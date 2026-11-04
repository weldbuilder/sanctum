// GENERATED from packages/backend/src/boot-recover.ts by scripts/sync-boot-recover.mjs. Do not edit; edit the .ts and run: node scripts/sync-boot-recover.mjs
// The pre-boot recovery, vendored: this file imports node's own modules and NOTHING else (no dotenv, no app code, not scripts/updater-core.mjs), so it can run when
// node_modules is half moved, and the new version's copy of it can never be the old version's. packages/backend/boot.mjs runs it before it imports server.js.
// scripts/boot-recover.mjs is a generated copy of this file (`node scripts/sync-boot-recover.mjs`; a test fails when it is stale); `npm start` runs that copy
// (`scripts/update.mjs --recover`) because it works even when dist is missing, and scripts/updater-core.mjs builds its restore and its crash recovery on it, so the
// swap, the roll back and the recovery after a crash all follow one set of rules.
//
// The state machine. A swap or a roll back keeps a copy of what it replaces in <app>/.update-rollback.next/<version>/ (a roll back works in .update-rollback/<version>/),
// with a manifest.json. The manifest names its `format` (1) and describes its own states (`machine`: state -> what the recovery does):
//   swapping, rolling_back   restore   put the previous version back: `git reset --hard <sha>` and `git checkout -- .` ALWAYS (even when HEAD already is the sha: a power cut in
//                                      the middle of a checkout leaves a half-written tree), then each moved directory back (the current one renamed aside first, never deleted
//                                      without its replacement in hand), then the copy removed
//   swapped                    adopt    in .update-rollback.next: the swap had finished, its copy is moved over the previous one (in .update-rollback it is just the kept copy)
//   rolled_back                discard  the restore had finished; only the set-aside copies were left to delete
//   recovery_failed            hold     an earlier recovery could not finish (the reason is in the manifest); only `npm run update -- --recover` tries again
// A manifest that cannot be read, or whose format is newer than this code knows, is never acted on: nothing is removed, and the result says so.
// Every manifest write is a temp file and a rename, so a cut leaves the old manifest or the new one, never half of one.
//
// The outcome is written to <app>/.update-recovery.json; the app's updater reads it at boot to word the job (services/updater.ts).
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
/** The manifest format this code writes and understands. */
export const MANIFEST_FORMAT = 1;
/** The exit code that asks a supervisor to start the app again after a recovery. */
export const RECOVER_EXIT_CODE = 75;
/** A supervised recovery may exit RECOVER_EXIT_CODE this many times within LOOP_WINDOW_MS; the next one is refused (the app boots as it is). */
export const LOOP_MAX = 3;
export const LOOP_WINDOW_MS = 10 * 60_000;
/** How long a boot must stay up before the loop count is cleared. */
export const CLEAN_BOOT_MS = 30_000;
/** The state machine, written into every manifest. */
export const MACHINE = Object.freeze({ swapping: 'restore', rolling_back: 'restore', swapped: 'adopt', rolled_back: 'discard', recovery_failed: 'hold' });
const ACTIONS = ['restore', 'adopt', 'discard', 'hold'];
const NOTHING = { changed: false, outcome: 'nothing', detail: '' };
const exists = (p) => { try {
    lstatSync(p);
    return true;
}
catch {
    return false;
} };
const isLink = (p) => { try {
    return lstatSync(p).isSymbolicLink();
}
catch {
    return false;
} };
const noop = (_line) => { };
const sha256 = (p) => { try {
    return createHash('sha256').update(readFileSync(p)).digest('hex');
}
catch {
    return '';
} };
const sleepSync = (ms) => { try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
catch { /* no sleeping here */ } };
/** Run a file operation; on Windows a rename or removal that fails because something still holds the file (EBUSY, EPERM, EACCES) is retried with a backoff. */
function retryFs(fn) {
    for (let i = 0;; i++) {
        try {
            return fn();
        }
        catch (err) {
            const code = err.code;
            if (process.platform === 'win32' && (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') && i < 8) {
                sleepSync(150 * (i + 1));
                continue;
            }
            throw err;
        }
    }
}
const renameTo = (from, to) => retryFs(() => renameSync(from, to));
const removeAll = (p) => retryFs(() => rmSync(p, { recursive: true, force: true }));
export const rollbackRoot = (root) => join(root, '.update-rollback');
export const rollbackNextRoot = (root) => join(root, '.update-rollback.next');
export const stageDir = (root) => join(root, '.update-stage');
export const RECOVERY_FILE = '.update-recovery.json';
export const LOOP_FILE = '.update-recover.count';
export const EXCLUDED = ['.update-stage/', '.update-rollback/', '.update-rollback.next/', RECOVERY_FILE, LOOP_FILE];
/** Keep the updater's own folders and files out of `git status` on checkouts whose .gitignore predates them (this checkout's own exclude file; never tracked). */
export function ensureExcluded(root, names = EXCLUDED) {
    try {
        const r = spawnSync('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd: root, encoding: 'utf-8' });
        if (r.status !== 0)
            return;
        const file = resolve(root, String(r.stdout).trim());
        const have = existsSync(file) ? readFileSync(file, 'utf-8') : '';
        const add = names.filter((p) => !have.split(/\r?\n/).includes(p));
        if (!add.length)
            return;
        mkdirSync(dirname(file), { recursive: true });
        appendFileSync(file, `${have && !have.endsWith('\n') ? '\n' : ''}${add.join('\n')}\n`);
    }
    catch { /* the .gitignore is the main route */ }
}
// ---- the manifest -----------------------------------------------------------------
/** Write a manifest atomically: a temp file in the same folder, then a rename over the old one. Stamps the format and the state machine. */
export function writeManifest(dir, manifest) {
    manifest.format = MANIFEST_FORMAT;
    manifest.machine = { ...MACHINE };
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, 'manifest.json.tmp');
    writeFileSync(tmp, JSON.stringify(manifest, null, 2));
    renameTo(tmp, join(dir, 'manifest.json'));
}
const safeRel = (p) => typeof p === 'string' && p !== '' && !isAbsolute(p) && !p.split(/[\\/]/).includes('..') && !/^[A-Za-z]:/.test(p);
/** Read <dir>/manifest.json: `none` when there is no such file, `corrupt` when it cannot be parsed or is not shaped like a manifest, `format` when it is a newer format. */
export function readManifest(dir) {
    const file = join(dir, 'manifest.json');
    if (!exists(file))
        return { kind: 'none' };
    let m;
    try {
        m = JSON.parse(readFileSync(file, 'utf-8'));
    }
    catch (err) {
        return { kind: 'corrupt', reason: err.message };
    }
    if (!m || typeof m !== 'object' || Array.isArray(m))
        return { kind: 'corrupt', reason: 'not an object' };
    const o = m;
    const format = o.format === undefined ? 1 : o.format;
    if (typeof format !== 'number' || !Number.isInteger(format) || format < 1)
        return { kind: 'corrupt', reason: `format ${JSON.stringify(o.format)} is not a number` };
    if (format > MANIFEST_FORMAT)
        return { kind: 'format', reason: `format ${format}; this version understands up to ${MANIFEST_FORMAT}` };
    if (typeof o.phase !== 'string' || !Array.isArray(o.entries))
        return { kind: 'corrupt', reason: 'no phase or no entries' };
    for (const e of o.entries) {
        const x = e;
        if (!x || typeof x !== 'object' || !safeRel(x.path) || !['dir', 'file', 'absent'].includes(String(x.kind)))
            return { kind: 'corrupt', reason: `an entry is not valid (${JSON.stringify(e)?.slice(0, 80)})` };
    }
    if (o.machine !== undefined && (typeof o.machine !== 'object' || o.machine === null || Object.values(o.machine).some((v) => !ACTIONS.includes(String(v)))))
        return { kind: 'corrupt', reason: 'the state machine is not valid' };
    return { kind: 'ok', manifest: o };
}
/** What the recovery does for a phase: the manifest's own description of its states, else this code's. */
const actionFor = (m) => (m.machine ?? MACHINE)[m.phase];
function copiesIn(base) {
    let list = [];
    try {
        list = readdirSync(base, { withFileTypes: true });
    }
    catch {
        return [];
    }
    return list.filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => ({ dir: join(base, d.name), read: readManifest(join(base, d.name)) }));
}
/** Is there a copy under `base` that must not be deleted or overwritten (an unreadable manifest, or a swap, roll back or failed recovery that is not settled)? '' when not, else a sentence. */
export function unsettled(base) {
    for (const c of copiesIn(base)) {
        if (c.read.kind === 'corrupt' || c.read.kind === 'format')
            return `the update state in ${c.dir} cannot be read (${c.read.reason})`;
        if (c.read.kind === 'ok') {
            const a = actionFor(c.read.manifest);
            if (a === 'restore' || a === 'hold' || !a)
                return `an earlier update left its files in ${c.dir} (state ${c.read.manifest.phase})`;
        }
    }
    return '';
}
// ---- git ------------------------------------------------------------------------------
export function headOf(root) {
    const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf-8' });
    return r.status === 0 ? String(r.stdout).trim() : '';
}
const gitErr = (r) => (r.error ? r.error.message : String(r.stderr || r.stdout || `exit ${r.status}`).trim().split(/\r?\n/).slice(-2).join(' '));
/** Put the tracked files back on `sha`: `git reset --hard <sha>`, then `git checkout -- .`. Always, whatever HEAD is: a cut during a checkout leaves HEAD on the new commit or the old
 *  one with half the files written. Returns '' on success, else what git said (git missing, index.lock, an unknown commit). Untracked files are never touched. */
