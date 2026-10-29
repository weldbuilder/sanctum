// Command Center MCP endpoint — JSON-RPC 2.0 protocol for Agent SDK
// Exposes all command center tools as MCP tools callable by the companion in chat
import { Router } from 'express';
import * as cc from '../services/cc.js';
import { getSanctumConfig } from '../config.js';
import { registry } from '../services/ws.js';

const router = Router();

// Live ripple — every cc mutation from chat lands on the open /command page.
// Same unknown-cast pattern as mantelpiece_update in routes/api.ts (cc_update
// is not in the shared ServerMessage union; shared is owned elsewhere).
type CcSection = 'care' | 'routines' | 'cycle' | 'wins' | 'countdowns';

function broadcastCcUpdate(section: CcSection): void {
  registry.broadcast({ type: 'cc_update', section } as unknown as Parameters<typeof registry.broadcast>[0]);
}

// Tool definitions — what the companion sees when the agent lists tools
export const TOOLS = [
  {
    name: 'cc_status',
    description: 'Relational dashboard overview: care, cycle, pets, countdowns, wins. Call with no arguments for a full summary.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'cc_care',
    description: 'Track wellness: meals, sleep, energy, mood, water, movement, medication.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['set', 'get', 'history'], description: 'Action' },
        person: { type: 'string', description: 'Person name' },
        category: { type: 'string', description: 'Category: breakfast, lunch, dinner, snacks, medication, movement, shower, sleep, energy, wellbeing, mood, water' },
        value: { type: 'string', description: 'true/false for toggles, 1-5 for ratings, 0-10 for water' },
        note: { type: 'string', description: 'Optional note (JSON array for stacking)' },
        date: { type: 'string', description: 'YYYY-MM-DD (default: today)' },
        days: { type: 'number', description: 'History lookback days (default: 7)' },
      },
      required: ['action'],
    },
  },
  {
    name: 'cc_cycle',
    description: 'Cycle tracking: status, predictions, period logging, daily symptom logging.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'history', 'predict', 'start_period', 'end_period', 'log'], description: 'Action' },
        date: { type: 'string', description: 'YYYY-MM-DD' },
        flow: { type: 'string', description: 'none, spotting, light, medium, heavy' },
        symptoms: { type: 'string' },
        mood: { type: 'string' },
        energy: { type: 'number', description: '1-5' },
        notes: { type: 'string' },
      },
      required: ['action'],
    },
  },
  {
    name: 'cc_pet',
    description: 'Pet care: profiles, events, medications, upcoming care alerts.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'list', 'update', 'log', 'med_add', 'med_given', 'upcoming'], description: 'Action' },
        id: { type: 'string', description: 'Pet ID (for update)' },
        pet_name: { type: 'string' },
        name: { type: 'string', description: 'Pet name (add) or medication name' },
        species: { type: 'string' },
        breed: { type: 'string' },
        birthday: { type: 'string' },
        weight: { type: 'string' },
        notes: { type: 'string' },
        event_type: { type: 'string', description: 'vet, vaccination, grooming, weight_check, note' },
        title: { type: 'string' },
        dosage: { type: 'string' },
        frequency: { type: 'string', description: 'daily, weekly, monthly, quarterly, yearly, as_needed' },
        days: { type: 'number', description: 'Upcoming lookback days (default 7)' },
      },
      required: ['action'],
    },
  },
  {
    name: 'cc_countdown',
    description: 'Manage countdowns. Actions: add, list, delete.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'list', 'delete'], description: 'Action' },
        id: { type: 'string', description: 'Countdown ID (for delete)' },
        title: { type: 'string' },
        target_date: { type: 'string', description: 'YYYY-MM-DD' },
        emoji: { type: 'string' },
      },
      required: ['action'],
    },
  },
  {
    name: 'cc_daily_win',
    description: 'Log the daily win. One per person per day.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'What was today\'s win?' },
        who: { type: 'string', description: 'Person (default: configured default person)' },
        date: { type: 'string', description: 'YYYY-MM-DD (default: today)' },
      },
      required: ['text'],
    },
  },
  {
    name: 'cc_scratchpad',
    description: 'House NOTES only — sticky notes on the Home timeline (letters, reminders-in-passing, things for the user to see). NOT for tasks or events: real tasks go to google-workspace Tasks, real events to google-workspace Calendar — deliberate split (2026-07-03): the world\'s paperwork lives in Google, the house keeps care. Actions: status (view all), add_note, remove_note, clear_notes.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'add_note', 'remove_note', 'clear_notes'], description: 'Action' },
        text: { type: 'string', description: 'Note text (for add_note)' },
        id: { type: 'string', description: 'Note ID (for remove_note)' },
      },
      required: ['action'],
    },
  },
  {
    name: 'cc_routine',
    description: 'Sir\'s Orders as data — daily/weekly routines with completion windows, completion read from care entries. Actions: list, create, update, deactivate, status.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'update', 'deactivate', 'status'], description: 'Action' },
        id: { type: 'string', description: 'Routine ID (for update/deactivate)' },
        label: { type: 'string', description: 'Human label, e.g. "First meal"' },
        category: { type: 'string', description: 'Maps to care_entries category: breakfast, dinner, shower, movement, meds, ...' },
        window_start: { type: 'string', description: 'HH:MM window start (optional)' },
        window_end: { type: 'string', description: 'HH:MM deadline — past this with no care entry = MISSED' },
        days: { type: 'string', description: "'daily' or CSV of lowercase weekdays, e.g. 'tuesday' (default: daily)" },
        active: { type: 'boolean', description: 'Reactivate (true) or deactivate (false) — for update' },
        include_inactive: { type: 'boolean', description: 'Include deactivated routines (for list)' },
      },
      required: ['action'],
    },
  },
];

