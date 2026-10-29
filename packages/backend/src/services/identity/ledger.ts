// The identity ledger: what the person ratified, and a journal of every change to the identity folder.
// (docs/PLUGINS.md "Identity ratification".)
//
// <ledger folder>/ledger.json            { version: 1, ratified?: { digest, files, ratified_at, by }, previous?, observed?, announced? }
// <ledger folder>/journal.jsonl          append-only; one line per detected or declared change
// <ledger folder>/snapshots/<digest>/    the ratified copy of the identity files (and the one before it)
//
// This is a separate store from the plugin ledger on purpose: pruning the plugin snapshots must never reach
// identity. It reuses plugin-ratify.ts for what is the same job (the walk, the hashes with the stat prefilter,
// the atomic write, the snapshot copy and rename).
//
// What it protects against: anything that can write the identity folder but cannot also rewrite this folder.
// The ledger folder is refused when it is inside identity/, and it belongs outside the companion's writable
// folders (the app warns when it is not: ledgerPlacementWarning). The default is <project>/data/identity, whatever
// server.db_path is. A writer that can rewrite the ledger can ratify itself.
import { closeSync, existsSync, lstatSync, readSync, readdirSync, statSync } from 'node:fs';
import { ownAppendFile, ownAssertReal, ownChmod, ownOpenRead, ownRename, ownUnlink, readOwn, readOwnText } from '../../tenancy/own-files.js';
import { isAbsolute, join } from 'node:path';
import {
  DIGEST_OK, TMP_MAX_AGE_MS, TMP_PREFIX, RatifyScanError, diffFiles, digestOfFiles, errMsg, hashEntries, hashEntriesCached, isObj,
  mkdirPrivate, placeSnapshot, rmTree, stageFiles, walkTree, writeFileAtomic, type FileChange, type TreeEntry,
} from '../plugin-ratify.js';
import type { IdentityAuthor, IdentityJournalEntry, IdentityState } from './types.js';
import { gateInside, realDeep } from '../plugin-paths.js';
import { IdentitySourceError, hasIdentityFolder, identityFolder, isIdentityName, readFolder, realIdentityDir, type IdentityFile } from './source.js';

export type { IdentityState, IdentityAuthor };
export type RatifiedBy = 'person' | 'setup';

export interface FileSets { added: string[]; removed: string[]; modified: string[] }
export type JournalEntry = IdentityJournalEntry;
export interface Ratified { digest: string; files: Record<string, string>; ratified_at: string; by: RatifiedBy }
/** `author` is who made the latest observed change; `authors` is everyone who changed the files since the ratified digest, in the order they first did
 *  (empty once the files are the ratified ones). A person's edit while a companion's change waits adds to the list; it does not replace the companion. */
interface Observed { digest: string; files: Record<string, string>; at: string; author: IdentityAuthor; authors: IdentityAuthor[] }
export interface IdentityLedger {
  version: 1;
  ratified?: Ratified;
  /** The ratified digest before this one: its snapshot stays for a run still using it. */
  previous?: string;
  /** The last state the journal records: a live digest that differs from this one is a change nobody declared. */
  observed?: Observed;
  /** The digest a thread line was last posted for, and when. Cleared when the files are the ratified ones again (a ratify, a rollback, a check that finds them ok). */
  announced?: string;
  announced_at?: string;
}

/** What the caller knows about where a check is made, for the journal line a change on disk gets. */
export interface CheckContext {
  /** The harness that noticed: 'claude', 'codex', 'dsh', or absent for the app's own check (a status request, boot). */
  harness?: string;
  /** 'preparing': the harness was preparing a turn. 'running' / 'idle': the app's own check, with or without a turn running. */
  turn?: 'preparing' | 'running' | 'idle' | 'unknown';
}
export interface LedgerOpts {
  /** The ledger folder (absolute). */
  ledgerDir: string;
  /** Trust the per-file stat prefilter; false where ctime is not a change time (win32, the default there) and in tests that stand in for it. */
  trustStat?: boolean;
  context?: CheckContext;
  now?: Date;
}
export interface IdentityCheck {
  state: IdentityState;
  /** The digest of the identity folder as it is on disk now; '' when it could not be computed. */
  digest: string;
  /** The ratified digest, when there is one. */
  ratified_digest?: string;
  ratified_at?: string;
  ratified_by?: RatifiedBy;
  /** Live against ratified, when they differ. */
  changes?: FileChange[];
  /** Who made the change that is waiting (pending), and when it was last observed. `author` is the most recent; `authors` is all of them since the ratified digest. */
  author?: IdentityAuthor;
  authors?: IdentityAuthor[];
  since?: string;
  /** The folder holding the ratified copy: what to serve whenever it exists, even when the live folder cannot be read. */
  snapshot?: string;
  detail?: string;
  /** Names left out of the set (links and the like). */
  skipped?: string[];
  /** The live files with their hashes. */
  files?: Record<string, string>;
  /** True when ledger.json could not be read (malformed, wrong shape): the person's ratify sets it aside and starts a new record. */
  damaged?: boolean;
  /** True when no write may go ahead (the live folder cannot be read, the ledger is damaged, or its folder is inside identity/). */
  blocked?: boolean;
  /** Set when THIS call wrote a journal line for a change nobody declared (author 'filesystem'). */
  detected?: JournalEntry;
}

