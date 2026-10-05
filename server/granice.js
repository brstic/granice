/* granice.js — stanje na graničnim prelazima. Strana /stanje-na-granicama je izdvojena od ostatka sajta i čita samo ovaj API.
   Podaci žive u data/granice.json (nije u zipu za deploy, ostaje na serveru); dok fajla nema, vraća se spisak prelaza bez vremena.
   Admin ih upisuje sa PUT /api/admin/granice (ceo JSON), a kasnije to može da radi i skripta/cron sa dogovorenim izvorom. */
const path = require('node:path');
const fs = require('node:fs');

const FAJL = path.join(__dirname, '..', 'data', 'granice.json');
/* Samo prelazi koji imaju bar jednu kameru (Brankova odluka 22.09.2026: evidencija samo tamo gde merimo) */
const PRELAZI = [
  { drzava: 'Mađarska', naziv: 'Horgoš', susedni: 'Röszke', tip: 'auto-put A1 / M5' },
  { drzava: 'Mađarska', naziv: 'Kelebija', susedni: 'Tompa', tip: 'magistrala' },
  { drzava: 'Mađarska', naziv: 'Đala', susedni: 'Tiszasziget', tip: 'putnička vozila' },
  { drzava: 'Hrvatska', naziv: 'Batrovci', susedni: 'Bajakovo', tip: 'auto-put A3 / E70' },
  { drzava: 'Hrvatska', naziv: 'Šid', susedni: 'Tovarnik', tip: 'magistrala' },
  { drzava: 'Hrvatska', naziv: 'Bačka Palanka', susedni: 'Ilok', tip: 'most na Dunavu' },
  { drzava: 'Hrvatska', naziv: 'Bezdan', susedni: 'Batina', tip: 'most na Dunavu' },
  { drzava: 'Bosna i Hercegovina', naziv: 'Sremska Rača', susedni: 'Rača', tip: 'E70' },
  { drzava: 'Bosna i Hercegovina', naziv: 'Mali Zvornik', susedni: 'Karakaj', tip: 'most na Drini' },
  { drzava: 'Bosna i Hercegovina', naziv: 'Trbušnica', susedni: 'Šepak', tip: 'Loznica – Zvornik, most na Drini' },
  { drzava: 'Bosna i Hercegovina', naziv: 'Kotroman', susedni: 'Vardište', tip: 'Užice – Višegrad' },
  { drzava: 'Crna Gora', naziv: 'Gostun', susedni: 'Dobrakovo', tip: 'Prijepolje – Bijelo Polje' },
  { drzava: 'Crna Gora', naziv: 'Jabuka', susedni: 'Ranče', tip: 'Prijepolje – Pljevlja' },
  { drzava: 'Crna Gora', naziv: 'Špiljani', susedni: 'Dračenovac', tip: 'Novi Pazar – Rožaje' },
  { drzava: 'Severna Makedonija', naziv: 'Preševo', susedni: 'Tabanovce', tip: 'auto-put A1 / E75' },
  { drzava: 'Bugarska', naziv: 'Gradina', susedni: 'Kalotina', tip: 'auto-put A4 / E80' },
  { drzava: 'Bugarska', naziv: 'Vrška Čuka', susedni: 'Vraška Čuka', tip: 'Zaječar – Vidin' },
  { drzava: 'Rumunija', naziv: 'Vatin', susedni: 'Moravița', tip: 'Vršac – Temišvar' },
];
const OSNOVA = () => ({ azurirano: null, izvor: '', prelazi: PRELAZI.map((p) => Object.assign({}, p, { cekanje: { ulaz: {}, izlaz: {} }, napomena: '' })) });

function ucitaj() {
  try { const j = JSON.parse(fs.readFileSync(FAJL, 'utf8')); if (j && Array.isArray(j.prelazi)) { j.prelazi = j.prelazi.filter((p) => PRELAZI.some((x) => x.naziv === p.naziv)); return j; } } catch (e) { /* nema fajla */ }
  return OSNOVA();
}
/* Provera i čišćenje JSON-a koji admin šalje: samo poznata polja, minuti kao celi brojevi ili null */
function ocisti(b) {
  const minuti = (x) => (x === null || x === undefined || x === '' ? null : Math.max(0, Math.min(1440, Math.round(Number(x)) || 0)));
  const s = (x, n) => String(x == null ? '' : x).slice(0, n || 80);
  const prelazi = (Array.isArray(b.prelazi) ? b.prelazi : []).slice(0, 60).map((p) => ({
    drzava: s(p.drzava), naziv: s(p.naziv), susedni: s(p.susedni), tip: s(p.tip),
    cekanje: { ulaz: { auto: minuti((p.cekanje || {}).ulaz && p.cekanje.ulaz.auto), autobus: minuti((p.cekanje || {}).ulaz && p.cekanje.ulaz.autobus), kamion: minuti((p.cekanje || {}).ulaz && p.cekanje.ulaz.kamion) },
      izlaz: { auto: minuti((p.cekanje || {}).izlaz && p.cekanje.izlaz.auto), autobus: minuti((p.cekanje || {}).izlaz && p.cekanje.izlaz.autobus), kamion: minuti((p.cekanje || {}).izlaz && p.cekanje.izlaz.kamion) } },
    napomena: s(p.napomena, 300),
  })).filter((p) => p.drzava && p.naziv);
  if (!prelazi.length) throw new Error('Nema nijednog prelaza sa državom i nazivom.');
  return { azurirano: b.azurirano ? s(b.azurirano, 40) : new Date().toISOString(), izvor: s(b.izvor, 120), prelazi };
}

