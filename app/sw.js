// Service worker: sovellus toimii myös ilman verkkoyhteyttä (esim. kirkossa).
// Nuotit itse ovat IndexedDB:ssä; tämä välimuistittaa vain sovelluksen tiedostot.
// GitHubin julkaisu (.github/workflows/pages.yml) vaihtaa CACHE-arvon jokaisella julkaisulla
// commitin tunnisteeseen, joten asennetut sovellukset päivittyvät ilman käsin tehtävää muutosta.

const CACHE = 'nuotit-v6';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './db.js',
  './viewer.js',
  './reorder.js',
  './notes.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './vendor/pdf.min.js',
  './vendor/pdf.worker.min.js',
];

self.addEventListener('install', (event) => {
  // cache: 'reload' ohittaa selaimen HTTP-välimuistin, jotta uusi versio saa varmasti uudet tiedostot.
  const requests = ASSETS.map((url) => new Request(url, { cache: 'reload' }));
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(requests)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Välimuisti ensin, päivitys taustalla (stale-while-revalidate).
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const key = req.mode === 'navigate' ? './index.html' : req;
    const cached = await cache.match(key, { ignoreSearch: req.mode === 'navigate' });
    const network = fetch(req).then((res) => {
      if (res.ok && req.mode !== 'navigate') cache.put(req, res.clone());
      else if (res.ok) cache.put('./index.html', res.clone());
      return res;
    }).catch(() => null);
    if (cached) {
      event.waitUntil(network);
      return cached;
    }
    return (await network) || new Response('Ei verkkoyhteyttä', { status: 503 });
  })());
});
