/* zvanicno.js — zvanično čekanje susednih policija, za prikaz uz našu procenu i za poređenje („mi vs. zvanično“ u adminu).
   Radnik (kamere.js) čita izvore na svakih 15 min i upisuje u zvanicno_merenja.
   - MUP RH preko HAK (hak.hr/info/stanje-na-cestama/, tabela „Čekanje na graničnim prijelazima“, Srbija – Hrvatska): kolone
     iz ugla Hrvatske Ulaz (auta, kamioni), Izlaz (auta, kamioni); ulaz u HR = izlaz iz Srbije. Svaka vrednost ima vreme objave.
     Meri samo hrvatsku kontrolu (srpska je posebno).
   - Mađarska policija (police.hu → Határinfó, Szerb határszakasz): „felől (ki)“ = izlaz iz HU = ulaz u Srbiju, „felé (be)“ =
     izlaz iz Srbije; `szgk` = auta. Bez vremena objave (upisuje se vreme preuzimanja). Na Röszke–Horgošu je kontrola zajednička,
     pa je to celo čekanje. „Nincs 15 percet meghaladó várakozás“ = do 15 min.
   Vrednosti su grube kategorije („do 30 min.“, „1 h“, „30 perc“) – `minuta` je gornja granica kategorije. */
const db = require('./db');

const URL = 'https://www.hak.hr/info/stanje-na-cestama/';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36 granice.sparkcan.com';
const PRELAZ = { Bajakovo: 'Batrovci', Tovarnik: 'Šid', Ilok: 'Bačka Palanka', Batina: 'Bezdan' };   // HR naziv → naš prelaz
const URL_HU = 'https://www.police.hu/hu/hirek-es-informaciok/hatarinfo?field_hat_rszakasz_value=szerb%20hat%C3%A1rszakasz';
const PRELAZ_HU = [[/^Röszke\s*-\s*Horgo[sš]\s+autópálya/i, 'Horgoš'], [/^Tompa\s*-\s*Kelebi/i, 'Kelebija'], [/^Tiszasziget\s*-\s*Đala/i, 'Đala']];

db.exec(`CREATE TABLE IF NOT EXISTS zvanicno_merenja (
  id INTEGER PRIMARY KEY AUTOINCREMENT, izvor TEXT NOT NULL, prelaz TEXT NOT NULL, smer TEXT NOT NULL, vozilo TEXT NOT NULL,
  tekst TEXT NOT NULL, minuta INTEGER, kolona_km REAL, objavljeno TEXT NOT NULL, preuzeto TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE UNIQUE INDEX IF NOT EXISTS zvanicno_jedinstveno ON zvanicno_merenja(izvor, prelaz, smer, vozilo, objavljeno);`);

const bezTagova = (s) => s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
/* „do 30 min.“ → 30, „1 h“ → 60, „1 h 30 min“ → 90, „bez zadržavanja“ → 0, „-“ → null; mađarski: „30 perc“, „1 óra“,
   „Nincs 15 percet meghaladó várakozás“ (nema čekanja dužeg od 15 min) → 15 */
function minuta(t) {
  if (!t || t === '-') return null;
  if (/bez\s+(čekanja|zadržavanja)/i.test(t)) return 0;
  if (/nincs\s+(\d+)\s*perc/i.test(t)) return Number(/nincs\s+(\d+)/i.exec(t)[1]);
  const h = /(\d+(?:[.,]\d+)?)\s*(?:h\b|óra)/i.exec(t), m = /(\d+)\s*(?:min|perc)/i.exec(t);
  if (!h && !m) return null;
  return Math.round((h ? parseFloat(h[1].replace(',', '.')) * 60 : 0) + (m ? Number(m[1]) : 0));
}
/* „T: 25.09.2026 12:04:37“ ili „T: 25.9.2026. 9:54:31“ (zavisi od jezika zahteva; lokalno vreme HR = Beograd) → UTC 'YYYY-MM-DD HH:MM:SS' */
function utcIzLokalnog(t) {
  const x = /(\d{1,2})\.(\d{1,2})\.(\d{4})\.?\s+(\d{1,2}):(\d{2}):(\d{2})/.exec(t); if (!x) return null;
  const kao = Date.UTC(+x[3], +x[2] - 1, +x[1], +x[4], +x[5], +x[6]);
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Belgrade', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(kao));
  const g = (k) => Number(p.find((q) => q.type === k).value);
  const pomak = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - kao;   // +1 h / +2 h
  return new Date(kao - pomak).toISOString().slice(0, 19).replace('T', ' ');
}

function parsiraj(html) {
  const i = html.indexOf('class="gpsrbija"'); if (i < 0) return [];
  const deo = html.slice(i, html.indexOf('</table>', i));
  const out = [];
  for (const red of deo.split('<tr>').slice(1)) {
    const ime = /class="gpime"><strong>([^<]+)<\/strong>/.exec(red); if (!ime) continue;
    const prelaz = PRELAZ[ime[1].trim()]; if (!prelaz) continue;
    const celije = [...red.matchAll(/<td class="gpUnos"[^>]*>([\s\S]*?)<span class="gpDatmToolTip">([\s\S]*?)<\/span>/g)];
    // redosled: ulaz u HR (auto, kamion), izlaz iz HR (auto, kamion)
    celije.forEach((c, j) => {
      const tekst = bezTagova(c[1]), info = bezTagova(c[2]); const kad = utcIzLokalnog(info);
      if (!kad || tekst === '-') return;
      const km = /L:\s*(\d+(?:[.,]\d+)?)\s*km/i.exec(info);
      out.push({ prelaz, smer: j < 2 ? 'izlaz' : 'ulaz', vozilo: j % 2 ? 'kamion' : 'auto', tekst: tekst.replace(/\.$/, ''), minuta: minuta(tekst), kolona_km: km ? parseFloat(km[1].replace(',', '.')) : null, objavljeno: kad });
    });
  }
  return out;
}

