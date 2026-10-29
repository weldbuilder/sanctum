// own-files-lib.mjs: a tenant's own files are its own (docs/MULTI-TENANT.md, "A tenant's own files").
//
// ONE implementation, plain .mjs so the backend (packages/backend/src/tenancy/own-files.ts) and `npm run setup` (which runs under plain node) share it.
// Three things live here:
//
//  1. The write layer: ownWriteFile / ownAppendFile / ownMkdir / ownCopyFile / ownCp / ownRename / ownRm / ownUnlink / ownChmod. Each takes the tenant
//     folder first. With `tenantDir` empty (tenancy off) each is the plain fs call it stands for (same flags, same mode, same errors). With a tenant
//     folder each normalises the target with path.resolve first (dot segments never go further), decides "inside" from the real path of the deepest
//     existing ancestor, and FAILS CLOSED: a target that is not provably inside the folder, or cannot be decided, is refused. A target provably outside
//     is written only when the caller passes the explicit `{ process: true }` (a genuinely process-level write that happens to run in a tenant context).
//     Inside the folder each refuses a target that is a link, a regular file with other hard links (posix), or whose parent chain is a link, and a write
//     goes to a temp file with a random name opened `wx` in the same folder, mode set, then renamed over the target (create-only flags open the target
//     directly with O_EXCL | O_NOFOLLOW so EEXIST keeps its meaning). An append opens with O_NOFOLLOW and checks nlink on the open handle.
//  2. The boot scan, tenantFilesProblem(): every entry of tenant.yaml, .env, .mcp.json, all of data/ and private/, the top level of home/ and the wake
//     prompts folder must be a real file or folder (no link, no pipe/socket/device, no second hard link). Never refuses on count.
//  3. The read side: ownOpenRead / ownReadFile / ownReadDir / ownStat / ownReadProblem. In a tenant a read of a path outside its folder is refused (unless the caller names
//     the shipped roots); inside, a link, a second hard link, a path behind a link or a non-regular file is refused.
//  4. tenantsDirProblem(): tenants.dir is not the app folder and not an ancestor of it.
//
// What this cannot close (said in docs/MULTI-TENANT.md): the window between the check and the rename, in which a process that can already write inside
// the tenant folder swaps a parent folder for a link. The temp-and-rename and O_NOFOLLOW keep the write itself off a link that is already there;
// a swap inside those microseconds is not detected until the next write or the next scan.
import {
  appendFileSync, chmodSync, closeSync, constants, copyFileSync, cpSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync,
  renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

const posix = process.platform !== 'win32';
const TAIL = "a tenant's own files and folders must be real ones inside its folder.";

/** A refusal: the sentence names a path relative to the tenant folder, never an absolute one. `code` is what the wizard and the app answer 400 with. */
export class OwnFileRefused extends Error {
  constructor(message) { super(message); this.name = 'OwnFileRefused'; this.code = 'tenant_refused'; }
}

/** ONE realpath flavour for the whole layer: the native one (it resolves a case-only spelling and a short 8.3 name to the real spelling on Windows), with the
 *  Windows long-path prefix taken off (`\\?\C:\x` is `C:\x`, `\\?\UNC\h\s` is `\\h\s`) so that two realpaths of the same place always compare equal as strings.
 *  Nothing changes off Windows. */
export function stripLongPrefix(p) {
  if (posix || typeof p !== 'string') return p;
  if (p.startsWith('\\\\?\\UNC\\')) return `\\\\${p.slice(8)}`;
  return p.startsWith('\\\\?\\') ? p.slice(4) : p;
}
export const nativeReal = (p) => stripLongPrefix(realpathSync.native(p));
const real = (p) => { try { return nativeReal(p); } catch { return resolve(p); } };
/** The path of `p` below `root` (a string, '' for root itself), or null when it is not inside. */
function below(root, p) {
  const r = relative(root, p);
  if (r === '') return '';
  if (r === '..' || r.startsWith(`..${sep}`) || isAbsolute(r)) return null;
  return r;
}
const nice = (segs) => (Array.isArray(segs) ? segs : String(segs).split(sep)).join('/');
const linkSentence = (rel) => `${rel} in the tenant folder is a link; ${TAIL}`;
const hardSentence = (rel) => `${rel} in the tenant folder has more than one hard link; ${TAIL}`;
const outsideSentence = (rel) => `${rel} in the tenant folder resolves outside it; ${TAIL}`;
const unreadSentence = (rel, code) => `${rel} in the tenant folder cannot be read (${code || 'error'}); ${TAIL}`;
const typeSentence = (rel) => `${rel} in the tenant folder is not a regular file or folder (a pipe, socket or device); ${TAIL}`;
const notFileSentence = (rel) => `${rel} in the tenant folder is not a file; ${TAIL}`;
const outsideReadSentence = 'that path is outside the tenant folder; a tenant reads only its own folder (and the files that ship with the app).';
const isGone = (e) => e?.code === 'ENOENT' || e?.code === 'ENOTDIR';
const isOther = (st) => !st.isFile() && !st.isDirectory();

/** The real path of the deepest existing ancestor of `target` (walking up until realpath succeeds) and the not-yet-existing tail below it, as segments.
 *  `target` is walked as given: a `..` in it is resolved by the operating system, after any link before it, exactly as an open would (the write layer never
 *  hands it a path with dot segments: it normalises first). `dots` is true when the tail holds `.` or `..` (a path that cannot exist: no operation on it can
 *  succeed). null when it cannot be decided (a loop, no permission). */
function deepReal(target) {
  let p = isAbsolute(target) ? String(target) : `${process.cwd()}${sep}${target}`;
  const tail = [];
  for (;;) {
    try { return { real: nativeReal(p), tail, dots: tail.some((t) => t === '..' || t === '.') }; }
    catch (e) {
      if (!isGone(e)) return null;
      const up = dirname(p);
      if (up === p) return null;
      tail.unshift(basename(p));
      p = up;
    }
  }
}
const hasDots = (raw) => String(raw).split(/[\\/]+/).some((s) => s === '..' || s === '.');

/** The segments of `abs` (already normalised: no dot segments) below the first of its folders whose real path is `realRoot` (the spelled way in through the
 *  tenant folder, whatever the spelling: /proc/self/root<real>, a case-only spelling, a second link), or null when no folder of it is the tenant folder. */
function restBelow(abs, realRoot) {
  const { root, dir } = { root: parse(abs).root, dir: abs.slice(parse(abs).root.length) };
  const segs = dir.split(/[\\/]+/).filter(Boolean);
  let cur = root;
  for (let i = 0; i < segs.length; i++) {
    cur = cur.endsWith(sep) ? `${cur}${segs[i]}` : `${cur}${sep}${segs[i]}`;
    let r;
    try { r = nativeReal(cur); } catch { return null; }
    if (r === realRoot) return segs.slice(i + 1);
  }
  return null;
}

/** A path with `.` or `..` in it can mean two things: the text normalised (`a/b/../c` is `a/c`) and what the operating system does (`b` followed first, so
 *  `..` is b's parent). Where the two land on different real paths (a link is on the way) the path is ambiguous and nothing is decided for it. */
function viewsAgree(raw, abs) {
  if (!hasDots(raw)) return true;
  // Windows resolves `.` and `..` LEXICALLY, before it looks at any link (`lnk\..\x` is `x` next to `lnk`): the text and the operating system always agree there,
  // so the normalised path IS the path the OS reaches and the ordinary inside / outside decision applies (a normalised path whose parent is missing is a
  // plain ENOENT, or created by a recursive mkdir, inside the tenant). Only where the OS follows the link first (posix) can the two views differ.
  if (!posix) return true;
  const os = deepReal(raw);
  if (!os) return false;
  if (os.dots) return true; // cannot exist as written: only the normalised path is ever used
  const text = deepReal(abs);
  if (!text) return false;
  return join(os.real, ...os.tail) === join(text.real, ...text.tail);
}

/** What `place` answers when it cannot decide (a loop, no permission, a `..` that a link carries elsewhere): in a tenant a write refuses, a read refuses. */
const UNKNOWN = Symbol('undecided');

/** Where `target` sits in the tenant folder: { abs, root, rel: segments, realRoot }; null when it is provably outside it; UNKNOWN when that cannot be decided.
 *  The target is normalised with path.resolve FIRST (dot segments never go further), then "inside" is decided from the REAL path of the deepest existing
 *  ancestor of the target's parent (a path through a second link, /proc/self/root..., a case-only spelling on a case-insensitive platform): never from how the
 *  path is spelled. The last component is never resolved (it is checked as itself: a link there is refused). */
function place(tenantDir, target) {
  const raw = String(target);
  const abs = resolve(raw);
  const given = resolve(tenantDir);
  const realRoot = real(tenantDir);
  if (!viewsAgree(raw, abs)) return UNKNOWN;
  for (const root of given === realRoot ? [given] : [given, realRoot]) {
    const r = below(root, abs);
    if (r !== null) return { abs, root, rel: r === '' ? [] : r.split(sep), realRoot };
  }
  // The tenant folder itself, by another spelling.
  const whole = deepReal(abs);
  if (!whole) return UNKNOWN;
  if (whole.real === realRoot && whole.tail.length === 0) return { abs: realRoot, root: realRoot, rel: [], realRoot };
  const last = basename(abs);
  if (last === '' || dirname(abs) === abs) return null;
  const parent = deepReal(dirname(abs));
  if (!parent) return UNKNOWN;
  const realTarget = join(parent.real, ...parent.tail, last);
  const r = below(realRoot, realTarget);
  if (r === null) {
    // Really outside by that way in; but a spelled way in THROUGH the tenant folder that passes a link out of it is still the tenant's business.
    const through = restBelow(abs, realRoot);
    if (!through || through.length === 0) return null;
    return { abs: join(realRoot, ...through), root: realRoot, rel: through, realRoot };
  }
  const through = restBelow(abs, realRoot);
  if (through && through.length) return { abs: join(realRoot, ...through), root: realRoot, rel: through, realRoot };
  return { abs: realTarget, root: realRoot, rel: r === '' ? [] : r.split(sep), realRoot };
}

/** true when `p` (resolved against `dir` when relative) really is inside `dir` AND is spelled as inside it (either spelling of the folder): the rule for every
 *  path a tenant's configuration names. A path that reaches the folder by another spelling (/proc/self/root<real>/..., a second link) is refused, not accepted
 *  (on Windows, where case is not an alias, a case-only spelling is the same path and is accepted). Dot segments are normalised first, so `<dir>/home/.` is
 *  `<dir>/home`; a `..` that a link carries elsewhere is refused. */
export function isInsideTenantDir(dir, p) {
  const raw = isAbsolute(p) ? String(p) : `${dir}${sep}${p}`;
  const given = resolve(dir);
  const realRoot = real(dir);
  const abs = resolve(raw);
  const spelled = [given, realRoot].some((root) => below(root, abs) !== null);
  if (!spelled) return false;
  if (abs === given || abs === realRoot) return true;
  if (!viewsAgree(raw, abs)) return false;
  const whole = deepReal(abs); // (the last component too: a folder that is a link out is outside)
  if (!whole) return false;
  return below(realRoot, join(whole.real, ...whole.tail)) !== null;
}

/** The config keys that name a path a tenant owns (its own folders and files): each must resolve inside the tenant folder. ONE list: the backend's confine.ts, the
 *  tenant config loader and the wizard (scripts/setup-inherit.mjs) all read it from here. */
export const OWNED_PATH_SCALARS = Object.freeze([
  'agent.cwd', 'agent.claude_md_path', 'agent.mcp_json_path', 'agent.system_prompt_file',
  'identity.ledger_dir', 'identity.profile_path', 'identity.companion_md_path',
  'plugins.ledger_dir', 'plugins.dir',
  'discord.private_dir', 'discord.public.exclusions_file', 'discord.gate.words_file', 'discord.gate.names_file',
  'hooks.workspace_root', 'hooks.vault_path',
]);
/** Files that ship with the app: fine as the app's defaults, but a tenant naming its own must name one in its folder. */
export const SHIPPED_PATH_SCALARS = Object.freeze([
  'agent.dsh.base_instructions_file', 'agent.codex.base_instructions_file', 'agent.rolling.summarizer_instructions_file',
  'orchestrator.wake_prompts_path', 'orchestrator.wake_prompts_dir',
]);
/** The config keys holding a list of paths a tenant owns. */
export const OWNED_PATH_LISTS = Object.freeze(['hooks.extra_write_paths', 'hooks.safe_write_prefixes', 'agent.codex.additional_directories']);

/** The rule for a path a tenant's CONFIG names (the backend's confine.ts and the wizard use this one function): an empty value is "not set" (inside), `~` and `~/...`
 *  are the operator's home (outside), anything else is isInsideTenantDir: dot segments normalised first, links followed, a second spelling of the folder refused. */
export function namedPathInsideTenant(dir, p) {
  if (typeof p !== 'string' || p === '') return true;
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) return false;
  return isInsideTenantDir(dir, p);
}

