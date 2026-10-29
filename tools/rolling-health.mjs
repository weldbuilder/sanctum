#!/usr/bin/env node
// rolling-health.mjs — is the rolling context keeping up?
//
//   node tools/rolling-health.mjs          one line per thread, totals, exit 1 if any thread is failing
//   node tools/rolling-health.mjs --json   the same as JSON, for a digest or a cron
//
// Reads data/rolling/*.json straight from disk (no server needed). A thread is
// "failing" when the last thing that happened to its summary was a failure:
// its older turns are out of the prompt until a fold succeeds. The app also
// serves this at GET /api/rolling/health.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const json = process.argv.includes('--json');

const FIRST_COOLDOWN_MS = 30 * 60_000;
const REPEAT_COOLDOWN_MS = 60 * 60_000;

async function rollingDir() {
  let dbPath = './data/sanctum.db';
  for (const name of ['sanctum.yaml', 'sanctum.yml', 'resonant.yaml', 'resonant.yml']) {
    const p = join(root, name);
    if (!existsSync(p)) continue;
    try {
      const yaml = (await import('js-yaml')).default;
      const cfg = yaml.load(readFileSync(p, 'utf-8')) || {};
      if (cfg.server?.db_path) dbPath = String(cfg.server.db_path);
    } catch { /* defaults */ }
    break;
  }
  if (process.env.DB_PATH) dbPath = process.env.DB_PATH;
  // An install from before the rename still has data/resonant.db beside its rolling folder.
  if (!existsSync(resolve(root, dbPath)) && existsSync(resolve(root, dbPath.replace(/sanctum\.db$/, 'resonant.db')))) dbPath = dbPath.replace(/sanctum\.db$/, 'resonant.db');
  return join(dirname(resolve(root, dbPath)), 'rolling'); // data/rolling beside either db name
}

const dir = await rollingDir();
const checkedAt = new Date().toISOString();
const threads = [];
if (existsSync(dir)) {
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
    let raw;
    try { raw = JSON.parse(readFileSync(join(dir, name), 'utf-8')); } catch { continue; }
    const segments = Array.isArray(raw.segments) ? raw.segments.length : 0;
    const failures = raw.failures ?? null;
    const lastSuccess = segments ? Date.parse(raw.updatedAt || '') || 0 : 0;
    const lastFailure = failures ? Date.parse(failures.lastAt || '') || 0 : 0;
    const failing = !!failures && lastFailure >= lastSuccess;
    const stuck = segments === 0 && !!failures && failures.count >= 3; // nothing ever covered, folds keep failing
    const truncated = (Array.isArray(raw.segments) ? raw.segments : []).filter((s) => s?.truncated).length;
    const until = failures ? lastFailure + (failures.count <= 1 ? FIRST_COOLDOWN_MS : REPEAT_COOLDOWN_MS) : 0;
    threads.push({
      threadId: name.slice(0, -5), segments, coveredCount: raw.coveredCount ?? 0, updatedAt: raw.updatedAt || '',
      failures, cooldownUntil: until > Date.now() ? new Date(until).toISOString() : null, failing, stuck, truncated,
    });
  }
}
const totals = {
  threads: threads.length,
  failing: threads.filter((t) => t.failing).length,
  stuck: threads.filter((t) => t.stuck).length,
  truncated: threads.reduce((s, t) => s + t.truncated, 0),
  segments: threads.reduce((s, t) => s + t.segments, 0),
};
const report = { checkedAt, dir, threads, totals };

if (json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  if (!threads.length) console.log(`no rolling sidecars in ${dir} (no thread has folded yet, or rolling is off)`);
  for (const t of threads) {
    const state = t.stuck ? `STUCK x${t.failures.count}: ${t.failures.lastError}` : t.failing ? `FAILING x${t.failures.count}: ${t.failures.lastError}` : 'ok';
    const when = t.updatedAt ? ` last fold ${t.updatedAt}` : '';
    const trunc = t.truncated ? ` truncated=${t.truncated}` : '';
    const cool = t.cooldownUntil ? ` cooldown until ${t.cooldownUntil}` : '';
    console.log(`${t.failing ? '!!' : '  '} ${t.threadId}  segments=${t.segments} covered=${t.coveredCount}${trunc}${when}${cool}  ${state}`);
  }
  console.log(`${totals.threads} thread${totals.threads === 1 ? '' : 's'}, ${totals.segments} segments, ${totals.truncated} shortened, ${totals.failing} failing, ${totals.stuck} stuck`);
}
process.exit(totals.failing ? 1 : 0);
