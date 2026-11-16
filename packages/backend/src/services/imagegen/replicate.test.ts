import { describe, it, expect, vi, afterEach } from 'vitest';
import { createReplicateProvider, aspectRatioFor } from './replicate.js';
import { ImageGenError } from './types.js';

const base = { prompt: 'a fox', width: 1024, height: 1024, model: '', safetyChecker: false, timeoutMs: 5000 };
const png = Buffer.from('replicate-png');
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });
afterEach(() => vi.unstubAllGlobals());

describe('replicate adapter', () => {
  it('aspect ratio mapping', () => {
    expect(aspectRatioFor(1024, 1024)).toBe('1:1');
    expect(aspectRatioFor(1024, 1536)).toBe('2:3');
    expect(aspectRatioFor(1536, 1024)).toBe('3:2');
  });

  it('Prefer: wait, inverted safety flag, aspect ratio, and the output download (no auth header on the delivery URL)', async () => {
    const f = vi.fn(async (url: string) => {
      if (url.startsWith('https://api.replicate.com')) return json({ status: 'succeeded', output: ['https://replicate.delivery/x.png'] });
      return new Response(png, { headers: { 'content-type': 'image/png' } });
    });
    vi.stubGlobal('fetch', f);
    const out = await createReplicateProvider('TOK').generate({ ...base, width: 1536, height: 1024, safetyChecker: true });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions');
    const h = init.headers as Record<string, string>;
    expect(h.Prefer).toBe('wait');
    expect(h.Authorization).toBe('Bearer TOK');
    expect(JSON.parse(init.body as string).input).toEqual({ prompt: 'a fox', aspect_ratio: '3:2', output_format: 'png', num_outputs: 1, disable_safety_checker: false });
    const [dlUrl, dlInit] = f.mock.calls[1] as unknown as [string, RequestInit];
    expect(dlUrl).toBe('https://replicate.delivery/x.png');
    expect((dlInit.headers as Record<string, string> | undefined)?.Authorization).toBeUndefined();
    expect(out.bytes.equals(png)).toBe(true);
    expect(out.model).toBe('black-forest-labs/flux-schnell');
  });

  // Pinned from main before references existed: with zero references the body must stay byte for byte this.
  it('zero references: the exact body of main, for the default model and for any model', async () => {
    const f = vi.fn(async (url: string) => url.includes('api.replicate') ? json({ status: 'succeeded', output: 'https://replicate.delivery/y.png' }) : new Response(png));
    vi.stubGlobal('fetch', f);
    await createReplicateProvider('T').generate(base);
    expect((f.mock.calls[0] as unknown as [string, RequestInit])[1].body).toBe('{"input":{"prompt":"a fox","aspect_ratio":"1:1","output_format":"png","num_outputs":1,"disable_safety_checker":true}}');
    await createReplicateProvider('T').generate({ ...base, model: 'black-forest-labs/flux-kontext-pro', references: [] });
    expect((f.mock.calls[2] as unknown as [string, RequestInit])[1].body).toBe('{"input":{"prompt":"a fox","aspect_ratio":"1:1","output_format":"png","num_outputs":1,"disable_safety_checker":true}}');
  });

  it('safetyChecker false sends disable_safety_checker true; a string output works', async () => {
    const f = vi.fn(async (url: string) => url.includes('api.replicate') ? json({ status: 'succeeded', output: 'https://replicate.delivery/y.png' }) : new Response(png));
    vi.stubGlobal('fetch', f);
    await createReplicateProvider('T').generate({ ...base, model: 'black-forest-labs/flux-dev' });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/models/black-forest-labs/flux-dev/predictions');
    expect(JSON.parse(init.body as string).input.disable_safety_checker).toBe(true);
  });

  it('polls urls.get until succeeded', async () => {
    const get = 'https://api.replicate.com/v1/predictions/abc';
    let polls = 0;
    const f = vi.fn(async (url: string) => {
      if (url.includes('/predictions') && url !== get) return json({ status: 'processing', urls: { get } });
      if (url === get) { polls++; return json(polls < 2 ? { status: 'processing', urls: { get } } : { status: 'succeeded', output: ['https://replicate.delivery/z.png'] }); }
      return new Response(png);
    });
    vi.stubGlobal('fetch', f);
    const out = await createReplicateProvider('T', { pollMs: 1 }).generate(base);
    expect(polls).toBe(2);
    expect(out.bytes.equals(png)).toBe(true);
  });

  it('failed prediction maps by known strings, never returning the raw error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ status: 'failed', error: 'NSFW content detected secret-detail' })));
    const err = await createReplicateProvider('T').generate(base).catch((e) => e);
    expect(err).toBeInstanceOf(ImageGenError);
    expect(err.cls).toBe('content_blocked');
    expect(err.message).not.toContain('secret-detail');
  });

  it.each([[401, 'auth'], [429, 'rate_limit'], [422, 'bad_request'], [500, 'server']])('HTTP %i -> %s', async (status, cls) => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ title: 'x', detail: 'y' }, status)));
    expect((await createReplicateProvider('T').generate(base).catch((e) => e)).cls).toBe(cls);
  });

  it('times out while polling', async () => {
    const get = 'https://api.replicate.com/v1/predictions/abc';
    vi.stubGlobal('fetch', vi.fn(async () => json({ status: 'processing', urls: { get } })));
    const err = await createReplicateProvider('T', { pollMs: 5 }).generate({ ...base, timeoutMs: 40 }).catch((e) => e);
    expect(err.cls).toBe('timeout');
  });

  it('rejects a malformed model id before any request', async () => {
    const f = vi.fn(); vi.stubGlobal('fetch', f);
    expect((await createReplicateProvider('T').generate({ ...base, model: '../evil' }).catch((e) => e)).cls).toBe('bad_request');
    expect(f).not.toHaveBeenCalled();
  });

  it('never follows urls.get off api.replicate.com (the poll carries the bearer token): server, and no second request', async () => {
    for (const get of ['https://evil.example.com/v1/predictions/abc', 'https://api.replicate.com.evil.example/x', 'http://api.replicate.com/v1/predictions/abc']) {
      const f = vi.fn(async () => json({ status: 'processing', urls: { get } }));
      vi.stubGlobal('fetch', f);
      await expect(createReplicateProvider('SECRET', { pollMs: 1 }).generate(base)).rejects.toMatchObject({ cls: 'server' });
      expect(f).toHaveBeenCalledTimes(1);
    }
  });

  it('402 is classed billing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ title: 'Payment required' }, 402)));
    await expect(createReplicateProvider('T').generate(base)).rejects.toMatchObject({ cls: 'billing' });
  });

  describe('references', () => {
    const refs = [
      { bytes: Buffer.from('ref-a'), mime: 'image/png', name: 'Echo' },
      { bytes: Buffer.from('ref-b'), mime: 'image/jpeg', name: 'Sam' },
      { bytes: Buffer.from('ref-c'), mime: 'image/webp', name: 'Lake house' },
    ];
    const run = async (model: string, references: typeof refs, extra: Record<string, unknown> = {}) => {
      const f = vi.fn(async (url: string) => url.includes('api.replicate') ? json({ status: 'succeeded', output: 'https://replicate.delivery/y.png' }) : new Response(png));
      vi.stubGlobal('fetch', f);
      await createReplicateProvider('T').generate({ ...base, model, references, ...extra });
      const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
      return { url, raw: init.body as string, input: JSON.parse(init.body as string).input };
    };

    it('kontext, one reference: exact body, input_image, no safety or num_outputs field', async () => {
      const { url, raw } = await run('black-forest-labs/flux-kontext-pro', refs.slice(0, 1));
      expect(url).toBe('https://api.replicate.com/v1/models/black-forest-labs/flux-kontext-pro/predictions');
      expect(raw).toBe('{"input":{"prompt":"a fox","input_image":"data:image/png;base64,cmVmLWE=","aspect_ratio":"1:1","output_format":"png"}}');
    });

    it('kontext, three references: only the FIRST is sent as input_image; the rest are dropped with a debug note of names only', async () => {
      const dbg = vi.spyOn(console, 'debug').mockImplementation(() => {});
      const { raw, input } = await run('black-forest-labs/flux-kontext-pro', refs, { width: 1024, height: 1536 });
      expect(raw).toBe('{"input":{"prompt":"a fox","input_image":"data:image/png;base64,cmVmLWE=","aspect_ratio":"2:3","output_format":"png"}}');
      expect('input_images' in input).toBe(false);
      expect(dbg.mock.calls.map((c) => String(c[0])).join('\n')).toContain('dropped: Sam, Lake house');
      expect(dbg.mock.calls.map((c) => String(c[0])).join('\n')).not.toContain('cmVm');
      dbg.mockRestore();
    });

    it('flux-2: input_images carries all of them, in order', async () => {
      const { raw } = await run('black-forest-labs/flux-2-pro', refs, { width: 1536, height: 1024 });
      expect(raw).toBe('{"input":{"prompt":"a fox","input_images":["data:image/png;base64,cmVmLWE=","data:image/jpeg;base64,cmVmLWI=","data:image/webp;base64,cmVmLWM="],"aspect_ratio":"3:2","output_format":"png"}}');
    });

    it('another model with references keeps its own safety and count fields and gets input_image', async () => {
      const { input } = await run('acme/other-editor', refs.slice(0, 1), { safetyChecker: true });
      expect(input).toEqual({ prompt: 'a fox', input_image: 'data:image/png;base64,cmVmLWE=', aspect_ratio: '1:1', output_format: 'png', num_outputs: 1, disable_safety_checker: false });
    });
  });
});