/* ---------- Kamere: poslednja merenja, 24 h, tipično za ovo doba, profil po satima, toplotna mapa ---------- */
const KAMERE = require('./kamere-lista');
const { proceni, tekstMin } = require('./procena');
const zvanicno = require('./zvanicno');
const DIR_SLIKE = path.join(__dirname, '..', 'data', 'kamere');
let kes = { t: 0, v: null };
function statistika(db) {
  if (kes.v && Date.now() - kes.t < 60000) return kes.v;
  const ima = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'kamere_merenja'").get();
  const sadLok = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Belgrade', hour: 'numeric', hour12: false, weekday: 'short' }).formatToParts(new Date());
  const satSad = Number(sadLok.find((x) => x.type === 'hour').value) % 24, danSad = (['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(sadLok.find((x) => x.type === 'weekday').value) + 6) % 7;
  const kamere = KAMERE.map((k) => {
    const o = { id: k.id, naziv: k.naziv, prelaz: k.prelaz, drzava: k.drzava, smer: k.smer, hr: !!k.hr, izvor: k.izvor, slika: fs.existsSync(path.join(DIR_SLIKE, k.id + '.jpg')) ? '/api/granice/kamera/' + k.id + '.jpg' : null, poslednje: null, danas: [], tipicno: null, indeks: null, nivo: null, trend: null, profil: null, toplotna: null, dana: 0, najbolje: [], najgore: [] };
    if (!ima) return o;
    const kolone = db.prepare("PRAGMA table_info('kamere_merenja')").all().map((c) => c.name); const imaDubinu = kolone.includes('dubina'), imaProtok = kolone.includes('protok');
    const p = db.prepare('SELECT vreme, auto, autobus, kamion, motor, ukupno, ok, greska' + (imaDubinu ? ', dubina' : ', NULL AS dubina') + ' FROM kamere_merenja WHERE kamera = ? ORDER BY id DESC LIMIT 1').get(k.id);
    if (!p) return o;
    o.poslednje = { vreme: p.vreme.replace(' ', 'T') + 'Z', ukupno: p.ukupno, auto: p.auto, autobus: p.autobus, kamion: p.kamion, motor: p.motor, ok: !!p.ok, greska: p.ok ? null : p.greska };
    if (o.slika) o.slika += '?v=' + encodeURIComponent(p.vreme);
    o.danas = db.prepare("SELECT vreme, ukupno FROM kamere_merenja WHERE kamera = ? AND ok = 1 AND vreme >= datetime('now', '-24 hours') ORDER BY vreme").all(k.id).map((r) => [r.vreme.replace(' ', 'T') + 'Z', r.ukupno]);
    o.dana = db.prepare("SELECT COUNT(DISTINCT date(vreme)) AS n FROM kamere_merenja WHERE kamera = ? AND ok = 1").get(k.id).n;
    const profil = db.prepare("SELECT lok_sat AS sat, AVG(ukupno) AS pros, COUNT(*) AS n FROM kamere_merenja WHERE kamera = ? AND ok = 1 AND vreme >= datetime('now', '-28 days') GROUP BY lok_sat").all(k.id);
    if (profil.length) { o.profil = Array.from({ length: 24 }, () => null); profil.forEach((r) => { o.profil[r.sat] = Math.round(r.pros * 10) / 10; }); }
    const tip = db.prepare("SELECT AVG(ukupno) AS pros, COUNT(*) AS n FROM kamere_merenja WHERE kamera = ? AND ok = 1 AND lok_sat = ? AND vreme >= datetime('now', '-28 days') AND vreme < datetime('now', '-2 hours')").get(k.id, satSad);
    if (tip && tip.n >= 6) {
      o.tipicno = { vrednost: Math.round(tip.pros * 10) / 10, uzorak: tip.n };
      if (p.ok) o.indeks = Math.round((p.ukupno / Math.max(tip.pros, 1)) * 100) / 100;
    }
    const p90 = db.prepare("SELECT ukupno FROM kamere_merenja WHERE kamera = ? AND ok = 1 AND vreme >= datetime('now', '-28 days') ORDER BY ukupno LIMIT 1 OFFSET (SELECT CAST(COUNT(*) * 0.9 AS INTEGER) FROM kamere_merenja WHERE kamera = ? AND ok = 1 AND vreme >= datetime('now', '-28 days'))").get(k.id, k.id);
    const nUz = db.prepare("SELECT COUNT(*) AS n FROM kamere_merenja WHERE kamera = ? AND ok = 1 AND vreme >= datetime('now', '-28 days')").get(k.id).n;
    const ref = nUz >= 48 && p90 && p90.ukupno >= 4 ? p90.ukupno : null;   // 90. percentil ima smisla tek posle ~4 sata merenja
    if (p.ok) { const u = p.ukupno; const r = ref ? u / ref : u / 20; o.nivo = r < 0.25 ? 'mirno' : r < 0.5 ? 'umereno' : r < 0.85 ? 'guzva' : 'velika'; }
    const trend = db.prepare("SELECT AVG(CASE WHEN vreme >= datetime('now', '-60 minutes') THEN ukupno END) AS sad, AVG(CASE WHEN vreme < datetime('now', '-60 minutes') THEN ukupno END) AS pre FROM kamere_merenja WHERE kamera = ? AND ok = 1 AND vreme >= datetime('now', '-120 minutes')").get(k.id);
    if (trend && trend.sad != null && trend.pre != null) o.trend = trend.sad > trend.pre * 1.25 + 1 ? 'raste' : trend.sad < trend.pre * 0.8 - 1 ? 'pada' : 'isto';
    /* Procena čekanja (server/procena.js) + „prošlo od početka merenja danas“ */
    if (k.procena) {
      const pr = proceni(db, k, null);
      if (pr) {
        o.procena = pr;
        /* koliko je vozila prošlo od jutros: izbrojani prelasci u prozorima gledanja, razvučeni na ceo period (kamera se gleda 10–30 % vremena) */
        const dn = db.prepare("SELECT SUM(proslo) AS p, SUM(prozor) AS s, COUNT(*) AS n, MIN(vreme) AS od FROM kamere_merenja WHERE kamera = ? AND ok = 1 AND protok IS NOT NULL AND prozor > 0 AND date(vreme, '+2 hours') = date('now', '+2 hours')").get(k.id);
        if (dn && dn.n >= 3 && dn.s > 0) { const od = new Date(dn.od.replace(' ', 'T') + 'Z'); o.procena.prosloDanas = { broj: Math.round((dn.p / dn.s) * ((Date.now() - od) / 1000 + 300)), izbrojano: dn.p, gledanoMin: Math.round(dn.s / 60), od: od.toLocaleTimeString('sr-Latn-RS', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Belgrade' }) }; }
        o.nivo = pr.minuta <= 10 ? 'mirno' : pr.minuta <= 20 ? 'umereno' : pr.minuta <= 30 ? 'guzva' : 'velika';   // nivo po čekanju (ista skala kao na strani), ne po broju vozila
        if (o.tipicno) { const t = o.tipicno.vrednost; o.procena.tipicnoMin = pr.protok != null && pr.protok >= 0.2 ? Math.ceil(t / pr.protok) : Math.ceil((t / k.procena.trake) * k.procena.minPoVozilu); }
      } else if (kolone.includes('cekanje')) {
        /* Nema svežeg merenja (kamera ne radi, radnik stao): nikad prazno – poslednja poznata procena do 12 h, inače tipično za ovaj sat */
        const za = (k.smer === 'ulaz' ? 'ulaz u Srbiju' : 'izlaz iz Srbije') + (k.hr ? ' (HR strana)' : '');
        const tekst = (m) => tekstMin(Math.round(m));
        const zad = db.prepare("SELECT vreme, cekanje, cekanje_plus FROM kamere_merenja WHERE kamera = ? AND ok = 1 AND cekanje IS NOT NULL AND vreme >= datetime('now', '-12 hours') ORDER BY id DESC LIMIT 1").get(k.id);
        if (zad) o.procena = { minuta: zad.cekanje, plus: !!zad.cekanje_plus, tekst: tekst(zad.cekanje, !!zad.cekanje_plus), za, izvorProcene: 'poslednja', od: zad.vreme.replace(' ', 'T') + 'Z' };
        else {
          const t = db.prepare("SELECT AVG(cekanje) AS c, COUNT(*) AS n FROM kamere_merenja WHERE kamera = ? AND ok = 1 AND cekanje IS NOT NULL AND lok_sat = ? AND vreme >= datetime('now', '-28 days')").get(k.id, satSad);
          if (t && t.n >= 3) { const m = Math.round(t.c); o.procena = { minuta: m, plus: false, tekst: tekst(m, false), za, izvorProcene: 'tipicno' }; }
        }
      }
    }
    if (o.dana >= 3) {
      const t = db.prepare("SELECT lok_dan AS dan, lok_sat AS sat, AVG(ukupno) AS pros FROM kamere_merenja WHERE kamera = ? AND ok = 1 AND vreme >= datetime('now', '-56 days') GROUP BY lok_dan, lok_sat").all(k.id);
      o.toplotna = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => null)); t.forEach((r) => { o.toplotna[r.dan][r.sat] = Math.round(r.pros * 10) / 10; });
      const sati = (o.profil || []).map((v, i) => [i, v]).filter(([, v]) => v != null).sort((a, b) => a[1] - b[1]);
      o.najbolje = sati.slice(0, 3).map(([i]) => i); o.najgore = sati.slice(-3).reverse().map(([i]) => i);
    }
    return o;
  });
  const azurirano = kamere.map((k) => k.poslednje && k.poslednje.vreme).filter(Boolean).sort().pop() || null;
  /* Procena po prelazu i smeru. Na svakoj strani granice (HAK = hrvatska kontrola, MUP = srpska) uzima se najveća procena
     među kamerama te strane (više kamera iste kolone), a strane se SABIRAJU: putnik čeka redom na obe kontrole
     (Batrovci ulaz = izlaz iz HR na Bajakovu + ulaz u Srbiju). Sabiraju se samo strane sa istom svežinom podatka –
     sveže merenje se ne sabira sa „poslednjim poznatim“ ili „tipičnim za sat“ druge strane. */
  const poStrani = {};
  const rang = (x) => (x.izvorProcene === 'tipicno' ? 2 : x.izvorProcene ? 1 : 0);   // sveže merenje uvek ima prednost nad starim i tipičnim
  for (const k of kamere) {
    if (!k.procena) continue;
    const kljuc = k.prelaz + '|' + k.smer + '|' + (k.hr ? 'hr' : 'rs');
    const st = poStrani[kljuc], r = rang(k.procena);
    if (!st || r < st.rang || (r === st.rang && k.procena.minuta > st.minuta)) poStrani[kljuc] = { prelaz: k.prelaz, smer: k.smer, strana: k.hr ? 'hr' : 'rs', minuta: k.procena.minuta, plus: k.procena.plus, kamera: k.id, vreme: k.procena.od || (k.poslednje && k.poslednje.vreme), izvorProcene: k.procena.izvorProcene || null, rang: r };
  }
  const zv = zvanicno.poslednje(3);   // zvanično (MUP RH za hrvatsku kontrolu, mađarska policija), auta, ne starije od 3 h
  const poPrelazu = {};
  /* mađarska strana: police.hu daje čekanje SAMO na mađarskoj kontroli (posle izlaska iz Srbije / pre ulaska), a kamere za nju
     nemamo → sveže zvanično (≤ 30 min od preuzimanja) ulazi u zbir kao treća strana. „Nema čekanja dužeg od 15 min“ = 0.
     (Zajednička kontrola na mađarskoj strani je samo na starom putu Röszke–Horgoš i manjim prelazima, ne na auto-putu.) */
  for (const [kl, lista] of Object.entries(zv)) for (const z of lista) {
    if (z.izvor !== 'Policija HU' || Date.now() - Date.parse(z.vreme) > 30 * 60000 || z.minuta == null) continue;
    const [prelaz, smer] = kl.split('|');
    if (!KAMERE.some((k) => k.prelaz === prelaz)) continue;
    poStrani[kl + '|hu'] = { prelaz, smer, strana: 'hu', minuta: /^do\s/.test(z.tekst) ? 0 : z.minuta, plus: false, kamera: null, vreme: z.vreme, izvorProcene: null, rang: 0 };
  }
  for (const d of Object.values(poStrani)) { const kl = d.prelaz + '|' + d.smer; (poPrelazu[kl] = poPrelazu[kl] || []).push(d); }
  const zbir = Object.values(poPrelazu).map((delovi) => {
    const r = Math.min(...delovi.map((d) => d.rang)), isti = delovi.filter((d) => d.rang === r).sort((a, b) => b.minuta - a.minuta);
    const glavni = isti[0], min = isti.reduce((a, d) => a + d.minuta, 0), kam = isti.find((d) => d.kamera) || glavni;
    return { prelaz: glavni.prelaz, smer: glavni.smer, minuta: min >= 60 ? Math.round(min / 5) * 5 : min, plus: isti.some((d) => d.plus), kamera: kam.kamera, vreme: glavni.vreme, izvorProcene: glavni.izvorProcene, rang: r,
      delovi: isti.length > 1 || isti.some((d) => d.strana === 'hu') ? isti.map((d) => ({ strana: d.strana, minuta: d.minuta, kamera: d.kamera })) : null, zvanicno: zv[glavni.prelaz + '|' + glavni.smer] || null };
  });
  kes = { t: Date.now(), v: { azurirano, interval: Number(process.env.KAMERE_INTERVAL_MIN) || 5, satSad, danSad, kamere, poPrelazu: zbir } };
  return kes.v;
}


/* ---------- Statistika gužvi po prelazu: po satu, dobu dana, danu u nedelji, mesecu, danima, toplotna mapa, rekordi ---------- */
let kesStat = {};
function statistikaPrelaza(db, prelaz) {
  const k0 = kesStat[prelaz]; if (k0 && Date.now() - k0.t < 300000) return k0.v;
  const kamere = KAMERE.filter((k) => k.prelaz === prelaz); if (!kamere.length) return null;
  const kol = db.prepare("PRAGMA table_info('kamere_merenja')").all().map((c) => c.name);
  const cek = kol.includes('cekanje') ? 'cekanje' : 'NULL';
  const grupe = { ulaz: kamere.filter((k) => k.smer === 'ulaz'), izlaz: kamere.filter((k) => k.smer === 'izlaz') };
  const smerovi = {};
  for (const [smer, lista] of Object.entries(grupe)) {
    if (!lista.length) continue;
    const ids = lista.map((k) => k.id); const ph = ids.map(() => '?').join(',');
    /* po krugu merenja (5 min): na svakoj strani granice najveće čekanje među kamerama (kolona je jedna), strane se sabiraju (čeka se redom) */
    const hr = lista.filter((k) => k.hr).map((k) => "'" + k.id + "'").join(',') || "''";
    const strane = `SELECT CAST(strftime('%s', vreme) / 300 AS INTEGER) AS slot, CASE WHEN kamera IN (${hr}) THEN 'hr' ELSE 'rs' END AS strana, MIN(vreme) AS vreme, MIN(lok_sat) AS lok_sat, MIN(lok_dan) AS lok_dan, MAX(${cek}) AS c, MAX(ukupno) AS u FROM kamere_merenja WHERE kamera IN (${ph}) AND ok = 1 GROUP BY slot, strana`;
    const osnova = `SELECT MIN(lok_sat) AS lok_sat, MIN(lok_dan) AS lok_dan, MIN(vreme) AS vreme, date(MIN(vreme), '+1 hour') AS dan_lok, strftime('%m', MIN(vreme), '+1 hour') AS mesec, SUM(c) AS c, SUM(u) AS u FROM (${strane}) GROUP BY slot`;
    const pokr = db.prepare(`SELECT COUNT(*) AS n, MIN(vreme) AS od, COUNT(DISTINCT dan_lok) AS dana FROM (${osnova})`).get(...ids);
    const poSatu = db.prepare(`SELECT lok_sat AS sat, AVG(c) AS cek, AVG(u) AS voz, MAX(c) AS maks, COUNT(*) AS n FROM (${osnova}) GROUP BY lok_sat`).all(...ids);
    const poDanu = db.prepare(`SELECT lok_dan AS dan, AVG(c) AS cek, AVG(u) AS voz, MAX(c) AS maks, COUNT(*) AS n FROM (${osnova}) GROUP BY lok_dan`).all(...ids);
    const poMesecu = db.prepare(`SELECT CAST(mesec AS INTEGER) AS mesec, AVG(c) AS cek, AVG(u) AS voz, MAX(c) AS maks, COUNT(*) AS n FROM (${osnova}) GROUP BY mesec`).all(...ids);
    const poDatumu = db.prepare(`SELECT dan_lok AS datum, AVG(c) AS cek, MAX(c) AS maks, AVG(u) AS voz, COUNT(*) AS n FROM (${osnova}) WHERE vreme >= datetime('now', '-30 days') GROUP BY dan_lok ORDER BY dan_lok`).all(...ids);
    const toplotna = db.prepare(`SELECT lok_dan AS dan, lok_sat AS sat, AVG(c) AS cek, COUNT(*) AS n FROM (${osnova}) WHERE vreme >= datetime('now', '-56 days') GROUP BY lok_dan, lok_sat`).all(...ids);
    const rekord = db.prepare(`SELECT vreme, c, u FROM (${osnova}) WHERE c IS NOT NULL ORDER BY c DESC, u DESC LIMIT 1`).get(...ids);
    const rekordVoz = db.prepare(`SELECT vreme, c, u FROM (${osnova}) ORDER BY u DESC LIMIT 1`).get(...ids);
    const deo = (od, doS) => { const r = poSatu.filter((x) => (od < doS ? x.sat >= od && x.sat < doS : x.sat >= od || x.sat < doS)); const n = r.reduce((a, x) => a + x.n, 0); return n ? { cek: r.reduce((a, x) => a + x.cek * x.n, 0) / n, voz: r.reduce((a, x) => a + x.voz * x.n, 0) / n, n } : null; };
    const z = (v) => (v == null ? null : Math.round(v * 10) / 10);
    const niz = (arr, kljuc, duz, pomak) => { const o = Array.from({ length: duz }, () => null); arr.forEach((r) => { o[(r[kljuc] - (pomak || 0) + duz) % duz] = { cek: z(r.cek), voz: z(r.voz), maks: z(r.maks), n: r.n }; }); return o; };
    smerovi[smer] = {
      kamere: ids, pokrivenost: { merenja: pokr.n, od: pokr.od ? pokr.od.replace(' ', 'T') + 'Z' : null, dana: pokr.dana },
      poSatu: niz(poSatu, 'sat', 24), poDanu: niz(poDanu, 'dan', 7), poMesecu: niz(poMesecu, 'mesec', 12, 1),
      dobaDana: { noc: deo(22, 6), jutro: deo(6, 10), dan: deo(10, 16), popodne: deo(16, 22) },
      poDatumu: poDatumu.map((r) => ({ datum: r.datum, cek: z(r.cek), maks: z(r.maks), voz: z(r.voz), n: r.n })),
      toplotna: (() => { const t = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => null)); toplotna.forEach((r) => { t[r.dan][r.sat] = z(r.cek); }); return t; })(),
      rekord: rekord ? { vreme: rekord.vreme.replace(' ', 'T') + 'Z', cek: z(rekord.c), voz: rekord.u } : null,
      rekordVozila: rekordVoz ? { vreme: rekordVoz.vreme.replace(' ', 'T') + 'Z', voz: rekordVoz.u, cek: z(rekordVoz.c) } : null,
    };
  }
  const v = { prelaz, drzava: kamere[0].drzava, smerovi };
  kesStat[prelaz] = { t: Date.now(), v }; return v;
}

module.exports = function (app, { db, zahtevaPrijavu, jeAdmin }) {
  app.get('/api/granice/statistika', (req, res) => { const p = String(req.query.prelaz || ''); const v = statistikaPrelaza(db, p); if (!v) return res.status(404).json({ greska: 'Nepoznat prelaz.' }); res.setHeader('Cache-Control', 'public, max-age=300'); res.json(v); });
  app.get('/api/granice/statistika/prelazi', (req, res) => res.json([...new Set(KAMERE.map((k) => k.prelaz))].map((p) => ({ prelaz: p, drzava: KAMERE.find((k) => k.prelaz === p).drzava, smerovi: [...new Set(KAMERE.filter((k) => k.prelaz === p).map((k) => k.smer))] }))));
  app.get('/api/granice/kamere', (req, res) => { res.setHeader('Cache-Control', 'public, max-age=60'); res.json(statistika(db)); });
  app.get('/api/granice/kamera/:id.jpg', (req, res) => {
    const k = KAMERE.find((x) => x.id === req.params.id); const f = k && path.join(DIR_SLIKE, k.id + '.jpg');
    if (!f || !fs.existsSync(f)) return res.status(404).end();
    res.setHeader('Cache-Control', 'public, max-age=60'); res.setHeader('Content-Type', 'image/jpeg'); fs.createReadStream(f).pipe(res);
  });
  app.get('/api/granice', (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=60');
    const j = ucitaj(); let st = null;
    try { st = statistika(db); } catch (e) { st = null; }
    if (st) {
      j.procena = st.poPrelazu; j.procenaAzurirano = st.azurirano;
      for (const p of j.prelazi) for (const s of ['ulaz', 'izlaz']) {
        const pr = st.poPrelazu.find((x) => x.prelaz === p.naziv && x.smer === s);
        if (!pr) continue;
        p.cekanje = p.cekanje || {}; p.cekanje[s] = p.cekanje[s] || {};
        if (p.cekanje[s].auto == null) { p.cekanje[s].auto = pr.minuta; p.cekanje[s].autoProcena = true; p.cekanje[s].autoPlus = pr.plus; p.cekanje[s].autoIzvor = pr.izvorProcene; p.cekanje[s].autoVreme = pr.vreme; }
      }
    }
    res.json(j);
  });
  app.put('/api/admin/granice', zahtevaPrijavu, jeAdmin, (req, res) => {
    try { const j = ocisti(req.body || {}); fs.mkdirSync(path.dirname(FAJL), { recursive: true }); fs.writeFileSync(FAJL, JSON.stringify(j, null, 1)); res.json({ ok: true, prelaza: j.prelazi.length, azurirano: j.azurirano }); }
    catch (e) { res.status(400).json({ greska: e.message }); }
  });
  app.get('/api/admin/granice/osnova', zahtevaPrijavu, jeAdmin, (req, res) => res.json(OSNOVA()));   // prazan šablon za popunjavanje
  require('./planer')(app, { db, statistika, KAMERE });   // „Kuda putujete?“ – preporuka prelaza

  /* ---------- Admin → Kamere: crtanje zone kolone, linije šaltera, repa kolone i zum isečaka po kameri ---------- */
  const broj = (x) => { const v = Number(x); if (!Number.isFinite(v)) throw new Error('Neispravna koordinata.'); return Math.round(Math.max(0, Math.min(1, v)) * 1000) / 1000; };
  function proveriZone(b) {
    const out = {};
    if (b.roi === null) out.roi = null;
    else if (b.roi !== undefined) {
      if (!Array.isArray(b.roi) || b.roi.length < 3 || b.roi.length > 40) throw new Error('Zona mora imati od 3 do 40 tačaka.');
      out.roi = b.roi.map((t) => [broj(t[0]), broj(t[1])]);
    }
    if (b.zum === null) out.zum = null;
    else if (b.zum !== undefined) {
      if (!Array.isArray(b.zum) || b.zum.length > 4) throw new Error('Najviše 4 zum isečka.');
      out.zum = b.zum.map((z) => { const [x1, y1, x2, y2] = z.map(broj); if (x2 - x1 < 0.04 || y2 - y1 < 0.04) throw new Error('Zum isečak je premali.'); return [x1, y1, x2, y2]; });
      if (!out.zum.length) out.zum = null;
    }
    if (b.puno === null) out.puno = null;
    else if (b.puno !== undefined) { if (!['gore', 'dole'].includes(b.puno.kraj)) throw new Error('Rep kolone: kraj mora biti gore ili dole.'); out.puno = { kraj: b.puno.kraj, y: broj(b.puno.y) }; }
    if (b.linija === null) out.linija = null;
    else if (b.linija !== undefined) {
      const l = b.linija; if (!['gore', 'dole'].includes(l.smer)) throw new Error('Linija: nepoznat smer.');
      out.linija = { x1: broj(l.x1), y1: broj(l.y1), x2: broj(l.x2), y2: broj(l.y2), smer: l.smer };
      if (Math.hypot(out.linija.x2 - out.linija.x1, out.linija.y2 - out.linija.y1) < 0.05) throw new Error('Linija je prekratka.');
    }
    return out;
  }
  const citajPod = () => { try { return JSON.parse(fs.readFileSync(KAMERE.PODESAVANJA, 'utf8')); } catch (e) { return {}; } };
  const pisiPod = (j) => { const tmp = KAMERE.PODESAVANJA + '.tmp'; fs.mkdirSync(path.dirname(tmp), { recursive: true }); fs.writeFileSync(tmp, JSON.stringify(j, null, 1)); fs.renameSync(tmp, KAMERE.PODESAVANJA); KAMERE.osvezi(); kes = { t: 0, v: null }; };
  const adminKamera = (k) => {
    const sirov = path.join(DIR_SLIKE, k.id + '.sirov.jpg'); let sirovKad = null; try { sirovKad = fs.statSync(sirov).mtime.toISOString(); } catch (e) { /* još nema */ }
    return { id: k.id, naziv: k.naziv, prelaz: k.prelaz, smer: k.smer, izvor: k.izvor, roi: k.roi, zum: k.zum, puno: k.puno, linija: k.linija, osnovno: k.osnovno, izmena: k.izmena, sirovKad };
  };
  /* „mi vs. zvanično“: uz svaki zvanični podatak MUP RH za auta naša procena sa HAK kamera (ista, hrvatska kontrola) u istom
     trenutku (najveće čekanje izmereno ±5 min). Mađarska policija meri samo mađarsku kontrolu koju ne vidimo – ona ulazi u zbir
     na stanju, ne u poređenje. Zvanično su grube kategorije – `minuta` je gornja granica. */
  app.get('/api/admin/kalibracija', zahtevaPrijavu, jeAdmin, (req, res) => {
    let redovi = [];
    try { redovi = db.prepare("SELECT izvor, prelaz, smer, tekst, minuta, kolona_km, objavljeno FROM zvanicno_merenja WHERE izvor = 'MUP RH' AND vozilo = 'auto' AND objavljeno >= datetime('now', '-14 days') ORDER BY objavljeno DESC").all(); } catch (e) { /* nema tabele */ }
    const nas = db.prepare("SELECT MAX(cekanje) AS c, MAX(ukupno) AS u FROM kamere_merenja WHERE kamera IN (SELECT value FROM json_each(?)) AND ok = 1 AND cekanje IS NOT NULL AND vreme BETWEEN datetime(?, '-5 minutes') AND datetime(?, '+5 minutes')");
    const lista = redovi.map((r) => {
      const ids = KAMERE.filter((k) => (r.izvor === 'MUP RH' ? k.hr : true) && k.prelaz === r.prelaz && k.smer === r.smer).map((k) => k.id);
      const m = ids.length ? nas.get(JSON.stringify(ids), r.objavljeno, r.objavljeno) : null;
      return { izvor: r.izvor, prelaz: r.prelaz, smer: r.smer, zvanicno: r.tekst, zvanicnoMin: r.minuta, kolonaKm: r.kolona_km, vreme: r.objavljeno.replace(' ', 'T') + 'Z', mi: m && m.c != null ? Math.round(m.c) : null, vozila: m ? m.u : null };
    });
    const sazetak = {};
    for (const x of lista) {
      if (x.mi == null || x.zvanicnoMin == null) continue;
      const kl = x.izvor + '|' + x.prelaz + '|' + x.smer;
      const s = sazetak[kl] = sazetak[kl] || { izvor: x.izvor, prelaz: x.prelaz, smer: x.smer, n: 0, iznad: 0, odnosi: [] };
      s.n++; if (x.mi > x.zvanicnoMin) s.iznad++; if (x.zvanicnoMin > 0) s.odnosi.push(x.mi / x.zvanicnoMin);
    }
    res.json({ lista, sazetak: Object.values(sazetak).map((s) => { const o = s.odnosi.sort((a, b) => a - b); return { izvor: s.izvor, prelaz: s.prelaz, smer: s.smer, n: s.n, iznad: s.iznad, medijanaOdnosa: o.length ? Math.round(o[Math.floor(o.length / 2)] * 100) / 100 : null }; }) });
  });
  app.get('/api/admin/kamere', zahtevaPrijavu, jeAdmin, (req, res) => { KAMERE.osvezi(); res.json(KAMERE.map(adminKamera)); });
  /* provera brojanja: zahtev za radnika (data/provera/<id>.zahtev) i poslednja montaža (data/kamere/<id>.provera.jpg + .json) */
  const DIR_PROVERA = path.join(__dirname, '..', 'data', 'provera');
  const stanjeProvere = (k) => { let info = null; try { info = JSON.parse(fs.readFileSync(path.join(DIR_SLIKE, k.id + '.provera.json'), 'utf8')); } catch (e) { /* još nema */ } return { zahtevano: fs.existsSync(path.join(DIR_PROVERA, k.id + '.zahtev')), info }; };
  app.get('/api/admin/kamere/:id/provera', zahtevaPrijavu, jeAdmin, (req, res) => { const k = KAMERE.find((x) => x.id === req.params.id); if (!k) return res.status(404).json({ greska: 'Nema te kamere.' }); res.json(stanjeProvere(k)); });
  app.post('/api/admin/kamere/:id/provera', zahtevaPrijavu, jeAdmin, (req, res) => {
    const k = KAMERE.find((x) => x.id === req.params.id); if (!k) return res.status(404).json({ greska: 'Nema te kamere.' });
    fs.mkdirSync(DIR_PROVERA, { recursive: true }); fs.writeFileSync(path.join(DIR_PROVERA, k.id + '.zahtev'), new Date().toISOString());
    res.json(stanjeProvere(k));
  });
  app.get('/api/admin/kamere/:id/provera.jpg', zahtevaPrijavu, jeAdmin, (req, res) => {
    const k = KAMERE.find((x) => x.id === req.params.id); const f = k && path.join(DIR_SLIKE, k.id + '.provera.jpg');
    if (!f || !fs.existsSync(f)) return res.status(404).json({ greska: 'Još nema provere.' });
    res.setHeader('Cache-Control', 'no-store'); res.sendFile(f);
  });
  /* sirov kadar (bez naših oznaka) za crtanje; ?novi=1 odmah uzima svež kadar sa kamere */
  app.get('/api/admin/kamere/:id/kadar.jpg', zahtevaPrijavu, jeAdmin, async (req, res) => {
    const k = KAMERE.find((x) => x.id === req.params.id); if (!k) return res.status(404).json({ greska: 'Nema te kamere.' });
    const f = path.join(DIR_SLIKE, k.id + '.sirov.jpg');
    if (req.query.novi === '1' || !fs.existsSync(f)) {
      try {
        let buf;
        if (k.tip === 'hls') buf = await new Promise((ok, ne) => require('node:child_process').execFile('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-rw_timeout', '15000000', '-i', k.url, '-frames:v', '1', '-q:v', '3', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-'], { encoding: 'buffer', timeout: 40000, killSignal: 'SIGKILL', maxBuffer: 20e6 }, (e, so, se) => (so && so.length ? ok(so) : ne(new Error('Kamera ne daje sliku: ' + String(se || (e && e.message) || '').trim().slice(0, 160))))));
        else { const r = await fetch(k.url + '?v=' + Date.now(), { signal: AbortSignal.timeout(20000), headers: { 'User-Agent': 'Mozilla/5.0 granice.sparkcan.com-kamere' } }); if (!r.ok) throw new Error('Kamera ne daje sliku: HTTP ' + r.status); buf = Buffer.from(await r.arrayBuffer()); }
        fs.mkdirSync(DIR_SLIKE, { recursive: true }); fs.writeFileSync(f + '.tmp', buf); fs.renameSync(f + '.tmp', f);
      } catch (e) { if (!fs.existsSync(f)) return res.status(502).json({ greska: e.message }); }
    }
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Type', 'image/jpeg'); fs.createReadStream(f).pipe(res);
  });
  app.put('/api/admin/kamere/:id', zahtevaPrijavu, jeAdmin, (req, res) => {
    const k = KAMERE.find((x) => x.id === req.params.id); if (!k) return res.status(404).json({ greska: 'Nema te kamere.' });
    try {
      const z = proveriZone(req.body || {}); const j = citajPod();
      j[k.id] = Object.assign({}, j[k.id] || {}, z, { kad: new Date().toISOString(), ko: req.korisnik && req.korisnik.email });
      pisiPod(j); res.json(adminKamera(k));
    } catch (e) { res.status(400).json({ greska: e.message }); }
  });
  app.delete('/api/admin/kamere/:id', zahtevaPrijavu, jeAdmin, (req, res) => {
    const k = KAMERE.find((x) => x.id === req.params.id); if (!k) return res.status(404).json({ greska: 'Nema te kamere.' });
    const j = citajPod(); delete j[k.id]; pisiPod(j); res.json(adminKamera(k));
  });
};
