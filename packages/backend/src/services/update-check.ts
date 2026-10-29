// Is there a newer Sanctum on GitHub? Compares this install's package.json
// version with the one on the project's main branch. One small request, at
// most every six hours, never more than that and never blocking anything.
// Off with updates.check: false. For a private project, GITHUB_TOKEN in .env.
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { getSanctumConfig, PROJECT_ROOT } from '../config.js';

export interface UpdateStatus {
  version: string;          // this install
  latest: string | null;    // on GitHub, null when unknown
  update_available: boolean;
  repo: string;
  branch: string;
  checked_at: string | null;
  error?: string;
}

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

/** True when `a` is a higher semantic version than `b` ("1.2.0" > "1.1.9"). */
export function isNewer(a: string, b: string): boolean {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0, y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

export function installedVersion(): string {
  try {
    return (JSON.parse(readFileSync(resolve(PROJECT_ROOT, 'package.json'), 'utf-8')).version as string) || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

let cached: UpdateStatus | null = null;
let inflight: Promise<UpdateStatus> | null = null;

async function fetchLatest(repo: string, branch: string): Promise<string> {
  // Public project: the raw file host (no rate limit, no token). Otherwise the
  // API, which honours GITHUB_TOKEN for a private project.
  const auth: Record<string, string> = process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {};
  const tries: Array<{ url: string; accept: string }> = [
    { url: `https://raw.githubusercontent.com/${repo}/${encodeURIComponent(branch)}/package.json`, accept: 'text/plain' },
    { url: `https://api.github.com/repos/${repo}/contents/package.json?ref=${encodeURIComponent(branch)}`, accept: 'application/vnd.github.raw+json' },
  ];
  let last = 'unreachable';
  for (const t of tries) {
    try {
      const res = await fetch(t.url, { headers: { 'User-Agent': 'sanctum-mobile', Accept: t.accept, ...auth }, signal: AbortSignal.timeout(8000) });
      if (!res.ok) { last = `GitHub answered ${res.status}`; continue; }
      const v = JSON.parse(await res.text()).version;
      if (typeof v !== 'string' || !v) throw new Error('no version in package.json');
      return v;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
  }
  throw new Error(last);
}

export async function checkForUpdate(opts: { force?: boolean } = {}): Promise<UpdateStatus> {
  const cfg = getSanctumConfig().updates;
  const version = installedVersion();
  const base: UpdateStatus = { version, latest: null, update_available: false, repo: cfg.repo, branch: cfg.branch, checked_at: null };
  if (!cfg.check) return base;
  if (!opts.force && cached && Date.now() - Date.parse(cached.checked_at ?? '0') < CHECK_EVERY_MS) return cached;
  if (inflight) return inflight;
  inflight = (async () => {
    const checked_at = new Date().toISOString();
    try {
      const latest = await fetchLatest(cfg.repo, cfg.branch);
      cached = { ...base, latest, update_available: isNewer(latest, version), checked_at };
    } catch (err) {
      cached = { ...base, checked_at, error: err instanceof Error ? err.message : String(err) };
    } finally {
      inflight = null;
    }
    return cached;
  })();
  return inflight;
}

/** Test hook. */
export function _resetUpdateCache(): void { cached = null; inflight = null; }
