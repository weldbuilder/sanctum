// Voice services — Groq Whisper STT + ElevenLabs TTS + Hume Prosody
// No new npm dependencies — uses raw fetch for all APIs

import crypto from 'crypto';
import { saveFile } from './files.js';
import { createMessage, updateThreadActivity } from './db.js';
import { registry } from './ws.js';
import { getSanctumConfig } from '../config.js';
import { envFor } from '../tenancy/context.js';

const GROQ_WHISPER_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const ELEVENLABS_BASE = 'https://api.elevenlabs.io/v1/text-to-speech';
const HUME_BATCH_URL = 'https://api.hume.ai/v0/batch/jobs';

export class VoiceService {
  private groqKey: string | undefined;
  private elevenLabsKey: string | undefined;
  private elevenLabsVoiceId: string | undefined;
  private humeApiKey: string | undefined;

  constructor() {
    const config = getSanctumConfig();
    // The keys come from the environment of whoever this service belongs to: process.env, or in tenant mode that tenant's own .env (never
    // the process's), so one tenant's voice is paid for and keyed by that tenant alone.
    const env = envFor('the voice keys');

    this.groqKey = env.GROQ_API_KEY || undefined;
    this.elevenLabsKey = env.ELEVENLABS_API_KEY || undefined;
    this.elevenLabsVoiceId = env.ELEVENLABS_VOICE_ID || config.voice.elevenlabs_voice_id || undefined;
    this.humeApiKey = env.HUME_API_KEY || undefined;

    if (!this.groqKey) {
      console.warn('[Voice] GROQ_API_KEY not set — transcription not configured');
    }
    if (!this.elevenLabsKey) {
      console.warn('[Voice] ELEVENLABS_API_KEY not set — TTS not configured');
    } else if (!this.elevenLabsVoiceId) {
      console.warn('[Voice] ELEVENLABS_VOICE_ID not set — TTS not configured');
    }
    if (!this.humeApiKey) {
      console.warn('[Voice] HUME_API_KEY not set — prosody analysis not configured');
    }
  }

  get canTranscribe(): boolean {
    return !!this.groqKey;
  }

  get canTTS(): boolean {
    return !!this.elevenLabsKey && !!this.elevenLabsVoiceId;
  }

  get canAnalyzeProsody(): boolean {
    return !!this.humeApiKey;
  }

