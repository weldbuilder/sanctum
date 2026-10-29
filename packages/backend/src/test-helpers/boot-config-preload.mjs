// Preload for server-boot.test.ts. The server reads <project root>/sanctum.yaml; this makes that one path answer with the text in
// SANCTUM_BOOT_YAML (and exist) without touching the checkout, so a scratch server can run with the orchestrator off and its writable
// folders in a temp folder. Nothing else is changed.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { resolve } from 'node:path';

const target = resolve(process.env.SANCTUM_BOOT_ROOT || '', 'sanctum.yaml');
const text = process.env.SANCTUM_BOOT_YAML || '';
// Windows paths compare case-insensitively (the drive letter alone can differ between cwd and import.meta.url).
const norm = (p) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));
const isTarget = (p) => typeof p === 'string' && norm(p) === norm(target);
const realExists = fs.existsSync;
const realRead = fs.readFileSync;
fs.existsSync = (p) => (isTarget(p) ? true : realExists(p));
fs.readFileSync = (p, ...rest) => (isTarget(p) ? text : realRead(p, ...rest));
syncBuiltinESMExports();
