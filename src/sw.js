// Offline support for the web version of SpriteStrack.
// This is a template: the build (see vite.config.ts) fills in a build id and
// the list of every built file and writes the result to dist/sw.js.
// All files are cached when the worker installs, so the editor opens offline
// after the first visit. Pages are fetched from the network first (so updates
// arrive) and fall back to the cache; everything else comes from the cache.
const CACHE = 'spritestrack-' + __BUILD_ID__;
const FILES = ['./', ...__BUILD_FILES__];
// Some servers send `Vary: Origin`, which would stop the cached copies from
// matching the page's `crossorigin` script and style requests
const MATCH = { ignoreVary: true };

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(FILES))
      .then(() => self.skipWaiting()),
  );
});

// Drop the caches of older builds
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  // One entry per page, whatever the query string
  const key = new URL(request.url);
  key.search = '';
  try {
    const res = await fetch(request);
    if (res.ok) cache.put(key.href, res.clone());
    return res;
  } catch {
    return (await cache.match(key.href, MATCH)) || (await cache.match('./index.html', MATCH)) || Response.error();
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request, MATCH);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) cache.put(request, res.clone());
  return res;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.mode === 'navigate' || url.pathname.endsWith('/') || url.pathname.endsWith('.html') || url.pathname.endsWith('.webmanifest')) {
    event.respondWith(networkFirst(req));
  } else {
    event.respondWith(cacheFirst(req));
  }
});
