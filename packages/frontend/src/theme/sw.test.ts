import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** Run public/sw.js against a fake service-worker scope and return its listeners and caches. */
function boot() {
  const src = readFileSync(fileURLToPath(new URL('../../public/sw.js', import.meta.url)), 'utf8');
  const listeners: Record<string, (e: any) => void> = {};
  const stores = new Map<string, Map<string, Response>>();
  const cacheApi = {
    open: async (name: string) => {
      if (!stores.has(name)) stores.set(name, new Map());
      const m = stores.get(name)!;
      return {
        match: async (r: Request | string) => m.get(typeof r === 'string' ? r : r.url),
        put: async (r: Request | string, res: Response) => { m.set(typeof r === 'string' ? r : r.url, res); },
        keys: async () => [...m.keys()].map(u => ({ url: u })),
        delete: async (r: { url: string } | string) => m.delete(typeof r === 'string' ? r : r.url),
        addAll: async () => {},
      };
    },
    keys: async () => [...stores.keys()],
    delete: async (k: string) => stores.delete(k),
    match: async () => undefined,
  };
  const self = { addEventListener: (t: string, f: (e: any) => void) => { listeners[t] = f; }, location: { origin: 'https://sanctum.test' }, skipWaiting() {}, clients: { claim() {} } };
  const fetchCalls: string[] = [];
  let respond: (url: string) => Response = () => new Response('x', { status: 200, headers: { 'content-type': 'image/webp' } });
  const fakeFetch = async (r: Request | string) => { const u = typeof r === 'string' ? r : r.url; fetchCalls.push(u); return respond(u); };
  new Function('self', 'caches', 'fetch', 'URL', 'Response', src)(self, cacheApi, fakeFetch, URL, Response);
  const request = (path: string) => ({ url: `https://sanctum.test${path}`, method: 'GET', mode: 'no-cors' });
  const doFetch = async (path: string) => {
    let p: Promise<Response> | undefined;
    listeners.fetch({ request: request(path), respondWith: (x: Promise<Response>) => { p = x; } });
    return p ? await p : null;
  };
  return { listeners, stores, fetchCalls, doFetch, setRespond: (f: (u: string) => Response) => { respond = f; } };
}

describe('service worker and room artwork', () => {
  it('caches a scene cache-first, so a second request never reaches the network', async () => {
    const sw = boot();
    await sw.doFetch('/skins/library/desktop-v1.webp');
    await sw.doFetch('/skins/library/desktop-v1.webp');
    expect(sw.fetchCalls.filter(u => u.includes('/skins/library/desktop-v1.webp'))).toHaveLength(1);
    expect([...sw.stores.get('sanctum-skins-v2')!.keys()]).toEqual(['https://sanctum.test/skins/library/desktop-v1.webp']);
  });

  it('caches Ember\'s scene the same way, in the same bounded cache (its names carry no version suffix, so a changed picture must be shipped under a new name)', async () => {
    const sw = boot();
    await sw.doFetch('/skins/ember/ember-mobile.webp');
    await sw.doFetch('/skins/ember/ember-mobile.webp');
    expect(sw.fetchCalls.filter(u => u.includes('/skins/ember/ember-mobile.webp'))).toHaveLength(1);
    expect([...sw.stores.get('sanctum-skins-v2')!.keys()]).toEqual(['https://sanctum.test/skins/ember/ember-mobile.webp']);
  });

  it('never caches a failed or missing image, so the room colour shows instead', async () => {
    const sw = boot();
    sw.setRespond(() => new Response('nope', { status: 404 }));
    const res = await sw.doFetch('/skins/salon/mobile-v1.webp');
    expect(res!.status).toBe(404);
    expect(sw.stores.get('sanctum-skins-v2')!.size).toBe(0);
  });

  it('never caches the SPA\'s HTML answered with 200 for a missing art path', async () => {
    const sw = boot();
    sw.setRespond(() => new Response('<!doctype html><div id="root"></div>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }));
    const res = await sw.doFetch('/skins/library/gone-v9.webp');
    expect(res!.status).toBe(200);
    expect(sw.stores.get('sanctum-skins-v2')!.size).toBe(0);
    sw.setRespond(() => new Response('x', { status: 200 })); // no content-type at all
    await sw.doFetch('/skins/library/untyped-v1.webp');
    expect(sw.stores.get('sanctum-skins-v2')!.size).toBe(0);
  });

  it('keeps the skins cache bounded', async () => {
    const sw = boot();
    for (let i = 0; i < 40; i++) await sw.doFetch(`/skins/night/file-${i}-v1.webp`);
    expect(sw.stores.get('sanctum-skins-v2')!.size).toBe(24);
  });

  it('leaves the API and other paths alone, and the skins cache survives activation', async () => {
    const sw = boot();
    await sw.doFetch('/skins/cloister/desktop-v1.webp');
    expect(await sw.doFetch('/api/theme')).toBeNull();
    sw.stores.set('sanctum-shell-v1-old', new Map());
    let done: Promise<unknown> | undefined;
    sw.listeners.activate({ waitUntil: (p: Promise<unknown>) => { done = p; } });
    await done;
    expect(sw.stores.has('sanctum-skins-v2')).toBe(true);
    expect(sw.stores.has('sanctum-shell-v1-old')).toBe(false);
  });
});
