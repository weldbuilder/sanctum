// generateImage with references: resolution order, de-duplication, the cap, unknown names, the model switch (real database and file store, adapters stubbed).
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { rmSync } from 'node:fs';

const h = vi.hoisted(() => ({
  top: '',
  cfg: {} as Record<string, unknown>,
  calls: [] as any[],
  messages: [] as any[],
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  h.top = fs.mkdtempSync(path.join(os.tmpdir(), 'imgidx-'));
  const cfg = { identity: { companion_name: 'Echo', user_name: 'Sam', timezone: 'UTC' }, agent: { app_write: true, cwd: h.top }, get imagegen() { return h.cfg; } };
  return { ...actual, PROJECT_ROOT: h.top, getSanctumConfig: () => cfg };
});
vi.mock('../ws.js', async () => {
  const actual = await vi.importActual<typeof import('../ws.js')>('../ws.js');
  return { ...actual, registry: { ...actual.registry, broadcast: vi.fn() } };
});
vi.mock('./runware.js', async () => {
  const actual = await vi.importActual<typeof import('./runware.js')>('./runware.js');
  return { ...actual, createRunwareProvider: () => ({ name: 'runware', generate: async (req: any) => { h.calls.push({ provider: 'runware', req }); return { bytes: Buffer.from('out'), mime: 'image/png', model: req.model }; } }) };
});
vi.mock('./replicate.js', async () => {
  const actual = await vi.importActual<typeof import('./replicate.js')>('./replicate.js');
  return { ...actual, createReplicateProvider: () => ({ name: 'replicate', generate: async (req: any) => { h.calls.push({ provider: 'replicate', req }); return { bytes: Buffer.from('out'), mime: 'image/png', model: req.model }; } }) };
});

import { initDb, getDb, createThread, getMessages } from '../db.js';
import { addReference } from '../media/references.js';
import { generateImage, imagegenStatus, resolveReferences, DEFAULT_REFERENCE_MODEL } from './index.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const add = (name: string, self = false) => addReference({ name, self, buffer: PNG, filename: `${name}.png`, mime: 'image/png' });
const base = { prompt: 'a lake at dusk', postToChat: false };

beforeAll(() => { initDb(':memory:'); });
afterAll(() => rmSync(h.top, { recursive: true, force: true }));
beforeEach(() => {
  h.cfg = { provider: 'runware', model: 'runware:101@1', reference_model: '', size: '1024x1024', safety_checker: false, timeout_ms: 5000 };
  h.calls.length = 0;
  getDb().prepare('DELETE FROM "references"').run();
  vi.stubEnv('RUNWARE_API_KEY', 'rk'); vi.stubEnv('REPLICATE_API_TOKEN', 'rt');
});
afterEach(() => vi.unstubAllEnvs());

describe('generateImage with references', () => {
  it('no references: the text-only model (cfg.model), no references field on the request, empty reference fields in the result', async () => {
    add('Echo', true);
    const r = await generateImage(base);
    expect(h.calls[0].req.model).toBe('runware:101@1');
    expect('references' in h.calls[0].req).toBe(false);
    expect(r).toMatchObject({ references: [], unknown_references: [], as_self: false, model: 'runware:101@1' });
  });

  it('named references: the default reference model per provider, never cfg.model; bytes and mime reach the adapter', async () => {
    add('Sam');
    const r = await generateImage({ ...base, references: ['sAM'] });
    expect(h.calls[0].req.model).toBe('bfl:3@1');
    expect(h.calls[0].req.references).toEqual([{ bytes: PNG, mime: 'image/png', name: 'Sam' }]);
    expect(r).toMatchObject({ references: ['Sam'], as_self: false, model: 'bfl:3@1' });
    h.cfg.provider = 'replicate';
    await generateImage({ ...base, references: ['Sam'] });
    expect(h.calls[1]).toMatchObject({ provider: 'replicate', req: { model: 'black-forest-labs/flux-kontext-pro' } });
    expect(DEFAULT_REFERENCE_MODEL).toEqual({ runware: 'bfl:3@1', replicate: 'black-forest-labs/flux-kontext-pro' });
  });

  it('cfg.reference_model wins when set (for its own provider only)', async () => {
    add('Sam');
    h.cfg.reference_model = 'bfl:4@1';
    await generateImage({ ...base, references: ['Sam'] });
    expect(h.calls[0].req.model).toBe('bfl:4@1');
    await generateImage({ ...base, provider: 'replicate', references: ['Sam'] });
    expect(h.calls[1].req.model).toBe('black-forest-labs/flux-kontext-pro');
  });

  it('as self: own references first in the order added, then the named ones; de-duplicated', async () => {
    add('Lake house'); add('Echo front', true); add('Sam'); add('Echo side', true);
    const r = await generateImage({ ...base, asSelf: true, references: ['Sam', 'echo side', 'Lake house'] });
    expect(h.calls[0].req.references.map((x: any) => x.name)).toEqual(['Echo front', 'Echo side', 'Sam', 'Lake house']);
    expect(r.references).toEqual(['Echo front', 'Echo side', 'Sam', 'Lake house']);
    expect(r.as_self).toBe(true);
  });

  it('caps at four, self first, so named ones are the ones dropped', async () => {
    for (const n of ['M1', 'M2', 'M3']) add(n, true);
    add('A'); add('B');
    const r = await generateImage({ ...base, asSelf: true, references: ['A', 'B'] });
    expect(r.references).toEqual(['M1', 'M2', 'M3', 'A']);
    const only = await generateImage({ ...base, references: ['A', 'B', 'M1', 'M2', 'M3'] });
    expect(only.references).toEqual(['A', 'B', 'M1', 'M2']);
  });

  it('unknown names are skipped and reported; with nothing left it behaves as text-only', async () => {
    add('Sam');
    const r = await generateImage({ ...base, references: ['Nobody', 'Sam', 'Ghost'] });
    expect(r.references).toEqual(['Sam']);
    expect(r.unknown_references).toEqual(['Nobody', 'Ghost']);
    const none = await generateImage({ ...base, references: ['Nobody'] });
    expect(none).toMatchObject({ references: [], unknown_references: ['Nobody'], model: 'runware:101@1' });
    expect('references' in h.calls[1].req).toBe(false);
  });

  it('as self with no own references is a plain picture (as_self false)', async () => {
    add('Sam');
    const r = await generateImage({ ...base, asSelf: true });
    expect(r).toMatchObject({ references: [], as_self: false, model: 'runware:101@1' });
    expect('references' in h.calls[0].req).toBe(false);
  });

  it('a reference whose file is gone is skipped, not fatal', async () => {
    const gone = add('Gone'); add('Sam');
    const { deleteFile } = await import('../files.js');
    deleteFile(gone.file_id);
    const r = await generateImage({ ...base, references: ['Gone', 'Sam'] });
    expect(r.references).toEqual(['Sam']);
  });

  it('the posted message records the names, as_self and the model actually used; a text-only one keeps its old shape', async () => {
    add('Echo', true);
    createThread({ id: 'th-1', name: 'T', type: 'named', createdAt: new Date().toISOString() });
    await generateImage({ prompt: 'Echo on a hill', postToChat: true, threadId: 'th-1', asSelf: true, triggeredBy: 'tag' });
    await generateImage({ prompt: 'a hill', postToChat: true, threadId: 'th-1' });
    const msgs = getMessages({ threadId: 'th-1' }) as any[];
    const withRef = msgs.find((m) => m.metadata.prompt === 'Echo on a hill').metadata;
    expect(withRef).toMatchObject({ references: ['Echo'], as_self: true, model: 'bfl:3@1', triggered_by: 'tag' });
    const plain = msgs.find((m) => m.metadata.prompt === 'a hill').metadata;
    expect('references' in plain).toBe(false);
    expect('as_self' in plain).toBe(false);
  });

  it('the stored picture\'s sidecar names the references (and a text-only one has no such field)', async () => {
    add('Sam');
    const a = await generateImage({ ...base, references: ['Sam'] });
    const b = await generateImage(base);
    const { readFileMeta } = await import('../files.js');
    expect(readFileMeta(a.file_id)).toMatchObject({ source: 'image-gen', references: ['Sam'] });
    expect(readFileMeta(b.file_id) && 'references' in readFileMeta(b.file_id)!).toBe(false);
  });

  it('resolveReferences alone: no names and not self is empty', () => {
    add('Sam');
    expect(resolveReferences(undefined, false)).toEqual({ used: [], unknown: [], asSelf: false });
  });
});

describe('imagegenStatus', () => {
  it('counts references and reports the reference model', () => {
    add('Echo', true); add('Sam');
    expect(imagegenStatus()).toMatchObject({ configured: true, references: 2, self_references: 1, reference_model: 'bfl:3@1' });
    h.cfg.reference_model = 'runware:400@1';
    expect(imagegenStatus().reference_model).toBe('runware:400@1');
    h.cfg.provider = 'none';
    expect(imagegenStatus()).toMatchObject({ configured: false, reference_model: null, references: 2 });
  });
});
