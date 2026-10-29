// Command Center REST routes — household management endpoints
import { Router } from 'express';
import * as cc from '../services/cc.js';
import { getSanctumConfig } from '../config.js';
import { registry } from '../services/ws.js';

const router = Router();

// ---------------------------------------------------------------------------
// Live ripple — cc_update on every cc mutation
// ---------------------------------------------------------------------------

type CcSection = 'care' | 'routines' | 'cycle' | 'wins' | 'countdowns';

function broadcastCcUpdate(section: CcSection): void {
  // cc_update is not in the shared ServerMessage union (shared is owned
  // elsewhere); broadcast via unknown cast — same pattern as mantelpiece_update
  // in routes/api.ts. The /command page listens and refetches the section.
  registry.broadcast({ type: 'cc_update', section } as unknown as Parameters<typeof registry.broadcast>[0]);
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// care_categories: ordered array of { key, label, repeatable, target? } — the
// config-driven care chips (kills the frontend's hardcoded CARE_CATEGORIES).
// Sourced from the 'cc.care_categories' config KV row when present, else the
// coded default list. default_person / currency_symbol keep
// their original shape for existing consumers.
router.get('/config', (_req, res) => {
  const cfg = getSanctumConfig().command_center;
  res.json({
    ok: true,
    default_person: cfg.default_person,
    currency_symbol: cfg.currency_symbol,
    care_categories: cc.getCareCategories(),
    sections: cc.getSections(),
  });
});

// Per-section on/off. Body: { sections: { cycle?: bool, care?: bool, ... } }
// (a bare { cycle: false } is accepted too). Hidden, not deleted.
router.patch('/config', (req, res) => {
  const body = (req.body || {}) as Record<string, unknown>;
  const src = (body.sections && typeof body.sections === 'object' ? body.sections : body) as Record<string, unknown>;
  const patch: Partial<Record<cc.CcSectionKey, boolean>> = {};
  for (const k of cc.CC_SECTION_KEYS) {
    if (src[k] !== undefined) {
      if (typeof src[k] !== 'boolean') return res.status(400).json({ ok: false, error: `${k} must be boolean` });
      patch[k] = src[k] as boolean;
    }
  }
  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ ok: false, error: 'No valid section flags' });
  }
  const sections = cc.setSections(patch);
  res.json({ ok: true, sections });
});

// Person for the Command Center page's care surface. The browser page tracks
// the user's care specifically (contract: care reads/writes are person 'user').
const CC_PAGE_PERSON = 'user';

// ---------------------------------------------------------------------------
// Overview — one call for the Command Center page's first paint
// ---------------------------------------------------------------------------

