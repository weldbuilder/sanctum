// The settings service: one rule, one place.
//
//   default  <  sanctum.yaml  <  .env  <  SQLite
//
// resolveSetting(key) answers for a key the registry (registry.ts) lists: its effective value, which layer it came from, and every layer that
// had something to say. "SQLite" is the `config` KV table AND the typed tables that act as overrides (auth_preferences, the bot-token rows,
// google_auth). A key the registry does not list falls through to getSanctumConfig() as it always did.
//
// Secrets (tokens, API keys, the login password) never leave through resolveSetting: it answers { set, source }. resolveSecret(key) hands
// the value to the code that needs it (the gateway login, the OAuth client, the app's own sign-in) and to nothing else.
//
// Tenant mode: the layers are the current tenant's own (its tenant.yaml as read, its .env, its database), reached through the tenancy
// accessors. the process environment is never read in tenant mode (tenancy/child.ts rule); a call outside any tenant throws NoTenantContext.
//
// No cache. Every call reads the layers again, so a KV write or reloadConfig() is seen by the next call.
import { getSanctumConfig, getAppPasswordSource } from '../../config.js';
import { HOUSE_SCOPE_ID, NoTenantContext, envFor, getProcessFile, tenantOrNull, tenancyEnabled } from '../../tenancy/context.js';
import { deleteConfig, getConfig } from '../db.js';
import { mindFromMcpJson } from '../mind-client.js';
import { PRECEDENCE, pickWinner, type Candidate, type SettingSource } from './rule.js';
import { STATIC_KEYS, expand, lookupKey, parseBoolWord, type KeyDef } from './registry.js';
import { TYPED_READERS } from './stores.js';

export type { SettingSource } from './rule.js';
export { PRECEDENCE, pickWinner } from './rule.js';
export { REGISTRY, STATIC_KEYS, PREFERENCE_KEYS, lookupKey } from './registry.js';

/** What a secret looks like to anything that leaves the process. */
export interface SecretMarker { set: boolean; source: SettingSource }

export interface Resolution {
  /** The canonical key (an alias or a family member is answered as asked: `cron.morning.schedule`). */
  key: string;
  /** The effective value; a SecretMarker for a secret. */
  value: unknown;
  source: SettingSource;
  /** Every layer that has a value, lowest first (the default is always the first). A secret's values are { set: true }. */
  candidates: Array<{ source: SettingSource; value: unknown; via?: string }>;
  /** False for a key outside the registry (answered from getSanctumConfig()). */
  registered: boolean;
}

export interface ResolveOptions {
  /** The yaml layer to use instead of the one in force (GET /api/preferences passes the file on disk, so a save shows at once). */
  yaml?: Record<string, unknown> | null;
  /** Override the registry default (a cron family's built-in schedule). */
  default?: unknown;
  /** Leave these layers out. */
  skip?: readonly SettingSource[];
}

/** Where each layer is read from. Built live by resolveSetting; built by hand for a caller with its own sources (the updater's Mind check). */
export interface Layers {
  /** sanctum.yaml (tenant.yaml in tenant mode) as read. undefined: not available, the merged `cfg` is the stand-in. */
  raw?: Record<string, unknown> | null;
  /** The merged config (defaults, yaml, env), for keys whose paths are resolved at load and as the stand-in for `raw`. */
  cfg?: unknown;
  env: Record<string, string | undefined>;
  /** One KV row, or null/undefined/'' when there is none. */
  kv: (row: string) => string | null | undefined;
  /** A typed table's value, undefined when it holds nothing. */
  typed?: (store: keyof typeof TYPED_READERS) => unknown;
  /** The companion's .mcp.json Mind entry. */
  mcp?: () => { url: string; bearer: string } | null;
  /** Where the app password came from (config.ts holds it apart from the process environment). */
  passwordSource?: string;
}

// --- reading --------------------------------------------------------------------------------------------------------------------------

function safe<T>(fn: () => T): T | undefined {
  try { return fn(); } catch (e) { if (e instanceof NoTenantContext) throw e; return undefined; }
}

