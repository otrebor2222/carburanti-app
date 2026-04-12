'use strict';

const express = require('express');
const fetch   = require('node-fetch');
const path    = require('path');
const zlib    = require('zlib');
const { promisify } = require('util');
const gunzip  = promisify(zlib.gunzip);

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── SORGENTI DATI ────────────────────────────────────────────────────────────
// MIMIT - URL ufficiali
const MIMIT_PREZZI     = 'https://www.mimit.gov.it/images/exportCSV/prezzo_alle_8.csv';
const MIMIT_ANAGRAFICA = 'https://www.mimit.gov.it/images/exportCSV/anagrafica_impianti_attivi.csv';

// Proxy pubblici CORS-free da cui scaricare i CSV
const PROXY_URLS = [
  url => `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
  url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  url => `https://proxy.cors.sh/${url}`,
  url => `https://thingproxy.freeboard.io/fetch/${url}`,
];

// Cache
const CACHE_TTL = 8 * 60 * 60 * 1000; // 8 ore
let CACHE = { data: null, ts: 0, loading: false, errore: null };

// ─── CORS ─────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

// ─── SCARICA CON TENTATIVI ────────────────────────────────────────────────────
async function scaricaURL(url, timeout = 30000) {
  // Prima prova diretta (server-side non ha CORS)
  try {
    const res = await fetch(url, {
      timeout,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; CarburantiBot/2.0)',
        'Accept': 'text/csv, text/plain, */*',
        'Accept-Encoding': 'gzip, deflate',
        'Cache-Control': 'no-cache',
      },
    });
    if (res.ok) {
      const testo = await res.text();
      if (testo && testo.length > 1000) {
        console.log(`[OK] Scaricato direttamente: ${url.split('/').pop()} (${Math.round(testo.length/1024)}KB)`);
        return testo;
      }
    }
  } catch (e) {
    console.log(`[WARN] Accesso diretto fallito: ${e.message}`);
  }

  // Prova i proxy in sequenza
  for (const buildProxy of PROXY_URLS) {
    const proxyUrl = buildProxy(url);
    try {
      const res = await fetch(proxyUrl, {
        timeout: 20000,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CarburantiBot/2.0)' },
      });
      if (!res.ok) continue;
      const testo = await res.text();
      if (testo && testo.length > 1000) {
        console.log(`[OK] Scaricato via proxy: ${proxyUrl.substring(0, 50)}...`);
        return testo;
      }
    } catch (e) {
      console.log(`[WARN] Proxy ${proxyUrl.substring(0, 40)} fallito: ${e.message}`);
    }
  }

  throw new Error(`Impossibile scaricare ${url} con nessun metodo`);
}