const undecidedSentence = 'that path cannot be resolved to a place inside the tenant folder (a loop, a missing permission, or a ".." that a link carries elsewhere); a tenant writes only inside its own folder.';
const outsideWriteSentence = 'that path is outside the tenant folder; a tenant writes only inside its own folder.';

/** The problem with writing at `at` (a place() answer that is inside), or ''. */
function problemAt(at, op) {
  if (at.rel.length === 0) return op !== 'write' ? '' : 'the tenant folder itself cannot be written, replaced or removed from inside it';
  // Every folder between the tenant folder and the target's parent: a link anywhere on that chain would carry the write somewhere else.
  let cur = at.root;
  let deepest = at.root;
  for (let i = 0; i < at.rel.length - 1; i++) {
    cur = join(cur, at.rel[i]);
    let st;
    try { st = lstatSync(cur); } catch (e) { if (isGone(e)) break; return unreadSentence(nice(at.rel.slice(0, i + 1)), e?.code); }
    if (st.isSymbolicLink()) return linkSentence(nice(at.rel.slice(0, i + 1)));
    if (!st.isDirectory()) break; // a file in the way: the write fails by itself
    deepest = cur;
  }
  if (below(at.realRoot, real(deepest)) === null) return outsideSentence(nice(at.rel.slice(0, -1)) || nice(at.rel));
  const me = nice(at.rel);
  let st;
  try { st = lstatSync(at.abs); } catch (e) { return isGone(e) ? '' : unreadSentence(me, e?.code); }
  if (st.isSymbolicLink()) return linkSentence(me);
  if (isOther(st)) return typeSentence(me);
  if (posix && st.isFile() && st.nlink > 1) return hardSentence(me);
  return '';
}

