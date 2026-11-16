// [image: a | with: Echo, Sam] and [selfie: ...]: argument split, offering, consent, and the instruction text (real database and library, generateImage recorded).
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { rmSync } from 'node:fs';

const h = vi.hoisted(() => ({ top: '', offered: true, calls: [] as any[] }));
vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  h.top = fs.mkdtempSync(path.join(os.tmpdir(), 'reftags-'));
  const cfg = { identity: { companion_name: 'Echo', user_name: 'Sam', timezone: 'UTC' }, agent: { app_write: true, cwd: h.top }, voice: { enabled: false }, imagegen: { provider: 'none' } };
  return { ...actual, PROJECT_ROOT: h.top, getSanctumConfig: () => cfg };
});
vi.mock('../imagegen/index.js', () => ({ generateImage: async (o: any) => { h.calls.push(o); }, imagegenOffered: () => h.offered }));

import { parseTags, expressionInstructions, getTagDef } from './index.js';
import { splitImageArg } from './builtin.js';
import { initDb, getDb } from '../db.js';
import { addReference } from '../media/references.js';
import { grant, setMode, turnOff } from '../consent/gate.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const add = (name: string, self = false) => addReference({ name, self, buffer: PNG, filename: `${name}.png`, mime: 'image/png' });
const run = async (name: string, arg: string) => { await (getTagDef(name) as any).run({ arg }, { threadId: 'T1', text: 'a reply' }); };

beforeAll(() => { initDb(':memory:'); });
afterAll(() => rmSync(h.top, { recursive: true, force: true }));
beforeEach(() => {
  initDb(':memory:');
  h.offered = true; h.calls = [];
  vi.spyOn(console, 'debug').mockImplementation(() => {});
});

describe('splitImageArg', () => {
  it('no marker: the whole text, no names', () => {
    expect(splitImageArg('a fox in snow')).toEqual({ prompt: 'a fox in snow', names: [] });
  });
  it('splits on the first "| with:" in any case with optional spaces; names trimmed, empties dropped', () => {
    expect(splitImageArg('a lake | with: Echo, Sam')).toEqual({ prompt: 'a lake', names: ['Echo', 'Sam'] });
    expect(splitImageArg('a lake|WITH:Echo ,  Lake house,')).toEqual({ prompt: 'a lake', names: ['Echo', 'Lake house'] });
    expect(splitImageArg('a lake | With : Echo | with: Sam')).toEqual({ prompt: 'a lake', names: ['Echo | with: Sam'] });
    expect(splitImageArg('a lake | with:')).toEqual({ prompt: 'a lake', names: [] });
  });
  it('a bar that is not "with:" stays in the description', () => {
    expect(splitImageArg('red | blue sky')).toEqual({ prompt: 'red | blue sky', names: [] });
  });
  it('the description is capped at 2000 characters after the split', () => {
    const r = splitImageArg(`${'x'.repeat(2500)} | with: Sam`);
    expect(r.prompt).toHaveLength(2000);
    expect(r.names).toEqual(['Sam']);
    expect(splitImageArg('y'.repeat(2500)).prompt).toHaveLength(2000);
  });
});

describe('parsing', () => {
  it('[image: a | with: Echo, Sam] is one image tag whose argument carries the names', () => {
    const p = parseTags('Look [image: a lake at dusk | with: Echo, Sam] done');
    expect(p.tags).toHaveLength(1);
    expect(p.tags[0]).toMatchObject({ name: 'image', arg: 'a lake at dusk | with: Echo, Sam', honoured: true });
    expect(p.clean).toBe('Look done');
  });
  it('[selfie: scene] is honoured once; a second is stripped but not honoured; empty is not an action', () => {
    const p = parseTags('[selfie: at the window] and [selfie: on the porch] and [selfie]');
    expect(p.tags.map((t) => [t.name, t.honoured])).toEqual([['selfie', true], ['selfie', false], ['selfie', false]]);
    expect(p.clean).not.toContain('[selfie');
  });
});

describe('[image] with references', () => {
  it('passes the names through; without the marker it passes none (the call is as it was)', async () => {
    await run('image', 'a lake | with: Echo, Sam');
    expect(h.calls[0]).toEqual({ prompt: 'a lake', references: ['Echo', 'Sam'], postToChat: true, threadId: 'T1', triggeredBy: 'tag' });
    await run('image', 'a lamp');
    expect(h.calls[1]).toEqual({ prompt: 'a lamp', postToChat: true, threadId: 'T1', triggeredBy: 'tag' });
  });
  it('nothing left of the description is not a picture', async () => {
    await run('image', ' | with: Sam');
    expect(h.calls).toEqual([]);
  });
});

describe('[selfie] tag', () => {
  it('offered only when pictures are offered AND a reference marks the companion', () => {
    const def = getTagDef('selfie') as any;
    expect(def.offered()).toBe(false);
    add('Sam');
    expect(def.offered()).toBe(false);
    add('Echo', true);
    expect(def.offered()).toBe(true);
    h.offered = false;
    expect(def.offered()).toBe(false);
    expect(expressionInstructions()).not.toContain('[selfie');
  });
  it('runs as the companion; extra names ride along', async () => {
    add('Echo', true);
    await run('selfie', 'at the window');
    expect(h.calls[0]).toEqual({ prompt: 'at the window', asSelf: true, postToChat: true, threadId: 'T1', triggeredBy: 'tag' });
    await run('selfie', 'on the dock | with: Sam');
    expect(h.calls[1]).toEqual({ prompt: 'on the dock', asSelf: true, references: ['Sam'], postToChat: true, threadId: 'T1', triggeredBy: 'tag' });
  });
  it('consent: app_write off denies it (with a receipt); guard mode needs a window', async () => {
    add('Echo', true);
    turnOff('app_write');
    await run('selfie', 'at the window');
    expect(h.calls).toEqual([]);
    expect(getDb().prepare("SELECT outcome, tool_or_route FROM consent_receipts WHERE capability = 'app_write' AND tool_or_route = '[selfie] tag' AND outcome = 'denied'").all()).toHaveLength(1);
    setMode('guard');
    await run('selfie', 'at the window');
    expect(h.calls).toEqual([]);
    grant('app_write', 30);
    await run('selfie', 'at the window');
    expect(h.calls).toHaveLength(1);
  });
});

describe('instruction text', () => {
  const imageLine = () => (getTagDef('image') as any).instruction as string;
  it('without references the [image] line is the plain one', () => {
    expect(imageLine()).toBe('[image: a short visual description] generates a picture and sends it after this message. Use it when a picture says it better; at most two per reply.');
    expect(expressionInstructions()).not.toContain('with:');
  });
  it('with references it adds the with: form and the real names, your own marked', () => {
    add('Sam'); add('Echo', true);
    expect(imageLine()).toContain('[image: description | with: name, name] using only these names: Echo (you), Sam.');
    expect(imageLine().startsWith('[image: a short visual description] generates')).toBe(true);
    expect(expressionInstructions()).toContain('[selfie: what you are doing and where] sends a picture of yourself, drawn from your reference images. Say the scene, not your looks; those come from the references. At most one per reply.');
  });
  it('a full library of twelve is listed in full', () => {
    for (let i = 0; i < 12; i++) add(`N${String(i).padStart(2, '0')}`);
    expect(imageLine()).toContain('N11.');
  });
});
