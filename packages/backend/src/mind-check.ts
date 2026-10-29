// The updater's one line about the Mind: `node packages/backend/dist/mind-check.js`, run by
// scripts/update.mjs after the build. It reads the same settings the app does (the Settings → Mind card
// in the database, opened read-only; sanctum.yaml; MIND_API_KEY from .env), runs the watchdog's probe
// once, and prints one line. It never prompts and never writes, and it never fails the update: any
// trouble reading settings is itself a line.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { config as loadDotenv } from 'dotenv';
import { PROJECT_ROOT, loadConfig } from './config.js';
import { describeMindSettingsFrom } from './services/mind-client.js';
import { mindCheckLine } from './services/mind-watchdog.js';

async function main(): Promise<string> {
  loadDotenv({ path: join(PROJECT_ROOT, '.env') });
  const log = console.log;
  console.log = () => {}; // loadConfig announces the file it read
  let cfg;
  try { cfg = loadConfig(); } finally { console.log = log; }
  let db: Database.Database | null = null;
  try {
    if (existsSync(cfg.server.db_path)) db = new Database(cfg.server.db_path, { readonly: true, fileMustExist: true });
  } catch { db = null; }
  try {
    const read = (key: string): string => {
      try { return String((db?.prepare('SELECT value FROM config WHERE key = ?').get(key) as { value?: string } | undefined)?.value ?? '').trim(); } catch { return ''; }
    };
    const report = describeMindSettingsFrom({ read, yaml: cfg.integrations?.mind_cloud, mcpJsonPath: cfg.agent?.mcp_json_path });
    return await mindCheckLine(report);
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

main().then(
  (line) => { console.log(line); },
  (err) => { console.log(`Mind: could not check (${err instanceof Error ? err.message.split('\n')[0] : 'unknown error'}).`); },
);
