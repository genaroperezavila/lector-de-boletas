// GastosPro · by Genaro_Perez — service worker: la app completa queda guardada para funcionar sin internet
const CACHE = 'gastospro-ecdb1dc1c7';
const FILES = [
 "./",
 "css/style.css",
 "icons/icon-192.png",
 "icons/icon-512.png",
 "icons/maskable-512.png",
 "js/app.js",
 "js/db.js",
 "js/parse.js",
 "js/rules.js",
 "js/scan.js",
 "js/xlsx.js",
 "lib/comunas.json",
 "lib/jszip.min.js",
 "lib/lang/spa.traineddata.gz",
 "lib/tesseract-core/tesseract-core-lstm.wasm.js",
 "lib/tesseract-core/tesseract-core-relaxedsimd-lstm.wasm.js",
 "lib/tesseract-core/tesseract-core-simd-lstm.wasm.js",
 "lib/tesseract.min.js",
 "lib/worker.min.js",
 "lib/zxing/zxing-reader.js",
 "lib/zxing/zxing_reader.wasm",
 "manifest.webmanifest",
 "index.html"
];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('gastospro-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((r) => r || fetch(e.request).catch(() => caches.match('index.html'))));
});
