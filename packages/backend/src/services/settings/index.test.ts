// The settings service: one rule (default < sanctum.yaml < .env < SQLite) for every key family in the registry.
// Layers: a real in-memory database (KV and the typed tables), env through vi.stubEnv, and the yaml either handed in (opts.yaml) or loaded for real.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('../embeddings.js', () => ({ embed: vi.fn().mockResolvedValue(new Float32Array(384)), vectorToBuffer: vi.fn().mockReturnValue(Buffer.alloc(384 * 4)) }));
vi.mock('../vector-cache.js', () => ({ cacheEmbedding: vi.fn(), removeEmbedding: vi.fn() }));

import { loadConfig, mergeConfigDefaults, getSanctumConfig } from '../../config.js';
import { initDb, setConfig } from '../db.js';
import { updateAuthPreferences } from '../auth-preferences.js';
import { saveBotToken } from '../bot-token.js';
import { setConfig as setGoogleCreds } from '../google-auth.js';
import { REGISTRY, STATIC_KEYS, PREFERENCE_KEYS, lookupKey, resolveSetting, resolveSecret, resolveAll } from './index.js';

const dir = mkdtempSync(join(tmpdir(), 'settings-'));
const mcpPath = join(dir, 'mcp.json');
const cfgPath = join(dir, 'sanctum.yaml');
writeFileSync(cfgPath, 'identity:\n  companion_name: FromYaml\nagent:\n  mcp_json_path: ' + JSON.stringify(mcpPath) + '\nhandoff:\n  enabled: true\n');

beforeAll(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  loadConfig(cfgPath);
});
beforeEach(() => {
  initDb(':memory:');
  updateAuthPreferences({ auth_mode: 'subscription', api_key: null, preferred_model: null, preferred_model_autonomous: null }); // (the preferences cache outlives a fresh database)
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('registry', () => {
  it('lists the 39 keys PUT /api/preferences writes, the imagegen keys and every key family of the precedence map', () => {
    expect(PREFERENCE_KEYS).toHaveLength(39);
    for (const k of PREFERENCE_KEYS) expect(lookupKey(k), k).not.toBeNull();
    for (const k of ['imagegen.provider', 'imagegen.model', 'imagegen.size', 'imagegen.safety_checker', 'imagegen.timeout_ms', 'imagegen.runware_api_key', 'imagegen.replicate_api_token',
      'discord.enabled', 'telegram.enabled', 'handoff.enabled', 'failsafe.enabled', 'failsafe.gentle', 'pulse.enabled', 'pulse.frequency', 'cron.morning.schedule', 'cron.morning.enabled', 'cron.morning.model', 'cron.morning.target',
      'mind.enabled', 'mind.url', 'mind.mind_id', 'mind.api_key', 'discord.bot_token', 'telegram.bot_token', 'google.client_id', 'google.client_secret', 'auth.password', 'agent.model', 'agent.model_autonomous', 'agent.provider']) {
      expect(lookupKey(k), k).not.toBeNull();
    }
    expect(REGISTRY.length).toBeGreaterThan(60);
  });

  it('every default equals the default config.ts ships', () => {
    const shipped = mergeConfigDefaults({}) as unknown as Record<string, unknown>;
    const at = (path: string) => path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], shipped);
    for (const def of STATIC_KEYS) {
      if (!def.yaml || def.key === 'agent.model_autonomous') continue;
      if (def.yaml === 'agent.rolling.dsh' || at(def.yaml) !== undefined) expect(def.default, def.key).toEqual(at(def.yaml) ?? def.default);
    }
  });

  it('an alias and the canonical name are one entry', () => {
    expect(lookupKey('mind.enabled')!.def).toBe(lookupKey('integrations.mind_cloud.enabled')!.def);
    expect(lookupKey('failsafe.gentle')!.def.key).toBe('orchestrator.failsafe.gentle_minutes');
    expect(lookupKey('cron.some_type.schedule')!.params).toEqual({ type: 'some_type' });
  });
});

