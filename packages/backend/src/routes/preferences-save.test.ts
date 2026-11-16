// Review fixes on the HTTP surface: PUT /api/preferences writes only keys that change the yaml layer, GET /api/settings redacts the Mind URL,
// and GET /api/models and /api/system/status report the effective chat model (not the yaml one).
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const h = vi.hoisted(() => ({ root: '', cfg: null as any }));
vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  h.root = mkdtempSync(join(tmpdir(), 'prefsave-'));
  const cfg = {
    identity: { user_name: 'Pat' },
    integrations: { browser_url: '', mind_cloud: { enabled: false, mcp_url: '', mind_id: '' } },
    server: { host: '127.0.0.1', port: 3099, db_path: ':memory:' }, auth: { password: '' }, agent: { model: 'file-model', model_autonomous: '' },
    discord: actual.normalizeDiscordConfig({}, '/srv/home', { warn: () => {} }),
  };
  h.cfg = cfg;
  return { ...actual, PROJECT_ROOT: h.root, getSanctumConfig: () => cfg };
});
vi.mock('../middleware/auth.js', async () => {
  const actual = await vi.importActual<typeof import('../middleware/auth.js')>('../middleware/auth.js');
  return { ...actual, authMiddleware: (_req: any, _res: any, next: () => void) => next() };
});

import router from './api.js';
import { initDb, setConfig } from '../services/db.js';
import { updateAuthPreferences } from '../services/auth-preferences.js';
import { registerProcessFile } from '../tenancy/context.js';
import { mergeConfigDefaults } from '../config.js';
import { appWriteGate } from '../middleware/app-write.js';
import yaml from 'js-yaml';

