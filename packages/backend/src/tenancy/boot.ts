// Boot for tenant mode: read every tenant folder, build the runtimes, turn tenancy on, register hosts.
import type { Express } from 'express';
import { PROJECT_ROOT, type SanctumConfig } from '../config.js';
import { loadVectorCache } from '../services/vector-cache.js';
import { startIdentityGate } from '../services/identity/notify.js';
import { AgentService, registerAgentService } from '../services/agent.js';
import { VoiceService } from '../services/voice.js';
import { registry, setVoiceService } from '../services/ws.js';
import { setSystemLineRegistry } from '../services/system-line.js';
import { currentTenant, enableTenancy, NoTenantContext, registerAllTenants, runInTenant, type TenantRuntime } from './context.js';
import { isHousehold, listTenants, parseTenantsBlock, readHostsLoosely, readRootsLoosely, tenantHoldsAppProblem, tenantsDirProblem } from './config.js';
import { layoutClash } from './layout.js';
import { TenantServiceUnavailable } from './errors.js';
import { createTenantRuntime } from './runtime.js';
import { authKeyMissingProblem } from '../../../../scripts/setup-inherit.mjs';
import { enableHousehold, houseDataDir, syncHousePassword } from './house.js';
import { setReservedHosts, setTenantRegistry } from './resolve.js';
import { join } from 'node:path';
import { Orchestrator } from '../services/orchestrator.js';
import { PushService } from '../services/push.js';
import { MindWatchdog, getMindWatchdog, setMindWatchdog } from '../services/mind-watchdog.js';
import { startOutlookPoller, stopOutlookPoller } from '../services/outlook.js';
import { startOutlookAuthor, stopOutlookAuthor } from '../services/outlook-author.js';
import { startHandoffSchedule, stopHandoffSchedule } from '../services/handoff.js';
import { announceSetupCode, setTenantAnnounceTap } from '../services/setup-code.js';
import { registerChannelTenants, startTenantChannels, stopTenantChannels } from './channels.js';
import { parkDuplicateRevien } from './revien.js';
import { effectiveBackgroundRuns, noteBackgroundCeiling } from './background.js';

/** The per-process services that are not per tenant. None since stage 3c (Discord and Telegram are per tenant); kept so a future shared service has a place. */
export const SHARED_SERVICES = [] as const;
/** The channel services app.locals answers for per tenant: the current tenant's own, or null when it has none (off, no token, parked). */
const CHANNEL_SERVICES = ['discordService', 'telegramService'] as const;

/** Whether this tenant's background model runs may run: tenants.background_runs in the process yaml (default true) is the operator's CEILING, and the tenant's own
 *  `background_runs` can only turn them off for itself (tenancy/background.ts). */
export function backgroundRunsFor(processCfg: SanctumConfig, rt: TenantRuntime): boolean {
  noteBackgroundCeiling(rt.id, processCfg, rt.config);
  return effectiveBackgroundRuns(processCfg, rt.config);
}

/** Print the setup code of every tenant that has no password yet, each inside its own tenant: to stdout (the operator reads it) naming the tenant,
 *  and to that tenant's own log. Never a password or a token. server.ts calls this once the server listens. */
export function announceTenantSetupCodes(runtimes: Iterable<TenantRuntime>): void {
  setTenantAnnounceTap((line) => console.log(`[setup] ${line}`)); // (called inside the tenant, so this is that tenant's log)
  for (const rt of runtimes) if (!rt.config.auth.password) runInTenant(rt, () => { announceSetupCode(); });
}

