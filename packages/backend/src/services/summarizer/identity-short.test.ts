import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildShortIdentity, shortIdentity, SHORT_IDENTITY_CAP } from './identity-short.js';

const names = { companion: 'Echo', user: 'Sam' };
const files = (narr: string, prof = 'Sam is my partner. We live together.') => [{ name: 'profile.md', text: prof }, { name: 'companion.md', text: narr }];

describe('buildShortIdentity', () => {
  it('has the heading, both names, the relationship and the first lines of the voice', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `Voice line ${i + 1} in my own words.`).join('\n');
    const t = buildShortIdentity(names, files(`<!-- delete me -->\n\n${lines}`));
    expect(t.startsWith('## Who you are (short)')).toBe(true);
    expect(t).toContain('You are Echo');
    expect(t).toContain('Sam');
    expect(t).toContain('Sam is my partner');
    expect(t).toContain('Voice line 1 ');
    expect(t).toContain('Voice line 12 ');
    expect(t).not.toContain('Voice line 13 ');
    expect(t).not.toContain('delete me');
  });
  it('prefers a "Summary" section of companion.md', () => {
    const t = buildShortIdentity(names, files('Long intro nobody needs.\n\n## Summary\nI am dry and warm. I tease gently.\n\n## Other\nmore'));
    expect(t).toContain('I am dry and warm.');
    expect(t).not.toContain('Long intro');
  });
  it('never exceeds the cap, however long the files', () => {
    const big = 'x'.repeat(5000);
    const t = buildShortIdentity(names, files(Array.from({ length: 50 }, () => big).join('\n'), Array.from({ length: 50 }, () => big).join('\n')));
    expect(t.length).toBeLessThanOrEqual(SHORT_IDENTITY_CAP);
    expect(SHORT_IDENTITY_CAP).toBe(1200);
  });
  it('with no files it is the names alone', () => {
    const t = buildShortIdentity(names, []);
    expect(t).toBe('## Who you are (short)\nYou are Echo. You are writing for yourself, about your life with Sam.');
  });
});

describe('shortIdentity (cached by digest)', () => {
  let root: string;
  let home: string;
  let cfg: any;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'idshort-'));
    home = join(root, 'home');
    mkdirSync(join(home, 'identity'), { recursive: true });
    cfg = { agent: { cwd: home }, server: { db_path: join(root, 'data', 'x.db') }, identity: { companion_name: 'Echo', user_name: 'Sam' } };
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const put = (n: string, t: string) => writeFileSync(join(home, 'identity', n), t);
  const cached = () => { try { return readdirSync(join(root, 'data', 'identity-short')); } catch { return []; } };

  it('missing identity files: name-only, nothing cached', async () => {
    const t = await shortIdentity(cfg);
    expect(t).toContain('You are Echo');
    expect(t).not.toContain('Who you are to each other');
    expect(cached()).toEqual([]);
  });
  it('builds from the files, caches under data/, reuses the cache, and changes when the identity changes; always within the cap', async () => {
    put('profile.md', 'Sam is my partner.');
    put('companion.md', 'I am dry and warm.\nI tease gently.');
    const a = await shortIdentity(cfg);
    expect(a).toContain('Sam is my partner.');
    expect(a.length).toBeLessThanOrEqual(SHORT_IDENTITY_CAP);
    expect(cached()).toHaveLength(1);
    const file = join(root, 'data', 'identity-short', cached()[0]);
    writeFileSync(file, readFileSync(file, 'utf8') + '\nCACHED-MARK');
    expect(await shortIdentity(cfg)).toContain('CACHED-MARK'); // same digest: the cached text is served
    put('companion.md', 'I am quiet now.\n' + 'y'.repeat(9000));
    const b = await shortIdentity(cfg);
    expect(b).not.toBe(a);
    expect(b).toContain('I am quiet now.');
    expect(b).not.toContain('CACHED-MARK');
    expect(b.length).toBeLessThanOrEqual(SHORT_IDENTITY_CAP);
    expect(cached()).toHaveLength(2);
  });
  it('a different name makes a different key', async () => {
    put('companion.md', 'I am dry.');
    await shortIdentity(cfg);
    await shortIdentity({ ...cfg, identity: { companion_name: 'Nova', user_name: 'Sam' } });
    expect(cached()).toHaveLength(2);
  });
});
