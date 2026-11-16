import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toolCapability, fileWriteCapability } from './tools.js';

const home = { agentCwd: '/srv/companion-home', installDir: '/srv/sanctum' };
const same = { agentCwd: '/srv/sanctum', installDir: '/srv/sanctum' };

describe('raw tool → capability', () => {
  it('maps the table', () => {
    expect(toolCapability('Bash', { command: 'ls' }, home)).toBe('shell');
    expect(toolCapability('WebFetch', { url: 'https://x.test' }, home)).toBe('web');
    expect(toolCapability('WebSearch', { query: 'x' }, home)).toBe('web');
    expect(toolCapability('mcp__browser__browser_navigate', {}, home)).toBe('web');
    expect(toolCapability('mcp__telegram__send', {}, home)).toBe('outward_telegram');
    expect(toolCapability('mcp__my-Telegram-bridge__post', {}, home)).toBe('outward_telegram');
  });
  it('google: only the workspace tool\'s write actions', () => {
    for (const action of ['create', 'update', 'delete', 'cancel', 'trash', 'send', 'append', 'add_to_playlist']) expect(toolCapability('mcp__sanctum-workspace__google', { service: 'gmail', action }, home)).toBe('google_write');
    for (const action of ['list', 'search', 'read', 'get', '']) expect(toolCapability('mcp__sanctum-workspace__google', { service: 'gmail', action }, home)).toBeNull();
    expect(toolCapability('mcp__sanctum-workspace__google_health', { action: 'create' }, home)).toBeNull();
  });
  it('everything else is not gated', () => {
    for (const t of ['Read', 'Glob', 'Grep', 'Task', 'TodoWrite', 'mcp__sanctum-workspace__generate_image', 'mcp__other__thing']) expect(toolCapability(t, { file_path: '/etc/passwd' }, home)).toBeNull();
  });
});

