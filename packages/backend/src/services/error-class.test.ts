import { describe, it, expect } from 'vitest';
import { errorClass, classifyFailure, isFalloverClass, FALLOVER_CLASSES, FAIL_CLASSES, type FailClass } from './error-class.js';

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
    for (const k of ['provider_error', 'timeout', 'queue_full', 'queue_timeout', 'max_turns', 'harness_unsupported', 'identity', 'identity_missing', 'record_failed', 'api_key_missing', 'transport', 'harness_hung', 'error']) {
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

// ─── Failure classes: what the brain router acts on ─────────────────────────────────────────────────────────────────────
const E = (message: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(message), extra);

describe('classifyFailure: each class from what Claude, Codex, dsh and a chat endpoint really print', () => {
  const table: Array<[string, unknown, FailClass]> = [
    // Claude (Agent SDK): the assistant message `error` code, the CLI's own words, a result's errors
    ['claude assistant.error authentication_failed', { error: 'authentication_failed' }, 'AUTH'],
    ['claude oauth org not allowed', { error: 'oauth_org_not_allowed' }, 'AUTH'],
    ['claude "Invalid API key · Please run /login"', E('Invalid API key · Please run /login'), 'AUTH'],
    ['claude not logged in', { errors: ['Not logged in · Please run /login'] }, 'AUTH'],
    ['claude billing_error', { error: 'billing_error' }, 'CREDIT'],
    ['claude credit balance', { errors: ['Credit balance is too low'] }, 'CREDIT'],
    ['claude rate_limit', { error: 'rate_limit' }, 'RATE_LIMIT'],
    ['claude usage limit', { result: 'Claude AI usage limit reached|1760000000' }, 'RATE_LIMIT'],
    ['claude server_error', { error: 'server_error' }, 'SERVER'],
    ['claude overloaded 529', E('529 {"type":"error","error":{"type":"overloaded_error"}}'), 'SERVER'],
    ['claude binary missing', E('Claude Code executable not found at /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js'), 'HARNESS_MISSING'],
    ['claude native binary missing', E('Claude Code native binary not found at /x/claude'), 'HARNESS_MISSING'],
    ['claude process exit 127', E('Claude Code process exited with code 127'), 'HARNESS_MISSING'],
    ['claude max output tokens is not a fallover', { error: 'max_output_tokens' }, 'OTHER'],
    ['claude invalid_request is not a fallover', { error: 'invalid_request' }, 'OTHER'],
    ['claude max turns is not a fallover', { type: 'result', subtype: 'error_max_turns', errors: ['too many turns'] }, 'OTHER'],
    // Codex
    ['codex 401', E('codex exec exited with code 1: unexpected status 401 Unauthorized: Missing bearer or basic authentication'), 'AUTH'],
    ['codex please login', E('codex exec exited with code 1: Not signed in. Run `codex login`'), 'AUTH'],
    ['codex usage limit', E("You've hit your usage limit. Upgrade to Pro or try again in 3 days"), 'RATE_LIMIT'],
    ['codex insufficient_quota', E('exceeded your current quota, please check your plan and billing details (insufficient_quota)'), 'CREDIT'],
    ['codex stream disconnected', E('stream disconnected before completion: error sending request for url'), 'NETWORK'],
    ['codex binary missing', E('Unable to locate Codex CLI binaries. Ensure @openai/codex is installed'), 'HARNESS_MISSING'],
    ['codex spawn ENOENT', E('spawn codex ENOENT', { code: 'ENOENT', syscall: 'spawn codex' }), 'HARNESS_MISSING'],
    ['codex 429', E('codex exec exited with code 1: 429 Too Many Requests'), 'RATE_LIMIT'],
    ['codex 503', E('codex exec exited with code 1: unexpected status 503 Service Unavailable'), 'SERVER'],
    // dsh
    ['dsh spawn ENOENT', E('spawn dsh ENOENT', { code: 'ENOENT', syscall: 'spawn dsh', errno: -2 }), 'HARNESS_MISSING'],
    ['dsh command not found', E('dsh exited with code 127: /bin/sh: dsh: command not found'), 'HARNESS_MISSING'],
    ['dsh timed out is the harness hung', E('dsh timed out after 1800000ms'), 'HARNESS_HUNG'],
    ['went silent (the router\'s own message)', E('the harness produced no output (went silent)', { kind: 'harness_hung' }), 'HARNESS_HUNG'],
    ['dsh 401 in stderr', E('dsh exited with code 1: DeepSeek API error: 401 Authentication Fails, Your api key is invalid'), 'AUTH'],
    ['dsh 402 insufficient balance', E('dsh exited with code 1: 402 Insufficient Balance'), 'CREDIT'],
    ['dsh turn error code', E('dsh turn failed: rate_limit_exceeded'), 'RATE_LIMIT'],
    ['dsh api key missing', Object.assign(new Error('the public run has no API key'), { kind: 'api_key_missing' }), 'AUTH'],
    // plain network and timeouts
    ['ECONNRESET', E('read ECONNRESET', { code: 'ECONNRESET' }), 'NETWORK'],
    ['ENOTFOUND', E('getaddrinfo ENOTFOUND api.anthropic.com'), 'NETWORK'],
    ['fetch failed', E('fetch failed'), 'NETWORK'],
    ['ETIMEDOUT', E('connect ETIMEDOUT 1.2.3.4:443'), 'TIMEOUT'],
    ['HTTP 504', E('HTTP 504 Gateway Timeout'), 'TIMEOUT'],
    // the chat client (providers/openai-compat.ts)
    ['chat auth', { name: 'ChatCompletionError', cls: 'auth', message: 'openai-compat: auth (HTTP 401)' }, 'AUTH'],
    ['chat billing', { name: 'ChatCompletionError', cls: 'billing', message: 'x' }, 'CREDIT'],
    ['chat rate_limit', { name: 'ChatCompletionError', cls: 'rate_limit', message: 'x' }, 'RATE_LIMIT'],
    ['chat timeout', { name: 'ChatCompletionError', cls: 'timeout', message: 'x' }, 'TIMEOUT'],
    ['chat network', { name: 'ChatCompletionError', cls: 'network', message: 'x' }, 'NETWORK'],
    ['chat server', { name: 'ChatCompletionError', cls: 'server', message: 'x' }, 'SERVER'],
    ['chat bad_request', { name: 'ChatCompletionError', cls: 'bad_request', message: 'openai-compat: bad_request (HTTP 400)' }, 'OTHER'],
    // never a fallover
    ['the person pressed stop', E('The operation was aborted', { name: 'AbortError' }), 'CANCELLED'],
    ['a park', E('tenant parked', { name: 'ParkedBeforeQuery' }), 'CANCELLED'],
    ['an ordinary bug', new TypeError("Cannot read properties of undefined (reading 'x')"), 'OTHER'],
    ['a missing data file is not a missing harness', E("ENOENT: no such file or directory, open '/home/x/notes.md'", { code: 'ENOENT', syscall: 'open' }), 'OTHER'],
    ['nothing', undefined, 'OTHER'],
    ['empty string', '', 'OTHER'],
  ];
  for (const [name, input, want] of table) it(`${name} -> ${want}`, () => expect(classifyFailure(input)).toBe(want));

  it('reads a stderr tail given as plain text', () => {
    expect(classifyFailure('Error: spawn claude ENOENT')).toBe('HARNESS_MISSING');
    expect(classifyFailure('429 Too Many Requests')).toBe('RATE_LIMIT');
  });

  it('every class in the list is reachable, and the fallover set is exactly the eight', () => {
    expect([...FALLOVER_CLASSES].sort()).toEqual(['AUTH', 'CREDIT', 'HARNESS_HUNG', 'HARNESS_MISSING', 'NETWORK', 'RATE_LIMIT', 'SERVER', 'TIMEOUT']);
    for (const c of FAIL_CLASSES) expect(isFalloverClass(c), c).toBe(c !== 'CANCELLED' && c !== 'OTHER');
    const seen = new Set(table.map((r) => r[2]));
    for (const c of FAIL_CLASSES) expect(seen.has(c), c).toBe(true);
  });

  it('never returns the text it read: a class is one of the fixed words', () => {
    const out = classifyFailure(E('401 Unauthorized for key sk-ant-SECRET-123 at /home/pat/.env'));
    expect(FAIL_CLASSES).toContain(out);
  });
});

describe('errorClass reads a provider failure as its lower-case class', () => {
  it('turns a recognised failure into the class word, and leaves the rest alone', () => {
    expect(errorClass(E('Invalid API key · Please run /login'))).toBe('auth');
    expect(errorClass(E('spawn dsh ENOENT', { code: 'ENOENT', syscall: 'spawn dsh' }))).toBe('harness_missing');
    expect(errorClass(E('429 Too Many Requests'))).toBe('rate_limit');
    expect(errorClass(E('boom'))).toBe('error');
    expect(errorClass(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe('AbortError');
  });
});