/** Why `target` may not be written, replaced, removed or copied over now, as one sentence naming the path relative to the tenant folder; '' when it may;
 *  null when `target` is provably not inside `tenantDir` (this is the READ side's question: a write uses ownWritePlan, which refuses what is outside). `op`
 *  Any `op` other than 'write' ('mkdir', 'chmod', 'cp', 'assert-real', 'read') lets the tenant folder itself through. A path that cannot be placed answers with a refusal. Nothing is changed. */
export function ownTargetProblem(tenantDir, target, op = 'write') {
  if (!tenantDir) return null;
  const at = place(tenantDir, target);
  if (at === null) return null;
  if (at === UNKNOWN) return undecidedSentence;
  return problemAt(at, op);
}

/** The decision every write-class helper makes in a tenant (`tenantDir` set): { abs, problem, plain, at }. `abs` is the normalised path the operation goes to
 *  (dot segments gone). THE DEFAULT IS REFUSAL: a target that is not provably inside the tenant folder, or cannot be decided, has a `problem`. A target provably
 *  OUTSIDE is allowed (`plain: true`, no problem) only when `allowProcess` is true: the caller's explicit `{ process: true }` for a genuinely process-level
 *  write that happens to run inside a tenant context. `tenantDir` empty: { abs: target, problem: '', plain: true } (the plain fs call, path untouched). */
export function ownWritePlan(tenantDir, target, op = 'write', allowProcess = false) {
  if (!tenantDir) return { abs: target, problem: '', plain: true, at: null };
  const abs = resolve(String(target));
  const at = place(tenantDir, target);
  if (at === UNKNOWN) return { abs, problem: undecidedSentence, plain: false, at: null };
  if (at === null) return allowProcess ? { abs, problem: '', plain: true, at: null } : { abs, problem: outsideWriteSentence, plain: false, at: null };
  return { abs, problem: problemAt(at, op), plain: false, at };
}

