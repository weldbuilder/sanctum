// The tags that exist today: [image: ...], [voice] / [voice:emotion], [gif: ...] and [sticker: name].
import { getSanctumConfig } from '../../config.js';
import { generateImage, imagegenOffered } from '../imagegen/index.js';
import { getVoiceService, isVoiceModeActive } from '../ws.js';
import { isVoiceEmotion, VOICE_EMOTIONS } from '../voice.js';
import { createMessage, updateThreadActivity } from '../db.js';
import { registry } from '../ws.js';
import { giphyOffered, search as giphySearch, configuredGifRating } from '../media/giphy.js';
import { countStickers, stickerByName, stickerNameList } from '../media/stickers.js';
import { getFile, readFileMeta } from '../files.js';
import { companionPath } from '../../tenancy/house.js';
import { ownStat } from '../../tenancy/own-files.js';
import { registerTag } from './index.js';
import { check as consentCheck } from '../consent/gate.js';

export const MAX_IMAGE_TAGS = 2;
export const MAX_GIF_TAGS = 2;
export const MAX_STICKER_TAGS = 2;
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
    if (!consentCheck('app_write', { harness: 'server', threadId: ctx.threadId, tool: '[image] tag', summary: tag.arg }).allow) return;
    await generateImage({ prompt: tag.arg.slice(0, 2000), postToChat: true, threadId: ctx.threadId, triggeredBy: 'tag' });
  },
});

registerTag('voice', {
  max: 1,
  startOnly: true,
  needsText: true,
  offered: voiceOffered,
  instruction: `[voice] at the very start of a reply sends it as a voice note too; [voice:${VOICE_EMOTIONS.join('|')}] sets how it is spoken.`,
  async run(tag, ctx) {
    const svc = getVoiceService();
    const text = ctx.text.trim();
    if (!svc?.canTTS || !text) return;
    // Voice mode already speaks every reply (ws.ts auto-TTS); a second voice note would play it twice.
    if (isVoiceModeActive('user')) return;
    if (text.length > MAX_VOICE_CHARS) { console.debug(`[Tags] voice: reply too long for a voice note (${text.length} chars)`); return; }
    if (!consentCheck('voice_out', { harness: 'server', threadId: ctx.threadId, tool: '[voice] tag', summary: text }).allow) return;
    const emotion = isVoiceEmotion(tag.arg.toLowerCase()) ? (tag.arg.toLowerCase() as typeof VOICE_EMOTIONS[number]) : undefined;
    await svc.generateTTSForMessage(text, ctx.threadId, { emotion, transcript: false });
  },
});

/** Post a companion message the tag produced, after the reply: stored, thread bumped, broadcast to every device. */
function postCompanionMedia(threadId: string, contentType: 'gif' | 'sticker', metadata: Record<string, unknown>): string {
  const now = new Date().toISOString();
  // Empty content on purpose: the bubble renders any non-empty content as text under the picture.
  const message = createMessage({ id: crypto.randomUUID(), threadId, role: 'companion', content: '', contentType, metadata, createdAt: now });
  updateThreadActivity(threadId, now, true);
  registry.broadcast({ type: 'message', message });
  return message.id;
}

function safeCount(): number { try { return countStickers(); } catch { return 0; } }

registerTag('gif', {
  max: MAX_GIF_TAGS,
  requiresArg: true,
  offered: giphyOffered,
  instruction: '[gif: a few words] sends a gif that fits the moment; at most two.',
  async run(tag, ctx) {
    const term = tag.arg.slice(0, 100);
    let results;
    try { results = await giphySearch(term, { limit: 1, rating: configuredGifRating() }); }
    catch (e) { console.debug(`[Tags] gif: search failed (${e instanceof Error ? e.message : 'error'})`); return; }
    const pick = results[0];
    if (!pick) { console.debug('[Tags] gif: no results'); return; }
    postCompanionMedia(ctx.threadId, 'gif', { gif_url: pick.url, gif_title: pick.title, gif_preview: pick.preview, source: 'giphy', query: term });
  },
});

registerTag('sticker', {
  max: MAX_STICKER_TAGS,
  requiresArg: true,
  offered: () => safeCount() > 0,
  get instruction() { return `[sticker: name] sends one of your stickers (${stickerNameList()}); use only these names; at most two.`; },
  async run(tag, ctx) {
    const sticker = stickerByName(tag.arg);
    if (!sticker) { console.debug('[Tags] sticker: no such sticker'); return; }
    const file = getFile(sticker.file_id);
    if (!file) { console.debug('[Tags] sticker: its file is gone'); return; }
    const filename = readFileMeta(sticker.file_id)?.filename || file.filename;
    postCompanionMedia(ctx.threadId, 'sticker', {
      attachments: [{ fileId: sticker.file_id, filename, contentType: 'image', url: companionPath(`/api/files/${sticker.file_id}`), mimeType: file.mimeType, size: ownStat(file.path).size }],
      sticker_name: sticker.name,
    });
  },
});