function getPath(obj: unknown, path: string): unknown {
  let cur = obj;
  for (const k of path.split('.')) {
    if (cur && typeof cur === 'object' && !Array.isArray(cur)) cur = (cur as Record<string, unknown>)[k];
    else return undefined;
  }
  return cur;
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function liveLayers(opts: ResolveOptions): Layers {
  const rt = tenantOrNull('the settings service'); // throws NoTenantContext with tenancy on and no tenant
  let cfg: unknown;
  try { cfg = getSanctumConfig(); } catch (e) { if (e instanceof NoTenantContext) throw e; cfg = undefined; }
  let raw: Record<string, unknown> | null | undefined;
  if (opts.yaml !== undefined) raw = opts.yaml;
  else if (rt) raw = rt.file ?? (rt.id === HOUSE_SCOPE_ID ? getProcessFile() ?? undefined : undefined);
  else raw = getProcessFile() ?? undefined;
  const mcpPath = (cfg as { agent?: { mcp_json_path?: string } } | undefined)?.agent?.mcp_json_path;
  return {
    raw,
    cfg,
    env: envFor('the settings service'),
    kv: (row) => safe(() => getConfig(row)),
    typed: (store) => safe(() => TYPED_READERS[store].read()),
    mcp: () => mindFromMcpJson(mcpPath),
    passwordSource: tenancyEnabled() ? undefined : safe(() => getAppPasswordSource()),
  };
}

/** One layer's raw value as a typed value, or undefined when the layer holds nothing usable for this key. */
function parse(def: KeyDef, v: unknown, layer: 'yaml' | 'env' | 'kv'): unknown {
  if (v === undefined || v === null) return undefined;
  switch (def.type) {
    case 'bool': {
      if (layer === 'env') return v === 'true' ? true : def.envTrueOnly ? undefined : v === 'false' ? false : undefined;
      // A KV row is true for 'true' / '1', anything else (an empty string too) is false: what getConfigBool always did.
      if (layer === 'kv') return typeof v === 'string' ? v === 'true' || v === '1' : parseBoolWord(v) ?? false;
      // yaml: yes/on/true/1 and no/off/false/0 in any case; anything else is false (config.ts says so once at load).
      return parseBoolWord(v) ?? false;
    }
    case 'number': {
      const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? parseFloat(v) : NaN;
      if (!Number.isFinite(n)) return undefined;
      return layer === 'yaml' && def.yamlFalsyAbsent && n === 0 ? undefined : n;
    }
    case 'enum':
      return typeof v === 'string' && def.values?.includes(v) ? v : undefined;
    case 'list': {
      const arr = typeof v === 'string' && layer === 'env' ? v.split(',').map((s) => s.trim()).filter(Boolean) : v;
      if (!Array.isArray(arr)) return undefined;
      return arr.filter((x): x is string => typeof x === 'string');
    }
    default: {
      const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v : undefined;
      return s !== undefined && s.trim() !== '' ? (layer === 'yaml' ? s : s.trim()) : undefined;
    }
  }
}

/** Every layer that has a value for `def`, lowest first, with raw values (secrets included: callers decide what leaves). */
function compute(def: KeyDef, params: Record<string, string>, L: Layers, opts: ResolveOptions): Candidate[] {
  const skip = new Set(opts.skip ?? []);
  const out: Candidate[] = [];
  const dflt = opts.default !== undefined ? opts.default : def.default;
  out.push({ source: 'default', value: dflt });

  // the login password: its env layer is held by config.ts apart from the process environment, so it is read from there
  if (def.key === 'auth.password') {
    const cfgPw = String(getPath(L.cfg, 'auth.password') ?? '');
    const rawPw = L.raw ? getPath(L.raw, 'auth.password') : undefined;
    const yamlPw = typeof rawPw === 'string' && rawPw !== '' ? rawPw : undefined;
    const fromEnv = L.passwordSource !== undefined
      ? L.passwordSource === 'parent_env' || L.passwordSource === 'dotenv'
      : cfgPw !== '' && cfgPw !== (yamlPw ?? ''); // tenant: its .env value is in the config, not in an environment
    if (yamlPw !== undefined && !skip.has('yaml')) out.push({ source: 'yaml', value: yamlPw });
    else if (!L.raw && cfgPw && !fromEnv && !skip.has('yaml')) out.push({ source: 'yaml', value: cfgPw });
    if (fromEnv && cfgPw && !skip.has('env')) out.push({ source: 'env', value: cfgPw });
    return out;
  }

  // .mcp.json (Mind only), below yaml. The key is one unit with the URL: it counts only when the URL in effect is the .mcp.json one.
  let mcpUnit: 'only' | 'never' | undefined;
  if (def.mcpJson === 'bearer') {
    const urlDef = lookupKey('integrations.mind_cloud.mcp_url')!.def;
    const url = pickWinner(compute(urlDef, {}, L, {}).filter((c) => c.source !== 'default' || c.value !== '' ));
    mcpUnit = url?.source === 'mcp_json' ? 'only' : 'never';
  }
  if (def.mcpJson && !skip.has('mcp_json') && mcpUnit !== 'never') {
    const m = safe(() => L.mcp?.() ?? null);
    const v = def.mcpJson === 'url' ? m?.url : m?.bearer;
    if (typeof v === 'string' && v.trim() !== '') out.push({ source: 'mcp_json', value: v.trim() });
  }
  if (mcpUnit === 'only') return out; // the saved key and the environment's belong to a URL that is not in effect

  // env
  let envCand: Candidate | undefined;
  if (def.env) {
    const v = parse(def, (L.env[def.env] ?? '').trim() === '' ? undefined : (L.env[def.env] as string).trim(), 'env');
    if (v !== undefined) envCand = { source: 'env', value: v, via: def.env };
  }

  // yaml
  const yamlPath = expand(def.yaml, params);
  if (yamlPath && !skip.has('yaml')) {
    const rawVal = L.raw ? getPath(L.raw, yamlPath) : undefined;
    const cfgVal = L.cfg !== undefined ? getPath(L.cfg, yamlPath) : undefined;
    let v: unknown;
    if (def.merged && L.cfg !== undefined) {
      if (envCand) v = parse(def, rawVal, 'yaml'); // the merged value has the environment in it
      else if (opts.yaml !== undefined && parse(def, rawVal, 'yaml') !== undefined) v = parse(def, rawVal, 'yaml'); // a file handed in (GET): what it says, as written
      else {
        v = parse(def, cfgVal, 'yaml');
        if (v !== undefined && parse(def, rawVal, 'yaml') === undefined && sameJson(v, dflt)) v = undefined;
      }
    } else if (L.raw !== undefined && L.raw !== null) {
      v = parse(def, rawVal, 'yaml');
    } else if (!envCand) {
      v = parse(def, cfgVal, 'yaml'); // no file to look at (tenant without one, a bare test config): what the merged config holds is the yaml's
      if (v !== undefined && sameJson(v, dflt)) v = undefined;
    }
    if (v !== undefined) out.push({ source: 'yaml', value: v, via: yamlPath });
  }

  if (envCand && !skip.has('env')) out.push(envCand);

  // SQLite: KV rows, then the typed table above them
  if (!skip.has('db')) {
    const rows = def.kv === undefined ? [] : typeof def.kv === 'string' ? [def.kv] : def.kv;
    for (const row of rows) {
      const name = expand(row, params)!;
      const v = parse(def, L.kv(name), 'kv');
      if (v !== undefined) { out.push({ source: 'db', value: v, via: `config:${name}` }); break; }
    }
    if (def.typed) {
      const v = L.typed?.(def.typed);
      if (v !== undefined && v !== null) out.push({ source: 'db', value: v, via: TYPED_READERS[def.typed].via });
    }
  }
  return out;
}

function conclude(def: KeyDef, params: Record<string, string>, L: Layers, opts: ResolveOptions, asked: string): { winner: Candidate; cands: Candidate[]; value: unknown } {
  const cands = compute(def, params, L, opts);
  const winner = pickWinner(cands)!;
  let value = winner.value;
  if (winner.source === 'default' && def.follow && opts.default === undefined) {
    const f = lookupKey(def.follow);
    if (f) value = conclude(f.def, f.params, L, { yaml: opts.yaml, skip: ['db'] }, def.follow).value;
  }
  void asked;
  return { winner, cands, value };
}

function describe(def: KeyDef, params: Record<string, string>, L: Layers, opts: ResolveOptions, asked: string): Resolution {
  const { winner, cands, value } = conclude(def, params, L, opts, asked);
  if (def.secret) {
    const isSet = typeof value === 'string' ? value !== '' : !!value;
    return {
      key: asked, registered: true,
      value: { set: isSet, source: isSet ? winner.source : 'default' } satisfies SecretMarker,
      source: isSet ? winner.source : 'default',
      candidates: cands.filter((c) => c.source !== 'default' || c.value !== '').map((c) => ({ source: c.source, value: { set: true }, via: c.via })),
    };
  }
  return { key: asked, registered: true, value, source: winner.source, candidates: cands.map((c) => ({ source: c.source, value: c.value, via: c.via })) };
}

// --- public ---------------------------------------------------------------------------------------------------------------------------

/**
 * The effective value of a setting and where it comes from. A secret answers { set, source } (see resolveSecret). A key the registry does not
 * list is answered from getSanctumConfig() (source 'yaml' when it holds something, else 'default'), unchanged from before the service.
 */
export function resolveSetting(key: string, opts: ResolveOptions = {}): Resolution {
  const found = lookupKey(key);
  if (!found) {
    let v: unknown;
    try { v = getPath(getSanctumConfig(), key); } catch (e) { if (e instanceof NoTenantContext) throw e; v = undefined; }
    return { key, registered: false, value: v, source: v === undefined ? 'default' : 'yaml', candidates: v === undefined ? [] : [{ source: 'yaml', value: v }] };
  }
  return describe(found.def, found.params, liveLayers(opts), opts, key);
}

/** The same as resolveSetting for a caller that brings its own layers (the updater reads the Mind with read-only sources). */
export function resolveSettingFrom(key: string, layers: Layers, opts: ResolveOptions = {}): Resolution {
  const found = lookupKey(key);
  if (!found) throw new Error(`settings: ${key} is not in the registry`);
  return describe(found.def, found.params, layers, opts, key);
}

/** The raw value of a secret, for the code that has to use it (a bot login, an OAuth client, the sign-in check). null when none is set. */
export function resolveSecret(key: string, opts: ResolveOptions = {}): string | null {
  const found = lookupKey(key);
  if (!found || !found.def.secret) throw new Error(`settings: ${key} is not a registered secret`);
  const { winner } = conclude(found.def, found.params, liveLayers(opts), opts, key);
  return typeof winner.value === 'string' && winner.value !== '' ? winner.value : null;
}

/** The raw value of a secret from layers the caller built (the Mind check). */
export function resolveSecretFrom(key: string, layers: Layers): { value: string | null; source: SettingSource } {
  const found = lookupKey(key);
  if (!found || !found.def.secret) throw new Error(`settings: ${key} is not a registered secret`);
  const { winner } = conclude(found.def, found.params, layers, {}, key);
  const v = typeof winner.value === 'string' && winner.value !== '' ? winner.value : null;
  return { value: v, source: v === null ? 'default' : winner.source };
}

/** Every fixed-name key's effective value and source, for the GET endpoints. Secrets are markers. */
export function resolveAll(opts: ResolveOptions = {}): { effective: Record<string, unknown>; sources: Record<string, SettingSource> } {
  const L = liveLayers(opts);
  const effective: Record<string, unknown> = {};
  const sources: Record<string, SettingSource> = {};
  for (const def of STATIC_KEYS) {
    const r = describe(def, {}, L, opts, def.key);
    effective[def.key] = r.value;
    sources[def.key] = r.source;
  }
  return { effective, sources };
}

export const SOURCE_ORDER: readonly SettingSource[] = PRECEDENCE;

/**
 * Earlier versions let the /model command write the KV row `agent.model`, which nothing read; it is not a layer of the rule now (/model writes
 * auth_preferences.preferred_model). A leftover row is named in one log line, then deleted. Returns the ignored value, or null when there was none.
 */
export function retireLegacyModelRow(): string | null {
  let v: string | null | undefined;
  try { v = getConfig('agent.model'); } catch (e) { if (e instanceof NoTenantContext) throw e; return null; }
  if (v === null || v === undefined) return null;
  console.warn(`[config] ignoring and deleting the old database row agent.model=${JSON.stringify(v)} (written by /model in earlier versions); /model now sets auth_preferences.preferred_model, /model reset clears it`);
  try { deleteConfig('agent.model'); } catch (e) { if (e instanceof NoTenantContext) throw e; }
  return v;
}