export function gitRestore(root, sha) {
    const reset = spawnSync('git', ['reset', '--hard', sha], { cwd: root, encoding: 'utf-8' });
    if (reset.status !== 0)
        return `git reset --hard ${sha.slice(0, 8)} failed: ${gitErr(reset)}`;
    const co = spawnSync('git', ['checkout', '--', '.'], { cwd: root, encoding: 'utf-8' });
    if (co.status !== 0)
        return `git checkout -- . failed: ${gitErr(co)}`;
    return '';
}
// ---- putting the files back -------------------------------------------------------------
/** Put a copy's files back. For every directory the copy holds the CURRENT one is first renamed aside (<copy>/aside/...), then the old one renamed back, so each is in exactly one
 *  place at every instant; each entry is marked `done` in the manifest as it goes, so a second run (after a crash) carries on. Nothing live is ever deleted without its replacement
 *  in hand: an entry whose copy is not there is left alone, and is reported in `missing` when the swap had got as far as moving it (step `moved`). Files only; git is the caller's.
 *  Throws when a rename fails (the manifest then says how far it got). */
export function restoreFiles({ root, dir, manifest }) {
    const aside = join(dir, 'aside');
    const missing = [];
    let changed = false;
    const save = () => writeManifest(dir, manifest);
    for (const e of manifest.entries) {
        if (e.done)
            continue;
        const target = join(root, e.path);
        const asideP = join(aside, e.path);
        if (e.kind === 'absent') { // it did not exist before: whatever is live now is the new version's
            if (exists(target)) {
                if (e.how === 'moved') {
                    mkdirSync(dirname(asideP), { recursive: true });
                    if (exists(asideP))
                        removeAll(target);
                    else
                        renameTo(target, asideP);
                }
                else
                    removeAll(target);
                changed = true;
            }
            e.done = true;
            save();
            continue;
        }
        const src = join(dir, 'files', e.path);
        if (!exists(src)) {
            if (e.step !== 'moved')
                continue; // the swap had not reached it: the live one is still the old one
            if (exists(asideP)) {
                e.done = true;
                save();
                continue;
            } // already swapped (a crash before the flag was written)
            missing.push(e.path); // lost from the copy: the live one stays where it is
            continue;
        }
        if (e.how === 'moved') {
            if (exists(target)) {
                mkdirSync(dirname(asideP), { recursive: true });
                if (exists(asideP))
                    removeAll(target);
                else
                    renameTo(target, asideP); // (the copy is in hand, so a second set-aside is simply dropped)
            }
            mkdirSync(dirname(target), { recursive: true });
            renameTo(src, target);
        }
        else {
            mkdirSync(dirname(target), { recursive: true });
            retryFs(() => cpSync(src, target, { recursive: true, force: true }));
        }
        changed = true;
        e.done = true;
        save();
    }
    return { changed, missing };
}
/** What is inconsistent after a restore, one line each: HEAD is not the manifest's sha, a directory the copy held is missing, the lockfile or the installed modules are not the
 *  restored version's. Empty when all is in place. */
