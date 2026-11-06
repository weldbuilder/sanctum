// The short identity the summarizer runs with: "Who you are (short)". The full ratified identity is for a turn; a mid-tier
// model asked to condense a thread does better with enough to anchor the voice and the relationship and no more.
//
// Built from the ratified identity (guard.ts identityForRun: the ratified copy while a change waits):
//   - the companion's name and the person's name (identity config),
//   - who they are to each other, from profile.md,
//   - a voice anchor: companion.md's `summary:` section if it has one, else its first lines.
// Capped at SHORT_IDENTITY_CAP characters, cached under <data folder>/identity-short/<key>.txt, where the key is the ratified
// identity digest (and the names). A changed digest builds a new file. With no identity files: the names alone.
import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { getSanctumConfig, type SanctumConfig } from '../../config.js';
import { identityForRun } from '../identity/guard.js';
import { identityRoles, type IdentityFile } from '../identity/source.js';
import { statSync } from 'node:fs';
import { ownMkdirAsync, ownReadDir, ownUnlink, ownWriteFileAsync, readOwnOrAppAsync } from '../../tenancy/own-files.js';

export const SHORT_IDENTITY_CAP = 1200;
export const SHORT_IDENTITY_HEADING = '## Who you are (short)';
const RELATION_CAP = 420;
const VOICE_LINES = 12;

const clean = (text: string): string[] => String(text || '').replace(/<!--[\s\S]*?-->/g, '').split('\n').map((l) => l.trimEnd()).filter((l) => l.trim());

/** Cut `text` to `max` characters on a line boundary where one falls in the last half, else on a word, with an ellipsis. */
function clip(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const head = t.slice(0, Math.max(0, max - 1));
  const nl = head.lastIndexOf('\n');
  const sp = head.lastIndexOf(' ');
  const cut = nl >= max / 2 ? nl : sp >= max / 2 ? sp : head.length;
  return `${head.slice(0, cut).trimEnd()}…`;
}

/** The lines under a heading that matches `re` (up to the next heading of the same or higher level), or [] when there is none. */
function section(lines: string[], re: RegExp): string[] {
  const at = lines.findIndex((l) => /^#{1,6}\s/.test(l) && re.test(l));
  if (at < 0) return [];
  const level = /^#+/.exec(lines[at])![0].length;
  const out: string[] = [];
  for (const l of lines.slice(at + 1)) {
    const m = /^(#+)\s/.exec(l);
    if (m && m[1].length <= level) break;
    out.push(l);
  }
  return out;
}

/** The short identity text for these names and files; pure. */
export function buildShortIdentity(names: { companion: string; user: string }, files: IdentityFile[], roles: { profile?: string; narrative?: string } = {}): string {
  const { companion, user } = names;
  const head = [SHORT_IDENTITY_HEADING, `You are ${companion}. You are writing for yourself, about your life with ${user}.`];
  const find = (want: string | undefined, fallback: string) => files.find((f) => f.name.toLowerCase() === (want || fallback).toLowerCase());
  const profile = find(roles.profile, 'profile.md');
  const narrative = find(roles.narrative, 'companion.md');
  const parts: string[] = [];
  if (profile) {
    const lines = clean(profile.text);
    const rel = section(lines, /relationship|who we are|who (they|she|he) (is|are)|about/i);
    const body = (rel.length ? rel : lines.filter((l) => !/^#{1,6}\s/.test(l))).slice(0, 8).join('\n');
    if (body.trim()) parts.push(`Who you are to each other:\n${clip(body, RELATION_CAP)}`);
  }
  if (narrative) {
    const lines = clean(narrative.text);
    const explicit = section(lines, /^#{1,6}\s*summary:?\s*$/i);
    const body = (explicit.length ? explicit : lines.filter((l) => !/^#{1,6}\s/.test(l))).slice(0, VOICE_LINES).join('\n');
    if (body.trim()) parts.push(`Your voice, in your own words:\n${body}`);
  }
  const fixed = head.join('\n');
  let out = fixed;
  for (const p of parts) {
    const room = SHORT_IDENTITY_CAP - out.length - 2;
    if (room < 80) break;
    out += `\n\n${clip(p, room)}`;
  }
  return clip(out, SHORT_IDENTITY_CAP);
}

/** Cache files kept besides the one just written: a changed key leaves the old file behind, so keep the newest few. */
export const KEEP_CACHE_FILES = 3;
function pruneCache(dir: string, current: string): void {
  try {
    const old = ownReadDir(dir)
      .filter((n) => /^[0-9a-f]{32}\.txt$/.test(n) && n !== current)
      .map((n) => { try { return { n, t: statSync(join(dir, n)).mtimeMs }; } catch { return { n, t: 0 }; } })
      .sort((a, b) => b.t - a.t);
    for (const f of old.slice(KEEP_CACHE_FILES - 1)) { try { ownUnlink(join(dir, f.n)); } catch { /* best effort */ } }
  } catch { /* best effort */ }
}

const cacheKey = (digest: string, companion: string, user: string) => createHash('sha256').update(`${digest}\0${companion}\0${user}`).digest('hex').slice(0, 32);

/** The short identity for the current config (the tenant's own in a tenant): from the cache when the ratified digest is unchanged, else built and cached. Never throws. */
export async function shortIdentity(cfg: SanctumConfig = getSanctumConfig()): Promise<string> {
  const names = { companion: cfg.identity?.companion_name || 'Companion', user: cfg.identity?.user_name || 'the person' };
  let files: IdentityFile[] = [];
  let digest = '';
  try {
    const run = identityForRun(cfg, { harness: 'summarizer', pendingLine: false });
    files = run.fileTexts ?? [];
    digest = (run.ratifiedServed ? run.check?.ratified_digest : run.check?.digest) || '';
    if (!digest && files.length) digest = createHash('sha256').update(files.map((f) => `${f.name}\0${f.text}`).join('\0')).digest('hex');
  } catch (e) {
    console.warn(`[summarizer] could not read the identity (${e instanceof Error ? e.message : e}); using the names alone`);
  }
  const roles = (() => { try { return identityRoles(cfg.agent.cwd, cfg.identity); } catch { return {}; } })();
  if (!files.length) return buildShortIdentity(names, [], roles);
  const file = join(dirname(cfg.server.db_path), 'identity-short', `${cacheKey(digest, names.companion, names.user)}.txt`);
  try {
    const cached = await readOwnOrAppAsync(file);
    if (cached.trim() && cached.length <= SHORT_IDENTITY_CAP) return cached.trim();
  } catch { /* not built yet */ }
  const text = buildShortIdentity(names, files, roles);
  try {
    await ownMkdirAsync(dirname(file), { recursive: true });
    await ownWriteFileAsync(file, text);
    pruneCache(dirname(file), basename(file));
  } catch (e) {
    console.warn(`[summarizer] could not cache the short identity (${e instanceof Error ? e.message : e})`);
  }
  return text;
}
