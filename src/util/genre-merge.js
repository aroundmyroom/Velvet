/**
 * Genre normalisation and merging.
 *
 * Problems solved:
 *  1. Multi-value genre fields  ("House, Trance, Chillout" → 3 separate genres)
 *  2. Near-duplicate names      ("Synth-pop" = "Synthpop" = "Synth Pop")
 *  3. Noise / junk entries      ("Genre", "Misc", "DMC", bare numbers, …)
 *  4. Tiny genres               (< MIN_CNT songs) merged into the most
 *                                word-similar larger genre
 */

/** Genres with fewer songs than this are merged into a similar larger one. */
const MIN_CNT = 10;

const NOISE_SET = new Set([
  'genre', 'misc', 'other', 'various', 'unknown', 'mix', 'dmc',
  'general', 'undefined', 'none', 'na', 'general club dance',
]);

/** Canonical key: lowercase, alphanumeric only (strips hyphens, spaces, &). */
export function toKey(s) {
  return s.toLowerCase().replaceAll('&', 'and').replaceAll(/[^a-z0-9]/g, '');
}

function isNoise(tag) {
  if (!tag || tag.trim().length < 2) return true;
  const k = toKey(tag);
  if (!k || k.length < 2) return true;
  if (/^\d+$/.test(k))     return true;
  return NOISE_SET.has(tag.trim().toLowerCase());
}

/**
 * "Display richness" heuristic: prefer the form with more word-separating
 * characters (spaces, hyphens). "Synth-Pop" beats "Synthpop"; "New Wave"
 * beats "NewWave". Higher richness = more human-readable display wins.
 */
