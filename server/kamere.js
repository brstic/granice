/* kamere.js — radnik koji na svakih KAMERE_INTERVAL_MIN minuta (5) uzima kadrove sa javnih kamera na graničnim prelazima
   (server/kamere-lista.js), broji vozila lokalnim YOLOv10m modelom (onnxruntime, bez spoljnih servisa) i upisuje merenja
   u SQLite (kamere_merenja). Poslednji kadar sa iscrtanim okvirima čuva u data/kamere/<id>.jpg za prikaz na strani.
   Pokretanje: node server/kamere.js  (PM2: granice-kamere). KAMERE_JEDNOM=1 obradi sve jednom i izađe; KAMERE_SAMO=id,id filter.
   Model (62 MB) se pri prvom pokretanju preuzima u data/modeli/ i ostaje tamo. ffmpeg je potreban za HLS strimove. */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFile } = require('node:child_process');
const db = require('./db');
const KAMERE = require('./kamere-lista');
const { proceni, osveziKolone } = require('./procena');
const zvanicno = require('./zvanicno');

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36 granice.sparkcan.com-kamere';
const DATA = path.join(__dirname, '..', 'data');
const DIR_SLIKE = path.join(DATA, 'kamere');
const MODEL_IME = process.env.KAMERE_MODEL || 'yolov10x';           // x: najbolji odziv na sitna/mutna vozila (~170 ms po kadru na serveru) – za kadar koji se broji
const MODEL_BRZI = process.env.KAMERE_MODEL_BRZI || 'yolov10m';     // m: 2× brži, za praćenje kroz sve kadrove (na Gostunu 22.09. isti broj prolazaka kao x: 11/150 s)
const modelPutanja = (ime) => path.join(DATA, 'modeli', ime + '.onnx');
const modelUrl = (ime) => 'https://huggingface.co/onnx-community/' + ime + '/resolve/main/onnx/model.onnx';
const INTERVAL_MIN = Math.max(1, Number(process.env.KAMERE_INTERVAL_MIN) || 5);
const PARALELNO = Math.max(1, Number(process.env.KAMERE_PARALELNO) || 21);   // kamera odjednom; na slabijoj mašini 2–4 (krug će trajati duže)
const NITI = Math.max(1, Number(process.env.KAMERE_NITI) || Math.max(2, Math.min(8, Math.floor(os.cpus().length / 6))));   // niti onnxruntime-a po modelu
const PRAG = Number(process.env.KAMERE_PRAG) || 0.18;      // najmanja pouzdanost detekcije (kamera može da ima svoj `prag`)
const PROZOR = Math.max(10, Number(process.env.KAMERE_PROZOR) || 30);   // sekundi snimanja po kameri bez kolone: HLS 1 kadar/s, JPEG na 5 s
const PROZOR_KOLONA = Math.max(PROZOR, Number(process.env.KAMERE_PROZOR_KOLONA) || 90);   // kad je u prošlom merenju bilo kolone: duže gledanje = više izbrojanih prolazaka (protok je retka pojava: ~1 vozilo/min)
const KORAK = 2;                                            // HLS: kadar na svake 2 s (vozila u koloni se pomeraju sporo; na Gostunu 22.09. korak 1/2/3 s daje 11/10/9 prolazaka)
const S = 640;                                              // ulaz modela
const KLASE = { 2: 'auto' };                               // samo putnička vozila (Branko 22.09.: kamioni i autobusi nas ne zanimaju – parkirani kamioni na terminalu su pravili lažnu „kolonu“ na Tovarniku); COCO 3 motor, 5 autobus, 7 kamion se ignorišu
const TERETNA = { 5: 'autobus', 7: 'kamion' };             // ne broje se, ali služe da se izbace automobili koji su NA njima (auto-transporter)
const PRAG_TERETNA = 0.4;
const BOJE = { auto: '#33ff66', motor: '#66ccff', autobus: '#ff3366', kamion: '#ff9900' };
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

db.exec(`CREATE TABLE IF NOT EXISTS kamere_merenja (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kamera TEXT NOT NULL, vreme TEXT NOT NULL, lok_dan INTEGER NOT NULL, lok_sat INTEGER NOT NULL,
  auto INTEGER NOT NULL DEFAULT 0, autobus INTEGER NOT NULL DEFAULT 0, kamion INTEGER NOT NULL DEFAULT 0, motor INTEGER NOT NULL DEFAULT 0, ukupno INTEGER NOT NULL DEFAULT 0,
  ms INTEGER, kadrova INTEGER, ok INTEGER NOT NULL DEFAULT 1, greska TEXT);
  CREATE INDEX IF NOT EXISTS kamere_merenja_k ON kamere_merenja(kamera, vreme);`);
for (const [kol, tip] of [['dubina', 'REAL'], ['protok', 'REAL'], ['proslo', 'INTEGER'], ['brzina', 'REAL'], ['prozor', 'INTEGER'], ['cekanje', 'REAL'], ['cekanje_plus', 'INTEGER'], ['pomereno', 'REAL']]) if (!db.prepare("PRAGMA table_info('kamere_merenja')").all().some((c) => c.name === kol)) db.exec(`ALTER TABLE kamere_merenja ADD COLUMN ${kol} ${tip}`);

/* ---------- model ---------- */
let ort, sharp; const sesije = {};
function preuzmi(url, cilj, pokusaj) {
  return new Promise((res, rej) => {
    fs.mkdirSync(path.dirname(cilj), { recursive: true });
    const https = require('node:https');
    https.get(url, { headers: { 'User-Agent': UA } }, (r) => {
      if ([301, 302, 303, 307, 308].includes(r.statusCode) && r.headers.location && (pokusaj || 0) < 5) { r.resume(); return preuzmi(new URL(r.headers.location, url).href, cilj, (pokusaj || 0) + 1).then(res, rej); }
      if (r.statusCode !== 200) { r.resume(); return rej(new Error('Preuzimanje modela: HTTP ' + r.statusCode)); }
      const tmp = cilj + '.deo', w = fs.createWriteStream(tmp);
      r.pipe(w); w.on('finish', () => { w.close(() => { fs.renameSync(tmp, cilj); res(); }); }); w.on('error', rej);
    }).on('error', rej);
  });
}
async function model(ime) {
  ime = ime || MODEL_IME;
  if (sesije[ime]) return sesije[ime];
  ort = ort || require('onnxruntime-node'); sharp = sharp || require('sharp');
  const f = modelPutanja(ime);
  if (!fs.existsSync(f)) { log('Preuzimam model ' + ime + '…'); await preuzmi(modelUrl(ime), f); log('Model preuzet:', f); }
  // niti po sesiji: 21 kamera paralelno × 16 niti je gušilo 48 jezgara (krug 310 s) – manje niti po kadru, više kadrova odjednom
  sesije[ime] = await ort.InferenceSession.create(f, { intraOpNumThreads: NITI, interOpNumThreads: 1 });
  return sesije[ime];
}

