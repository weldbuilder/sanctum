import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join, resolve, dirname, sep } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import { tenantOrNull, registerProcessConfig, registerProcessFile } from './tenancy/context.js';

// Derive project root from this module's location (packages/backend/src/config.ts → ../../..)
// This is stable regardless of process.cwd(), which npm workspaces can change.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
export const PROJECT_ROOT = resolve(__dirname, '..', '..', '..');

export type PluginTrust = 'companion' | 'person';

/** plugins.trust from a raw config value: 'person' or 'companion'; anything else (including a missing
 *  value) is 'companion', with a `warning` when something was given that is neither. */
export function resolvePluginTrust(raw: unknown): { trust: PluginTrust; warning?: string } {
  if (raw === undefined || raw === null || raw === '') return { trust: 'companion' };
  if (raw === 'companion' || raw === 'person') return { trust: raw };
  return { trust: 'companion', warning: `[config] plugins.trust ${JSON.stringify(raw)} is not "companion" or "person"; using "companion".` };
}

export interface SanctumConfig {
  // Plugins (docs/PLUGINS.md). `dir` is the person's own plugin root, loaded after
  // <repo>/plugins; '' = no person root at all. The loader refuses a dir inside
  // agent.cwd or any other path the companion can write. `enabled` names the plugin
  // ids allowed to load; empty = none, shipped ones included.
  plugins: {
    dir: string;
    /** Where the ratification ledger and the ratified copies live. Default <project>/data/plugins.
     *  If it is inside (or contains) anything the companion can write, plugins are off. */
    ledger_dir: string;
    enabled: string[];
    /** Who manages plugins. 'companion' (default): enabled plugins run from their live folder, the
     *  companion may turn them on and off and edit them, and the ledger is an audit record the person
     *  reads in Settings. 'person': nothing runs until the person has ratified its exact code (the
     *  ratification gate, snapshots, containment and the full-access refusal). */
    trust: PluginTrust;
  };
  identity: {
    companion_name: string;
    user_name: string;
    timezone: string;
    /** Optional: which file in the home's identity folder is the structured profile (a .yaml). '' = companion.profile.yaml if it is there. A relative path is read from the companion home. */
    profile_path: string;
    /** Optional: which file in the home's identity folder is the narrative. '' = companion.md. A relative path is read from the companion home. */
    companion_md_path: string;
    /** Where the identity ledger, journal and ratified copies live (services/identity/ledger.ts). Resolved to an absolute path; '' = <project>/data/identity. Never inside the identity folder. */
    ledger_dir?: string;
  };
  server: {
    port: number;
    host: string;
    db_path: string;
  };
  auth: {
    password: string;
  };
  agent: {
    cwd: string;
    claude_md_path: string;
    system_prompt_file?: string;
    mcp_json_path: string;
    model: string;
    model_autonomous: string;
    // Claude path only: let the Agent SDK summarize the session when the context
    // fills. Off by default: the summary is the SDK's, not the companion's, and
    // identity drifts across it. On Codex the app owns history (rolling context).
    auto_compact: boolean;
    // The harness's own memory feature: Claude's auto-memory, Codex's "memories".
    // Off by default so it does not fight the memory the companion is set up with
    // (Revien, or a system of the person's own). On only when that IS the memory.
    harness_memory?: boolean;
    // Sanctum's own memory (services/local-recall.ts): before each message, the most relevant lines from earlier
    // conversations, found by meaning in the local message index, nothing to install. true: it is the memory.
    // Unset: only a stand-in while a chosen Revien cannot be reached. false: never, not even then.
    local_recall?: boolean;
    // The companion may write to the app's own features (reminders, meal and care
    // log, cycle tracking, notes, presence, routines, Command Center tools). Off,
    // every such write path answers 403 and says where the switch is.
    app_write?: boolean;
    // Which harness runs turns. 'claude' = Agent SDK (original). 'codex' = @openai/codex-sdk.
    provider: 'claude' | 'codex' | 'dsh';
    // DeepSeek Harness (dsh), the third harness. See docs/DSH.md.
    dsh: {
      command: string;          // the dsh executable; 'dsh' = on PATH
      model: string;            // '' → dsh's own default model
      model_autonomous: string; // autonomous runs: wakes and read-only subagents (digest/handoff/outlook); '' = same as model
      model_provider: string;   // a dsh llm route name (e.g. "deepseek-official", "openai"); '' → dsh's default route
      api_key_env: string;      // env var holding that route's API key; '' → dsh's own credential lookup
      base_url: string;         // endpoint override for a route dsh already knows; '' = the route's own
      home: string;             // DSH_HOME for this companion; '' → dsh's default
      sandbox_mode: 'read-only' | 'workspace-write' | 'danger-full-access';
      base_instructions_file: string; // fallback base prompt when <cwd>/config/dsh-base-prompt.md is absent; '' = dsh's stock persona
      identity_every_turn: boolean;
    };
    codex: {
      model: string;            // '' → Codex CLI default
      model_provider?: string;  // '' → Codex CLI default; else a [model_providers.*] key from ~/.codex/config.toml
      model_autonomous: string; // autonomous runs: wakes and read-only subagents (digest/handoff/outlook); '' = same as model
      sandbox_mode: 'read-only' | 'workspace-write' | 'danger-full-access';
      network_access: boolean;  // must stay true for the res CLI (loopback) to work
      additional_directories: string[];
      base_instructions_file: string; // fallback base prompt when <cwd>/config/codex-base-prompt.md is absent; '' = stock Codex
      identity_every_turn: boolean;   // true = send <cwd>/identity/* with every message; false = first message of a thread only
      /** Legacy location of the rolling settings (before 2026-10-08). Read once at
       *  load and folded into agent.rolling; never read anywhere else. */
      rolling?: Partial<RollingConfig> & { enabled?: boolean };
    };
    // Rolling context, the app's own compaction, on either harness: the app owns
    // the thread history, every turn is a fresh run, older turns are folded into
    // short summary segments, and those segments are the only summary the model
    // ever sees. Switchable per provider; the budgets and summarizer are shared.
    rolling: RollingConfig;
  };
  orchestrator: {
    enabled: boolean;
    wake_prompts_path: string;
    wake_prompts_dir: string;
    schedules: Record<string, string>;
    failsafe: {
      enabled: boolean;
      gentle_minutes: number;
      concerned_minutes: number;
      emergency_minutes: number;
    };
  };
  handoff: {
    // Daily handoff subagent (12:10am): authors a warm carry-forward from
    // yesterday's daily into today's. OFF BY DEFAULT. A KV row `handoff.enabled`
    // overrides this at runtime (the Settings toggle persists there).
    enabled: boolean;
  };
  hooks: {
    context_injection: boolean;
    safe_write_prefixes: string[];
    // Write-gate roots. workspace_root + vault_path are added as directory
    // prefixes; extra_write_paths entries are directories (prefix match) unless
    // they end in a file extension (exact match). Harvested from the reference app's
    // WORKSPACE_ROOT / VAULT_PATH / EXTRA_WRITE_PATHS env trio, now config-backed.
    workspace_root: string;
    vault_path: string;
    extra_write_paths: string[];
  };
  voice: {
    enabled: boolean;
    elevenlabs_voice_id: string;
  };
  discord: DiscordConfig;
  telegram: {
    enabled: boolean;
    owner_chat_id: string;
  };
  integrations: {
    life_api_url: string;
    // Browser tab: URL of a browser viewer (e.g. neko) embedded in an iframe. '' = tab shows setup help.
    browser_url: string;
    mind_cloud: {
      enabled: boolean;
      mcp_url: string;
      // The mind's id on the service (sanctum-mind requires it on every verb).
      // Settings → Mind (`mind.mind_id` in the DB) takes precedence.
      mind_id: string;
    };
  };
  google: {
    // Master gate for the Workspace MCP mount. Per-app toggles live in the DB
    // (google_integrations); this flag only controls whether /mcp/workspace is
    // mounted at all.
    enabled: boolean;
    // Desktop OAuth client creds — the user supplies from their Google Cloud project.
    // Env (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET) overrides these. Empty =
    // "not configured".
    client_id: string;
    client_secret: string;
  };
  command_center: {
    enabled: boolean;
    default_person: string;
    currency_symbol: string;
    care_categories: {
      toggles: string[];
      ratings: string[];
      counters: { name: string; max: number }[];
    };
  };
  cors: {
    origins: string[];
  };
  // Revien: local memory daemon. Recalled memories ride into each Codex turn; each finished turn is ingested.
  revien: {
    enabled: boolean;
    url: string;
    recall_limit: number;
    timeout_ms: number;
  };
  // Newer-version notice. One request to GitHub for the project's package.json,
  // at most every six hours. `npm run update` reads the same two keys.
  updates: {
    check: boolean;
    repo: string;   // owner/name on GitHub; '' = package.json "repository"
    branch: string;
  };
}

