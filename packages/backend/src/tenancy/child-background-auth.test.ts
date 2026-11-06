// applyAuthForBackgroundRun: tenancy off writes the person's auth choice into process.env (the summarizer inherits it); tenant mode writes nothing.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

let mode: { auth_mode: string; api_key: string } = { auth_mode: 'subscription', api_key: '' };
vi.mock('../services/auth-preferences.js', async () => {
  const { tenancyEnabled } = await import('./context.js');
  return {
    getAuthPreferences: () => mode,
    // The real function's write rule, with the preference read stubbed.
    applyAuthToEnv: () => {
      const overrides: Record<string, string | undefined> = mode.auth_mode === 'api_key' && mode.api_key
        ? { ANTHROPIC_API_KEY: mode.api_key }
        : { ANTHROPIC_API_KEY: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined, CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: undefined };
      if (!tenancyEnabled()) for (const [k, v] of Object.entries(overrides)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      return overrides;
    },
  };
});

import { applyAuthForBackgroundRun } from './child.js';
import { enableTenancy } from './context.js';

const KEYS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST'];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  process.env.ANTHROPIC_API_KEY = 'P-key';
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'P-oauth';
  process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1';
});
afterEach(() => {
  enableTenancy(false);
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

describe('applyAuthForBackgroundRun', () => {
  it('tenancy off, subscription: removes the key and the OAuth shell from process.env', () => {
    enableTenancy(false);
    mode = { auth_mode: 'subscription', api_key: '' };
    applyAuthForBackgroundRun();
    for (const k of KEYS) expect(process.env[k]).toBeUndefined();
  });

  it('tenancy off, api_key: sets the key', () => {
    enableTenancy(false);
    mode = { auth_mode: 'api_key', api_key: 'sk-chosen' };
    applyAuthForBackgroundRun();
    expect(process.env.ANTHROPIC_API_KEY).toBe('sk-chosen');
  });

  it('tenant mode: writes nothing to process.env, in either mode', () => {
    enableTenancy(true);
    for (const m of [{ auth_mode: 'subscription', api_key: '' }, { auth_mode: 'api_key', api_key: 'sk-chosen' }]) {
      mode = m;
      applyAuthForBackgroundRun();
      expect(process.env.ANTHROPIC_API_KEY).toBe('P-key');
      expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('P-oauth');
      expect(process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBe('1');
    }
  });
});
