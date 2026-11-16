// The key registry: for every setting the service resolves, where each layer of the one rule lives.
//
//   default < sanctum.yaml < .env < SQLite      (rule.ts)
//
// Pure data, no imports of the app: stores.ts holds the code that reads the typed tables, index.ts the resolver.
// A key that is not here is not resolved by the service: resolveSetting() answers it from getSanctumConfig() as it always was.
//
// The canonical name of a key is its yaml path when it has one (the shape GET /api/preferences and PUT /api/preferences use),
// otherwise the name the code uses (`pulse.enabled`, `discord.bot_token`). `aliases` are the other names the same setting has
// (the KV row names), so both spellings resolve to one entry.
//
// What sits ABOVE the service and is not config: the per-thread model (threads.model) and the per-call modelOverride of a scheduled wake,
// both applied in agent.ts before it asks for agent.model, and the per-turn `thread.effort`. They are per-request values, not settings;
// the service neither knows nor lists them.

export type SettingType = 'bool' | 'string' | 'number' | 'enum' | 'list';

/** The typed tables that act as overrides today (stores.ts has the readers). */
export type TypedStore =
  | 'auth.preferred_model'
  | 'auth.preferred_model_autonomous'
  | 'auth.mode'
  | 'auth.api_key'
  | 'bot.discord'
  | 'bot.telegram'
  | 'google.client_id'
  | 'google.client_secret';

export interface KeyDef {
  /** Canonical name. `{type}` stands for one dotted segment (a wake type): `cron.{type}.schedule`. */
  key: string;
  aliases?: readonly string[];
  type: SettingType;
  values?: readonly string[];
  /** The shipped default. Must equal DEFAULTS in config.ts for a yaml-backed key (settings/index.test.ts checks). */
  default: unknown;
  /** Dotted path in sanctum.yaml (tenant.yaml in tenant mode). */
  yaml?: string;
  /** Env var. */
  env?: string;
  /** Bool env vars only count when they say 'true' (config.ts applyEnvOverrides never read 'false' from DISCORD_ENABLED). */
  envTrueOnly?: boolean;
  /** KV row name(s) in the `config` table; the first non-empty row wins. */
  kv?: string | readonly string[];
  /** Typed table that overrides (above the KV row when both exist). */
  typed?: TypedStore;
  /** Never leaves the process: resolveSetting() answers {set, source}; only resolveSecret() returns the value. */
  secret?: boolean;
  /** The yaml layer reads the merged config (paths resolved against the project/tenant root at load), not the raw file. */
  merged?: boolean;
  /** yaml 0/'' counts as unset (the old `x || DEFAULT` spelling). */
  yamlFalsyAbsent?: boolean;
  /** When nothing but the default is set, the value follows this other key (agent.model_autonomous → agent.model), db layer excluded. */
  follow?: string;
  /** Mind only: the .mcp.json entry is a candidate (`mcp_json`), below yaml. `bearer` also obeys the one-unit rule (see index.ts). */
  mcpJson?: 'url' | 'bearer';
  note?: string;
}

const d = (def: KeyDef): KeyDef => def;

/** The words a yaml boolean may be spelled with (js-yaml 4 reads only true/false as booleans, so `yes` / `on` arrive as strings). undefined = not one. */
export function parseBoolWord(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v === 1 ? true : v === 0 ? false : undefined;
  if (typeof v !== 'string') return undefined;
  switch (v.trim().toLowerCase()) {
    case 'true': case 'yes': case 'on': case '1': return true;
    case 'false': case 'no': case 'off': case '0': return false;
    default: return undefined;
  }
}

