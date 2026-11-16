// The expression-tag runners are server-side sends too: [voice] is voice_out, [image: ...] is app_write.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ tts: [] as string[], images: [] as string[] }));
vi.mock('../embeddings.js', () => ({ embed: vi.fn().mockResolvedValue(new Float32Array(384)), vectorToBuffer: vi.fn().mockReturnValue(Buffer.alloc(384 * 4)) }));
vi.mock('../vector-cache.js', () => ({ cacheEmbedding: vi.fn(), removeEmbedding: vi.fn() }));
vi.mock('../../config.js', () => ({ getSanctumConfig: () => ({ identity: { timezone: 'UTC' }, voice: { enabled: true }, server: { db_path: ':memory:' }, agent: { cwd: '/tmp/home' } }), PROJECT_ROOT: '/tmp/test' }));
vi.mock('../imagegen/index.js', () => ({ generateImage: async (o: any) => { h.images.push(o.prompt); }, imagegenOffered: () => true }));
vi.mock('../ws.js', () => ({ getVoiceService: () => ({ canTTS: true, generateTTSForMessage: async (t: string) => { h.tts.push(t); } }), isVoiceModeActive: () => false }));

import './builtin.js';
import { getTagDef } from './index.js';
import { initDb, getDb } from '../db.js';
import { grant, setMode, turnOff } from '../consent/gate.js';

const run = async (name: string, arg: string, text = 'a reply') => { const t: any = getTagDef(name); await t.run({ arg }, { threadId: 'T1', text }); };
beforeEach(() => { initDb(':memory:'); h.tts = []; h.images = []; vi.spyOn(console, 'debug').mockImplementation(() => {}); });

describe('[voice] tag', () => {
  it('on: speaks, with a receipt; off: silent, with a denied receipt; guard: only with a window', async () => {
    await run('voice', '');
    expect(h.tts).toEqual(['a reply']);
    turnOff('voice_out');
    await run('voice', '');
    expect(h.tts).toEqual(['a reply']);
    expect(getDb().prepare("SELECT outcome, thread_id, tool_or_route FROM consent_receipts WHERE capability = 'voice_out' AND outcome IN ('allowed','denied') ORDER BY id").all())
      .toEqual([{ outcome: 'allowed', thread_id: 'T1', tool_or_route: '[voice] tag' }, { outcome: 'denied', thread_id: 'T1', tool_or_route: '[voice] tag' }]);
    setMode('guard');
    await run('voice', '');
    expect(h.tts.length).toBe(1);
    grant('voice_out', 15);
    await run('voice', '');
    expect(h.tts.length).toBe(2);
  });
});

describe('[image: ...] tag', () => {
  it('on: generates; app_write off: nothing is generated', async () => {
    await run('image', 'a cat');
    expect(h.images).toEqual(['a cat']);
    turnOff('app_write');
    await run('image', 'a dog');
    expect(h.images).toEqual(['a cat']);
  });
  it('guard mode: only with an app_write window', async () => {
    setMode('guard');
    await run('image', 'a cat');
    expect(h.images).toEqual([]);
    grant('app_write', 30);
    await run('image', 'a cat');
    expect(h.images).toEqual(['a cat']);
  });
});
