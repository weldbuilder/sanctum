// Plugin audit record (docs/PLUGINS.md, trust: companion). In companion mode nothing is gated: the
// loader runs the live folder. This file is what lets the person see what the companion did. On every
// load and run check the folder's digest is compared with the last one recorded; a different one is
// recorded as the new "last seen" with the files that changed, no person action needed, and the last
// 20 are kept. "Mark as seen" records the digest (and files) the person looked at, so the list can say
// "changed since you last looked" and show everything that differs from that point.
//
// Separate from ratified.json (the person-mode ledger): the two never share a file.
import { existsSync } from 'node:fs';
import { ownMkdir, ownRename, ownWriteFileAtomic, readOwnText } from '../tenancy/own-files.js';
import { OwnFileRefused } from '../../../../scripts/own-files-lib.mjs';
import { dirname, join } from 'node:path';
import { diffFiles, type DigestResult, type FileChange, type LedgerEntry } from './plugin-ratify.js';

export const AUDIT_HISTORY = 20;

export interface AuditRecord { digest: string; files: Record<string, string>; seen_at: string; changes: FileChange[] }
export interface AuditViewed { digest: string; files: Record<string, string>; at: string }
export interface AuditEntry { entries: AuditRecord[]; viewed?: AuditViewed }
export interface AuditFile { version: 1; plugins: Record<string, AuditEntry> }
/** What GET /api/plugins carries per plugin in companion mode. */
export interface AuditSummary {
  /** The digest of the code as last recorded; '' when nothing could be recorded. */
  digest: string;
  /** When the files last changed (ISO), or null when nothing was ever recorded. */
  last_change_at: string | null;
  changed_since_last_view: boolean;
  /** Everything that differs from what the person last viewed (a plugin never viewed: every file as added). */
  changes: FileChange[];
}

export const auditPath = (ledgerDir: string): string => join(ledgerDir, 'audit.json');

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isFiles = (v: unknown): v is Record<string, string> => isObj(v) && Object.values(v).every((x) => typeof x === 'string');
const isChange = (c: unknown): c is FileChange => isObj(c) && typeof c.path === 'string' && (c.kind === 'added' || c.kind === 'removed' || c.kind === 'modified');
const isRecord = (r: unknown): r is AuditRecord =>
  isObj(r) && typeof r.digest === 'string' && typeof r.seen_at === 'string' && isFiles(r.files) && Array.isArray(r.changes) && r.changes.every(isChange);
const isViewed = (v: unknown): v is AuditViewed => isObj(v) && typeof v.digest === 'string' && typeof v.at === 'string' && isFiles(v.files);

/** A file that cannot be trusted as an audit record is moved aside (audit.json.corrupt-<timestamp>) and one loud
 *  warning names it, so the next write starts a fresh record without silently losing what was there. */
function setAside(file: string, why: string): void {
  const aside = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  try {
    ownRename(file, aside);
    console.warn(`[plugins] AUDIT RECORD UNREADABLE: ${file} ${why}. Kept as ${aside}; starting a fresh record. Anything recorded before is only in that copy.`);
  } catch (e) {
    console.warn(`[plugins] AUDIT RECORD UNREADABLE: ${file} ${why}, and it could not be moved aside (${e instanceof Error ? e.message : String(e)}). The next write will replace it.`);
  }
}

/** Read the audit file. Missing: empty. Malformed: empty, with the file kept aside and a warning; a bad entry
 *  inside a good file is dropped. Never throws. */