const YAML = 'identity:\n  companion_name: FromFile\nagent:\n  model: file-model\n  model_autonomous: ""\ndiscord:\n  enabled: false\n';
let server: Server;
let base = '';
const app = express();
app.use(express.json());
app.use('/api', router);
const file = () => join(h.root, 'sanctum.yaml');
const put = async (body: unknown): Promise<any> => (await fetch(`${base}/preferences`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
const get = async (path: string): Promise<any> => (await fetch(`${base}${path}`)).json();

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => r()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });
beforeEach(() => {
  initDb(':memory:');
  updateAuthPreferences({ auth_mode: 'subscription', api_key: null, preferred_model: null, preferred_model_autonomous: null });
  writeFileSync(file(), YAML);
  registerProcessFile(() => ({ identity: { companion_name: 'FromFile' }, agent: { model: 'file-model', model_autonomous: '' }, discord: { enabled: false } }));
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('PUT /api/preferences writes only what changes the yaml layer', () => {
  it('agent.model effective from the database: the same value posted back leaves the file byte-for-byte unchanged', async () => {
    updateAuthPreferences({ preferred_model: 'db-model' });
    const draft = (await get('/preferences'));
    expect(draft.agent.model).toBe('db-model');
    expect(draft.sources['agent.model']).toBe('db');
    const r = await put({ agent: { model: draft.agent.model, model_autonomous: draft.agent.model_autonomous }, identity: draft.identity, discord: draft.discord });
    expect(r.success).toBe(true);
    expect(r.written).toEqual([]);
    expect(readFileSync(file(), 'utf8')).toBe(YAML);
  });

  it('a different value is written to the file and listed in `written`', async () => {
    updateAuthPreferences({ preferred_model: 'db-model' });
    const r = await put({ agent: { model: 'typed-by-person' }, identity: { companion_name: 'FromFile' } });
    expect(r.written).toEqual(['agent.model']);
    const text = readFileSync(file(), 'utf8');
    expect(text).toContain('typed-by-person');
    expect(text).not.toContain('db-model');
  });

  it('a value that came from .env is not pinned into the file; a real change beside it is', async () => {
    vi.stubEnv('AGENT_MODEL', 'env-model');
    const r = await put({ agent: { model: 'env-model' }, identity: { companion_name: 'Renamed' } });
    expect(r.written).toEqual(['identity.companion_name']);
    const text = readFileSync(file(), 'utf8');
    expect(text).toContain('Renamed');
    expect(text).toContain('file-model');
    expect(text).not.toContain('env-model');
  });

  it('a default echoed back for a key the file lacks is not written (no new section appears)', async () => {
    const r = await put({ voice: { enabled: false, elevenlabs_voice_id: '' }, hooks: { extra_write_paths: [] }, agent: { app_write: true } });
    expect(r.written).toEqual([]);
    expect(readFileSync(file(), 'utf8')).toBe(YAML);
  });
});

describe('a yaml switch word is read the same by the runtime and by Settings', () => {
  it('agent.app_write: no -> GET shows false, the posted false has nothing to write, and the app-write gate answers 403', async () => {
    const yamlText = YAML.replace('agent:\n', 'agent:\n  app_write: no\n');
    writeFileSync(file(), yamlText);
    const parsed = yaml.load(yamlText) as Record<string, any>;
    expect(parsed.agent.app_write).toBe('no'); // js-yaml 1: a string
    registerProcessFile(() => parsed);
    const saved = h.cfg.agent;
    h.cfg.agent = { ...saved, app_write: mergeConfigDefaults(parsed).agent.app_write }; // what loadConfig hands the runtime
    try {
      expect(h.cfg.agent.app_write).toBe(false);
      expect((await get('/preferences')).agent.app_write).toBe(false);
      const r = await put({ agent: { app_write: false } });
      expect(r.success).toBe(true);
      expect(r.written).toEqual([]); // correct: the effective value is already false
      expect(readFileSync(file(), 'utf8')).toBe(yamlText);
      const gated = express();
      gated.post('/w', appWriteGate, (_req, res) => { res.json({ ok: true }); });
      const gs: Server = await new Promise((ok) => { const x = gated.listen(0, '127.0.0.1', () => ok(x)); });
      try {
        const res = await fetch(`http://127.0.0.1:${(gs.address() as AddressInfo).port}/w`, { method: 'POST' });
        expect(res.status).toBe(403);
        expect((await res.json()).error).toBe('app_write_off');
      } finally { await new Promise((ok) => gs.close(ok)); }
    } finally { h.cfg.agent = saved; }
  });
});

describe('GET /api/settings', () => {
  it('never returns the Mind URL raw: userinfo, path and query are redacted in effective', async () => {
    setConfig('mind.url', 'https://user:hunter2@mind.example.com/mcp/abc123?token=SECRETTOKEN');
    const body = await get('/settings'); // (body.config still carries the saved row itself: the Mind card edits it)
    const shown = body.effective['integrations.mind_cloud.mcp_url'] as string;
    expect(shown).toContain('mind.example.com');
    expect(shown).not.toContain('hunter2');
    expect(shown).not.toContain('SECRETTOKEN');
    expect(shown).not.toContain('user:');
    expect(JSON.stringify(body.effective)).not.toContain('hunter2');
    expect(JSON.stringify(body.effective)).not.toContain('SECRETTOKEN');
  });
});

describe('the effective chat model is reported, not the yaml value', () => {
  it('GET /api/models and /api/system/status follow the resolver (AGENT_MODEL, then a /model choice)', async () => {
    expect((await get('/models')).current).toBe('file-model');
    vi.stubEnv('AGENT_MODEL', 'env-model');
    expect((await get('/models')).current).toBe('env-model');
    updateAuthPreferences({ preferred_model: 'claude-chosen' });
    expect((await get('/models')).current).toBe('claude-chosen');
    expect((await get('/system/status')).agent.model).toBe('claude-chosen');
  });
});

describe('PUT /api/preferences: the summarizer and picture fields', () => {
  it('GET shows the registry defaults for both blocks', async () => {
    const g = await get('/preferences');
    expect(g.agent.summarizer).toEqual({ provider: '', model: '', base_url: '', api_key_env: 'SUMMARIZER_API_KEY' });
    expect(g.imagegen).toEqual({ provider: 'none', model: '', reference_model: '', size: '1024x1024', safety_checker: false });
  });

  it('writes only what changed: echoing the defaults leaves the file alone, a real change lands and is listed', async () => {
    const g = await get('/preferences');
    const echo = await put({ agent: { summarizer: g.agent.summarizer }, imagegen: g.imagegen });
    expect(echo.written).toEqual([]);
    expect(readFileSync(file(), 'utf8')).toBe(YAML);
    const r = await put({
      agent: { summarizer: { provider: 'openai-compat', model: 'm-1', base_url: 'https://example.test/v1', api_key_env: 'MY_KEY' } },
      imagegen: { provider: 'runware', size: '1024x1536', safety_checker: true },
    });
    expect(r.written.sort()).toEqual([
      'agent.summarizer.api_key_env', 'agent.summarizer.base_url', 'agent.summarizer.model', 'agent.summarizer.provider',
      'imagegen.provider', 'imagegen.safety_checker', 'imagegen.size',
    ]);
    const saved = yaml.load(readFileSync(file(), 'utf8')) as any;
    expect(saved.agent.summarizer.provider).toBe('openai-compat');
    expect(saved.imagegen.provider).toBe('runware');
  });

  it('reference_model round-trips, is trimmed, and echoing it back writes nothing', async () => {
    const r = await put({ imagegen: { reference_model: '  bfl:4@1 ' } });
    expect(r.written).toEqual(['imagegen.reference_model']);
    expect((yaml.load(readFileSync(file(), 'utf8')) as any).imagegen.reference_model).toBe('bfl:4@1');
    const g = await get('/preferences');
    expect(g.imagegen.reference_model).toBe('bfl:4@1');
    const echo = await put({ imagegen: g.imagegen });
    expect(echo.written).toEqual([]);
    const cleared = await put({ imagegen: { reference_model: '' } });
    expect(cleared.written).toEqual(['imagegen.reference_model']);
    expect((await get('/preferences')).imagegen.reference_model).toBe('');
  });

  it('refuses a bad provider, size, key-env name (a key pasted in its place) and non-boolean checker', async () => {
    for (const body of [
      { agent: { summarizer: { provider: 'gpt' } } },
      { agent: { summarizer: { api_key_env: 'sk-abc 123' } } },
      { imagegen: { provider: 'midjourney' } },
      { imagegen: { size: '10x10' } },
      { imagegen: { safety_checker: 'yes' } },
    ]) {
      const res = await fetch(`${base}/preferences`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(readFileSync(file(), 'utf8')).toBe(YAML);
  });
});

describe('api_key_env takes a variable NAME, never a key', () => {
  const tryPut = async (v: string) => {
    const res = await fetch(`${base}/preferences`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent: { summarizer: { api_key_env: v } } }) });
    return { status: res.status, body: await res.json() as any };
  };
  it('refuses the three probes (Groq, Replicate, 64-hex) and other key shapes with the NAME message, writing nothing', async () => {
    for (const v of ['gsk_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789', 'r8_AbCdEfGhIjKlMnOpQrStUvWxYz012345678', 'a'.repeat(16) + '0123456789abcdef'.repeat(3),
      'sk-abc', 'xai-AAAA', 'AIzaSyAAAA', 'ghp_AAAA', 'github_pat_AAAA', 'my_secret_variable', 'summarizer_api_key', '0123456789ABCDEF0123456789ABCDEF']) {
      const r = await tryPut(v);
      expect(r.status, v).toBe(400);
      expect(r.body.error, v).toContain('this field takes the NAME of the variable, e.g. SUMMARIZER_API_KEY, not the key itself');
    }
    expect(readFileSync(file(), 'utf8')).toBe(YAML);
  });
  it('accepts upper-case variable names and the empty string', async () => {
    for (const v of ['SUMMARIZER_API_KEY', 'OPENROUTER_API_KEY', 'K', '']) expect((await tryPut(v)).status, v).toBe(200);
  });
});

describe('PUT /api/preferences: the memory choice writes the right trio', () => {
  const saved = () => yaml.load(readFileSync(file(), 'utf8')) as any;
  it('reads as Revien when the file says nothing, and each choice writes revien.enabled, agent.harness_memory and agent.local_recall together', async () => {
    expect((await get('/preferences')).memory).toBe('revien');
    let r = await put({ memory: 'sanctum' });
    expect(r.written.sort()).toEqual(['agent.harness_memory', 'agent.local_recall', 'revien.enabled']);
    expect(saved().agent.local_recall).toBe(true);
    expect(saved().revien.enabled).toBe(false);
    expect((await get('/preferences')).memory).toBe('sanctum');
    r = await put({ memory: 'harness' });
    expect(saved().agent.harness_memory).toBe(true);
    expect(saved().agent.local_recall).toBeUndefined();
    expect((await get('/preferences')).memory).toBe('harness');
    await put({ memory: 'none' });
    expect(saved().revien.enabled).toBe(false);
    expect(saved().agent.harness_memory).toBe(false);
    expect((await get('/preferences')).memory).toBe('none');
    await put({ memory: 'revien' });
    expect(saved().revien.enabled).toBe(true);
    expect((await get('/preferences')).memory).toBe('revien');
  });
  it('a mixed file (Revien on beside harness memory) reads as harness, says so, and posting harness normalises it', async () => {
    const doc = yaml.load(readFileSync(file(), 'utf8')) as any;
    doc.revien = { enabled: true };
    doc.agent = { ...(doc.agent || {}), harness_memory: true };
    writeFileSync(file(), yaml.dump(doc));
    const g = await get('/preferences');
    expect(g.memory).toBe('harness');
    expect(g.memory_mixed).toBe(true);
    const r = await put({ memory: 'harness' });
    expect(r.written).toContain('revien.enabled');
    expect(saved().revien.enabled).toBe(false);
    expect(saved().agent.harness_memory).toBe(true);
    expect((await get('/preferences')).memory_mixed).toBe(false);
    expect((await put({ memory: 'harness' })).written).toEqual([]);
  });
  it('on dsh, a file with harness memory on reads as the system that is really running (dsh has no harness memory), never as harness', async () => {
    const doc = yaml.load(readFileSync(file(), 'utf8')) as any;
    doc.revien = { enabled: false };
    doc.agent = { ...(doc.agent || {}), provider: 'dsh', harness_memory: true };
    writeFileSync(file(), yaml.dump(doc));
    const g = await get('/preferences');
    expect(g.memory).toBe('none');
    expect(g.memory_mixed).toBe(true);
  });
  it('posting back the choice it was shown writes nothing; an unknown choice is a 400', async () => {
    const r = await put({ memory: 'revien' });
    expect(r.written).toEqual([]);
    const bad = await fetch(`${base}/preferences`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ memory: 'own' }) });
    expect(bad.status).toBe(400);
  });
});