/* ---------- kadrovi ---------- */
function ffmpegKadrovi(url, prozor) {
  const KADROVA = Math.ceil(prozor / KORAK);
  return new Promise((res, rej) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kam-'));
    const args = ['-hide_banner', '-loglevel', 'error', '-user_agent', UA, '-rw_timeout', '15000000', '-i', url, '-vf', 'fps=1/' + KORAK, '-frames:v', String(KADROVA), '-q:v', '3', '-y', path.join(dir, '%d.jpg')];
    execFile('ffmpeg', args, { timeout: prozor * 1000 + 60000, killSignal: 'SIGKILL' }, (err, so, se) => {   // SIGKILL: ffmpeg zaglavljen u DNS/TLS-u ignoriše SIGTERM i blokira ceo krug
      const fajlovi = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.jpg')).sort((a, b) => parseInt(a, 10) - parseInt(b, 10)) : [];
      const bufferi = fajlovi.map((f) => ({ buf: fs.readFileSync(path.join(dir, f)), t: (parseInt(f, 10) - 1) * KORAK }));
      fs.rmSync(dir, { recursive: true, force: true });
      if (!bufferi.length) return rej(new Error('ffmpeg: ' + (se || (err && err.message) || 'nema kadra').toString().trim().slice(0, 200)));
      res(bufferi);
    });
  });
}
async function jpgKadrovi(url, prozor) {
  const out = []; const t0 = Date.now(); let prosli = null;
  for (let i = 0; i * 5 < prozor && (Date.now() - t0) / 1000 < prozor; i++) {
    if (i) await new Promise((r) => setTimeout(r, 5000));
    const r = await fetch(url + (url.includes('?') ? '&' : '?') + 'v=' + Date.now(), { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const b = Buffer.from(await r.arrayBuffer());
    if (prosli && b.equals(prosli)) continue;   // slika se još nije osvežila
    prosli = b; out.push({ buf: b, t: (Date.now() - t0) / 1000 });
  }
  return out;
}

/* ---------- detekcija ---------- */
function uPoligonu(x, y, poly) { let u = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i], [xj, yj] = poly[j]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) u = !u; } return u; }
const iou = (a, b) => { const x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]), x2 = Math.min(a[2], b[2]), y2 = Math.min(a[3], b[3]); const i = Math.max(0, x2 - x1) * Math.max(0, y2 - y1); const u = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - i; return u ? i / u : 0; };
/* Pun kadar + zum zone (isečak ×3, niži prag), spojeno bez duplikata; vraća i dubinu = najmanji relativni y donje ivice (koliko daleko kolona dopire) */
/* Pločice (kao SAHI): na kadru od 1280 px model vidi smanjeno na 640, pa su automobili u sredini kolone 30–50 px i gusta
   kolona se stapa u zajedničke okvire. Zona kolone se zato dodatno pokrije preklapajućim pločicama (~512 px, uvećanje ×1,25),
   okviri koji seku unutrašnju ivicu pločice se odbacuju (to vozilo cele vidi susedna pločica), okvir sa celog kadra koji u sebi
   ima 2+ vozila sa pločica se izbacuje kao „stopljen“, pa se sve spoji bez duplikata. Uključeno za kadrove ≥ 1000 px (HAK)
   ili kad kamera ima `plocice: true`. */
const presek = (a, b) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
const povrsina = (a) => (a[2] - a[0]) * (a[3] - a[1]);
/* tri nivoa: ~W/2,5 preko cele zone (×1,25), ~W/4 preko gornje (udaljene) polovine zone (×2) i ~W/6 preko najdalje četvrtine (×3).
   Bajakovo 2 (22.09.): 28 → 50 vozila od ~55 vidljivih, ~3 s po kadru. */
