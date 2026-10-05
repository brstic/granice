/* procena.js — procena čekanja za jednu kameru iz merenja u bazi, „na trenutak“ `kad` (UTC 'YYYY-MM-DD HH:MM:SS') ili sada.
   Isti kod koristi API (uživo) i radnik (upisuje cekanje uz svako merenje, za statistiku).

   Kolona N  = medijana broja vozila u zoni iz poslednja 3 merenja (15 min). Ako kolona dopire do dalekog kraja kadra
               (četvrto najdalje vozilo iznad puno.y u bar 2 od 3 merenja), deo kolone je van kadra: N × faktor, gde faktor raste
               sa tim koliko dugo kolona bez prekida dopire do kraja kadra (1,5× odmah, +0,25 na svaki sat, najviše 2×).
               Linija repa mora biti na strani repa (rep gore → y ≤ 0,6, rep dole → y ≥ 0,4) – inače se ne koristi (25.09.:
               rep „dole“ nacrtan pri vrhu kadra je značio „kolona izlazi iz kadra“ čim ima 4 vozila → Preševo 7 auta = 21 vozilo).
   Parkirano = vozila koja se 30+ min uopšte ne pomeraju (niko ne prođe liniju, `pomereno` ≈ 0, broj isti ±1) a ima ih
               malo (< 15): to nije kolona nego parking/prikolice sa automobilima (Batina 1: auto-transporteri) → N = 0.
   Protok r  = brzina prolaska kroz šalter (vozila/min) iz izbrojanih prelazaka linije (server/kamere.js → proslo/prozor),
               samo iz prozora u kojima je bilo kolone (≥ 2 vozila – bez kolone prelasci mere dolaske, ne kapacitet šaltera):
               r = (Σ w·proslo + r0·T0) / (Σ w·prozor + T0), w = e^(−starost/45 min) preko poslednja 3 h, T0 = 3 min pseudo-posmatranja.
               r0 = ono što je ista kamera izmerila tokom poslednjih 7 dana kad je bilo kolone (≥ 20 min posmatranja),
               inače trake / minPoVozilu iz konfiguracije. I prior i rezultat su u granicama [rMin, trake/0.5] vozila/min, gde je
               rMin = trake / (2 · minPoVozilu): šalter koji radi ne propušta sporije od polovine konfigurisanog kapaciteta.
               Bez tog poda je brojač koji ne vidi prolaske (loš smer linije, retki HAK kadrovi, zaklonjena linija) davao
               protok 0,05/min → 3 auta = 60 min, 10 auta = 200 min („velika gužva“ sa par auta).
               Prozor u kome se kolona pomerala (`pomereno` ≥ 0,3) a nije izbrojan nijedan prolazak ne ulazi u protok (promašaj brojača).
               Kamere se gledaju 30–90 s na svakih 5 min, pa je posmatranje 10–30 % vremena: prior se zato brzo povlači pred
               podacima (posle ~10 min gledanja skoro ne utiče), a težina po starosti daje prednost onome što se dešava sad.
   Kretanje  = da li se kolona pomera: iz poslednja 2 merenja (proslo, udeo pomerenih vozila `pomereno`); ako stoji, od kada.
   Čekanje   = N / r, zaokruženo; preko 60 min na 5, najviše 6 h. Prikazuje se kao konkretan broj (≈ 1 h 20 min), bez „+“. */
let kolone = null;
/* „≈ 45 min“, „≈ 1 h 20 min“ */
const tekstMin = (m) => { if (m === 0) return 'bez čekanja'; if (m < 60) return '≈ ' + m + ' min'; const h = Math.floor(m / 60), r = m % 60; return '≈ ' + h + ' h' + (r ? ' ' + r + ' min' : ''); };
const T0 = 3;                        // minuta pseudo-posmatranja za prior
const TAU = 45;                      // minuta: težina prozora e^(−starost/TAU)
const z2 = (x) => Math.round(x * 100) / 100;
const utc = (s) => Date.parse(s.replace(' ', 'T') + 'Z');
/* najsporiji verovatan rad šaltera (vozila/min). HAK kamere (JPEG na 5–10 s) sistematski ne vide deo prolazaka – brojač između
   dva kadra izgubi vozilo – pa je njihov pod pun kapacitet iz konfiguracije. Zvanično MUP RH 25.09. 12:04: Bajakovo ulaz u HR
   „do 30 min“, a mi sa izmerenih 0,6 vozila/min 70 min (40 auta, 3 trake); sa podom 1,2/min ≈ 33 min. */
