const CACHE_NAME = 'swgoh-shell-v32';
const FILES = [
  './',
  './index.html',
  './app.js',
  './styles.css',
  './manifest.json'
];

// The static catalogue lives beside the worker (e.g. /gac-helper/catalogue/).
const CATALOGUE_PATH = new URL('catalogue/', self.location).pathname;

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

  // Cross-origin requests (the Apps Script roster proxy) are never handled here.
  if (requestUrl.origin !== self.location.origin) return;

  // Nor is the static catalogue: the browser fetches it directly, so the worker
  // never caches or serves stale catalogue data. app.js validates it and owns
  // the only catalogue cache.
  if (requestUrl.pathname.startsWith(CATALOGUE_PATH)) return;

  event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
});
