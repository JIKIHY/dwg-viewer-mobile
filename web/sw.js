// 오프라인용 캐시 (웹 주소로 열었을 때만. iOS 앱에서는 쓰지 않는다)
const CACHE = 'dwgv-3';
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'store.js', 'convert-worker.js', 'worker-env.js', 'core/dxf.js', 'core/scene.js', 'core/view.js', 'tileview.js',
  'vendor/earcut.min.js', 'vendor/libredwg/libredwg-web.js', 'vendor/libredwg/libredwg-web.wasm', 'manifest.webmanifest', 'icon-192.png', 'icon-180.png'];
self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((r) => r || fetch(e.request)));
});
