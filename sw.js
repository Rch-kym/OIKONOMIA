// Service worker: guarda o app para abrir offline e recebe o arquivo compartilhado pelo menu "Compartilhar" do Android.
const STATIC = 'conc-static-v17';
const FILES = ['./', 'index.html', 'app.css', 'app.js', 'seed.json', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/logo-wordmark.png',
  'src/pdf.js', 'src/audit.js', 'src/filter.js', 'src/local.js', 'src/assistant.js', 'vendor/pdf.min.mjs', 'vendor/pdf.worker.min.mjs', 'src/util.js', 'src/ofx.js', 'src/csv.js', 'src/rules.js', 'src/card.js', 'src/recurring.js', 'src/ledger.js', 'src/summary.js', 'src/forecast.js', 'src/sheets.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(STATIC).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('conc-static') && k !== STATIC).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method === 'POST' && url.pathname.endsWith('/share-target')) {
    e.respondWith((async () => {
      try {
        const form = await req.formData();
        const file = form.get('extrato');
        if (file && file.size) {
          const cache = await caches.open('conc-share');
          await cache.put('shared-file', new Response(file, { headers: { 'x-file-name': encodeURIComponent(file.name || 'extrato') } }));
        }
      } catch (err) { /* segue para o app mesmo assim */ }
      return Response.redirect(new URL('./?compartilhado=1', self.registration.scope).href, 303);
    })());
    return;
  }
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  // rede primeiro (para pegar atualizações), cache como reserva offline
  e.respondWith(fetch(req).then((res) => {
    const copy = res.clone();
    caches.open(STATIC).then((c) => c.put(req, copy)).catch(() => {});
    return res;
  }).catch(() => caches.match(req).then((r) => r || caches.match('index.html'))));
});
