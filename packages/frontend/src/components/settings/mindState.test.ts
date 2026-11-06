import { describe, expect, it } from 'vitest';
import { imagegenKeyFor, keyEnvTyped, keyMarker, keyText, KEY_ENV_HINT, memoryMixedNote, memoryOptions, shownMemory, summarizerWho } from './mindState';

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

describe('summarizerWho with the deprecated rolling aliases', () => {
  it('names the alias when it is the only thing choosing the model', () => {
    expect(summarizerWho({ provider: '', model: '' }, { model: 'big-1', model_provider: '' }))
      .toBe('Summaries currently use big-1 via the deprecated agent.rolling.model; move it to agent.summarizer.');
    expect(summarizerWho(undefined, { model: 'big-1', model_provider: 'deepseek' })).toContain('big-1 (deepseek) via the deprecated agent.rolling.model');
  });
  it('says nothing about it once agent.summarizer is set, or when the alias is empty', () => {
    expect(summarizerWho({ provider: 'openai-compat', model: 'm' }, { model: 'big-1' })).not.toContain('deprecated');
    expect(summarizerWho({ provider: '', model: '' }, { model: '  ', model_provider: '' })).toBe('The chat model writes them.');
  });
});

describe('the key-env field', () => {
  it('uppercases as you type, drops spaces, and its hint says NAME, not the key', () => {
    expect(keyEnvTyped('summarizer_api_key')).toBe('SUMMARIZER_API_KEY');
    expect(keyEnvTyped('my key')).toBe('MYKEY');
    expect(KEY_ENV_HINT).toContain('variable NAME, not the key');
  });
});

describe('memory radio mapping and the mixed-file note', () => {
  it('dsh has no harness memory: a file that reads harness shows the option that is really selected', () => {
    expect(shownMemory('dsh', 'harness')).toBe('none');
    expect(shownMemory('dsh', 'revien')).toBe('revien');
    expect(shownMemory('claude', 'harness')).toBe('harness');
    expect(memoryOptions('dsh').map(o => o.value)).toContain(shownMemory('dsh', 'harness'));
  });
  it('notes a mixed file in one line, and stays quiet otherwise', () => {
    expect(memoryMixedNote(true)).toMatch(/more than one memory system/);
    expect(memoryMixedNote(false)).toBeNull();
    expect(memoryMixedNote(undefined)).toBeNull();
  });
});
