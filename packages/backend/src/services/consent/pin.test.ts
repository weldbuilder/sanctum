import { describe, it, expect, beforeEach, vi } from 'vitest';
vi.mock('../embeddings.js', () => ({ embed: vi.fn().mockResolvedValue(new Float32Array(384)), vectorToBuffer: vi.fn().mockReturnValue(Buffer.alloc(384 * 4)) }));
vi.mock('../vector-cache.js', () => ({ cacheEmbedding: vi.fn(), removeEmbedding: vi.fn() }));
vi.mock('../../config.js', () => ({ getSanctumConfig: vi.fn().mockReturnValue({ identity: { timezone: 'UTC' } }), PROJECT_ROOT: '/tmp/test' }));
import { initDb, getConfig, getDb } from '../db.js';
import { PIN_LOCK_MS, PIN_TOKEN_MS, _resetTokens, clearPin, issueToken, lockedUntil, pinFormatOk, pinIsSet, setPin, tokenValid, verifyPin } from './pin.js';

beforeEach(() => { initDb(':memory:'); _resetTokens(); });
const T = 1_800_000_000_000;

describe('the PIN', () => {
  it('is 4 to 8 digits', () => {
    for (const ok of ['1234', '12345678', '0000']) expect(pinFormatOk(ok)).toBe(true);
    for (const bad of ['123', '123456789', 'abcd', '12 34', '', 1234, null]) expect(pinFormatOk(bad)).toBe(false);
    expect(() => setPin('12')).toThrow();
    expect(pinIsSet()).toBe(false);
  });
  it('is stored as a scrypt hash, never the digits', () => {
    setPin('482913');
    const stored = getConfig('consent.pin_hash')!;
    expect(stored).toMatch(/^scrypt\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
    expect(stored).not.toContain('482913');
    const everything = JSON.stringify(getDb().prepare('SELECT key, value FROM config').all());
    expect(everything).not.toContain('482913');
  });
  it('verifies the right PIN and counts the wrong ones', () => {
    setPin('4829');
    expect(verifyPin('4829', T)).toEqual({ ok: true });
    expect(verifyPin('0000', T)).toEqual({ ok: false, reason: 'wrong', attempts_left: 4 });
    expect(verifyPin('4829', T)).toEqual({ ok: true });
    expect(verifyPin('0000', T)).toMatchObject({ attempts_left: 4 }); // a right one reset the count
  });
  it('five wrong lock it for 15 minutes, even against the right PIN, then it opens', () => {
    setPin('4829');
    for (let i = 0; i < 4; i++) expect(verifyPin('1111', T)).toMatchObject({ reason: 'wrong' });
    const fifth = verifyPin('1111', T);
    expect(fifth).toMatchObject({ ok: false, reason: 'locked', locked_until: T + PIN_LOCK_MS });
    expect(lockedUntil(T + 1000)).toBe(T + PIN_LOCK_MS);
    expect(verifyPin('4829', T + 60_000)).toMatchObject({ ok: false, reason: 'locked' });
    expect(verifyPin('4829', T + PIN_LOCK_MS + 1)).toEqual({ ok: true });
    expect(lockedUntil(T + PIN_LOCK_MS + 1)).toBeNull();
  });
  it('re-running setup clears a lockout', () => {
    setPin('4829');
    for (let i = 0; i < 5; i++) verifyPin('1111', T);
    expect(lockedUntil(T)).not.toBeNull();
    setPin('7777');
    expect(lockedUntil(T)).toBeNull();
    expect(verifyPin('7777', T)).toEqual({ ok: true });
  });
  it('not set: nothing verifies', () => {
    expect(verifyPin('1234')).toEqual({ ok: false, reason: 'not_set' });
    setPin('1234'); clearPin();
    expect(pinIsSet()).toBe(false);
  });
  it('the PIN never reaches the log, and no result carries it', () => {
    const spies = (['log', 'warn', 'error', 'info', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    setPin('482913');
    const results = [verifyPin('482913'), verifyPin('999999'), issueToken()];
    for (const s of spies) { expect(JSON.stringify(s.mock.calls)).not.toContain('482913'); s.mockRestore(); }
    expect(JSON.stringify(results.slice(0, 2))).not.toContain('482913');
    expect(JSON.stringify(results)).not.toMatch(/scrypt/);
  });
  it('verify tokens live 10 minutes and are unknown after a reset', () => {
    const { token, expires_in } = issueToken(T);
    expect(expires_in).toBe(PIN_TOKEN_MS / 1000);
    expect(tokenValid(token, T + PIN_TOKEN_MS - 1)).toBe(true);
    expect(tokenValid(token, T + PIN_TOKEN_MS)).toBe(false);
    expect(tokenValid('nope')).toBe(false);
    expect(tokenValid(undefined)).toBe(false);
    const again = issueToken();
    setPin('1234'); // a new PIN invalidates what the old one vouched for
    expect(tokenValid(again.token)).toBe(false);
  });
});
