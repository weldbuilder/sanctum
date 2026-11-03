// Hot park and revive of ONE tenant without a process restart (docs/MULTI-TENANT.md, "Parking a companion").
//
// "Parked" here means the WHOLE companion is switched off by the operator: its services are stopped, its sockets closed, its database closed, and it answers 503
// (its hosts stay reserved; household mode lists it `unavailable`). It is a different thing from a service park (a duplicate bot token, channels.ts, or a
// shared Revien address, revien.ts), which switches one service off and leaves the companion up. The words are never used for each other in the code:
// the registry records `operator_parked` (this file) or `start_failed` (boot, or a revive, did not get the tenant up).
//
// Revive goes through the same code path as boot: the same admission (admitTenant: folder, runtime from the files as they are NOW, token), the same layout
// check a reload does, the same Revien reconciliation, and the same startTenant with its catch. A tenant whose files were fixed while it was parked comes
// back; one that fails to start stays down with the error recorded. Nothing here reads or writes another tenant: parking A is the running set losing A.
import { runInTenant, type TenantRuntime } from './context.js';
import { admitTenant, republishTenants, startTenant, stopTenantServices, tenantLifecycle, type TenantLifecycle } from './boot.js';
import { readRootsLoosely } from './config.js';
import { layoutClash } from './layout.js';
import { reconcileRevienOnReload } from './revien.js';
import { housePassword, householdMode } from './house.js';
import { mountPluginsFor } from './plugin-mount.js';
import { registry } from '../services/ws.js';
import type { AgentService } from '../services/agent.js';

export type TenantState = 'running' | 'parked' | 'failed';
export interface TenantStatus { id: string; state: TenantState; error?: string }

/** A refusal the route turns into a status: 404 no such folder, 409 already in that state (or a change is under way). */
export class ParkRefusal extends Error {
  constructor(readonly status: 404 | 409, readonly code: string, message: string) { super(message); this.name = 'ParkRefusal'; }
}

/** The websocket close code a parked companion's clients get: 1013, try again later (the page reconnects and is answered 503 until the revive). */
export const PARK_CLOSE_CODE = 1013;

// Ids with a park or revive under way: a second call for the same id is a 409, never a second runtime on one folder.
const moving = new Set<string>();

function lifecycle(): TenantLifecycle {
  const l = tenantLifecycle();
  if (!l) throw new ParkRefusal(404, 'not_found', 'tenancy is off');
  return l;
}
function known(l: TenantLifecycle, id: string): void {
  if (!l.ids.includes(id)) throw new ParkRefusal(404, 'not_found', `no tenant folder named ${id}`);
}

function statusOf(l: TenantLifecycle, id: string): TenantStatus {
  if (l.runtimes.has(id)) return { id, state: 'running' };
  const why = l.inactive.get(id);
  if (!why) return { id, state: 'failed' };
  return { id, state: why.kind === 'operator_parked' ? 'parked' : 'failed', error: why.lastError ?? (why.kind === 'start_failed' ? why.why : undefined) };
}

/** Every tenant folder found at boot, with whether it runs. An error is the last recorded reason it is not running. */
export function tenantStatuses(): TenantStatus[] {
  const l = tenantLifecycle();
  return l ? l.ids.map((id) => statusOf(l, id)) : [];
}

/** Park one running tenant. Stops its services (stopTenantServices for it alone), closes its sockets and database, keeps its hosts reserved (503). */
export async function parkTenant(id: string): Promise<TenantStatus> {
  const l = lifecycle();
  known(l, id);
  if (moving.has(id)) throw new ParkRefusal(409, 'in_progress', `tenant ${id} is already being parked or revived`);
  const rt = l.runtimes.get(id);
  if (!rt) throw new ParkRefusal(409, 'not_running', `tenant ${id} is not running (${l.inactive.get(id)?.kind === 'operator_parked' ? 'already parked' : 'it did not start'})`);
  moving.add(id);
  try {
    // First, in one synchronous step, leave the running set: from here a request for this tenant is answered 503, whatever happens below.
    l.runtimes.delete(id);
    l.skippedConfigs.set(id, readRootsLoosely(rt.dir)); // (what it may write stays off limits to the others while it is down)
    l.reservedFor.set(id, [...rt.hosts]);
    l.inactive.set(id, { kind: 'operator_parked', why: 'parked by the operator' });
    republishTenants(l);
    // A turn in flight is asked to stop and its sockets are closed, inside the tenant (its own registry, its own agent).
    runInTenant(rt, () => {
      try { (rt.services.agentService as AgentService | undefined)?.stopGeneration(); } catch { /* best effort */ }
      try { registry.closeAll(PARK_CLOSE_CODE, 'companion parked'); } catch { /* best effort */ }
    });
    await stopTenantServices([rt]);
    closeQuietly(rt);
    console.warn(`[tenancy] tenant ${id} parked by the operator`);
    return statusOf(l, id);
  } finally { moving.delete(id); }
}

/** Revive one tenant that is not running (parked, or it never started) from its files as they are now, by the same path as boot. A tenant that fails to start
 *  stays down with the error recorded, and the result says so (`state` is not `running`, `error` is the line). */
export function reviveTenant(id: string): TenantStatus {
  const l = lifecycle();
  known(l, id);
  if (l.runtimes.has(id)) throw new ParkRefusal(409, 'already_running', `tenant ${id} is already running`);
  if (moving.has(id)) throw new ParkRefusal(409, 'in_progress', `tenant ${id} is already being parked or revived`);
  moving.add(id);
  try {
    const why = bringUp(l, id);
    if (why === null) console.log(`[tenancy] tenant ${id} revived`);
    else {
      const entry = l.inactive.get(id);
      if (entry) entry.lastError = why;
      console.warn(`[tenancy] tenant ${id} did not revive: ${why}`);
    }
    return statusOf(l, id);
  } finally { moving.delete(id); }
}

/** null once the tenant runs, else the one-line reason it does not. */
function bringUp(l: TenantLifecycle, id: string): string | null {
  const tokenOwner = new Map<string, string>([...l.runtimes.values()].map((r) => [r.token, r.id]));
  const admitted = admitTenant(l.processCfg, l.dir, id, l.household, tokenOwner);
  if ('why' in admitted) { closeQuietly(admitted.rt); return admitted.why; }
  const rt = admitted.rt;
  const others = [...l.runtimes.values()];
  // The check a reload makes: where its writable roots sit against every running tenant and the process.
  const clash = layoutClash([...others, rt], l.processCfg).get(id);
  if (clash) { closeQuietly(rt); return clash; }
  if (!l.household) {
    // A host a running tenant serves is not this tenant's; a host two tenants once claimed stays unserved (as at boot).
    const taken = rt.hosts.find((h) => others.some((o) => o.hosts.includes(h)));
    if (taken) { closeQuietly(rt); return `its host ${taken} is served by another tenant`; }
    rt.hosts = rt.hosts.filter((h) => !l.contested.has(h));
  }
  reconcileRevienOnReload(rt, others); // (decided from every tenant's files; the other tenants are read, never written)
  if (householdMode()) rt.config.auth.password = housePassword();
  const failed = startTenant(l.processCfg, rt);
  if (failed) { closeQuietly(rt); return failed; }
  mountPluginsFor(rt);
  l.runtimes.set(id, rt);
  l.skippedConfigs.delete(id);
  l.reservedFor.delete(id);
  l.inactive.delete(id);
  republishTenants(l);
  return null;
}

function closeQuietly(rt: TenantRuntime | undefined): void {
  if (rt) { try { rt.db.close(); } catch { /* already closed */ } }
}
