// The refusal both tenant config writers share (PUT /config/raw and friends in routes/api.ts, PUT /api/plugins/enabled in plugin-config.ts):
// a tenant may not save a tenant.yaml that reaches outside its folder, changes what only the process decides, or would stop it booting.
import yaml from 'js-yaml';
import { tenantOrNull, getProcessConfig } from './context.js';
import { tenantYamlEditProblem } from './confine.js';
import { loadTenantConfig } from './config.js';
import { noteBackgroundCeiling } from './background.js';

/** Why the current tenant may not save `incoming` as its tenant.yaml (`currentText` is what is on disk now), or null. Null too with tenancy off. */
export function tenantEditRefusal(incoming: unknown, currentText: string): string | null {
  const tenant = tenantOrNull('config edit');
  if (!tenant) return null;
  let current: unknown = null;
  try { current = yaml.load(currentText); } catch { current = null; }
  const problem = tenantYamlEditProblem(incoming, current, tenant.dir);
  if (problem) return problem;
  // Dry run: the candidate must still load, or this tenant would be skipped at the next start and lose its login.
  let loaded;
  try { loaded = loadTenantConfig(getProcessConfig(), tenant.dir, tenant.id, { fileCfg: incoming, quiet: true }); }
  catch (err) { return `this config would stop the tenant starting: ${(err instanceof Error ? err.message : String(err)).replace(/^tenant [^:]*: /, '').split('\n')[0]}`; }
  // The operator's background_runs is a ceiling: `background_runs: true` under an operator `false` is accepted (the file says what the tenant wrote) and told once.
  noteBackgroundCeiling(tenant.id, getProcessConfig(), loaded.config);
  return null;
}

// The refusal type and the write helpers live in own-files.ts (the tenant-safe file layer); re-exported so the route and plugin code keeps its imports.
export { TenantEditRefused, tenantWriteRefusal, writeOwnFile } from './own-files.js';
