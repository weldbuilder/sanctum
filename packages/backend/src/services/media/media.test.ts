// [gif:] and [sticker:]: parser cases, offered() gating, and the message shapes the runner posts (Giphy stubbed, real database).
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import { rmSync } from 'node:fs';

const h = vi.hoisted(() => ({ top: '', rating: 'pg-13' as string, broadcasts: [] as any[] }));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  h.top = fs.mkdtempSync(path.join(os.tmpdir(), 'media-'));
  const cfg = { identity: { companion_name: 'Echo', user_name: 'Sam', timezone: 'UTC' }, agent: { app_write: true, cwd: h.top }, voice: { enabled: false }, get media() { return { gif_rating: h.rating }; }, imagegen: { provider: 'none' } };
  return { ...actual, PROJECT_ROOT: h.top, getSanctumConfig: () => cfg };
});
vi.mock('../ws.js', async () => {
  const actual = await vi.importActual<typeof import('../ws.js')>('../ws.js');
  return { ...actual, registry: { ...actual.registry, broadcast: (m: any) => { h.broadcasts.push(m); } } };
});

import { parseTags, expressionInstructions, runTags, anyTagWillRun, streamView } from '../tags/index.js';
import '../tags/builtin.js';
import { initDb, createThread, getMessages, getDb } from '../db.js';
import { addSticker } from './stickers.js';
import { search } from './giphy.js';
import { mediaRelayOf, discordPayloadFor, telegramCallFor } from './relay.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const giphyBody = (n: number) => ({ data: Array.from({ length: n }, (_, i) => ({
  id: `g${i + 1}`, title: `Funny cat ${i + 1} GIF`,
  images: { downsized: { url: `https://media.giphy.com/g${i + 1}.gif` }, fixed_width_small_still: { url: `https://media.giphy.com/g${i + 1}_s.gif` } },
})) });
let fetched: string[] = [];
let giphy: () => Response;