export const REGISTRY: readonly KeyDef[] = [
  // --- identity
  d({ key: 'identity.companion_name', type: 'string', default: 'Echo', yaml: 'identity.companion_name', env: 'COMPANION_NAME' }),
  d({ key: 'identity.user_name', type: 'string', default: 'User', yaml: 'identity.user_name', env: 'USER_NAME' }),
  d({ key: 'identity.timezone', type: 'string', default: 'UTC', yaml: 'identity.timezone', env: 'TZ' }),

  // --- the chat model chain. Above this service: threads.model, then the per-call modelOverride (agent.ts).
  d({
    key: 'agent.model', type: 'string', default: 'claude-sonnet-5-5', yaml: 'agent.model', env: 'AGENT_MODEL',
    typed: 'auth.preferred_model',
    note: 'db: auth_preferences.preferred_model (written by the /model command; /model reset clears it). The KV row agent.model of earlier versions is ignored and deleted at startup. Above the service: threads.model, modelOverride.',
  }),
  d({
    key: 'agent.model_autonomous', type: 'string', default: '', yaml: 'agent.model_autonomous',
    typed: 'auth.preferred_model_autonomous', follow: 'agent.model',
    note: '"" follows agent.model as set in yaml/env (not the db preferred_model). Above the service: modelOverride (a scheduled wake\'s own model).',
  }),
  d({ key: 'agent.provider', type: 'enum', values: ['claude', 'codex', 'dsh'], default: 'claude', yaml: 'agent.provider', env: 'AGENT_PROVIDER' }),
  d({ key: 'agent.app_write', type: 'bool', default: true, yaml: 'agent.app_write' }),
  d({ key: 'agent.dsh.model', type: 'string', default: '', yaml: 'agent.dsh.model' }),
  d({ key: 'agent.dsh.model_autonomous', type: 'string', default: '', yaml: 'agent.dsh.model_autonomous' }),
  d({ key: 'agent.dsh.model_provider', type: 'string', default: '', yaml: 'agent.dsh.model_provider' }),
  d({ key: 'agent.dsh.base_url', type: 'string', default: '', yaml: 'agent.dsh.base_url' }),
  d({ key: 'agent.dsh.api_key_env', type: 'string', default: '', yaml: 'agent.dsh.api_key_env', note: 'The NAME of an env var, never a key.' }),
  d({ key: 'agent.codex.model', type: 'string', default: '', yaml: 'agent.codex.model' }),
  d({ key: 'agent.codex.model_provider', type: 'string', default: '', yaml: 'agent.codex.model_provider' }),
  d({ key: 'agent.codex.model_autonomous', type: 'string', default: '', yaml: 'agent.codex.model_autonomous' }),
  d({ key: 'agent.codex.sandbox_mode', type: 'enum', values: ['read-only', 'workspace-write', 'danger-full-access'], default: 'workspace-write', yaml: 'agent.codex.sandbox_mode' }),
  d({ key: 'agent.codex.network_access', type: 'bool', default: true, yaml: 'agent.codex.network_access' }),
  d({ key: 'agent.codex.additional_directories', type: 'list', default: [], yaml: 'agent.codex.additional_directories' }),
  d({ key: 'agent.rolling.claude', type: 'bool', default: true, yaml: 'agent.rolling.claude', merged: true, note: 'The legacy agent.codex.rolling block is folded in at load (config.ts applyLegacyRolling).' }),
  d({ key: 'agent.rolling.codex', type: 'bool', default: true, yaml: 'agent.rolling.codex', merged: true }),
  d({ key: 'agent.rolling.dsh', type: 'bool', default: true, yaml: 'agent.rolling.dsh' }),
  d({ key: 'agent.rolling.model', type: 'string', default: '', yaml: 'agent.rolling.model', note: 'Deprecated alias of agent.summarizer.model: read only while that is empty (services/summarizer/config.ts).' }),
  d({ key: 'agent.rolling.model_provider', type: 'string', default: '', yaml: 'agent.rolling.model_provider', note: 'Deprecated alias of agent.summarizer.provider.' }),
  // --- the summarizer: one block, every harness (docs/CONFIGURATION.md "Summarizer")
  d({ key: 'agent.summarizer.provider', type: 'string', default: '', yaml: 'agent.summarizer.provider', note: '"" = the chat harness; or claude | codex | dsh | openai-compat.' }),
  d({ key: 'agent.summarizer.model', type: 'string', default: '', yaml: 'agent.summarizer.model', note: '"" = the chat model of the provider. It writes the companion\'s own memory: not a small model.' }),
  d({ key: 'agent.summarizer.base_url', type: 'string', default: '', yaml: 'agent.summarizer.base_url', note: 'openai-compat only, e.g. https://openrouter.ai/api/v1.' }),
  d({ key: 'agent.summarizer.api_key_env', type: 'string', default: 'SUMMARIZER_API_KEY', yaml: 'agent.summarizer.api_key_env', note: 'The NAME of an env var, never a key.' }),
  d({ key: 'agent.summarizer.max_output_tokens', type: 'number', default: 2000, yaml: 'agent.summarizer.max_output_tokens', note: 'openai-compat only: sent as max_tokens.' }),
  d({ key: 'summarizer.api_key', type: 'string', default: '', env: 'SUMMARIZER_API_KEY', secret: true, note: 'Reported as {set, source} only. The env var that is read is the one agent.summarizer.api_key_env names (this marker follows the default name).' }),
  // --- the fallback brain (docs/CONFIGURATION.md "Fallback brain")
  d({ key: 'agent.fallback.provider', type: 'enum', values: ['', 'openai-compat'], default: '', yaml: 'agent.fallback.provider', note: '"" = no fallback brain.' }),
  d({ key: 'agent.fallback.mode', type: 'enum', values: ['off', 'auto', 'always'], default: 'off', yaml: 'agent.fallback.mode', note: 'off: primary only. auto: the fallback takes over when the primary fails or is marked unhealthy. always: fallback first, primary as the safety net.' }),
  d({ key: 'agent.fallback.model', type: 'string', default: '', yaml: 'agent.fallback.model', note: 'A capable mid-tier model; DeepSeek V3-class via OpenRouter is the reference. It needs function calling to act.' }),
  d({ key: 'agent.fallback.base_url', type: 'string', default: '', yaml: 'agent.fallback.base_url', note: 'e.g. https://openrouter.ai/api/v1.' }),
  d({ key: 'agent.fallback.api_key_env', type: 'string', default: 'FALLBACK_API_KEY', yaml: 'agent.fallback.api_key_env', note: 'The NAME of an env var, never a key.' }),
  d({ key: 'agent.fallback.max_tool_turns', type: 'number', default: 8, yaml: 'agent.fallback.max_tool_turns', note: 'Most model round trips in one turn; each may call tools.' }),
  d({ key: 'agent.fallback.unhealthy_minutes', type: 'number', default: 10, yaml: 'agent.fallback.unhealthy_minutes', note: 'How long an AUTH, CREDIT or RATE_LIMIT failure keeps the primary out of the order (auto mode).' }),
  d({ key: 'agent.fallback.max_output_tokens', type: 'number', default: 4096, yaml: 'agent.fallback.max_output_tokens', note: 'Sent as max_tokens.' }),
  d({ key: 'fallback.api_key', type: 'string', default: '', env: 'FALLBACK_API_KEY', secret: true, note: 'Reported as {set, source} only. The env var that is read is the one agent.fallback.api_key_env names (this marker follows the default name).' }),

  // --- write-gate roots (paths are resolved at load, so the yaml layer reads the merged config)
  d({ key: 'hooks.workspace_root', type: 'string', default: '', yaml: 'hooks.workspace_root', env: 'WORKSPACE_ROOT', merged: true }),
  d({ key: 'hooks.vault_path', type: 'string', default: '', yaml: 'hooks.vault_path', env: 'VAULT_PATH', merged: true }),
  d({ key: 'hooks.extra_write_paths', type: 'list', default: [], yaml: 'hooks.extra_write_paths', env: 'EXTRA_WRITE_PATHS', merged: true, note: 'EXTRA_WRITE_PATHS is comma-separated.' }),

  d({ key: 'command_center.enabled', type: 'bool', default: false, yaml: 'command_center.enabled' }),
  d({ key: 'orchestrator.enabled', type: 'bool', default: true, yaml: 'orchestrator.enabled' }),
  d({ key: 'orchestrator.wake_prompts_path', type: 'string', default: './prompts/wake.md', yaml: 'orchestrator.wake_prompts_path', merged: true }),
  d({ key: 'voice.enabled', type: 'bool', default: false, yaml: 'voice.enabled' }),
  d({ key: 'voice.elevenlabs_voice_id', type: 'string', default: '', yaml: 'voice.elevenlabs_voice_id', env: 'ELEVENLABS_VOICE_ID' }),
  d({ key: 'server.port', type: 'number', default: 3099, yaml: 'server.port', env: 'PORT', merged: true, note: 'Read at boot; process-level (a tenant has the process\'s).' }),

  // --- channels and the handoff: a DB row beats env beats yaml
  d({ key: 'discord.enabled', type: 'bool', default: false, yaml: 'discord.enabled', env: 'DISCORD_ENABLED', envTrueOnly: true, kv: 'discord.enabled' }),
  d({ key: 'telegram.enabled', type: 'bool', default: false, yaml: 'telegram.enabled', env: 'TELEGRAM_ENABLED', envTrueOnly: true, kv: 'telegram.enabled' }),
  d({ key: 'handoff.enabled', type: 'bool', default: false, yaml: 'handoff.enabled', kv: 'handoff.enabled' }),
  d({ key: 'discord.bot_token', type: 'string', default: '', env: 'DISCORD_BOT_TOKEN', typed: 'bot.discord', secret: true, note: 'db: the AES-GCM row config.discord.botToken.' }),
  d({ key: 'telegram.owner_chat_id', type: 'string', default: '', yaml: 'telegram.owner_chat_id', kv: 'telegram.ownerChatId', note: 'The chat the bot answers to. yaml is the install-time value; the KV row is what the bot saved when the owner first wrote to it.' }),
  d({ key: 'telegram.bot_token', type: 'string', default: '', env: 'TELEGRAM_BOT_TOKEN', typed: 'bot.telegram', secret: true, note: 'db: the AES-GCM row config.telegram.botToken.' }),

  // --- orchestrator
  d({ key: 'orchestrator.failsafe.enabled', aliases: ['failsafe.enabled'], type: 'bool', default: false, yaml: 'orchestrator.failsafe.enabled', kv: 'failsafe.enabled' }),
  d({ key: 'orchestrator.failsafe.gentle_minutes', aliases: ['failsafe.gentle'], type: 'number', default: 120, yaml: 'orchestrator.failsafe.gentle_minutes', kv: 'failsafe.gentle', yamlFalsyAbsent: true }),
  d({ key: 'orchestrator.failsafe.concerned_minutes', aliases: ['failsafe.concerned'], type: 'number', default: 720, yaml: 'orchestrator.failsafe.concerned_minutes', kv: 'failsafe.concerned', yamlFalsyAbsent: true }),
  d({ key: 'orchestrator.failsafe.emergency_minutes', aliases: ['failsafe.emergency'], type: 'number', default: 1440, yaml: 'orchestrator.failsafe.emergency_minutes', kv: 'failsafe.emergency', yamlFalsyAbsent: true }),
  d({ key: 'consent.mode', type: 'enum', values: ['open', 'guard'], default: 'open', kv: 'consent.mode', note: 'The consent gate (Settings → Permissions). Db-homed: changed only through /api/consent (PIN to switch Guard mode on or off). Grants, switch-offs and the PIN are runtime state, not settings.' }),
  d({ key: 'pulse.enabled', type: 'bool', default: false, kv: 'pulse.enabled' }),
  d({ key: 'pulse.frequency', type: 'number', default: 15, kv: 'pulse.frequency' }),
  d({ key: 'cron.{type}.schedule', type: 'string', default: '', yaml: 'orchestrator.schedules.{type}', kv: 'cron.{type}.schedule', note: 'The built-in schedule of a default wake type is passed as the default by the orchestrator.' }),
  d({ key: 'cron.{type}.enabled', type: 'bool', default: true, kv: 'cron.{type}.enabled' }),
  d({ key: 'cron.{type}.model', type: 'string', default: '', kv: 'cron.{type}.model' }),
  d({ key: 'cron.{type}.target', type: 'string', default: '', kv: 'cron.{type}.target' }),

  // --- the Mind (db > yaml > .mcp.json for the URL; db > env > .mcp.json for the key; the key and URL come from one source)
  d({ key: 'integrations.mind_cloud.enabled', aliases: ['mind.enabled'], type: 'bool', default: false, yaml: 'integrations.mind_cloud.enabled', kv: 'mind.enabled' }),
  d({ key: 'integrations.mind_cloud.mcp_url', aliases: ['mind.url'], type: 'string', default: '', yaml: 'integrations.mind_cloud.mcp_url', kv: 'mind.url', mcpJson: 'url' }),
  d({ key: 'integrations.mind_cloud.mind_id', aliases: ['mind.mind_id'], type: 'string', default: '', yaml: 'integrations.mind_cloud.mind_id', kv: 'mind.mind_id' }),
  d({ key: 'mind.api_key', type: 'string', default: '', env: 'MIND_API_KEY', kv: ['mind.api_key', 'integrations.mind_api_key'], mcpJson: 'bearer', secret: true, note: 'The .mcp.json bearer counts only when the URL in effect is the .mcp.json one, and a saved key only when it is not.' }),
  d({ key: 'integrations.browser_url', type: 'string', default: '', yaml: 'integrations.browser_url' }),

  // --- Google client (db google_auth > env > yaml)
  d({ key: 'google.client_id', type: 'string', default: '', yaml: 'google.client_id', env: 'GOOGLE_CLIENT_ID', typed: 'google.client_id' }),
  d({ key: 'google.client_secret', type: 'string', default: '', yaml: 'google.client_secret', env: 'GOOGLE_CLIENT_SECRET', typed: 'google.client_secret', secret: true }),

  // --- the login password and the Anthropic credential
  d({ key: 'auth.password', type: 'string', default: '', yaml: 'auth.password', secret: true, note: 'env: APP_PASSWORD, held by config.ts apart from process.env (parent env or .env).' }),
  d({ key: 'auth.mode', type: 'enum', values: ['subscription', 'api_key'], default: 'subscription', typed: 'auth.mode' }),
  d({ key: 'auth.anthropic_api_key', type: 'string', default: '', typed: 'auth.api_key', secret: true, note: 'In subscription mode (the default) ANTHROPIC_API_KEY is removed from the child environment (auth-preferences.ts applyAuthToEnv).' }),

  // --- image generation (keys are env-only secrets)
  d({ key: 'imagegen.provider', type: 'enum', values: ['none', 'runware', 'replicate'], default: 'none', yaml: 'imagegen.provider' }),
  d({ key: 'imagegen.model', type: 'string', default: '', yaml: 'imagegen.model' }),
  d({ key: 'imagegen.reference_model', type: 'string', default: '', yaml: 'imagegen.reference_model' }),
  d({ key: 'imagegen.size', type: 'enum', values: ['1024x1024', '1024x1536', '1536x1024'], default: '1024x1024', yaml: 'imagegen.size' }),
  d({ key: 'imagegen.safety_checker', type: 'bool', default: false, yaml: 'imagegen.safety_checker' }),
  d({ key: 'imagegen.timeout_ms', type: 'number', default: 90000, yaml: 'imagegen.timeout_ms' }),
  d({ key: 'imagegen.runware_api_key', type: 'string', default: '', env: 'RUNWARE_API_KEY', secret: true }),
  d({ key: 'imagegen.replicate_api_token', type: 'string', default: '', env: 'REPLICATE_API_TOKEN', secret: true }),

  // --- inline media (the companion's [gif:] tag; GIPHY_API_KEY is an env-only secret)
  d({ key: 'media.gif_rating', type: 'enum', values: ['g', 'pg', 'pg-13', 'r'], default: 'pg-13', yaml: 'media.gif_rating' }),
  d({ key: 'media.giphy_api_key', type: 'string', default: '', env: 'GIPHY_API_KEY', secret: true }),
];

