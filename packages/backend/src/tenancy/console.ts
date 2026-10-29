// Console output per tenant (docs/MULTI-TENANT.md: "the process log keeps only process-level lines and never a tenant's text").
// Installed only in tenant mode. While a tenant is current, console.log/info/warn/error/debug write one line to that tenant's own
// <data>/logs/tenant.log (prefixed with an ISO timestamp, which services/logs.ts parses) and NOT to stdout/stderr. With no tenant current the
// line goes where it always went. Anything that looks like the tenant's token, password or a secret-named .env value is replaced first.
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { format } from 'node:util';
import { currentTenant, type TenantRuntime } from './context.js';
import { ownAppendFile, ownMkdir, ownRename, ownUnlink } from './own-files.js';

const METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD)/i;

export const tenantLogFile = (rt: TenantRuntime): string => join(rt.dataDir, 'logs', 'tenant.log');

/** The secret values this tenant holds (its token, login, and any secret-named .env entry). Short values are skipped so a word is not blanked. */
function secretsOf(rt: TenantRuntime): string[] {
  const out = [rt.token, rt.config?.auth?.password ?? ''];
  for (const [k, v] of Object.entries(rt.env)) if (SECRET_NAME.test(k)) out.push(v);
  return out.filter((v): v is string => typeof v === 'string' && v.length >= 6);
}

export function redactFor(rt: TenantRuntime, text: string): string {
  let t = text;
  for (const s of secretsOf(rt)) t = t.split(s).join('[redacted]');
  return t;
}

/** One file may grow to this many bytes; then it moves to tenant.log.1 (replacing the last one) and a new tenant.log starts. At most about twice
 *  the cap per tenant on disk, so one tenant cannot fill the shared disk. */
let cap = 10 * 1024 * 1024;
export function setTenantLogCap(bytes: number): void { cap = bytes; sizes.clear(); }
// Bytes written per file, so the common call does not stat; the size is read from disk the first time a file is touched.
const sizes = new Map<string, number>();

/** Append one line to `file`, moving it aside at the cap (tenant.log, and the per-tenant orchestrator.log). The folder must exist. */
export function appendCapped(file: string, line: string): void {
  const add = Buffer.byteLength(line);
  let size = sizes.get(file);
  if (size === undefined) { try { size = statSync(file).size; } catch { size = 0; } }
  if (size > 0 && size + add > cap) {
    try { ownUnlink(`${file}.1`); } catch { /* none yet (Windows cannot rename over an existing file) */ }
    try { ownRename(file, `${file}.1`); } catch { /* keep appending */ }
    size = 0;
  }
  ownAppendFile(file, line);
  sizes.set(file, size + add);
}

const MARK = Symbol.for('sanctum.tenantConsole');

/** Replace the console's methods on `target` (the global console by default). Idempotent. Returns a function that puts them back. */
export function installTenantConsole(target: Pick<Console, (typeof METHODS)[number]> = console): () => void {
  if ((target.log as unknown as Record<symbol, boolean>)[MARK]) return () => {};
  const originals = Object.fromEntries(METHODS.map((m) => [m, target[m]])) as Record<(typeof METHODS)[number], (...a: unknown[]) => void>;
  for (const m of METHODS) {
    target[m] = (...args: unknown[]): void => {
      const rt = currentTenant();
      if (!rt) { originals[m].apply(target, args); return; }
      try {
        ownMkdir(join(rt.dataDir, 'logs'), process.platform === 'win32' ? { recursive: true } : { recursive: true, mode: 0o700 });
        appendCapped(tenantLogFile(rt), `${new Date().toISOString()}: ${redactFor(rt, format(...(args as [unknown, ...unknown[]])))}\n`);
      } catch { /* a log that cannot be written is dropped, never sent to the process's output */ }
    };
  }
  (target.log as unknown as Record<symbol, boolean>)[MARK] = true;
  return () => { for (const m of METHODS) target[m] = originals[m] as never; };
}
