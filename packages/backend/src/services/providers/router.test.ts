import { describe, it, expect, vi } from 'vitest';

vi.mock('../../config.js', () => ({ getSanctumConfig: () => ({ agent: {} }) }));
vi.mock('../db.js', () => ({ getConfig: () => null, setConfig: () => {} }));
vi.mock('./index.js', () => ({ query: () => { throw new Error('unused'); }, activeProvider: () => 'claude' }));
vi.mock('./openai-compat-harness.js', () => ({ openaiCompatQuery: () => { throw new Error('unused'); } }));

import { planBrains, healthAfterFailure, routedQuery, failureInMessage, fallbackReady, resetRouterWarnings, type BrainEvent, type BrainHealth, type RouterDeps } from './router.js';
import type { FailClass } from '../error-class.js';

const HEALTHY: BrainHealth = { unhealthyUntil: null, missingProvider: '' };
const NOW = 1_000_000;

describe('planBrains: mode x health', () => {
  const rows: Array<[string, Parameters<typeof planBrains>[0]['mode'], boolean, BrainHealth, string[]]> = [
    ['off: primary only', 'off', true, HEALTHY, ['primary']],
    ['off, even when unhealthy', 'off', true, { unhealthyUntil: NOW + 5000, missingProvider: '' }, ['primary']],
    ['fallback not ready: primary only (always)', 'always', false, HEALTHY, ['primary']],
    ['fallback not ready: primary only (auto)', 'auto', false, { unhealthyUntil: NOW + 5000, missingProvider: '' }, ['primary']],
    ['always: fallback first, primary the net', 'always', true, HEALTHY, ['fallback', 'primary']],
    ['auto, healthy: primary first', 'auto', true, HEALTHY, ['primary', 'fallback']],
    ['auto, unhealthy window open: fallback first', 'auto', true, { unhealthyUntil: NOW + 1, missingProvider: '' }, ['fallback', 'primary']],
    ['auto, unhealthy window over: primary first again', 'auto', true, { unhealthyUntil: NOW, missingProvider: '' }, ['primary', 'fallback']],
    ['auto, binary missing: fallback first', 'auto', true, { unhealthyUntil: null, missingProvider: 'dsh' }, ['fallback', 'primary']],
    ['auto, missing pin was for another provider: ignored', 'auto', true, { unhealthyUntil: null, missingProvider: 'codex' }, ['primary', 'fallback']],
  ];
  for (const [name, mode, ready, health, want] of rows) {
    it(name, () => expect(planBrains({ mode, fallbackReady: ready, health, primaryName: 'dsh', now: NOW })).toEqual(want));
  }
});

describe('healthAfterFailure: which classes pin the primary', () => {
  const after = (cls: FailClass) => healthAfterFailure(cls, HEALTHY, { now: NOW, unhealthyMinutes: 10, primaryName: 'claude' });
  for (const cls of ['AUTH', 'CREDIT', 'RATE_LIMIT'] as FailClass[]) {
    it(`${cls} pins unhealthy for unhealthy_minutes`, () => expect(after(cls)).toEqual({ unhealthyUntil: NOW + 600_000, missingProvider: '' }));
  }
  it('HARNESS_MISSING pins until a successful primary run (no clock)', () => expect(after('HARNESS_MISSING')).toEqual({ unhealthyUntil: null, missingProvider: 'claude' }));
  for (const cls of ['TIMEOUT', 'NETWORK', 'SERVER', 'HARNESS_HUNG', 'OTHER', 'CANCELLED'] as FailClass[]) {
    it(`${cls} pins nothing`, () => expect(after(cls)).toEqual(HEALTHY));
  }
});

