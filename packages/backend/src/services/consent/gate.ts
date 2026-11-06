// The consent gate. Code, not cooperation: every place the companion can reach outside the chat asks check() first.
//
//   Open mode (the default): everything is ON. The person can turn any one capability OFF, or put it on a window that ends.
//   Guard mode (opt-in, PIN to switch on): everything is OFF until granted for a window (or left on), PIN on every grant.
//
// State is KV only: `consent.mode` (open|guard) and `consent.grants`, one JSON array with at most one entry per capability:
//   { grant_id, capability, effect: 'on' | 'off', granted_at, expires_at | null, note? }
// `effect: 'off'` is the person's switch-off; `'on'` with an expires_at is a window. Expiry is lazy: it is judged at check time, no timers.
// An expired window is NOT the default again: open mode keeps it off until the person turns it back on (that is what "a window" means).
//
// Every check() writes a receipt (allowed, denied or expired); so does every grant, revoke, switch-off and mode change.
// If the state cannot be read: before the database exists (boot) the gate behaves as the default, Open. Once the database is initialised the gate
// FAILS CLOSED: the last mode it read is kept; with none, an unreadable mode or a corrupt `consent.grants` is read as Guard with no grants (deny),
// with one `error` receipt and one warning per outage. A receipt that cannot be written never blocks.
import crypto from 'node:crypto';
import { getConfig, setConfig } from '../db.js';
import { NoTenantContext, currentTenant } from '../../tenancy/context.js';
import { getSanctumConfig } from '../../config.js';
import { pinIsSet } from './pin.js';
import { writeReceipt, type ReceiptOutcome } from './receipts.js';

export const CAPABILITIES = [
  'app_write', 'shell', 'files_outside_home', 'web', 'outward_telegram', 'outward_discord', 'google_write', 'self_code_edit', 'voice_out',
] as const;
export type Capability = (typeof CAPABILITIES)[number];
export type ConsentMode = 'open' | 'guard';
export const WINDOW_CHOICES: readonly (number | null)[] = [15, 30, 60, 1440, null];
export const MAX_WINDOW_MINUTES = 7 * 24 * 60;

export const CAPABILITY_LABELS: Record<Capability, string> = {
  app_write: 'App writes (timers, schedules, canvas, reactions, meals, shares, images)',
  shell: 'Shell commands',
  files_outside_home: 'Files outside the companion home',
  web: 'Web (fetch, search, browser)',
  outward_telegram: 'Sending to Telegram',
  outward_discord: 'Sending to Discord',
  google_write: 'Google writes (Gmail drafts, Calendar, Tasks, Docs, Sheets, YouTube)',
  self_code_edit: "Editing Sanctum's own code",
  voice_out: 'Voice notes (spends credit)',
};

/** The name a sentence uses ("Shell access is turned off"). */
export const CAPABILITY_SHORT: Record<Capability, string> = {
  app_write: 'App write access', shell: 'Shell access', files_outside_home: 'File access outside the home folder', web: 'Web access',
  outward_telegram: 'Telegram sending', outward_discord: 'Discord sending', google_write: 'Google write access', self_code_edit: "Editing Sanctum's own code", voice_out: 'Voice output',
};

export const isCapability = (v: unknown): v is Capability => typeof v === 'string' && (CAPABILITIES as readonly string[]).includes(v);

export interface Entry {
  grant_id: string;
  capability: Capability;
  effect: 'on' | 'off';
  granted_at: string;
  expires_at: string | null;
  note?: string;
}

export interface CheckCtx {
  /** claude | codex | dsh | server (the server's own choke points) | app */
  harness: string;
  threadId?: string | null;
  /** The raw tool or the route: `Bash`, `/internal/telegram-send`. */
  tool?: string;
  /** What it was about to do. Scrubbed and cut to 200 characters before it is stored. */
  summary?: string;
}

export interface Decision { allow: boolean; reason: string; grantId?: string; outcome: 'allowed' | 'denied' | 'expired' }
export interface CheckResult { allow: boolean; reason: string; grantId?: string }

// ── state ───────────────────────────────────────────────────────────────────

