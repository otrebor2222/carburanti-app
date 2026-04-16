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

// ─── NOMI COMMERCIALI ─────────────────────────────────────────────────────────
const NOMI = [
  ['enimoov',           'ENI'],
  ['agip',              'ENI'],
  ['eni ',              'ENI'],
  ['ip services',       'IP'],
  ['italiana petroli',  'IP'],
  ['q8',                'Q8'],
  ['kuwait',            'Q8'],
  ['shell',             'Shell'],
  ['tamoil',            'Tamoil'],
  ['totalenergies',     'TotalEnergies'],
  ['total ',            'TotalEnergies'],
  ['esso',              'Esso'],
  ['exxon',             'Esso'],
  ['api-ip',            'API-IP'],
  ['erg ',              'ERG'],
  ['costco',            'Costco'],
  ['carrefour',         'Carrefour'],
  ['conad',             'Conad'],
  ['esselunga',         'Esselunga'],
  ['vega carburanti',   'Vega'],
  ['sarni',             'Sarni'],
  ['europam',           'Europam'],
  ['sia fuel',          'SIA Fuel'],
  ['san marco petroli', 'San Marco Petroli'],
  ['goldengas',         'Goldengas'],
];

function gestoreOk(g) {
  // Scarta qualsiasi cosa che sembri un URL o sito web
  return !(
    /\.(it|com|net|org|eu|info)\b/i.test(g) ||
    /https?:\/\//i.test(g) ||
    /^www\./i.test(g) ||
    g.includes('/') ||
    g.includes('@') ||
    g.toLowerCase().includes('prezzibenzina') ||
    g.toLowerCase().includes('gestori.')
  );
}

