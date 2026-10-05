/* kamere-lista.js — javne kamere na graničnim prelazima koje radnik server/kamere.js snima i broji vozila.
   MUP Srbije / AMSS: HLS strimovi sa kamere.amss.org.rs (1 = ulaz u Srbiju, 2 = izlaz, redosled kao na njihovoj strani).
   HAK (Hrvatski autoklub): JPEG slike sa hrvatske strane prelaza prema Srbiji, osvežavaju se na 5–15 s.
   `roi` (opciono): poligon u relativnim koordinatama [0–1]; broje se samo vozila čija je donja ivica unutar njega. */
const MUP = (id, prelaz, drzava, smer, m3u8) => ({ id, prelaz, drzava, smer, prag: 0.15 /* 640×360, noću mutno – niži prag */, naziv: prelaz + (smer === 'ulaz' ? ' – ulaz u Srbiju' : ' – izlaz iz Srbije'), izvor: 'MUP Srbije / AMSS', tip: 'hls', url: 'https://kamere.amss.org.rs/' + m3u8 + '/' + m3u8 + '.m3u8' });
/* Ostali MUP prelazi (spisak sa mup.gov.rs → Kamere na graničnim prelazima, 22.09.2026): direktno sa kamere.mup.gov.rs:4443/<Folder>/<ime>N.m3u8, 704×576.
   Pažnja: broj strima NE znači uvek smer – na Đali i Kotromanu je 1 = izlaz, 2 = ulaz (proveren natpis na slici); zato se ime strima zadaje eksplicitno. */
const MUP2 = (id, prelaz, drzava, smer, folder, strim) => ({ id, prelaz, drzava, smer, prag: 0.15, naziv: prelaz + (smer === 'ulaz' ? ' – ulaz u Srbiju' : ' – izlaz iz Srbije'), izvor: 'MUP Srbije', tip: 'hls', url: 'https://kamere.mup.gov.rs:4443/' + folder + '/' + strim + '.m3u8' });
/* HAK kamere su na hrvatskoj strani. Smer se čita iz strelica na kadru: „▼ SRB ▼“ = vozila idu ka Srbiji (ulaz u Srbiju),
   „▼ HR ▼“ = vozila dolaze iz Srbije i čekaju ulaz u Hrvatsku (izlaz iz Srbije). Na svih 9 kamera kolona ide ka kameri (nadole).
   Do 25.09.2026 su sve vođene kao ulaz – Bajakovo 2, Tovarnik 2, Ilok 2 i Batina 2 su zapravo izlaz. */
const HAK = (id, prelaz, drzava, mesto, n, hakId, smer) => ({ id, prelaz, drzava, smer, hr: true, naziv: mesto + ' (HR strana) – kamera ' + n + (smer === 'ulaz' ? ' – ka Srbiji' : ' – iz Srbije'), izvor: 'HAK', tip: 'jpg', url: 'https://www.hak.hr/info/kamere/' + hakId + '.jpg' });