const warned = new Set<string>();
const warnOnce = (k: string, m: string) => { if (!warned.has(k)) { warned.add(k); console.warn(m); } };

const tenantKey = () => currentTenant()?.id ?? '';
/** The last mode read successfully, per tenant: what a later unreadable state falls back to. */
const lastMode = new Map<string, ConsentMode>();
/** Tenants whose state is unreadable right now (the warning and the `error` receipt are once per outage). */
const failing = new Set<string>();

/** "Not initialised": there is no database to read yet (boot, or tenancy on and no tenant entered). Anything else that throws is a failure. */
const notInitialised = (e: unknown) => e instanceof NoTenantContext || /not initiali[sz]ed/i.test((e as Error)?.message ?? '');

interface Snapshot { mode: ConsentMode; entries: Entry[]; unreadable: boolean }

function parseEntries(raw: string | null): Entry[] {
  if (!raw) return [];
  const arr = JSON.parse(raw); // throws on corrupt JSON
  if (!Array.isArray(arr)) throw new Error('consent.grants is not a list');
  const out: Entry[] = [];
  for (const e of arr) {
    if (!e || typeof e !== 'object' || !isCapability(e.capability) || typeof e.grant_id !== 'string') continue;
    out.push({
      grant_id: e.grant_id, capability: e.capability, effect: e.effect === 'off' ? 'off' : 'on',
      granted_at: typeof e.granted_at === 'string' ? e.granted_at : '', expires_at: typeof e.expires_at === 'string' ? e.expires_at : null,
      ...(typeof e.note === 'string' && e.note ? { note: e.note } : {}),
    });
  }
  return out;
}

/** The state, read once. Fails closed (see the header): unreadable state is Guard with no grants, never Open. */
function snapshot(): Snapshot {
  const k = tenantKey();
  let rawMode: string | null;
  let rawGrants: string | null;
  try {
    rawMode = getConfig('consent.mode');
    rawGrants = getConfig('consent.grants');
  } catch (e) {
    if (notInitialised(e)) return { mode: 'open', entries: [], unreadable: false }; // boot: no database yet, the default
    noteFailure(k, e);
    return { mode: 'guard', entries: [], unreadable: true };
  }
  try {
    const entries = parseEntries(rawGrants);
    const m: ConsentMode = rawMode === 'guard' ? 'guard' : 'open';
    lastMode.set(k, m);
    failing.delete(k);
    return { mode: m, entries, unreadable: false };
  } catch (e) {
    // The mode itself was read; the grants are corrupt. The person's switch-offs and windows are lost to us, so nothing is let through on trust.
    lastMode.set(k, rawMode === 'guard' ? 'guard' : 'open');
    noteFailure(k, e);
    return { mode: 'guard', entries: [], unreadable: true };
  }
}

function noteFailure(k: string, e: unknown): void {
  if (failing.has(k)) return;
  failing.add(k);
  const msg = (e as Error)?.message ?? String(e);
  console.warn(`[Consent] state unreadable (${msg}); failing closed: everything the gate covers is denied until it can be read`);
  writeReceipt({ capability: '*', outcome: 'error', harness: 'server', toolOrRoute: 'consent state', summary: `consent state unreadable: ${msg}` });
}

/** Test seam: forget the last mode read and any outage in progress. */
export function _resetStateCache(): void { lastMode.clear(); failing.clear(); }

/** The mode. Unreadable once the database exists: the last mode read if there is one, else Guard. Before the database exists: Open. */
export function mode(): ConsentMode {
  const k = tenantKey();
  try {
    const m: ConsentMode = getConfig('consent.mode') === 'guard' ? 'guard' : 'open';
    lastMode.set(k, m);
    return m;
  } catch (e) {
    if (notInitialised(e)) return 'open';
    noteFailure(k, e);
    return lastMode.get(k) ?? 'guard';
  }
}

function writeEntries(entries: Entry[]): void { setConfig('consent.grants', JSON.stringify(entries)); }
const readEntries = (): Entry[] => snapshot().entries;

const entryFor = (entries: Entry[], cap: Capability) => entries.find((e) => e.capability === cap);
const isExpired = (e: Entry, now: number) => e.expires_at !== null && Date.parse(e.expires_at) <= now;

