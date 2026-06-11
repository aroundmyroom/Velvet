# Plan: MusicBrainz Text Search Fallback voor niet-herkende bestanden

**Status**: Ontwerp / onderzoeksfase  
**Datum**: Mei 2026  
**Scope**: Bestanden met `acoustid_status = 'not_found'` — fingerprint werkte maar audiocontent staat niet in de AcoustID-database

---

## Probleemstelling

De huidige pipeline stopt bij `acoustid_status = 'not_found'`:

```
Bestand → fpcalc fingerprint → AcoustID → "not found" → ❌ stopt hier
```

Dit treft met name:
- Zeldzame 12-inch remixes (weinig mensen fingerprinted die)
- Bootlegs, live-opnames, white-label-persingen
- Bestanden die fpcalc niet goed kan fingerprenten (te kort, fout formaat)
- Vroege digitalisaties van vinyl vóór de AcoustID-database groot werd

Deze bestanden hebben wél tags (artist, title, album) — soms goed, soms slecht. MusicBrainz heeft een text-search API die we kunnen gebruiken als fallback.

---

## MusicBrainz Text Search API

### Endpoint
```
GET https://musicbrainz.org/ws/2/recording/?query=...&fmt=json&limit=5
```

### Query-syntax (Lucene-gebaseerd)
```
artist:"Moloko" AND recording:"Sing It Back"
```

### Rate limit: 1 req/s — zelfde als MB Recording lookup, zelfde worker kan het aan

### Responsstructuur (relevant)
```json
{
  "count": 42,
  "recordings": [
    {
      "id": "ae424ef7-...",          ← mbid
      "title": "Sing It Back",
      "score": 98,                   ← 0–100, door MB zelf berekend
      "artist-credit": [{ "artist": { "id": "...", "name": "Moloko" } }],
      "releases": [
        {
          "id": "release-uuid",
          "title": "I Am Not a Doctor",
          "date": "1998",
          "release-group": { "primary-type": "Album" }
        }
      ]
    }
  ]
}
```

### Score-interpretatie (empirisch gevalideerd door MB zelf)
| Score | Betekenis |
|-------|-----------|
| 95–100 | Vrijwel zeker correct — titel + artiest zijn exact of bijna exact gematcht |
| 85–94 | Waarschijnlijk correct — kleine spelling/punctuatieverschillen |
| 70–84 | Mogelijk correct — onduidelijk, handmatige review nodig |
| < 70 | Onzeker — te veel afwijking, niet automatisch gebruiken |

**Drempel voor automatisch accepteren**: score ≥ 95  
**Drempel voor "needs_review" opslaan**: score ≥ 70  
**Onder 70**: niet opslaan, bestand blijft onbekend

---

## Wanneer is text search bruikbaar?

### Vereiste kwaliteitscheck vóór de API-aanvraag

De kwaliteit van de query bepaalt of het resultaat betrouwbaar is. We doen text search **alleen** als het bestand aan alle onderstaande criteria voldoet:

| Criterium | Check | Reden |
|-----------|-------|-------|
| `title` is aanwezig | `title IS NOT NULL AND LENGTH(TRIM(title)) > 1` | "Track 01" is onbruikbaar |
| `artist` is aanwezig | `artist IS NOT NULL AND LENGTH(TRIM(artist)) > 1` | "Unknown" is onbruikbaar |
| `title` is geen generieke placeholder | zie blacklist hieronder | Filtert 90% van het lawaai |
| `artist` is geen generieke placeholder | zie blacklist hieronder | Idem |
| `duration` aanwezig (aanbevolen) | optioneel — voor tiebreaker | Niet verplicht |

### Placeholder-blacklist (regex, case-insensitive)
```
title:  /^(track|track\s*\d+|song|audio|untitled|unknown|no title|\d+)$/i
artist: /^(unknown|artist|various|va|various artists|n\/a|no artist)$/i
```

Als een van beide velden matched → overslaan, `mb_text_search_status = 'skipped_no_tags'`.

### Duration-tiebreaker (optioneel, hoge waarde)
Als MB meerdere recordings retourneert met dezelfde score, gebruik dan `duration` uit de DB (ms) vs. `length` uit MB-response (ms) — kies de recording die het dichtst bij ± 5 seconden zit.

---

## Database-uitbreiding

### Nieuwe kolommen (via `ALTER TABLE ADD COLUMN` migrations)

| Kolom | Type | Waarden | Betekenis |
|-------|------|---------|-----------|
| `mb_text_search_status` | TEXT | NULL / `'pending'` / `'found'` / `'not_found'` / `'skipped_no_tags'` / `'skipped_low_score'` / `'error'` | Status van text-search poging |
| `mb_text_search_score` | REAL | 0.0–1.0 (genormaliseerd van 0–100) | Beste MB-score |
| `mb_text_search_ts` | INTEGER | Unix timestamp | Tijdstip van laatste poging |

