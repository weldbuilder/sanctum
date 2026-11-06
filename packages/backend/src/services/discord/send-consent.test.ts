// outward_discord: the consent gate is asked on every send, before the word gate and the name guard.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { rulesFromText } from './gate.js';

vi.mock('../embeddings.js', () => ({ embed: vi.fn().mockResolvedValue(new Float32Array(384)), vectorToBuffer: vi.fn().mockReturnValue(Buffer.alloc(384 * 4)) }));
vi.mock('../vector-cache.js', () => ({ cacheEmbedding: vi.fn(), removeEmbedding: vi.fn() }));
vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  const cfg = { identity: { timezone: 'UTC' }, server: { db_path: ':memory:' }, agent: { cwd: '/tmp/home' }, discord: actual.normalizeDiscordConfig({}, '/tmp/home', { warn: () => {} }) };
  return { ...actual, getSanctumConfig: () => cfg };
});

import { createSender, sendGated, type SendRuntime } from './send.js';
import { initDb, getDb } from '../db.js';
import { check, grant, setMode, turnOff } from '../consent/gate.js';

beforeEach(() => { initDb(':memory:'); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
const channel = () => ({ send: vi.fn(async (p: unknown) => ({ id: 's', p })) });
const receipts = () => getDb().prepare("SELECT capability, outcome, harness, tool_or_route FROM consent_receipts WHERE outcome IN ('allowed','denied','expired') ORDER BY id").all() as any[];

describe('createSender with the consent hook', () => {
  const words = vi.fn(() => rulesFromText('Maple Street\n'));
  const runtime = (consent: SendRuntime['consent']): SendRuntime => ({ isPaused: () => false, isPublicEnabled: () => true, words, names: () => null, log: () => {}, chunkDelayMs: 0, consent });
  beforeEach(() => words.mockClear());

  it('refused: nothing is sent, the word gate is not even read, and the reason names Settings → Permissions', async () => {
    const send = createSender(runtime(() => ({ allow: false, reason: 'Discord sending is turned off' })));
    const ch = channel();
    const r = await send({ kind: 'channel', channel: ch }, 'Hello', 'owner');
    expect(r).toMatchObject({ sent: false, reason: 'consent_off', error: 'Discord sending is turned off (Settings → Permissions).' });
    expect(ch.send).not.toHaveBeenCalled();
    expect(words).not.toHaveBeenCalled();
  });
  it('allowed: goes on to the word gate and out', async () => {
    const ch = channel();
    const r = await createSender(runtime(() => ({ allow: true, reason: '' })))({ kind: 'channel', channel: ch }, 'Hello', 'owner');
    expect(r.sent).toBe(true);
    expect(words).toHaveBeenCalled();
  });
  it('is asked for the public lane as well, with the lane and the text', async () => {
    const consent = vi.fn(() => ({ allow: true, reason: '' }));
    await createSender(runtime(consent))({ kind: 'channel', channel: channel() }, 'Hello', 'public');
    expect(consent).toHaveBeenCalledWith('public', 'Hello');
  });
  it('the other word-bearing calls (topic, thread name, presence) are refused the same way, and run() is never called', async () => {
    const run = vi.fn();
    const r = await createSender(runtime(() => ({ allow: false, reason: 'Discord sending is turned off' })) ).action({ lane: 'owner', text: 'new topic', run });
    expect(r).toMatchObject({ sent: false, reason: 'consent_off' });
    expect(run).not.toHaveBeenCalled();
  });
  it('a runtime without the hook (tests, older callers) is not asked', async () => {
    const ch = channel();
    expect((await createSender(runtime(undefined))({ kind: 'channel', channel: ch }, 'Hello', 'owner')).sent).toBe(true);
  });
});

describe('the app\'s own sender (sendGated) against the real gate', () => {
  it('switched off: refused with consent_off and a denied receipt; nothing reaches the channel', async () => {
    turnOff('outward_discord');
    const ch = channel();
    const r = await sendGated({ kind: 'channel', channel: ch }, 'Hello', 'owner');
    expect(r).toMatchObject({ sent: false, reason: 'consent_off' });
    expect(ch.send).not.toHaveBeenCalled();
    expect(receipts()).toEqual([{ capability: 'outward_discord', outcome: 'denied', harness: 'server', tool_or_route: 'discord owner send' }]);
  });
  it('guard mode without a grant: refused; with a window: past the consent step', async () => {
    setMode('guard');
    expect((await sendGated({ kind: 'channel', channel: channel() }, 'Hello', 'owner')).reason).toBe('consent_off');
    grant('outward_discord', 15);
    const r = await sendGated({ kind: 'channel', channel: channel() }, 'Hello', 'owner');
    expect(r.reason).not.toBe('consent_off'); // (the word gate has no list in this test, so it answers for itself)
    expect(receipts().map((x) => x.outcome)).toEqual(['denied', 'allowed']);
  });
  it('open mode: asked, allowed, receipt written', async () => {
    const r = await sendGated({ kind: 'channel', channel: channel() }, 'Hello', 'owner');
    expect(r.reason).not.toBe('consent_off');
    expect(check('outward_discord', { harness: 'x' }).allow).toBe(true);
    expect(receipts()[0]).toMatchObject({ capability: 'outward_discord', outcome: 'allowed' });
  });
});