/** The caller asked for a digest and the folder is at another one (or the ratified file set moved). `digest` is what is live now. */
export class IdentityDigestMismatch extends Error {
  constructor(readonly digest: string) { super('the identity files changed since the digest was computed'); }
}
/** A write that is refused. `code` is stable (the routes answer with it); the message says what to do. */
export class IdentityRefused extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

/** What a home with no identity/ folder is told. One sentence: where identity lives, and how to move it. */
export const LEGACY_DETAIL = 'This home has no identity/ folder, so the companion\'s identity is read from CLAUDE.md; to move to ratified identity files, create identity/ in the home (profile.md and companion.md) and restart.';
export const MAX_FILE_BYTES = 1024 * 1024;
const MAX_DETAIL = 300;
const JOURNAL_TAIL_BYTES = 2 * 1024 * 1024;
export const JOURNAL_LIMIT = 200;

// ── Paths ────────────────────────────────────────────────────────────────────
export const ledgerFile = (ledgerDir: string): string => join(ledgerDir, 'ledger.json');
export const journalFile = (ledgerDir: string): string => join(ledgerDir, 'journal.jsonl');
export const snapshotsRoot = (ledgerDir: string): string => join(ledgerDir, 'snapshots');
/** <ledger folder>/snapshots/<digest>. Throws on anything that is not a sha256, so a path never escapes. */
export function snapshotOf(ledgerDir: string, digest: string): string {
  if (!DIGEST_OK.test(digest)) throw new IdentityRefused('bad_digest', 'not a sha256 digest');
  return join(snapshotsRoot(ledgerDir), digest);
}

// ── Reading and writing the ledger ───────────────────────────────────────────
const warned = new Set<string>();
const warnOnce = (key: string, text: string) => { if (!warned.has(key)) { warned.add(key); console.warn(text); } };
export function resetLedgerWarnings(): void { warned.clear(); }

const validFiles = (v: unknown): v is Record<string, string> => isObj(v) && Object.values(v).every((x) => typeof x === 'string');
const AUTHORS: readonly string[] = ['person', 'companion', 'filesystem', 'baseline', 'revert'];

/** The ledger, or an empty one when the file is missing. `damaged` says why it could not be used (malformed JSON, wrong shape). Never throws. */
export function readIdentityLedger(dir: string): { ledger: IdentityLedger; damaged?: string } {
  const file = ledgerFile(dir);
  let text: string;
  try { text = readOwnText(file); } catch (e: any) {
    if (e?.code === 'ENOENT') return { ledger: { version: 1 } };
    return { ledger: { version: 1 }, damaged: `${file} could not be read (${errMsg(e)})` };
  }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e) { return { ledger: { version: 1 }, damaged: `${file} is not valid JSON (${errMsg(e)}); ratify in the app to set it aside and start a new one` }; }
  if (!isObj(raw) || raw.version !== 1) return { ledger: { version: 1 }, damaged: `${file} is not a version 1 identity ledger; ratify in the app to set it aside and start a new one` };
  const out: IdentityLedger = { version: 1 };
  const r = raw.ratified;
  if (r !== undefined) {
    if (!isObj(r) || typeof r.digest !== 'string' || !DIGEST_OK.test(r.digest) || !validFiles(r.files) || typeof r.ratified_at !== 'string' || (r.by !== 'person' && r.by !== 'setup')) {
      return { ledger: { version: 1 }, damaged: `${file} has an invalid "ratified" entry; ratify in the app to set it aside and start a new one` };
    }
    out.ratified = { digest: r.digest, files: r.files, ratified_at: r.ratified_at, by: r.by };
  }
  if (typeof raw.previous === 'string' && DIGEST_OK.test(raw.previous)) out.previous = raw.previous;
  const o = raw.observed;
  if (isObj(o) && typeof o.digest === 'string' && validFiles(o.files) && typeof o.at === 'string' && typeof o.author === 'string' && AUTHORS.includes(o.author)) {
    const listed = Array.isArray(o.authors) ? o.authors.filter((a): a is IdentityAuthor => typeof a === 'string' && AUTHORS.includes(a)) : [];
    out.observed = { digest: o.digest, files: o.files, at: o.at, author: o.author as IdentityAuthor, authors: Array.isArray(o.authors) ? listed : [o.author as IdentityAuthor] };
  }
  if (typeof raw.announced === 'string') out.announced = raw.announced;
  if (typeof raw.announced_at === 'string') out.announced_at = raw.announced_at;
  return { ledger: out };
}

