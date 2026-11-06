// The Expression block rides the session-mode orientation only while a tag's capability is on, and only on the owner's chat surfaces.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ image: true, voice: true }));
vi.mock('../config.js', () => ({
  getSanctumConfig: vi.fn().mockReturnValue({
    identity: { companion_name: 'Test', user_name: 'User', timezone: 'UTC' },
    hooks: { context_injection: false, safe_write_prefixes: [], workspace_root: '', vault_path: '', extra_write_paths: [] },
    agent: { cwd: '/home/user/companion', mcp_json_path: '' },
    integrations: { mind_cloud: { enabled: false, mcp_url: '', mind_id: '' } },
    voice: { enabled: true },
    command_center: { enabled: false },
  }),
  PROJECT_ROOT: '/tmp/test',
}));
vi.mock('./db.js', () => ({
  getMessages: vi.fn().mockReturnValue([]), getConfig: () => null, getConfigBool: () => false, getConfigsByPrefix: () => ({}),
  setConfig: vi.fn(), getActiveTriggers: () => [], createMessage: vi.fn(), updateThreadActivity: vi.fn(),
}));
vi.mock('./audit.js', () => ({ logToolUse: vi.fn() }));
vi.mock('./files.js', () => ({ saveFile: vi.fn(), saveFileFromBase64: vi.fn(), saveFileInternal: vi.fn(), getContentTypeFromMime: vi.fn() }));
vi.mock('./imagegen/index.js', async (orig) => ({ ...(await orig<typeof import('./imagegen/index.js')>()), imagegenOffered: () => h.image }));
vi.mock('./ws.js', () => ({ registry: { broadcast: vi.fn() }, getVoiceService: () => ({ canTTS: h.voice }) }));

import { buildOrientationContext, type HookContext } from './hooks.js';

const ctx = (platform: HookContext['platform'] = 'web'): HookContext => ({
  threadId: 't', threadName: 'n', threadType: 'daily', streamMsgId: 's', isAutonomous: false,
  registry: {} as any, sessionId: null, platform, toolInsertions: [], getTextLength: () => 0,
});
beforeEach(() => { h.image = true; h.voice = true; });

describe('Expression block in the orientation', () => {
  it('lists image and voice when both are offered', async () => {
    const out = await buildOrientationContext(ctx(), 'session');
    expect(out).toContain('EXPRESSION');
    expect(out).toContain('[image: a short visual description]');
    expect(out).toContain('at most two per reply');
    expect(out).toContain('[voice]');
    expect(out).toContain('[voice:playful|warm|calm]');
  });

  it('drops the image line when image generation is not offered, and the voice line when voice is off', async () => {
    h.image = false;
    let out = await buildOrientationContext(ctx(), 'session');
    expect(out).not.toContain('[image:');
    expect(out).toContain('[voice]');
    h.voice = false;
    out = await buildOrientationContext(ctx(), 'session');
    expect(out).not.toContain('EXPRESSION');
    expect(out).not.toContain('[voice');
  });

  it('is absent on Discord and Telegram, and on the one-line turn mode', async () => {
    expect(await buildOrientationContext(ctx('discord'), 'session')).not.toContain('EXPRESSION');
    expect(await buildOrientationContext(ctx('telegram'), 'session')).not.toContain('EXPRESSION');
    expect(await buildOrientationContext(ctx('web'), 'turn')).not.toContain('EXPRESSION');
  });
});
