'use strict';

const express = require('express');
const fetch   = require('node-fetch');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

const MIMIT_PREZZI     = 'https://www.mimit.gov.it/images/exportCSV/prezzo_alle_8.csv';
const MIMIT_ANAGRAFICA = 'https://www.mimit.gov.it/images/exportCSV/anagrafica_impianti_attivi.csv';
const CACHE_TTL = 6 * 60 * 60 * 1000; // 6 ore

// ─── CACHE ───────────────────────────────────────────────────────────────────
let CACHE = { data: null, ts: 0, loading: false };

function cacheValida() {
  return CACHE.data !== null && (Date.now() - CACHE.ts) < CACHE_TTL;
}

// ─── CORS ────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// ─── PARSE CSV ───────────────────────────────────────────────────────────────
function parseCSV(testo, sep = '|') {
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

function get(obj, ...keys) {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== '') return obj[k];
  }
  return '';
}

// ─── SCARICA E PROCESSA ───────────────────────────────────────────────────────
async function scaricaCSV(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'CarburantiMIMIT/2.0 (+https://github.com)' },
    timeout: 45000,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} da ${url}`);
  return res.text();
}

async function aggiornaDati() {
  if (CACHE.loading) return;
  CACHE.loading = true;
  console.log(`[${new Date().toISOString()}] Scaricamento CSV MIMIT...`);

  try {
    const [tPrezzi, tAnag] = await Promise.all([
      scaricaCSV(MIMIT_PREZZI),
      scaricaCSV(MIMIT_ANAGRAFICA),
    ]);

    // Prova separatore | poi ;
    let rowsPrezzi = parseCSV(tPrezzi, '|');
    if (rowsPrezzi.length < 100) rowsPrezzi = parseCSV(tPrezzi, ';');

    let rowsAnag = parseCSV(tAnag, '|');
    if (rowsAnag.length < 100) rowsAnag = parseCSV(tAnag, ';');

    // Costruisci mappa anagrafica O(1)
    const anagMap = new Map();
    for (const r of rowsAnag) {
      const id = get(r, 'idimpianto', 'id');
      if (id) anagMap.set(id, r);
    }

    // Merge
    const stazioni = [];
    for (const r of rowsPrezzi) {
      const id     = get(r, 'idimpianto', 'id');
      const pStr   = get(r, 'prezzo');
      const prezzo = parseFloat(pStr.replace(',', '.'));
      if (!id || isNaN(prezzo) || prezzo <= 0.1 || prezzo > 6) continue;

      const a   = anagMap.get(id) || {};
      const lat = parseFloat(get(a, 'latitudine', 'lat') || '0');
      const lng = parseFloat(get(a, 'longitudine', 'lng', 'lon') || '0');

      stazioni.push({
        id,
        prezzo,
        carburante: get(r, 'desccarburante', 'carburante'),
        isSelf:     get(r, 'isself', 'self') === 'true' || get(r, 'isself') === '1',
        dtCom:      get(r, 'dtcomu', 'dtcomunicazione', 'data'),
        gestore:    get(a, 'gestore', 'bandiera', 'nome') || '—',
        indirizzo:  [get(a, 'indirizzo'), get(a, 'comune')].filter(Boolean).join(', ') || '—',
        comune:     get(a, 'comune'),
        provincia:  get(a, 'provincia'),
        latitudine: isNaN(lat) ? 0 : lat,
        longitudine:isNaN(lng) ? 0 : lng,
      });
    }

    if (stazioni.length < 100) throw new Error(`Dati insufficienti: ${stazioni.length}`);

    CACHE.data = stazioni;
    CACHE.ts   = Date.now();
    console.log(`[OK] ${stazioni.length} stazioni caricate in cache.`);
  } catch (e) {
    console.error('[ERRORE]', e.message);
    // Non svuotare la cache se esiste già
  } finally {
    CACHE.loading = false;
  }
}

// ─── HAVERSINE ────────────────────────────────────────────────────────────────
function hav(la1, lo1, la2, lo2) {
  const R = 6371, dL = (la2 - la1) * Math.PI / 180, dl = (lo2 - lo1) * Math.PI / 180;
  const a = Math.sin(dL/2)**2 + Math.cos(la1*Math.PI/180) * Math.cos(la2*Math.PI/180) * Math.sin(dl/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── MIDDLEWARE: assicura cache pronta ───────────────────────────────────────
async function assicuraCache(req, res, next) {
  if (cacheValida()) return next();
  // Cache vuota o scaduta: aspetta il caricamento
  try {
    await aggiornaDati();
  } catch(e) { /* gestito dentro */ }
  if (!CACHE.data) {
    return res.status(503).json({ ok: false, error: 'Dati non ancora disponibili, riprova tra 30 secondi.' });
  }
  next();
}

// ═══════════════════════════════════════════════════════════════════════════════
// ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════════

// Health check (usato da UptimeRobot per tenere sveglio il server)
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    stazioni: CACHE.data?.length || 0,
    cacheValida: cacheValida(),
    aggiornato: CACHE.ts ? new Date(CACHE.ts).toISOString() : null,
  });
});

// Endpoint principale
app.get('/api/stazioni-con-prezzi', assicuraCache, (req, res) => {
  const { carburante, lat, lng, raggio, limit } = req.query;

  let dati = CACHE.data;

  // Filtra per carburante
  if (carburante) {
    const q = carburante.toLowerCase();
    dati = dati.filter(s => s.carburante.toLowerCase().includes(q));
  }

  // Calcola distanza e filtra per raggio
  const uLat = parseFloat(lat), uLng = parseFloat(lng), km = parseFloat(raggio) || 50;
  if (!isNaN(uLat) && !isNaN(uLng)) {
    dati = dati
      .map(s => ({
        ...s,
        distanza: (s.latitudine && s.longitudine)
          ? hav(uLat, uLng, s.latitudine, s.longitudine)
          : null,
      }))
      .filter(s => s.distanza === null || s.distanza <= km);
    dati.sort((a, b) => (a.distanza ?? 999) - (b.distanza ?? 999));
  } else {
    dati.sort((a, b) => a.prezzo - b.prezzo);
  }

  const maxLimit = Math.min(parseInt(limit) || 300, 2000);
  dati = dati.slice(0, maxLimit);

  res.json({
    ok: true,
    count: dati.length,
    aggiornatoAlle: CACHE.ts ? new Date(CACHE.ts).toISOString() : null,
    fonte: 'MIMIT Open Data',
    data: dati,
  });
});

// Stats per carburante
app.get('/api/stats', assicuraCache, (req, res) => {
  const mappa = {};
  for (const s of CACHE.data) {
    const c = s.carburante || 'altro';
    if (!mappa[c]) mappa[c] = [];
    mappa[c].push(s.prezzo);
  }
  const stats = Object.entries(mappa).map(([c, pp]) => {
    pp.sort((a, b) => a - b);
    return {
      carburante: c,
      count: pp.length,
      min: +pp[0].toFixed(3),
      max: +pp[pp.length - 1].toFixed(3),
      media: +(pp.reduce((a, b) => a + b, 0) / pp.length).toFixed(3),
    };
  }).sort((a, b) => b.count - a.count);
  res.json({ ok: true, aggiornatoAlle: new Date(CACHE.ts).toISOString(), stats });
});

// Forza refresh
app.get('/api/refresh', async (req, res) => {
  CACHE.ts = 0;
  await aggiornaDati();
  res.json({ ok: true, stazioni: CACHE.data?.length || 0 });
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── AVVIO ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Server avviato su porta ${PORT}`);
  // Carica subito i dati all'avvio
  aggiornaDati();
  // Aggiorna ogni 6 ore automaticamente
  setInterval(aggiornaDati, CACHE_TTL);
});
