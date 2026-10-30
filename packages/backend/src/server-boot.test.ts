// Negative control for multi-tenant stage 1: the real server, started the way `npm start` starts it with no `tenants:` block, prints
// the same boot lines in the same order and answers /api/health and /api/auth/check with the same bodies as before tenancy existed.
// The child gets no provider key, the orchestrator is off, and everything it writes is in a temp folder. UPDATE_GOLDEN=1 rewrites the golden.
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { request as httpRequest, createServer as createServer2 } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { safeTenantYaml } from './tenancy/test-runtime.js';

const here = dirname(fileURLToPath(import.meta.url));
const backendDir = resolve(here, '..');
const projectRoot = resolve(here, '..', '..', '..');
const goldenPath = join(here, 'test-golden', 'server-boot.json');
const PROVIDER_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'MIND_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CODEX_API_KEY', 'GROQ_API_KEY', 'ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID', 'HUME_API_KEY', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'APP_PASSWORD', 'INTERNAL_TOKEN'];

function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address() as { port: number }; s.close(() => ok(port)); });
  });
}

const slash = (s: string) => s.replace(/\\/g, '/');

interface Scratch { lines: string[]; port: number; dir: string; stderr: () => string; stop: () => Promise<void>; terminate: () => Promise<number | null> }

/** Start src/server.ts as `npm start` does, in a temp folder, with no provider key and the orchestrator off; resolve on its last listen line. */
async function startScratch(extraYaml: string[] = [], lastLine = 'Companion: '): Promise<Scratch> {
  const dir = mkdtempSync(join(tmpdir(), 'sanctum-boot-'));
  const port = await freePort();
  const yamlText = [
    'orchestrator:', '  enabled: false',
    `  wake_prompts_dir: ${JSON.stringify(join(dir, 'wakes'))}`,
    `  wake_prompts_path: ${JSON.stringify(join(dir, 'wake.md'))}`,
    'identity:', `  ledger_dir: ${JSON.stringify(join(dir, 'identity'))}`,
    'plugins:', `  ledger_dir: ${JSON.stringify(join(dir, 'plugins'))}`,
    ...extraYaml,
    '',
  ].join('\n');
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !PROVIDER_KEYS.includes(k)) env[k] = v;
  for (const k of Object.keys(env)) if (/^(AGENT_|DSH_|PORT$|HOST$|TZ$|DB_PATH$|DISCORD_|TELEGRAM_|GOOGLE_)/i.test(k)) delete env[k];
  Object.assign(env, {
    DB_PATH: join(dir, 'data', 'sanctum.db'), AGENT_CWD: join(dir, 'home'), PORT: String(port), HOST: '127.0.0.1',
    NODE_ENV: 'development', APP_PASSWORD: 'golden-password',
    SANCTUM_BOOT_ROOT: projectRoot, SANCTUM_BOOT_YAML: yamlText,
  });

  const child = spawn(process.execPath, ['--import', 'tsx', '--import', pathToFileURL(join(here, 'test-helpers', 'boot-config-preload.mjs')).href, 'src/server.ts'], { cwd: backendDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let exitCode: number | null = null;
  const exited = new Promise<void>((done) => child.once('exit', (code) => { exitCode = code; done(); }));
  const lines: string[] = [];
  let stderr = '';
  child.stderr!.on('data', (d) => { stderr += String(d); });
  const stop = async () => { child.kill(); await exited; rmSync(dir, { recursive: true, force: true }); };
  // A polite SIGTERM, and the exit code the server chose (null where the platform cannot deliver the signal).
  const terminate = async () => { child.kill('SIGTERM'); await exited; return exitCode; };
  try {
    // Resolves on the last line of the listen callback; rejects if the child exits first or the hard timeout fires.
    await new Promise<void>((ok, fail) => {
      const timer = setTimeout(() => fail(new Error(`no listen line within 60s\n${lines.join('\n')}\n${stderr}`)), 60_000);
      let buf = '';
      child.stdout!.on('data', (d) => {
        buf += String(d);
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).replace(/\r$/, '');
          buf = buf.slice(i + 1);
          lines.push(line);
          if (line.startsWith(lastLine)) { clearTimeout(timer); ok(); }
        }
      });
      child.once('exit', (code) => { clearTimeout(timer); fail(new Error(`server exited (${code}) before listening\n${lines.join('\n')}\n${stderr}`)); });
    });
  } catch (err) {
    await stop();
    throw err;
  }
  return { lines, port, dir, stderr: () => stderr, stop, terminate };
}

