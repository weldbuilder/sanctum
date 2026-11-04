// sync-boot-recover.mjs — scripts/boot-recover.mjs is the dependency-free pre-boot recovery for `npm start` (scripts/update.mjs --recover), which must work when dist is
// missing. Its source is packages/backend/src/boot-recover.ts (what packages/backend/boot.mjs runs); this writes the plain-JavaScript copy:
//
//   node scripts/sync-boot-recover.mjs          write scripts/boot-recover.mjs
//   node scripts/sync-boot-recover.mjs --check  exit 1 when it is stale (a test runs this)
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const ts = require('typescript');

export function transpiled() {
  const src = readFileSync(join(root, 'packages', 'backend', 'src', 'boot-recover.ts'), 'utf-8');
  const out = ts.transpileModule(src, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, removeComments: false } }).outputText;
  return `// GENERATED from packages/backend/src/boot-recover.ts by scripts/sync-boot-recover.mjs. Do not edit; edit the .ts and run: node scripts/sync-boot-recover.mjs\n${out.replace(/\r\n/g, '\n')}`;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const target = join(root, 'scripts', 'boot-recover.mjs');
  const want = transpiled();
  if (process.argv.includes('--check')) {
    let have = '';
    try { have = readFileSync(target, 'utf-8'); } catch { /* missing */ }
    if (have !== want) { console.error('scripts/boot-recover.mjs is stale: run node scripts/sync-boot-recover.mjs'); process.exit(1); }
  } else writeFileSync(target, want);
}
