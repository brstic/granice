# Deploy na sopstveni server

Vodič za produkciju na Linux serveru (primeri za Ubuntu/Debian). Za brzo lokalno pokretanje vidi [README](../README.md#brzo-pokretanje).
Dva puta, izaberi jedan:

- **A) Docker Compose**: najmanje posla, sve je u kontejnerima.
- **B) Node + PM2 direktno na serveru**: ovako radi granice.sparkcan.com.

U oba slučaja ispred aplikacije stoji reverse proxy sa HTTPS-om (nginx ili Caddy). Aplikacija sluša samo na `127.0.0.1:3090`.

---

## Šta je potrebno

| | Minimum | Preporučeno za svih 41 kameru na 5 min |
|---|---|---|
| CPU | 4 jezgra (uz `KAMERE_PARALELNO=2–4`, manji model) | 16+ jezgara |
| RAM | 2 GB (bez planera) | 8 GB; **pravljenje OSRM grafa traži ~13 GB** (jednom mesečno) |
| Disk | 2 GB | 10 GB + OSRM ~15 GB (mape + graf) |
| Softver | Node.js ≥ 18, ffmpeg | + Docker (OSRM), osmium-tool (pravljenje grafa) |

Radnik kamera (`server/kamere.js`) je najzahtevniji deo. Svakih 5 minuta skida 30–90 s video snimka sa svake kamere i nad kadrovima pušta YOLOv10 detekciju. Na jačoj mašini pri podrazumevanim podešavanjima može da zauzme desetine jezgara. Opterećenje se smanjuje ovim podešavanjima u `.env`: `KAMERE_PARALELNO`, `KAMERE_NITI`, `KAMERE_MODEL=yolov10m` (ili `s`/`n`), `KAMERE_INTERVAL_MIN` i `KAMERE_SAMO`. Sajt sam po sebi troši malo resursa.

---

## A) Docker Compose

```sh
git clone https://github.com/brstic/granice.git && cd granice
cp .env.example .env
# u .env upiši ADMIN_LOZINKA i SESSION_SECRET; iza HTTPS proxy-ja dodaj COOKIE_SECURE=1
docker compose up -d --build
docker compose logs -f kamere        # prvi put preuzima YOLO modele (~200 MB) u ./data/modeli
```