export interface RollingConfig {
  claude: boolean;            // rolling on the Claude path (the SDK's own compaction stays off)
  codex: boolean;             // rolling on the Codex path (Codex keeps no history of its own)
  dsh?: boolean;              // rolling on the dsh path (default true)
  model?: string;             // the summarizer: '' → model_autonomous → model → the harness default
  model_provider?: string;    // Codex only: '' → codex.model_provider
  tail_chars: number;         // fold once the unsummarized tail exceeds this
  fold_chars: number;         // how much of the oldest tail one fold summarizes
  keep_chars: number;         // newest history a fold never eats into
  tail_turns: number;         // turn-count trigger
  max_segments: number;       // past this the two oldest segments merge
  segment_cap: number;        // max chars per summary segment
  history_max_chars: number;  // cap on the verbatim tail sent per turn
  history_max_turns: number;
  summarizer_instructions_file: string;
}

const ROLLING_KEYS: Array<keyof RollingConfig> = [
  'model', 'model_provider', 'tail_chars', 'fold_chars', 'keep_chars', 'tail_turns', 'max_segments',
  'segment_cap', 'history_max_chars', 'history_max_turns', 'summarizer_instructions_file',
];

/**
 * Fold a legacy `agent.codex.rolling` block into `agent.rolling`. A key the
 * person set explicitly under the new location wins; otherwise the legacy
 * value carries over, and legacy `enabled` becomes the Codex switch. The
 * legacy block is removed so nothing reads two sources.
 */
export function applyLegacyRolling(merged: SanctumConfig, fileAgent: Record<string, any> | undefined): void {
  const legacy = merged.agent.codex?.rolling;
  if (!legacy) return;
  const explicit = (fileAgent?.rolling ?? {}) as Record<string, unknown>;
  if (typeof legacy.enabled === 'boolean' && explicit.codex === undefined) merged.agent.rolling.codex = legacy.enabled;
  for (const k of ROLLING_KEYS) {
    if (legacy[k] !== undefined && explicit[k] === undefined) (merged.agent.rolling as any)[k] = legacy[k];
  }
  delete merged.agent.codex.rolling;
}