const rMin = (k) => k.procena.trake / ((k.tip === 'jpg' ? 1 : 2) * k.procena.minPoVozilu);
/* linija repa kolone ima smisla samo na strani repa (ne preko pola kadra ka čelu kolone) */
const punoOk = (p) => !!(p && (p.kraj === 'gore' ? p.y <= 0.6 : p.y >= 0.4));
const PARK_MIN = 30;                 // minuta bez ikakvog pomeranja i sa istim brojem vozila → parkirano, ne kolona
const PARK_MAX = 15;                 // … samo kad je vozila malo (velika kolona koja stoji je stvarna vest)

function priorProtoka(db, k, ref) {
  const cfg = k.procena.trake / k.procena.minPoVozilu;
  const d = db.prepare("SELECT SUM(proslo) AS p, SUM(prozor) AS s FROM kamere_merenja WHERE kamera = ? AND ok = 1 AND protok IS NOT NULL AND pomereno IS NOT NULL AND ukupno >= 4 AND NOT (proslo = 0 AND pomereno >= 0.3) AND vreme <= ? AND vreme >= datetime(?, '-7 days')").get(k.id, ref, ref);   // pomereno IS NOT NULL = samo merenja novog brojača (stari je brojao 2–5× manje)
  let r0 = cfg, izvor = 'konfiguracija';
  if (d && d.s >= 1200 && d.p != null) { r0 = (d.p / d.s) * 60; izvor = 'izmereno'; }
  const min = rMin(k), max = k.procena.trake / 0.5;
  return { r0: Math.min(max, Math.max(min, r0)), izvor, posmatranoUkupno: d ? d.s || 0 : 0 };
}

