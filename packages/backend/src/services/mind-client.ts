// sanctum-mind client. The one place Sanctum talks to a mind service.
//
// Speaks sanctum-mind's documented REST surface: POST <root>/verbs/<name> with
// a bearer key, a JSON body that always carries mind_id, and a result that is
// exactly { ok: true, receipt: { projection, warnings } } or
// { ok: false, error: { code, message, field } }. Only read-scoped verbs are
// called from here (mind_orient, mind_search, mind_surface, mind_thread list);
// the service refuses anything else under a read grant, and this module never
// asks for anything else.
//
// Why this exists: the previous hooks code was inherited from the reference
// app and spoke a different Mind. It called verbs sanctum-mind does not have
// (mind_ground, mind_spark), used argument names its strict schemas reject
// (n_results, limit, count, action), never sent mind_id, and posted bare
// JSON-RPC with no bearer. Every call failed and was swallowed into null, so
// the companion ran with no mind and nothing said so.
import { envFor } from '../tenancy/context.js';
import { existsSync } from 'node:fs';
import { readOwnText } from '../tenancy/own-files.js';
import { getConfig } from './db.js';
import { getSanctumConfig } from '../config.js';

export interface MindSettings { root: string; bearer: string; mindId: string }

/** The service's mind id pattern (and the three names it reserves). */
export const MIND_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
export const MIND_ID_RULE = 'mind_id must be 1 to 64 characters of letters, digits, "_" or "-" (^[a-zA-Z0-9_-]{1,64}$)';
const RESERVED_MIND_IDS = new Set(['__proto__', 'constructor', 'prototype']);
/** null when `id` is a mind id the service accepts, else the rule it breaks. */
export function mindIdProblem(id: unknown): string | null {
  return typeof id === 'string' && MIND_ID_PATTERN.test(id) && !RESERVED_MIND_IDS.has(id) ? null : MIND_ID_RULE;
}

export type MindResult<P = unknown> =
  | { ok: true; projection: P; warnings: string[] }
  | { ok: false; code: string; message: string };

/** Accepts a root, a /mcp URL or a /verbs URL and returns the service root with no trailing slash. */
export function mindRootFrom(raw: string): string {
  const trimmed = String(raw || '').trim().replace(/\/+$/, '');
  return trimmed.replace(/\/(mcp|verbs(\/[^/]*)?)$/, '');
}

/** The sanctum-mind entry in the companion's .mcp.json, if any: its URL and the bearer in its headers. */
export function mindFromMcpJson(path: string | undefined, readText: (p: string) => string | null = (p) => (existsSync(p) ? readOwnText(p) : null)): { url: string; bearer: string } | null {
  if (!path) return null;
  try {
    const raw = readText(path);
    if (!raw) return null;
    const servers = (JSON.parse(raw) as { mcpServers?: Record<string, { url?: string; headers?: Record<string, string> }> }).mcpServers || {};
    const key = Object.keys(servers).find(k => /mind/i.test(k));
    const entry = key ? servers[key] : undefined;
    if (!entry?.url) return null;
    const auth = Object.entries(entry.headers || {}).find(([h]) => h.toLowerCase() === 'authorization')?.[1] || '';
    return { url: entry.url, bearer: auth.replace(/^Bearer\s+/i, '').trim() };
  } catch { return null; }
}

export type MindKeySource = 'settings' | 'environment' | 'mcp_json';
export interface MindSettingsReport { enabled: boolean; settings: MindSettings | null; missing: string[]; invalid?: string[]; keySource?: MindKeySource | null }

/** Where the Mind's inputs are read from. The app passes its own sources; the updater passes read-only ones. */
export interface MindSettingsSources {
  read: (key: string) => string;
  yaml?: { enabled?: boolean; mcp_url?: string; mind_id?: string } | null;
  mcpJsonPath?: string;
  env?: Record<string, string | undefined>;
}

/** The bearer and where it came from: the Settings → Mind card (DB), then MIND_API_KEY from the environment. */
function savedKey(src: MindSettingsSources): { key: string; source: 'settings' | 'environment' } | null {
  const fromDb = src.read('mind.api_key') || src.read('integrations.mind_api_key');
  if (fromDb) return { key: fromDb, source: 'settings' };
  // Tenant mode: only the tenant's own .env; the process environment (the operator's key) is never read.
  const fromEnv = String((src.env ?? envFor('mind-client')).MIND_API_KEY ?? '').trim();
  return fromEnv ? { key: fromEnv, source: 'environment' } : null;
}