describe('file writes', () => {
  it('inside the companion home: ungated (journal, HANDOFF.md, notes)', () => {
    for (const p of ['/srv/companion-home/journal/2026-11-06.md', '/srv/companion-home/HANDOFF.md', 'notes/x.md', '/srv/companion-home/a/../b.md']) {
      expect(toolCapability('Write', { file_path: p }, home)).toBeNull();
      expect(toolCapability('Edit', { file_path: p }, home)).toBeNull();
    }
  });
  it('under the install and not the home: self_code_edit', () => {
    expect(toolCapability('Write', { file_path: '/srv/sanctum/packages/backend/src/x.ts' }, home)).toBe('self_code_edit');
    expect(toolCapability('Edit', { file_path: '/srv/sanctum/tools/res.mjs' }, home)).toBe('self_code_edit');
    expect(toolCapability('Edit', { file_path: '/srv/companion-home/../sanctum/package.json' }, home)).toBe('self_code_edit'); // traversal is resolved
  });
  it('anywhere else: files_outside_home', () => {
    expect(toolCapability('Write', { file_path: '/home/other/notes.md' }, home)).toBe('files_outside_home');
    expect(toolCapability('NotebookEdit', { notebook_path: '/tmp/x.ipynb' }, home)).toBe('files_outside_home');
    expect(toolCapability('Write', { file_path: '/srv/sanctum-private/x' }, home)).toBe('files_outside_home'); // a sibling, not under the install
  });
  it('a write with no path is not gated', () => {
    expect(toolCapability('Write', {}, home)).toBeNull();
    expect(toolCapability('Write', undefined, home)).toBeNull();
  });
  it('when the home IS the install (cwd "."): home is the explicit list of the companion\'s own files, everything else is self_code_edit', () => {
    expect(fileWriteCapability('/srv/sanctum/packages/backend/src/x.ts', same)).toBe('self_code_edit');
    expect(fileWriteCapability('/srv/sanctum/prompts/companion-claude.md', same)).toBe('self_code_edit');
    for (const home of ['journal/today.md', 'HANDOFF.md', 'AGENTS.md', 'identity/companion.md', 'archive/2026/x.md', 'config/codex-base-prompt.md', 'notes/x.md',
      'companion-home/HANDOFF.md', 'companion-home/journal/x.md', '.claude/skills/browser/SKILL.md', '.agents/skills/browser/SKILL.md']) {
      expect(fileWriteCapability(`/srv/sanctum/${home}`, same), home).toBeNull();
    }
    expect(fileWriteCapability('/etc/hosts', same)).toBe('files_outside_home');
  });
  it('under cwd ".": the install root files and secrets are self_code_edit, not home', () => {
    for (const code of ['package.json', 'package-lock.json', '.mcp.json', 'sanctum.yaml', '.env', '.env.local', 'tsconfig.json', 'tsconfig.base.json', 'vitest.config.mjs',
      'vitest.setup.mjs', 'scripts/doctor.mjs', 'data/sanctum.db', 'data/.internal-token', 'dist/index.js', '.github/workflows/ci.yml', '.gitignore', 'UPGRADE.md',
      'docs/CONFIGURATION.md', 'node_modules/x/index.js', '.git/hooks/pre-commit', '.claude/settings.json', '.claude/skills-evil/x', 'journal.sh', 'newfolder/x.md', 'logs/x.log']) {
      expect(fileWriteCapability(`/srv/sanctum/${code}`, same), code).toBe('self_code_edit');
    }
    // not a prefix match: HANDOFF.md.bak and journalx are not the home files
    expect(fileWriteCapability('/srv/sanctum/HANDOFF.md.bak', same)).toBe('self_code_edit');
    expect(fileWriteCapability('/srv/sanctum/journalx/a.md', same)).toBe('self_code_edit');
    // relative paths are read against the cwd, traversal is resolved
    expect(fileWriteCapability('package.json', same)).toBe('self_code_edit');
    expect(fileWriteCapability('journal/../package.json', same)).toBe('self_code_edit');
  });
  it('a separate home folder (the wizard setup): inside the cwd stays ungated, the install stays self_code_edit', () => {
    expect(fileWriteCapability('/srv/companion-home/package.json', home)).toBeNull();
    expect(fileWriteCapability('/srv/companion-home/anything/at/all.md', home)).toBeNull();
    expect(fileWriteCapability('/srv/sanctum/package.json', home)).toBe('self_code_edit');
    expect(fileWriteCapability('/srv/sanctum/journal/x.md', home)).toBe('self_code_edit');
    const inside = { agentCwd: '/srv/sanctum/companion-home', installDir: '/srv/sanctum' };
    expect(fileWriteCapability('/srv/sanctum/companion-home/x.md', inside)).toBeNull();
    expect(fileWriteCapability('/srv/sanctum/package.json', inside)).toBe('self_code_edit');
  });
  it('a real folder inside the home whose name starts with two dots is inside (a leading ".." SEGMENT is what means outside)', () => {
    expect(fileWriteCapability('/srv/companion-home/..foo/x.md', home)).toBeNull();
    expect(fileWriteCapability('/srv/companion-home/..foo', home)).toBeNull();
    expect(fileWriteCapability('/srv/companion-home/../elsewhere/x.md', home)).toBe('files_outside_home');
    expect(fileWriteCapability('/srv/sanctum/..foo/x.md', same)).toBe('self_code_edit'); // under cwd ".": inside the install, not on the home list
    expect(fileWriteCapability('/srv/sanctum/journal/..foo/x.md', same)).toBeNull();
    expect(fileWriteCapability('/srv/sanctum/notes/..foo/x.md', same)).toBeNull();
  });
  it('a relative path is read against the home', () => {
    expect(fileWriteCapability('journal/x.md', home)).toBeNull();
    expect(fileWriteCapability('../sanctum/package.json', home)).toBe('self_code_edit');
  });
});


