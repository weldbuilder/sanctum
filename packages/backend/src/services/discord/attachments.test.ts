// D4: the owner lane hands attachments to the existing attachment path (files.ts saveFile -> processMessage `images`);
// images and text/docs only, under discord.attachments.max_mb; anything else is logged by name. The public lane never
// reaches this module (its frame says "[attachment: <type>, not opened]"; see service-lanes.test.ts).
import { describe, it, expect, vi } from 'vitest';
import { attachmentKind, ingestOwnerAttachments, type DiscordAttachmentLike } from './attachments.js';

const MB = 1024 * 1024;
const att = (name: string, over: Partial<DiscordAttachmentLike> = {}): DiscordAttachmentLike => ({
  name, url: `https://cdn.discordapp.com/attachments/1/2/${name}?ex=abc&is=def&hm=secretsignature`, size: 1000, ...over,
});

function setup(over: { bytes?: (url: string) => number; ok?: boolean } = {}) {
  const fetched: string[] = [];
  const saved: Array<{ buf: Buffer; name: string; mime: string }> = [];
  const logs: string[] = [];
  const deps = {
    maxBytes: 8 * MB,
    fetch: vi.fn(async (url: string) => {
      fetched.push(url);
      const n = over.bytes ? over.bytes(url) : 10;
      return { ok: over.ok ?? true, status: over.ok === false ? 404 : 200, arrayBuffer: async () => new ArrayBuffer(n) };
    }),
    save: (buf: Buffer, name: string, mime: string) => {
      saved.push({ buf, name, mime });
      return { fileId: `id-${saved.length}`, filename: name, mimeType: mime, size: buf.length, contentType: (mime.startsWith('image/') ? 'image' : 'file') as 'image' | 'file', url: `/api/files/id-${saved.length}` };
    },
    log: (m: string) => { logs.push(m); },
  };
  return { deps, fetched, saved, logs };
}

describe('attachmentKind', () => {
  it('names the kind from the content type, else the extension', () => {
    expect(attachmentKind({ name: 'a.png', contentType: 'image/png' })).toBe('image');
    expect(attachmentKind({ name: 'a.PNG' })).toBe('image');
    expect(attachmentKind({ name: 'a.mp4', contentType: 'video/mp4' })).toBe('video');
    expect(attachmentKind({ name: 'a.mp3' })).toBe('audio');
    expect(attachmentKind({ name: 'notes.pdf' })).toBe('file');
    expect(attachmentKind({ name: 'mystery' })).toBe('file');
  });
});

describe('ingestOwnerAttachments', () => {
  it('saves an image and a text document through the existing path and returns them as agent inputs', async () => {
    const s = setup();
    const r = await ingestOwnerAttachments([att('pic.png', { contentType: 'image/png' }), att('notes.md', { contentType: 'text/markdown; charset=utf-8' }), att('plan.pdf')], s.deps);
    expect(s.saved.map((x) => [x.name, x.mime])).toEqual([['pic.png', 'image/png'], ['notes.md', 'text/markdown'], ['plan.pdf', 'application/pdf']]);
    expect(r.saved.map((x) => x.fileId)).toEqual(['id-1', 'id-2', 'id-3']);
    expect(r.skipped).toEqual([]);
  });

  it('skips anything that is not an image or a text/document, and logs it by name', async () => {
    const s = setup();
    const r = await ingestOwnerAttachments([att('x.zip'), att('song.mp3'), att('clip.mp4'), att('run.exe'), att('ok.txt')], s.deps);
    expect(r.saved.map((x) => x.filename)).toEqual(['ok.txt']);
    expect(r.skipped.map((x) => x.name)).toEqual(['x.zip', 'song.mp3', 'clip.mp4', 'run.exe']);
    expect(s.fetched).toHaveLength(1);
    for (const n of ['x.zip', 'song.mp3', 'clip.mp4', 'run.exe']) expect(s.logs.join('\n')).toContain(n);
  });

  it('a file over the cap is not fetched when its declared size says so, and is dropped when its bytes say so', async () => {
    const s = setup({ bytes: (u) => (u.includes('liar.png') ? 9 * MB : 10) });
    const r = await ingestOwnerAttachments([att('big.png', { size: 9 * MB }), att('liar.png', { size: 100 }), att('edge.png', { size: 8 * MB })], s.deps);
    expect(s.fetched.some((u) => u.includes('big.png'))).toBe(false);
    expect(r.skipped.map((x) => [x.name, x.reason])).toEqual([['big.png', 'too_large'], ['liar.png', 'too_large']]);
    expect(r.saved.map((x) => x.filename)).toEqual(['edge.png']);
  });

  it('a failed download is skipped, never thrown, and the rest still go', async () => {
    const s = setup();
    s.deps.fetch.mockImplementationOnce(async () => { throw new Error('ECONNRESET'); });
    const r = await ingestOwnerAttachments([att('a.png'), att('b.png')], s.deps);
    expect(r.skipped).toEqual([{ name: 'a.png', reason: 'fetch_failed' }]);
    expect(r.saved.map((x) => x.filename)).toEqual(['b.png']);
    const bad = setup({ ok: false });
    expect((await ingestOwnerAttachments([att('c.png')], bad.deps)).skipped[0].reason).toBe('fetch_failed');
  });

  it('only fetches from Discord\'s own hosts over https', async () => {
    const s = setup();
    const r = await ingestOwnerAttachments([
      att('a.png', { url: 'https://evil.example.com/a.png' }),
      att('b.png', { url: 'http://cdn.discordapp.com/b.png' }),
      att('c.png', { url: 'https://cdn.discordapp.com.evil.example/c.png' }),
      att('d.png', { url: 'https://media.discordapp.net/attachments/1/2/d.png' }),
    ], s.deps);
    expect(s.fetched).toEqual(['https://media.discordapp.net/attachments/1/2/d.png']);
    expect(r.skipped.map((x) => x.reason)).toEqual(['untrusted_host', 'untrusted_host', 'untrusted_host']);
  });

  it('takes at most 5 per batch; the rest are skipped by name', async () => {
    const s = setup();
    const r = await ingestOwnerAttachments(Array.from({ length: 7 }, (_, i) => att(`f${i}.png`)), s.deps);
    expect(r.saved).toHaveLength(5);
    expect(r.skipped.map((x) => [x.name, x.reason])).toEqual([['f5.png', 'too_many'], ['f6.png', 'too_many']]);
  });

  it('never logs a URL (they carry signatures), only names, and a name is flattened to one line', async () => {
    const s = setup();
    await ingestOwnerAttachments([att('x.zip'), att('line1\nline2.exe')], s.deps);
    const out = s.logs.join('\n');
    expect(out).not.toMatch(/secretsignature|https?:/);
    expect(s.logs.every((l) => !l.includes('\n'))).toBe(true);
  });
});

