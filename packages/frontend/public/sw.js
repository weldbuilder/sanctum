// Sanctum — app-shell service worker
// Caches the shell on install; serves it offline.
// API / WS requests are never cached (network-first by default).

const CACHE_NAME = 'sanctum-shell-v31';

// Room artwork (/skins/<room>/<file>-v1.webp ...). File names carry a version suffix, so cache-first is
// safe: new art ships under a new name. A separate, bounded cache keeps it from growing without limit.
const SKINS_CACHE = 'sanctum-skins-v2';  // v2: drops any HTML that v1 cached for a missing path
const SKINS_MAX_ENTRIES = 24;

// The minimum shell to cache for standalone installability.
// Vite builds assets with hashed names; we don't try to enumerate them here —
// instead we cache the root document and let the browser handle assets via
// normal HTTP caching. This SW's job is: installability + offline shell.
const SHELL_URLS = [
  '/',
  '/manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_URLS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== CACHE_NAME && k !== SKINS_CACHE)
          .map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Never intercept: API, WS, cross-origin
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/ws') ||
    url.origin !== self.location.origin
  ) {
    return;
  }

  // For navigation requests: try network, fall back to cached shell
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() =>
        caches.match('/').then((r) => r ?? fetch(request))
      )
    );
    return;
  }

  // Room artwork: cache-first, only good responses are kept, oldest entries go past the bound.
  // A failed, missing or non-image response is never cached, so the page falls back to its room colour.
  if (url.pathname.startsWith('/skins/') && request.method === 'GET') {
    event.respondWith(
      caches.open(SKINS_CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        // The server answers an unknown path with the SPA's HTML (200), so also require an image type.
        const type = (response && response.headers && response.headers.get('content-type')) || '';
        if (response && response.ok && response.status === 200 && type.startsWith('image/')) {
          await cache.put(request, response.clone());
          const keys = await cache.keys();
          for (let i = 0; i < keys.length - SKINS_MAX_ENTRIES; i++) await cache.delete(keys[i]);
        }
        return response;
      })
    );
    return;
  }

  // For static assets: cache-first (Vite hashes ensure freshness)
  if (
    url.pathname.startsWith('/assets/') ||
    url.pathname.startsWith('/icons/') ||
    url.pathname === '/apple-touch-icon.png'
  ) {
    event.respondWith(
      caches.match(request).then(
        (cached) => cached ?? fetch(request).then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          return response;
        })
      )
    );
    return;
  }

  // Everything else: network-only
});
