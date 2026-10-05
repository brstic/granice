# Arhitektura – granice.sparkcan.com

Stanje na graničnim prelazima Srbije: javne kamere → broj automobila (YOLOv10 lokalno, onnxruntime-node) → procena čekanja,
statistika gužvi i planer puta „Kuda putujete?“ sa sopstvenim OSRM-om. Sve self-hosted, bez spoljnih servisa.

## Delovi
- `server/server.js` – Express (port 3090): statika iz `public/`, admin prijava (jedan nalog iz `.env`, sesija = potpisan kolačić 30 dana), rate limit za planer, `/api/admin/stanje`, blokira `/server|deploy|data`, `*.md|sh|db|zip|env`.
- `server/granice.js` – API: `/api/granice` (tabela prelaza), `/api/granice/kamere` (poslednje merenje, 24 h, tipično za sat, nivo, trend), `/api/granice/kamera/:id.jpg`, `/api/granice/statistika?prelaz=` i `/statistika/prelazi`; admin: `PUT /api/admin/granice`, `/api/admin/kamere` (GET/PUT/DELETE zona po kameri, `kadar.jpg`).
- `server/kamere-lista.js` – spisak kamera (41 kamera, 18 prelaza) sa podrazumevanim zonama; admin izmene iz `data/kamere-podesavanja.json` se preklapaju preko njih (**admin izmena pobeđuje** – proveri pre izmene zone u kodu).
- `server/kamere.js` – radnik (PM2 `granice-kamere`): krug svakih 5 min, snima kamere, detektuje, broji prolaske, upisuje u `kamere_merenja`, čuva `data/kamere/<id>.jpg` (anotiran) i `<id>.sirov.jpg` (za crtanje u adminu).
- `server/procena.js` – zajednička procena čekanja (stanje, statistika, planer).
- `server/planer.js` – „Kuda putujete?“: `/api/granice/mesta`, `/api/granice/ruta`; `PRELAZI` = tačka + kurs izlaska po prelazu.
- `public/` – `index.html` (stanje + planer), `statistika.html`, `admin.html` (tabovi Kamere i Stanje sistema), `privatnost.html`, sitemap/robots.
- `deploy/` – `pakuj.sh`, `backup.sh`, `ecosystem.config.js`, `osrm/pripremi.sh` + `osrm/mesta.js`.

## Izvori kamera
- MUP/AMSS: `kamere.amss.org.rs/<id>/<id>.m3u8` (Horgoš, Batrovci, Gradina, Preševo). AMSS glavni sajt blokira botove – ne skrejpovati.
- MUP direktno: `kamere.mup.gov.rs:4443/<Folder>/<ime>N.m3u8` – Đala, Kelebija, Jabuka, Gostun, Špiljani, Šid, Vatin, Kotroman, Mali Zvornik, Sremska Rača, Trbušnica, Vrška Čuka. Spisak: mup.gov.rs → Kamere → „Kamere na graničnim prelazima“ (curl sa browser UA).
- HAK: `hak.hr/info/kamere/<id>.jpg` (Bajakovo, Tovarnik, Ilok, Batina), hrvatska strana (`hr: true`). **Smer po strelicama na kadru**: „▼ SRB ▼“ = ulaz u Srbiju (Bajakovo 1 i 3, Tovarnik 1, Ilok 1, Batina 1), „▼ HR ▼“ = izlaz iz Srbije (Bajakovo 2, Tovarnik 2, Ilok 2, Batina 2). Na svima kolona ide ka kameri (linija `dole`, rep `gore`). Do 25.09.2026 su sve vođene kao ulaz.
- **Broj strima ≠ smer**: na Đali i Kotromanu 1 = izlaz, 2 = ulaz – istina je natpis u dnu sirovog kadra.
- Hakovane (vandalski natpis): Preševo, Jabuka ulaz, Špiljani izlaz. Sremska Rača ulaz povremeno 404.
- Tabela prelaza sadrži **samo prelaze sa kamerama** (Brankova odluka 22.09.).

## Detekcija i brojanje
- Broje se **samo automobili** (`KLASE = { 2: 'auto' }`) – kamioni/autobusi/motori ignorisani od 22.09. ~16:10 (parkirani kamioni su pravili lažnu kolonu).
- Praćenje kroz sve kadrove: **yolov10m**; veliki **x** model samo za kadar koji se broji (medijana). Kadrovi ≥ 1000 px (HAK) dobijaju pločice u 3 nivoa samo na tom kadru.
- Prozor gledanja 30 s, **90 s kad je prošlo merenje imalo ≥ 5 vozila** (`KAMERE_PROZOR_KOLONA`). Krug mora biti < 300 s (22.09. ~218 s).
- Brojač prolazaka: Mađarski algoritam (pomak + boja vozila), bez pomaka unazad, stanje ispred/iza linije šaltera; `pomereno` = udeo vozila koja su se pomerila.
- **HAK (kadar na ~10 s)**: staza se ne prenosi na vozilo druge boje (razlika > 0,2) – vozilo iza zauzme mesto onog koje je prošlo; „druga šansa“: staza izgubljena tik ispred linije + novo vozilo tik iza nje (≤ 1,6 R) = prolazak. Snimak 25.09. (5 min): Bajakovo 2 1 → 2, Bajakovo 3 3 → 5; stvarno ~2/min – vozila zaklonjena u gustoj koloni se ne mogu pratiti, pa HAK procena i dalje ima pod = pun kapacitet. Na MUP kamerama isključeno (u magli dodavalo neproverljive prolaske).
- Zone po kameri (crta ih Branko u adminu): zona kolone, linija šaltera (duž sa smerom), rep kolone (`puno`), zum isečci.

