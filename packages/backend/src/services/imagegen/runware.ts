import { randomUUID } from 'node:crypto';
import { ImageGenError, classFromStatus, classFromText, timedFetch, type ImageGenProvider, type ImageGenRequest, type ImageGenResult } from './types.js';

export const RUNWARE_URL = 'https://api.runware.ai/v1';
/** FLUX.1 schnell. (runware:101@1 is FLUX.1 dev.) */
export const RUNWARE_DEFAULT_MODEL = 'runware:100@1';

const snap64 = (n: number) => Math.max(64, Math.round(n / 64) * 64);

export function createRunwareProvider(apiKey: string): ImageGenProvider {
  return {
    name: 'runware',
    async generate(req: ImageGenRequest): Promise<ImageGenResult> {
      const startedAt = Date.now();
      const model = req.model || RUNWARE_DEFAULT_MODEL;
      const body = [{
        taskType: 'imageInference',
        taskUUID: randomUUID(),
        positivePrompt: req.prompt,
        model,
        width: snap64(req.width),
        height: snap64(req.height),
        numberResults: 1,
        outputType: 'base64Data',
        outputFormat: 'PNG',
        checkNSFW: req.safetyChecker,
      }];
      const res = await timedFetch('runware', RUNWARE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
      }, { timeoutMs: req.timeoutMs, signal: req.signal, startedAt });

      let json: any = null;
      try { json = await res.json(); } catch { /* non-JSON body */ }

      const errors: any[] = Array.isArray(json?.errors) ? json.errors : [];
      if (!res.ok || errors.length) {
        const text = errors.map((e) => `${e?.code ?? ''} ${e?.message ?? ''}`).join(' ');
        throw new ImageGenError(classFromText(text, res.ok ? 'bad_request' : classFromStatus(res.status)), 'runware');
      }
      const item = Array.isArray(json?.data) ? json.data[0] : null;
      // With checkNSFW on, a flagged image comes back with NSFWContent true and no usable pixels.
      if (item?.NSFWContent === true && !item?.imageBase64Data) throw new ImageGenError('content_blocked', 'runware');
      const b64 = item?.imageBase64Data;
      if (typeof b64 !== 'string' || !b64) throw new ImageGenError('server', 'runware');
      return { bytes: Buffer.from(b64, 'base64'), mime: 'image/png', model };
    },
  };
}
