// Offline support: the app's own files are fetched fresh when online and served from cache
// when not; the pinned CDN builds never change, so they come from cache once fetched.
// API calls (Anthropic, Firestore, sign-in) are never touched here.
const CACHE = 'kc-v1';
const SHELL = ['./', './index.html', './app.js', './config.js', './manifest.webmanifest', './icons/icon-192.png', './icons/apple-touch-icon.png'];
const CDN = ['https://www.gstatic.com/firebasejs/', 'https://cdn.jsdelivr.net/npm/', 'https://fonts.googleapis.com/', 'https://fonts.gstatic.com/'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) e.respondWith(networkFirst(req));
  else if (CDN.some(p => req.url.startsWith(p))) e.respondWith(cacheFirst(req));
});

async function networkFirst(req){
  const cache = await caches.open(CACHE);
  try {
    // Revalidate with the server so an update shows up on the next open, not after the HTTP cache
    // expires; a slow connection falls back to the cached copy after a few seconds.
    const fresh = fetch(req.url, {cache: 'no-cache', credentials: 'same-origin'});
    const res = await Promise.race([fresh, new Promise((_, no) => setTimeout(() => no(new Error('slow')), 4000))]);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req, {ignoreSearch: true}) || (req.mode === 'navigate' && await cache.match('./index.html'));
    return hit || Response.error();
  }
}

async function cacheFirst(req){
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
  return res;
}
