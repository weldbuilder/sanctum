// The typed tables that act as overrides today, as one reader each. Every one answers undefined when it holds nothing, and reads through the
// tenant-aware accessors (getDb, tenantLocal), so a tenant's call reads the tenant's own rows.
import { getConfig } from '../db.js';
import { getAuthPreferences } from '../auth-preferences.js';
import { decryptSecret, storedGoogleCreds } from '../google-auth.js';
import type { TypedStore } from './registry.js';

const orUndef = <T>(v: T | null | undefined): T | undefined => (v === null || v === undefined ? undefined : v);

function botToken(platform: 'discord' | 'telegram'): string | undefined {
  const stored = getConfig(`${platform}.botToken`);
  if (!stored) return undefined;
  const plain = decryptSecret(stored); // a blob that no longer decrypts (key rotated) is the same as no row: the env value, if any, applies
  return plain && plain.length > 0 ? plain : undefined;
}

export const TYPED_READERS: Record<TypedStore, { via: string; read: () => unknown }> = {
  'auth.preferred_model': { via: 'auth_preferences.preferred_model', read: () => orUndef(getAuthPreferences().preferred_model) },
  'auth.preferred_model_autonomous': { via: 'auth_preferences.preferred_model_autonomous', read: () => orUndef(getAuthPreferences().preferred_model_autonomous) },
  // A row that says nothing different from the default is still a row; the mode is only an override once someone saved a key with it.
  'auth.mode': { via: 'auth_preferences.auth_mode', read: () => { const p = getAuthPreferences(); return p.auth_mode === 'api_key' ? 'api_key' : undefined; } },
  'auth.api_key': { via: 'auth_preferences.api_key', read: () => orUndef(getAuthPreferences().api_key) },
  'bot.discord': { via: 'config:discord.botToken (encrypted)', read: () => botToken('discord') },
  'bot.telegram': { via: 'config:telegram.botToken (encrypted)', read: () => botToken('telegram') },
  'google.client_id': { via: 'google_auth.client_id', read: () => orUndef(storedGoogleCreds()?.clientId) },
  'google.client_secret': { via: 'google_auth.client_secret_enc', read: () => orUndef(storedGoogleCreds()?.clientSecret) },
};
