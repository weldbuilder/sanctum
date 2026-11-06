// The /api/setup routes over a real express app on a real port: the gate (the one-time setup code before a password exists, the session
// after), the plan with no secrets in it, one-step validation, the probes, and apply. The config, the session check and the database
// are stubs; the router, the plan and the apply code are the real ones, working in a sandbox folder.
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const h = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('node:fs') as typeof import('node:fs');
  const os = require('node:os') as typeof import('node:os');
  const path = require('node:path') as typeof import('node:path');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'setup-routes-')));
  return { root, appPassword: '' as string, source: 'dotenv' as string, password: '' as string, sessionOk: false, db: {} as Record<string, string>, reloads: 0, kept: [] as (string | null)[], revoked: 2, reloadThrows: false, botToken: false };
});

vi.mock('../config.js', () => ({
  PROJECT_ROOT: h.root,
  getSanctumConfig: () => ({ auth: { password: h.password } }),
  setAppPassword: (pw: string) => { h.appPassword = pw; },
  getAppPasswordSource: () => h.source,
  reloadConfig: () => { h.reloads++; if (h.reloadThrows) throw new Error('boom'); },
}));
// The session check: a request with the header `x-test-session: yes` is signed in.
vi.mock('../middleware/auth.js', () => ({
  getCookieName: () => 'sanctum_session',
  authMiddleware: (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.get('x-test-session') === 'yes') { next(); return; }
    res.status(401).json({ error: 'Unauthorized' });
  },
}));
vi.mock('../services/db.js', () => ({ getConfig: (k: string) => h.db[k] ?? null, deleteWebSessionsExcept: (keep: string | null) => { h.kept.push(keep); return h.revoked; } }));
vi.mock('../services/bot-token.js', () => ({ hasBotToken: () => h.botToken }));
vi.mock('child_process', async (orig) => ({ ...(await orig<typeof import('child_process')>()), spawnSync: () => ({ status: 0 }) }));

import router from './setup.js';
import { loginRateLimiter } from '../middleware/security.js';
import { _resetSetupCode, setupCode, SETUP_CODE_TTL_MS } from '../services/setup-code.js';

let server: Server;
let base = '';
const app = express();
app.set('trust proxy', true); // the tests make different callers with x-forwarded-for
app.use(express.json());
app.use('/api/setup', router);
app.post('/login', loginRateLimiter, (req, res) => { res.status(req.get('x-test-login') === 'right' ? 200 : 401).json({}); }); // the real sign-in limiter

const SECRET_PW = 'super-secret-password-1';
const SECRET_KEY = 'sk-ant-secret-key-xyz';
const SECRET_PROVIDER_KEY = 'sk-provider-secret-key-abc';
let now = 5_000_000;
let printed: string[] = [];
const savedEnv = { ...process.env };

const home = join(h.root, 'home');
const companionHome = join(home, 'Documents', 'companion-home');
function lay() {
  rmSync(h.root, { recursive: true, force: true });
  mkdirSync(join(h.root, 'companion-home', 'identity'), { recursive: true });
  writeFileSync(join(h.root, 'companion-home', 'identity', 'profile.md'), '# Profile\n');
  mkdirSync(join(h.root, 'plugins', 'hello', 'dsh'), { recursive: true });
  writeFileSync(join(h.root, 'plugins', 'hello', 'sanctum.plugin.json'), JSON.stringify({ id: 'hello', name: 'Hello' }));
  writeFileSync(join(h.root, 'plugins', 'hello', 'dsh', 'index.mjs'), "export default 'hello';\n");
  writeFileSync(join(h.root, '.env.example'), '# env\nAPP_PASSWORD=\n');
  mkdirSync(join(companionHome, 'identity'), { recursive: true });
  writeFileSync(join(companionHome, 'identity', 'profile.md'), 'p\n');
  process.env.CODEX_HOME = join(home, '.codex');
  delete process.env.APP_PASSWORD;
  delete process.env.ANTHROPIC_API_KEY;
}