describe('single-tenant boot golden', () => {
  it('prints the golden boot lines and answers the golden bodies', async () => {
    const sc = await startScratch();
    try {
      const { port, dir, lines } = sc;
      const get = async (path: string) => { const r = await fetch(`http://127.0.0.1:${port}${path}`); return { status: r.status, body: await r.text() }; };
      const health = await get('/api/health');
      const check = await get('/api/auth/check');
      // Everything the server prints, to the end: a polite shutdown too (where the platform can deliver SIGTERM).
      const signalled = process.platform !== 'win32';
      if (signalled) await sc.terminate();

      const norm = (line: string) => slash(line)
        .split(slash(dir)).join('<TMP>').split(slash(projectRoot)).join('<ROOT>')
        .replace(`:${port}`, ':<PORT>')
        .replace(/••••[0-9a-f]{4}/, '••••<FP>')
        // Whether a frontend build sits in the checkout (and its id) depends on where the test runs, not on the server.
        .replace(/^(Serving frontend from: .*|No frontend build found .*)$/, '<FRONTEND>')
        .replace(/^Frontend build id: .*$/, 'Frontend build id: <ID>');
      // Windows cannot deliver SIGTERM to the child (kill ends it outright), so the shutdown tail is dropped from both sides there.
      const shutdownLine = (l: string) => /^(SIGTERM received|\[Orchestrator\] Stopping|Server closed)/.test(l);
      const actual = {
        lines: lines.filter((l) => signalled || !shutdownLine(l)).map(norm),
        stderr: sc.stderr().split(/\r?\n/).filter((l) => l && !/^\(node:\d+\) \[DEP\d+\]|^\(Use `node --trace-deprecation|^\(Use `node --trace-warnings/.test(l)).map(norm),
        // uptime and memory differ on every run: keep the shape and key order, zero the numbers.
        health: { status: health.status, body: health.body.replace(/-?\d+(\.\d+)?(e[+-]?\d+)?/gi, '0') },
        authCheck: check,
      };
      if (process.env.UPDATE_GOLDEN === '1') writeFileSync(goldenPath, JSON.stringify(actual, null, 2) + '\n');
      const golden = JSON.parse(readFileSync(goldenPath, 'utf8')) as typeof actual;
      if (!signalled) golden.lines = golden.lines.filter((l) => !shutdownLine(l));
      expect(actual).toEqual(golden);
    } finally {
      await sc.stop();
    }
  }, 90_000);
});

/** The process yaml of every scratch server in tenant mode (the standing rule: a scratch server never starts a model run): tenants.background_runs off, the orchestrator
 *  off (startScratch's own base yaml says so for both cases), handoff off, the dsh harness binary at /bin/false, no channel tokens (startScratch drops DISCORD_* and TELEGRAM_* from the child's
 *  environment, and no tenant .env here names one). `test-runtime.test.ts` requires every tenant-mode spawn of src/server.ts to carry these keys. */
const safeProcessYaml = (tenantsDir: string, extra: string[] = []): string[] => [
  'tenants:', `  dir: ${JSON.stringify(tenantsDir)}`, '  background_runs: false', '  auth: per-tenant', ...extra,
  'handoff:', '  enabled: false',
  'agent:', '  dsh:', '    command: /bin/false',
];

describe('tenant mode boot', () => {
  it('serves each tenant on its own host, refuses the rest, and starts nothing it should not', async () => {
    const tenants = mkdtempSync(join(tmpdir(), 'sanctum-boot-tenants-'));
    for (const [id, host, pw] of [['ada', 'ada.example.net', 'pw-ada-boot'], ['bea', 'bea.example.net', 'pw-bea-boot']]) {
      mkdirSync(join(tenants, id), { recursive: true });
      writeFileSync(join(tenants, id, 'tenant.yaml'), safeTenantYaml(`hosts: [${host}]\n`));
      writeFileSync(join(tenants, id, '.env'), `APP_PASSWORD=${pw}\n`);
    }
    // cal has no tenant.yaml at all: a valid tenant that boots from defaults plus .env and is the default host.
    mkdirSync(join(tenants, 'cal'), { recursive: true });
    writeFileSync(join(tenants, 'cal', '.env'), 'APP_PASSWORD=pw-cal-boot\n');
    const sc = await startScratch(safeProcessYaml(tenants, ['  default: cal']), '[tenancy] cal: login');
    try {
      const call = (method: string, path: string, host: string, body?: unknown, extra: Record<string, string> = {}) => new Promise<{ status: number; body: string; cookie: string }>((ok, fail) => {
        const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
        const req = httpRequest({ host: '127.0.0.1', port: sc.port, method, path, headers: { host, ...extra, ...(payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {}) } }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => ok({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), cookie: String(res.headers['set-cookie']?.[0] ?? '').split(';')[0] }));
        });
        req.on('error', fail);
        if (payload) req.write(payload);
        req.end();
      });
      const text = sc.lines.join('\n');
      expect(text).toContain('[tenancy] tenant ada: ada.example.net');
      expect(text).toContain('[tenancy] tenant bea: bea.example.net');
      // A tenant's own boot lines go to its tenant.log, not the process's output (pass 2).
      expect(text).not.toMatch(/\[Voice\]|\[identity\]|\[vector-cache\]/);
      expect(readFileSync(join(tenants, 'ada', 'data', 'logs', 'tenant.log'), 'utf8')).toContain('[Voice]');
      expect(text).toContain('[tenancy] tenant mode');
      expect(text).not.toContain('channels off');
      expect(text).not.toMatch(/Orchestrator|Discord|Telegram|outlook|handoff|Internal token|Auth enabled|setup code/i);
      expect(text).not.toContain('pw-ada-boot');
      expect(text).not.toContain('pw-bea-boot');
      expect(sc.stderr()).not.toMatch(/NoTenantContext/);

      expect((await call('GET', '/api/auth/check', 'ada.example.net')).body).toBe('{"authenticated":false}');
      expect((await call('POST', '/api/auth/login', 'ada.example.net', { password: 'pw-ada-boot' })).status).toBe(200);
      expect((await call('POST', '/api/auth/login', 'bea.example.net', { password: 'pw-ada-boot' })).status).toBe(401);
      // An unclaimed host goes to the default tenant, which has no tenant.yaml yet: the config routes still work and a PUT creates it.
      expect((await call('GET', '/api/auth/check', 'nobody.example.net')).status).toBe(200);
      const cal = await call('POST', '/api/auth/login', 'nobody.example.net', { password: 'pw-cal-boot' });
      expect(cal.status).toBe(200);
      expect((await call('GET', '/api/preferences', 'nobody.example.net', undefined, { cookie: cal.cookie })).status).toBe(200);
      expect((await call('GET', '/api/config/raw', 'nobody.example.net', undefined, { cookie: cal.cookie })).status).toBe(200);
      expect(existsSync(join(tenants, 'cal', 'tenant.yaml'))).toBe(false);
      expect((await call('PUT', '/api/config/raw', 'nobody.example.net', { content: 'identity:\n  companion_name: Cal\n' }, { cookie: cal.cookie })).status).toBe(200);
      expect(existsSync(join(tenants, 'cal', 'tenant.yaml'))).toBe(true);
      // Stage 4 lifted the 501: the wizard is live per tenant, and without a session or the tenant's setup code it answers 401.
      expect((await call('GET', '/api/setup/plan', 'ada.example.net')).status).toBe(401);
      expect((await call('POST', '/api/setup/apply', 'ada.example.net', {})).status).toBe(401);
      expect((await call('GET', '/api/health', 'bea.example.net')).status).toBe(200);

      const upgrade = await new Promise<string>((ok, fail) => {
        const req = httpRequest({ host: '127.0.0.1', port: sc.port, path: '/ws', headers: { host: 'ada.example.net', connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' } });
        req.on('upgrade', () => fail(new Error('upgrade was accepted')));
        req.on('response', (res) => { ok(String(res.statusCode)); res.resume(); });
        req.on('error', fail);
        req.end();
      });
      expect(upgrade).toBe('403'); // (was 503 before 3a: the socket is live per tenant; this upgrade carries no Origin, so it is refused at the origin check)

      // 3c: Discord, Telegram and the channels routes are live per tenant (the refused list is empty): swapped from 503 to the auth gate (401).
      for (const [m, path] of [['GET', '/api/discord/status'], ['GET', '/api/telegram/status'], ['GET', '/api/channels']]) {
        expect((await call(m, path, 'ada.example.net')).status, `${m} ${path}`).toBe(401);
      }
      // 3b: outlook, handoff, mind, orchestrator and home are live per tenant (swapped out of the refused list above): without a login they reach the auth gate.
      for (const [m, path] of [['GET', '/api/outlook'], ['POST', '/api/outlook/reauthor'], ['POST', '/api/handoff/run'], ['GET', '/api/orchestrator/status'], ['GET', '/api/mind/status'], ['GET', '/api/home/mantelpiece']]) {
        expect((await call(m, path, 'ada.example.net', m === 'POST' ? {} : undefined)).status, `${m} ${path}`).toBe(401);
      }

      // Findings 4 and 5: a tenant cannot edit its way outside its folder or into stopping the process.
      const { cookie } = await call('POST', '/api/auth/login', 'ada.example.net', { password: 'pw-ada-boot' });
      const put = (path: string, body: unknown) => call('PUT', path, 'ada.example.net', body, { cookie });
      const cfgRaw = await call('GET', '/api/config/raw', 'ada.example.net', undefined, { cookie });
      expect(cfgRaw.status).toBe(200);
      const original = JSON.parse(cfgRaw.body).content as string;
      expect((await put('/api/config/raw', { content: original.replace('bea.example.net', 'x') + `\nhosts: [bea.example.net]\n` })).status).toBe(400);
      expect((await put('/api/config/raw', { content: `hosts: [ada.example.net]\nagent:\n  cwd: ${JSON.stringify(join(tenants, 'bea', 'home'))}\n` })).status).toBe(400);
      expect((await put('/api/config/raw', { content: `hosts: [ada.example.net]\nidentity:\n  timezone: Pacific/Auckland\n` })).status).toBe(400);
      expect((await put('/api/preferences', { identity: { timezone: 'Pacific/Auckland' } })).status).toBe(400);
      expect((await put('/api/preferences', { hooks: { workspace_root: join(tenants, 'bea') } })).status).toBe(400);
      expect((await put('/api/preferences', { identity: { companion_name: 'Ada' } })).status).toBe(200);
      const roots = await call('GET', '/api/files/browse', 'ada.example.net', undefined, { cookie });
      expect(roots.body).not.toContain('bea');
      expect((await call('GET', `/api/files/browse?path=${encodeURIComponent(join(tenants, 'bea'))}`, 'ada.example.net', undefined, { cookie })).status).toBe(403);

      // Pass 3 #1 / pass 4 #1, swapped in 3c: the refused list is empty, so any spelling of these reaches the auth gate (never a 503, never a handler without a login).
      for (const path of ['/api/DISCORD', '/api/Discord/status', '/api/Channels', '/api/TELEGRAM/status']) {
        expect((await call('GET', path, 'ada.example.net')).status, path).toBe(401);
      }
      for (const path of ['/api//discord', '/api///channels', '/api//telegram/status', '/api/x/../discord/status']) {
        expect([400, 401, 404], path).toContain((await call('GET', path, 'ada.example.net')).status);
      }
      // Pass 3 #3(c): a config the tenant could not start with is refused when saved, not at the next restart.
      expect((await put('/api/config/raw', { content: 'hosts: [ada.example.net]\nagent: 5\n' })).status).toBe(400);
      // Pass 3 #7: a token holder cannot make the app read a file outside its tenant folder.
      const token = readFileSync(join(tenants, 'ada', 'data', '.internal-token'), 'utf8').trim();
      const viaToken = (path: string, body: unknown) => call('POST', path, 'ada.example.net', body, { 'x-internal-token': token });
      // The workspace MCP rides on the tenant's own Google connection (live per tenant since 3a: it answers for the token's tenant).
      expect((await viaToken('/mcp/workspace', { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(200);
      expect((await viaToken('/api/internal/share', { path: join(tenants, 'bea', 'data', 'sanctum.db') })).status).toBe(403);
      expect((await viaToken('/api/internal/canvas', { action: 'create', title: 't', filePath: join(tenants, 'bea', '.env') })).status).toBe(403);
      expect((await viaToken('/api/internal/share', { path: join(tenants, 'ada', 'home', 'missing.txt') })).status).toBe(404);
      // Pass 3 #6, swapped in 3b: the watchdog is per tenant now, so saving a Mind setting wakes THAT tenant's watchdog and it probes the URL just saved.
      let probed = false;
      let onProbe: () => void = () => {};
      const probeSeen = new Promise<void>((ok) => { onProbe = ok; });
      const sink = createServer2((_rq, rs) => { probed = true; onProbe(); rs.end('{}'); });
      await new Promise<void>((ok) => sink.listen(0, '127.0.0.1', () => ok()));
      try {
        const sinkUrl = `http://127.0.0.1:${(sink.address() as { port: number }).port}/mcp`;
        for (const [k, v] of [['mind.url', sinkUrl], ['mind.api_key', 'k'], ['mind.mind_id', 'mind-one'], ['mind.enabled', 'true']]) {
          await call('PUT', '/api/settings', 'ada.example.net', { key: k, value: v }, { cookie });
        }
        await Promise.race([probeSeen, new Promise((r) => setTimeout(r, 10_000))]); // resolves on the first probe; the timer only bounds a failure
        expect(probed).toBe(true);
      } finally { await new Promise<void>((ok) => sink.close(() => ok())); }

      // Finding 10: a handler that catches the "not per tenant" error still answers 503, and nothing prints a stack.
      expect((await call('POST', '/api/push/test', 'ada.example.net', {}, { cookie })).status).toBe(503); // (was /api/sessions: the agent is per tenant now, so that route answers 200)
      expect(sc.stderr()).not.toMatch(/\n\s+at /);

      // Finding 9: SIGTERM closes every tenant database and exits 0 (a signal is only deliverable off Windows).
      if (process.platform !== 'win32') {
        expect(await sc.terminate()).toBe(0);
        expect(sc.lines.join('\n')).toContain('Server closed');
        for (const id of ['ada', 'bea']) expect(existsSync(join(tenants, id, 'data', 'sanctum.db-wal'))).toBe(false);
        expect(sc.stderr()).not.toMatch(/Cannot read properties of null/);
      }
    } finally {
      await sc.stop();
      rmSync(tenants, { recursive: true, force: true });
    }
  }, 90_000);
});