const refuse = (problem) => { throw new OwnFileRefused(problem); };

let tempNameSeam = null;
/** Test seam: make the temp file's name predictable (a test plants a link at it). Pass null to restore. */
export function setTempNameForTest(fn) { tempNameSeam = fn; }
/** The temp name for a write to `abs`: same folder, random, never reused. */
export function tempNameFor(abs) {
  return tempNameSeam ? tempNameSeam(abs) : join(dirname(abs), `.${basename(abs)}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`);
}

const optsOf = (options) => (typeof options === 'string' ? { encoding: options } : options && typeof options === 'object' ? { ...options } : {});
/** `{ process: true }` in an options object is the caller's explicit allowance for a genuinely process-level write that runs inside a tenant context (a
 *  target provably outside the tenant folder is otherwise refused). It is never handed to fs. Returns the options without it (the same object when it was
 *  not there) and the flag. */
export function splitProcess(options) {
  if (options && typeof options === 'object' && 'process' in options) { const { process: allow, ...rest } = options; return { options: rest, allow: allow === true }; }
  return { options, allow: false };
}

/** The numeric open flags of an exclusive-create flag string ('wx', 'wx+', 'ax', 'ax+'): create only, EEXIST when anything is there (O_EXCL never follows a
 *  link), O_NOFOLLOW where the platform has it. */
function exclusiveFlags(flag) {
  return constants.O_CREAT | constants.O_EXCL | (flag.includes('+') ? constants.O_RDWR : constants.O_WRONLY) | (flag.startsWith('a') ? constants.O_APPEND : 0) | (constants.O_NOFOLLOW || 0);
}

/** writeFileSync. In a tenant folder: temp file (`wx`, random name, same folder), mode set, renamed over the target. Flags with `x` (`wx`, `wx+`, `ax`, `ax+`,
 *  create only) open the target directly with O_EXCL | O_NOFOLLOW after the checks, so EEXIST still means "something is there". An existing file's permissions
 *  carry over when no mode is given (posix). The target is normalised first (dot segments gone). In a tenant a target that is not provably inside the folder is
 *  refused unless `options.process` is true. */
export function ownWriteFile(tenantDir, path, data, options) {
  if (!tenantDir) return writeFileSync(path, data, options);
  const sp = splitProcess(options);
  const plan = ownWritePlan(tenantDir, path, 'write', sp.allow);
  if (plan.problem) refuse(plan.problem);
  const abs = plan.abs;
  const o = optsOf(sp.options);
  if (plan.plain) return writeFileSync(abs, data, o);
  if (typeof o.flag === 'string' && o.flag.includes('x')) { writeFileSync(abs, data, { ...o, flag: exclusiveFlags(o.flag) }); return undefined; }
  if (typeof o.flag === 'string' && o.flag.startsWith('a')) return ownAppendFile(tenantDir, abs, data, o); // (append: never replace)
  let mode = o.mode;
  if (mode === undefined && posix) { try { const st = statSync(abs); if (st.isFile()) mode = st.mode & 0o777; } catch { /* a new file */ } }
  const tmp = tempNameFor(abs);
  try {
    writeFileSync(tmp, data, { ...(o.encoding ? { encoding: o.encoding } : {}), flag: 'wx', ...(mode !== undefined ? { mode } : {}) });
  } catch (e) {
    // Nothing of ours is there when the name was taken (a planted entry stays as it is, and is never written through).
    if (e?.code !== 'EEXIST') { try { rmSync(tmp, { force: true }); } catch { /* gone */ } }
    throw e;
  }
  try {
    if (mode !== undefined && posix) chmodSync(tmp, mode);
    renameSync(tmp, abs);
  } catch (e) { try { rmSync(tmp, { force: true }); } catch { /* gone */ } throw e; }
  return undefined;
}

/** appendFileSync. In a tenant folder: opened O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW (where the platform has it; elsewhere the lstat above is
 *  the check), the open handle's link count read before the write. */
export function ownAppendFile(tenantDir, path, data, options) {
  if (!tenantDir) return appendFileSync(path, data, options);
  const sp = splitProcess(options);
  const plan = ownWritePlan(tenantDir, path, 'write', sp.allow);
  if (plan.problem) refuse(plan.problem);
  if (plan.plain) return appendFileSync(plan.abs, data, sp.options);
  const o = optsOf(sp.options);
  const abs = plan.abs;
  const me = nice(plan.at.rel);
  const checked = identityOf(abs); // (null for a file about to be created)
  let fd;
  try { fd = openSync(abs, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0), o.mode ?? 0o666); }
  catch (e) { if (e?.code === 'ELOOP' || e?.code === 'EMLINK') refuse(linkSentence(me)); throw e; }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) refuse(typeSentence(me));
    if (posix && st.nlink > 1) refuse(hardSentence(me));
    if (checked && !sameFile(checked, fstatSync(fd, { bigint: true }))) refuse(changedSentence(me)); // (where there is no O_NOFOLLOW this is the only guard against a late link)
    if (typeof data === 'string') writeSync(fd, data, null, o.encoding || 'utf8'); else writeSync(fd, data);
  } finally { closeSync(fd); }
  return undefined;
}

/** mkdirSync. In a tenant folder: refused when the target or a folder on the way to it is a link, or when it is not provably inside the folder (unless
 *  `options.process`). */
