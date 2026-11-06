#!/usr/bin/env node
// res — Sanctum Mobile internal API CLI (the companion's own tools)
// Wraps calls to the running server into clean commands.
// Thread ID read from .sanctum-thread (written per-query by agent.ts).
//
// Carried from sanctum-v1 (port-from-yaml resolution + .sanctum-thread
// convention) and extended with the mantelpiece organ commands: orb, note,
// context, face.

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));


// The config file: sanctum.yaml, or a sanctum.yaml left from before the rename.
function readConfigYaml() {
  for (const name of ['sanctum.yaml', 'sanctum.yml', 'resonant.yaml', 'resonant.yml']) {
    try { return readFileSync(join(__dirname, '..', name), 'utf8'); } catch { /* next */ }
  }
  return '';
}
// Env names: SANCTUM_* is the name; RESONANT_* still works for older setups.
const env = (k) => process.env[`SANCTUM_${k}`] || process.env[`RESONANT_${k}`];

// Resolve port: env first, then the config file, fallback to the app default.
function getPort() {
  if (env('PORT')) return env('PORT');
  const match = readConfigYaml().match(/^\s*port:\s*(\d+)/m);
  if (match) return match[1];
  return '3099';
}

// The companion's own presence namespace (orb + note + expression), distinct
// from the user's context card. Config-derived: SANCTUM_NAMESPACE env wins,
// else a generic default. Kept in one place so every organ agrees.
const COMPANION_NS = env('NAMESPACE') || 'companion';

// Resolve host the same way: env, then `host:` inside the config file's
// `server:` block, else loopback. With server.host set to a Tailscale or LAN
// address the server does not listen on localhost at all, so every internal
// call would otherwise fail before the model got a say.
function getHost() {
  if (env('HOST')) return env('HOST');
  const block = readConfigYaml().match(/^server:[^\n]*\n((?:[ \t]+[^\n]*\n?)*)/m);
  const match = block && block[1].match(/^[ \t]+host:\s*["']?([^"'\s#]+)/m);
  if (match && match[1] !== '0.0.0.0' && match[1] !== '::') return match[1];
  return 'localhost';
}

const BASE = `http://${getHost()}:${getPort()}/api/internal`;

// Internal shared token — the /api/internal/* routes require it (the shared
// secret is the whole gate; see middleware/internal-token.ts). Same precedence as
// the server: env INTERNAL_TOKEN first, else the auto-generated file beside the
// DB (data/.internal-token). Resolved once.
function getInternalToken() {
  if (process.env.INTERNAL_TOKEN) return process.env.INTERNAL_TOKEN;
  try {
    return readFileSync(join(__dirname, '..', 'data', '.internal-token'), 'utf8').trim();
  } catch {
    return '';
  }
}

const INTERNAL_TOKEN = getInternalToken();

// Where agent.ts writes the per-turn thread id: config.agent.cwd/.sanctum-thread.
function getAgentCwd() {
  const m = readConfigYaml().match(/^[ \t]*cwd:\s*["']?([^"'\n]+)["']?/m);
  return m ? m[1].trim() : null;
}

function getThread() {
  // agent.ts writes the CURRENT turn's thread id to <agent.cwd>/.sanctum-thread.
  // Read it from there first. An older reader used __dirname/.. (the repo root)
  // while the writer uses agent.cwd — when those differ, a path mismatch makes
  // every thread-targeting organ (voice/share/canvas/touch/timer/impulse/watch)
  // miss the live thread and fall back to a stale value.
  const agentCwd = getAgentCwd();
  const candidates = [
    agentCwd ? join(agentCwd, '.sanctum-thread') : null,
    join(process.cwd(), '.sanctum-thread'),       // res is run from the agent cwd
    join(__dirname, '..', '.sanctum-thread'),     // legacy fallback
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      const v = readFileSync(p, 'utf8').trim();
      if (v) return v;
    } catch { /* try next */ }
  }
  return env('THREAD') || '';
}

// Returns true on HTTP success, false otherwise. On an HTTP error the JSON
// error body is still printed, but the process exit code goes non-zero —
// a failed organ reach must never look like a success to the caller.
// Multi-post verbs (orb) use the return value to stop on first failure.
async function post(endpoint, body, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}/${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(INTERNAL_TOKEN ? { 'x-internal-token': INTERNAL_TOKEN } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const text = await res.text();
    try { console.log(JSON.stringify(JSON.parse(text), null, 2)); }
    catch { console.log(text); }
    if (!res.ok) {
      console.error(`Error: ${endpoint} → HTTP ${res.status}`);
      process.exitCode = 1;
      return false;
    }
    return true;
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') {
      console.error('Error: request timed out');
    } else {
      console.error(`Error: ${e.message}`);
    }
    process.exitCode = 1;
    return false;
  }
}