/**
 * Where the Mind's settings come from, in order: the Settings → Mind card (DB
 * keys), sanctum.yaml, then the .mcp.json entry. The key comes from the card
 * first, then MIND_API_KEY in the environment (.env), then the .mcp.json
 * bearer. No logging; callers decide what to say.
 */
export function describeMindSettingsFrom(src: MindSettingsSources): MindSettingsReport {
  const yaml = src.yaml;
  const read = (key: string): string => { try { return (src.read(key) ?? '').trim(); } catch { return ''; } };
  const enabledDb = read('mind.enabled');
  const enabled = enabledDb !== '' ? enabledDb === 'true' : !!yaml?.enabled;
  if (!enabled) return { enabled: false, settings: null, missing: [] };
  // The .mcp.json entry is one unit: its bearer is used only when its URL is
  // the one selected. A key from one service is never sent to a host named
  // elsewhere.
  const configuredUrl = read('mind.url') || (yaml?.mcp_url ?? '').trim();
  const fromMcp = configuredUrl ? null : mindFromMcpJson(src.mcpJsonPath);
  let root = '';
  try { root = mindRootFrom(configuredUrl || fromMcp?.url || ''); } catch { root = ''; }
  // The bearer comes from the same source as the URL: a key stored for the Mind card (or MIND_API_KEY) is
  // never sent to the host named in .mcp.json (only selected when no card/yaml URL exists), and vice versa.
  const saved = fromMcp ? null : savedKey({ ...src, read });
  const bearer = fromMcp ? (fromMcp.bearer || '') : (saved?.key || '');
  const keySource: MindKeySource | null = fromMcp ? (fromMcp.bearer ? 'mcp_json' : null) : (saved?.source ?? null);
  const mindId = read('mind.mind_id') || yaml?.mind_id || '';
  const missing = [!root && 'url', !bearer && 'api key', !mindId && 'mind id'].filter((x): x is string => Boolean(x));
  // A malformed id is treated like a missing one: the service would answer every call with invalid_input.
  const invalid = mindId && mindIdProblem(mindId) ? [MIND_ID_RULE] : [];
  if (missing.length || invalid.length) return { enabled: true, settings: null, missing, ...(invalid.length ? { invalid } : {}), keySource };
  return { enabled: true, settings: { root, bearer, mindId }, missing: [], keySource };
}

export function describeMindSettings(): MindSettingsReport {
  let cfg: ReturnType<typeof getSanctumConfig> | null = null;
  try { cfg = getSanctumConfig(); } catch { cfg = null; }
  return describeMindSettingsFrom({
    read: (key) => { try { return (getConfig(key) ?? '').trim(); } catch { return ''; } },
    yaml: cfg?.integrations?.mind_cloud,
    mcpJsonPath: cfg?.agent?.mcp_json_path,
  });
}

/** What the UI shows in place of a secret: the dots, plus the last 4 only when the key is long enough that 4 is a small part of it. */
export function keyFingerprint(key: string): string {
  return key.length <= 8 ? '••••' : `••••${key.slice(-4)}`;
}

/** Where the key in use comes from and its masked tail, for Settings → Mind. Never the key itself. */
export function mindKeyInfo(): { source: MindKeySource | null; fingerprint: string | null } {
  let cfg: ReturnType<typeof getSanctumConfig> | null = null;
  try { cfg = getSanctumConfig(); } catch { cfg = null; }
  const read = (key: string): string => { try { return (getConfig(key) ?? '').trim(); } catch { return ''; } };
  // The key is reported whether or not the Mind is switched on, so the card can show it while the toggle is off.
  // Same rule as describeMindSettingsFrom: the card/environment key pairs with a card or yaml URL; the
  // .mcp.json entry supplies its own bearer.
  const hasConfiguredUrl = !!(read('mind.url') || (cfg?.integrations?.mind_cloud?.mcp_url ?? '').trim());
  const saved = hasConfiguredUrl ? savedKey({ read }) : null;
  const key = hasConfiguredUrl ? (saved?.key ?? '') : (mindFromMcpJson(cfg?.agent?.mcp_json_path)?.bearer ?? '');
  const source: MindKeySource | null = saved?.source ?? (key ? 'mcp_json' : null);
  return { source, fingerprint: key ? keyFingerprint(key) : null };
}