/* police.hu: panel po prelazu; naslov u <span>, pa „felől (ki)“ i „felé (be)“ – vrednost je tekst ili <div class="szgk"> za auta */
function parsirajHu(html) {
  const out = [];
  for (const panel of html.split('class="panel panel-primary"').slice(1)) {
    const naslov = /<h5 class="panel-title">[\s\S]*?<span>(?:<i[^>]*><\/i>)?([\s\S]*?)<\/span>/.exec(panel); if (!naslov) continue;
    const ime = bezTagova(naslov[1]).replace(/-$/, '').trim();
    const pr = PRELAZ_HU.find(([re]) => re.test(ime)); if (!pr) continue;
    for (const [oznaka, smer] of [['felől (ki)', 'ulaz'], ['felé (be)', 'izlaz']]) {
      const i = panel.indexOf(oznaka); if (i < 0) continue;
      const kraj = panel.indexOf('<hr', i), posle = panel.slice(i, kraj > i ? kraj : i + 800);   // samo ovo polje (do <hr>)
      const zapis = (vozilo, vr) => { const min = minuta(vr); if (min != null) out.push({ prelaz: pr[1], smer, vozilo, tekst: /nincs/i.test(vr) ? 'do ' + min + ' min' : vr.replace(/perc/i, 'min').replace(/óra/i, 'h'), minuta: min, kolona_km: null }); };
      const szgk = /<div class="szgk">([\s\S]*?)<\/div>/.exec(posle);
      if (szgk) {   // po vrsti vozila; prazno polje za auta (a kamioni imaju vreme) = za auta nema čekanja vrednog pomena
        zapis('auto', bezTagova(szgk[1]) || 'Nincs 15 percet meghaladó várakozás');
        const tgk = /<div class="tgk">([\s\S]*?)<\/div>/.exec(posle); if (tgk && bezTagova(tgk[1])) zapis('kamion', bezTagova(tgk[1]));
      } else { const vr = bezTagova((/<\/div>\s*<div>([\s\S]*?)<\/div>\s*$/.exec(posle) || [])[1] || ''); if (vr) zapis('auto', vr); }
    }
  }
  return out;
}

const upis = db.prepare('INSERT OR IGNORE INTO zvanicno_merenja (izvor, prelaz, smer, vozilo, tekst, minuta, kolona_km, objavljeno) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
const preuzmi = async (url) => { const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) }); if (!r.ok) throw new Error(new URL(url).host + ' HTTP ' + r.status); return r.text(); };
/* oba izvora nezavisno – ispad jednog ne sprečava drugi */
async function osvezi() {
  const rez = {};
  try {
    const redovi = parsiraj(await preuzmi(URL));
    let novih = 0; for (const x of redovi) novih += upis.run('MUP RH', x.prelaz, x.smer, x.vozilo, x.tekst, x.minuta, x.kolona_km, x.objavljeno).changes;
    rez.hr = { redova: redovi.length, novih };
  } catch (e) { rez.hr = { greska: e.message }; }
  try {
    const redovi = parsirajHu(await preuzmi(URL_HU)), sad = new Date().toISOString().slice(0, 19).replace('T', ' ');
    let novih = 0; for (const x of redovi) novih += upis.run('Policija HU', x.prelaz, x.smer, x.vozilo, x.tekst, x.minuta, x.kolona_km, sad).changes;
    rez.hu = { redova: redovi.length, novih };
  } catch (e) { rez.hu = { greska: e.message }; }
  return rez;
}

const OPIS = { 'MUP RH': 'MUP RH, hrvatska kontrola', 'Policija HU': 'mađarska policija' };
/* poslednji zvanični podatak za auta po prelazu|smeru (lista po izvoru), ne stariji od `satiMax` */
function poslednje(satiMax = 3) {
  const v = {};
  try {
    for (const r of db.prepare(`SELECT izvor, prelaz, smer, tekst, minuta, kolona_km, objavljeno FROM zvanicno_merenja z WHERE vozilo = 'auto' AND objavljeno >= datetime('now', ?) AND id = (SELECT MAX(id) FROM zvanicno_merenja WHERE izvor = z.izvor AND prelaz = z.prelaz AND smer = z.smer AND vozilo = 'auto')`).all(`-${satiMax} hours`)) {
      (v[r.prelaz + '|' + r.smer] = v[r.prelaz + '|' + r.smer] || []).push({ izvor: r.izvor, opis: OPIS[r.izvor] || r.izvor, tekst: r.tekst, minuta: r.minuta, kolonaKm: r.kolona_km, vreme: r.objavljeno.replace(' ', 'T') + 'Z' });
    }
  } catch (e) { /* tabela još ne postoji */ }
  return v;
}

module.exports = { osvezi, parsiraj, parsirajHu, poslednje, minuta };