describe('symlinks: classified by where they point (realpath), not where they sit', () => {
  let dir = '';
  const o = () => ({ agentCwd: join(dir, 'home'), installDir: join(dir, 'install') });
  beforeAll(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'consent-links-')));
    mkdirSync(join(dir, 'home', 'journal'), { recursive: true });
    mkdirSync(join(dir, 'install', 'packages'), { recursive: true });
    mkdirSync(join(dir, 'outside'), { recursive: true });
    symlinkSync(join(dir, 'outside'), join(dir, 'home', 'link-out'));
    symlinkSync(join(dir, 'install', 'packages'), join(dir, 'home', 'link-code'));
    symlinkSync(join(dir, 'outside', 'nowhere.txt'), join(dir, 'home', 'dangling'));
    symlinkSync(join(dir, 'home', 'journal'), join(dir, 'home', 'link-in'));
  });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });
  it('a link inside the home that points outside is files_outside_home, even for a file that does not exist yet', () => {
    expect(fileWriteCapability(join(dir, 'home', 'link-out', 'evil.sh'), o())).toBe('files_outside_home');
    expect(fileWriteCapability('link-out/deeper/new/evil.sh', o())).toBe('files_outside_home');
  });
  it('a link that points at the install code is self_code_edit', () => {
    expect(fileWriteCapability(join(dir, 'home', 'link-code', 'x.ts'), o())).toBe('self_code_edit');
  });
  it('a dangling link is classified by its target', () => {
    expect(fileWriteCapability(join(dir, 'home', 'dangling'), o())).toBe('files_outside_home');
  });
  it('a link that stays inside the home is home', () => {
    expect(fileWriteCapability(join(dir, 'home', 'link-in', 'x.md'), o())).toBeNull();
  });
  it('under cwd ".": a link inside a home-list folder pointing at package.json is self_code_edit', () => {
    mkdirSync(join(dir, 'same', 'journal'), { recursive: true });
    symlinkSync(join(dir, 'same', 'package.json'), join(dir, 'same', 'journal', 'pkg'));
    const same = { agentCwd: join(dir, 'same'), installDir: join(dir, 'same') };
    expect(fileWriteCapability(join(dir, 'same', 'journal', 'pkg'), same)).toBe('self_code_edit');
    expect(fileWriteCapability(join(dir, 'same', 'journal', 'ok.md'), same)).toBeNull();
  });
});

describe('the ask channel: res ask / res help are not the shell capability', () => {
  const RES = '/srv/sanctum/tools/res.mjs';
  const cap = (command: string, o = home) => toolCapability('Bash', { command }, o);
  it('res ask and res help (every form) are exempt', () => {
    for (const c of ['res ask shell 30', 'res ask shell', 'res ask web on', 'res ask "why" --capability web --window 30', "res ask 'send it' to Sam", 'res help', 'res help ask',
      `node ${RES} ask shell 30`, `${RES} ask shell 30`, `node "${RES}" help`, '  res   ask   shell   30  ']) {
      expect(cap(c), c).toBeNull();
    }
  });
  it('anything chained, substituted, redirected or piped is the shell', () => {
    for (const c of ['res ask shell 30; rm -rf /', 'res ask shell 30 && ls', 'res ask shell 30 || ls', 'res ask shell | sh', 'res ask `id`', 'res ask $(id)', 'res ask shell > /etc/x',
      'res ask shell < /etc/passwd', 'res ask shell\nrm -rf /', 'res ask shell &', 'res ask \\ shell', 'res ask "$HOME"', 'res ask shell 30 # x; ls']) {
      expect(cap(c), c).toBe('shell');
    }
  });
  it('other verbs and other programs are the shell (tg, voice, image have their own gates at the server)', () => {
    for (const c of ['res tg "x"', 'res voice hi', 'res image a cat', 'res timer 5', 'resask shell', 'resx ask shell', 'ls', 'node other.mjs ask', 'node /tmp/res.mjs ask shell 30',
      '/tmp/evil/res.mjs ask shell', 'echo res ask', 'sudo res ask shell', 'FOO=1 res ask shell', 'res', 'res ', '']) {
      expect(cap(c), c).toBe('shell');
    }
  });
  it('no command is a shell call as before', () => {
    expect(toolCapability('Bash', {}, home)).toBe('shell');
    expect(toolCapability('Bash', undefined, home)).toBe('shell');
  });
});
