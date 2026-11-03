// Verifier item 8: a Discord reply the gate withholds is NOT saved as a companion message and NOT
// handed to memory, and the retry note never reaches memory. The agent runs the turn, then hands the
// reply back HELD; the Discord module commits it only after the gated send. The web path is unchanged.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
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
vi.mock('./rolling-history.js', async (orig) => ({ ...(await orig<typeof import('./rolling-history.js')>()), assembleRollingHistory: async () => { h.histories++; return ({ summary: '', notice: '', lines: [], turns: 0, segments: 0 }); } }));
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
    identity: { companion_name: 'Echo', user_name: 'Pat', timezone: 'UTC' },
    agent: { cwd: '/nonexistent-agent-cwd', model: 'm', model_autonomous: 'm', claude_md_path: '', mcp_json_path: '/nonexistent/.mcp.json', system_prompt_file: '', app_write: false, auto_compact: false, harness_memory: false },
    command_center: { enabled: false },
    server: { host: '127.0.0.1', port: 1 },
    hooks: {},
  }),
  internalBaseUrl: () => 'http://127.0.0.1:1',
}));
vi.mock('../identity/load.js', () => ({ loadCompanionIdentity: () => ({}) }));
vi.mock('../identity/render.js', () => ({ describeIdentitySource: () => 'test', renderIdentityPrompt: () => '', fillIdentityNames: (s: string) => s }));
vi.mock('./auth-preferences.js', () => ({ applyAuthToEnv: () => {}, effectiveModel: (_k: string, d: string) => d, getAuthPreferences: () => ({}) }));
vi.mock('./usage-log.js', () => ({ recordUsage: () => {} }));

import { AgentService, AgentTurnError, type HeldReply } from './agent.js';

const companionMessages = () => h.created.filter((m) => m.role === 'companion');
const types = () => h.broadcasts.map((b) => b.type);
const settle = () => new Promise((r) => setTimeout(r, 0));

function service() {
  const agent = new AgentService();
  (agent as any).setPushService?.({ sendIfOffline: async (p: any) => { h.pushes.push(p); } });
  return agent;
}

beforeEach(() => {
  h.reply = 'the reply';
  h.created = [];
  h.ingested = [];
  h.broadcasts = [];
  h.pushes = [];
  h.toneSnaps = 0;
  h.provider = 'claude';
  h.options = null;
  h.rolling = true; h.recalls = []; h.prefetches = 0; h.histories = 0; h.queryThrows = null; h.events = null; h.gate = null;
});

describe('the web path is unchanged', () => {
  it('saves the companion message, streams it, ingests the exchange and pushes', async () => {
    const out = await service().processMessage('t1', 'hello there', { name: 'T', type: 'named' }, { platform: 'web' });
    expect(out).toBe('the reply');
    expect(companionMessages()).toHaveLength(1);
    expect(companionMessages()[0].content).toBe('the reply');
    expect(types()).toContain('stream_start');
    expect(types()).toContain('stream_end');
    await settle();
    expect(h.ingested).toEqual([{ threadId: 't1', user: 'hello there', assistant: 'the reply' }]);
    expect(h.pushes).toHaveLength(1);
  });
});

describe('a held Discord reply', () => {
  const run = async (opts: { userText?: string; ingest?: boolean; content?: string } = {}) => {
    let held: HeldReply | undefined;
    const out = await service().processMessage('t1', opts.content ?? 'hello there', { name: 'T', type: 'named' }, {
      platform: 'discord',
      senderIsOwner: true,
      hold: { userText: opts.userText ?? 'hello there', ingest: opts.ingest ?? true, onHeld: (r) => { held = r; } },
    });
    await settle();
    return { out, held: held! };
  };

  it('is handed back, not saved, not streamed, not ingested, not pushed', async () => {
    const { out, held } = await run();
    expect(out).toBe('the reply');
    expect(held.text).toBe('the reply');
    expect(companionMessages()).toEqual([]);
    expect(h.ingested).toEqual([]);
    expect(types()).not.toContain('stream_start');
    expect(types()).not.toContain('stream_end');
    expect(types()).not.toContain('stream_token');
    expect(h.pushes).toEqual([]);
    expect(h.toneSnaps).toBe(0);
  });

  it('discard leaves nothing behind', async () => {
    const { held } = await run();
    held.discard();
    await settle();
    expect(companionMessages()).toEqual([]);
    expect(h.ingested).toEqual([]);
    expect(h.pushes).toEqual([]);
  });

  it('commit saves the companion message once, broadcasts it, and ingests the ORIGINAL user text with the sent reply', async () => {
    const note = 'Your reply was not sent because it contained: Janie. Answer again without it.';
    const { held } = await run({ content: `hello there\n\n${note}`, userText: 'hello there' });
    held.commit();
    held.commit(); // a second commit is a no-op
    await settle();
    expect(companionMessages()).toHaveLength(1);
    expect(companionMessages()[0]).toMatchObject({ threadId: 't1', content: 'the reply', platform: 'discord' });
    expect(h.broadcasts.filter((b) => b.type === 'message' && b.message.role === 'companion')).toHaveLength(1);
    expect(h.ingested).toEqual([{ threadId: 't1', user: 'hello there', assistant: 'the reply' }]);
    expect(JSON.stringify(h.ingested)).not.toContain('Answer again');
    expect(h.pushes).toHaveLength(1);
  });

  it('a discarded reply cannot be committed afterwards', async () => {
    const { held } = await run();
    held.discard();
    held.commit();
    await settle();
    expect(companionMessages()).toEqual([]);
    expect(h.ingested).toEqual([]);
  });

  it('ingest: false (the public lane) saves the committed reply but never hands it to memory', async () => {
    const { held } = await run({ ingest: false });
    held.commit();
    await settle();
    expect(companionMessages()).toHaveLength(1);
    expect(h.ingested).toEqual([]);
  });

  it('on Codex or dsh the adapter is told not to ingest, and the commit does it (original text, sent reply)', async () => {
    h.provider = 'codex';
    const { held } = await run({ content: 'hello there\n\nnote', userText: 'hello there' });
    expect(h.options.sanctum).toMatchObject({ noIngest: true, userContent: 'hello there\n\nnote' });
    expect(h.ingested).toEqual([]);
    held.commit();
    await settle();
    expect(h.ingested).toEqual([{ threadId: 't1', user: 'hello there', assistant: 'the reply' }]);
  });

  it('on the Claude path nothing extra rides in the options', async () => {
    await run();
    expect(h.options.sanctum).toBeUndefined();
  });
});

