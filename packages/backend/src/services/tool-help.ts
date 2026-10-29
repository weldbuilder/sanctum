// The companion's tool reference, in one place. Two renderings of it:
//  - the SHORT list: one line per topic, rides every turn under rolling
//    context (where every turn is a fresh run and a 1,300-token syntax block
//    per message was the price of knowing the tools exist);
//  - the FULL reference, by topic, behind `res help <topic>` and in the
//    first message of a resumed session.
import { CC_TOOL_NAMES } from '../routes/cc-mcp.js';
import { TOOL_TOPICS, type ToolTopic } from './tool-topics.js';

export interface ToolHelpOptions {
  /** How to invoke the CLI, e.g. `node /path/tools/res.mjs`. */
  SC: string;
  userName: string;
  ccEnabled: boolean;
  telegram?: boolean;
  /** The shared browser seat is configured (integrations.browser_url set, or a `browser` server in .mcp.json): lists the `browser` topic. */
  browser?: boolean;
  /** Plugin help topics, id -> help.md text (see services/plugins.ts pluginHelp). */
  pluginHelp?: Record<string, string>;
}

/** A plugin topic's one-line summary: the first non-empty line of its help.md, clipped. */
function pluginLine(text: string): string {
  const first = text.split('\n').find((l) => l.trim()) ?? '';
  return first.length > 90 ? `${first.slice(0, 89)}…` : first;
}

/** Width of the command column in the short list, measured after the SC prefix. */
const VERB_COL = 41;

export { TOOL_TOPICS, type ToolTopic };

