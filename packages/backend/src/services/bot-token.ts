// ---------------------------------------------------------------------------
// Bot token store — single source of truth for Discord / Telegram bot tokens.
//
// Resolution order (per platform):
//   1. config table value (AES-256-GCM ciphertext) → decrypt → plaintext
//   2. process.env.{DISCORD,TELEGRAM}_BOT_TOKEN  (back-compat with .env)
//   3. null
//
// SECURITY: the plaintext token value is NEVER logged here and NEVER returned to
// any client. Callers (the gateway services) consume the plaintext only to hand
// it to client.login() / new Telegraf(). Status/read endpoints use hasBotToken().
// ---------------------------------------------------------------------------

import { envFor } from '../tenancy/context.js';
import { getConfig, setConfig, deleteConfig } from './db.js';
import { encryptSecret, decryptSecret } from './google-auth.js';

export type BotPlatform = 'discord' | 'telegram';

/** Config table key for a platform's stored (encrypted) bot token. */
function configKey(platform: BotPlatform): string {
  return platform === 'discord' ? 'discord.botToken' : 'telegram.botToken';
}

/** Env var name for a platform's back-compat token. */
function envVar(platform: BotPlatform): string {
  return platform === 'discord' ? 'DISCORD_BOT_TOKEN' : 'TELEGRAM_BOT_TOKEN';
}

/**
 * Resolve the active bot token for a platform: stored (decrypted) value first,
 * then the env var, then null. Returns plaintext for gateway login use only.
 */
export function getBotToken(platform: BotPlatform): string | null {
  const stored = getConfig(configKey(platform));
  if (stored) {
    const plain = decryptSecret(stored);
    if (plain && plain.length > 0) return plain;
    // Stored blob failed to decrypt (e.g. key rotated) — fall through to env.
  }
  const fromEnv = envFor('bot token')[envVar(platform)];
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return null;
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