// ── Discord block (docs/DISCORD-PLAN.md, "Config sketch") ─────────────────────
export interface DiscordConfig {
  enabled: boolean;
  /** Legacy key. Kept readable: it mirrors owner.user_id after load. Write owner.user_id. */
  owner_user_id: string;
  owner: { user_id: string; channel_id: string };
  public: {
    enabled: boolean;
    guild_ids: string[];
    /** Roles that count as addressing her (a mention of one is a mention of her). Ids, as strings. */
    role_ids: string[];
    bots: 'never' | 'capped';
    bot_exchange_limit: number;
    bot_hourly_limit: number;
    /** How many lines of the channel's file transcript a public turn carries as history. 1..50, default 12. */
    history_lines: number;
    /** Resolved to a path after load ('' in the file = <private_dir>/exclusions.txt). */
    exclusions_file: string;
  };
  gate: {
    /** Resolved after load ('' in the file = <private_dir>/words.txt). */
    words_file: string;
    /** Resolved after load ('' in the file = <private_dir>/names.txt). */
    names_file: string;
  };
  /** Owner-lane attachments: the largest file taken, in whole megabytes (1..10, default 8; files.ts saves nothing larger than 10). */
  attachments: { max_mb: number };
  paused: boolean;
  /** Hours a deferred message may wait, clamped 1..48. */
  deferral_hours: number;
  /** Resolved after load ('' in the file = <agent.cwd>/../sanctum-private). */
  private_dir: string;
}

const DISCORD_ONCE = new Set<string>();

const homePath = (p: string) => (p === '~' ? homedir() : p.startsWith('~/') || (sep === '\\' && p.startsWith('~\\')) ? join(homedir(), p.slice(2)) : p);

/**
 * The `discord` block as the rest of the app reads it: defaults filled, values clamped, the legacy
 * `owner_user_id` mapped to `owner.user_id` (one warning), and every path made absolute the way the
 * plugin loader does it (`~` expanded, relative to the project root). Pure apart from `warn`.
 * Whether a path is allowed to be where it is (not inside a companion-writable root) is decided by
 * services/discord/paths.ts, which needs the plugin loader's helpers.
 */
export function normalizeDiscordConfig(
  raw: unknown,
  agentCwd: string,
  opts: { warn?: (msg: string) => void; resolveFromRoot?: (p: string) => string } = {},
): DiscordConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const warnOnce = (key: string, msg: string) => {
    if (DISCORD_ONCE.has(key)) return;
    DISCORD_ONCE.add(key);
    (opts.warn ?? ((m: string) => console.warn(m)))(msg);
  };
  const fromRoot = opts.resolveFromRoot ?? ((p: string) => resolve(PROJECT_ROOT, p));
  const obj = (v: unknown): Record<string, any> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {});

  // An id is a string. A bare number was rounded by YAML before we saw it, so it cannot be trusted.
  const id = (v: unknown, where: string): string => {
    if (typeof v === 'string') return v.trim();
    if (typeof v === 'number') {
      warnOnce(`number-id:${where}`, `[config] ${where} is a bare number in sanctum.yaml; YAML rounds ids that large, so it is ignored. Put it in quotes: ${where.replace(/^discord\./, '')}: "..."`);
    }
    return '';
  };
  const whole = (v: unknown, def: number): number => (typeof v === 'number' && Number.isFinite(v) && v >= 1 ? Math.floor(v) : def);
  const path = (v: unknown, def: string): string => {
    const s = typeof v === 'string' ? v.trim() : '';
    return s ? fromRoot(homePath(s)) : def;
  };

  const owner = obj(r.owner);
  const pub = obj(r.public);
  const gate = obj(r.gate);

  const legacyOwner = id(r.owner_user_id, 'discord.owner_user_id');
  let userId = id(owner.user_id, 'discord.owner.user_id');
  if (legacyOwner && !userId) {
    userId = legacyOwner;
    warnOnce(`legacy-owner:${legacyOwner}`, '[config] discord.owner_user_id is the old key and is read as discord.owner.user_id. Rename it in sanctum.yaml (owner: { user_id: "..." }); the old key will stop being read in a later release.');
  } else if (legacyOwner && userId && legacyOwner !== userId) {
    warnOnce(`legacy-conflict:${legacyOwner}:${userId}`, '[config] discord.owner_user_id and discord.owner.user_id are both set and differ; owner.user_id wins and the old key is ignored. Remove discord.owner_user_id.');
  }

  let bots: 'never' | 'capped' = 'never';
  if (pub.bots === 'capped') bots = 'capped';
  else if (pub.bots !== undefined && pub.bots !== 'never') {
    warnOnce(`bots:${String(pub.bots)}`, `[config] discord.public.bots is ${JSON.stringify(pub.bots)}; only "never" or "capped" are valid, so it is "never".`);
  }

  let hours = 24;
  const hv = typeof r.deferral_hours === 'string' && r.deferral_hours.trim() !== '' ? Number(r.deferral_hours) : r.deferral_hours;
  if (typeof hv === 'number' && Number.isFinite(hv)) hours = Math.min(48, Math.max(1, Math.round(hv)));

  const privateDir = typeof r.private_dir === 'string' && r.private_dir.trim()
    ? fromRoot(homePath(r.private_dir.trim()))
    : resolve(agentCwd, '..', 'sanctum-private');

  const guilds: string[] = [];
  for (const g of Array.isArray(pub.guild_ids) ? pub.guild_ids : []) {
    const s = id(g, 'discord.public.guild_ids');
    if (s) guilds.push(s);
  }

  const roles: string[] = [];
  for (const g of Array.isArray(pub.role_ids) ? pub.role_ids : []) {
    const s = id(g, 'discord.public.role_ids');
    if (s) roles.push(s);
  }

  return {
    enabled: r.enabled === true,
    owner_user_id: userId,
    owner: { user_id: userId, channel_id: id(owner.channel_id, 'discord.owner.channel_id') },
    public: {
      enabled: pub.enabled === true,
      guild_ids: guilds,
      role_ids: roles,
      bots,
      bot_exchange_limit: whole(pub.bot_exchange_limit, 4),
      bot_hourly_limit: whole(pub.bot_hourly_limit, 20),
      history_lines: Math.min(50, whole(pub.history_lines, 12)),
      exclusions_file: path(pub.exclusions_file, join(privateDir, 'exclusions.txt')),
    },
    gate: {
      words_file: path(gate.words_file, join(privateDir, 'words.txt')),
      names_file: path(gate.names_file, join(privateDir, 'names.txt')),
    },
    attachments: { max_mb: Math.min(10, whole(obj(r.attachments).max_mb, 8)) },
    paused: r.paused === true,
    deferral_hours: hours,
    private_dir: privateDir,
  };
}

