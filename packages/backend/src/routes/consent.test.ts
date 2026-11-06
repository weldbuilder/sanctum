// /api/consent: auth on every route, the PIN-token rules, receipts paging, the consent_changed push, the ask card creating a grant on approve,
// appWriteGate following the gate, and the settings routes refusing to be a way round the PIN.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const h = vi.hoisted(() => ({ pushes: [] as any[], password: 'app-pass-1' }));
vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
  const cfg = {
    identity: { user_name: 'Sam', companion_name: 'Echo', timezone: 'UTC' },
    integrations: { browser_url: '', mind_cloud: { enabled: false, mcp_url: '', mind_id: '' } },
    server: { host: '127.0.0.1', port: 3099, db_path: ':memory:' }, auth: { password: '' }, agent: { model: 'm', model_autonomous: '', cwd: '/tmp/home', app_write: true },
    discord: actual.normalizeDiscordConfig({}, '/srv/home', { warn: () => {} }),
  };
  return { ...actual, getSanctumConfig: () => cfg };
});
vi.mock('../services/ws.js', () => ({ registry: { broadcast: (m: any) => { h.pushes.push(m); }, getCount: () => 0 } }));
vi.mock('../middleware/auth.js', async () => {
  const actual = await vi.importActual<typeof import('../middleware/auth.js')>('../middleware/auth.js');
  return {
    ...actual,
    // A session is the header x-test-session; the app password is whatever h.password says.
    authMiddleware: (req: any, res: any, next: () => void) => (req.headers['x-test-session'] ? next() : res.status(401).json({ error: 'Unauthorized' })),
    passwordConfigured: () => !!h.password,
    verifyPassword: (p: unknown) => !!h.password && p === h.password,
  };
});
// The real limiter counts failed POST /pin calls per address across the whole file; the wiring is asserted below instead.
vi.mock('../middleware/security.js', async () => {
  const actual = await vi.importActual<typeof import('../middleware/security.js')>('../middleware/security.js');
  return { ...actual, loginRateLimiter: Object.assign((_req: any, _res: any, next: () => void) => next(), { isTestLimiter: true }) };
});
vi.mock('../middleware/internal-token.js', async () => {
  const actual = await vi.importActual<typeof import('../middleware/internal-token.js')>('../middleware/internal-token.js');
  return { ...actual, internalOnly: (_req: any, _res: any, next: () => void) => next() };
});

import apiRouter from './api.js';
import consentRouter from './consent.js';
import { appWriteGate } from '../middleware/app-write.js';
import { initDb, getConfig, getDb, listApprovals } from '../services/db.js';
import { grant, mode, peek, requireCapability, setMode, turnOff } from '../services/consent/gate.js';
import { setPin, _resetTokens } from '../services/consent/pin.js';

let server: Server;
let base = '';
const app = express();
const ttsCalls: string[] = [];
const tgCalls: string[] = [];
app.locals.voiceService = { canTTS: true, generateTTSForMessage: async (text: string) => { ttsCalls.push(text); return { messageId: 'm1', fileId: 'f1' }; } };
// (the real service checks the gate inside each send method; this stands in for it so the route's handling of a refusal is what is tested)
app.locals.telegramService = { isConnected: () => true, sendToOwner: async (text: string) => { requireCapability('outward_telegram', { harness: 'server', tool: 'telegram text', summary: text }); tgCalls.push(text); } };
app.use(express.json());
app.use('/api', apiRouter);
app.use('/api/consent', consentRouter);
const gated = express();
gated.post('/w', appWriteGate, (_req, res) => { res.json({ ok: true }); });
let gatedServer: Server;
let gatedBase = '';