export function readAudit(file: string): AuditFile {
  const empty = (): AuditFile => ({ version: 1, plugins: {} });
  if (!existsSync(file)) return empty();
  let raw: unknown;
  try { raw = JSON.parse(readOwnText(file)); } catch (e) {
    if (e instanceof OwnFileRefused) { console.warn(`[plugins] the audit file ${e.message}`); return empty(); } // (a link planted at the audit file: not read, not set aside)
    setAside(file, `is not valid JSON (${e instanceof Error ? e.message : String(e)})`); return empty();
  }
  if (!isObj(raw) || raw.version !== 1 || !isObj(raw.plugins)) { setAside(file, 'is not an audit file (expected {"version": 1, "plugins": {...}})'); return empty(); }
  const out = empty();
  for (const [id, e] of Object.entries(raw.plugins)) {
    if (!isObj(e) || !Array.isArray(e.entries) || !e.entries.every(isRecord)) continue;
    out.plugins[id] = { entries: (e.entries as AuditRecord[]).slice(-AUDIT_HISTORY), ...(isViewed(e.viewed) && { viewed: e.viewed }) };
  }
  return out;
}

/** Atomic: a temp file in the same folder, then a rename. */
export function writeAudit(file: string, audit: AuditFile): void {
  ownMkdir(dirname(file), { recursive: true });
  ownWriteFileAtomic(file, JSON.stringify(audit, null, 2) + '\n');
}

export interface NoteResult { record: AuditRecord; /** True when this call wrote a new record. */ changed: boolean }

/** Compare `now` with the last recorded digest of plugin `id`; when it differs (or nothing was recorded),
 *  record it as the new last seen with its changes. `seedFrom` gives the person-mode ratified entry, asked for once, only when nothing is recorded yet, and used as
 *  the first record (already viewed) so a plugin that was ratified before the switch to companion mode does not
 *  show up as new. Writes nothing when the digest is unchanged. */
export function noteDigest(file: string, id: string, now: DigestResult, seedFrom?: () => LedgerEntry | undefined, at: Date = new Date()): NoteResult {
  const audit = readAudit(file);
  let entry = audit.plugins[id];
  let dirty = false;
  if (!entry) {
    entry = { entries: [] };
    const seed = seedFrom?.();
    if (seed) {
      entry.entries.push({ digest: seed.digest, files: seed.files, seen_at: seed.ratified_at, changes: [] });
      entry.viewed = { digest: seed.digest, files: seed.files, at: seed.ratified_at };
    }
    audit.plugins[id] = entry;
    dirty = true;
  }
  const last = entry.entries[entry.entries.length - 1];
  if (last && last.digest === now.digest) {
    if (dirty) writeAudit(file, audit);
    return { record: last, changed: false };
  }
  const record: AuditRecord = { digest: now.digest, files: now.files, seen_at: at.toISOString(), changes: diffFiles(last?.files ?? {}, now.files) };
  entry.entries = [...entry.entries, record].slice(-AUDIT_HISTORY);
  writeAudit(file, audit);
  return { record, changed: true };
}

/** What the list shows for plugin `id`: null when nothing was ever recorded for it. */
export function auditSummary(file: string, id: string): AuditSummary | null {
  const entry = readAudit(file).plugins[id];
  const last = entry?.entries[entry.entries.length - 1];
  if (!entry || !last) return null;
  const seen = entry.viewed?.digest === last.digest;
  return {
    digest: last.digest,
    last_change_at: last.seen_at,
    changed_since_last_view: !seen,
    changes: seen ? [] : diffFiles(entry.viewed?.files ?? {}, last.files),
  };
}

/** The history of plugin `id`, oldest first (at most AUDIT_HISTORY). */
export function auditHistory(file: string, id: string): AuditRecord[] {
  return readAudit(file).plugins[id]?.entries ?? [];
}

/** The person has looked at the code recorded as last seen: remember it. With `expected`, only when that is still the
 *  last recorded digest (never mark blind); returns false (and writes nothing) when it is not, or nothing is recorded. */
export function markSeen(file: string, id: string, expected?: string, at: Date = new Date()): boolean {
  const audit = readAudit(file);
  const entry = audit.plugins[id];
  const last = entry?.entries[entry.entries.length - 1];
  if (!entry || !last) return false;
  if (expected !== undefined && expected !== last.digest) return false;
  entry.viewed = { digest: last.digest, files: last.files, at: at.toISOString() };
  writeAudit(file, audit);
  return true;
}
