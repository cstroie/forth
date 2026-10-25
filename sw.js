/*
 * Service worker: serves the app from cache so it works offline.
 * Stale-while-revalidate: cached files load instantly and are refreshed
 * in the background, so an update shows up on the next visit.
 */
const CACHE = 'forth-v1';
const SHELL = [
    './',
    'index.html',
    'forth.js',
    'manifest.webmanifest',
    'icons/icon-32.png',
    'icons/icon-180.png',
    'icons/icon-192.png',
    'icons/icon-512.png'
];
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', event => {
    event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', event => {
    const req = event.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);
    if (url.origin !== location.origin && !FONT_HOSTS.includes(url.hostname)) return;

    event.respondWith(caches.open(CACHE).then(async cache => {
        const cached = await cache.match(req, { ignoreSearch: true });
        const network = fetch(req).then(res => {
            if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
            return res;
        }).catch(() => cached);
        return cached || network;
    }));
});
