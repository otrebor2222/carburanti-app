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

// ─── MAPPA NOMI LEGALI → NOMI COMMERCIALI ─────────────────────────────────────
// Basata sui dati reali del CSV MIMIT (campo "gestore")
const MAPPA_GESTORI = {
  // ENI / Agip / EniMoov
  'enimoov':        'ENI',
  'eni ':           'ENI',
  'agip':           'ENI',

  // IP / IP Services
  'ip services':    'IP',
  'italiana petroli':'IP',
  'ip carburanti':  'IP',

  // Q8 / Kuwait
  'q8':             'Q8',
  'kuwait':         'Q8',
  'kuwait petroleum':'Q8',

  // Shell
  'shell':          'Shell',

  // Tamoil
  'tamoil':         'Tamoil',

  // TotalEnergies
  'total':          'TotalEnergies',
  'totalenergies':  'TotalEnergies',

  // Esso / ExxonMobil
  'esso':           'Esso',
  'exxon':          'Esso',

  // API / IP
  'api-ip':         'API-IP',
  'api ':           'API-IP',

  // ERG
  'erg':            'ERG',

  // Costco / Carrefour
  'costco':         'Costco',
  'carrefour':      'Carrefour',
  'conad':          'Conad',
  'coop':           'Coop',
  'esselunga':      'Esselunga',
  'decathlon':      'Decathlon',
  'ikea':           'IKEA',
  'auchan':         'Auchan',

  // Gestioni / Distributori generici comuni
  'servizi & gestioni italia':  'Distributore Indipendente',
  'servizi e gestioni zenit':   'Zenit',
  't.d.m.':                     'TDM',
  'pad multienergy':            'PAD',
  'egi-2go':                    'EGI',
  'easy service':               'Easy Service',
  'gestioni innovative italia': 'GII',
  'vega carburanti':            'Vega',
  'sarni':                      'Sarni',
  'eos services':               'EOS',
  'nuova sidap':                'Sidap',
  'ala carburanti':             'ALA',
  'keropetrol':                 'Keropetrol',
  'europam':                    'Europam',
  'sia fuel':                   'SIA Fuel',
  'enerpetroli':                'Enerpetroli',
  'spazio s.r.l.':              'Spazio',
  'cristella petroli':          'Cristella',
  'toil ':                      'TOIL',
  'sirtam':                     'Sirtam',
  'san marco petroli':          'San Marco Petroli',
  'economy s.r.l.':             'Economy',
  'loro f.':                    'Loro',
  'simonetti mario':            'Simonetti',
  'a.f. petroli':               'AF Petroli',
  'dima s.r.l.':                'DIMA',
  'energia s.p.a.':             'Energia',
  'goldengas':                  'Goldengas',
};

