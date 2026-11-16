// The consent gate in the Claude PreToolUse hook: first, before the regex and prefix rules, and in the deny shape the companion already knows.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./embeddings.js', () => ({ embed: vi.fn().mockResolvedValue(new Float32Array(384)), vectorToBuffer: vi.fn().mockReturnValue(Buffer.alloc(384 * 4)) }));
vi.mock('./vector-cache.js', () => ({ cacheEmbedding: vi.fn(), removeEmbedding: vi.fn() }));
vi.mock('../config.js', () => ({
  getSanctumConfig: vi.fn().mockReturnValue({
    identity: { companion_name: 'Echo', user_name: 'Sam', timezone: 'UTC' },
    hooks: { context_injection: false, safe_write_prefixes: [], workspace_root: '', vault_path: '', extra_write_paths: ['/home/other', '/srv/sanctum'] },
    command_center: { enabled: false },
    agent: { cwd: '/srv/companion-home', mcp_json_path: '' },
    integrations: { life_api_url: '', mind_cloud: { enabled: false, mcp_url: '', mind_id: '' } },
    server: { db_path: ':memory:' },
  }),
  PROJECT_ROOT: '/srv/sanctum',
}));
vi.mock('./audit.js', () => ({ logToolUse: vi.fn() }));

import { createHooks, buildOrientationContext, type HookContext } from './hooks.js';
import { initDb, getDb } from './db.js';
import { grant, setMode, turnOff } from './consent/gate.js';

const broadcast = vi.fn();
const ctx = (): HookContext => ({
  threadId: 'thread-1', threadName: 'n', threadType: 'daily', streamMsgId: 's', isAutonomous: false,
  registry: { broadcast } as any, sessionId: 'sess', platform: 'web', toolInsertions: [], getTextLength: () => 0,
});
const pre = (tool: string, input: Record<string, unknown>) => {
  const cb = (createHooks(ctx())!.PreToolUse![0].hooks[0]) as any;
  return cb({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id: `tu-${Math.random()}` }, 'x', { signal: new AbortController().signal }) as Promise<any>;
};
const decision = (r: any) => r.hookSpecificOutput?.permissionDecision;
const reason = (r: any) => r.hookSpecificOutput?.permissionDecisionReason as string;
// (what the gate decided about tool calls; the grant/off/mode rows a test makes to set up are not these)
const receipts = () => getDb().prepare("SELECT capability, outcome, harness, thread_id, tool_or_route FROM consent_receipts WHERE outcome IN ('allowed','denied','expired') ORDER BY id").all() as any[];

beforeEach(() => { initDb(':memory:'); broadcast.mockClear(); vi.spyOn(console, 'warn').mockImplementation(() => {}); });

