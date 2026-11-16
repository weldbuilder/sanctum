// The reference library: limits, names, the self cap, the library cap, sniffed type and orphan tolerance (real database, real file store in a temp folder).
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { rmSync, existsSync, unlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const h = vi.hoisted(() => ({ top: '' }));
vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  h.top = fs.mkdtempSync(path.join(os.tmpdir(), 'refs-'));
  const cfg = { identity: { companion_name: 'Echo', user_name: 'Sam', timezone: 'UTC' }, agent: { app_write: true, cwd: h.top }, imagegen: { provider: 'none' } };
  return { ...actual, PROJECT_ROOT: h.top, getSanctumConfig: () => cfg };
});

import { initDb, getDb } from '../db.js';
import {
  addReference, updateReference, removeReference, listReferences, countReferences, referenceByName, referenceById, selfReferences,
  referenceNameList, readReferenceBytes, ReferenceError,
  REFERENCE_MAX_BYTES, REFERENCE_MAX_COUNT, REFERENCE_SELF_MAX,
} from './references.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const GIF = Buffer.from('R0lGODlhAQABAAAAACw=', 'base64');
const filesDir = () => join(h.top, 'data', 'files');
const add = (name: string, extra: Partial<Parameters<typeof addReference>[0]> = {}) => addReference({ name, buffer: PNG, filename: 'a.png', mime: 'image/png', ...extra });
const code = (fn: () => unknown): string | undefined => { try { fn(); } catch (e) { return (e as ReferenceError).code; } return undefined; };

beforeAll(() => { initDb(':memory:'); });
afterAll(() => rmSync(h.top, { recursive: true, force: true }));
beforeEach(() => { getDb().prepare('DELETE FROM "references"').run(); });

describe('reference library', () => {
  it('stores the picture in the file store with source "reference" and reads it back', () => {
    const r = add('Echo', { self: true, note: '  Echo in the   green coat ' });
    expect(r).toMatchObject({ name: 'Echo', self: true, note: 'Echo in the green coat' });
    expect(JSON.parse(require('node:fs').readFileSync(join(filesDir(), `${r.file_id}.meta.json`), 'utf-8')).source).toBe('reference');
    expect(readReferenceBytes(r)?.bytes.equals(PNG)).toBe(true);
    expect(readReferenceBytes(r)?.mime).toBe('image/png');
    expect(referenceById(r.id)?.self).toBe(true);
    expect(referenceByName('ECHO')?.id).toBe(r.id);
  });

  it('name rules: required, edge spaces, 40 characters, no brackets, colon, comma, bar or newline; unique without case', () => {
    expect(code(() => add('   '))).toBe('name_required');
    expect(code(() => add(' Sam'))).toBe('name_invalid');
    expect(code(() => add('x'.repeat(41)))).toBe('name_too_long');
    for (const bad of ['a[b', 'a]b', 'a:b', 'a,b', 'a|b', 'a\nb']) expect(code(() => add(bad)), bad).toBe('name_invalid');
    expect(() => add('x'.repeat(40))).not.toThrow();
    add('Sam');
    expect(code(() => add('sAM'))).toBe('name_taken');
    expect(countReferences()).toBe(2);
  });

  it('refuses a note over 200 characters, a fake or gif picture, and more than 1 MB', () => {
    expect(code(() => add('A', { note: 'n'.repeat(201) }))).toBe('note_too_long');
    expect(() => add('A', { note: 'n'.repeat(200) })).not.toThrow();
    expect(code(() => add('B', { buffer: Buffer.from('not a picture') }))).toBe('not_image');
    expect(code(() => add('C', { buffer: GIF }))).toBe('not_image');
    expect(code(() => add('D', { buffer: Buffer.concat([PNG, Buffer.alloc(REFERENCE_MAX_BYTES)]) }))).toBe('too_large');
    expect(countReferences()).toBe(1);
  });

  it('trusts the sniffed type over the claimed one', () => {
    const r = add('Real', { mime: 'text/plain', filename: 'x.txt' });
    expect(readReferenceBytes(r)?.mime).toBe('image/png');
  });

  it('caps the companion\'s own pictures at 4, on add and on update; the library at 12', () => {
    for (let i = 0; i < REFERENCE_SELF_MAX; i++) add(`Me ${i}`, { self: true });
    expect(code(() => add('Me 5', { self: true }))).toBe('self_limit');
    const other = add('Lake house');
    expect(code(() => updateReference(other.id, { self: true }))).toBe('self_limit');
    expect(updateReference(selfReferences()[0].id, { self: true }).self).toBe(true); // already self: no change, no error
    expect(updateReference(selfReferences()[0].id, { self: false }).self).toBe(false);
    expect(updateReference(other.id, { self: true }).self).toBe(true);
    for (let i = countReferences(); i < REFERENCE_MAX_COUNT; i++) add(`Thing ${i}`);
    expect(countReferences()).toBe(REFERENCE_MAX_COUNT);
    expect(code(() => add('One more'))).toBe('library_full');
  });

  it('selfReferences come in the order they were added', () => {
    add('B', { self: true }); add('A', { self: true }); add('C');
    expect(selfReferences().map((r) => r.name)).toEqual(['B', 'A']);
  });

  it('update changes the note and keeps the rest; unknown id is not_found', () => {
    const r = add('Sam', { note: 'old' });
    const u = updateReference(r.id, { note: ' new note ' });
    expect(u).toMatchObject({ self: false, note: 'new note' });
    expect(referenceById(r.id)?.note).toBe('new note');
    expect(code(() => updateReference(r.id, { note: 'n'.repeat(201) }))).toBe('note_too_long');
    expect(code(() => updateReference('nope', { note: 'x' }))).toBe('not_found');
  });

  it('name list: the companion\'s own marked, 20 then "and N more"', () => {
    expect(referenceNameList()).toBe('');
    add('Sam'); add('Echo', { self: true });
    expect(referenceNameList()).toBe('Echo (you), Sam');
    getDb().prepare('DELETE FROM "references"').run();
    for (let i = 0; i < 12; i++) add(`N${String(i).padStart(2, '0')}`);
    expect(referenceNameList(5)).toBe('N00, N01, N02, N03, N04, and 7 more');
  });

  it('remove drops the row and the file; a missing file does not stop it; unknown id is false', () => {
    const a = add('A'); const b = add('B');
    expect(removeReference(a.id)).toBe(true);
    expect(existsSync(join(filesDir(), `${a.file_id}.png`))).toBe(false);
    for (const f of readdirSync(filesDir())) if (f.startsWith(b.file_id) && !f.endsWith('.json')) unlinkSync(join(filesDir(), f));
    expect(readReferenceBytes(b)).toBeNull();
    expect(removeReference(b.id)).toBe(true);
    expect(removeReference(b.id)).toBe(false);
    expect(listReferences()).toEqual([]);
  });

  it('a failed insert deletes the stored file', () => {
    const before = readdirSync(filesDir()).length;
    getDb().prepare('DROP TABLE "references"').run();
    expect(() => add('Doomed')).toThrow();
    expect(readdirSync(filesDir()).length).toBe(before);
    getDb().exec('CREATE TABLE "references" (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, file_id TEXT NOT NULL, self INTEGER NOT NULL DEFAULT 0, note TEXT NOT NULL DEFAULT \'\', created_at TEXT NOT NULL)');
  });
});