function writeIdentityLedger(dir: string, ledger: IdentityLedger): void {
  writeFileAtomic(ledgerFile(dir), JSON.stringify(ledger, null, 2) + '\n');
}

/** True when the file is empty, missing or ends with a newline (a torn last line does not). */
function endsCleanly(file: string): boolean {
  let fd: number | undefined;
  try {
    const opened = ownOpenRead(file, { kind: 'file' }); // (a tenant: one guarded open; a pipe at the journal is refused, never waited on)
    fd = opened.fd;
    const size = opened.stat.size;
    if (size === 0) return true;
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    return last[0] === 0x0a;
  } catch { return true; } finally { if (fd !== undefined) { try { closeSync(fd); } catch { /* nothing to close */ } } }
}

/** Append one line to the journal. Never rewrites the file. A last line that was torn (no newline) is ended first, so the new entry is its own line. */
function appendJournal(dir: string, entry: JournalEntry): void {
  mkdirPrivate(dir);
  const file = journalFile(dir);
  const line = (endsCleanly(file) ? '' : '\n') + JSON.stringify({ ...entry, detail: entry.detail.slice(0, MAX_DETAIL) }) + '\n';
  ownAppendFile(file, line, { mode: 0o600 });
  try { ownChmod(file, 0o600); } catch { /* the OS does not honour modes */ }
}

/** The journal, newest first, at most `limit` lines (read from the last 2 MiB of the file). Lines that do not parse are skipped. */
export function readJournal(dir: string, limit = JOURNAL_LIMIT): JournalEntry[] {
  let text: string;
  try {
    const file = journalFile(dir);
    const size = statSync(file).size;
    if (size > JOURNAL_TAIL_BYTES) {
      const buf = readOwn(file);
      text = buf.subarray(buf.length - JOURNAL_TAIL_BYTES).toString('utf-8');
      text = text.slice(text.indexOf('\n') + 1); // the first line is cut: drop it
    } else text = readOwnText(file);
  } catch { return []; }
  const out: JournalEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (isObj(e) && typeof e.at === 'string' && typeof e.author === 'string' && isObj(e.files)) out.push(e as unknown as JournalEntry);
    } catch { /* a torn or hand-edited line */ }
  }
  return out.reverse().slice(0, Math.max(1, Math.min(limit, 1000)));
}

// ── The live folder ──────────────────────────────────────────────────────────
interface Live { dir: string; entries: TreeEntry[]; digest: string; files: Record<string, string>; skipped: string[] }

function scanLive(home: string, trust: boolean): Live {
  let dir: string;
  const skipped: string[] = [];
  let top: string;
  let entries: TreeEntry[];
  try {
    dir = realIdentityDir(home);
    ({ top, entries } = walkTree(dir, { flat: true, keep: isIdentityName, label: 'identity folder', skipped }));
  } catch (e) {
    if (e instanceof RatifyScanError) throw new IdentitySourceError(e.message);
    throw e;
  }
  const hashed = hashEntriesCached(top, entries, Date.now(), trust);
  return { dir, entries, digest: hashed.digest, files: hashed.files, skipped };
}

/** The digest of the identity-set files directly in `dir` (a ratified copy). */
function folderDigest(dir: string): string {
  return folderHash(dir).digest;
}
function folderHash(dir: string): { digest: string; files: Record<string, string> } {
  const { entries } = walkTree(dir, { flat: true, keep: isIdentityName, label: 'identity folder' });
  return hashEntries(entries);
}

function sets(before: Record<string, string>, after: Record<string, string>): FileSets {
  const out: FileSets = { added: [], removed: [], modified: [] };
  for (const c of diffFiles(before, after)) out[c.kind].push(c.path);
  return out;
}

const isDir = (p: string): boolean => { try { return statSync(p).isDirectory(); } catch { return false; } };

function ledgerRefusal(home: string, identityDir: string, ledgerDir: string): string | null {
  // A relative folder would be resolved against whatever the working directory is (a ledger.json and journal.jsonl in the project root).
  if (!isAbsolute(ledgerDir)) return `the identity ledger folder (${JSON.stringify(ledgerDir)}) is not an absolute path; set identity.ledger_dir to one`;
  let l: string;
  try { l = realDeep(ledgerDir); } catch { l = ledgerDir; }
  if (gateInside(l, identityDir) || gateInside(l, identityFolder(home)) || gateInside(ledgerDir, identityFolder(home))) {
    return `the identity ledger folder (${ledgerDir}) is inside the identity folder, where whatever can edit identity can edit the ledger; move identity.ledger_dir out of it (the default is data/identity in the project)`;
  }
  return null;
}

