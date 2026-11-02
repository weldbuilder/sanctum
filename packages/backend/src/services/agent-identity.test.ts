// The Claude harness reads the companion's identity from the home's identity folder (services/identity/source.ts),
// with the real loader and renderer, on every query: the system prompt carries what is in the home now.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const h = vi.hoisted(() => ({
  home: '',
  ledgerDir: '',
  reply: 'the reply',
  created: [] as any[],
  ingested: [] as any[],
  broadcasts: [] as any[],
  pushes: [] as any[],
  toneSnaps: 0,
  provider: 'claude',
  options: null as any,
  rolling: true,
  recalls: [] as string[],
  prefetches: 0,
  histories: 0,
  queryThrows: null as null | Error,
  events: null as null | any[],
  gate: null as null | Promise<void>,
  frameFile: '',
}));

vi.mock('./providers/index.js', () => ({
  activeProvider: () => h.provider,
  AbortError: class AbortError extends Error {},
  listSessions: async () => [],
  query: (p: any) => {
    h.options = p.options;
    const events = h.events ?? [{ type: 'assistant', session_id: 's1', message: { content: [{ type: 'text', text: h.reply }] } }, { type: 'result', session_id: 's1' }];
    const it = (async function* () { if (h.gate) await h.gate; if (h.queryThrows) throw h.queryThrows; for (const e of events) yield e; })();
    return Object.assign(it, { mcpServerStatus: async () => [], interrupt: async () => {}, close: () => {} });
  },
}));
vi.mock('./plugins.js', () => ({ senderIsOwnerFor: () => true }));
vi.mock('./rolling-context.js', () => ({
  getRolling: () => ({ maybeCompact: async () => {}, readTurns: async () => [] }),
  rollingEnabledForActiveProvider: () => h.rolling,
}));
vi.mock('./rolling-history.js', () => ({ assembleRollingHistory: async () => { h.histories++; return ({ summary: '', notice: '', lines: [], turns: 0, segments: 0 }); } }));
vi.mock('../middleware/internal-token.js', () => ({ getInternalToken: () => 't' }));
vi.mock('./revien.js', () => ({
  MEMORY_HEADER: '[memory]',
  recallForPrompt: async (q: string) => { h.recalls.push(q); return ''; },
  ingestTurn: async (p: any) => { h.ingested.push(p); },
}));
vi.mock('./files.js', () => ({ getFile: () => null }));
vi.mock('./db.js', () => ({
  createMessage: (m: any) => { h.created.push(m); return { ...m, thread_id: m.threadId, created_at: m.createdAt }; },
  updateThreadSession: () => {},
  getThread: () => ({ id: 't1', name: 'T', type: 'named', current_session_id: null, model: null, effort: null, show_thinking: false }),
  updateThreadActivity: () => {},
  createSessionRecord: () => {},
  endSessionRecord: () => {},
  setConfig: () => {},
  getConfig: () => null,
}));
vi.mock('./ws.js', () => ({ registry: { broadcast: (m: any) => { h.broadcasts.push(m); } } }));
vi.mock('./hooks.js', () => ({
  createHooks: () => ({}),
  buildOrientationContext: async () => '',
  prefetchMindContext: async () => { h.prefetches++; return ''; },
  maybeSnapshotTone: () => { h.toneSnaps++; },
}));
vi.mock('../config.js', () => ({
  getSanctumConfig: () => ({
    identity: { companion_name: 'Echo', user_name: 'Pat', timezone: 'UTC', profile_path: '', companion_md_path: '', ledger_dir: h.ledgerDir },
    agent: { cwd: h.home, model: 'm', model_autonomous: 'm', claude_md_path: '', mcp_json_path: '/nonexistent/.mcp.json', system_prompt_file: h.frameFile, app_write: false, auto_compact: false, harness_memory: false },
    command_center: { enabled: false },
    server: { host: '127.0.0.1', port: 1 },
    hooks: {},
  }),
  internalBaseUrl: () => 'http://127.0.0.1:1',
}));
vi.mock('./auth-preferences.js', () => ({ applyAuthToEnv: () => {}, effectiveModel: (_k: string, d: string) => d, getAuthPreferences: () => ({}) }));
vi.mock('./usage-log.js', () => ({ recordUsage: () => {} }));


import { AgentService } from './agent.js';
import { ratifyIdentity } from './identity/ledger.js';

const prompt = (): string => {
  const sp = h.options.systemPrompt;
  return typeof sp === 'string' ? sp : String(sp.append ?? '');
};
const turn = () => new AgentService().processMessage('t1', 'hello', { name: 'T', type: 'named' }, { platform: 'web' });