// ─── routedQuery against stub brains ────────────────────────────────────────────────────────────────────────────────────
const text = (t: string) => [
  { type: 'system', subtype: 'init', session_id: 's' },
  { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: t } } },
  { type: 'assistant', message: { content: [{ type: 'text', text: t }] } },
  { type: 'result', subtype: 'success', result: t },
];
type Script = { msgs?: any[]; throws?: unknown; throwsAfter?: number; hang?: boolean; meta?: any };
const stub = (s: Script) => (): any => {
  const gen = (async function* () {
    if (s.hang) await new Promise(() => {});
    let n = 0;
    for (const m of s.msgs ?? []) { if (s.throwsAfter !== undefined && n++ === s.throwsAfter) throw s.throws; yield m; }
    if (s.throws !== undefined && s.throwsAfter === undefined) throw s.throws;
  })();
  return Object.assign(gen, { mcpServerStatus: async () => [], interrupt: async () => {}, meta: s.meta });
};

function harness(o: { mode?: 'off' | 'auto' | 'always'; primary: Script; fallback?: Script; kv?: Record<string, string>; ready?: boolean; provider?: string; now?: number; firstOutputMs?: number }) {
  const kv: Record<string, string> = { ...(o.kv ?? {}) };
  const events: BrainEvent[] = [];
  const calls: string[] = [];
  const seenOptions: any[] = [];
  const wrap = (name: string, s: Script) => (p: any) => { calls.push(name); seenOptions.push(p.options); return stub(s)(); };
  const deps: Partial<RouterDeps> = {
    now: () => o.now ?? NOW,
    kvGet: (k) => kv[k] ?? null,
    kvSet: (k, v) => { kv[k] = v; },
    config: () => ({ provider: 'openai-compat', mode: o.mode ?? 'auto', model: 'fb-model', base_url: 'http://x', api_key_env: 'FK', max_tool_turns: 8, unhealthy_minutes: 10 }),
    primaryName: () => o.provider ?? 'claude',
    hasKey: () => o.ready !== false,
    primary: wrap('primary', o.primary),
    fallback: wrap('fallback', o.fallback ?? { msgs: text('from the fallback'), meta: { toolsOffered: 3, toolsRun: 1, degraded: false } }),
    firstOutputMs: o.firstOutputMs ?? 5000,
  };
  const ac = new AbortController();
  const q: any = routedQuery({ prompt: 'hi', options: { abortController: ac, sanctum: { threadId: 't' } } as any }, { onEvent: (e) => events.push(e) }, deps);
  const drain = async () => { const out: any[] = []; for await (const m of q) out.push(m); return out; };
  return { q, kv, events, calls, seenOptions, drain, ac };
}
const resultText = (out: any[]) => out.filter((m) => m.type === 'result').map((m) => m.result);

describe('routedQuery: a healthy primary is untouched', () => {
  it('passes every message through in order, never starts the fallback, reports nothing', async () => {
    const h = harness({ primary: { msgs: text('hello') } });
    const out = await h.drain();
    expect(out).toEqual(text('hello'));
    expect(h.calls).toEqual(['primary']);
    expect(h.events).toEqual([]);
    expect(h.kv.brain_active).toBe('primary');
  });

  it('strips the adapters-only `sanctum` option from a Claude primary, and keeps it for the fallback', async () => {
    const h = harness({ mode: 'always', primary: { msgs: text('p') }, fallback: { throws: new Error('boom') } });
    await h.drain();
    expect(h.calls).toEqual(['fallback', 'primary']);
    expect(h.seenOptions[0].sanctum).toEqual({ threadId: 't' });
    expect(h.seenOptions[1].sanctum).toBeUndefined();
  });

  it('exposes the first attempt to the caller before it is read (agent.ts asks for MCP status at once)', async () => {
    const h = harness({ primary: { msgs: text('x') } });
    expect(h.calls).toEqual(['primary']);
    expect(await h.q.mcpServerStatus()).toEqual([]);
    await h.drain();
  });
});

