/* Service Worker: يخلي التطبيق يفتح من غير نت */
const VER = 'v6';                       // غيّر الرقم ده كل ما تعدّل ملفات التطبيق عشان الكاش يتحدّث
const CACHE = 'attendance-' + VER;
const CORE = ['./', './index.html', './offline.js', './manifest.json', './icon-192.png', './icon-512.png'];
const CDN = [
  'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js',
  'https://unpkg.com/html5-qrcode',
  'https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
  'https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;800&display=swap'
];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await Promise.allSettled([
      ...CORE.map(u => c.add(u)),
      ...CDN.map(u => c.add(new Request(u, { mode: 'no-cors' })))
    ]);
    self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith('attendance-') && k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.hostname.endsWith('supabase.co')) return;       // بيانات سوبابيز ما تتخزنش هنا (offline.js بيتولاها)

  // فتح الصفحة: النت الأول (عشان التحديثات) بمهلة 4 ثواني، وإلا من الكاش
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      const c = await caches.open(CACHE);
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 4000);
        const r = await fetch(req, { signal: ctrl.signal });
        clearTimeout(t);
        if (r && r.ok) c.put('./index.html', r.clone());
        return r;
      } catch (err) {
        return (await c.match('./index.html', { ignoreSearch: true })) || (await c.match('./')) || Response.error();
      }
    })());
    return;
  }

  // باقي الملفات (سكريبتات، خطوط، صور): من الكاش فوراً وتتحدّث في الخلفية
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    const cached = await c.match(req);
    const net = fetch(req).then(r => {
      if (r && (r.ok || r.type === 'opaque')) c.put(req, r.clone());
      return r;
    }).catch(() => null);
    return cached || (await net) || Response.error();
  })());
});
