// /api/plugins in tenant mode. Each tenant gets its own plugin mount, built once at boot inside that tenant: its enabled list ("enabled at
// startup" is per tenant), its trust mode, its ledger and audit folder, its scan cache and route state all come from its own config. A request
// is handed to its tenant's mount.
//
// One plugin module instance is shared by every tenant (decision D3): a plugin's routes.mjs is imported by path, and Node evaluates a module
// once per URL, so tenants whose plugin code is at one path (a shipped plugin, a companion-trust plugin) share it, told apart only by
// req.tenant = { id } and the config getter. (In person trust each tenant runs its own ratified copy, a file in its own ledger folder, so
// that is one evaluation per tenant: the code that runs is the code that tenant ratified.)
import type { RequestHandler, Router } from 'express';
import { createPluginMount, type MountDeps } from '../services/plugins.js';
import { runInTenant, type TenantRuntime } from './context.js';

const KEY = 'pluginMount';

export function buildTenantPluginMounts(runtimes: Iterable<TenantRuntime>, deps: () => MountDeps): RequestHandler {
  for (const rt of runtimes) rt.services[KEY] = runInTenant(rt, () => createPluginMount(deps()));
  return (req, res, next) => {
    const mount = req.tenant?.services[KEY] as Router | undefined;
    if (!mount) { res.status(503).json({ error: 'service_unavailable', service: 'plugins' }); return; }
    mount(req, res, next);
  };
}
