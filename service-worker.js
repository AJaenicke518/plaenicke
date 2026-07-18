// Minimal service worker: lets iOS treat this as an installable app and keeps
// it working offline. Uses a NETWORK-FIRST strategy so that when you redeploy an
// updated version, the phone shows the new version (falling back to the cached
// copy only when offline). Cache-first would freeze the installed app on the
// first version forever — the wrong behavior for an app you plan to keep growing.
const CACHE = 'plaenicke-v1';
const ASSETS = [
  '.', 'index.html', 'styles.css', 'manifest.json',
  'js/app.js', 'js/storage.js', 'js/items.js', 'js/dateparse.js', 'js/calendar.js',
  'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE).then((c) => c.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
