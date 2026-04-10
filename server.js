/**
 * server.js — Proxy MIMIT Open Data per prezzi carburanti
 *
 * Scarica i CSV ufficiali del Ministero delle Imprese e del Made in Italy,
 * li parsifica e li serve come API JSON al frontend, aggirando il blocco CORS.
 *
 * Avvio:  node server.js
 * Porta:  3000 (configurabile con env PORT)
 *
 * Endpoints:
 *   GET /api/prezzi              → tutti i prezzi (con filtri opzionali)
 *   GET /api/stazioni            → anagrafica impianti attivi
 *   GET /api/stazioni-con-prezzi → merge prezzi + anagrafica (usato dal frontend)
 *   GET /api/stats               → statistiche aggregate per tipo carburante
 *   GET /health                  → status server e cache
 */

'use strict';

const express  = require('express');
const fetch    = require('node-fetch');
const path     = require('path');
const iconv    = require('iconv-lite');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── URL CSV MIMIT ───────────────────────────────────────────────────────────
const MIMIT_PREZZI      = 'https://www.mimit.gov.it/images/exportCSV/prezzo_alle_8.csv';
const MIMIT_ANAGRAFICA  = 'https://www.mimit.gov.it/images/exportCSV/anagrafica_impianti_attivi.csv';

// ─── CACHE in memoria ────────────────────────────────────────────────────────
// I dati MIMIT vengono aggiornati una volta al giorno alle 8:00.
// Teniamo cache per 4 ore per evitare di rifare la chiamata ad ogni request.
const CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 ore

let cache = {
  prezzi:     { data: null, ts: 0 },
  anagrafica: { data: null, ts: 0 },
  merged:     { data: null, ts: 0 },
};

function isCacheValid(entry) {
  return entry.data !== null && (Date.now() - entry.ts) < CACHE_TTL_MS;
}

// ─── CORS & JSON ─────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json());

