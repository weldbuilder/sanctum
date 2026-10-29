// Plugin code ratification (docs/PLUGINS.md "Ratifying"). The person ratifies a plugin's exact
// code by hash; code that differs from the ratified digest contributes nothing until they ratify
// it again. This closes the gap the roots check cannot: an unconfined writer (Claude with Bash)
// editing an enabled plugin's files.
//
// This file depends on node builtins and plugin-paths.ts (also builtins only), so the loader, the routes
// and tests share it without pulling in config. (scripts/setup-lib.mjs carries a small plain-JS copy of the hashing for the
// wizard, which runs before anything is built; a test keeps the two byte-identical.)
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gateCanon, realDeep } from './plugin-paths.js';
import { ownAssertReal, ownChmod, ownMkdir, ownRename, ownRm, ownWriteFile, ownWriteFileAtomic, readOwn, readOwnText } from '../tenancy/own-files.js';

export const MAX_FILES = 2000;
export const MAX_BYTES = 25 * 1024 * 1024;
const DEPS_HINT = 'keep dependencies outside the plugin folder (the folder is hashed whole, and a plugin that ships node_modules is too big to review)';

export type RatificationState = 'ok' | 'unratified' | 'changed' | 'unavailable';
export interface FileChange { path: string; kind: 'added' | 'removed' | 'modified' }
export interface Ratification {
  state: RatificationState;
  /** The digest of the code on disk now; '' when it could not be computed. */
  digest: string;
  changes?: FileChange[];
  /** Why the digest could not be computed (state 'unavailable'). */
  detail?: string;
  /** state 'ok' only: the folder holding the ratified copy, the code that actually runs. */
  snapshot?: string;
}
export interface LedgerEntry {
  digest: string; files: Record<string, string>; ratified_at: string; root: string;
  /** The digest ratified just before this one, whose copy is kept until the next start (a request that began under it may still be reading from it). */
  previous?: string;
}
export interface Ledger { version: 1; plugins: Record<string, LedgerEntry> }
export interface DigestResult { digest: string; files: Record<string, string> }
/** A regular file of the plugin folder. `st` is the lstat taken during the walk (the stat prefilter compares it). */
export interface TreeEntry { path: string; abs: string; size: number; st: { size: number; mtimeMs: number; ctimeMs: number; ino: number } }

/** A folder that cannot be hashed (link, cap, unreadable). The message names the fix. */
export class RatifyScanError extends Error {}

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
export const sha256 = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
export const byPath = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0); // code-unit order, the same on every platform and locale

/** Every regular file under `dir`, sorted by posix relpath. Never
 *  follows a link: one anywhere in the tree is an error. Relpaths are built with '/' here, so
 *  they are posix on Windows too. */
export function scanTree(dir: string): TreeEntry[] {
  return walkTree(dir).entries;
}

/** How walkTree reads a folder that is not a plugin. */
export interface WalkOpts {
  /** Only the files directly in the folder: sub-folders are ignored, not entered. */
  flat?: boolean;
  /** Which names count (flat walks). A name this refuses is left out as if it were not there. */
  keep?: (name: string) => boolean;
  /** What the folder is called in a message ("the plugin folder"). */
  label?: string;
  /** Flat walks only: a link or another thing that is not a regular file is left out and its name pushed here, instead of failing the walk. */
  skipped?: string[];
}

/** scanTree, with the real path of the folder it walked (the stat cache is keyed by it). */
export function walkTree(dir: string, opts: WalkOpts = {}): { top: string; entries: TreeEntry[] } {
  const what = opts.label ?? 'plugin folder';
  const holds = opts.label ? `${what}s hold regular files only` : 'plugin folders hold regular files only';
  let top: string;
  try { top = realpathSync(dir); } catch (e) { throw new RatifyScanError(`cannot read the ${what}: ${errMsg(e)}`); }
  const out: TreeEntry[] = [];
  let bytes = 0;
  const stack: Array<{ abs: string; rel: string }> = [{ abs: top, rel: '' }];
  while (stack.length) {
    const { abs, rel } = stack.pop()!;
    let items;
    try { items = readdirSync(abs, { withFileTypes: true }); } catch (e) { throw new RatifyScanError(`cannot read ${rel || `the ${what}`}: ${errMsg(e)}`); }
    for (const it of items) {
      if (opts.flat && opts.keep && !opts.keep(it.name)) continue;
      const r = rel ? `${rel}/${it.name}` : it.name;
      const a = join(abs, it.name);
      if (it.isSymbolicLink()) {
        if (opts.flat) { opts.skipped?.push(r); continue; }
        throw new RatifyScanError(`plugin folders may not contain links (${r}); replace it with a real file or move it out of the plugin folder`);
      }
      if (it.isDirectory()) { if (!opts.flat) stack.push({ abs: a, rel: r }); continue; }
      if (!it.isFile()) {
        if (opts.flat) { opts.skipped?.push(r); continue; }
        throw new RatifyScanError(`${r} is not a regular file; ${holds}`);
      }
      let st;
      try { st = lstatSync(a); } catch (e) { throw new RatifyScanError(`cannot read ${r}: ${errMsg(e)}`); }
      if (!st.isFile()) { // swapped for a link since the listing
        if (opts.flat) { opts.skipped?.push(r); continue; }
        throw new RatifyScanError(`${r} is not a regular file; ${holds}`);
      }
      bytes += st.size;
      if (out.length + 1 > MAX_FILES) throw new RatifyScanError(`${what} has more than ${MAX_FILES} files${opts.label ? '' : `; ${DEPS_HINT}`}`);
      if (bytes > MAX_BYTES) throw new RatifyScanError(`${what} is larger than ${MAX_BYTES / 1024 / 1024} MiB${opts.label ? '' : `; ${DEPS_HINT}`}`);
      out.push({ path: r, abs: a, size: st.size, st: { size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, ino: st.ino } });
    }
  }
  return { top, entries: out.sort((x, y) => byPath(x.path, y.path)) };
}

