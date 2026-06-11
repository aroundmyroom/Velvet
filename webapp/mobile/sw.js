/* velvet-mobile — Service Worker */
const CACHE_ART = 'velvet-art-v1';
const MAX_ART   = 500;

self.addEventListener('install',  () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', e => {
  const reqUrl = new URL(e.request.url);
  if (e.request.method === 'GET' && reqUrl.origin === self.location.origin &&
      (reqUrl.pathname.includes('/album-art/') || reqUrl.pathname.includes('/api/v1/albums/art-file'))) {
    e.respondWith(cacheFirst(e.request));
  }
});

async function cacheFirst(request) {
  const cache  = await caches.open(CACHE_ART);
  const cached = await cache.match(request);
  if (cached) return cached;
  const reqUrl = new URL(request.url);
  const response = await fetch(reqUrl.toString(), { method: 'GET', credentials: 'same-origin' });
  if (response.ok) {
    const keys = await cache.keys();
    if (keys.length >= MAX_ART) await cache.delete(keys[0]);
    await cache.put(request, response.clone());
  }
  return response;
}