export type MindUrlSource = 'settings' | 'yaml' | 'mcp_json';

/** The URL in effect and where it comes from, by the same order the watchdog and the hooks use: the card, sanctum.yaml, the .mcp.json entry. */
export function mindUrlInfo(): { source: MindUrlSource | null; url: string } {
  let cfg: ReturnType<typeof getSanctumConfig> | null = null;
  try { cfg = getSanctumConfig(); } catch { cfg = null; }
  const read = (key: string): string => { try { return (getConfig(key) ?? '').trim(); } catch { return ''; } };
  const card = read('mind.url');
  if (card) return { source: 'settings', url: card };
  const yaml = (cfg?.integrations?.mind_cloud?.mcp_url ?? '').trim();
  if (yaml) return { source: 'yaml', url: yaml };
  const mcp = mindFromMcpJson(cfg?.agent?.mcp_json_path);
  return mcp ? { source: 'mcp_json', url: mcp.url } : { source: null, url: '' };
}

/** The key that goes with `root` for a draft test that leaves the key blank, and where it comes from. Only for the host it belongs to. */
/** The mind_id in effect: the card's, else sanctum.yaml's (integrations.mind_cloud.mind_id), else ''. */
export function savedMindId(): string {
  let cfg: ReturnType<typeof getSanctumConfig> | null = null;
  try { cfg = getSanctumConfig(); } catch { cfg = null; }
  let card = '';
  try { card = (getConfig('mind.mind_id') ?? '').trim(); } catch { card = ''; }
  return card || (cfg?.integrations?.mind_cloud?.mind_id ?? '').trim();
}

export function savedMindKeyFor(root: string): { key: string; source: MindKeySource } | null {
  const info = mindUrlInfo();
  let savedRoot = '';
  try { savedRoot = mindRootFrom(info.url); } catch { savedRoot = ''; }
  if (!savedRoot || savedRoot !== root) return null;
  if (info.source === 'mcp_json') {
    let cfg: ReturnType<typeof getSanctumConfig> | null = null;
    try { cfg = getSanctumConfig(); } catch { cfg = null; }
    const bearer = mindFromMcpJson(cfg?.agent?.mcp_json_path)?.bearer ?? '';
    return bearer ? { key: bearer, source: 'mcp_json' } : null;
  }
  const read = (key: string): string => { try { return (getConfig(key) ?? '').trim(); } catch { return ''; } };
  return savedKey({ read });
}

/** Settings for a call, or null when the Mind is off or incomplete (logged once until it resolves). */
export function resolveMindSettings(): MindSettings | null {
  const report = describeMindSettings();
  if (!report.enabled) return null;
  if (!report.settings) {
    const parts = [report.missing.length ? `${report.missing.join(', ')} missing` : '', ...(report.invalid ?? [])].filter(Boolean);
    warnOnce('config', `[Mind] enabled but incomplete: ${parts.join('; ')}. Set them in Settings → Mind.`);
    return null;
  }
  clearWarnings('config');
  return report.settings;
}

// One line per (verb, failure) while a failure streak lasts. A success for a
// verb clears its entries, so a service that recovers and fails again is heard
// again. The config warning clears when settings resolve.
const warned = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(redactUrls(message));
}
/** Masks user:pass@ in any URL in a log line. */
export function redactUrls(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]*@/gi, '$1***@');
}

/** A body over this is not parsed: a Mind answers with a few KB, so more is a wrong service or a runaway. */
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
/** The response text, or null when it is over the cap (content-length first, else counted as it is read). */
async function readCapped(res: Response, cap = MAX_RESPONSE_BYTES): Promise<string | null> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > cap) { try { await res.body?.cancel(); } catch { /* ignore */ } return null; }
  if (!res.body) { const t = await res.text(); return Buffer.byteLength(t) > cap ? null : t; }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) { try { await reader.cancel(); } catch { /* ignore */ } return null; }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