export function verifyRestored(root, m) {
    const out = [];
    if (m.mode === 'git' && m.sha) {
        const head = headOf(root);
        if (head !== m.sha)
            out.push(`HEAD is ${head ? head.slice(0, 8) : 'unreadable'}, not ${String(m.sha).slice(0, 8)}`);
    }
    for (const e of m.entries)
        if (e.kind === 'dir' && e.how === 'moved' && !exists(join(root, e.path)))
            out.push(`${e.path} is missing`);
    const lock = join(root, 'package-lock.json');
    if (m.lockfile_sha256 && exists(lock) && sha256(lock) !== m.lockfile_sha256)
        out.push('package-lock.json is not the restored version\'s');
    try {
        const hidden = join(root, 'node_modules', '.package-lock.json');
        if (exists(hidden) && exists(lock)) {
            const have = JSON.parse(readFileSync(hidden, 'utf-8')).packages ?? {};
            const want = JSON.parse(readFileSync(lock, 'utf-8')).packages ?? {};
            const off = Object.keys(have).filter((k) => k && want[k]?.version !== undefined && have[k]?.version !== undefined && want[k].version !== have[k].version);
            if (off.length)
                out.push(`node_modules does not match package-lock.json (${off.length} package${off.length === 1 ? '' : 's'}, e.g. ${off[0]})`);
        }
    }
    catch { /* an unreadable hidden lockfile is npm's own business */ }
    return out;
}
/** The whole restore of one copy, for a swap that failed, a roll back, and the recovery after a crash: code first, then the files, then (when all is back) the manifest says
 *  `rolled_back` and the caller deletes the copy. When something cannot be done the manifest is marked `recovery_failed` with the reason and the copy is KEPT.
 *  `gitFirst`: stop before moving anything when git fails (an interactive roll back); the recovery after a crash moves the directories back anyway, where it can.
 *  Returns { ok, changed, detail, problems }: `ok` false means the copy must stay. */