function normalizzaGestore(raw) {
  if (!raw || !raw.trim()) return 'Indipendente';
  const s = raw.trim();

  // Scarta URL
  if (!gestoreOk(s)) return 'Indipendente';

  // Valori generici
  if (['n/a','nd','n.d.','null','none','-','--','---'].includes(s.toLowerCase()))
    return 'Indipendente';

  // Cerca nome commerciale
  const sl = s.toLowerCase();
  for (const [chiave, nome] of NOMI) {
    if (sl.includes(chiave)) return nome;
  }

  // Pulisce nome legale
  let p = s
    .replace(/\bS\.?R\.?L\.?\b/gi, '')
    .replace(/\bS\.?P\.?A\.?\b/gi, '')
    .replace(/\bS\.?N\.?C\.?\b/gi, '')
    .replace(/\bS\.?A\.?S\.?\b/gi, '')
    .replace(/\bIN SIGLA.*$/i, '')
    .replace(/\bA SOCIO UNICO\b/gi, '')
    .replace(/\bPER AZIONI\b/gi, '')
    .replace(/\bSOCIETA'?\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!p) return 'Indipendente';

  // Capitalizza
  if (p === p.toUpperCase() && p.length > 2)
    p = p.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());

  return p;
}

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
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CarburantiBot/3.0)' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// ─── PARSE CSV MIMIT ──────────────────────────────────────────────────────────
function parseCSVMIMIT(testo) {
  const righe = testo.replace(/\r/g, '').split('\n').filter(r => r.trim());
  if (righe.length < 3) return [];
  let hi = -1;
  for (let i = 0; i < Math.min(5, righe.length); i++) {
    if (righe[i].toLowerCase().includes('idimpianto')) { hi = i; break; }
  }
  if (hi === -1) hi = 1;
  const hr = righe[hi];
  const sep = (hr.match(/\|/g)||[]).length >= (hr.match(/;/g)||[]).length ? '|' : ';';
  const heads = hr.split(sep).map(h => h.trim().replace(/"/g,'').toLowerCase());
  const out = [];
  for (let i = hi + 1; i < righe.length; i++) {
    const vals = righe[i].split(sep).map(v => v.trim().replace(/"/g,''));
    if (vals.length < 2) continue;
    const o = {};
    heads.forEach((h, j) => { o[h] = vals[j] || ''; });
    out.push(o);
  }
  return out;
}

function get(obj, ...keys) {
  for (const k of keys) { if (obj[k] !== undefined && obj[k] !== '') return obj[k]; }
  return '';
}

// ─── HAVERSINE ────────────────────────────────────────────────────────────────
function hav(la1, lo1, la2, lo2) {
  const R = 6371;
  const dL = (la2 - la1) * Math.PI / 180;
  const dl = (lo2 - lo1) * Math.PI / 180;
  const a  = Math.sin(dL/2)**2 + Math.cos(la1*Math.PI/180)*Math.cos(la2*Math.PI/180)*Math.sin(dl/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── AGGIORNA CACHE ───────────────────────────────────────────────────────────
async function aggiornaDati() {
  if (CACHE.loading) return;
  CACHE.loading = true;
  CACHE.errore  = null;
  console.log(`[${new Date().toISOString()}] Scaricamento MIMIT...`);

  try {
    const [tP, tA] = await Promise.all([scaricaCSV(MIMIT_PREZZI), scaricaCSV(MIMIT_ANAGRAFICA)]);
    const rowsP = parseCSVMIMIT(tP);
    const rowsA = parseCSVMIMIT(tA);
    console.log(`[INFO] ${rowsP.length} prezzi, ${rowsA.length} anagrafica`);

    const anagMap = new Map();
    for (const r of rowsA) {
      const id = (get(r, 'idimpianto', 'id') || '').trim();
      if (id) anagMap.set(id, r);
    }

    const stazioni = [];
    let senzaCoord = 0;

    for (const r of rowsP) {
      const id     = (get(r, 'idimpianto', 'id') || '').trim();
      const prezzo = parseFloat((get(r, 'prezzo') || '').replace(',', '.'));
      if (!id || isNaN(prezzo) || prezzo < 0.3 || prezzo > 6) continue;

      const a   = anagMap.get(id) || {};
      const lat = parseFloat(get(a, 'latitudine', 'lat') || '0');
      const lng = parseFloat(get(a, 'longitudine', 'lng') || '0');

      // *** SCARTA stazioni senza coordinate valide ***
      // Senza lat/lng non possiamo filtrare per distanza, quindi le escludiamo
      if (!lat || !lng || Math.abs(lat) < 1 || Math.abs(lng) < 1) {
        senzaCoord++;
        continue;
      }

      // Verifica che le coordinate siano in Italia (bounding box approssimativo)
      if (lat < 35.0 || lat > 48.0 || lng < 6.0 || lng > 19.0) continue;

      const gestoreRaw = get(a, 'gestore', 'bandiera', 'insegna', 'nome', 'brand');
      const gestore    = normalizzaGestore(gestoreRaw);

      stazioni.push({
        id, prezzo,
        carburante: get(r, 'desccarburante', 'carburante'),
        isSelf:     (get(r, 'isself') || '').toLowerCase() === 'true' || get(r, 'isself') === '1',
        dtCom:      (get(r, 'dtcomu', 'data') || '').split(' ')[0],
        gestore,
        indirizzo:  [get(a, 'indirizzo'), get(a, 'comune')].filter(Boolean).join(', ') || '—',
        comune:     get(a, 'comune'),
        provincia:  get(a, 'provincia'),
        latitudine: lat,
        longitudine: lng,
      });
    }

    if (stazioni.length < 100) throw new Error(`Solo ${stazioni.length} stazioni`);

    CACHE.data = stazioni;
    CACHE.ts   = Date.now();
    console.log(`[OK] ${stazioni.length} stazioni con coordinate | ${senzaCoord} scartate senza coord`);

  } catch (e) {
    CACHE.errore = e.message;
    console.error('[ERRORE]', e.message);
  } finally {
    CACHE.loading = false;
  }
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
  CACHE.ts = 0; CACHE.loading = false;
  await aggiornaDati();
  res.json({ ok: true, stazioni: CACHE.data?.length || 0, errore: CACHE.errore || null });
});

app.get('/api/debug/gestori', (req, res) => {
  if (!CACHE.data) return res.json({ ok: false });
  const m = {};
  for (const s of CACHE.data) m[s.gestore] = (m[s.gestore]||0) + 1;
  const top = Object.entries(m).sort((a,b) => b[1]-a[1]).slice(0, 30).map(([g,n]) => ({gestore:g, count:n}));
  res.json({ ok: true, top });
});

app.get('/api/stazioni-con-prezzi', async (req, res) => {
  if (!CACHE.data || CACHE.data.length === 0) {
    if (!CACHE.loading) aggiornaDati();
    return res.status(503).json({ ok: false, error: 'Dati in caricamento, riprova tra 30 secondi.', retry: 30 });
  }
  if ((Date.now() - CACHE.ts) > CACHE_TTL && !CACHE.loading) aggiornaDati();

  const { carburante, lat, lng, raggio, limit } = req.query;
  const uLat = parseFloat(lat);
  const uLng = parseFloat(lng);
  const km   = Math.min(parseFloat(raggio) || 50, 200);

  // *** SE non vengono fornite coordinate lat/lng valide, rifiuta la richiesta ***
  // Non restituiamo MAI stazioni senza un centro di ricerca valido
  if (isNaN(uLat) || isNaN(uLng)) {
    return res.status(400).json({
      ok: false,
      error: 'Parametri lat e lng obbligatori. Fornisci una posizione GPS o una città.',
    });
  }

  let dati = CACHE.data;

  // Filtra per carburante
  if (carburante) {
    const q = carburante.toLowerCase().trim();
    const filtrati = dati.filter(s => s.carburante.toLowerCase().includes(q));
    if (filtrati.length >= 5) dati = filtrati;
  }

  // Calcola distanza e filtra per raggio — OBBLIGATORIO
  dati = dati
    .map(s => ({
      ...s,
      distanza: hav(uLat, uLng, s.latitudine, s.longitudine),
    }))
    .filter(s => s.distanza <= km)
    .sort((a, b) => a.distanza - b.distanza)
    .slice(0, Math.min(parseInt(limit) || 300, 2000));

  res.json({
    ok: true,
    count: dati.length,
    aggiornatoAlle: new Date(CACHE.ts).toISOString(),
    fonte: 'MIMIT Open Data',
    data: dati,
  });
});

app.get('/api/stats', (req, res) => {
  if (!CACHE.data) return res.json({ ok: false, error: 'Dati non disponibili' });
  const m = {};
  for (const s of CACHE.data) {
    const c = s.carburante || 'altro';
    if (!m[c]) m[c] = [];
    m[c].push(s.prezzo);
  }
  const stats = Object.entries(m)
    .map(([c, pp]) => { pp.sort((a,b)=>a-b); return { carburante:c, count:pp.length, min:+pp[0].toFixed(3), max:+pp[pp.length-1].toFixed(3), media:+(pp.reduce((a,b)=>a+b,0)/pp.length).toFixed(3) }; })
    .sort((a, b) => b.count - a.count);
  res.json({ ok: true, aggiornatoAlle: new Date(CACHE.ts).toISOString(), stats });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`🚀 Server avviato su porta ${PORT}`);
  aggiornaDati();
  setInterval(aggiornaDati, CACHE_TTL);
});