De bestaande `mbid`, `mb_title`, `mb_artist`, `mb_release_id` enz. worden **hergebruikt** — als text search een MBID vindt, worden dezelfde kolommen gevuld als bij een normale fingerprint-match. De `mb_enrichment_status` wordt daarna op NULL gezet zodat de MB-enrichment-worker het oppakt.

### Worker-volgorde
```
acoustid_status = 'not_found'
    ↓ mb-text-search-worker
    ↓ mbid, mb_title, mb_artist opgeslagen (indien score ≥ 70)
    ↓ mb_enrichment_status = NULL (trigger voor mb-enrich-worker)
    ↓ mb-enrich-worker: haal album/year/track op via recording/{mbid}
    ↓ tag_status = 'confirmed' | 'needs_review'
    ↓ Tag Workshop: toon voor review
```

---

## Nieuwe worker: `mb-text-search-worker.mjs`

### Aanpak
Modeleer exact naar `mb-enrich-worker.mjs`:
- Worker thread (`node:worker_threads`)
- SQLite directe toegang (WAL mode, busy_timeout)
- 1 req/s rate limit (zelfde als MB enrichment)
- Batch van 50 per iteratie
- `pending` → `found` / `not_found` / `skipped_*` / `error`

### Queue-query
```sql
SELECT filepath, vpath, title, artist, duration
FROM files
WHERE acoustid_status = 'not_found'
  AND mb_text_search_status IS NULL
  AND title IS NOT NULL AND LENGTH(TRIM(title)) > 2
  AND artist IS NOT NULL AND LENGTH(TRIM(artist)) > 2
ORDER BY ts ASC
LIMIT 50
```

### Per-bestand logica
```
1. Check placeholder-blacklist → indien match: status = 'skipped_no_tags', stop
2. Bouw query: artist:"<artist>" AND recording:"<title>"
3. GET MusicBrainz search (1 req/s rate limit)
4. Filter results: score >= 70
5. Indien leeg: status = 'not_found', stop
6. Sorteer op score DESC, dan op duration-proximity als tiebreaker
7. Beste kandidaat:
   - Sla mbid, mb_title, mb_artist, mb_artist_id op
   - mb_text_search_score = best.score / 100
   - mb_text_search_status = 'found'
   - acoustid_status = 'not_found' (niet aanpassen — we weten dat fingerprint faalde)
   - mb_enrichment_status = NULL (zodat mb-enrich-worker het oppakt)
   - tag_status = 'needs_review' (altijd — ook bij score 100, want text-match is minder zeker dan fingerprint)
```

**Belangrijk**: Zelfs bij score 100 zetten we `tag_status = 'needs_review'` en nooit `'confirmed'`. Text-match is fundamenteel minder betrouwbaar dan een audiocontent-fingerprint. De gebruiker beslist in Tag Workshop.

### Score-toelichting in de Tag Workshop

In de Tag Workshop-UI moet zichtbaar zijn of een match via fingerprint of via text-search verkregen is:
- `acoustid_id IS NOT NULL` → fingerprint-match (oranje/grijs badge: "AcoustID")
- `mb_text_search_score IS NOT NULL` → text-match (blauwe badge: "Text match · score: 92%")

---

## Admin API-uitbreiding (tagworkshop.js)

### Nieuwe endpoints

| Methode | Pad | Beschrijving |
|---------|-----|-------------|
| `POST` | `/api/v1/tagworkshop/text-search/start` | Start de MB text-search worker |
| `POST` | `/api/v1/tagworkshop/text-search/stop` | Stop de worker |
| `GET` | `/api/v1/tagworkshop/text-search/status` | Stats: queued / found / not_found / skipped / errors |
| `POST` | `/api/v1/tagworkshop/text-search/retry-notfound` | Reset `not_found` → NULL voor herpoging |

### Bestaand `/api/v1/tagworkshop/status` uitbreiden
Voeg `textSearch: { running, queued, found, not_found, skipped, errors }` toe naast de bestaande `mb` en `acoustid` secties.

---

## Tag Workshop UI-uitbreiding (admin/index.js)

### Sectie: "MB Text Search (Fallback)"

Naast de bestaande "MB Enrichment" sectie een vergelijkbare kaart:

```
┌──────────────────────────────────────────────────────┐
│ MB Text Search (Fallback voor niet-herkende bestanden) │
├───────────────────────────────────┬──────────────────┤
│ Wachtrij                          │ 3.421            │
│ Gevonden (score ≥ 70)             │ 147              │
│ Niet gevonden                     │ 812              │
│ Overgeslagen (onvoldoende tags)   │ 203              │
│ Fouten                            │ 2                │
├───────────────────────────────────┴──────────────────┤
│ [▶ Start]  [⏹ Stop]                                  │
└──────────────────────────────────────────────────────┘
```