// ─── PARSE CSV ────────────────────────────────────────────────────────────────
function parseCSV(testo) {
  // Rileva automaticamente il separatore
  const primaRiga = testo.split('\n')[0];
  let sep = '|';
  if ((primaRiga.match(/;/g)||[]).length > (primaRiga.match(/\|/g)||[]).length) sep = ';';
  if ((primaRiga.match(/,/g)||[]).length > 10 && !primaRiga.includes('|')) sep = ',';

  const righe = testo.replace(/\r/g, '').split('\n').filter(r => r.trim());
  if (righe.length < 2) return [];

  const heads = righe[0].split(sep).map(h => h.trim().replace(/"/g, '').toLowerCase());
  const risultati = [];

  for (let i = 1; i < righe.length; i++) {
    const vals = righe[i].split(sep).map(v => v.trim().replace(/"/g, ''));
    if (vals.length < 2) continue;
    const o = {};
    heads.forEach((h, j) => { o[h] = vals[j] || ''; });
    risultati.push(o);
  }
  return risultati;
}

function getField(obj, ...keys) {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== '') return obj[k];
  }
  return '';
}

// ─── AGGIORNA CACHE ───────────────────────────────────────────────────────────
async function aggiornaDati() {
  if (CACHE.loading) {
    console.log('[INFO] Caricamento già in corso, skip.');
    return;
  }
  CACHE.loading = true;
  CACHE.errore = null;
  console.log(`\n[${new Date().toISOString()}] === Inizio scaricamento CSV MIMIT ===`);

  try {
    // Scarica i due CSV
    const [tPrezzi, tAnag] = await Promise.all([
      scaricaURL(MIMIT_PREZZI, 40000),
      scaricaURL(MIMIT_ANAGRAFICA, 40000),
    ]);

    console.log(`[INFO] Prezzi: ${tPrezzi.length} bytes | Anagrafica: ${tAnag.length} bytes`);

    const rowsPrezzi = parseCSV(tPrezzi);
    const rowsAnag   = parseCSV(tAnag);

    console.log(`[INFO] Prezzi parsificati: ${rowsPrezzi.length} righe | Anagrafica: ${rowsAnag.length} righe`);

    if (rowsPrezzi.length < 100) throw new Error(`Troppo pochi prezzi: ${rowsPrezzi.length}`);

    // Log headers per debug
    if (rowsPrezzi.length > 0) console.log('[DEBUG] Headers prezzi:', Object.keys(rowsPrezzi[0]).join(', '));
    if (rowsAnag.length > 0)   console.log('[DEBUG] Headers anagrafica:', Object.keys(rowsAnag[0]).join(', '));

    // Mappa anagrafica O(1)
    const anagMap = new Map();
    for (const r of rowsAnag) {
      const id = getField(r, 'idimpianto', 'id', 'codicempianto', 'codice');
      if (id) anagMap.set(id.trim(), r);
    }

    // Merge
    const stazioni = [];
    for (const r of rowsPrezzi) {
      const id    = (getField(r, 'idimpianto', 'id', 'codiceimpianto', 'codice') || '').trim();
      const pStr  = getField(r, 'prezzo', 'price', 'prezzoself', 'prezzoservito');
      const prezzo = parseFloat(pStr.replace(',', '.'));

      if (!id || isNaN(prezzo) || prezzo < 0.3 || prezzo > 6) continue;

      const a   = anagMap.get(id) || {};
      const lat = parseFloat(getField(a, 'latitudine', 'lat', 'latitude') || '0');
      const lng = parseFloat(getField(a, 'longitudine', 'lng', 'lon', 'longitude') || '0');

      stazioni.push({
        id,
        prezzo,
        carburante: getField(r, 'desccarburante', 'carburante', 'tipo', 'fuel', 'tipologia'),
        isSelf:     ['true','1','si','yes'].includes(getField(r, 'isself', 'self', 'modalita').toLowerCase()),
        dtCom:      getField(r, 'dtcomu', 'dtcomunicazione', 'data', 'date', 'datacomunicazione'),
        gestore:    getField(a, 'gestore', 'bandiera', 'nome', 'brand', 'insegna') || '—',
        indirizzo:  [
          getField(a, 'indirizzo', 'via', 'address'),
          getField(a, 'comune', 'citta', 'city'),
        ].filter(Boolean).join(', ') || '—',
        comune:     getField(a, 'comune', 'citta', 'city'),
        provincia:  getField(a, 'provincia', 'prov'),
        latitudine: isNaN(lat) ? 0 : lat,
        longitudine:isNaN(lng) ? 0 : lng,
      });
    }

    if (stazioni.length < 50) throw new Error(`Merge fallito: solo ${stazioni.length} stazioni`);

    CACHE.data = stazioni;
    CACHE.ts   = Date.now();
    console.log(`[OK] Cache aggiornata: ${stazioni.length} stazioni totali`);

    // Log esempio carburanti trovati
    const tipi = [...new Set(stazioni.map(s => s.carburante).filter(Boolean))].slice(0, 10);
    console.log('[INFO] Tipi carburante:', tipi.join(', '));

  } catch (e) {
    CACHE.errore = e.message;
    console.error('[ERRORE] aggiornaDati:', e.message);
  } finally {
    CACHE.loading = false;
  }
}

// ─── HAVERSINE ────────────────────────────────────────────────────────────────
function hav(la1, lo1, la2, lo2) {
  const R = 6371,
    dL = (la2 - la1) * Math.PI / 180,
    dl = (lo2 - lo1) * Math.PI / 180,
    a  = Math.sin(dL/2)**2 + Math.cos(la1*Math.PI/180) * Math.cos(la2*Math.PI/180) * Math.sin(dl/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────

// Health — usato da UptimeRobot per tenere sveglio il server
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    stazioni: CACHE.data?.length || 0,
    cacheValida: CACHE.data !== null && (Date.now() - CACHE.ts) < CACHE_TTL,
    aggiornato: CACHE.ts ? new Date(CACHE.ts).toISOString() : null,
    errore: CACHE.errore || null,
    loading: CACHE.loading,
  });
});