/* Zone kolone po kameri (relativne koordinate, ručno određene sa kadrova 21.09.2026): broje se samo vozila čija je donja ivica unutar poligona */
const ROI = {
  'horgos-ulaz': [[0.02, 0.98], [0.98, 0.98], [0.8, 0.5], [0.72, 0.1], [0.18, 0.1], [0.0, 0.45]],
  'horgos-izlaz': [[0.0, 0.98], [0.62, 0.98], [0.78, 0.3], [0.75, 0.12], [0.22, 0.12]],
  'batrovci-ulaz': [[0.0, 0.98], [1.0, 0.98], [0.9, 0.15], [0.1, 0.15]],
  'batrovci-izlaz': [[0.0, 0.98], [1.0, 0.98], [0.82, 0.12], [0.3, 0.12]],
  'gradina-ulaz': [[0.0, 0.98], [0.85, 0.98], [0.8, 0.12], [0.15, 0.12], [0.0, 0.4]],
  'gradina-izlaz': [[0.0, 0.98], [0.95, 0.98], [0.9, 0.1], [0.2, 0.1], [0.0, 0.3]],
  'presevo-ulaz': [[0.0, 0.98], [0.65, 0.98], [0.65, 0.8], [0.95, 0.8], [0.8, 0.45], [0.75, 0.12], [0.15, 0.12], [0.0, 0.4]],
  'presevo-izlaz': [[0.0, 0.98], [0.78, 0.98], [0.7, 0.12], [0.4, 0.12], [0.0, 0.35]],
  'bajakovo-1': [[0.0, 0.98], [1.0, 0.98], [1.0, 0.6], [0.62, 0.42], [0.55, 0.25], [0.35, 0.25], [0.0, 0.45]],
  'bajakovo-2': [[0.0, 0.98], [1.0, 0.98], [1.0, 0.35], [0.88, 0.15], [0.72, 0.15], [0.4, 0.33], [0.0, 0.45]],
  'bajakovo-3': [[0.0, 0.98], [1.0, 0.98], [1.0, 0.2], [0.92, 0.1], [0.8, 0.12], [0.7, 0.22], [0.45, 0.5], [0.0, 0.62]],   // desna traka do gornjeg desnog ugla – kolona se tu nastavlja van kadra
  'tovarnik-1': [[0.0, 0.98], [1.0, 0.98], [1.0, 0.66], [0.85, 0.6], [0.74, 0.48], [0.6, 0.48], [0.45, 0.58], [0.3, 0.66], [0.0, 0.72]],   // levo uz ogradu je parking, ne kolona
  'tovarnik-2': [[0.0, 0.98], [1.0, 0.98], [1.0, 0.5], [0.6, 0.3], [0.55, 0.24], [0.32, 0.24], [0.1, 0.34], [0.0, 0.45]],
  'ilok-1': [[0.05, 0.98], [0.78, 0.98], [0.75, 0.6], [0.62, 0.5], [0.45, 0.5], [0.2, 0.62], [0.05, 0.75]],
  'ilok-2': [[0.5, 0.98], [1.0, 0.98], [1.0, 0.35], [0.7, 0.15], [0.55, 0.15], [0.5, 0.45]],
  'batina-1': [[0.18, 1.0], [0.68, 1.0], [0.675, 0.59], [0.64, 0.42], [0.625, 0.29], [0.47, 0.29], [0.37, 0.55], [0.23, 0.83]],   // samo trake za auta (desno od šrafure) i ne do samog kraja – levo je traka za kamione, a iznad y 0,29 se auto-transporteri spajaju sa trakom za auta
  'batina-2': [[0.5, 0.98], [1.0, 0.98], [1.0, 0.4], [0.75, 0.12], [0.5, 0.12], [0.47, 0.6]],
  /* MUP kamere dodate 22.09.2026 (kadrovi po danu, 08:10). Gde je smer kretanja nejasan (prazna cesta), zona pokriva ceo kolovoz bez parkinga. */
  'djala-izlaz': [[0.0, 0.98], [0.42, 0.98], [0.5, 0.1], [0.32, 0.1], [0.0, 0.45]],                                // leva polovina kolovoza – prilaz ostrvu (šrafura se širi ka kameri)
  'djala-ulaz': [[0.0, 0.98], [1.0, 0.98], [0.95, 0.15], [0.55, 0.1], [0.4, 0.1], [0.1, 0.45], [0.0, 0.6]],          // ceo kolovoz (strelica u levoj traci ka kameri)
  'kelebija-ulaz': [[0.0, 0.98], [0.6, 0.98], [0.66, 0.65], [0.7, 0.32], [0.55, 0.3], [0.4, 0.42], [0.05, 0.52], [0.0, 0.6]],   // desno dole travnato ostrvo, levo stub nadstrešnice
  'kelebija-izlaz': [[0.0, 0.98], [1.0, 0.98], [1.0, 0.35], [0.85, 0.28], [0.6, 0.28], [0.35, 0.32], [0.3, 0.5], [0.15, 0.72], [0.0, 0.78]],   // gore levo kamionska traka i drveće – isključeno
  'jabuka-ulaz': [[0.12, 0.98], [1.0, 0.98], [1.0, 0.7], [0.72, 0.3], [0.62, 0.1], [0.28, 0.1], [0.15, 0.4]],       // levo uz ogradu parkirana policijska vozila
  'jabuka-izlaz': [[0.0, 0.98], [1.0, 0.98], [1.0, 0.4], [0.9, 0.28], [0.8, 0.3], [0.55, 0.5], [0.3, 0.62], [0.0, 0.7]],
  'gostun-ulaz': [[0.0, 0.98], [1.0, 0.98], [1.0, 0.45], [0.95, 0.3], [0.75, 0.2], [0.4, 0.2], [0.25, 0.3], [0.1, 0.5], [0.0, 0.6]],   // levo gore rampa ka drugom šalteru – isključena
  'gostun-izlaz': [[0.0, 0.98], [0.95, 0.98], [0.85, 0.5], [0.75, 0.25], [0.55, 0.15], [0.35, 0.15], [0.2, 0.3], [0.02, 0.5], [0.0, 0.6]],   // desno nadstrešnica sa parkiranim vozilima, levo gore parking
  'spiljani-ulaz': [[0.0, 0.98], [0.8, 0.98], [0.6, 0.4], [0.5, 0.15], [0.38, 0.15], [0.3, 0.4], [0.05, 0.7], [0.0, 0.8]],
  'spiljani-izlaz': [[0.3, 0.98], [1.0, 0.98], [0.85, 0.62], [0.72, 0.45], [0.62, 0.2], [0.55, 0.05], [0.45, 0.05], [0.42, 0.25], [0.35, 0.6]],   // desno gore parkirani automobili, levo zid
  'sid-ulaz': [[0.0, 0.98], [0.35, 0.98], [0.4, 0.6], [0.47, 0.35], [0.45, 0.12], [0.3, 0.12], [0.2, 0.22], [0.18, 0.42], [0.0, 0.55]],   // leva traka ka kameri (kamioni), desna traka odlazi; parkiran auto uz kućicu isključen
  'sid-izlaz': [[0.0, 0.98], [0.7, 0.98], [0.7, 0.6], [0.85, 0.3], [0.6, 0.0], [0.35, 0.0], [0.0, 0.35]],           // 352×288
  'vatin-ulaz': [[0.15, 0.98], [0.85, 0.98], [0.8, 0.5], [0.3, 0.5], [0.12, 0.6]],                                  // trake do STOP linija (y≈0,5); iza šaltera i parking kamiona gore isključeni
  'vatin-izlaz': [[0.05, 0.98], [0.5, 0.98], [0.5, 0.35], [0.47, 0.1], [0.38, 0.1], [0.32, 0.3], [0.22, 0.45], [0.08, 0.7]],   // levo od zelenog ostrva; parking uz obe ivice isključen
  'kotroman-izlaz': [[0.05, 0.98], [1.0, 0.98], [1.0, 0.72], [0.72, 0.5], [0.6, 0.32], [0.5, 0.3], [0.42, 0.32], [0.3, 0.5], [0.1, 0.8]],   // desno nadstrešnica sa parkiranim vozilima
  'kotroman-ulaz': [[0.35, 0.98], [0.95, 0.98], [1.0, 0.7], [0.85, 0.3], [0.72, 0.05], [0.5, 0.05], [0.45, 0.3], [0.42, 0.6]],   // levo gore kamionski parking
  'malizvornik-ulaz': [[0.0, 0.98], [0.6, 0.98], [0.6, 0.5], [0.62, 0.15], [0.55, 0.15], [0.4, 0.35], [0.2, 0.6], [0.0, 0.75]],   // leva strana mosta ka kameri
  'malizvornik-izlaz': [[0.0, 0.98], [0.45, 0.98], [0.4, 0.5], [0.42, 0.15], [0.3, 0.1], [0.15, 0.3], [0.0, 0.5]],   // leva traka ka kameri; desno ulica sa parkiranim vozilima
  'sremskaraca-ulaz': [[0.0, 0.98], [0.35, 0.98], [0.4, 0.6], [0.5, 0.4], [0.55, 0.15], [0.45, 0.1], [0.3, 0.2], [0.1, 0.5], [0.0, 0.6]],   // leva kamionska traka; desno parking
  'sremskaraca-izlaz': [[0.0, 0.98], [0.6, 0.98], [0.62, 0.5], [0.6, 0.15], [0.45, 0.1], [0.35, 0.2], [0.25, 0.4], [0.0, 0.6]],   // parkirani automobili levo isključeni
  'trbusnica-ulaz': [[0.0, 0.98], [0.6, 0.98], [0.55, 0.5], [0.5, 0.15], [0.42, 0.15], [0.25, 0.4], [0.0, 0.6]],   // leva traka mosta (strelica ka kameri)
  'trbusnica-izlaz': [[0.2, 0.98], [0.9, 0.98], [0.85, 0.6], [0.7, 0.35], [0.65, 0.1], [0.45, 0.1], [0.4, 0.4], [0.25, 0.7]],   // 352×288; parking desno gore
  'vrskacuka-ulaz': [[0.0, 0.98], [0.7, 0.98], [0.62, 0.5], [0.55, 0.15], [0.45, 0.15], [0.3, 0.45], [0.05, 0.7], [0.0, 0.8]],
  'vrskacuka-izlaz': [[0.05, 0.98], [1.0, 0.98], [1.0, 0.55], [0.75, 0.45], [0.6, 0.2], [0.45, 0.1], [0.2, 0.1], [0.1, 0.4], [0.05, 0.7]],
};