// ── Code outside the folder ──────────────────────────────────────────────────
// The digest covers the plugin folder and nothing else. Code that reaches a file outside it runs bytes
// the hash never saw, so a plugin whose files do that is refused. This is a text scan, not a parser, and
// it is deliberately blunt: every file (binary ones, with a NUL in the first 8 KiB, aside) is read as plain text (comments and
// strings included, any of the three quote styles, or none) and cut into path-like tokens, and a token
// is refused when, after JS string escapes and percent escapes are undone,
//  - it holds a `..` segment that climbs out of the folder, judged from the file's own folder
//    (so `../sibling.mjs` two folders down is fine and `../../../x` is not), or
//  - it is an absolute path or file: URL that points inside a folder the companion can write, or
//  - it is a data: URL (any), which is refused outright.
// A template literal with a `${` in a specifier position (`import(\`./${x}\`)`) is refused as a dynamic
// specifier, and a folder with TypeScript or JSX files is refused whole (plugins ship JavaScript:
// Node can strip types and run such a file, and this scan does not read it).
// Still out of reach, and documented in docs/PLUGINS.md: a path assembled at run time (`import(name)`,
// `'.' + './x'`, String.fromCharCode, path pieces `join(here, '..', '..')` judged one at a time), a bare
// package name (Node resolves it by walking up from the ratified copy: a node_modules inside the plugin, which the hash covers, or the ledger folder's parents, which it does not), an
// absolute path outside every writable root, and a template specifier called through an alias.
/** A `data:` URL (`data:text/javascript,...`, `data:;base64,...`, `data:,...`) is code spelled in the specifier,
 *  and its payload (base64 or percent-encoded) can hide a file: import the scan cannot read. */
const DATA_URL = /(?<![\w$.-])data:(?:[a-z0-9.+-]+\/[a-z0-9.+-]+|;|,)/i;
const BUILD_STEP_FILE = /\.(?:ts|mts|cts|tsx|jsx)$/i;
/** Runs of characters that can be part of a path or a URL: not white space, a quote, a bracket, a brace,
 *  a comma, a semicolon or an operator. `?` `#` `:` `=` `%` `\` `.` `/` `$` `@` `~` stay in. */