describe('PreToolUse: Bash and the shell switch', () => {
  it('on (the default): allowed, and the receipt says so', async () => {
    const r = await pre('Bash', { command: 'ls -la' });
    expect(decision(r)).toBeUndefined();
    expect(receipts()).toEqual([{ capability: 'shell', outcome: 'allowed', harness: 'claude', thread_id: 'thread-1', tool_or_route: 'Bash' }]);
  });
  it('off: denied in the existing shape, with the reason and how to ask', async () => {
    turnOff('shell');
    const r = await pre('Bash', { command: 'ls -la' });
    expect(r.continue).toBe(true);
    expect(r.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(decision(r)).toBe('deny');
    expect(reason(r)).toBe('Blocked: Shell access is turned off. Ask with res ask shell <window> (minutes, or "on" to leave it on).');
    expect(receipts()).toMatchObject([{ capability: 'shell', outcome: 'denied' }]);
  });
  it('on a window that ended: denied, receipt "expired"', async () => {
    grant('shell', 15, undefined, {}, Date.now() - 20 * 60_000);
    const r = await pre('Bash', { command: 'ls' });
    expect(decision(r)).toBe('deny');
    expect(reason(r)).toMatch(/^Blocked: Shell access's window ended at \d\d:\d\d\. Ask with res ask shell/);
    expect(receipts().at(-1).outcome).toBe('expired');
  });
  it('guard mode: denied until granted, allowed in the window', async () => {
    setMode('guard');
    expect(decision(await pre('Bash', { command: 'ls' }))).toBe('deny');
    expect(reason(await pre('Bash', { command: 'ls' }))).toMatch(/Shell access needs a grant \(Guard mode is on\)/);
    grant('shell', 30);
    expect(decision(await pre('Bash', { command: 'ls' }))).toBeUndefined();
  });
  it('the gate comes first: a destructive command with shell off gets the gate\'s answer, with shell on the old rule still bites', async () => {
    turnOff('shell');
    expect(reason(await pre('Bash', { command: 'rm -rf /' }))).toMatch(/^Blocked: Shell access is turned off/);
    grant('shell', null);
    expect(reason(await pre('Bash', { command: 'rm -rf /' }))).toMatch(/^Blocked: destructive command pattern detected/);
  });
  it('no tool_use is announced for a refused call', async () => {
    turnOff('shell');
    await pre('Bash', { command: 'ls' });
    expect(broadcast).not.toHaveBeenCalled();
  });
});

describe('PreToolUse: the ask channel works with shell off', () => {
  it('res ask shell 30 passes the hook with shell off or in Guard, and leaves no receipt', async () => {
    turnOff('shell');
    expect(decision(await pre('Bash', { command: 'res ask shell 30' }))).toBeUndefined();
    expect(decision(await pre('Bash', { command: 'res help ask' }))).toBeUndefined();
    setMode('guard');
    expect(decision(await pre('Bash', { command: 'res ask shell 30' }))).toBeUndefined();
    expect(decision(await pre('Bash', { command: 'node /srv/sanctum/tools/res.mjs ask web 15' }))).toBeUndefined();
    expect(receipts()).toEqual([]);
  });
  it('res ask shell 30; rm -rf / is denied', async () => {
    turnOff('shell');
    const r = await pre('Bash', { command: 'res ask shell 30; rm -rf /' });
    expect(decision(r)).toBe('deny');
    expect(reason(r)).toMatch(/^Blocked: Shell access is turned off/);
  });
  it('res tg "x" with shell off is denied by the hook; with shell on and outward_telegram off the server refuses it regardless (routes/consent.test.ts, telegram-send)', async () => {
    turnOff('shell');
    expect(decision(await pre('Bash', { command: 'res tg "x"' }))).toBe('deny');
    expect(decision(await pre('Bash', { command: 'res voice hi' }))).toBe('deny');
    expect(decision(await pre('Bash', { command: 'res image a cat' }))).toBe('deny');
  });
  it('the deny hint\'s own advice now works: ask, then the grant makes the next Bash call pass', async () => {
    turnOff('shell');
    expect(decision(await pre('Bash', { command: 'ls' }))).toBe('deny');
    expect(decision(await pre('Bash', { command: 'res ask shell 30' }))).toBeUndefined();
    grant('shell', 30);
    expect(decision(await pre('Bash', { command: 'ls' }))).toBeUndefined();
  });
});

describe('PreToolUse: a write the old prefix rule denies leaves no allowed receipt', () => {
  it('Write outside the configured prefixes: denied by the prefix rule, no files_outside_home allowed row', async () => {
    const r = await pre('Write', { file_path: '/nowhere/else/x.md', content: 'x' });
    expect(reason(r)).toBe('Blocked: file write outside configured workspace');
    expect(receipts().filter((x) => x.outcome === 'allowed')).toEqual([]);
  });
  it('a destructive command is denied by its rule with no allowed shell row', async () => {
    const r = await pre('Bash', { command: 'rm -rf /' });
    expect(reason(r)).toMatch(/destructive command pattern/);
    expect(receipts()).toEqual([]);
  });
  it('a write the prefix rule lets through still leaves its receipt, and the gate\'s own refusal still wins when it is off', async () => {
    expect(decision(await pre('Write', { file_path: '/home/other/x.md', content: 'x' }))).toBeUndefined();
    expect(receipts()).toEqual([{ capability: 'files_outside_home', outcome: 'allowed', harness: 'claude', thread_id: 'thread-1', tool_or_route: 'Write' }]);
    turnOff('files_outside_home');
    expect(reason(await pre('Write', { file_path: '/nowhere/else/x.md', content: 'x' }))).toMatch(/^Blocked: File access outside the home folder is turned off/);
  });
});

describe('PreToolUse: the mapping, end to end', () => {
  const cases: Array<[string, Record<string, unknown>, string | null]> = [
    ['WebFetch', { url: 'https://example.com' }, 'web'],
    ['WebSearch', { query: 'x' }, 'web'],
    ['mcp__browser__browser_navigate', { url: 'https://example.com' }, 'web'],
    ['mcp__sanctum-workspace__google', { service: 'calendar', action: 'create' }, 'google_write'],
    ['mcp__telegram__send_message', { text: 'hi' }, 'outward_telegram'],
    ['Write', { file_path: '/home/other/x.md', content: '' }, 'files_outside_home'],
    ['Edit', { file_path: '/srv/sanctum/packages/backend/src/x.ts' }, 'self_code_edit'],
  ];
  for (const [tool, input, cap] of cases) {
    it(`${tool} → ${cap}: denied when off, allowed when on`, async () => {
      turnOff(cap as any);
      const denied = await pre(tool, input);
      expect(decision(denied)).toBe('deny');
      expect(reason(denied)).toContain(`res ask ${cap} <window>`);
      grant(cap as any, 30);
      expect(decision(await pre(tool, input))).toBeUndefined();
    });
  }
  it('ungated things leave no receipt: reads, the home folder, a google read', async () => {
    setMode('guard');
    for (const [tool, input] of [
      ['Read', { file_path: '/etc/hosts' }], ['Glob', { pattern: '*' }],
      ['Write', { file_path: '/srv/companion-home/journal/today.md', content: 'x' }],
      ['Edit', { file_path: '/srv/companion-home/HANDOFF.md' }],
      ['mcp__sanctum-workspace__google', { service: 'calendar', action: 'list' }],
    ] as Array<[string, Record<string, unknown>]>) expect(decision(await pre(tool, input)), tool).toBeUndefined();
    expect(receipts()).toEqual([]);
  });
});

describe('orientation', () => {
  it('has no Hands line in open mode with nothing changed, one line when something is off', async () => {
    expect(await buildOrientationContext(ctx(), 'session')).not.toContain('Hands:');
    turnOff('shell');
    grant('web', 30);
    const out = await buildOrientationContext(ctx(), 'session');
    const line = out.split('\n').filter((l: string) => l.startsWith('Hands:'));
    expect(line).toHaveLength(1);
    expect(line[0]).toMatch(/^Hands: shell off; web on until \d\d:\d\d \(ask with res ask shell 30 for a window\)$/);
  });
});
