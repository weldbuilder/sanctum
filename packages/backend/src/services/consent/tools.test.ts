import { describe, it, expect } from 'vitest';
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
  it('when the home IS the install (cwd "."): the code folders are self_code_edit, the rest is home', () => {
    expect(fileWriteCapability('/srv/sanctum/packages/backend/src/x.ts', same)).toBe('self_code_edit');
    expect(fileWriteCapability('/srv/sanctum/prompts/companion-claude.md', same)).toBe('self_code_edit');
    expect(fileWriteCapability('/srv/sanctum/journal/today.md', same)).toBeNull();
    expect(fileWriteCapability('/srv/sanctum/HANDOFF.md', same)).toBeNull();
    expect(fileWriteCapability('/etc/hosts', same)).toBe('files_outside_home');
  });
  it('a relative path is read against the home', () => {
    expect(fileWriteCapability('journal/x.md', home)).toBeNull();
    expect(fileWriteCapability('../sanctum/package.json', home)).toBe('self_code_edit');
  });
});
