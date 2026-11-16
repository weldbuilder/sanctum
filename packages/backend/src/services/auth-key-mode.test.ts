// The boot check: ANTHROPIC_API_KEY set while the auth mode is subscription (the key is removed from every run). One line, only in that mismatch.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ mode: 'subscription' as 'subscription' | 'api_key' }));
vi.mock('./db.js', () => ({ getDb: () => ({ prepare: () => ({ get: () => ({ auth_mode: h.mode, api_key: null, preferred_model: null, preferred_model_autonomous: null, usage_tracking_enabled: 1, updated_at: 'x' }) }) }) }));
vi.mock('../tenancy/context.js', () => ({ tenancyEnabled: () => false, tenantLocal: (init: () => unknown) => { let v = init(); return { get: () => v, set: (n: unknown) => { v = n; } }; } }));
vi.mock('./settings/index.js', () => ({ resolveSetting: () => ({ value: null }) }));

import { AUTH_KEY_IGNORED_LINE } from '../../../../scripts/setup-lib.mjs';

const KEY = { ANTHROPIC_API_KEY: 'sk-demo-key' } as NodeJS.ProcessEnv;
// (getAuthPreferences caches per database, so each test loads the module afresh)
let checkAuthKeyMode: typeof import('./auth-preferences.js').checkAuthKeyMode;
beforeEach(async () => { h.mode = 'subscription'; vi.resetModules(); ({ checkAuthKeyMode } = await import('./auth-preferences.js')); });

describe('checkAuthKeyMode', () => {
  it('logs one line in the mismatch: a key set, mode subscription (the line carries no key)', () => {
    const warn = vi.fn();
    expect(checkAuthKeyMode(warn, KEY)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain(AUTH_KEY_IGNORED_LINE);
    expect(warn.mock.calls[0][0]).not.toContain('sk-demo-key');
  });
  it('is silent in api_key mode, with no key, or with a blank key', () => {
    const warn = vi.fn();
    expect(checkAuthKeyMode(warn, {} as NodeJS.ProcessEnv)).toBe(false);
    expect(checkAuthKeyMode(warn, {} as NodeJS.ProcessEnv)).toBe(false);
    expect(checkAuthKeyMode(warn, { ANTHROPIC_API_KEY: '  ' } as NodeJS.ProcessEnv)).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
  it('is silent in api_key mode', async () => {
    h.mode = 'api_key';
    vi.resetModules();
    const { checkAuthKeyMode: fresh } = await import('./auth-preferences.js');
    const warn = vi.fn();
    expect(fresh(warn, KEY)).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
});
