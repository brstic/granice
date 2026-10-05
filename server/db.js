/* db.js — SQLite baza granica (jedan fajl u data/granice.db): merenja sa kamera. Tabelu pravi radnik (kamere.js). */
const Database = require('better-sqlite3');
const path = require('node:path');
const fs = require('node:fs');

const DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DIR, { recursive: true });
const db = new Database(path.join(DIR, 'granice.db'));
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');   // sajt i radnik pišu u istu bazu

module.exports = db;
