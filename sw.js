/* Resume SAT service worker: makes the site installable and opens the last copy when offline.
   It caches only the site's own pages and icons. Resumes, photos and job descriptions are never stored here. */
const CACHE = 'rsat-v1';
const CORE = ['/', '/guides.html', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== self.location.origin) return;   /* never touch other sites or uploads */
  if (r.mode === 'navigate') {
    /* pages: always try the network first so updates show at once; fall back to the saved copy offline */
    e.respondWith(fetch(r).then(res => { const copy = res.clone(); if (res.ok) caches.open(CACHE).then(c => c.put(r, copy)); return res; })
      .catch(() => caches.match(r).then(m => m || caches.match('/'))));
    return;
  }
  if (u.pathname.startsWith('/icons/')) e.respondWith(caches.match(r).then(m => m || fetch(r)));
});
