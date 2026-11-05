/* Service Worker: يخلي التطبيق يفتح من غير نت */
const VER = 'v10';                       // غيّر الرقم ده كل ما تعدّل ملفات التطبيق عشان الكاش يتحدّث
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
    // الملفات المحلية: add عادي
    // مكتبات الـ CDN: لازم fetch ثم put، لأن cache.add بيرفض الردود الـ opaque (no-cors) وماكانتش بتتخزن فعلاً
    await Promise.allSettled([
      ...CORE.map(u => c.add(u)),
      ...CDN.map(async u => {
        const r = await fetch(new Request(u, { mode: 'no-cors' }));
        if (r && (r.ok || r.type === 'opaque')) await c.put(u, r);
      })
    ]);
    self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    const old = keys.filter(k => k.startsWith('attendance-') && k !== CACHE);
    const cur = await caches.open(CACHE);
    // ننقل أي ملف متخزن في الكاش القديم (المكتبات والخطوط) للجديد قبل المسح، عشان تحديث الإصدار ما يسيبش التطبيق من غير مكتباته أوفلاين
    for (const k of old) {
      try {
        const oc = await caches.open(k);
        for (const rq of await oc.keys()) {
          if (!(await cur.match(rq))) { const rs = await oc.match(rq); if (rs) await cur.put(rq, rs); }
        }
      } catch (err) { /* مش مشكلة */ }
    }
    await Promise.all(old.map(k => caches.delete(k)));
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

  // ملفات التطبيق نفسها: النت الأول (عشان التحديث يوصل فوراً) وإلا الكاش
  if (url.origin === location.origin && /\.(js|json|html)$/.test(url.pathname)) {
    e.respondWith((async () => {
      const c = await caches.open(CACHE);
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 4000);
        const r = await fetch(req, { signal: ctrl.signal });
        clearTimeout(t);
        if (r && r.ok) c.put(req, r.clone());
        return r;
      } catch (err) {
        return (await c.match(req, { ignoreSearch: true })) || Response.error();
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
