// The environment a harness child (Claude Code, Codex, dsh) starts with, per tenant (docs/MULTI-TENANT.md "Harness runs", decision D2).
//
// Tenancy off: childBaseEnv() is process.env, the same object, so every caller behaves as it did before this file existed.
// Tenant mode: a fresh object, never process.env. It holds the allowlisted process variables (PATH, HOME, locale, proxies: nothing
// secret), the tenant's own .env, the tenant's internal token and the process port (so tools/res.mjs calls this tenant's routes), and the
// tenant's harness homes, plus a HOME and TMPDIR of its own under data/harness/ (D7). The process's provider keys never enter it; the child decides nothing about that, because the key is simply
// not in the object. childEnv() (providers/child-env.ts) still withholds MIND_API_KEY on top.
import { join } from 'node:path';
import { applyAuthToEnv } from '../services/auth-preferences.js';
import { ownMkdirIn } from './own-files.js';
import { tenancyEnabled, tenantHomePaths, tenantOrNull, type TenantRuntime } from './context.js';

export const ENV_ALLOW = new Set([
  'PATH', 'HOME', 'LANG', 'LANGUAGE', 'TERM', 'TZ', 'SHELL', 'USER', 'LOGNAME',
  // proxies and certificates, so a corporate network still reaches the model
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  // Windows needs these to start a process at all
  'SystemRoot', 'SYSTEMROOT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP',
]);

const ENV_ALLOW_UPPER = new Set([...ENV_ALLOW].map((n) => n.toUpperCase()));

/** Backend-only secrets a tenant's .env carries for the backend's own use; a child never gets them. */
const BACKEND_ONLY = new Set(['APP_PASSWORD', 'MIND_API_KEY']);

/** D2: where each harness keeps its login and state for this tenant. Created 0700 (the mode is skipped on Windows). */
export function harnessHomes(rt: TenantRuntime): Record<'CLAUDE_CONFIG_DIR' | 'CODEX_HOME' | 'DSH_HOME', string> {
  const root = join(rt.dataDir, 'harness');
  const dirs = { CLAUDE_CONFIG_DIR: join(root, 'claude'), CODEX_HOME: join(root, 'codex'), DSH_HOME: join(root, 'dsh') };
  for (const d of Object.values(dirs)) ownMkdirIn(rt.dir, d, process.platform === 'win32' ? { recursive: true } : { recursive: true, mode: 0o700 });
  return dirs;
}

/** Process variables a tenant child never inherits (D7): the operator's home and temp folders. The tenant's own replace them below. */
const PER_TENANT = new Set(['HOME', 'USERPROFILE', 'TMPDIR', 'TMP', 'TEMP']);

function tenantHomeEnv(rt: TenantRuntime): Record<string, string> {
  const { home, tmp } = tenantHomePaths(rt);
  for (const d of [home, tmp]) ownMkdirIn(rt.dir, d, process.platform === 'win32' ? { recursive: true } : { recursive: true, mode: 0o700 });
  const env: Record<string, string> = { HOME: home, TMPDIR: tmp, TMP: tmp, TEMP: tmp };
  if (process.platform === 'win32') env.USERPROFILE = home;
  return env;
}

/** What a child's environment starts from. Off: process.env itself. On (inside a tenant): see the header. Outside any tenant: throws. */
export function childBaseEnv(): NodeJS.ProcessEnv {
  const rt = tenantOrNull('a harness child environment');
  if (!rt) return process.env;
  const env: NodeJS.ProcessEnv = {};
  // Names compare case-insensitively: Windows enumerates `Path`, not `PATH`, and a child without it finds no git or node.
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !PER_TENANT.has(k.toUpperCase()) && (ENV_ALLOW_UPPER.has(k.toUpperCase()) || k.toUpperCase().startsWith('LC_'))) env[k] = v;
  }
  for (const [k, v] of Object.entries(rt.env)) if (!BACKEND_ONLY.has(k.toUpperCase())) env[k] = v;
  env.INTERNAL_TOKEN = rt.token;
  env.SANCTUM_PORT = String(rt.config.server.port) /* the tenant's server block is the process's (config.ts: only db_path differs) */;
  Object.assign(env, harnessHomes(rt));
  // D7: after the tenant's .env, so a tenant cannot point its child's HOME or TMPDIR at someone else's folder by naming one there.
  for (const k of Object.keys(env)) if (PER_TENANT.has(k.toUpperCase())) delete env[k];
  Object.assign(env, tenantHomeEnv(rt));
  return env;
}

/** A run's child env: childBaseEnv() as a copy with `overrides` applied (a value of undefined removes the name, matched case-insensitively
 *  as Windows does). No overrides: undefined, so the caller leaves the run's env to the provider switch. */
export function withRunEnv(overrides: Record<string, string | undefined> | undefined | void): NodeJS.ProcessEnv | undefined {
  if (!overrides) return undefined;
  const env: NodeJS.ProcessEnv = { ...childBaseEnv() };
  for (const [name, value] of Object.entries(overrides)) {
    for (const k of Object.keys(env)) if (k.toUpperCase() === name.toUpperCase()) delete env[k];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/** The base for every child that is not handed a run env of its own (Codex, dsh, the rolling summarizer): tenancy off, process.env, which
 *  applyAuthToEnv has already written the auth choice into (the old behaviour, exactly). Tenant mode: the tenant's base env with this
 *  tenant's auth choice applied to the copy, so subscription mode drops a key and an OAuth token a run would otherwise inherit. */
export function childRunBase(): NodeJS.ProcessEnv {
  const base = childBaseEnv();
  return base === process.env ? base : withRunEnv(applyAuthToEnv())!;
}

/** Tenancy off: write the person's auth choice (subscription or api key) into process.env before a background run that inherits it (the
 *  summarizer: digest, handoff, outlook), as those runs did for themselves. Tenant mode: nothing; childRunBase() merges it into the run's own copy.
 *  Best effort: a missing database or preference never stops a run. */
export function applyAuthForBackgroundRun(): void {
  if (tenancyEnabled()) return;
  try { applyAuthToEnv(); } catch { /* the run goes on with the environment as it is */ }
}

/** `{ env }` for a provider call's options, or nothing when there are no overrides (the provider switch then picks childBaseEnv()). */
export function runEnvOption(overrides: Record<string, string | undefined> | undefined | void): { env?: NodeJS.ProcessEnv } {
  const env = withRunEnv(overrides);
  return env ? { env } : {};
}

/** The seam where a per-tenant OS user or sandbox plugs in (design doc, "What does not change": every harness child must run as a
 *  per-tenant OS user or inside a per-tenant sandbox). Takes the spawn description (command, args, cwd, env, uid/gid, or the SDK's spawn
 *  override) and returns the one to use. Identity today: no behaviour. */
export function spawnWrapper<T>(_rt: TenantRuntime, spec: T): T { return spec; }
