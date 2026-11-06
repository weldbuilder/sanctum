// Telegram configuration — DB-backed with config.yaml fallback defaults

import { getConfigNumber } from '../db.js';
import { resolveSetting } from '../settings/index.js';
import type { TelegramConfigValues } from './types.js';

const DEFAULTS = {
  maxMessageLength: 4096,
};

export function getTelegramConfig(): TelegramConfigValues {
  return {
    // default < sanctum.yaml (telegram.owner_chat_id) < the KV row the bot saved: the settings service's one rule
    ownerChatId: String(resolveSetting('telegram.owner_chat_id').value ?? ''),
    maxMessageLength: getConfigNumber('telegram.maxMessageLength', DEFAULTS.maxMessageLength),
  };
}