/** Which harness runs turns: env wins, then yaml, then Claude. */
export function activeProviderName(): 'claude' | 'codex' | 'dsh' {
  const tenant = tenantOrNull('activeProviderName');
  // A tenant's provider is in its own config (its .env's AGENT_PROVIDER was applied when it loaded); the process env is not consulted.
  const p = (tenant ? (tenant.config.agent.provider || 'claude') : (process.env.AGENT_PROVIDER || _config?.agent.provider || 'claude')).toLowerCase();
  return p === 'codex' ? 'codex' : p === 'dsh' ? 'dsh' : 'claude';
}

/** Where the config file may live, in order. `sanctum.yaml` is the name; the
 *  `sanctum.*` names are read for installs made before the rename. */
export const CONFIG_FILE_NAMES = [
  'sanctum.yaml', 'sanctum.yml', 'config/sanctum.yaml',
  'resonant.yaml', 'resonant.yml', 'config/resonant.yaml', // before the rename
];

/** The database file: `data/sanctum.db`, or an existing `data/resonant.db`
 *  from before the rename when the new one does not exist yet, so nobody's
 *  history is orphaned by an update. Explicit yaml/env paths are left alone. */
export function resolveDbPath(configured: string, explicit: boolean, exists: (p: string) => boolean = existsSync): string {
  if (explicit) return configured;
  const legacy = configured.replace(/sanctum\.db$/, 'resonant.db'); // before the rename
  if (legacy !== configured && !exists(configured) && exists(legacy)) return legacy;
  return configured;
}

const DEFAULTS: SanctumConfig = {
  plugins: { dir: '', ledger_dir: '', enabled: [], trust: 'companion' },
  identity: {
    companion_name: 'Echo',
    user_name: 'User',
    timezone: 'UTC',
    profile_path: '',
    companion_md_path: '',
    ledger_dir: '',
  },
  server: {
    port: 3099,
    host: '127.0.0.1',
    db_path: './data/sanctum.db',
  },
  auth: {
    password: '',
  },
  agent: {
    cwd: '.',
    claude_md_path: './CLAUDE.md',
    system_prompt_file: '',
    mcp_json_path: './.mcp.json',
    model: 'claude-sonnet-5-5',
    model_autonomous: '', // '' = the same as agent.model (see resolveAutonomousModel)
    auto_compact: false,
    harness_memory: false,
    // (local_recall is left unset: a stand-in for an unreachable Revien only, until setup chooses it)
    app_write: true,
    provider: 'claude',
    dsh: {
      command: 'dsh',
      model: '',
      model_autonomous: '',
      model_provider: '',
      api_key_env: '',
      base_url: '',
      home: '',
      sandbox_mode: 'workspace-write',
      base_instructions_file: './prompts/dsh-base-prompt.md',
      identity_every_turn: true,
    },
    codex: {
      model: '',
      model_provider: '',
      model_autonomous: '',
      sandbox_mode: 'workspace-write',
      network_access: true,
      additional_directories: [],
      base_instructions_file: './prompts/codex-base-prompt.md',
      identity_every_turn: true,
    },
    rolling: {
      claude: true,
      codex: true,
      dsh: true,
      model: '',
      model_provider: '',
      tail_chars: 14000,
      fold_chars: 6000,
      keep_chars: 6000,
      tail_turns: 24,
      max_segments: 5,
      segment_cap: 2000,
      history_max_chars: 24000,
      history_max_turns: 30,
      summarizer_instructions_file: './prompts/codex-summarizer-prompt.md',
    },
  },
  orchestrator: {
    enabled: true,
    wake_prompts_path: './prompts/wake.md',
    wake_prompts_dir: './prompts/wakes',
    schedules: {},
    failsafe: {
      enabled: false,
      gentle_minutes: 120,
      concerned_minutes: 720,
      emergency_minutes: 1440,
    },
  },
  handoff: {
    enabled: false,
  },
  hooks: {
    context_injection: true,
    safe_write_prefixes: [],
    workspace_root: '',
    vault_path: '',
    extra_write_paths: [],
  },
  voice: {
    enabled: false,
    elevenlabs_voice_id: '',
  },
  discord: {
    enabled: false,
    owner_user_id: '',
    owner: { user_id: '', channel_id: '' },
    public: { enabled: false, guild_ids: [], role_ids: [], bots: 'never', bot_exchange_limit: 4, bot_hourly_limit: 20, history_lines: 12, exclusions_file: '' },
    gate: { words_file: '', names_file: '' },
    attachments: { max_mb: 8 },
    paused: false,
    deferral_hours: 24,
    private_dir: '',
  },
  telegram: {
    enabled: false,
    owner_chat_id: '',
  },
  integrations: {
    life_api_url: '',
    browser_url: '',
    mind_cloud: {
      enabled: false,
      mcp_url: '',
      mind_id: '',
    },
  },
  google: {
    enabled: false,
    client_id: '',
    client_secret: '',
  },
  command_center: {
    enabled: false,
    default_person: 'user',
    currency_symbol: '$',
    care_categories: {
      toggles: ['breakfast', 'lunch', 'dinner', 'snacks', 'medication', 'movement', 'shower'],
      ratings: ['sleep', 'energy', 'wellbeing', 'mood'],
      counters: [{ name: 'water', max: 10 }],
    },
  },
  cors: {
    origins: [],
  },
  revien: {
    enabled: true,
    url: 'http://127.0.0.1:7437',
    recall_limit: 6,
    timeout_ms: 2500,
  },
  updates: {
    check: true,
    repo: '', // '' = the "repository" line in package.json
    branch: 'main',
  },
};

