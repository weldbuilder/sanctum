import { describe, it, expect } from 'vitest';
import { errorClass } from './error-class.js';

describe('errorClass: a short class that is safe to show and to log', () => {
  it('passes a known kind through', () => {
    expect(errorClass(Object.assign(new Error('x'), { kind: 'provider_error' }))).toBe('provider_error');
    expect(errorClass({ kind: 'timeout' })).toBe('timeout');
  });

  // SHOULD-FIX 7: err.kind is whatever a provider or a library put there. Only ^[a-z_]{1,32}$ is a class.
  it('never passes through a kind that is not ^[a-z_]{1,32}$: a path, a message, a number, a multi-line string, a long one', () => {
    const bad: unknown[] = [
      '/home/pat/.env', 'ENOENT: open /home/x/secret', 'Provider Error', 'provider-error', 'Quota', 'a'.repeat(33), '', 'x\ny', 'x_1', 'tok_sk-ant-123',
      42, null, undefined, {}, ['a'], true,
    ];
    for (const kind of bad) {
      const out = errorClass(Object.assign(new Error('boom'), { kind }));
      expect(out, String(kind)).toBe('error');
    }
  });

  // B2.2: a regex pass-through let `sk_live_x`, `ghp_secret` and `AKIA...` out as a "class". Only a fixed list passes.
  it('only a fixed list of known kinds passes; anything else, even a plain snake word, is "error"', () => {
    for (const k of ['provider_error', 'timeout', 'queue_full', 'queue_timeout', 'max_turns', 'harness_unsupported', 'identity', 'identity_missing', 'record_failed', 'api_key_missing', 'transport', 'error']) {
      expect(errorClass({ kind: k }), k).toBe(k);
    }
    for (const k of ['sk_live_x', 'ghp_secret', 'sk_live_51Habc', 'AKIAIOSFODNN7EXAMPLE', 'secret_token', 'a'.repeat(32)]) {
      expect(errorClass(Object.assign(new Error('boom'), { kind: k })), k).toBe('error');
    }
  });

  it('the error name is used only for TypeError, RangeError, SyntaxError and AbortError', () => {
    for (const name of ['TypeError', 'RangeError', 'SyntaxError', 'AbortError']) expect(errorClass(Object.assign(new Error('x'), { name })), name).toBe(name);
    for (const name of ['SpawnError', 'sk_live_x', 'ghp_secret', 'AKIAIOSFODNN7EXAMPLE', 'PublicRunError', 'AgentTurnError']) expect(errorClass(Object.assign(new Error('x'), { name })), name).toBe('error');
    // a bad kind does not turn into a name unless the name is on the list
    expect(errorClass(Object.assign(new Error('boom'), { name: 'SpawnError', kind: '/etc/passwd' }))).toBe('error');
    expect(errorClass(Object.assign(new TypeError('boom'), { kind: '/etc/passwd' }))).toBe('TypeError');
  });

  it('a name that is not a plain identifier, or is just Error, is "error"', () => {
    expect(errorClass(Object.assign(new Error('boom'), { name: 'not an identifier / path' }))).toBe('error');
    expect(errorClass(new Error('boom'))).toBe('error');
    expect(errorClass('a string')).toBe('error');
    expect(errorClass(null)).toBe('error');
  });
});