export function bootTenants(app: Express, processCfg: SanctumConfig): Map<string, TenantRuntime> {
  const block = parseTenantsBlock(processCfg);
  if (!block) throw new Error('bootTenants called without a tenants: block');
  // tenants.dir that is the app folder, or holds it, would read every folder of the app (or an app copy) as a tenant.
  const dirBad = tenantsDirProblem(block.dir, PROJECT_ROOT);
  if (dirBad) throw new Error(dirBad);
  const ids = listTenants(block.dir);
  const household = isHousehold(block);
  // A missing `tenants.auth` is household; an install that looks per-tenant must say so rather than be switched on upgrade.
  const authBad = authKeyMissingProblem(block.dir, block);
  if (authBad) throw new Error(authBad);
  if (ids.length === 0) throw new Error(`tenants.dir ${block.dir} has no tenant folders (a folder named like a-z, 0-9, - up to 32 characters)`);

  // Operator mistakes stop the boot; one tenant's own mistakes never do: that tenant is skipped with one line.
  if (process.env.INTERNAL_TOKEN) throw new Error('INTERNAL_TOKEN is set in the process environment; in tenant mode each tenant has its own token in <tenant>/data/.internal-token, so unset it');
  if (block.default !== undefined && !household && !ids.includes(block.default)) throw new Error(`tenants.default is ${block.default}, but there is no tenant folder with that id`);
  const runtimes = new Map<string, TenantRuntime>();
  // Hosts that must answer 503, never someone else: a skipped tenant's, and any host two tenants both claimed.
  const reserved = new Set<string>();
  const tokenOwner = new Map<string, string>();
  const skippedConfigs: SanctumConfig[] = [];
  const skip = (id: string, why: string, rt?: TenantRuntime) => {
    // What a skipped tenant declared it may write stays off limits to the others (the unions in plugins.ts read these).
    skippedConfigs.push(readRootsLoosely(rt ? rt.dir : join(block.dir, id)));
    if (rt) { try { rt.db.close(); } catch { /* already closed */ } }
    for (const h of rt ? rt.hosts : readHostsLoosely(join(block.dir, id))) reserved.add(h);
    console.warn(`[tenancy] tenant ${id} skipped: ${why}`);
  };
  for (const id of ids) {
    let rt: TenantRuntime;
    // A tenant folder that is, or holds, the app folder (a link to an ancestor of the app) would hand the operator's .env and database to a tenant.
    const holds = tenantHoldsAppProblem(join(block.dir, id), PROJECT_ROOT);
    if (holds) { skip(id, holds); continue; }
    try { rt = createTenantRuntime(processCfg, id, join(block.dir, id), process.env, household); }
    catch (err) { skip(id, (err instanceof Error ? err.message : String(err)).replace(new RegExp(`^tenant ${id}: `), '').split('\n')[0]); continue; }
    const same = tokenOwner.get(rt.token);
    if (same) { skip(id, `its internal token is the same as tenant ${same}'s`, rt); continue; }
    tokenOwner.set(rt.token, id);
    if (household) {
      // One house, one password: a tenant's own APP_PASSWORD is not a login, and hosts are not read (the prefix names the companion).
      if (rt.config.auth.password) console.warn(`[tenancy] household mode: the house password applies; a tenant password (APP_PASSWORD in ${id}/.env, or auth.password in its tenant.yaml) is ignored`);
      if (rt.hosts.length) { console.warn(`[tenancy] household mode: hosts in ${id}/tenant.yaml are not read (the companion is served at /c/${id}/)`); rt.hosts = []; }
    }
    runtimes.set(id, rt);
  }
  // Where tenants sit: nobody's writable roots may touch another tenant's data/, private/, .env or tenant.yaml, or the process's own files.
  for (const [id, why] of layoutClash([...runtimes.values()], processCfg)) {
    const rt = runtimes.get(id)!;
    runtimes.delete(id);
    skip(id, why, rt);
  }
  // A host two tenants claim belongs to neither: both lose it, and it answers 503.
  const claims = new Map<string, string[]>();
  for (const rt of runtimes.values()) for (const h of rt.hosts) claims.set(h, [...(claims.get(h) ?? []), rt.id]);
  for (const [h, owners] of claims) {
    if (owners.length < 2) continue;
    reserved.add(h);
    for (const id of owners) { const rt = runtimes.get(id)!; rt.hosts = rt.hosts.filter((x) => x !== h); }
    console.warn(`[tenancy] host ${h} is claimed by tenants ${owners.join(' and ')}: neither serves it`);
  }
  if (runtimes.size === 0) throw new Error(`no tenant in ${block.dir} could be started`);
  // One Revien daemon has no tenant scope: two tenants on one address are both parked (their memory is off, the tenants boot).
  parkDuplicateRevien([...runtimes.values()]);
  const defaultId = !household && block.default !== undefined && runtimes.has(block.default) ? block.default : undefined;
  if (household && block.default !== undefined) console.warn('[tenancy] household mode: tenants.default is not read (the hallway chooses a companion)');
  if (!household && block.default !== undefined && defaultId === undefined) console.warn(`[tenancy] default tenant ${block.default} was skipped; unclaimed hosts get a 404`);

  enableTenancy(true);
  // Household mode: open the house store (house.db next to the process's own data) and keep the list of every folder found, started or not.
  if (household) enableHousehold(houseDataDir(processCfg.server.db_path), ids);
  registerAllTenants({ booted: () => [...runtimes.values()], skipped: () => skippedConfigs });
  setTenantRegistry(runtimes, defaultId);
  setReservedHosts(reserved);
  if (household) syncHousePassword();
  // One tenant's service start failing (a bad cron expression, a watchdog that throws) skips THAT tenant, stops whatever it had started and
  // reserves its hosts; it never stops the others or the process (Codex, stage 3b).
  const startFailed: Array<[TenantRuntime, string]> = [];
  registerChannelTenants(() => [...runtimes.values()]);
  for (const rt of [...runtimes.values()]) {
    try {
    runInTenant(rt, () => {
      loadVectorCache();
      // One agent per tenant: its own queue, presence, active query, MCP status and turn probe (services/agent.ts keeps them in tenantLocal),
      // so tenant A's turn never queues behind tenant B's. No push service yet (stage 3): a finished turn is not pushed.
      const agent = new AgentService();
      rt.services.agentService = agent;
      registerAgentService(agent);
      // Push per tenant: the VAPID keys come from the tenant's own .env (never the process's), the subscriptions from its own database. A tenant
      // with no keys gets the existing "not configured" answer.
      const push = new PushService(rt.env.VAPID_PUBLIC_KEY, rt.env.VAPID_PRIVATE_KEY, rt.env.VAPID_CONTACT);
      rt.services.pushService = push;
      agent.setPushService(push);
      // One voice service per tenant, keyed from that tenant's own .env (services/voice.ts reads envFor); one socket registry per tenant
      // (services/ws.ts keeps it in tenantLocal), which the system-line path and the identity notice broadcast through.
      const voice = new VoiceService();
      rt.services.voiceService = voice;
      setVoiceService(voice);
      setSystemLineRegistry(registry);
      startIdentityGate();
      // The scheduler per tenant, after the agent and the identity gate: its timers, crons and watchers are created here, inside the tenant,
      // and every callback is bound to it (see bindCurrentTenant in services/orchestrator.ts). Started only when this tenant's config enables it,
      // as the single-tenant server does; constructed either way so the wake-type routes work.
      // The operator's switch for background model runs: tenants.background_runs in the process sanctum.yaml (default true) is a ceiling; the
      // tenant's own background_runs can only turn it off for itself. Off: the orchestrator is built (the routes need it) but not started, the outlook author and the handoff
      // schedule are not started, and the wake, author, handoff and summarizer entry points refuse (backgroundRunsOff). One line per boot.
      const background = backgroundRunsFor(processCfg, rt);
      rt.services.backgroundRuns = background;
      if (!background) console.log(`[tenancy] tenant ${rt.id}: background model runs are off (orchestrator wakes, outlook author, handoff and summarizer do not run)`);
      const orchestrator = new Orchestrator(agent, push);
      rt.services.orchestrator = orchestrator;
      // (The process's own orchestrator.enabled is the operator's off switch for every tenant; a tenant's own flag can only turn its scheduler off.)
      if (background && processCfg.orchestrator.enabled && rt.config.orchestrator.enabled) orchestrator.start();
      else if (!background) { /* said above */ }
      else console.log('[Orchestrator] Disabled via config.orchestrator.enabled — autonomous wakes off');
      const watchdog = new MindWatchdog({ broadcast: (status) => runInTenant(rt, () => registry.broadcast({ type: 'mind_status', status })) }); // (answers for this tenant's sockets whoever calls)
      setMindWatchdog(watchdog);
      watchdog.start();
      startOutlookPoller({ agent, orchestrator });
      if (background) { startOutlookAuthor(); startHandoffSchedule(); }
      // Discord and Telegram per tenant, last: inside this same catch, so a client that throws or a bad setup skips this tenant and never the process
      // (a failed login is the client's own log line and leaves everything else running). A token two tenants share parks both (D9).
      startTenantChannels(rt, agent, voice);
    });
    } catch (err) {
      const why = (err instanceof Error ? err.message : String(err)).split('\n')[0];
      try { stopTenantServices([rt]); } catch { /* partial services: best effort */ }
      runtimes.delete(rt.id);
      startFailed.push([rt, `its services did not start: ${why}`]);
      continue;
    }
    console.log(household ? `[tenancy] tenant ${rt.id}: /c/${rt.id}/` : `[tenancy] tenant ${rt.id}: ${rt.hosts.length ? rt.hosts.join(', ') : 'no hosts'}${defaultId === rt.id ? ' (default)' : ''}`);
  }
  for (const [rt, why] of startFailed) skip(rt.id, why, rt);
  if (runtimes.size === 0) throw new Error(`no tenant in ${block.dir} could be started`);
  if (startFailed.length) {
    // The registry, the default and the reserved hosts were set before the loop: say them again without the tenants that failed.
    const stillDefault = defaultId !== undefined && runtimes.has(defaultId) ? defaultId : undefined;
    if (defaultId !== undefined && stillDefault === undefined) console.warn(`[tenancy] default tenant ${defaultId} was skipped; unclaimed hosts get a 404`);
    registerAllTenants({ booted: () => [...runtimes.values()], skipped: () => skippedConfigs });
    setTenantRegistry(runtimes, stillDefault);
    setReservedHosts(reserved);
  }

  // (No runtime, token, env, db or password is put on app.locals: plugin routes and anything else holding `req.app` can read it. The registry
  // lives in resolve.ts, behind narrow accessors.)
  for (const name of SHARED_SERVICES as readonly string[]) {
    Object.defineProperty(app.locals, name, { configurable: true, enumerable: true, get() { throw new TenantServiceUnavailable(name); } });
  }
  // Discord and Telegram are per tenant: the getter answers with the current tenant's own service (null when it has none), the setter is how the
  // toggle routes start and stop it; both throw outside any tenant, never touching another's.
  for (const name of CHANNEL_SERVICES) {
    Object.defineProperty(app.locals, name, {
      configurable: true, enumerable: true,
      get() {
        const rt = currentTenant();
        if (!rt) throw new NoTenantContext(`the ${name}`);
        return rt.services[name] ?? null;
      },
      set(v: unknown) {
        const rt = currentTenant();
        if (!rt) throw new NoTenantContext(`the ${name}`);
        if (v) rt.services[name] = v; else delete rt.services[name];
      },
    });
  }
  // The orchestrator and the push service are per tenant too: the current tenant's own, a throw outside any tenant (never another's).
  for (const name of ['orchestrator', 'pushService'] as const) {
    Object.defineProperty(app.locals, name, {
      configurable: true, enumerable: true,
      get() {
        const rt = currentTenant();
        if (!rt) throw new NoTenantContext(`the ${name}`);
        return rt.services[name];
      },
    });
  }
  // The agent is per tenant: the getter answers with the current tenant's own service, and throws outside any tenant (never another's).
  Object.defineProperty(app.locals, 'agentService', {
    configurable: true, enumerable: true,
    get() {
      const rt = currentTenant();
      if (!rt) throw new NoTenantContext('the agent service');
      return rt.services.agentService;
    },
  });
  // Voice is per tenant too: the getter answers with the current tenant's service (keyless when its .env has no keys: the routes say "not configured").
  Object.defineProperty(app.locals, 'voiceService', {
    configurable: true, enumerable: true,
    get() {
      const rt = currentTenant();
      if (!rt) throw new NoTenantContext('the voice service');
      return rt.services.voiceService;
    },
  });
  return runtimes;
}

/** Stop every tenant's scheduler, watchdog and timers (graceful shutdown), each as its own tenant. The databases are closed by the caller after. */
export function stopTenantServices(runtimes: Iterable<TenantRuntime>): Promise<unknown> {
  const channels: Promise<unknown>[] = [];
  for (const rt of runtimes) {
    channels.push(stopTenantChannels(rt));
    runInTenant(rt, () => {
      for (const stop of [
        () => (rt.services.orchestrator as Orchestrator | undefined)?.stop(),
        () => getMindWatchdog().stop(),
        stopOutlookPoller, stopOutlookAuthor, stopHandoffSchedule,
      ]) { try { stop(); } catch { /* one stopper failing must not keep the others, or the exit, waiting */ } }
    });
  }
  return Promise.all(channels);
}