function rasporedPlocica(W, H, roi) {
  let x0 = 0, y0 = 0, x1 = W, y1 = H;
  if (roi) { x0 = Math.min(...roi.map((t) => t[0])) * W; x1 = Math.max(...roi.map((t) => t[0])) * W; y0 = Math.min(...roi.map((t) => t[1])) * H; y1 = Math.max(...roi.map((t) => t[1])) * H; }
  const nivo = (T, ya, yb) => {
    const osa = (a, b, max) => { const duz = b - a; if (duz <= T) return [Math.max(0, Math.min(max - T, Math.round(a + duz / 2 - T / 2)))]; const n = Math.ceil((duz - T) / (T * 0.75)) + 1; return Array.from({ length: n }, (_, i) => Math.max(0, Math.min(max - T, Math.round(a + (i * (duz - T)) / (n - 1))))); };
    const out = []; for (const y of osa(ya, yb, H)) for (const x of osa(x0, x1, W)) out.push({ x, y, w: Math.min(T, W), h: Math.min(T, H) });
    return out;
  };
  const T1 = Math.round(Math.max(400, Math.min(640, W / 2.5))), T2 = Math.round(Math.max(256, W / 4));
  const T3 = Math.round(Math.max(200, W / 6));
  return [...nivo(T1, y0, y1), ...nivo(T2, y0, y0 + (y1 - y0) / 2), ...nivo(T3, y0, y0 + (y1 - y0) / 4)];
}
/* brzo = samo pun kadar brzim modelom (praćenje kroz sve kadrove: vozila oko linije su krupna); inače pun kadar + pločice + zum velikim modelom */
async function detektuj(buf, k, brzo) {
  const prag = (k && k.prag) || PRAG;
  const r = await detektujJedan(buf, k && k.roi, prag, brzo, !!(k && k.transporteri));
  r.plocice = !brzo && !!k && (k.plocice != null ? k.plocice : r.sirina >= 1000);
  if (r.plocice) {
    const saPlocica = [];
    for (const t of rasporedPlocica(r.sirina, r.visina, k.roi)) {
      try {
        const isecak = await sharp(buf).extract({ left: t.x, top: t.y, width: t.w, height: t.h }).toBuffer();
        const rz = await detektujJedan(isecak, null, Math.max(0.12, prag - 0.04));
        r.ms += rz.ms;
        for (const v of rz.vozila) {
          const b = v.box, M = 3;
          const reze = (b[0] < M && t.x > 0) || (b[1] < M && t.y > 0) || (b[2] > t.w - M && t.x + t.w < r.sirina) || (b[3] > t.h - M && t.y + t.h < r.visina);
          if (reze) continue;
          if (v.kl === 'motor' && v.sc < 0.35) continue;
          const box = [b[0] + t.x, b[1] + t.y, b[2] + t.x, b[3] + t.y];
          if (k.roi && !uPoligonu((box[0] + box[2]) / 2 / r.sirina, box[3] / r.visina, k.roi)) continue;
          saPlocica.push({ kl: v.kl, sc: v.sc, box, plocica: true });
        }
      } catch (e) { /* pločica nije uspela – ostaje ostatak */ }
    }
    // stopljeni okviri: ceo kadar dao jedan okvir tamo gde pločice vide 2+ vozila
    const celi = r.vozila.filter((v) => saPlocica.filter((p) => presek(v.box, p.box) / povrsina(p.box) > 0.7).length < 2);
    // spajanje bez duplikata: po pouzdanosti, preklop (IoU > 0,5) ili isto vozilo u drugom okviru (≥ 80 % manjeg, slične veličine)
    const svi = [...celi, ...saPlocica].sort((a, b) => b.sc - a.sc), zadrzani = [];
    for (const v of svi) {
      const dupl = zadrzani.some((z) => { const i = presek(z.box, v.box), a = povrsina(z.box), b = povrsina(v.box); return iou(z.box, v.box) > 0.5 || (i / Math.min(a, b) > 0.8 && Math.min(a, b) / Math.max(a, b) > 0.4); });
      if (!dupl) zadrzani.push(v);
    }
    r.vozila = zadrzani;
  }
  for (const z of (!brzo && k && k.zum) || []) {
    const x0 = Math.round(z[0] * r.sirina), y0 = Math.round(z[1] * r.visina), cw = Math.round((z[2] - z[0]) * r.sirina), ch = Math.round((z[3] - z[1]) * r.visina);
    if (cw < 40 || ch < 40) continue;
    try {
      // isečak se uvećava tako da širina bude ≈ 640 px (ulaz modela), pa je uvećanje 640/cw (za uske isečke stvarno 2–3×)
      const uv = Math.max(1, Math.min(4, 640 / Math.max(cw, ch * 640 / 640)));
      const isecak = await sharp(buf).extract({ left: x0, top: y0, width: cw, height: ch }).resize(Math.round(cw * uv), Math.round(ch * uv), { kernel: 'lanczos3' }).jpeg({ quality: 95 }).toBuffer();
      const rz = await detektujJedan(isecak, null, Math.max(0.12, prag - 0.06));
      for (const v of rz.vozila) {
        if (v.kl === 'motor' && v.sc < 0.35) continue;   // u zumu čunjevi i pešaci lako prođu kao „motor“
        const box = [v.box[0] / uv + x0, v.box[1] / uv + y0, v.box[2] / uv + x0, v.box[3] / uv + y0];
        if (k.roi && !uPoligonu((box[0] + box[2]) / 2 / r.sirina, box[3] / r.visina, k.roi)) continue;
        if (!r.vozila.some((s) => iou(s.box, box) > 0.45)) r.vozila.push({ kl: v.kl, sc: v.sc, box, zum: true });
      }
      r.ms += rz.ms;
    } catch (e) { /* zum nije uspeo – ostaje pun kadar */ }
  }
  if (k && k.transporteri && r.teretna.length) r.vozila = r.vozila.filter((v) => !naTeretnom(v.box, r.teretna));   // pločice i zum vide auto na transporteru bez celog kamiona
  // dubina = donja ivica ČETVRTOG vozila najbližeg ivici kadra na kojoj je rep kolone (3 vozila mogu stajati bilo gde, 4 znače kolonu)
  const dna = r.vozila.map((v) => v.box[3] / r.visina).sort((a, b) => a - b);
  const kraj = (k && k.puno && k.puno.kraj) || 'gore';
  r.dubina = dna.length >= 4 ? (kraj === 'gore' ? dna[3] : dna[dna.length - 4]) : null;
  return r;
}
/* auto na kamionu (auto-transporter): donja sredina okvira auta je unutar okvira kamiona i bar 15 % njegove visine iznad dna.
   Samo za kamere sa `transporteri: true` (Batina 1): u opštem slučaju auto u susednoj traci pored autobusa izgleda isto (Gostun izlaz 25.09.). */