/** "owner/name" from package.json's repository field ("github:owner/name",
 *  "https://github.com/owner/name.git", or { url }). '' when absent. */
export function repoFromPackageJson(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf-8'));
    const r: string = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url || '';
    const m = /(?:github:|github\.com[/:])([^/\s]+\/[^/\s#]+?)(?:\.git)?\/?$/.exec(r) || /^([^/\s]+\/[^/\s]+)$/.exec(r);
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key]) &&
        target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) {
      result[key] = deepMerge(target[key] as Record<string, unknown>, source[key] as Record<string, unknown>);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

const BROWSER_LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?';
const BROWSER_URL_RE = new RegExp(
  `^(https?)://` +                                    // scheme (matched case-insensitively)
  `(${BROWSER_LABEL}(?:\\.${BROWSER_LABEL})*|\\[[0-9A-Fa-f:.]+\\])` + // host, or bracketed IPv6
  `(?::([0-9]{1,5}))?` +                              // optional port
  `(?:[/?#][^\\s\\u0000-\\u001f\\u007f]*)?$`,           // optional path/query/fragment
  'i',
);

/** The app's own listen address, used to refuse a viewer URL that points back at the app. */
export interface BrowserSelf { host: string; port: number }

export type BrowserUrlCheck =
  | { ok: true; url: string; origin: string }
  | { ok: false; reason: string };

/** True when `u` would be served by this app: same port, and a host that is the configured
 *  one or any loopback alias of it. (A different machine on the same port is not caught;
 *  the cross-origin guarantee otherwise rests on the viewer being a separate service.) */
function sameAsApp(u: URL, self: BrowserSelf): boolean {
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  if (port !== String(self.port)) return false;
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const own = (self.host || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (host === own) return true;
  const loopbackish = (h: string) => h === 'localhost' || h === '::1' || /^127\./.test(h) || h === '0.0.0.0' || h === '::' || h === '';
  return loopbackish(host) && loopbackish(own);
}

/** Strict check for the Browser tab URL. The host must be letters, digits, dots and
 *  hyphens (or a bracketed IPv6 literal). Wildcards, userinfo (user:pass@), odd ports,
 *  whitespace and over-long values are rejected, because the origin is placed into the
 *  CSP `frame-src` header: anything looser can widen it or make helmet throw at boot. */
export function checkBrowserUrl(url: unknown, self?: BrowserSelf): BrowserUrlCheck {
  // YAML can hand us numbers, booleans, lists or maps; only a string can be a URL.
  if (typeof url !== 'string') return { ok: false, reason: url == null ? 'empty' : 'must be a string' };
  const raw = url.trim();
  if (!raw) return { ok: false, reason: 'empty' };
  if (raw.length > 2048) return { ok: false, reason: 'too long (max 2048 characters)' };
  const m = BROWSER_URL_RE.exec(raw);
  if (!m) return { ok: false, reason: 'must be http(s)://host[:port]/... with a plain hostname (no wildcards or user:pass@)' };
  if (m[3] !== undefined) {
    const port = Number(m[3]);
    if (port < 1 || port > 65535) return { ok: false, reason: 'port out of range' };
  }
  try {
    const u = new URL(raw);
    if (u.username || u.password) return { ok: false, reason: 'credentials in the URL are not allowed' };
    if (!u.hostname || /[*%,;'"\s]/.test(u.hostname)) return { ok: false, reason: 'invalid host' };
    if (self && sameAsApp(u, self)) {
      return { ok: false, reason: 'must not point at the app itself (a same-origin frame could remove its own sandbox)' };
    }
    return { ok: true, url: raw, origin: u.origin };
  } catch {
    return { ok: false, reason: 'not a valid URL' };
  }
}

/** The origin to allow in the CSP `frame-src` for the Browser tab, or '' when the
 *  URL is unset or fails checkBrowserUrl. Only the origin goes into the header. */
export function browserFrameOrigin(url: unknown, self?: BrowserSelf): string {
  const r = checkBrowserUrl(url, self);
  return r.ok ? r.origin : '';
}

export type BrowserUrlUpdate =
  | { action: 'set'; value: string }
  | { action: 'keep' }
  | { action: 'reject'; reason: string };

/** How a PUT of `integrations.browser_url` applies. Empty clears it. A valid value is saved.
 *  An invalid value is rejected, except when it equals what is already saved: the Settings
 *  form echoes the whole draft back, and a stale bad value must not block other saves. */
export function resolveBrowserUrlUpdate(incoming: string, saved: unknown, self?: BrowserSelf): BrowserUrlUpdate {
  const u = incoming.trim();
  if (!u) return { action: 'set', value: '' };
  const check = checkBrowserUrl(u, self);
  if (check.ok) return { action: 'set', value: u };
  if (typeof saved === 'string' && u === saved.trim()) return { action: 'keep' };
  return { action: 'reject', reason: check.reason };
}

/** True for an address the server would only reach itself on: loopback or
 *  the unspecified address. */
export function isLoopbackHost(host: string): boolean {
  const h = (host || '').trim().toLowerCase();
  return h === '' || h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0' || h === '::';
}

/** The address this machine reaches its own server on. With server.host set to
 *  a Tailscale or LAN address the server does not listen on loopback at all,
 *  so the built-in tools must call that address; otherwise loopback. */
export function internalBaseUrl(server: { host: string; port: number }): string {
  const host = isLoopbackHost(server.host) ? '127.0.0.1' : server.host;
  const h = host.includes(':') ? `[${host}]` : host;
  return `http://${h}:${server.port}`;
}

/** The browser origin for a server bound straight to a non-loopback address
 *  (`http://100.x.y.z:3099`), '' when the server is on loopback or every
 *  address. Added to the allowed origins so the live connection is not refused
 *  with a silent 403 on a direct Tailscale or LAN install. */
export function boundOrigin(server: { host: string; port: number }): string {
  if (isLoopbackHost(server.host)) return '';
  const h = server.host.includes(':') ? `[${server.host}]` : server.host;
  return `http://${h}:${server.port}`;
}

/** The context-window tag at the end of a model id (`claude-opus-4-8[1m]` → `1m`), lowercased; '' when none. */
export function contextWindowTag(modelId: string): string {
  const m = /\[([^\]]+)\]\s*$/.exec(modelId || '');
  return m ? m[1].toLowerCase() : '';
}

/**
 * Which model autonomous wakes run on. Empty means the same as the chat model.
 *
 * Wakes (routines, timers, impulses, the failsafe) choose their model from
 * agent.model_autonomous, chat from agent.model. Setting a 1M-window model on
 * agent.model alone left every wake on the shipped default: a 200k window
 * writing into a thread sized for a million, so it compacted on nearly every
 * wake. Following agent.model by default closes that trap. Two explicit models
 * are fine, but a different context-window tag is loud, since that is the
 * exact mismatch that caused it.
 */
export function resolveAutonomousModel(
  model: string,
  modelAutonomous: string | undefined,
  warn: (msg: string) => void = console.warn,
): string {
  const auto = (modelAutonomous || '').trim();
  if (!auto) return model;
  if (contextWindowTag(auto) !== contextWindowTag(model)) {
    warn(`[config] agent.model is "${model}" but agent.model_autonomous is "${auto}": wakes run on a different context window than chat and will compact at a different point. Set both the same, or leave model_autonomous empty to follow agent.model.`);
  }
  return auto;
}

let _config: SanctumConfig | null = null;
registerProcessConfig(() => _config);
// The operator's sanctum.yaml as read (file values only), which a tenant inherits from (tenancy/config.ts, D11).
let _processFile: Record<string, unknown> | null = null;
registerProcessFile(() => _processFile);

// The app password is held here, not in process.env: provider children (Codex, the Claude SDK) are started with a copy of the
// environment, and the password they have no use for must not be in it. The environment is the first source (the first load takes
// APP_PASSWORD out of it); the setup wizard hands a new one over with setAppPassword and then reloads.
let appPassword = '';
let appPasswordTaken = false;

/** Where the password in force comes from, which decides whether the app can change it for good:
 *  parent_env  APP_PASSWORD was already in the environment the program was started with (pm2, systemd, a shell export). dotenv never
 *              overrides an existing variable, so that value wins at every start and a new one written to .env is ignored.
 *  dotenv      it came from the .env file the program loads at boot.
 *  yaml        auth.password in sanctum.yaml.
 *  none        no password anywhere. */
export type AppPasswordSource = 'parent_env' | 'dotenv' | 'yaml' | 'none';

// Taken when this module is first evaluated. server.ts loads .env in its own body, which runs after every import it makes (ESM
// evaluates imports first), so at this point the environment holds only what the parent put there. Do not import dotenv (or anything
// that calls it) ahead of this module in the entry point, or a .env value would be taken for the parent's.
const parentSuppliedPassword = !!process.env.APP_PASSWORD;
let appPasswordSource: AppPasswordSource = 'none';

function takeAppPasswordFromEnv(): void {
  if (appPasswordTaken) return;
  appPasswordTaken = true;
  appPassword = process.env.APP_PASSWORD || '';
  appPasswordSource = !appPassword ? 'none' : parentSuppliedPassword ? 'parent_env' : 'dotenv';
  delete process.env.APP_PASSWORD;
}
/** The password the app now signs in with, ahead of sanctum.yaml, from the next (re)load of the config. Never put into process.env. */
export function setAppPassword(password: string): void {
  takeAppPasswordFromEnv();
  appPassword = password;
  // A parent's value still wins at the next start, whatever was typed here, so that source stays. Otherwise the wizard has just
  // written it to .env, which is where it will come from.
  if (appPasswordSource !== 'parent_env') appPasswordSource = password ? 'dotenv' : 'none';
}
/** Where the password comes from (see AppPasswordSource). yaml when neither the environment nor .env gave one but sanctum.yaml did. */
export function getAppPasswordSource(): AppPasswordSource {
  takeAppPasswordFromEnv();
  if (appPasswordSource === 'none' && _config?.auth.password) return 'yaml';
  return appPasswordSource;
}

/** A copy of DEFAULTS taken when this module loads, before loadConfig has written anything into the live ones (it does: deepMerge shares
 *  nested defaults and the env overrides then mutate them). Tenants merge over this, so the process environment never reaches them. */
const PRISTINE_DEFAULTS: SanctumConfig = structuredClone(DEFAULTS);

/** The shipped defaults with a parsed yaml file merged over them, for a tenant. deepMerge shares every nested default the yaml does not
 *  override, and loadConfig then writes into the result: the process may do that to the one config it has, but two tenants must not
 *  write into one shared DEFAULTS, so a tenant merges over a copy. (loadConfig keeps calling deepMerge on DEFAULTS as it always did.) */
export function mergeConfigDefaults(fileConfig: Record<string, unknown>): SanctumConfig {
  return deepMerge(structuredClone(PRISTINE_DEFAULTS) as unknown as Record<string, unknown>, fileConfig) as unknown as SanctumConfig;
}

/** The environment-variable overrides on a merged config (env wins over yaml). A pure function of `merged` and the `env` it is given:
 *  loadConfig passes process.env, a tenant passes its own .env, so nothing a tenant sets can come from the process. The app password
 *  is not here: it is held apart from the environment (see takeAppPasswordFromEnv). */
export function applyEnvOverrides(merged: SanctumConfig, env: Record<string, string | undefined>): void {
  if (env.PORT) merged.server.port = parseInt(env.PORT, 10);
  if (env.HOST) merged.server.host = env.HOST;
  if (env.DB_PATH) merged.server.db_path = env.DB_PATH;
  if (env.AGENT_CWD) merged.agent.cwd = env.AGENT_CWD;
  if (env.AGENT_MODEL) merged.agent.model = env.AGENT_MODEL;
  if (env.AGENT_PROVIDER === 'codex' || env.AGENT_PROVIDER === 'claude' || env.AGENT_PROVIDER === 'dsh') merged.agent.provider = env.AGENT_PROVIDER;
  if (env.COMPANION_NAME) merged.identity.companion_name = env.COMPANION_NAME;
  if (env.USER_NAME) merged.identity.user_name = env.USER_NAME;
  if (env.TZ) merged.identity.timezone = env.TZ;
  if (env.DISCORD_ENABLED === 'true') merged.discord.enabled = true;
  if (env.TELEGRAM_ENABLED === 'true') merged.telegram.enabled = true;
  if (env.GOOGLE_ENABLED === 'true') merged.google.enabled = true;
  if (env.GOOGLE_CLIENT_ID) merged.google.client_id = env.GOOGLE_CLIENT_ID;
  if (env.GOOGLE_CLIENT_SECRET) merged.google.client_secret = env.GOOGLE_CLIENT_SECRET;
  // Write-gate roots (env wins over yaml). EXTRA_WRITE_PATHS is comma-separated.
  if (env.WORKSPACE_ROOT) merged.hooks.workspace_root = env.WORKSPACE_ROOT;
  if (env.VAULT_PATH) merged.hooks.vault_path = env.VAULT_PATH;
  if (env.EXTRA_WRITE_PATHS) {
    merged.hooks.extra_write_paths = env.EXTRA_WRITE_PATHS
      .split(',').map(s => s.trim()).filter(Boolean);
  }

  // Wakes follow the chat model unless told otherwise (after env, so AGENT_MODEL counts).
  merged.agent.model_autonomous = resolveAutonomousModel(merged.agent.model, merged.agent.model_autonomous);
}

/** Resolve every path in a merged config against `base` (the project root for the process, the tenant folder for a tenant).
 *  `fileCfg` is the raw yaml, for what only the file can say (was db_path given, the legacy keys); `env` is the environment in force. */
export function resolveConfigPaths(merged: SanctumConfig, base: string, fileCfg: Record<string, unknown>, env: Record<string, string | undefined>): void {
  // Resolve relative paths against the project root (not cwd)
  // A leading `~` is the home directory (a shell would have expanded it; yaml does not).
  const resolveFromRoot = (p: string) => resolve(base, p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);
  merged.server.db_path = resolveDbPath(resolveFromRoot(merged.server.db_path), !!(env.DB_PATH || (fileCfg as any).server?.db_path));
  merged.agent.cwd = resolveFromRoot(merged.agent.cwd);
  // identity.profile_path / companion_md_path are overrides inside the home's identity folder, so a relative one is the home's, not the project root's.
  const resolveFromHome = (p: unknown) => (typeof p === 'string' && p.trim() ? resolve(merged.agent.cwd, p.trim() === '~' ? homedir() : p.trim().startsWith('~/') ? join(homedir(), p.trim().slice(2)) : p.trim()) : '');
  merged.identity.profile_path = resolveFromHome(merged.identity.profile_path);
  merged.identity.companion_md_path = resolveFromHome(merged.identity.companion_md_path);
  merged.identity.ledger_dir = resolveFromRoot(typeof merged.identity.ledger_dir === 'string' && merged.identity.ledger_dir.trim() ? merged.identity.ledger_dir.trim() : 'data/identity');
  if ((fileCfg as any).plugins_dir !== undefined) {
    const old = (fileCfg as any).plugins_dir;
    console.warn(`[config] plugins_dir is no longer read (value ${JSON.stringify(old)} ignored). Use plugins.dir, which would have been: plugins.dir: ${JSON.stringify(old)}, and name each plugin you want in plugins.enabled. See docs/PLUGINS.md.`);
  }
  const trustResult = resolvePluginTrust((merged.plugins as any)?.trust);
  if (trustResult.warning) console.warn(trustResult.warning);
  merged.plugins = {
    trust: trustResult.trust,
    dir: typeof merged.plugins?.dir === 'string' && merged.plugins.dir.trim() ? resolveFromRoot(merged.plugins.dir.trim()) : '',
    ledger_dir: resolveFromRoot(typeof merged.plugins?.ledger_dir === 'string' && merged.plugins.ledger_dir.trim() ? merged.plugins.ledger_dir.trim() : 'data/plugins'),
    enabled: Array.isArray(merged.plugins?.enabled) ? merged.plugins.enabled.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()) : [],
  };
  merged.discord = normalizeDiscordConfig(merged.discord, merged.agent.cwd, { resolveFromRoot });
  merged.agent.claude_md_path = resolveFromRoot(merged.agent.claude_md_path);
  if (merged.agent.system_prompt_file) {
    merged.agent.system_prompt_file = resolveFromRoot(merged.agent.system_prompt_file);
  }
  merged.agent.mcp_json_path = resolveFromRoot(merged.agent.mcp_json_path);
  if (merged.agent.dsh?.base_instructions_file) {
    merged.agent.dsh.base_instructions_file = resolveFromRoot(merged.agent.dsh.base_instructions_file);
  }
  if (merged.agent.codex?.base_instructions_file) {
    merged.agent.codex.base_instructions_file = resolveFromRoot(merged.agent.codex.base_instructions_file);
  }
  applyLegacyRolling(merged, (fileCfg as any).agent);
  if (merged.agent.rolling?.summarizer_instructions_file) {
    merged.agent.rolling.summarizer_instructions_file = resolveFromRoot(merged.agent.rolling.summarizer_instructions_file);
  }
  merged.orchestrator.wake_prompts_path = resolveFromRoot(merged.orchestrator.wake_prompts_path);
  merged.orchestrator.wake_prompts_dir = resolveFromRoot(merged.orchestrator.wake_prompts_dir);
}

export function loadConfig(configPath?: string): SanctumConfig {
  if (_config) return _config;

  const searchPaths = configPath
    ? [configPath]
    : [
        ...CONFIG_FILE_NAMES.map((n) => join(PROJECT_ROOT, n)),
      ];

  let fileConfig: Record<string, unknown> = {};

  for (const p of searchPaths) {
    if (existsSync(p)) {
      const raw = readFileSync(p, 'utf-8');
      fileConfig = yaml.load(raw) as Record<string, unknown> || {};
      console.log(`Loaded config from: ${p}`);
      break;
    }
  }

  // A copy of the file as read, before the merge shares its values and the environment overrides touch them: what a tenant inherits.
  const pristineFile = structuredClone(fileConfig);

  // Merge: defaults <- yaml <- env overrides
  const merged = deepMerge(DEFAULTS as unknown as Record<string, unknown>, fileConfig) as unknown as SanctumConfig;

  // Environment variable overrides
  applyEnvOverrides(merged, process.env);
  takeAppPasswordFromEnv();
  if (appPassword) merged.auth.password = appPassword;

  // The project's GitHub address lives in package.json unless yaml overrides it.
  if (!merged.updates.repo) merged.updates.repo = repoFromPackageJson();

  resolveConfigPaths(merged, PROJECT_ROOT, fileConfig, process.env);

  _config = merged;
  _processFile = pristineFile;
  return merged;
}

/** Re-read sanctum.yaml and the environment into the live config (the setup wizard calls this after it writes them). Whatever is read
 *  through getSanctumConfig() on each use (identity, auth, agent settings) picks it up at once; what the process captured at boot (the
 *  listen address, CORS, started services) waits for a restart. A config that fails to load leaves the old one in place. */
export function reloadConfig(): SanctumConfig {
  const previous = _config;
  _config = null;
  try { return loadConfig(); }
  catch (err) { _config = previous; throw err; }
}

export function getSanctumConfig(): SanctumConfig {
  const tenant = tenantOrNull('getSanctumConfig');
  if (tenant) return tenant.config;
  if (!_config) throw new Error('Config not loaded. Call loadConfig() first.');
  return _config;
}

/** Replace plugins.enabled in the loaded config, so the next run reads the new list without a restart
 *  (the companion-managed PUT /api/plugins/enabled writes sanctum.yaml and calls this). */
export function setPluginsEnabledInMemory(ids: string[]): void {
  getSanctumConfig().plugins.enabled = [...ids];
}
