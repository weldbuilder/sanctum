// Identity ratification routes (docs/PLUGINS.md "Identity ratification").
//
// The person's routes sit behind the session (authMiddleware) and nothing else: the internal token must never be able to
// ratify, revert or edit as the person, or the companion could bless its own change. The companion's routes sit behind the
// internal token, and the one that writes also behind the app-write switch; it never ratifies.
//
//   GET  /api/identity/status          session   state, digests, what is waiting and who changed it
//   GET  /api/identity/history         session   the journal, newest first, bounded
//   GET  /api/identity/files           session   the live files' text with the digest they were read at (for the editor); answers over a damaged ledger too
//   GET  /api/identity/diff            session   unified text diff between two copies (a digest, `ratified` or `live`), per file
//   POST /api/identity/ratify          session   {digest}  409 when the files are no longer at that digest; 200 with unchanged: true when they are already the ratified ones
//   POST /api/identity/revert          session   {digest}  409 guard; writes the ratified copy back over live
//   PUT  /api/identity/file            session   {path, text, digest}  the person's edit; ratifies when nothing else was waiting
//   GET  /api/internal/identity/status internal  read-only (`res identity status`)
//   POST /api/internal/identity/file   internal + app-write   {path, text}  the companion's edit; journaled `companion`, never ratified
import { Router, type Request, type Response } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { internalOnly } from '../middleware/internal-token.js';
import { appWriteGate } from '../middleware/app-write.js';
import { DIGEST_OK } from '../services/plugin-ratify.js';
import {
  IdentityDigestMismatch, IdentityRefused, JOURNAL_LIMIT, checkIdentity, filesOf, ratifyIdentity, readJournal, revertIdentity, writeIdentityFile,
} from '../services/identity/ledger.js';
import { unifiedDiff } from '../services/identity/diff.js';
import { appLedger, currentIdentity, toStatus } from '../services/identity/status.js';
import { emitCheck } from '../services/identity/guard.js';
import { publishIdentity } from '../services/identity/notify.js';

/** The diff of one file is left out above this size, as plugins do for a file view. */
export const DIFF_FILE_MAX = 256 * 1024;

/** The person's router: mounted at /api/identity ahead of the main API router. */
export const identityRouter = Router();
/** The companion's router: mounted at /api/internal/identity. */
export const identityInternalRouter = Router();

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function unconfigured(res: Response): void {
  res.status(503).json({ error: 'identity_ledger_unconfigured', detail: 'no identity ledger folder is configured' });
}

/** Answer a failed write: 409 for a digest that moved, the refusal's own status for a refused one, 500 for anything else. */
function fail(res: Response, e: unknown, what: string): void {
  if (e instanceof IdentityDigestMismatch) {
    res.status(409).json({ error: 'digest_mismatch', digest: e.digest, detail: 'the identity files changed since you looked; reload and review them again' });
    return;
  }
  if (e instanceof IdentityRefused) {
    const status = e.code === 'unavailable' ? 503 : ['case_conflict', 'not_regular', 'nothing_to_revert', 'snapshot_damaged', 'revert_incomplete'].includes(e.code) ? 409 : 400;
    res.status(status).json({ error: e.code, detail: e.message });
    return;
  }
  console.error(`[identity] ${what} failed:`, e);
  res.status(500).json({ error: 'identity_write_failed', detail: errMsg(e) });
}

const digestOf = (req: Request): string | null => {
  const d = (req.body as { digest?: unknown } | undefined)?.digest;
  return typeof d === 'string' && DIGEST_OK.test(d) ? d : null;
};
const needDigest = (res: Response): void => {
  res.status(400).json({ error: 'digest_required', detail: 'send {"digest": "<sha256>"}: the digest GET /api/identity/status showed you' });
};

/** A file name from the disk, for the companion to read: control characters (a newline in a name) become `?` and a long name is cut. */
export function printableName(n: string): string {
  const clean = n.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '?');
  return clean.length > 80 ? `${clean.slice(0, 80)}...` : clean;
}

function sendStatus(_req: Request, res: Response): void {
  const cur = currentIdentity();
  if (!cur) { unconfigured(res); return; }
  res.json(cur.status);
}

/** `res identity status`: the same record, with every file name made printable (the companion reads it as text). */
function sendInternalStatus(_req: Request, res: Response): void {
  const cur = currentIdentity();
  if (!cur) { unconfigured(res); return; }
  const s = cur.status;
  res.json({
    ...s,
    files: s.files.slice(0, 100).map(printableName),
    skipped: s.skipped.slice(0, 100).map(printableName),
    pending: s.pending && { ...s.pending, changes: s.pending.changes.slice(0, 100).map((c) => ({ ...c, path: printableName(c.path) })) },
    detail: s.detail === null ? null : s.detail.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '?'),
  });
}

// ── The companion ────────────────────────────────────────────────────────────
identityInternalRouter.get('/status', internalOnly, sendInternalStatus);

identityInternalRouter.post('/file', internalOnly, appWriteGate, (req, res) => {
  const l = appLedger();
  if (!l) { unconfigured(res); return; }
  const { path, text } = (req.body ?? {}) as { path?: unknown; text?: unknown };
  if (typeof path !== 'string' || typeof text !== 'string') { res.status(400).json({ error: 'path_and_text_required', detail: 'send {"path": "companion.md", "text": "..."}' }); return; }
  try {
    const out = writeIdentityFile(l.home, l.opts, { name: path, text, author: 'companion' });
    publishIdentity(out);
    res.json({ ok: true, ratified: false, changed: out.changed, status: toStatus(out) });
  } catch (e) { fail(res, e, 'companion write'); }
});