## Procena čekanja (`server/procena.js`)
- Protok: prior T0 = 3 min, težina prozora e^(−starost/45 min) preko 3 h, prior iz sopstvene istorije 7 dana (samo redovi sa `pomereno IS NOT NULL`, ≥ 20 min gledanja) inače konfiguracija (minPoVozilu 2,0–2,5). Protok se uči samo iz prozora sa ≥ 4 vozila.
- **Pod protoka** `rMin = trake / (2 · minPoVozilu)`, za HAK (JPEG) kamere `trake / minPoVozilu` (brojač na kadrovima od 5–10 s ne vidi deo prolazaka; MUP RH „do 30 min“ vs naših 70) (i za prior i za rezultat): brojač koji ne vidi prolaske (pogrešan smer linije, retki HAK kadrovi) je davao 0,05/min → 3 auta = 60 min (25.09.).
- Prozor u kome se kolona pomerala (`pomereno` ≥ 0,3), a nije izbrojan nijedan prolazak, ne ulazi u protok ni u prior (promašaj brojača, najčešće HAK).
- **Parkirano**: < 15 vozila, 30+ min (≥ 5 merenja) isti broj ±1, niko ne prođe liniju i `pomereno` ≤ 0,2 (bar jednom izmereno) → nije kolona. Blaža verzija (15 min, bez uslova za broj) je 25.09. poništila pravu kolonu koja stoji (Gostun izlaz 3 → 11 auta), N = 0 (`parkirano` u odgovoru; Batina 1 = auto-transporteri).
- **Auto-transporteri** (kamera sa `transporteri: true`, sada samo Batina 1): kamioni/autobusi (COCO 5, 7, pouzdanost ≥ 0,4) se detektuju samo da bi se izbacila auta čija je donja sredina na kamionu (≥ 15 % visine iznad njegovog dna). Nije uključeno svuda: auto u susednoj traci pored autobusa izgleda isto (Gostun izlaz). Iz daljine model vidi samo kabinu, pa je na Batini 1 zona svedena na trake za auta (desno od šrafure, do y 0,29).
- **Zamrznut strim**: HLS sa < 5 s kadrova umesto 30–90 s → greška, `ok = 0` (Preševo izlaz je od 22.09. vrteo hakovan kadar sa 7 auta).
- n ≤ trake → čekanje = jedna obrada. „Kolona stoji“ samo uz ≥ 6 auta i izmereno `pomereno`.
- Kolona van kadra: vidljivo × 1,5 + 0,25 po satu neprekidno pune kolone (max 2×, do 25.09. 3×), gornja granica 6 h. Linija repa važi samo na strani repa (rep gore → y ≤ 0,6, rep dole → y ≥ 0,4) – rep „dole“ nacrtan pri vrhu je značio „puno“ čim ima 4 auta.
- **Uvek konkretan broj** („≈ 45 min“, „1 h 20 min“), nikad „N+“. Kad nema svežeg merenja: poslednja poznata procena (do 12 h, „pre N min“) ili tipična za taj sat – strana nikad ne sme da bude prazna.
- **Više kamera istog prelaza/smera**: na svakoj strani granice (HAK = hrvatska kontrola, MUP = srpska) uzima se najveća procena (ista kolona), a strane se **sabiraju** – čeka se redom na obe kontrole (Batrovci, Šid). Sabiraju se samo strane iste svežine (sveže + sveže); `delovi` u `poPrelazu`, na strani „HR 45 + SRB 10 min“. Isto u statistici (po krugu od 5 min) i u profilu planera. Od 25.09.
- **Skala gužve**: mirno ≤ 10 min, umereno ≤ 20, gužva ≤ 30, velika gužva > 30 – svuda ista (stanje, statistika, planer, nivo kamere).
- Merenja pre 2026-09-22 14:10 UTC su `ok = 0` (isključena iz statistike). Takođe `ok = 0`: Preševo izlaz od 22.09. 14:00 UTC (zamrznut strim) i Batina 1 do 25.09. 09:58 UTC (stara zona je brojala auta na auto-transporterima) – razlog je u koloni `greska`. Zaključci po satu/danu tek posle ≥ 2 dana podataka.

