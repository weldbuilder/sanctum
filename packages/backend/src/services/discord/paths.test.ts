import { describe, it, expect, vi, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDiscordPaths, resetPathWarnings } from './paths.js';
import { buildDiscordStatus } from './status.js';
import { normalizeDiscordConfig } from '../../config.js';

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'sanctum-dpaths-test-')));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let n = 0;
// Under Codex or dsh in workspace-write the sandbox can write /tmp and $TMPDIR, so the loader counts them as
// companion-writable roots and a private folder under the OS temp dir is rightly refused. The one test that
// needs an accepted folder under those providers builds its fixture inside the repo instead (gitignored).
const repoTmpParent = fileURLToPath(new URL('../../../.test-tmp/', import.meta.url));
mkdirSync(repoTmpParent, { recursive: true });
const repoTmp = realpathSync(mkdtempSync(join(repoTmpParent, 'dpaths-')));
afterAll(() => rmSync(repoTmp, { recursive: true, force: true }));
function layoutOutsideTmp() {
  const base = join(repoTmp, `t${n++}`);
  const home = join(base, 'companion-home');
  const priv = join(base, 'sanctum-private');
  mkdirSync(home, { recursive: true });
  mkdirSync(priv, { recursive: true });
  return { base, home, priv };
}
function layout() {
  const base = join(tmp, `t${n++}`);
  const home = join(base, 'companion-home');
  const priv = join(base, 'sanctum-private');
  mkdirSync(home, { recursive: true });
  mkdirSync(priv, { recursive: true });
  return { base, home, priv };
}

/** A normalised discord block, as config.ts hands it over: every path absolute. */
function discord(priv: string, over: Record<string, unknown> = {}) {
  return {
    private_dir: priv,
    gate: { words_file: join(priv, 'words.txt'), names_file: join(priv, 'names.txt') },
    public: { exclusions_file: join(priv, 'exclusions.txt') },
    ...over,
  } as any;
}