// ── The person ───────────────────────────────────────────────────────────────
identityRouter.get('/status', authMiddleware, sendStatus);

identityRouter.get('/history', authMiddleware, (req, res) => {
  const l = appLedger();
  if (!l) { unconfigured(res); return; }
  const n = Number(req.query.limit);
  const limit = Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), JOURNAL_LIMIT) : 50;
  const check = emitCheck(checkIdentity(l.home, l.opts)); // so an edit made since the last look is in the list
  res.json({ entries: readJournal(l.opts.ledgerDir, limit), digest: check.digest, ratified_digest: check.ratified_digest ?? null });
});

identityRouter.get('/files', authMiddleware, (_req, res) => {
  const l = appLedger();
  if (!l) { unconfigured(res); return; }
  const check = emitCheck(checkIdentity(l.home, l.opts));
  // A damaged ledger is the one blocker the person can ratify their way out of, so they must be able to read what they would be ratifying.
  if (check.blocked && !check.damaged) { res.status(503).json({ error: 'unavailable', detail: check.detail }); return; }
  const live = filesOf(l.home, l.opts, 'live');
  if (!live) { res.status(503).json({ error: 'unavailable', detail: 'the identity folder cannot be read' }); return; }
  // The digest is of what the check hashed; if a file moved in between, the next write's 409 says so.
  res.json({ digest: check.digest, files: [...live.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([name, text]) => ({ name, text })) });
});

identityRouter.get('/diff', authMiddleware, (req, res) => {
  const l = appLedger();
  if (!l) { unconfigured(res); return; }
  const check = emitCheck(checkIdentity(l.home, l.opts));
  const resolve = (v: unknown, dflt: string): string => {
    const s = typeof v === 'string' && v ? v : dflt;
    return s === 'ratified' ? (check.ratified_digest ?? '') : s;
  };
  const from = resolve(req.query.from, 'ratified');
  const to = resolve(req.query.to, 'live');
  // Over a damaged ledger there is no ratified copy to name: the diff is against nothing, so the full text shows (as added files).
  const fromNothing = from === '' && !!check.damaged;
  for (const v of [from, to]) {
    if (v !== 'live' && !DIGEST_OK.test(v) && !(v === '' && fromNothing)) { res.status(400).json({ error: 'bad_digest', detail: 'from and to are a sha256 digest, `ratified` or `live`' }); return; }
  }
  const a = fromNothing ? new Map<string, string>() : filesOf(l.home, l.opts, from);
  const b = filesOf(l.home, l.opts, to);
  if (!a || !b) { res.status(404).json({ error: 'not_found', detail: 'there is no copy of that version (only the ratified one and the one before it are kept)' }); return; }
  const names = [...new Set([...a.keys(), ...b.keys()])].sort();
  const files = [];
  for (const name of names) {
    const before = a.get(name);
    const after = b.get(name);
    if (before === after) continue;
    const kind = before === undefined ? 'added' : after === undefined ? 'removed' : 'modified';
    const text = `${before ?? ''}${after ?? ''}`;
    if (text.includes('\0')) { files.push({ path: name, kind, binary: true }); continue; }
    if (Buffer.byteLength(before ?? '', 'utf-8') > DIFF_FILE_MAX || Buffer.byteLength(after ?? '', 'utf-8') > DIFF_FILE_MAX) { files.push({ path: name, kind, truncated: true }); continue; }
    files.push({ path: name, kind, diff: unifiedDiff(before ?? '', after ?? '', before === undefined ? '/dev/null' : `${from === 'live' ? 'live' : from.slice(0, 8)}/${name}`, after === undefined ? '/dev/null' : `${to === 'live' ? 'live' : to.slice(0, 8)}/${name}`) });
  }
  res.json({ from, to, files });
});

identityRouter.post('/ratify', authMiddleware, (req, res) => {
  const l = appLedger();
  if (!l) { unconfigured(res); return; }
  const digest = digestOf(req);
  if (!digest) { needDigest(res); return; }
  try {
    const out = ratifyIdentity(l.home, l.opts, { by: 'person', expected: digest });
    publishIdentity(out);
    res.json({ ok: true, digest: out.digest, unchanged: !!out.unchanged, status: toStatus(out) });
  } catch (e) { fail(res, e, 'ratify'); }
});

identityRouter.post('/revert', authMiddleware, (req, res) => {
  const l = appLedger();
  if (!l) { unconfigured(res); return; }
  const digest = digestOf(req);
  if (!digest) { needDigest(res); return; }
  try {
    const out = revertIdentity(l.home, l.opts, { expected: digest });
    publishIdentity(out);
    res.json({ ok: true, digest: out.digest, status: toStatus(out) });
  } catch (e) { fail(res, e, 'revert'); }
});

identityRouter.put('/file', authMiddleware, (req, res) => {
  const l = appLedger();
  if (!l) { unconfigured(res); return; }
  const { path, text } = (req.body ?? {}) as { path?: unknown; text?: unknown };
  const digest = digestOf(req);
  if (typeof path !== 'string' || typeof text !== 'string') { res.status(400).json({ error: 'path_and_text_required', detail: 'send {"path": "companion.md", "text": "...", "digest": "<sha256>"}' }); return; }
  if (!digest) { needDigest(res); return; }
  try {
    const out = writeIdentityFile(l.home, l.opts, { name: path, text, author: 'person', expected: digest });
    publishIdentity(out);
    res.json({ ok: true, ratified: out.ratified_now, changed: out.changed, status: toStatus(out) });
  } catch (e) { fail(res, e, 'person edit'); }
});