function filesystemDetail(ctx: CheckContext | undefined): string {
  const base = 'Changed on disk by something other than the app\'s identity editor or the companion\'s identity write verb.';
  const who = ctx?.harness ? (/^(?:claude|codex|dsh)$/.test(ctx.harness) ? `the ${ctx.harness} harness` : ctx.harness) : '';
  if (who && ctx?.turn === 'preparing') return `${base} First noticed by ${who} while it was preparing a turn.`;
  if (who) return `${base} First noticed by ${who}.`;
  if (ctx?.turn === 'running') return `${base} First noticed by the app while a turn was running.`;
  if (ctx?.turn === 'idle') return `${base} First noticed by the app while no turn was running.`;
  return `${base} First noticed by the app.`;
}

/** Everyone who changed the files since the ratified digest, in the order they first did, with `author` added. Empty when `digest` is the ratified one. */
function mergeAuthors(ledger: IdentityLedger, digest: string, author: IdentityAuthor): IdentityAuthor[] {
  if (ledger.ratified?.digest === digest) return [];
  // An observation of the ratified state itself (setup's baseline, a ratify) carries no author of a change.
  const before = ledger.observed && ledger.observed.digest !== ledger.ratified?.digest ? ledger.observed.authors : [];
  return before.includes(author) ? before : [...before, author];
}

/** The ratified answer when the live folder cannot be read: the snapshot is still what to serve. */
function unavailable(opts: LedgerOpts, detail: string, digest = '', skipped?: string[], damaged = false): IdentityCheck {
  const out: IdentityCheck = { state: 'unavailable', digest, detail, blocked: true, ...(damaged && { damaged: true }), ...(skipped?.length && { skipped }) };
  try {
    const { ledger } = readIdentityLedger(opts.ledgerDir);
    if (ledger.ratified) {
      out.ratified_digest = ledger.ratified.digest;
      out.ratified_at = ledger.ratified.ratified_at;
      out.ratified_by = ledger.ratified.by;
      const v = verifyCopy(opts.ledgerDir, ledger.ratified.digest, trustOf(opts));
      if (v.kind === 'ok') out.snapshot = v.dir;
      else if (v.kind === 'altered') out.detail = `${detail}; ${alteredDetail(ledger.ratified.digest)}, so it is not served`;
    }
  } catch { /* nothing more to say */ }
  warnOnce(`unavailable|${out.detail}`, `[identity] ${out.detail}${out.snapshot ? ' (the ratified copy is served)' : ''}`);
  return out;
}

/** Compare the identity folder with the ledger. The one check: every harness, the routes and `res identity status` use it.
 *  First sight of a folder with no ledger writes the baseline journal line and answers `unratified` (the live files are served
 *  until the person ratifies). A live digest that differs from the last journaled one is a change nobody declared: one
 *  `filesystem` line is journaled (once per digest) and the answer is `pending`, with the ratified snapshot to serve.
 *  Never throws. */
export function checkIdentity(home: string, opts: LedgerOpts): IdentityCheck {
  // No identity/ folder at all: a legacy install whose identity is CLAUDE.md, on purpose. Nothing to ratify, so nothing is read or written (no ledger, no journal).
  // A folder that was ratified and is now gone is not that: it stays unavailable (below), with the ratified copy named.
  if (!hasIdentityFolder(home) && !readIdentityLedger(opts.ledgerDir).ledger.ratified) return { state: 'legacy', digest: '', detail: LEGACY_DETAIL, blocked: true };
  const trust = opts.trustStat ?? process.platform !== 'win32';
  let live: Live;
  try { live = scanLive(home, trust); } catch (e) { return unavailable(opts, errMsg(e)); }
  const refusal = ledgerRefusal(home, live.dir, opts.ledgerDir);
  if (refusal) return { state: 'unavailable', digest: live.digest, detail: refusal, blocked: true, files: live.files, ...(live.skipped.length && { skipped: live.skipped }) };
  const read = readIdentityLedger(opts.ledgerDir);
  if (read.damaged) return unavailable(opts, read.damaged, live.digest, live.skipped, true);
  const ledger = read.ledger;
  const at = (opts.now ?? new Date()).toISOString();
  let detected: JournalEntry | undefined;
  let persistError: string | undefined;
  try {
    if (!ledger.observed && !ledger.ratified) {
      const entry: JournalEntry = {
        at, digest_before: '', digest_after: live.digest, files: sets({}, live.files), author: 'baseline',
        detail: 'First sight of the identity folder: this is what was on disk then, and nothing has been ratified yet.',
      };
      appendJournal(opts.ledgerDir, entry);
      ledger.observed = { digest: live.digest, files: live.files, at, author: 'baseline', authors: ['baseline'] };
      writeIdentityLedger(opts.ledgerDir, ledger);
    } else {
      const lastDigest = ledger.observed?.digest ?? ledger.ratified?.digest;
      if (lastDigest !== live.digest) {
        const lastFiles = ledger.observed?.files ?? ledger.ratified?.files ?? {};
        const entry: JournalEntry = {
          at, digest_before: lastDigest ?? '', digest_after: live.digest, files: sets(lastFiles, live.files), author: 'filesystem',
          detail: filesystemDetail(opts.context),
        };
        appendJournal(opts.ledgerDir, entry);
        ledger.observed = { digest: live.digest, files: live.files, at, author: 'filesystem', authors: mergeAuthors(ledger, live.digest, 'filesystem') };
        writeIdentityLedger(opts.ledgerDir, ledger);
        detected = entry;
      }
      // Back at the ratified version: the same bytes coming again are a new move into pending, so the digest mark goes. The time of the last line stays,
      // so a writer that alternates between the ratified bytes and a change cannot post a line per cycle (notify.ts keeps one per LINE_INTERVAL_MS).
      // Only the person's ratify or revert clears both.
      if (ledger.ratified?.digest === live.digest && ledger.announced !== undefined) {
        delete ledger.announced;
        writeIdentityLedger(opts.ledgerDir, ledger);
      }
    }
  } catch (e) {
    persistError = errMsg(e);
    warnOnce(`persist|${opts.ledgerDir}`, `[identity] could not write the ledger in ${opts.ledgerDir}: ${persistError}`);
  }
  return describe(opts, live, ledger, detected, persistError);
}