// ─── STATIC: serve il frontend HTML ──────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ─── SCARICA CSV ─────────────────────────────────────────────────────────────
async function fetchCSV(url) {
  console.log(`[MIMIT] Scaricamento: ${url}`);
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; CarburantiProxy/1.0)',
      'Accept': 'text/csv,text/plain,*/*',
    },
    timeout: 30000,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} da ${url}`);
  const buffer = await res.buffer();
  // I file MIMIT possono essere in ISO-8859-1 o UTF-8, proviamo entrambi
  let text = iconv.decode(buffer, 'utf-8');
  // Se contiene caratteri strani, riprova con latin1
  if (text.includes('â€') || text.includes('Ã')) {
    text = iconv.decode(buffer, 'latin1');
  }
  return text;
}

// ─── PARSE CSV (separatore | dal 10 feb 2026) ────────────────────────────────
function parseCSV(text, sep = '|') {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];

  const headers = lines[0].split(sep).map(h => h.trim().replace(/^"|"$/g, ''));

  return lines.slice(1)
    .filter(l => l.trim().length > 0)
    .map(line => {
      const vals = line.split(sep).map(v => v.trim().replace(/^"|"$/g, ''));
      const obj = {};
      headers.forEach((h, i) => { obj[h] = vals[i] ?? ''; });
      return obj;
    });
}

// ─── CARICA E CACHEA PREZZI ───────────────────────────────────────────────────
async function getPrezzi() {
  if (isCacheValid(cache.prezzi)) return cache.prezzi.data;

  const text = await fetchCSV(MIMIT_PREZZI);
  // Il CSV prezzi usa sia '|' che ';' a seconda della versione; prova '|' prima
  let rows = parseCSV(text, '|');
  if (rows.length < 10) rows = parseCSV(text, ';');

  const data = rows
    .map(r => {
      const idRaw  = r['idImpianto'] || r['Id'] || r['id'] || r['ID'] || '';
      const prezzoRaw = r['prezzo'] || r['Prezzo'] || '';
      const prezzo = parseFloat(prezzoRaw.replace(',', '.'));
      if (!idRaw || isNaN(prezzo) || prezzo <= 0 || prezzo > 10) return null;
      return {
        idImpianto:     idRaw.trim(),
        carburante:     (r['descCarburante'] || r['carburante'] || r['Carburante'] || '').trim(),
        prezzo,
        isSelf:         (r['isSelf'] || r['self'] || '').toLowerCase() === 'true' || r['isSelf'] === '1',
        dtComunicazione: r['dtComu'] || r['dtComunicazione'] || r['data'] || '',
      };
    })
    .filter(Boolean);

  console.log(`[MIMIT] Prezzi caricati: ${data.length} record`);
  cache.prezzi = { data, ts: Date.now() };
  return data;
}

// ─── CARICA E CACHEA ANAGRAFICA ───────────────────────────────────────────────
async function getAnagrafica() {
  if (isCacheValid(cache.anagrafica)) return cache.anagrafica.data;

  const text = await fetchCSV(MIMIT_ANAGRAFICA);
  let rows = parseCSV(text, '|');
  if (rows.length < 10) rows = parseCSV(text, ';');

  const data = rows
    .map(r => {
      const id = (r['idImpianto'] || r['Id'] || r['id'] || '').trim();
      if (!id) return null;
      const lat = parseFloat(r['Latitudine'] || r['lat'] || r['latitudine'] || '0');
      const lng = parseFloat(r['Longitudine'] || r['lng'] || r['longitudine'] || '0');
      return {
        idImpianto: id,
        gestore:    (r['Gestore']   || r['gestore']   || r['nome']    || '—').trim(),
        bandiera:   (r['Bandiera']  || r['bandiera']  || '').trim(),
        tipo:       (r['Tipo']      || r['tipo']      || '').trim(),
        nome:       (r['Nome']      || r['nome']      || '').trim(),
        indirizzo:  (r['Indirizzo'] || r['indirizzo'] || '').trim(),
        comune:     (r['Comune']    || r['comune']    || '').trim(),
        provincia:  (r['Provincia'] || r['provincia'] || '').trim(),
        latitudine: isNaN(lat) ? 0 : lat,
        longitudine: isNaN(lng) ? 0 : lng,
      };
    })
    .filter(Boolean);

  console.log(`[MIMIT] Anagrafica caricata: ${data.length} impianti`);
  cache.anagrafica = { data, ts: Date.now() };
  return data;
}

// ─── MERGE PREZZI + ANAGRAFICA ────────────────────────────────────────────────
async function getMerged() {
  if (isCacheValid(cache.merged)) return cache.merged.data;

  const [prezzi, anagrafica] = await Promise.all([getPrezzi(), getAnagrafica()]);

  // Mappa idImpianto → anagrafica
  const anagMap = {};
  anagrafica.forEach(a => { anagMap[a.idImpianto] = a; });

  const data = prezzi.map(p => {
    const a = anagMap[p.idImpianto] || {};
    return {
      id:           p.idImpianto,
      prezzo:       p.prezzo,
      carburante:   p.carburante,
      isSelf:       p.isSelf,
      dtCom:        p.dtComunicazione,
      gestore:      a.gestore    || '—',
      bandiera:     a.bandiera   || '',
      indirizzo:    [a.indirizzo, a.comune].filter(Boolean).join(', ') || '—',
      comune:       a.comune     || '',
      provincia:    a.provincia  || '',
      latitudine:   a.latitudine  || 0,
      longitudine:  a.longitudine || 0,
    };
  });

  console.log(`[MIMIT] Merge completato: ${data.length} stazioni con prezzi`);
  cache.merged = { data, ts: Date.now() };
  return data;
}

// ─── HELPER: distanza haversine (km) ─────────────────────────────────────────
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ═══════════════════════════════════════════════════════════════════════════════
// ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /health
 * Stato del server e cache
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()) + 's',
    cache: {
      prezzi:     isCacheValid(cache.prezzi)     ? 'valida' : 'scaduta',
      anagrafica: isCacheValid(cache.anagrafica) ? 'valida' : 'scaduta',
      merged:     isCacheValid(cache.merged)     ? 'valida' : 'scaduta',
    },
    nextRefresh: cache.merged.ts
      ? new Date(cache.merged.ts + CACHE_TTL_MS).toISOString()
      : 'non ancora caricato',
  });
});

/**
 * GET /api/stazioni-con-prezzi
 *
 * Query params (tutti opzionali):
 *   carburante  — es. "Benzina", "Gasolio", "GPL", "Metano"
 *   lat         — latitudine utente (per distanza)
 *   lng         — longitudine utente
 *   raggio      — raggio km (default 50, max 200)
 *   limit       — max risultati (default 200, max 2000)
 *   sort        — "prezzo" | "distanza" (default "prezzo")
 *   self        — "true" | "false" (filtra solo self o solo servito)
 */
app.get('/api/stazioni-con-prezzi', async (req, res) => {
  try {
    let data = await getMerged();

    const { carburante, lat, lng, raggio, limit, sort, self } = req.query;

    // Filtro carburante
    if (carburante) {
      const q = carburante.toLowerCase();
      data = data.filter(s => s.carburante.toLowerCase().includes(q));
    }

    // Filtro self/servito
    if (self === 'true')  data = data.filter(s => s.isSelf);
    if (self === 'false') data = data.filter(s => !s.isSelf);

    // Calcola distanza se lat/lng forniti
    const uLat = parseFloat(lat), uLng = parseFloat(lng);
    if (!isNaN(uLat) && !isNaN(uLng)) {
      const maxKm = Math.min(parseFloat(raggio) || 50, 200);
      data = data
        .map(s => ({
          ...s,
          distanza: (s.latitudine && s.longitudine)
            ? haversine(uLat, uLng, s.latitudine, s.longitudine)
            : null,
        }))
        .filter(s => s.distanza === null || s.distanza <= maxKm);
    }

    // Ordina
    if (sort === 'distanza') {
      data.sort((a, b) => (a.distanza ?? 9999) - (b.distanza ?? 9999));
    } else {
      data.sort((a, b) => a.prezzo - b.prezzo);
    }

    // Limita
    const maxLimit = Math.min(parseInt(limit) || 200, 2000);
    data = data.slice(0, maxLimit);

    res.json({
      ok: true,
      count: data.length,
      aggiornatoAlle: new Date(cache.merged.ts).toISOString(),
      fonte: 'MIMIT Open Data - mimit.gov.it',
      data,
    });
  } catch (err) {
    console.error('[API] Errore stazioni-con-prezzi:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /api/prezzi
 * Solo i prezzi grezzi (senza anagrafica)
 */
app.get('/api/prezzi', async (req, res) => {
  try {
    let data = await getPrezzi();
    const { carburante } = req.query;
    if (carburante) data = data.filter(s => s.carburante.toLowerCase().includes(carburante.toLowerCase()));
    res.json({ ok: true, count: data.length, data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /api/stazioni
 * Solo l'anagrafica impianti
 */
app.get('/api/stazioni', async (req, res) => {
  try {
    const data = await getAnagrafica();
    res.json({ ok: true, count: data.length, data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /api/stats
 * Statistiche aggregate per tipo di carburante
 */
app.get('/api/stats', async (req, res) => {
  try {
    const data = await getMerged();

    // Raggruppa per carburante
    const byFuel = {};
    data.forEach(s => {
      if (!byFuel[s.carburante]) byFuel[s.carburante] = [];
      byFuel[s.carburante].push(s.prezzo);
    });

    const stats = Object.entries(byFuel).map(([fuel, prezzi]) => {
      prezzi.sort((a, b) => a - b);
      const sum = prezzi.reduce((a, b) => a + b, 0);
      return {
        carburante: fuel,
        count: prezzi.length,
        min: +prezzi[0].toFixed(3),
        max: +prezzi[prezzi.length - 1].toFixed(3),
        media: +(sum / prezzi.length).toFixed(3),
        mediana: +prezzi[Math.floor(prezzi.length / 2)].toFixed(3),
      };
    }).sort((a, b) => b.count - a.count);

    res.json({ ok: true, aggiornatoAlle: new Date(cache.merged.ts).toISOString(), stats });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /api/refresh
 * Forza il refresh della cache (utile dopo le 8:00)
 */
app.get('/api/refresh', async (req, res) => {
  cache = { prezzi: { data: null, ts: 0 }, anagrafica: { data: null, ts: 0 }, merged: { data: null, ts: 0 } };
  try {
    await getMerged();
    res.json({ ok: true, message: 'Cache aggiornata con i dati MIMIT più recenti' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Fallback SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── AVVIO ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 Server avviato su http://localhost:${PORT}`);
  console.log(`📊 API disponibili:`);
  console.log(`   GET /api/stazioni-con-prezzi?carburante=Benzina&lat=41.9&lng=12.5&raggio=20`);
  console.log(`   GET /api/stats`);
  console.log(`   GET /api/refresh`);
  console.log(`   GET /health\n`);

  // Pre-carica la cache all'avvio in background
  getMerged().catch(err => console.warn('[INIT] Pre-caricamento cache fallito:', err.message));
});