  /**
   * Transcribe audio buffer using Groq-hosted Whisper API.
   * Same OpenAI-compatible format, free tier.
   * Returns the transcript text.
   */
  async transcribe(audioBuffer: Buffer, mimeType: string): Promise<string> {
    if (!this.groqKey) {
      throw new Error('GROQ_API_KEY not configured — cannot transcribe');
    }

    // Determine file extension from mime type
    const extMap: Record<string, string> = {
      'audio/webm': 'webm',
      'audio/webm;codecs=opus': 'webm',
      'audio/mp4': 'm4a',
      'audio/mpeg': 'mp3',
      'audio/ogg': 'ogg',
      'audio/wav': 'wav',
    };
    // Normalize mime — strip codec params for lookup
    const baseMime = mimeType.split(';')[0].trim();
    const ext = extMap[baseMime] || 'webm';

    // Build multipart form data manually for fetch
    const boundary = `----FormBoundary${crypto.randomUUID().replace(/-/g, '')}`;
    const filename = `recording.${ext}`;

    const preamble = [
      `--${boundary}`,
      `Content-Disposition: form-data; name="file"; filename="${filename}"`,
      `Content-Type: ${baseMime}`,
      '',
      '',
    ].join('\r\n');

    const model = [
      '',
      `--${boundary}`,
      'Content-Disposition: form-data; name="model"',
      '',
      'whisper-large-v3-turbo',
      `--${boundary}`,
      'Content-Disposition: form-data; name="language"',
      '',
      'en',
      `--${boundary}--`,
      '',
    ].join('\r\n');

    const body = Buffer.concat([
      Buffer.from(preamble),
      audioBuffer,
      Buffer.from(model),
    ]);

    const response = await fetch(GROQ_WHISPER_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.groqKey}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Groq Whisper API error ${response.status}: ${errText}`);
    }

    const result = await response.json() as { text: string };
    return result.text || '';
  }

  /**
   * Analyze prosody (emotional tone) from audio using Hume AI batch API.
   * Returns top 5 emotions by relative rank, or null on failure.
   * Flow: submit job -> poll until complete -> extract predictions.
   */
  async analyzeProsody(audioBuffer: Buffer, mimeType: string, signal?: AbortSignal): Promise<Record<string, number> | null> {
    if (!this.humeApiKey) return null;

    const baseMime = mimeType.split(';')[0].trim();
    const extMap: Record<string, string> = {
      'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3',
      'audio/ogg': 'ogg', 'audio/wav': 'wav',
    };
    const ext = extMap[baseMime] || 'webm';
    const boundary = `----HumeBoundary${crypto.randomUUID().replace(/-/g, '')}`;

    // Build multipart: file + JSON config requesting prosody model
    const filePart = [
      `--${boundary}`,
      `Content-Disposition: form-data; name="file"; filename="recording.${ext}"`,
      `Content-Type: ${baseMime}`,
      '', '',
    ].join('\r\n');

    const jsonConfig = JSON.stringify({ models: { prosody: {} } });
    const jsonPart = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="json"',
      'Content-Type: application/json',
      '', jsonConfig,
      `--${boundary}--`, '',
    ].join('\r\n');

    const body = Buffer.concat([
      Buffer.from(filePart), audioBuffer, Buffer.from('\r\n' + jsonPart),
    ]);

    // Step 1: Submit batch job
    if (signal?.aborted) return null;
    const submitRes = await fetch(HUME_BATCH_URL, {
      method: 'POST',
      headers: {
        'X-Hume-Api-Key': this.humeApiKey,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
      signal,
    });

    if (!submitRes.ok) {
      const errText = await submitRes.text();
      console.error(`[Hume] Job submit failed ${submitRes.status}: ${errText}`);
      return null;
    }

    const { job_id } = await submitRes.json() as { job_id: string };
    console.log(`[Hume] Job submitted: ${job_id}`);

    // Step 2: Poll for completion (max ~30s, 1s intervals)
    const maxPolls = 30;
    for (let i = 0; i < maxPolls; i++) {
      if (signal?.aborted) return null;
      await new Promise(r => setTimeout(r, 1000));
      if (signal?.aborted) return null;

      const statusRes = await fetch(`${HUME_BATCH_URL}/${job_id}`, {
        headers: { 'X-Hume-Api-Key': this.humeApiKey },
        signal,
      });

      if (!statusRes.ok) continue;

      const statusBody = await statusRes.json() as any;
      const jobStatus = statusBody.state?.status;
      console.log(`[Hume] Poll ${i + 1}/${maxPolls}: status=${jobStatus}`);

      if (jobStatus === 'COMPLETED') {
        // Step 3: Get predictions
        const predRes = await fetch(`${HUME_BATCH_URL}/${job_id}/predictions`, {
          headers: { 'X-Hume-Api-Key': this.humeApiKey },
          signal,
        });

        if (!predRes.ok) {
          const errBody = await predRes.text();
          console.error(`[Hume] Predictions fetch failed: ${predRes.status} — ${errBody}`);
          return null;
        }

        const predictions = await predRes.json() as any[];
        console.log(`[Hume] Predictions response keys: ${JSON.stringify(predictions?.map((p: any) => Object.keys(p)))}`);
        return this.extractProsodyScores(predictions);
      }

      if (jobStatus === 'FAILED') {
        console.error(`[Hume] Job failed. Full status: ${JSON.stringify(statusBody)}`);
        return null;
      }
    }

    console.warn('[Hume] Job timed out after 30s polling');
    return null;
  }

  /**
   * Extract top prosody scores from Hume batch predictions response.
   * Averages across all segments, returns emotions with score > 0.3.
   */
  private extractProsodyScores(predictions: any[]): Record<string, number> | null {
    try {
      // Navigate: predictions[0].results.predictions[0].models.prosody.grouped_predictions[0].predictions[*].emotions
      const file = predictions?.[0];
      const results = file?.results?.predictions;
      if (!results?.length) {
        console.warn(`[Hume] No results in predictions. Top-level keys: ${JSON.stringify(Object.keys(file || {}))}`);
        if (file?.results) console.warn(`[Hume] results keys: ${JSON.stringify(Object.keys(file.results))}`);
        return null;
      }

      const prosody = results[0]?.models?.prosody;
      const grouped = prosody?.grouped_predictions;
      if (!grouped?.length) {
        console.warn(`[Hume] No grouped_predictions. models keys: ${JSON.stringify(Object.keys(results[0]?.models || {}))}`);
        if (prosody) console.warn(`[Hume] prosody keys: ${JSON.stringify(Object.keys(prosody))}`);
        return null;
      }
      console.log(`[Hume] Found ${grouped.length} groups, ${grouped.reduce((n: number, g: any) => n + (g.predictions?.length || 0), 0)} segments`);

      // Collect all emotion scores across all segments
      const emotionTotals: Record<string, number[]> = {};
      for (const group of grouped) {
        for (const pred of group.predictions || []) {
          for (const emotion of pred.emotions || []) {
            const name = emotion.name as string;
            const score = emotion.score as number;
            if (!emotionTotals[name]) emotionTotals[name] = [];
            emotionTotals[name].push(score);
          }
        }
      }

      // Average scores across segments
      const averaged: [string, number][] = [];
      for (const [name, scores] of Object.entries(emotionTotals)) {
        const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
        averaged.push([name, Math.round(avg * 100) / 100]);
      }

      // Return top 5 by score (no absolute threshold — relative rank is what matters)
      const sorted = averaged
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);

      console.log(`[Hume] Top 5: ${JSON.stringify(Object.fromEntries(sorted))}`);
      if (sorted.length === 0) return null;
      return Object.fromEntries(sorted);
    } catch (error) {
      console.error('[Hume] Failed to extract prosody scores:', error);
      return null;
    }
  }

  /**
   * Generate TTS audio from text using ElevenLabs.
   * Returns raw MP3 Buffer (no side effects — caller decides what to do with it).
   */
  async generateTTS(text: string): Promise<Buffer> {
    if (!this.elevenLabsKey || !this.elevenLabsVoiceId) {
      throw new Error('ElevenLabs not configured — set ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID');
    }

    const response = await fetch(`${ELEVENLABS_BASE}/${this.elevenLabsVoiceId}`, {
      method: 'POST',
      headers: {
        'xi-api-key': this.elevenLabsKey,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_v3',
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`ElevenLabs error ${response.status}: ${errText}`);
    }

    return Buffer.from(await response.arrayBuffer());
  }

  /**
   * Generate TTS and save as an audio message in the thread.
   * Used by the /api/internal/tts endpoint.
   */
  async generateTTSForMessage(text: string, threadId: string): Promise<{ messageId: string; fileId: string }> {
    const audioBuffer = await this.generateTTS(text);
    const fileMeta = saveFile(audioBuffer, 'voice-note.mp3', 'audio/mpeg');

    const now = new Date().toISOString();
    // Emit the new attachment shape so the MessageBubble renders an inline audio
    // player (a voice note from the companion): transcript as the body + a playable clip.
    const audioMessage = createMessage({
      id: crypto.randomUUID(),
      threadId,
      role: 'companion',
      content: text,
      contentType: 'text',
      metadata: {
        source: 'voice',
        attachments: [{
          fileId: fileMeta.fileId,
          filename: fileMeta.filename,
          contentType: 'audio',
          url: fileMeta.url,
          mimeType: 'audio/mpeg',
          size: fileMeta.size,
        }],
      },
      createdAt: now,
    });

    updateThreadActivity(threadId, now, true);
    registry.broadcast({ type: 'message', message: audioMessage });

    return { messageId: audioMessage.id, fileId: fileMeta.fileId };
  }
}