describe('routedQuery: fallover by error class (primary throws before saying anything)', () => {
  const err = (m: string, x: Record<string, unknown> = {}) => Object.assign(new Error(m), x);
  const rows: Array<[string, unknown, FailClass, boolean]> = [
    ['AUTH', err('Invalid API key · Please run /login'), 'AUTH', true],
    ['CREDIT', err('Credit balance is too low'), 'CREDIT', true],
    ['RATE_LIMIT', err('429 Too Many Requests'), 'RATE_LIMIT', true],
    ['TIMEOUT', err('connect ETIMEDOUT 1.2.3.4:443'), 'TIMEOUT', true],
    ['NETWORK', err('read ECONNRESET'), 'NETWORK', true],
    ['SERVER', err('529 overloaded_error'), 'SERVER', true],
    ['HARNESS_MISSING', err('spawn claude ENOENT', { code: 'ENOENT', syscall: 'spawn claude' }), 'HARNESS_MISSING', true],
    ['HARNESS_HUNG', err('dsh timed out after 1800000ms'), 'HARNESS_HUNG', true],
    ['OTHER stays on the primary and surfaces', err('Cannot read properties of undefined'), 'OTHER', false],
    ['user cancel stays and surfaces', err('The operation was aborted', { name: 'AbortError' }), 'CANCELLED', false],
  ];
  for (const [name, e, cls, moves] of rows) {
    it(`${name}: ${moves ? 'moves to the fallback' : 'does not move'}`, async () => {
      const h = harness({ primary: { throws: e } });
      if (moves) {
        const out = await h.drain();
        expect(resultText(out)).toEqual(['from the fallback']);
        expect(h.calls).toEqual(['primary', 'fallback']);
        expect(h.kv.brain_last_error).toBe(cls);
        expect(h.kv.brain_active).toBe('fallback');
        expect(h.events).toEqual([{ type: 'fallover', cls, model: 'fb-model' }]);
      } else {
        await expect(h.drain()).rejects.toBe(e);
        expect(h.calls).toEqual(['primary']);
        expect(h.events).toEqual([]);
      }
    });
  }

  it('a user stop while the primary runs is never a fallover, even if the error reads like a timeout', async () => {
    const h = harness({ primary: { throws: Object.assign(new Error('timed out'), { name: 'AbortError' }) } });
    h.ac.abort();
    await expect(h.drain()).rejects.toBeTruthy();
    expect(h.calls).toEqual(['primary']);
  });
});

describe('routedQuery: failures that arrive as messages, not throws', () => {
  it('an assistant message carrying an SDK auth error is held back and the fallback answers', async () => {
    const bad = [
      { type: 'system', subtype: 'init' },
      { type: 'assistant', error: 'authentication_failed', message: { content: [{ type: 'text', text: 'Invalid API key · Please run /login' }] } },
      { type: 'result', subtype: 'success', is_error: true, result: 'Invalid API key' },
    ];
    const h = harness({ primary: { msgs: bad } });
    const out = await h.drain();
    expect(JSON.stringify(out)).not.toContain('Invalid API key');
    expect(resultText(out)).toEqual(['from the fallback']);
    expect(h.kv.brain_last_error).toBe('AUTH');
  });

  it('a failed result (rate limit text) before any output moves the turn', async () => {
    const h = harness({ primary: { msgs: [{ type: 'system', subtype: 'init' }, { type: 'result', subtype: 'error_during_execution', errors: ['You have hit your usage limit'] }] } });
    expect(resultText(await h.drain())).toEqual(['from the fallback']);
  });

  it('error_max_turns is the turn running long, not the brain being down: surfaced as it was', async () => {
    const msgs = [{ type: 'system', subtype: 'init' }, { type: 'result', subtype: 'error_max_turns', errors: ['too many'] }];
    const h = harness({ primary: { msgs } });
    expect(await h.drain()).toEqual(msgs);
    expect(h.calls).toEqual(['primary']);
  });

  it('if every brain fails, the primary\'s failure is what the caller sees', async () => {
    const e = new Error('Invalid API key');
    const h = harness({ primary: { throws: e }, fallback: { throws: new Error('read ECONNRESET') } });
    await expect(h.drain()).rejects.toBe(e);
    expect(h.calls).toEqual(['primary', 'fallback']);
    expect(h.kv.brain_fallback_error).toBe('NETWORK');
  });
});