function hhmm(iso: string): string {
  const d = new Date(iso);
  try {
    const tz = getSanctumConfig().identity?.timezone || 'UTC';
    return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz }).format(d);
  } catch {
    return d.toISOString().slice(11, 16);
  }
}

function decide(cap: Capability, m: ConsentMode, entries: Entry[], now: number): Decision {
  const e = entryFor(entries, cap);
  if (e?.effect === 'off') return { allow: false, outcome: 'denied', grantId: e.grant_id, reason: `${CAPABILITY_SHORT[cap]} is turned off` };
  if (e) {
    if (isExpired(e, now)) return { allow: false, outcome: 'expired', grantId: e.grant_id, reason: `${CAPABILITY_SHORT[cap]}'s window ended at ${hhmm(e.expires_at!)}` };
    return { allow: true, outcome: 'allowed', grantId: e.grant_id, reason: e.expires_at ? `${CAPABILITY_SHORT[cap]} is on until ${hhmm(e.expires_at)}` : `${CAPABILITY_SHORT[cap]} is on` };
  }
  if (m === 'guard') return { allow: false, outcome: 'denied', reason: `${CAPABILITY_SHORT[cap]} needs a grant (Guard mode is on)` };
  return { allow: true, outcome: 'allowed', reason: `${CAPABILITY_SHORT[cap]} is on` };
}

/** The decision without a receipt: for orientation, state listing and the run-flag computation. */
export function peek(cap: Capability, now = Date.now()): Decision {
  const s = snapshot();
  return decide(cap, s.mode, s.entries, now);
}

/** Ask the gate. Writes a receipt every time. */
export function check(cap: Capability, ctx: CheckCtx, now = Date.now()): CheckResult {
  const s = snapshot();
  const d = s.unreadable ? { ...decide(cap, 'guard', [], now), reason: `${CAPABILITY_SHORT[cap]} is off: the consent state cannot be read, so the gate is closed` } : decide(cap, s.mode, s.entries, now);
  writeReceipt({ capability: cap, outcome: d.outcome, grantId: d.grantId, harness: ctx.harness, threadId: ctx.threadId, toolOrRoute: ctx.tool, summary: ctx.summary });
  return { allow: d.allow, reason: d.reason, ...(d.grantId ? { grantId: d.grantId } : {}) };
}

/** What the person sees when a server route is refused: a sentence naming where the switch is. */
export function denyMessage(_cap: Capability, reason: string): string {
  return `${reason} (Settings → Permissions).`;
}

/** What the companion sees when a tool is refused: the reason, and how to ask. */
export function denyHint(cap: Capability, reason: string): string {
  return `Blocked: ${reason}. Ask with res ask ${cap} <window> (minutes, or "on" to leave it on).`;
}

/** Thrown by the choke points that cannot answer an HTTP status themselves (the Google write helpers). */
export class ConsentDeniedError extends Error {
  constructor(public readonly capability: Capability, public readonly reason: string) {
    super(denyMessage(capability, reason));
    this.name = 'ConsentDeniedError';
  }
}

/** check(), and throw ConsentDeniedError when it says no. */
export function requireCapability(cap: Capability, ctx: CheckCtx): CheckResult {
  const r = check(cap, ctx);
  if (!r.allow) throw new ConsentDeniedError(cap, r.reason);
  return r;
}

// ── changes ─────────────────────────────────────────────────────────────────

type Listener = (change: { mode: ConsentMode; capability?: Capability; change: 'grant' | 'off' | 'revoke' | 'mode' }) => void;
const listeners = new Set<Listener>();
/** The socket registers here so open tabs update (`consent_changed`). */
export function onConsentChanged(fn: Listener): () => void { listeners.add(fn); return () => listeners.delete(fn); }
function emit(change: Parameters<Listener>[0]): void {
  for (const l of listeners) { try { l(change); } catch (e) { console.warn(`[Consent] listener failed: ${(e as Error)?.message}`); } }
}

