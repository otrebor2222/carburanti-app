'use strict';

const express = require('express');
const fetch   = require('node-fetch');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

const MIMIT_PREZZI     = 'https://www.mimit.gov.it/images/exportCSV/prezzo_alle_8.csv';
const MIMIT_ANAGRAFICA = 'https://www.mimit.gov.it/images/exportCSV/anagrafica_impianti_attivi.csv';

const CACHE_TTL = 8 * 60 * 60 * 1000;
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

// ─── SCARICA CSV ──────────────────────────────────────────────────────────────
async function scaricaCSV(url) {
  const res = await fetch(url, {
    timeout: 45000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; CarburantiBot/2.0)',
      'Accept': 'text/csv, text/plain, */*',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// ─── PARSE CSV MIMIT ──────────────────────────────────────────────────────────
// I CSV MIMIT hanno questo formato:
// Riga 0: "estrazione del 2026-04-11"   ← intestazione con data, DA SALTARE
// Riga 1: idImpianto|...|...|...        ← headers reali delle colonne
// Riga 2+: dati
function parseCSVMIMIT(testo) {
  const righe = testo.replace(/\r/g, '').split('\n').filter(r => r.trim());
  if (righe.length < 3) return [];

  // Trova la riga degli headers reali (quella che contiene "idImpianto" o "idimpianto")
  let headerIdx = -1;
  for (let i = 0; i < Math.min(5, righe.length); i++) {
    const r = righe[i].toLowerCase();
    if (r.includes('idimpianto') || r.includes('id_impianto') || r.includes('codicimpianto')) {
      headerIdx = i;
      break;
    }
  }

  if (headerIdx === -1) {
    console.log('[WARN] Header idImpianto non trovato nelle prime 5 righe, uso riga 1');
    headerIdx = 1; // fallback: salta solo la prima riga (data)
  }

  console.log(`[INFO] Header trovato alla riga ${headerIdx}: ${righe[headerIdx].substring(0, 100)}`);

  // Rileva separatore dalla riga degli headers
  const headerRiga = righe[headerIdx];
  const nPipe  = (headerRiga.match(/\|/g) || []).length;
  const nSemic = (headerRiga.match(/;/g)  || []).length;
  const sep    = nPipe >= nSemic ? '|' : ';';
  console.log(`[INFO] Separatore rilevato: "${sep}" (pipe:${nPipe}, semicolon:${nSemic})`);

  const heads = headerRiga.split(sep).map(h => h.trim().replace(/"/g, '').toLowerCase());
  console.log(`[INFO] Headers: ${heads.join(', ')}`);

  const risultati = [];
  for (let i = headerIdx + 1; i < righe.length; i++) {
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
    const v = obj[k];
    if (v !== undefined && v !== '') return v;
  }
  return '';
}

// ─── AGGIORNA CACHE ───────────────────────────────────────────────────────────
async function aggiornaDati() {
  if (CACHE.loading) return;
  CACHE.loading = true;
  CACHE.errore  = null;
  console.log(`\n[${new Date().toISOString()}] Scaricamento CSV MIMIT...`);

  try {
    const [tPrezzi, tAnag] = await Promise.all([
      scaricaCSV(MIMIT_PREZZI),
      scaricaCSV(MIMIT_ANAGRAFICA),
    ]);

    console.log(`[INFO] Prezzi: ${tPrezzi.length} bytes | Anagrafica: ${tAnag.length} bytes`);

    // Log prime 3 righe per debug
    const prime3P = tPrezzi.split('\n').slice(0, 3).join(' || ');
    const prime3A = tAnag.split('\n').slice(0, 3).join(' || ');
    console.log(`[DEBUG] Prime righe PREZZI: ${prime3P.substring(0, 200)}`);
    console.log(`[DEBUG] Prime righe ANAGRAFICA: ${prime3A.substring(0, 200)}`);

    const rowsPrezzi = parseCSVMIMIT(tPrezzi);
    const rowsAnag   = parseCSVMIMIT(tAnag);

    console.log(`[INFO] Parsificati: ${rowsPrezzi.length} prezzi, ${rowsAnag.length} anagrafica`);
    if (rowsPrezzi.length > 0) console.log('[DEBUG] Esempio prezzo:', JSON.stringify(rowsPrezzi[0]));
    if (rowsAnag.length > 0)   console.log('[DEBUG] Esempio anagrafica:', JSON.stringify(rowsAnag[0]));

    if (rowsPrezzi.length < 100) throw new Error(`Troppo pochi prezzi: ${rowsPrezzi.length}`);

    // Mappa anagrafica
    const anagMap = new Map();
    for (const r of rowsAnag) {
      // Prova tutti i possibili nomi del campo ID
      const id = (r['idimpianto'] || r['id_impianto'] || r['id'] || r['codicimpianto'] || '').trim();
      if (id) anagMap.set(id, r);
    }
    console.log(`[INFO] Anagrafica mappata: ${anagMap.size} impianti`);

    // Merge
    const stazioni = [];
    let skipPrezzo = 0, skipId = 0;

    for (const r of rowsPrezzi) {
      const id     = (r['idimpianto'] || r['id_impianto'] || r['id'] || r['codicimpianto'] || '').trim();
      const pStr   = (r['prezzo'] || r['price'] || r['prezzoself'] || '').replace(',', '.');
      const prezzo = parseFloat(pStr);

      if (!id) { skipId++; continue; }
      if (isNaN(prezzo) || prezzo < 0.3 || prezzo > 6) { skipPrezzo++; continue; }

      const a   = anagMap.get(id) || {};
      const lat = parseFloat(a['latitudine'] || a['lat'] || a['latitude'] || '0');
      const lng = parseFloat(a['longitudine'] || a['lng'] || a['lon'] || a['longitude'] || '0');

      stazioni.push({
        id,
        prezzo,
        carburante: r['desccarburante'] || r['carburante'] || r['tipo'] || r['fuel'] || '',
        isSelf:     (r['isself'] || r['self'] || r['modalita'] || '').toLowerCase() === 'true'
                 || (r['isself'] || '') === '1',
        dtCom:      r['dtcomu'] || r['dtcomunicazione'] || r['data'] || '',
        gestore:    a['gestore'] || a['bandiera'] || a['nome'] || a['brand'] || '—',
        indirizzo:  [a['indirizzo'] || a['via'] || '', a['comune'] || ''].filter(Boolean).join(', ') || '—',
        comune:     a['comune'] || a['citta'] || '',
        provincia:  a['provincia'] || a['prov'] || '',
        latitudine: isNaN(lat) ? 0 : lat,
        longitudine:isNaN(lng) ? 0 : lng,
      });
    }

    console.log(`[INFO] Stazioni create: ${stazioni.length} (skip id:${skipId}, skip prezzo:${skipPrezzo})`);
    if (stazioni.length > 0) console.log('[DEBUG] Esempio stazione:', JSON.stringify(stazioni[0]));

    if (stazioni.length < 50) throw new Error(`Merge fallito: ${stazioni.length} stazioni. Verifica i log qui sopra.`);

    CACHE.data = stazioni;
    CACHE.ts   = Date.now();
    console.log(`[OK] ✅ Cache aggiornata: ${stazioni.length} stazioni`);

    const tipi = [...new Set(stazioni.map(s => s.carburante).filter(Boolean))].slice(0, 8);
    console.log('[INFO] Tipi carburante:', tipi.join(', '));

  } catch (e) {
    CACHE.errore = e.message;
    console.error('[ERRORE]', e.message);
  } finally {
    CACHE.loading = false;
  }
}

// ─── HAVERSINE ────────────────────────────────────────────────────────────────
function hav(la1, lo1, la2, lo2) {
  const R = 6371, dL = (la2-la1)*Math.PI/180, dl = (lo2-lo1)*Math.PI/180;
  const a = Math.sin(dL/2)**2 + Math.cos(la1*Math.PI/180)*Math.cos(la2*Math.PI/180)*Math.sin(dl/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────
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

app.get('/api/refresh', async (req, res) => {
  CACHE.ts = 0;
  CACHE.loading = false;
  await aggiornaDati();
  res.json({ ok: true, stazioni: CACHE.data?.length || 0, errore: CACHE.errore || null });
});

app.get('/api/stazioni-con-prezzi', async (req, res) => {
  if (!CACHE.data || CACHE.data.length === 0) {
    if (!CACHE.loading) aggiornaDati();
    return res.status(503).json({ ok: false, error: 'Dati in caricamento, riprova tra 30 secondi.', retry: 30 });
  }
  if ((Date.now() - CACHE.ts) > CACHE_TTL && !CACHE.loading) aggiornaDati();

  const { carburante, lat, lng, raggio, limit } = req.query;
  let dati = CACHE.data;

  if (carburante) {
    const q = carburante.toLowerCase().trim();
    dati = dati.filter(s => s.carburante.toLowerCase().includes(q));
    if (dati.length < 5) dati = CACHE.data; // fallback: tutti
  }

  const uLat = parseFloat(lat), uLng = parseFloat(lng);
  const km   = Math.min(parseFloat(raggio) || 50, 200);

  if (!isNaN(uLat) && !isNaN(uLng)) {
    dati = dati
      .map(s => ({ ...s, distanza: (s.latitudine && s.longitudine) ? hav(uLat, uLng, s.latitudine, s.longitudine) : null }))
      .filter(s => s.distanza === null || s.distanza <= km)
      .sort((a, b) => (a.distanza ?? 999) - (b.distanza ?? 999));
  } else {
    dati = [...dati].sort((a, b) => a.prezzo - b.prezzo);
  }

  dati = dati.slice(0, Math.min(parseInt(limit) || 300, 2000));

  res.json({ ok: true, count: dati.length, aggiornatoAlle: new Date(CACHE.ts).toISOString(), fonte: 'MIMIT Open Data', data: dati });
});

app.get('/api/stats', (req, res) => {
  if (!CACHE.data) return res.json({ ok: false, error: 'Dati non disponibili' });
  const mappa = {};
  for (const s of CACHE.data) {
    const c = s.carburante || 'altro';
    if (!mappa[c]) mappa[c] = [];
    mappa[c].push(s.prezzo);
  }
  const stats = Object.entries(mappa)
    .map(([c, pp]) => { pp.sort((a,b)=>a-b); return { carburante:c, count:pp.length, min:+pp[0].toFixed(3), max:+pp[pp.length-1].toFixed(3), media:+(pp.reduce((a,b)=>a+b,0)/pp.length).toFixed(3) }; })
    .sort((a, b) => b.count - a.count);
  res.json({ ok: true, aggiornatoAlle: new Date(CACHE.ts).toISOString(), stats });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ─── AVVIO ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Server avviato su porta ${PORT}`);
  aggiornaDati();
  setInterval(aggiornaDati, CACHE_TTL);
});