/** A kept copy checked against the digest it is named for, through the stat prefilter (the same cache the live folder uses, keyed by the copy's folder; `trust`
 *  false rehashes every file). `missing`: no folder. `altered`: its files no longer hash to the digest (or cannot be read). Only `ok` may be served. */
type CopyCheck = { kind: 'ok'; dir: string; files: Record<string, string> } | { kind: 'missing' } | { kind: 'altered'; dir: string };
function verifyCopy(ledgerDir: string, digest: string, trust: boolean): CopyCheck {
  let dir: string;
  try { dir = snapshotOf(ledgerDir, digest); } catch { return { kind: 'missing' }; }
  if (!isDir(dir)) return { kind: 'missing' };
  try {
    const startedAt = Date.now();
    const { top, entries } = walkTree(dir, { flat: true, keep: isIdentityName, label: 'identity folder' });
    const h = hashEntriesCached(top, entries, startedAt, trust);
    return h.digest === digest ? { kind: 'ok', dir, files: h.files } : { kind: 'altered', dir };
  } catch { return { kind: 'altered', dir }; }
}
const trustOf = (opts: LedgerOpts): boolean => opts.trustStat ?? process.platform !== 'win32';
const alteredDetail = (digest: string): string => `the ratified copy in the ledger folder (snapshots/${digest.slice(0, 12)}) has been altered and does not match its digest`;

/** A kept copy whose files still hash to the digest it is named for, with those hashes; null when it is missing or has been altered. */
function usableCopy(ledgerDir: string, digest: string, trust: boolean): { dir: string; files: Record<string, string> } | null {
  const v = verifyCopy(ledgerDir, digest, trust);
  return v.kind === 'ok' ? { dir: v.dir, files: v.files } : null;
}

function describe(opts: LedgerOpts, live: Live, ledger: IdentityLedger, detected: JournalEntry | undefined, persistError?: string): IdentityCheck {
  const base: IdentityCheck = {
    state: 'unratified', digest: live.digest, files: live.files, ...(live.skipped.length && { skipped: live.skipped }),
    ...(detected && { detected }), ...(persistError && { detail: `the ledger could not be written: ${persistError}` }),
  };
  const r = ledger.ratified;
  if (!r) return base;
  base.ratified_digest = r.digest;
  base.ratified_at = r.ratified_at;
  base.ratified_by = r.by;
  const copy = verifyCopy(opts.ledgerDir, r.digest, trustOf(opts));
  const haveSnap = copy.kind === 'ok';
  if (copy.kind === 'ok') base.snapshot = copy.dir;
  // Who changed the files, when the last observation is of these bytes: said in every answer below, the missing-copy ones included.
  const attribute = (): void => {
    if (ledger.observed && ledger.observed.digest === live.digest && r.digest !== live.digest) { base.author = ledger.observed.author; base.authors = ledger.observed.authors; base.since = ledger.observed.at; }
  };
  if (!haveSnap) {
    attribute();
    const why = copy.kind === 'altered' ? alteredDetail(r.digest) : 'the ratified copy is missing from the ledger folder';
    // The ratified copy is gone or altered. The version before it, when its folder still hashes to its digest, is the next best thing to serve: pending, with a note.
    const prev = ledger.previous ? usableCopy(opts.ledgerDir, ledger.previous, trustOf(opts)) : null;
    if (prev) {
      base.state = 'pending';
      base.snapshot = prev.dir;
      base.changes = diffFiles(prev.files, live.files);
      base.detail = `${why}, so runs use the version ratified before it; ratify the identity again in the app`;
      warnOnce(`missing|${r.digest}|${copy.kind}`, `[identity] ${base.detail}`);
      return base;
    }
    base.state = 'unavailable';
    base.detail = `${why}; ratify the identity again in the app`;
    if (r.digest !== live.digest) base.changes = diffFiles(r.files, live.files);
    warnOnce(`missing|${r.digest}|${copy.kind}|none`, `[identity] ${base.detail}`);
    return base;
  }
  if (r.digest === live.digest) { base.state = 'ok'; return base; }
  base.state = 'pending';
  base.changes = diffFiles(r.files, live.files);
  attribute();
  return base;
}