beforeEach(() => {
  h.home = mkdtempSync(join(tmpdir(), 'sanctum-agent-home-'));
  h.ledgerDir = join(mkdtempSync(join(tmpdir(), 'sanctum-agent-ledger-')), 'identity');
  h.created = []; h.options = null; h.broadcasts = [];
  h.frameFile = '';
});

describe('the Claude harness identity', () => {
  it("carries the home's identity/profile.md and companion.md (not the project root's)", async () => {
    mkdirSync(join(h.home, 'identity'));
    writeFileSync(join(h.home, 'identity', 'profile.md'), 'Hazel lives in the garden.');
    writeFileSync(join(h.home, 'identity', 'companion.md'), 'I am Hazel, and I stay myself.');
    await turn();
    expect(prompt()).toContain('# Companion Identity\n\nHazel lives in the garden.');
    expect(prompt()).toContain('## Companion Narrative\n\nI am Hazel, and I stay myself.');
  });

  it('picks up an edit on the next query, with no restart', async () => {
    mkdirSync(join(h.home, 'identity'));
    writeFileSync(join(h.home, 'identity', 'companion.md'), 'first words');
    await turn();
    expect(prompt()).toContain('first words');
    writeFileSync(join(h.home, 'identity', 'companion.md'), 'second words');
    await turn();
    expect(prompt()).toContain('second words');
    expect(prompt()).not.toContain('first words');
  });

  it('boots on the ratified identity while a change waits, and says so on the first query after the change', async () => {
    mkdirSync(join(h.home, 'identity'));
    writeFileSync(join(h.home, 'identity', 'profile.md'), 'Hazel lives in the garden.');
    await turn(); // first sight: nothing ratified yet, the live files are served
    expect(prompt()).toContain('Hazel lives in the garden.');
    ratifyIdentity(h.home, { ledgerDir: h.ledgerDir, trustStat: false }, { by: 'person' });
    writeFileSync(join(h.home, 'identity', 'profile.md'), 'HOSTILE REWRITE');
    await turn();
    expect(prompt()).toContain('Hazel lives in the garden.');
    expect(prompt()).not.toContain('HOSTILE REWRITE');
    expect(prompt()).toContain('A change to profile.md is waiting for the person to ratify it; this run uses the ratified version.');
  });
});

// The agent reads agent.system_prompt_file once at first use (per-process state), so each case below loads a fresh copy of the module.
describe('the Claude harness frame (agent.system_prompt_file)', () => {
  const freshTurn = async () => {
    vi.resetModules();
    const { AgentService: Fresh } = await import('./agent.js');
    await new Fresh().processMessage('t1', 'hello', { name: 'T', type: 'named' }, { platform: 'web' });
  };

  it('replaces the claude_code preset: frame, then identity, then the [Runtime] line', async () => {
    const frame = 'FRAME-START You are Echo, living in a home, not a codebase. FRAME-END';
    h.frameFile = join(mkdtempSync(join(tmpdir(), 'sanctum-agent-frame-')), 'frame.md');
    writeFileSync(h.frameFile, `${frame}\n`);
    mkdirSync(join(h.home, 'identity'));
    writeFileSync(join(h.home, 'identity', 'profile.md'), 'Echo lives with Sam in the garden.');
    await freshTurn();
    const sp = h.options.systemPrompt;
    expect(typeof sp).toBe('string');
    expect(sp.startsWith(frame)).toBe(true);
    const at = sp.indexOf('Echo lives with Sam in the garden.');
    expect(at).toBeGreaterThan(frame.length);
    const last = sp.split('\n').pop() as string;
    expect(last.startsWith('[Runtime] Model serving this turn:')).toBe(true);
    expect(sp.indexOf('[Runtime] Model serving this turn:')).toBeGreaterThan(at);
  });

  it('falls back to the claude_code preset when the configured frame file does not exist', async () => {
    h.frameFile = join(mkdtempSync(join(tmpdir(), 'sanctum-agent-frame-')), 'missing-frame.md');
    mkdirSync(join(h.home, 'identity'));
    writeFileSync(join(h.home, 'identity', 'profile.md'), 'Echo lives with Sam in the garden.');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await freshTurn();
      const sp = h.options.systemPrompt;
      expect(typeof sp).toBe('object');
      expect(sp.type).toBe('preset');
      expect(sp.preset).toBe('claude_code');
      expect(sp.append).toContain('Echo lives with Sam in the garden.');
      expect(warn.mock.calls.some((c) => String(c[0]).includes('frame file is missing') && String(c[0]).includes('missing-frame.md'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});