/* Kalibracija za procenu čekanja: trake = koliko traka kolone kamera pokriva, kapacitet = koliko vozila stane u zonu
   (ako je kolona blizu toga, izlazi iz kadra i procena uračunava i skriveni deo), minPoVozilu = prosečna obrada po vozilu i traci.
   minPoVozilu je samo početni prior dok kamera ne izmeri sopstveni protok (server/procena.js); 22.09. izmereno na svim kamerama
   sa kolonom 0,4–1,5 vozila/min ukupno, pa su vrednosti 1,2–1,5 min bile preoptimistične (Gostun: prior 150/h, izmereno ~70/h). */
const PROCENA = {
  'horgos-ulaz': [4, 25, 2.0], 'horgos-izlaz': [3, 20, 2.0], 'batrovci-ulaz': [3, 12, 2.0], 'batrovci-izlaz': [4, 15, 2.0],
  'gradina-ulaz': [3, 12, 2.0], 'gradina-izlaz': [3, 12, 2.0], 'presevo-ulaz': [3, 12, 2.0], 'presevo-izlaz': [2, 10, 2.0],
  'bajakovo-1': [3, 20, 2.5], 'bajakovo-2': [3, 20, 2.5], 'bajakovo-3': [2, 12, 2.5], 'tovarnik-1': [2, 15, 2.5], 'tovarnik-2': [2, 12, 2.5],
  'ilok-1': [1, 8, 2.5], 'ilok-2': [2, 10, 2.5], 'batina-1': [1, 8, 2.5], 'batina-2': [1, 8, 2.5],
  'djala-izlaz': [1, 8, 2.0], 'djala-ulaz': [1, 10, 2.0], 'kelebija-ulaz': [2, 12, 2.0], 'kelebija-izlaz': [2, 12, 2.0],
  'jabuka-ulaz': [1, 8, 2.0], 'jabuka-izlaz': [1, 8, 2.0], 'gostun-ulaz': [3, 15, 2.0], 'gostun-izlaz': [3, 15, 2.0],
  'spiljani-ulaz': [1, 8, 2.5], 'spiljani-izlaz': [1, 8, 2.5], 'sid-ulaz': [1, 8, 2.5], 'sid-izlaz': [1, 6, 2.5],
  'vatin-ulaz': [3, 12, 2.0], 'vatin-izlaz': [2, 12, 2.0], 'kotroman-izlaz': [2, 10, 2.5], 'kotroman-ulaz': [1, 8, 2.5],
  'malizvornik-ulaz': [1, 10, 2.0], 'malizvornik-izlaz': [1, 8, 2.5], 'sremskaraca-ulaz': [1, 8, 2.5], 'sremskaraca-izlaz': [2, 10, 2.5],
  'trbusnica-ulaz': [1, 10, 2.0], 'trbusnica-izlaz': [1, 6, 2.0], 'vrskacuka-ulaz': [1, 8, 2.0], 'vrskacuka-izlaz': [2, 10, 2.0],
};

