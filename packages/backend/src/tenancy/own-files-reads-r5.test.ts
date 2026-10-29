// Round 5 over HTTP (items 2, 3, 4, 5, 7, 8): reads fail closed. A tenant's request, or a path the companion names, never reaches the app's .env, another tenant's
// database, or anything a planted link points at; a refused read answers 400 or 404, never 500; a pipe is never opened. Real express, real auth, real tenants;
// the Telegram service is a recorder (no network); no provider key, no model run.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../services/embeddings.js', async (orig) => ({ ...(await orig<object>()), embed: async () => new Float32Array(384) })); // createMessage fires a background embed: none here

import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { bootTenants } from './boot.js';
import { enableTenancy, registerProcessConfig, runInTenant, type TenantRuntime } from './context.js';
import { tenantResolve, tenantEnter, setTenantRegistry } from './resolve.js';
import { processConfigFor, safeTenancyProcess, stopBootedTenants, safeTenantYaml } from './test-runtime.js';
import { loginHandler } from '../middleware/auth.js';
import { createThread } from '../services/db.js';
import { createHooks } from '../services/hooks.js';
import apiRoutes from '../routes/api.js';
import { globalErrorHandler } from '../middleware/error-handler.js';

const posix = process.platform !== 'win32';
const SECRET = 'APP_PASSWORD=process-secret-bytes\n';
const LEAK_SKILL = '---\nname: LEAKED-NAME\ndescription: LEAKED-DESCRIPTION\n---\nbody\n';
let server: http.Server;
let port = 0;
let top = '';
let runtimes: Map<string, TenantRuntime>;
const cookies: Record<string, string> = {};
const sentToTelegram: Array<{ kind: string; bytes: string }> = [];

function call(method: string, path: string, id: string, opts: { json?: unknown; token?: boolean } = {}): Promise<{ status: number; text: string; json: any }> {
  return new Promise((ok, fail) => {
    const headers: Record<string, string> = { host: `${id}.example.net` };
    if (opts.token) headers['x-internal-token'] = runtimes.get(id)!.token; else if (cookies[id]) headers.cookie = cookies[id];
    let payload: Buffer | undefined;
    if (opts.json !== undefined) { payload = Buffer.from(JSON.stringify(opts.json)); headers['content-type'] = 'application/json'; headers['content-length'] = String(payload.length); }
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let json: unknown = null; try { json = JSON.parse(text); } catch { /* not json */ } ok({ status: res.statusCode ?? 0, text, json }); });
    });
    req.on('error', fail);
    if (payload) req.write(payload);
    req.end();
  });
}
const tdir = (id: string) => join(top, 'tenants', id);
const home = (id: string) => join(tdir(id), 'home');
const fakeTelegram = {
  isConnected: () => true,
  stop: async () => {},
  sendPhotoToOwner: async (src: Buffer | string) => { sentToTelegram.push({ kind: 'photo', bytes: String(src) }); },
  sendDocumentToOwner: async (src: Buffer | string) => { sentToTelegram.push({ kind: 'document', bytes: String(src) }); },
  sendAnimationToOwner: async (src: Buffer | string) => { sentToTelegram.push({ kind: 'animation', bytes: String(src) }); },
};