// ── B3c item 5: hardening ─────────────────────────────────────────────────────
describe('ingestOwnerAttachments: the size cap holds on the stream', () => {
  /** A body that streams `chunks` chunks of `chunk` bytes and counts how many were pulled from it. */
  function streaming(chunk: number, chunks: number) {
    const state = { pulled: 0, cancelled: false };
    const body = new ReadableStream<Uint8Array>({
      pull(c) { if (state.pulled >= chunks) { c.close(); return; } state.pulled++; c.enqueue(new Uint8Array(chunk)); },
      cancel() { state.cancelled = true; },
    });
    return { state, res: new Response(body, { status: 200 }) };
  }
  const baseDeps = (res: Response, over: { maxBytes?: number } = {}) => {
    const saved: Array<{ buf: Buffer; name: string }> = [];
    return {
      saved,
      deps: {
        maxBytes: over.maxBytes ?? 1000,
        fetch: async () => res as unknown as import('./attachments.js').FetchedResponse,
        save: (buf: Buffer, name: string, mime: string) => { saved.push({ buf, name }); return { fileId: 'f', filename: name, mimeType: mime, size: buf.length, contentType: 'file' as const, url: '/x' }; },
        log: () => {},
      },
    };
  };

  it('a body that declares 10 bytes and streams more is abandoned past the cap, not read to the end', async () => {
    const { state, res } = streaming(1024, 50_000); // would be ~50 MB
    const { deps, saved } = baseDeps(res);
    const r = await ingestOwnerAttachments([att('a.png', { size: 10, contentType: 'image/png' })], deps);
    expect(r.skipped).toEqual([{ name: 'a.png', reason: 'too_large' }]);
    expect(saved).toEqual([]);
    expect(state.pulled).toBeLessThanOrEqual(4); // the cap is 1000 bytes: one or two chunks, plus what the stream had buffered
    expect(state.cancelled).toBe(true);
  });

  it('a Content-Length over the cap is refused before the body is read', async () => {
    const { state, res } = streaming(100, 10);
    const withLength = new Response(res.body, { status: 200, headers: { 'content-length': '999999' } });
    const { deps } = baseDeps(withLength);
    const r = await ingestOwnerAttachments([att('a.png', { size: 10, contentType: 'image/png' })], deps);
    expect(r.skipped).toEqual([{ name: 'a.png', reason: 'too_large' }]);
    expect(state.pulled).toBeLessThanOrEqual(1); // a stream pulls once as it is built; nothing is read after the header said no
    expect(state.cancelled).toBe(true);
  });

  it('a body inside the cap is read whole and saved', async () => {
    const { res } = streaming(100, 5);
    const { deps, saved } = baseDeps(res);
    const r = await ingestOwnerAttachments([att('a.png', { size: 10, contentType: 'image/png' })], deps);
    expect(r.skipped).toEqual([]);
    expect(saved[0].buf.length).toBe(500);
  });
});