// ── Declared changes ─────────────────────────────────────────────────────────
function previousOf(ledger: IdentityLedger, digest: string, ledgerDir: string): string | undefined {
  // The copy that was in force before this one. When the ratified copy itself is missing (the older one was being served),
  // the older one is what "previous" must name, or no older copy survives the prune.
  const candidates = [ledger.ratified?.digest, ledger.previous].filter((d): d is string => !!d && d !== digest);
  return candidates.find((d) => existsSync(snapshotOf(ledgerDir, d))) ?? candidates[0];
}

/** Ratify what is on disk now: copy it to a snapshot (the bytes read once are the bytes hashed and copied), record it, prune. When the files are already the
 *  ratified ones (and their copy is there) nothing is written and the answer carries `unchanged: true`.
 *  `expected` is the digest the person was shown: a different one aborts with IdentityDigestMismatch and nothing written.
 *  `journal: false` is for setup, whose baseline line says it already. */
export function ratifyIdentity(home: string, opts: LedgerOpts, r: { by: RatifiedBy; expected?: string; journal?: boolean }): IdentityCheck & { unchanged?: boolean } {
  let before = checkIdentity(home, opts);
  let setAside = false;
  if (before.damaged) {
    // The person is looking at the files and ratifying them: that is the way out of a ledger that cannot be read. The old file is kept beside it.
    // Nothing is set aside for a ratification that is going to be refused: the digest the person was shown, and the files now, are checked first.
    if (r.expected !== undefined && r.expected !== before.digest) throw new IdentityDigestMismatch(before.digest);
    const now = scanLive(home, false);
    if (now.digest !== before.digest) throw new IdentityDigestMismatch(now.digest);
    const aside = `${ledgerFile(opts.ledgerDir)}.damaged-${(opts.now ?? new Date()).toISOString().replace(/[^0-9A-Za-z]/g, '-')}`;
    try { ownRename(ledgerFile(opts.ledgerDir), aside); } catch (e) { throw new IdentityRefused('unavailable', `the damaged ledger could not be set aside: ${errMsg(e)}`); }
    warnOnce(`aside|${aside}`, `[identity] the unreadable ledger was set aside as ${aside}; a new record starts with this ratification`);
    setAside = true;
    before = checkIdentity(home, opts);
  }
  if (before.blocked) throw new IdentityRefused('unavailable', before.detail ?? 'the identity folder cannot be used');
  // Already ratified, with its copy in place: nothing to approve, so no new line and no new copy (a second click or a race must not pile up ratify lines).
  // The copy is read again, with no stat prefilter: "unchanged" is a promise that the ratified bytes are there.
  if (before.state === 'ok' && before.ratified_digest === before.digest && (r.expected === undefined || r.expected === before.digest) && usableCopy(opts.ledgerDir, before.digest, false)) return { ...before, unchanged: true };
  const live = scanLive(home, false);
  const staged = stageFiles(snapshotsRoot(opts.ledgerDir), 'identity', live.entries);
  const digest = digestOfFiles(staged.files);
  if (digest !== before.digest || (r.expected !== undefined && digest !== r.expected)) { rmTree(staged.tmp); throw new IdentityDigestMismatch(digest); }
  const created = placeSnapshot(staged.tmp, snapshotOf(opts.ledgerDir, digest), digest, folderDigest);
  const { ledger } = readIdentityLedger(opts.ledgerDir);
  const at = (opts.now ?? new Date()).toISOString();
  const previous = previousOf(ledger, digest, opts.ledgerDir);
  const next: IdentityLedger = {
    ...ledger,
    ratified: { digest, files: staged.files, ratified_at: at, by: r.by },
    observed: ledger.observed?.digest === digest ? { ...ledger.observed, authors: [] } : { digest, files: staged.files, at, author: ledger.observed?.author ?? 'baseline', authors: [] },
  };
  if (previous) next.previous = previous; else delete next.previous;
  delete next.announced; delete next.announced_at;
  try {
    if (r.journal !== false) {
      appendJournal(opts.ledgerDir, {
        at, digest_before: digest, digest_after: digest, files: { added: [], removed: [], modified: [] },
        author: r.by === 'setup' ? 'baseline' : 'person', kind: 'ratify', detail: r.by === 'setup' ? 'Ratified at setup.' : 'Ratified by the person in the app.',
      });
    }
    writeIdentityLedger(opts.ledgerDir, next);
  } catch (e) {
    if (created) rmTree(snapshotOf(opts.ledgerDir, digest));
    throw e;
  }
  // After a set-aside the old copies are known only through the file set aside, which may name none of them (a ledger overwritten
  // with garbage): nothing is pruned on that path, so the copies linger for the person rather than vanish.
  if (!setAside) { try { pruneIdentitySnapshots(opts.ledgerDir, { keepPrevious: true }); } catch { /* old copies linger until the next prune */ } }
  return checkIdentity(home, opts);
}

