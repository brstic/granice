/* server.js — granice.sparkcan.com: stanje na graničnim prelazima Srbije (kamere, procena čekanja, planer puta, statistika)
   i admin za jednog administratora (fiksni nalog iz .env: ADMIN_KORISNIK / ADMIN_LOZINKA).
   Radnik koji snima kamere je poseban proces: server/kamere.js (PM2: granice-kamere). */
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

/* .env (KLJUC=vrednost) */
const envPutanja = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPutanja)) for (const red of fs.readFileSync(envPutanja, 'utf8').split('\n')) {
  const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(red);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const express = require('express');
const db = require('./db');

const PORT = Number(process.env.PORT) || 3090;
const KOREN = path.join(__dirname, '..', 'public');
const ADMIN_KORISNIK = process.env.ADMIN_KORISNIK || 'admin';
const ADMIN_LOZINKA = process.env.ADMIN_LOZINKA || '';
const TAJNA = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');   // bez .env: sesije važe do restarta
if (!ADMIN_LOZINKA) console.warn('ADMIN_LOZINKA nije podešena u .env – admin je zaključan.');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin'); res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});

/* ---------- ograničenje pokušaja po IP adresi (u memoriji) ---------- */
const pokusaji = new Map();
function ogranici(maks, prozorMin) {
  return (req, res, next) => {
    const k = req.path + '|' + req.ip, sad = Date.now(), z = pokusaji.get(k) || { n: 0, od: sad };
    if (sad - z.od > prozorMin * 60e3) { z.n = 0; z.od = sad; }
    z.n++; pokusaji.set(k, z);
    if (z.n > maks) return res.status(429).json({ greska: 'Previše pokušaja. Sačekajte ' + prozorMin + ' minuta pa pokušajte ponovo.' });
    next();
  };
}
setInterval(() => { const sad = Date.now(); for (const [k, z] of pokusaji) if (sad - z.od > 3600e3) pokusaji.delete(k); }, 600e3).unref();
app.use('/api/granice/ruta', ogranici(60, 15));
app.use('/api/granice/mesta', ogranici(600, 15));

/* ---------- admin: jedan fiksni nalog, sesija u potpisanom kolačiću (30 dana) ---------- */
const potpis = (v) => crypto.createHmac('sha256', TAJNA).update(v).digest('base64url');
const jednako = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
function kolacici(req) { const o = {}; for (const d of (req.headers.cookie || '').split(';')) { const i = d.indexOf('='); if (i > 0) o[d.slice(0, i).trim()] = decodeURIComponent(d.slice(i + 1).trim()); } return o; }
function sesija(req) {
  const [istek, sig] = String(kolacici(req).granice_admin || '').split('.');
  if (!istek || !sig || !jednako(sig, potpis('admin.' + istek)) || Number(istek) < Date.now()) return null;
  return { email: ADMIN_KORISNIK };
}
app.use((req, res, next) => { req.korisnik = sesija(req); next(); });
const zahtevaPrijavu = (req, res, next) => (req.korisnik ? next() : res.status(401).json({ greska: 'Niste prijavljeni.' }));
const jeAdmin = (req, res, next) => next();   // jedini nalog je admin
const SECURE = process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === '1' : process.env.NODE_ENV === 'production';   // COOKIE_SECURE=0 za http bez TLS-a (lokalno, Docker)
const postaviKolacic = (res, vrednost, maxAge) => res.setHeader('Set-Cookie', `granice_admin=${vrednost}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${SECURE ? '; Secure' : ''}`);

app.post('/api/admin/prijava', ogranici(10, 15), (req, res) => {
  const { korisnik, lozinka } = req.body || {};
  if (!ADMIN_LOZINKA || !jednako(String(korisnik || '').trim().toLowerCase(), ADMIN_KORISNIK.toLowerCase()) || !jednako(String(lozinka || ''), ADMIN_LOZINKA)) return res.status(401).json({ greska: 'Pogrešno korisničko ime ili lozinka.' });
  const istek = Date.now() + 30 * 86400e3;
  postaviKolacic(res, istek + '.' + potpis('admin.' + istek), 30 * 86400);
  res.json({ ok: true });
});
app.post('/api/admin/odjava', (req, res) => { postaviKolacic(res, '', 0); res.json({ ok: true }); });
app.get('/api/admin/ja', (req, res) => res.json({ admin: !!req.korisnik, korisnik: req.korisnik ? ADMIN_KORISNIK : null }));

require('./granice')(app, { db, zahtevaPrijavu, jeAdmin });

/* stanje radnika i rutiranja za admin pregled */
app.get('/api/admin/stanje', zahtevaPrijavu, async (req, res) => {
  let osrm = false; try { const r = await fetch((process.env.OSRM_URL || 'http://127.0.0.1:5055') + '/nearest/v1/driving/20.46,44.81', { signal: AbortSignal.timeout(3000) }); osrm = r.ok; } catch (e) { /* ne radi */ }
  const t = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'kamere_merenja'").get();
  const m = t ? db.prepare("SELECT COUNT(*) AS n, MIN(vreme) AS od, MAX(vreme) AS do FROM kamere_merenja").get() : { n: 0 };
  const sat = t ? db.prepare("SELECT SUM(ok) AS ok, COUNT(*) AS n FROM kamere_merenja WHERE vreme >= datetime('now', '-1 hour')").get() : { ok: 0, n: 0 };
  res.json({ osrm, merenja: m.n, od: m.od, do: m.do, poslednjiSat: sat, mestaDb: fs.existsSync(path.join(__dirname, '..', 'data', 'mesta.db')), radiOd: new Date(Date.now() - process.uptime() * 1000).toISOString(), node: process.version });
});

/* ---------- strane ---------- */
const BLOK = /^\/(server|deploy|data|node_modules)(\/|$)|\.(md|sh|db|zip|env)$/i;
app.use((req, res, next) => (BLOK.test(req.path) ? res.status(404).end() : next()));
app.get('/statistika-granica', (req, res) => res.redirect(301, '/statistika' + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '')));
app.get('/stanje-na-granicama', (req, res) => res.redirect(301, '/'));
app.use(express.static(KOREN, { dotfiles: 'deny', extensions: ['html'], index: 'index.html' }));
app.use((req, res) => (req.path.startsWith('/api/') ? res.status(404).json({ greska: 'Nema.' }) : res.status(404).sendFile(path.join(KOREN, '404.html'))));

const HOST = process.env.HOST || '127.0.0.1';   // iza reverse proxy-ja; u Docker-u 0.0.0.0
app.listen(PORT, HOST, () => console.log('Granice radi na ' + HOST + ':' + PORT));