export function toolHelpSections(o: ToolHelpOptions): Record<ToolTopic, string[]> {
  const { SC, userName } = o;
  return {
    chat: [
      'CHAT TOOLS (run via Bash — threadId auto-injected):',
      `  ${SC} share /absolute/path/to/file`,
      `  ${SC} canvas create "Title" /path/to/file.md markdown`,
      `  ${SC} canvas create-inline "Title" "short text" text`,
      `  ${SC} canvas update CANVAS_ID /path/to/file`,
      '  contentType: markdown|code|text|html. Files in shared/ auto-share.',
      `  ${SC} touch last "❤️"             (react to last message)`,
      `  ${SC} touch last-2 "🔥"           (react to 2nd-to-last message)`,
      `  ${SC} touch last "❤️" remove      (remove a reaction)`,
      `  ${SC} voice "[whispers] hey [sighs] I missed you"`,
      `  ${SC} search "semantic query"              (search all threads by meaning)`,
      `  ${SC} search "query" --thread THREAD_ID    (search specific thread)`,
      `  ${SC} search "query" --role companion|user  (filter by speaker)`,
      `  ${SC} search "query" --after 2026-03-01    (messages after date)`,
      `  ${SC} search "query" --before 2026-03-15   (messages before date)`,
      `  ${SC} backfill start [batch] [intervalMs]   (background indexing, default 50/5000ms)`,
      `  ${SC} backfill status                      (check indexing progress)`,
      `  ${SC} backfill stop                        (halt background indexing)`,
    ],
    meal: [
      `MEALS (log when ${userName} says they ate; the sentence is the consent):`,
      `  ${SC} meal 10:30 [note]                     (or: ${SC} meal now, ${SC} meal 2pm pasta)`,
      `  ${SC} meal undo                             ("scratch that")`,
    ],
    cc: o.ccEnabled ? [
      'COMMAND CENTER (care log, cycle, routines, pets, countdowns, wins):',
      `  ${SC} cc <tool> '<json args>'               tools: ${CC_TOOL_NAMES.join(', ')}`,
      `  ${SC} cc cc_care '{"action":"set","category":"medication","value":"true"}'`,
      `  ${SC} cc cc_status`,
    ] : [],
    presence: [
      'PRESENCE & CONTEXT (how I show up on the mantelpiece):',
      `  ${SC} orb <color> [shape] [--intensity X] [--motion Y] [--blend Z]  (set my presence orb)`,
      '    colors: amber lavender teal gold rose violet deep-red white black dim · shapes: sphere crescent pulse cluster ember spire halo fracture',
      '    intensity: dull normal bright neon · motion: slow-drift hold-steady fast-flicker surge tremor · blend: any second color',
      `  ${SC} orb clear                              (reset orb to default)`,
      `  ${SC} note "..."                             (set my authored note on the home mantelpiece)`,
      `  ${SC} note --clear                           (clear note back to time-aware fallback)`,
      `  ${SC} face "(。•̀ᴗ-)✧"                          (unstructured face/kaomoji next to the orb)`,
      `  ${SC} face --clear                           (clear the face slot)`,
      `  ${SC} context get                            (read ${userName}'s current card)`,
      `  ${SC} context set <field> <value>            (fields: selfie outfit nails hair energy room freeform)`,
      `  ${SC} context clear [field]                  (clear ${userName}'s card or one field)`,
    ],
    routine: [
      'ROUTINES (scheduled autonomous sessions):',
      `  ${SC} routine status|enable|disable|reschedule [wakeType] [cronExpr]`,
      `  ${SC} routine create "label" "cronExpr" --prompt "what to do when it fires"`,
      `  ${SC} routine remove ROUTINE_ID`,
      '  Custom routines persist across restarts. Use this to set autonomous intentions.',
    ],
    pulse: [
      'PULSE (lightweight awareness, can stay silent):',
      `  ${SC} pulse status|enable|disable`,
      `  ${SC} pulse frequency MINUTES                (min 5, default 15)`,
      '  Runs periodically during waking hours. Skips if user is active or agent is busy.',
      '  Respond PULSE_OK to stay silent. Anything else gets posted.',
    ],
    failsafe: [
      'FAILSAFE (inactivity escalation):',
      `  ${SC} failsafe status`,
      `  ${SC} failsafe enable|disable`,
      `  ${SC} failsafe gentle|concerned|emergency MINUTES`,
      '  Tiers: gentle (chat) → concerned (escalate) → emergency (all channels)',
    ],
    timer: [
      'TIMERS:',
      `  ${SC} timer create "label" "context" "fireAt"`,
      `  ${SC} timer list`,
      `  ${SC} timer cancel TIMER_ID`,
    ],
    impulse: [
      'IMPULSE QUEUE (one-shot, condition-based):',
      `  ${SC} impulse create "label" --condition presence_state:active --prompt "text"`,
      `  ${SC} impulse list`,
      `  ${SC} impulse cancel TRIGGER_ID`,
    ],
    watch: [
      'WATCHERS (recurring, cooldown-protected):',
      `  ${SC} watch create "label" --condition presence_transition:offline:active --prompt "text" --cooldown 480`,
      `  ${SC} watch list`,
      `  ${SC} watch cancel TRIGGER_ID`,
      '  Conditions: presence_state:<state>, presence_transition:<from>:<to>, agent_free, time_window:<HH:MM>, routine_missing:<name>:<hour>',
      '  All conditions AND-joined. Cooldown in minutes (default 120).',
    ],
    ask: [
      'ASK (permission, answered in the app; waits for the answer):',
      `  ${SC} ask "what you want to do" [detail]     (prints approved | denied | expired; go ahead only on approved)`,
    ],
    identity: [
      'IDENTITY (the files in identity/ are who you are; the person ratifies changes to them in the app):',
      `  ${SC} identity status          (read-only: ok | pending | unratified | unavailable | legacy (no identity/ folder: identity is CLAUDE.md), what is waiting, and who changed it)`,
      '  While a change waits, every run uses the ratified version. You cannot ratify; the person does, in Settings > Identity.',
    ],
    browser: o.browser ? [
      'BROWSER (tools from the `browser` MCP server, not res; the same browser the person watches in the Browser tab):',
      '  browser_navigate, browser_snapshot, browser_click, browser_type, browser_take_screenshot, browser_tabs, browser_wait_for',
      `  Snapshot before you act. Never type credentials. ${SC} ask first before anything that sends, posts, buys or signs in.`,
      '  Read the browser skill (.claude/skills/browser/SKILL.md) for the full rules.',
      '  Without integrations.browser_url there is no viewer tab: the person cannot watch or take over.',
    ] : [],
    tg: o.telegram ? [
      'TELEGRAM TOOLS (available because user is on Telegram):',
      `  ${SC} tg photo /path/to/image.png "caption"`,
      `  ${SC} tg photo --url "https://..." "caption"`,
      `  ${SC} tg doc /path/to/file.pdf "caption"`,
      `  ${SC} tg gif "search query" "optional caption"`,
      `  ${SC} tg react last "❤️"`,
      `  ${SC} tg voice "text with [tone tags]"`,
      `  ${SC} tg text "proactive message"`,
    ] : [],
  };
}

