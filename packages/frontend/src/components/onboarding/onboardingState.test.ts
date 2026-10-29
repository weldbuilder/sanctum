import { describe, it, expect } from 'vitest';
import { codexTarget, connectionBody, initialConnect, onboardingAnswers, placeOf, readyToCheck, withCodexProvider, withHarness, type Connect } from './onboardingState';

const yours = { userName: ' Sam ', companionName: ' Ada ', timezone: 'America/New_York' };
const c = (over: Partial<Connect> = {}): Connect => ({ ...initialConnect(), ...over });

describe('onboarding answers', () => {
  it('sends only the names, the time zone, the password and the harness: the server defaults everything else', () => {
    expect(onboardingAnswers(yours, c(), 'pw')).toEqual({
      userName: 'Sam', companionName: 'Ada', timezone: 'America/New_York', password: 'pw', provider: 'claude', claudeModel: 'claude-sonnet-5-5',
    });
  });

  it('Claude with a key sends the key; with a login it sends none', () => {
    expect(onboardingAnswers(yours, c({ method: 'key', key: ' sk-ant ' }), '')).toMatchObject({ provider: 'claude', anthropicKey: 'sk-ant' });
    expect(onboardingAnswers(yours, c({ method: 'login', key: 'left over' }), '')).not.toHaveProperty('anthropicKey');
    expect(onboardingAnswers(yours, c(), '')).not.toHaveProperty('password'); // a rerun keeps the saved one
  });

  it('Codex with a ChatGPT login adds no provider; with a key it adds the chosen one as the default', () => {
    expect(onboardingAnswers(yours, c({ harness: 'codex', method: 'login' }), '')).toMatchObject({ provider: 'codex', addProvider: false });
    expect(onboardingAnswers(yours, withCodexProvider(c({ harness: 'codex', method: 'key', key: 'k' }), 'deepseek'), '')).toMatchObject({
      provider: 'codex', addProvider: true, providerId: 'deepseek', providerName: 'DeepSeek', providerBaseUrl: 'https://api.deepseek.com',
      providerKey: 'k', providerModel: 'deepseek-chat', providerDefault: true,
    });
  });

  it('another provider gets an id the server accepts, made from its name', () => {
    expect(codexTarget(c({ codexProvider: 'other', otherName: 'My Local Llama!', otherBaseUrl: ' http://localhost:11434/v1 ' }))).toEqual({ id: 'my-local-llama', name: 'My Local Llama!', baseUrl: 'http://localhost:11434/v1' });
    expect(codexTarget(c({ codexProvider: 'other', otherName: '???' })).id).toBe('custom');
  });
});

describe('the connection check', () => {
  it('asks for a key only when one is the way in, and a Codex provider needs its address and model', () => {
    expect(readyToCheck(c())).toBe(true);
    expect(readyToCheck(c({ method: 'key' }))).toBe(false);
    expect(readyToCheck(c({ method: 'key', key: 'k' }))).toBe(true);
    expect(readyToCheck(withCodexProvider(c({ harness: 'codex', method: 'key', key: 'k' }), 'other'))).toBe(false);
    expect(readyToCheck(c({ harness: 'codex', method: 'key', key: 'k', codexProvider: 'other', otherBaseUrl: 'https://x/v1', codexModel: 'm' }))).toBe(true);
  });

  it('sends the key only for a key check, and names the Codex provider', () => {
    expect(connectionBody(c())).toEqual({ probe: 'connection', harness: 'claude', method: 'login' });
    expect(connectionBody(c({ method: 'key', key: 'k' }))).toEqual({ probe: 'connection', harness: 'claude', method: 'key', key: 'k' });
    expect(connectionBody(c({ harness: 'codex', method: 'key', key: 'k' }))).toEqual({ probe: 'connection', harness: 'codex', method: 'key', key: 'k', baseUrl: 'https://api.openai.com/v1', providerName: 'OpenAI' });
  });
});

it('shows a time zone as its place', () => {
  expect(placeOf('America/New_York')).toBe('New York');
  expect(placeOf('UTC')).toBe('UTC');
});

describe('DeepSeek Harness, the third harness', () => {
  it('is reached with a DeepSeek API key: choosing it starts on the key, and the check and the answers carry it', () => {
    const d = withHarness(c({ method: 'login', key: 'old' }), 'dsh');
    expect(d).toMatchObject({ harness: 'dsh', method: 'key', key: '' });
    expect(readyToCheck(d)).toBe(false);
    const withKey = { ...d, key: ' sk-ds ' };
    expect(readyToCheck(withKey)).toBe(true);
    expect(connectionBody(withKey)).toEqual({ probe: 'connection', harness: 'dsh', method: 'key', key: ' sk-ds ' });
    expect(onboardingAnswers(yours, withKey, 'pw')).toEqual({ userName: 'Sam', companionName: 'Ada', timezone: 'America/New_York', password: 'pw', provider: 'dsh', dshKey: 'sk-ds' });
  });
  it('choosing Claude or Codex again starts on the account login', () => {
    expect(withHarness(c({ harness: 'dsh', method: 'key' }), 'codex')).toMatchObject({ harness: 'codex', method: 'login' });
  });
});