// Forza aggiornamento manuale
app.get('/api/refresh', async (req, res) => {
  CACHE.ts = 0;
  await aggiornaDati();
  res.json({
    ok: true,
    stazioni: CACHE.data?.length || 0,
    errore: CACHE.errore || null,
  });
});

// Endpoint principale
app.get('/api/stazioni-con-prezzi', async (req, res) => {
  // Se cache vuota avvia caricamento e rispondi subito con array vuoto + retry hint
  if (!CACHE.data || CACHE.data.length === 0) {
    if (!CACHE.loading) aggiornaDati(); // avvia in background
    return res.status(503).json({
      ok: false,
      error: 'Dati in caricamento. Riprova tra 30 secondi.',
      retry: 30,
    });
  }

  // Cache scaduta: aggiorna in background senza bloccare
  if ((Date.now() - CACHE.ts) > CACHE_TTL && !CACHE.loading) {
    aggiornaDati();
  }

  const { carburante, lat, lng, raggio, limit } = req.query;
  let dati = CACHE.data;

  // Filtra per carburante
  if (carburante) {
    const q = carburante.toLowerCase().trim();
    dati = dati.filter(s => s.carburante.toLowerCase().includes(q));
    // Se non trova nulla prova varianti
    if (dati.length < 5) {
      const alt = { gasolio: ['diesel', 'gasolio'], benzina: ['benzina 95', 'benzin'], gpl: ['gpl', 'liquefatt'] };
      const altKeys = alt[q] || [];
      if (altKeys.length) {
        dati = CACHE.data.filter(s => altKeys.some(k => s.carburante.toLowerCase().includes(k)));
      }
    }
  }

  // Calcola distanza e filtra per raggio
  const uLat = parseFloat(lat), uLng = parseFloat(lng);
  const km   = Math.min(parseFloat(raggio) || 50, 200);

  if (!isNaN(uLat) && !isNaN(uLng)) {
    dati = dati
      .map(s => ({
        ...s,
        distanza: (s.latitudine && s.longitudine)
          ? hav(uLat, uLng, s.latitudine, s.longitudine)
          : null,
      }))
      .filter(s => s.distanza === null || s.distanza <= km)
      .sort((a, b) => (a.distanza ?? 999) - (b.distanza ?? 999));
  } else {
    dati = dati.sort((a, b) => a.prezzo - b.prezzo);
  }

  const maxLimit = Math.min(parseInt(limit) || 300, 2000);
  dati = dati.slice(0, maxLimit);

  res.json({
    ok: true,
    count: dati.length,
    aggiornatoAlle: new Date(CACHE.ts).toISOString(),
    fonte: 'MIMIT Open Data',
    data: dati,
  });
});

// Stats
app.get('/api/stats', (req, res) => {
  if (!CACHE.data) return res.json({ ok: false, error: 'Dati non disponibili' });
  const mappa = {};
  for (const s of CACHE.data) {
    const c = s.carburante || 'altro';
    if (!mappa[c]) mappa[c] = [];
    mappa[c].push(s.prezzo);
  }
  const stats = Object.entries(mappa).map(([c, pp]) => {
    pp.sort((a, b) => a - b);
    return { carburante: c, count: pp.length, min: +pp[0].toFixed(3), max: +pp[pp.length-1].toFixed(3), media: +(pp.reduce((a,b)=>a+b,0)/pp.length).toFixed(3) };
  }).sort((a, b) => b.count - a.count);
  res.json({ ok: true, aggiornatoAlle: new Date(CACHE.ts).toISOString(), stats });
});

// SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── AVVIO ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 Server avviato su porta ${PORT}`);
  console.log(`📊 Endpoints: /health | /api/stazioni-con-prezzi | /api/refresh\n`);
  // Carica subito
  aggiornaDati();
  // Aggiorna ogni 8 ore
  setInterval(aggiornaDati, CACHE_TTL);
});
