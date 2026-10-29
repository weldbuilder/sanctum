// Thread routing (D3 removed): the owner channel maps to ONE stable Sanctum thread; the public lane
// gets a per-channel thread marked lane: public, which pass B2 will replace with a file transcript.
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { getDiscordThreadId } from './utils.js';
import { isLegacyPublicThread, ownerThreadId, resolveOwnerThread, type ThreadStore } from './threads.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function store(existing: string[] = []) {
  const ids = new Set(existing);
  const created: Array<{ id: string; name: string }> = [];
  const s: ThreadStore = {
    exists: (id) => ids.has(id),
    create: (id, name) => { ids.add(id); created.push({ id, name }); },
  };
  return { s, created, ids };
}

describe('ownerThreadId', () => {
  it('is discord-owner-<sha256(channelId) first 12 hex>', () => {
    expect(ownerThreadId('222')).toBe(`discord-owner-${sha('222').slice(0, 12)}`);
    expect(ownerThreadId('222')).toBe(ownerThreadId('222'));
    expect(ownerThreadId('222')).not.toBe(ownerThreadId('223'));
  });
});

describe('resolveOwnerThread: one stable thread, created on first use, never split', () => {
  it('creates discord-owner-<hash> the first time and finds it after', () => {
    const { s, created } = store();
    const a = resolveOwnerThread(s, '222');
    expect(a).toMatchObject({ id: ownerThreadId('222'), created: true, legacy: false });
    expect(created).toHaveLength(1);
    const b = resolveOwnerThread(s, '222');
    expect(b).toMatchObject({ id: a.id, created: false });
    expect(created).toHaveLength(1);
  });
  it('the same thread for every message and every day: nothing in the id depends on the message or the date', () => {
    const { s } = store();
    expect(new Set([1, 2, 3].map(() => resolveOwnerThread(s, '222').id)).size).toBe(1);
  });
  it('keeps using an older discord-<channelId> thread rather than making a second', () => {
    const { s, created } = store(['discord-222']);
    expect(resolveOwnerThread(s, '222')).toMatchObject({ id: 'discord-222', created: false, legacy: true });
    expect(created).toEqual([]);
  });
  it('keeps using the older channel-mapped thread id the pre-lane module made', () => {
    const legacy = getDiscordThreadId('222');
    const { s, created } = store([legacy]);
    expect(resolveOwnerThread(s, '222')).toMatchObject({ id: legacy, created: false, legacy: true });
    expect(created).toEqual([]);
  });
  it('the canonical thread wins when both it and an older one exist', () => {
    const { s } = store([ownerThreadId('222'), 'discord-222']);
    expect(resolveOwnerThread(s, '222').id).toBe(ownerThreadId('222'));
  });
  it('another channel never picks up this channel\'s thread', () => {
    const { s } = store(['discord-222']);
    expect(resolveOwnerThread(s, '999').id).toBe(ownerThreadId('999'));
  });
});

describe('there is no public thread any more (the public lane is a file transcript)', () => {
  it('threads.ts exports no public-thread routing and no lane mark', async () => {
    const mod: Record<string, unknown> = await import('./threads.js');
    expect(mod.resolvePublicThread).toBeUndefined();
    expect(mod.publicThreadId).toBeUndefined();
    expect(Object.keys(mod).sort()).toEqual(['isLegacyPublicThread', 'ownerThreadId', 'resolveOwnerThread']);
  });
  it('the owner resolver marks no lane: the store has no setLane to call', () => {
    const calls: string[] = [];
    const s = { exists: () => false, create: (id: string) => { calls.push(id); } } as any;
    expect(() => resolveOwnerThread(s, '222')).not.toThrow();
    expect(calls).toHaveLength(1);
  });
  it('isLegacyPublicThread recognises the B1 discord-public-<guild>-<hash> ids, and nothing else', () => {
    expect(isLegacyPublicThread(`discord-public-500-${sha('600').slice(0, 12)}`)).toBe(true);
    expect(isLegacyPublicThread(ownerThreadId('222'))).toBe(false);
    expect(isLegacyPublicThread('discord-222')).toBe(false);
  });
});