function proceni(db, k, kad) {
  if (!k.procena) return null;
  if (!kolone) kolone = db.prepare("PRAGMA table_info('kamere_merenja')").all().map((c) => c.name);
  const ima = (c) => kolone.includes(c);
  const imaDubinu = ima('dubina'), imaProtok = ima('protok');
  const ref = kad || db.prepare("SELECT datetime('now') AS t").get().t;
  const redovi = db.prepare('SELECT ukupno' + (imaDubinu ? ', dubina' : ', NULL AS dubina') + " FROM kamere_merenja WHERE kamera = ? AND ok = 1 AND vreme <= ? AND vreme >= datetime(?, '-20 minutes') ORDER BY id DESC LIMIT 3").all(k.id, ref, ref);
  const posl = redovi.map((r) => r.ukupno).sort((a, b) => a - b);
  if (!posl.length) return null;
  const vidljivo = posl[Math.floor(posl.length / 2)];
  const dostize = (d) => (k.puno.kraj === 'gore' ? d <= k.puno.y : d >= k.puno.y);
  const doKraja = !!(punoOk(k.puno) && vidljivo >= 6 && redovi.filter((r) => r.dubina != null && dostize(r.dubina)).length >= Math.min(2, redovi.length));
  let faktor = 1, punoMin = 0;
  if (doKraja) {
    faktor = 1.5;
    if (ima('cekanje_plus')) {   // od kada kolona bez prekida dopire do kraja kadra (prethodna merenja, do 4 h unazad)
      const ist = db.prepare("SELECT vreme, cekanje_plus FROM kamere_merenja WHERE kamera = ? AND ok = 1 AND vreme < ? AND vreme >= datetime(?, '-4 hours') ORDER BY id DESC").all(k.id, ref, ref);
      let od = null; for (const r of ist) { if (!r.cekanje_plus) break; od = r.vreme; }
      if (od) punoMin = (utc(ref) - utc(od)) / 60000;
      faktor = Math.min(2, 1.5 + punoMin / 240);
    }
  }
  let n = Math.round(vidljivo * faktor);

  /* protok */
  let parkirano = 0;
  let protok = null, prior = null, metod = 'formula', prolasci = 0, posmatrano = 0, protokSirov = null, tezOb = 0, kretanje = null;
  if (imaProtok) {
    prior = priorProtoka(db, k, ref);
    const pr = db.prepare('SELECT vreme, proslo, prozor, ukupno' + (ima('pomereno') ? ', pomereno' : ', NULL AS pomereno') + " FROM kamere_merenja WHERE kamera = ? AND ok = 1 AND protok IS NOT NULL AND prozor > 0 AND vreme <= ? AND vreme >= datetime(?, '-180 minutes') ORDER BY id DESC").all(k.id, ref, ref);
    // „promašen“ prozor: kolona se pomerala (≥ 30 % vozila) a brojač nije video nijedan prolazak – ne meri šalter nego brojač
    // (retki HAK kadrovi, vozilo izađe iz slike između dva kadra); takav prozor bi samo vukao protok naniže
    const saKolonom = pr.filter((r) => r.ukupno >= 4 && !(r.proslo === 0 && r.pomereno >= 0.3));   // 4+ vozila = kolona (kao za dubinu); sa manje, nula prolazaka znači da niko ne dolazi, ne da šalter stoji
    let tezPr = 0;
    for (const r of saKolonom) {
      const st = (utc(ref) - utc(r.vreme)) / 60000, w = Math.exp(-Math.max(0, st) / TAU);
      tezPr += w * (r.proslo || 0); tezOb += (w * r.prozor) / 60;
      if (st <= 60) { prolasci += r.proslo || 0; posmatrano += r.prozor; }
    }
    protok = z2(Math.max(rMin(k), (tezPr + prior.r0 * T0) / (tezOb + T0)));
    metod = tezOb >= 3 ? 'protok' : 'prior';
    if (posmatrano >= 60) protokSirov = z2((prolasci / posmatrano) * 60);
    /* kretanje kolone: samo kad postoji prava kolona (≥ 6 vozila sad) i kad je pomeranje izmereno (`pomereno` nije null);
       stoji ako u poslednja 2 merenja (≤ 15 min) niko nije prošao i vozila se nisu pomerila */
    const skoro = vidljivo >= 6 ? pr.filter((r) => (utc(ref) - utc(r.vreme)) / 60000 <= 15 && r.ukupno >= 6 && r.pomereno != null).slice(0, 2) : [];
    if (skoro.length) {
      const mirno = (r) => !(r.proslo > 0) && r.pomereno <= 0.1;
      const stoji = skoro.every(mirno);
      let odKad = null;
      if (stoji) { odKad = skoro[skoro.length - 1].vreme; for (const r of pr) { if (r.ukupno < 6 || r.pomereno == null) continue; if (!mirno(r)) break; odKad = r.vreme; } }
      kretanje = { stoji, min: stoji ? Math.round((utc(ref) - utc(odKad)) / 60000) : 0, posmatrano: skoro.reduce((a, r) => a + r.prozor, 0) };
    }
    /* parkirano: malo vozila, uvek isti broj, ni u jednom merenju poslednjih 30+ min se nisu pomerila i niko nije prošao liniju */
    if (vidljivo > 0 && vidljivo < PARK_MAX) {
      const pola = pr.filter((r) => (utc(ref) - utc(r.vreme)) / 60000 <= PARK_MIN + 5 && r.ukupno > 0);   // `pomereno` null = nijedna staza nije trajala dovoljno (retki HAK kadrovi) – ne znači da se kretalo
      const raspon = pola.length ? (utc(ref) - utc(pola[pola.length - 1].vreme)) / 60000 : 0;
      const broj = pola.map((r) => r.ukupno);   // parkirana vozila: isti broj; kolona koja stoji raste ili se menja (Gostun izlaz 25.09.: 3 → 11 auta, niko ne prolazi)
      if (pola.length >= 5 && raspon >= PARK_MIN - 5 && Math.max(...broj) - Math.min(...broj) <= 1 && pola.some((r) => r.pomereno != null) && pola.every((r) => !(r.proslo > 0) && !(r.pomereno > 0.2))) {
        parkirano = vidljivo; n = 0; kretanje = null;
      }
    }
  } else protok = z2(k.procena.trake / k.procena.minPoVozilu);
  let min = n === 0 ? 0 : Math.max(1, Math.round(n / protok));
  if (n <= k.procena.trake) min = Math.min(min, Math.ceil(k.procena.minPoVozilu));   // po jedno vozilo na šalteru (ili manje) = nema kolone, čeka se jedna obrada
  if (min >= 60) min = Math.round(min / 5) * 5;
  if (min > 360) min = 360;
  const plus = doKraja && !parkirano;   // ostaje kao podatak („deo kolone je van kadra“), ne prikazuje se kao „+“
  const tekst = tekstMin(min);
  return { minuta: min, plus, doKraja: plus, parkirano, faktor: z2(faktor), punoMin: Math.round(punoMin), vozila: n, vidljivo, protok, protokSirov, prior: prior ? { r0: z2(prior.r0), izvor: prior.izvor } : null,
    prolasci, posmatrano, posmatranoTez: Math.round(tezOb), metod, kretanje, tekst,
    za: (k.smer === 'ulaz' ? 'ulaz u Srbiju' : 'izlaz iz Srbije') + (k.hr ? ' (HR strana)' : '') };
}
module.exports = { proceni, tekstMin, osveziKolone() { kolone = null; } };
