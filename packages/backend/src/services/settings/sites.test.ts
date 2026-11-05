// One test per site that used to carry its own precedence, each proving the winner it always had (DB > env > yaml wherever a DB row exists),
// now through the settings service. Real config (a yaml loaded from a temp folder), real in-memory database, env through vi.stubEnv.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('../embeddings.js', () => ({ embed: vi.fn().mockResolvedValue(new Float32Array(384)), vectorToBuffer: vi.fn().mockReturnValue(Buffer.alloc(384 * 4)) }));
vi.mock('../vector-cache.js', () => ({ cacheEmbedding: vi.fn(), removeEmbedding: vi.fn() }));
vi.mock('../agent.js', () => ({ AgentService: vi.fn(), isInteractiveAgentBusy: () => false }));
vi.mock('../push.js', () => ({}));
vi.mock('../ws.js', () => ({ registry: { getCount: vi.fn().mockReturnValue(0), broadcast: vi.fn() } }));
vi.mock('../hooks.js', () => ({ fetchLifeStatus: vi.fn().mockResolvedValue('') }));
vi.mock('../digest.js', () => ({ runDigest: vi.fn() }));
vi.mock('../rolling-watch.js', () => ({ rollingWatch: vi.fn() }));

import { loadConfig } from '../../config.js';
import { initDb, setConfig } from '../db.js';
import { updateAuthPreferences, effectiveModel } from '../auth-preferences.js';
import { getBotToken, hasBotToken, saveBotToken } from '../bot-token.js';
import { setConfig as setGoogleCreds, startAuth, isConfigured } from '../google-auth.js';
import { isHandoffEnabled } from '../handoff.js';
import { Orchestrator } from '../orchestrator.js';
import { describeMindSettings, describeMindSettingsFrom, mindKeyInfo, mindUrlInfo, savedMindId } from '../mind-client.js';
import { getTelegramConfig } from '../telegram/config.js';
import { handleCommand } from '../commands.js';

const dir = mkdtempSync(join(tmpdir(), 'sites-'));
const mcpPath = join(dir, 'mcp.json');
writeFileSync(join(dir, 'sanctum.yaml'), [
  'identity: { timezone: UTC }',
  `agent: { model: yaml-model, mcp_json_path: ${JSON.stringify(mcpPath)} }`,
  `orchestrator: { wake_prompts_path: ${JSON.stringify(join(dir, 'wake.md'))}, wake_prompts_dir: ${JSON.stringify(join(dir, 'wakes'))}, failsafe: { enabled: true, gentle_minutes: 30 }, schedules: { morning: "0 7 * * *" } }`,
  'handoff: { enabled: true }',
  'telegram: { owner_chat_id: "yaml-chat" }',
  'google: { client_id: yaml-gid, client_secret: yaml-gsecret }',
  'integrations: { mind_cloud: { enabled: true, mcp_url: "https://yaml.example/mcp", mind_id: yaml-id } }',
].join('\n'));

