// The tags that exist today: [image: ...] and [voice] / [voice:emotion]. Later rounds register [gif:] and [sticker:] here.
import { getSanctumConfig } from '../../config.js';
import { generateImage, imagegenOffered } from '../imagegen/index.js';
import { getVoiceService } from '../ws.js';
import { isVoiceEmotion, VOICE_EMOTIONS } from '../voice.js';
import { registerTag } from './index.js';

export const MAX_IMAGE_TAGS = 2;
const MAX_VOICE_CHARS = 4500;

function voiceOffered(): boolean {
  try { return !!getSanctumConfig().voice?.enabled && !!getVoiceService()?.canTTS; } catch { return false; }
}

registerTag('image', {
  max: MAX_IMAGE_TAGS,
  requiresArg: true,
  offered: imagegenOffered,
  instruction: '[image: a short visual description] generates a picture and sends it after this message. Use it when a picture says it better; at most two per reply.',
  async run(tag, ctx) {
    await generateImage({ prompt: tag.arg.slice(0, 2000), postToChat: true, threadId: ctx.threadId, triggeredBy: 'tag' });
  },
});

registerTag('voice', {
  max: 1,
  startOnly: true,
  offered: voiceOffered,
  instruction: `[voice] at the very start of a reply sends it as a voice note too; [voice:${VOICE_EMOTIONS.join('|')}] sets how it is spoken.`,
  async run(tag, ctx) {
    const svc = getVoiceService();
    const text = ctx.text.trim();
    if (!svc?.canTTS || !text) return;
    if (text.length > MAX_VOICE_CHARS) { console.debug(`[Tags] voice: reply too long for a voice note (${text.length} chars)`); return; }
    const emotion = isVoiceEmotion(tag.arg.toLowerCase()) ? (tag.arg.toLowerCase() as typeof VOICE_EMOTIONS[number]) : undefined;
    await svc.generateTTSForMessage(text, ctx.threadId, { emotion, transcript: false });
  },
});
