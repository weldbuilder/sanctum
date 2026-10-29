import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  setupCode, checkSetupCode, setupCodeMatches, ensureSetupCode, announceSetupCode, _resetSetupCode,
  SETUP_CODE_TTL_MS, SETUP_CODE_FREE_FAILURES, SETUP_CODE_HEX_CHARS, SETUP_CODE_ROTATION_WINDOW_MS,
  SETUP_GUESS_LIMIT, SETUP_GUESS_WINDOW_MS, SETUP_GUESS_TABLE_MAX, setupGuessBlocked, noteWrongGuess,
} from './setup-code.js';

// The one-time setup code before a password exists: 12 hex characters, printed once, 30 minutes, five free wrong guesses.

let now = 1_000_000;
const printed: { code: string; why: string }[] = [];
beforeEach(() => {
  now = 1_000_000;
  printed.length = 0;
  _resetSetupCode({ now: () => now, announce: (code, why) => { printed.push({ code, why }); } });
});

describe('the code', () => {
  it('is twelve hex characters from crypto.randomBytes, stable within a boot, new after a reset', () => {
    expect(SETUP_CODE_HEX_CHARS).toBe(12);
    const a = setupCode();
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(setupCode()).toBe(a);
    _resetSetupCode({ now: () => now, announce: () => undefined });
    expect(setupCode()).not.toBe(a);
  });

  it('is printed once at boot, with nothing else printed while guesses are right', () => {
    const code = announceSetupCode();
    expect(printed).toEqual([{ code, why: 'boot' }]);
    expect(checkSetupCode(code)).toBe('ok');
    expect(checkSetupCode(code)).toBe('ok');
    expect(printed).toHaveLength(1);
  });

  it('is never written to disk: the module touches no file', async () => {
    const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('./setup-code.ts', import.meta.url), 'utf-8'));
    expect(src).not.toMatch(/writeFile|appendFile|createWriteStream|writeSync/);
    expect(src).not.toMatch(/from 'fs'|from 'node:fs'/);
    expect(src).not.toMatch(/console\.(log|info|warn|error)/); // and not into the app's log either: a plain stdout write
  });

  it('matches case-insensitively with surrounding space, and nothing else', () => {
    const c = setupCode();
    expect(checkSetupCode(` ${c.toUpperCase()} `)).toBe('ok');
    expect(checkSetupCode(c.slice(0, -1))).toBe('wrong');
    expect(checkSetupCode(`${c}0`)).toBe('wrong');
    expect(setupCodeMatches(c)).toBe(true);
  });

  it('says "missing" for no code at all, and does not count it as a guess', () => {
    setupCode();
    for (const x of [undefined, null, '', '   ', 5, {}]) expect(checkSetupCode(x)).toBe('missing');
    for (let i = 0; i < SETUP_CODE_FREE_FAILURES; i++) expect(checkSetupCode('000000000000')).toBe('wrong');
    expect(printed).toEqual([]); // the missing ones used up none of the five
  });
});

describe('wrong guesses', () => {
  it('five are free; the sixth replaces the code and prints the new one', () => {
    const first = setupCode();
    for (let i = 0; i < SETUP_CODE_FREE_FAILURES; i++) expect(checkSetupCode('ffffffffffff')).toBe('wrong');
    expect(setupCode()).toBe(first);
    expect(printed).toEqual([]);
    expect(checkSetupCode('ffffffffffff')).toBe('rotated');
    expect(setupCode()).not.toBe(first);
    expect(printed).toHaveLength(1);
    expect(printed[0]).toEqual({ code: setupCode(), why: 'too_many_guesses' });
    // the old code no longer works, even though it was right a moment ago
    expect(checkSetupCode(first)).not.toBe('ok');
  });

  it('after the fifth, a wrong guess replaces the code at most once per rotation window, one printed line per rotation', () => {
    for (let i = 0; i < SETUP_CODE_FREE_FAILURES; i++) checkSetupCode('ffffffffffff');
    expect(checkSetupCode('ffffffffffff')).toBe('rotated');
    for (let i = 0; i < 50; i++) expect(checkSetupCode('ffffffffffff')).toBe('wrong');
    expect(printed).toHaveLength(1);
    now += SETUP_CODE_ROTATION_WINDOW_MS - 1;
    expect(checkSetupCode('ffffffffffff')).toBe('wrong');
    expect(printed).toHaveLength(1);
    now += 1;
    expect(checkSetupCode('ffffffffffff')).toBe('rotated'); // the count carried on past five, so the first wrong guess after the window rotates
    expect(printed).toHaveLength(2);
    expect(printed.map((p) => p.why)).toEqual(['too_many_guesses', 'too_many_guesses']);
  });

  it('a rotation resets the failure count (the new code starts clean)', () => {
    for (let i = 0; i < SETUP_CODE_FREE_FAILURES + 1; i++) checkSetupCode('ffffffffffff');
    now += SETUP_CODE_ROTATION_WINDOW_MS;
    // five free guesses again on the new code: none of them rotates, although the window has passed
    for (let i = 0; i < SETUP_CODE_FREE_FAILURES; i++) expect(checkSetupCode('ffffffffffff')).toBe('wrong');
    expect(printed).toHaveLength(1);
    expect(checkSetupCode('ffffffffffff')).toBe('rotated');
  });

  it('the newest printed code works, and a right code resets the count', () => {
    for (let i = 0; i < SETUP_CODE_FREE_FAILURES + 1; i++) checkSetupCode('ffffffffffff');
    const newest = printed[printed.length - 1].code;
    expect(checkSetupCode(newest)).toBe('ok');
    now += SETUP_CODE_ROTATION_WINDOW_MS;
    for (let i = 0; i < SETUP_CODE_FREE_FAILURES; i++) expect(checkSetupCode('eeeeeeeeeeee')).toBe('wrong');
    expect(checkSetupCode('eeeeeeeeeeee')).toBe('rotated');
  });

  it('a right guess after four wrong ones still works and the code stays', () => {
    const c = setupCode();
    for (let i = 0; i < 4; i++) checkSetupCode('ffffffffffff');
    expect(checkSetupCode(c)).toBe('ok');
    expect(setupCode()).toBe(c);
  });
});