- Sajt je na `http://127.0.0.1:3090`. Port se menja sa `GRANICE_PORT=8080` u `.env`. Na javnom serveru ga ograniči na localhost (`"127.0.0.1:3090:3090"` u `docker-compose.yml`), pa ispred stavi proxy (vidi dole).
- Svi podaci su u `./data`: baza, kadrovi, modeli i zone iz admina. To je jedini folder koji treba čuvati.
- Ažuriranje: `git pull && docker compose up -d --build`.
- Planer puta: vidi [OSRM](#planer-puta-osrm). Graf se pravi sa `OSRM_POKRENI=0`, a pokreće sa `docker compose --profile planer up -d`.

---

## B) Node + PM2

### 1. Paketi
```sh
sudo apt update && sudo apt install -y ffmpeg git nginx
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash - && sudo apt install -y nodejs
sudo npm install -g pm2
```

### 2. Korisnik i kod
```sh
sudo adduser --disabled-password --gecos "" granice
sudo -iu granice
git clone https://github.com/brstic/granice.git app && cd app
npm ci --omit=dev
cp .env.example .env && nano .env      # ADMIN_LOZINKA, SESSION_SECRET (vidi komentar u fajlu)
```

### 3. PM2: sajt i radnik
```sh
pm2 start deploy/ecosystem.config.js   # pokreće „granice“ (sajt) i „granice-kamere“ (radnik)
pm2 save
pm2 startup                            # ispiše jednu sudo komandu – pokreni je da PM2 krene posle restarta servera
pm2 logs granice-kamere                # posle par minuta: „krug gotov za N s“ (N treba da bude < 300)
```
Radnik je nezavisan od sajta. Ako ti ne treba sveže merenje (ili kad opterećuje server), zaustavi ga sa `pm2 stop granice-kamere && pm2 save`. Sajt i dalje radi i prikazuje poslednje poznate i tipične vrednosti.

### 4. nginx + HTTPS
`/etc/nginx/sites-available/granice`:
```nginx
server {
    server_name granice.example.com;
    location / {
        proxy_pass http://127.0.0.1:3090;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```
```sh
sudo ln -s /etc/nginx/sites-available/granice /etc/nginx/sites-enabled/ && sudo nginx -t && sudo systemctl reload nginx
sudo apt install -y certbot python3-certbot-nginx && sudo certbot --nginx -d granice.example.com
```
Isto radi i sa Caddy-jem, u jednoj liniji: `granice.example.com { reverse_proxy 127.0.0.1:3090 }`.

### 5. Ažuriranje
```sh
sudo -iu granice
cd app && git pull && npm ci --omit=dev && pm2 restart granice granice-kamere
```
Druga mogućnost, bez git-a na serveru: lokalno pokreni `sh deploy/pakuj.sh`. Skripta proveri sintaksu svih `server/*.js` i napravi `granice.zip` bez `data/`, `.env` i dokumentacije. Zip prebaci na server, raspakuj preko postojećeg foldera (`unzip -o`) i restartuj PM2. `data/` i `.env` ostaju netaknuti.

---

## Planer puta (OSRM)

„Kuda putujete?“ računa rute preko sopstvenog [OSRM](https://github.com/Project-OSRM/osrm-backend) servera, na OpenStreetMap mapama za 14 zemalja regiona. Ovaj deo nije obavezan: bez njega planer javlja grešku, a ostatak sajta radi normalno.

```sh
sudo apt install -y osmium-tool docker.io
# iz foldera projekta (posle npm ci); traje ~1 h, vrh ~13 GB RAM, ~15 GB diska
OSRM_DIR=/srv/granice-osrm sh deploy/osrm/pripremi.sh
```
Skripta skine mape sa Geofabrika, napravi `data/mesta.db` (pretraga mesta) i OSRM graf. Zatim pokrene Docker kontejner `granice-osrm` na `127.0.0.1:5055`, što je i podrazumevani `OSRM_URL`.

- Skriptu pokrećeš kao root, a aplikacija radi kao korisnik `granice`? Dodaj `GRANICE_KORISNIK=granice`, da `mesta.db` pripadne tom korisniku.
- Uz Docker Compose dodaj `OSRM_POKRENI=0 OSRM_DIR=./osrm`. Skripta tada samo napravi graf u `./osrm/graf`, a OSRM pokreće compose (`--profile planer`).
- Mesečno osvežavanje mapa, root cron:
  ```
  30 3 2 * * cd /home/granice/app && OSRM_DIR=/srv/granice-osrm GRANICE_KORISNIK=granice sh deploy/osrm/pripremi.sh --osvezi > /var/log/granice-osrm.log 2>&1
  ```

---

## Backup
`deploy/backup.sh` pravi konzistentnu kopiju baze (`granice-YYYY-MM-DD.db.gz`) i zona iz admina, a čuva ih 30 dana u `$BACKUP_DIR` (podrazumevano `~/backups`). Cron korisnika `granice`:
```
25 3 * * * BACKUP_DIR=/home/granice/backups sh /home/granice/app/deploy/backup.sh
```
Najvredniji fajl je `data/kamere-podesavanja.json`: tu su zone koje si nacrtao u adminu.

---

## Provera posle deploya
```sh
curl -sI https://granice.example.com | head -1                       # 200
curl -s https://granice.example.com/api/granice/kamere | head -c 300  # JSON sa merenjima
pm2 status && pm2 logs granice-kamere --lines 30 --nostream
```
Admin (`/admin`) → tab **Stanje sistema** prikazuje broj merenja, poslednji sat, OSRM i `mesta.db`.

## Zamke
- **Sintaksna greška u `server/*.js` obara sajt.** Zato `deploy/pakuj.sh` pre pakovanja radi `node --check`. Ako ažuriraš git-om, pokreni `node --check server/*.js` pre restarta.
- **ffmpeg zna da ignoriše SIGTERM i visi.** Radnik ga zato ubija SIGKILL-om, svaka kamera ima čuvara od 3 min, a ako ceo krug visi 10 min, radnik izađe i PM2 ga podigne. Za to je potreban `pkill`, iz paketa procps.
- **Admin prijava ne radi preko http-a.** Uz `NODE_ENV=production` kolačić je `Secure`. Lokalno bez TLS-a postavi `COOKIE_SECURE=0`.
- **Zone kamera su podešene za postojeće kadrove.** Kad kamera promeni ugao, nacrtaj zonu ponovo u adminu (Kamere → zona kolone i linija šaltera), a zatim proveri rezultat alatom „Proveri brojanje“.
- `public/robots.txt`, `public/sitemap.xml` i `canonical` u HTML-u pokazuju na granice.sparkcan.com. Na svom domenu ih promeni.
