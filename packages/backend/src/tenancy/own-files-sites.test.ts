// The write sites from the round-3 verifier's table, each through its real function inside a tenant folder with tenancy on: a link planted where the write
// would land (at the target, at the temp name, or at a folder on the way) is refused and the file or folder outside the tenant folder is byte-identical.
// Round 3's fixed list of twelve entries missed every one of these (they sit one level or more below it). No provider, no model run.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enableTenancy, runInTenant } from './context.js';
import { fakeRuntime } from './test-runtime.js';
import { TenantEditRefused, setTempNameForTest, writeThreadFile } from './own-files.js';
import { appendCapped } from './console.js';
import { saveFile } from '../services/files.js';
import { pruneSnapshots, writeFileAtomic, writeLedger } from '../services/plugin-ratify.js';
import { checkIdentity, pruneIdentitySnapshots, ratifyIdentity, resetLedgerWarnings, type LedgerOpts } from '../services/identity/ledger.js';
import { createTranscript } from '../services/discord/public-transcript.js';
import { migrateWakePromptsToDir } from '../services/orchestrator.js';

const posix = process.platform !== 'win32';
const made: string[] = [];
function world() {
  const top = mkdtempSync(join(tmpdir(), 'sanctum-sites-'));
  made.push(top);
  const tenant = join(top, 'tenants', 'ada');
  const outside = join(top, 'outside');
  mkdirSync(join(tenant, 'home', 'identity'), { recursive: true });
  mkdirSync(join(tenant, 'data'), { recursive: true });
  mkdirSync(join(outside, 'dir', 'old'), { recursive: true });
  writeFileSync(join(outside, 'dir', 'old', 'keep.txt'), 'KEEP');
  writeFileSync(join(outside, 'secret'), 'SECRET');
  writeFileSync(join(tenant, 'home', 'identity', 'profile.md'), 'P');
  return { top, tenant, data: join(tenant, 'data'), home: join(tenant, 'home'), outside, secret: join(outside, 'secret'), outDir: join(outside, 'dir') };
}
type W = ReturnType<typeof world>;
const snap = (dir: string, out: Record<string, string> = {}): Record<string, string> => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { out[p] = 'dir'; snap(p, out); } else if (e.isFile()) out[p] = readFileSync(p).toString('hex'); else out[p] = 'link';
  }
  return out;
};
const link = (target: string, at: string, kind: 'file' | 'junction'): boolean => { try { symlinkSync(target, at, kind); return true; } catch { return false; } };
const inTenant = <T>(w: W, fn: () => T): T => runInTenant(fakeRuntime('ada', { dir: w.tenant, dataDir: w.data, homeDir: w.home }), fn);
const refused = (fn: () => unknown): unknown => { try { fn(); } catch (e) { return e; } return undefined; };

