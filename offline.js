/* ============================================================
   offline.js — طبقة الأوفلاين + المزامنة مع Supabase
   - كل القراءات بتتخزن محلياً (IndexedDB) وتتقرا منها لو مفيش نت
   - كل الكتابات (insert/update/upsert/delete) لو فشلت بسبب النت بتتسجل في طابور
   - أول ما النت يرجع الطابور بيتبعت بالترتيب
   - دخول أوفلاين لو الجهاز سجّل دخول بالنت قبل كده
   v2:
   - منع التكرار (حضور: تاريخ+مخدوم | مخدوم: الاسم الكامل+تاريخ الميلاد+التليفون) أوفلاين وأونلاين
   - طلب تخزين دائم من المتصفح (Chrome/Android + Safari/iPhone) عشان البيانات الأوفلاين ما تتمسحش
   - العملية ما بتتشالش من الجهاز غير لما السيرفر يقبلها ثم تتأكد في أول تحميل بيانات بعدها
   ============================================================ */
(function () {
  'use strict';

  const FLAG = 'ofl_session';          // علامة "الجلسة شغالة" في التبويب (sessionStorage)
  const CRED_KEY = 'ofl_cred_v1';      // بيانات التحقق للدخول أوفلاين (هاش مش باسورد)
  const TEMP_ID_TABLES = { attendance: true }; // جداول id فيها بيتولد من قاعدة البيانات

  let real = null;        // عميل Supabase الأصلي
  let realAuth = null;
  let memCreds = null;    // بيانات الدخول في الذاكرة بس (لو دخل أوفلاين) عشان نسجل دخول حقيقي لما النت يرجع
  let qlen = 0, failedCount = 0, syncing = false;
  const mem = {};         // table -> rows (نسخة محلية)
  const memQueue = [];    // طابور احتياطي في الذاكرة لو IndexedDB مش متاح

  /* ---------- IndexedDB ---------- */
  let dbp = null;
  function openDB() {
    if (dbp) return dbp;
    dbp = new Promise(res => {
      if (typeof indexedDB === 'undefined') { res(null); return; }
      try {
        const r = indexedDB.open('church_offline', 2);
        r.onupgradeneeded = () => {
          const d = r.result;
          if (!d.objectStoreNames.contains('cache')) d.createObjectStore('cache', { keyPath: 'table' });
          if (!d.objectStoreNames.contains('queue')) d.createObjectStore('queue', { keyPath: 'seq', autoIncrement: true });
          if (!d.objectStoreNames.contains('failed')) d.createObjectStore('failed', { keyPath: 'seq', autoIncrement: true });
          if (!d.objectStoreNames.contains('unverified')) d.createObjectStore('unverified', { keyPath: 'seq', autoIncrement: true });
        };
        r.onsuccess = () => res(r.result);
        r.onerror = () => res(null);
        r.onblocked = () => res(null);
      } catch (e) { res(null); }
    });
    return dbp;
  }
  async function idb(store, mode, fn) {
    const d = await openDB();
    if (!d) return undefined;
    return new Promise(res => {
      try {
        const t = d.transaction(store, mode);
        const rq = fn(t.objectStore(store));
        t.oncomplete = () => res(rq && rq.result);
        t.onerror = t.onabort = () => res(undefined);
      } catch (e) { res(undefined); }
    });
  }
  async function qAll() {
    const d = await openDB();
    if (!d) return memQueue.slice();
    return (await idb('queue', 'readonly', s => s.getAll())) || [];
  }
  async function qAdd(op) {
    const d = await openDB();
    if (!d) { op.seq = (memQueue.length ? memQueue[memQueue.length - 1].seq : 0) + 1; memQueue.push(op); }
    else await idb('queue', 'readwrite', s => s.add(op));
    qlen++; badge();
  }
  async function qDel(seq) {
    const d = await openDB();
    if (!d) { const i = memQueue.findIndex(x => x.seq === seq); if (i >= 0) memQueue.splice(i, 1); }
    else await idb('queue', 'readwrite', s => s.delete(seq));
    qlen = Math.max(0, qlen - 1); badge();
  }
  async function failedAdd(op, err) {
    failedCount++;
    await idb('failed', 'readwrite', s => s.add({ op, err: String(err && err.message || err), at: Date.now() }));
  }
  function persist(table) { idb('cache', 'readwrite', s => s.put({ table, rows: mem[table] || [] })); }

  /* ---------- تخزين دائم (عشان أندرويد/آيفون ما يمسحوش البيانات الأوفلاين) ---------- */
  let persistState = null;
  async function requestPersist() {
    try {
      if (navigator.storage && navigator.storage.persist) {
        if (navigator.storage.persisted && (await navigator.storage.persisted())) persistState = true;
        else persistState = !!(await navigator.storage.persist());
      }
    } catch (e) { /* مش مشكلة */ }
    return persistState;
  }
  const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent || '') || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isStandalone = () => { try { return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; } catch (e) { return false; } };

  /* ---------- منع التكرار ---------- */
  function normName(s) {
    return String(s == null ? '' : s).normalize('NFKC').toLowerCase()
      .replace(/[\u064B-\u0652\u0640]/g, '').replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
      .replace(/\s+/g, ' ').trim();
  }
  function phoneKey(s) {
    let d = String(s == null ? '' : s).replace(/[٠-٩]/g, c => '٠١٢٣٤٥٦٧٨٩'.indexOf(c)).replace(/\D/g, '');
    if (d.startsWith('0020')) d = '0' + d.slice(4);
    else if (d.startsWith('20') && d.length >= 12) d = '0' + d.slice(2);
    return d;
  }
  // المخدوم المتكرر = نفس الاسم الكامل + نفس تاريخ الميلاد + نفس التليفون (مش الاسم الأول بس)
  function memberKey(r) { return normName(r && r.name) + '|' + String((r && r.birthdate) || '').trim() + '|' + phoneKey(r && r.phone); }
  function dupKey(table, r) {
    if (!r) return null;
    if (table === 'attendance') return (r.meeting_date != null && r.member_id != null) ? r.meeting_date + '|' + r.member_id : null;
    if (table === 'members') return r.name ? memberKey(r) : null;
    return null;
  }
  const DEDUPE = { attendance: true, members: true };
  function dropDups(q) {
    const list = Array.isArray(q.payload) ? q.payload : [q.payload];
    const seen = new Set((mem[q.t] || []).map(r => dupKey(q.t, r)).filter(Boolean));
    const keep = [], skipped = [];
    list.forEach(p => {
      const k = dupKey(q.t, p);
      if (k && seen.has(k)) skipped.push(p); else { keep.push(p); if (k) seen.add(k); }
    });
    q.payload = Array.isArray(q.payload) ? keep : (keep[0] || null);
    return { kept: keep.length, skipped };
  }
  // قبل الإرسال الفعلي: نتأكد إن السيرفر مفيهوش نفس السجل (لو اتسجل من جهاز تاني)
  async function serverDupFilter(op) {
    const list = Array.isArray(op.payload) ? op.payload : [op.payload];
    const keep = [];
    for (const p of list) {
      const k = dupKey(op.t, p);
      if (!k) { keep.push(p); continue; }
      let q = real.from(op.t).select('*');
      if (op.t === 'attendance') q = q.eq('meeting_date', p.meeting_date).eq('member_id', p.member_id);
      else if (p.birthdate) q = q.eq('birthdate', p.birthdate);
      else q = q.eq('name', p.name);
      let r;
      try { r = await q.limit(200); } catch (e) { r = { error: e, status: 0 }; }
      if (r.error) { if (isNetErr(r.error) || r.status === 0) return 'net'; keep.push(p); continue; }
      if (!(r.data || []).some(row => dupKey(op.t, row) === k)) keep.push(p);
    }
    if (!keep.length) return { skipAll: true };
    return { op: Object.assign({}, op, { payload: Array.isArray(op.payload) ? keep : keep[0] }) };
  }

  /* ---------- التأكد إن العملية اترفعت فعلاً وثبتت ---------- */
  const VERIFY_WINDOW = 10 * 60 * 1000;
  function stripSeq(o) { const c = Object.assign({}, o); delete c.seq; return c; }
  async function markSynced(op) {
    await idb('unverified', 'readwrite', s => s.add({ t: op.t, op: stripSeq(op), syncedAt: Date.now(), miss: 0 }));
    await qDel(op.seq);
  }
  function confirmed(o, rows) {
    if (o.op !== 'insert' && o.op !== 'upsert') return true;     // التعديل/الحذف مش بنتحقق منهم (ممكن يتغيروا بعدها)
    const list = Array.isArray(o.payload) ? o.payload : [o.payload];
    const keys = (o.op === 'upsert' && o.opts && o.opts.onConflict) ? String(o.opts.onConflict).split(',').map(s => s.trim()) : null;
    return list.every(p => {
      const dk = dupKey(o.t, p);
      if (dk) return rows.some(r => dupKey(o.t, r) === dk);
      if (keys) return rows.some(r => keys.every(k => String(r[k]) === String(p[k])));
      if (p && p.id != null && o.t !== 'attendance') return rows.some(r => String(r.id) === String(p.id));
      return true;
    });
  }
  async function verifyTable(table, rows) {
    const all = (await idb('unverified', 'readonly', s => s.getAll())) || [];
    let requeued = 0;
    for (const x of all) {
      if (x.t !== table) continue;
      if (Date.now() - x.syncedAt > VERIFY_WINDOW && x.miss < 2) { await idb('unverified', 'readwrite', s => s.delete(x.seq)); continue; }
      if (confirmed(x.op, rows)) { await idb('unverified', 'readwrite', s => s.delete(x.seq)); continue; }   // ثبتت ✅ دلوقتي بس نقدر نتخلص من النسخة المحلية
      x.miss++;
      if (x.miss < 2) { await idb('unverified', 'readwrite', s => s.put(x)); continue; }                   // نستنى تحميل تاني قبل ما نحكم
      await idb('unverified', 'readwrite', s => s.delete(x.seq));
      const tries = (x.op.tries || 0) + 1;
      if (tries > 3) { await failedAdd(x.op, 'السيرفر قبل العملية بس ما ظهرتش في البيانات'); continue; }
      await qAdd(Object.assign({}, x.op, { tries }));
      requeued++;
    }
    if (requeued) setTimeout(() => flush(), 500);
  }

  const ready = (async function () {
    try {
      const all = await idb('cache', 'readonly', s => s.getAll());
      (all || []).forEach(x => { mem[x.table] = x.rows || []; });
      qlen = (await qAll()).length;
      const f = await idb('failed', 'readonly', s => s.count());
      failedCount = f || 0;
    } catch (e) { /* مش مشكلة */ }
    badge();
  })();

  /* ---------- أدوات ---------- */
  function isNetErr(e) {
    if (!e) return false;
    if (typeof TypeError !== 'undefined' && e instanceof TypeError) return true;
    if (e.status === 0 || e.name === 'AuthRetryableFetchError') return true;
    const m = String(e.message || e) + ' ' + String(e.details || '');
    return /failed to fetch|networkerror|network request failed|load failed|fetch failed|abort|timeout|offline/i.test(m);
  }
  function isAuthErr(r) {
    const e = r && r.error;
    return (r && (r.status === 401 || r.status === 403)) ||
      (e && (e.code === '42501' || /jwt|row-level security|permission denied/i.test(e.message || '')));
  }
  function match(row, f) {
    return f.every(([k, c, v]) => {
      const a = row[c];
      if (k === 'eq') return String(a) === String(v);
      if (k === 'neq') return String(a) !== String(v);
      if (k === 'in') return (v || []).map(String).includes(String(a));
      return true;
    });
  }
  function cmp(a, b) {
    if (a == null) return b == null ? 0 : -1;
    if (b == null) return 1;
    return a < b ? -1 : a > b ? 1 : 0;
  }
  const clone = o => (o == null ? o : JSON.parse(JSON.stringify(o)));

  /* ---------- تطبيق العملية على النسخة المحلية ---------- */
  function applyLocal(q) {
    const rows = mem[q.t] || (mem[q.t] = []);
    const out = [];
    const list = Array.isArray(q.payload) ? q.payload : [q.payload];
    if (q.op === 'insert') {
      list.forEach((p, i) => {
        const r = Object.assign({}, p);
        if (r.id == null && TEMP_ID_TABLES[q.t]) r.id = -(Date.now() * 10 + i);
        rows.push(r); out.push(r);
      });
    } else if (q.op === 'update') {
      rows.forEach(r => { if (match(r, q.f)) { Object.assign(r, q.payload); out.push(r); } });
    } else if (q.op === 'delete') {
      mem[q.t] = rows.filter(r => { const m = match(r, q.f); if (m) out.push(r); return !m; });
    } else if (q.op === 'upsert') {
      const keys = String((q.opts && q.opts.onConflict) || 'id').split(',').map(s => s.trim());
      list.forEach(p => {
        const ex = rows.find(r => keys.every(k => String(r[k]) === String(p[k])));
        if (ex) { Object.assign(ex, p); out.push(ex); }
        else { const r = Object.assign({}, p); rows.push(r); out.push(r); }
      });
    }
    persist(q.t);
    return out;
  }

  function readLocal(q) {
    let rows = (mem[q.t] || []).filter(r => match(r, q.f));
    (q.ord || []).slice().reverse().forEach(([c, d]) => { rows.sort((a, b) => cmp(a[c], b[c]) * d); });
    if (q.rng) rows = rows.slice(q.rng[0], q.rng[1] + 1);
    if (q.lim != null) rows = rows.slice(0, q.lim);
    return rows.map(r => Object.assign({}, r));
  }

  /* ---------- بناء الطلب الحقيقي ---------- */
  function buildReal(o) {
    let q = real.from(o.t);
    if (o.op === 'select') q = q.select(o.cols || '*');
    else if (o.op === 'insert') q = q.insert(o.payload, o.opts || undefined);
    else if (o.op === 'update') q = q.update(o.payload);
    else if (o.op === 'upsert') q = q.upsert(o.payload, o.opts || undefined);
    else if (o.op === 'delete') q = q.delete();
    if (o.sel) q = q.select(o.cols || '*');
    o.f.forEach(([k, c, v]) => { q = q[k](c, v); });
    (o.ord || []).forEach(([c, d]) => { q = q.order(c, { ascending: d > 0 }); });
    if (o.rng) q = q.range(o.rng[0], o.rng[1]);
    if (o.lim != null) q = q.limit(o.lim);
    return q;
  }

  /* ---------- بديل لـ from(table) ---------- */
  class Q {
    constructor(t) { this.t = t; this.op = null; this.payload = null; this.opts = null; this.f = []; this.ord = []; this.rng = null; this.lim = null; this.sel = false; this.cols = '*'; }
    select(c) { if (this.op == null) { this.op = 'select'; this.cols = c || '*'; } else { this.sel = true; if (c) this.cols = c; } return this; }
    insert(p, o) { this.op = 'insert'; this.payload = p; this.opts = o || null; return this; }
    update(p) { this.op = 'update'; this.payload = p; return this; }
    upsert(p, o) { this.op = 'upsert'; this.payload = p; this.opts = o || null; return this; }
    delete() { this.op = 'delete'; return this; }
    eq(c, v) { this.f.push(['eq', c, v]); return this; }
    neq(c, v) { this.f.push(['neq', c, v]); return this; }
    in(c, v) { this.f.push(['in', c, v]); return this; }
    order(c, o) { this.ord.push([c, o && o.ascending === false ? -1 : 1]); return this; }
    range(a, b) { this.rng = [a, b]; return this; }
    limit(n) { this.lim = n; return this; }
    then(a, b) { return this.run().then(a, b); }
    catch(b) { return this.run().catch(b); }

    serial() {
      return { t: this.t, op: this.op, payload: clone(this.payload), opts: clone(this.opts), f: clone(this.f), sel: this.sel, cols: this.cols, ts: Date.now() };
    }

    async run() {
      await ready;
      if (this.op === 'select' || this.op == null) return this.runRead();
      return this.runWrite();
    }

    async runRead() {
      this.op = 'select';
      if (qlen === 0 && navigator.onLine) {
        try {
          const r = await buildReal(this);
          if (!r.error || !(isNetErr(r.error) || r.status === 0)) return r;
        } catch (e) { if (!isNetErr(e)) throw e; }
      }
      // أوفلاين أو فيه عمليات معلقة: من النسخة المحلية
      return { data: readLocal(this), error: null, local: true, status: 200 };
    }

    async runWrite() {
      if (navigator.onLine) {
        if (qlen > 0) await flush({ silent: true });
        if (qlen === 0) {
          try {
            const r = await buildReal(this);
            if (!r.error || !(isNetErr(r.error) || r.status === 0)) return r;
          } catch (e) { if (!isNetErr(e)) throw e; }
        }
      }
      // أوفلاين: نمنع التكرار الأول، بعدين نطبق محلياً ونسجل في الطابور
      if (this.op === 'insert' && DEDUPE[this.t]) {
        const d = dropDups(this);
        if (!d.kept) return { data: this.sel ? [] : null, error: null, status: 200, local: true, duplicate: true, skipped: d.skipped };
      }
      const op = this.serial();
      const out = applyLocal(this);
      await qAdd(op);
      return { data: this.sel ? out : null, error: null, status: 201, local: true };
    }
  }

  /* ---------- المزامنة ---------- */
  async function hasRealSession() {
    try { const { data } = await realAuth.getSession(); return !!(data && data.session); } catch (e) { return false; }
  }
  async function ensureAuth() {
    if (await hasRealSession()) return true;
    if (memCreds) {
      try {
        const { error } = await realAuth.signInWithPassword(memCreds);
        if (!error) { memCreds = null; return true; }
      } catch (e) { /* لسه */ }
    }
    return false;
  }

  let flushing = null;
  function flush(opts) {
    opts = opts || {};
    if (flushing) return flushing;
    flushing = (async () => {
      await ready;
      let synced = 0;
      if (!real || !navigator.onLine || qlen === 0) return 0;
      syncing = true; badge();
      if (!(await ensureAuth())) return 0;
      const ops = await qAll();
      for (let op of ops) {
        if (op.op === 'insert' && DEDUPE[op.t]) {
          const pre = await serverDupFilter(op);
          if (pre === 'net') break;
          if (pre.skipAll) { await qDel(op.seq); synced++; continue; }   // موجود بالفعل على السيرفر: ما نكررهوش
          op = pre.op;
        }
        let r;
        try { r = await buildReal(op); } catch (e) { r = { error: e, status: 0 }; }
        if (r.error && (isNetErr(r.error) || r.status === 0)) break;                  // النت وقع تاني: نكمل بعدين
        if (r.error && isAuthErr(r)) {
          if (!(await hasRealSession())) break;                                        // مفيش جلسة: ننتظر تسجيل الدخول
          await failedAdd(op, r.error); await qDel(op.seq); continue;                  // جلسة سليمة والسيرفر رافض: صلاحيات
        }
        if (r.error) {
          if (r.error.code === '23505' && op.op === 'insert') { await qDel(op.seq); synced++; continue; } // اتسجلت قبل كده
          await failedAdd(op, r.error); await qDel(op.seq); continue;
        }
        await markSynced(op); synced++;       // السيرفر قبلها: نحتفظ بسجل التحقق لحد ما تثبت في أول تحميل بيانات
      }
      if (synced && !opts.silent) {
        try { window.dispatchEvent(new CustomEvent('offline-synced', { detail: { n: synced } })); } catch (e) { /* */ }
      }
      return synced;
    })().catch(() => 0).finally(() => { flushing = null; syncing = false; badge(); });
    return flushing;
  }

  /* ---------- الدخول أوفلاين ---------- */
  async function hashPw(pw, salt) {
    const enc = new TextEncoder();
    const k = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
    const b = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: enc.encode(salt), iterations: 100000, hash: 'SHA-256' }, k, 256);
    return Array.from(new Uint8Array(b)).map(x => x.toString(16).padStart(2, '0')).join('');
  }
  function credStore() { try { return JSON.parse(localStorage.getItem(CRED_KEY) || '{}'); } catch (e) { return {}; } }
  async function saveCred(email, pw) {
    try {
      const s = credStore(); const salt = Math.random().toString(36).slice(2) + Date.now();
      s[String(email).toLowerCase()] = { salt, hash: await hashPw(pw, salt) };
      localStorage.setItem(CRED_KEY, JSON.stringify(s));
    } catch (e) { /* */ }
  }
  async function checkCred(email, pw) {
    try {
      const c = credStore()[String(email).toLowerCase()];
      return !!c && (await hashPw(pw, c.salt)) === c.hash;
    } catch (e) { return false; }
  }

  async function signIn(args) {
    const email = args && args.email, password = args && args.password;
    let res;
    if (navigator.onLine) {
      try { res = await realAuth.signInWithPassword(args); } catch (e) { res = { data: null, error: e }; }
    } else res = { data: null, error: { message: 'Failed to fetch' } };

    if (!res.error) {
      await saveCred(email, password);
      sessionStorage.setItem(FLAG, '1'); memCreds = null;
      setTimeout(() => flush(), 300);
      return res;
    }
    if (isNetErr(res.error)) {
      if (await checkCred(email, password)) {
        memCreds = { email, password };
        sessionStorage.setItem(FLAG, '1');
        return { data: { user: { email }, session: { offline: true } }, error: null };
      }
      return { data: null, error: { message: 'مفيش نت. الدخول أوفلاين متاح بس لو سجلت دخول بالنت على الجهاز ده قبل كده وبنفس البيانات.' } };
    }
    return res;
  }
  async function getSession() {
    let r;
    try { r = await realAuth.getSession(); } catch (e) { r = { data: { session: null }, error: e }; }
    if (r && r.data && r.data.session) { sessionStorage.setItem(FLAG, '1'); return r; }
    if (sessionStorage.getItem(FLAG) === '1' && (!navigator.onLine || (r && r.error && isNetErr(r.error)))) {
      return { data: { session: { offline: true } }, error: null };
    }
    return r;
  }
  async function signOut() {
    sessionStorage.removeItem(FLAG); memCreds = null;
    try { return await realAuth.signOut(); } catch (e) { return { error: null }; }
  }

  /* ---------- مؤشر الحالة ---------- */
  function badge() {
    if (typeof document === 'undefined' || !document.body) return;
    let b = document.getElementById('ofl-badge');
    if (!b) {
      b = document.createElement('div'); b.id = 'ofl-badge';
      b.style.cssText = 'position:fixed;bottom:12px;left:12px;z-index:99999;padding:6px 12px;border-radius:20px;font:700 12px Cairo,system-ui,sans-serif;color:#fff;box-shadow:0 4px 12px rgba(0,0,0,.25);cursor:pointer;direction:rtl;opacity:.92';
      b.onclick = () => api.sync(true);
      document.body.appendChild(b);
    }
    let t, c;
    if (syncing) { t = '🔄 جاري المزامنة...'; c = '#0284c7'; }
    else if (!navigator.onLine) { t = '🔴 أوفلاين' + (qlen ? ' • ' + qlen + ' معلقة' : ''); c = '#dc2626'; }
    else if (qlen) { t = '⏳ ' + qlen + ' عملية معلقة'; c = '#d97706'; }
    else { t = '🟢 متصل'; c = '#059669'; }
    if (failedCount) t += ' • ⚠️ ' + failedCount + ' فشلت';
    b.textContent = t; b.style.background = c;
  }

  /* ---------- fetch بمهلة عشان النت الضعيف ما يعلّقش ---------- */
  function tfetch(u, o) {
    o = o || {};
    if (!navigator.onLine) return Promise.reject(new TypeError('Failed to fetch'));
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 15000);
    if (o.signal) { if (o.signal.aborted) c.abort(); else o.signal.addEventListener('abort', () => c.abort()); }
    return fetch(u, Object.assign({}, o, { signal: c.signal })).finally(() => clearTimeout(t));
  }

  /* ---------- الواجهة العامة ---------- */
  const api = {
    ready,
    fetch: tfetch,
    isNetErr,
    pending: () => qlen,
    flush,
    version: 2,
    memberKey, phoneKey, normName,
    requestPersist,
    async status() {
      let persisted = persistState;
      try { if (navigator.storage && navigator.storage.persisted) persisted = await navigator.storage.persisted(); } catch (e) { /* */ }
      return { pending: qlen, failed: failedCount, persisted: !!persisted, ios: isIOS(), standalone: isStandalone(), online: navigator.onLine };
    },
    saveCache(table, rows) { mem[table] = rows; persist(table); verifyTable(table, rows).catch(() => {}); },
    readCache(table) { return mem[table] || null; },
    async sync(manual) {
      if (!navigator.onLine) { if (manual && window.toast) window.toast('مفيش نت حالياً — العمليات محفوظة على الجهاز وهتتبعت أول ما النت يرجع'); return; }
      if (!qlen) { if (manual && window.toast) window.toast('كل حاجة متزامنة ✅'); return; }
      const n = await flush();
      if (manual && window.toast) window.toast(qlen ? 'لسه ' + qlen + ' معلقة (سجل دخول بالنت لو لزم)' : 'تمت مزامنة ' + n + ' عملية ✅');
    },
    wrap(client) {
      real = client; realAuth = client.auth;
      const authP = new Proxy(realAuth, {
        get(t, p) {
          if (p === 'signInWithPassword') return signIn;
          if (p === 'getSession') return getSession;
          if (p === 'signOut') return signOut;
          const v = Reflect.get(t, p, t);
          return typeof v === 'function' ? v.bind(t) : v;
        }
      });
      return new Proxy(client, {
        get(t, p) {
          if (p === 'from') return tb => new Q(tb);
          if (p === 'auth') return authP;
          const v = Reflect.get(t, p, t);
          return typeof v === 'function' ? v.bind(t) : v;
        }
      });
    }
  };
  if (typeof window !== 'undefined') window.OfflineSync = api;
  if (typeof module !== 'undefined') module.exports = api;

  /* ---------- أحداث ---------- */
  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => { badge(); setTimeout(() => flush(), 800); });
    window.addEventListener('offline', badge);
    document.addEventListener('visibilitychange', () => { if (!document.hidden && qlen && navigator.onLine) flush(); });
    setInterval(() => { if (qlen && navigator.onLine) flush(); }, 15000);
    document.addEventListener('DOMContentLoaded', badge);
    // طلب التخزين الدائم: مرة وقت التحميل، ومرة عند أول لمسة (بعض المتصفحات بتشترط تفاعل المستخدم)
    ready.then(() => requestPersist()).then(() => {
      setTimeout(() => {
        try {
          if (persistState !== true && isIOS() && !isStandalone() && !localStorage.getItem('ofl_ios_hint') && window.toast) {
            localStorage.setItem('ofl_ios_hint', '1');
            window.toast('📱 على الآيفون: من سفاري اضغط مشاركة ← «إضافة إلى الشاشة الرئيسية» وافتح التطبيق منها، عشان البيانات الأوفلاين تفضل محفوظة ومتتمسحش.', 12000);
          }
        } catch (e) { /* */ }
      }, 4000);
    });
    const firstTouch = () => { requestPersist(); ['click', 'touchstart'].forEach(ev => document.removeEventListener(ev, firstTouch, true)); };
    ['click', 'touchstart'].forEach(ev => document.addEventListener(ev, firstTouch, true));
    window.addEventListener('offline-synced', e => {
      if (window.toast) window.toast('تمت مزامنة ' + e.detail.n + ' عملية مع السيرفر ✅');
      try { if (typeof window.loadData === 'function') window.loadData(); } catch (x) { /* */ }
    });
    /* تسجيل الـ Service Worker عشان الصفحة تفتح من غير نت */
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
      window.addEventListener('load', () => { navigator.serviceWorker.register('./sw.js').catch(() => {}); });
    }
  }
})();