/** Delete snapshots the ledger does not point at: everything but the ratified digest (and, with `keepPrevious`, the one before it, and any
 *  the set-aside `ledger.json.damaged-*` files name), and temp folders left by an interrupted ratification. Does nothing when the ledger is missing or damaged, so a damaged ledger never costs the copies. */
export function pruneIdentitySnapshots(ledgerDir: string, opts: { keepPrevious?: boolean } = {}): void {
  const read = readIdentityLedger(ledgerDir);
  const root = snapshotsRoot(ledgerDir);
  if (read.damaged || !read.ledger.ratified || !existsSync(root)) return;
  ownAssertReal(root); // (a link at snapshots/ is refused, never emptied)
  const keep = new Set<string>([read.ledger.ratified.digest]);
  if (opts.keepPrevious && read.ledger.previous) keep.add(read.ledger.previous);
  // A ledger set aside as damaged still names its copies ("kept beside it"): any digest written in one is kept too.
  try {
    for (const n of readdirSync(ledgerDir)) {
      if (!n.startsWith('ledger.json.damaged-')) continue;
      for (const m of readOwnText(join(ledgerDir, n)).slice(0, 4 * 1024 * 1024).matchAll(/[0-9a-f]{64}/g)) keep.add(m[0]);
    }
  } catch { /* an unreadable set-aside file protects nothing */ }
  for (const name of readdirSync(root)) {
    const p = join(root, name);
    if (name.startsWith(TMP_PREFIX)) {
      let old = false;
      try { old = Date.now() - statSync(p).mtimeMs > TMP_MAX_AGE_MS; } catch { /* gone */ }
      if (old) rmTree(p);
      continue;
    }
    if (!keep.has(name)) rmTree(p);
  }
}

/** Write the ratified copy back over the live files (and remove files added since), journaled as `revert`. Only when something is pending. */
export function revertIdentity(home: string, opts: LedgerOpts, r: { expected?: string } = {}): IdentityCheck {
  const before = checkIdentity(home, opts);
  if (before.state !== 'pending' || !before.snapshot || !before.ratified_digest) {
    const why = before.state === 'unratified' ? 'nothing has been ratified yet' : before.state === 'ok' ? 'the identity files are the ratified ones' : `the identity check says ${before.state}${before.detail ? `: ${before.detail}` : ''}`;
    throw new IdentityRefused('nothing_to_revert', `there is no waiting change to roll back: ${why}`);
  }
  if (r.expected !== undefined && r.expected !== before.digest) throw new IdentityDigestMismatch(before.digest);
  const { ledger } = readIdentityLedger(opts.ledgerDir);
  const ratified = ledger.ratified!;
  let copy: IdentityFile[];
  try {
    if (folderDigest(before.snapshot) !== ratified.digest) throw new Error('digest differs');
    copy = readFolder(before.snapshot).files;
  } catch { throw new IdentityRefused('snapshot_damaged', 'the ratified copy in the ledger folder does not match its digest; fix it by hand'); }
  const live = scanLive(home, false);
  if (live.digest !== before.digest) throw new IdentityDigestMismatch(live.digest);
  // Extras go FIRST. On a case-insensitive filesystem (Windows, macOS) a live "Companion.md" and the ratified "companion.md" are one file: writing the
  // ratified copy and then deleting the extra would delete the file just restored.
  for (const e of live.entries) {
    if (!Object.hasOwn(ratified.files, e.path)) {
      try { if (lstatSync(e.abs).isFile()) ownUnlink(e.abs); } catch { /* already gone */ }
    }
  }
  for (const f of copy) writeFileAtomic(join(live.dir, f.name), f.text, { dotTemp: true });
  const after = scanLive(home, false);
  if (after.digest !== ratified.digest) throw new IdentityRefused('revert_incomplete', 'the identity files could not be put back exactly (a file is locked or not writable); check the folder by hand');
  const at = (opts.now ?? new Date()).toISOString();
  appendJournal(opts.ledgerDir, {
    at, digest_before: live.digest, digest_after: after.digest, files: sets(live.files, after.files), author: 'revert',
    detail: 'Rolled back to the ratified version by the person.',
  });
  const reverted: IdentityLedger = { ...ledger, observed: { digest: after.digest, files: after.files, at, author: 'revert', authors: [] } };
  delete reverted.announced; delete reverted.announced_at;
  writeIdentityLedger(opts.ledgerDir, reverted);
  return checkIdentity(home, opts);
}