export function restoreCopy(o) {
    const { root, dir, manifest: m } = o;
    const log = o.log ?? noop;
    const from = m.phase === 'recovery_failed' ? (m.restored_from ?? 'swapping') : m.phase;
    let git = '';
    if (m.mode === 'git' && m.sha)
        git = gitRestore(root, m.sha);
    if (git)
        log(`warning: ${git}`);
    if (git && o.gitFirst)
        return { ok: false, changed: false, touched: false, detail: git };
    let r = { changed: false, missing: [] };
    let thrown = '';
    try {
        r = restoreFiles({ root, dir, manifest: m });
    }
    catch (err) {
        thrown = err.message;
        log(`warning: could not put the files back: ${thrown}`);
    }
    const problems = [];
    if (git)
        problems.push(git);
    if (thrown)
        problems.push(`could not put the files back: ${thrown}`);
    if (r.missing.length)
        problems.push(`the copy lacks ${r.missing.join(', ')} (restored the others; the live ones were left where they are)`);
    if (problems.length) {
        const detail = problems.join('; ');
        m.restored_from = from;
        m.phase = 'recovery_failed';
        m.failure = detail;
        try {
            writeManifest(dir, m);
        }
        catch { /* the folder is still there */ }
        return { ok: false, changed: r.changed, touched: r.changed, detail };
    }
    m.restored_from = from;
    m.phase = 'rolled_back';
    delete m.failure;
    writeManifest(dir, m);
    return { ok: true, changed: r.changed, touched: r.changed, detail: '' };
}
// ---- the recovery -------------------------------------------------------------------------
const rank = { nothing: 0, adopted: 1, restored: 2, failed: 3, refused: 4 };
const POINTER = 'Run: npm run update -- --recover';
/** Recover one copy under `base` (.update-rollback.next or .update-rollback). */
function recoverCopy(root, base, c, log, retry) {
    if (c.read.kind === 'corrupt' || c.read.kind === 'format') {
        const why = c.read.kind === 'format'
            ? `the update state in ${c.dir} is in a format this version does not understand (${c.read.reason}); nothing was removed or changed. ${POINTER} with the newer version's files, or restore that folder from a backup.`
            : `could not read the update state in ${c.dir} (${c.read.reason}); nothing was removed. The copy and the stage were left in place. ${POINTER}`;
        log(why);
        return { changed: false, outcome: 'refused', detail: c.read.kind === 'format' ? 'could not read the update state (a newer format); nothing was removed' : 'could not read the update state; nothing was removed' };
    }
    if (c.read.kind === 'none')
        return NOTHING;
    const m = c.read.manifest;
    const action = actionFor(m);
    const base0 = { phase: m.phase, version: m.version, toVersion: m.toVersion ?? undefined };
    if (!action) {
        log(`the update state in ${c.dir} is in the state "${m.phase}", which this version does not know; nothing was removed or changed.`);
        return { ...base0, changed: false, outcome: 'refused', detail: `could not read the update state (unknown state "${m.phase}"); nothing was removed` };
    }
    if (action === 'hold' && !retry) {
        log(`an earlier recovery could not finish (${m.failure ?? 'no reason was kept'}); the copy is kept in ${c.dir}. ${POINTER}`);
        return { ...base0, changed: false, outcome: 'failed', detail: `${m.failure ?? 'an earlier recovery did not finish'}. The copy was kept. ${POINTER}` };
    }
    if (action === 'restore' || action === 'hold') {
        log(m.phase === 'rolling_back' ? 'a roll back was cut short: finishing it' : action === 'hold' ? 'trying the interrupted recovery again' : 'a swap was cut short: putting the previous version back');
        const r = restoreCopy({ root, dir: c.dir, manifest: m, log });
        if (!r.ok) {
            log(`could not finish: ${r.detail}. The copy is kept in ${c.dir}. ${POINTER}`);
            return { ...base0, changed: r.changed, outcome: 'failed', detail: `${r.detail}. The copy was kept. ${POINTER}` };
        }
        removeAll(base);
        const problems = verifyRestored(root, m);
        if (problems.length) {
            const detail = `the previous version was put back, but this is inconsistent: ${problems.join('; ')}`;
            log(detail);
            return { ...base0, phase: m.restored_from ?? m.phase, changed: true, outcome: 'failed', detail };
        }
        return { ...base0, phase: m.restored_from ?? m.phase, changed: true, outcome: 'restored', detail: 'the previous version was put back' };
    }
    if (action === 'discard') {
        removeAll(base); // (a roll back consumes its copy; the restore had finished)
        return { ...base0, phase: m.restored_from ?? 'rolling_back', changed: false, outcome: 'restored', detail: 'the previous version was put back' };
    }
    // adopt: only a copy still in .update-rollback.next has anything to do (one in .update-rollback is the kept copy of a finished swap)
    if (base === rollbackNextRoot(root)) {
        log('finishing a swap: keeping its rollback copy');
        removeAll(rollbackRoot(root));
        renameTo(base, rollbackRoot(root));
        return { ...base0, changed: false, outcome: 'adopted', detail: `restarted on ${m.toVersion ?? 'the new version'}; the stage was cleaned up at boot` };
    }
    return NOTHING;
}
/** Look for a swap or a roll back that was cut short and finish it (see the state machine above). Never throws for a bad manifest: it refuses and says so.
 *  `retry`: also try a copy an earlier recovery marked `recovery_failed` (`npm run update -- --recover`). Writes <app>/.update-recovery.json when it did anything.
 *  `changed` in the result means the caller must start over. */
