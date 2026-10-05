/* planer.js — „Kuda putujete?“: preporuka graničnog prelaza sa najmanjim ukupnim vremenom puta.
   Ukupno = vožnja do prelaza + očekivano čekanje u trenutku dolaska + vožnja posle prelaza.
   Rutiranje radi naš OSRM (Docker, 127.0.0.1:5055, mapa Srbije i okolnih zemalja – deploy/osrm/pripremi.sh),
   mesta su u data/mesta.db (ista OSM mapa). Nema spoljnih servisa. */
const path = require('node:path');
const fs = require('node:fs');

const OSRM = process.env.OSRM_URL || 'http://127.0.0.1:5055';
const MESTA_DB = path.join(__dirname, '..', 'data', 'mesta.db');

/* Tačka prelaza je čvor granične kontrole iz OSM-a; smer = kurs vožnje pri izlasku iz Srbije.
   Kurs se šalje OSRM-u (bearings) da se tačka ne „zalepi“ za suprotnu stranu auto-puta. */
const PRELAZI = [
  { naziv: 'Horgoš', ka: 'Mađarska', lat: 46.1733, lon: 19.9758, kurs: 20 },
  { naziv: 'Kelebija', ka: 'Mađarska', lat: 46.1692, lon: 19.5578, kurs: 350 },
  { naziv: 'Đala', ka: 'Mađarska', lat: 46.15743, lon: 20.11423, kurs: 60, samoEU: true },
  { naziv: 'Batrovci', ka: 'Hrvatska', lat: 45.0473, lon: 19.1070, kurs: 270 },
  { naziv: 'Šid', ka: 'Hrvatska', lat: 45.1548, lon: 19.1752, kurs: 270 },
  { naziv: 'Bačka Palanka', ka: 'Hrvatska', lat: 45.2397, lon: 19.3987, kurs: 200 },
  { naziv: 'Bezdan', ka: 'Hrvatska', lat: 45.8446, lon: 18.8666, kurs: 250 },
  { naziv: 'Sremska Rača', ka: 'Bosna i Hercegovina', lat: 44.9165, lon: 19.3039, kurs: 200 },
  { naziv: 'Mali Zvornik', ka: 'Bosna i Hercegovina', lat: 44.4036, lon: 19.1260, kurs: 290 },
  { naziv: 'Trbušnica', ka: 'Bosna i Hercegovina', lat: 44.5407, lon: 19.1847, kurs: 270 },
  { naziv: 'Kotroman', ka: 'Bosna i Hercegovina', lat: 43.7626, lon: 19.4702, kurs: 270 },
  { naziv: 'Gostun', ka: 'Crna Gora', lat: 43.1851, lon: 19.7605, kurs: 170 },
  { naziv: 'Jabuka', ka: 'Crna Gora', lat: 43.3375, lon: 19.4777, kurs: 260 },
  { naziv: 'Špiljani', ka: 'Crna Gora', lat: 42.9105, lon: 20.3412, kurs: 210 },
  { naziv: 'Preševo', ka: 'Severna Makedonija', lat: 42.2399, lon: 21.7018, kurs: 200 },
  { naziv: 'Gradina', ka: 'Bugarska', lat: 42.9985, lon: 22.8315, kurs: 120 },
  { naziv: 'Vrška Čuka', ka: 'Bugarska', lat: 43.8503, lon: 22.3790, kurs: 90 },
  { naziv: 'Vatin', ka: 'Rumunija', lat: 45.2292, lon: 21.2767, kurs: 315 },
];

/* Mapa pokriva Srbiju i okolinu; za dalja mesta (Nemačka, Švajcarska, Turska…) ruta se vodi do izlazne tačke
   na ivici mape, a ostatak se računa vazdušnom linijom × 1,25 pri ~100 km/h (za izbor prelaza je to dovoljno tačno). */
const KAPIJE = [
  { ime: 'Walserberg (Salcburg)', lat: 47.787, lon: 12.995 }, { ime: 'Suben (Pasau)', lat: 48.417, lon: 13.425 },
  { ime: 'Kufštajn', lat: 47.601, lon: 12.181 }, { ime: 'Hörbranz (Lindau)', lat: 47.555, lon: 9.747 },
  { ime: 'Lustenau', lat: 47.435, lon: 9.656 }, { ime: 'Brener', lat: 47.005, lon: 11.505 },
  { ime: 'Arnoldštajn', lat: 46.550, lon: 13.708 }, { ime: 'Fernetiči', lat: 45.700, lon: 13.836 },
  { ime: 'Drasenhofen', lat: 48.753, lon: 16.645 }, { ime: 'Vulovic', lat: 48.630, lon: 14.450 },
  { ime: 'Trstena', lat: 49.372, lon: 19.610 }, { ime: 'Kuti', lat: 48.660, lon: 17.030 },
  { ime: 'Kapitan Andreevo', lat: 41.717, lon: 26.317 }, { ime: 'Kipi', lat: 40.920, lon: 26.310 },
];
const OSTATAK_FAKTOR = 1.25, OSTATAK_KMH = 100;