router.get('/overview', (_req, res) => {
  try {
    res.json({
      ok: true,
      care: cc.getCareEntries(cc.today(), CC_PAGE_PERSON),
      routines: cc.getRoutineStatusToday(),
      cycle: cc.getCycleStatus(),
      wins: cc.getRecentDailyWins(7),
      countdowns: cc.listCountdowns().filter(c => c.days_until >= 0),
    });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Status aggregator
// ---------------------------------------------------------------------------

router.get('/status', (_req, res) => {
  try {
    const status = cc.getCcStatus();
    res.json({ ok: true, status });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Care entries
// ---------------------------------------------------------------------------

router.get('/care', (req, res) => {
  const { date: qDate, person } = req.query as { date?: string; person?: string };
  const date = qDate || cc.today(); // default: today in the tenant's timezone
  res.json({ ok: true, date, entries: cc.getCareEntries(date, person) });
});

router.get('/care/history', (req, res) => {
  const { person, days } = req.query as { person?: string; days?: string };
  if (!person) return res.status(400).json({ ok: false, error: 'person required' });
  res.json({ ok: true, entries: cc.getCareHistory(person, days ? parseInt(days) : 7) });
});

router.put('/care', (req, res) => {
  const entry = cc.upsertCareEntry({ ...req.body, source: 'ui' });
  broadcastCcUpdate('care');
  res.json({ ok: true, entry });
});

// Browser-page upsert — person fixed to the user, date defaults to today (config tz).
// Repeatable categories (water ×N — flags from GET /config) increment the count
// on the (date, person, category) row; the response carries the numeric count.
router.post('/care', (req, res) => {
  try {
    const { category, value, note, date } = (req.body || {}) as Record<string, unknown>;
    if (!category || typeof category !== 'string') {
      return res.status(400).json({ ok: false, error: 'category required' });
    }
    const common = {
      category,
      person: CC_PAGE_PERSON,
      value: value === undefined || value === null ? undefined : String(value),
      note: note === undefined || note === null ? undefined : String(note),
      date: typeof date === 'string' && date ? date : undefined,
      source: 'ui' as const,
    };
    if (cc.isRepeatableCategory(category)) {
      const { entry, count } = cc.incrementCareEntry(common);
      broadcastCcUpdate('care');
      return res.json({ ok: true, entry, count });
    }
    const entry = cc.upsertCareEntry(common);
    broadcastCcUpdate('care');
    res.json({ ok: true, entry });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.delete('/care/:id', (req, res) => {
  try {
    const deleted = cc.deleteCareEntry(req.params.id);
    if (!deleted) return res.status(404).json({ ok: false, error: 'Care entry not found' });
    broadcastCcUpdate('care');
    res.json({ ok: true, deleted: true });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Care routines
// ---------------------------------------------------------------------------

router.get('/routines', (_req, res) => {
  try {
    res.json({ ok: true, routines: cc.listRoutines(false), status: cc.getRoutineStatusToday() });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/routines', (req, res) => {
  try {
    const { label, category, window_end, window_start, days } = (req.body || {}) as Record<string, unknown>;
    if (!label || typeof label !== 'string') return res.status(400).json({ ok: false, error: 'label required' });
    if (!category || typeof category !== 'string') return res.status(400).json({ ok: false, error: 'category required' });
    if (!window_end || typeof window_end !== 'string') return res.status(400).json({ ok: false, error: 'window_end required' });
    const routine = cc.createRoutine({
      label,
      category,
      window_end,
      window_start: typeof window_start === 'string' && window_start ? window_start : undefined,
      days: typeof days === 'string' && days ? days : undefined,
    });
    broadcastCcUpdate('routines');
    res.json({ ok: true, routine });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.patch('/routines/:id', (req, res) => {
  try {
    const body = (req.body || {}) as Record<string, unknown>;
    const updates: Parameters<typeof cc.updateRoutine>[1] = {};
    if (typeof body.label === 'string') updates.label = body.label;
    if (typeof body.category === 'string') updates.category = body.category;
    if (typeof body.window_start === 'string') updates.window_start = body.window_start;
    if (typeof body.window_end === 'string') updates.window_end = body.window_end;
    if (typeof body.days === 'string') updates.days = body.days;
    if (body.active !== undefined) updates.active = !!body.active;
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ ok: false, error: 'No valid fields to update' });
    }
    const updated = cc.updateRoutine(req.params.id, updates);
    if (!updated) return res.status(404).json({ ok: false, error: 'Routine not found' });
    const routine = cc.listRoutines(false).find(r => r.id === req.params.id) || null;
    broadcastCcUpdate('routines');
    res.json({ ok: true, updated: true, routine });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Default = soft deactivate (row kept, reactivatable). ?hard=true = true DELETE.
router.delete('/routines/:id', (req, res) => {
  try {
    const { hard } = req.query as { hard?: string };
    if (hard === 'true') {
      const deleted = cc.deleteRoutine(req.params.id);
      if (!deleted) return res.status(404).json({ ok: false, error: 'Routine not found' });
      broadcastCcUpdate('routines');
      return res.json({ ok: true, deleted: true });
    }
    const deactivated = cc.deactivateRoutine(req.params.id);
    if (!deactivated) return res.status(404).json({ ok: false, error: 'Routine not found' });
    broadcastCcUpdate('routines');
    res.json({ ok: true, deactivated: true });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

router.get('/tasks', (req, res) => {
  const { status, project, date, person, due_before, carry_forward } = req.query as Record<string, string>;
  const tasks = cc.listTasks({
    status, project, date, person, due_before,
    carry_forward: carry_forward === 'true',
  });
  res.json({ ok: true, tasks });
});

router.post('/tasks', (req, res) => {
  const task = cc.addTask(req.body);
  res.json({ ok: true, task });
});

router.put('/tasks/:id', (req, res) => {
  const updated = cc.updateTask(req.params.id, req.body);
  res.json({ ok: true, updated });
});

router.put('/tasks/:id/complete', (req, res) => {
  const result = cc.completeTask(req.params.id);
  res.json({ ok: true, result });
});

router.delete('/tasks/:id', (req, res) => {
  const result = cc.updateTask(req.params.id, { status: 'deleted' });
  res.json({ ok: true, deleted: result });
});

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

router.get('/projects', (req, res) => {
  const { status } = req.query as { status?: string };
  res.json({ ok: true, projects: cc.listProjects(status) });
});

router.post('/projects', (req, res) => {
  const project = cc.addProject(req.body);
  res.json({ ok: true, project });
});

router.put('/projects/:id', (req, res) => {
  const updated = cc.updateProject(req.params.id, req.body);
  res.json({ ok: true, updated });
});

router.delete('/projects/:id', (req, res) => {
  const deleted = cc.deleteProject(req.params.id);
  res.json({ ok: true, deleted });
});

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

router.get('/events', (req, res) => {
  const { start_date, end_date, category } = req.query as Record<string, string>;
  res.json({ ok: true, events: cc.listEvents({ start_date, end_date, category }) });
});

router.post('/events', (req, res) => {
  const event = cc.addEvent(req.body);
  res.json({ ok: true, event });
});

router.put('/events/:id', (req, res) => {
  const updated = cc.updateEvent(req.params.id, req.body);
  res.json({ ok: true, updated });
});

router.delete('/events/:id', (req, res) => {
  const deleted = cc.deleteEvent(req.params.id);
  res.json({ ok: true, deleted });
});

// ---------------------------------------------------------------------------
// Cycle
// ---------------------------------------------------------------------------

// Combined read for the Command Center page.
router.get('/cycle', (_req, res) => {
  try {
    res.json({
      ok: true,
      status: cc.getCycleStatus(),
      history: cc.getCycleHistory(6),
      predict: cc.getCyclePredict(),
      settings: cc.getCycleSettings(),
    });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/cycle/status', (_req, res) => {
  res.json({ ok: true, ...cc.getCycleStatus() });
});

router.get('/cycle/history', (req, res) => {
  const { limit } = req.query as { limit?: string };
  res.json({ ok: true, cycles: cc.getCycleHistory(limit ? parseInt(limit) : 6) });
});

router.get('/cycle/predict', (_req, res) => {
  res.json({ ok: true, ...cc.getCyclePredict() });
});

router.post('/cycle/period/start', (req, res) => {
  const result = cc.startPeriod(req.body.date, req.body.notes);
  broadcastCcUpdate('cycle');
  res.json({ ok: true, result });
});

router.post('/cycle/period/end', (req, res) => {
  const result = cc.endPeriod(req.body.date);
  if (!result.ok) return res.json({ ok: false, error: 'no_open_period' });
  broadcastCcUpdate('cycle');
  res.json({ ok: true, result: result.message });
});

// Browser-page aliases (kebab-case per the Command Center page contract).
router.post('/cycle/period-start', (req, res) => {
  try {
    const { date, notes } = (req.body || {}) as { date?: string; notes?: string };
    const result = cc.startPeriod(date, notes);
    broadcastCcUpdate('cycle');
    res.json({ ok: true, result });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/cycle/period-end', (req, res) => {
  try {
    const { date } = (req.body || {}) as { date?: string };
    const result = cc.endPeriod(date);
    if (!result.ok) return res.json({ ok: false, error: 'no_open_period' });
    broadcastCcUpdate('cycle');
    res.json({ ok: true, result: result.message });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Cycle row CRUD — fix a mis-tapped period start/end without SQL surgery.
// Both recompute the learned averages (inside the service).
router.patch('/cycle/rows/:id', (req, res) => {
  try {
    const body = (req.body || {}) as Record<string, unknown>;
    const updates: Parameters<typeof cc.updateCycleRow>[1] = {};
    if (typeof body.start_date === 'string' && body.start_date) updates.start_date = body.start_date;
    if (body.end_date === null) updates.end_date = null; // reopen a period
    else if (typeof body.end_date === 'string' && body.end_date) updates.end_date = body.end_date;
    if (body.notes === null) updates.notes = null;
    else if (typeof body.notes === 'string') updates.notes = body.notes;
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ ok: false, error: 'No valid fields to update (start_date, end_date, notes)' });
    }
    const row = cc.updateCycleRow(req.params.id, updates);
    if (!row) return res.status(404).json({ ok: false, error: 'Cycle row not found' });
    broadcastCcUpdate('cycle');
    res.json({ ok: true, row });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.delete('/cycle/rows/:id', (req, res) => {
  try {
    const deleted = cc.deleteCycleRow(req.params.id);
    if (!deleted) return res.status(404).json({ ok: false, error: 'Cycle row not found' });
    broadcastCcUpdate('cycle');
    res.json({ ok: true, deleted: true });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/cycle/log', (req, res) => {
  try {
    const { date, flow, symptoms, mood, energy, notes } = (req.body || {}) as Record<string, unknown>;
    const result = cc.logCycleDaily({
      date: typeof date === 'string' && date ? date : undefined,
      flow: typeof flow === 'string' ? flow : undefined,
      symptoms: typeof symptoms === 'string' ? symptoms : undefined,
      mood: typeof mood === 'string' ? mood : undefined,
      energy: energy === undefined || energy === null || Number.isNaN(Number(energy)) ? undefined : Number(energy),
      notes: typeof notes === 'string' ? notes : undefined,
    });
    broadcastCcUpdate('cycle');
    res.json({ ok: true, result });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.patch('/cycle/settings', (req, res) => {
  try {
    const body = (req.body || {}) as Record<string, unknown>;
    const updates: { average_cycle_length?: number; average_period_length?: number } = {};
    const cycleLen = Number(body.average_cycle_length);
    const periodLen = Number(body.average_period_length);
    if (body.average_cycle_length !== undefined && Number.isFinite(cycleLen) && cycleLen > 0) {
      updates.average_cycle_length = Math.round(cycleLen);
    }
    if (body.average_period_length !== undefined && Number.isFinite(periodLen) && periodLen > 0) {
      updates.average_period_length = Math.round(periodLen);
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ ok: false, error: 'Provide average_cycle_length and/or average_period_length as positive numbers' });
    }
    const settings = cc.setCycleSettings(updates);
    broadcastCcUpdate('cycle');
    res.json({ ok: true, settings });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Pets
// ---------------------------------------------------------------------------

router.get('/pets', (_req, res) => {
  res.json({ ok: true, pets: cc.listPets() });
});

router.post('/pets', (req, res) => {
  const pet = cc.addPet(req.body);
  res.json({ ok: true, pet });
});

router.post('/pets/events', (req, res) => {
  const result = cc.logPetEvent(req.body);
  res.json({ ok: true, result });
});

router.post('/pets/medications', (req, res) => {
  const result = cc.addPetMedication(req.body);
  res.json({ ok: true, result });
});

router.post('/pets/medications/given', (req, res) => {
  const result = cc.markMedGiven(req.body);
  res.json({ ok: true, result });
});

router.get('/pets/upcoming', (req, res) => {
  const { days } = req.query as { days?: string };
  res.json({ ok: true, items: cc.upcomingPetCare(days ? parseInt(days) : 7) });
});

router.put('/pets/:id', (req, res) => {
  const updated = cc.updatePet(req.params.id, req.body);
  res.json({ ok: true, updated });
});

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

router.get('/lists', (_req, res) => {
  res.json({ ok: true, lists: cc.getAllLists() });
});

router.post('/lists', (req, res) => {
  const list = cc.createList(req.body);
  res.json({ ok: true, list });
});

router.get('/lists/:id', (req, res) => {
  const list = cc.getListWithItems(req.params.id);
  if (!list) return res.status(404).json({ ok: false, error: 'List not found' });
  res.json({ ok: true, list });
});

router.delete('/lists/:id', (req, res) => {
  const deleted = cc.deleteLst(req.params.id);
  res.json({ ok: true, deleted });
});

router.post('/lists/:id/items', (req, res) => {
  const items = Array.isArray(req.body.items) ? req.body.items : [req.body.item].filter(Boolean);
  const count = cc.addListItems(req.params.id, items, req.body.added_by);
  res.json({ ok: true, count });
});

router.put('/lists/items/:itemId', (req, res) => {
  if (req.body.text !== undefined) {
    const updated = cc.updateListItem(req.params.itemId, { text: req.body.text, checked: req.body.checked });
    res.json({ ok: true, updated });
  } else {
    const checked = cc.checkListItem(req.params.itemId, req.body.checked ?? true);
    res.json({ ok: true, checked });
  }
});

router.delete('/lists/items/:itemId', (req, res) => {
  const deleted = cc.deleteListItem(req.params.itemId);
  res.json({ ok: true, deleted });
});

router.delete('/lists/:id/items', (req, res) => {
  const { all } = req.query as { all?: string };
  const count = cc.clearListItems(req.params.id, all === 'true');
  res.json({ ok: true, cleared: count });
});

// ---------------------------------------------------------------------------
// Expenses
// ---------------------------------------------------------------------------

router.get('/expenses', (req, res) => {
  const { start_date, end_date, category, paid_by, limit } = req.query as Record<string, string>;
  const result = cc.listExpenses({ start_date, end_date, category, paid_by, limit: limit ? parseInt(limit) : undefined });
  res.json({ ok: true, ...result });
});

router.post('/expenses', (req, res) => {
  const expense = cc.addExpense(req.body);
  res.json({ ok: true, expense });
});

router.get('/expenses/stats', (req, res) => {
  try {
    const { period } = req.query as { period?: string };
    res.json({ ok: true, ...cc.getExpenseStats(period) });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Countdowns
// ---------------------------------------------------------------------------

router.get('/countdowns', (_req, res) => {
  res.json({ ok: true, countdowns: cc.listCountdowns() });
});

router.post('/countdowns', (req, res) => {
  try {
    const { title, target_date, emoji, color } = (req.body || {}) as Record<string, unknown>;
    if (!title || typeof title !== 'string') return res.status(400).json({ ok: false, error: 'title required' });
    if (!target_date || typeof target_date !== 'string') return res.status(400).json({ ok: false, error: 'target_date required' });
    const countdown = cc.addCountdown({
      title,
      target_date,
      emoji: typeof emoji === 'string' && emoji ? emoji : undefined,
      color: typeof color === 'string' && color ? color : undefined,
    });
    broadcastCcUpdate('countdowns');
    res.json({ ok: true, countdown });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.patch('/countdowns/:id', (req, res) => {
  try {
    const body = (req.body || {}) as Record<string, unknown>;
    const updates: Parameters<typeof cc.updateCountdown>[1] = {};
    if (typeof body.title === 'string' && body.title) updates.title = body.title;
    if (typeof body.target_date === 'string' && body.target_date) updates.target_date = body.target_date;
    if (typeof body.emoji === 'string') updates.emoji = body.emoji;
    if (typeof body.color === 'string') updates.color = body.color;
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ ok: false, error: 'No valid fields to update (title, target_date, emoji, color)' });
    }
    const countdown = cc.updateCountdown(req.params.id, updates);
    if (!countdown) return res.status(404).json({ ok: false, error: 'Countdown not found' });
    broadcastCcUpdate('countdowns');
    res.json({ ok: true, countdown });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.delete('/countdowns/:id', (req, res) => {
  try {
    const deleted = cc.deleteCountdown(req.params.id);
    if (!deleted) return res.status(404).json({ ok: false, error: 'Countdown not found' });
    broadcastCcUpdate('countdowns');
    res.json({ ok: true, deleted: true });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Daily wins
// ---------------------------------------------------------------------------

// ?days=N returns the recent window (page default: 7); ?date=YYYY-MM-DD returns
// a single day; no params = today.
router.get('/wins', (req, res) => {
  try {
    const { date, days } = req.query as { date?: string; days?: string };
    if (days) {
      const n = parseInt(days, 10);
      return res.json({ ok: true, wins: cc.getRecentDailyWins(Number.isFinite(n) && n > 0 ? n : 7) });
    }
    res.json({ ok: true, wins: cc.getDailyWins(date) });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/wins', (req, res) => {
  try {
    const { text, who, date } = (req.body || {}) as Record<string, unknown>;
    if (!text || typeof text !== 'string') return res.status(400).json({ ok: false, error: 'text required' });
    const win = cc.upsertDailyWin({
      text,
      who: typeof who === 'string' && who ? who : undefined,
      date: typeof date === 'string' && date ? date : undefined,
    });
    broadcastCcUpdate('wins');
    res.json({ ok: true, win });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.delete('/wins/:id', (req, res) => {
  try {
    const deleted = cc.deleteDailyWin(req.params.id);
    if (!deleted) return res.status(404).json({ ok: false, error: 'Win not found' });
    broadcastCcUpdate('wins');
    res.json({ ok: true, deleted: true });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Scratchpad (daily plan)
// ---------------------------------------------------------------------------

router.get('/scratchpad', (_req, res) => {
  res.json({ ok: true, ...cc.getScratchpad() });
});

router.post('/scratchpad/notes', (req, res) => {
  const { text, created_by } = req.body;
  if (!text) return res.status(400).json({ ok: false, error: 'text required' });
  const note = cc.addScratchpadNote(text, created_by);
  res.json({ ok: true, note });
});

router.put('/scratchpad/notes/:id', (req, res) => {
  try {
    const note = cc.updateScratchpadNote(req.params.id, req.body.text);
    res.json({ ok: true, note });
  } catch (e: any) {
    res.status(404).json({ ok: false, error: e.message });
  }
});

router.delete('/scratchpad/notes/:id', (req, res) => {
  const deleted = cc.deleteScratchpadNote(req.params.id);
  res.json({ ok: true, deleted });
});

router.delete('/scratchpad/notes', (_req, res) => {
  const cleared = cc.clearScratchpadNotes();
  res.json({ ok: true, cleared });
});

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

router.get('/stats/tasks', (req, res) => {
  const { days } = req.query as { days?: string };
  try {
    res.json({ ok: true, ...cc.getTaskStats(days ? parseInt(days) : 14) });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/stats/care', (req, res) => {
  const { person, days } = req.query as { person?: string; days?: string };
  try {
    res.json({ ok: true, ...cc.getCareStats(person || getSanctumConfig().command_center.default_person, days ? parseInt(days) : 14) });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/stats/cycle', (_req, res) => {
  try {
    res.json({ ok: true, ...cc.getCycleStats() });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

export default router;