describe('routedQuery: once a brain has said something, the turn is its own', () => {
  it('a failure after the first token is surfaced, never retried on the fallback', async () => {
    const boom = new Error('read ECONNRESET');
    const h = harness({ primary: { msgs: text('half'), throws: boom, throwsAfter: 2 } });
    const out: any[] = [];
    await expect((async () => { for await (const m of h.q) out.push(m); })()).rejects.toBe(boom);
    expect(out.some((m) => m.type === 'stream_event')).toBe(true);
    expect(h.calls).toEqual(['primary']);
    expect(h.events).toEqual([]);
  });
});

describe('routedQuery: hung harness', () => {
  it('no visible output past the guard is HARNESS_HUNG and moves to the fallback', async () => {
    const h = harness({ primary: { hang: true }, firstOutputMs: 20 });
    const out = await h.drain();
    expect(resultText(out)).toEqual(['from the fallback']);
    expect(h.kv.brain_last_error).toBe('HARNESS_HUNG');
    expect(h.calls).toEqual(['primary', 'fallback']);
  });
});

describe('routedQuery: modes and health end to end', () => {
  it('off: the failure is the primary\'s, no fallback is ever started', async () => {
    const e = new Error('Invalid API key');
    const h = harness({ mode: 'off', primary: { throws: e } });
    await expect(h.drain()).rejects.toBe(e);
    expect(h.calls).toEqual(['primary']);
    expect(h.kv.brain_last_error).toBe('AUTH'); // recorded for the status page
    expect(h.kv['brain.primary_unhealthy_until']).toBeUndefined(); // but nothing is pinned with nobody to hand over to
  });

  it('always: the fallback answers first; the primary is never started when it succeeds', async () => {
    const h = harness({ mode: 'always', primary: { msgs: text('p') } });
    expect(resultText(await h.drain())).toEqual(['from the fallback']);
    expect(h.calls).toEqual(['fallback']);
    expect(h.events).toEqual([{ type: 'fallover', cls: null, model: 'fb-model' }]);
  });

  it('always: a broken fallback falls to the primary, whatever the class', async () => {
    const h = harness({ mode: 'always', primary: { msgs: text('p') }, fallback: { throws: new Error('agent.fallback.model is required') } });
    expect(resultText(await h.drain())).toEqual(['p']);
    expect(h.calls).toEqual(['fallback', 'primary']);
  });

  it('auto: AUTH pins the primary; the next turn starts on the fallback without trying the primary first; the window ends and the primary is first again', async () => {
    const kv: Record<string, string> = {};
    const run = async (now: number, primary: Script) => { const h = harness({ primary, kv, now }); const out = await h.drain(); Object.assign(kv, h.kv); return { calls: h.calls, events: h.events, out }; };
    const t1 = await run(NOW, { throws: new Error('Invalid API key') });
    expect(t1.calls).toEqual(['primary', 'fallback']);
    expect(kv['brain.primary_unhealthy_until']).toBe(String(NOW + 600_000));
    const t2 = await run(NOW + 60_000, { msgs: text('p') });
    expect(t2.calls).toEqual(['fallback']); // pinned: the fallback is first, the primary is not tried
    expect(t2.events).toEqual([]); // no second "running on the fallback" line while it stays there
    const t3 = await run(NOW + 601_000, { msgs: text('p back') });
    expect(t3.calls).toEqual(['primary']);
    expect(resultText(t3.out)).toEqual(['p back']);
    expect(t3.events).toEqual([{ type: 'recovered' }]);
    expect(kv.brain_active).toBe('primary');
    expect(kv['brain.primary_unhealthy_until']).toBe(''); // cleared by the successful primary run
  });

  it('auto: a pinned turn says why (the class that pinned it)', async () => {
    const h = harness({ primary: { msgs: text('p') }, kv: { 'brain.primary_unhealthy_until': String(NOW + 1000), brain_last_error: 'CREDIT' } });
    await h.drain();
    expect(h.events).toEqual([{ type: 'fallover', cls: 'CREDIT', model: 'fb-model' }]);
  });

  it('auto: HARNESS_MISSING pins until a primary run succeeds; the safety-net run that succeeds clears it', async () => {
    const miss = Object.assign(new Error('spawn dsh ENOENT'), { code: 'ENOENT', syscall: 'spawn dsh' });
    const first = harness({ provider: 'dsh', primary: { throws: miss } });
    await first.drain();
    expect(first.kv['brain.primary_missing']).toBe('dsh');
    const second = harness({ provider: 'dsh', primary: { msgs: text('p') }, kv: first.kv, now: NOW + 99 * 3_600_000 });
    await second.drain();
    expect(second.calls).toEqual(['fallback']); // still pinned, however late
    const swapped = harness({ provider: 'claude', primary: { msgs: text('p') }, kv: first.kv });
    await swapped.drain();
    expect(swapped.calls).toEqual(['primary']); // the provider changed: the pin no longer applies
  });

  it('auto: TIMEOUT, NETWORK, SERVER move one turn and pin nothing', async () => {
    const h = harness({ primary: { throws: new Error('read ECONNRESET') } });
    await h.drain();
    expect(h.kv['brain.primary_unhealthy_until']).toBe('');
    expect(h.kv['brain.primary_missing']).toBe('');
  });

  it('fallover is announced once and recovery once', async () => {
    const kv: Record<string, string> = {};
    const a = harness({ primary: { throws: new Error('429 Too Many Requests') }, kv }); await a.drain(); Object.assign(kv, a.kv);
    expect(a.events).toHaveLength(1);
    const b = harness({ primary: { throws: new Error('429 Too Many Requests') }, kv, now: NOW + 1 }); await b.drain(); Object.assign(kv, b.kv);
    expect(b.events).toEqual([]);
    const c = harness({ primary: { msgs: text('ok') }, kv, now: NOW + 99 * 3_600_000 }); await c.drain();
    expect(c.events).toEqual([{ type: 'recovered' }]);
  });
});