/* Zum zone: isečci kadra (x0,y0,x1,y1 relativno) koji se uvećaju 3× i detektuju posebno, za daleki deo kolone na kamerama niske rezolucije */
const ZUM = {
  'bajakovo-3': [[0.7, 0.05, 1.0, 0.45]],   // širi isečak (uvećanje ~1,7×) radi bolje od uskog: modelu treba kontekst oko vozila
  'horgos-izlaz': [[0.25, 0.06, 0.65, 0.45]],
  'horgos-ulaz': [[0.15, 0.05, 0.8, 0.4]],
  'batrovci-izlaz': [[0.2, 0.05, 0.85, 0.4]],
  'gradina-izlaz': [[0.15, 0.03, 0.9, 0.35]],
  'presevo-izlaz': [[0.3, 0.05, 0.75, 0.35]],
  'kelebija-ulaz': [[0.45, 0.25, 0.8, 0.5]], 'kelebija-izlaz': [[0.5, 0.2, 0.9, 0.5]],
  'gostun-ulaz': [[0.3, 0.15, 0.9, 0.4]], 'gostun-izlaz': [[0.25, 0.1, 0.8, 0.4]],
  'spiljani-ulaz': [[0.3, 0.1, 0.7, 0.4]], 'spiljani-izlaz': [[0.35, 0.02, 0.75, 0.3]],
  'sid-ulaz': [[0.1, 0.08, 0.6, 0.4]], 'vatin-izlaz': [[0.25, 0.03, 0.6, 0.3]], 'kotroman-izlaz': [[0.35, 0.25, 0.75, 0.5]],
  'malizvornik-ulaz': [[0.35, 0.1, 0.75, 0.4]], 'malizvornik-izlaz': [[0.2, 0.05, 0.6, 0.35]],
  'sremskaraca-ulaz': [[0.3, 0.05, 0.7, 0.4]], 'sremskaraca-izlaz': [[0.3, 0.05, 0.7, 0.35]], 'trbusnica-ulaz': [[0.3, 0.1, 0.7, 0.4]],
};
/* Rep kolone: `kraj` je ivica kadra na kojoj je rep (suprotno od smera kretanja ka šalteru), `y` prag za četvrto vozilo
   najbliže toj ivici. Ako ga kolona dostiže, deo kolone je van kadra → procena množi vidljivu kolonu faktorom (server/procena.js). */
