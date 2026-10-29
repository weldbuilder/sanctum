import { describe, it, expect, afterAll, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AUDIT_HISTORY, auditHistory, auditPath, auditSummary, markSeen, noteDigest, readAudit } from './plugin-audit.js';

const tmp = mkdtempSync(join(tmpdir(), 'sanctum-audit-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const fileFor = () => auditPath(join(tmp, `d${n++}`));
const d = (digest: string, files: Record<string, string>) => ({ digest, files });

describe('plugin audit record', () => {
  it('records the first sight as every file added, and nothing for the same digest again', () => {
    const f = fileFor();
    const a = noteDigest(f, 'p', d('1'.repeat(64), { 'a.mjs': 'x', 'b.md': 'y' }), undefined, new Date('2026-10-20T10:00:00Z'));
    expect(a.changed).toBe(true);
    expect(a.record.changes).toEqual([{ path: 'a.mjs', kind: 'added' }, { path: 'b.md', kind: 'added' }].sort((p, q) => (p.path < q.path ? -1 : 1)));
    expect(a.record.seen_at).toBe('2026-10-20T10:00:00.000Z');
    const before = readFileSync(f, 'utf-8');
    const b = noteDigest(f, 'p', d('1'.repeat(64), { 'a.mjs': 'x', 'b.md': 'y' }));
    expect(b.changed).toBe(false);
    expect(readFileSync(f, 'utf-8')).toBe(before); // nothing rewritten
  });

  it('a different digest is recorded with the files that changed, no person action', () => {
    const f = fileFor();
    noteDigest(f, 'p', d('a', { 'a.mjs': '1', 'b.md': '1' }));
    const r = noteDigest(f, 'p', d('b', { 'a.mjs': '2', 'c.md': '1' }));
    expect(r.changed).toBe(true);
    expect(r.record.changes).toEqual([{ path: 'a.mjs', kind: 'modified' }, { path: 'b.md', kind: 'removed' }, { path: 'c.md', kind: 'added' }]);
    expect(auditHistory(f, 'p').map((e) => e.digest)).toEqual(['a', 'b']);
  });

  it('keeps the last 20 entries per plugin, and other plugins are separate', () => {
    const f = fileFor();
    for (let i = 0; i < AUDIT_HISTORY + 7; i++) noteDigest(f, 'p', d(`d${i}`, { 'a.mjs': String(i) }));
    noteDigest(f, 'q', d('q0', { 'q.mjs': '0' }));
    const h = auditHistory(f, 'p');
    expect(h).toHaveLength(AUDIT_HISTORY);
    expect(h[0].digest).toBe('d7');
    expect(h[h.length - 1].digest).toBe(`d${AUDIT_HISTORY + 6}`);
    expect(auditHistory(f, 'q')).toHaveLength(1);
  });

  it('summary: changed since last view until marked as seen; then only later changes, measured from what was seen', () => {
    const f = fileFor();
    expect(auditSummary(f, 'p')).toBeNull();
    noteDigest(f, 'p', d('v1', { 'a.mjs': '1' }), undefined, new Date('2026-10-20T10:00:00Z'));
    expect(auditSummary(f, 'p')).toMatchObject({ digest: 'v1', changed_since_last_view: true, last_change_at: '2026-10-20T10:00:00.000Z', changes: [{ path: 'a.mjs', kind: 'added' }] });
    expect(markSeen(f, 'p')).toBe(true);
    expect(auditSummary(f, 'p')).toMatchObject({ changed_since_last_view: false, changes: [] });
    noteDigest(f, 'p', d('v2', { 'a.mjs': '2' }));
    noteDigest(f, 'p', d('v3', { 'a.mjs': '2', 'new.md': '1' }));
    // two edits since the last look: both show, against what was viewed
    expect(auditSummary(f, 'p')).toMatchObject({ digest: 'v3', changed_since_last_view: true, changes: [{ path: 'a.mjs', kind: 'modified' }, { path: 'new.md', kind: 'added' }] });
  });

  it('markSeen with an expected digest never marks blind', () => {
    const f = fileFor();
    noteDigest(f, 'p', d('v1', { 'a.mjs': '1' }));
    noteDigest(f, 'p', d('v2', { 'a.mjs': '2' }));
    expect(markSeen(f, 'p', 'v1')).toBe(false);
    expect(auditSummary(f, 'p')?.changed_since_last_view).toBe(true);
    expect(markSeen(f, 'p', 'v2')).toBe(true);
    expect(auditSummary(f, 'p')?.changed_since_last_view).toBe(false);
    expect(markSeen(f, 'nobody')).toBe(false);
  });

  it('a ratified entry seeds the first record as already viewed', () => {
    const f = fileFor();
    const seed = { digest: 'r1', files: { 'a.mjs': '1' }, ratified_at: '2026-10-01T00:00:00.000Z', root: '/x' };
    noteDigest(f, 'p', d('r1', { 'a.mjs': '1' }), () => seed);
    expect(auditSummary(f, 'p')).toMatchObject({ changed_since_last_view: false, changes: [], last_change_at: '2026-10-01T00:00:00.000Z' });
    noteDigest(f, 'p', d('r2', { 'a.mjs': '2' }), () => { throw new Error('asked twice'); });
    expect(auditSummary(f, 'p')).toMatchObject({ changed_since_last_view: true, changes: [{ path: 'a.mjs', kind: 'modified' }] });
  });

  it('writes atomically (no temp file left) and a damaged file reads as empty', () => {
    const f = fileFor();
    noteDigest(f, 'p', d('v1', { 'a.mjs': '1' }));
    expect(readdirSync(join(f, '..'))).toEqual(['audit.json']);
    writeFileSync(f, '{ not json');
    expect(readAudit(f)).toEqual({ version: 1, plugins: {} });
    writeFileSync(f, JSON.stringify({ version: 2, plugins: {} }));
    expect(readAudit(f).plugins).toEqual({});
    writeFileSync(f, JSON.stringify({ version: 1, plugins: { ok: { entries: [{ digest: 'a', files: {}, seen_at: 't', changes: [] }] }, bad: { entries: [{ nope: 1 }] } } }));
    expect(Object.keys(readAudit(f).plugins)).toEqual(['ok']);
  });
});

describe('a malformed audit file', () => {
  it('is kept aside as audit.json.corrupt-<timestamp>, one loud warning names the file, and a fresh record is written', () => {
    const f = fileFor();
    mkdirSync(join(f, '..'), { recursive: true });
    writeFileSync(f, '{ "version": 1, "plugins": { broken');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(readAudit(f)).toEqual({ version: 1, plugins: {} });
      expect(warn).toHaveBeenCalledTimes(1);
      const msg = String(warn.mock.calls[0][0]);
      expect(msg).toContain(f);
      expect(msg).toMatch(/corrupt-/);
      const aside = readdirSync(join(f, '..')).filter((x) => x.startsWith('audit.json.corrupt-'));
      expect(aside).toHaveLength(1);
      expect(readFileSync(join(f, '..', aside[0]), 'utf-8')).toBe('{ "version": 1, "plugins": { broken');
      readAudit(f); // the bad file is gone from its place: no second warning
      expect(warn).toHaveBeenCalledTimes(1);
      noteDigest(f, 'p', d('1', { 'a.mjs': 'x' }));
      expect(auditHistory(f, 'p')).toHaveLength(1);
      expect(readdirSync(join(f, '..')).filter((x) => x.startsWith('audit.json.corrupt-'))).toEqual(aside);
    } finally { warn.mockRestore(); }
  });
  it('a wrong shape (valid JSON, not an audit file) is treated the same; a missing file is silent', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const f = fileFor();
      expect(readAudit(f)).toEqual({ version: 1, plugins: {} }); // missing
      expect(warn).not.toHaveBeenCalled();
      mkdirSync(join(f, '..'), { recursive: true });
      writeFileSync(f, '[1,2,3]');
      readAudit(f);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(readdirSync(join(f, '..')).some((x) => x.startsWith('audit.json.corrupt-'))).toBe(true);
    } finally { warn.mockRestore(); }
  });
});