### Albums-overzicht: badge per match-type

In de albumkaart in `/tagworkshop/albums` toevoegen per track:
- Oranje badge `🎵 AcoustID` voor fingerprint-matches (acoustid_score)
- Blauwe badge `🔍 Text match` + score% voor text-search-matches

### Hoe `needs_review` items nu herkend worden
Huidig filter: `tag_status = 'needs_review' AND mb_release_id IS NOT NULL`

Na implementatie: **geen aanpassing nodig** — text-search-matches doorlopen dezelfde mb-enrich-worker en krijgen daarna dezelfde `mb_release_id` + `tag_status = 'needs_review'`. Ze komen automatisch in dezelfde review-wachtrij.

---

## Implementatiestappen (prioriteitsvolgorde)

### Stap 1 — DB migraties (10 min)
`src/db/sqlite-backend.js`: voeg 3 `ALTER TABLE ADD COLUMN` migraties toe voor `mb_text_search_status`, `mb_text_search_score`, `mb_text_search_ts`. Index op `mb_text_search_status`.

### Stap 2 — Worker `mb-text-search-worker.mjs` (3–4 uur)
Nieuwe file in `src/util/`. Bevat:
- Queue-query, pending/result-updates
- Placeholder-blacklist
- MB search HTTP-call (1 req/s)
- Duration-tiebreaker
- Score-drempel logica (70 = opslaan, < 70 = not_found)
- Na `found`: zet `mb_enrichment_status = NULL` zodat mb-enrich-worker het oppakt

### Stap 3 — Worker lifecycle in `tagworkshop.js` (1 uur)
- `_spawnTextSearchWorker()`, `_textSearchWorker`, `_textSearchRunning`
- 3 nieuwe endpoints (start/stop/status)
- Auto-start als er `not_found` files met geschikte tags zijn

### Stap 4 — DB helper functies (30 min)
`src/db/sqlite-backend.js`:
- `getMbTextSearchStats()` — counts per status
- `resetMbTextSearchNotFound()` — herpoging

### Stap 5 — Admin UI kaart (1–2 uur)
`webapp/admin/index.js`: nieuwe sectie naast MB Enrichment. Zelfde patroon (start/stop knoppen, stats-tabel).

### Stap 6 — Tag Workshop badge (30 min)
Albums-overzicht: toon match-type badge per track/album. Kleine UI-toevoeging.

### Stap 7 — i18n keys (15 min)
Nieuwe sleutels in alle 12 locale-bestanden voor de UI-labels.

### Stap 8 — Tests + docs (30 min)
- Regressietest: controleer dat `not_found` files met goede tags in wachtrij komen
- `docs/acoustid.md` en `docs/tageditor.md` bijwerken

---

## Risico's en mitigaties

| Risico | Kans | Mitigatie |
|--------|------|-----------|
| Slechte tags → foute match | Middel | Drempel 70 + altijd `needs_review`, nooit `confirmed` |
| Homoniemen (bijv. "The Wall" van meerdere artiesten) | Middel | Duration-tiebreaker + `needs_review` review stap |
| MB rate limit overschrijden | Laag | 1100 ms delay (zelfde als mb-enrich-worker) |
| DB lock conflict met andere workers | Laag | WAL mode + `busy_timeout = 60s` + retry-loop |
| Artist = "Various Artists" levert ruis | Laag | Placeholder-blacklist pakt dit op |
| Titel bevat tracknummer prefix ("A1. Sing It Back") | Middel | Optioneel: strip prefix-regex vóór query |

### Optionele verbetering: title pre-processing
Titels als `"A1. Sing It Back"` of `"B2 - Somebody"` zijn gangbaar in 12-inch collecties. Vóór de MB-query:
```js
const cleanTitle = title.replace(/^[A-Z]\d+[\.\-\s]+/i, '').trim();
```
Dit verhoogt de score significant voor 12-inch-rips.

---

## Niet in scope (bewuste keuzes)

- **Automatisch accepteren** op basis van text-match, ook niet bij score 100 — altijd `needs_review`
- **Discogs text search** — aparte feature, al in `docs/dev/todo.md`
- **BPM-inferentie via MB** — MB heeft geen BPM-data; BPM blijft via Essentia/rsgain
- **Cover art via MB** — al gedekt via Discogs; niet dupliceren

---

## Schatting totale bouwtijd

| Stap | Tijd |
|------|------|
| DB migraties | 10 min |
| Worker | 3–4 uur |
| Worker lifecycle + endpoints | 1 uur |
| DB helper functies | 30 min |
| Admin UI | 1–2 uur |
| Badge in Tag Workshop | 30 min |
| i18n + docs | 45 min |
| **Totaal** | **~7–9 uur** |
