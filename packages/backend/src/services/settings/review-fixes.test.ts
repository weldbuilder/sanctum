// Review fixes for the settings service: the legacy /model row, yaml truthiness, the empty KV bool row, a dotted wake type.
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

import { loadConfig, badSwitchWarning } from '../../config.js';
import { initDb, setConfig, getConfig } from '../db.js';
import { updateAuthPreferences } from '../auth-preferences.js';
import { resolveSetting, retireLegacyModelRow } from './index.js';

const dir = mkdtempSync(join(tmpdir(), 'review-'));
const cfgPath = join(dir, 'sanctum.yaml');
const write = (extra: string) => writeFileSync(cfgPath, [
  'identity: { timezone: UTC }',
  'agent: { model: yaml-model }',
  `orchestrator: { wake_prompts_path: ${JSON.stringify(join(dir, 'wake.md'))}, wake_prompts_dir: ${JSON.stringify(join(dir, 'wakes'))}${extra} }`,
].join('\n'));

let warn: ReturnType<typeof vi.spyOn>;
beforeAll(() => { vi.spyOn(console, 'log').mockImplementation(() => {}); write(''); loadConfig(cfgPath); });
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  initDb(':memory:');
  updateAuthPreferences({ auth_mode: 'subscription', api_key: null, preferred_model: null, preferred_model_autonomous: null });
});
afterEach(() => { vi.unstubAllEnvs(); warn.mockRestore(); });

describe('the legacy KV agent.model row', () => {
  it('is ignored by the resolver, named in ONE warning at startup, and deleted', () => {
    setConfig('agent.model', 'old-retired-model');
    expect(resolveSetting('agent.model')).toMatchObject({ value: 'yaml-model', source: 'yaml' });
    expect(retireLegacyModelRow()).toBe('old-retired-model');
    const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('agent.model'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('ignoring');
    expect(lines[0]).toContain('old-retired-model');
    expect(getConfig('agent.model')).toBeNull();
    expect(retireLegacyModelRow()).toBeNull(); // nothing left, nothing said
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('agent.model'))).toHaveLength(1);
  });
});

describe('boolean coercion of a yaml value (orchestrator.enabled: the default is true, so a false is a read value, not a fall-through)', () => {
  const read = (v: unknown) => resolveSetting('orchestrator.enabled', { yaml: { orchestrator: { enabled: v } } });
  const matrix: Array<[unknown, boolean]> = [
    [true, true], [false, false], ['true', true], ['false', false], ['yes', true], ['on', true], ['no', false], ['off', false],
    [1, true], [0, false], ['', false], ['maybe', false], ['YES', true], ['Off', false], ['1', true], ['0', false], [2, false],
  ];
  for (const [input, want] of matrix) {
    it(`${JSON.stringify(input)} -> ${want}`, () => {
      expect(read(input)).toMatchObject({ value: want, source: 'yaml' });
    });
  }

  it('an empty-string KV row for a boolean key reads false (getConfigBool), it does not fall through to yaml/default', () => {
    setConfig('cron.morning.enabled', '');
    expect(resolveSetting('cron.morning.enabled')).toMatchObject({ value: false, source: 'db' });
    setConfig('handoff.enabled', '');
    expect(resolveSetting('handoff.enabled', { yaml: { handoff: { enabled: true } } })).toMatchObject({ value: false, source: 'db' });
  });

  it('config load names a non-yes/no switch once and ignores the good ones', async () => {
    write(', enabled: maybe, failsafe: { enabled: yes }');
    vi.resetModules(); // loadConfig keeps its first result: read this file with a fresh copy of the module
    (await import('../../config.js')).loadConfig(cfgPath);
    const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('read as false'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('orchestrator.enabled: "maybe"');
    expect(lines[0]).not.toContain('failsafe');
    expect(badSwitchWarning({ discord: { enabled: 'on' }, telegram: { enabled: 0 } })).toBeNull();
  });
});

describe('a yaml schedule key with a dot', () => {
  it('is warned about and skipped; start() does not throw', async () => {
    write(', schedules: { "a.b": "0 8 * * *", ok: "0 9 * * *" }');
    vi.resetModules();
    (await import('../../config.js')).loadConfig(cfgPath);
    (await import('../db.js')).initDb(':memory:');
    const { Orchestrator: Fresh } = await import('../orchestrator.js');
    const o = new Fresh({} as never, {} as never);
    expect(() => o.start()).not.toThrow();
    o.stop();
    expect(warn.mock.calls.some((c) => String(c[0]).includes('"a.b"') && String(c[0]).includes('skipped'))).toBe(true);
  });
});