export function ownMkdir(tenantDir, path, options) {
  if (!tenantDir) return mkdirSync(path, options);
  const sp = splitProcess(options);
  const plan = ownWritePlan(tenantDir, path, 'mkdir', sp.allow);
  if (plan.problem) refuse(plan.problem);
  const made = mkdirSync(plan.abs, sp.options);
  return typeof made === 'string' ? stripLongPrefix(made) : made; // (a recursive mkdir answers the first folder it made, namespaced on Windows)
}

/** chmodSync. In a tenant folder: refused on a link (chmod would follow it). `opts.process` allows a target provably outside the folder. */
export function ownChmod(tenantDir, path, mode, opts = {}) {
  if (!tenantDir) return chmodSync(path, mode);
  const plan = ownWritePlan(tenantDir, path, 'chmod', opts?.process === true);
  if (plan.problem) refuse(plan.problem);
  return chmodSync(plan.abs, mode);
}

/** copyFileSync(src, dest, flags). In a tenant folder: `dest` is checked as a write target and `src` (when it is inside the folder too) as a link-free
 *  source; without COPYFILE_EXCL the copy goes to a temp file and is renamed over `dest`. `opts.process` allows a `dest` provably outside the folder. */
export function ownCopyFile(tenantDir, src, dest, flags = 0, opts = {}) {
  if (!tenantDir) return copyFileSync(src, dest, flags);
  const plan = ownWritePlan(tenantDir, dest, 'write', opts?.process === true);
  const sourceProblem = ownTargetProblem(tenantDir, src);
  if (sourceProblem) refuse(sourceProblem);
  if (plan.problem) refuse(plan.problem);
  const from = resolve(String(src));
  if (plan.plain) return copyFileSync(from, plan.abs, flags);
  const abs = plan.abs;
  if (flags & constants.COPYFILE_EXCL) { copyFileSync(from, abs, flags); return undefined; }
  const tmp = tempNameFor(abs);
  try { copyFileSync(from, tmp, constants.COPYFILE_EXCL); } catch (e) { if (e?.code !== 'EEXIST') { try { rmSync(tmp, { force: true }); } catch { /* gone */ } } throw e; }
  try { renameSync(tmp, abs); } catch (e) { try { rmSync(tmp, { force: true }); } catch { /* gone */ } throw e; }
  return undefined;
}

/** cpSync(src, dest, options). In a tenant folder: `dest` is checked as a write target, and a link in the copied tree is left out (never recreated inside).
 *  `options.process` allows a `dest` provably outside the folder (never handed to fs). */
export function ownCp(tenantDir, src, dest, options = {}) {
  if (!tenantDir) return cpSync(src, dest, options);
  const sp = splitProcess(options);
  const plan = ownWritePlan(tenantDir, dest, 'cp', sp.allow);
  const sourceProblem = ownTargetProblem(tenantDir, src);
  if (sourceProblem) refuse(sourceProblem);
  if (plan.problem) refuse(plan.problem);
  const from = resolve(String(src));
  if (plan.plain) return cpSync(from, plan.abs, sp.options);
  // A pipe, socket or device in the tree would end in Node's own internal assertion half way through the copy: refuse it first, before anything is written.
  const odd = firstNonRegular(from);
  if (odd !== null) refuse(`${odd || 'the source'} in the copied tree is not a regular file or folder (a pipe, socket or device); ${TAIL}`);
  const userFilter = sp.options.filter;
  const filter = (a, b) => {
    try {
      const st = lstatSync(a);
      if (st.isSymbolicLink()) return false;
      if (isOther(st)) refuse(`${nice(relative(from, a)) || 'the source'} in the copied tree is not a regular file or folder (a pipe, socket or device); ${TAIL}`);
    } catch (e) { if (e instanceof OwnFileRefused) throw e; /* gone: cp reports it */ }
    return userFilter ? userFilter(a, b) : true;
  };
  return cpSync(from, plan.abs, { ...sp.options, dereference: false, filter });
}

/** The path (relative to `root`, '' for root itself) of the first entry of the tree at `root` that is a pipe, socket or device (links are not followed), or null. */
function firstNonRegular(root) {
  const walk = (abs, rel) => {
    let st;
    try { st = lstatSync(abs); } catch { return null; }
    if (st.isSymbolicLink()) return null;
    if (isOther(st)) return rel;
    if (!st.isDirectory()) return null;
    let names = [];
    try { names = readdirSync(abs).sort(); } catch { return null; }
    for (const n of names) { const r = walk(join(abs, n), rel ? `${rel}/${n}` : n); if (r !== null) return r; }
    return null;
  };
  return walk(root, '');
}

/** Write a file by temp file and rename, in every mode: a random temp name opened `wx` in the same folder (a link planted at a guessable name is never written
 *  through), owner-only, then `opts.mode` (default 0600) before the rename. In a tenant folder the target and the way to it are checked first (and a target
 *  not provably inside it is refused unless `opts.process`). */
export function ownWriteFileAtomic(tenantDir, path, data, opts = {}) {
  const plan = ownWritePlan(tenantDir, path, 'write', opts.process === true);
  if (plan.problem) refuse(plan.problem);
  const abs = tenantDir ? plan.abs : resolve(path);
  const nonce = `${process.pid}.${randomBytes(8).toString('hex')}`;
  const tmp = tempNameSeam ? tempNameSeam(abs) : opts.dotTemp ? join(dirname(abs), `.${basename(abs)}.${nonce}.tmp`) : `${abs}.${nonce}.tmp`;
  try {
    writeFileSync(tmp, data, { ...(opts.encoding ? { encoding: opts.encoding } : {}), mode: 0o600, flag: 'wx' });
    try { chmodSync(tmp, opts.mode ?? 0o600); } catch { /* the OS does not honour modes */ }
    renameSync(tmp, abs);
  } catch (e) {
    if (e?.code !== 'EEXIST') { try { unlinkSync(tmp); } catch { /* nothing to clean */ } }
    throw e;
  }
}

