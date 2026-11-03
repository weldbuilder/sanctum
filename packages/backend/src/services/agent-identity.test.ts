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
  historyOpts: [] as any[],
  historyLines: [] as string[],
  prompts: [] as any[],
  queryThrows: null as null | Error,
  events: null as null | any[],
  gate: null as null | Promise<void>,
  frameFile: '',
  model: 'claude-echo-test-9',
}));

vi.mock('./providers/index.js', () => ({
  activeProvider: () => h.provider,
  AbortError: class AbortError extends Error {},
  listSessions: async () => [],
  query: (p: any) => {
    h.options = p.options; h.prompts.push(p.prompt);
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
vi.mock('./rolling-history.js', async (orig) => ({
  ...(await orig<typeof import('./rolling-history.js')>()),
  assembleRollingHistory: async (_t: string, _c: string, _a: boolean, o?: any) => { h.histories++; h.historyOpts.push(o); return ({ summary: '', notice: '', lines: h.historyLines, turns: h.historyLines.length, segments: 0 }); },
}));
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
    agent: { cwd: h.home, model: h.model, model_autonomous: h.model, claude_md_path: '', mcp_json_path: '/nonexistent/.mcp.json', system_prompt_file: h.frameFile, app_write: false, auto_compact: false, harness_memory: false },
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
  h.created = []; h.options = null; h.broadcasts = []; h.prompts = []; h.historyOpts = []; h.historyLines = [];
  h.frameFile = '';
  h.provider = 'claude';
});

describe('the Claude harness identity', () => {
  it('the rolling history names its speakers: Name: lines under a preface saying which are the companion\'s own words', async () => {
    h.historyLines = ['Pat: good morning', 'Echo: morning, Pat'];
    await turn();
    expect(h.historyOpts[0]).toMatchObject({ named: true });
    const p = h.prompts[0] as string;
    expect(p).toContain('Prior turns of this conversation. Lines marked Echo: are your own earlier words.\n\n[Conversation so far]\nPat: good morning\nEcho: morning, Pat');
    expect(p.indexOf('[Context]')).toBeLessThan(p.indexOf('[Conversation so far]'));
    expect(p.indexOf('[Conversation so far]')).toBeLessThan(p.indexOf('[Current message]\nhello'));
  });

  it.each(['codex', 'dsh'])('forwards the context block to the %s provider as sanctum.contextBlock', async (provider) => {
    h.provider = provider;
    await turn();
    const sanctum = h.options.sanctum;
    expect(sanctum.userContent).toBe('hello');
    expect(sanctum.contextBlock).toMatch(/^\[Context\]\n/);
    expect(sanctum.contextBlock).toMatch(/\n\[\/Context\]$/);
  });

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

// The agent reads the home and the configured path once at first use (per-process state), so each case below loads a fresh copy of the module;
// the frame file itself is resolved and read on every turn.
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
    // The frame and the identity are joined by exactly one blank line (the frame's trailing newline is trimmed, nothing else is added).
    expect(sp.slice(frame.length, frame.length + 2)).toBe('\n\n');
    expect(sp.slice(frame.length + 2).startsWith('# Companion Identity')).toBe(true);
    const at = sp.indexOf('Echo lives with Sam in the garden.');
    expect(at).toBeGreaterThan(frame.length);
    const last = sp.split('\n').pop() as string;
    expect(last.startsWith('[Runtime] Model serving this turn:')).toBe(true);
    // The [Runtime] line names the model the test configured, and is set off from what precedes it by a blank line.
    expect(last.startsWith(`[Runtime] Model serving this turn: ${h.model}. `)).toBe(true);
    expect(sp.slice(0, sp.length - last.length).endsWith('\n\n')).toBe(true);
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
  const frameDir = () => mkdtempSync(join(tmpdir(), 'sanctum-agent-frame-'));
  const homeCopy = (text: string) => { mkdirSync(join(h.home, 'config'), { recursive: true }); writeFileSync(join(h.home, 'config', 'companion-claude.md'), text); };

  it('the home copy (<home>/config/companion-claude.md) wins over the configured file', async () => {
    h.frameFile = join(frameDir(), 'frame.md');
    writeFileSync(h.frameFile, 'CONFIGURED FRAME');
    homeCopy('HOME FRAME\n');
    await freshTurn();
    const sp = h.options.systemPrompt;
    expect(typeof sp).toBe('string');
    expect(sp.startsWith('HOME FRAME')).toBe(true);
    expect(sp).not.toContain('CONFIGURED FRAME');
  });

  it('the home copy is used with no key at all, and an edit to it applies on the next turn', async () => {
    h.frameFile = '';
    homeCopy('FIRST HOME FRAME');
    vi.resetModules();
    const { AgentService: Fresh } = await import('./agent.js');
    const again = () => new Fresh().processMessage('t1', 'hello', { name: 'T', type: 'named' }, { platform: 'web' });
    await again();
    expect(h.options.systemPrompt.startsWith('FIRST HOME FRAME')).toBe(true);
    homeCopy('SECOND HOME FRAME');
    await again();
    expect(h.options.systemPrompt.startsWith('SECOND HOME FRAME')).toBe(true);
  });

  it('with no home copy the configured file is used', async () => {
    h.frameFile = join(frameDir(), 'frame.md');
    writeFileSync(h.frameFile, 'CONFIGURED FRAME');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await freshTurn();
      expect(h.options.systemPrompt.startsWith('CONFIGURED FRAME')).toBe(true);
      expect(warn).not.toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });

  it('neither file present and a non-empty key: the preset, and one warning that names the home path', async () => {
    h.frameFile = join(frameDir(), 'missing-frame.md');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await freshTurn();
      expect(h.options.systemPrompt.type).toBe('preset');
      const msgs = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('frame file is missing'));
      expect(msgs).toHaveLength(1);
      expect(msgs[0]).toContain(join(h.home, 'config', 'companion-claude.md'));
      expect(msgs[0]).not.toContain('prompts:build');
    } finally { warn.mockRestore(); }
  });

  it('an empty key and no home copy: the preset, and no warning', async () => {
    h.frameFile = '';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await freshTurn();
      expect(h.options.systemPrompt.type).toBe('preset');
      expect(warn.mock.calls.filter((c) => String(c[0]).includes('frame'))).toHaveLength(0);
    } finally { warn.mockRestore(); }
  });

  it.each(['codex', 'dsh'])('on %s the missing-file warning and the "frame active" line are not printed', async (provider) => {
    h.provider = provider;
    h.frameFile = join(frameDir(), 'missing-frame.md');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await freshTurn();
      expect(warn.mock.calls.filter((c) => String(c[0]).includes('frame file is missing'))).toHaveLength(0);
      homeCopy('HOME FRAME');
      await freshTurn();
      expect(log.mock.calls.filter((c) => String(c[0]).includes('System-prompt frame active'))).toHaveLength(0);
    } finally { warn.mockRestore(); log.mockRestore(); }
  });

  // The frame is the Claude harness's system prompt only: Codex and dsh carry their own base prompts, so a turn on them neither reads the file
  // nor lets it replace the preset (the per-turn read in agent.ts is gated on the provider).
  it.each(['codex', 'dsh'])('on %s a frame that is there is not read per turn: the system prompt stays the preset', async (provider) => {
    h.provider = provider;
    h.frameFile = join(frameDir(), 'frame.md');
    writeFileSync(h.frameFile, 'CONFIGURED FRAME');
    homeCopy('HOME FRAME');
    await freshTurn();
    expect(typeof h.options.systemPrompt).toBe('object');
    expect(h.options.systemPrompt.type).toBe('preset');
    expect(JSON.stringify(h.options.systemPrompt)).not.toContain('FRAME');
    // The same files on Claude do replace it (so the case above is about the gate, not about the files).
    h.provider = 'claude';
    await freshTurn();
    expect(h.options.systemPrompt.startsWith('HOME FRAME')).toBe(true);
  });
});
