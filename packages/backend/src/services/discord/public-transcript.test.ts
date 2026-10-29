// The public lane's record (docs/DISCORD-PLAN.md, "Records"): one append-only JSONL file per channel,
// data/discord/public/<guildId>/<channelId>.jsonl. Nothing from it becomes memory on its own, so
// nothing outside the Discord module may read it.
import { describe, it, expect, afterAll } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTranscript } from './public-transcript.js';
import { isInsideDiscordFolder, touchesPublicTranscript } from './transcript-scan.js';

const tmp = mkdtempSync(join(tmpdir(), 'sanctum-transcript-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const fresh = () => join(tmp, `root${n++}`);

const who = { id: '333', name: 'Moss (@moss)', bot: false };
const where = { guild: '500', channel: '600' };

describe('the file', () => {
  it('lives at <root>/<guildId>/<channelId>.jsonl, owner-only: files 0600, folders 0700', () => {
    const root = fresh();
    const t = createTranscript(() => root);
    t.append({ kind: 'in', who, where, text: 'hello there', len: 11 });
    const file = join(root, '500', '600.jsonl');
    expect(existsSync(file)).toBe(true);
    if (process.platform !== 'win32') { // POSIX modes; Windows relies on the user profile ACL
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(join(root, '500')).mode & 0o777).toBe(0o700);
      expect(statSync(root).mode & 0o777).toBe(0o700);
    }
  });

  it('is append-only: one JSON line per event, earlier lines never rewritten', () => {
    const root = fresh();
    const t = createTranscript(() => root, () => new Date('2026-10-19T10:00:00Z'));
    t.append({ kind: 'in', who, where, text: 'one', len: 3 });
    const first = readFileSync(join(root, '500', '600.jsonl'), 'utf-8');
    t.append({ kind: 'out', who: { id: '900', name: 'her', bot: true }, where, text: 'two', len: 3 });
    const all = readFileSync(join(root, '500', '600.jsonl'), 'utf-8');
    expect(all.startsWith(first)).toBe(true);
    const lines = all.trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({ ts: '2026-10-19T10:00:00.000Z', kind: 'in', who, where, text: 'one', len: 3 });
    expect(lines[1].kind).toBe('out');
  });

  it('a thread is recorded in where.thread, in its parent channel\'s file', () => {
    const root = fresh();
    const t = createTranscript(() => root);
    t.append({ kind: 'in', who, where: { ...where, thread: '777' }, text: 'x', len: 1 });
    const line = JSON.parse(readFileSync(join(root, '500', '600.jsonl'), 'utf-8'));
    expect(line.where).toEqual({ guild: '500', channel: '600', thread: '777' });
  });

  it('refuses ids that are not plain digits (no path walking), and writes nothing', () => {
    const root = fresh();
    const t = createTranscript(() => root);
    expect(() => t.append({ kind: 'in', who, where: { guild: '..', channel: '600' }, text: 'x', len: 1 })).toThrow();
    expect(() => t.append({ kind: 'in', who, where: { guild: '500', channel: '../../x' }, text: 'x', len: 1 })).toThrow();
    expect(existsSync(root) ? readdirSync(root) : []).toEqual([]);
  });
});

describe('blocked and error lines carry no text', () => {
  it('a blocked line keeps reason, hits and len, and drops any text it was handed', () => {
    const root = fresh();
    const t = createTranscript(() => root);
    t.append({ kind: 'blocked', who: { id: '900', name: 'her', bot: true }, where, reason: 'word', hits: ['Janie'], len: 42, text: 'the reply that said Janie' } as any);
    const raw = readFileSync(join(root, '500', '600.jsonl'), 'utf-8');
    expect(raw).not.toContain('the reply');
    const line = JSON.parse(raw);
    expect(line).toMatchObject({ kind: 'blocked', reason: 'word', hits: ['Janie'], len: 42 });
    expect('text' in line).toBe(false);
  });

  it('an error line keeps the error class and len 0, never a message', () => {
    const root = fresh();
    const t = createTranscript(() => root);
    t.append({ kind: 'error', who: { id: '900', name: 'her', bot: true }, where, reason: 'SpawnError', len: 0, text: 'ENOENT /home/x/secret' } as any);
    const raw = readFileSync(join(root, '500', '600.jsonl'), 'utf-8');
    expect(raw).not.toContain('/home/x');
    expect(JSON.parse(raw)).toMatchObject({ kind: 'error', reason: 'SpawnError', len: 0 });
  });
});

describe('tail: the last N lines of THIS channel, for the frame', () => {
  it('returns the last N in and out lines of this channel only, oldest first', () => {
    const root = fresh();
    const t = createTranscript(() => root);
    for (let i = 1; i <= 20; i++) t.append({ kind: i % 2 ? 'in' : 'out', who, where, text: `m${i}`, len: 2 });
    t.append({ kind: 'in', who, where: { guild: '500', channel: '601' }, text: 'other channel', len: 13 });
    t.append({ kind: 'blocked', who, where, reason: 'word', hits: ['x'], len: 3 });
    const tail = t.tail('500', '600', 12);
    expect(tail.map((l) => l.text)).toEqual(Array.from({ length: 12 }, (_, i) => `m${i + 9}`));
    expect(tail.every((l) => l.kind === 'in' || l.kind === 'out')).toBe(true);
  });

  it('a missing file, a bad id and a damaged line all give what can be read, never a throw', () => {
    const root = fresh();
    const t = createTranscript(() => root);
    expect(t.tail('500', '600', 12)).toEqual([]);
    expect(t.tail('..', '600', 12)).toEqual([]);
    t.append({ kind: 'in', who, where, text: 'ok', len: 2 });
    writeFileSync(join(root, '500', '600.jsonl'), `{not json\n${readFileSync(join(root, '500', '600.jsonl'), 'utf-8')}`);
    expect(t.tail('500', '600', 12).map((l) => l.text)).toEqual(['ok']);
  });
});

// SHOULD-FIX 2: tail() is per place. A message in thread T gets T's lines; a message in the channel gets the lines with no thread.
describe('tail() isolates threads', () => {
  const put = (t: ReturnType<typeof createTranscript>, text: string, thread?: string) =>
    t.append({ kind: 'in', who, where: { guild: '500', channel: '600', ...(thread ? { thread } : {}) }, text, len: text.length });

  it('for a thread: only lines whose where.thread is that thread', () => {
    const root = fresh();
    const t = createTranscript(() => root);
    put(t, 'c1'); put(t, 'a1', '777'); put(t, 'b1', '888'); put(t, 'a2', '777'); put(t, 'c2');
    expect(t.tail('500', '600', 12, '777').map((l) => l.text)).toEqual(['a1', 'a2']);
    expect(t.tail('500', '600', 12, '888').map((l) => l.text)).toEqual(['b1']);
    expect(t.tail('500', '600', 12, '999')).toEqual([]);
  });

  it('for the channel itself: only lines with no thread', () => {
    const root = fresh();
    const t = createTranscript(() => root);
    put(t, 'c1'); put(t, 'a1', '777'); put(t, 'c2'); put(t, 'b1', '888');
    expect(t.tail('500', '600', 12).map((l) => l.text)).toEqual(['c1', 'c2']);
  });

  it('n counts the lines of that place, not of the file', () => {
    const root = fresh();
    const t = createTranscript(() => root);
    put(t, 'a1', '777');
    for (let i = 0; i < 20; i++) put(t, `noise-${i}`, '888');
    put(t, 'a2', '777');
    expect(t.tail('500', '600', 2, '777').map((l) => l.text)).toEqual(['a1', 'a2']);
  });

  it('a thread id that is not digits matches nothing', () => {
    const root = fresh();
    const t = createTranscript(() => root);
    put(t, 'c1'); put(t, 'a1', '777');
    expect(t.tail('500', '600', 12, '../x')).toEqual([]);
  });
});

describe('the scan that keeps the public transcript inside services/discord (SHOULD-FIX 6)', () => {
  const D = join('/repo', 'packages', 'backend', 'src', 'services', 'discord');
  const S = join('/repo', 'packages', 'backend', 'src', 'services');

  it('scans a sibling whose name merely starts with "discord" (services/discord-zz.ts is outside the folder)', () => {
    expect(isInsideDiscordFolder(join(S, 'discord-zz.ts'), S)).toBe(false);
    expect(isInsideDiscordFolder(join(S, 'discord.ts'), S)).toBe(false);
    expect(isInsideDiscordFolder(join(D, 'send.ts'), S)).toBe(true);
    expect(isInsideDiscordFolder(join(D, 'sub', 'x.ts'), S)).toBe(true);
  });

  it('flags an import, the data path as text, and a path built with join()', () => {
    for (const code of [
      "import { publicTranscript } from './discord/public-transcript.js';",
      "const p = 'data/discord/public/1/2.jsonl';",
      "const p = join(dataDir, 'discord', 'public', g, c + '.jsonl');",
      'const p = join(dataDir, "discord", "public");',
      "path.resolve(root, 'discord',\n  'public')",
      "const p = [dir, 'discord', 'public'].join('/');",
    ]) expect(touchesPublicTranscript(code), code).toBe(true);
  });

  it('does not flag unrelated text', () => {
    for (const code of ["join(dir, 'discord', 'run')", "const publicKey = 1; // discord", "import { x } from './discord/send.js';"]) {
      expect(touchesPublicTranscript(code), code).toBe(false);
    }
  });
});

describe('nothing outside services/discord reads the public transcript', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = join(here, '..', '..');
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const p = join(d, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' || e.name === 'dist' ? [] : walk(p);
    return /\.(ts|mjs|js)$/.test(e.name) ? [p] : [];
  });

  it('no module outside services/discord imports public-transcript or names its data folder', () => {
    const offenders = walk(src)
      .filter((p) => !isInsideDiscordFolder(p, join(src, 'services')) && !/\.test\./.test(p))
      .filter((p) => touchesPublicTranscript(readFileSync(p, 'utf-8')));
    expect(offenders).toEqual([]);
  });

  it('and neither the Revien nor the Mind code names the folder (no path, no import)', () => {
    for (const f of ['revien.ts', 'hooks.ts', 'rolling-history.ts', 'rolling-context.ts']) {
      const text = readFileSync(join(src, 'services', f), 'utf-8');
      expect(text, f).not.toMatch(/public-transcript|discord\/public/);
    }
  });
});

describe('attachments count (D4)', () => {
  it('an in line carries attachments: n when there were any, and only then', () => {
    const root = fresh();
    const t = createTranscript(() => root);
    t.append({ kind: 'in', who, where, text: 'with', len: 4, attachments: 2 });
    t.append({ kind: 'in', who, where, text: 'without', len: 7 });
    const rows = readFileSync(join(root, '500', '600.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    expect(rows[0].attachments).toBe(2);
    expect('attachments' in rows[1]).toBe(false);
  });

  it('is dropped from any other kind of line', () => {
    const root = fresh();
    const t = createTranscript(() => root);
    t.append({ kind: 'out', who, where, text: 'x', len: 1, attachments: 3 });
    expect('attachments' in JSON.parse(readFileSync(join(root, '500', '600.jsonl'), 'utf-8').trim())).toBe(false);
  });
});