/** The keys PUT /api/preferences writes, each also in GET /api/preferences (the 39 the panel edits). */
export const PREFERENCE_KEYS: readonly string[] = [
  'identity.companion_name', 'identity.user_name', 'identity.timezone',
  'agent.model', 'agent.model_autonomous', 'agent.app_write', 'agent.provider',
  'agent.dsh.model', 'agent.dsh.model_autonomous', 'agent.dsh.model_provider', 'agent.dsh.base_url', 'agent.dsh.api_key_env',
  'agent.codex.model', 'agent.codex.model_provider', 'agent.codex.model_autonomous', 'agent.codex.sandbox_mode', 'agent.codex.network_access', 'agent.codex.additional_directories',
  'agent.rolling.claude', 'agent.rolling.codex', 'agent.rolling.dsh', 'agent.rolling.model', 'agent.rolling.model_provider',
  'hooks.workspace_root', 'hooks.vault_path', 'hooks.extra_write_paths',
  'command_center.enabled', 'orchestrator.enabled', 'orchestrator.wake_prompts_path',
  'voice.enabled', 'voice.elevenlabs_voice_id',
  'discord.enabled', 'telegram.enabled', 'handoff.enabled',
  'integrations.browser_url', 'integrations.mind_cloud.enabled', 'integrations.mind_cloud.mcp_url', 'integrations.mind_cloud.mind_id',
  'auth.password',
];

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const families = REGISTRY.filter((k) => k.key.includes('{type}')).map((def) => ({
  def,
  re: new RegExp(`^${esc(def.key).replace('\\{type\\}', '([^.]+)')}$`),
}));
const byName = new Map<string, KeyDef>();
for (const def of REGISTRY) {
  if (def.key.includes('{type}')) continue;
  byName.set(def.key, def);
  for (const a of def.aliases ?? []) byName.set(a, def);
}

/** The entry for a key name (canonical or alias; a family member such as `cron.morning.schedule` gives its entry and `type`), or null. */
export function lookupKey(name: string): { def: KeyDef; params: Record<string, string> } | null {
  const direct = byName.get(name);
  if (direct) return { def: direct, params: {} };
  for (const f of families) {
    const m = f.re.exec(name);
    if (m) return { def: f.def, params: { type: m[1] } };
  }
  return null;
}

/** Every key with a fixed name (what GET answers for); the `{type}` families are asked for by name. */
export const STATIC_KEYS: readonly KeyDef[] = REGISTRY.filter((k) => !k.key.includes('{type}'));

export function expand(template: string | undefined, params: Record<string, string>): string | undefined {
  return template === undefined ? undefined : template.replace('{type}', params.type ?? '');
}