beforeEach(() => { enableTenancy(true); resetLedgerWarnings(); vi.spyOn(console, 'warn').mockImplementation(() => {}); vi.spyOn(console, 'log').mockImplementation(() => {}); });
afterEach(() => { enableTenancy(false); setTempNameForTest(null); vi.restoreAllMocks(); for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('M2: the identity ledger (data/identity/journal.jsonl, snapshots/)', () => {
  const opts = (w: W): LedgerOpts => ({ ledgerDir: join(w.data, 'identity'), trustStat: false });
  it('a link at journal.jsonl: the first look (the baseline line) never appends through it', () => {
    const w = world();
    mkdirSync(join(w.data, 'identity'));
    if (!link(w.secret, join(w.data, 'identity', 'journal.jsonl'), 'file')) return;
    const before = snap(w.outside);
    refused(() => inTenant(w, () => checkIdentity(w.home, opts(w))));
    expect(snap(w.outside)).toEqual(before);
    expect(readFileSync(w.secret, 'utf8')).toBe('SECRET');
  });
  it.runIf(posix)('a hard link at journal.jsonl: never appended to', () => {
    const w = world();
    mkdirSync(join(w.data, 'identity'));
    linkSync(w.secret, join(w.data, 'identity', 'journal.jsonl'));
    refused(() => inTenant(w, () => checkIdentity(w.home, opts(w))));
    expect(readFileSync(w.secret, 'utf8')).toBe('SECRET');
  });
  it('a link at snapshots/: a ratification stages nothing outside, and the prune refuses and deletes nothing', () => {
    const w = world();
    mkdirSync(join(w.data, 'identity'));
    if (!link(w.outDir, join(w.data, 'identity', 'snapshots'), 'junction')) return;
    const before = snap(w.outside);
    refused(() => inTenant(w, () => ratifyIdentity(w.home, opts(w), { by: 'person' })));
    expect(snap(w.outside)).toEqual(before);
    writeFileSync(join(w.data, 'identity', 'ledger.json'), JSON.stringify({ version: 1, ratified: { digest: 'a'.repeat(64), files: {}, ratified_at: '2026-01-01T00:00:00Z', by: 'person' } }));
    expect(refused(() => inTenant(w, () => pruneIdentitySnapshots(join(w.data, 'identity'))))).toBeInstanceOf(TenantEditRefused);
    expect(snap(w.outside)).toEqual(before);
  });
});

describe('M4: the plugin ledger and its snapshots (data/plugins)', () => {
  it('a link at data/plugins/snapshots is refused by pruneSnapshots, never traversed: the folder behind it is byte-identical', () => {
    const w = world();
    const plugins = join(w.data, 'plugins');
    mkdirSync(plugins);
    const file = join(plugins, 'ratified.json');
    writeFileSync(file, JSON.stringify({ version: 1, plugins: {} }));
    if (!link(w.outDir, join(plugins, 'snapshots'), 'junction')) return;
    const before = snap(w.outside);
    const err = refused(() => inTenant(w, () => pruneSnapshots(file)));
    expect(err).toBeInstanceOf(TenantEditRefused);
    expect((err as Error).message).toBe("data/plugins/snapshots in the tenant folder is a link; a tenant's own files and folders must be real ones inside its folder.");
    expect(snap(w.outside)).toEqual(before);
  });
  it('a link at the ledger file: writeLedger is refused and the file behind it is byte-identical', () => {
    const w = world();
    const plugins = join(w.data, 'plugins');
    mkdirSync(plugins);
    if (!link(w.secret, join(plugins, 'ratified.json'), 'file')) return;
    expect(refused(() => inTenant(w, () => writeLedger(join(plugins, 'ratified.json'), { version: 1, plugins: {} })))).toBeInstanceOf(TenantEditRefused);
    expect(readFileSync(w.secret, 'utf8')).toBe('SECRET');
  });
});

describe('S2: writeFileAtomic opens its temp file with a random name and `wx`', () => {
  for (const tenancy of [true, false]) {
    it(`a link planted at the temp name is never written through (tenancy ${tenancy ? 'on' : 'off'})`, () => {
      enableTenancy(tenancy);
      const w = world();
      const tmp = join(w.data, '.planted');
      if (!link(w.secret, tmp, 'file')) return;
      setTempNameForTest(() => tmp);
      const err = refused(() => inTenant(w, () => writeFileAtomic(join(w.data, 'ledger.json'), 'NEW')));
      expect((err as { code?: string }).code).toBe('EEXIST');
      expect(readFileSync(w.secret, 'utf8')).toBe('SECRET');
    });
  }
});

describe('uploads, transcripts, logs, wake prompts, the thread marker', () => {
  it('data/files that is a link: an upload (POST /files, /internal/share, a Discord or Telegram attachment all call saveFile) writes nothing behind it', () => {
    const w = world();
    if (!link(w.outDir, join(w.data, 'files'), 'junction')) return;
    const before = snap(w.outside);
    expect(refused(() => inTenant(w, () => saveFile(Buffer.from('x'), 'a.txt', 'text/plain')))).toBeInstanceOf(TenantEditRefused);
    expect(snap(w.outside)).toEqual(before);
  });
  it('a link at a Discord public transcript file is never appended to', () => {
    const w = world();
    const root = join(w.data, 'discord', 'public');
    mkdirSync(join(root, '111'), { recursive: true });
    if (!link(w.secret, join(root, '111', '222.jsonl'), 'file')) return;
    const t = createTranscript(() => root);
    expect(refused(() => inTenant(w, () => t.append({ kind: 'in', who: { id: '1', name: 'x', bot: false }, where: { guild: '111', channel: '222' }, text: 'hi', len: 2 })))).toBeInstanceOf(TenantEditRefused);
    expect(readFileSync(w.secret, 'utf8')).toBe('SECRET');
  });
  it('a link at data/logs/tenant.log is never appended to', () => {
    const w = world();
    mkdirSync(join(w.data, 'logs'));
    if (!link(w.secret, join(w.data, 'logs', 'tenant.log'), 'file')) return;
    expect(refused(() => inTenant(w, () => appendCapped(join(w.data, 'logs', 'tenant.log'), 'a line\n')))).toBeInstanceOf(TenantEditRefused);
    expect(readFileSync(w.secret, 'utf8')).toBe('SECRET');
  });
  it('the wake-prompt migration into a data/wake-prompts that is a link writes nothing behind it', () => {
    const w = world();
    const empty = join(w.outside, 'empty');
    mkdirSync(empty);
    if (!link(empty, join(w.data, 'wake-prompts'), 'junction')) return;
    inTenant(w, () => migrateWakePromptsToDir(join(w.data, 'wake-prompts'), join(w.data, 'none.md'), 'u'));
    expect(readdirSync(empty)).toEqual([]);
  });
  it('S1: home/.sanctum-thread that the companion made a link is refused on a chat turn, the turn goes on, and the target is untouched', () => {
    const w = world();
    if (!link(w.secret, join(w.home, '.sanctum-thread'), 'file')) return;
    expect(inTenant(w, () => writeThreadFile(w.home, 'thread-1'))).toBe('refused');
    expect(readFileSync(w.secret, 'utf8')).toBe('SECRET');
    rmSync(join(w.home, '.sanctum-thread'));
    expect(inTenant(w, () => writeThreadFile(w.home, 'thread-2'))).toBe('written');
    expect(readFileSync(join(w.home, '.sanctum-thread'), 'utf8')).toBe('thread-2');
  });
});