const naTeretnom = (b, teretna) => { const cx = (b[0] + b[2]) / 2; return teretna.some((t) => cx > t[0] && cx < t[2] && b[3] > t[1] && b[3] < t[3] - 0.15 * (t[3] - t[1])); };
async function detektujJedan(buf, roi, prag, brzo, transporteri) {
  prag = prag || PRAG;
  const ses = await model(brzo ? MODEL_BRZI : MODEL_IME);
  const img = sharp(buf); const meta = await img.metadata();
  const k = Math.min(S / meta.width, S / meta.height), w = Math.round(meta.width * k), h = Math.round(meta.height * k);
  const { data } = await img.clone().resize(w, h).extend({ top: 0, left: 0, bottom: S - h, right: S - w, background: { r: 114, g: 114, b: 114 } }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const t = new Float32Array(3 * S * S);
  for (let i = 0; i < S * S; i++) { t[i] = data[i * 3] / 255; t[S * S + i] = data[i * 3 + 1] / 255; t[2 * S * S + i] = data[i * 3 + 2] / 255; }
  const t0 = Date.now();
  const out = await ses.run({ [ses.inputNames[0]]: new ort.Tensor('float32', t, [1, 3, S, S]) });
  const o = out[ses.outputNames[0]], d = o.data, n = o.dims[1], st = o.dims[2];
  const vozila = [], teretna = [];
  for (let i = 0; i < n; i++) if (d[i * st + 4] >= PRAG_TERETNA && TERETNA[d[i * st + 5]]) teretna.push([d[i * st] / k, d[i * st + 1] / k, d[i * st + 2] / k, d[i * st + 3] / k]);
  // Batina 1 (25.09.): auto-transporteri sa 7–11 auta su po 30 min pravili „kolonu“ od 50+ min
  const naKamionu = (b) => naTeretnom(b, teretna);
  for (let i = 0; i < n; i++) {
    const sc = d[i * st + 4], kl = KLASE[d[i * st + 5]];
    if (sc < prag || !kl) continue;
    const box = [d[i * st] / k, d[i * st + 1] / k, d[i * st + 2] / k, d[i * st + 3] / k];
    if (roi && !uPoligonu((box[0] + box[2]) / 2 / meta.width, box[3] / meta.height, roi)) continue;
    if (transporteri && naKamionu(box)) continue;
    // prosečna boja unutrašnje polovine okvira (na 640 px ulazu) – pomaže uparivanju istog vozila između kadrova u koloni gde su sva vozila jednako razmaknuta
    const bx0 = Math.max(0, Math.round((box[0] * k + (box[2] - box[0]) * k * 0.25))), bx1 = Math.min(S - 1, Math.round((box[2] * k - (box[2] - box[0]) * k * 0.25)));
    const by0 = Math.max(0, Math.round((box[1] * k + (box[3] - box[1]) * k * 0.25))), by1 = Math.min(S - 1, Math.round((box[3] * k - (box[3] - box[1]) * k * 0.25)));
    let R = 0, G = 0, B = 0, N = 0;
    for (let y = by0; y <= by1; y += 2) for (let x = bx0; x <= bx1; x += 2) { const o = (y * S + x) * 3; R += data[o]; G += data[o + 1]; B += data[o + 2]; N++; }
    vozila.push({ kl, sc, box, boja: N ? [R / N / 255, G / N / 255, B / N / 255] : null });
  }
  return { vozila, teretna, ms: Date.now() - t0, sirina: meta.width, visina: meta.height };
}
async function nacrtaj(buf, r, k, brojevi, tok) {
  const tekst = `${k.naziv} · ${new Date().toLocaleString('sr-Latn-RS', { timeZone: 'Europe/Belgrade', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' })} · ${r.vozila.length} vozila (${Object.entries(brojevi).filter(([, v]) => v).map(([a, b]) => b + ' ' + a).join(', ') || 'prazno'})${tok && tok.prozor ? ` · prošlo ${tok.proslo} za ${tok.prozor}s` : ''}`;
  const linijaSvg = k.linija ? (() => {
    const L = k.linija, x1 = L.x1 * r.sirina, y1 = L.y1 * r.visina, x2 = L.x2 * r.sirina, y2 = L.y2 * r.visina;
    // strelica iz sredine duži u smeru prolaska: 'gore' = suprotno od normale (-dy, dx)
    const dx = x2 - x1, dy = y2 - y1, d = Math.hypot(dx, dy) || 1, zn = L.smer === 'gore' ? -1 : 1, nx = (-dy / d) * zn, ny = (dx / d) * zn, mx = (x1 + x2) / 2, my = (y1 + y2) / 2, a = r.sirina > 800 ? 26 : 18;
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="rgba(255,80,80,.85)" stroke-width="2"/><line x1="${mx}" y1="${my}" x2="${mx + nx * a}" y2="${my + ny * a}" stroke="rgba(255,80,80,.85)" stroke-width="2"/><circle cx="${mx + nx * a}" cy="${my + ny * a}" r="3" fill="#ff8080"/><text x="${Math.min(x1, x2) + 6}" y="${(x1 <= x2 ? y1 : y2) - 4}" font-size="${r.sirina > 800 ? 13 : 10}" font-family="Arial" fill="#ff8080">linija prolaska</text>`;
  })() : '';
  const esc = (s) => String(s).replace(/[&<>"]/g, (x) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[x]));
  const punoSvg = k.puno ? `<line x1="0" y1="${k.puno.y * r.visina}" x2="${r.sirina}" y2="${k.puno.y * r.visina}" stroke="rgba(255,200,0,.55)" stroke-dasharray="3 5" stroke-width="1"/><text x="${r.sirina - 6}" y="${k.puno.y * r.visina + (k.puno.kraj === 'gore' ? -4 : 11)}" font-size="${r.sirina > 800 ? 12 : 9}" font-family="Arial" fill="rgba(255,200,0,.8)" text-anchor="end">rep kolone ${k.puno.kraj === 'gore' ? '▲' : '▼'}</text>` : '';
  const roiSvg = k.roi ? `<polygon points="${k.roi.map(([x, y]) => (x * r.sirina) + ',' + (y * r.visina)).join(' ')}" fill="rgba(51,255,102,.06)" stroke="rgba(51,255,102,.6)" stroke-dasharray="6 4" stroke-width="2"/>` : '';
  const svg = `<svg width="${r.sirina}" height="${r.visina}" xmlns="http://www.w3.org/2000/svg">${roiSvg}${punoSvg}${linijaSvg}${r.vozila.map((v) => `<rect x="${v.box[0]}" y="${v.box[1]}" width="${v.box[2] - v.box[0]}" height="${v.box[3] - v.box[1]}" fill="none" stroke="${BOJE[v.kl]}" stroke-width="${r.sirina > 800 ? 3 : 2}"${v.zum ? ' stroke-dasharray="4 2"' : ''}/>`).join('')}<rect x="0" y="${r.visina - 26}" width="${r.sirina}" height="26" fill="rgba(16,37,79,.75)"/><text x="8" y="${r.visina - 8}" font-size="${r.sirina > 800 ? 16 : 12}" font-family="Arial,Helvetica,sans-serif" fill="#fff">${esc(tekst)}</text><text x="${r.sirina - 8}" y="${r.visina - 8}" font-size="${r.sirina > 800 ? 13 : 10}" font-family="Arial,Helvetica,sans-serif" fill="#c9d6ee" text-anchor="end">${esc(k.izvor)} · granice.sparkcan.com</text></svg>`;
  fs.mkdirSync(DIR_SLIKE, { recursive: true });
  const tmp = path.join(DIR_SLIKE, k.id + '.tmp.jpg');
  await sharp(buf).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).jpeg({ quality: 78 }).toFile(tmp);
  fs.renameSync(tmp, path.join(DIR_SLIKE, k.id + '.jpg'));
}

/* ---------- protok: praćenje vozila kroz niz kadrova i brojanje prelazaka linije šaltera ----------
   Kadrovi su 1 s (HLS) ili ~5 s (JPEG) razmaknuti. Kolona se pomera „u talasu“: kad jedno vozilo prođe šalter, sva iza njega
   pomere se za jedno mesto, pa uparivanje po najbližem susedu lako „preskoči“ na vozilo iza (isto mesto, druga kola) i prelazak
   se ne izbroji (Gostun 22.09.: ručno 12–16 prolazaka u 150 s, stari brojač 2–6). Zato:
   – uparivanje je globalno (Mađarski algoritam nad cenom = pomak + razlika boje), ne pohlepno po najbližem;
   – pomak unazad (suprotno od smera kolone) košta kao da vozilo nije upareno;
   – prelazak se broji sa stanjem: staza koja je bila jasno ispred linije (> H) računa se kad prvi put bude jasno iza (< −H),
     pa i kad prelazak traje više kadrova; treperenje na liniji se ne broji;
   – `pomereno` = udeo staza koje su se za vreme prozora pomerile bar pola svoje dužine (da li se kolona uopšte kreće). */
function madjarski(cena) {   // najjeftinije uparivanje redova i kolona kvadratne matrice (O(n³), n ≤ ~80)
  const n = cena.length; if (!n) return [];
  const u = new Array(n + 1).fill(0), v = new Array(n + 1).fill(0), p = new Array(n + 1).fill(0), way = new Array(n + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i; let j0 = 0; const minv = new Array(n + 1).fill(Infinity), used = new Array(n + 1).fill(false);
    do {
      used[j0] = true; const i0 = p[j0]; let delta = Infinity, j1 = 0;
      for (let j = 1; j <= n; j++) if (!used[j]) { const cur = cena[i0 - 1][j - 1] - u[i0] - v[j]; if (cur < minv[j]) { minv[j] = cur; way[j] = j0; } if (minv[j] < delta) { delta = minv[j]; j1 = j; } }
      for (let j = 0; j <= n; j++) if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }
  const par = new Array(n).fill(-1); for (let j = 1; j <= n; j++) if (p[j]) par[p[j] - 1] = j - 1; return par;
}
function protok(rez, k) {
  const out = { proslo: 0, protok: null, brzina: null, prozor: 0, pomereno: null };
  if (!k.linija || rez.length < 2) return out;
  const W = rez[0].r.sirina, H = rez[0].r.visina; const prozor = rez[rez.length - 1].t - rez[0].t; if (prozor < 5) return out;
  const centar = (v) => [(v.box[0] + v.box[2]) / 2 / W, v.box[3] / H];   // donja sredina, relativno
  const A = W / H, L = k.linija, ax = L.x1 * A, ay = L.y1, lx = (L.x2 - L.x1) * A, ly = L.y2 - L.y1, duz = Math.hypot(lx, ly) || 1;
  const zn = L.smer === 'gore' ? 1 : -1;   // u > 0 = ispred linije (uzvodno), u < 0 = prošlo
  const polozaj = (c) => { const px = c[0] * A - ax, py = c[1] - ay; return { u: ((lx * py - ly * px) / duz) * zn, t: (px * lx + py * ly) / (duz * duz) }; };
  const HIST = 0.012;
  const bojaR = (a, b) => (a && b ? Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) : 0.15);
  /* retki kadrovi (HAK, ~10 s): vozilo iza zauzme mesto onog koje je prošlo, pa bi mu uparivanje „prelepilo“ stazu (Bajakovo 2:
     tamni kombi prođe, na njegovo mesto dođe sivo auto → prolazak se ne vidi). Zato se tamo staza ne prenosi na vozilo
     očigledno druge boje – ona se izgubi, a druga šansa ispod je spoji sa pravim vozilom iza linije. */
  const retki = k.tip === 'jpg';   // HAK; MUP (kadar na 2 s) ostaje na brojaču ručno proverenom na Gostunu
  const BOJA_MAX = k._bojaPrag != null ? k._bojaPrag : retki ? 0.2 : Infinity;
  let staze = []; let proslo = 0; let sled = 0; const gotove = [];
  for (let i = 0; i < rez.length; i++) {
    const dt = i ? rez[i].t - rez[i - 1].t : 0;
    const det = rez[i].r.vozila.map((v) => ({ c: centar(v), h: (v.box[3] - v.box[1]) / H, boja: v.boja }));
    const R = 0.1 + 0.03 * Math.min(dt, 5);   // najveći pomak koji još smatramo istim vozilom (visine kadra)
    const n = Math.max(staze.length, det.length); const nove = [];
    if (staze.length && det.length) {
      const cena = Array.from({ length: n }, (_, a) => Array.from({ length: n }, (_, b) => {
        if (a >= staze.length || b >= det.length) return R;   // „nije upareno“
        const s = staze[a], d = det[b];
        const dd = Math.hypot((d.c[0] - s.c[0]) * A, d.c[1] - s.c[1]); if (dd > R) return 9;
        if (s.boja && d.boja && bojaR(s.boja, d.boja) > BOJA_MAX) return 9;
        const unazad = polozaj(d.c).u - polozaj(s.c).u;   // > 0 = vozilo se vratilo uzvodno (nemoguće u koloni, osim treperenja)
        return dd + 0.25 * bojaR(s.boja, d.boja) + (unazad > 0.02 + 0.01 * dt ? 9 : 0);
      }));
      const par = madjarski(cena);
      const zauzeto = new Set(), izgubljene = [];
      staze.forEach((s, a) => {
        const b = par[a];
        if (b >= 0 && b < det.length && cena[a][b] < R) {
          const d = det[b]; zauzeto.add(b);
          const pos = polozaj(d.c); const naDuzi = pos.t > -0.05 && pos.t < 1.05;
          let str = s.str; if (pos.u > HIST) str = 'pre'; else if (pos.u < -HIST) str = 'posle';
          if (s.str === 'pre' && str === 'posle' && naDuzi) { proslo++; if (k._dnevnik) k._dnevnik.push({ t: rez[i].t, x: Math.round(d.c[0] * 100) / 100 }); }
          nove.push({ id: s.id, c: d.c, h: d.h, boja: d.boja || s.boja, str, zivot: 0, od: s.od, odU: s.odU, zadnjiU: pos.u });
        } else if (s.zivot < 2) { const kop = Object.assign({}, s, { zivot: s.zivot + 1 }); nove.push(kop); if (s.zivot === 0) izgubljene.push(kop); }
        else gotove.push(s);
      });
      /* druga šansa za prelazak linije: kad su kadrovi retki (HAK, ~10 s), vozilo u jednom kadru stoji tik ispred linije, a u
         sledećem je već iza nje i dalje nego što uparivanje dozvoljava – staza se izgubi, a iza linije se rodi „nova“ i prolazak
         se ne izbroji (Bajakovo 2, 25.09.: ~5 stvarnih prolazaka za 142 s, izbrojan 1). Staza izgubljena baš u ovom kadru, koja je
         bila ispred linije na manje od 1,5 svoje dužine, i nova detekcija iza linije na manje od 1,5 dužine, na razumnoj
         udaljenosti (≤ 1,6 R) = isto vozilo koje je prošlo. Samo za retke kadrove: na MUP kamerama (2 s) u magli je dodavala
         neproverljive prolaske (Preševo 3 → 6 za 90 s), a tamo je brojač proveren ručno.
         Provera 25.09. (snimak 5 min, Bajakovo 2/3): 1 → 2 i 3 → 5 prolazaka; stvarno ih je ~2/min – vozila koja se iznad linije
         uopšte ne vide (gusta kolona) ne mogu se uhvatiti, zato HAK procena i dalje ima pod = pun kapacitet (procena.js). */
      const kand = !retki ? [] : det.map((d, b) => ({ d, b, pos: polozaj(d.c) })).filter((x) => !zauzeto.has(x.b) && x.pos.u < -HIST && -x.pos.u <= Math.max(0.08, 1.5 * x.d.h) && x.pos.t > -0.05 && x.pos.t < 1.05);
      const parovi = [];
      for (const st of izgubljene) {
        const u = polozaj(st.c).u; if (st.str !== 'pre' || u > Math.max(0.08, 1.5 * st.h)) continue;
        for (const x of kand) { const dd = Math.hypot((x.d.c[0] - st.c[0]) * A, x.d.c[1] - st.c[1]); if (dd <= 1.6 * R) parovi.push({ st, x, dd: dd + 0.25 * bojaR(st.boja, x.d.boja) }); }
      }
      parovi.sort((p, q) => p.dd - q.dd);
      const uzeteSt = new Set();
      for (const { st, x } of parovi) {
        if (uzeteSt.has(st) || zauzeto.has(x.b)) continue;
        uzeteSt.add(st); zauzeto.add(x.b); nove.splice(nove.indexOf(st), 1);
        proslo++; if (k._dnevnik) k._dnevnik.push({ t: rez[i].t, x: Math.round(x.d.c[0] * 100) / 100, druga: true });
        nove.push({ id: st.id, c: x.d.c, h: x.d.h, boja: x.d.boja || st.boja, str: 'posle', zivot: 0, od: st.od, odU: st.odU, zadnjiU: x.pos.u });
      }
      det.forEach((d, b) => { if (!zauzeto.has(b)) { const pos = polozaj(d.c); nove.push({ id: sled++, c: d.c, h: d.h, boja: d.boja, str: pos.u > HIST ? 'pre' : pos.u < -HIST ? 'posle' : null, zivot: 0, od: i, odU: pos.u, zadnjiU: pos.u }); } });
    } else det.forEach((d) => { const pos = polozaj(d.c); nove.push({ id: sled++, c: d.c, h: d.h, boja: d.boja, str: pos.u > HIST ? 'pre' : pos.u < -HIST ? 'posle' : null, zivot: 0, od: i, odU: pos.u, zadnjiU: pos.u }); });
    staze = nove;
    if (k._trag) k._trag.push(staze.map((s) => ({ id: s.id, x: Math.round(s.c[0] * 100) / 100, y: Math.round(s.c[1] * 1000) / 1000, u: Math.round(polozaj(s.c).u * 1000) / 1000, str: s.str, z: s.zivot })));
  }
  gotove.push(...staze);
  // pomak u dužinama vozila po minuti (medijana svih staza koje su trajale ≥ 5 kadrova) i udeo staza koje su se pomerile bar pola dužine
  const duge = gotove.filter((s) => rez.length - s.od >= 5 && s.h > 0);
  const pomaci = duge.map((s) => (s.odU - s.zadnjiU) / s.h);   // koliko svojih dužina je prešlo napred
  if (duge.length) { const sr = pomaci.slice().sort((a, b) => a - b)[Math.floor(pomaci.length / 2)]; out.brzina = Math.round(Math.max(0, sr) / (prozor / 60) * 100) / 100; out.pomereno = Math.round(pomaci.filter((p) => p >= 0.5).length / pomaci.length * 100) / 100; }
  out.proslo = proslo; out.prozor = Math.round(prozor); out.protok = Math.round((proslo / prozor) * 60 * 100) / 100;
  return out;
}

/* ---------- provera brojanja (admin → Kamere → „Proveri brojanje“) ----------
   Admin ostavi data/provera/<id>.zahtev; radnik u sledećem krugu za tu kameru prati staze (k._trag, k._dnevnik iz protok())
   i sačuva montažu svih kadrova prozora: staze sa ID-jem (žuto = ispred linije, zeleno = prošlo, sivo = nepoznato),
   liniju šaltera i obeležen prolazak. Tako se na oko vidi da li brojač promašuje ili broji duplo. */
const DIR_PROVERA = path.join(DATA, 'provera');
async function montaza(rez, k, tok) {
  const MAX = 24, idx = rez.length <= MAX ? rez.map((_, i) => i) : Array.from({ length: MAX }, (_, j) => Math.round((j * (rez.length - 1)) / (MAX - 1)));
  const W = 480, H = Math.round((W * rez[0].r.visina) / rez[0].r.sirina), KOL = 3, RED = Math.ceil(idx.length / KOL);
  const boja = { pre: '#ffd000', posle: '#33ff66' };
  const plocice = [];
  for (const [j, i] of idx.entries()) {
    const trag = (k._trag[i] || []), prolasci = k._dnevnik.filter((d) => d.t === rez[i].t);
    const L = k.linija;
    const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
      ${L ? `<line x1="${L.x1 * W}" y1="${L.y1 * H}" x2="${L.x2 * W}" y2="${L.y2 * H}" stroke="#ff5050" stroke-width="2"/>` : ''}
      ${trag.map((s) => `<circle cx="${s.x * W}" cy="${s.y * H}" r="5" fill="${boja[s.str] || '#bbbbbb'}" stroke="#000" stroke-width="1"/><text x="${s.x * W + 7}" y="${s.y * H - 4}" font-size="13" font-family="Arial" font-weight="bold" fill="#fff" stroke="#000" stroke-width="3" paint-order="stroke">${s.id}</text>`).join('')}
      ${prolasci.map((d) => `<rect x="${d.x * W - 30}" y="4" width="60" height="20" rx="4" fill="#d00000"/><text x="${d.x * W}" y="19" font-size="13" font-family="Arial" font-weight="bold" fill="#fff" text-anchor="middle">PROŠAO</text>`).join('')}
      <rect x="0" y="${H - 20}" width="${W}" height="20" fill="rgba(0,0,0,.6)"/><text x="6" y="${H - 6}" font-size="12" font-family="Arial" fill="#fff">kadar ${i + 1}/${rez.length} · t = ${Math.round(rez[i].t)} s · staza ${trag.length}</text></svg>`;
    const buf = await sharp(rez[i].buf).resize(W, H, { fit: 'fill' }).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).jpeg({ quality: 72 }).toBuffer();
    plocice.push({ input: buf, left: (j % KOL) * W, top: Math.floor(j / KOL) * H });
  }
  const tmp = path.join(DIR_SLIKE, k.id + '.provera.tmp.jpg');
  await sharp({ create: { width: KOL * W, height: RED * H, channels: 3, background: '#222' } }).composite(plocice).jpeg({ quality: 72 }).toFile(tmp);
  fs.renameSync(tmp, path.join(DIR_SLIKE, k.id + '.provera.jpg'));
  const info = { vreme: new Date().toISOString(), kadrova: rez.length, prikazano: idx.length, prozor: tok.prozor, proslo: tok.proslo, pomereno: tok.pomereno, staza: new Set(k._trag.flat().map((s) => s.id)).size, prolasci: k._dnevnik.map((d) => ({ t: Math.round(d.t), x: d.x })) };
  fs.writeFileSync(path.join(DIR_SLIKE, k.id + '.provera.json'), JSON.stringify(info));
}

/* ---------- jedno merenje ---------- */
const lokalno = () => { const p = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Belgrade', hour: 'numeric', hour12: false, weekday: 'short' }).formatToParts(new Date()); const sat = Number(p.find((x) => x.type === 'hour').value) % 24; const dan = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.find((x) => x.type === 'weekday').value); return { sat, dan: (dan + 6) % 7 }; };   // dan: 0 = ponedeljak
const upis = db.prepare('INSERT INTO kamere_merenja (kamera, vreme, lok_dan, lok_sat, auto, autobus, kamion, motor, ukupno, ms, kadrova, ok, greska) VALUES (?, datetime(\'now\'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
async function obradi(k) {
  const { sat, dan } = lokalno(); const t0 = Date.now();
  try {
    // čuvar: jedna zaglavljena kamera ne sme da zaustavi ceo krug (22.09. je ffmpeg visio sat vremena posle ispada DNS-a)
    let tajmer; const cuvar = new Promise((_, rej) => { tajmer = setTimeout(() => rej(new Error('snimanje traje duže od 4 min')), 240000); });
    const prethodno = db.prepare('SELECT ukupno FROM kamere_merenja WHERE kamera = ? AND ok = 1 ORDER BY id DESC LIMIT 1').get(k.id);
    const prozor = k.linija && prethodno && prethodno.ukupno >= 5 ? PROZOR_KOLONA : PROZOR;   // kolona → duže gledanje radi brojanja prolazaka
    const kadrovi = await Promise.race([k.tip === 'hls' ? ffmpegKadrovi(k.url, prozor) : jpgKadrovi(k.url, prozor), cuvar]).finally(() => clearTimeout(tajmer));
    // zamrznut strim: HLS koji umesto 30–90 s da samo 1–2 kadra (< 5 s) ne ide uživo – Preševo izlaz je od 22.09. vrteo isti
    // hakovani kadar sa 7 auta i sajt je 3 dana prikazivao kolonu koje nema. Merenje se upisuje kao greška (ok = 0).
    if (k.tip === 'hls' && prozor >= 20 && kadrovi[kadrovi.length - 1].t - kadrovi[0].t < 5) throw new Error('strim zamrznut – kamera ne ide uživo');
    // brza detekcija (mali model, bez zuma/pločica) na svim kadrovima za praćenje prolaska kroz liniju; kadar koji se broji (medijana) ide kroz punu detekciju
    const rez = []; for (const kd of kadrovi) rez.push({ buf: kd.buf, t: kd.t, r: await detektuj(kd.buf, k, true) });
    const zahtev = path.join(DIR_PROVERA, k.id + '.zahtev'), provera = fs.existsSync(zahtev);
    if (provera) { k._trag = []; k._dnevnik = []; }
    const tok = protok(rez, k);                                   // prelasci linije šaltera, kretanje kolone
    if (provera) {
      try { await montaza(rez, k, tok); log('provera brojanja sačuvana:', k.id); } catch (e) { log('provera brojanja greška:', k.id, e.message); }
      finally { delete k._trag; delete k._dnevnik; fs.rmSync(zahtev, { force: true }); }
    }
    const poBroju = rez.slice().sort((a, b) => a.r.vozila.length - b.r.vozila.length);
    { const s = poBroju[Math.floor(poBroju.length / 2)]; s.r = await detektuj(s.buf, k); }
    const sred = poBroju[Math.floor(poBroju.length / 2)];         // medijana po broju vozila – otporno na zamućen kadar
    const br = { auto: 0, autobus: 0, kamion: 0, motor: 0 }; sred.r.vozila.forEach((v) => { br[v.kl]++; });
    await nacrtaj(sred.buf, sred.r, k, br, tok);
    try { const f = path.join(DIR_SLIKE, k.id + '.sirov.jpg'); fs.writeFileSync(f + '.tmp', sred.buf); fs.renameSync(f + '.tmp', f); } catch (e) { /* sirov kadar je samo za admin crtanje */ }
    upis.run(k.id, dan, sat, br.auto, br.autobus, br.kamion, br.motor, sred.r.vozila.length, Date.now() - t0, kadrovi.length, 1, null);
    db.prepare('UPDATE kamere_merenja SET dubina = ?, protok = ?, proslo = ?, brzina = ?, prozor = ?, pomereno = ? WHERE id = (SELECT MAX(id) FROM kamere_merenja WHERE kamera = ?)').run(sred.r.dubina, tok.protok, tok.proslo, tok.brzina, tok.prozor, tok.pomereno, k.id);
    const pc = proceni(db, k, null); if (pc) db.prepare('UPDATE kamere_merenja SET cekanje = ?, cekanje_plus = ? WHERE id = (SELECT MAX(id) FROM kamere_merenja WHERE kamera = ?)').run(pc.minuta, pc.plus ? 1 : 0, k.id);
    return { id: k.id, ukupno: sred.r.vozila.length, proslo: tok.proslo, br, ms: Date.now() - t0 };
  } catch (e) {
    upis.run(k.id, dan, sat, 0, 0, 0, 0, 0, Date.now() - t0, 0, 0, String(e.message).slice(0, 300));
    return { id: k.id, greska: e.message.slice(0, 120) };
  }
}
async function krug() {
  if (KAMERE.osvezi()) log('učitane zone kamera (admin izmene: ' + KAMERE.filter((k) => k.izmena).map((k) => k.id).join(', ') + ')');
  const filter = (process.env.KAMERE_SAMO || '').split(',').map((s) => s.trim()).filter(Boolean);
  const lista = KAMERE.filter((k) => !filter.length || filter.includes(k.id));
  const t0 = Date.now(); const rez = [];
  let i = 0; const radnik = async () => { while (i < lista.length) { const k = lista[i++]; rez.push(await obradi(k)); } };
  await Promise.all(Array.from({ length: Math.min(PARALELNO, lista.length) }, radnik));   // KAMERE_PARALELNO (21) kamera odjednom (2 runde): snimanje traje 30–90 s po kameri, krug mora ostati ispod 5 min
  log(`krug gotov za ${((Date.now() - t0) / 1000).toFixed(1)} s: ` + rez.map((r) => r.id + '=' + (r.greska ? 'GREŠKA(' + r.greska + ')' : r.ukupno + (r.proslo ? '/' + r.proslo + '↦' : ''))).join(', '));
  // čišćenje: sirova merenja starija od 400 dana
  db.prepare("DELETE FROM kamere_merenja WHERE vreme < datetime('now', '-400 days')").run();
}
/* Dopuna: merenja bez upisanog čekanja (od pre ove verzije) dobiju procenu „na taj trenutak“ */
function dopuniCekanje() {
  osveziKolone();
  const redovi = db.prepare('SELECT id, kamera, vreme FROM kamere_merenja WHERE ok = 1 ORDER BY id').all();   // sve, novom logikom
  if (!redovi.length) return;
  const up = db.prepare('UPDATE kamere_merenja SET cekanje = ?, cekanje_plus = ? WHERE id = ?');
  const tx = db.transaction(() => { for (const r of redovi) { const k = KAMERE.find((x) => x.id === r.kamera); if (!k) continue; const pc = proceni(db, k, r.vreme); if (pc) up.run(pc.minuta, pc.plus ? 1 : 0, r.id); } });
  tx(); log('dopunjeno čekanje za', redovi.length, 'starih merenja');
}

async function glavni() {
  dopuniCekanje();
  await model(); await model(MODEL_BRZI);
  if (process.env.KAMERE_JEDNOM) { await krug(); process.exit(0); }
  log(`Kamere: ${KAMERE.length} kamera, svakih ${INTERVAL_MIN} min, prag ${PRAG}`);
  let zvanicnoOd = 0;
  for (;;) {
    const pocetak = Date.now();
    if (pocetak - zvanicnoOd >= 14 * 60000) {   // zvanično čekanje (MUP RH sa hak.hr, mađarska policija) – na svakih 15 min, za poređenje i prikaz
      zvanicnoOd = pocetak;
      try { const z = await zvanicno.osvezi(); log('zvanično: ' + Object.entries(z).map(([i, r]) => i + ' ' + (r.greska ? 'GREŠKA ' + r.greska : r.novih + '/' + r.redova)).join(', ')); } catch (e) { log('zvanično greška:', e.message); }
    }
    // pas: ako krug i pored čuvara po kameri visi 10 min, ubij decu (ffmpeg) i izađi – PM2 odmah podiže radnik
    const pas = setTimeout(() => { log('krug visi 10 min – restart radnika'); try { require('node:child_process').execFileSync('pkill', ['-9', '-P', String(process.pid)]); } catch (e) { /* nema dece */ } process.exit(1); }, 10 * 60000);
    try { await krug(); } catch (e) { log('greška kruga:', e.message); } finally { clearTimeout(pas); }
    const cekaj = Math.max(15000, INTERVAL_MIN * 60000 - (Date.now() - pocetak));
    await new Promise((r) => setTimeout(r, cekaj));
  }
}
process.on('SIGTERM', () => process.exit(0));
if (require.main === module) glavni().catch((e) => { console.error(e); process.exit(1); });
module.exports = { obradi, krug, detektuj, detektujJedan, nacrtaj, protok };
