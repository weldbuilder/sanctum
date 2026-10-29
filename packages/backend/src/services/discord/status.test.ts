import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeDiscordConfig } from '../../config.js';
import { RuleSource } from './gate.js';
import { buildDiscordStatus } from './status.js';

const tmp = mkdtempSync(join(tmpdir(), 'sanctum-dstatus-test-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const cfg = (raw: unknown = {}) => normalizeDiscordConfig(raw, '/srv/home', { warn: () => {} });
const paths = { privateDir: '/srv/sanctum-private', wordsFile: '/srv/sanctum-private/words.txt', namesFile: '', exclusionsFile: '', refused: [] as Array<{ key: string; path: string; clash: string }> };
const loaded = { state: 'loaded', entries: 9 } as const;
const failed = { state: 'failed', kind: 'missing' } as const;
const off = { state: 'off' } as const;

describe('buildDiscordStatus', () => {
  it('a fresh install: everything off, public closed, gate state shown', () => {
    const s = buildDiscordStatus(cfg(), paths, { words: loaded, names: off });
    expect(s.lanes.owner.state).toBe('off');
    expect(s.lanes.public.state).toBe('off');
    expect(s.paused).toBe(false);
    expect(s.privateDir).toEqual({ configured: true, refused: false });
    expect(s.gate).toEqual({ words: loaded, names: off });
  });

  it('owner lane needs both ids', () => {
    expect(buildDiscordStatus(cfg({ enabled: true }), paths, { words: loaded, names: off }).lanes.owner.state).toBe('unconfigured');
    expect(buildDiscordStatus(cfg({ enabled: true, owner: { user_id: '1' } }), paths, { words: loaded, names: off }).lanes.owner.state).toBe('unconfigured');
    expect(buildDiscordStatus(cfg({ enabled: true, owner: { user_id: '1', channel_id: '2' } }), paths, { words: loaded, names: off }).lanes.owner.state).toBe('on');
  });

  it('public lane: on, paused, or blocked by a failed gate; counts guilds, never lists them', () => {
    const base = { enabled: true, owner: { user_id: '1', channel_id: '2' }, public: { enabled: true, guild_ids: ['10', '11'], bots: 'capped' } };
    const on = buildDiscordStatus(cfg(base), paths, { words: loaded, names: off });
    expect(on.lanes.public).toMatchObject({ state: 'on', guilds: 2, bots: 'capped' });
    expect(JSON.stringify(on)).not.toMatch(/"10"|"11"/);
    expect(buildDiscordStatus(cfg({ ...base, paused: true }), paths, { words: loaded, names: off }).lanes.public.state).toBe('paused');
    const blocked = buildDiscordStatus(cfg(base), paths, { words: failed, names: off });
    expect(blocked.lanes.public.state).toBe('blocked');
    expect(blocked.lanes.owner.state).toBe('blocked');
  });

  it('the public lane is blocked, not on, when its exclusions file cannot be loaded; the owner lane is not', () => {
    const base = { enabled: true, owner: { user_id: '1', channel_id: '2' }, public: { enabled: true, guild_ids: ['10'] } };
    const s = buildDiscordStatus(cfg(base), paths, { words: loaded, names: off }, { exclusions: { state: 'failed', kind: 'missing' } });
    expect(s.lanes.public.state).toBe('blocked');
    expect(s.lanes.owner.state).toBe('on');
    expect(s.exclusions).toEqual({ state: 'failed', kind: 'missing' });
    expect(buildDiscordStatus(cfg(base), paths, { words: loaded, names: off }, { exclusions: { state: 'loaded' } }).lanes.public.state).toBe('on');
    // public off stays off whatever the file says
    expect(buildDiscordStatus(cfg({ ...base, public: { enabled: false } }), paths, { words: loaded, names: off }, { exclusions: { state: 'failed', kind: 'malformed' } }).lanes.public.state).toBe('off');
  });

  // B-1 (Codex): the public lane is refused on that harness, and the status says so.
  it("public.state is 'unsupported_harness' when the public lane is on but the harness cannot run it (Codex)", () => {
    const base = { enabled: true, owner: { user_id: '1', channel_id: '2' }, public: { enabled: true, guild_ids: ['10'] } };
    const s = buildDiscordStatus(cfg(base), paths, { words: loaded, names: off }, { publicHarnessSupported: false });
    expect(s.lanes.public.state).toBe('unsupported_harness');
    expect(s.lanes.owner.state).toBe('on'); // the owner lane has tools and a thread; it is not affected
    // it outranks pause and a failed gate: the lane cannot run at all, so say that
    expect(buildDiscordStatus(cfg({ ...base, paused: true }), paths, { words: failed, names: off }, { publicHarnessSupported: false }).lanes.public.state).toBe('unsupported_harness');
    // supported, or not said: unchanged
    expect(buildDiscordStatus(cfg(base), paths, { words: loaded, names: off }, { publicHarnessSupported: true }).lanes.public.state).toBe('on');
    expect(buildDiscordStatus(cfg(base), paths, { words: loaded, names: off }).lanes.public.state).toBe('on');
    // off stays off: there is nothing to refuse
    expect(buildDiscordStatus(cfg({ ...base, public: { enabled: false } }), paths, { words: loaded, names: off }, { publicHarnessSupported: false }).lanes.public.state).toBe('off');
  });

  it('paused is reported even when the public lane is off', () => {
    expect(buildDiscordStatus(cfg({ paused: true }), paths, { words: loaded, names: off }).paused).toBe(true);
  });

  it('reports a refused private folder by key, never by path', () => {
    const s = buildDiscordStatus(cfg(), { ...paths, privateDir: '', refused: [{ key: 'discord.private_dir', path: '/srv/home/p', clash: 'agent.cwd' }] }, { words: failed, names: failed });
    expect(s.privateDir).toEqual({ configured: false, refused: true, clash: 'agent.cwd' });
    expect(s.refused).toEqual([{ key: 'discord.private_dir', clash: 'agent.cwd' }]);
    expect(JSON.stringify(s)).not.toMatch(/\/srv\//);
  });

  it('carries no absolute path anywhere, and gate errors are kinds', () => {
    const s = buildDiscordStatus(cfg({ enabled: true }), paths, { words: { state: 'failed', kind: 'malformed' }, names: { state: 'failed', kind: 'refused' } });
    expect(s.gate).toEqual({ words: { state: 'failed', kind: 'malformed' }, names: { state: 'failed', kind: 'refused' } });
    expect(JSON.stringify(s)).not.toMatch(/\/srv|\/x\b|words\.txt/);
  });

  it('the owner lane counts the DB override discord.ownerUserId as well as yaml', () => {
    const raw = { enabled: true, owner: { channel_id: '2' } };
    expect(buildDiscordStatus(cfg(raw), paths, { words: loaded, names: off }).lanes.owner.state).toBe('unconfigured');
    const s = buildDiscordStatus(cfg(raw), paths, { words: loaded, names: off }, { ownerUserIdOverride: '77' });
    expect(s.lanes.owner).toMatchObject({ state: 'on', userIdSet: true, channelIdSet: true });
    expect(JSON.stringify(s)).not.toContain('77');
  });

  it('says which lane an event lands in by channel: the owner channel is configured or not', () => {
    const s = buildDiscordStatus(cfg({ enabled: true, owner: { user_id: '1' } }), paths, { words: loaded, names: off });
    expect(s.lanes.owner).toMatchObject({ channelIdSet: false, state: 'unconfigured' });
  });

  it('never carries an entry, from a real list', () => {
    const f = join(tmp, 'words.txt');
    writeFileSync(f, 'Zanzibar Quokka\nre:ZZ-secret-\\d+\n');
    const words = new RuleSource({ path: () => f, what: 'word list' }).status();
    const s = buildDiscordStatus(cfg({ enabled: true }), paths, { words, names: off });
    expect(s.gate.words).toEqual({ state: 'loaded', entries: 2 });
    expect(JSON.stringify(s)).not.toMatch(/Zanzibar|Quokka|secret/);
  });
});

describe('buildDiscordStatus: recentFailures (D11)', () => {
  it('empty by default, and carries the summary it is handed (kinds and times only)', () => {
    expect(buildDiscordStatus(cfg(), paths, { words: loaded, names: off }).recentFailures).toEqual({ count24h: 0, lastKind: null, lastAt: null });
    const recent = { count24h: 4, lastKind: 'gate_error', lastAt: '2026-10-19T10:00:00.000Z' };
    expect(buildDiscordStatus(cfg(), paths, { words: loaded, names: off }, { recentFailures: recent }).recentFailures).toEqual(recent);
  });
});