export const CC_TOOL_NAMES = TOOLS.map((t) => t.name);

// --- Tool dispatch ---

export function handleTool(name: string, args: any): string {
  const config = getSanctumConfig();
  const defaultPerson = config.command_center.default_person;

  switch (name) {
    case 'cc_status':
      return cc.getCcStatus();

    case 'cc_care': {
      const a = args.action;
      if (a === 'set') {
        const entry = cc.upsertCareEntry({ date: args.date, person: args.person, category: args.category, value: args.value, note: args.note, source: 'mcp' });
        broadcastCcUpdate('care');
        return `Care logged: ${entry.person} ${entry.category} = ${entry.value || ''}${entry.note ? ' (note)' : ''}`;
      }
      if (a === 'get') {
        const entries = cc.getCareEntries(args.date || new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' }), args.person);
        if (entries.length === 0) return 'No care entries for this day.';
        return entries.map(e => `${e.person} ${e.category}: ${e.value || '-'}${e.note ? ' [has notes]' : ''}`).join('\n');
      }
      if (a === 'history') {
        const entries = cc.getCareHistory(args.person || defaultPerson, args.days || 7);
        if (entries.length === 0) return 'No care history.';
        return entries.map(e => `${e.date} ${e.category}: ${e.value || '-'}`).join('\n');
      }
      return 'Unknown action. Use: set, get, history.';
    }

    case 'cc_cycle': {
      const a = args.action;
      if (a === 'status') {
        const s = cc.getCycleStatus();
        if (s.noData) return 'No cycle data yet.';
        return `Day ${s.cycleDay} (${s.phase}). ${s.onPeriod ? 'On period.' : `Next period in ~${s.daysUntilPeriod} days.`}${s.inPMSWindow ? ' PMS window.' : ''}`;
      }
      if (a === 'history') {
        const cycles = cc.getCycleHistory(args.limit || 6);
        return cycles.map(c => `${c.start_date} — ${c.end_date || 'ongoing'}${c.notes ? ': ' + c.notes : ''}`).join('\n') || 'No history.';
      }
      if (a === 'predict') {
        const p = cc.getCyclePredict();
        if (p.error) return p.error;
        return `Next period: ${p.nextPeriod}\nOvulation: ${p.ovulation}\nFertile: ${p.fertileWindow.start} — ${p.fertileWindow.end}\nPMS: ${p.pmsWindow.start} — ${p.pmsWindow.end}`;
      }
      if (a === 'start_period') { const r = cc.startPeriod(args.date, args.notes); broadcastCcUpdate('cycle'); return r; }
      if (a === 'end_period') {
        const r = cc.endPeriod(args.date);
        if (r.ok) broadcastCcUpdate('cycle');
        return r.message;
      }
      if (a === 'log') { const r = cc.logCycleDaily(args); broadcastCcUpdate('cycle'); return r; }
      return 'Unknown action.';
    }

    case 'cc_pet': {
      const a = args.action;
      if (a === 'add') { const p = cc.addPet(args); return `Pet added: ${(p as any).name}`; }
      if (a === 'list') {
        const pets = cc.listPets();
        return pets.map((p: any) => `${p.name}${p.species ? ` (${p.species})` : ''}${p.birthday ? `, born ${p.birthday}` : ''}`).join('\n') || 'No pets.';
      }
      if (a === 'update') { cc.updatePet(args.id, args); return 'Pet updated.'; }
      if (a === 'log') return cc.logPetEvent(args);
      if (a === 'med_add') return cc.addPetMedication(args);
      if (a === 'med_given') return cc.markMedGiven(args);
      if (a === 'upcoming') {
        const items = cc.upcomingPetCare(args.days || 7);
        return items.map((i: any) => `${i.pet}: ${i.name} (${i.type}) — ${i.overdue ? 'OVERDUE' : i.isToday ? 'TODAY' : i.due}`).join('\n') || 'No upcoming care.';
      }
      return 'Unknown action.';
    }

    case 'cc_countdown': {
      const a = args.action;
      if (a === 'add') { cc.addCountdown(args); broadcastCcUpdate('countdowns'); return `Countdown added: ${args.title} (${args.target_date})`; }
      if (a === 'list') {
        const cds = cc.listCountdowns();
        return cds.map((c: any) => `${c.emoji || ''} ${c.title} — ${c.days_until === 0 ? 'TODAY' : c.days_until > 0 ? c.days_until + ' days' : Math.abs(c.days_until) + ' days ago'}`).join('\n') || 'No countdowns.';
      }
      if (a === 'delete') { cc.deleteCountdown(args.id); broadcastCcUpdate('countdowns'); return 'Countdown deleted.'; }
      return 'Unknown action.';
    }

    case 'cc_daily_win':
      cc.upsertDailyWin({ text: args.text, who: args.who, date: args.date });
      broadcastCcUpdate('wins');
      return `Win logged for ${args.who || defaultPerson}: ${args.text}`;

    case 'cc_scratchpad': {
      const a = args.action;
      const companionName = config.identity.companion_name.toLowerCase();
      if (a === 'status') {
        const data = cc.getScratchpad();
        const lines: string[] = ['**Scratchpad**'];
        if (data.events.length > 0) {
          lines.push('**Today\'s events:**');
          data.events.forEach((e: any) => lines.push(`  ${e.start_time || 'all day'} — ${e.title}${e.created_by ? ' (' + e.created_by + ')' : ''}`));
        }
        if (data.tasks.length > 0) {
          lines.push('**Tasks:**');
          data.tasks.forEach((t: any) => lines.push(`  [ ] ${t.text}${t.created_by ? ' (' + t.created_by + ')' : ''}`));
        }
        if (data.notes.length > 0) {
          lines.push('**Notes:**');
          data.notes.forEach((n: any) => lines.push(`  • ${n.text} (${n.created_by})`));
        }
        if (data.counts.events === 0 && data.counts.notes === 0 && data.counts.tasks === 0) {
          lines.push('Nothing on the scratchpad yet.');
        }
        lines.push(`\n${data.counts.events} events today, ${data.counts.tasks} tasks, ${data.counts.notes} notes`);
        return lines.join('\n');
      }
      if (a === 'add_note') {
        if (!args.text) return 'Error: text is required for add_note.';
        const note = cc.addScratchpadNote(args.text, companionName);
        return `Note added: "${note.text}" (${note.id})`;
      }
      // Tasks + events were REMOVED from the scratchpad 2026-07-03:
      // the world's paperwork lives in Google (google-workspace Tasks/Calendar),
      // the house keeps care. Stale callers get an honest redirect, not a write.
      if (a === 'add_task' || a === 'remove_task') {
        return 'Tasks no longer live on the scratchpad — use google-workspace Tasks (service: tasks). The scratchpad is house notes only.';
      }
      if (a === 'add_event') {
        return 'Events no longer live on the scratchpad — use google-workspace Calendar (service: calendar). The scratchpad is house notes only.';
      }
      if (a === 'remove_note') {
        if (!args.id) return 'Error: id is required for remove_note.';
        const ok = cc.deleteScratchpadNote(args.id);
        return ok ? 'Note removed.' : 'Note not found.';
      }
      if (a === 'clear_notes') {
        const count = cc.clearScratchpadNotes();
        return `Cleared ${count} note(s).`;
      }
      return 'Unknown action. Use: status, add_note, remove_note, clear_notes. (Tasks → google-workspace Tasks; events → google-workspace Calendar.)';
    }

    case 'cc_routine': {
      const a = args.action;
      if (a === 'list') {
        const routines = cc.listRoutines(!args.include_inactive);
        if (routines.length === 0) return 'No routines.';
        return routines.map(r => `${r.label} [${r.category}] — by ${r.window_end}${r.window_start ? ` (from ${r.window_start})` : ''}, ${r.days}${r.active ? '' : ' (inactive)'} (${r.id})`).join('\n');
      }
      if (a === 'create') {
        if (!args.label || !args.category || !args.window_end) return 'Error: label, category and window_end are required for create.';
        const r = cc.createRoutine({ label: args.label, category: args.category, window_start: args.window_start, window_end: args.window_end, days: args.days });
        broadcastCcUpdate('routines');
        return `Routine created: ${r.label} [${r.category}] by ${r.window_end}, ${r.days} (${r.id})`;
      }
      if (a === 'update') {
        if (!args.id) return 'Error: id is required for update.';
        const ok = cc.updateRoutine(args.id, { label: args.label, category: args.category, window_start: args.window_start, window_end: args.window_end, days: args.days, active: args.active });
        if (ok) broadcastCcUpdate('routines');
        return ok ? 'Routine updated.' : 'Routine not found (or nothing to update).';
      }
      if (a === 'deactivate') {
        if (!args.id) return 'Error: id is required for deactivate.';
        const ok = cc.deactivateRoutine(args.id);
        if (ok) broadcastCcUpdate('routines');
        return ok ? 'Routine deactivated.' : 'Routine not found.';
      }
      if (a === 'status') {
        const statuses = cc.getRoutineStatusToday();
        if (statuses.length === 0) return 'No routines due today.';
        return statuses.map(s => `${s.routine.label} [${s.routine.category}] — ${s.status === 'missed' ? 'MISSED' : s.status}${s.completedAt ? ` at ${s.completedAt}` : ''} (window ends ${s.routine.window_end})`).join('\n');
      }
      return 'Unknown action. Use: list, create, update, deactivate, status.';
    }

    default:
      return `Unknown tool: ${name}`;
  }
}

// --- MCP JSON-RPC endpoint ---

router.post('/', (req, res) => {
  const { jsonrpc, method, id, params } = req.body;

  if (jsonrpc !== '2.0') {
    return res.json({ jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request' } });
  }

  try {
    switch (method) {
      case 'initialize':
        return res.json({
          jsonrpc: '2.0', id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'command-center', version: '1.0.0' },
          },
        });

      case 'notifications/initialized':
        return res.json({ jsonrpc: '2.0', id, result: {} });

      case 'tools/list':
        return res.json({ jsonrpc: '2.0', id, result: { tools: TOOLS } });

      case 'tools/call': {
        const { name, arguments: toolArgs } = params || {};
        const result = handleTool(name, toolArgs || {});
        return res.json({
          jsonrpc: '2.0', id,
          result: { content: [{ type: 'text', text: result }] },
        });
      }

      default:
        return res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  } catch (err: any) {
    return res.json({
      jsonrpc: '2.0', id,
      result: { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true },
    });
  }
});

export default router;
