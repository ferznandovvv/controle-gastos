// Rede primeiro, cache como reserva: o app abre mesmo sem internet
// e sempre pega a versão nova quando há conexão.
const CACHE = 'gastos-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const estatico = url.origin === location.origin
    || url.hostname === 'www.gstatic.com'
    || url.hostname === 'cdn.jsdelivr.net';
  if (!estatico || url.pathname.startsWith('/__/')) return;

  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copia = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copia));
        }
        return res;
      })
      .catch(() => caches.match(req)),
  );
});
