import { describe, expect, it } from 'vitest';
import { imagegenKeyFor, keyMarker, keyText, memoryOptions, summarizerWho } from './mindState';

describe('memoryOptions: one radio, four systems', () => {
  it('Revien, local recall, harness memory, none, in that order', () => {
    expect(memoryOptions('claude').map(o => o.value)).toEqual(['revien', 'sanctum', 'harness', 'none']);
  });
  it('names the harness whose memory it is, and drops it on dsh, which has none', () => {
    expect(memoryOptions('claude')[2].hint).toContain("Claude's auto-memory");
    expect(memoryOptions('codex')[2].hint).toContain('Codex "memories"');
    expect(memoryOptions('dsh').map(o => o.value)).toEqual(['revien', 'sanctum', 'none']);
  });
});

describe('key markers from GET /api/settings', () => {
  it('reads set / not set and where it came from, never a value', () => {
    const eff = { 'summarizer.api_key': { set: true, source: 'env' }, 'imagegen.runware_api_key': { set: false, source: 'default' } };
    expect(keyText(keyMarker(eff, 'summarizer.api_key'))).toBe('set (from .env)');
    expect(keyText(keyMarker(eff, 'imagegen.runware_api_key'))).toBe('not set');
    expect(keyText(keyMarker(eff, 'imagegen.replicate_api_token'))).toBe('not reported');
    expect(keyMarker(undefined, 'x')).toBeNull();
  });
  it('maps a pictures provider to the key it needs', () => {
    expect(imagegenKeyFor('runware')).toEqual({ key: 'imagegen.runware_api_key', env: 'RUNWARE_API_KEY' });
    expect(imagegenKeyFor('replicate')?.env).toBe('REPLICATE_API_TOKEN');
    expect(imagegenKeyFor('none')).toBeNull();
  });
});

describe('summarizerWho', () => {
  it('says the chat model writes them when the fields are empty', () => {
    expect(summarizerWho({ provider: '', model: '' })).toBe('The chat model writes them.');
    expect(summarizerWho(undefined)).toBe('The chat model writes them.');
  });
  it('names the endpoint and model otherwise', () => {
    expect(summarizerWho({ provider: 'openai-compat', model: 'big-1' })).toContain('openai-compat on big-1');
  });
});
