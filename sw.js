/* 小书房 离线缓存（Service Worker）
 * 以后修改了代码，把下面的版本号 v1 改成 v2、v3…，手机上重新打开两次即可更新。 */
const CACHE = 'xiaoshufang-v3';
const ASSETS = [
  './', './index.html', './style.css', './app.js', './jszip.min.js', './manifest.webmanifest',
  './pdfjs/pdf.min.js', './pdfjs/pdf.worker.min.js',
  './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-512.png', './icons/apple-touch-icon.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 先用缓存（秒开、断网可用），同时在后台联网更新缓存
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    caches.open(CACHE).then(async cache => {
      const cached = await cache.match(req, { ignoreSearch: true }) ||
        (req.mode === 'navigate' ? await cache.match('./index.html') : null);
      const network = fetch(req).then(res => {
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