const PUNO = {
  'horgos-izlaz': { kraj: 'dole', y: 0.88 }, 'horgos-ulaz': { kraj: 'dole', y: 0.88 }, 'batrovci-izlaz': { kraj: 'dole', y: 0.88 }, 'batrovci-ulaz': { kraj: 'gore', y: 0.3 },
  'gradina-izlaz': { kraj: 'dole', y: 0.88 }, 'gradina-ulaz': { kraj: 'gore', y: 0.3 }, 'presevo-izlaz': { kraj: 'dole', y: 0.88 }, 'presevo-ulaz': { kraj: 'gore', y: 0.3 },
  'bajakovo-1': { kraj: 'gore', y: 0.4 }, 'bajakovo-2': { kraj: 'gore', y: 0.2 }, 'bajakovo-3': { kraj: 'gore', y: 0.34 }, 'tovarnik-1': { kraj: 'gore', y: 0.55 }, 'tovarnik-2': { kraj: 'gore', y: 0.3 },
  'ilok-1': { kraj: 'gore', y: 0.5 }, 'ilok-2': { kraj: 'gore', y: 0.25 }, 'batina-1': { kraj: 'gore', y: 0.35 }, 'batina-2': { kraj: 'gore', y: 0.15 },
  /* nove MUP kamere: većina gleda kolonu koja prilazi kameri (rep gore); Jabuka izlaz, Špiljani izlaz i Vatin ulaz gledaju kolonu koja odlazi od kamere (rep dole) */
  ...Object.fromEntries(['djala-izlaz', 'djala-ulaz', 'kelebija-ulaz', 'kelebija-izlaz', 'jabuka-ulaz', 'gostun-ulaz', 'gostun-izlaz', 'spiljani-ulaz', 'sid-ulaz', 'sid-izlaz', 'vatin-izlaz', 'kotroman-izlaz', 'kotroman-ulaz', 'malizvornik-ulaz', 'malizvornik-izlaz', 'sremskaraca-ulaz', 'sremskaraca-izlaz', 'trbusnica-ulaz', 'trbusnica-izlaz', 'vrskacuka-ulaz', 'vrskacuka-izlaz'].map((id) => [id, { kraj: 'gore', y: 0.32 }])),
  'kelebija-ulaz': { kraj: 'gore', y: 0.4 }, 'kotroman-izlaz': { kraj: 'gore', y: 0.38 },
  'jabuka-izlaz': { kraj: 'dole', y: 0.88 }, 'spiljani-izlaz': { kraj: 'dole', y: 0.88 }, 'vatin-ulaz': { kraj: 'dole', y: 0.9 },
};

