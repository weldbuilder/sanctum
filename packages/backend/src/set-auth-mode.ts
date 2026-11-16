// Sets the auth mode (and a stored key) from the terminal wizard, through the same service the app uses (services/auth-preferences.ts).
//   node --import tsx packages/backend/src/set-auth-mode.ts <db path>      the update arrives as JSON on stdin (a key never goes on a command line)
import { mkdirSync, readFileSync } from 'fs';
import { dirname } from 'path';
import { initDb } from './services/db.js';
import { updateAuthPreferences } from './services/auth-preferences.js';

const update = JSON.parse(readFileSync(0, 'utf-8'));
if (update.auth_mode !== 'api_key' && update.auth_mode !== 'subscription') throw new Error('auth_mode must be api_key or subscription');
// A fresh clone has no data/ yet; the app creates it at boot, the wizard runs before that.
mkdirSync(dirname(process.argv[2]), { recursive: true });
initDb(process.argv[2]);
updateAuthPreferences({ auth_mode: update.auth_mode, ...(typeof update.api_key === 'string' ? { api_key: update.api_key } : {}) });
