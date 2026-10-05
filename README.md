# Granice Srbije

**Koliko se čeka na granici, procenjeno sa javnih kamera.** Uživo: **https://granice.sparkcan.com**

> *English:* Live wait-time estimates for Serbian border crossings. The system reads public border cameras (MUP/AMSS Serbia, HAK Croatia), counts cars with a local YOLOv10 model and estimates queue time. It also has a trip planner that picks the fastest crossing (self-hosted OSRM) and congestion statistics. Fully self-hosted: Node.js + SQLite, no external APIs or SaaS. The docs are in Serbian, and the commands below work as-is.

---

## Šta radi

- **Stanje na prelazima.** 41 javna kamera na 18 prelaza (Horgoš, Batrovci, Gradina, Preševo, Kelebija, Šid…). Svakih 5 minuta sistem izbroji automobile u koloni i prolaske kroz kontrolu, pa izračuna čekanje za ulaz i za izlaz.
- **Obe strane granice.** Na prelazima sa Hrvatskom (HAK kamere) i Mađarskom (police.hu) čekanja na obe kontrole se sabiraju, npr. „HR 25 + SRB 10 min“.
- **Zvanični podaci uporedo.** MUP RH (hak.hr) i mađarska policija prikazuju se pored naše procene, a admin vidi koliko odstupamo.
- **Planer puta „Kuda putujete?“.** Za izabrano polazište i odredište računa vožnju i očekivano čekanje u trenutku dolaska na svaki prelaz, pa predlaže najbrži.
- **Statistika.** Tipična gužva po danu i satu, za svaki prelaz.
- **Admin.** Iscrtavanje zona po kameri (kolona, linija šaltera, rep kolone), stanje sistema i alat „Proveri brojanje“ (montaža kadrova sa stazama vozila).

## Kako radi

```
javne kamere (HLS / JPEG)
      │  ffmpeg: 30–90 s snimka po kameri
      ▼
server/kamere.js  ── YOLOv10 (onnxruntime, lokalno) ── praćenje vozila + brojanje prolazaka kroz liniju šaltera
      │
      ▼
SQLite (data/granice.db) ── server/procena.js: protok × dužina kolone → čekanje
      │
      ▼
server/server.js (Express) ── stranice, API, admin ── planer: sopstveni OSRM (Docker) + data/mesta.db
```

Detaljno (algoritam brojanja, procena, izvori kamera, zamke): **[docs/ARHITEKTURA.md](docs/ARHITEKTURA.md)**.

---

## Brzo pokretanje

### Docker (najlakše: Linux, macOS, Windows)