describe("memory: 'none' on the agent path (a turn that must never touch the owner's memory)", () => {
  const run = async (rolling: boolean) => {
    h.rolling = rolling;
    let held: HeldReply | undefined;
    await service().processMessage('t1', 'hello there', { name: 'T', type: 'named' }, {
      platform: 'discord', senderIsOwner: false, memory: 'none',
      hold: { userText: 'hello there', ingest: true, onHeld: (r: HeldReply) => { held = r; } },
    } as any);
    held?.commit();
    await settle();
  };

  it('rolling on: no recall, no Mind prefetch, no rolling history, no ingest', async () => {
    await run(true);
    expect(h.recalls).toEqual([]);
    expect(h.prefetches).toBe(0);
    expect(h.histories).toBe(0);
    expect(h.ingested).toEqual([]);
  });

  it('rolling off: no recall, no Mind prefetch, no ingest', async () => {
    await run(false);
    expect(h.recalls).toEqual([]);
    expect(h.prefetches).toBe(0);
    expect(h.ingested).toEqual([]);
  });

  it('on Codex the adapter is told, in sanctum.memory', async () => {
    h.provider = 'codex';
    await run(false);
    expect(h.options.sanctum).toMatchObject({ memory: 'none', noIngest: true });
    expect(h.ingested).toEqual([]);
  });

  it('without it the owner turn still recalls (the option is the only switch)', async () => {
    h.rolling = true;
    await service().processMessage('t1', 'hello there', { name: 'T', type: 'named' }, { platform: 'discord', senderIsOwner: true, hold: { userText: 'hello there', ingest: true, onHeld: () => {} } });
    expect(h.recalls).toEqual(['hello there']);
  });
});

describe('a held owner turn on Claude with rolling OFF does not ingest (it matches the web path)', () => {
  it('commit saves the reply and ingests nothing', async () => {
    h.rolling = false;
    let held: HeldReply | undefined;
    await service().processMessage('t1', 'hello there', { name: 'T', type: 'named' }, {
      platform: 'discord', senderIsOwner: true,
      hold: { userText: 'hello there', ingest: true, onHeld: (r) => { held = r; } },
    });
    held!.commit();
    await settle();
    expect(companionMessages()).toHaveLength(1);
    expect(h.ingested).toEqual([]);
  });

  it('the web path with rolling off ingests nothing either (the baseline it matches)', async () => {
    h.rolling = false;
    await service().processMessage('t1', 'hello there', { name: 'T', type: 'named' }, { platform: 'web' });
    await settle();
    expect(h.ingested).toEqual([]);
  });
});