const call = async (method: string, path: string, body?: unknown, session = true): Promise<{ status: number; body: any }> => {
  const r = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...(session ? { 'x-test-session': '1' } : {}) }, body: body === undefined || method === 'GET' ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const verify = async (pin = '4829') => (await call('POST', '/consent/pin/verify', { pin })).body.token as string;

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => r()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  await new Promise<void>((r) => { gatedServer = gated.listen(0, '127.0.0.1', () => r()); });
  gatedBase = `http://127.0.0.1:${(gatedServer.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); await new Promise((r) => gatedServer.close(r)); });
beforeEach(() => { initDb(':memory:'); _resetTokens(); h.pushes.length = 0; h.password = 'app-pass-1'; });

describe('auth', () => {
  it('every /api/consent route refuses without a session', async () => {
    const routes: Array<[string, string]> = [['GET', '/consent'], ['GET', '/consent/receipts'], ['POST', '/consent/pin'], ['POST', '/consent/pin/verify'], ['POST', '/consent/mode'], ['POST', '/consent/grant'], ['POST', '/consent/off'], ['POST', '/consent/revoke']];
    for (const [m, p] of routes) expect((await call(m, p, {}, false)).status, `${m} ${p}`).toBe(401);
    expect(getConfig('consent.mode')).toBeNull();
  });
});

describe('the PIN route is behind the login rate limiter', () => {
  it('POST /pin runs loginRateLimiter first (5 failures per 15 minutes per address); verify has its own lockout', () => {
    const layer = (consentRouter as any).stack.find((l: any) => l.route?.path === '/pin' && l.route.methods.post);
    expect(layer.route.stack[0].handle.isTestLimiter).toBe(true);
  });
});

describe('GET /api/consent', () => {
  it('open by default: nine capabilities on, no PIN, not locked, windows listed', async () => {
    const r = await call('GET', '/consent');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ mode: 'open', pin_set: false, locked_until: null, windows: [15, 30, 60, 1440, null] });
    expect(r.body.capabilities).toHaveLength(9);
    expect(r.body.capabilities.every((c: any) => c.state === 'on' && c.allow)).toBe(true);
    expect(JSON.stringify(r.body)).not.toMatch(/pin_hash|scrypt/);
  });
  it('shows state, expiry and note per capability', async () => {
    turnOff('shell');
    grant('web', 30, 'research');
    const caps = (await call('GET', '/consent')).body.capabilities;
    expect(caps.find((c: any) => c.capability === 'shell')).toMatchObject({ state: 'off', source: 'override', allow: false });
    expect(caps.find((c: any) => c.capability === 'web')).toMatchObject({ state: 'window', note: 'research', source: 'grant' });
    expect(caps.find((c: any) => c.capability === 'web').expires_at).toBeTruthy();
  });
});

describe('PIN routes', () => {
  it('set needs the app password; a wrong one is refused and nothing is stored', async () => {
    expect((await call('POST', '/consent/pin', { password: 'nope', pin: '4829' })).status).toBe(403);
    expect(getConfig('consent.pin_hash')).toBeNull();
    expect((await call('POST', '/consent/pin', { password: 'app-pass-1', pin: 'abc' })).status).toBe(400);
    const ok = await call('POST', '/consent/pin', { password: 'app-pass-1', pin: '4829' });
    expect(ok).toEqual({ status: 200, body: { pin_set: true } });
    expect((await call('GET', '/consent')).body.pin_set).toBe(true);
  });
  it('with no app password configured it says so', async () => {
    h.password = '';
    expect((await call('POST', '/consent/pin', { password: '', pin: '4829' })).status).toBe(400);
  });
  it('verify: right PIN gives a token; wrong counts down; five lock (423) and the status shows it; the PIN never comes back', async () => {
    setPin('4829');
    const ok = await call('POST', '/consent/pin/verify', { pin: '4829' });
    expect(ok.status).toBe(200);
    expect(ok.body.token).toMatch(/^[0-9a-f]{48}$/);
    expect(ok.body.expires_in).toBe(600);
    expect(JSON.stringify(ok.body)).not.toContain('4829');
    const bad = await call('POST', '/consent/pin/verify', { pin: '1111' });
    expect(bad).toEqual({ status: 403, body: { error: 'wrong_pin', attempts_left: 4 } });
    for (let i = 0; i < 3; i++) await call('POST', '/consent/pin/verify', { pin: '1111' });
    const locked = await call('POST', '/consent/pin/verify', { pin: '1111' });
    expect(locked.status).toBe(423);
    expect(locked.body.error).toBe('locked');
    expect((await call('POST', '/consent/pin/verify', { pin: '4829' })).status).toBe(423);
    expect((await call('GET', '/consent')).body.locked_until).toBeTruthy();
    // reset with the app password
    expect((await call('POST', '/consent/pin', { password: 'app-pass-1', pin: '7777' })).status).toBe(200);
    expect((await call('POST', '/consent/pin/verify', { pin: '7777' })).status).toBe(200);
  });
  it('verify with no PIN set is a 409, not a pass', async () => {
    expect((await call('POST', '/consent/pin/verify', { pin: '1234' })).status).toBe(409);
  });
  it('clearing the PIN needs the password and is refused while Guard is on', async () => {
    setPin('4829'); setMode('guard');
    expect((await call('POST', '/consent/pin', { password: 'app-pass-1', clear: true })).status).toBe(409);
    setMode('open');
    expect((await call('POST', '/consent/pin', { password: 'wrong', clear: true })).status).toBe(403);
    expect((await call('POST', '/consent/pin', { password: 'app-pass-1', clear: true })).body).toEqual({ pin_set: false });
  });
});

describe('mode', () => {
  it('Guard cannot be switched on without a PIN set', async () => {
    const r = await call('POST', '/consent/mode', { mode: 'guard', pin_token: 'x' });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('pin_not_set');
    expect(mode()).toBe('open');
  });
  it('switching on needs a valid token; switching off too', async () => {
    setPin('4829');
    expect((await call('POST', '/consent/mode', { mode: 'guard' })).status).toBe(403);
    expect((await call('POST', '/consent/mode', { mode: 'guard', pin_token: 'forged' })).body.error).toBe('pin_required');
    expect(mode()).toBe('open');
    const token = await verify();
    expect((await call('POST', '/consent/mode', { mode: 'guard', pin_token: token })).body).toEqual({ mode: 'guard' });
    expect(mode()).toBe('guard');
    expect((await call('POST', '/consent/mode', { mode: 'open' })).status).toBe(403);
    expect(mode()).toBe('guard');
    expect((await call('POST', '/consent/mode', { mode: 'open', pin_token: token })).body).toEqual({ mode: 'open' });
  });
  it('a bad mode is a 400', async () => {
    expect((await call('POST', '/consent/mode', { mode: 'lax' })).status).toBe(400);
  });
});

describe('grant, off, revoke', () => {
  it('open mode, no PIN: a window needs no token; off never does', async () => {
    const g = await call('POST', '/consent/grant', { capability: 'web', window_minutes: 30, note: 'reading' });
    expect(g.status).toBe(200);
    expect(g.body.grant).toMatchObject({ capability: 'web', effect: 'on', note: 'reading' });
    expect(Date.parse(g.body.grant.expires_at) - Date.parse(g.body.grant.granted_at)).toBe(30 * 60_000);
    expect((await call('POST', '/consent/off', { capability: 'shell' })).status).toBe(200);
    expect(peek('shell').allow).toBe(false);
  });
  it('rejects an unknown capability and a bad window', async () => {
    expect((await call('POST', '/consent/grant', { capability: 'root', window_minutes: 30 })).status).toBe(400);
    expect((await call('POST', '/consent/grant', { capability: 'web', window_minutes: 'forever' })).status).toBe(400);
    expect((await call('POST', '/consent/grant', { capability: 'web', window_minutes: -5 })).status).toBe(400);
    expect((await call('POST', '/consent/off', { capability: 'root' })).status).toBe(400);
  });
  it('leave on: window_minutes null (or absent) has no expiry', async () => {
    expect((await call('POST', '/consent/grant', { capability: 'web', window_minutes: null })).body.grant.expires_at).toBeNull();
  });
  it('open mode with a PIN: turning back on what was turned off needs a token; a window on something already on does not', async () => {
    setPin('4829');
    await call('POST', '/consent/off', { capability: 'shell' });
    const denied = await call('POST', '/consent/grant', { capability: 'shell', window_minutes: 30 });
    expect(denied).toMatchObject({ status: 403, body: { error: 'pin_required' } });
    expect(peek('shell').allow).toBe(false);
    expect((await call('POST', '/consent/grant', { capability: 'web', window_minutes: 30 })).status).toBe(200);
    const token = await verify();
    expect((await call('POST', '/consent/grant', { capability: 'shell', window_minutes: 30, pin_token: token })).status).toBe(200);
    expect(peek('shell').allow).toBe(true);
  });
  it('guard mode: every grant needs a token; a wrong token is refused', async () => {
    setPin('4829'); setMode('guard');
    expect((await call('POST', '/consent/grant', { capability: 'shell', window_minutes: 15 })).body.error).toBe('pin_required');
    expect((await call('POST', '/consent/grant', { capability: 'shell', window_minutes: 15, pin_token: 'abc' })).status).toBe(403);
    expect(peek('shell').allow).toBe(false);
    const token = await verify();
    expect((await call('POST', '/consent/grant', { capability: 'shell', window_minutes: 15, pin_token: token })).status).toBe(200);
    expect(peek('shell').allow).toBe(true);
    // off is still free
    expect((await call('POST', '/consent/off', { capability: 'shell' })).status).toBe(200);
  });
  it('revoke: removing a window needs no token; removing a switch-off needs one once a PIN exists; unknown id is 404', async () => {
    setPin('4829');
    const w = (await call('POST', '/consent/grant', { capability: 'web', window_minutes: 30 })).body.grant;
    expect((await call('POST', '/consent/revoke', { grant_id: w.grant_id })).status).toBe(200);
    const off = (await call('POST', '/consent/off', { capability: 'web' })).body.grant;
    expect((await call('POST', '/consent/revoke', { grant_id: off.grant_id })).status).toBe(403);
    expect((await call('POST', '/consent/revoke', { grant_id: off.grant_id, pin_token: await verify() })).status).toBe(200);
    expect((await call('POST', '/consent/revoke', { grant_id: 'ghost' })).status).toBe(404);
    expect((await call('POST', '/consent/revoke', {})).status).toBe(400);
  });
});

describe('consent_changed over the socket', () => {
  it('is broadcast for grant, off, revoke and mode', async () => {
    setPin('4829');
    const g = (await call('POST', '/consent/grant', { capability: 'web', window_minutes: 30 })).body.grant;
    await call('POST', '/consent/off', { capability: 'shell' });
    await call('POST', '/consent/revoke', { grant_id: g.grant_id });
    await call('POST', '/consent/mode', { mode: 'guard', pin_token: await verify() });
    expect(h.pushes.filter((m) => m.type === 'consent_changed').map((m) => `${m.change}:${m.capability ?? '-'}:${m.mode}`)).toEqual(['grant:web:open', 'off:shell:open', 'revoke:web:open', 'mode:-:guard']);
  });
});

describe('GET /api/consent/receipts', () => {
  it('newest first, filtered, paged with before=', async () => {
    for (let i = 0; i < 4; i++) grant('web', 30, `n${i}`);
    turnOff('shell');
    const first = (await call('GET', '/consent/receipts?limit=2')).body;
    expect(first.receipts.map((r: any) => r.summary)).toEqual(['shell turned off', 'web 30 min — n3']);
    const second = (await call('GET', `/consent/receipts?limit=2&before=${first.next_before}`)).body;
    expect(second.receipts.map((r: any) => r.summary)).toEqual(['web 30 min — n2', 'web 30 min — n1']);
    expect((await call('GET', '/consent/receipts?capability=shell')).body.receipts).toHaveLength(1);
    expect((await call('GET', '/consent/receipts?outcome=granted')).body.receipts).toHaveLength(4);
  });
  it('refuses unknown filters', async () => {
    expect((await call('GET', '/consent/receipts?capability=root')).status).toBe(400);
    expect((await call('GET', '/consent/receipts?outcome=maybe')).status).toBe(400);
    expect((await call('GET', '/consent/receipts?before=abc')).status).toBe(400);
  });
});

describe('the settings routes are not a way round the PIN', () => {
  it('PUT /api/settings refuses consent.* keys', async () => {
    setMode('guard');
    for (const key of ['consent.mode', 'consent.grants', 'consent.pin_hash', 'consent.pin_lock_until']) {
      expect((await call('PUT', '/settings', { key, value: 'open' })).status, key).toBe(403);
    }
    expect(mode()).toBe('guard');
  });
  it('GET /api/settings never lists the PIN hash', async () => {
    setPin('4829'); setMode('guard');
    const body = (await call('GET', '/settings')).body;
    expect(JSON.stringify(body.config)).not.toMatch(/pin_hash|scrypt/);
    expect(body.config['consent.mode']).toBe('guard');
  });
});

describe('the ask card', () => {
  const ask = (body: Record<string, unknown>) => fetch(`${base}/internal/approvals`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ timeoutMs: 8000, ...body }) });
  const pendingId = async () => { for (let i = 0; i < 50; i++) { const a = listApprovals('pending'); if (a.length) return a[0].id; await new Promise((r) => setTimeout(r, 20)); } throw new Error('no ask'); };
  const decide = (id: string, body: Record<string, unknown>) => call('POST', `/approvals/${id}/decide`, body);

  it('an ask without a capability behaves as before: no grant', async () => {
    const waiting = ask({ what: 'send the email' });
    const id = await pendingId();
    const d = await decide(id, { decision: 'approved' });
    expect(d.body.grant).toBeUndefined();
    expect((await (await waiting).json()).status).toBe('approved');
    expect(JSON.parse(getConfig('consent.grants') ?? '[]')).toEqual([]);
  });
  it('rejects an unknown capability and a bad window', async () => {
    expect((await ask({ what: 'x', capability: 'root' })).status).toBe(400);
    expect((await ask({ what: 'x', capability: 'web', window_minutes: 'soon' })).status).toBe(400);
  });
  it('approving a capability ask creates the grant for the asked window', async () => {
    turnOff('web');
    const waiting = ask({ what: 'look something up', capability: 'web', window_minutes: 30 });
    const id = await pendingId();
    expect(listApprovals('pending')[0]).toMatchObject({ capability: 'web', window_minutes: 30 });
    const d = await decide(id, { decision: 'approved' });
    expect(d.status).toBe(200);
    expect(d.body.grant).toMatchObject({ capability: 'web', effect: 'on' });
    expect(peek('web').allow).toBe(true);
    expect((await (await waiting).json()).status).toBe('approved');
  });
  it('the person may pick another window on the card, or leave it on', async () => {
    turnOff('shell');
    const waiting = ask({ what: 'run a build', capability: 'shell', window_minutes: 15 });
    const d = await decide(await pendingId(), { decision: 'approved', window_minutes: null });
    expect(d.body.grant.expires_at).toBeNull();
    await waiting;
  });
  it('denying creates nothing', async () => {
    turnOff('web');
    const waiting = ask({ what: 'look something up', capability: 'web', window_minutes: 30 });
    const d = await decide(await pendingId(), { decision: 'denied' });
    expect(d.body.grant).toBeUndefined();
    expect(peek('web').allow).toBe(false);
    await waiting;
  });
  it('in Guard mode the card needs the PIN token, and without it the ask stays pending', async () => {
    setPin('4829'); setMode('guard');
    const waiting = ask({ what: 'look something up', capability: 'web', window_minutes: 30 });
    const id = await pendingId();
    const refused = await decide(id, { decision: 'approved' });
    expect(refused).toMatchObject({ status: 403, body: { error: 'pin_required' } });
    expect(listApprovals('pending')).toHaveLength(1);
    expect(peek('web').allow).toBe(false);
    const ok = await decide(id, { decision: 'approved', pin_token: await verify() });
    expect(ok.body.grant.capability).toBe('web');
    expect(peek('web').allow).toBe(true);
    await waiting;
  });
  it('asking for something already on with no end changes nothing (a window would only put an end on it)', async () => {
    const waiting = ask({ what: 'look something up', capability: 'web', window_minutes: 30 });
    const d = await decide(await pendingId(), { decision: 'approved' });
    expect(d.body.grant).toBeUndefined();
    expect(JSON.parse(getConfig('consent.grants') ?? '[]')).toEqual([]);
    await waiting;
  });
});

describe('/internal/telegram-send and /internal/tts', () => {
  beforeEach(() => { ttsCalls.length = 0; tgCalls.length = 0; });
  const internal = async (path: string, body: unknown) => { const r = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };

  it('telegram-send: on → 200 and sent; off → 403 naming Settings → Permissions, nothing sent, denied receipt', async () => {
    expect((await internal('/internal/telegram-send', { type: 'text', text: 'hello' })).status).toBe(200);
    expect(tgCalls).toEqual(['hello']);
    turnOff('outward_telegram');
    const r = await internal('/internal/telegram-send', { type: 'text', text: 'again' });
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: 'consent_off', capability: 'outward_telegram', message: 'Telegram sending is turned off (Settings → Permissions).' });
    expect(tgCalls).toEqual(['hello']);
    expect(getDb().prepare("SELECT outcome FROM consent_receipts WHERE capability = 'outward_telegram' AND outcome IN ('allowed','denied') ORDER BY id").all()).toEqual([{ outcome: 'allowed' }, { outcome: 'denied' }]);
  });
  it('telegram-send: guard mode refuses until a window', async () => {
    setMode('guard');
    expect((await internal('/internal/telegram-send', { type: 'text', text: 'x' })).status).toBe(403);
    grant('outward_telegram', 30);
    expect((await internal('/internal/telegram-send', { type: 'text', text: 'x' })).status).toBe(200);
  });
  it('tts: on → a voice note; off → 403, ElevenLabs is not called; guard → refused until granted', async () => {
    expect((await internal('/internal/tts', { text: 'say this' })).status).toBe(200);
    expect(ttsCalls).toEqual(['say this']);
    turnOff('voice_out');
    const r = await internal('/internal/tts', { text: 'and this' });
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: 'consent_off', capability: 'voice_out', message: 'Voice output is turned off (Settings → Permissions).' });
    expect(ttsCalls).toEqual(['say this']);
    setMode('guard');
    expect((await internal('/internal/tts', { text: 'x' })).status).toBe(403);
    grant('voice_out', 15);
    expect((await internal('/internal/tts', { text: 'granted' })).status).toBe(200);
  });
  it('/internal/image follows the app_write gate (the middleware, same as every app write)', async () => {
    turnOff('app_write');
    const r = await internal('/internal/image', { prompt: 'a cat' });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ error: 'app_write_off', capability: 'app_write' });
  });
});

describe('appWriteGate follows the consent gate', () => {
  const post = async () => fetch(`${gatedBase}/w`, { method: 'POST' });
  it('open: passes, with a receipt naming the route', async () => {
    expect((await post()).status).toBe(200);
    expect(getDb().prepare("SELECT * FROM consent_receipts WHERE capability = 'app_write'").all()).toMatchObject([{ outcome: 'allowed', tool_or_route: 'POST /w', harness: 'server' }]);
  });
  it('switched off: 403 naming Settings → Permissions', async () => {
    turnOff('app_write');
    const r = await post();
    expect(r.status).toBe(403);
    const b = await r.json();
    expect(b).toMatchObject({ error: 'app_write_off', capability: 'app_write' });
    expect(b.message).toBe('App write access is turned off (Settings → Permissions).');
  });
  it('guard mode without a grant: 403; with one: passes', async () => {
    setMode('guard');
    expect((await post()).status).toBe(403);
    grant('app_write', 15);
    expect((await post()).status).toBe(200);
  });
});