```sh
git clone https://github.com/brstic/granice.git
cd granice
cp .env.example .env
```
U `.env` upiši bar:
```ini
ADMIN_LOZINKA=neka-jaka-lozinka
SESSION_SECRET=<izlaz komande: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))">
```
Na laptopu smanji opterećenje (vidi [Podešavanja](#podešavanja)):
```ini
KAMERE_PARALELNO=3
KAMERE_MODEL=yolov10m
```
Pokreni:
```sh
docker compose up -d --build
docker compose logs -f kamere
```
Otvori **http://localhost:3090** (admin: http://localhost:3090/admin).
Prvi krug traje nekoliko minuta: radnik prvo preuzme YOLO modele (~200 MB, u `./data/modeli`), a onda obiđe kamere. Do tada je strana prazna.

Zaustavljanje: `docker compose down`. Podaci ostaju u `./data`.

### Bez Docker-a (Node.js)

Potrebno je **Node.js ≥ 18** i **ffmpeg** (`brew install node ffmpeg` ili `sudo apt install nodejs npm ffmpeg`).

```sh
git clone https://github.com/brstic/granice.git
cd granice
npm install
cp .env.example .env     # popuni ADMIN_LOZINKA i SESSION_SECRET; lokalno dodaj i COOKIE_SECURE=0
npm start                # sajt: http://localhost:3090
npm run kamere           # u drugom terminalu: radnik koji snima kamere
```

Za probu nad samo jednom ili dve kamere, uz jedan krug i izlaz:
```sh
KAMERE_SAMO=horgos-ulaz,horgos-izlaz KAMERE_JEDNOM=1 npm run kamere
```

---

## Deployment (sopstveni server)

Kompletan vodič je u **[docs/DEPLOY.md](docs/DEPLOY.md)**: zahtevi, Docker Compose ili Node + PM2, nginx/Caddy i HTTPS, OSRM, backup, ažuriranje i zamke. Ukratko, za Node + PM2:

```sh
# na serveru, kao korisnik koji pokreće aplikaciju
git clone https://github.com/brstic/granice.git app && cd app
npm ci --omit=dev
cp .env.example .env && nano .env
pm2 start deploy/ecosystem.config.js && pm2 save && pm2 startup
# reverse proxy (nginx/Caddy) sa HTTPS-om → 127.0.0.1:3090
```

Ažuriranje:
```sh
git pull && npm ci --omit=dev && node --check server/*.js && pm2 restart granice granice-kamere
```

Bez git-a na serveru: `sh deploy/pakuj.sh` napravi `granice.zip` (posle provere sintakse). Zip se raspakuje preko foldera na serveru, a `data/` i `.env` ostaju.

---

## Podešavanja

Sva podešavanja su u `.env` (šablon: [`.env.example`](.env.example)).

| Promenljiva | Podrazumevano | Značenje |
|---|---|---|
| `PORT` / `HOST` | `3090` / `127.0.0.1` | adresa sajta (Docker sam postavlja `0.0.0.0`) |
| `ADMIN_KORISNIK` / `ADMIN_LOZINKA` | `admin` / — | jedini nalog za `/admin`; bez lozinke je admin zaključan |
| `SESSION_SECRET` | nasumično | potpis sesije; bez njega se posle restarta ponovo prijavljuješ |
| `COOKIE_SECURE` | `1` u produkciji | `0` kad sajt radi preko http-a (lokalno) |
| `OSRM_URL` | `http://127.0.0.1:5055` | OSRM za planer puta |
| `KAMERE_INTERVAL_MIN` | `5` | krug radnika na svakih N minuta |
| `KAMERE_PARALELNO` | `21` | koliko kamera se snima i obrađuje odjednom |
| `KAMERE_NITI` | jezgra/6 (2–8) | niti onnxruntime-a po modelu |
| `KAMERE_MODEL` / `KAMERE_MODEL_BRZI` | `yolov10x` / `yolov10m` | model za kadar koji se broji / za praćenje (`yolov10n,s,m,b,l,x`) |
| `KAMERE_SAMO` | sve | lista ID-jeva kamera, npr. `horgos-ulaz,batrovci-izlaz` |
| `KAMERE_JEDNOM` | — | `1` = jedan krug pa izlaz (proba) |
| `KAMERE_PROZOR` / `KAMERE_PROZOR_KOLONA` | `30` / `90` | sekundi gledanja po kameri (bez kolone / sa kolonom) |
| `KAMERE_PRAG` | `0.18` | najmanja pouzdanost detekcije |

**Opterećenje.** Pri podrazumevanim podešavanjima radnik je napravljen za jak server: 21 kamera paralelno, svaka 30–90 s video snimka, detekcija na svakom kadru. Na slabijoj mašini smanji `KAMERE_PARALELNO` i `KAMERE_NITI`, uzmi `KAMERE_MODEL=yolov10m` (ili `s`), produži `KAMERE_INTERVAL_MIN` ili ograniči kamere sa `KAMERE_SAMO`. Ako krug traje duže od intervala, sledeći kreće 15 s posle završetka prethodnog.

---

## Planer puta (opciono)

Planer koristi sopstveni [OSRM](https://github.com/Project-OSRM/osrm-backend) nad OpenStreetMap mapama 14 zemalja (Srbija i region). Graf se pravi jednom (~1 h, ~13 GB RAM, ~15 GB diska) i osvežava mesečno:

```sh
# treba: docker, osmium-tool, node + npm install
sh deploy/osrm/pripremi.sh                                         # podigne i kontejner granice-osrm na 127.0.0.1:5055
# ili, uz docker compose:
OSRM_POKRENI=0 sh deploy/osrm/pripremi.sh && docker compose --profile planer up -d
```
Bez OSRM-a sve ostalo radi, a samo planer javlja da trenutno nije dostupan. Detalji su u [docs/DEPLOY.md](docs/DEPLOY.md#planer-puta-osrm).

---

## Struktura

```
server/
  server.js        Express: stranice, admin prijava, rate limit, /api/admin/stanje
  granice.js       API: stanje prelaza, kamere, statistika, admin zone
  kamere.js        radnik: snimanje kamera, YOLO detekcija, praćenje, brojanje, upis merenja
  kamere-lista.js  spisak 41 kamere sa podrazumevanim zonama (admin izmene se preklapaju preko njih)
  procena.js       procena čekanja (zajednička za stanje, statistiku i planer)
  zvanicno.js      zvanično čekanje: MUP RH (hak.hr), mađarska policija (police.hu)
  planer.js        „Kuda putujete?“ – rute preko OSRM-a, izbor prelaza
  db.js            SQLite (better-sqlite3)
public/            index.html (stanje + planer), statistika.html, admin.html, …
deploy/            ecosystem.config.js (PM2), pakuj.sh, backup.sh, osrm/pripremi.sh + mesta.js
data/              (nije u gitu) granice.db, kamere/ (poslednji kadrovi), modeli/, mesta.db, kamere-podesavanja.json
Dockerfile, docker-compose.yml
```

## Podaci i odgovornost

- Kamere su javni strimovi MUP-a/AMSS-a i HAK-a, a zvanična čekanja su javno objavljeni podaci MUP RH i mađarske policije. Projekat ih samo čita, u razmaku od nekoliko minuta. Ne povećavaj učestalost i poštuj uslove korišćenja izvora.
- Procena je **procena**: kamera ne vidi celu kolonu, a brojač ponekad ne vidi sve prolaske. Za važne odluke proveri i zvanične izvore.
- Detekcija radi potpuno lokalno, bez slanja slika ikome. Model se jednom preuzme sa Hugging Face-a ([onnx-community/yolov10](https://huggingface.co/onnx-community)).