function richness(s) {
  return (s.match(/[\s\-_']/g) || []).length;
}

/**
 * Split a raw DB genre string into individual tag strings.
 * Splits on: comma, semicolon, or slash (all with optional surrounding spaces).
 * "R&B" and "Rock & Roll" stay intact (no split on &).
 * "Pop/Rock" → ["Pop", "Rock"], "Pub Rock/New Wave" → ["Pub Rock", "New Wave"].
 */
export function splitRaw(raw) {
  return raw.split(/\s*[,;/]\s*/)
    .map(s => s.trim())
    .filter(s => !isNoise(s));
}

/** Proper-case a genre label (normalises ALL-CAPS while preserving "R&B"). */
function titleCase(s) {
  return s.toLowerCase().replaceAll(/\b([a-z])/g, c => c.toUpperCase());
}

/**
 * Word-overlap similarity between two display names (0 – 1).
 * Words are extracted from the DISPLAY name (not the key) so that
 * "Classic Rock" → {"classic","rock"} overlaps with "Rock" → {"rock"}.
 */
function wordsOf(display) {
  return new Set(
    display.toLowerCase().replaceAll(/[^a-z0-9]/g, ' ').split(/\s+/).filter(w => w.length >= 2)
  );
}

function similarity(dispA, dispB) {
  if (toKey(dispA) === toKey(dispB)) return 1;
  const wa = wordsOf(dispA), wb = wordsOf(dispB);
  if (!wa.size || !wb.size) return 0;
  let overlap = 0;
  for (const w of wa) if (wb.has(w)) overlap++;
  return overlap / Math.max(wa.size, wb.size);
}

/**
 * Process raw DB genre rows into a normalised, merged genre list.
 *
 * @param {Array<{genre:string, cnt:number}>} rows  — raw DB output
 * @returns {{
 *   genres: Array<{genre:string, cnt:number}>,
 *   rawMap: Map<string, Set<string>>
 * }}
 *   genres  — merged display list sorted by cnt desc
 *   rawMap  — display_genre → Set of raw DB genre strings whose songs belong here
 *             (used by the songs endpoint to build the SQL IN clause)
 */
export function mergeGenreRows(rows) {

  // ── Step 1: expand multi-value fields ───────────────────────
  // canonical_key → { display, cnt, rawSet }
  const byKey = new Map();

  for (const row of rows) {
    const tags = splitRaw(row.genre);
    for (const tag of tags) {
      const key = toKey(tag);
      if (!key) continue;
      const candidate = titleCase(tag);
      if (!byKey.has(key)) {
        byKey.set(key, { display: candidate, cnt: 0, rawSet: new Set() });
      }
      const e = byKey.get(key);
      e.cnt += row.cnt;        // approximate: multi-value rows counted for each tag
      e.rawSet.add(row.genre); // track the original DB string
      // Prefer the "richest" display form (most word-separating chars);
      // on tie, keep what we have (first-seen or already richer).
      if (richness(candidate) > richness(e.display)) {
        e.display = candidate;
      }
    }
  }

  // ── Step 2: sort; split into major / minor ───────────────────
  const entries = [...byKey.values()].sort((a, b) => b.cnt - a.cnt);
  const major   = entries.filter(e => e.cnt >= MIN_CNT);
  const minor   = entries.filter(e => e.cnt <  MIN_CNT);

  // ── Step 3: merge minor into most-similar major ──────────────
  for (const s of minor) {
    let bestMajor = null, bestScore = 0;
    for (const b of major) {
      const score = similarity(s.display, b.display);
      if (score > bestScore) { bestScore = score; bestMajor = b; }
    }
    if (bestMajor && bestScore > 0) {
      bestMajor.cnt += s.cnt;
      for (const r of s.rawSet) bestMajor.rawSet.add(r);
    }
    // No similar major found → silently dropped (noise)
  }

  // ── Step 4: final sort + output ─────────────────────────────
  const sorted = major.toSorted((a, b) => b.cnt - a.cnt);
  const rawMap = new Map(sorted.map(e => [e.display, e.rawSet]));

  return {
    genres: sorted.map(({ display, cnt }) => ({ genre: display, cnt })),
    rawMap,
  };
}

// The genre groups used while an admin has saved none
const GENRE_BUCKETS_DEFAULT = [
  ['Rock',               /\b(rock|punk|metal|grunge|emo|hardcore|alternative|indie|shoegaze|post.rock|new.wave|prog(ressive)?|glam|gothic|psychedel|garage|britpop|surf|math.rock|noise.rock|skate)\b/i],
  ['Electronic',         /\b(electro(nic)?|techno|house|trance|drum.?n?.?bass|dnb|d&b|ambient|synth|rave|edm|idm|breakbeat|dubstep|chillout|chill(?!i)|deep.house|trip.hop|downtempo|jungle|acid|minimal(?! folk|ist)|dance(?!.pop)|club|industrial|dark.wave|ebm|vaporwave|lo.?fi|hardstyle|psytrance|psybient|dub(?!step)|gabber|neurofunk|liquid drum|deathstep)\b/i],
  ['Pop',                /\b(pop(?!.punk|.rock)|disco|bubblegum|teen.pop|j.?pop|k.?pop|c.?pop|city.pop)\b/i],
  ['Hip-Hop & R&B',      /\b(hip.?hop|rap|r&b|rnb|neo.?soul|urban|grime|trap|drill|afroswing)\b/i],
  ['Soul & Funk',        /\b(soul|funk|motown|rhythm.and.blues|boogie|northern.soul|groove(?! metal))\b/i],
  ['Jazz & Blues',       /\b(jazz|blues|swing|bebop|be.bop|fusion|bossa|latin.jazz|cool.jazz|dixieland|delta|smooth.jazz|acid.jazz|nu.jazz)\b/i],
  ['Classical',          /\b(classical|orchestral|opera|chamber|symphony|baroque|contempor|neoclassic|minimali(st)?|modern.classical)\b/i],
  ['Folk & Country',     /\b(folk|country|bluegrass|acoustic(?!.rock)|singer.?songwriter|americana|celtic|irish|western|cowboy|outlaw|appalachian)\b/i],
  ['World & Reggae',     /\b(world|reggae|latin(?!.jazz)|african|caribbean|cuban|salsa|bossa.nova|afrobeat|cumbia|flamenco|tango|polka|turkish|arabic|indian|bollywood|samba|merengue|calypso|afrobeats|dancehall)\b/i],
  ['Gospel & Christian', /\b(gospel|christian|worship|spiritual|hymn|ccm|praise|inspirational|devotional)\b/i],
];

export function autoGroupGenres(allGenres) {
  const bucketMap = new Map(GENRE_BUCKETS_DEFAULT.map(([label]) => [label, []]));
  const other = [];
  for (const g of allGenres) {
    const hit = GENRE_BUCKETS_DEFAULT.find(([, re]) => re.test(g));
    if (hit) bucketMap.get(hit[0]).push(g);
    else other.push(g);
  }
  const result = GENRE_BUCKETS_DEFAULT
    .map(([label]) => ({ name: label, genres: bucketMap.get(label) }))
    .filter(g => g.genres.length > 0);
  if (other.length > 0) result.push({ name: 'Other', genres: other });
  return result;
}