describe('resolveDiscordPaths', () => {
  it('passes a private folder beside the home, with no warning', () => {
    const { home, priv } = layout();
    const warn = vi.fn();
    const p = resolveDiscordPaths({ agent: { cwd: home }, discord: discord(priv) } as any, { warn });
    expect(p.privateDir).toBe(priv);
    expect(p.wordsFile).toBe(join(priv, 'words.txt'));
    expect(p.namesFile).toBe(join(priv, 'names.txt'));
    expect(p.exclusionsFile).toBe(join(priv, 'exclusions.txt'));
    expect(p.refused).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('refuses a private folder inside the companion home, loudly, and blanks every derived path', () => {
    const { home } = layout();
    const inside = join(home, 'private');
    mkdirSync(inside);
    const warn = vi.fn();
    const p = resolveDiscordPaths({ agent: { cwd: home }, discord: discord(inside) } as any, { warn });
    expect(p.privateDir).toBe('');
    expect(p.wordsFile).toBe('');
    expect(p.namesFile).toBe('');
    expect(p.exclusionsFile).toBe('');
    expect(p.refused.map((r) => r.key)).toContain('discord.private_dir');
    expect(p.refused[0].clash).toBe('agent.cwd');
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/refused.*agent\.cwd/s);
  });

  it('refuses a private folder that contains the home', () => {
    const { base, home } = layout();
    const p = resolveDiscordPaths({ agent: { cwd: home }, discord: discord(base) } as any, { warn: vi.fn() });
    expect(p.privateDir).toBe('');
  });

  it('refuses a folder under a Codex extra directory, the dsh home and the write-gate roots', () => {
    const { base } = layout();
    for (const [cfgPart, label] of [
      [{ agent: { cwd: join(base, 'elsewhere'), codex: { additional_directories: [base] } } }, 'agent.codex.additional_directories'],
      [{ agent: { cwd: join(base, 'elsewhere'), dsh: { home: base } } }, 'agent.dsh.home'],
      [{ agent: { cwd: join(base, 'elsewhere') }, hooks: { extra_write_paths: [base] } }, 'hooks.extra_write_paths'],
      [{ agent: { cwd: join(base, 'elsewhere') }, hooks: { vault_path: base } }, 'hooks.vault_path'],
    ] as Array<[any, string]>) {
      const p = resolveDiscordPaths({ ...cfgPart, discord: discord(join(base, 'sanctum-private')) } as any, { warn: vi.fn() });
      expect(p.privateDir, label).toBe('');
      expect(p.refused[0].clash, label).toBe(label);
    }
  });

  it('follows symlinks: a private folder that is a link into the home is refused', () => {
    const { base, home } = layout();
    const target = join(home, 'real-private');
    mkdirSync(target);
    const link = join(base, 'link-private');
    symlinkSync(target, link);
    const p = resolveDiscordPaths({ agent: { cwd: home }, discord: discord(link) } as any, { warn: vi.fn() });
    expect(p.privateDir).toBe('');
  });

  it('refuses one list file inside the home and keeps the others', () => {
    const { home, priv } = layout();
    const warn = vi.fn();
    const p = resolveDiscordPaths({
      agent: { cwd: home },
      discord: discord(priv, { gate: { words_file: join(home, 'words.txt'), names_file: join(priv, 'names.txt') } }),
    } as any, { warn });
    expect(p.wordsFile).toBe('');
    expect(p.namesFile).toBe(join(priv, 'names.txt'));
    expect(p.exclusionsFile).toBe(join(priv, 'exclusions.txt'));
    expect(p.refused.map((r) => r.key)).toEqual(['discord.gate.words_file']);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('warns once per problem, not on every call', () => {
    const { home } = layout();
    const inside = join(home, 'p');
    const warn = vi.fn();
    const cfg = { agent: { cwd: home }, discord: discord(inside) } as any;
    resolveDiscordPaths(cfg, { warn });
    resolveDiscordPaths(cfg, { warn });
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('resolveDiscordPaths under danger-full-access (the sandbox is no boundary)', () => {
  beforeEach(() => resetPathWarnings());
  const full = (home: string, over: Record<string, any> = {}) => ({ agent: { cwd: home, provider: 'codex', codex: { sandbox_mode: 'danger-full-access', ...over } } });

  it('Codex at danger-full-access: the private folder and every list file are refused, full_access is the clash, the warning names the setting', () => {
    const { home, priv } = layout();
    const warn = vi.fn();
    const p = resolveDiscordPaths({ ...full(home), discord: discord(priv) } as any, { warn });
    expect(p.privateDir).toBe('');
    expect(p.wordsFile).toBe('');
    expect(p.namesFile).toBe('');
    expect(p.exclusionsFile).toBe('');
    expect(p.refused.map((r) => r.key)).toEqual(expect.arrayContaining(['discord.private_dir', 'discord.gate.words_file', 'discord.gate.names_file', 'discord.public.exclusions_file']));
    expect(p.refused.every((r) => r.clash === 'full_access')).toBe(true);
    const text = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(text).toMatch(/agent\.codex\.sandbox_mode/);
    expect(text).toMatch(/danger-full-access/);
  });

  it('GET /api/discord/status shows privateDir.refused with clash full_access (and no path)', () => {
    const { home, priv } = layout();
    const p = resolveDiscordPaths({ ...full(home, { m: 'status' }), discord: discord(priv) } as any, { warn: vi.fn() });
    const s = buildDiscordStatus(normalizeDiscordConfig({}, home, { warn: () => {} }), p, { words: { state: 'failed', kind: 'missing' }, names: { state: 'off' } });
    expect(s.privateDir).toEqual({ configured: false, refused: true, clash: 'full_access' });
    expect(JSON.stringify(s)).not.toContain(priv);
  });

  it('dsh at danger-full-access is refused too, naming agent.dsh.sandbox_mode', () => {
    const { home, priv } = layout();
    const warn = vi.fn();
    const p = resolveDiscordPaths({ agent: { cwd: home, provider: 'dsh', dsh: { sandbox_mode: 'danger-full-access' } }, discord: discord(priv) } as any, { warn });
    expect(p.privateDir).toBe('');
    expect(p.refused.find((r) => r.key === 'discord.private_dir')?.clash).toBe('full_access');
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/agent\.dsh\.sandbox_mode/);
  });

  it('warns once per boot, not on every call', () => {
    const { home, priv } = layout();
    const warn = vi.fn();
    const cfg = { ...full(home, { m: 'once' }), discord: discord(priv) } as any;
    resolveDiscordPaths(cfg, { warn });
    resolveDiscordPaths(cfg, { warn });
    resolveDiscordPaths(cfg, { warn });
    expect(warn.mock.calls.filter((c) => /danger-full-access/.test(String(c[0])))).toHaveLength(1);
  });

  it('Claude is NOT refused (it has no sandbox mode; the docs say what its write-gate covers), whatever the others are set to', () => {
    const { home, priv } = layout();
    const warn = vi.fn();
    const p = resolveDiscordPaths({ agent: { cwd: home, provider: 'claude', codex: { sandbox_mode: 'danger-full-access' }, dsh: { sandbox_mode: 'danger-full-access' } }, discord: discord(priv) } as any, { warn });
    expect(p.privateDir).toBe(priv);
    expect(p.wordsFile).toBe(join(priv, 'words.txt'));
    expect(p.refused).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  // When the repo itself is checked out under the OS temp dir there is no non-temp folder to use; skip rather than fail.
  const repoUnderTmp = realpathSync(repoTmpParent).startsWith(realpathSync(tmpdir())) || realpathSync(repoTmpParent).startsWith('/tmp/');
  it.skipIf(repoUnderTmp)('workspace-write and read-only are not refused (only the active provider counts)', () => {
    const { home, priv } = layoutOutsideTmp(); // a folder under /tmp would be refused: the sandbox can write /tmp
    for (const mode of ['workspace-write', 'read-only']) {
      const p = resolveDiscordPaths({ agent: { cwd: home, provider: 'codex', codex: { sandbox_mode: mode }, dsh: { sandbox_mode: 'danger-full-access' } }, discord: discord(priv) } as any, { warn: vi.fn() });
      expect(p.privateDir, mode).toBe(priv);
    }
  });
});