/* Linija prolaska (šalter): relativni y i smer kretanja kolone ('gore' = ka vrhu kadra, 'dole' = ka kameri).
   Vozilo koje između dva kadra pređe liniju u tom smeru računa se kao „prošlo“ → protok (vozila/min) → čekanje = kolona ÷ protok */
const LINIJA = {
  'horgos-izlaz': { y: 0.3, smer: 'gore' }, 'horgos-ulaz': { y: 0.22, smer: 'gore' },
  'batrovci-izlaz': { y: 0.22, smer: 'gore' }, 'batrovci-ulaz': { y: 0.75, smer: 'dole' },
  'gradina-izlaz': { y: 0.24, smer: 'gore' }, 'gradina-ulaz': { y: 0.75, smer: 'dole' },
  'presevo-izlaz': { y: 0.22, smer: 'gore' }, 'presevo-ulaz': { y: 0.78, smer: 'dole' },
  'bajakovo-1': { y: 0.85, smer: 'dole' }, 'bajakovo-2': { y: 0.72, smer: 'dole' },   // na čelu kolone gde su auta krupna – linija u gustom, dalekom delu (0,4) brojala je šum (provera 25.09.) 'bajakovo-3': { y: 0.85, smer: 'dole' },
  'tovarnik-1': { y: 0.85, smer: 'dole' }, 'tovarnik-2': { y: 0.53, smer: 'dole' },
  'ilok-1': { y: 0.8, smer: 'dole' }, 'ilok-2': { y: 0.65, smer: 'dole' },   // provera 25.09.: linija na repu (0,46) nije brojala čelo kolone 'batina-1': { y: 0.6, smer: 'dole' }, 'batina-2': { y: 0.6, smer: 'dole' },   // HAK slika na ~10 s: linija pri dnu (0,8) – auto izađe iz kadra između dva kadra i prelazak se ne vidi
  ...Object.fromEntries(['djala-izlaz', 'djala-ulaz', 'kelebija-ulaz', 'kelebija-izlaz', 'jabuka-ulaz', 'gostun-ulaz', 'gostun-izlaz', 'spiljani-ulaz', 'sid-ulaz', 'sid-izlaz', 'vatin-izlaz', 'kotroman-izlaz', 'kotroman-ulaz', 'malizvornik-ulaz', 'malizvornik-izlaz', 'sremskaraca-ulaz', 'sremskaraca-izlaz', 'trbusnica-ulaz', 'trbusnica-izlaz', 'vrskacuka-ulaz', 'vrskacuka-izlaz'].map((id) => [id, { y: 0.85, smer: 'dole' }])),
  'jabuka-izlaz': { y: 0.35, smer: 'gore' }, 'spiljani-izlaz': { y: 0.25, smer: 'gore' }, 'vatin-ulaz': { y: 0.55, smer: 'gore' },
};