const PATH_TOKEN = /[^\s'"`()[\]{},;<>|&*^!+]+/g;
const LINE_CONTINUATION = new RegExp('\\\\(?:\\r\\n|[\\n\\r\\u2028\\u2029])', 'g');
const OTHER_SCHEME =/^(?:https?|wss?|ftp|node|data|npm|blob|mailto):/i;
const SCAN_TAIL = '(this scan reads comments and strings as text too: reword or remove a comment that merely mentions such a path)';
/** Person mode: why it is refused. Companion mode: nothing is gated, so it says what the import does, as a warning. */
const scanHint = (ctx: { hint?: 'person' | 'companion' }): string => (ctx.hint === 'companion'
  ? `this import reaches outside the plugin folder, so the audit record (which covers only the folder) will not show what it loads; keep the code a plugin runs inside it ${SCAN_TAIL}`
  : `the hash covers only the folder, so keep the code a plugin runs inside it ${SCAN_TAIL}`);
/** Template literals with a substitution where a module specifier goes. */
const DYNAMIC_TEMPLATES: RegExp[] = [
  /\b(?:import|require)\s*\(\s*`[^`]*\$\{/g,        // import(`./${x}`), require(`./${x}`)
  /\bimport\.meta\.resolve\s*\(\s*`[^`]*\$\{/g,      // import.meta.resolve(`./${x}`)
  /\bnew\s+Worker\s*\(\s*`[^`]*\$\{/g,              // new Worker(`./${x}.mjs`)
  /\)\s*\(\s*`[^`]*\$\{/g,                          // createRequire(import.meta.url)(`./${x}`)
];

export interface ScanOpts {
  /** Folders the companion can write, as paths. An absolute path or file: URL that points into one is refused. */
  writableRoots?: string[];
  /** Whose wording the findings use: 'person' (default, refusals about the hash) or 'companion' (warnings). */
  hint?: 'person' | 'companion';
}
interface ScanCtx { roots: string[]; real: Map<string, string>; hint?: 'person' | 'companion' }
function scanContext(opts?: ScanOpts): ScanCtx {
  const roots = new Set<string>();
  for (const r of opts?.writableRoots ?? []) { if (r) { roots.add(gateCanon(r)); roots.add(gateCanon(realDeep(r))); } }
  return { roots: [...roots], real: new Map(), hint: opts?.hint };
}
const inRoots = (ctx: ScanCtx, canon: string) => ctx.roots.some((r) => canon === r || canon.startsWith(r.endsWith('/') ? r : `${r}/`));

/** What a JS string literal's escapes make of `s`, then what a URL parser does to it (it drops tab and
 *  line breaks): `'\x2e\x2e/x'`, `'../x'`, `'\.\./x'` and `'.\t./x'` all spell `../x`. */
function jsUnescape(s: string): string {
  const code = (n: number) => { try { return String.fromCodePoint(n); } catch { return ''; } };
  const out = s.replace(/\\(?:u\{([0-9a-fA-F]{1,6})\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|([0-7]{1,3})|([tnrbfv])|([\s\S]))/g,
    (_m, ub, u4, x2, oct, ctl, any) => {
      if (ub !== undefined) return code(parseInt(ub, 16));
      if (u4 !== undefined) return code(parseInt(u4, 16));
      if (x2 !== undefined) return code(parseInt(x2, 16));
      if (oct !== undefined) return code(parseInt(oct, 8));
      if (ctl !== undefined) return { t: '\t', n: '\n', r: '\r', b: '\b', f: '\f', v: '\v' }[ctl as 't'];
      return any as string;
    });
  return out.replace(/[\t\n\r]/g, '');
}

/** `s` with percent escapes undone. Only `%` followed by two hex digits is an escape: a printf-style `/%s` or a
 *  lone `%` is literal text, as a URL parser reads it. `ok` is false when the escapes do not form valid UTF-8
 *  (`%E0%A4`); the escapes that spell ASCII are undone anyway, so a half-valid string cannot hide a `..`. */
function percentDecode(s: string): { text: string; ok: boolean } {
  try { return { text: decodeURIComponent(s.replace(/%(?![0-9a-fA-F]{2})/g, '%25')), ok: true }; } catch {
    return { text: s.replace(/%([0-7][0-9a-fA-F])/g, (_m, h) => String.fromCharCode(parseInt(h, 16))), ok: false };
  }
}

/** Whether `s` (read as a path relative to the folder of the file at posix relpath `fileRel`) climbs above the plugin folder. */
function climbs(fileRel: string, s: string): boolean {
  let depth = fileRel.split('/').length - 1;
  for (const seg of s.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (--depth < 0) return true; } else depth++;
  }
  return false;
}

/** The absolute paths `variant` (an already unescaped token) could name: itself when absolute, or the path a file: URL holds. */
function absoluteCandidates(variant: string): string[] {
  const v = variant.replace(/\\/g, '/');
  if (/^file:/i.test(v)) {
    const out: string[] = [];
    try { out.push(fileURLToPath(v)); } catch { /* a host the OS cannot map: use the path alone */ }
    try { out.push(decodeURIComponent(new URL(v).pathname)); } catch { /* not a URL */ }
    return out;
  }
  const d = percentDecode(v).text;
  return posix.isAbsolute(d) || /^[a-zA-Z]:\//.test(d) ? [d] : [];
}

function scanText(fileRel: string, rawText: string, ctx: ScanCtx): string[] {
  // NUL is legal inside a JS comment or string, so no file is skipped as binary; a NUL ends a token like a space does.
  const text = rawText.replace(/\0/g, ' ');
  const out: string[] = [];
  const mention = (tok: string) => out.push(`${fileRel} refers to "${tok}", which is outside the plugin folder; ${scanHint(ctx)}`);
  const seen = new Set<string>();
  if (DATA_URL.test(text) || DATA_URL.test(jsUnescape(text))) out.push(`${fileRel} holds a data: URL (a specifier that carries code inline): data: URLs cannot be ratified, because the hash cannot see what they load; put the code in a file inside the plugin folder`);
  for (const re of DYNAMIC_TEMPLATES) {
    re.lastIndex = 0;
    if (re.test(text)) { out.push(`${fileRel} builds a module specifier from a template literal with a \${...} substitution (a dynamic specifier): the hash cannot see where it points, so use a literal specifier inside the plugin folder`); break; }
  }
  // A backslash before a line break is a line continuation inside a string: it joins the two lines.
  // A braced \u{2e} would be cut at the brace: write it as . (a code point above U+FFFF cannot spell a dot or a slash).
  const flat = text
    .replace(LINE_CONTINUATION, '')
    .replace(/\\u\{([0-9a-fA-F]{1,6})\}/g, (_m, h: string) => (parseInt(h, 16) <= 0xffff ? `\\u${h.padStart(4, '0')}` : '\\uFFFD'));
  for (const m of flat.matchAll(PATH_TOKEN)) {
    const tok = m[0];
    if (seen.has(tok)) continue;
    // Only tokens that could be a climb or an absolute path are worth the work.
    if (!(tok.includes('..') || tok.includes('%') || tok.includes('\\') || tok.charCodeAt(0) === 47 || /^(?:file:|[a-zA-Z]:[\\/])/i.test(tok))) continue;
    if (OTHER_SCHEME.test(tok)) continue;
    seen.add(tok);
    const variants = new Set([tok, jsUnescape(tok)]);
    let refuse = false;
    for (const v of variants) {
      const dec = percentDecode(v);
      dec.text = dec.text.replace(/\\/g, '/'); // after the decode: %5c is a backslash too
      if (!dec.ok && (/^(?:\.|\/|file:)/i.test(v) || /%(?:2e|2f|5c)/i.test(v))) {
        out.push(`${fileRel} refers to "${tok}", which holds a percent escape that cannot be decoded in something that looks like a path; ${scanHint(ctx)}`);
        refuse = true;
        break;
      }
      if (climbs(fileRel, dec.text)) { refuse = true; break; }
      for (const c of absoluteCandidates(v)) {
        const abs = resolve(c);
        let real = ctx.real.get(abs);
        if (real === undefined) { real = realDeep(abs); ctx.real.set(abs, real); }
        if (inRoots(ctx, gateCanon(abs)) || inRoots(ctx, gateCanon(real))) { refuse = true; break; }
      }
      if (refuse) break;
    }
    if (refuse && !out.some((o) => o.includes(`"${tok}"`))) mention(tok);
  }
  return out;
}

/** One message per path in `text` (the file at posix relpath `fileRel`) that reaches outside the plugin
 *  folder, plus one for a dynamic template specifier. Every file is read as text, whatever its extension; NUL is a token separator. */
export function escapingImports(fileRel: string, text: string, opts?: ScanOpts): string[] {
  return scanText(fileRel, text, scanContext(opts));
}

/** One message per TypeScript or JSX file in `paths` (relpaths): plugins ship JavaScript. */
export function buildStepFiles(paths: string[]): string[] {
  return paths.filter((p) => BUILD_STEP_FILE.test(p)).map((p) => `${p} is TypeScript or JSX; plugins ship JavaScript (Node can strip the types and run it, and the import scan does not read it): compile it to a .js or .mjs file first`);
}

/** The refusals for every file in the plugin folder: TypeScript and JSX files, then escapingImports over each text file. A
 *  folder that cannot be listed gives no messages here: the ratification check reports that. */
export function scanImports(dir: string, opts?: ScanOpts): string[] {
  let entries: TreeEntry[];
  try { entries = scanTree(dir); } catch { return []; }
  const out = buildStepFiles(entries.map((e) => e.path));
  const ctx = scanContext(opts);
  for (const e of entries) {
    try { out.push(...scanText(e.path, readOwn(e.abs, { shipped: true }).toString('utf-8'), ctx)); } catch { /* unreadable: the ratification check says so */ }
  }
  return out;
}

export function digestOfFiles(files: Record<string, string>): string {
  return sha256(Object.keys(files).sort(byPath).map((k) => `${k}\0${files[k]}\n`).join(''));
}

export function hashEntries(entries: TreeEntry[]): DigestResult {
  const files: Record<string, string> = {};
  for (const e of entries) {
    try { files[e.path] = sha256(readOwn(e.abs, { shipped: true })); } catch (er) { throw new RatifyScanError(`cannot read ${e.path}: ${errMsg(er)}`); }
  }
  return { digest: digestOfFiles(files), files };
}

/** sha256 of every file's contents and one digest over them: `relpath\0sha\n` lines in order. */
export function pluginDigest(dir: string): DigestResult {
  return hashEntries(scanTree(dir));
}

/** What differs between a ratified file map and the current one, sorted by path. */
export function diffFiles(ratified: Record<string, string>, now: Record<string, string>): FileChange[] {
  const out: FileChange[] = [];
  for (const p of Object.keys(now)) {
    if (!Object.hasOwn(ratified, p)) out.push({ path: p, kind: 'added' });
    else if (ratified[p] !== now[p]) out.push({ path: p, kind: 'modified' });
  }
  for (const p of Object.keys(ratified)) if (!Object.hasOwn(now, p)) out.push({ path: p, kind: 'removed' });
  return out.sort((a, b) => byPath(a.path, b.path));
}

// ── Ledger ───────────────────────────────────────────────────────────────────
/** <ledger folder>/ratified.json. The folder defaults to <project>/data/plugins; plugins.ledger_dir
 *  moves it. It must be out of the companion's reach (plugins.ts refuses it otherwise). */
export function ledgerPath(projectRoot: string, ledgerDir?: string): string {
  return join(ledgerDir ?? join(projectRoot, 'data', 'plugins'), 'ratified.json');
}

const warnedLedger = new Set<string>();
export function resetRatifyWarnings(): void { warnedLedger.clear(); }
function warnLedger(file: string, why: string): void {
  const key = `${file}|${why}`;
  if (warnedLedger.has(key)) return;
  warnedLedger.add(key);
  console.warn(`[plugins] ${file} ${why}; nothing is ratified, so no plugin loads until you ratify it again in the app. Fix or delete the file.`);
}

export const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const validEntry = (e: unknown): e is LedgerEntry =>
  isObj(e) && typeof e.digest === 'string' && typeof e.ratified_at === 'string' && typeof e.root === 'string'
  && (e.previous === undefined || typeof e.previous === 'string')
  && isObj(e.files) && Object.values(e.files).every((v) => typeof v === 'string');

/** Read the ledger. Missing: empty, quietly. Malformed: a loud warning (once) and empty; never throws. */
export function readLedger(file: string): Ledger {
  const empty = (): Ledger => ({ version: 1, plugins: {} });
  let text: string;
  try { text = readOwnText(file); } catch (e: any) {
    if (e?.code !== 'ENOENT') warnLedger(file, `could not be read (${errMsg(e)})`);
    return empty();
  }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e) { warnLedger(file, `is not valid JSON (${errMsg(e)})`); return empty(); }
  if (!isObj(raw) || raw.version !== 1 || !isObj(raw.plugins)) { warnLedger(file, 'is not a version 1 ledger'); return empty(); }
  const out = empty();
  for (const [id, e] of Object.entries(raw.plugins)) {
    if (validEntry(e)) out.plugins[id] = e;
    else warnLedger(file, `has an invalid entry for "${id}" (ignored)`);
  }
  return out;
}

/** Write a file atomically: a temp file in the same folder, then a rename. 0600 where the OS honours it.
 *  `dotTemp` names the temp file with a leading dot (a folder read by name, like the identity folder, ignores dot files). */
export function writeFileAtomic(file: string, data: string | Buffer, opts: { dotTemp?: boolean } = {}): void {
  ownMkdir(dirname(file), { recursive: true });
  // A random temp name opened `wx`, owner-only, renamed over the file; in a tenant folder the target and the way to it are checked first (S2).
  ownWriteFileAtomic(file, data, { dotTemp: opts.dotTemp });
}

/** Write the ledger atomically (writeFileAtomic). */
export function writeLedger(file: string, ledger: Ledger): void {
  writeFileAtomic(file, JSON.stringify(ledger, null, 2) + '\n');
}

/** Record `result` as the ratified code of plugin `id` (folder `dir`). Ledger only; see ratifyDirectory. */
export function recordRatification(file: string, id: string, dir: string, result: DigestResult, now: Date = new Date()): void {
  const ledger = readLedger(file);
  const old = ledger.plugins[id];
  // The copy before this one stays for a request still using it; ratifying the same code again keeps what was already the previous.
  const previous = old && old.digest !== result.digest ? old.digest : old?.previous && old.previous !== result.digest ? old.previous : undefined;
  ledger.plugins[id] = { digest: result.digest, files: result.files, ratified_at: now.toISOString(), root: dir, ...(previous && { previous }) };
  writeLedger(file, ledger);
}

// ── Snapshots: the ratified copy is what runs ────────────────────────────────
// Ratifying copies the plugin folder to <ledger folder>/snapshots/<id>/<digest>/. Routes and dsh
// rows load from there, never from the live folder, so the bytes that run are the bytes that were
// hashed, and a re-ratified plugin has a new path (every module it imports is fresh, not a cached
// old instance). The snapshot folder is inside the ledger folder, which plugins.ts refuses to use
// when the companion can write it.
const ID_OK = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const DIGEST_OK = /^[0-9a-f]{64}$/;
export const TMP_PREFIX = '.tmp-';
export const TMP_MAX_AGE_MS = 3600_000;

/** The folder holding every plugin's snapshots, next to the ledger. */
export const snapshotRoot = (ledgerFile: string): string => join(dirname(ledgerFile), 'snapshots');

/** <ledger folder>/snapshots/<id>/<digest>. Throws on an id or digest that is not shaped like one, so a path never escapes. */
export function snapshotDir(ledgerFile: string, id: string, digest: string): string {
  if (!ID_OK.test(id)) throw new RatifyScanError(`"${id}" is not a plugin id`);
  if (!DIGEST_OK.test(digest)) throw new RatifyScanError('not a sha256 digest');
  return join(snapshotRoot(ledgerFile), id, digest);
}

/** The bytes in the folder are not the digest the person was shown. `result` is what is there now. */
export class DigestMismatch extends Error {
  constructor(readonly result: DigestResult) { super('the plugin files changed since the digest was computed'); }
}

export function mkdirPrivate(dir: string): void {
  ownMkdir(dir, { recursive: true, mode: 0o700 });
  try { ownChmod(dir, 0o700); } catch { /* the OS does not honour modes */ }
}

export const rmTree = (p: string) => { try { ownRm(p, { recursive: true, force: true }); } catch { /* best effort */ } };

/** Read the ledger, or null when it is missing or not a version 1 ledger (no warning: callers that
 *  must not act on a broken ledger use this). */
function readLedgerStrict(file: string): Ledger | null {
  try {
    const raw = JSON.parse(readOwnText(file));
    if (!isObj(raw) || raw.version !== 1 || !isObj(raw.plugins)) return null;
  } catch { return null; }
  return readLedger(file);
}

/** Copy `entries` into a new private temp folder under `root` (made if need be), reading each file ONCE: the bytes
 *  that are hashed are the bytes that are copied. `each` sees every file's bytes (the plugin import scan). Returns the
 *  temp folder and each file's sha256. The folder is removed when anything throws; the caller removes it otherwise. */
export function stageFiles(root: string, label: string, entries: TreeEntry[], each?: (e: TreeEntry, bytes: Buffer) => void): { tmp: string; files: Record<string, string> } {
  mkdirPrivate(root);
  const tmp = join(root, `${TMP_PREFIX}${label}-${process.pid}-${Date.now()}`);
  mkdirPrivate(tmp);
  try {
    const files: Record<string, string> = {};
    for (const e of entries) {
      let bytes: Buffer;
      try { bytes = readOwn(e.abs, { shipped: true }); } catch (er) { throw new RatifyScanError(`cannot read ${e.path}: ${errMsg(er)}`); }
      files[e.path] = sha256(bytes);
      each?.(e, bytes);
      const out = join(tmp, ...e.path.split('/'));
      mkdirPrivate(dirname(out));
      ownWriteFile(out, bytes, { mode: 0o600 });
      try { ownChmod(out, 0o600); } catch { /* the OS does not honour modes */ }
    }
    return { tmp, files };
  } catch (e) { rmTree(tmp); throw e; }
}

/** Rename the staged folder `tmp` to `final`. When `final` already holds the same files (`digestOf(final)` is `digest`)
 *  the staged copy is dropped instead; a damaged one is replaced. Returns whether `final` was made new. The staged folder is gone either way. */
export function placeSnapshot(tmp: string, final: string, digest: string, digestOf: (dir: string) => string): boolean {
  try {
    mkdirPrivate(dirname(final));
    if (existsSync(final)) {
      let same = false;
      try { same = digestOf(final) === digest; } catch { /* damaged: replace it */ }
      if (same) { rmTree(tmp); return false; }
      rmTree(final);
    }
    ownRename(tmp, final);
    return true;
  } catch (e) { rmTree(tmp); throw e; }
}

/** Ratify the plugin folder `dir` as `id`: read each file once, hash and copy those very bytes to a
 *  temp folder, and when `expected` is given abort (nothing written) unless the digest of what was
 *  read is `expected`. Then the temp folder is renamed into place as the snapshot, the ledger entry
 *  is written, and every other snapshot of this plugin is deleted. */
export function ratifyDirectory(ledgerFile: string, id: string, dir: string, expected?: string, scan?: ScanOpts): DigestResult {
  const entries = scanTree(dir);
  const problems = buildStepFiles(entries.map((e) => e.path)); // every refusal is collected (build-step files first), and the message names the first three
  const ctx = scanContext(scan);
  const root = snapshotRoot(ledgerFile);
  const staged = stageFiles(root, id, entries, (e, bytes) => { problems.push(...scanText(e.path, bytes.toString('utf-8'), ctx)); }); // the bytes being copied, not a second read
  const tmp = staged.tmp;
  const result: DigestResult = { digest: digestOfFiles(staged.files), files: staged.files };
  try {
    if (problems.length) throw new RatifyScanError(problems.slice(0, 3).join('; '));
    if (expected !== undefined && result.digest !== expected) throw new DigestMismatch(result);
  } catch (e) { rmTree(tmp); throw e; }
  const final = snapshotDir(ledgerFile, id, result.digest);
  const created = placeSnapshot(tmp, final, result.digest, (d) => pluginDigest(d).digest);
  try { recordRatification(ledgerFile, id, dir, result); } catch (e) {
    if (created) rmTree(final);
    throw e;
  }
  try { pruneSnapshots(ledgerFile, { keepPrevious: true }); } catch { /* old copies linger until the next prune */ }
  return result;
}

/** Delete snapshots the ledger no longer points at: other digests of a plugin, plugins that are not in
 *  the ledger, and temp folders left by an interrupted ratification (over an hour old). Does nothing
 *  at all when the ledger is missing or malformed, so a damaged ledger never costs the copies.
 *  `keepPrevious` (a ratification calls it so) also keeps the digest the ledger names as `previous`: a
 *  request or a lazy import that started under the old copy is still reading from it. At boot, with
 *  nothing in flight, the default drops it. */
export function pruneSnapshots(ledgerFile: string, opts: { keepPrevious?: boolean } = {}): void {
  const ledger = readLedgerStrict(ledgerFile);
  const root = snapshotRoot(ledgerFile);
  if (!ledger || !existsSync(root)) return;
  // A link at snapshots/ (or above it, inside a tenant folder) is refused, never read and emptied.
  ownAssertReal(root);
  for (const name of readdirSync(root)) {
    const p = join(root, name);
    if (name.startsWith(TMP_PREFIX)) {
      let old = false;
      try { old = Date.now() - statSync(p).mtimeMs > TMP_MAX_AGE_MS; } catch { /* gone */ }
      if (old) rmTree(p);
      continue;
    }
    const entry = Object.hasOwn(ledger.plugins, name) ? ledger.plugins[name] : undefined;
    if (!entry) { rmTree(p); continue; }
    let kids: string[] = [];
    try { kids = readdirSync(p); } catch { continue; }
    const keep = new Set([entry.digest]);
    if (opts.keepPrevious && typeof entry.previous === 'string' && DIGEST_OK.test(entry.previous)) keep.add(entry.previous);
    for (const k of kids) if (!keep.has(k)) rmTree(join(p, k));
  }
}

/** Ratify what is on disk now for a loaded plugin (the wizard's and tests' entry point; the route
 *  does the same after checking the person's digest). Returns the digest it recorded. */
export function ratifyPlugin(file: string, p: { id: string; dir: string; ratification?: Ratification }): DigestResult {
  const r = ratifyDirectory(file, p.id, p.dir);
  if (p.ratification) p.ratification = { state: 'ok', digest: r.digest, snapshot: snapshotDir(file, p.id, r.digest) };
  return r;
}

// ── Status ───────────────────────────────────────────────────────────────────
// ── The per-file stat prefilter ──────────────────────────────────────────────
// Hashing a plugin at the 2000-file / 25 MiB cap costs about 60 ms; a typical plugin about 0.1 ms. Rows,
// help, the list and every route request run the check, so the check remembers each file's sha256 with the
// stat it had, and rereads a file only when its stat changed. The file SET is walked every time (an added,
// removed or swapped file is never missed), and only the hashing is skipped.
//
// Why that is sound on POSIX: a stat that is identical in size, mtime, ctime and inode means the file was
// not written, truncated, renamed over or chmod'ed since. mtime can be set to anything with utimes, but
// ctime cannot: every write, rename, link, chmod and utimes sets ctime to the kernel's clock, and no
// system call sets it to another value (only root moving the clock, or editing the disk behind the file
// system, can). So the edit that restores size and mtime still changes ctime. Two guards cover what stat
// cannot see: a cache entry is not trusted while the file's newest timestamp is within RACY_MS of when it
// was hashed (a second write in the same timestamp tick would look unchanged: git's "racily clean" rule),
// and every entry expires after REVERIFY_MS, so a file written through a long-lived writable mapping
// (which can change bytes without a new ctime) is read again within a minute. On win32 ctime is the
// creation time, not a change time, so nothing is trusted there: every check rehashes.
const RACY_MS = 2000;
const REVERIFY_MS = 60_000;
interface CachedFile { size: number; mtimeMs: number; ctimeMs: number; ino: number; sha: string; hashedAt: number }
const fileCache = new Map<string, Map<string, CachedFile>>(); // real plugin folder -> file path -> what was hashed
/** How many files the last checks read (`hashed`) and skipped (`hits`); tests read it. */
export const ratifyCacheStats = { hits: 0, hashed: 0 };
export function resetRatifyCache(): void { fileCache.clear(); ratifyCacheStats.hits = 0; ratifyCacheStats.hashed = 0; }

/** hashEntries with the stat prefilter. `startedAt` is the time before the folder was walked. */
export function hashEntriesCached(top: string, entries: TreeEntry[], startedAt: number, trust: boolean): DigestResult {
  const before = fileCache.get(top);
  const after = new Map<string, CachedFile>();
  const files: Record<string, string> = {};
  for (const e of entries) {
    const c = before?.get(e.abs);
    if (trust && c && c.size === e.st.size && c.mtimeMs === e.st.mtimeMs && c.ctimeMs === e.st.ctimeMs && c.ino === e.st.ino
      && startedAt - c.hashedAt < REVERIFY_MS && c.hashedAt - Math.max(c.mtimeMs, c.ctimeMs) > RACY_MS) {
      files[e.path] = c.sha; after.set(e.abs, c); ratifyCacheStats.hits++;
      continue;
    }
    let sha: string;
    try { sha = sha256(readOwn(e.abs, { shipped: true })); } catch (er) { throw new RatifyScanError(`cannot read ${e.path}: ${errMsg(er)}`); }
    ratifyCacheStats.hashed++;
    files[e.path] = sha;
    after.set(e.abs, { ...e.st, sha, hashedAt: startedAt });
  }
  fileCache.set(top, after); // files that are gone drop out with the old map
  return { digest: digestOfFiles(files), files };
}

/** The digest of the plugin folder as it is on disk now, through the same stat prefilter the ratification
 *  check uses. Throws RatifyScanError when the folder cannot be hashed (a link in the tree, the caps, an
 *  unreadable file). trust: companion records this in the audit file; it gates nothing. */
export function currentDigest(dir: string, { trustStat = process.platform !== 'win32' }: { trustStat?: boolean } = {}): DigestResult {
  const startedAt = Date.now();
  const { top, entries } = walkTree(dir);
  return hashEntriesCached(top, entries, startedAt, trustStat);
}

/** Compare the code on disk with the ledger. This is the one check; rows, help, the list and every route
 *  request use it. The folder is walked in full every time and each file is hashed unless its stat
 *  says it has not changed (see the stat prefilter above). `trustStat` is false where ctime is not a change time (win32, the default there) and in tests that stand in for it. An 'ok' answer carries the ratified copy's
 *  folder, which is what to run. */
export function checkRatification(id: string, dir: string, ledgerFile: string, { trustStat = process.platform !== 'win32' }: { trustStat?: boolean } = {}): Ratification {
  let now: DigestResult;
  try {
    const startedAt = Date.now();
    const { top, entries } = walkTree(dir);
    now = hashEntriesCached(top, entries, startedAt, trustStat);
  } catch (e) {
    return { state: 'unavailable', digest: '', detail: errMsg(e) };
  }
  const entry = readLedger(ledgerFile).plugins[id];
  if (!entry) return { state: 'unratified', digest: now.digest };
  if (entry.digest !== now.digest) return { state: 'changed', digest: now.digest, changes: diffFiles(entry.files, now.files) };
  let snapshot: string;
  try {
    snapshot = snapshotDir(ledgerFile, id, entry.digest);
    if (!statSync(snapshot).isDirectory()) throw new Error('not a folder');
  } catch {
    return { state: 'unavailable', digest: now.digest, detail: 'the ratified copy is missing from the ledger folder; ratify it again in the app' };
  }
  return { state: 'ok', digest: now.digest, snapshot };
}

/** The `error` text a non-ok state puts on a plugin's list entry. */
export function ratificationError(id: string, r: Ratification): string | null {
  if (r.state === 'ok') return null;
  if (r.state === 'unratified') return `not ratified: review its files and ratify it in the app (POST /api/plugins/${id}/ratify with its digest); it contributes nothing until then`;
  if (r.state === 'unavailable') return `cannot be ratified: ${r.detail ?? 'its digest could not be computed'}`;
  const ch = r.changes ?? [];
  const named = ch.slice(0, 5).map((c) => c.path).join(', ');
  return `changed since ratification: ${ch.length} files (${named}${ch.length > 5 ? ', ...' : ''}); review and ratify it again (POST /api/plugins/${id}/ratify); it contributes nothing until then`;
}
