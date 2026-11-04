import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../config.js', () => ({ getSanctumConfig: () => ({ voice: { enabled: true, elevenlabs_voice_id: 'v' } }) }));
vi.mock('./files.js', () => ({ saveFile: vi.fn(() => ({ fileId: 'f', filename: 'voice-note.mp3', url: '/u', size: 3 })) }));
const msgs: any[] = [];
vi.mock('./db.js', () => ({ createMessage: (m: any) => { msgs.push(m); return m; }, updateThreadActivity: vi.fn() }));
vi.mock('./ws.js', () => ({ registry: { broadcast: vi.fn() } }));

import { VoiceService, VOICE_EMOTIONS, isVoiceEmotion } from './voice.js';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); msgs.length = 0; });

describe('voice emotion', () => {
  it('maps each emotion to the one ElevenLabs lever the path has (stability); no emotion keeps 0.5', async () => {
    vi.stubEnv('ELEVENLABS_API_KEY', 'k'); vi.stubEnv('ELEVENLABS_VOICE_ID', 'v');
    const bodies: any[] = [];
    vi.stubGlobal('fetch', async (_u: string, init: RequestInit) => { bodies.push(JSON.parse(init.body as string)); return new Response(Buffer.from('mp3')); });
    const svc = new VoiceService();
    await svc.generateTTS('hi');
    for (const e of VOICE_EMOTIONS) await svc.generateTTS('hi', { emotion: e });
    expect(bodies.map((b) => b.voice_settings.stability)).toEqual([0.5, 0, 0.5, 1]);
    expect(VOICE_EMOTIONS).toEqual(['playful', 'warm', 'calm']);
    expect(isVoiceEmotion('furious')).toBe(false);
  });

  it('transcript:false posts the voice note with empty content; the default keeps the transcript', async () => {
    vi.stubEnv('ELEVENLABS_API_KEY', 'k'); vi.stubEnv('ELEVENLABS_VOICE_ID', 'v');
    vi.stubGlobal('fetch', async () => new Response(Buffer.from('mp3')));
    const svc = new VoiceService();
    await svc.generateTTSForMessage('words', 't1');
    await svc.generateTTSForMessage('words', 't1', { transcript: false });
    expect(msgs.map((m) => m.content)).toEqual(['words', '']);
  });
});