describe('the rule: default < yaml < env < db', () => {
  it('discord.enabled: KV=false, env=true, yaml=true -> false from db', () => {
    vi.stubEnv('DISCORD_ENABLED', 'true');
    setConfig('discord.enabled', 'false');
    const r = resolveSetting('discord.enabled', { yaml: { discord: { enabled: true } } });
    expect(r.value).toBe(false);
    expect(r.source).toBe('db');
    expect(r.candidates.map((c) => c.source)).toEqual(['default', 'yaml', 'env', 'db']);
  });

  it('discord.enabled / telegram.enabled: env beats yaml, yaml beats default, and an env of "false" is ignored (as it always was)', () => {
    for (const k of ['discord', 'telegram']) {
      const name = `${k}.enabled`;
      expect(resolveSetting(name, { yaml: {} }).source).toBe('default');
      expect(resolveSetting(name, { yaml: { [k]: { enabled: true } } })).toMatchObject({ value: true, source: 'yaml' });
      vi.stubEnv(`${k.toUpperCase()}_ENABLED`, 'false');
      expect(resolveSetting(name, { yaml: { [k]: { enabled: true } } })).toMatchObject({ value: true, source: 'yaml' });
      vi.stubEnv(`${k.toUpperCase()}_ENABLED`, 'true');
      expect(resolveSetting(name, { yaml: { [k]: { enabled: false } } })).toMatchObject({ value: true, source: 'env' });
      setConfig(name, 'false');
      expect(resolveSetting(name, { yaml: { [k]: { enabled: false } } })).toMatchObject({ value: false, source: 'db' });
    }
  });

  it('handoff.enabled: db > yaml > default; no env twin (a stray HANDOFF_ENABLED is nothing)', () => {
    vi.stubEnv('HANDOFF_ENABLED', 'true');
    expect(resolveSetting('handoff.enabled', { yaml: {} })).toMatchObject({ value: false, source: 'default' });
    expect(resolveSetting('handoff.enabled', { yaml: { handoff: { enabled: true } } })).toMatchObject({ value: true, source: 'yaml' });
    setConfig('handoff.enabled', '0');
    expect(resolveSetting('handoff.enabled', { yaml: { handoff: { enabled: true } } })).toMatchObject({ value: false, source: 'db' });
  });

  it('failsafe.*: KV row names differ from the yaml path; yaml 0 counts as unset; a junk KV row falls through', () => {
    const y = { orchestrator: { failsafe: { enabled: true, gentle_minutes: 30, concerned_minutes: 0 } } };
    expect(resolveSetting('failsafe.enabled', { yaml: y })).toMatchObject({ value: true, source: 'yaml' });
    expect(resolveSetting('failsafe.gentle', { yaml: y })).toMatchObject({ value: 30, source: 'yaml' });
    expect(resolveSetting('failsafe.concerned', { yaml: y })).toMatchObject({ value: 720, source: 'default' });
    setConfig('failsafe.gentle', '45');
    setConfig('failsafe.emergency', 'junk');
    setConfig('failsafe.enabled', 'false');
    expect(resolveSetting('failsafe.gentle', { yaml: y })).toMatchObject({ value: 45, source: 'db' });
    expect(resolveSetting('orchestrator.failsafe.emergency_minutes', { yaml: y })).toMatchObject({ value: 1440, source: 'default' });
    expect(resolveSetting('orchestrator.failsafe.enabled', { yaml: y })).toMatchObject({ value: false, source: 'db' });
  });

  it('pulse.*: db only, then the default', () => {
    expect(resolveSetting('pulse.enabled')).toMatchObject({ value: false, source: 'default' });
    expect(resolveSetting('pulse.frequency')).toMatchObject({ value: 15, source: 'default' });
    setConfig('pulse.enabled', 'true');
    setConfig('pulse.frequency', '5');
    expect(resolveSetting('pulse.enabled')).toMatchObject({ value: true, source: 'db' });
    expect(resolveSetting('pulse.frequency')).toMatchObject({ value: 5, source: 'db' });
  });

  it('cron.<type>: schedule is built-in < yaml orchestrator.schedules < KV; enabled/model/target are db only', () => {
    const y = { orchestrator: { schedules: { morning: '0 7 * * *' } } };
    expect(resolveSetting('cron.evening.schedule', { yaml: y, default: '0 20 * * *' })).toMatchObject({ value: '0 20 * * *', source: 'default' });
    expect(resolveSetting('cron.morning.schedule', { yaml: y, default: '0 9 * * *' })).toMatchObject({ value: '0 7 * * *', source: 'yaml' });
    setConfig('cron.morning.schedule', '30 6 * * *');
    expect(resolveSetting('cron.morning.schedule', { yaml: y, default: '0 9 * * *' })).toMatchObject({ value: '30 6 * * *', source: 'db' });
    expect(resolveSetting('cron.morning.schedule', { yaml: y, default: '0 9 * * *', skip: ['yaml'] }).value).toBe('30 6 * * *');
    expect(resolveSetting('cron.morning.enabled').value).toBe(true);
    setConfig('cron.morning.enabled', 'false');
    setConfig('cron.morning.model', 'claude-x');
    expect(resolveSetting('cron.morning.enabled')).toMatchObject({ value: false, source: 'db' });
    expect(resolveSetting('cron.morning.model')).toMatchObject({ value: 'claude-x', source: 'db' });
    expect(resolveSetting('cron.morning.target')).toMatchObject({ value: '', source: 'default' });
  });

  it('identity and agent.provider: env beats yaml; an invalid AGENT_PROVIDER is ignored', () => {
    vi.stubEnv('COMPANION_NAME', 'FromEnv');
    expect(resolveSetting('identity.companion_name', { yaml: { identity: { companion_name: 'Y' } } })).toMatchObject({ value: 'FromEnv', source: 'env' });
    vi.stubEnv('AGENT_PROVIDER', 'bogus');
    expect(resolveSetting('agent.provider', { yaml: { agent: { provider: 'codex' } } })).toMatchObject({ value: 'codex', source: 'yaml' });
    vi.stubEnv('AGENT_PROVIDER', 'dsh');
    expect(resolveSetting('agent.provider', { yaml: { agent: { provider: 'codex' } } })).toMatchObject({ value: 'dsh', source: 'env' });
  });

  it('agent.model: db(auth_preferences) > env > yaml > default (a KV agent.model row is not a layer); agent.model_autonomous follows the file/env model, not the db one', () => {
    const y = { agent: { model: 'yaml-model' } };
    expect(resolveSetting('agent.model', { yaml: y })).toMatchObject({ value: 'yaml-model', source: 'yaml' });
    vi.stubEnv('AGENT_MODEL', 'env-model');
    expect(resolveSetting('agent.model', { yaml: y })).toMatchObject({ value: 'env-model', source: 'env' });
    expect(resolveSetting('agent.model_autonomous', { yaml: y })).toMatchObject({ value: 'env-model', source: 'default' });
    setConfig('agent.model', 'kv-model'); // the row /model used to write: ignored
    expect(resolveSetting('agent.model', { yaml: y })).toMatchObject({ value: 'env-model', source: 'env' });
    updateAuthPreferences({ preferred_model: 'pref-model', preferred_model_autonomous: 'pref-auto' });
    const r = resolveSetting('agent.model', { yaml: y });
    expect(r).toMatchObject({ value: 'pref-model', source: 'db' });
    expect(r.candidates.map((c) => c.via)).toEqual([undefined, 'agent.model', 'AGENT_MODEL', 'auth_preferences.preferred_model']);
    expect(resolveSetting('agent.model_autonomous', { yaml: y })).toMatchObject({ value: 'pref-auto', source: 'db' });
    // the follow rule leaves the db preferred_model out
    updateAuthPreferences({ preferred_model_autonomous: null });
    expect(resolveSetting('agent.model_autonomous', { yaml: y }).value).toBe('env-model');
  });

  it('mind.*: db > yaml > .mcp.json for the URL; db > env > .mcp.json for the key; the key pairs with the URL in effect', () => {
    const y = { integrations: { mind_cloud: { enabled: true, mcp_url: 'https://yaml.example/mcp', mind_id: 'yaml-id' } } };
    writeFileSync(mcpPath, JSON.stringify({ mcpServers: { 'sanctum-mind': { url: 'https://file.example/mcp', headers: { Authorization: 'Bearer FILE-KEY' } } } }));
    expect(resolveSetting('mind.url', { yaml: {} })).toMatchObject({ value: 'https://file.example/mcp', source: 'mcp_json' });
    expect(resolveSecret('mind.api_key', { yaml: {} })).toBe('FILE-KEY');
    expect(resolveSetting('mind.api_key', { yaml: {} }).value).toEqual({ set: true, source: 'mcp_json' });
    expect(resolveSetting('mind.url', { yaml: y })).toMatchObject({ value: 'https://yaml.example/mcp', source: 'yaml' });
    expect(resolveSecret('mind.api_key', { yaml: y })).toBeNull(); // the file's bearer belongs to the file's URL
    vi.stubEnv('MIND_API_KEY', 'ENV-KEY');
    expect(resolveSecret('mind.api_key', { yaml: y })).toBe('ENV-KEY');
    setConfig('mind.api_key', 'DB-KEY');
    expect(resolveSecret('mind.api_key', { yaml: y })).toBe('DB-KEY');
    expect(resolveSetting('mind.api_key', { yaml: y }).value).toEqual({ set: true, source: 'db' });
    setConfig('mind.url', 'https://card.example');
    setConfig('mind.enabled', 'false');
    setConfig('mind.mind_id', 'card-id');
    expect(resolveSetting('mind.url', { yaml: y })).toMatchObject({ value: 'https://card.example', source: 'db' });
    expect(resolveSetting('integrations.mind_cloud.enabled', { yaml: y })).toMatchObject({ value: false, source: 'db' });
    expect(resolveSetting('mind.mind_id', { yaml: y })).toMatchObject({ value: 'card-id', source: 'db' });
  });

  it('telegram.owner_chat_id: the KV row the bot saved beats the yaml value', () => {
    expect(resolveSetting('telegram.owner_chat_id', { yaml: { telegram: { owner_chat_id: '11' } } })).toMatchObject({ value: '11', source: 'yaml' });
    setConfig('telegram.ownerChatId', '22');
    expect(resolveSetting('telegram.owner_chat_id', { yaml: { telegram: { owner_chat_id: '11' } } })).toMatchObject({ value: '22', source: 'db' });
  });

  it('a yaml loaded for real names its layer (default / yaml) with no file handed in', () => {
    expect(resolveSetting('identity.companion_name')).toMatchObject({ value: 'FromYaml', source: 'yaml' });
    expect(resolveSetting('handoff.enabled')).toMatchObject({ value: true, source: 'yaml' });
    expect(resolveSetting('identity.user_name')).toMatchObject({ value: 'User', source: 'default' });
    vi.stubEnv('COMPANION_NAME', 'E');
    expect(resolveSetting('identity.companion_name').source).toBe('env');
  });

  it('a path-resolved key (hooks.workspace_root) reads the merged config, and the file handed in when it says something', () => {
    expect(resolveSetting('hooks.workspace_root')).toMatchObject({ value: '', source: 'default' });
    expect(resolveSetting('hooks.workspace_root', { yaml: { hooks: { workspace_root: '/w' } } })).toMatchObject({ value: '/w', source: 'yaml' });
    vi.stubEnv('WORKSPACE_ROOT', '/e');
    expect(resolveSetting('hooks.workspace_root', { yaml: { hooks: { workspace_root: '/w' } } })).toMatchObject({ value: '/e', source: 'env' });
  });
});