// The wizard's helpers (setup-lib.mjs) are many small functions called from one synchronous applySetup: it names the tenant folder once, here, for
// the duration of the call, instead of threading it through every one. Empty (the default) means every helper is the plain fs call.
let ambient = '';
/** Run `fn` with `tenantDir` as the folder the wizard's own-file helpers guard ('' for none). Synchronous; restores the previous value. */
export function withAmbientTenant(tenantDir, fn) {
  const before = ambient;
  ambient = tenantDir || '';
  try { return fn(); } finally { ambient = before; }
}
/** The tenant folder the wizard's helpers are guarding right now, or ''. */
export const ambientTenantDir = () => ambient;

/** renameSync. Each side is checked as a write target (one not provably inside the tenant folder is refused unless `opts.process`). */
export function ownRename(tenantDir, from, to, opts = {}) {
  if (!tenantDir) return renameSync(from, to);
  const allow = opts?.process === true;
  const a = ownWritePlan(tenantDir, from, 'write', allow);
  const b = ownWritePlan(tenantDir, to, 'write', allow);
  if (a.problem) refuse(a.problem);
  if (b.problem) refuse(b.problem);
  return renameSync(a.abs, b.abs);
}

/** rmSync. In a tenant folder: refused when the target is a link, or any folder on the way to it is (a link at snapshots/ is never emptied). A folder's
 *  contents are removed without following a link inside it (fs.rm unlinks the link itself). `options.process` allows a target provably outside the folder. */
export function ownRm(tenantDir, path, options) {
  if (!tenantDir) return rmSync(path, options);
  const sp = splitProcess(options);
  const plan = ownWritePlan(tenantDir, path, 'write', sp.allow);
  if (plan.problem) refuse(plan.problem);
  return rmSync(plan.abs, sp.options);
}

/** unlinkSync, with the same refusals as ownRm. */
export function ownUnlink(tenantDir, path, opts = {}) {
  if (!tenantDir) return unlinkSync(path);
  const plan = ownWritePlan(tenantDir, path, 'write', opts?.process === true);
  if (plan.problem) refuse(plan.problem);
  return unlinkSync(plan.abs);
}

// ── The boot scan ────────────────────────────────────────────────────────────

/** The entry count above which the scan says so in one log line. It never refuses on count: a healthy tenant (plugin snapshots, identity snapshots, daily
 *  transcripts, digests) can hold tens of thousands of entries, and walking 20k of them takes well under a second. */
export const SCAN_LOG_ABOVE = 20000;

/** `x` (a folder the scan is asked to walk) as a path below the tenant folder: by the spelled way in through either spelling of the folder (the real root, or
 *  tenants.dir as written, which may be a link), else by its real path. null when it is not inside. */
function insideRel(realRoot, tenantDir, x) {
  const ax = resolve(String(x));
  for (const root of [realRoot, resolve(tenantDir)]) { const r = below(root, ax); if (r !== null) return r; }
  const d = deepReal(ax);
  return d ? below(realRoot, join(d.real, ...d.tail)) : null;
}

/** Why a tenant folder's own files are not its own, or '': tenant.yaml, .env and .mcp.json, every entry under data/ and private/, and the entries at the
 *  top level of home/ must each be a real file or folder (no link, no pipe, socket or device; a regular file has one hard link on posix). One sentence naming
 *  the path relative to the tenant folder. `opts.extra`: more folders inside the tenant folder to walk like data/ (the wake prompts folder when it lives
 *  elsewhere); `opts.only` walks just those and skips the fixed set. `opts.quick` looks at tenant.yaml, .env, .mcp.json, home/, private/ and data/ themselves
 *  and the first level of data/ and private/ only (the per-request net). `opts.log` receives the one line printed when more than SCAN_LOG_ABOVE entries were
 *  looked at (default console.log). No count ever refuses. A backup that links instead of copying (cp -al) is refused by design. */
export function tenantFilesProblem(tenantDir, opts = {}) {
  if (!scanMemo) return walkTenantFiles(tenantDir, opts);
  const key = [real(tenantDir), opts.quick ? 'q' : '-', opts.only ? 'o' : '-', ...(opts.extra || []).map((x) => resolve(String(x)))].join('\0');
  if (scanMemo.has(key)) return scanMemo.get(key);
  const r = walkTenantFiles(tenantDir, opts);
  scanMemo.set(key, r);
  return r;
}

/** How many walks have really run, by kind (the full scan, the quick per-request net, the wake-prompts-only walk). A test reads it to prove one scan per request. */
export const scanStats = { full: 0, quick: 0, only: 0 };
let scanMemo = null;
/** Run `fn` (synchronously) with the scan answers remembered: the same scan asked for again inside `fn` (the dry run and the reload of one /apply, the wizard's
 *  own check and the config it writes) is answered from the first walk. Nested calls share the outer memo. The memo is dropped when `fn` returns, so a later
 *  request always scans afresh. */
export function withScanMemo(fn) {
  if (scanMemo) return fn();
  scanMemo = new Map();
  try { return fn(); } finally { scanMemo = null; }
}

