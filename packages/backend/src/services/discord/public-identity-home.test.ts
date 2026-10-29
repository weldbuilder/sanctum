// The public lane's identity comes from the companion home's identity folder through the one reader
// (services/identity/source.ts), with the real loader and renderer: no stubs for identity here.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'sanctum-public-home-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const h = vi.hoisted(() => ({ calls: [] as any[], ledgerDir: '' }));

vi.mock('../providers/index.js', () => ({
  activeProvider: () => 'claude',
  AbortError: class AbortError extends Error {},
  query: (p: any) => {
    h.calls.push(p);
    return (async function* () {
      yield { type: 'assistant', session_id: 's1', message: { content: [{ type: 'text', text: 'hi' }] } };
      yield { type: 'result', subtype: 'success', session_id: 's1', result: 'hi' };
    })();
  },
}));
vi.mock('../../config.js', () => ({
  getSanctumConfig: () => ({
    identity: { companion_name: 'Hazel', user_name: 'Pat', timezone: 'UTC', profile_path: '', companion_md_path: '', ledger_dir: h.ledgerDir },
    agent: { cwd: join(tmp, 'home'), claude_md_path: join(tmp, 'home', 'CLAUDE.md'), model: 'claude-sonnet-5-5' },
    server: { db_path: join(tmp, 'sanctum.db') },
    discord: { public: {} },
  }),
}));
vi.mock('../auth-preferences.js', () => ({ applyAuthToEnv: () => {}, effectiveModel: (_k: string, d: string) => d, getAuthPreferences: () => ({}) }));

import { runPublicTurn, resetIdentityWarning } from './public-runtime.js';
import { ratifyIdentity } from '../identity/ledger.js';

const base = { guildId: '500', channelId: '600', speaker: { id: '333', displayName: 'Moss', username: 'moss', bot: false }, text: 'hey' };
const home = () => join(tmp, 'home');

beforeEach(() => {
  h.calls = [];
  h.ledgerDir = join(tmp, 'ledger');
  rmSync(h.ledgerDir, { recursive: true, force: true });
  rmSync(join(tmp, 'discord'), { recursive: true, force: true });
  rmSync(home(), { recursive: true, force: true });
  mkdirSync(home(), { recursive: true });
  resetIdentityWarning();
});

describe('the public lane reads the home identity folder', () => {
  it("says who she is from identity/profile.md and identity/companion.md in the home", async () => {
    mkdirSync(join(home(), 'identity'));
    writeFileSync(join(home(), 'identity', 'profile.md'), 'Hazel lives in the garden.');
    writeFileSync(join(home(), 'identity', 'companion.md'), 'I am Hazel, and I stay myself.');
    await runPublicTurn(base);
    const sys = String(h.calls[0].options.systemPrompt);
    expect(sys).toContain('Hazel lives in the garden.');
    expect(sys).toContain('I am Hazel, and I stay myself.');
  });

  it('is silent with no identity folder, even when the home has a legacy CLAUDE.md', async () => {
    writeFileSync(join(home(), 'CLAUDE.md'), 'LEGACY: the owner lives at 12 Maple Street.');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(runPublicTurn(base)).rejects.toMatchObject({ kind: 'identity_missing' });
    warn.mockRestore();
    expect(h.calls).toHaveLength(0);
  });

  it('serves the ratified identity while a change waits, without telling the channel anything about it', async () => {
    mkdirSync(join(home(), 'identity'));
    writeFileSync(join(home(), 'identity', 'companion.md'), 'I am Hazel, and I stay myself.');
    ratifyIdentity(home(), { ledgerDir: h.ledgerDir, trustStat: false }, { by: 'person' });
    writeFileSync(join(home(), 'identity', 'companion.md'), 'HOSTILE REWRITE');
    await runPublicTurn(base);
    const sys = String(h.calls[0].options.systemPrompt);
    expect(sys).toContain('I am Hazel, and I stay myself.');
    expect(sys).not.toContain('HOSTILE REWRITE');
    expect(sys).not.toContain('waiting for the person');
  });
});