## Zvanično čekanje (MUP RH preko HAK, mađarska policija)
- `server/zvanicno.js`: radnik na svakih 15 min čita `hak.hr/info/stanje-na-cestama/` (tabela „Čekanje na graničnim prijelazima“, Srbija – Hrvatska: Bajakovo, Tovarnik, Ilok, Batina; kolone Ulaz/Izlaz × auto/kamion iz ugla HR – ulaz u HR = izlaz iz Srbije) → tabela `zvanicno_merenja` (grube kategorije, `minuta` = gornja granica: „do 30 min“ = 30). Datum u tooltipu dolazi u dva formata („25.09.2026 12:04:37“ i „25.9.2026. 9:54:31“).
- Mađarska policija: `police.hu/hu/hirek-es-informaciok/hatarinfo?field_hat_rszakasz_value=szerb határszakasz` – paneli po prelazu (Röszke–Horgoš autópálya → Horgoš, Tompa–Kelebia → Kelebija, Tiszasziget–Đala → Đala); „felől (ki)“ = ulaz u Srbiju, „felé (be)“ = izlaz iz Srbije; `<div class="szgk">` = auta, inače jedan tekst za sve; „Nincs 15 percet meghaladó várakozás“ = do 15 min. Bez vremena objave → upisuje se vreme preuzimanja. **Vreme važi samo za mađarsku kontrolu** (police.hu to piše; zajednička kontrola je samo na starom putu Röszke–Horgoš i manjim prelazima, ne na auto-putu) → sveže (≤ 30 min) ulazi u zbir na stanju kao strana `hu` („SRB 1 + HU 30 min“; „do 15 min“ = 0), ne u admin poređenje.
- Stanje: `poPrelazu[].zvanicno` (lista po izvoru, auta, ≤ 3 h), na strani u detaljima prelaza „Zvanično: …“. Ne ulazi u procenu.
- Admin → Stanje sistema → „Mi vs. zvanično“ (`/api/admin/kalibracija`): uz svaki zvanični podatak naša procena ±5 min (MUP RH → samo HAK kamere, HU → sve kamere prelaza), medijana odnosa po prelazu/smeru. Prvi podatak 25.09. 12:04: Batrovci izlaz MUP RH „do 30 min“, mi 70 min (odnos 2,3) → posle nekoliko dana podataka odrediti korekciju za HAK kamere.

## Planer puta
- Za svaki od 18 prelaza: vožnja do prelaza + čekanje u trenutku dolaska (sveže → tipično za dan/sat kako je dolazak dalji) + vožnja posle; poređenje sa najkraćom rutom. Tranzit bira par ulaz/izlaz u različite zemlje.
- OSRM (Docker `granice-osrm`, osrm-backend v5.27.1, MLD), 14 Geofabrik zemalja (RS, XK, HU, HR, BA, ME, MK, BG, RO, SI, AT, AL, GR, SK). `data/mesta.db` ~70.500 mesta + 98 gradova van mape preko „kapija“ (vazdušno ×1,25 pri 100 km/h).
- Đala samo za državljane EU (opcija „pasoš EU“). Tačke prelaza = OSM border_control + kurs ±70°. Sremska Rača ima asimetriju u OSM-u (nije naš bag).
- **Novi prelaz sa kamerom → dodati ga i u `PRELAZI` u `server/planer.js`** i proveriti rutom.

## Podešavanja (.env)
`KAMERE_INTERVAL_MIN`, `KAMERE_PARALELNO` (21), `KAMERE_NITI`, `KAMERE_PRAG`, `KAMERE_MODEL`, `KAMERE_MODEL_BRZI`, `KAMERE_PROZOR`, `KAMERE_PROZOR_KOLONA`, `KAMERE_JEDNOM=1` (jedan krug za probu), `KAMERE_SAMO=id,id`, `OSRM_URL`, `HOST`, `COOKIE_SECURE`. Docker: `Dockerfile` + `docker-compose.yml` (sajt, radnik, OSRM u profilu `planer`).

## Alat za proveru brojača
Admin → Kamere → „Proveri brojanje“: `POST /api/admin/kamere/:id/provera` ostavi `data/provera/<id>.zahtev`; radnik u sledećem krugu za tu kameru sačuva montažu kadrova (do 24) sa stazama (ID, žuto ispred linije / zeleno prošlo), linijom i oznakom „PROŠAO“ → `data/kamere/<id>.provera.jpg` + `.json`. Ručno (staro):
Snimi kadrove na serveru (`ffmpeg -i <m3u8> -vf fps=1 -frames:v 150 k%03d.jpg`), lokalno pokreni `detektuj` + `protok` uz `k._dnevnik` / `k._trag` (montaže sa ID-jevima staza) – tako je brojač verifikovan na Gostunu.