describe('secrets', () => {
  it('bot tokens: the stored row beats the env var; resolveSetting never returns the value', () => {
    vi.stubEnv('DISCORD_BOT_TOKEN', 'ENV-TOKEN-1');
    expect(resolveSecret('discord.bot_token')).toBe('ENV-TOKEN-1');
    expect(resolveSetting('discord.bot_token').value).toEqual({ set: true, source: 'env' });
    saveBotToken('discord', 'DB-TOKEN-2');
    expect(resolveSecret('discord.bot_token')).toBe('DB-TOKEN-2');
    const r = resolveSetting('discord.bot_token');
    expect(r.value).toEqual({ set: true, source: 'db' });
    expect(JSON.stringify(r)).not.toMatch(/TOKEN-[12]/);
    expect(resolveSetting('telegram.bot_token').value).toEqual({ set: false, source: 'default' });
    expect(resolveSecret('telegram.bot_token')).toBeNull();
  });

  it('google client: the pair saved in Settings beats env, env beats yaml, per field', () => {
    const y = { google: { client_id: 'yaml-id', client_secret: 'yaml-secret' } };
    expect(resolveSetting('google.client_id', { yaml: y })).toMatchObject({ value: 'yaml-id', source: 'yaml' });
    vi.stubEnv('GOOGLE_CLIENT_ID', 'env-id');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', 'env-secret');
    expect(resolveSecret('google.client_secret', { yaml: y })).toBe('env-secret');
    setGoogleCreds('db-id', 'db-secret');
    expect(resolveSetting('google.client_id', { yaml: y })).toMatchObject({ value: 'db-id', source: 'db' });
    expect(resolveSecret('google.client_secret', { yaml: y })).toBe('db-secret');
    const r = resolveSetting('google.client_secret', { yaml: y });
    expect(r.value).toEqual({ set: true, source: 'db' });
    expect(JSON.stringify(r)).not.toMatch(/db-secret|env-secret|yaml-secret/);
  });

  it('auth.password and the Anthropic key are markers; the api key lives in auth_preferences', () => {
    const r = resolveSetting('auth.password', { yaml: { auth: { password: 'hunter2-yaml' } } });
    expect(r.value).toEqual({ set: true, source: 'yaml' });
    expect(JSON.stringify(r)).not.toContain('hunter2');
    expect(resolveSetting('auth.anthropic_api_key').value).toEqual({ set: false, source: 'default' });
    updateAuthPreferences({ auth_mode: 'api_key', api_key: 'sk-ant-secretvalue' });
    const k = resolveSetting('auth.anthropic_api_key');
    expect(k.value).toEqual({ set: true, source: 'db' });
    expect(JSON.stringify(k)).not.toContain('secretvalue');
    expect(resolveSecret('auth.anthropic_api_key')).toBe('sk-ant-secretvalue');
    expect(resolveSetting('auth.mode')).toMatchObject({ value: 'api_key', source: 'db' });
  });

  it('env-only image keys are secrets too; resolveSecret refuses a key that is not one', () => {
    vi.stubEnv('RUNWARE_API_KEY', 'rw-123456');
    const r = resolveSetting('imagegen.runware_api_key');
    expect(r.value).toEqual({ set: true, source: 'env' });
    expect(JSON.stringify(r)).not.toContain('rw-123456');
    expect(() => resolveSecret('discord.enabled')).toThrow();
  });

  it('resolveAll gives markers for every secret and a source for every fixed key', () => {
    vi.stubEnv('REPLICATE_API_TOKEN', 'r8_zzz');
    const { effective, sources } = resolveAll();
    expect(Object.keys(sources).sort()).toEqual(STATIC_KEYS.map((k) => k.key).sort());
    expect(JSON.stringify(effective)).not.toContain('r8_zzz');
    expect(effective['imagegen.replicate_api_token']).toEqual({ set: true, source: 'env' });
  });
});

describe('keys outside the registry', () => {
  it('fall through to getSanctumConfig() unchanged', () => {
    const r = resolveSetting('server.host');
    expect(r.registered).toBe(false);
    expect(r.value).toBe(getSanctumConfig().server.host);
    expect(resolveSetting('plugins.trust').value).toBe(getSanctumConfig().plugins.trust);
    expect(resolveSetting('nope.nothing')).toMatchObject({ registered: false, value: undefined, source: 'default' });
    // a KV row of the same name does not matter to an unlisted key
    setConfig('server.host', 'elsewhere');
    expect(resolveSetting('server.host').value).toBe(getSanctumConfig().server.host);
  });
});
