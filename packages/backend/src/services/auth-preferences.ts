import { getDb } from './db.js';
import { tenancyEnabled, tenantLocal } from '../tenancy/context.js';
import { resolveSetting } from './settings/index.js';
import { AUTH_KEY_IGNORED_LINE, authKeyIgnored } from '../../../../scripts/setup-lib.mjs';

export type AuthMode = 'subscription' | 'api_key';

export interface AuthPreferences {
  auth_mode: AuthMode;
  api_key: string | null;
  preferred_model: string | null;
  preferred_model_autonomous: string | null;
  usage_tracking_enabled: boolean;
  updated_at: string;
}

interface AuthPrefRow {
  auth_mode: AuthMode;
  api_key: string | null;
  preferred_model: string | null;
  preferred_model_autonomous: string | null;
  usage_tracking_enabled: number;
  updated_at: string;
}

// Holds the api_key read from this database, so it is one per tenant: a process-wide cache would hand tenant A's key to tenant B.
const cacheLocal = tenantLocal<AuthPreferences | null>(() => null);

function rowToPrefs(row: AuthPrefRow): AuthPreferences {
  return {
    auth_mode: row.auth_mode,
    api_key: row.api_key,
    preferred_model: row.preferred_model,
    preferred_model_autonomous: row.preferred_model_autonomous,
    usage_tracking_enabled: row.usage_tracking_enabled === 1,
    updated_at: row.updated_at,
  };
}

export function getAuthPreferences(): AuthPreferences {
  const hit = cacheLocal.get();
  if (hit) return hit;
  const row = getDb().prepare('SELECT * FROM auth_preferences WHERE id = 1').get() as AuthPrefRow | undefined;
  if (!row) {
    const now = new Date().toISOString();
    const fresh: AuthPreferences = {
      auth_mode: 'subscription',
      api_key: null,
      preferred_model: null,
      preferred_model_autonomous: null,
      usage_tracking_enabled: true,
      updated_at: now,
    };
    cacheLocal.set(fresh);
    return fresh;
  }
  const prefs = rowToPrefs(row);
  cacheLocal.set(prefs);
  return prefs;
}

export interface AuthPreferencesUpdate {
  auth_mode?: AuthMode;
  api_key?: string | null;
  preferred_model?: string | null;
  preferred_model_autonomous?: string | null;
  usage_tracking_enabled?: boolean;
}

export function updateAuthPreferences(update: AuthPreferencesUpdate): AuthPreferences {
  const current = getAuthPreferences();
  const next: AuthPreferences = {
    auth_mode: update.auth_mode ?? current.auth_mode,
    api_key: update.api_key !== undefined ? update.api_key : current.api_key,
    preferred_model: update.preferred_model !== undefined ? update.preferred_model : current.preferred_model,
    preferred_model_autonomous:
      update.preferred_model_autonomous !== undefined ? update.preferred_model_autonomous : current.preferred_model_autonomous,
    usage_tracking_enabled: update.usage_tracking_enabled ?? current.usage_tracking_enabled,
    updated_at: new Date().toISOString(),
  };

  getDb().prepare(`
    UPDATE auth_preferences SET
      auth_mode = ?,
      api_key = ?,
      preferred_model = ?,
      preferred_model_autonomous = ?,
      usage_tracking_enabled = ?,
      updated_at = ?
    WHERE id = 1
  `).run(
    next.auth_mode,
    next.api_key,
    next.preferred_model,
    next.preferred_model_autonomous,
    next.usage_tracking_enabled ? 1 : 0,
    next.updated_at
  );

  cacheLocal.set(next);
  return next;
}

/**
 * The auth variables for the next SDK query, as overrides for that run's child env (a value of undefined removes the name).
 * Tenancy off: also writes process.env, as it always did (see below). Tenant mode: never touches process.env, which is every tenant's
 * environment at once; each caller merges the result into the env of its own run (tenancy/child.ts runEnvOption), so two runs, or two
 * tenants, can differ.
 *
 * - api_key mode: ANTHROPIC_API_KEY (highest-precedence in SDK auth chain)
 * - subscription mode: removes ANTHROPIC_API_KEY plus any frozen OAuth shell
 *   tokens so the SDK falls all the way back to ~/.claude/.credentials.json
 *   (the tenant's CLAUDE_CONFIG_DIR in tenant mode), which has a working refresh path. A pre-existing CLAUDE_CODE_OAUTH_TOKEN
 *   in env (common when a process manager like PM2 inherited the launch shell)
 *   eventually 401s silently, so it is removed here.
 *
 * CLAUDE_CODE_USE_BEDROCK / CLAUDE_CODE_USE_VERTEX are intentionally left
 * alone so users with multi-provider setups aren't disrupted.
 */
export function applyAuthToEnv(): Record<string, string | undefined> {
  const prefs = getAuthPreferences();
  const overrides: Record<string, string | undefined> = prefs.auth_mode === 'api_key' && prefs.api_key
    ? { ANTHROPIC_API_KEY: prefs.api_key }
    : { ANTHROPIC_API_KEY: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined, CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: undefined };
  // Tenancy off: exactly the old behaviour. The single process has one environment, and every later child (Codex, dsh, the rolling summarizer)
  // inherits what this wrote, so it still writes it. The callers' merge of the returned overrides is then a no-op.
  // Tenant mode: process.env is every tenant's environment and is never written; callers merge per run (tenancy/child.ts).
  if (!tenancyEnabled()) {
    for (const [k, v] of Object.entries(overrides)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
  return overrides;
}

/**
 * The effective model for a role, from the settings service's one rule (default < sanctum.yaml < .env < SQLite). The db layer is this
 * table's preferred_model / preferred_model_autonomous, then the KV row agent.model (the /model command). `fallback` is what the caller
 * would use when the service holds nothing (it never is, short of a missing registry entry).
 *
 * Above this, in agent.ts and not config: the per-thread model (threads.model) and a scheduled wake's own modelOverride.
 */
export function effectiveModel(role: 'interactive' | 'autonomous', fallback: string): string {
  const r = resolveSetting(role === 'interactive' ? 'agent.model' : 'agent.model_autonomous');
  return typeof r.value === 'string' ? r.value : fallback;
}

/**
 * Returns the API key prefix only — for display in the UI without leaking the full key.
 * e.g. 'sk-ant-api03-abc123...xyz'
 */
export function maskApiKey(key: string | null): string | null {
  if (!key) return null;
  if (key.length <= 16) return '***';
  return `${key.slice(0, 12)}...${key.slice(-4)}`;
}

/**
 * Boot check: ANTHROPIC_API_KEY is in the environment (.env) but the auth mode is subscription, where applyAuthToEnv removes it from every run.
 * ONE line, only in that mismatch (the setup wizard selects api_key when a key is pasted; older installs and hand-edited .env files can still land here).
 * `npm run doctor` prints the same sentence as WARN.
 */
export function checkAuthKeyMode(warn: (m: string) => void = console.warn, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!authKeyIgnored(getAuthPreferences().auth_mode, env.ANTHROPIC_API_KEY)) return false;
  warn(`[auth] ${AUTH_KEY_IGNORED_LINE}`);
  return true;
}