export function recover(root, o = {}) {
    const log = o.log ?? noop;
    const next = rollbackNextRoot(root);
    const main = rollbackRoot(root);
    let best = NOTHING;
    let changed = false;
    for (const base of [next, main]) {
        for (const c of copiesIn(base)) {
            const r = recoverCopy(root, base, c, log, !!o.retry);
            changed = changed || r.changed;
            if (rank[r.outcome] > rank[best.outcome])
                best = r;
        }
    }
    // A .update-rollback.next whose copies never got a manifest: the swap never began (the manifest is written before anything is touched), so it is just removed.
    if (exists(next) && !isLink(next) && copiesIn(next).every((c) => c.read.kind === 'none'))
        removeAll(next);
    const result = { ...best, changed };
    if (result.outcome !== 'nothing')
        writeResult(root, result);
    return result;
}
function writeResult(root, r) {
    try {
        ensureExcluded(root);
        const file = join(root, RECOVERY_FILE);
        writeFileSync(`${file}.tmp`, JSON.stringify({ ...r, at: new Date().toISOString() }, null, 2));
        renameTo(`${file}.tmp`, file);
    }
    catch { /* the log lines say it */ }
}
/** The result of the last recovery, once (the file is deleted by reading it). null when there is none. */
export function takeRecoveryResult(root) {
    const file = join(root, RECOVERY_FILE);
    if (!exists(file))
        return null;
    try {
        const r = JSON.parse(readFileSync(file, 'utf-8'));
        return r && typeof r.outcome === 'string' ? r : null;
    }
    catch {
        return null;
    }
    finally {
        try {
            rmSync(file, { force: true });
        }
        catch { /* it is read once or not at all */ }
    }
}
// ---- starting over -------------------------------------------------------------------------
/** `SANCTUM_SUPERVISED` may be set only in .env, which dotenv has not read yet: read just that line. */
export function isSupervised(root, env = process.env) {
    if (env.pm_id || env.SANCTUM_SUPERVISED === '1')
        return true;
    if (env.SANCTUM_SUPERVISED !== undefined)
        return false;
    try {
        for (const line of readFileSync(join(root, '.env'), 'utf-8').split(/\r?\n/)) {
            const m = /^\s*SANCTUM_SUPERVISED\s*=\s*(.*?)\s*$/.exec(line);
            if (m && !line.trim().startsWith('#'))
                return m[1].replace(/^(["'])(.*)\1$/, '$2') === '1';
        }
    }
    catch { /* no .env */ }
    return false;
}
/** The loop guard: `{ count, since }` in <app>/.update-recover.count. A supervised recovery that exits 75 notes itself here first; more than LOOP_MAX within LOOP_WINDOW_MS is refused. */
export function noteRecoveryExit(root, now = Date.now()) {
    let count = 0, since = now;
    try {
        const j = JSON.parse(readFileSync(join(root, LOOP_FILE), 'utf-8'));
        if (typeof j.count === 'number' && typeof j.since === 'number' && now - j.since < LOOP_WINDOW_MS && now >= j.since) {
            count = j.count;
            since = j.since;
        }
    }
    catch { /* none, or unreadable: a new window */ }
    count += 1;
    try {
        ensureExcluded(root);
        writeFileSync(join(root, LOOP_FILE), JSON.stringify({ count, since }));
    }
    catch { /* the guard is best effort */ }
    return { allowed: count <= LOOP_MAX, count };
}
export function clearLoopCount(root) { try {
    rmSync(join(root, LOOP_FILE), { force: true });
}
catch { /* ignore */ } }
/** The arguments of the re-exec: this process's node arguments without the inspector flags (the idle parent would hold the inspector port the child needs), then the same script. */
export function reexecArgs(execArgv, argv) {
    const out = [];
    for (let i = 0; i < execArgv.length; i++) {
        const a = execArgv[i];
        if (/^--inspect/.test(a) || /^--debug-port/.test(a)) {
            if (!a.includes('=') && /^--(inspect-port|inspect-publish-uid|debug-port)$/.test(a))
                i++;
            continue;
        }
        out.push(a);
    }
    return [...out, ...argv.slice(1)];
}
const SIGNAL_NUMBER = { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 };
/** What boot does: recover, then (when anything changed) start over. Resolves 'booting' (carry on and load the app), 'guarded' (the loop guard refused a restart: load the app as it is,
 *  and do not clear the count), 'exited' (a supervised exit was requested) or 'child' (the re-executed child has ended and this process was told to exit with its code). */
export async function bootRecover(d) {
    const log = d.log ?? ((l) => console.log(`[update-recover] ${l}`));
    const env = d.env ?? process.env;
    const exit = d.exit ?? ((c) => process.exit(c));
    const restarted = env.SANCTUM_RECOVER_REEXEC === '1';
    delete env.SANCTUM_RECOVER_REEXEC; // (so a later recovery, in this process's own life, may start over again)
    let r = NOTHING;
    try {
        r = recover(d.root, { log, retry: d.retry });
    }
    catch (err) {
        console.warn('[update-recover] could not check for a cut-short swap:', err.message);
    }
    if (r.outcome === 'failed' || r.outcome === 'refused')
        console.warn(`[update-recover] ${r.detail}`);
    if (!r.changed)
        return 'booting';
    if (restarted) {
        log('recovered again straight after a restart; carrying on with what is on disk.');
        return 'booting';
    }
    if (isSupervised(d.root, env)) {
        const guard = noteRecoveryExit(d.root, (d.now ?? Date.now)());
        if (!guard.allowed) {
            log(`this is recovery number ${guard.count} within ${LOOP_WINDOW_MS / 60_000} minutes, so the supervisor is not asked to restart again: starting the app as it is. Delete .update-recover.count once the folder is sorted out.`);
            return 'guarded';
        }
        log(`the files are back; exiting ${RECOVER_EXIT_CODE} so the supervisor starts the app again.`);
        exit(RECOVER_EXIT_CODE);
        return 'exited';
    }
    log('the files are back; starting the app again from them.');
    const spawnFn = d.spawnFn ?? spawn;
    const child = spawnFn(d.execPath ?? process.execPath, reexecArgs(d.execArgv ?? process.execArgv, d.argv ?? process.argv), { stdio: 'inherit', env: { ...env, SANCTUM_RECOVER_REEXEC: '1' } });
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'])
        process.on(sig, () => { try {
            child.kill(sig);
        }
        catch { /* gone */ } });
    return new Promise((resolveP) => {
        child.on('error', (err) => { console.error('[update-recover] could not start the app again:', err.message); exit(1); resolveP('child'); });
        child.on('exit', (code, signal) => { exit(code ?? (signal ? 128 + (SIGNAL_NUMBER[signal] ?? 1) : 0)); resolveP('child'); });
    });
}
