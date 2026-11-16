import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRunwareProvider } from './runware.js';
import { ImageGenError } from './types.js';

const base = { prompt: 'a lighthouse', width: 1024, height: 1536, model: '', safetyChecker: true, timeoutMs: 5000 };
const png = Buffer.from('fakepng-bytes');

function mockFetch(res: { status?: number; json: unknown }) {
  const f = vi.fn(async () => new Response(JSON.stringify(res.json), { status: res.status ?? 200 }));
  vi.stubGlobal('fetch', f);
  return f;
}
afterEach(() => vi.unstubAllGlobals());

describe('runware adapter', () => {
  it('sends an array body with Bearer auth, multiple-of-64 dims, and passes checkNSFW through', async () => {
    const f = mockFetch({ json: { data: [{ taskType: 'imageInference', imageBase64Data: png.toString('base64') }] } });
    const out = await createRunwareProvider('KEY').generate(base);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.runware.ai/v1');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer KEY');
    const body = JSON.parse(init.body as string);
    expect(Array.isArray(body)).toBe(true);
    expect(body[0]).toMatchObject({ taskType: 'imageInference', positivePrompt: 'a lighthouse', model: 'runware:100@1', numberResults: 1, outputType: 'base64Data', outputFormat: 'PNG', checkNSFW: true });
    expect(body[0].taskUUID).toMatch(/^[0-9a-f-]{36}$/);
    expect(body[0].width % 64).toBe(0);
    expect(body[0].height % 64).toBe(0);
    expect(out.bytes.equals(png)).toBe(true);
    expect(out.mime).toBe('image/png');
    expect(out.model).toBe('runware:100@1');
  });

  // Pinned from main before references existed: with zero references the body must stay byte for byte this.
  it('zero references: the exact body of main (key order, no inputs)', async () => {
    const f = mockFetch({ json: { data: [{ imageBase64Data: png.toString('base64') }] } });
    await createRunwareProvider('K').generate(base);
    const raw = ((f.mock.calls[0] as unknown as [string, RequestInit])[1]).body as string;
    const uuid = JSON.parse(raw)[0].taskUUID as string;
    expect(raw).toBe(`[{"taskType":"imageInference","taskUUID":"${uuid}","positivePrompt":"a lighthouse","model":"runware:100@1","width":1024,"height":1536,"numberResults":1,"outputType":"base64Data","outputFormat":"PNG","checkNSFW":true}]`);
    await createRunwareProvider('K').generate({ ...base, references: [] });
    expect(((f.mock.calls[1] as unknown as [string, RequestInit])[1]).body as string).toBe(raw.replace(uuid, JSON.parse(((f.mock.calls[1] as unknown as [string, RequestInit])[1]).body as string)[0].taskUUID));
  });

  it('checkNSFW follows the flag, and an odd size is snapped to 64', async () => {
    const f = mockFetch({ json: { data: [{ imageBase64Data: png.toString('base64') }] } });
    await createRunwareProvider('K').generate({ ...base, safetyChecker: false, width: 1000, height: 1030, model: 'runware:101@1' });
    const body = JSON.parse(((f.mock.calls[0] as unknown as [string, RequestInit])[1]).body as string)[0];
    expect(body.checkNSFW).toBe(false);
    expect(body.model).toBe('runware:101@1');
    expect([body.width, body.height]).toEqual([1024, 1024]);
  });

  it.each([
    [401, { errors: [{ code: 'invalidApiKey', message: 'secret-body-text' }] }, 'auth'],
    [429, { errors: [{ message: 'slow down' }] }, 'rate_limit'],
    [400, { errors: [{ code: 'safetyFilter', message: 'NSFW content' }] }, 'content_blocked'],
    [400, { errors: [{ code: 'invalidWidth', message: 'bad' }] }, 'bad_request'],
    [503, {}, 'server'],
    [200, { errors: [{ code: 'unauthorizedAccess' }] }, 'auth'],
  ])('maps status %i %j to %s without leaking the body', async (status, json, cls) => {
    mockFetch({ status, json });
    const err = await createRunwareProvider('K').generate(base).catch((e) => e);
    expect(err).toBeInstanceOf(ImageGenError);
    expect(err.cls).toBe(cls);
    expect(err.message).not.toContain('secret-body-text');
  });

  it('flagged image with no pixels is content_blocked; empty data is a server error', async () => {
    mockFetch({ json: { data: [{ NSFWContent: true }] } });
    expect((await createRunwareProvider('K').generate(base).catch((e) => e)).cls).toBe('content_blocked');
    mockFetch({ json: { data: [] } });
    expect((await createRunwareProvider('K').generate(base).catch((e) => e)).cls).toBe('server');
  });

  it('transport failure is network; the key never appears in the error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('connect ECONNREFUSED Bearer KEY'); }));
    const err = await createRunwareProvider('KEY').generate(base).catch((e) => e);
    expect(err.cls).toBe('network');
    expect(err.message).not.toContain('KEY');
  });

  describe('references', () => {
    const refs = [
      { bytes: Buffer.from('ref-a'), mime: 'image/png', name: 'Echo' },
      { bytes: Buffer.from('ref-b'), mime: 'image/jpeg', name: 'Sam' },
      { bytes: Buffer.from('ref-c'), mime: 'image/webp', name: 'Lake house' },
    ];
    const run = async (references: typeof refs) => {
      const f = mockFetch({ json: { data: [{ imageBase64Data: png.toString('base64') }] } });
      await createRunwareProvider('K').generate({ ...base, model: 'bfl:3@1', references });
      const raw = ((f.mock.calls[0] as unknown as [string, RequestInit])[1]).body as string;
      return { raw, task: JSON.parse(raw)[0] };
    };

    it('one reference: exact body, inputs.referenceImages is one data URI, last key of the task', async () => {
      const { raw, task } = await run(refs.slice(0, 1));
      expect(raw).toBe(`[{"taskType":"imageInference","taskUUID":"${task.taskUUID}","positivePrompt":"a lighthouse","model":"bfl:3@1","width":1024,"height":1536,"numberResults":1,"outputType":"base64Data","outputFormat":"PNG","checkNSFW":true,"inputs":{"referenceImages":["data:image/png;base64,cmVmLWE="]}}]`);
    });

    it('three references: all three, in order, each a data URI of its own type', async () => {
      const { task } = await run(refs);
      expect(task.inputs).toEqual({ referenceImages: ['data:image/png;base64,cmVmLWE=', 'data:image/jpeg;base64,cmVmLWI=', 'data:image/webp;base64,cmVmLWM='] });
      expect(task.width).toBe(1024);
      expect(task.height).toBe(1536);
    });

    it('no references: no inputs key at all', async () => {
      expect('inputs' in (await run([])).task).toBe(false);
    });
  });
});