function walkTenantFiles(tenantDir, opts) {
  scanStats[opts.quick ? 'quick' : opts.only ? 'only' : 'full'] += 1;
  const quick = !!opts.quick;
  const root = real(tenantDir);
  let seen = 0;
  const check = (rel, abs) => {
    let st;
    try { st = lstatSync(abs); } catch (e) { return isGone(e) ? { gone: true } : { problem: unreadSentence(rel, e?.code) }; }
    seen += 1;
    if (st.isSymbolicLink()) return { problem: linkSentence(rel) };
    if (isOther(st)) return { problem: typeSentence(rel) };
    if (posix && st.isFile() && st.nlink > 1) return { problem: hardSentence(rel) };
    return { dir: st.isDirectory() };
  };
  const done = (problem) => {
    if (seen > SCAN_LOG_ABOVE) (opts.log || console.log)(`[tenancy] ${basename(root)}: the files check looked at ${seen} entries (more than ${SCAN_LOG_ABOVE}); that is fine, it is only slow to read.`);
    return problem;
  };
  const dirs = [];
  if (!opts.only) {
    const top = ['tenant.yaml', '.env', '.mcp.json', 'home', 'private', 'data'];
    for (const name of top) {
      const r = check(name, join(root, name));
      if (r.problem) return done(r.problem);
      if (r.dir && name !== 'home') dirs.push(name);
      if (r.dir && name === 'home' && !quick) {
        let names = [];
        try { names = readdirSync(join(root, 'home')).sort(); } catch (e) { return done(unreadSentence('home', e?.code)); }
        for (const n of names) {
          const c = check(`home/${n}`, join(root, 'home', n));
          if (c.problem) return done(c.problem);
        }
      }
    }
  }
  if (!quick) {
    for (const x of opts.extra || []) {
      const rel = insideRel(root, tenantDir, x);
      if (rel === null || rel === '' || dirs.includes(rel.split(sep).join('/'))) continue; // outside (confine says so) or already walked
      const parts = rel.split(sep);
      let cur = root;
      let bad = '';
      for (let i = 0; i < parts.length && !bad; i++) { // the way down to it must be real folders too
        cur = join(cur, parts[i]);
        const c = check(parts.slice(0, i + 1).join('/'), cur);
        if (c.problem) bad = c.problem;
        else if (c.gone || !c.dir) { cur = ''; break; }
      }
      if (bad) return done(bad);
      if (cur) dirs.push(parts.join('/'));
    }
  }
  // data/ and private/ (and the extras): every entry, depth first, names sorted so the same folder always names the same first problem. No cap.
  const stack = dirs.map((d) => ({ rel: d, depth: 0 })).reverse();
  while (stack.length) {
    const { rel, depth } = stack.pop();
    let names;
    try { names = readdirSync(join(root, ...rel.split('/'))).sort(); } catch (e) { return done(unreadSentence(rel, e?.code)); }
    const sub = [];
    for (const n of names) {
      const childRel = `${rel}/${n}`;
      const c = check(childRel, join(root, ...childRel.split('/')));
      if (c.problem) return done(c.problem);
      if (c.dir && !(quick && depth >= 0) && !SCAN_SKIPPED.includes(childRel)) sub.push({ rel: childRel, depth: depth + 1 });
    }
    stack.push(...sub.reverse());
  }
  return done('');
}

/** Folders under data/ the scan does not enter: the harnesses own their homes and temp folders, and uploads and logs can be large. The write layer still guards
 *  every server write into them, and reads of uploads and logs go through ownReadProblem. */
export const SCAN_SKIPPED = Object.freeze(['data/harness', 'data/tmp', 'data/files', 'data/logs']);

/** Why `tenantsDir` cannot be tenants.dir, or '': it is the app folder itself, or it holds the app folder (an app copy named like an id would then
 *  be read as a tenant holding the operator's .env and database). The shipped layout, <app>/tenants (held BY the app folder), is fine. */
export function tenantsDirProblem(tenantsDir, appRoot) {
  const rt = real(tenantsDir);
  const ra = real(appRoot);
  const down = below(rt, ra); // the app folder, as seen from tenants.dir
  if (down === '') return 'tenants.dir is the app folder itself; give it a folder of its own, for example tenants/.';
  if (down !== null) return 'tenants.dir holds the app folder; every folder in it would be read as a tenant, an app copy included, with the operator\'s .env and database. Give it a folder of its own, for example tenants/.';
  return '';
}

/** Why the tenant folder `tenantDir` cannot be a tenant, or '': it is, or holds, the app folder (through a link too). */
export function tenantHoldsAppProblem(tenantDir, appRoot) {
  const down = below(real(tenantDir), real(appRoot));
  return down === null ? '' : 'the tenant folder is, or holds, the app folder; a tenant never contains the process\'s own files.';
}

/** Why `path` may not be read now, in the sentences the write side uses; '' when it may. READS FAIL CLOSED: in a tenant (`tenantDir` set) a path outside the
 *  tenant folder is refused unless `opts.shipped` (an array of absolute roots: the shipped plugin root and the app's static assets) holds it. Inside, the path
 *  must not be a link, a hard-linked file, behind a link, or anything but a regular file (`opts.kind: 'file'`) or a file or folder (default). Nothing is opened.
 *  `tenantDir` empty: '' (the plain call, as before). */
export function ownReadProblem(tenantDir, path, opts = {}) { return readCheck(tenantDir, path, opts).problem; }

/** true when `path` is in the tenant folder by any spelling or by its real path (the paths the guard decides about), or cannot be decided; false when it is
 *  provably elsewhere. Agrees with isInsideTenantDir on dot segments (both normalise first). */
export function ownTouches(tenantDir, path) { return !!tenantDir && place(tenantDir, path) !== null; }