function clearWarnings(prefix: string): void {
  for (const key of warned) if (key === prefix || key.startsWith(`${prefix}:`)) warned.delete(key);
}
/** Test hook. */
export function resetMindWarnings(): void { warned.clear(); }

export async function callMindVerb<P = unknown>(
  name: string,
  input: Record<string, unknown>,
  timeoutMs = 7000,
  settings: MindSettings | null = resolveMindSettings(),
  fetchImpl: typeof fetch = fetch,
  opts: { quiet?: boolean } = {},
): Promise<MindResult<P>> {
  // quiet: a probe (the watchdog, a draft test) reports through its own record, not the once-per-streak log,
  // and never touches the streak state.
  const warn = opts.quiet ? () => {} : warnOnce;
  const clear = opts.quiet ? () => {} : clearWarnings;
  if (!settings) return { ok: false, code: 'disabled', message: 'mind is not configured' };
  const url = `${settings.root}/verbs/${encodeURIComponent(name)}`;
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${settings.bearer}` },
      body: JSON.stringify({ mind_id: settings.mindId, ...input }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await readCapped(res);
    if (text === null) {
      const code = 'response_too_large';
      warn(`${name}:${code}`, `[Mind] ${name} ${code}: ${settings.root} answered with more than ${MAX_RESPONSE_BYTES / 1024 / 1024} MiB; not read. Check the URL in Settings → Mind.`);
      return { ok: false, code, message: 'the response was over the size limit' };
    }
    let body: any = null;
    try { body = JSON.parse(text); } catch { body = null; }
    if (body && body.ok === true && body.receipt && typeof body.receipt === 'object') {
      clear(name);
      return { ok: true, projection: body.receipt.projection as P, warnings: Array.isArray(body.receipt.warnings) ? body.receipt.warnings : [] };
    }
    // sanctum-mind answers every verb with { ok, receipt } or { ok:false, error }.
    // A 2xx without that envelope is a different service on this URL: most
    // likely the earlier sanctum-mind HTTP server, which returns bare results.
    if (res.ok && !(body && body.ok === false && body.error)) {
      const code = 'not_sanctum_mind';
      warn(`${name}:${code}`, `[Mind] ${name}: ${settings.root} answered ${res.status} without the { ok, receipt } envelope. This is not a current sanctum-mind service (an older sanctum-mind HTTP server, or something else on that URL). Check the URL in Settings → Mind.`);
      return { ok: false, code, message: 'the server did not answer with the sanctum-mind receipt envelope' };
    }
    const code = body?.error?.code ?? `http_${res.status}`;
    const message = body?.error?.message ?? `HTTP ${res.status}`;
    warn(`${name}:${code}`, `[Mind] ${name} failed: ${code} — ${message}${body?.error?.field ? ` (field ${body.error.field})` : ''}`);
    return { ok: false, code, message };
  } catch (err) {
    const e = err as Error;
    const code = e.name === 'TimeoutError' ? 'timeout' : 'unreachable';
    warn(`${name}:${code}`, `[Mind] ${name} ${code} at ${settings.root}: ${e.message}`);
    return { ok: false, code, message: e.message };
  }
}


export type MindHealthResult =
  | { ok: true; version?: string; schema?: string }
  | { ok: false; code: 'unreachable' | 'timeout' | 'not_sanctum_mind' | 'response_too_large' | 'db_down' | `http_${number}`; message: string; version?: string };

/**
 * GET <root>/health: open (no bearer), answers the receipt envelope with { verbs, db, version, schema }
 * and 503 with db "down" when the service cannot reach its database. Never logs; the caller reports.
 */
export async function callMindHealth(root: string, timeoutMs = 7000, fetchImpl: typeof fetch = fetch): Promise<MindHealthResult> {
  try {
    const res = await fetchImpl(`${root}/health`, { method: 'GET', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    const text = await readCapped(res);
    if (text === null) return { ok: false, code: 'response_too_large', message: 'the response was over the size limit' };
    let body: any = null;
    try { body = JSON.parse(text); } catch { body = null; }
    const p = body && body.ok === true && body.receipt && typeof body.receipt === 'object' ? body.receipt.projection : null;
    if (!p || typeof p !== 'object') {
      return { ok: false, code: res.ok ? 'not_sanctum_mind' : (`http_${res.status}` as `http_${number}`), message: res.ok ? 'the server did not answer with the sanctum-mind receipt envelope' : `HTTP ${res.status}` };
    }
    const version = typeof p.version === 'string' ? p.version.slice(0, 64) : undefined;
    const schema = typeof p.schema === 'string' ? p.schema.slice(0, 64) : undefined;
    if (p.db === 'down' || !res.ok) return { ok: false, code: 'db_down', message: 'the Mind cannot reach its database', ...(version ? { version } : {}) };
    return { ok: true, ...(version ? { version } : {}), ...(schema ? { schema } : {}) };
  } catch (err) {
    const e = err as Error;
    return { ok: false, code: e.name === 'TimeoutError' ? 'timeout' : 'unreachable', message: e.name === 'TimeoutError' ? 'timed out' : 'could not connect' };
  }
}

// ── Renderers: projections → the compact text the context block carries ──

const one = (v: unknown, n = 240): string => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

function lines(items: unknown[] | undefined, map: (item: any) => string, limit: number): string[] {
  return (Array.isArray(items) ? items : []).slice(0, limit).map(map).filter(Boolean).map(s => `- ${s}`);
}

export function renderOrient(p: any): string {
  const s = p?.sections ?? {};
  const out: string[] = [];
  const cores = s.identity?.cores;
  if (Array.isArray(cores) && cores.length) out.push('**Identity cores:**', ...lines(cores, c => one(c.content ?? c.text ?? c.statement, 300), 6));
  const vows = s.vows?.vows ?? s.vows;
  if (Array.isArray(vows) && vows.length) out.push('**Vows:**', ...lines(vows, v => `${one(v.content ?? v.text ?? v.vow, 200)}${v.broken === true ? ' (broken)' : ''}`, 6));
  const st = s.state;
  if (st && typeof st === 'object' && !st.error) {
    const fields = ['mood', 'energy', 'momentum', 'register', 'afterglow'].map(k => st[k] != null ? `${k} ${one(st[k], 40)}` : '').filter(Boolean);
    const note = st.note ? ` · ${one(st.note, 160)}` : '';
    if (fields.length || note) out.push(`**State:** ${fields.join(', ')}${note}`);
  }
  const h = s.handoff?.handoff;
  if (h) out.push(`**Last handoff:** ${one(typeof h.handoff === 'string' ? h.handoff : JSON.stringify(h.handoff ?? h), 400)}`);
  const loops = s.loops?.loops;
  if (Array.isArray(loops) && loops.length) out.push('**Open loops:**', ...lines(loops, l => `${l.urgency ? `[${l.urgency}] ` : ''}${one(l.label ?? l.content, 160)}`, 6));
  const threads = s.threads?.threads;
  if (Array.isArray(threads) && threads.length) out.push('**Active threads:**', ...lines(threads, t => one(t.label, 160), 6));
  const tasks = s.tasks?.tasks;
  if (Array.isArray(tasks) && tasks.length) out.push('**Tasks:**', ...lines(tasks, t => `${t.status ? `[${t.status}] ` : ''}${one(t.title, 160)}`, 6));
  // What the mind is carrying: mind_attend's heaviest items (added to mind_orient after the first client).
  const carrying = s.attention?.items;
  if (Array.isArray(carrying) && carrying.length) out.push('**Carrying (heaviest first):**', ...lines(carrying, a => `${a.type ? `[${a.type}] ` : ''}${one(a.label, 160)}${a.pinned === true ? ' (pinned)' : ''}`, 7));
  const weather = s.weather?.report;
  if (weather) out.push(`**Weather:** ${one(weather, 300)}`);
  const inbox = s.inbox?.letters ?? s.inbox?.inbox;
  if (Array.isArray(inbox) && inbox.length) out.push(`**Unread letters:** ${inbox.length}`);
  return out.join('\n');
}

export function renderSearch(p: any): string {
  return lines(p?.hits, h => `${h.label ? `${one(h.label, 80)}: ` : ''}${one(h.snippet, 240)}`, 6).join('\n');
}

export function renderSurface(p: any): string {
  const out: string[] = [];
  const core = lines(p?.core, h => `${h.label ? `${one(h.label, 80)}: ` : ''}${one(h.snippet, 200)}`, 3);
  const novel = lines(p?.novel, h => `${h.label ? `${one(h.label, 80)}: ` : ''}${one(h.snippet, 200)}`, 2);
  const edge = lines(p?.edge, h => `${h.label ? `${one(h.label, 80)}: ` : ''}${one(h.snippet, 160)}`, 2);
  if (core.length) out.push(...core);
  if (novel.length) out.push('**Less obvious, related:**', ...novel);
  if (edge.length) out.push('**Neighbours in the graph:**', ...edge);
  return out.join('\n');
}

export function renderThreads(p: any): string {
  return lines(p?.threads, t => `${t.priority && t.priority !== 'normal' ? `[${t.priority}] ` : ''}${one(t.label, 160)}`, 5).join('\n');
}

/**
 * A query the service will accept. mind_search and mind_surface take
 * nonBlankText(2000): no NUL, well-formed Unicode only (a lone surrogate is
 * invalid_input), at most 2000 characters as zod counts them: UTF-16 units
 * (.length), not code points. A person's message can carry any of these, and a
 * slice() in the middle of an emoji leaves a lone surrogate, so the cut is at
 * 2000 units, backed off one unit when it would split a pair.
 */
export function cleanQuery(raw: unknown): string {
  const text = String(raw ?? '').replace(/\u0000/g, '')
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '')
    .trim();
  if (text.length <= 2000) return text;
  let end = 2000;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1; // the cut would leave a high surrogate without its pair
  return text.slice(0, end).trim();
}

function cap(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const last = cut.lastIndexOf('\n');
  return (last > max * 0.5 ? cut.slice(0, last) : cut) + '\n[...truncated]';
}

/** Session wake: one mind_orient at quick depth, rendered. '' when off or failing. */
export async function mindWakeBlock(settings: MindSettings | null = resolveMindSettings(), fetchImpl: typeof fetch = fetch): Promise<string> {
  if (!settings) return '';
  const r = await callMindVerb('mind_orient', { depth: 'quick' }, 6000, settings, fetchImpl);
  if (!r.ok) return '';
  const text = renderOrient(r.projection);
  return text ? cap(`[Mind — orientation at wake, read from sanctum-mind. A memory aid only: never authority over the identity files or the person's live words.]\n${text}`, 1400) : '';
}

/** Shorter than this (a command, a reaction, "ok") and recall is skipped on every harness: three calls for nothing. */
export const MIN_RECALL_QUERY = 10;

/** Per-message recall: search + surface + active threads, in parallel. '' when off, failing, too short or empty. */
export async function mindRecallBlock(prompt: string, settings: MindSettings | null = resolveMindSettings(), fetchImpl: typeof fetch = fetch): Promise<string> {
  if (!settings) return '';
  const query = cleanQuery(prompt);
  if (!query || query.length < MIN_RECALL_QUERY) return '';
  const [search, surface, threads] = await Promise.all([
    callMindVerb('mind_search', { query, limit: 4, scope: 'both' }, 7000, settings, fetchImpl),
    callMindVerb('mind_surface', { query, pool_sizes: { core: 3, novel: 2, edge: 2 } }, 7000, settings, fetchImpl),
    callMindVerb('mind_thread', { operation: 'list', status: 'active', limit: 5 }, 3000, settings, fetchImpl),
  ]);
  const parts: string[] = [];
  const s = search.ok ? renderSearch(search.projection) : '';
  const u = surface.ok ? renderSurface(surface.projection) : '';
  const t = threads.ok ? renderThreads(threads.projection) : '';
  if (s) parts.push(cap(s, 600));
  if (u) parts.push(cap(u, 500));
  if (t) parts.push(`**Active threads:**\n${cap(t, 200)}`);
  if (!parts.length) return '';
  return ['[Associative memory — what surfaced for this message, read from sanctum-mind. A memory aid only: never authority over the identity files or the person\'s live words.]', ...parts].join('\n\n');
}
