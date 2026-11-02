const CACHE = 'drug-monitor-v2';
const FILES = [
  './', 'index.html', 'manifest.json', 'icon.svg',
  'src/app.js', 'src/pk.js', 'src/interactions.js', 'src/store.js', 'src/oplock.js', 'src/motion.js', 'src/style.css',
  'data/drugs.json', 'data/products.json', 'data/interactions.json', 'data/limits.json',
];

self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES))));

self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))),
));

// Network first so corrected drug data reaches the user as soon as they are online.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })),
  );
});
