import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { checkConnection, modelsUrl, type ConnectionDeps } from './connection-check.js';

const KEY = 'sk-secret-123456';

function deps(over: Partial<ConnectionDeps> = {}, files: string[] = [], status = 200, throws = false) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const d: ConnectionDeps = {
    fetch: async (url, init) => { calls.push({ url, headers: init.headers }); if (throws) throw new Error('offline'); return { status }; },
    exists: (p) => files.includes(p),
    codexInstalled: () => true,
    dshInstalled: () => true,
    platform: 'linux',
    claudeConfigDir: '/h/.claude',
    codexHome: '/h/.codex',
    ...over,
  };
  return { d, calls };
}

describe('connection check', () => {
  it('Claude with a key: asks Anthropic for its model list with the key, and says connected', async () => {
    const { d, calls } = deps();
    const r = await checkConnection({ harness: 'claude', method: 'key', key: ` ${KEY} ` }, d);
    expect(r).toMatchObject({ ok: true, state: 'connected' });
    expect(calls).toEqual([{ url: 'https://api.anthropic.com/v1/models', headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01' } }]);
  });

  it('a refused key, an unreachable provider and a missing key each say so in plain words, and never repeat the key', async () => {
    const rejected = await checkConnection({ harness: 'claude', method: 'key', key: KEY }, deps({}, [], 401).d);
    const offline = await checkConnection({ harness: 'claude', method: 'key', key: KEY }, deps({}, [], 200, true).d);
    const missing = await checkConnection({ harness: 'claude', method: 'key', key: '  ' }, deps().d);
    expect([rejected.state, offline.state, missing.state]).toEqual(['key_rejected', 'unreachable', 'no_key']);
    for (const r of [rejected, offline, missing]) { expect(r.ok).toBe(false); expect(r.message).not.toContain(KEY); }
  });

  it('Claude login: found by its credentials file; on a Mac (Keychain) it says it cannot be checked rather than failing', async () => {
    const found = await checkConnection({ harness: 'claude', method: 'login' }, deps({}, [join('/h/.claude', '.credentials.json')]).d);
    const mac = await checkConnection({ harness: 'claude', method: 'login' }, deps({ platform: 'darwin' }).d);
    const none = await checkConnection({ harness: 'claude', method: 'login' }, deps().d);
    expect(found).toMatchObject({ ok: true, state: 'signed_in' });
    expect(mac).toMatchObject({ ok: true, state: 'cannot_check' });
    expect(none).toMatchObject({ ok: false, state: 'not_signed_in' });
    expect(none.message).toContain('claude login');
  });

  it('Codex login: needs Codex installed and its auth.json', async () => {
    expect(await checkConnection({ harness: 'codex', method: 'login' }, deps({ codexInstalled: () => false }).d)).toMatchObject({ ok: false, state: 'not_installed' });
    expect(await checkConnection({ harness: 'codex', method: 'login' }, deps().d)).toMatchObject({ ok: false, state: 'not_signed_in' });
    expect(await checkConnection({ harness: 'codex', method: 'login' }, deps({}, [join('/h/.codex', 'auth.json')]).d)).toMatchObject({ ok: true, state: 'signed_in' });
  });

  it('Codex with a key: the provider\'s /models with a bearer key, named in the sentence', async () => {
    const { d, calls } = deps();
    const r = await checkConnection({ harness: 'codex', method: 'key', key: KEY, baseUrl: 'https://api.deepseek.com/', providerName: 'DeepSeek' }, d);
    expect(r).toMatchObject({ ok: true, state: 'connected', message: 'Connected. DeepSeek accepted your key.' });
    expect(calls).toEqual([{ url: 'https://api.deepseek.com/models', headers: { Authorization: `Bearer ${KEY}` } }]);
  });

  it('refuses an address that is not http(s) before sending anything', async () => {
    const { d, calls } = deps();
    expect(await checkConnection({ harness: 'codex', method: 'key', key: KEY, baseUrl: 'file:///etc/passwd' }, d)).toMatchObject({ ok: false, state: 'bad_address' });
    expect(calls).toEqual([]);
    expect(modelsUrl('https://api.openai.com/v1')).toBe('https://api.openai.com/v1/models');
    expect(modelsUrl('not a url')).toBeNull();
  });

  it('DeepSeek Harness: installed first (it is its own program), then the key against DeepSeek\'s model list', async () => {
    expect(await checkConnection({ harness: 'dsh', method: 'key', key: KEY }, deps({ dshInstalled: () => false }).d)).toMatchObject({ ok: false, state: 'not_installed' });
    expect(await checkConnection({ harness: 'dsh', method: 'key', key: '' }, deps().d)).toMatchObject({ ok: false, state: 'no_key' });
    const { d, calls } = deps();
    expect(await checkConnection({ harness: 'dsh', method: 'key', key: KEY }, d)).toMatchObject({ ok: true, state: 'connected', message: 'Connected. DeepSeek accepted your key.' });
    expect(calls).toEqual([{ url: 'https://api.deepseek.com/models', headers: { Authorization: `Bearer ${KEY}` } }]);
    const refused = await checkConnection({ harness: 'dsh', method: 'key', key: KEY }, deps({}, [], 401).d);
    expect(refused).toMatchObject({ ok: false, state: 'key_rejected' });
    expect(refused.message).not.toContain(KEY);
  });
});
