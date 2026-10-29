import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ provider: 'claude', seen: null as any }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (p: any) => { h.seen = p; return (async function* () {})(); },
  AbortError: class extends Error {}, listSessions: async () => [],
}));
vi.mock('../../config.js', () => ({ getSanctumConfig: () => ({}), activeProviderName: () => h.provider }));
vi.mock('./codex.js', () => ({ codexQuery: () => (async function* () {})() }));
vi.mock('./dsh.js', () => ({ dshQuery: () => (async function* () {})() }));

import { childEnv } from './child-env.js';
import { query } from './index.js';

describe('childEnv', () => {
  it('drops MIND_API_KEY and nothing else, without touching the source', () => {
    const src = { MIND_API_KEY: 'secret', PATH: '/bin', OPENAI_API_KEY: 'o', EMPTY: undefined };
    const out = childEnv(src);
    expect(out).toEqual({ PATH: '/bin', OPENAI_API_KEY: 'o', EMPTY: undefined });
    expect(src.MIND_API_KEY).toBe('secret');
  });
});

describe('the Claude SDK child', () => {
  beforeEach(() => { h.seen = null; h.provider = 'claude'; vi.stubEnv('MIND_API_KEY', 'mind-secret-1'); vi.stubEnv('SOME_OTHER_VAR', 'kept'); });
  it('gets an env without MIND_API_KEY and with everything else', () => {
    query({ prompt: 'hi', options: { model: 'm' } as any });
    expect(h.seen.options.env.MIND_API_KEY).toBeUndefined();
    expect('MIND_API_KEY' in h.seen.options.env).toBe(false);
    expect(h.seen.options.env.SOME_OTHER_VAR).toBe('kept');
    // Key set, not a named variable: Windows spells PATH as Path.
    expect(Object.keys(h.seen.options.env).sort()).toEqual(Object.keys(process.env).filter((k) => k.toUpperCase() !== 'MIND_API_KEY').sort());
    expect(h.seen.options.model).toBe('m');
  });
  it('strips it from an env the caller passed, keeping the caller\'s other entries', () => {
    query({ prompt: 'hi', options: { env: { MIND_API_KEY: 'x', A: '1' } } as any });
    expect(h.seen.options.env).toEqual({ A: '1' });
  });
  it('matches the name case-insensitively (Windows keys are case-insensitive)', () => {
    query({ prompt: 'hi', options: { env: { Mind_Api_Key: 'x', mind_api_key: 'y', B: '2' } } as any });
    expect(h.seen.options.env).toEqual({ B: '2' });
  });
  it('works with no options at all', () => {
    query({ prompt: 'hi' });
    expect('MIND_API_KEY' in h.seen.options.env).toBe(false);
  });
});