export function normalizeWindow(v: unknown): number | null | undefined {
  if (v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  const n = Math.floor(v);
  return n >= 1 && n <= MAX_WINDOW_MINUTES ? n : undefined;
}

const newId = () => crypto.randomUUID();
const windowText = (w: number | null) => (w === null ? 'left on' : w >= 60 && w % 60 === 0 ? `${w / 60} h` : `${w} min`);

/** Put a capability on (a window, or left on). Replaces whatever entry the capability had. No PIN rule here; the routes apply it. */
export function grant(cap: Capability, windowMinutes: number | null, note?: string, who: { harness?: string; route?: string } = {}, now = Date.now()): Entry {
  const w = normalizeWindow(windowMinutes);
  if (w === undefined) throw new Error('window_minutes must be a whole number of minutes, or null to leave it on');
  const entries = readEntries().filter((e) => e.capability !== cap);
  const entry: Entry = {
    grant_id: newId(), capability: cap, effect: 'on', granted_at: new Date(now).toISOString(),
    expires_at: w === null ? null : new Date(now + w * 60_000).toISOString(),
    ...(note && note.trim() ? { note: note.trim().slice(0, 200) } : {}),
  };
  entries.push(entry);
  writeEntries(entries);
  writeReceipt({ capability: cap, outcome: 'granted', grantId: entry.grant_id, harness: who.harness ?? 'app', toolOrRoute: who.route ?? 'grant', summary: `${cap} ${windowText(w)}${entry.note ? ` — ${entry.note}` : ''}` });
  emit({ mode: mode(), capability: cap, change: 'grant' });
  return entry;
}

/** The person's switch-off. Holds until the person turns it back on. Never needs the PIN. */
export function turnOff(cap: Capability, note?: string, who: { harness?: string; route?: string } = {}, now = Date.now()): Entry {
  const entries = readEntries().filter((e) => e.capability !== cap);
  const entry: Entry = {
    grant_id: newId(), capability: cap, effect: 'off', granted_at: new Date(now).toISOString(), expires_at: null,
    ...(note && note.trim() ? { note: note.trim().slice(0, 200) } : {}),
  };
  entries.push(entry);
  writeEntries(entries);
  writeReceipt({ capability: cap, outcome: 'revoked', grantId: entry.grant_id, harness: who.harness ?? 'app', toolOrRoute: who.route ?? 'off', summary: `${cap} turned off` });
  emit({ mode: mode(), capability: cap, change: 'off' });
  return entry;
}

/** Remove an entry (a window, or a switch-off) by its grant_id: the capability goes back to the mode's default. */
export function revoke(grantId: string, who: { harness?: string; route?: string } = {}): Entry | null {
  const entries = readEntries();
  const hit = entries.find((e) => e.grant_id === grantId);
  if (!hit) return null;
  writeEntries(entries.filter((e) => e !== hit));
  writeReceipt({ capability: hit.capability, outcome: 'revoked', grantId: hit.grant_id, harness: who.harness ?? 'app', toolOrRoute: who.route ?? 'revoke', summary: `${hit.capability} ${hit.effect === 'off' ? 'switch-off removed' : 'window removed'}` });
  emit({ mode: mode(), capability: hit.capability, change: 'revoke' });
  return hit;
}

/** Switch mode. Switching Guard ON clears every `on` entry (windows and leave-on) so nothing granted in Open mode carries into Guard; the receipt lists
 *  what was cleared. Switching back to Open restores nothing: the grants are gone and every capability is on by default again. The person's
 *  switch-offs (`off` entries) are kept in both directions: they are the person's own choice, not a grant. */
export function setMode(next: ConsentMode, who: { harness?: string; route?: string } = {}): void {
  const prev = mode();
  let cleared: Entry[] = [];
  if (next === 'guard' && prev !== 'guard') {
    const all = readEntries();
    cleared = all.filter((e) => e.effect === 'on');
    if (cleared.length) writeEntries(all.filter((e) => e.effect !== 'on'));
  }
  setConfig('consent.mode', next);
  lastMode.set(tenantKey(), next);
  const list = cleared.length ? `; cleared: ${cleared.map((e) => `${e.capability} (${e.expires_at ? 'window' : 'on'})`).join(', ')}` : '';
  writeReceipt({ capability: '*', outcome: 'mode_changed', harness: who.harness ?? 'app', toolOrRoute: who.route ?? 'mode', summary: `mode ${prev} → ${next}${list}` });
  emit({ mode: next, change: 'mode' });
}

// ── what the routes and the card ask ────────────────────────────────────────

export interface CapabilityState {
  capability: Capability;
  label: string;
  /** on: allowed with no end; window: allowed until expires_at; expired: a window that ended; off: not allowed. */
  state: 'on' | 'window' | 'expired' | 'off';
  allow: boolean;
  grant_id: string | null;
  expires_at: string | null;
  note: string | null;
  /** default: no entry, so the mode decides. grant: a window or leave-on. override: the person's switch-off. */
  source: 'default' | 'grant' | 'override';
}

export function listState(now = Date.now()): { mode: ConsentMode; capabilities: CapabilityState[] } {
  const { mode: m, entries } = snapshot();
  return {
    mode: m,
    capabilities: CAPABILITIES.map((cap) => {
      const e = entryFor(entries, cap);
      const d = decide(cap, m, entries, now);
      const state: CapabilityState['state'] = e && e.effect === 'on' && isExpired(e, now) ? 'expired'
        : !d.allow ? 'off' : e?.expires_at ? 'window' : 'on';
      return {
        capability: cap, label: CAPABILITY_LABELS[cap], state, allow: d.allow, grant_id: e?.grant_id ?? null,
        expires_at: e?.expires_at ?? null, note: e?.note ?? null, source: !e ? 'default' : e.effect === 'off' ? 'override' : 'grant',
      };
    }),
  };
}

export type PinNeed = 'none' | 'pin';

/** Does this change need the PIN? Switching Guard mode either way: always. A grant in Guard mode: always. Otherwise, any change that makes the
 *  capability MORE permissive than it is now, and only once a PIN exists: turning back on what was turned off or whose window ended, and also
 *  stretching a live window to a longer one or to leave-on (`windowMinutes`, when the caller knows it). Turning off never needs it. */
export function pinNeededForGrant(cap: Capability, now = Date.now(), windowMinutes?: number | null): PinNeed {
  const s = snapshot();
  if (s.mode === 'guard') return 'pin';
  if (!pinIsSet()) return 'none';
  if (!decide(cap, s.mode, s.entries, now).allow) return 'pin';
  const e = entryFor(s.entries, cap);
  if (e && e.effect === 'on' && e.expires_at !== null && windowMinutes !== undefined) {
    const until = windowMinutes === null ? Infinity : now + windowMinutes * 60_000;
    if (until > Date.parse(e.expires_at)) return 'pin'; // a window made longer, or left on
  }
  return 'none';
}

/** Removing an entry needs the PIN when it lets the capability through that was not let through: a switch-off, an EXPIRED window (an ended window
 *  is off until the person turns it back on), or anything else whose removal flips deny to allow. In Guard, removing a grant makes the capability
 *  off, so it needs none. */
export function pinNeededForRevoke(grantId: string, now = Date.now()): PinNeed {
  if (!pinIsSet()) return 'none';
  const s = snapshot();
  const hit = s.entries.find((e) => e.grant_id === grantId);
  if (!hit) return 'none';
  const before = decide(hit.capability, s.mode, s.entries, now).allow;
  const after = decide(hit.capability, s.mode, s.entries.filter((e) => e !== hit), now).allow;
  return !before && after ? 'pin' : 'none';
}

/** An ask that named a capability, approved: when the capability is already let through with no end, there is nothing to grant (a window
 *  would only put an end on it). Otherwise the grant is made. */
export function askWouldChange(cap: Capability, now = Date.now()): boolean {
  const s = snapshot();
  const e = entryFor(s.entries, cap);
  const d = decide(cap, s.mode, s.entries, now);
  if (!d.allow) return true;
  return !!e && e.expires_at !== null; // a window in force: the new window replaces it
}

// ── orientation ─────────────────────────────────────────────────────────────

/** One line for the companion's orientation, only when something is off or on a window. Open mode with nothing changed: null. */
export function orientationLine(now = Date.now()): string | null {
  let state: ReturnType<typeof listState>;
  try { state = listState(now); } catch { return null; }
  const caps = state.capabilities;
  const parts: string[] = [];
  if (state.mode === 'guard') {
    for (const c of caps) {
      if (c.state === 'window') parts.push(`${c.capability} on until ${hhmm(c.expires_at!)}`);
      else if (c.state === 'on') parts.push(`${c.capability} on`);
    }
    const offs = caps.filter((c) => !c.allow).map((c) => c.capability);
    if (offs.length) parts.push(`off: ${offs.join(', ')}`);
    return `Hands (Guard mode, everything is off unless granted): ${parts.join('; ')} (ask with res ask <capability> 30 for a window)`;
  }
  for (const c of caps) {
    if (c.state === 'off') parts.push(`${c.capability} off`);
    else if (c.state === 'expired') parts.push(`${c.capability} off (its window ended)`);
    else if (c.state === 'window') parts.push(`${c.capability} on until ${hhmm(c.expires_at!)}`);
  }
  if (!parts.length) return null;
  const first = caps.find((c) => c.state !== 'on')!.capability;
  return `Hands: ${parts.join('; ')} (ask with res ask ${first} 30 for a window)`;
}

// ── harness flags (Codex, dsh) ──────────────────────────────────────────────

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

export interface RunLimits {
  sandboxMode: SandboxMode;
  networkAccess: boolean;
  additionalDirectories: string[];
  /** The capabilities that narrowed this run. */
  restricted: Capability[];
}

/** The sandbox a Codex (or dsh) run is launched with, from what the configuration allows narrowed by the gate:
 *  shell off → read-only; files_outside_home off → no additional directories; web off → no network;
 *  danger-full-access needs shell, files_outside_home, web and self_code_edit all on, else it drops to workspace-write.
 *  A change made while a run is going applies from the next run (the flags are fixed at launch). Receipts only for what was narrowed,
 *  since a run is not itself an action; the actions inside it are caught at the server choke points. */
export function runLimits(
  configured: { sandboxMode: SandboxMode; networkAccess: boolean; additionalDirectories?: string[] },
  ctx: { harness: string; threadId?: string | null; readOnly?: boolean },
  now = Date.now(),
): RunLimits {
  const { mode: m, entries } = snapshot();
  const off = (cap: Capability) => !decide(cap, m, entries, now).allow;
  let sandboxMode = configured.sandboxMode;
  let networkAccess = configured.networkAccess;
  let dirs = [...(configured.additionalDirectories ?? [])];
  const restricted: Capability[] = [];
  const narrow = (cap: Capability) => { if (!restricted.includes(cap)) restricted.push(cap); };
  if (sandboxMode === 'danger-full-access' && (off('shell') || off('files_outside_home') || off('web') || off('self_code_edit'))) {
    sandboxMode = 'workspace-write';
    for (const c of ['files_outside_home', 'web', 'self_code_edit'] as const) if (off(c)) narrow(c);
  }
  if (sandboxMode !== 'read-only' && off('shell')) { sandboxMode = 'read-only'; narrow('shell'); }
  if (dirs.length && off('files_outside_home')) { dirs = []; narrow('files_outside_home'); }
  if (networkAccess && off('web')) { networkAccess = false; narrow('web'); }
  for (const cap of restricted) {
    const d = decide(cap, m, entries, now);
    writeReceipt({ capability: cap, outcome: d.outcome === 'allowed' ? 'denied' : d.outcome, grantId: d.grantId, harness: ctx.harness, threadId: ctx.threadId, toolOrRoute: 'run flags', summary: `${ctx.harness} run launched narrower: ${d.reason}` });
  }
  if (restricted.length) {
    console.debug(`[Consent] ${ctx.harness} run: sandbox=${sandboxMode} network=${networkAccess} extra_dirs=${dirs.length} (narrowed by ${restricted.join(', ')}; a change mid-run applies next turn)`);
  }
  return { sandboxMode, networkAccess, additionalDirectories: dirs, restricted };
}
