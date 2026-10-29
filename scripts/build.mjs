// build.mjs — full production build with a single, consistent build id.
//
// Generates ONE build id, then runs the workspace builds with it in the
// environment so vite bakes the same value into __BUILD_ID__ (define in
// packages/frontend/vite.config.ts reads process.env.BUILD_ID). Finally stamps
// packages/frontend/build/.build-id via write-build-id.mjs (which reads the same
// BUILD_ID). This is what makes the frontend's compile-time __BUILD_ID__ equal
// the value the backend serves at /api/version — without it the version check
// would always report a mismatch.

import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

function genBuildId() {
  // Must change on every BUILD, not every commit — we deploy by rebuilding without
  // committing, so a git-hash-only id would freeze and the version check would never
  // fire. Combine the git short hash (traceability) with a per-build timestamp.
  let git = '';
  try {
    git = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch { /* no git available */ }
  const stamp = Date.now().toString(36);
  return git ? `${git}-${stamp}` : stamp;
}

const buildId = genBuildId();
const env = { ...process.env, BUILD_ID: buildId };

const run = (cmd) => execSync(cmd, { stdio: 'inherit', cwd: root, env });

run('npm run build --workspace=packages/shared');
run('npm run build --workspace=packages/backend');
run('npm run build --workspace=packages/frontend');
run('node scripts/write-build-id.mjs');

console.log(`[build] stamped frontend bundle with BUILD_ID=${buildId}`);