function readCheck(tenantDir, path, opts) {
  if (!tenantDir) return { problem: '', abs: path, inside: false };
  const at = place(tenantDir, path);
  if (at === UNKNOWN) return { problem: outsideReadSentence };
  if (!at) {
    for (const rootRaw of opts.shipped || []) {
      const rootReal = real(rootRaw);
      if (!viewsAgree(String(path), resolve(String(path)))) continue;
      const d = deepReal(resolve(String(path)));
      if (!d || d.dots) continue;
      const target = join(d.real, ...d.tail);
      if (below(rootReal, target) === null) continue;
      let st;
      try { st = lstatSync(target); } catch (e) { return isGone(e) ? { problem: '', abs: target, inside: false } : { problem: outsideReadSentence }; }
      if (isOther(st) || (opts.kind === 'file' && !st.isFile())) return { problem: outsideReadSentence };
      return { problem: '', abs: target, inside: false };
    }
    return { problem: outsideReadSentence };
  }
  const problem = ownTargetProblem(tenantDir, path, 'read');
  if (problem) return { problem };
  const me = nice(at.rel) || 'the tenant folder';
  if (opts.kind === 'file') {
    let st;
    try { st = lstatSync(at.abs); } catch { return { problem: '', abs: at.abs, inside: true }; }
    if (!st.isFile()) return { problem: notFileSentence(me) };
  }
  return { problem: '', abs: at.abs, inside: true };
}

let afterReadCheck = null;
/** Test seam: `fn(absPath)` runs between the read check and the open (a test swaps a link or a pipe in there, the race the open must survive). null restores. */
export function setAfterReadCheckForTest(fn) { afterReadCheck = fn; }

/** Open a file for reading (tailing, streaming, or a read that needs the open handle). Tenancy off (`tenantDir` empty): the plain `openSync(path, 'r')`. In a
 *  tenant: the read check above, then the file is opened O_RDONLY | O_NOFOLLOW | O_NONBLOCK (a pipe swapped in after the check opens at once instead of
 *  blocking the event loop for a writer), and the OPEN handle must be a regular file with one hard link (posix) before the caller reads a byte. The caller
 *  closes `fd`. There is never a check followed by a plain open of the path. Returns { fd, stat } (stat is fstat of the open handle). */
export function ownOpenRead(tenantDir, path, opts = {}) {
  if (!tenantDir) { const fd = openSync(path, 'r'); return { fd, stat: fstatSync(fd) }; }
  const { problem, abs, inside } = readCheck(tenantDir, path, { ...opts, kind: 'file' });
  if (problem) refuse(problem);
  // The identity of what was checked: the path's own inode and device, taken right after the check (a link has its own, not its target's).
  const checked = identityOf(abs);
  if (afterReadCheck) afterReadCheck(abs);
  const me = inside ? nice(place(tenantDir, path)?.rel || []) : 'that file';
  let fd;
  try { fd = openSync(abs, constants.O_RDONLY | (inside ? (constants.O_NOFOLLOW || 0) : 0) | (constants.O_NONBLOCK || 0)); }
  catch (e) { if (e?.code === 'ELOOP' || e?.code === 'EMLINK') refuse(linkSentence(me)); throw e; }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) refuse(typeSentence(me));
    if (inside && posix && st.nlink > 1) refuse(hardSentence(me));
    if (!sameFile(checked, fstatSync(fd, { bigint: true }))) refuse(changedSentence(me));
    return { fd, stat: st };
  } catch (e) { try { closeSync(fd); } catch { /* closed */ } throw e; }
}

/** The inode and device of the entry at `abs` itself (lstat: a link is not followed), or null when there is none. */
function identityOf(abs) {
  try { const st = lstatSync(abs, { bigint: true }); return { ino: st.ino, dev: st.dev }; } catch { return null; }
}
/** true when the open handle `st` (fstat) is the very file `checked` described. This is the SECOND check behind O_NOFOLLOW, and the only one on Windows (which has
 *  no O_NOFOLLOW): a link or another file swapped in after the check has a different inode or device than the path had when it was checked. It closes the window
 *  to the comparison and no further: a swap that restores the same inode is not seen. */
function sameFile(checked, st) {
  if (!checked) return false; // there was nothing at the path when it was checked, and something opened: not what was checked
  return checked.ino === st.ino && checked.dev === st.dev; // (both read as bigint: a Windows file id is wider than a double)
}
const changedSentence = (rel) => `${rel} in the tenant folder changed while it was being opened; ${TAIL}`;

/** readFileSync for a tenant: ownOpenRead (checked, opened without following a link or blocking on a pipe, the open handle verified), then the bytes. Tenancy
 *  off (`tenantDir` empty): the plain readFileSync. A missing file throws ENOENT as readFileSync does. */
export function ownReadFile(tenantDir, path, opts = {}) {
  if (!tenantDir) return readFileSync(path, opts.encoding);
  const { fd } = ownOpenRead(tenantDir, path, opts);
  try { return readFileSync(fd, opts.encoding); } finally { closeSync(fd); }
}

/** readdirSync for a tenant, after the read check (a folder, not behind a link). */
export function ownReadDir(tenantDir, path, opts = {}) {
  if (!tenantDir) return readdirSync(path, opts.options);
  const { problem, abs } = readCheck(tenantDir, path, opts);
  if (problem) refuse(problem);
  return readdirSync(abs, opts.options);
}

/** statSync for a tenant, after the read check. */
export function ownStat(tenantDir, path, opts = {}) {
  if (!tenantDir) return statSync(path);
  const { problem, abs } = readCheck(tenantDir, path, opts);
  if (problem) refuse(problem);
  return statSync(abs);
}
