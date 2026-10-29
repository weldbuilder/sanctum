#!/usr/bin/env node
// setup.mjs — the setup wizard:  npm run setup
//
// Asks a handful of questions and writes sanctum.yaml and .env. Safe to run
// again: existing answers are the defaults, and keys it does not ask about are
// left exactly as they were. It reads ~/.codex/config.toml to show which models
// and providers Codex already knows about, and writes to it only when asked:
// a new provider block, Codex's default model, or its memories flag. A backup
// copy is made first, every time.
//
// The questions are data (scripts/setup-plan.mjs) and the writes are one function
// (scripts/setup-apply.mjs); this file is the terminal: it asks, and prints.
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { runSetup } from './setup-walk.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// npm run setup -- --tenant <id> [--create]: the same questions for one tenant of a `tenants:` block (docs/MULTI-TENANT.md).
const args = process.argv.slice(2);
let tenant;
let create = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--tenant' && args[i + 1] !== undefined) tenant = args[++i];
  else if (args[i].startsWith('--tenant=')) tenant = args[i].slice('--tenant='.length);
  else if (args[i] === '--create') create = true;
  else { console.error(`Unknown option ${args[i]}. Usage: npm run setup [-- --tenant <id> [--create]]`); process.exit(2); }
}
if (create && tenant === undefined) { console.error('--create goes with --tenant <id>.'); process.exit(2); }

if (!stdin.isTTY) {
  console.error('npm run setup asks questions, so it needs a terminal. Open Terminal, go to the app folder, and run it there.');
  process.exit(1);
}

const rl = createInterface({ input: stdin, output: stdout });
// Ctrl+C or Ctrl+D at any question: stop with nothing written.
const cancelled = () => { console.log('\nSetup cancelled. Nothing was written.'); process.exit(130); };
rl.on('SIGINT', cancelled);
const io = {
  say: (s = '') => console.log(s),
  prompt: async (text) => {
    try { return await rl.question(text); }
    catch (err) { if (err?.code === 'ABORT_ERR') cancelled(); throw err; }
  },
};
try { await runSetup({ root, io, tenant, create }); }
catch (err) { if (tenant === undefined) throw err; console.error(`\n${err.message}`); process.exitCode = 1; }
finally { rl.close(); }