const rad = (x) => (x * Math.PI) / 180;
const vazdusno = (a, b) => { const d = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2; return 12742 * Math.asin(Math.sqrt(d)); };

/* ---------- mesta (pretraga) ---------- */
const CIR = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', ђ: 'dj', е: 'e', ж: 'z', з: 'z', и: 'i', ј: 'j', к: 'k', л: 'l', љ: 'lj', м: 'm', н: 'n', њ: 'nj', о: 'o', п: 'p', р: 'r', с: 's', т: 't', ћ: 'c', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'c', џ: 'dz', ш: 's' };
/* ključ za pretragu: mala slova, ćirilica → latinica, bez kvačica (đ → dj), samo slova/brojevi/razmak */
function kljuc(s) {
  return String(s || '').toLowerCase().replace(/[а-џ]/g, (c) => (CIR[c] != null ? CIR[c] : c)).replace(/đ/g, 'dj')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ß/g, 'ss').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}
let mestaDb = null;
function mesta() {
  if (mestaDb) return mestaDb;
  if (!fs.existsSync(MESTA_DB)) return null;
  const Database = require('better-sqlite3');
  mestaDb = new Database(MESTA_DB, { readonly: true, fileMustExist: true });
  return mestaDb;
}
function trazi(q) {
  const db = mesta(); const k = kljuc(q);
  if (!db || k.length < 2) return [];
  return db.prepare(`SELECT m.id, m.ime, m.drzava, m.tip, m.lat, m.lon, m.van, m.blizu FROM imena i JOIN mesta m ON m.id = i.mesto
    WHERE i.kljuc >= ? AND i.kljuc < ? GROUP BY m.id ORDER BY MAX(CASE WHEN i.kljuc = ? THEN 1 ELSE 0 END) DESC, m.rang DESC LIMIT 8`).all(k, k + '\uffff', k);
}
function mesto(id) { const db = mesta(); return db ? db.prepare('SELECT id, ime, drzava, tip, lat, lon, van FROM mesta WHERE id = ?').get(id) : null; }

