// A reload recomputes a tenant's effective background_runs (operator ceiling AND the tenant's own value) and acts on a flip: off stops the tenant's orchestrator,
// outlook author and handoff schedule (the summarizer has no timer: its entry point reads the flag); on starts them the way boot does. One line either way.
import type { SanctumConfig } from '../config.js';
import type { Orchestrator } from '../services/orchestrator.js';
import { startOutlookAuthor, stopOutlookAuthor } from '../services/outlook-author.js';
import { startHandoffSchedule, stopHandoffSchedule } from '../services/handoff.js';
import { runInTenant, type TenantRuntime } from './context.js';
import { effectiveBackgroundRuns } from './background.js';

/** Call after `rt.config` holds the reloaded config. A runtime that was never booted with services (no flag yet) only records the value. */
export function syncBackgroundRuns(rt: TenantRuntime, processCfg: SanctumConfig): void {
  const was = rt.services.backgroundRuns;
  const now = effectiveBackgroundRuns(processCfg, rt.config);
  rt.services.backgroundRuns = now;
  if (typeof was !== 'boolean' || was === now) return;
  const orchestrator = rt.services.orchestrator as Orchestrator | undefined;
  if (!now) {
    runInTenant(rt, () => {
      for (const stop of [() => orchestrator?.stop(), stopOutlookAuthor, stopHandoffSchedule]) { try { stop(); } catch { /* one stopper failing must not keep the others */ } }
    });
    console.log(`[tenancy] tenant ${rt.id}: background model runs are off (reload): orchestrator, outlook author and handoff stopped`);
    return;
  }
  try {
    runInTenant(rt, () => {
      if (processCfg.orchestrator.enabled && rt.config.orchestrator.enabled) orchestrator?.start();
      startOutlookAuthor();
      startHandoffSchedule();
    });
    console.log(`[tenancy] tenant ${rt.id}: background model runs are on (reload): orchestrator, outlook author and handoff started`);
  } catch (err) {
    rt.services.backgroundRuns = false;
    runInTenant(rt, () => { for (const stop of [() => orchestrator?.stop(), stopOutlookAuthor, stopHandoffSchedule]) { try { stop(); } catch { /* best effort */ } } });
    console.warn(`[tenancy] tenant ${rt.id}: background runs could not start on reload and stay off: ${(err instanceof Error ? err.message : String(err)).split('\n')[0]}`);
  }
}
