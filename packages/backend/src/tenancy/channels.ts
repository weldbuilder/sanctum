// Discord and Telegram per tenant (docs/MULTI-TENANT.md, decisions D8 and D9). One service per tenant that has a bot token, built and started
// inside that tenant; every client handler runs as its tenant (services/discord and services/telegram wrap them); the service lives on
// rt.services and app.locals answers with the current tenant's own.
//
// D9: a bot token that two tenants both hold (in the tenant .env or the encrypted config row) parks BOTH tenants' channel of that platform: one
// boot line each, naming the other tenant ids and never the token. The tenants otherwise boot. Tokens are compared by sha256, never by value in
// a log. A toggle that would start a parked channel later is refused the same way.
import { createHash } from 'node:crypto';
import { bindCurrentTenant, currentTenant, runInTenant, type TenantRuntime } from './context.js';
import { getBotToken, hasBotToken, type BotPlatform } from '../services/bot-token.js';
import { resolveSetting } from '../services/settings/index.js';
import { DiscordService } from '../services/discord/index.js';
import { TelegramService } from '../services/telegram/index.js';
import type { AgentService } from '../services/agent.js';
import type { VoiceService } from '../services/voice.js';
import { registry, setGatewayServices } from '../services/ws.js';

const PLATFORMS: BotPlatform[] = ['discord', 'telegram'];
const label = (p: BotPlatform) => (p === 'discord' ? 'Discord' : 'Telegram');

let known: () => TenantRuntime[] = () => [];
/** Boot hands over the live list of booted tenants (the checks below look across all of them). */
export function registerChannelTenants(source: () => TenantRuntime[]): void { known = source; }

const fingerprint = (token: string): string => createHash('sha256').update(token).digest('hex');

/** sha256 of the tenant's bot token for a platform, or null (none, or it could not be read). Runs as that tenant. */
function tokenFingerprint(rt: TenantRuntime, platform: BotPlatform): string | null {
  try {
    const t = runInTenant(rt, () => getBotToken(platform));
    return t ? fingerprint(t) : null;
  } catch { return null; }
}

// What each LIVE client is actually running with: platform -> tenant id -> sha256 of the token it logged in with. Set when a client starts, cleared
// when it stops. A tenant that changes or deletes its stored token while its client still runs would otherwise be forgotten at once, and another
// tenant could take the old token and run the same bot (Codex, PR #18). Inert with tenancy off (nothing registers).
const live = new Map<BotPlatform, Map<string, string>>([['discord', new Map()], ['telegram', new Map()]]);

function markLive(rt: TenantRuntime, platform: BotPlatform): void {
  const fp = tokenFingerprint(rt, platform);
  if (fp) live.get(platform)!.set(rt.id, fp); else live.get(platform)!.delete(rt.id);
}
function markStopped(rt: TenantRuntime, platform: BotPlatform): void { live.get(platform)!.delete(rt.id); }
/** For the toggle routes: the current tenant's client for `platform` just started / stopped. */
export function markCurrentChannel(platform: BotPlatform, running: boolean): void {
  const rt = known().find((r) => r.id === currentTenant()?.id);
  if (!rt) return;
  if (running) markLive(rt, platform); else markStopped(rt, platform);
}

/** The other tenants (ids) that hold the same bot token as `rt` for `platform`: configured now, or running live under another tenant. */
export function duplicateTokenOwners(rt: TenantRuntime, platform: BotPlatform): string[] {
  const mine = tokenFingerprint(rt, platform);
  if (!mine) return [];
  const ids = new Set(known().filter((o) => o !== rt && tokenFingerprint(o, platform) === mine).map((o) => o.id));
  for (const [id, fp] of live.get(platform)!) if (id !== rt.id && fp === mine) ids.add(id);
  return [...ids].sort();
}

const channelKey = (p: BotPlatform) => (p === 'discord' ? 'discordService' : 'telegramService');

/** Start one platform's service for `rt` (inside the tenant), unless parked by D9 or not enabled/keyed. A failure is one line and nothing else. */
function startOne(rt: TenantRuntime, platform: BotPlatform, agent: AgentService, voice: VoiceService, log: (m: string) => void): void {
  runInTenant(rt, () => {
    const dup = duplicateTokenOwners(rt, platform);
    if (dup.length) { log(`[tenancy] tenant ${rt.id}: ${label(platform)} parked, its bot token is also held by tenant ${dup.join(', ')} (a token in two tenants runs in neither)`); return; }
    let on = false;
    try { on = resolveSetting(`${platform}.enabled`).value === true && hasBotToken(platform); } catch { on = false; }
    if (!on) return;
    try {
      const svc = platform === 'discord' ? new DiscordService(agent, registry) : new TelegramService(agent, registry, voice);
      rt.services[channelKey(platform)] = svc;
      markLive(rt, platform);
      // start() logs its own login failure; a rejection here is the last line of defence, never the process.
      void svc.start().catch(bindCurrentTenant((err: unknown) => console.error(`[tenancy] tenant ${rt.id}: ${label(platform)} did not start: ${err instanceof Error ? err.message : String(err)}`)));
    } catch (err) {
      delete rt.services[channelKey(platform)];
      markStopped(rt, platform);
      log(`[tenancy] tenant ${rt.id}: ${label(platform)} did not start: ${(err instanceof Error ? err.message : String(err)).split('\n')[0]}`);
    }
  });
}

/** Start each platform's service for `rt` (inside the tenant). Called from boot inside the same per-tenant catch as every other service. */
export function startTenantChannels(rt: TenantRuntime, agent: AgentService, voice: VoiceService, log: (m: string) => void = (m) => console.warn(m)): void {
  for (const platform of PLATFORMS) startOne(rt, platform, agent, voice, log);
  runInTenant(rt, () => setGatewayServices({ discord: (rt.services.discordService as DiscordService) ?? null, telegram: (rt.services.telegramService as TelegramService) ?? null }));
}

/** A tenant changed or deleted its own bot token: its live client (running with the old one) is stopped, so the registry tells the truth, and
 *  restarted with the new token when the channel is enabled and the new token is not parked. Never throws (it runs after the token is saved). */
export async function refreshChannelAfterTokenChange(platform: BotPlatform): Promise<void> {
  const cur = currentTenant();
  const rt = cur && known().find((r) => r.id === cur.id);
  if (!rt) return; // tenancy off: one client, nothing to re-key here (single-tenant behaviour unchanged)
  try {
    await runInTenant(rt, async () => {
      const key = channelKey(platform);
      const svc = rt.services[key] as { stop(): Promise<void> } | undefined;
      if (svc) { try { await svc.stop(); } catch { /* the old client is gone either way */ } delete rt.services[key]; }
      markStopped(rt, platform);
      const agent = rt.services.agentService as AgentService | undefined;
      const voice = rt.services.voiceService as VoiceService | undefined;
      if (agent && voice) startOne(rt, platform, agent, voice, (m) => console.warn(m));
    });
  } catch (err) {
    console.warn(`[tenancy] tenant ${rt.id}: ${label(platform)} could not be re-keyed: ${(err instanceof Error ? err.message : String(err)).split('\n')[0]}`);
  }
}

/** Stop this tenant's channel services (graceful shutdown). */
export function stopTenantChannels(rt: TenantRuntime): Promise<unknown> {
  return Promise.all(PLATFORMS.map((p) => {
    const svc = rt.services[channelKey(p)] as { stop(): Promise<void> } | undefined;
    if (!svc) return undefined;
    markStopped(rt, p);
    return runInTenant(rt, () => svc.stop()).catch(() => { /* one channel failing to stop must not keep the exit waiting */ });
  }));
}
