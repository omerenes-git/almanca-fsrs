'use strict';

// Almanca FSRS — Çift Modlu PWA (IndexedDB) + Özel GitHub Repo CRDT Senkronu
// DİKKAT: api.github.com CORS whitelist'inde Cache-Control yoktur — asla Cache-Control başlığı gönderme.
(() => {
  const UYGULAMA = 'almanca-fsrs';
  const IDB_ADI = 'almanca-fsrs-idb';
  const IDB_DEPO = 'kv';
  const ONEK = 'almanca';
  const VARSAYILAN_REPO = 'omerenes-git/almanca-data';
  const AYAR_ANAHTAR = ONEK + '-gh-sync';
  const AYAR_TS_ANAHTAR = ONEK + '-ayar-ts';
  const YEREL_CACHE_ANAHTAR = 'yerel-remote-cache';
  const PWA_DURUM_ANAHTAR = 'pwa-durum';

  const SKALER_ALANLAR = [
    'yeniLimit', 'hedef', 'sesOto', 'yeniSira', 'dikte', 'onceGoster',
    'kuralTur', 'yukKoruma', 'ilerlemeHedefi', 'tahminYeniGunluk', 'calismaGunleri',
  ];

  const VARSAYILAN_AYAR = {
    yeniLimit: 20, hedef: 0.9, sesOto: false, yeniSira: 'kural-once',
    pasif: [], ekYeni: {}, dikte: true, onceGoster: true, kuralTur: true, yukKoruma: true,
  };

  let mod = 'yerel'; // 'yerel' | 'pwa'
  let yerelPc = '';
  let pwaDurum = null;
  let idbSoz = null;
  let aktifAyar = { ...VARSAYILAN_AYAR };
  let aktifAyarTs = {};
  let yerelKirli = false;
  let esitlemeSuruyor = false;
  let tekrarEsitle = false;
  let zamanlayici = null;
  let yenidenYukleCb = null;
  let sonDurum = { durum: 'yapilandirilmadi', bekleyen: 0, zaman: '', hata: '' };

  const cihazTemizle = s => String(s || '').trim().replace(/[^A-Za-z0-9_-]/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'tablet';
  const kisaId = () => (globalThis.crypto?.randomUUID ? crypto.randomUUID().replace(/-/g, '').slice(0, 6) : Math.random().toString(36).slice(2, 8));
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function toBase64Utf8(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }

  function fromBase64Utf8(b64) {
    const bin = atob(String(b64 || '').replace(/\s+/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  function idbAc() {
    if (idbSoz) return idbSoz;
    idbSoz = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB kullanılamıyor'));
        return;
      }
      const req = indexedDB.open(IDB_ADI, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_DEPO)) db.createObjectStore(IDB_DEPO);
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onclose = () => { idbSoz = null; };
        resolve(db);
      };
      req.onerror = () => {
        idbSoz = null;
        reject(req.error || new Error('IndexedDB açılamadı'));
      };
    });
    return idbSoz;
  }

  async function idbOku(anahtar) {
    if (typeof indexedDB === 'undefined' && globalThis.__SENKRON_MEM_IDB__) {
      return globalThis.__SENKRON_MEM_IDB__.get(anahtar);
    }
    const db = await idbAc();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_DEPO, 'readonly');
      const req = tx.objectStore(IDB_DEPO).get(anahtar);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbYaz(anahtar, deger) {
    if (typeof indexedDB === 'undefined' && globalThis.__SENKRON_MEM_IDB__) {
      globalThis.__SENKRON_MEM_IDB__.set(anahtar, deger);
      return;
    }
    const db = await idbAc();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_DEPO, 'readwrite');
      tx.objectStore(IDB_DEPO).put(deger, anahtar);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  function bosPwaDurum() {
    return { ownEntries: [], ownRetracted: [], ownAppeals: [], ownSettings: {}, remoteFiles: {}, lastSyncAt: '', dirty: false };
  }

  function ayarOku() {
    try {
      const raw = globalThis.localStorage?.getItem(AYAR_ANAHTAR);
      if (raw) {
        const p = JSON.parse(raw);
        const cfg = {
          repo: String(p.repo || VARSAYILAN_REPO).trim(),
          token: String(p.token || '').trim(),
          deviceId: cihazTemizle(p.deviceId || yerelPc || `tablet-${kisaId()}`),
        };
        if (!p.deviceId && globalThis.localStorage) globalThis.localStorage.setItem(AYAR_ANAHTAR, JSON.stringify(cfg));
        return cfg;
      }
    } catch {}
    const yeni = { repo: VARSAYILAN_REPO, token: '', deviceId: cihazTemizle(yerelPc || `tablet-${kisaId()}`) };
    try { globalThis.localStorage?.setItem(AYAR_ANAHTAR, JSON.stringify(yeni)); } catch {}
    return yeni;
  }

  function ayarKaydet(cfg) {
    const temiz = {
      repo: String(cfg.repo || VARSAYILAN_REPO).trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/^\/+|\/+$/g, ''),
      token: String(cfg.token || '').trim(),
      deviceId: cihazTemizle(cfg.deviceId || yerelPc || 'tablet'),
    };
    try { globalThis.localStorage?.setItem(AYAR_ANAHTAR, JSON.stringify(temiz)); } catch {}
    return temiz;
  }

  function kayitAnahtari(k) {
    if (k && typeof k.id === 'string' && k.id) return 'id:' + k.id;
    if (k && 'c' in k && 't' in k && 'r' in k) return JSON.stringify([k.t, k.c, k.i, k.r, k.ok, k.ms]);
    return JSON.stringify(k);
  }

  function jsonlOku(metin) {
    const liste = [];
    for (const satir of String(metin || '').split(/\r?\n/)) {
      const s = satir.trim();
      if (!s) continue;
      try { liste.push(JSON.parse(s)); } catch {}
    }
    return liste;
  }

  function satirlariBirlestir(aMetin, bMetin) {
    const map = new Map();
    for (const metin of [aMetin, bMetin]) {
      for (const obj of jsonlOku(metin)) {
        const k = kayitAnahtari(obj);
        if (!map.has(k)) map.set(k, JSON.stringify(obj));
      }
    }
    return map.size ? [...map.values()].join('\n') + '\n' : '';
  }

  function iptalleriOku(metin) {
    const idler = new Set();
    for (const obj of jsonlOku(metin)) {
      for (const id of obj?.idler || obj?.ids || []) {
        if (typeof id === 'string' && id.trim()) idler.add(id.trim());
      }
    }
    return [...idler];
  }

  function geriAlmalariBirlestir(aMetin, bMetin) {
    const kume = new Set([...iptalleriOku(aMetin), ...iptalleriOku(bMetin)]);
    return kume.size ? JSON.stringify({ idler: [...kume].sort() }) + '\n' : '';
  }

  function tekrarOnar(kayit) {
    if (!kayit || typeof kayit !== 'object') return kayit;
    const k = { ...kayit };
    if (typeof k.ms === 'number') {
      if (!Number.isFinite(k.ms)) delete k.ms;
      else k.ms = Math.trunc(Math.min(Math.max(0, k.ms), 1e8));
    }
    if (typeof k.g === 'string') {
      let temiz = '';
      for (const ch of k.g) {
        const cp = ch.codePointAt(0);
        if (cp >= 0xD800 && cp <= 0xDFFF) continue;
        if ([...temiz].length >= 200) break;
        temiz += ch;
      }
      if (temiz.trim()) k.g = temiz;
      else delete k.g;
    }
    return k;
  }

  function ayarFarkiDamgala(onceki, sonraki, oncekiTs = {}, simdi = Date.now()) {
    const ts = { ...oncekiTs };
    const p = onceki || {};
    const n = sonraki || {};
    for (const k of SKALER_ALANLAR) {
      if (JSON.stringify(p[k]) !== JSON.stringify(n[k])) ts[k] = simdi;
    }
    if (JSON.stringify(p.pasif || []) !== JSON.stringify(n.pasif || [])) ts.pasif = simdi;
    return ts;
  }

  function damgaliAyarSec(ayar, ts) {
    const out = { _ts: ts };
    for (const k of SKALER_ALANLAR) {
      if ((ts[k] || 0) > 0 && ayar[k] !== undefined) out[k] = ayar[k];
    }
    if ((ts.pasif || 0) > 0 && Array.isArray(ayar.pasif)) out.pasif = [...ayar.pasif];
    if (ayar.ekYeni && Object.keys(ayar.ekYeni).length) out.ekYeni = { ...ayar.ekYeni };
    return out;
  }

  function ayarlariBirlestirVeTs(docs) {
    const out = { ...VARSAYILAN_AYAR, ekYeni: {} };
    const ts = {};
    for (const k of SKALER_ALANLAR) {
      let bestTs = -1;
      let bestVal;
      for (const doc of docs) {
        if (!doc || !(k in doc) || doc[k] === undefined) continue;
        const t = doc._ts?.[k] ?? doc._updatedAt ?? 0;
        if (t >= bestTs) { bestTs = t; bestVal = doc[k]; }
      }
      if (bestVal !== undefined) {
        out[k] = bestVal;
        if (bestTs > 0) ts[k] = bestTs;
      }
    }
    {
      let bestTs = -1;
      let bestPasif;
      for (const doc of docs) {
        if (!doc || !Array.isArray(doc.pasif)) continue;
        const t = doc._ts?.pasif ?? doc._updatedAt ?? 0;
        if (t >= bestTs) { bestTs = t; bestPasif = [...doc.pasif]; }
      }
      if (bestPasif !== undefined) {
        out.pasif = bestPasif;
        if (bestTs > 0) ts.pasif = bestTs;
      }
    }
    const ek = {};
    for (const doc of docs) {
      if (!doc?.ekYeni || typeof doc.ekYeni !== 'object') continue;
      for (const [gun, adet] of Object.entries(doc.ekYeni)) {
        if (Number.isInteger(adet) && adet >= 0) {
          ek[gun] = Math.max(ek[gun] || 0, adet);
        }
      }
    }
    out.ekYeni = ek;
    return { ayarlar: out, ts };
  }

  function ayarJsonBirlestir(uzakMetin, yerelMetin) {
    let u = null, y = null;
    try { if (uzakMetin?.trim()) u = JSON.parse(uzakMetin); } catch {}
    try { if (yerelMetin?.trim()) y = JSON.parse(yerelMetin); } catch {}
    if (!y) return uzakMetin || '';
    if (!u) return JSON.stringify(y, null, 1);
    const { ayarlar, ts } = ayarlariBirlestirVeTs([u, y]);
    const birlesik = { ...damgaliAyarSec(ayarlar, ts), ...(Object.keys(ayarlar.ekYeni || {}).length ? { ekYeni: ayarlar.ekYeni } : {}) };
    const uNorm = ayarlariBirlestirVeTs([u]);
    const uDok = { ...damgaliAyarSec(uNorm.ayarlar, uNorm.ts), ...(Object.keys(uNorm.ayarlar.ekYeni || {}).length ? { ekYeni: uNorm.ayarlar.ekYeni } : {}) };
    if (JSON.stringify(uDok) === JSON.stringify(birlesik)) return uzakMetin;
    return JSON.stringify(birlesik, null, 1);
  }

  function senkronDosyasiMi(yol) {
    return /^(tekrarlar|geri-almalar|itirazlar)-[^/]+\.jsonl$/.test(yol) || /^ayarlar(-[^/]+)?\.json$/.test(yol);
  }

  function pwaVeriTopla() {
    const ps = pwaDurum || bosPwaDurum();
    const files = ps.remoteFiles || {};
    const iptaller = new Set(ps.ownRetracted || []);
    for (const [p, f] of Object.entries(files)) {
      if (p.startsWith('geri-almalar-') && p.endsWith('.jsonl')) {
        for (const id of iptalleriOku(f.text)) iptaller.add(id);
      }
    }
    const tekrarMap = new Map();
    const ekle = k => {
      if (!k || !k.c || !k.t || (k.id && iptaller.has(k.id))) return;
      const key = kayitAnahtari(k);
      if (!tekrarMap.has(key)) tekrarMap.set(key, k);
    };
    for (const [p, f] of Object.entries(files)) {
      if (p.startsWith('tekrarlar-') && p.endsWith('.jsonl')) {
        for (const k of jsonlOku(f.text)) ekle(k);
      }
    }
    for (const k of ps.ownEntries || []) ekle(k);

    const ayarDocs = [];
    for (const [p, f] of Object.entries(files)) {
      if (/^ayarlar(-[^/]+)?\.json$/.test(p)) {
        try { const o = JSON.parse(f.text); if (o && typeof o === 'object') ayarDocs.push(o); } catch {}
      }
    }
    if (ps.ownSettings && Object.keys(ps.ownSettings).length) ayarDocs.push(ps.ownSettings);
    const { ayarlar, ts } = ayarlariBirlestirVeTs(ayarDocs);
    aktifAyar = ayarlar;
    aktifAyarTs = { ...ts, ...(ps.ownSettings?._ts || {}) };
    return { tekrarlar: [...tekrarMap.values()], ayarlar, ts: aktifAyarTs };
  }

  function ghBasliklar(token, govdeli = false) {
    const h = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' };
    if (govdeli) h['Content-Type'] = 'application/json';
    return h;
  }

  function ghHata(kod, yedek) {
    if (kod === 401) return new Error('GitHub token geçersiz veya süresi dolmuş (401).');
    if (kod === 403) return new Error('GitHub erişim reddedildi veya hız sınırı aşıldı (403).');
    if (kod === 404) return new Error('Repo bulunamadı — token yetkisini kontrol et (404).');
    return new Error(yedek);
  }

  async function dosyaGonderRetry(repo, token, dosya, ilkSha, ilkUzakMetin, fetchFn) {
    let sha = ilkSha;
    let birlesik = dosya.birlestir(ilkUzakMetin, dosya.icerik);
    if (birlesik === ilkUzakMetin) return { sha: sha || '', text: ilkUzakMetin };

    const url = `https://api.github.com/repos/${repo}/contents/${dosya.yol.split('/').map(encodeURIComponent).join('/')}`;
    for (let deneme = 0; deneme < 2; deneme++) {
      const res = await fetchFn(url, {
        method: 'PUT',
        headers: ghBasliklar(token, true),
        body: JSON.stringify({ message: `sync: ${dosya.yol}`, content: toBase64Utf8(birlesik), ...(sha ? { sha } : {}) }),
      });
      if (res.ok) {
        const j = await res.json();
        return { sha: j.content?.sha || '', text: birlesik };
      }
      if ((res.status === 409 || res.status === 422) && deneme === 0) {
        const cur = await fetchFn(`${url}?_t=${Date.now()}`, { headers: ghBasliklar(token) });
        if (cur.ok) {
          const cj = await cur.json();
          const tazeUzak = cj.content ? fromBase64Utf8(cj.content) : '';
          sha = cj.sha;
          birlesik = dosya.birlestir(tazeUzak, dosya.icerik);
          if (birlesik === tazeUzak) return { sha: sha || '', text: tazeUzak };
          continue;
        }
      }
      const errTxt = await res.text().catch(() => '');
      throw ghHata(res.status, `GitHub kayıt hatası (${res.status}): ${errTxt.slice(0, 120)}`);
    }
    throw new Error(`Çakışma çözülemedi: ${dosya.yol}`);
  }

  async function githubEsitleCekirdek(cfg, onbellek, yerelDosyalar, fetchFn = fetch) {
    const repo = cfg.repo.trim();
    const token = cfg.token.trim();
    if (!repo || !repo.includes('/')) throw new Error('Geçerli repo gir (ör. kullanici/almanca-data).');
    if (!token) throw new Error('GitHub token eksik.');

    const yeniUzak = { ...onbellek };
    let cekilen = 0, gonderilen = 0;
    const treeRes = await fetchFn(`https://api.github.com/repos/${repo}/git/trees/main?_t=${Date.now()}`, { headers: ghBasliklar(token) });
    let ogeler = [];
    if (treeRes.ok) {
      const td = await treeRes.json();
      ogeler = (td.tree || []).filter(it => it.type === 'blob' && senkronDosyasiMi(it.path));
    } else if (treeRes.status === 404 || treeRes.status === 409) {
      const rr = await fetchFn(`https://api.github.com/repos/${repo}?_t=${Date.now()}`, { headers: ghBasliklar(token) });
      if (!rr.ok) throw ghHata(rr.status, `Repo okunamadı (${rr.status})`);
    } else {
      throw ghHata(treeRes.status, `Ağaç okunamadı (${treeRes.status})`);
    }

    const uzakAdlar = new Set(ogeler.map(it => it.path));
    for (const k of Object.keys(yeniUzak)) if (!uzakAdlar.has(k)) delete yeniUzak[k];

    for (const oge of ogeler) {
      if (yeniUzak[oge.path]?.sha === oge.sha) continue;
      const br = await fetchFn(`https://api.github.com/repos/${repo}/git/blobs/${oge.sha}`, { headers: ghBasliklar(token) });
      if (!br.ok) throw ghHata(br.status, `Dosya indirilemedi (${oge.path}: ${br.status})`);
      const bj = await br.json();
      yeniUzak[oge.path] = { sha: oge.sha, text: bj.content ? fromBase64Utf8(bj.content) : '' };
      cekilen++;
    }

    for (const yd of yerelDosyalar) {
      const varOlan = yeniUzak[yd.yol];
      const uzakMetin = varOlan?.text || '';
      const birlesik = yd.birlestir(uzakMetin, yd.icerik);
      if (!birlesik && !varOlan) continue;
      if (birlesik === uzakMetin) continue;
      const sonuc = await dosyaGonderRetry(repo, token, yd, varOlan?.sha, uzakMetin, fetchFn);
      if (sonuc.text !== uzakMetin || sonuc.sha !== varOlan?.sha) {
        yeniUzak[yd.yol] = sonuc;
        gonderilen++;
      }
    }
    return { cekilen, gonderilen, zaman: new Date().toISOString(), uzakDosyalar: yeniUzak };
  }

  function bekleyenSayisi() {
    if (mod === 'yerel') return yerelKirli ? 1 : 0;
    const ps = pwaDurum || bosPwaDurum();
    if (!ps.dirty) return 0;
    const uzakIdler = new Set();
    for (const [p, f] of Object.entries(ps.remoteFiles || {})) {
      if (p.startsWith('tekrarlar-')) for (const k of jsonlOku(f.text)) if (k.id) uzakIdler.add(k.id);
    }
    const gonderilmemis = (ps.ownEntries || []).filter(k => !k.id || !uzakIdler.has(k.id)).length;
    return Math.max(1, gonderilmemis);
  }

  function rozetGuncelle() {
    const rozet = globalThis.document?.getElementById?.('kayit-rozet');
    const durumEl = globalThis.document?.getElementById?.('gh-sync-durum');
    const cfg = ayarOku();
    if (durumEl) durumEl.textContent = durumAciklamasi();
    if (mod !== 'pwa' || !rozet) return;

    const bek = bekleyenSayisi();
    let kisa = 'Çevrimdışı', uyari = false, bekliyor = false, ok = false;
    if (sonDurum.durum === 'esitleniyor') { kisa = 'Eşitleniyor…'; bekliyor = true; }
    else if (sonDurum.durum === 'hata') { kisa = 'Senkron hatası'; uyari = true; }
    else if (bek > 0 && !globalThis.navigator?.onLine) { kisa = `Çevrimdışı (${bek})`; bekliyor = true; }
    else if (bek > 0 && !cfg.token) { kisa = `${bek} yerel kayıt`; ok = true; }
    else if (bek > 0) { kisa = `${bek} bekliyor`; bekliyor = true; }
    else if (!cfg.token) { kisa = 'Cihazda kayıtlı'; ok = true; }
    else if (!globalThis.navigator?.onLine) { kisa = 'Çevrimdışı'; ok = true; }
    else { kisa = 'Eşitlendi'; ok = true; }

    const yazi = rozet.querySelector?.('.rozet-yazi');
    if (yazi) { if (yazi.textContent !== kisa) yazi.textContent = kisa; }
    else if (rozet.textContent !== kisa) rozet.textContent = kisa;
    rozet.classList?.toggle('durum-uyari', uyari);
    rozet.classList?.toggle('durum-bekliyor', bekliyor);
    rozet.classList?.toggle('durum-ok', ok);
    const tam = durumAciklamasi();
    rozet.title = tam;
    rozet.setAttribute?.('aria-label', tam);
  }

  function durumAciklamasi() {
    const cfg = ayarOku();
    const zaman = sonDurum.zaman ? ` · Son: ${sonDurum.zaman.slice(0, 16).replace('T', ' ')}` : '';
    if (sonDurum.durum === 'esitleniyor') return 'GitHub ile eşitleniyor…';
    if (!cfg.token) return `GitHub senkronu bağlı değil (veriler ${mod === 'pwa' ? 'IndexedDB' : 'yerel klasörde'} güvende).`;
    if (sonDurum.durum === 'hata') return `Senkron hatası: ${sonDurum.hata}`;
    if (!globalThis.navigator?.onLine) return `Çevrimdışı (${bekleyenSayisi()} kayıt bağlantı gelince gönderilecek).`;
    if (sonDurum.bekleyen > 0) return `${sonDurum.bekleyen} değişiklik gönderilmeyi bekliyor.${zaman}`;
    return `Eşitlendi${zaman}`;
  }

  async function esitle(manuel = false, cfgOverride) {
    const cfg = cfgOverride || ayarOku();
    if (!cfg.token) {
      sonDurum = { durum: 'yapilandirilmadi', bekleyen: bekleyenSayisi(), zaman: sonDurum.zaman, hata: '' };
      rozetGuncelle();
      return;
    }
    if (globalThis.navigator && !globalThis.navigator.onLine) {
      sonDurum = { durum: 'cevrimdisi', bekleyen: bekleyenSayisi(), zaman: sonDurum.zaman, hata: '' };
      rozetGuncelle();
      return;
    }
    if (esitlemeSuruyor) { tekrarEsitle = true; return; }
    esitlemeSuruyor = true;
    sonDurum = { ...sonDurum, durum: 'esitleniyor', hata: '' };
    rozetGuncelle();

    try {
      if (mod === 'yerel') {
        const res = await fetch('./api/sync-dosyalar', { cache: 'no-store' });
        if (!res.ok) throw new Error('Yerel sync dosyaları okunamadı');
        const { pc, files: disk } = await res.json();
        yerelPc = pc || yerelPc;
        const dev = yerelPc || cfg.deviceId;
        const onbellek = (await idbOku(YEREL_CACHE_ANAHTAR).catch(() => null)) || {};
        const yerelDosyalar = [];
        for (const [ad, icerik] of Object.entries(disk || {})) {
          if ((ad === `tekrarlar-${dev}.jsonl` || ad.startsWith(`tekrarlar-${dev}-`)) && ad.endsWith('.jsonl')) {
            yerelDosyalar.push({ yol: ad, icerik, birlestir: satirlariBirlestir });
          } else if (ad === `geri-almalar-${dev}.jsonl`) {
            yerelDosyalar.push({ yol: ad, icerik, birlestir: geriAlmalariBirlestir });
          }
        }
        let tsMap = {};
        try { tsMap = JSON.parse(globalThis.localStorage?.getItem(AYAR_TS_ANAHTAR) || '{}') || {}; } catch {}
        let diskAyar = null;
        try { if (disk['ayarlar.json']) diskAyar = JSON.parse(disk['ayarlar.json']); } catch {}
        if (diskAyar && !disk[`ayarlar-${dev}.json`] && Object.keys(tsMap).length === 0) {
          for (const k of SKALER_ALANLAR) if (diskAyar[k] !== undefined) tsMap[k] = 1;
          if (Array.isArray(diskAyar.pasif)) tsMap.pasif = 1;
          try { globalThis.localStorage?.setItem(AYAR_TS_ANAHTAR, JSON.stringify(tsMap)); } catch {}
        }
        const yerelAyarDok = diskAyar && (Object.keys(tsMap).length > 0 || Object.keys(diskAyar.ekYeni || {}).length > 0)
          ? damgaliAyarSec(diskAyar, tsMap) : null;
        if (yerelAyarDok) {
          yerelDosyalar.push({ yol: `ayarlar-${dev}.json`, icerik: JSON.stringify(yerelAyarDok, null, 1), birlestir: ayarJsonBirlestir });
        }

        const out = await githubEsitleCekirdek(cfg, onbellek, yerelDosyalar);
        await idbYaz(YEREL_CACHE_ANAHTAR, out.uzakDosyalar).catch(() => {});

        const ayarDocs = [];
        for (const [p, f] of Object.entries(out.uzakDosyalar)) {
          if (/^ayarlar(-[^/]+)?\.json$/.test(p)) {
            try { const o = JSON.parse(f.text); if (o && typeof o === 'object') ayarDocs.push(o); } catch {}
          }
        }
        if (yerelAyarDok) ayarDocs.push(yerelAyarDok);
        const { ayarlar: birlesikAyar, ts: yeniTs } = ayarlariBirlestirVeTs(ayarDocs);
        try { globalThis.localStorage?.setItem(AYAR_TS_ANAHTAR, JSON.stringify(yeniTs)); } catch {}

        const yazilacak = {};
        for (const [p, f] of Object.entries(out.uzakDosyalar)) {
          if (p !== 'ayarlar.json' && f.text && disk[p] !== f.text) yazilacak[p] = f.text;
        }
        const imp = await fetch('./api/sync-al', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ files: yazilacak, mergedSettings: birlesikAyar }),
        });
        const impJson = imp.ok ? await imp.json() : { updated: 0 };
        yerelKirli = false;
        sonDurum = { durum: 'hazir', bekleyen: 0, zaman: out.zaman, hata: '' };
        rozetGuncelle();
        if ((out.cekilen > 0 || impJson.updated > 0) && yenidenYukleCb) await yenidenYukleCb(manuel);
      } else {
        const ps = pwaDurum || bosPwaDurum();
        const dev = cfg.deviceId;
        const yillar = new Map();
        for (const k of ps.ownEntries || []) {
          const yil = /^\d{4}/.test(String(k.t || '')) ? k.t.slice(0, 4) : String(new Date().getFullYear());
          if (!yillar.has(yil)) yillar.set(yil, []);
          yillar.get(yil).push(k);
        }
        const yerelDosyalar = [];
        for (const [yil, liste] of yillar) {
          yerelDosyalar.push({
            yol: `tekrarlar-${dev}-${yil}.jsonl`,
            icerik: liste.map(x => JSON.stringify(x)).join('\n') + '\n',
            birlestir: satirlariBirlestir,
          });
        }
        if ((ps.ownRetracted || []).length) {
          yerelDosyalar.push({
            yol: `geri-almalar-${dev}.jsonl`,
            icerik: JSON.stringify({ idler: [...new Set(ps.ownRetracted)].sort() }) + '\n',
            birlestir: geriAlmalariBirlestir,
          });
        }
        if ((ps.ownAppeals || []).length) {
          yerelDosyalar.push({
            yol: `itirazlar-${dev}.jsonl`,
            icerik: ps.ownAppeals.map(x => JSON.stringify(x)).join('\n') + '\n',
            birlestir: satirlariBirlestir,
          });
        }
        if (ps.ownSettings && Object.keys(ps.ownSettings).length) {
          yerelDosyalar.push({
            yol: `ayarlar-${dev}.json`,
            icerik: JSON.stringify(ps.ownSettings, null, 1),
            birlestir: ayarJsonBirlestir,
          });
        }

        const out = await githubEsitleCekirdek(cfg, ps.remoteFiles || {}, yerelDosyalar);
        pwaDurum = { ...ps, remoteFiles: out.uzakDosyalar, lastSyncAt: out.zaman, dirty: false };
        await idbYaz(PWA_DURUM_ANAHTAR, pwaDurum);
        sonDurum = { durum: 'hazir', bekleyen: 0, zaman: out.zaman, hata: '' };
        rozetGuncelle();
        if (out.cekilen > 0 && yenidenYukleCb) await yenidenYukleCb(manuel);
      }
    } catch (e) {
      sonDurum = {
        durum: globalThis.navigator && !globalThis.navigator.onLine ? 'cevrimdisi' : 'hata',
        bekleyen: bekleyenSayisi(),
        zaman: sonDurum.zaman,
        hata: e?.message || String(e),
      };
      rozetGuncelle();
    } finally {
      esitlemeSuruyor = false;
      if (tekrarEsitle) { tekrarEsitle = false; void esitle(false); }
    }
  }

  function esitlePlanla(hemen = false) {
    clearTimeout(zamanlayici);
    const cfg = ayarOku();
    if (!cfg.token) { rozetGuncelle(); return; }
    if (globalThis.navigator && !globalThis.navigator.onLine) {
      sonDurum = { ...sonDurum, durum: 'cevrimdisi', bekleyen: bekleyenSayisi() };
      rozetGuncelle();
      return;
    }
    sonDurum = { ...sonDurum, bekleyen: bekleyenSayisi() };
    rozetGuncelle();
    zamanlayici = setTimeout(() => { void esitle(false); }, hemen ? 50 : 15000);
  }

  async function baslat() {
    try {
      const iptal = new AbortController();
      const t = setTimeout(() => iptal.abort(), 2500);
      const r = await fetch('./api/ayarlar', { cache: 'no-store', signal: iptal.signal });
      clearTimeout(t);
      if (r.ok && (r.headers.get('content-type') || '').includes('json')) {
        mod = 'yerel';
        try {
          const sr = await fetch('./api/sync-dosyalar', { cache: 'no-store' });
          if (sr.ok) yerelPc = (await sr.json()).pc || '';
        } catch {}
        return 'yerel';
      }
    } catch {}

    mod = 'pwa';
    pwaDurum = (await idbOku(PWA_DURUM_ANAHTAR).catch(() => null)) || bosPwaDurum();
    if (!pwaDurum.remoteFiles) pwaDurum.remoteFiles = {};
    if (!pwaDurum.ownEntries) pwaDurum.ownEntries = [];
    if (!pwaDurum.ownRetracted) pwaDurum.ownRetracted = [];
    if (!pwaDurum.ownAppeals) pwaDurum.ownAppeals = [];
    if (!pwaDurum.ownSettings) pwaDurum.ownSettings = {};
    sonDurum.zaman = pwaDurum.lastSyncAt || '';

    try { void globalThis.navigator?.storage?.persist?.(); } catch {}
    if (globalThis.navigator?.serviceWorker && !['localhost', '127.0.0.1'].includes(globalThis.location?.hostname || '')) {
      globalThis.window?.addEventListener?.('load', () => {
        globalThis.navigator.serviceWorker.register('./sw.js').catch(() => {});
      });
      if (globalThis.document?.readyState === 'complete') {
        globalThis.navigator.serviceWorker.register('./sw.js').catch(() => {});
      }
    }
    return 'pwa';
  }

  async function yerelApi(yol, govde) {
    const u = String(yol || '').split('?')[0];
    if (govde === undefined) {
      if (u === '/api/icerik') {
        const r = await fetch('./icerik.json');
        if (!r.ok) throw new Error('İçerik dosyası (icerik.json) okunamadı.');
        return r.json();
      }
      if (u === '/api/tekrarlar') return pwaVeriTopla().tekrarlar;
      if (u === '/api/ayarlar') return pwaVeriTopla().ayarlar;
      if (u === '/api/yazilar') return [];
      if (u === '/api/yedek') {
        const { tekrarlar, ayarlar } = pwaVeriTopla();
        return { surum: 1, uygulama: UYGULAMA, tekrarlar, ayarlar };
      }
      throw new Error('Bilinmeyen adres: ' + u);
    }

    const ps = pwaDurum || bosPwaDurum();
    if (u === '/api/tekrar') {
      const kayit = tekrarOnar(govde);
      if (!kayit || !kayit.c || !kayit.t || !(Number.isInteger(kayit.r) && kayit.r >= 1 && kayit.r <= 4)) {
        const err = new Error('Tekrar kaydı geçersiz.'); err.durum = 400; throw err;
      }
      const key = kayitAnahtari(kayit);
      const varMi = ps.ownEntries.some(x => kayitAnahtari(x) === key);
      if (!varMi) ps.ownEntries = [...ps.ownEntries, kayit];
      ps.dirty = true;
      pwaDurum = ps;
      await idbYaz(PWA_DURUM_ANAHTAR, ps);
      esitlePlanla(false);
      return { ok: true };
    }
    if (u === '/api/geri-al') {
      const idler = Array.isArray(govde?.idler) ? govde.idler.filter(x => typeof x === 'string' && x.trim()) : [];
      if (!idler.length) { const err = new Error('Geri alma geçersiz.'); err.durum = 400; throw err; }
      const silSet = new Set(idler);
      ps.ownEntries = ps.ownEntries.filter(k => !silSet.has(k.id));
      ps.ownRetracted = [...new Set([...ps.ownRetracted, ...idler])];
      ps.dirty = true;
      pwaDurum = ps;
      await idbYaz(PWA_DURUM_ANAHTAR, ps);
      esitlePlanla(false);
      return { ok: true };
    }
    if (u === '/api/ayarlar') {
      const yeniTs = ayarFarkiDamgala(aktifAyar, govde || {}, aktifAyarTs);
      aktifAyar = { ...VARSAYILAN_AYAR, ...(govde || {}) };
      aktifAyarTs = yeniTs;
      ps.ownSettings = damgaliAyarSec(aktifAyar, yeniTs);
      ps.dirty = true;
      pwaDurum = ps;
      await idbYaz(PWA_DURUM_ANAHTAR, ps);
      esitlePlanla(false);
      return { ok: true };
    }
    if (u === '/api/itiraz') {
      ps.ownAppeals = [...ps.ownAppeals, govde];
      ps.dirty = true;
      pwaDurum = ps;
      await idbYaz(PWA_DURUM_ANAHTAR, ps);
      esitlePlanla(false);
      return { ok: true };
    }
    if (u === '/api/yedek') {
      const y = govde?.yedek;
      if (!y || typeof y !== 'object' || y.surum !== 1 || !Array.isArray(y.tekrarlar)) {
        const err = new Error('Yedek dosyası geçersiz.'); err.durum = 400; throw err;
      }
      if ('uygulama' in y && y.uygulama !== UYGULAMA) {
        const err = new Error('Almanca FSRS yedek dosyasını seç.'); err.durum = 400; throw err;
      }
      const { tekrarlar: mevcut, ayarlar: mevcutAyar } = pwaVeriTopla();
      const mevcutAnahtar = new Set(mevcut.map(kayitAnahtari));
      const iptaller = new Set(ps.ownRetracted || []);
      for (const [p, f] of Object.entries(ps.remoteFiles || {})) {
        if (p.startsWith('geri-almalar-')) for (const id of iptalleriOku(f.text)) iptaller.add(id);
      }
      const yeni = [];
      const gorulen = new Set();
      for (const k of y.tekrarlar) {
        const ak = kayitAnahtari(k);
        if (mevcutAnahtar.has(ak) || gorulen.has(ak) || (k.id && iptaller.has(k.id))) continue;
        gorulen.add(ak);
        yeni.push(k);
      }
      if (govde.onizleme) return { ok: true, toplam: y.tekrarlar.length, yeni: yeni.length };
      if (yeni.length) ps.ownEntries = [...ps.ownEntries, ...yeni];
      if (govde.ayarlariAl && y.ayarlar && typeof y.ayarlar === 'object') {
        const birlesik = { ...mevcutAyar, ...y.ayarlar };
        const ts = ayarFarkiDamgala(mevcutAyar, birlesik, aktifAyarTs);
        aktifAyar = birlesik;
        aktifAyarTs = ts;
        ps.ownSettings = damgaliAyarSec(birlesik, ts);
      }
      ps.dirty = ps.dirty || yeni.length > 0 || Boolean(govde.ayarlariAl);
      pwaDurum = ps;
      await idbYaz(PWA_DURUM_ANAHTAR, ps);
      esitlePlanla(false);
      return { ok: true, toplam: y.tekrarlar.length, yeni: yeni.length };
    }
    throw new Error('Bu işlem yalnızca bilgisayarınızdaki yerel uygulamada kullanılabilir.');
  }

  function pcAyarDamgala(yeniAyar) {
    if (mod !== 'yerel') return;
    let oncekiTs = {};
    try { oncekiTs = JSON.parse(globalThis.localStorage?.getItem(AYAR_TS_ANAHTAR) || '{}') || {}; } catch {}
    const yeniTs = ayarFarkiDamgala(aktifAyar, yeniAyar, oncekiTs);
    aktifAyar = { ...VARSAYILAN_AYAR, ...yeniAyar };
    aktifAyarTs = yeniTs;
    yerelKirli = true;
    try { globalThis.localStorage?.setItem(AYAR_TS_ANAHTAR, JSON.stringify(yeniTs)); } catch {}
    esitlePlanla(false);
  }

  function pcKayitBildir() {
    if (mod !== 'yerel') return;
    yerelKirli = true;
    esitlePlanla(false);
  }

  function acilisSonrasi(yenidenYukle, ilkAyar) {
    yenidenYukleCb = yenidenYukle;
    if (ilkAyar) aktifAyar = { ...VARSAYILAN_AYAR, ...ilkAyar };
    rozetGuncelle();
    const rozet = globalThis.document?.getElementById?.('kayit-rozet');
    if (rozet && !rozet._senkronBagli) {
      rozet._senkronBagli = true;
      rozet.style.cursor = 'pointer';
      rozet.addEventListener('click', () => {
        if (!ayarOku().token) globalThis.document?.querySelector?.('#nav button[data-ekran="ayarlar"]')?.click?.();
        else void esitle(true);
      });
    }
    globalThis.window?.addEventListener?.('online', () => { if (ayarOku().token) void esitle(false); });
    globalThis.document?.addEventListener?.('visibilitychange', () => {
      if (!ayarOku().token) return;
      if (globalThis.document.hidden) {
        if (bekleyenSayisi() > 0 && globalThis.navigator?.onLine) void esitle(false);
      } else if (globalThis.navigator?.onLine) {
        void esitle(false);
      }
    });
    globalThis.window?.addEventListener?.('pagehide', () => {
      if (ayarOku().token && bekleyenSayisi() > 0 && globalThis.navigator?.onLine) void esitle(false);
    });
    if (ayarOku().token && (!globalThis.navigator || globalThis.navigator.onLine)) {
      void esitle(false);
    }
  }

  function durumMesaji(bekleyenAdet, iptalAdet, hazir) {
    const toplam = bekleyenAdet + iptalAdet;
    if (toplam > 0) return `${toplam} işlem cihaza yazılıyor…`;
    if (sonDurum.durum === 'esitleniyor') return 'GitHub ile eşitleniyor…';
    if (sonDurum.durum === 'hata') return `Senkron hatası: ${sonDurum.hata} (veriler cihazda güvende)`;
    const cfg = ayarOku();
    if (!cfg.token) return hazir ? 'İlerleme cihazda (IndexedDB) saklanıyor.' : 'Kayıtlar yükleniyor…';
    const bek = bekleyenSayisi();
    if (bek > 0 && !globalThis.navigator?.onLine) return `Çevrimdışı — ${bek} kayıt bağlantı gelince GitHub'a gönderilecek.`;
    if (bek > 0) return `${bek} kayıt GitHub'a gönderilmeyi bekliyor.`;
    return 'İlerleme cihazda ve GitHub ile eşitlendi.';
  }

  function ayarPaneliHtml() {
    const cfg = ayarOku();
    const dev = mod === 'yerel' ? (yerelPc || cfg.deviceId) : cfg.deviceId;
    return `<div class="panel">
      <h2>GitHub Senkronu (Tablet ↔ Bilgisayar)</h2>
      <p class="small muted">Kayıtlar özel (private) GitHub reposunda cihaz adına göre ayrı dosyalarda birleştirilir; iki cihaz aynı anda çevrimdışı çalışsa bile veri kaybolmaz.</p>
      <label class="ayar"><span>Özel veri reposu<br><span class="small muted">kullanıcı/repo</span></span>
        <input type="text" id="gh-repo" value="${esc(cfg.repo)}" style="width:min(240px,52vw);padding:7px 10px;border:1px solid var(--line-strong);border-radius:var(--radius-sm);background:var(--panel-2)"></label>
      <label class="ayar"><span>Cihaz adı${mod === 'yerel' ? '<br><span class="small muted">Bilgisayarda dosya adından alınır</span>' : ''}</span>
        <input type="text" id="gh-cihaz" value="${esc(dev)}" ${mod === 'yerel' ? 'disabled' : ''} style="width:min(240px,52vw);padding:7px 10px;border:1px solid var(--line-strong);border-radius:var(--radius-sm);background:var(--panel-2)"></label>
      <label class="ayar"><span>Fine-grained GitHub Token<br><span class="small muted">Contents: Read and write</span></span>
        <input type="password" id="gh-token" value="${esc(cfg.token)}" placeholder="github_pat_..." autocomplete="off" style="width:min(240px,52vw);padding:7px 10px;border:1px solid var(--line-strong);border-radius:var(--radius-sm);background:var(--panel-2)"></label>
      <div class="row" style="margin-top:10px">
        <button class="btn primary" id="gh-baglan" type="button">Bağlan ve Eşitle</button>
        ${cfg.token ? '<button class="btn" id="gh-simdi" type="button">Şimdi eşitle</button><button class="btn" id="gh-kes" type="button">Bağlantıyı kes</button>' : ''}
      </div>
      <p id="gh-sync-durum" class="small muted" role="status" style="margin-top:8px">${esc(durumAciklamasi())}</p>
    </div>`;
  }

  function ayarPaneliBagla(yenidenCiz) {
    const repoEl = globalThis.document?.getElementById?.('gh-repo');
    const cihazEl = globalThis.document?.getElementById?.('gh-cihaz');
    const tokenEl = globalThis.document?.getElementById?.('gh-token');
    const baglanBtn = globalThis.document?.getElementById?.('gh-baglan');
    const simdiBtn = globalThis.document?.getElementById?.('gh-simdi');
    const kesBtn = globalThis.document?.getElementById?.('gh-kes');
    if (baglanBtn) {
      baglanBtn.onclick = async () => {
        const yeni = ayarKaydet({
          repo: repoEl?.value || VARSAYILAN_REPO,
          deviceId: mod === 'yerel' ? (yerelPc || cihazEl?.value) : cihazEl?.value,
          token: tokenEl?.value || '',
        });
        await esitle(true, yeni);
        yenidenCiz?.();
      };
    }
    if (simdiBtn) simdiBtn.onclick = async () => { await esitle(true); yenidenCiz?.(); };
    if (kesBtn) {
      kesBtn.onclick = () => {
        const cur = ayarOku();
        ayarKaydet({ ...cur, token: '' });
        sonDurum = { durum: 'yapilandirilmadi', bekleyen: bekleyenSayisi(), zaman: sonDurum.zaman, hata: '' };
        rozetGuncelle();
        yenidenCiz?.();
      };
    }
  }

  const senkron = {
    pwaModu: () => mod === 'pwa',
    yerelModu: () => mod === 'yerel',
    baslat,
    yerelApi,
    esitle,
    esitlePlanla,
    acilisSonrasi,
    pcAyarDamgala,
    pcKayitBildir,
    durumMesaji,
    rozetGuncelle,
    ayarPaneliHtml,
    ayarPaneliBagla,
    _ic: {
      toBase64Utf8, fromBase64Utf8, satirlariBirlestir, geriAlmalariBirlestir,
      ayarlariBirlestirVeTs, ayarFarkiDamgala, ayarJsonBirlestir, tekrarOnar,
      githubEsitleCekirdek,
      durumSifirla: (yeniMod = 'pwa') => {
        mod = yeniMod; yerelPc = ''; pwaDurum = bosPwaDurum();
        aktifAyar = { ...VARSAYILAN_AYAR }; aktifAyarTs = {};
        sonDurum = { durum: 'yapilandirilmadi', bekleyen: 0, zaman: '', hata: '' };
      },
    },
  };

  globalThis.senkron = senkron;
  if (typeof module !== 'undefined' && module.exports) module.exports = senkron;
})();
