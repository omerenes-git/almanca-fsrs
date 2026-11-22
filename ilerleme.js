'use strict';

/* İlerleme (İstatistik) ekranı: konu ilerlemesi, günlük aktivite grafikleri,
   kart durumu/türü dağılımı (SVG halka + yatay çubuklar), hata analizi ve tekrar takvimi.
   Ünite durumları:
     Başlanmadı → hiçbir kartı görülmedi
     Devam ediyor → bazı kartları görüldü
     Tamamlandı → bütün kartları en az bir kez görüldü
     Pekişti → bütün kartları görüldü ve en az %80'i olgun (FSRS kararlılığı ≥ 21 gün) */
const ilerlemeEkran = (() => {
  const SEVIYELER = ['A1', 'A2', 'B1', 'B2'];
  const PEKISME_ORANI = 0.8;
  const MIN_GUN = 7, SON_GUN = 14, BAKILAN_GUN = 42;
  const sayi = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 1 });
  const DURUM_AD = { baslanmadi: 'Başlanmadı', devam: 'Devam ediyor', tamam: 'Tamamlandı', pekisti: 'Pekişti' };
  const KART_AD = { yeni: 'Yeni', ogren: 'Öğreniliyor', genc: 'Genç', olgun: 'Olgun' };
  const GUN_KISA = ['Paz', 'Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt'];

  function seviye(no) {
    if (!(no >= 1)) return null;          // kişisel dosyalar (Hatalarım)
    return no <= 12 ? 'A1' : no <= 24 ? 'A2' : no <= 36 ? 'B1' : 'B2';
  }

  function uniteOlc(u) {
    const o = { toplam: u.kartlar.length, goruldu: 0, olgun: 0, durum: 'baslanmadi' };
    for (const k of u.kartlar) {
      const d = kartDurumu(k);
      if (d !== 'yeni') o.goruldu++;
      if (d === 'olgun') o.olgun++;
    }
    if (o.goruldu) o.durum = 'devam';
    if (o.toplam && o.goruldu === o.toplam) o.durum = o.olgun >= PEKISME_ORANI * o.toplam ? 'pekisti' : 'tamam';
    return o;
  }

  function topla(liste) {
    const t = { unite: 0, tamam: 0, pekisti: 0, kart: 0, goruldu: 0, olgun: 0 };
    for (const { o } of liste) {
      if (!o.toplam) continue;
      t.unite++; t.kart += o.toplam; t.goruldu += o.goruldu; t.olgun += o.olgun;
      if (o.durum === 'tamam' || o.durum === 'pekisti') t.tamam++;
      if (o.durum === 'pekisti') t.pekisti++;
    }
    return t;
  }

  const yuzde = (a, b) => b ? '%' + sayi.format(100 * a / b) : '—';
  const genislik = (a, b) => (b ? 100 * a / b : 0).toFixed(1) + '%';

  function cubuk(t, etiket) {
    return `<div class="prog" role="progressbar" aria-label="${esc(etiket)}" aria-valuemin="0" aria-valuemax="${t.kart || 1}" aria-valuenow="${t.goruldu}">
      <i style="width:${genislik(t.olgun, t.kart)};background:var(--ok)"></i>
      <i style="width:${genislik(t.goruldu - t.olgun, t.kart)};background:var(--acc);opacity:.55"></i>
    </div>`;
  }

  // Son `gunSayisi` çalışma gününün yığılmış aktivite verisi (doğru/iyi vs tekrar/zor ve süre).
  function gunlukAktivite(kayitlar, gunSayisi = 14, simdi = Date.now()) {
    const b = gunNo(simdi);
    const harita = new Map();
    for (let i = gunSayisi - 1; i >= 0; i--) {
      const g = b - i;
      const d = new Date(gunBasi(g));
      const etiket = i === 0 ? 'Bugün' : GUN_KISA[d.getDay()];
      const tarih = `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}`;
      harita.set(g, { gun: g, etiket, tarih, toplam: 0, dogru: 0, zor: 0, ms: 0 });
    }
    for (const l of kayitlar) {
      const t = Date.parse(l.t);
      if (!Number.isFinite(t)) continue;
      const g = gunNo(t);
      const veri = harita.get(g);
      if (!veri) continue;
      veri.toplam++;
      if (l.ok === 'biliyorum' || l.r >= 3) veri.dogru++;
      else veri.zor++;
      if (l.ms > 0) veri.ms += l.ms;
    }
    return [...harita.values()];
  }

  // Son `gunSayisi` gündeki çalışma metrikleri (toplam tekrar, doğruluk oranı, süre, ortalama sn, biliyorum sayısı).
  function calismaMetrikleri(kayitlar, gunSayisi = 30, simdi = Date.now()) {
    const sinir = simdi - gunSayisi * 86400000;
    let toplamTekrar = 0, basarili = 0, yanitlananTekrar = 0, yanitBasarili = 0;
    let toplamMs = 0, sureliAdet = 0, biliyorumSayisi = 0;
    for (const l of kayitlar) {
      const bil = l.ok === 'biliyorum';
      if (bil) biliyorumSayisi++;
      const t = Date.parse(l.t);
      if (!(t >= sinir)) continue;
      toplamTekrar++;
      const ok = bil || l.r >= 3 || l.ok === 'dogru';
      if (ok) basarili++;
      if (!bil) {
        yanitlananTekrar++;
        if (ok) yanitBasarili++;
        if (l.ms > 0) {
          toplamMs += Math.min(l.ms, 120000);
          sureliAdet++;
        }
      }
    }
    return {
      toplamTekrar,
      dogrulukOrani: toplamTekrar ? basarili / toplamTekrar : null,
      yanitlananTekrar,
      yanitDogrulukOrani: yanitlananTekrar ? yanitBasarili / yanitlananTekrar : null,
      toplamDakika: Math.round(toplamMs / 60000),
      ortSaniye: sureliAdet ? Math.round((toplamMs / sureliAdet) / 100) / 10 : null,
      biliyorumSayisi,
    };
  }

  // Kart türlerine göre (Kelime, Kalıp, Kural, Tanıma, Dikte) ilerleme dağılımı.
  function kartTuruDagilimi(kartlar) {
    const turler = ['kelime', 'kalip', 'kural', 'tanima', 'dikte'];
    return turler.map(tur => {
      const liste = kartlar.filter(k => k.tur === tur);
      let goruldu = 0, olgun = 0;
      for (const k of liste) {
        const d = kartDurumu(k);
        if (d !== 'yeni') goruldu++;
        if (d === 'olgun') olgun++;
      }
      return { tur, ad: TUR_AD[tur] || tur, toplam: liste.length, goruldu, olgun };
    }).filter(x => x.toplam > 0);
  }

  // SVG Halka (Donut) grafiği: Olgun, Genç, Öğreniliyor, Yeni kart oranlarını görselleştirir.
  function halkaGrafikHtml(say, toplam) {
    const top = toplam || 1;
    const r = 44, cevre = 2 * Math.PI * r;
    const dilimler = [
      { ad: 'Olgun', deger: say.olgun, renk: 'var(--ok)' },
      { ad: 'Genç', deger: say.genc, renk: 'var(--acc)' },
      { ad: 'Öğreniliyor', deger: say.ogren, renk: 'var(--warn)' },
      { ad: 'Yeni', deger: say.yeni, renk: 'var(--chip)' },
    ];
    let ofset = 0;
    const halkalar = dilimler.filter(d => d.deger > 0).map(d => {
      const uzunluk = (d.deger / top) * cevre;
      const cizgi = `<circle cx="60" cy="60" r="${r}" fill="none" stroke="${d.renk}" stroke-width="14" stroke-dasharray="${uzunluk.toFixed(2)} ${(cevre - uzunluk).toFixed(2)}" stroke-dashoffset="${(-ofset).toFixed(2)}" transform="rotate(-90 60 60)"/>`;
      ofset += uzunluk;
      return cizgi;
    }).join('');
    const gorulen = say.olgun + say.genc + say.ogren;
    return `<div class="ilr-donut-kapsam">
      <svg class="ilr-donut" viewBox="0 0 120 120" role="img" aria-label="Kart dağılımı grafiği">
        <circle cx="60" cy="60" r="${r}" fill="none" stroke="var(--chip)" stroke-width="14"/>
        ${halkalar}
        <text x="60" y="56" text-anchor="middle" class="ilr-donut-ana">${yuzde(gorulen, toplam)}</text>
        <text x="60" y="73" text-anchor="middle" class="ilr-donut-alt">görüldü</text>
      </svg>
      <div class="ilr-donut-liste">
        ${dilimler.map(d => `<div class="ilr-donut-satir">
          <span><i class="dot" style="background:${d.renk}"></i>${d.ad}</span>
          <b>${sayi.format(d.deger)} <span class="small muted">(${yuzde(d.deger, toplam)})</span></b>
        </div>`).join('')}
      </div>
    </div>`;
  }

  // Son 42 takvim gününde, her çalışma gününde ilk kez görülen kart sayısı ('biliyorum' hariç).
  function yeniKartHizi(hedefKartlar) {
    const hedef = new Set(hedefKartlar.map(k => k.id)), b = bugun();
    const gunler = new Map(), ilk = new Set();
    const olaylar = D.kayitlar.map(l => ({ c: l.c, ok: l.ok, t: Date.parse(l.t) })).filter(x => Number.isFinite(x.t)).sort((a, b) => a.t - b.t);
    for (const { c, ok, t } of olaylar) {
      const g = gunNo(t);
      if (g > b) continue;
      if (ok !== 'biliyorum' && g > b - BAKILAN_GUN && !gunler.has(g)) gunler.set(g, 0);
      if (ilk.has(c)) continue;
      ilk.add(c);
      if (ok !== 'biliyorum' && gunler.has(g) && hedef.has(c)) gunler.set(g, gunler.get(g) + 1);
    }
    return [...gunler.values()].slice(-SON_GUN);
  }

  function ceyrek(s, oran) {
    const i = (s.length - 1) * oran, a = Math.floor(i), u = Math.ceil(i);
    return s[a] + (s[u] - s[a]) * (i - a);
  }

  function haftaYaz(gun, haftaGunu) { return haftaGunu ? ` · yaklaşık ${sayi.format(gun / haftaGunu)} hafta` : ''; }

  function tahminHtml(kalan, hizlar, gunlukYeni, haftaGunu) {
    if (!kalan) return '<p><b>Hedefteki bütün kartları gördün.</b> Artık tekrarlarla pekiştirme aşamasındasın.</p>';
    let kisisel;
    if (hizlar.length < MIN_GUN) kisisel = `Kişisel tahmin için <b>${hizlar.length} / ${MIN_GUN}</b> çalışma günü kaydedildi.`;
    else {
      const s = [...hizlar].sort((a, b) => a - b), hizli = ceyrek(s, .75), yavas = ceyrek(s, .25);
      if (!hizli) kisisel = 'Son çalışma günlerinde hedefe ait yeni kart görülmedi.';
      else {
        const alt = Math.ceil(kalan / hizli), ust = yavas > 0 ? Math.ceil(kalan / yavas) : null;
        kisisel = `Mevcut temponla <b>yaklaşık ${sayi.format(alt)}${ust && ust !== alt ? '–' + sayi.format(ust) : ''} çalışma günü</b>${haftaYaz(alt, haftaGunu)}.`;
      }
    }
    const senaryo = Math.ceil(kalan / gunlukYeni);
    return `<p>${kisisel}</p><p>Günde ${sayi.format(gunlukYeni)} yeni kartla <b>${sayi.format(senaryo)} çalışma günü</b>${haftaYaz(senaryo, haftaGunu)}.</p>`;
  }

  function zayifKonular(kartlar) {
    const b = bugun(), konular = new Map(), harita = new Map(kartlar.map(k => [k.id, k]));
    for (const l of D.kayitlar) {
      const kart = harita.get(l.c);
      if (!kart || b - gunNo(Date.parse(l.t)) > SON_GUN) continue;
      const id = kart.tur === 'kural' ? kart.id : kart.unite.id + ':' + kart.tur;
      if (!konular.has(id)) konular.set(id, { id, kart, hata: 0, toplam: 0 });
      const k = konular.get(id);
      k.toplam++;
      if (l.r <= 2) k.hata++;
    }
    return [...konular.values()].filter(k => k.hata)
      .sort((a, b) => b.hata - a.hata || b.hata / b.toplam - a.hata / a.toplam).slice(0, 3)
      .map(k => ({ ...k, ad: `${uniteEtiketi(k.kart.unite)} · ${k.kart.baslik || TUR_AD[k.kart.tur]}`, sorular: konuSorulari(k.kart) }));
  }

  // Kartın konusundan (kural kartı ya da ünitedeki aynı türden kartlar) en uzun süredir sorulmayan sorular.
  function konuSorulari(kart, adet = 5) {
    const kaynak = kart.tur === 'kural' ? [kart] : kart.unite.kartlar.filter(c => c.tur === kart.tur);
    return kaynak.flatMap(k => k.ogeler.map(oge => ({ kart: k, oge, son: D.durum.get(k.id)?.ogeSon?.[oge.id] ?? -Infinity })))
      .sort((a, b) => a.son - b.son).slice(0, adet);
  }

  // Sıradaki ünite: seviyeli, aktif ve henüz bütün kartları görülmemiş ilk ünite.
  function siradakiUnite(olcumler = D.uniteler.map(u => ({ u, o: uniteOlc(u), sv: seviye(u.no) }))) {
    return olcumler.find(x => x.o.toplam && x.sv && !D.ayar.pasif.includes(x.u.id) && x.o.goruldu < x.o.toplam);
  }

  const HATA_AD = { dogru: 'Doğru', harf: 'Büyük/küçük harf', umlaut: 'Umlaut yazımı', umlautEksik: 'Umlaut eksik',
    yazim: 'Yazım', yanlis: 'Yanlış', bos: 'Boş', oz: 'Öz değerlendirme', biliyorum: 'Zaten biliyorum' };

  // Unutma sayısı eşiği aşan kartlar, en çok unutulan önce.
  function sulukKartlar(kartlar, esik = 4) {
    return kartlar.filter(k => (D.durum.get(k.id)?.unutma || 0) >= esik)
      .sort((a, b) => D.durum.get(b.id).unutma - D.durum.get(a.id).unutma);
  }

  // Son `gun` günün kayıtlarında sonuç koduna (ok) göre sayım.
  function hataTurleri(kayitlar, gun = 30, simdi = Date.now()) {
    const sinir = simdi - gun * 86400000, sayim = {};
    for (const l of kayitlar) {
      const t = Date.parse(l.t);
      if (!l.ok || !(t >= sinir)) continue;
      sayim[l.ok] = (sayim[l.ok] || 0) + 1;
    }
    return sayim;
  }

  // Panelde yalnız hata türleri: doğru, büyük/küçük harf (harf), öz değerlendirme (oz) ve biliyorum sayılmaz.
  function hataPaneli(sayim) {
    return Object.entries(sayim).filter(([kod]) => !['dogru', 'harf', 'oz', 'biliyorum'].includes(kod)).sort((a, b) => b[1] - a[1]);
  }

  function uniteSatiri(u, o) {
    const kurallar = u.kartlar.filter(k => k.tur === 'kural');
    const pasif = D.ayar.pasif.includes(u.id);
    return `<details class="ilr-unite">
      <summary>
        <span class="ilr-ad">${esc(u.baslik)}${pasif ? ' <span class="chip">Kapalı</span>' : ''}</span>
        <span class="ilr-durum d-${o.durum}">${DURUM_AD[o.durum]}</span>
        <span class="small muted ilr-sayi">${o.goruldu}/${o.toplam} kart · olgun ${yuzde(o.olgun, o.toplam)}</span>
      </summary>
      <div class="ilr-ic">
        ${cubuk({ kart: o.toplam, goruldu: o.goruldu, olgun: o.olgun }, u.baslik)}
        ${kurallar.length ? `<ul class="ilr-kurallar">${kurallar.map(k => {
          const d = kartDurumu(k);
          return `<li><span>${esc(k.baslik)}</span><span class="ilr-kart k-${d}">${KART_AD[d]}</span></li>`;
        }).join('')}</ul>` : ''}
        <div class="row">
          ${u.konu ? `<button class="btn small" data-konu="${esc(u.id)}">Konu anlatımı</button>` : ''}
          <button class="btn small" data-pratik="${esc(u.id)}">Bu üniteden pratik</button>
        </div>
      </div>
    </details>`;
  }

  function stilleriYukle() {
    if (document.getElementById('ilerleme-stilleri')) return;
    const stil = document.createElement('style');
    stil.id = 'ilerleme-stilleri';
    stil.textContent = `
      #ilerleme-sayfasi h1{font-size:clamp(24px,4.5vw,32px);margin:0 0 6px;letter-spacing:-.025em;line-height:1.18}
      #ilerleme-sayfasi p{margin:.5em 0}
      .ilr-ozet{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,7.5rem),1fr));gap:10px;margin:14px 0}
      .ilr-ozet div{background:var(--panel-2);border:1px solid var(--line);border-radius:var(--radius);padding:11px 13px}
      .ilr-ozet b{display:block;font-size:1.45em;font-variant-numeric:tabular-nums;line-height:1.2}
      .ilr-seviye-izgara{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,14rem),1fr));gap:12px;margin-top:8px}
      .ilr-seviye-kart{background:var(--panel-2);border:1px solid var(--line);border-radius:var(--radius);padding:13px 15px;display:grid;gap:8px;box-shadow:var(--shadow-sm)}
      .ilr-seviye-baslik{display:flex;justify-content:space-between;align-items:baseline}
      .ilr-seviye-baslik b{font-size:1.25em}
      .ilr-seviye-yuzde{font-weight:700;font-size:1.15em;color:var(--acc);font-variant-numeric:tabular-nums}
      .ilr-grup>summary{cursor:pointer;padding:10px 0;font-weight:600}
      .ilr-unite{border-top:1px solid var(--line)}
      .ilr-unite summary{cursor:pointer;display:flex;flex-wrap:wrap;gap:4px 10px;align-items:center;padding:10px 0;list-style-position:inside}
      .ilr-ad{flex:1 1 16rem;min-width:0;font-weight:500}
      .ilr-sayi{flex-basis:100%;padding-left:1.2em;font-variant-numeric:tabular-nums}
      .ilr-durum,.ilr-kart{font-size:12px;border-radius:99px;padding:2px 9px;background:var(--bg-subtle);border:1px solid var(--line);color:var(--muted);white-space:nowrap}
      .d-devam,.k-ogren{background:var(--warn-bg);border-color:var(--warn-border);color:var(--warn)}
      .d-tamam,.k-genc{background:var(--acc-soft);border-color:color-mix(in srgb,var(--acc) 26%,var(--line));color:var(--acc)}
      .d-pekisti,.k-olgun{background:var(--ok-bg);border-color:var(--ok-border);color:var(--ok)}
      .ilr-ic{padding:0 0 14px 1.2em;display:grid;gap:10px}
      .ilr-kurallar{list-style:none;margin:0;padding:0;display:grid;gap:6px}
      .ilr-kurallar li{display:flex;justify-content:space-between;gap:10px;font-size:14px;padding:4px 0;border-bottom:1px solid var(--line)}
      .ilr-kurallar li:last-child{border-bottom:0}
      .ilr-secim{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px 12px;align-items:center}
      .ilr-secim select,.ilr-secim input{border:1px solid var(--line-strong);border-radius:var(--radius-sm);background:var(--panel-2);color:inherit;padding:7px 10px;min-height:40px}
      .ilr-secim input{width:6.5rem;font-variant-numeric:tabular-nums}
      .ilr-tahmin{background:var(--panel-2);border:1px solid var(--line);padding:10px 13px;border-radius:var(--radius);margin-top:12px}
      .ilr-zayif{list-style:none;padding:0;margin:0}
      .ilr-zayif li{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 0;border-top:1px solid var(--line)}
      .ilr-zayif li:first-child{border-top:0}
      .ilr-aktivite{display:grid;grid-template-columns:repeat(14,minmax(0,1fr));gap:5px;align-items:end;height:126px;margin:14px 0 8px;padding-top:16px}
      .ilr-akt-sutun{display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%;font-size:11px;color:var(--muted);min-width:0}
      .ilr-akt-yigin{width:76%;display:flex;flex-direction:column;justify-content:flex-end;border-radius:4px 4px 0 0;overflow:hidden;min-height:2px;background:var(--bg-subtle)}
      .ilr-akt-yigin i{display:block;width:100%}
      .ilr-akt-sayi{font-size:11px;font-weight:600;color:var(--ink);font-variant-numeric:tabular-nums;margin-bottom:2px}
      .ilr-akt-etiket{margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
      .ilr-donut-kapsam{display:grid;grid-template-columns:130px 1fr;gap:18px;align-items:center;margin:10px 0 16px}
      .ilr-donut{width:130px;height:130px;display:block}
      .ilr-donut-ana{font-size:18px;font-weight:700;fill:var(--ink);font-variant-numeric:tabular-nums}
      .ilr-donut-alt{font-size:11px;fill:var(--muted)}
      .ilr-donut-liste{display:grid;gap:6px}
      .ilr-donut-satir{display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:14px;font-variant-numeric:tabular-nums}
      .ilr-tur-liste{display:grid;gap:10px;margin-top:12px;padding-top:12px;border-top:1px solid var(--line)}
      .ilr-tur-satir{display:grid;gap:4px}
      .ilr-hata-cubuk{height:7px;background:var(--bg-subtle);border-radius:99px;overflow:hidden;margin-top:4px;width:100%}
      .ilr-hata-cubuk i{display:block;height:100%;background:var(--bad);border-radius:99px}
      @media(max-width:480px){
        .ilr-donut-kapsam{grid-template-columns:1fr;justify-items:center}
        .ilr-donut-liste{width:100%}
        .ilr-akt-etiket{font-size:9px}
      }
      @media(max-width:380px){.ilr-secim{grid-template-columns:1fr}}
    `;
    document.head.append(stil);
  }

  function ayarSayi(deger, alt, ust, varsayilan) {
    return Number.isInteger(deger) && deger >= alt && deger <= ust ? deger : varsayilan;
  }

  const f = function ilerlemeEkran() {
    stilleriYukle();
    const hedef = SEVIYELER.includes(D.ayar.ilerlemeHedefi) ? D.ayar.ilerlemeHedefi : 'B2';
    const hedefSira = SEVIYELER.indexOf(hedef);
    const haftaGunu = ayarSayi(D.ayar.calismaGunleri, 0, 7, 0);
    const gunlukYeni = ayarSayi(D.ayar.tahminYeniGunluk, 1, 500, ayarSayi(D.ayar.yeniLimit, 1, 500, 20));

    const olcumler = D.uniteler.map(u => ({ u, o: uniteOlc(u), sv: seviye(u.no) }));
    const kartli = olcumler.filter(x => x.o.toplam);
    const genel = topla(kartli.filter(x => x.sv));
    const siradaki = siradakiUnite(kartli);
    const hedefListe = kartli.filter(x => x.sv && !D.ayar.pasif.includes(x.u.id) && SEVIYELER.indexOf(x.sv) <= hedefSira);
    const hedefT = topla(hedefListe);
    const hedefKartlar = hedefListe.flatMap(x => x.u.kartlar);
    const aktifKartlar = D.sira.filter(k => !pasifMi(k));
    const zayif = zayifKonular(aktifKartlar);
    const suluk = sulukKartlar(aktifKartlar);
    const hataListe = hataPaneli(hataTurleri(D.kayitlar));
    const hataToplam = hataListe.reduce((a, [, n]) => a + n, 0);
    const hataMax = hataListe.length ? hataListe[0][1] : 1;

    // Yeni görsel istatistik verileri
    const aktivite = gunlukAktivite(D.kayitlar, 14);
    const aktMax = Math.max(1, ...aktivite.map(x => x.toplam));
    const metrik = calismaMetrikleri(D.kayitlar, 30);
    const durumSay = { yeni: 0, ogren: 0, genc: 0, olgun: 0 };
    for (const k of aktifKartlar) durumSay[kartDurumu(k)]++;
    const turDagilim = kartTuruDagilimi(aktifKartlar);

    const aktiviteHtml = `<section class="panel">
      <h2>Çalışma aktivitesi ve performans</h2>
      <div class="ilr-ozet">
        <div><b>${sayi.format(metrik.yanitlananTekrar)}</b><span class="small muted">son 30 gün yanıt${metrik.toplamTekrar > metrik.yanitlananTekrar ? ` (+${sayi.format(metrik.toplamTekrar - metrik.yanitlananTekrar)} eleme)` : ''}</span></div>
        <div><b>${metrik.yanitDogrulukOrani === null ? '—' : yuzde(metrik.yanitDogrulukOrani, 1)}</b><span class="small muted">yanıt doğruluk oranı</span></div>
        <div><b>${metrik.toplamDakika ? metrik.toplamDakika + ' dk' : '—'}</b><span class="small muted">son 30 gün süre</span></div>
        <div><b>${metrik.ortSaniye ? sayi.format(metrik.ortSaniye) + ' sn' : '—'}</b><span class="small muted">kart başına süre</span></div>
      </div>
      <h3 class="small" style="margin:12px 0 4px">Son 14 gün çözülen kartlar</h3>
      <div class="ilr-aktivite" role="img" aria-label="Son 14 günlük çalışma aktivitesi grafiği">
        ${aktivite.map(g => {
          const boy = g.toplam ? Math.max(6, Math.round(82 * g.toplam / aktMax)) : 2;
          const dogruOran = g.toplam ? (100 * g.dogru / g.toplam).toFixed(1) : 0;
          const zorOran = g.toplam ? (100 * g.zor / g.toplam).toFixed(1) : 0;
          return `<div class="ilr-akt-sutun" title="${g.tarih}: ${g.toplam} cevap (${g.dogru} iyi/doğru, ${g.zor} tekrar/zor)">
            <span class="ilr-akt-sayi">${g.toplam || ''}</span>
            <div class="ilr-akt-yigin" style="height:${boy}%">
              ${g.zor ? `<i style="height:${zorOran}%;background:var(--warn)"></i>` : ''}
              ${g.dogru ? `<i style="height:${dogruOran}%;background:var(--ok)"></i>` : ''}
            </div>
            <span class="ilr-akt-etiket">${esc(g.etiket)}</span>
          </div>`;
        }).join('')}
      </div>
      <div class="legend">
        <span><i class="dot" style="background:var(--ok)"></i>İyi / Kolay / Biliyorum</span>
        <span><i class="dot" style="background:var(--warn)"></i>Tekrar / Zor</span>
        ${metrik.biliyorumSayisi ? `<span>· Toplam <b>${sayi.format(metrik.biliyorumSayisi)}</b> kart „zaten biliyorum“ olarak geçildi</span>` : ''}
      </div>
    </section>`;

    const dagilimHtml = `<section class="panel">
      <h2>Kart dağılımı ve türler</h2>
      ${halkaGrafikHtml(durumSay, aktifKartlar.length)}
      <div class="ilr-tur-liste">
        ${turDagilim.map(t => `<div class="ilr-tur-satir">
          <div class="row spread"><span class="small"><b>${esc(t.ad)}</b></span><span class="small muted">${sayi.format(t.goruldu)} / ${sayi.format(t.toplam)} görüldü · olgun ${yuzde(t.olgun, t.toplam)}</span></div>
          ${cubuk({ kart: t.toplam, goruldu: t.goruldu, olgun: t.olgun }, t.ad + ' ilerlemesi')}
        </div>`).join('')}
      </div>
    </section>`;

    const seviyeHtml = `<div class="ilr-seviye-izgara">${SEVIYELER.map(sv => {
      const t = topla(kartli.filter(x => x.sv === sv));
      if (!t.unite) return '';
      return `<div class="ilr-seviye-kart">
        <div class="ilr-seviye-baslik"><b>${sv}</b><span class="ilr-seviye-yuzde">${yuzde(t.goruldu, t.kart)}</span></div>
        ${cubuk(t, sv + ' ilerlemesi')}
        <div class="small muted">${t.tamam}/${t.unite} ünite tamam · ${t.pekisti} pekişti · ${sayi.format(t.olgun)}/${sayi.format(t.kart)} olgun</div>
      </div>`;
    }).join('')}</div>`;

    const gruplar = [...SEVIYELER, null].map(sv => {
      const liste = olcumler.filter(x => x.sv === sv && (x.o.toplam || x.u.konu));
      if (!liste.length) return '';
      const acik = siradaki ? siradaki.sv === sv : sv === 'B2';
      return `<details class="ilr-grup" ${acik ? 'open' : ''}>
        <summary>${sv ? sv + ' üniteleri' : 'Kişisel'}</summary>
        ${liste.map(({ u, o }) => o.toplam ? uniteSatiri(u, o)
          : `<div class="ilr-unite" style="padding:9px 0"><span>${esc(u.baslik)}</span> <button class="btn small" data-konu="${esc(u.id)}">Konu anlatımı</button></div>`).join('')}
      </details>`;
    }).join('');

    $('#app').innerHTML = `<div id="ilerleme-sayfasi">
      <section class="panel">
        <h1>Konu ilerlemesi ve İstatistikler</h1>
        <p>${siradaki ? `Sıradaki ünite: <b>${esc(siradaki.u.baslik)}</b> · ${siradaki.o.goruldu}/${siradaki.o.toplam} kart görüldü`
          : '<b>Aktif ünitelerdeki bütün kartları gördün.</b>'}</p>
        <div class="ilr-ozet">
          <div><b>${genel.tamam}/${genel.unite}</b><span class="small muted">ünite tamamlandı</span></div>
          <div><b>${genel.pekisti}</b><span class="small muted">ünite pekişti</span></div>
          <div><b>${yuzde(genel.goruldu, genel.kart)}</b><span class="small muted">kart görüldü</span></div>
          <div><b>${yuzde(genel.olgun, genel.kart)}</b><span class="small muted">kart olgun</span></div>
        </div>
        ${cubuk(genel, 'Genel ilerleme')}
        <div class="legend"><span><i class="dot" style="background:var(--ok)"></i>Olgun</span><span><i class="dot" style="background:var(--acc);opacity:.55"></i>Görüldü</span><span><i class="dot" style="background:var(--chip)"></i>Görülmedi</span></div>
        <p class="small muted">Bir ünitenin bütün kartlarını en az bir kez gördüğünde ünite <b>Tamamlandı</b> olur. Kartlarının en az %80'i olgunlaştığında (tekrar aralığı 3 haftayı geçtiğinde) <b>Pekişti</b> olur.</p>
      </section>
      ${aktiviteHtml}
      ${dagilimHtml}
      <section class="panel"><h2>Seviyeler</h2>${seviyeHtml}</section>
      <section class="panel">
        <h2>Bitirme tahmini</h2>
        <div class="ilr-secim">
          <label for="ilr-hedef">Hedef seviye (öncekileri de kapsar)</label>
          <select id="ilr-hedef">${SEVIYELER.map(s => `<option ${s === hedef ? 'selected' : ''}>${s}</option>`).join('')}</select>
          <label for="ilr-gunluk">Günde kaç yeni kart?</label>
          <input id="ilr-gunluk" type="number" min="1" max="500" inputmode="numeric" value="${gunlukYeni}">
          <label for="ilr-hafta">Haftada kaç gün çalışırsın?</label>
          <select id="ilr-hafta"><option value="0">Belirtme</option>${[1, 2, 3, 4, 5, 6, 7].map(i => `<option ${i === haftaGunu ? 'selected' : ''}>${i}</option>`).join('')}</select>
        </div>
        <p><b>${hedefT.tamam}/${hedefT.unite}</b> ünite tamamlandı · ${sayi.format(hedefT.kart - hedefT.goruldu)} kart henüz görülmedi</p>
        <div class="ilr-tahmin" aria-live="polite">${tahminHtml(hedefT.kart - hedefT.goruldu, yeniKartHizi(hedefKartlar), gunlukYeni, haftaGunu)}</div>
      </section>
      ${zayif.length ? `<section class="panel"><h2>Zorlandığın konular</h2>
        <p class="small muted">Son ${SON_GUN} günde Tekrar veya Zor puanı verdiğin konular.</p>
        <ul class="ilr-zayif">${zayif.map((z, i) => `<li><span>${esc(z.ad)} <span class="small muted">· ${z.hata}/${z.toplam}</span></span>
          <button class="btn small" data-zayif="${i}">${z.sorular.length} soru çöz</button></li>`).join('')}</ul></section>` : ''}
      ${suluk.length ? `<section class="panel"><h2>Takıldığın kartlar</h2>
        <p class="small muted">4 ya da daha fazla kez unuttuğun kartlar.</p>
        <ul class="ilr-zayif">${suluk.slice(0, 10).map((k, i) => `<li><span>${esc(uniteEtiketi(k.unite))} · ${esc(k.baslik || TUR_AD[k.tur])} <span class="small muted">· ${D.durum.get(k.id).unutma} kez unutuldu</span></span>
          <span class="row"><button class="btn small" data-suluk-konu="${i}">Konu</button> <button class="btn small" data-suluk="${i}">5 soru</button></span></li>`).join('')}</ul></section>` : ''}
      ${hataToplam ? `<section class="panel"><h2>Hata türleri</h2>
        <p class="small muted">Son 30 gündeki yanlış ve yarı doğru cevapların dağılımı (${sayi.format(hataToplam)} hata).</p>
        <ul class="ilr-zayif">${hataListe.map(([kod, n]) => `<li style="display:block">
          <div class="row spread"><span>${esc(HATA_AD[kod] || kod)}</span><b>${n} <span class="small muted">(${yuzde(n, hataToplam)})</span></b></div>
          <div class="ilr-hata-cubuk"><i style="width:${(100 * n / hataMax).toFixed(1)}%"></i></div>
        </li>`).join('')}</ul></section>` : ''}
      <section class="panel"><h2>Üniteler ve konular</h2>${gruplar}</section>
      ${gelecekTekrarlarHtml()}
    </div>`;

    const ayarla = (id, anahtar, donustur) => {
      $('#' + id).onchange = e => {
        const deger = donustur(e.target.value);
        if (deger === undefined) return;
        D.ayar[anahtar] = deger;
        ayarKaydet();
        ilerlemeEkran();
        $('#' + id)?.focus({ preventScroll: true });
      };
    };
    ayarla('ilr-hedef', 'ilerlemeHedefi', x => SEVIYELER.includes(x) ? x : 'B2');
    ayarla('ilr-gunluk', 'tahminYeniGunluk', x => ayarSayi(Number(x), 1, 500, undefined));
    ayarla('ilr-hafta', 'calismaGunleri', x => ayarSayi(Number(x), 0, 7, 0));
    const sayfa = $('#ilerleme-sayfasi');
    sayfa.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.konu) konuAc(D.uniteler.find(u => u.id === b.dataset.konu));
      else if (b.dataset.zayif) { const z = zayif[+b.dataset.zayif]; pratikBaslat(z.sorular, z.ad, 'ilerleme'); }
      else if (b.dataset.sulukKonu) konuAc(suluk[+b.dataset.sulukKonu].unite);
      else if (b.dataset.suluk) {
        const k = suluk[+b.dataset.suluk];
        const sorular = k.ogeler.map(oge => ({ kart: k, oge, son: D.durum.get(k.id)?.ogeSon?.[oge.id] ?? -Infinity }))
          .sort((a, b) => a.son - b.son).slice(0, 5);
        pratikBaslat(sorular, `${uniteEtiketi(k.unite)} · ${k.baslik || TUR_AD[k.tur]}`, 'ilerleme');
      }
      else if (b.dataset.pratik) {
        const u = D.uniteler.find(x => x.id === b.dataset.pratik);
        const sorular = u.kartlar.flatMap(kart => kart.ogeler.map(oge => ({ kart, oge })));
        for (let i = sorular.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [sorular[i], sorular[j]] = [sorular[j], sorular[i]]; }
        pratikBaslat(sorular.slice(0, PRATIK_LIMIT), u.baslik, 'ilerleme');
      }
    });
  };
  f.yardimci = { sulukKartlar, hataTurleri, hataPaneli, konuSorulari, siradakiUnite, gunlukAktivite, calismaMetrikleri, kartTuruDagilimi, yeniKartHizi };
  return f;
})();
