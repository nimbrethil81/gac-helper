const CACHE_NAME = 'swgoh-shell-v19';
const FILES = [
  './',
  './index.html',
  './app.js',
  './styles.css',
  './manifest.json'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(FILES)));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys
        .filter(key => key.startsWith('swgoh-') && key !== CACHE_NAME)
        .map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const requestUrl = new URL(event.request.url);

  // The Apps Script catalogue is intentionally never handled by the service
  // worker. app.js validates and owns the only fallback cache for that data.
  if (requestUrl.origin !== self.location.origin) return;

  event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
});
