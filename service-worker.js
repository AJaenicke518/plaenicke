// Minimal service worker: lets iOS treat this as an installable app and keeps
// it working offline. Uses a NETWORK-FIRST strategy so that when you redeploy an
// updated version, the phone shows the new version (falling back to the cached
// copy only when offline). Cache-first would freeze the installed app on the
// first version forever — the wrong behavior for an app you plan to keep growing.

// The '-2' generation exists to purge caches written by the previous V4 service
// worker, which cached cross-origin GETs and so could hold /feed ICS responses
// keyed by a URL containing the feed's capability token. `activate` deletes
// every cache whose name isn't this one, so the rename is what actually evicts
// them; the fetch-handler guard below only stops new ones being written.
const CACHE = 'plaenicke-v4-2';
const ASSETS = [
  '.', 'index.html', 'styles.css', 'manifest.json',
  'js/app.js', 'js/storage.js', 'js/items.js', 'js/dateparse.js', 'js/calendar.js',
  'js/config.js', 'js/smartadd.js', 'js/preview.js', 'js/voice.js',
  'js/timegrid.js', 'js/theme.js', 'js/settings.js', 'js/dayview.js', 'js/weekview.js',
  'js/ics.js', 'js/tzmap.js', 'js/feeds.js',
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
  // Same-origin app shell only. Cross-origin GETs are left entirely to the
  // browser: the Worker's /feed proxy is one, and caching an ICS response would
  // (a) key up to a megabyte of calendar data by a URL containing the feed's
  // capability token and (b) let an offline manual sync be served a stale feed
  // as a *success*, stamping fetchedAt=now so the row claims "fetched just now"
  // with no error. Offline behavior for feeds is the last-good localStorage
  // cache in js/feeds.js, not Cache Storage.
  if (new URL(event.request.url).origin !== self.location.origin) return;
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
