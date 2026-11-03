// The entry point of the app: `node packages/backend/boot.mjs` (npm start, pm2, systemd, Docker, and the updater's own respawn all run this, never server.js).
//
// This file is tracked plain JavaScript that lives OUTSIDE every directory a swap moves (node_modules, packages/*/dist, packages/*/node_modules, the frontend build), so it exists at every
// instant of a swap: in the window after dist is renamed into the rollback copy and before the staged dist is renamed in, `node packages/backend/boot.mjs` still starts, finds the
// cut-short swap and puts the previous version back. (A git fast-forward may change it too, but a checkout writes each file atomically and runs before any rename; the recovery's
// `git reset --hard` + `git checkout -- .` covers a cut in the middle of one.)
//
// Why not just server.js: node links a program's whole import graph before it evaluates any of it, so a recovery that is merely the first import of server.ts cannot run first. After a
// swap that was cut short (kill -9, a power cut) node_modules may be half moved and `import 'dotenv'` fails while the graph is being linked. This file imports only node's own modules
// (through the vendored, dependency-free scripts/boot-recover.mjs, generated from src/boot-recover.ts), recovers, and only then loads the app with a dynamic import. When it had to
// change files it starts over first (a re-exec, or exit 75 under a supervisor). `dist/server.js` stays importable on its own (tests, `tsx src/server.ts`), but it recovers nothing.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLEAN_BOOT_MS, bootRecover, clearLoopCount } from '../../scripts/boot-recover.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const how = await bootRecover({ root });
if (how === 'booting' || how === 'guarded') {
  await import('./dist/server.js');
  // A boot that stays up is a clean one: the loop guard's count starts over (not after a refusal: then the count is what keeps the guard honest).
  if (how === 'booting') setTimeout(() => clearLoopCount(root), CLEAN_BOOT_MS).unref();
} else {
  await new Promise(() => { /* exiting, or this is only the parent of the restarted app: nothing after this may load */ });
}