const LISTA = [
  MUP('horgos-ulaz', 'Horgoš', 'Mađarska', 'ulaz', 'horgos1'),
  MUP('horgos-izlaz', 'Horgoš', 'Mađarska', 'izlaz', 'horgos2'),
  MUP('batrovci-ulaz', 'Batrovci', 'Hrvatska', 'ulaz', 'batrovci1'),
  MUP('batrovci-izlaz', 'Batrovci', 'Hrvatska', 'izlaz', 'batrovci2'),
  MUP('gradina-ulaz', 'Gradina', 'Bugarska', 'ulaz', 'gradina1'),
  MUP('gradina-izlaz', 'Gradina', 'Bugarska', 'izlaz', 'gradina2'),
  MUP('presevo-ulaz', 'Preševo', 'Severna Makedonija', 'ulaz', 'presevo1'),
  MUP('presevo-izlaz', 'Preševo', 'Severna Makedonija', 'izlaz', 'presevo2'),
  HAK('bajakovo-1', 'Batrovci', 'Hrvatska', 'Bajakovo', 1, 1, 'ulaz'),
  HAK('bajakovo-2', 'Batrovci', 'Hrvatska', 'Bajakovo', 2, 2, 'izlaz'),
  HAK('bajakovo-3', 'Batrovci', 'Hrvatska', 'Bajakovo', 3, 3, 'ulaz'),
  HAK('tovarnik-1', 'Šid', 'Hrvatska', 'Tovarnik', 1, 419, 'ulaz'),
  HAK('tovarnik-2', 'Šid', 'Hrvatska', 'Tovarnik', 2, 420, 'izlaz'),
  HAK('ilok-1', 'Bačka Palanka', 'Hrvatska', 'Ilok', 1, 417, 'ulaz'),
  HAK('ilok-2', 'Bačka Palanka', 'Hrvatska', 'Ilok', 2, 418, 'izlaz'),
  Object.assign(HAK('batina-1', 'Bezdan', 'Hrvatska', 'Batina', 1, 1017, 'ulaz'), { transporteri: true }),   // auto-transporteri u traci za kamione – auta na njima se ne broje
  HAK('batina-2', 'Bezdan', 'Hrvatska', 'Batina', 2, 1018, 'izlaz'),
  /* ostali MUP prelazi (22.09.2026) – redosled kao na mup.gov.rs */
  MUP2('djala-ulaz', 'Đala', 'Mađarska', 'ulaz', 'Djala', 'djala2'),
  MUP2('djala-izlaz', 'Đala', 'Mađarska', 'izlaz', 'Djala', 'djala1'),
  MUP2('kelebija-ulaz', 'Kelebija', 'Mađarska', 'ulaz', 'Kelebija', 'kelebija1'),
  MUP2('kelebija-izlaz', 'Kelebija', 'Mađarska', 'izlaz', 'Kelebija', 'kelebija2'),
  MUP2('jabuka-ulaz', 'Jabuka', 'Crna Gora', 'ulaz', 'Jabuka', 'jabuka1'),
  MUP2('jabuka-izlaz', 'Jabuka', 'Crna Gora', 'izlaz', 'Jabuka', 'jabuka2'),
  MUP2('gostun-ulaz', 'Gostun', 'Crna Gora', 'ulaz', 'Gostun', 'gostun1'),
  MUP2('gostun-izlaz', 'Gostun', 'Crna Gora', 'izlaz', 'Gostun', 'gostun2'),
  MUP2('spiljani-ulaz', 'Špiljani', 'Crna Gora', 'ulaz', 'Spiljani', 'spiljani1'),
  MUP2('spiljani-izlaz', 'Špiljani', 'Crna Gora', 'izlaz', 'Spiljani', 'spiljani2'),
  MUP2('sid-ulaz', 'Šid', 'Hrvatska', 'ulaz', 'Sid', 'sid1'),
  MUP2('sid-izlaz', 'Šid', 'Hrvatska', 'izlaz', 'Sid', 'sid2'),
  MUP2('vatin-ulaz', 'Vatin', 'Rumunija', 'ulaz', 'Vatin', 'vatin1'),
  MUP2('vatin-izlaz', 'Vatin', 'Rumunija', 'izlaz', 'Vatin', 'vatin2'),
  MUP2('kotroman-ulaz', 'Kotroman', 'Bosna i Hercegovina', 'ulaz', 'Kotroman', 'kotroman2'),
  MUP2('kotroman-izlaz', 'Kotroman', 'Bosna i Hercegovina', 'izlaz', 'Kotroman', 'kotroman1'),
  MUP2('malizvornik-ulaz', 'Mali Zvornik', 'Bosna i Hercegovina', 'ulaz', 'MaliZvornik', 'malizvornik1'),
  MUP2('malizvornik-izlaz', 'Mali Zvornik', 'Bosna i Hercegovina', 'izlaz', 'MaliZvornik', 'malizvornik2'),
  MUP2('sremskaraca-ulaz', 'Sremska Rača', 'Bosna i Hercegovina', 'ulaz', 'SremskaRaca', 'sremskaraca1'),
  MUP2('sremskaraca-izlaz', 'Sremska Rača', 'Bosna i Hercegovina', 'izlaz', 'SremskaRaca', 'sremskaraca2'),
  MUP2('trbusnica-ulaz', 'Trbušnica', 'Bosna i Hercegovina', 'ulaz', 'Trbusnica', 'trbusnica1'),
  MUP2('trbusnica-izlaz', 'Trbušnica', 'Bosna i Hercegovina', 'izlaz', 'Trbusnica', 'trbusnica2'),
  MUP2('vrskacuka-ulaz', 'Vrška Čuka', 'Bugarska', 'ulaz', 'VrskaCuka', 'vrskacuka1'),
  MUP2('vrskacuka-izlaz', 'Vrška Čuka', 'Bugarska', 'izlaz', 'VrskaCuka', 'vrskacuka2'),
].map((k) => Object.assign(k, { roi: ROI[k.id] || null, zum: ZUM[k.id] || null, puno: PUNO[k.id] || null, linija: normLinija(LINIJA[k.id]), procena: PROCENA[k.id] ? { trake: PROCENA[k.id][0], kapacitet: PROCENA[k.id][1], minPoVozilu: PROCENA[k.id][2] } : null }));

