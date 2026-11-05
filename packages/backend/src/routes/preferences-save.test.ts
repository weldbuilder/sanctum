// Review fixes on the HTTP surface: PUT /api/preferences writes only keys that change the yaml layer, GET /api/settings redacts the Mind URL,
// and GET /api/models and /api/system/status report the effective chat model (not the yaml one).
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const h = vi.hoisted(() => ({ root: '' }));
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