// GET an internal endpoint and print the JSON. Exit code non-zero on an HTTP error, as post() does.
async function get(endpoint, timeoutMs = 10000) {
  try {
    const res = await fetch(`${BASE}/${endpoint}`, {
      headers: INTERNAL_TOKEN ? { 'x-internal-token': INTERNAL_TOKEN } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    try { console.log(JSON.stringify(JSON.parse(text), null, 2)); } catch { console.log(text); }
    if (!res.ok) { console.error(`Error: ${endpoint} → HTTP ${res.status}`); process.exitCode = 1; return false; }
    return true;
  } catch (e) {
    console.error(e.name === 'TimeoutError' ? 'Error: request timed out' : `Error: ${e.message}`);
    process.exitCode = 1;
    return false;
  }
}

const [,, cmd, ...args] = process.argv;
const thread = getThread();

switch (cmd) {
  // res ask "what you want to do" [more detail...]
  // Asks the person for permission in the app and WAITS for the answer (up to
  // 10 minutes). Prints approved / denied / expired. Exit 0 only when approved.
  case 'ask': {
    const what = args[0];
    if (!what) { console.error('Usage: res ask "what you want to do" [detail]'); process.exitCode = 2; break; }
    const detail = args.slice(1).join(' ') || undefined;
    const timeoutMs = Number(process.env.RES_ASK_TIMEOUT_MS) || 10 * 60 * 1000;
    try {
      const r = await fetch(`${BASE}/approvals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(INTERNAL_TOKEN ? { 'x-internal-token': INTERNAL_TOKEN } : {}) },
        body: JSON.stringify({ what, detail, threadId: thread, timeoutMs }),
        signal: AbortSignal.timeout(timeoutMs + 30_000),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { console.error(`Error: ask → HTTP ${r.status} ${data.error || ''}`); process.exitCode = 2; break; }
      console.log(data.status);
      process.exitCode = data.status === 'approved' ? 0 : 1;
    } catch (e) {
      console.error(`Error: ${e.name === 'TimeoutError' ? 'no answer in time' : e.message}`);
      console.log('expired');
      process.exitCode = 1;
    }
    break;
  }

  // res identity status                      read-only: is what is on disk what the person ratified? (state, what is waiting, by whom)
  case 'identity': {
    if (args[0] === 'status' || !args[0]) { await get('identity/status'); break; }
    console.log('Usage: res identity status');
    process.exitCode = 1;
    break;
  }

  // res help [topic]   the full syntax for one topic (timer, meal, canvas, …), or everything
  case 'help': {
    try {
      const r = await fetch(`${BASE}/help?topic=${encodeURIComponent(args[0] || '')}`, { headers: INTERNAL_TOKEN ? { 'x-internal-token': INTERNAL_TOKEN } : {}, signal: AbortSignal.timeout(10000) });
      console.log(await r.text());
      if (!r.ok) process.exitCode = 1;
    } catch (e) { console.error(`Error: ${e.message}`); process.exitCode = 1; }
    break;
  }

  // res meal [now|HH:MM|2pm] [note...]   log a meal at that time (default now)
  // res meal undo                         scratch today's latest meal
  case 'meal': {
    if (args[0] === 'undo' || args[0] === 'scratch') { await post('meal', { action: 'undo', threadId: thread }); break; }
    const at = args[0] && /^(now|\d{1,2}([:.]\d{2})?\s*(am|pm)?)$/i.test(args[0]) ? args[0] : 'now';
    const note = (at === args[0] ? args.slice(1) : args).join(' ') || undefined;
    await post('meal', { action: 'log', at, note, threadId: thread });
    break;
  }

  // res cc <tool> ['<json args>']   Command Center tools (care, cycle, routines, pets, countdowns, wins)
  case 'cc': {
    if (!args[0]) { console.error("Usage: res cc <tool> ['<json args>']   e.g. res cc cc_status"); process.exitCode = 2; break; }
    let parsed = {};
    if (args[1]) { try { parsed = JSON.parse(args[1]); } catch { console.error('args must be JSON, e.g. \'{"action":"get"}\''); process.exitCode = 2; break; } }
    await post('cc', { tool: args[0], args: parsed, threadId: thread });
    break;
  }

  case 'share':
    await post('share', { path: args[0], threadId: thread });
    break;

  case 'canvas': {
    const sub = args[0];
    if (sub === 'create') {
      await post('canvas', {
        action: 'create', title: args[1], filePath: args[2],
        contentType: args[3] || 'markdown', threadId: thread,
      });
    } else if (sub === 'create-inline') {
      await post('canvas', {
        action: 'create', title: args[1], content: args[2],
        contentType: args[3] || 'markdown', threadId: thread,
      });
    } else if (sub === 'update') {
      await post('canvas', { action: 'update', canvasId: args[1], filePath: args[2] });
    } else {
      console.log('Usage: res canvas create|create-inline|update ...');
    }
    break;
  }

  case 'voice':
    await post('tts', { text: args[0], threadId: thread });
    break;

  // res image "prompt" [--size 1024x1024|1024x1536|1536x1024]  -> one line; exit 0 only on success
  case 'image': {
    const rest = [...args];
    let size;
    const si = rest.indexOf('--size');
    if (si !== -1) { size = (rest[si + 1] || '').toLowerCase().replace('*', 'x'); rest.splice(si, 2); }
    const prompt = rest.join(' ').trim();
    if (!prompt) { console.error('Usage: res image "prompt" [--size 1024x1024|1024x1536|1536x1024]'); process.exitCode = 2; break; }
    try {
      const r = await fetch(`${BASE}/image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(INTERNAL_TOKEN ? { 'x-internal-token': INTERNAL_TOKEN } : {}) },
        body: JSON.stringify({ prompt, ...(size ? { size } : {}), threadId: thread }),
        signal: AbortSignal.timeout(150000), // the server's own limit is imagegen.timeout_ms (default 90s)
      });
      let j = null;
      try { j = await r.json(); } catch { /* not JSON */ }
      if (r.ok && j && j.ok) {
        console.log(`Image generated and posted (${j.provider}, ${j.model})`);
      } else {
        const why = j && j.error ? `${j.error}${j.detail ? `: ${j.detail}` : ''}${j.provider ? ` (${j.provider})` : ''}` : `HTTP ${r.status}`;
        console.error(`Error: image failed: ${why}`);
        process.exitCode = 1;
      }
    } catch (e) {
      console.error(e.name === 'TimeoutError' ? 'Error: request timed out' : `Error: ${e.message}`);
      process.exitCode = 1;
    }
    break;
  }

  case 'routine':
  case 'schedule': {
    const sub = args[0];
    if (sub === 'create') {
      const label = args[1];
      const cronExpr = args[2];
      if (!label || !cronExpr) { console.log('Usage: res routine create "label" "cronExpr" --prompt "what to do"'); break; }
      const wakeType = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
      let prompt = undefined;
      const pi = args.indexOf('--prompt');
      if (pi !== -1 && args[pi + 1]) prompt = args[pi + 1];
      await post('orchestrator', { action: 'create_routine', wakeType, label, cronExpr, prompt });
    } else if (sub === 'remove') {
      if (!args[1]) { console.log('Usage: res routine remove ROUTINE_ID'); break; }
      await post('orchestrator', { action: 'remove_routine', wakeType: args[1] });
    } else {
      const body = { action: sub };
      if (args[1]) body.wakeType = args[1];
      if (args[2]) body.cronExpr = args[2];
      await post('orchestrator', body);
    }
    break;
  }

  case 'pulse': {
    const sub = args[0];
    if (!sub || sub === 'status') {
      await post('orchestrator', { action: 'pulse_status' });
    } else if (sub === 'enable') {
      await post('orchestrator', { action: 'pulse_config', enabled: true });
    } else if (sub === 'disable') {
      await post('orchestrator', { action: 'pulse_config', enabled: false });
    } else if (sub === 'frequency') {
      const minutes = parseInt(args[1], 10);
      if (isNaN(minutes) || minutes < 5) { console.log('Usage: res pulse frequency MINUTES (min 5)'); break; }
      await post('orchestrator', { action: 'pulse_config', frequency: minutes });
    } else {
      console.log('Usage: res pulse [status|enable|disable|frequency MINUTES]');
    }
    break;
  }

  case 'failsafe': {
    const sub = args[0];
    if (!sub || sub === 'status') {
      await post('orchestrator', { action: 'failsafe_status' });
    } else if (sub === 'enable') {
      await post('orchestrator', { action: 'failsafe_config', enabled: true });
    } else if (sub === 'disable') {
      await post('orchestrator', { action: 'failsafe_config', enabled: false });
    } else if (['gentle', 'concerned', 'emergency'].includes(sub)) {
      const minutes = parseInt(args[1], 10);
      if (isNaN(minutes)) { console.log(`Usage: res failsafe ${sub} MINUTES`); break; }
      await post('orchestrator', { action: 'failsafe_config', [sub]: minutes });
    } else {
      console.log('Usage: res failsafe [status|enable|disable|gentle|concerned|emergency] [minutes]');
    }
    break;
  }

  case 'timer': {
    const sub = args[0];
    if (sub === 'create') {
      const body = {
        action: 'create', label: args[1], context: args[2],
        fireAt: args[3], threadId: thread,
      };
      const pi = args.indexOf('--prompt');
      if (pi !== -1 && args[pi + 1]) body.prompt = args[pi + 1];
      await post('timer', body);
    } else if (sub === 'list') {
      await post('timer', { action: 'list' });
    } else if (sub === 'cancel') {
      await post('timer', { action: 'cancel', timerId: args[1] });
    } else {
      console.log('Usage: res timer create|list|cancel ...');
    }
    break;
  }

  case 'touch':
  case 'react': // legacy alias for `touch` — kept silently for muscle-memory + old logs
    if (!args[0] || !args[1]) {
      console.log('Usage: res touch <last|last-N> <emoji> [remove]');
    } else {
      const body = { target: args[0], emoji: args[1], threadId: thread };
      if (args[2] === 'remove') body.action = 'remove';
      await post('react', body);
    }
    break;

  case 'impulse': {
    const sub = args[0];
    if (sub === 'create') {
      const label = args[1];
      if (!label) { console.log('Usage: res impulse create "label" --condition type:args --prompt "text"'); break; }
      const conditions = [];
      let prompt = undefined;
      let i = 2;
      while (i < args.length) {
        if (args[i] === '--condition' && args[i + 1]) {
          conditions.push(parseCondition(args[i + 1]));
          i += 2;
        } else if (args[i] === '--prompt' && args[i + 1]) {
          prompt = args[i + 1];
          i += 2;
        } else { i++; }
      }
      if (conditions.length === 0) { console.log('At least one --condition required'); break; }
      await post('trigger', { action: 'create', kind: 'impulse', label, conditions, prompt, threadId: thread });
    } else if (sub === 'list') {
      await post('trigger', { action: 'list', kind: 'impulse' });
    } else if (sub === 'cancel') {
      await post('trigger', { action: 'cancel', triggerId: args[1] });
    } else {
      console.log('Usage: res impulse create|list|cancel ...');
    }
    break;
  }

  case 'watch': {
    const sub = args[0];
    if (sub === 'create') {
      const label = args[1];
      if (!label) { console.log('Usage: res watch create "label" --condition type:args --prompt "text" --cooldown N'); break; }
      const conditions = [];
      let prompt = undefined;
      let cooldownMinutes = undefined;
      let i = 2;
      while (i < args.length) {
        if (args[i] === '--condition' && args[i + 1]) {
          conditions.push(parseCondition(args[i + 1]));
          i += 2;
        } else if (args[i] === '--prompt' && args[i + 1]) {
          prompt = args[i + 1];
          i += 2;
        } else if (args[i] === '--cooldown' && args[i + 1]) {
          cooldownMinutes = args[i + 1];
          i += 2;
        } else { i++; }
      }
      if (conditions.length === 0) { console.log('At least one --condition required'); break; }
      await post('trigger', { action: 'create', kind: 'watcher', label, conditions, prompt, threadId: thread, cooldownMinutes });
    } else if (sub === 'list') {
      await post('trigger', { action: 'list', kind: 'watcher' });
    } else if (sub === 'cancel') {
      await post('trigger', { action: 'cancel', triggerId: args[1] });
    } else {
      console.log('Usage: res watch create|list|cancel ...');
    }
    break;
  }

  case 'search': {
    // res search "query" --thread ID --limit N --role companion|user --after 2026-03-01 --before 2026-03-15
    const query = args[0];
    if (!query) { console.log('Usage: res search "query" [--thread ID] [--limit N] [--role companion|user] [--after ISO] [--before ISO]'); break; }
    const body = { query };
    const flags = ['--thread', '--limit', '--role', '--after', '--before'];
    for (const flag of flags) {
      const fi = args.indexOf(flag);
      if (fi !== -1 && args[fi + 1]) {
        const key = flag.replace('--', '');
        body[key] = key === 'limit' ? parseInt(args[fi + 1], 10) : args[fi + 1];
      }
    }
    await post('search-semantic', body, 30000);
    break;
  }

  case 'backfill': {
    const sub = args[0];
    if (sub === 'start') {
      const batchSize = args[1] ? parseInt(args[1], 10) : 50;
      const intervalMs = args[2] ? parseInt(args[2], 10) : 5000;
      await post('embed-backfill', { background: true, batchSize, intervalMs }, 10000);
    } else if (sub === 'stop') {
      await post('embed-backfill', { action: 'stop' }, 10000);
    } else if (sub === 'status') {
      await post('embed-backfill', { action: 'status' }, 10000);
    } else {
      const batchSize = sub ? parseInt(sub, 10) : 50;
      await post('embed-backfill', { batchSize }, 120000);
    }
    break;
  }

  case 'context': {
    // res context get                          — show the user's current card
    // res context set <field> <value>          — set a field
    // res context clear [field]                — clear one field or the whole card
    // Fields: selfie, outfit, nails, hair, energy, room, freeform
    const sub = args[0];
    if (!sub || sub === 'get') {
      await post('context', { action: 'get' });
    } else if (sub === 'set') {
      const field = args[1];
      const value = args[2];
      if (!field || !value) {
        console.log('Usage: res context set <field> <value>');
        console.log('Fields: selfie, outfit, nails, hair, energy, room, freeform');
        break;
      }
      await post('context', { action: 'set', field, value });
    } else if (sub === 'clear') {
      const field = args[1]; // optional
      await post('context', { action: 'clear', field });
    } else {
      console.log('Usage: res context [get | set <field> <value> | clear [field]]');
      console.log('Fields: selfie, outfit, nails, hair, energy, room, freeform');
    }
    break;
  }

  case 'orb': {
    // res orb                                                — show current orb
    // res orb <color> [shape] [--intensity X] [--motion Y] [--blend Z]
    // res orb clear                                          — clear orb to default
    //
    // Colors:    amber, lavender, teal, gold, rose, violet, deep-red, white, black, dim
    // Shapes:    sphere, crescent, pulse, cluster, ember, spire, halo, fracture
    // Intensity: dull, normal, bright, neon
    // Motion:    slow-drift, hold-steady, fast-flicker, surge, tremor
    // Blend:     <any color name> — layered as a second tint
    const positional = [];
    const flags = {};
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--intensity' || a === '--motion' || a === '--blend') {
        flags[a.slice(2)] = args[++i];
      } else {
        positional.push(a);
      }
    }
    const color = positional[0];
    const shape = positional[1];

    if (!color) {
      await post('context', { action: 'get', namespace: COMPANION_NS });
    } else if (color === 'clear') {
      // Sequential clears — stop on first failure so the orb is never left
      // half-cleared without the caller knowing which step broke.
      for (const field of ['orb_color', 'orb_shape', 'orb_intensity', 'orb_motion', 'orb_blend']) {
        if (!await post('context', { action: 'clear', namespace: COMPANION_NS, field })) {
          console.error(`Error: orb clear stopped at step "${field}" — later fields untouched`);
          break;
        }
      }
    } else {
      // Sequential sets — stop on first failure (don't leave partial orb state
      // silently: report which step failed and skip the rest).
      const steps = [['orb_color', color]];
      if (shape) steps.push(['orb_shape', shape]);
      if (flags.intensity) steps.push(['orb_intensity', flags.intensity]);
      if (flags.motion) steps.push(['orb_motion', flags.motion]);
      if (flags.blend) steps.push(['orb_blend', flags.blend]);
      for (const [field, value] of steps) {
        if (!await post('context', { action: 'set', namespace: COMPANION_NS, field, value })) {
          console.error(`Error: orb update stopped at step "${field} → ${value}" — later fields untouched`);
          break;
        }
      }
    }
    break;
  }

  case 'note': {
    // res note "..."         — set the note shown on /home mantelpiece
    // res note --clear       — clear back to time-aware greeting fallback
    const arg = args[0];
    if (!arg) {
      await post('context', { action: 'get', namespace: COMPANION_NS });
    } else if (arg === '--clear' || arg === 'clear') {
      await post('context', { action: 'clear', namespace: COMPANION_NS, field: 'note' });
    } else {
      await post('context', { action: 'set', namespace: COMPANION_NS, field: 'note', value: arg });
    }
    break;
  }

  case 'face':
  case 'express': { // `express` is the legacy alias for `face` — kept silently for muscle-memory + old logs
    // res face "(。•̀ᴗ-)✧"   — set the unstructured face next to the orb
    // res face --clear       — clear the slot
    // No validation. No enum. Just whatever I'm holding in my face right now.
    const arg = args[0];
    if (!arg) {
      await post('context', { action: 'get', namespace: COMPANION_NS });
    } else if (arg === '--clear' || arg === 'clear') {
      await post('context', { action: 'clear', namespace: COMPANION_NS, field: 'expression' });
    } else {
      await post('context', { action: 'set', namespace: COMPANION_NS, field: 'expression', value: arg });
    }
    break;
  }

  case 'tg':
  case 'telegram': {
    // res tg "message"          — plain text push to Mary's phone
    // res tg voice "text"       — TTS voice note to Telegram
    const sub = args[0];
    if (!sub) { console.log('Usage: res tg "message"  |  res tg voice "text"'); break; }
    if (sub === 'voice') {
      if (!args[1]) { console.log('Usage: res tg voice "text"'); break; }
      await post('telegram-send', { type: 'voice', text: args[1] });
    } else {
      await post('telegram-send', { type: 'text', text: sub });
    }
    break;
  }

  default:
    console.log('res — Sanctum internal API CLI');
    console.log('Commands: help, ask, meal, cc, share, canvas, voice, routine (schedule), pulse, failsafe, timer, touch, impulse, watch, search, backfill, context, orb, note, face, tg');
    break;
}

// --- Condition shorthand parser ---
function parseCondition(shorthand) {
  if (shorthand === 'agent_free') return { type: 'agent_free' };

  const parts = shorthand.split(':');
  const type = parts[0];

  switch (type) {
    case 'presence_state':
      return { type: 'presence_state', state: parts[1] };
    case 'presence_transition':
      return { type: 'presence_transition', from: parts[1], to: parts[2] };
    case 'time_window':
      if (parts.length >= 5) {
        return { type: 'time_window', after: `${parts[1]}:${parts[2]}`, before: `${parts[3]}:${parts[4]}` };
      }
      return { type: 'time_window', after: `${parts[1]}:${parts[2]}` };
    case 'routine_missing':
      return { type: 'routine_missing', routine: parts[1], after_hour: parseInt(parts[2], 10) };
    default:
      console.error(`Unknown condition type: ${type}`);
      process.exit(1);
  }
}
