import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { MindStatus } from '@sanctum/shared';

vi.mock('../config.js', () => ({ getSanctumConfig: vi.fn().mockReturnValue({ integrations: { mind_cloud: {} }, agent: {} }) }));
vi.mock('./db.js', () => ({ getConfig: vi.fn(() => null) }));

import { MindWatchdog, probeMind, mindCheckLine } from './mind-watchdog.js';
import { resetMindWarnings, type MindSettingsReport } from './mind-client.js';
import { startFakeMind } from '../test-helpers/fake-mind.js';

const KEY = 'k-secret-0123456789abcdef';
let fake: Awaited<ReturnType<typeof startFakeMind>>;
beforeAll(async () => { fake = await startFakeMind({ key: KEY, mindId: 'alpha' }); });
afterAll(async () => { await fake.close(); });
beforeEach(() => { fake.state.mode = 'normal'; fake.state.delayMs = 0; fake.state.reqs.length = 0; resetMindWarnings(); });

const on = (over: Partial<{ root: string; bearer: string; mindId: string }> = {}): MindSettingsReport => ({
  enabled: true, missing: [], keySource: 'settings',
  settings: { root: fake.root, bearer: KEY, mindId: 'alpha', ...over },
});
const off: MindSettingsReport = { enabled: false, settings: null, missing: [] };

function make(report: () => MindSettingsReport, extra: Record<string, unknown> = {}) {
  const logs: string[] = [];
  const sent: MindStatus[] = [];
  const clock = { t: 1_000_000 };
  const wd = new MindWatchdog({
    describe: report, log: (l: string) => logs.push(l), broadcast: (s: MindStatus) => sent.push(s),
    now: () => clock.t, timeoutMs: 300, ...extra,
  } as never);
  return { wd, logs, sent, clock };
}