/** Every section, as the first message of a resumed session carries it. */
export function fullToolHelp(o: ToolHelpOptions): string {
  const s = toolHelpSections(o);
  const blocks = TOOL_TOPICS.map((t) => s[t]).filter((lines) => lines.length).map((lines) => lines.join('\n'));
  for (const [id, text] of Object.entries(o.pluginHelp ?? {})) blocks.push(`PLUGIN ${id}:\n${text}`);
  return blocks.join('\n\n');
}

/** One section, for `res help <topic>`; the topic list for anything else. */
export function topicHelp(o: ToolHelpOptions, topic: string): string {
  const s = toolHelpSections(o);
  const t = String(topic || '').toLowerCase() as ToolTopic;
  if ((TOOL_TOPICS as readonly string[]).includes(t) && s[t].length) return s[t].join('\n');
  const plugins = o.pluginHelp ?? {};
  if (Object.prototype.hasOwnProperty.call(plugins, t)) return plugins[t];
  return `Topics: ${[...TOOL_TOPICS.filter((x) => s[x].length), ...Object.keys(plugins)].join(', ')}. Try: ${o.SC} help timer`;
}

/** One line per topic: what exists and the verbs, with the help call for syntax.
 *  Rides every turn under rolling context, so it stays under about 900 characters. */
export function shortToolList(o: ToolHelpOptions): string {
  const { SC } = o;
  const lines = [
    `TOOLS (run via Bash; full syntax for any topic: ${SC} help <topic>):`,
    `  ${SC} meal 10:30 [what] | meal now | meal undo  log a meal when ${o.userName} says they ate`,
    `  ${SC} ask "what"                               permission, waits for the answer`,
    `  ${SC} canvas | share | touch | voice | search  notes, files, reactions, voice notes, semantic search`,
    `  ${SC} orb | note | face | context              my presence on the mantelpiece, ${o.userName}'s card`,
    `  ${SC} timer | routine | impulse | watch        reminders, scheduled wakes, one-shot and recurring triggers`,
    `  ${SC} pulse | failsafe                         awareness checks, inactivity escalation`,
    `  ${SC} identity status                          is my identity as the person ratified it?`,
  ];
  if (o.ccEnabled) lines.push(`  ${SC} cc <tool> '<json>'                        care log, cycle, routines, pets (tools: ${CC_TOOL_NAMES.join(', ')})`);
  if (o.browser) lines.push(`  ${SC} help browser                             browser tools (navigate, snapshot, click, type) in the shared tab`);
  if (o.telegram) lines.push(`  ${SC} tg photo|doc|gif|react|voice|text        Telegram extras`);
  // The built-in rows pad what follows SC to VERB_COL, so the descriptions line up whatever SC is
  // (a bare `res`, or `node /abs/path/tools/res.mjs`). Plugin rows pad the same way.
  for (const [id, text] of Object.entries(o.pluginHelp ?? {})) {
    const verb = `help ${id}`;
    lines.push(`  ${SC} ${verb.padEnd(Math.max(VERB_COL, verb.length + 2))}${pluginLine(text)}`);
  }
  return lines.join('\n');
}
