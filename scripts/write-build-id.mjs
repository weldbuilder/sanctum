// write-build-id.mjs — stamp the frontend build with its build id.
//
// Writes packages/frontend/build/.build-id so the backend (server.ts) can read
// back the id of the bundle it is serving and expose it at GET /api/version.
//
// The id MUST equal the value vite bakes into __BUILD_ID__ for the same build.
// That match is guaranteed by running this under the SAME process.env.BUILD_ID
// that the vite build saw — see scripts/build.mjs, which sets BUILD_ID once and
// passes it to both the vite build and this script. When BUILD_ID is unset
// (e.g. a standalone CI stamp), fall back to the git short hash, then a
// time-based id, so a value is always written.
//
// Prints the resolved id to stdout so CI can capture it.

import { execSync } from 'node:child_process';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function resolveBuildId() {
  if (process.env.BUILD_ID) return process.env.BUILD_ID;
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return Date.now().toString(36);
  }
}

const buildId = resolveBuildId();
const outDir = join(__dirname, '..', 'packages', 'frontend', 'build');

if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, '.build-id'), buildId, 'utf-8');

process.stdout.write(buildId + '\n');
