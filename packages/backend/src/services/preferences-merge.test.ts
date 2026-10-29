import { describe, it, expect } from 'vitest';
import { mergeProviderAndDsh, readDshPrefs } from './preferences-merge.js';

describe('mergeProviderAndDsh', () => {
  it('round-trips provider=dsh and the dsh fields, trimmed', () => {
    const agent: Record<string, any> = {};
    const err = mergeProviderAndDsh(agent, {
      provider: 'dsh',
      dsh: { model: ' a ', model_autonomous: 'b', model_provider: 'openrouter', base_url: 'https://openrouter.ai/api/v1', api_key_env: 'OPENROUTER_API_KEY' },
    });
    expect(err).toBeNull();
    expect(agent.provider).toBe('dsh');
    expect(readDshPrefs(agent)).toEqual({
      model: 'a', model_autonomous: 'b', model_provider: 'openrouter', base_url: 'https://openrouter.ai/api/v1', api_key_env: 'OPENROUTER_API_KEY',
    });
  });

  it('rejects an unknown provider and leaves the agent untouched', () => {
    const agent: Record<string, any> = { provider: 'claude' };
    expect(mergeProviderAndDsh(agent, { provider: 'bogus' })).toMatch(/agent.provider must be one of/);
    expect(agent.provider).toBe('claude');
  });

  it("keeps model_autonomous '' as '' and never copies the chat model into it", () => {
    const agent: Record<string, any> = {};
    mergeProviderAndDsh(agent, { dsh: { model: 'a', model_autonomous: '' } });
    expect(agent.dsh.model).toBe('a');
    expect(agent.dsh.model_autonomous).toBe('');
    expect(readDshPrefs(agent).model_autonomous).toBe('');
  });

  it('omitted fields are left as saved; non-strings are ignored; GET defaults to ""', () => {
    const agent: Record<string, any> = { dsh: { model: 'a', base_url: 'u' } };
    mergeProviderAndDsh(agent, { dsh: { model: 'c', base_url: 5 } });
    expect(agent.dsh).toEqual({ model: 'c', base_url: 'u' });
    expect(readDshPrefs(undefined).api_key_env).toBe('');
  });
});