beforeAll(() => { initDb(':memory:'); createThread({ id: 't1', name: 'T', type: 'named', createdAt: new Date().toISOString() }); });
afterAll(() => rmSync(h.top, { recursive: true, force: true }));
beforeEach(() => {
  h.broadcasts.length = 0; h.rating = 'pg-13'; fetched = [];
  getDb().prepare('DELETE FROM stickers').run(); getDb().prepare('DELETE FROM messages').run();
  vi.stubEnv('GIPHY_API_KEY', 'gk');
  giphy = () => new Response(JSON.stringify(giphyBody(3)));
  vi.stubGlobal('fetch', (url: any) => { fetched.push(String(url)); return Promise.resolve(giphy()); });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

const settle = () => new Promise((r) => setTimeout(r, 30));
const run = async (text: string) => {
  const p = parseTags(text);
  runTags(p.tags, { platform: 'web', threadId: 't1', messageId: 'm0', cleanText: p.clean });
  await settle();
  return p;
};

describe('parser', () => {
  it('[gif: ...] and [sticker: ...] are tags; arguments are required; the cap is two each', () => {
    const p = parseTags('Ha! [gif: happy dance] and [sticker: Wave] too [gif: cat] [gif: a third] [sticker: a] [sticker: b] [sticker: c] [gif:] [sticker]');
    expect(p.tags.map((t) => [t.name, t.arg, t.honoured])).toEqual([
      ['gif', 'happy dance', true], ['sticker', 'Wave', true], ['gif', 'cat', true], ['gif', 'a third', false],
      ['sticker', 'a', true], ['sticker', 'b', false], ['sticker', 'c', false], ['gif', '', false], ['sticker', '', false],
    ]);
    expect(p.clean).not.toContain('[');
    expect(p.clean.startsWith('Ha! and too')).toBe(true);
  });
  it('is prose inside code, and held back while streaming', () => {
    expect(parseTags('use `[gif: x]` or\n```\n[sticker: y]\n```').tags).toHaveLength(0);
    expect(streamView('so [gif: hap')).toBe('so');
    expect(streamView('so [gif: happy] there')).toBe('so there');
  });
});

describe('offered() gating', () => {
  it('no key: no gif instruction; key: the line is there, word for word', () => {
    vi.stubEnv('GIPHY_API_KEY', '');
    expect(expressionInstructions()).not.toContain('[gif:');
    vi.stubEnv('GIPHY_API_KEY', 'gk');
    expect(expressionInstructions()).toContain('[gif: a few words] sends a gif that fits the moment; at most two.');
  });
  it('no stickers: no sticker instruction; with stickers it lists the real names, 20 then "and N more"', () => {
    expect(expressionInstructions()).not.toContain('[sticker:');
    addSticker('Wave', PNG, 'w.png', 'image/png');
    const one = expressionInstructions();
    expect(one).toContain('[sticker: name]');
    expect(one).toContain('Wave');
    for (let i = 0; i < 22; i++) addSticker(`s${String(i).padStart(2, '0')}`, PNG, 's.png', 'image/png');
    const many = expressionInstructions();
    expect(many).toContain('and 3 more');
    expect(many).not.toContain('s21');
  });
  it('a tag that is not offered does not run', async () => {
    vi.stubEnv('GIPHY_API_KEY', '');
    await run('hi [gif: cat] [sticker: Nope]');
    expect(fetched).toEqual([]);
    expect(getMessages({ threadId: 't1' })).toHaveLength(0);
    expect(anyTagWillRun(parseTags('[gif: cat]').tags, '')).toBe(false);
  });
});

describe('runner', () => {
  it('[gif:] posts a companion gif message with the first result and broadcasts it', async () => {
    await run('Ha [gif: happy dance]');
    expect(fetched).toHaveLength(1);
    expect(fetched[0]).toContain('q=happy%20dance');
    expect(fetched[0]).toContain('rating=pg-13');
    expect(fetched[0]).toContain('api_key=gk');
    const msgs = getMessages({ threadId: 't1' });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ role: 'companion', content: '', content_type: 'gif' });
    expect(msgs[0].metadata).toMatchObject({ gif_url: 'https://media.giphy.com/g1.gif', gif_title: 'Funny cat 1 GIF', gif_preview: 'https://media.giphy.com/g1_s.gif', source: 'giphy', query: 'happy dance' });
    expect(h.broadcasts.map((b) => [b.type, b.message.content_type])).toEqual([['message', 'gif']]);
  });
  it('honours the configured rating; honours all gif tags, capped at two', async () => {
    h.rating = 'g';
    await run('[gif: one] [gif: two] [gif: three]');
    expect(fetched).toHaveLength(2);
    expect(fetched.every((u) => u.includes('rating=g&') || u.endsWith('rating=g'))).toBe(true);
    expect(getMessages({ threadId: 't1' })).toHaveLength(2);
  });
  it('a failed or empty search posts nothing', async () => {
    giphy = () => new Response('nope', { status: 500 });
    await run('words [gif: cat]');
    giphy = () => new Response(JSON.stringify({ data: [] }));
    await run('words [gif: zzzz]');
    expect(getMessages({ threadId: 't1' })).toHaveLength(0);
    expect(h.broadcasts).toHaveLength(0);
  });
  it('search() maps results to {id, url, preview, title}', async () => {
    expect(await search('cat', { limit: 2 })).toEqual([
      { id: 'g1', url: 'https://media.giphy.com/g1.gif', preview: 'https://media.giphy.com/g1_s.gif', title: 'Funny cat 1 GIF' },
      expect.objectContaining({ id: 'g2' }), expect.objectContaining({ id: 'g3' }),
    ]);
    expect(fetched[0]).toContain('limit=2');
  });
  it('[sticker: name] posts the sticker (name matched without case); an unknown name posts nothing', async () => {
    const s = addSticker('Wave', PNG, 'w.png', 'image/png');
    await run('hello [sticker: wAVE] [sticker: Nope]');
    const msgs = getMessages({ threadId: 't1' });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ role: 'companion', content: '', content_type: 'sticker' });
    expect(msgs[0].metadata).toMatchObject({ sticker_name: 'Wave', attachments: [{ fileId: s.file_id, filename: 'w.png', contentType: 'image' }] });
    expect(h.broadcasts).toHaveLength(1);
  });
});

describe('relay mapping', () => {
  it('a gif is its URL on Discord and sendAnimation on Telegram; a sticker is a file on Discord and sendPhoto on Telegram', () => {
    const gif = mediaRelayOf({ content_type: 'gif', metadata: { gif_url: 'https://media.giphy.com/g1.gif', gif_title: 'x' } })!;
    expect(discordPayloadFor(gif, () => null)).toEqual({ content: 'https://media.giphy.com/g1.gif' });
    expect(telegramCallFor(gif)).toBe('sendAnimation');
    const st = mediaRelayOf({ content_type: 'sticker', metadata: { sticker_name: 'Wave', attachments: [{ fileId: 'f1', filename: 'w.png' }] } })!;
    expect(discordPayloadFor(st, () => PNG)).toEqual({ files: [{ attachment: PNG, name: 'w.png' }] });
    expect(discordPayloadFor(st, () => null)).toBeNull();
    expect(telegramCallFor(st)).toBe('sendPhoto');
  });
  it('anything else, and a gif without an https url, is not relayed', () => {
    expect(mediaRelayOf({ content_type: 'text', metadata: {} })).toBeNull();
    expect(mediaRelayOf({ content_type: 'gif', metadata: { gif_url: 'http://x/y.gif' } })).toBeNull();
    expect(mediaRelayOf({ content_type: 'sticker', metadata: {} })).toBeNull();
  });
});
