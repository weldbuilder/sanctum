// The entry point of the app: `node dist/boot.js` (npm start, pm2, systemd, Docker, and the updater's own respawn all run this, never server.js).
//
// Why a separate entry: node links a program's whole import graph before it evaluates any of it, so a recovery that is merely the first import of server.ts cannot run first. After a
// swap that was cut short (kill -9, a power cut) node_modules may be half moved, `import 'dotenv'` fails while the graph is being linked, and the app never reaches its own code.
// This file imports nothing but node's own modules (through ./boot-recover.js, which imports only those too), puts the previous version back when a swap was cut short, and
// only then loads the app with a dynamic import. When it had to change files it starts over first (a re-exec, or exit 75 under a supervisor: see boot-recover.ts).
// `dist/server.js` stays importable on its own (tests, `tsx src/server.ts`), but it does not recover anything.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLEAN_BOOT_MS, bootRecover, clearLoopCount } from './boot-recover.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const how = await bootRecover({ root });
if (how === 'booting' || how === 'guarded') {
  await import('./server.js');
  // A boot that stays up is a clean one: the loop guard's count starts over (not after a refusal: then the count is what keeps the guard honest).
  if (how === 'booting') setTimeout(() => clearLoopCount(root), CLEAN_BOOT_MS).unref();
} else {
  await new Promise<never>(() => { /* exiting, or this is only the parent of the restarted app: nothing after this may load */ });
}