/* ---------- OSRM ---------- */
async function tabela(tacke, izvori, ciljevi) {
  const coords = tacke.map((t) => t.lon.toFixed(5) + ',' + t.lat.toFixed(5)).join(';');
  const bearings = tacke.map((t) => (t.kurs != null ? Math.round(t.kurs) + ',70' : '')).join(';');
  const url = `${OSRM}/table/v1/driving/${coords}?sources=${izvori.join(';')}&destinations=${ciljevi.join(';')}&annotations=duration,distance&bearings=${bearings}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const j = await r.json();
  if (j.code !== 'Ok') throw new Error('OSRM: ' + (j.message || j.code));
  return j;   // durations[i][j] u sekundama, distances u metrima, null = nema puta
}

/* ---------- čekanje u trenutku dolaska ---------- */
let kesProfila = { t: 0, v: null };
/* Tipično čekanje po prelazu i smeru: [dan][sat] i [sat] (poslednjih 28 dana); više kamera istog smera → najveće (kolona je jedna) */
function profili(db, KAMERE) {
  if (kesProfila.v && Date.now() - kesProfila.t < 600000) return kesProfila.v;
  const v = {};
  const kol = db.prepare("PRAGMA table_info('kamere_merenja')").all().map((c) => c.name);
  if (!kol.includes('cekanje')) return (kesProfila = { t: Date.now(), v }).v;
  const redovi = db.prepare("SELECT kamera, lok_dan AS dan, lok_sat AS sat, AVG(cekanje) AS c, COUNT(*) AS n FROM kamere_merenja WHERE ok = 1 AND cekanje IS NOT NULL AND vreme >= datetime('now', '-28 days') GROUP BY kamera, lok_dan, lok_sat").all();
  /* kao na stanju: na svakoj strani granice (HAK / MUP) najveće tipično čekanje među kamerama, strane se sabiraju (čeka se redom) */
  const strana = (k) => (k.hr ? 'hr' : 'rs');
  const zbirStrana = (po) => { const vr = Object.values(po); return vr.length ? vr.reduce((a, x) => a + x, 0) : null; };
  for (const r of redovi) {
    const k = KAMERE.find((x) => x.id === r.kamera); if (!k || !k.procena) continue;
    const kl = k.prelaz + '|' + k.smer;
    const p = v[kl] = v[kl] || { danSat: {}, sat: {} };
    const ds = r.dan + '|' + r.sat;
    if (r.n >= 2) { const d = p.danSat[ds] = p.danSat[ds] || {}; if (d[strana(k)] == null || r.c > d[strana(k)]) d[strana(k)] = r.c; }
    const s = p.sat[r.sat] = p.sat[r.sat] || { kam: {} };
    s.kam[r.kamera] = s.kam[r.kamera] || { zbir: 0, n: 0, strana: strana(k) }; s.kam[r.kamera].zbir += r.c * r.n; s.kam[r.kamera].n += r.n;
  }
  for (const p of Object.values(v)) {
    for (const ds of Object.keys(p.danSat)) p.danSat[ds] = zbirStrana(p.danSat[ds]);
    for (const [sat, s] of Object.entries(p.sat)) {
      const po = {}; for (const x of Object.values(s.kam)) if (x.n >= 3) po[x.strana] = Math.max(po[x.strana] ?? 0, x.zbir / x.n);
      p.sat[sat] = zbirStrana(po);
    }
  }
  return (kesProfila = { t: Date.now(), v }).v;
}
const lokalno = (d) => { const p = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Belgrade', hour: 'numeric', hour12: false, weekday: 'short' }).formatToParts(d); return { sat: Number(p.find((x) => x.type === 'hour').value) % 24, dan: (['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.find((x) => x.type === 'weekday').value) + 6) % 7 }; };
/* Sadašnja procena važi za skori dolazak; što je dolazak dalji, to više vredi tipično čekanje za taj dan i sat */
function ocekivano(st, prof, prelaz, smer, dolazak) {
  const sad = st && st.poPrelazu.find((x) => x.prelaz === prelaz && x.smer === smer);
  const p = prof[prelaz + '|' + smer]; const { dan, sat } = lokalno(dolazak);
  const tip = p ? (p.danSat[dan + '|' + sat] != null ? p.danSat[dan + '|' + sat] : p.sat[sat]) : null;
  const zaMin = (dolazak - Date.now()) / 60000;
  if (!sad && tip == null) return { minuta: null, izvor: 'nepoznato' };
  if (!sad || sad.izvorProcene === 'tipicno') return { minuta: Math.round(tip != null ? tip : sad.minuta), izvor: 'tipicno' };
  let w = Math.max(0, Math.min(1, (zaMin - 20) / 120));
  if (sad.izvorProcene === 'poslednja') w = Math.max(w, 0.5);   // staro merenje – više se oslanja na tipično
  if (tip == null) return { minuta: sad.minuta, izvor: w > 0.3 ? 'sada' : 'uzivo', plus: sad.plus };
  const m = Math.round(sad.minuta * (1 - w) + tip * w);
  return { minuta: m, izvor: w < 0.3 ? 'uzivo' : w > 0.8 ? 'tipicno' : 'mesano', plus: w < 0.3 && sad.plus };
}
const NEPOZNATO_MIN = 15;   // prelaz bez podataka za taj smer: pretpostavka da se ne bi uvek birao „prazan“ prelaz

/* ---------- preporuka ---------- */
async function preporuci(db, statistika, KAMERE, od, doo, opcije) {
  const st = (() => { try { return statistika(db); } catch (e) { return null; } })();
  const prof = profili(db, KAMERE);
  const polazak = new Date(opcije.polazak || Date.now());
  const odSrb = od.drzava === 'Srbija', doSrb = doo.drzava === 'Srbija';
  if (odSrb && doSrb) return { tip: 'bez-granice', poruka: 'Oba mesta su u Srbiji – na ovom putu nema graničnog prelaza.' };
  const prelazi = PRELAZI.filter((p) => !p.samoEU || opcije.eu);
  const smerovi = odSrb ? ['izlaz'] : doSrb ? ['ulaz'] : ['ulaz', 'izlaz'];

  /* tačke: polazne (mesto ili kapije), prelazi po smeru (sa kursom), odredišne */
  const tacke = []; const dodaj = (t) => (tacke.push(t), tacke.length - 1);
  const krajevi = (m) => (m.van ? KAPIJE.map((k) => ({ lat: k.lat, lon: k.lon, ostatak: vazdusno(k, m), kapija: k.ime })) : [{ lat: m.lat, lon: m.lon, ostatak: 0 }]);
  const A = krajevi(od).map((t) => Object.assign(t, { i: dodaj(t) }));
  const B = krajevi(doo).map((t) => Object.assign(t, { i: dodaj(t) }));
  const P = {};
  for (const s of smerovi) P[s] = prelazi.map((p) => ({ p, i: dodaj({ lat: p.lat, lon: p.lon, kurs: s === 'izlaz' ? p.kurs : (p.kurs + 180) % 360 }) }));
  const ulaz = smerovi[0] === 'ulaz' ? P.ulaz : null, izlaz = P.izlaz || null;
  const izv = [...A.map((a) => a.i), ...(ulaz ? ulaz.map((x) => x.i) : []), ...(izlaz ? izlaz.map((x) => x.i) : [])];
  const cilj = [...B.map((b) => b.i), ...(ulaz ? ulaz.map((x) => x.i) : []), ...(izlaz ? izlaz.map((x) => x.i) : [])];
  const t = await tabela(tacke, [...new Set(izv)], [...new Set(cilj)]);
  const si = [...new Set(izv)], ci = [...new Set(cilj)];
  const noga = (a, b) => { const d = t.durations[si.indexOf(a)][ci.indexOf(b)], m = t.distances[si.indexOf(a)][ci.indexOf(b)]; return d == null ? null : { s: d, m }; };
  const ostatakS = (km) => (km * OSTATAK_FAKTOR / OSTATAK_KMH) * 3600;
  /* najbolja vožnja od polaska do tačke x (preko kapije ako je mesto van mape) i od x do odredišta */
  const doTacke = (x) => { let naj = null; for (const a of A) { const n = noga(a.i, x); if (!n) continue; const s = n.s + ostatakS(a.ostatak), m = n.m + a.ostatak * OSTATAK_FAKTOR * 1000; if (!naj || s < naj.s) naj = { s, m, kapija: a.kapija }; } return naj; };
  const odTacke = (x) => { let naj = null; for (const b of B) { const n = noga(x, b.i); if (!n) continue; const s = n.s + ostatakS(b.ostatak), m = n.m + b.ostatak * OSTATAK_FAKTOR * 1000; if (!naj || s < naj.s) naj = { s, m, kapija: b.kapija }; } return naj; };
  const cek = (p, smer, kad) => { const e = ocekivano(st, prof, p.naziv, smer, kad); return Object.assign(e, { racun: e.minuta == null ? NEPOZNATO_MIN : e.minuta }); };

  const opcijeRute = [];
  if (smerovi.length === 1) {
    const smer = smerovi[0];
    for (const x of P[smer]) {
      const v1 = doTacke(x.i), v2 = odTacke(x.i); if (!v1 || !v2) continue;
      const dolazak = new Date(polazak.getTime() + v1.s * 1000); const c = cek(x.p, smer, dolazak);
      const voznja = v1.s + v2.s;
      opcijeRute.push({ prelazi: [{ naziv: x.p.naziv, ka: x.p.ka, smer, lat: x.p.lat, lon: x.p.lon, dolazak: dolazak.toISOString(), cekanje: c }], voznjaS: voznja, km: (v1.m + v2.m) / 1000, ukupnoS: voznja + c.racun * 60, doGraniceKm: v1.m / 1000, kapije: [v1.kapija, v2.kapija].filter(Boolean) });
    }
  } else {
    /* tranzit kroz Srbiju: par (ulaz, izlaz) */
    for (const u of ulaz) {
      const v1 = doTacke(u.i); if (!v1) continue;
      const dol1 = new Date(polazak.getTime() + v1.s * 1000); const c1 = cek(u.p, 'ulaz', dol1);
      for (const z of izlaz) {
        if (u.p.ka === z.p.ka) continue;   // tranzit ulazi iz jedne, a izlazi u drugu zemlju (Kelebija → Horgoš nije put kroz Srbiju)
        const n = noga(u.i, z.i), v2 = odTacke(z.i); if (!n || !v2) continue;
        const kroz = n.s, krozM = n.m;
        const dol2 = new Date(dol1.getTime() + (c1.racun * 60 + kroz) * 1000); const c2 = cek(z.p, 'izlaz', dol2);
        const voznja = v1.s + kroz + v2.s;
        opcijeRute.push({ prelazi: [
          { naziv: u.p.naziv, ka: u.p.ka, smer: 'ulaz', lat: u.p.lat, lon: u.p.lon, dolazak: dol1.toISOString(), cekanje: c1 },
          { naziv: z.p.naziv, ka: z.p.ka, smer: 'izlaz', lat: z.p.lat, lon: z.p.lon, dolazak: dol2.toISOString(), cekanje: c2 },
        ], voznjaS: voznja, km: (v1.m + krozM + v2.m) / 1000, ukupnoS: voznja + (c1.racun + c2.racun) * 60, kapije: [v1.kapija, v2.kapija].filter(Boolean) });
      }
    }
  }
  if (!opcijeRute.length) return { tip: 'nema', poruka: 'Nije pronađen put preko prelaza koje pratimo.' };

  /* „glavni“ prelaz = najkraća vožnja, ono što bi navigacija izabrala bez obzira na gužvu */
  const glavni = opcijeRute.slice().sort((a, b) => a.voznjaS - b.voznjaS)[0];
  const sve = opcijeRute.sort((a, b) => a.ukupnoS - b.ukupnoS);
  const kljucRute = (r) => r.prelazi.map((p) => p.naziv).join('→');
  const izbor = []; for (const r of sve) { if (izbor.length >= 5) break; if (r.voznjaS > glavni.voznjaS * 1.25 + 1800) continue; /* obilazak duži od četvrtine puta + pola sata nije realna alternativa */ if (!izbor.some((x) => kljucRute(x) === kljucRute(r))) izbor.push(r); }
  if (!izbor.some((x) => x === glavni)) izbor.push(glavni);
  /* tranzit: ako i najkraća ruta preko naših prelaza znatno produžava put, najbrži put verovatno ne ide kroz Srbiju */
  let napomena = '';
  if (smerovi.length === 2) {
    const d = await tabela([...A, ...B].map((x) => ({ lat: x.lat, lon: x.lon })), A.map((_, i) => i), B.map((_, i) => A.length + i));
    let direkt = null; A.forEach((a, i) => B.forEach((b, j) => { const s = d.durations[i][j]; if (s != null) { const u = s + ostatakS(a.ostatak) + ostatakS(b.ostatak); if (direkt == null || u < direkt) direkt = u; } }));
    if (direkt != null && glavni.voznjaS > direkt + 45 * 60) napomena = `Najbrži put između ova dva mesta verovatno ne vodi kroz Srbiju (oko ${Math.round((glavni.voznjaS - direkt) / 60)} min kraće vožnje drugim putem). Prikazane su opcije preko Srbije.`;
  }
  const oblik = (r) => ({ prelazi: r.prelazi, voznjaMin: Math.round(r.voznjaS / 60), km: Math.round(r.km), ukupnoMin: Math.round(r.ukupnoS / 60), cekanjeMin: r.prelazi.reduce((a, p) => a + p.cekanje.racun, 0), glavni: r === glavni, kapije: r.kapije, stizete: new Date(polazak.getTime() + r.ukupnoS * 1000).toISOString() });
  return { tip: smerovi.length === 2 ? 'tranzit' : smerovi[0], polazak: polazak.toISOString(), od: { ime: od.ime, drzava: od.drzava, lat: od.lat, lon: od.lon, van: !!od.van }, do: { ime: doo.ime, drzava: doo.drzava, lat: doo.lat, lon: doo.lon, van: !!doo.van }, opcije: izbor.map(oblik), napomena, azurirano: st && st.azurirano };
}

module.exports = function (app, { db, statistika, KAMERE }) {
  app.get('/api/granice/mesta', (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=3600');
    try { res.json(trazi(String(req.query.q || '').slice(0, 60))); } catch (e) { res.status(500).json({ greska: 'Pretraga mesta trenutno ne radi.' }); }
  });
  app.get('/api/granice/ruta', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const od = mesto(Number(req.query.od)), doo = mesto(Number(req.query.do));
    if (!od || !doo) return res.status(400).json({ greska: 'Izaberite mesto polaska i odredište sa spiska.' });
    let polazak = req.query.polazak ? new Date(String(req.query.polazak)) : new Date();
    if (isNaN(polazak) || polazak < Date.now() - 3600e3 || polazak > Date.now() + 7 * 86400e3) polazak = new Date();
    try { res.json(await preporuci(db, statistika, KAMERE, od, doo, { polazak, eu: req.query.eu === '1' })); }
    catch (e) { console.error('planer:', e.message); res.status(503).json({ greska: 'Planer trenutno ne radi, pokušajte za par minuta.' }); }
  });
};
module.exports.kljuc = kljuc;
module.exports.PRELAZI = PRELAZI;