describe('an agent error is never the reply on a held turn', () => {
  const hold = () => {
    const onHeld = vi.fn();
    return { onHeld, opts: { platform: 'discord' as const, senderIsOwner: true, hold: { userText: 'hi', ingest: true, onHeld } } };
  };

  it('a thrown provider error rejects with a class and nothing else: no held reply, nothing saved, ingested or pushed', async () => {
    h.queryThrows = Object.assign(new Error('ENOENT: open /home/x/secret/path.txt at Object.<anonymous> (/srv/app.js:1:1)'), { name: 'SpawnError' });
    const { onHeld, opts } = hold();
    const err: any = await service().processMessage('t1', 'hi', { name: 'T', type: 'named' }, opts).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(AgentTurnError);
    expect(err.kind).toBe('error');
    expect(err.message).not.toMatch(/secret|path|\/srv|ENOENT|at /);
    expect(onHeld).not.toHaveBeenCalled();
    await settle();
    expect(companionMessages()).toEqual([]);
    expect(h.ingested).toEqual([]);
    expect(h.pushes).toEqual([]);
  });

  it('a failed result with no text rejects too', async () => {
    h.events = [{ type: 'result', subtype: 'error_during_execution', errors: ['rate limited: /home/x/key'] }];
    const { onHeld, opts } = hold();
    const err: any = await service().processMessage('t1', 'hi', { name: 'T', type: 'named' }, opts).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(AgentTurnError);
    expect(err.message).not.toContain('/home/x');
    expect(onHeld).not.toHaveBeenCalled();
    expect(h.ingested).toEqual([]);
  });

  const partial = (subtype: string) => [
    { type: 'assistant', session_id: 's1', message: { content: [{ type: 'text', text: 'half an answer that stops mid-sen' }] } },
    { type: 'result', subtype, session_id: 's1', errors: ['ran out: /home/x/key'] },
  ];

  it('partial text followed by error_max_turns rejects a held turn with the class max_turns: the partial is never held, saved or sent', async () => {
    h.events = partial('error_max_turns');
    const { onHeld, opts } = hold();
    const err: any = await service().processMessage('t1', 'hi', { name: 'T', type: 'named' }, opts).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(AgentTurnError);
    expect(err.kind).toBe('max_turns');
    expect(err.message).not.toMatch(/half an answer|\/home/);
    expect(onHeld).not.toHaveBeenCalled();
    await settle();
    expect(companionMessages()).toEqual([]);
    expect(h.ingested).toEqual([]);
    expect(h.pushes).toEqual([]);
  });

  it('partial text followed by error_during_execution rejects a held turn as provider_error (any non-success subtype does)', async () => {
    for (const subtype of ['error_during_execution', 'error_max_budget_usd', 'something_new']) {
      h.events = partial(subtype);
      const { onHeld, opts } = hold();
      const err: any = await service().processMessage('t1', 'hi', { name: 'T', type: 'named' }, opts).then(() => null, (e) => e);
      expect(err, subtype).toBeInstanceOf(AgentTurnError);
      expect(err.kind, subtype).toBe('provider_error');
      expect(onHeld, subtype).not.toHaveBeenCalled();
    }
  });

  it('a success result (or none) with text is still held, as before', async () => {
    h.events = [
      { type: 'assistant', session_id: 's1', message: { content: [{ type: 'text', text: 'all of it' }] } },
      { type: 'result', subtype: 'success', session_id: 's1' },
    ];
    const { onHeld, opts } = hold();
    expect(await service().processMessage('t1', 'hi', { name: 'T', type: 'named' }, opts)).toBe('all of it');
    expect(onHeld).toHaveBeenCalledTimes(1);
  });

  it('the WEB path keeps showing the partial text after a failure subtype', async () => {
    h.events = partial('error_max_turns');
    const out = await service().processMessage('t1', 'hi', { name: 'T', type: 'named' }, { platform: 'web' });
    expect(out).toBe('half an answer that stops mid-sen');
    expect(companionMessages()).toHaveLength(1);
    expect(companionMessages()[0].content).toBe('half an answer that stops mid-sen');
  });

  it('the web path is unchanged: the error text is the reply the owner sees', async () => {
    h.queryThrows = new Error('boom');
    const out = await service().processMessage('t1', 'hi', { name: 'T', type: 'named' }, { platform: 'web' });
    expect(out).toBe('[Agent error: boom]');
  });
});

describe('a full or timed-out queue is an error on a held turn, never a reply', () => {
  it('rejects with kind queue_full for Discord, and the web path still gets the busy text', async () => {
    let release!: () => void;
    h.gate = new Promise<void>((r) => { release = r; });
    const meta = { name: 'T', type: 'named' as const };
    const held = () => ({ platform: 'discord' as const, senderIsOwner: true, hold: { userText: 'x', ingest: true, onHeld: () => {} } });
    const svc = service();
    const first = svc.processMessage('t1', 'a', meta, held());
    const queued = Array.from({ length: 5 }, () => svc.processMessage('t1', 'b', meta, held()));
    const err: any = await svc.processMessage('t1', 'c', meta, held()).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(AgentTurnError);
    expect(err.kind).toBe('queue_full');
    const exclusive: any = await svc.runExclusive(async () => 'a public reply').then(() => null, (e) => e);
    expect(exclusive).toBeInstanceOf(AgentTurnError);
    expect(exclusive.kind).toBe('queue_full');
    const web = await svc.processMessage('t1', 'd', meta, { platform: 'web' });
    expect(web).toMatch(/busy/);
    h.gate = null;
    release();
    await Promise.all([first, ...queued]);
  });
});