const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/i;
/** A file name the identity folder may hold: directly in it (no separators, no `..`), not a dot file, not an avatar image, nothing Windows cannot keep. */
export function validIdentityFileName(name: unknown): name is string {
  return typeof name === 'string' && name.length > 0 && name.length <= 120 && name !== '.' && name !== '..' && isIdentityName(name)
    && !/[<>:"|?*\x00-\x1f]/.test(name) && !/[. ]$/.test(name) && !WINDOWS_RESERVED.test(name);
}

/** Write one identity file atomically and journal it as `person` or `companion`. The person's edit also ratifies, but only when the folder was
 *  `ok` before it: with something waiting, or nothing ratified yet, ratifying here would approve files the person did not look at.
 *  `expected` is the live digest the writer was shown; a different one aborts with IdentityDigestMismatch. Returns the check after the write. */
export function writeIdentityFile(home: string, opts: LedgerOpts, w: { name: string; text: string; author: 'person' | 'companion'; expected?: string }): IdentityCheck & { ratified_now: boolean; changed: boolean } {
  if (!validIdentityFileName(w.name)) throw new IdentityRefused('bad_name', 'path must be the name of a file directly in identity/ (no folders, no dot files, no images)');
  if (typeof w.text !== 'string' || w.text.includes('\0')) throw new IdentityRefused('bad_text', 'text must be a string without NUL bytes');
  if (Buffer.byteLength(w.text, 'utf-8') > MAX_FILE_BYTES) throw new IdentityRefused('too_big', `an identity file may be at most ${MAX_FILE_BYTES / 1024} KiB`);
  const before = checkIdentity(home, opts);
  if (before.blocked) throw new IdentityRefused('unavailable', before.detail ?? 'the identity folder cannot be used');
  if (w.expected !== undefined && w.expected !== before.digest) throw new IdentityDigestMismatch(before.digest);
  const live = scanLive(home, false);
  if (live.digest !== before.digest) throw new IdentityDigestMismatch(live.digest);
  // Case-folded: a second spelling of a name that is there would be two files on Linux and one on Windows and macOS.
  let existing: string[] = [];
  try { existing = readdirSync(live.dir); } catch (e) { throw new IdentityRefused('unavailable', errMsg(e)); }
  const lower = w.name.toLowerCase();
  for (const n of existing) {
    if (n !== w.name && n.toLowerCase() === lower) throw new IdentityRefused('case_conflict', `the folder already has "${n}"; use that spelling`);
  }
  const target = join(live.dir, w.name);
  try {
    const st = lstatSync(target);
    if (!st.isFile()) throw new IdentityRefused('not_regular', `identity/${w.name} is a link or not a regular file; the editor writes regular files only`);
  } catch (e) { if (e instanceof IdentityRefused) throw e; /* a new file */ }
  writeFileAtomic(target, w.text, { dotTemp: true });
  const after = scanLive(home, false);
  const at = (opts.now ?? new Date()).toISOString();
  const changed = after.digest !== live.digest;
  if (changed) {
    appendJournal(opts.ledgerDir, {
      at, digest_before: live.digest, digest_after: after.digest, files: sets(live.files, after.files), author: w.author,
      detail: w.author === 'person' ? `Edited ${w.name} in the app.` : `Edited ${w.name} through the identity write verb.`,
    });
    const { ledger } = readIdentityLedger(opts.ledgerDir);
    writeIdentityLedger(opts.ledgerDir, { ...ledger, observed: { digest: after.digest, files: after.files, at, author: w.author, authors: mergeAuthors(ledger, after.digest, w.author) } });
  }
  let ratifiedNow = false;
  if (w.author === 'person' && before.state === 'ok' && changed) {
    ratifyIdentity(home, opts, { by: 'person' }); // the approval gets its own line, so History shows it
    ratifiedNow = true;
  }
  return { ...checkIdentity(home, opts), ratified_now: ratifiedNow, changed };
}

/** Record that a thread line went out for `digest` at `at`. Returns false when it already had for that digest. */
export function markAnnounced(ledgerDir: string, digest: string, at: Date = new Date()): boolean {
  const { ledger, damaged } = readIdentityLedger(ledgerDir);
  if (damaged || ledger.announced === digest) return false;
  try { writeIdentityLedger(ledgerDir, { ...ledger, announced: digest, announced_at: at.toISOString() }); } catch { return false; }
  return true;
}

/** The text of the files of a ratified copy (a digest with a snapshot) or of the live folder ('live'), by name. */
export function filesOf(home: string, opts: LedgerOpts, which: string): Map<string, string> | null {
  try {
    if (which === 'live') return new Map(readFolder(realIdentityDir(home)).files.map((f) => [f.name, f.text]));
    if (!DIGEST_OK.test(which)) return null;
    const snap = snapshotOf(opts.ledgerDir, which);
    if (!isDir(snap)) return null;
    return new Map(readFolder(snap).files.map((f) => [f.name, f.text]));
  } catch { return null; }
}

