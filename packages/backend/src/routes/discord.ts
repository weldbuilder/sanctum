// The Discord admin routes, mounted by api.ts at /api/discord (behind its authMiddleware). Its own file so the
// routes can be tested over a real express app without loading the rest of api.ts.

import { Router } from 'express';
import { registry } from '../services/ws.js';
import { hasBotToken } from '../services/bot-token.js';
import { getConfig, setConfig } from '../services/db.js';
import { resolveSetting } from '../services/settings/index.js';
import { getSanctumConfig } from '../config.js';
import { eventSummary } from '../services/logs.js';
import { DiscordService } from '../services/discord/index.js';
import type { AgentService } from '../services/agent.js';
import { buildDiscordStatus } from '../services/discord/status.js';
import { getDiscordPaths } from '../services/discord/paths.js';
import { exclusionsStatus } from '../services/discord/intake.js';
import { publicHarnessSupported } from '../services/discord/harness.js';
import { wordGateStatus, nameGuardStatus } from '../services/discord/send.js';
import { getDiscordConfig } from '../services/discord/config.js';
import { handleUnavailable } from '../tenancy/errors.js';
import { tenancyEnabled, currentTenant } from '../tenancy/context.js';
import { duplicateTokenOwners, markCurrentChannel } from '../tenancy/channels.js';

export const discordRouter = Router();

/** What Settings sees. discord.deferMaxAgeMs is not part of it any more (the clock is discord.deferral_hours in sanctum.yaml). */
const settingsView = () => {
  const { deferMaxAgeMs: _legacy, ...rest } = getDiscordConfig();
  return rest;
};

// --- Discord admin endpoints ---


discordRouter.get('/status', (req, res) => {
  try {
    const discordService = req.app.locals.discordService as DiscordService | null;
    const configEnabled = resolveSetting('discord.enabled').value === true; // the effective switch (default < yaml < .env < db), what boot used
    const hasToken = hasBotToken('discord');
    // Lane state, gate state (counts and states, never entries), paused, the private folder. Read-only.
    const lanes = buildDiscordStatus(getSanctumConfig().discord, getDiscordPaths(), { words: wordGateStatus(), names: nameGuardStatus() }, { ownerUserIdOverride: getConfig('discord.ownerUserId') || '', exclusions: exclusionsStatus(), publicHarnessSupported: publicHarnessSupported(), recentFailures: eventSummary('discord') });
    if (!discordService) {
      res.json({ enabled: false, configEnabled, hasToken, ...lanes });
      return;
    }
    res.json({ enabled: true, configEnabled, hasToken, ...discordService.getStats(), ...lanes });
  } catch (error) {
    if (handleUnavailable(error, res)) return;
    console.error('Error fetching Discord status:', error);
    res.status(500).json({ error: 'Failed to fetch Discord status' });
  }
});

discordRouter.post('/toggle', async (req, res) => {
  try {
    const { enabled } = req.body as { enabled: boolean };
    const agentService = req.app.locals.agentService as AgentService;

    if (enabled) {
      // Start Discord gateway
      if (!hasBotToken('discord')) {
        res.status(400).json({ error: 'Discord bot token not set (Settings or DISCORD_BOT_TOKEN)' });
        return;
      }
      if (req.app.locals.discordService) {
        res.json({ success: true, message: 'Already running' });
        return;
      }
      // D9: a bot token another tenant also holds runs in neither tenant.
      const rt = tenancyEnabled() ? currentTenant() : undefined;
      const dup = rt ? duplicateTokenOwners(rt, 'discord') : [];
      if (dup.length) {
        console.warn(`[tenancy] tenant ${rt!.id}: Discord parked, its bot token is also held by tenant ${dup.join(', ')}`);
        res.status(409).json({ error: 'parked', message: 'This Discord bot token is also used by another tenant, so Discord is parked for both. Give each tenant its own bot.' });
        return;
      }
      const service = new DiscordService(agentService, registry);
      await service.start();
      req.app.locals.discordService = service;
      if (tenancyEnabled()) markCurrentChannel('discord', true);
      setConfig('discord.enabled', 'true');
      console.log('[Discord] Gateway enabled via settings toggle');
      res.json({ success: true, message: 'Discord gateway started' });
    } else {
      // Stop Discord gateway
      const service = req.app.locals.discordService as DiscordService | null;
      if (service) {
        await service.stop();
        req.app.locals.discordService = null;
        if (tenancyEnabled()) markCurrentChannel('discord', false);
      }
      setConfig('discord.enabled', 'false');
      console.log('[Discord] Gateway disabled via settings toggle');
      res.json({ success: true, message: 'Discord gateway stopped' });
    }
  } catch (error) {
    if (handleUnavailable(error, res)) return;
    console.error('Error toggling Discord:', error);
    res.status(500).json({ error: 'Failed to toggle Discord gateway' });
  }
});

// --- Discord settings ---


// GET /discord/settings — all config values
discordRouter.get('/settings', (req, res) => {
  try {
    res.json(settingsView());
  } catch (error) {
    console.error('Error fetching Discord settings:', error);
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

// PUT /discord/settings — partial update of config values
discordRouter.put('/settings', (req, res) => {
  try {
    const body = req.body as Record<string, unknown>;

    // Map of setting keys to their DB config keys
    const settingsMap: Record<string, string> = {
      ownerUserId: 'discord.ownerUserId',
      debounceMs: 'discord.debounceMs',
      ownerActiveThresholdMin: 'discord.ownerActiveThresholdMin',
      deferPollIntervalMs: 'discord.deferPollIntervalMs',
    };

    let updated = 0;

    for (const [key, dbKey] of Object.entries(settingsMap)) {
      if (key in body) {
        setConfig(dbKey, String(body[key]));
        updated++;
      }
    }

    // Return current state after update
    res.json({ success: true, updated, ...settingsView() });
  } catch (error) {
    console.error('Error updating Discord settings:', error);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});