describe('ingestOwnerAttachments: only the default https port, no credentials', () => {
  it('refuses an explicit port and a user:password, and still takes the default port spelled out', async () => {
    const s = setup();
    const r = await ingestOwnerAttachments([
      att('a.png', { url: 'https://cdn.discordapp.com:8443/a.png' }),
      att('b.png', { url: 'https://cdn.discordapp.com:80/b.png' }),
      att('c.png', { url: 'https://user:pw@cdn.discordapp.com/c.png' }),
      att('d.png', { url: 'https://cdn.discordapp.com:443/d.png' }),
      att('e.png', { url: 'https://cdn.discordapp.com/e.png' }),
    ], s.deps);
    expect(r.skipped.map((x) => [x.name, x.reason])).toEqual([['a.png', 'untrusted_host'], ['b.png', 'untrusted_host'], ['c.png', 'untrusted_host']]);
    expect(s.fetched).toHaveLength(2);
  });
});

describe('ingestOwnerAttachments: the name handed to save()', () => {
  const savedNames = async (name: string) => {
    const s = setup();
    await ingestOwnerAttachments([att('placeholder.txt', { name, contentType: 'text/plain' })], s.deps);
    return s.saved.map((x) => x.name);
  };

  it('is capped at 120 characters and keeps the extension', async () => {
    const [n] = await savedNames(`${"a".repeat(300)}.txt`);
    expect(n.length).toBeLessThanOrEqual(120);
    expect(n.endsWith('.txt')).toBe(true);
  });

  it('loses control characters, newlines, bidi and zero-width characters', async () => {
    expect(await savedNames('re\nport\r\u0000\u0007\u202E\u200B.txt')).toEqual(['report.txt']);
  });

  it('loses any path in front of the name', async () => {
    expect(await savedNames('../../../etc/cron.d/x.txt')).toEqual(['x.txt']);
    expect(await savedNames('C:\\Users\\me\\notes.txt')).toEqual(['notes.txt']);
  });

  it('falls back to a plain name when nothing is left', async () => {
    const [n] = await savedNames('\n\u0000\n');
    expect(n).toBe('attachment');
  });
});

describe('ingestOwnerAttachments: HTML is not taken', () => {
  it('skips .html, .htm and text/html as a type, by name', async () => {
    const s = setup();
    const r = await ingestOwnerAttachments([
      att('page.html'), att('old.htm'), att('x.txt', { contentType: 'text/html; charset=utf-8' }),
      att('disguised.html', { contentType: 'text/plain' }), att('ok.txt'),
    ], s.deps);
    expect(r.saved.map((x) => x.filename)).toEqual(['ok.txt']);
    expect(r.skipped.map((x) => [x.name, x.reason])).toEqual([['page.html', 'type'], ['old.htm', 'type'], ['x.txt', 'type'], ['disguised.html', 'type']]);
    expect(s.logs.join('\n')).toContain('page.html');
    expect(s.fetched).toHaveLength(1);
  });
});

describe('ingestOwnerAttachments: the HTML check runs on the sanitised name too (B3d 9)', () => {
  // The name that is saved is the sanitised one (invisible characters and control characters out, trimmed): the extension
  // check reads that one as well as the raw one, so a name that only becomes `.html` once cleaned is refused.
  it.each([
    ['a zero-width space inside the extension', 'x.ht​ml'],
    ['a trailing space', 'x.html '],
    ['a trailing NUL', 'x.html\u0000'],
    ['a right-to-left override inside', 'x.h‮tml'],
    ['a soft hyphen inside .htm', 'x.h­tm'],
    ['a trailing dot', 'x.html.'],
    ['capitals and a trailing space', 'PAGE.HTML '],
    ['a C1 control inside', 'x.ht\u0085ml'],
  ])('%s: skipped as a type, even when labelled text/plain', async (_n, name) => {
    const s = setup();
    const r = await ingestOwnerAttachments([att('fine.txt'), att(name, { contentType: 'text/plain' })], s.deps);
    expect(r.saved.map((x) => x.filename)).toEqual(['fine.txt']);
    expect(r.skipped.map((x) => x.reason)).toEqual(['type']);
    expect(s.fetched).toHaveLength(1);
  });

  it('a clean .txt whose name has an invisible character elsewhere is still taken', async () => {
    const s = setup();
    const r = await ingestOwnerAttachments([att('no​tes.txt')], s.deps);
    expect(r.saved.map((x) => x.filename)).toEqual(['notes.txt']);
    expect(r.skipped).toEqual([]);
  });
});