function normalizzaGestore(raw) {
  if (!raw) return 'Indipendente';
  const s = raw.trim();
  if (!s) return 'Indipendente';

  // Scarta URL e indirizzi web
  if (/\.(it|com|net|org|eu|info)\b/i.test(s)) return 'Indipendente';
  if (/https?:\/\//i.test(s)) return 'Indipendente';
  if (/^www\./i.test(s)) return 'Indipendente';
  if (s.includes('/') || s.includes('@')) return 'Indipendente';

  // Scarta valori generici
  const nd = ['n/a','nd','n.d.','non disponibile','sconosciuto','null','none','---','--','-'];
  if (nd.includes(s.toLowerCase())) return 'Indipendente';

  // Cerca corrispondenza nella mappa (case-insensitive, substring)
  const sl = s.toLowerCase();
  for (const [chiave, nome] of Object.entries(MAPPA_GESTORI)) {
    if (sl.includes(chiave.toLowerCase())) return nome;
  }

  // Pulisci il nome legale: rimuovi forma societaria e uniforma
  // Es: "MARIO ROSSI S.R.L." → "Mario Rossi"
  let pulito = s
    .replace(/\bS\.R\.L\.?\b/gi, '')
    .replace(/\bS\.P\.A\.?\b/gi, '')
    .replace(/\bS\.N\.C\.?\b/gi, '')
    .replace(/\bS\.A\.S\.?\b/gi, '')
    .replace(/\bS\.S\.?\b/gi, '')
    .replace(/\bDITTA\b/gi, '')
    .replace(/\bSOCIETA'?\b/gi, '')
    .replace(/\bSOCIETA'\b/gi, '')
    .replace(/\bIN SIGLA.*$/i, '')  // rimuove "IN SIGLA - NOME S.R.L."
    .replace(/\bA SOCIO UNICO\b/gi, '')
    .replace(/\bPER AZIONI\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Capitalizza: "MARIO ROSSI" → "Mario Rossi"
  if (pulito === pulito.toUpperCase() && pulito.length > 2) {
    pulito = pulito.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
  }

  return pulito || 'Indipendente';
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
  const headerRiga = righe[hi];
  const sep = (headerRiga.match(/\|/g)||[]).length >= (headerRiga.match(/;/g)||[]).length ? '|' : ';';
  const heads = headerRiga.split(sep).map(h => h.trim().replace(/"/g,'').toLowerCase());
  const risultati = [];
  for (let i = hi + 1; i < righe.length; i++) {
    const vals = righe[i].split(sep).map(v => v.trim().replace(/"/g,''));
    if (vals.length < 2) continue;
    const o = {};
    heads.forEach((h, j) => { o[h] = vals[j] || ''; });
    risultati.push(o);
  }
  return risultati;
}

function get(obj, ...keys) {
  for (const k of keys) { if (obj[k] !== undefined && obj[k] !== '') return obj[k]; }
  return '';
}

// ─── AGGIORNA CACHE ───────────────────────────────────────────────────────────
async function aggiornaDati() {
  if (CACHE.loading) return;
  CACHE.loading = true;
  CACHE.errore  = null;
  console.log(`[${new Date().toISOString()}] Scaricamento CSV MIMIT...`);
  try {
    const [tPrezzi, tAnag] = await Promise.all([
      scaricaCSV(MIMIT_PREZZI),
      scaricaCSV(MIMIT_ANAGRAFICA),
    ]);
    const rowsPrezzi = parseCSVMIMIT(tPrezzi);
    const rowsAnag   = parseCSVMIMIT(tAnag);
    console.log(`[INFO] ${rowsPrezzi.length} prezzi, ${rowsAnag.length} anagrafica`);

    const anagMap = new Map();
    for (const r of rowsAnag) {
      const id = (get(r, 'idimpianto', 'id') || '').trim();
      if (id) anagMap.set(id, r);
    }

    const stazioni = [];
    for (const r of rowsPrezzi) {
      const id     = (get(r, 'idimpianto', 'id') || '').trim();
      const prezzo = parseFloat((get(r, 'prezzo') || '').replace(',', '.'));
      if (!id || isNaN(prezzo) || prezzo < 0.3 || prezzo > 6) continue;

      const a   = anagMap.get(id) || {};
      const lat = parseFloat(get(a, 'latitudine', 'lat') || '0');
      const lng = parseFloat(get(a, 'longitudine', 'lng') || '0');

      // Prende il gestore dal CSV e lo normalizza
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
        latitudine: isNaN(lat) ? 0 : lat,
        longitudine:isNaN(lng) ? 0 : lng,
      });
    }

    if (stazioni.length < 100) throw new Error(`Solo ${stazioni.length} stazioni`);
    CACHE.data = stazioni;
    CACHE.ts   = Date.now();
    console.log(`[OK] ${stazioni.length} stazioni in cache`);

    // Log top gestori per verifica
    const gCount = {};
    stazioni.forEach(s => { gCount[s.gestore] = (gCount[s.gestore]||0)+1; });
    const top5 = Object.entries(gCount).sort((a,b)=>b[1]-a[1]).slice(0,5);
    console.log('[TOP GESTORI]', top5.map(([g,n])=>`${g}:${n}`).join(', '));

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
  res.json({ ok:true, stazioni:CACHE.data?.length||0, cacheValida:CACHE.data!==null&&(Date.now()-CACHE.ts)<CACHE_TTL, aggiornato:CACHE.ts?new Date(CACHE.ts).toISOString():null, errore:CACHE.errore||null, loading:CACHE.loading });
});

app.get('/api/refresh', async (req, res) => {
  CACHE.ts=0; CACHE.loading=false;
  await aggiornaDati();
  res.json({ ok:true, stazioni:CACHE.data?.length||0, errore:CACHE.errore||null });
});

app.get('/api/debug/gestori', (req, res) => {
  if (!CACHE.data) return res.json({ ok:false, error:'Cache vuota' });
  const m={};
  for(const s of CACHE.data) m[s.gestore]=(m[s.gestore]||0)+1;
  const top=Object.entries(m).sort((a,b)=>b[1]-a[1]).slice(0,30).map(([g,n])=>({gestore:g,count:n}));
  res.json({ ok:true, top });
});

app.get('/api/stazioni-con-prezzi', async (req, res) => {
  if (!CACHE.data||CACHE.data.length===0) {
    if(!CACHE.loading) aggiornaDati();
    return res.status(503).json({ ok:false, error:'Dati in caricamento, riprova tra 30 secondi.', retry:30 });
  }
  if((Date.now()-CACHE.ts)>CACHE_TTL&&!CACHE.loading) aggiornaDati();

  const {carburante,lat,lng,raggio,limit}=req.query;
  let dati=CACHE.data;

  if(carburante){
    const q=carburante.toLowerCase().trim();
    dati=dati.filter(s=>s.carburante.toLowerCase().includes(q));
    if(dati.length<5) dati=CACHE.data;
  }

  const uLat=parseFloat(lat),uLng=parseFloat(lng),km=Math.min(parseFloat(raggio)||50,200);
  if(!isNaN(uLat)&&!isNaN(uLng)){
    dati=dati
      .map(s=>({...s,distanza:(s.latitudine&&s.longitudine)?hav(uLat,uLng,s.latitudine,s.longitudine):null}))
      .filter(s=>s.distanza===null||s.distanza<=km)
      .sort((a,b)=>(a.distanza??999)-(b.distanza??999));
  }else{
    dati=[...dati].sort((a,b)=>a.prezzo-b.prezzo);
  }

  dati=dati.slice(0,Math.min(parseInt(limit)||300,2000));
  res.json({ ok:true, count:dati.length, aggiornatoAlle:new Date(CACHE.ts).toISOString(), fonte:'MIMIT Open Data', data:dati });
});

app.get('/api/stats',(req,res)=>{
  if(!CACHE.data) return res.json({ok:false,error:'Dati non disponibili'});
  const m={};
  for(const s of CACHE.data){const c=s.carburante||'altro';if(!m[c])m[c]=[];m[c].push(s.prezzo);}
  const stats=Object.entries(m).map(([c,pp])=>{pp.sort((a,b)=>a-b);return{carburante:c,count:pp.length,min:+pp[0].toFixed(3),max:+pp[pp.length-1].toFixed(3),media:+(pp.reduce((a,b)=>a+b,0)/pp.length).toFixed(3)};}).sort((a,b)=>b.count-a.count);
  res.json({ok:true,aggiornatoAlle:new Date(CACHE.ts).toISOString(),stats});
});

app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));

app.listen(PORT,()=>{
  console.log(`🚀 Server avviato su porta ${PORT}`);
  aggiornaDati();
  setInterval(aggiornaDati,CACHE_TTL);
});
