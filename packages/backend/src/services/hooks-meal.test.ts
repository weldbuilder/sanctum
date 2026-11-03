import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config.js', () => ({
  getSanctumConfig: vi.fn().mockReturnValue({
    identity: { companion_name: 'Test', user_name: 'User', timezone: 'UTC' },
    hooks: { context_injection: false, safe_write_prefixes: [], workspace_root: '', vault_path: '', extra_write_paths: [] },
    agent: { cwd: '/home/user/companion', mcp_json_path: '' },
    integrations: { mind_cloud: { enabled: false, mcp_url: '', mind_id: '' } },
  }),
  PROJECT_ROOT: '/tmp/test',
}));

const db = vi.hoisted(() => ({
  cfg: {} as Record<string, string>,
  triggers: [] as any[],
  setConfig: vi.fn(),
}));
vi.mock('./db.js', () => ({
  getMessages: vi.fn().mockReturnValue([]),
  getConfig: (k: string) => db.cfg[k] ?? null,
  getConfigBool: () => false,
  getConfigsByPrefix: () => ({}),
  setConfig: db.setConfig,
  getActiveTriggers: () => db.triggers,
  createMessage: vi.fn(),
  updateThreadActivity: vi.fn(),
}));
vi.mock('./audit.js', () => ({ logToolUse: vi.fn() }));
vi.mock('./files.js', () => ({ saveFile: vi.fn(), saveFileFromBase64: vi.fn(), saveFileInternal: vi.fn(), getContentTypeFromMime: vi.fn() }));

import { buildOrientationContext, type HookContext } from './hooks.js';

const ctx = (): HookContext => ({
  threadId: 't', threadName: 'n', threadType: 'daily', streamMsgId: 's', isAutonomous: false,
  registry: {} as any, sessionId: null, platform: 'web', toolInsertions: [], getTextLength: () => 0,
});
const mealWatcher = (category: string) => ({
  id: category, kind: 'watcher', label: `${category} watch`, status: 'pending',
  conditions: JSON.stringify([{ type: 'care_missing', category, after: '14:00' }]),
});

beforeEach(() => {
  db.setConfig.mockClear();
  db.triggers = [];
  db.cfg = { 'her.state.latest': JSON.stringify({ at: new Date().toISOString(), sleepMin: 420 }) };
});

describe('meal ask respects the Automations watchers', () => {
  it('all meal watchers paused (absent from active list): no meal line, nudge_date untouched', async () => {
    db.triggers = [{ id: 'x', kind: 'watcher', label: 'calendar heads-up', status: 'pending', conditions: JSON.stringify([{ type: 'calendar_within', minutes: 20 }]) }];
    const out = await buildOrientationContext(ctx(), 'turn');
    expect(out).toContain('slept 7h00');
    expect(out).not.toContain('meal');
    expect(db.setConfig).not.toHaveBeenCalledWith('meal.nudge_date', expect.anything());
  });

  it('paused even when the day was already raised: still silent', async () => {
    db.cfg['meal.nudge_date'] = new Date().toISOString().slice(0, 10);
    const out = await buildOrientationContext(ctx(), 'turn');
    expect(out).not.toContain('meal');
  });

  it('one meal watcher active: meal line present and nudge_date advanced', async () => {
    db.triggers = [mealWatcher('dinner')];
    const out = await buildOrientationContext(ctx(), 'turn');
    expect(out).toContain('no meal logged (not yet raised today');
    expect(db.setConfig).toHaveBeenCalledWith('meal.nudge_date', expect.any(String));
  });
});