beforeAll(async () => {
  for (const m of ['log', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation(() => {});
  top = realpathSync.native(mkdtempSync(join(tmpdir(), 'sanctum-reads5-')));
  const tenants = join(top, 'tenants');
  const yamlFor: Record<string, string> = {
    ada: 'agent:\n  system_prompt_file: home/frame.md\norchestrator:\n  wake_prompts_dir: prompts/wakes\n',
    bea: '',
  };
  for (const id of ['ada', 'bea']) {
    mkdirSync(join(tenants, id), { recursive: true });
    writeFileSync(join(tenants, id, 'tenant.yaml'), safeTenantYaml(`hosts: [${id}.example.net]\n${yamlFor[id]}`));
    writeFileSync(join(tenants, id, '.env'), `APP_PASSWORD=pw-${id}\n`);
  }
  mkdirSync(join(tenants, 'ada', 'prompts', 'wakes'), { recursive: true });
  writeFileSync(join(top, 'app.env'), SECRET);
  const proc = processConfigFor(resolve(top, 'proc'), { orchestrator: { enabled: false } });
  (proc as unknown as { tenants: unknown }).tenants = { dir: tenants };
  registerProcessConfig(() => proc);
  const app = express();
  app.set('trust proxy', 1);
  runtimes = bootTenants(app, safeTenancyProcess(proc));
  runtimes.get('ada')!.services.telegramService = fakeTelegram;
  app.use(tenantResolve);
  app.use(express.json());
  app.use(tenantEnter);
  app.post('/api/auth/login', loginHandler);
  app.use('/api', apiRoutes);
  app.use(globalErrorHandler);
  await new Promise<void>((ok) => { server = app.listen(0, '127.0.0.1', () => ok()); });
  port = (server.address() as AddressInfo).port;
  for (const id of ['ada', 'bea']) {
    const r = await new Promise<string>((ok, fail) => {
      const body = Buffer.from(JSON.stringify({ password: `pw-${id}` }));
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/auth/login', headers: { host: `${id}.example.net`, 'content-type': 'application/json', 'content-length': String(body.length) } }, (res) => { res.resume(); res.on('end', () => ok(String(res.headers['set-cookie']?.[0] ?? '').split(';')[0])); });
      req.on('error', fail); req.write(body); req.end();
    });
    cookies[id] = r;
  }
});
afterAll(async () => {
  await stopBootedTenants();
  await new Promise<void>((ok) => server.close(() => ok()));
  for (const rt of runtimes.values()) { try { rt.db.close(); } catch { /* closed */ } }
  enableTenancy(false); setTenantRegistry(new Map()); registerProcessConfig(() => null);
  rmSync(top, { recursive: true, force: true });
  vi.restoreAllMocks();
});
const noLeak = (text: string) => { expect(text).not.toContain('process-secret-bytes'); expect(text).not.toContain('LEAKED'); expect(text).not.toContain('SQLite'); };

describe('item 2: POST /internal/telegram-send answers 403 for a path outside the tenant folder, and no byte reaches Telegram', () => {
  const beaDb = () => join(tdir('bea'), 'data', 'sanctum.db');
  const spellings: Array<[string, () => string]> = [
    ["the app's .env", () => join(top, 'app.env')],
    ["the other tenant's sanctum.db", beaDb],
    ["the app's .env by a dot-dot path", () => join(home('ada'), '..', '..', '..', 'app.env')],
    ...(posix && existsSync('/proc/self/root') ? [["the app's .env through /proc/self/root", () => `/proc/self/root${join(top, 'app.env')}`] as [string, () => string]] : []),
  ];
  for (const type of ['photo', 'document', 'animation']) {
    it.each(spellings)(`${type}: %s → 403`, async (_n, path) => {
      const before = sentToTelegram.length;
      const r = await call('POST', '/api/internal/telegram-send', 'ada', { token: true, json: { type, path: path() } });
      expect(r.status).toBe(403);
      expect(r.text).toContain('outside the tenant folder');
      noLeak(r.text);
      expect(sentToTelegram).toHaveLength(before);
    });
  }
  it("a file in the tenant's own home is sent (the control), and a link planted in home/ to the app's .env is refused with no bytes sent", async () => {
    mkdirSync(home('ada'), { recursive: true });
    writeFileSync(join(home('ada'), 'pic.png'), 'OWN-BYTES');
    sentToTelegram.length = 0;
    const ok = await call('POST', '/api/internal/telegram-send', 'ada', { token: true, json: { type: 'photo', path: join(home('ada'), 'pic.png') } });
    expect(ok.status).toBe(200);
    expect(sentToTelegram).toEqual([{ kind: 'photo', bytes: 'OWN-BYTES' }]);
    sentToTelegram.length = 0;
    try { symlinkSync(join(top, 'app.env'), join(home('ada'), 'evil.png'), 'file'); } catch { return; }
    const bad = await call('POST', '/api/internal/telegram-send', 'ada', { token: true, json: { type: 'document', path: join(home('ada'), 'evil.png') } });
    expect([400, 403]).toContain(bad.status); // (a link out of the folder is "outside" by its real path: 403; the layer would say 400)
    noLeak(bad.text);
    expect(sentToTelegram).toEqual([]);
  });
});

describe('item 3: a link planted by the companion is never served', () => {
  const avatarDir = () => join(home('ada'), 'identity');
  it('GET /api/identity/avatar: a real avatar is served; an avatar.png symlink or hard link to the app .env is 404 with no bytes', async () => {
    mkdirSync(avatarDir(), { recursive: true });
    writeFileSync(join(avatarDir(), 'avatar.png'), 'REAL-PNG-BYTES');
    const ok = await call('GET', '/api/identity/avatar', 'ada');
    expect(ok.status).toBe(200);
    expect(ok.text).toBe('REAL-PNG-BYTES');
    rmSync(join(avatarDir(), 'avatar.png'));
    if (posix || true) {
      let made = false;
      try { symlinkSync(join(top, 'app.env'), join(avatarDir(), 'avatar.png'), 'file'); made = true; } catch { /* no links here */ }
      if (made) {
        const r = await call('GET', '/api/identity/avatar', 'ada');
        expect(r.status).toBe(404);
        noLeak(r.text);
        expect((await call('GET', '/api/identity', 'ada')).json.avatar_url).toBeNull();
        rmSync(join(avatarDir(), 'avatar.png'));
      }
    }
    if (posix) {
      linkSync(join(top, 'app.env'), join(avatarDir(), 'avatar.png'));
      const r = await call('GET', '/api/identity/avatar', 'ada');
      expect(r.status).toBe(404);
      noLeak(r.text);
      rmSync(join(avatarDir(), 'avatar.png'));
    }
  });
  it('GET /api/skills: a SKILL.md symlink or hard link is left out of the list and none of its bytes appear', async () => {
    const skills = join(home('ada'), '.claude', 'skills');
    for (const n of ['real', 'sym', 'hard']) mkdirSync(join(skills, n), { recursive: true });
    writeFileSync(join(skills, 'real', 'SKILL.md'), '---\nname: real-skill\ndescription: fine\n---\n');
    writeFileSync(join(top, 'leak-skill.md'), LEAK_SKILL);
    try { symlinkSync(join(top, 'leak-skill.md'), join(skills, 'sym', 'SKILL.md'), 'file'); } catch { rmSync(join(skills, 'sym'), { recursive: true }); }
    if (posix) linkSync(join(top, 'leak-skill.md'), join(skills, 'hard', 'SKILL.md'));
    const r = await call('GET', '/api/skills', 'ada');
    expect(r.status).toBe(200);
    expect(r.json.skills.map((s: { name: string }) => s.name)).toEqual(['real-skill']);
    noLeak(r.text);
  });
  it('GET /api/prompts/system: the frame read has the hard-link check; a hard link to a file outside is 400 with no bytes', async () => {
    if (!posix) return;
    writeFileSync(join(home('ada'), 'frame.md'), 'FRAME TEXT');
    const ok = await call('GET', '/api/prompts/system', 'ada');
    expect(ok.status).toBe(200);
    expect(ok.json.content).toBe('FRAME TEXT');
    rmSync(join(home('ada'), 'frame.md'));
    linkSync(join(top, 'app.env'), join(home('ada'), 'frame.md'));
    const r = await call('GET', '/api/prompts/system', 'ada');
    expect(r.status).toBe(400);
    expect(r.text).toContain('more than one hard link');
    noLeak(r.text);
    rmSync(join(home('ada'), 'frame.md'));
  });
});

describe.runIf(posix)('item 4: GET /api/files/read never opens a pipe', () => {
  it('a FIFO in home/ answers 400 (a writer that would unblock an open is started and never needed)', async () => {
    const fifo = join(home('ada'), 'pipe.txt');
    execFileSync('mkfifo', [fifo]);
    const writer = spawn('sh', ['-c', 'exec 3>"$1"; echo LEAKED-FROM-PIPE >&3; exec 3>&-', 'sh', fifo], { stdio: 'ignore' });
    try {
      const r = await call('GET', `/api/files/read?path=${encodeURIComponent(fifo)}`, 'ada');
      expect(r.status).toBe(400);
      expect(r.text).toContain('not a regular file');
      noLeak(r.text);
    } finally { writer.kill('SIGKILL'); rmSync(fifo, { force: true }); }
  });
});

describe('item 5: a refused read answers 400, never 500', () => {
  it.runIf(posix)('GET /api/files/read on a hard link to the app .env: 400 naming the hard link, no bytes', async () => {
    const f = join(home('ada'), 'hard.txt');
    linkSync(join(top, 'app.env'), f);
    const r = await call('GET', `/api/files/read?path=${encodeURIComponent(f)}`, 'ada');
    expect(r.status).toBe(400);
    expect(r.json.error).toContain('more than one hard link');
    noLeak(r.text);
    rmSync(f);
  });
  it.runIf(posix)('POST /internal/share on a hard link: 400 carrying the sentence (it was a 500)', async () => {
    const f = join(home('ada'), 'hard-share.txt');
    linkSync(join(top, 'app.env'), f);
    const r = await call('POST', '/api/internal/share', 'ada', { token: true, json: { path: f } });
    expect(r.status).toBe(400);
    expect(r.json.error).toContain('more than one hard link');
    noLeak(r.text);
    rmSync(f);
  });
  it('GET /api/files/read on a symlink to the app .env: refused (400 or 403, never 500), and a path outside the roots is still 403', async () => {
    const f = join(home('ada'), 'sym.txt');
    try { symlinkSync(join(top, 'app.env'), f, 'file'); } catch { return; }
    const r = await call('GET', `/api/files/read?path=${encodeURIComponent(f)}`, 'ada');
    expect([400, 403]).toContain(r.status);
    noLeak(r.text);
    rmSync(f);
    expect((await call('GET', `/api/files/read?path=${encodeURIComponent(join(top, 'app.env'))}`, 'ada')).status).toBe(403);
  });
});

describe('item 7: GET /api/orchestrator/wake-types reads through the guard', () => {
  const dir = () => join(tdir('ada'), 'prompts', 'wakes');
  it('a planted link or hard link is left out of the list (no bytes) and 400 when asked for by name; a real prompt is listed', async () => {
    writeFileSync(join(dir(), 'morning.md'), 'Good morning');
    for (const n of ['evening.md', 'midday.md']) rmSync(join(dir(), n), { force: true }); // (the orchestrator wrote its default prompts here)
    writeFileSync(join(top, 'leak-wake.md'), 'LEAKED wake text');
    let linked = false;
    try { symlinkSync(join(top, 'leak-wake.md'), join(dir(), 'evening.md'), 'file'); linked = true; } catch { /* no links */ }
    if (posix) linkSync(join(top, 'leak-wake.md'), join(dir(), 'midday.md'));
    const list = await call('GET', '/api/orchestrator/wake-types', 'ada');
    expect(list.status).toBe(200);
    const types = list.json.wakeTypes.map((w: { type: string }) => w.type);
    expect(types).toContain('morning');
    expect(types).not.toContain('evening');
    expect(types).not.toContain('midday');
    noLeak(list.text);
    if (linked) { const one = await call('GET', '/api/orchestrator/wake-types/evening', 'ada'); expect(one.status).toBe(400); noLeak(one.text); }
    if (posix) { const one = await call('GET', '/api/orchestrator/wake-types/midday', 'ada'); expect(one.status).toBe(400); noLeak(one.text); }
    expect((await call('GET', '/api/orchestrator/wake-types/morning', 'ada')).json.content).toBe('Good morning');
  });
});

describe('item 8: the shared-folder auto-share judges the real path, not the text', () => {
  const post = (file: string, thread: string) => {
    const ada = runtimes.get('ada')!;
    const broadcast = vi.fn();
    const hooks = runInTenant(ada, () => createHooks({ threadId: thread, threadName: 't', threadType: 'named', streamMsgId: 'm1', isAutonomous: false, registry: { broadcast } as never, sessionId: 's', platform: 'web', toolInsertions: [], getTextLength: () => 0 }));
    const fn = (hooks!.PostToolUse as Array<{ hooks: Array<(i: unknown, id: string, o: { signal: AbortSignal }) => Promise<unknown>> }>)[0].hooks[0];
    return runInTenant(ada, () => fn({ hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: file }, tool_response: 'ok', tool_use_id: 'u1', session_id: 's', transcript_path: '', cwd: '' }, 'u1', { signal: new AbortController().signal })).then(() => broadcast.mock.calls.map((c) => c[0] as { type: string }).filter((m) => m.type === 'message').length);
  };
  const filesOf = () => { const d = join(tdir('ada'), 'data', 'files'); return existsSync(d) ? readdirSync(d).length : 0; };
  it('a file in <home>/shared is shared (the control); <home>/shared/../.. paths that land on the tenant .env or the app .env share nothing and save nothing', async () => {
    const ada = runtimes.get('ada')!;
    const thread = runInTenant(ada, () => createThread({ name: 'share-test', type: 'named', createdAt: new Date().toISOString() })).id;
    mkdirSync(join(home('ada'), 'shared'), { recursive: true });
    writeFileSync(join(home('ada'), 'shared', 'ok.txt'), 'SHARED OK');
    expect(await post(join(home('ada'), 'shared', 'ok.txt'), thread)).toBe(1);
    const saved = filesOf();
    // the text of both paths starts with <home>/shared/
    const intoTenant = `${join(home('ada'), 'shared')}/../../.env`; // the tenant's own .env (inside the tenant folder)
    const toApp = `${join(home('ada'), 'shared')}/../../../../app.env`; // the app's .env (outside it)
    expect(await post(intoTenant, thread)).toBe(0);
    expect(await post(toApp, thread)).toBe(0);
    expect(filesOf()).toBe(saved);
  });
});
