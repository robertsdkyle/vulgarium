/**
 * Minimal service worker: makes the phone controller installable and lets
 * the shell open instantly on a flaky connection. Network-first for
 * everything, so a deploy reaches phones on the next load; the cache is only
 * a fallback. Room lookups and the game socket are never touched.
 */
const CACHE = 'pb-shell-v1';
const SHELL = ['/', '/style.css', '/js/phone.js', '/js/realtime.js', '/manifest.webmanifest', '/icons/icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/rooms') || url.pathname === '/healthz' || url.pathname === '/host') return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