beforeAll(() => { vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {}); loadConfig(join(dir, 'sanctum.yaml')); });
beforeEach(() => {
  initDb(':memory:'); writeFileSync(mcpPath, '{}');
  updateAuthPreferences({ auth_mode: 'subscription', api_key: null, preferred_model: null, preferred_model_autonomous: null }); // (the preferences cache outlives a fresh database)
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('handoff.js isHandoffEnabled (was KV, else yaml)', () => {
  it('yaml true with no row is on; a row of false wins; a row of true wins over nothing', () => {
    expect(isHandoffEnabled()).toBe(true);
    setConfig('handoff.enabled', 'false');
    expect(isHandoffEnabled()).toBe(false);
    setConfig('handoff.enabled', '1');
    expect(isHandoffEnabled()).toBe(true);
  });
});

describe('orchestrator.js start() (failsafe, pulse, cron)', () => {
  const started = (): Orchestrator => { const o = new Orchestrator({} as never, {} as never); o.start(); return o; };

  it('failsafe: yaml values, then KV rows beat them', () => {
    let o = started();
    expect(o.getFailsafeConfig()).toEqual({ enabled: true, gentle: 30, concerned: 720, emergency: 1440 });
    o.stop();
    setConfig('failsafe.enabled', 'false'); setConfig('failsafe.gentle', '10'); setConfig('failsafe.emergency', '999');
    o = started();
    expect(o.getFailsafeConfig()).toEqual({ enabled: false, gentle: 10, concerned: 720, emergency: 999 });
    o.stop();
  });

  it('pulse: default, then KV', () => {
    let o = started();
    expect(o.getPulseConfig()).toEqual({ enabled: false, frequency: 15 });
    o.stop();
    setConfig('pulse.enabled', 'true'); setConfig('pulse.frequency', '3');
    o = started();
    expect(o.getPulseConfig()).toEqual({ enabled: true, frequency: 3 });
    o.stop();
  });

  it('cron: built-in < yaml orchestrator.schedules < KV schedule; enabled and model from KV', async () => {
    let o = started();
    let st = await o.getStatus();
    const row = (t: string) => st.find((s: any) => s.wakeType === t) as any;
    expect(row('morning').cronExpr).toBe('0 7 * * *');        // yaml over the built-in
    const builtIn = row('evening')?.cronExpr;                  // untouched: the built-in
    expect(typeof builtIn).toBe('string');
    o.stop();
    setConfig('cron.morning.schedule', '15 6 * * *');
    setConfig('cron.morning.enabled', 'false');
    setConfig('cron.morning.model', 'cron-model');
    o = started();
    st = await o.getStatus();
    expect(row('morning')).toMatchObject({ cronExpr: '15 6 * * *', enabled: false, model: 'cron-model' });
    expect(row('evening').cronExpr).toBe(builtIn);
    o.stop();
  });
});

describe('mind-client.js (card > yaml > .mcp.json for the URL; card > MIND_API_KEY > .mcp.json for the key)', () => {
  const mcp = (url: string, bearer: string) => writeFileSync(mcpPath, JSON.stringify({ mcpServers: { 'sanctum-mind': { url, headers: { Authorization: `Bearer ${bearer}` } } } }));

  it('url: the card beats yaml; with neither, the .mcp.json entry (and then its own bearer)', () => {
    mcp('https://file.example/mcp', 'FILE');
    expect(mindUrlInfo()).toEqual({ source: 'yaml', url: 'https://yaml.example/mcp' });
    setConfig('mind.url', 'https://card.example/mcp');
    setConfig('mind.api_key', 'CARD-KEY-0123456789');
    expect(mindUrlInfo()).toEqual({ source: 'settings', url: 'https://card.example/mcp' });
    expect(describeMindSettings().settings?.root).toBe('https://card.example');
  });

  it('key: the card beats MIND_API_KEY, which beats the .mcp.json bearer (only when no card or yaml URL is in effect)', () => {
    mcp('https://file.example/mcp', 'FILE-KEY-0123456789');
    vi.stubEnv('MIND_API_KEY', 'ENV-KEY-0123456789');
    expect(mindKeyInfo().source).toBe('environment');
    expect(describeMindSettings()).toMatchObject({ enabled: true, settings: { bearer: 'ENV-KEY-0123456789', mindId: 'yaml-id' }, keySource: 'environment' });
    setConfig('mind.api_key', 'CARD-KEY-0123456789');
    expect(describeMindSettings().settings?.bearer).toBe('CARD-KEY-0123456789');
    expect(mindKeyInfo().source).toBe('settings');
    // the yaml-less pairing: the file's bearer goes with the file's URL
    const noUrl = describeMindSettingsFrom({ read: () => '', yaml: { enabled: true, mind_id: 'x' }, mcpJsonPath: mcpPath, env: {} });
    expect(noUrl.settings).toMatchObject({ root: 'https://file.example', bearer: 'FILE-KEY-0123456789', mindId: 'x' });
    expect(noUrl.keySource).toBe('mcp_json');
    const withYaml = describeMindSettingsFrom({ read: () => '', yaml: { enabled: true, mcp_url: 'https://y.example', mind_id: 'x' }, mcpJsonPath: mcpPath, env: {} });
    expect(withYaml.missing).toContain('api key');
  });

  it('enabled and mind_id: the card beats yaml', () => {
    expect(describeMindSettings().enabled).toBe(true);
    setConfig('mind.enabled', 'false');
    expect(describeMindSettings().enabled).toBe(false);
    expect(savedMindId()).toBe('yaml-id');
    setConfig('mind.mind_id', 'card-id');
    expect(savedMindId()).toBe('card-id');
  });
});

describe('bot-token.js (stored row, then the env var)', () => {
  it('is the same winner as before, and has/get agree', () => {
    expect(hasBotToken('telegram')).toBe(false);
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'env-tg');
    expect(getBotToken('telegram')).toBe('env-tg');
    saveBotToken('telegram', 'db-tg');
    expect(getBotToken('telegram')).toBe('db-tg');
    setConfig('telegram.botToken', 'not-a-valid-ciphertext'); // a blob that no longer decrypts is no row
    expect(getBotToken('telegram')).toBe('env-tg');
  });
});

describe('google-auth.js (the saved pair, then env, then yaml)', () => {
  const clientId = () => new URL(startAuth().url).searchParams.get('client_id');
  it('picks the same client', () => {
    expect(isConfigured()).toBe(true);
    expect(clientId()).toBe('yaml-gid');
    vi.stubEnv('GOOGLE_CLIENT_ID', 'env-gid');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', 'env-gsecret');
    expect(clientId()).toBe('env-gid');
    setGoogleCreds('db-gid', 'db-gsecret');
    expect(clientId()).toBe('db-gid');
  });
});

describe('auth-preferences.js effectiveModel and the /model command (the model chain, minus threads.model and modelOverride, which stay above)', () => {
  it('interactive: preferred_model > KV agent.model > AGENT_MODEL > yaml', () => {
    expect(effectiveModel('interactive', 'fallback')).toBe('yaml-model');
    vi.stubEnv('AGENT_MODEL', 'env-model');
    expect(effectiveModel('interactive', 'fallback')).toBe('env-model');
    setConfig('agent.model', 'kv-model');
    expect(effectiveModel('interactive', 'fallback')).toBe('kv-model');
    updateAuthPreferences({ preferred_model: 'pref-model' });
    expect(effectiveModel('interactive', 'fallback')).toBe('pref-model');
  });

  it('autonomous: preferred_model_autonomous, else the yaml/env model_autonomous, which is empty and follows agent.model', () => {
    expect(effectiveModel('autonomous', 'fallback')).toBe('yaml-model');
    updateAuthPreferences({ preferred_model_autonomous: 'pref-auto' });
    expect(effectiveModel('autonomous', 'fallback')).toBe('pref-auto');
  });

  it('/model writes the KV row, and now takes effect; it says so when something above still wins', async () => {
    const run = async (arg?: string) => ((await handleCommand('model', arg, undefined, { agent: {} as never, registry: {} as never })) as any).data.message as string;
    expect(await run()).toBe('Current model: yaml-model');
    expect(await run('claude-new')).toBe('Model switched to claude-new');
    expect(effectiveModel('interactive', 'x')).toBe('claude-new');
    expect(await run()).toBe('Current model: claude-new');
    updateAuthPreferences({ preferred_model: 'pinned' });
    expect(await run('claude-other')).toMatch(/^Saved claude-other, but pinned is in effect/);
  });
});

describe('telegram/config.js owner chat (KV row, else yaml)', () => {
  it('is the same winner', () => {
    expect(getTelegramConfig().ownerChatId).toBe('yaml-chat');
    setConfig('telegram.ownerChatId', 'kv-chat');
    expect(getTelegramConfig().ownerChatId).toBe('kv-chat');
  });
});
