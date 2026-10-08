/* Le Spinners service worker.
   - API calls are never cached: availability, holds and payments are live.
   - Pages and static files are network-first with an offline fallback. */

const VERSION = 'ls-2026-10-09-staff-management-1';
const SHELL = [
  '/',
  '/admin/',
  '/staff/',
  '/css/app.css',
  '/css/player.css',
  '/css/landing.css',
  '/css/admin.css',
  '/manifest.webmanifest',
  '/icons/favicon.svg',
  '/icons/icon-192.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) => Promise.all(SHELL.map((url) => cache.add(url).catch(() => undefined)))),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

function timeout(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms));
}

async function networkFirst(event, fallbackUrl) {
  const request = event.request;
  const cache = await caches.open(VERSION);
  try {
    const response = await Promise.race([fetch(request), timeout(4000)]);
    if (response && response.ok && response.type === 'basic') event.waitUntil(cache.put(request, response.clone()).catch(() => undefined));
    return response;
  } catch {
    const cached = (await cache.match(request)) || (fallbackUrl && (await cache.match(fallbackUrl)));
    if (cached) return cached;
    return new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // fonts etc. use the browser cache
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/cdn-cgi/')) return; // always live, never cached
  if (request.mode === 'navigate') {
    // Each app falls back to its own shell. Shells hold no account data; screens load it live.
    const shell = url.pathname.startsWith('/admin') || url.pathname.startsWith('/revenue') ? '/admin/' : url.pathname.startsWith('/staff') ? '/staff/' : '/';
    event.respondWith(networkFirst(event, shell));
    return;
  }
  if (/\.(?:js|css|png|svg|webmanifest|woff2?)$/.test(url.pathname)) {
    event.respondWith(networkFirst(event));
  }
});