describe('probeMind', () => {
  it('reads /health first, then one read verb with the bearer and mind_id, and answers ok with version and latency', async () => {
    const s = await probeMind({ root: fake.root, bearer: KEY, mindId: 'alpha' }, { timeoutMs: 1000 });
    expect(s.state).toBe('ok');
    expect(s.version).toBe('2.0.0-test');
    expect(typeof s.latencyMs).toBe('number');
    expect(s.error).toBeUndefined();
    expect(Number.isNaN(Date.parse(s.checkedAt))).toBe(false);
    const [a, b, ...rest] = fake.state.reqs;
    expect(rest).toEqual([]);
    expect(a).toMatchObject({ method: 'GET', path: '/health' });
    expect(b).toMatchObject({ method: 'POST', path: '/verbs/mind_thread', auth: `Bearer ${KEY}` });
    expect((b!.body as any).mind_id).toBe('alpha');
    expect((b!.body as any).operation).toBe('list');
  });

  it('never puts the key, the mind id, or the URL in the record, whatever the outcome', async () => {
    const outcomes = [
      probeMind({ root: fake.root, bearer: KEY, mindId: 'alpha' }, { timeoutMs: 500 }),
      probeMind({ root: fake.root, bearer: 'wrong-key', mindId: 'alpha' }, { timeoutMs: 500 }),
      probeMind({ root: 'http://user:pw@127.0.0.1:1', bearer: KEY, mindId: 'alpha' }, { timeoutMs: 500 }),
    ];
    for (const s of await Promise.all(outcomes)) {
      const text = JSON.stringify(s);
      expect(text).not.toContain(KEY);
      expect(text).not.toContain('wrong-key');
      expect(text).not.toContain('127.0.0.1');
      expect(text).not.toContain('pw');
    }
  });

  it('is unauthorized when the key is refused, and says so in plain words', async () => {
    const s = await probeMind({ root: fake.root, bearer: 'nope', mindId: 'alpha' }, { timeoutMs: 1000 });
    expect(s).toMatchObject({ state: 'unauthorized', version: '2.0.0-test' });
    expect(s.error).toMatch(/key/i);
  });

  it('is forbidden, not "key refused", when the key may not read that mind id', async () => {
    const s = await probeMind({ root: fake.root, bearer: KEY, mindId: 'someone-else' }, { timeoutMs: 1000 });
    expect(s.state).toBe('forbidden');
    expect(s.version).toBe('2.0.0-test');
    expect(s.error).toMatch(/mind id/i);
    expect(s.error).not.toMatch(/refused/i);
  });

  it('is offline with the verb\'s error class when /health is fine but the verb answers 5xx', async () => {
    fake.state.mode = 'verbfail';
    const s = await probeMind({ root: fake.root, bearer: KEY, mindId: 'alpha' }, { timeoutMs: 1000 });
    expect(fake.state.reqs.map((r) => r.path)).toEqual(['/health', '/verbs/mind_thread']); // health answered ok
    expect(s).toMatchObject({ state: 'offline', version: '2.0.0-test' });
    expect(s.error).toMatch(/error/i);
    expect(s.error).toMatch(/storage|HTTP 500/);
  });

  it('says the same in the update line', async () => {
    const line = await mindCheckLine(on({ mindId: 'someone-else' }), { timeoutMs: 1000 });
    expect(line).toMatch(/not allowed/);
    expect(line).not.toMatch(/refused the key/);
  });

  it('is offline when nothing is listening', async () => {
    const s = await probeMind({ root: 'http://127.0.0.1:1', bearer: KEY, mindId: 'alpha' }, { timeoutMs: 1000 });
    expect(s.state).toBe('offline');
    expect(s.latencyMs).toBeNull();
    expect(s.version).toBeUndefined();
  });

  it.each([
    ['http500', /database|error|answer/i],
    ['html', /sanctum-mind/i],
    ['dbdown', /database/i],
  ] as const)('is offline when the service answers like %s', async (mode, re) => {
    fake.state.mode = mode;
    const s = await probeMind({ root: fake.root, bearer: KEY, mindId: 'alpha' }, { timeoutMs: 1000 });
    expect(s.state).toBe('offline');
    expect(s.error).toMatch(re);
  });

  it('is offline when the service never answers (health, or the verb)', async () => {
    fake.state.mode = 'healthhang';
    expect((await probeMind({ root: fake.root, bearer: KEY, mindId: 'alpha' }, { timeoutMs: 150 })).state).toBe('offline');
    fake.state.mode = 'hang';
    const s = await probeMind({ root: fake.root, bearer: KEY, mindId: 'alpha' }, { timeoutMs: 150 });
    expect(s.state).toBe('offline');
    expect(s.version).toBe('2.0.0-test');
  });

  it('leaves the once-per-streak log of the client alone', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await probeMind({ root: fake.root, bearer: 'nope', mindId: 'alpha' }, { timeoutMs: 500 });
    await probeMind({ root: 'http://127.0.0.1:1', bearer: KEY, mindId: 'alpha' }, { timeoutMs: 500 });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('MindWatchdog.check', () => {
  it('does not probe when the Mind is off', async () => {
    const { wd, logs } = make(() => off);
    const s = await wd.check();
    expect(s.state).toBe('off');
    expect(fake.state.reqs).toHaveLength(0);
    expect(wd.probes).toBe(0);
    expect(logs).toEqual([]);
  });

  it.each([
    [{ enabled: true, settings: null, missing: ['mind id'] }, /mind id missing/i],
    [{ enabled: true, settings: null, missing: ['api key'] }, /api key missing/i],
    [{ enabled: true, settings: null, missing: ['url', 'api key'] }, /url and api key missing/i],
    [{ enabled: true, settings: null, missing: [], invalid: ['mind_id must be 1 to 64 characters'] }, /mind_id must be/],
  ] as Array<[MindSettingsReport, RegExp]>)('is incomplete, with no probe, when %j', async (report, re) => {
    const { wd } = make(() => report);
    const s = await wd.check();
    expect(s.state).toBe('incomplete');
    expect(s.error).toMatch(re);
    expect(fake.state.reqs).toHaveLength(0);
    expect(wd.probes).toBe(0);
  });

  it('logs a state change once, and nothing while it holds', async () => {
    const { wd, logs, sent } = make(() => on());
    await wd.check(); await wd.check(); await wd.check();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/off .*ok/);
    fake.state.mode = 'http500';
    await wd.check(); await wd.check();
    expect(logs).toHaveLength(2);
    expect(logs[1]).toMatch(/ok .*offline/);
    fake.state.mode = 'normal';
    await wd.check(); await wd.check();
    expect(logs).toHaveLength(3);
    expect(logs[2]).toMatch(/offline .*ok/);
    expect(sent.map((s) => s.state)).toEqual(['ok', 'offline', 'ok']);
    for (const l of logs) { expect(l).not.toContain(KEY); expect(l).not.toContain('127.0.0.1'); }
  });

  it('logs nothing at all while the Mind stays off', async () => {
    const { wd, logs, sent } = make(() => off);
    for (let i = 0; i < 3; i += 1) await wd.check();
    expect(logs).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('follows the settings: off again after the toggle goes off, with no probe', async () => {
    let report = on();
    const { wd, logs } = make(() => report);
    await wd.check();
    fake.state.reqs.length = 0;
    report = off;
    expect((await wd.check()).state).toBe('off');
    expect(fake.state.reqs).toHaveLength(0);
    expect(logs).toHaveLength(2);
  });

  it('shares one probe between concurrent callers', async () => {
    const { wd } = make(() => on());
    await Promise.all([wd.check(), wd.check(), wd.check()]);
    expect(fake.state.reqs.filter((r) => r.path === '/health')).toHaveLength(1);
  });

  it('a settings save during a check queues exactly one more check, which reads the corrected settings', async () => {
    let bearer = 'wrong-key';
    const { wd } = make(() => on({ bearer }), { timeoutMs: 2000 });
    fake.state.delayMs = 300;
    const first = wd.recheck();
    await new Promise((r) => setTimeout(r, 50));
    bearer = KEY; // the corrected save lands while the first probe is still waiting on the Mind
    const second = wd.recheck();
    const [a, b] = await Promise.all([first, second]);
    expect(fake.state.reqs.filter((r) => r.path === '/health')).toHaveLength(2);
    expect(wd.probes).toBe(2);
    expect(wd.get().state).toBe('ok');
    expect(a.state).toBe('ok'); // both callers see the final reading
    expect(b.state).toBe('ok');
    // Several saves in one check still cost one more probe, not one each.
    fake.state.reqs.length = 0;
    const c = wd.recheck(); wd.recheck(); wd.recheck();
    await c;
    expect(fake.state.reqs.filter((r) => r.path === '/health')).toHaveLength(2);
  });

  it('get() returns the last record', async () => {
    const { wd } = make(() => on());
    expect(wd.get().state).toBe('off');
    await wd.check();
    expect(wd.get()).toMatchObject({ state: 'ok', version: '2.0.0-test' });
  });
});

describe('MindWatchdog.current', () => {
  it('runs the first probe when none has run, then serves the record without probing again', async () => {
    const { wd } = make(() => on());
    expect((await wd.current()).state).toBe('ok');
    await wd.current();
    expect(fake.state.reqs.filter((r) => r.path === '/health')).toHaveLength(1);
  });

  it('notices a toggle-off or an emptied field straight away, with no network', async () => {
    let report = on();
    const { wd } = make(() => report);
    await wd.current();
    fake.state.reqs.length = 0;
    report = { enabled: true, settings: null, missing: ['mind id'] };
    expect((await wd.current()).state).toBe('incomplete');
    report = off;
    expect((await wd.current()).state).toBe('off');
    expect(fake.state.reqs).toHaveLength(0);
  });
});

describe('MindWatchdog.start', () => {
  it('probes at once and on every tick, and stop() ends the timer', async () => {
    let tick: (() => void) | null = null;
    const cleared: unknown[] = [];
    const { wd } = make(() => on(), {
      setTimer: (fn: () => void) => { tick = fn; return 7 as never; },
      clearTimer: (h: unknown) => { cleared.push(h); },
      intervalMs: 60_000,
    });
    wd.start();
    wd.start(); // idempotent
    await vi.waitFor(() => expect(wd.get().state).toBe('ok'));
    expect(wd.probes).toBe(1);
    tick!();
    await vi.waitFor(() => expect(fake.state.reqs).toHaveLength(4)); // two probes, two requests each
    wd.stop();
    expect(cleared).toEqual([7]);
  });

  it('does not probe at start or on a tick while the Mind is off', async () => {
    let tick: (() => void) | null = null;
    const { wd } = make(() => off, { setTimer: (fn: () => void) => { tick = fn; return 1 as never; }, clearTimer: () => {} });
    wd.start();
    tick!();
    await new Promise((r) => setTimeout(r, 20));
    expect(wd.probes).toBe(0);
    expect(fake.state.reqs).toHaveLength(0);
    wd.stop();
  });
});

describe('MindWatchdog.test (a draft)', () => {
  const draft = (over: Record<string, string | undefined> = {}) => ({ url: fake.root, mind_id: 'alpha', api_key: KEY, ...over });

  it('probes the draft, answers the record shape, and leaves the saved record, the log and the socket alone', async () => {
    const { wd, logs, sent } = make(() => off);
    const r = await wd.test(draft());
    expect(r).toMatchObject({ ok: true, status: { state: 'ok', version: '2.0.0-test' } });
    expect(wd.get().state).toBe('off');
    expect(logs).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('reports a refused key and an offline address for the draft', async () => {
    const { wd, clock } = make(() => off);
    expect(await wd.test(draft({ api_key: 'bad' }))).toMatchObject({ ok: true, status: { state: 'unauthorized' } });
    clock.t += 5000;
    expect(await wd.test(draft({ url: 'http://127.0.0.1:1' }))).toMatchObject({ ok: true, status: { state: 'offline' } });
  });

  it('a blank mind id in the draft means the saved one (the card, else sanctum.yaml)', async () => {
    const { wd } = make(() => off, { savedMindId: () => 'alpha' });
    const r = await wd.test(draft({ mind_id: '' }));
    expect(r).toMatchObject({ ok: true, status: { state: 'ok' } });
    const verb = fake.state.reqs.find((q) => q.path === '/verbs/mind_thread');
    expect((verb!.body as any).mind_id).toBe('alpha');
  });

  it('says a missing mind id is missing, without a request', async () => {
    const { wd } = make(() => off, { savedMindId: () => '' });
    const r = await wd.test(draft({ mind_id: '' }));
    expect(r).toMatchObject({ ok: true, status: { state: 'incomplete' } });
    expect((r as any).status.error).toMatch(/mind id missing/i);
    expect(fake.state.reqs).toHaveLength(0);
  });

  it('refuses a malformed mind id or a URL that is not http(s), without a request', async () => {
    const { wd, clock } = make(() => off);
    const a = await wd.test(draft({ mind_id: 'has space' }));
    expect((a as any).status).toMatchObject({ state: 'incomplete' });
    clock.t += 5000;
    const b = await wd.test(draft({ url: 'ftp://x' }));
    expect((b as any).status).toMatchObject({ state: 'incomplete' });
    expect((b as any).status.error).toMatch(/http/);
    expect(fake.state.reqs).toHaveLength(0);
  });

  it('uses the saved key when the draft leaves it blank, but only for the saved host', async () => {
    const savedKeyFor = (root: string) => (root === fake.root ? { key: KEY, source: 'environment' as const } : null);
    const { wd, clock } = make(() => off, { savedKeyFor });
    expect(await wd.test(draft({ api_key: '' }))).toMatchObject({ ok: true, status: { state: 'ok' } });
    clock.t += 5000;
    expect(await wd.test({ url: fake.root, mind_id: 'alpha' })).toMatchObject({ ok: true, status: { state: 'ok' } });
    clock.t += 5000;
    expect(await wd.test(draft({ api_key: '••••cdef' }))).toMatchObject({ ok: true, status: { state: 'ok' } });
    clock.t += 5000;
    fake.state.reqs.length = 0;
    const other = await wd.test(draft({ api_key: '', url: 'http://127.0.0.1:9' }));
    expect((other as any).status).toMatchObject({ state: 'incomplete' });
    expect((other as any).status.error).toMatch(/api key missing/i);
    expect(fake.state.reqs).toHaveLength(0);
  });

  it('with no draft, tests the saved settings and records the result', async () => {
    const { wd, logs } = make(() => on());
    const r = await wd.test();
    expect(r).toMatchObject({ ok: true, status: { state: 'ok' } });
    expect(wd.get().state).toBe('ok');
    expect(logs).toHaveLength(1);
  });

  it('with no draft and the Mind off, answers off without a request', async () => {
    const { wd } = make(() => off);
    expect(await wd.test()).toMatchObject({ ok: true, status: { state: 'off' } });
    expect(fake.state.reqs).toHaveLength(0);
  });

  it('allows one test in flight and no more than one per two seconds', async () => {
    fake.state.delayMs = 120;
    const { wd, clock } = make(() => off);
    const first = wd.test(draft());
    const second = await wd.test(draft());
    expect(second).toMatchObject({ ok: false, reason: 'busy' });
    expect(await first).toMatchObject({ ok: true });
    fake.state.delayMs = 0;
    clock.t += 1999;
    const soon = await wd.test(draft());
    expect(soon).toMatchObject({ ok: false, reason: 'too_soon' });
    expect((soon as any).retryAfterMs).toBeGreaterThan(0);
    expect((soon as any).retryAfterMs).toBeLessThanOrEqual(2000);
    clock.t += 1;
    expect(await wd.test(draft())).toMatchObject({ ok: true });
  });

  it('a refused test does not push the window out', async () => {
    const { wd, clock } = make(() => off);
    await wd.test(draft());
    clock.t += 1000;
    expect(await wd.test(draft())).toMatchObject({ ok: false, reason: 'too_soon' });
    clock.t += 1000; // 2000 after the first accepted test
    expect(await wd.test(draft())).toMatchObject({ ok: true });
  });

  it('releases the in-flight slot even when the probe throws', async () => {
    const { wd, clock } = make(() => off, { fetchImpl: async () => { throw new Error('boom'); } });
    expect(await wd.test(draft())).toMatchObject({ ok: true, status: { state: 'offline' } });
    clock.t += 5000;
    expect(await wd.test(draft())).toMatchObject({ ok: true });
  });
});

describe('mindCheckLine (the updater\'s one line)', () => {
  it('says the Mind is off, with no request', async () => {
    expect(await mindCheckLine(off, { timeoutMs: 300 })).toBe('Mind: off.');
    expect(fake.state.reqs).toHaveLength(0);
  });
  it('says what is missing, with no request', async () => {
    const line = await mindCheckLine({ enabled: true, settings: null, missing: ['mind id'] }, { timeoutMs: 300 });
    expect(line).toBe('Mind: on, but mind id missing. Set it in Settings → Mind.');
    expect(fake.state.reqs).toHaveLength(0);
  });
  it('says the Mind answered, with version and latency', async () => {
    expect(await mindCheckLine(on(), { timeoutMs: 1000 })).toMatch(/^Mind: answered \(2\.0\.0-test, \d+ ms\)\.$/);
  });
  it('says it did not answer, or refused the key', async () => {
    expect(await mindCheckLine(on({ root: 'http://127.0.0.1:1' }), { timeoutMs: 500 })).toMatch(/^Mind: not answering \(/);
    expect(await mindCheckLine(on({ bearer: 'nope' }), { timeoutMs: 500 })).toBe('Mind: answered, but it refused the key (the Mind refused the key).');
  });
  it('is one line and carries neither the key nor the URL', async () => {
    for (const r of [on(), on({ bearer: 'nope' }), on({ root: 'http://127.0.0.1:1' })]) {
      const line = await mindCheckLine(r, { timeoutMs: 500 });
      expect(line).not.toContain('\n');
      expect(line).not.toContain(KEY);
      expect(line).not.toContain('127.0.0.1');
    }
  });
});