/* Linija prolaska je duž (x1,y1)–(x2,y2); stari zapis { y, smer } je vodoravna linija preko celog kadra.
   smer 'gore' = vozilo prelazi sa strane na koju pokazuje normala (-dy, dx) na suprotnu (za vodoravnu liniju: odozdo nagore). */
function normLinija(l) {
  if (!l) return null;
  if (l.x1 == null) return { x1: 0, y1: l.y, x2: 1, y2: l.y, smer: l.smer };
  return { x1: l.x1, y1: l.y1, x2: l.x2, y2: l.y2, smer: l.smer };
}

/* Admin → Kamere: zone koje admin nacrta čuvaju se u data/kamere-podesavanja.json (ne ide u zip, ostaje na serveru)
   i preklapaju podrazumevane vrednosti iz ovog fajla. Sajt i radnik zovu osvezi(); fajl se ponovo čita samo kad se promeni. */
const fs = require('node:fs');
const path = require('node:path');
const PODESAVANJA = path.join(__dirname, '..', 'data', 'kamere-podesavanja.json');
const POLJA = ['roi', 'zum', 'puno', 'linija'];
const kopija = (x) => (x == null ? null : JSON.parse(JSON.stringify(x)));
for (const k of LISTA) k.osnovno = Object.fromEntries(POLJA.map((p) => [p, kopija(k[p])]));
let procitano = null;
function osvezi() {
  let t = 0; try { t = fs.statSync(PODESAVANJA).mtimeMs; } catch (e) { /* nema izmena */ }
  if (t === procitano) return false;
  procitano = t;
  let j = {}; try { j = t ? JSON.parse(fs.readFileSync(PODESAVANJA, 'utf8')) : {}; } catch (e) { console.error('kamere-podesavanja.json:', e.message); }
  for (const k of LISTA) {
    const iz = j[k.id] || null;
    for (const p of POLJA) k[p] = iz && iz[p] !== undefined ? (p === 'linija' ? normLinija(iz[p]) : kopija(iz[p])) : kopija(k.osnovno[p]);
    k.izmena = iz ? { kad: iz.kad || null, ko: iz.ko || null } : null;
  }
  return true;
}
osvezi();
Object.defineProperty(LISTA, 'osvezi', { value: osvezi });
Object.defineProperty(LISTA, 'PODESAVANJA', { value: PODESAVANJA });
module.exports = LISTA;
