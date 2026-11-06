// ---------------------------------------------------------------------------
// Bot token store — single source of truth for Discord / Telegram bot tokens.
//
// Resolution order (per platform), decided by the settings service (services/settings): the one rule is
// default < sanctum.yaml < .env < SQLite, and a bot token has no yaml home, so:
//   1. config table value (AES-256-GCM ciphertext) → decrypt → plaintext
//   2. {DISCORD,TELEGRAM}_BOT_TOKEN from .env (the tenant's own .env in tenant mode)
//   3. null
//
// SECURITY: the plaintext token value is NEVER logged here and NEVER returned to
// any client. Callers (the gateway services) consume the plaintext only to hand
// it to client.login() / new Telegraf(). Status/read endpoints use hasBotToken().
// ---------------------------------------------------------------------------

import { setConfig, deleteConfig } from './db.js';
import { encryptSecret } from './google-auth.js';
import { resolveSecret } from './settings/index.js';

export type BotPlatform = 'discord' | 'telegram';

/** Config table key for a platform's stored (encrypted) bot token. */
function configKey(platform: BotPlatform): string {
  return platform === 'discord' ? 'discord.botToken' : 'telegram.botToken';
}

/**
 * Resolve the active bot token for a platform through the settings service (the typed token row, decrypted, beats the env var; a row that
 * no longer decrypts counts as no row). Returns plaintext for gateway login use only.
 */
export function getBotToken(platform: BotPlatform): string | null {
  return resolveSecret(`${platform}.bot_token`);
}

/** True if a usable token exists in the DB OR the env. Never exposes the value. */
export function hasBotToken(platform: BotPlatform): boolean {
  return getBotToken(platform) !== null;
}

/**
 * Persist a bot token, encrypted at rest, under the platform's config key.
 * The plaintext lives only in this call frame; it is never logged.
 */
export function saveBotToken(platform: BotPlatform, plaintext: string): void {
  const ciphertext = encryptSecret(plaintext);
  setConfig(configKey(platform), ciphertext);
}

/** Remove a stored bot token. Env fallback (if any) remains in effect. */
export function clearBotToken(platform: BotPlatform): void {
  deleteConfig(configKey(platform));
}