describe('the per-address guess count', () => {
  it('blocks an address after five wrong guesses and frees it when the window ends; counts nothing until told', () => {
    expect(setupGuessBlocked('1.1.1.1')).toBe(false);
    for (let i = 0; i < SETUP_GUESS_LIMIT - 1; i++) noteWrongGuess('1.1.1.1');
    expect(setupGuessBlocked('1.1.1.1')).toBe(false);
    noteWrongGuess('1.1.1.1');
    expect(setupGuessBlocked('1.1.1.1')).toBe(true);
    expect(setupGuessBlocked('2.2.2.2')).toBe(false);
    now += SETUP_GUESS_WINDOW_MS;
    expect(setupGuessBlocked('1.1.1.1')).toBe(false);
  });
  it('remembers at most SETUP_GUESS_TABLE_MAX addresses: a flood of forged ones forgets the oldest, never grows past the cap', () => {
    for (let i = 0; i < SETUP_GUESS_LIMIT; i++) noteWrongGuess('10.0.0.1');
    expect(setupGuessBlocked('10.0.0.1')).toBe(true);
    for (let i = 0; i < SETUP_GUESS_TABLE_MAX + 50; i++) noteWrongGuess(`flood-${i}`);
    expect(setupGuessBlocked('10.0.0.1')).toBe(false); // the oldest entry was dropped to make room
    expect(setupGuessBlocked(`flood-${SETUP_GUESS_TABLE_MAX + 49}`)).toBe(false); // one guess each, none blocked
    // Fill again, this time counting five from one new address last: it is still there and blocked.
    for (let i = 0; i < SETUP_GUESS_LIMIT; i++) noteWrongGuess('10.0.0.2');
    expect(setupGuessBlocked('10.0.0.2')).toBe(true);
  });
});

describe('expiry', () => {
  it('works for 30 minutes and not a moment longer; an expired try prints a new code and is not a guess', () => {
    const c = setupCode();
    now += SETUP_CODE_TTL_MS;
    expect(checkSetupCode(c)).toBe('ok'); // exactly 30 minutes: still good
    now += 1;
    expect(checkSetupCode(c)).toBe('expired');
    expect(printed).toHaveLength(1);
    expect(printed[0].why).toBe('expired');
    const fresh = setupCode();
    expect(fresh).not.toBe(c);
    expect(checkSetupCode(fresh)).toBe('ok');
    // the expired try did not use up a free guess
    for (let i = 0; i < SETUP_CODE_FREE_FAILURES; i++) expect(checkSetupCode('ffffffffffff')).toBe('wrong');
  });

  it('the status route can make a new code after it expired (ensureSetupCode), and prints it', () => {
    ensureSetupCode();
    expect(printed.map((p) => p.why)).toEqual(['boot']);
    now += SETUP_CODE_TTL_MS + 1;
    ensureSetupCode();
    expect(printed.map((p) => p.why)).toEqual(['boot', 'expired']);
    ensureSetupCode();
    expect(printed).toHaveLength(2); // nothing new while it is live
  });

  it('a wrong guess after expiry is "expired" first, never a free pass', () => {
    setupCode();
    now += SETUP_CODE_TTL_MS + 5;
    expect(checkSetupCode('ffffffffffff')).toBe('expired');
  });
});

describe('the default announcement', () => {
  it('goes to stdout directly, not through console (which the app captures into its log)', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    _resetSetupCode({ now: () => now });
    const c = announceSetupCode();
    expect(write).toHaveBeenCalledWith(expect.stringContaining(c));
    expect(log).not.toHaveBeenCalled();
    write.mockRestore(); log.mockRestore();
  });
});
