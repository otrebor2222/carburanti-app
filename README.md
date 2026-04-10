# OsservaPrezzi Carburanti — MIMIT Open Data

App web per la comparazione dei prezzi di benzina, diesel e GPL in Italia,
con dati ufficiali del **Ministero delle Imprese e del Made in Italy (MIMIT)**.

## Perché serve un backend?

I CSV ufficiali del MIMIT sono ospitati su `mimit.gov.it` **senza header CORS**,
quindi il browser blocca le chiamate dirette dal frontend.

Questo server Node.js risolve il problema:
- Scarica i CSV lato server (nessun blocco CORS)
- Li parsifica e li serve come JSON pulito
- Mantiene una **cache di 4 ore** (i dati MIMIT si aggiornano una volta al giorno)
- Aggiunge geolocalizzazione, filtri e statistiche

---

## Requisiti

- **Node.js** v16 o superiore → https://nodejs.org
- Connessione internet (per scaricare i CSV MIMIT)

---

## Installazione e avvio

```bash
# 1. Entra nella cartella del progetto
cd carburanti-app

# 2. Installa le dipendenze (solo la prima volta)
npm install

# 3. Avvia il server
npm start
```

Il server si avvia su **http://localhost:3000**

Apri il browser su http://localhost:3000 — vedrai l'app con i dati reali MIMIT.

---

## API disponibili

### `GET /api/stazioni-con-prezzi`
Ritorna le stazioni con prezzi, filtrate e ordinate.

**Parametri opzionali:**

| Param        | Tipo    | Default | Descrizione                              |
|--------------|---------|---------|------------------------------------------|
| `carburante` | string  | tutti   | es. `Benzina`, `Gasolio`, `GPL`, `Metano`|
| `lat`        | float   | —       | Latitudine utente (per distanza)         |
| `lng`        | float   | —       | Longitudine utente                       |
| `raggio`     | int     | 50      | Raggio in km (max 200)                   |
| `limit`      | int     | 200     | Max risultati (max 2000)                 |
| `sort`       | string  | prezzo  | `prezzo` oppure `distanza`               |
| `self`       | boolean | —       | `true` = solo self-service               |

**Esempio:**
```
GET /api/stazioni-con-prezzi?carburante=Benzina&lat=41.12&lng=16.87&raggio=15&limit=50
```

**Risposta:**
```json
{
  "ok": true,
  "count": 47,
  "aggiornatoAlle": "2026-04-08T06:00:00.000Z",
  "fonte": "MIMIT Open Data - mimit.gov.it",
  "data": [
    {
      "id": "12345",
      "prezzo": 1.729,
      "carburante": "Benzina",
      "isSelf": true,
      "gestore": "ENI",
      "indirizzo": "Via Roma 1, Bari",
      "comune": "Bari",
      "provincia": "BA",
      "latitudine": 41.1234,
      "longitudine": 16.8765,
      "distanza": 2.4
    }
  ]
}
```

---

### `GET /api/stats`
Statistiche aggregate per tipo di carburante.

```json
{
  "ok": true,
  "stats": [
    {
      "carburante": "Benzina",
      "count": 18234,
      "min": 1.619,
      "max": 2.199,
      "media": 1.789,
      "mediana": 1.779
    }
  ]
}
```

---

### `GET /api/stazioni`
Anagrafica completa degli impianti (senza prezzi).

### `GET /api/prezzi`
Solo i prezzi grezzi (senza dati di localizzazione).

### `GET /api/refresh`
Forza il rinnovo della cache (utile dopo le 8:00 per avere i dati aggiornati).

### `GET /health`
Stato del server e della cache.

---

## Fonte dati

- **CSV Prezzi:** https://www.mimit.gov.it/images/exportCSV/prezzo_alle_8.csv
- **CSV Anagrafica:** https://www.mimit.gov.it/images/exportCSV/anagrafica_impianti_attivi.csv
- **Pagina ufficiale:** https://www.mimit.gov.it/it/open-data/elenco-dataset/carburanti-prezzi-praticati-e-anagrafica-degli-impianti
- **Licenza:** IODL 2.0
- **Base legale:** Art. 51, comma 1, L. 23 luglio 2009 n. 99
- **Aggiornamento:** quotidiano alle ore 8:00
- **Separatore CSV:** `|` (pipe) dal 10 febbraio 2026

---

## Struttura progetto

```
carburanti-app/
├── server.js          ← backend Node.js (proxy + API JSON)
├── package.json
├── README.md
└── public/
    └── index.html     ← frontend (mappa + lista + statistiche)
```

---

## Deploy su server remoto (opzionale)

Per renderlo accessibile da internet:

```bash
# Con PM2 (processo in background)
npm install -g pm2
pm2 start server.js --name carburanti
pm2 save

# Oppure su Render.com / Railway / Fly.io — basta caricare la cartella
# e impostare come Start Command:  node server.js
```

Imposta la variabile d'ambiente `PORT` se necessario:
```bash
PORT=8080 node server.js
```