beforeAll(async () => { await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => r()); }); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/setup`; });
afterAll(async () => { await new Promise((r) => server.close(r)); rmSync(h.root, { recursive: true, force: true }); });
beforeEach(() => {
  h.appPassword = ''; h.source = 'dotenv'; h.kept = []; h.revoked = 2; h.password = ''; h.sessionOk = false; h.db = {}; h.reloads = 0; h.reloadThrows = false; h.botToken = false;
  now = 5_000_000; printed = [];
  _resetSetupCode({ now: () => now, announce: (code) => { printed.push(code); } });
  lay();
});
afterEach(() => { process.env = { ...savedEnv }; vi.restoreAllMocks(); });

const asCode = (extra: Record<string, string> = {}) => ({ 'content-type': 'application/json', 'x-setup-code': setupCode(), ...extra });
const asSession = (extra: Record<string, string> = {}) => ({ 'content-type': 'application/json', 'x-test-session': 'yes', ...extra });
// These helpers walk EVERY question (phase 'all'), the wizard as it was before it had phases; the phase tests at the end use rawPost / rawGet.
const rawPost = (path: string, body: unknown, headers: Record<string, string>) => fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
const rawGet = (path: string, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { headers });
const post = (path: string, body: unknown, headers: Record<string, string>) => rawPost(path, { phase: 'all', ...(body as object) }, headers);
const get = (path: string, headers: Record<string, string> = {}) => rawGet(/^\/(plan)(\?|$)/.test(path) && !path.includes('phase') && !path.includes('more') ? `${path}${path.includes('?') ? '&' : '?'}phase=all` : path, headers);
/** Caller number `n`: its own address. */
const from = (n: number, h: Record<string, string> = {}) => ({ 'x-forwarded-for': `10.0.0.${n}`, ...h });
const wrongCode = 'b'.repeat(12);

/** The answers for a first run on Claude. */
const fresh = (extra: Record<string, unknown> = {}) => ({ provider: 'claude', home: companionHome, password: SECRET_PW, anthropicKey: SECRET_KEY, memory: 'none', ...extra });

describe('GET /status: open, and says which door the page needs', () => {
  it('no password: needs the setup code', async () => {
    const r = await get('/status');
    expect(await r.json()).toEqual({ password_set: false, needs_code: true });
  });
  it('a password: a sign-in', async () => {
    h.password = 'x';
    expect(await (await get('/status')).json()).toEqual({ password_set: true, needs_code: false });
  });
  it('a page opened after the code expired gets a new code printed', async () => {
    setupCode();
    now += SETUP_CODE_TTL_MS + 1;
    await get('/status');
    expect(printed).toHaveLength(1);
  });
});

describe('the gate before a password exists: the setup code', () => {
  it('refuses a request with no code', async () => {
    const r = await get('/plan');
    expect(r.status).toBe(401);
    expect(await r.json()).toMatchObject({ error: 'setup_code' });
  });

  it('refuses a wrong code, naming where the right one is', async () => {
    const r = await get('/plan', { 'x-setup-code': 'a'.repeat(12) });
    expect(r.status).toBe(401);
    expect((await r.json()).message).toMatch(/npm start/);
  });

  it('lets the right code through, in any case and with spaces, on every route', async () => {
    const code = setupCode();
    expect((await get('/plan', { 'x-setup-code': ` ${code.toUpperCase()} ` })).status).toBe(200);
    expect((await post('/plan', { answers: {} }, asCode())).status).toBe(200);
    expect((await post('/validate', { id: 'userName', value: 'x' }, asCode())).status).toBe(200);
    expect((await post('/test', { probe: 'codex_config' }, asCode())).status).toBe(200);
  });

  it('after five wrong tries the next wrong one replaces the code, and the old one stops working', async () => {
    const first = setupCode();
    for (let i = 0; i < 5; i++) expect((await get('/plan', from(i + 1, { 'x-setup-code': wrongCode }))).status).toBe(401);
    expect(printed).toEqual([]);
    const sixth = await get('/plan', from(6, { 'x-setup-code': wrongCode }));
    expect(sixth.status).toBe(401);
    expect((await sixth.json()).message).toMatch(/replaced/);
    expect(printed).toHaveLength(1);
    expect((await get('/plan', from(7, { 'x-setup-code': first }))).status).toBe(401); // the old code is one more wrong guess
    expect((await get('/plan', from(8, { 'x-setup-code': printed[0] }))).status).toBe(200);
  });

  it('20 wrong guesses from 20 addresses replace the code once and print one line, not fifteen', async () => {
    setupCode();
    for (let i = 0; i < 20; i++) expect((await get('/plan', from(i + 1, { 'x-setup-code': wrongCode }))).status).toBe(401);
    expect(printed).toHaveLength(1);
    now += 5 * 60 * 1000; // a rotation window later the next wrong guess may replace it again
    await get('/plan', from(30, { 'x-setup-code': wrongCode }));
    expect(printed).toHaveLength(2);
  });

  it('requests with no code are not guesses: five of them, then the right code, gets in', async () => {
    const code = setupCode();
    for (let i = 0; i < 5; i++) expect((await get('/plan')).status).toBe(401);
    expect((await get('/plan', { 'x-setup-code': code })).status).toBe(200);
  });

  it('a 400 from /apply with the right code is not a guess: five of them, and /plan still answers', async () => {
    for (let i = 0; i < 5; i++) expect((await post('/apply', { answers: {} }, asCode())).status).toBe(400);
    expect((await get('/plan', asCode())).status).toBe(200);
  });

  it('a request that passes the gate and is then refused by its route (here 400s from /validate) is not a guess either', async () => {
    for (let i = 0; i < 6; i++) await post('/validate', { id: 'nope', value: 1 }, asCode()); // 400s
    expect((await get('/plan', asCode())).status).toBe(200);
  });

  it('five wrong guesses from one address refuse that address (even with the right code) for 15 minutes; others are untouched', async () => {
    const code = setupCode();
    for (let i = 0; i < 5; i++) await get('/plan', from(1, { 'x-setup-code': wrongCode }));
    const blocked = await get('/plan', from(1, { 'x-setup-code': code }));
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toMatchObject({ error: 'setup_code_locked' });
    expect((await get('/plan', from(2, { 'x-setup-code': code }))).status).toBe(200);
    now += 15 * 60 * 1000;
    expect((await get('/plan', from(1, { 'x-setup-code': code }))).status).toBe(200);
  });

  it("the setup code's counts are not the sign-in's: wrong guesses from an address leave its first sign-in alone", async () => {
    for (let i = 0; i < 5; i++) await get('/plan', from(1, { 'x-setup-code': wrongCode }));
    expect((await fetch(base.replace('/api/setup', '/login'), { method: 'POST', headers: from(1, { 'x-test-login': 'right' }) })).status).toBe(200);
    // and the other way round: five failed sign-ins do not refuse the setup code
    for (let i = 0; i < 5; i++) await fetch(base.replace('/api/setup', '/login'), { method: 'POST', headers: from(3) });
    expect((await get('/plan', from(3, { 'x-setup-code': setupCode() }))).status).toBe(200);
  });

  it('an expired code is refused with its own error, and a new one is printed', async () => {
    const old = setupCode();
    now += SETUP_CODE_TTL_MS + 1;
    const r = await get('/plan', { 'x-setup-code': old });
    expect(r.status).toBe(401);
    expect(await r.json()).toMatchObject({ error: 'setup_code_expired' });
    expect(printed).toHaveLength(1);
    expect((await get('/plan', { 'x-setup-code': printed[0] })).status).toBe(200);
  });

  it('never puts the code in a response', async () => {
    const code = setupCode();
    for (const r of [await get('/plan'), await get('/plan', { 'x-setup-code': 'c'.repeat(12) }), await get('/status')]) {
      expect(JSON.stringify(await r.json())).not.toContain(code);
    }
  });
});

describe('the gate once a password exists: the session', () => {
  beforeEach(() => { h.password = 'already-set'; });
  it('refuses a request without a session, even with the right setup code', async () => {
    const r = await get('/plan', { 'x-setup-code': setupCode() });
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: 'Unauthorized' });
    expect((await post('/apply', { answers: fresh() }, asCode())).status).toBe(401);
  });
  it('lets a signed-in request through on every route', async () => {
    expect((await get('/plan', asSession())).status).toBe(200);
    expect((await post('/plan', {}, asSession())).status).toBe(200);
    expect((await post('/validate', { id: 'userName', value: 'x' }, asSession())).status).toBe(200);
    expect((await post('/test', { probe: 'codex_config' }, asSession())).status).toBe(200);
  });
  it('does not touch the setup code at all', async () => {
    await get('/plan', { 'x-setup-code': 'd'.repeat(12) });
    expect(printed).toEqual([]);
  });
});

describe('GET /plan and POST /plan', () => {
  it('lists the steps of the current config, in order, with the words and defaults', async () => {
    const body = await (await get('/plan', asCode())).json();
    expect(body.mode).toBe('first_run');
    const ids = body.steps.map((s: { id: string }) => s.id);
    expect(ids.slice(0, 4)).toEqual(['companionName', 'userName', 'timezone', 'home']);
    expect(ids.indexOf('provider')).toBeGreaterThan(3);
    expect(ids).toContain('password');
    const first = body.steps[0];
    expect(first).toMatchObject({ kind: 'text', question: "Your companion's name", default: 'Echo' });
    expect(body.steps.find((s: { id: string }) => s.id === 'provider').options.map((o: { value: string }) => o.value)).toEqual(['codex', 'claude', 'dsh']); // the three harnesses (docs/DSH.md)
  });

  it('says "set" for saved secrets and never echoes one', async () => {
    h.password = 'x';
    writeFileSync(join(h.root, '.env'), `APP_PASSWORD=${SECRET_PW}\nANTHROPIC_API_KEY=${SECRET_KEY}\n`);
    writeFileSync(join(h.root, 'sanctum.yaml'), 'agent:\n  provider: claude\n');
    const text = await (await get('/plan', asSession())).text();
    expect(text).not.toContain(SECRET_PW);
    expect(text).not.toContain(SECRET_KEY);
    const body = JSON.parse(text);
    expect(body.mode).toBe('rerun');
    expect(body.steps.find((s: { id: string }) => s.id === 'password')).toMatchObject({ kind: 'secret', saved: true });
    expect(body.steps.find((s: { id: string }) => s.id === 'anthropicKey')).toMatchObject({ saved: true });
    expect(body.steps.find((s: { id: string }) => s.id === 'password').default).toBeUndefined();
  });

  it('POST re-resolves for the answers so far: Claude hides the Codex steps, a person-managed plugin shows its ratify step', async () => {
    const codex = await (await post('/plan', { answers: { provider: 'codex' } }, asCode())).json();
    expect(codex.steps.map((s: { id: string }) => s.id)).toContain('sandbox');
    const claude = await (await post('/plan', { answers: { provider: 'claude', pluginsTrust: 'person', plugins: ['hello'] } }, asCode())).json();
    const ids = claude.steps.map((s: { id: string }) => s.id);
    expect(ids).not.toContain('sandbox');
    expect(ids).toContain('ratify_0');
    const ratify = claude.steps.find((s: { id: string }) => s.id === 'ratify_0');
    expect(ratify.meta.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(ratify.help.join('\n')).toMatch(/the code you are about to ratify/);
  });

  it('says where the password comes from, so the password step can warn before anything is typed (GET and POST)', async () => {
    for (const source of ['parent_env', 'dotenv', 'yaml', 'none']) {
      h.source = source;
      expect((await (await get('/plan', asCode())).json()).passwordSource).toBe(source);
      expect((await (await post('/plan', { answers: {} }, asCode())).json()).passwordSource).toBe(source);
    }
  });

  it('ignores answers that are not an object', async () => {
    expect((await post('/plan', { answers: 'nope' }, asCode())).status).toBe(200);
    expect((await post('/plan', { answers: [1, 2] }, asCode())).status).toBe(200);
  });
});

describe('POST /validate: one step\'s value', () => {
  it('says ok, or why not', async () => {
    expect(await (await post('/validate', { id: 'timezone', value: 'Europe/Berlin' }, asCode())).json()).toMatchObject({ ok: true, message: '' });
    const bad = await (await post('/validate', { id: 'timezone', value: 'Mars/Olympus' }, asCode())).json();
    expect(bad.ok).toBe(false);
    expect(bad.message).toMatch(/timezone/);
    const pw = await (await post('/validate', { id: 'password', value: 'short' }, asCode())).json();
    expect(pw).toMatchObject({ ok: false });
    expect(pw.message).toMatch(/at least 8/);
  });
  it('uses the answers given so far (a Discord folder inside the home is refused)', async () => {
    const r = await (await post('/validate', { id: 'discordPrivateDir', value: join(companionHome, 'private'), answers: { home: companionHome, discordEnable: true } }, asCode())).json();
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/your companion can write/);
  });
  it('a step that is not asked is simply ok', async () => {
    expect(await (await post('/validate', { id: 'sandbox', value: 'read-only', answers: { provider: 'claude' } }, asCode())).json()).toMatchObject({ ok: true, active: false });
  });
  it('an unknown or missing id is a 400', async () => {
    expect((await post('/validate', { id: 'nope', value: 1 }, asCode())).status).toBe(400);
    expect((await post('/validate', { value: 1 }, asCode())).status).toBe(400);
  });
  it('a value of the wrong kind is a problem, not a crash', async () => {
    const r = await (await post('/validate', { id: 'provider', value: 'hal9000' }, asCode())).json();
    expect(r.ok).toBe(false);
  });
});

describe('POST /test: the probes', () => {
  it('codex_config: reads Codex\'s config and reports models and providers, never a key', async () => {
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(join(home, '.codex', 'config.toml'), `model = "deepseek-chat"\nmodel_provider = "deepseek"\n\n[model_providers.deepseek]\nname = "DeepSeek"\nbase_url = "https://api.deepseek.com"\nexperimental_bearer_token = "${SECRET_PROVIDER_KEY}"\n\n[features]\nmemories = true\n`);
    const text = await (await post('/test', { probe: 'codex_config' }, asCode())).text();
    expect(text).not.toContain(SECRET_PROVIDER_KEY);
    expect(JSON.parse(text)).toMatchObject({ ok: true, state: 'found', installed: true, model: 'deepseek-chat', model_provider: 'deepseek', memories_on: true, providers: [{ key: 'deepseek', name: 'DeepSeek', base_url: 'https://api.deepseek.com' }] });
  });
  it('codex_config: no file yet', async () => {
    const r = await (await post('/test', { probe: 'codex_config' }, asCode())).json();
    expect(r).toMatchObject({ state: 'missing', providers: [] });
    expect(r.message).toMatch(/No .*config\.toml yet/);
  });

  it('discord_token: checks the shape only, and does not keep or return the token', async () => {
    const token = `${'A'.repeat(24)}.${'b'.repeat(6)}.${'C'.repeat(27)}`;
    const ok = await (await post('/test', { probe: 'discord_token', value: token }, asCode())).text();
    expect(ok).not.toContain(token);
    expect(JSON.parse(ok)).toMatchObject({ ok: true, state: 'shape_ok' });
    expect(await (await post('/test', { probe: 'discord_token', value: 'not-a-token' }, asCode())).json()).toMatchObject({ ok: false, state: 'shape_wrong' });
    expect(await (await post('/test', { probe: 'discord_token', value: '' }, asCode())).json()).toMatchObject({ ok: false, state: 'empty', saved: false });
    h.botToken = true;
    expect(await (await post('/test', { probe: 'discord_token', value: '' }, asCode())).json()).toMatchObject({ ok: true, state: 'saved', saved: true });
  });

  it('browser_filter: says whether .mcp.json has the filtered entry, none, an unfiltered one, or is not JSON', async () => {
    const probe = async () => (await post('/test', { probe: 'browser_filter' }, asCode())).json();
    expect(await probe()).toMatchObject({ ok: false, state: 'added' });
    writeFileSync(join(h.root, '.mcp.json'), JSON.stringify({ mcpServers: { browser: { command: 'npx', args: ['@playwright/mcp'] } } }));
    expect(await probe()).toMatchObject({ ok: false, state: 'upgrade' });
    writeFileSync(join(h.root, '.mcp.json'), 'not json {');
    expect(await probe()).toMatchObject({ ok: false, state: 'refused' });
    const { mergeBrowserMcp } = await import('../../../../scripts/setup-lib.mjs');
    writeFileSync(join(h.root, '.mcp.json'), (mergeBrowserMcp('', join(h.root, 'examples', 'browser-seat-neko', 'mcp-filter.mjs'), join(h.root, 'data', 'browser-out')) as { text: string }).text);
    expect(await probe()).toMatchObject({ ok: true, state: 'exists' });
  });

  it('an unknown probe is a 400 that lists the probes (there is no Mind probe on this version)', async () => {
    const r = await post('/test', { probe: 'mind' }, asCode());
    expect(r.status).toBe(400);
    expect((await r.json()).probes).toEqual(['codex_config', 'discord_token', 'browser_filter', 'connection']);
  });

  it('connection: behind the gate like every probe, a 400 for a harness or method it does not know, and an answer in the shape the page reads', async () => {
    expect((await post('/test', { probe: 'connection', harness: 'claude', method: 'login' }, { 'content-type': 'application/json' })).status).toBe(401);
    expect((await post('/test', { probe: 'connection', harness: 'gemini', method: 'login' }, asCode())).status).toBe(400);
    expect((await post('/test', { probe: 'connection', harness: 'claude', method: 'magic' }, asCode())).status).toBe(400);
    // No network here: a key-less key check answers before any request, and says what to do.
    expect(await (await post('/test', { probe: 'connection', harness: 'claude', method: 'key', key: '' }, asCode())).json()).toMatchObject({ ok: false, state: 'no_key' });
    expect(await (await post('/test', { probe: 'connection', harness: 'codex', method: 'key', key: 'k', baseUrl: 'ftp://x' }, asCode())).json()).toMatchObject({ ok: false, state: 'bad_address' });
  });
});

describe('POST /apply', () => {
  it('refuses answers that need another look and writes nothing', async () => {
    const r = await post('/apply', { answers: fresh({ password: 'short', discordEnable: true, discordOwnerUserId: 'x' }) }, asCode());
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body.problems.map((p: { id: string }) => p.id).sort()).toEqual(['discordOwnerUserId', 'password']);
    expect(existsSync(join(h.root, 'sanctum.yaml'))).toBe(false);
    expect(existsSync(join(h.root, '.env'))).toBe(false);
    expect(h.reloads).toBe(0);
  });

  it('the three-screen onboarding: only the names, the time zone, the harness, its model or key and the password are sent, and every other answer takes its default', async () => {
    // (the home folder is sent here only to keep the test inside its sandbox; the onboarding leaves it to its default)
    const claude = await post('/apply', { answers: { userName: 'Sam', companionName: 'Ada', timezone: 'America/New_York', provider: 'claude', claudeModel: 'claude-sonnet-5-5', password: SECRET_PW, home: companionHome } }, asCode());
    expect(claude.status).toBe(200);
    expect(await claude.json()).toMatchObject({ ok: true });
    const yaml = readFileSync(join(h.root, 'sanctum.yaml'), 'utf-8');
    expect(yaml).toMatch(/companion_name: "Ada"/);
    expect(yaml).toMatch(/user_name: "Sam"/);
    expect(yaml).toMatch(/America\/New_York/);
    expect(readFileSync(join(h.root, '.env'), 'utf-8')).not.toContain('ANTHROPIC_API_KEY'); // a Claude login, so no key is written
    h.password = SECRET_PW; // run again on Codex with a ChatGPT login: nothing but the harness changes
    const codex = await post('/apply', { answers: { userName: 'Sam', companionName: 'Ada', timezone: 'America/New_York', provider: 'codex', addProvider: false, home: companionHome } }, { 'content-type': 'application/json', 'x-test-session': 'yes' });
    expect(codex.status).toBe(200);
    expect(readFileSync(join(h.root, 'sanctum.yaml'), 'utf-8')).toMatch(/provider: "?codex"?/);
  });

  it('DeepSeek Harness, the third harness: its model in sanctum.yaml, its key in .env as DEEPSEEK_API_KEY (never in the reply), and no built-in memory offered', async () => {
    const plan = await (await post('/plan', { answers: { provider: 'dsh' } }, asCode())).json();
    const ids = plan.steps.map((st: { id: string }) => st.id);
    expect(ids).toEqual(expect.arrayContaining(['dshModel', 'dshKey']));
    expect(ids).not.toContain('claudeModel');
    expect(ids).not.toContain('anthropicKey');
    expect(plan.steps.find((st: { id: string }) => st.id === 'memory').options.map((o: { value: string }) => o.value)).toEqual(['revien', 'own', 'none', 'sanctum']);
    const r = await post('/apply', { answers: { userName: 'Sam', companionName: 'Ada', timezone: 'America/New_York', provider: 'dsh', dshModel: 'deepseek-chat', dshKey: 'sk-ds-secret', password: SECRET_PW, home: companionHome } }, asCode());
    const text = await r.text();
    expect(r.status).toBe(200);
    expect(text).not.toContain('sk-ds-secret');
    const yaml = readFileSync(join(h.root, 'sanctum.yaml'), 'utf-8');
    expect(yaml).toMatch(/provider: "dsh"/);
    expect(yaml).toMatch(/dsh:\n\s+model: "deepseek-chat"/);
    expect(yaml).not.toContain('sk-ds-secret');
    expect(readFileSync(join(h.root, '.env'), 'utf-8')).toContain('DEEPSEEK_API_KEY=sk-ds-secret');
    expect(process.env.DEEPSEEK_API_KEY).toBe('sk-ds-secret');
    delete process.env.DEEPSEEK_API_KEY;
  });

  it('pictures and summaries: the plan carries the optional steps, and apply writes the blocks and the keys (never in the reply)', async () => {
    const plan = await (await post('/plan', { answers: { imageProvider: 'runware', summaryWho: 'other' } }, asCode())).json();
    const ids = plan.steps.map((st: { id: string }) => st.id);
    expect(ids).toEqual(expect.arrayContaining(['imageProvider', 'imageKey', 'summaryWho', 'summaryEndpoint', 'summaryKey']));
    const bad = await post('/apply', { answers: fresh({ summaryWho: 'other', summaryEndpoint: 'nope' }) }, asCode());
    expect(bad.status).toBe(400);
    const r = await post('/apply', { answers: fresh({ imageProvider: 'runware', imageKey: 'rw-route-secret', summaryWho: 'other', summaryEndpoint: 'https://openrouter.ai/api/v1 some/model', summaryKey: 'sk-sum-route-secret' }) }, asCode());
    const text = await r.text();
    expect(r.status).toBe(200);
    expect(text).not.toContain('rw-route-secret');
    expect(text).not.toContain('sk-sum-route-secret');
    const yaml = readFileSync(join(h.root, 'sanctum.yaml'), 'utf-8');
    expect(yaml).toMatch(/imagegen:\n\s+provider: "runware"/);
    expect(yaml).toContain('base_url: "https://openrouter.ai/api/v1"');
    expect(yaml).not.toContain('route-secret');
    const envText = readFileSync(join(h.root, '.env'), 'utf-8');
    expect(envText).toContain('RUNWARE_API_KEY=rw-route-secret');
    expect(envText).toContain('SUMMARIZER_API_KEY=sk-sum-route-secret');
    delete process.env.RUNWARE_API_KEY;
    delete process.env.SUMMARIZER_API_KEY;
  });

  it("memory 'sanctum' (Sanctum's own memory) is written as agent.local_recall with Revien off, and a later setup offers it back", async () => {
    const r = await post('/apply', { answers: fresh({ memory: 'sanctum' }) }, asCode());
    expect(r.status).toBe(200);
    const yaml = readFileSync(join(h.root, 'sanctum.yaml'), 'utf-8');
    expect(yaml).toMatch(/local_recall: true/);
    expect(yaml).toMatch(/revien:\n\s+enabled: false/);
    h.password = SECRET_PW;
    const plan = await (await get('/plan', { 'x-test-session': 'yes' })).json();
    expect(plan.steps.find((st: { id: string }) => st.id === 'memory').default).toBe('sanctum');
  });

  it('a first run: writes sanctum.yaml and .env, reloads the config, hands the new password to the process, answers { restartNeeded, changed }', async () => {
    const r = await post('/apply', { answers: fresh({ companionName: 'Ada', userName: 'Sam' }) }, asCode());
    expect(r.status).toBe(200);
    const text = await r.text();
    const body = JSON.parse(text);
    expect(body).toMatchObject({ ok: true, restartNeeded: true });
    expect(body.changed.map((c: { what: string }) => c.what)).toEqual(expect.arrayContaining(['sanctum.yaml', '.env (the password and keys, never shown)']));
    expect(readFileSync(join(h.root, 'sanctum.yaml'), 'utf-8')).toMatch(/companion_name: "Ada"/);
    expect(readFileSync(join(h.root, 'sanctum.yaml'), 'utf-8')).toMatch(/written by the setup wizard/);
    expect(readFileSync(join(h.root, '.env'), 'utf-8')).toContain(`APP_PASSWORD=${SECRET_PW}`);
    expect(readFileSync(join(h.root, '.env'), 'utf-8')).toContain(`ANTHROPIC_API_KEY=${SECRET_KEY}`);
    expect(h.reloads).toBe(1);
    expect(h.appPassword).toBe(SECRET_PW); // handed to the config's holder...
    expect(process.env.APP_PASSWORD).toBeUndefined(); // ...and never put in the environment the provider children copy
    expect({ ...process.env }).not.toHaveProperty('APP_PASSWORD');
    expect(process.env.ANTHROPIC_API_KEY).toBe(SECRET_KEY);
    // no secret in the response
    expect(text).not.toContain(SECRET_PW);
    expect(text).not.toContain(SECRET_KEY);
  });

  it('never writes a secret into a log', async () => {
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'error'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'info')].map((s) => s.mockImplementation(() => undefined));
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await post('/apply', { answers: fresh({ provider: 'codex', addProvider: true, providerId: 'deepseek', providerBaseUrl: 'https://api.deepseek.com', providerKey: SECRET_PROVIDER_KEY, providerModel: 'deepseek-chat', providerName: 'DeepSeek' }) }, asCode());
    await post('/apply', { answers: fresh({ password: 'bad' }) }, asCode()); // a refused one too
    const seen = JSON.stringify([...logs.flatMap((s) => s.mock.calls), ...out.mock.calls]);
    for (const secret of [SECRET_PW, SECRET_KEY, SECRET_PROVIDER_KEY]) expect(seen).not.toContain(secret);
    expect(readFileSync(join(home, '.codex', 'config.toml'), 'utf-8')).toContain(SECRET_PROVIDER_KEY); // saved where it belongs
  });

  it('a re-run with a session: backs up sanctum.yaml and .env first, keeps the saved password, and says restartNeeded false for a change of name', async () => {
    h.password = SECRET_PW;
    writeFileSync(join(h.root, 'sanctum.yaml'), `identity:\n  companion_name: "Old"\nagent:\n  cwd: ${JSON.stringify(companionHome)}\n  provider: "claude"\n  harness_memory: false\nrevien:\n  enabled: false\n`); // JSON quoting: a Windows path's backslashes are not YAML escapes
    writeFileSync(join(h.root, '.env'), `APP_PASSWORD=${SECRET_PW}\n`);
    const r = await post('/apply', { answers: { provider: 'claude', home: companionHome, companionName: 'New', memory: 'none', appWrite: true, rolling: false, phoneOrigin: '' } }, asSession());
    const body = await r.json();
    expect(r.status).toBe(200);
    expect(readFileSync(join(h.root, '.env'), 'utf-8')).toBe(`APP_PASSWORD=${SECRET_PW}\n`);
    const files = readdirSync(h.root);
    expect(files.filter((f) => f.startsWith('sanctum.yaml.bak-'))).toHaveLength(1);
    expect(files.filter((f) => f.startsWith('.env.bak-'))).toHaveLength(0); // nothing was written to .env, so nothing to copy
    expect(readFileSync(join(h.root, 'sanctum.yaml'), 'utf-8')).toMatch(/companion_name: "New"/);
    expect(body.restartNeeded).toBe(true); // app_write and rolling were added: the agent block changed
  });

  it('a re-run that only renames needs no restart', async () => {
    h.password = SECRET_PW;
    const answers = { provider: 'claude', home: companionHome, memory: 'none', appWrite: true, rolling: false, phoneOrigin: '', claudeModel: 'claude-sonnet-5-5' };
    await post('/apply', { answers: { ...answers, companionName: 'One' } }, asSession());
    const second = await (await post('/apply', { answers: { ...answers, companionName: 'Two' } }, asSession())).json();
    expect(second.restartNeeded).toBe(false);
  });

  describe('changing the password signs the other browsers out', () => {
    const rerun = { provider: 'claude', home: companionHome, memory: 'none', appWrite: true, rolling: false, phoneOrigin: '', claudeModel: 'claude-sonnet-5-5' };
    const asBrowser = () => asSession({ cookie: 'other=1; sanctum_session=tok-mine' });
    beforeEach(() => { h.password = SECRET_PW; writeFileSync(join(h.root, '.env'), `APP_PASSWORD=${SECRET_PW}\n`); });

    it('a new password removes every session but the caller\'s, and says how many', async () => {
      const r = await post('/apply', { answers: { ...rerun, password: 'a-brand-new-password' } }, asBrowser());
      expect(r.status).toBe(200);
      expect(h.kept).toEqual(['tok-mine']);
      expect((await r.json()).notes.join('\n')).toMatch(/2 other signed-in browsers were signed out/);
    });
    it('no new password, or the same one typed again, leaves the sessions alone', async () => {
      await post('/apply', { answers: rerun }, asBrowser());
      await post('/apply', { answers: { ...rerun, password: SECRET_PW } }, asBrowser());
      expect(h.kept).toEqual([]);
    });
    it('APP_PASSWORD from the parent environment: a new password still applies now, but says it must be changed there too (no restart asked for: a restart is what brings the old one back)', async () => {
      h.source = 'parent_env';
      const r = await post('/apply', { answers: { ...rerun, password: 'a-brand-new-password' } }, asBrowser());
      const body = await r.json();
      expect(h.appPassword).toBe('a-brand-new-password');
      expect(readFileSync(join(h.root, '.env'), 'utf8')).toContain('a-brand-new-password');
      expect(body.passwordKeptByParent).toBe(true);
      // A change of password alone asks for no restart (the parent banner carries its own advice): apply the same
      // answers again with only the password different, and nothing else is left to change.
      const again = await (await post('/apply', { answers: { ...rerun, password: 'a-second-new-password' } }, asBrowser())).json();
      expect(again.passwordKeptByParent).toBe(true);
      expect(again.restartNeeded).toBe(false);
      expect(body.passwordSource).toBe('parent_env');
      expect(body.notes[0]).toMatch(/set by whatever starts this app.*change it there too.*old password comes back at the next restart/);
    });
    it('parent environment, but the password is not changed (none typed, or the same one): no such note', async () => {
      h.source = 'parent_env';
      for (const answers of [rerun, { ...rerun, password: SECRET_PW }]) {
        const body = await (await post('/apply', { answers }, asBrowser())).json();
        expect(body.passwordKeptByParent).toBe(false);
        expect(body.notes.join('\n')).not.toMatch(/whatever starts this app/);
      }
    });
    it('a password from .env: a change carries no such note', async () => {
      const body = await (await post('/apply', { answers: { ...rerun, password: 'a-brand-new-password' } }, asBrowser())).json();
      expect(body.passwordKeptByParent).toBe(false);
      expect(body.notes.join('\n')).not.toMatch(/whatever starts this app/);
    });
    it('a first run removes every session left from an earlier password (none is the caller\'s)', async () => {
      h.password = '';
      const r = await post('/apply', { answers: fresh() }, asCode());
      expect(r.status).toBe(200);
      expect(h.kept).toEqual([null]);
      expect((await r.json()).notes.join('\n')).toMatch(/password was set, so 2 signed-in browsers were signed out/);
    });
    it('a refused apply (400) removes nothing', async () => {
      await post('/apply', { answers: { ...rerun, password: 'short' } }, asBrowser());
      expect(h.kept).toEqual([]);
    });
  });

  it('person mode: ratifies what was confirmed with the digest shown, creates the Discord lists, and the ledger is written', async () => {
    const plan = await (await post('/plan', { answers: { provider: 'claude', pluginsTrust: 'person', plugins: ['hello'] } }, asCode())).json();
    const digest = plan.steps.find((s: { id: string }) => s.id === 'ratify_0').meta.digest;
    const r = await post('/apply', { answers: fresh({ pluginsTrust: 'person', plugins: ['hello'], ratify_0: true, 'ratify_0#digest': digest, discordEnable: true, discordOwnerUserId: '123456789012345678', discordOwnerChannelId: '223456789012345678' }) }, asCode());
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(JSON.parse(readFileSync(join(h.root, 'data', 'plugins', 'ratified.json'), 'utf-8')).plugins.hello.digest).toBe(digest);
    expect(readFileSync(join(h.root, 'sanctum.yaml'), 'utf-8')).toMatch(/enabled:\n\s+- "hello"/);
    expect(readdirSync(join(home, 'Documents', 'sanctum-private')).sort()).toEqual(['exclusions.txt', 'names.txt', 'words.txt']);
    expect(body.changed.map((c: { what: string }) => c.what).join('\n')).toMatch(/ratification ledger/);
    expect(body.changed.map((c: { what: string }) => c.what).join('\n')).toMatch(/Discord private lists/);
  });

  it('person mode: a declined plugin is left out, and the answer says so', async () => {
    const r = await (await post('/apply', { answers: fresh({ pluginsTrust: 'person', plugins: ['hello'], ratify_0: false }) }, asCode())).json();
    expect(r.notes.join('\n')).toMatch(/hello was left out of plugins\.enabled/);
    expect(existsSync(join(h.root, 'data', 'plugins', 'ratified.json'))).toBe(false);
  });

  it('makes the home folder when it is missing and the person said to', async () => {
    const elsewhere = join(h.root, 'newhome', 'companion-home');
    const r = await (await post('/apply', { answers: fresh({ home: elsewhere, homeCreate: true }) }, asCode())).json();
    expect(existsSync(join(elsewhere, 'identity', 'profile.md'))).toBe(true);
    expect(r.changed.some((c: { path: string }) => c.path === elsewhere)).toBe(true);
  });

  it('a config that will not reload is not a failure: the files are saved, and the answer says a restart will pick them up', async () => {
    h.reloadThrows = true;
    const r = await post('/apply', { answers: fresh() }, asCode());
    expect(r.status).toBe(200);
    expect((await r.json()).notes.join('\n')).toMatch(/could not be loaded until a restart/);
  });

  it('answers a failure plainly, with no secret in it', async () => {
    const r = await post('/apply', { answers: fresh({ password: '' }) }, asCode()); // no password typed on a fresh install: invalid
    expect(r.status).toBe(400);
    expect(JSON.stringify(await r.json())).not.toContain(SECRET_KEY);
  });
});

describe('phases: GET /plan and POST /plan, /validate and /apply take `phase` or `more`', () => {
  const idsOf = (plan: { steps: { id: string }[] }) => plan.steps.map((s) => s.id);
  const CONFIGURED = (tail = '') => `identity:\n  companion_name: "Echo"\n  user_name: "Sam"\n  timezone: "UTC"\nagent:\n  cwd: ${JSON.stringify(companionHome)}\n  provider: "claude"\n  model: "claude-sonnet-5-5"\n  app_write: true\n  rolling:\n    claude: true\nrevien:\n  enabled: false\n${tail}`;

  it('a request that sends neither `phase` nor `more` gets every question, as the in-app wizard always did', async () => {
    const plan = await (await rawGet('/plan', asCode())).json();
    expect(plan.phase).toBe('all');
    expect(plan.more).toBe(true);
    expect(idsOf(plan)).toEqual(expect.arrayContaining(['companionName', 'rolling', 'pluginsTrust', 'discordEnable', 'phoneOrigin']));
    expect((await (await rawPost('/plan', { answers: {} }, asCode())).json()).phase).toBe('all');
    // and /apply with no phase takes the same full step set: an answer for a phase-two step is written
    h.password = SECRET_PW;
    writeFileSync(join(h.root, 'sanctum.yaml'), CONFIGURED());
    writeFileSync(join(h.root, '.env'), `APP_PASSWORD=${SECRET_PW}\n`);
    const configured = await (await rawPost('/plan', { answers: {} }, asSession())).json();
    expect(configured.phase).toBe('all');
    expect(idsOf(configured)).toEqual(expect.arrayContaining(['companionName', 'password', 'rolling', 'discordEnable']));
    const r = await rawPost('/apply', { answers: { phoneOrigin: 'https://phone.example.ts.net' } }, asSession());
    expect(r.status).toBe(200);
    expect(readFileSync(join(h.root, 'sanctum.yaml'), 'utf-8')).toContain('phone.example.ts.net');
  });

  it('a first run is phase one when asked for: only the tier-zero questions, each marked phase 1', async () => {
    const plan = await (await rawGet('/plan?phase=one', asCode())).json();
    expect(plan.phase).toBe('one');
    expect(plan.more).toBe(false);
    expect(idsOf(plan)).toEqual(['companionName', 'userName', 'timezone', 'home', 'homeCreate', 'provider', 'codexModel', 'appWrite', 'orchestrator', 'password', 'memory']);
    expect(plan.steps.every((s: { phase: number }) => s.phase === 1)).toBe(true);
  });

  it('the provider answer picks the model and key questions of phase one', async () => {
    const plan = await (await rawPost('/plan', { phase: 'one', answers: { provider: 'claude' } }, asCode())).json();
    expect(idsOf(plan)).toEqual(['companionName', 'userName', 'timezone', 'home', 'homeCreate', 'provider', 'claudeModel', 'anthropicKey', 'appWrite', 'orchestrator', 'password', 'memory']);
  });

  it('`more` (query or body) is the rest, and `phase: all` is everything', async () => {
    const more = await (await rawGet('/plan?more=1', asCode())).json();
    expect(more.phase).toBe('more');
    expect(more.more).toBe(true);
    expect(idsOf(more)).toEqual(expect.arrayContaining(['addProvider', 'sandbox', 'rolling', 'pluginsTrust', 'discordEnable', 'browserSeat', 'phoneOrigin']));
    // a first run has not answered phase one yet, so `more` still asks it
    expect(idsOf(more)).toEqual(expect.arrayContaining(['companionName', 'password']));
    expect((await (await rawPost('/plan', { more: true, answers: {} }, asCode())).json()).phase).toBe('more');
    const all = await (await rawGet('/plan?phase=all', asCode())).json();
    expect(all.phase).toBe('all');
    expect(idsOf(all)).toEqual(expect.arrayContaining(['companionName', 'rolling', 'discordEnable']));
    expect(idsOf(all).indexOf('companionName')).toBeLessThan(idsOf(all).indexOf('discordEnable'));
  });

  it('a configured install asks nothing in phase one, and says what it kept; `more` shows the rest only', async () => {
    h.password = SECRET_PW;
    writeFileSync(join(h.root, 'sanctum.yaml'), CONFIGURED());
    writeFileSync(join(h.root, '.env'), `APP_PASSWORD=${SECRET_PW}\n`);
    const one = await (await rawGet('/plan?phase=one', asSession())).json();
    expect(one.phase).toBe('one');
    expect(one.steps).toEqual([]);
    expect(one.notes).toEqual(expect.arrayContaining(['Kept: Your name = Sam', 'Kept: Provider = Claude']));
    expect(JSON.stringify(one)).not.toContain(SECRET_PW);
    const more = await (await rawGet('/plan?more=1', asSession())).json();
    expect(idsOf(more)).not.toContain('companionName');
    expect(idsOf(more)).not.toContain('password');
    expect(idsOf(more)).toEqual(expect.arrayContaining(['rolling', 'pluginsTrust', 'discordEnable']));
    expect(more.steps.every((s: { phase: number }) => s.phase === 2)).toBe(true);
  });

  it('phase one applies on its own: a first run writes the tier-zero answers, and nothing the other phase owns is left to chance', async () => {
    const r = await rawPost('/apply', { phase: 'one', answers: fresh({ orchestrator: false }) }, asCode());
    expect(r.status).toBe(200);
    const yaml = readFileSync(join(h.root, 'sanctum.yaml'), 'utf-8');
    expect(yaml).toMatch(/orchestrator:\n  enabled: false/);
    expect(yaml).toMatch(/provider: "?claude"?/);
    expect(yaml).toMatch(/app_write: true/);
    expect(yaml).toMatch(/rolling:/); // phase two's rolling memory took its default
    expect(yaml).not.toMatch(/plugins:/); // plugins are left alone by a run that did not ask
    expect(readFileSync(join(h.root, '.env'), 'utf-8')).toContain(`APP_PASSWORD=${SECRET_PW}`);
  });

  it('`more` on apply: a phase-two answer is written; one sent in phase one is refused, not dropped', async () => {
    h.password = SECRET_PW;
    writeFileSync(join(h.root, 'sanctum.yaml'), CONFIGURED());
    writeFileSync(join(h.root, '.env'), `APP_PASSWORD=${SECRET_PW}\n`);
    const refused = await rawPost('/apply', { phase: 'one', answers: { phoneOrigin: 'https://phone.example.ts.net' } }, asSession());
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: 'answers_for_skipped_steps', steps: ['phoneOrigin'] });
    expect(readFileSync(join(h.root, 'sanctum.yaml'), 'utf-8')).not.toContain('phone.example.ts.net');
    const r = await rawPost('/apply', { more: true, answers: { phoneOrigin: 'https://phone.example.ts.net' } }, asSession());
    expect(r.status).toBe(200);
    expect(readFileSync(join(h.root, 'sanctum.yaml'), 'utf-8')).toContain('phone.example.ts.net');
  });

  it('the other direction: a phase-one answer already kept, sent to `more`, is refused too', async () => {
    h.password = SECRET_PW;
    writeFileSync(join(h.root, 'sanctum.yaml'), CONFIGURED());
    writeFileSync(join(h.root, '.env'), `APP_PASSWORD=${SECRET_PW}\n`);
    const before = readFileSync(join(h.root, 'sanctum.yaml'), 'utf-8');
    const r = await rawPost('/apply', { more: true, answers: { companionName: 'Renamed', phoneOrigin: 'https://phone.example.ts.net' } }, asSession());
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ error: 'answers_for_skipped_steps', steps: ['companionName'] });
    expect(readFileSync(join(h.root, 'sanctum.yaml'), 'utf-8')).toBe(before);
  });

  it('/validate follows the phase: a phase-two step is not asked in phase one', async () => {
    const one = await (await rawPost('/validate', { id: 'phoneOrigin', value: 'nope', phase: 'one' }, asCode())).json();
    expect(one).toMatchObject({ ok: true, active: false });
    const more = await (await rawPost('/validate', { id: 'phoneOrigin', value: 'nope', more: true }, asCode())).json();
    expect(more).toMatchObject({ ok: false, active: true });
  });
});
