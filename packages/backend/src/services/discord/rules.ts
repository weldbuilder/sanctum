// Server/channel/user context for the owner lane's prompt (buildRulesContext). Read-only: from the discord.rules
// settings key, else data/discord-rules.json. Nothing here admits or ignores anyone any more (the lane is decided by
// channel at intake, lanes.ts); the screens and routes that edited these rules are gone.

import { readOwnOrApp } from '../../tenancy/own-files.js';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getConfig } from '../db.js';
import { currentTenant, tenantLocal } from '../../tenancy/context.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface ServerRule {
  id: string;
  name: string;
  context: string;
  requireMention?: boolean;
  ignoredChannels?: string[];
  ignoredUsers?: string[];
  allowPublicResponses?: boolean;
}

export interface ChannelRule {
  id: string;
  name: string;
  serverId: string;
  context?: string;
  requireMention?: boolean;
  alwaysListen?: boolean;
  ignore?: boolean;
  readOnly?: boolean;
}

export interface UserRule {
  id: string;
  name: string;
  context?: string;
  allowedServers?: string[];
  blockedServers?: string[];
  trustLevel: 'full' | 'standard' | 'limited';
  relationship?: string;
}

export interface RulesData {
  servers: Record<string, ServerRule>;
  channels: Record<string, ChannelRule>;
  users: Record<string, UserRule>;
}

// Load rules from data directory (fallback for first boot). Tenant mode: the tenant's own <data>/discord-rules.json.
const rulesPath = (): string => {
  const rt = currentTenant();
  return rt ? join(rt.dataDir, 'discord-rules.json') : join(__dirname, '../../../data/discord-rules.json');
};

function loadRulesFromFile(): RulesData {
  try {
    const content = readOwnOrApp(rulesPath());
    return JSON.parse(content);
  } catch (error) {
    console.warn('[Discord Rules] Failed to load discord-rules.json, using empty rules:', (error as Error).message);
    return { servers: {}, channels: {}, users: {} };
  }
}

function loadRulesFromDb(): RulesData | null {
  const raw = getConfig('discord.rules');
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    console.warn('[Discord Rules] Failed to parse rules from DB, falling back to file');
    return null;
  }
}

function loadRulesWithFallback(): RulesData {
  return loadRulesFromDb() || loadRulesFromFile();
}

// Active rule maps — lazily initialized on first access (DB may not be ready at import time). One set per tenant in tenant mode (tenantLocal:
// one process-wide set otherwise), so one tenant's server, channel and user rules are never read under another.
interface RuleMaps { servers: Map<string, ServerRule>; channels: Map<string, ChannelRule>; users: Map<string, UserRule>; loaded: boolean }
const rulesLocal = tenantLocal<RuleMaps>(() => ({ servers: new Map(), channels: new Map(), users: new Map(), loaded: false }));

export const serverRules = (): Map<string, ServerRule> => rulesLocal.get().servers;
export const channelRules = (): Map<string, ChannelRule> => rulesLocal.get().channels;
export const userRules = (): Map<string, UserRule> => rulesLocal.get().users;

function ensureRulesLoaded(): void {
  const m = rulesLocal.get();
  if (m.loaded) return;
  m.loaded = true;
  const data = loadRulesWithFallback();
  for (const [k, v] of Object.entries(data.servers)) m.servers.set(k, v);
  for (const [k, v] of Object.entries(data.channels)) m.channels.set(k, v);
  for (const [k, v] of Object.entries(data.users)) m.users.set(k, v);
  console.log(`[Discord Rules] Loaded ${m.servers.size} server, ${m.channels.size} channel, ${m.users.size} user rules`);
}

// --- Getters ---

export function getServerRule(guildId: string | null): ServerRule | undefined {
  ensureRulesLoaded();
  if (!guildId) return undefined;
  return rulesLocal.get().servers.get(guildId);
}

export function getChannelRule(channelId: string): ChannelRule | undefined {
  ensureRulesLoaded();
  return rulesLocal.get().channels.get(channelId);
}

export function getUserRule(userId: string): UserRule | undefined {
  ensureRulesLoaded();
  return rulesLocal.get().users.get(userId);
}

export function buildRulesContext(userId: string, channelId: string, guildId: string | null): string {
  const parts: string[] = [];

  if (guildId) {
    const serverRule = getServerRule(guildId);
    if (serverRule?.context) parts.push(serverRule.context);
  } else {
    parts.push('=== CONTEXT: DIRECT MESSAGE ===');
    parts.push('Private DM conversation. Full presence.');
  }

  const channelRule = getChannelRule(channelId);
  if (channelRule?.context) {
    parts.push('');
    parts.push(`=== CHANNEL: ${channelRule.name} ===`);
    parts.push(channelRule.context);
  }

  const userRule = getUserRule(userId);
  if (userRule) {
    parts.push('');
    parts.push(`=== SPEAKING WITH: ${userRule.name} ===`);
    if (userRule.relationship) parts.push(userRule.relationship);
    if (userRule.context) parts.push(userRule.context);
  }

  return parts.join('\n');
}