describe('brainInfo and fallbackReady', () => {
  it('reports the fallback\'s tool counts (agent.ts reads them for the honesty guard)', async () => {
    const h = harness({ mode: 'always', primary: { msgs: text('p') }, fallback: { msgs: text('f'), meta: { toolsOffered: 4, toolsRun: 0, degraded: true } } });
    await h.drain();
    expect(h.q.brainInfo()).toMatchObject({ active: 'fallback', toolsOffered: 4, toolsRun: 0, degraded: true });
  });

  it('a half-set fallback block warns once and is not ready', () => {
    resetRouterWarnings();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = { provider: 'openai-compat', mode: 'auto', model: '', base_url: '', api_key_env: 'FK' } as any;
    expect(fallbackReady({ config: () => cfg, hasKey: () => false })).toBe(false);
    expect(fallbackReady({ config: () => cfg, hasKey: () => false })).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('agent.fallback.base_url');
    expect(String(warn.mock.calls[0][0])).toContain('FK');
    warn.mockRestore();
    expect(fallbackReady({ config: () => ({ ...cfg, model: 'm', base_url: 'http://x' }), hasKey: () => true })).toBe(true);
    expect(fallbackReady({ config: () => ({ ...cfg, mode: 'off', model: 'm', base_url: 'http://x' }), hasKey: () => true })).toBe(false);
    expect(fallbackReady({ config: () => undefined, hasKey: () => true })).toBe(false);
  });

  it('failureInMessage: success and ordinary messages are not failures', () => {
    expect(failureInMessage({ type: 'result', subtype: 'success', result: 'fine' })).toBeNull();
    expect(failureInMessage({ type: 'assistant', message: { content: [] } })).toBeNull();
    expect(failureInMessage({ type: 'stream_event' })).toBeNull();
  });
});
