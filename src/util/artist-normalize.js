/**
 * Artist name normalisation and grouping.
 *
 * Problems solved:
 *  1. Space-separated digit prefix — "01 DJ Deep", "02 DJ Deep" alongside "DJ Deep"
 *  2. Underscore format — "01_Communards", "07_Level_42" (filesystem track-numbered filenames
 *     where the artist tag holds a number + underscores instead of spaces)
 *  3. Pure-digit ghost artists — "01", "05", "06" (bare track numbers with no artist info)
 *     → excluded from the index entirely; they cannot be attributed to any real artist
 *  4. Parenthetical remix credits
 *     a. Entire field is a credit: " (Nalin & Kane Remix)" → artist = "Nalin & Kane"
 *     b. Suffix on main artist: "Earth Wind & Fire (Phats & Small Remix)" → artist = "Earth Wind & Fire"
 *  5. Merging only when safe — "2 Unlimited" (235 songs) must NOT collapse to "Unlimited".
 *     The 50% ratio test prevents this.
 *  6. Real artists whose names start with digits — "808 State", "50 Cent", "4 Non Blondes"
 *     — kept unchanged when no clean variant exists or the clean variant has far fewer songs.
 *  7. Similarity/containment merge — small artist groups (≤5 songs) whose name as a
 *     word-boundary CONTAINS a larger artist's key are merged into that larger group.
 *     e.g. "Nalin & Kane Remix)" (1 song) → merged into "Nalin & Kane" (many songs)
 *
 * This module is PURE — it never reads from or writes to the database.
 * The DB layer calls buildArtistGroups() and stores the result.
 */

// ── Regex patterns ────────────────────────────────────────────────────────────

// Padded digit prefix: "01 Artist Name", "002 Artist"
const PADDED_PREFIX_RX   = /^(0\d+)\s+(.+)$/;

// Unpadded digit prefix: "2 Artist Name", "50 Cent", "808 State"
const UNPADDED_PREFIX_RX = /^([1-9]\d*)\s+(.+)$/;

// Dotted track prefix: "01.Abba", "13.Bill Motley", "06. Hitlist"
const DOTTED_PREFIX_RX   = /^(\d{1,3})\.\s*(.+)$/;

// Side/slot prefix often seen in ripped VA mixes: "03a) Lime"
const SIDE_PREFIX_RX     = /^(\d{1,2})[a-z]\)\s+(.+)$/i;

// Vinyl side/position prefixes from pasted tracklists: "A1 Artist", "A2. Artist", "B10) Artist"
const VINYL_SIDE_PREFIX_RX = /^([A-D])(\d{1,2})(?:[.)])?\s+(.+)$/i;

// Glued punctuation variants: "A1.Artist", "A1, Artist", "B2)Artist"
const VINYL_SIDE_PUNCT_PREFIX_RX = /^([A-D])(\d{1,2})[.,)]\s*(.+)$/i;

// Underscore format: "01_Communards", "07_Level_42"  (any digits, then _, then name)
const UNDERSCORE_PREFIX_RX = /^(\d+)_(.+)$/;

// Pure digits only: "01", "05", "42" — bare track number, no artist info at all
const PURE_DIGITS_RX = /^\d+$/;

// Year-like token used as a malformed artist after prefix stripping: "1994"
const PURE_YEAR_RX = /^(?:19|20)\d{2}$/;

// Entire field is a parenthetical remix/mix credit: " (Artist Remix)", "(Nalin & Kane Mix)"
// Captures the artist name before the final keyword.
const PAREN_ONLY_RX = /^\s*\((.+)\s+(?:remix(?:es)?|mix(?:es)?|edit|rework|version|bootleg|dub)\s*\)\s*$/i;

// Remix/mix suffix appended to a non-paren main artist name:
//   "Earth Wind & Fire (Phats & Small Remix)"  →  base = "Earth Wind & Fire"
// The first capture group ([^(]+?) disallows parens in the base to avoid greedy gremlins.
const PAREN_SUFFIX_RX = /^([^(]+?)\s*\(([^)]+)\s+(?:remix(?:es)?|mix(?:es)?|edit|rework|version|bootleg|dub)\s*\)\s*$/i;

// ── Similarity merge thresholds ───────────────────────────────────────────────
const SIM_MAX_CANDIDATE = 5;   // candidate (small group): ≤ this many songs total
const SIM_MIN_TARGET    = 10;  // target (large group): ≥ this many songs
const SIM_RATIO         = 5;   // target must have ≥ 5× more songs than candidate
const SIM_MIN_KEY_LEN   = 5;   // target key must be ≥ 5 chars to avoid "dj"/"the" false matches

// ── Low-level helpers ─────────────────────────────────────────────────────────

function parseDigitPrefix(raw) {
  const padded = raw.match(PADDED_PREFIX_RX);
  if (padded) {
    const stripped = padded[2].trim();
    return { stripped, padded: true, num: Number(padded[1]), drop: PURE_YEAR_RX.test(stripped) };
  }

  // "01.Abba" style tags are almost always track-number corruption.
  const dotted = raw.match(DOTTED_PREFIX_RX);
  if (dotted) {
    const stripped = dotted[2].trim();
    // Keep real numeric artist names like "9.9" untouched (no letters in tail/year token).
    if (/[A-Za-z]/.test(stripped) || PURE_YEAR_RX.test(stripped)) {
      return { stripped, padded: true, num: Number(dotted[1]), drop: PURE_YEAR_RX.test(stripped) };
    }
  }

  const sided = raw.match(SIDE_PREFIX_RX);
  if (sided) {
    const stripped = sided[2].trim();
    return { stripped, padded: true, num: Number(sided[1]), drop: PURE_YEAR_RX.test(stripped) };
  }

  const vinylPunct = raw.match(VINYL_SIDE_PUNCT_PREFIX_RX);
  if (vinylPunct) {
    const stripped = vinylPunct[3].trim();
    return { stripped, padded: true, num: Number(vinylPunct[2]), drop: PURE_YEAR_RX.test(stripped) };
  }

  // "A1 Madonna", "A2. Big Pig", "B3) D Mob" style prefixes are track
  // positions copied from vinyl/tracklist metadata, not artist names.
  const vinylSide = raw.match(VINYL_SIDE_PREFIX_RX);
  if (vinylSide) {
    const stripped = vinylSide[3].trim();
    return { stripped, padded: true, num: Number(vinylSide[2]), drop: PURE_YEAR_RX.test(stripped) };
  }

  const unpadded = raw.match(UNPADDED_PREFIX_RX);
  if (unpadded) {
    const stripped = unpadded[2].trim();
    return { stripped, padded: false, num: Number(unpadded[1]), drop: PURE_YEAR_RX.test(stripped) };
  }
  return null;
}

/**
 * Parse an underscore-format tag like "01_Communards" or "07_Level_42".
 * Returns { stripped, padded: true } or null.
 */
function parseUnderscorePrefix(raw) {
  const m = raw.match(UNDERSCORE_PREFIX_RX);
  if (!m) return null;
  const stripped = m[2].replaceAll('_', ' ').trim();
  return { stripped, padded: true };
}

// Kept for backwards-compat / external use
function stripDigitPrefix(raw) {
  const r = parseDigitPrefix(raw);
  return r ? r.stripped : null;
}

function toKey(raw) {
  return raw.toLowerCase().trim();
}

// Some malformed tags contain stacked prefixes, e.g. "02 B1.Tom Hooker".
// Remove repeated padded-style track prefixes, but never strip unpadded
// prefixes to avoid breaking real artists like "50 Cent".
function stripNestedPaddedPrefixes(name) {
  let cur = String(name || '').trim();
  for (let i = 0; i < 4; i++) {
    const p = parseDigitPrefix(cur);
    if (!p?.padded) break;
    const next = String(p.stripped || '').trim();
    if (!next || next === cur) break;
    cur = next;
  }
  return cur;
}

/**
 * From an array of { name, count } variants, pick the best display name.
 * Prefers variants with no digit prefix or underscore prefix.
 */
function pickCanonicalName(variants) {
  const clean = variants.filter(v => !parseDigitPrefix(v.name) && !parseUnderscorePrefix(v.name));
  const pool  = clean.length ? clean : variants;
  pool.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const winner = pool[0].name;
  if (!clean.length) {
    const prefix = parseDigitPrefix(winner) || parseUnderscorePrefix(winner);
    return prefix ? prefix.stripped : winner;
  }
  return winner;
}

// ── Core algorithm ────────────────────────────────────────────────────────────

/**
 * Build a stable grouping of all raw artist tags into canonical display groups.
 *
 * @param {{ artist: string, count: number }[]} rows  All distinct (artist, count) from files table
 * @returns {Map<string, { canonicalName: string, rawVariants: { name: string, count: number }[] }>}
 */
function buildArtistGroups(rows) {

  // ── Step 1: build lowercase lookup map, skipping pure-digit junk ──────────
  const byLower = new Map(); // key → { name, count }
  for (const row of rows) {
    if (PURE_DIGITS_RX.test(row.artist.trim())) continue;
    const k = toKey(row.artist);
    if (byLower.has(k)) {
      byLower.get(k).count += row.count;
    } else {
      byLower.set(k, { name: row.artist, count: row.count });
    }
  }

  // ── Step 2: main grouping loop ────────────────────────────────────────────
  const groups = new Map(); // key → { canonicalName, rawVariants[], _sealed }

  function getGroup(key) {
    if (!groups.has(key)) {
      groups.set(key, { canonicalName: '', rawVariants: [], _sealed: false });
    }
    return groups.get(key);
  }

  // Merge a raw variant into an existing (or future) group without sealing it.
  function mergeVariantInto(targetKey, rawName, count) {
    getGroup(targetKey).rawVariants.push({ name: rawName, count });
  }

  // Add a raw variant to a group AND seal it with a canonical name (if not already sealed).
  function sealGroup(key, canonical, rawName, count) {
    const g = getGroup(key);
    g.rawVariants.push({ name: rawName, count });
    if (!g._sealed) { g.canonicalName = canonical; g._sealed = true; }
  }

  for (const row of rows) {
    const raw = row.artist;

    // ── Guard: exclude pure track-number tags ─────────────────────────────
    if (PURE_DIGITS_RX.test(raw.trim())) continue;

    // ── Case: entire field is a parenthetical remix credit ────────────────
    //    " (Nalin & Kane Remix)" → extract "Nalin & Kane", merge into their group
    const parenOnly = PAREN_ONLY_RX.exec(raw);
    if (parenOnly) {
      const extracted    = parenOnly[1].trim();
      const extractedKey = toKey(extracted);
      if (byLower.has(extractedKey)) {
        mergeVariantInto(extractedKey, raw, row.count);
      } else {
        sealGroup(extractedKey, extracted, raw, row.count);
      }
      continue;
    }

    // ── Case: remix/mix suffix after a base artist ────────────────────────
    //    "Earth Wind & Fire (Phats & Small Remix)" → base = "Earth Wind & Fire"
    const parenSuffix = PAREN_SUFFIX_RX.exec(raw);
    if (parenSuffix) {
      const base    = parenSuffix[1].trim();
      const baseKey = toKey(base);
      if (byLower.has(baseKey)) {
        mergeVariantInto(baseKey, raw, row.count);
      } else {
        sealGroup(baseKey, base, raw, row.count);
      }
      continue;
    }

    // ── Case: underscore-format "NN_ArtistName" ───────────────────────────
    //    "01_Communards" → stripped = "Communards" (always treated as corruption)
    const underPrefix = parseUnderscorePrefix(raw);
    if (underPrefix) {
      const { stripped } = underPrefix;
      const strippedKey  = toKey(stripped);
      const cleanEntry   = byLower.get(strippedKey);
      if (cleanEntry && cleanEntry.count >= row.count * 0.5) {
        mergeVariantInto(strippedKey, raw, row.count);
      } else {
        sealGroup(strippedKey, stripped, raw, row.count);
      }
      continue;
    }

    // ── Case: space-separated digit prefix "NN ArtistName" ───────────────
    const prefix = parseDigitPrefix(raw);
    if (prefix) {
      const { padded, num, drop } = prefix;
      const stripped = padded ? stripNestedPaddedPrefixes(prefix.stripped) : prefix.stripped;
      if (drop || !stripped) continue;
      const strippedKey = toKey(stripped);
      const cleanEntry  = byLower.get(strippedKey);

      if (padded || (num >= 10 && row.count <= 3 && /[A-Za-z]/.test(stripped))) {
        // Zero-padded / dotted prefixes (track-number corruption) or low-frequency
        // two-digit prefixes ("10 Bianca Neve", "14 Triple X"): group under stripped name.
        if (cleanEntry) mergeVariantInto(strippedKey, raw, row.count);
        else sealGroup(strippedKey, stripped, raw, row.count);
      } else if (cleanEntry && cleanEntry.count >= row.count * 0.5) {
        // Unpadded names are ambiguous ("2 Unlimited" vs "2 Artist") — merge
        // only when the clean variant is already strong enough.
        mergeVariantInto(strippedKey, raw, row.count);
      } else {
        // Real artist name starting with a digit ("50 Cent", "2 Unlimited").
        sealGroup(toKey(raw), raw, raw, row.count);
      }
      continue;
    }

    // ── Default: no special format → own group ────────────────────────────
    const g = getGroup(toKey(raw));
    g.rawVariants.push({ name: raw, count: row.count });
    if (!g._sealed) { g.canonicalName = raw; g._sealed = true; }
  }

  // ── Step 3: seal any groups left unsealed ─────────────────────────────────
  for (const [, group] of groups) {
    if (!group._sealed) {
      group.canonicalName = pickCanonicalName(group.rawVariants);
      group._sealed = true;
    }
  }

  // ── Step 4: similarity / containment merge pass ───────────────────────────
  //
  // After explicit pattern matching, some small corrupt groups survive — e.g.
  // "Nalin & Kane Remix)" (1 song, no opening-paren to trigger PAREN_ONLY).
  // If such a group's key word-boundary CONTAINS a larger group's key, merge it in.
  //
  // Safety rules:
  //   • Only candidates with ≤ SIM_MAX_CANDIDATE total songs are checked
  //   • Target must have ≥ SIM_MIN_TARGET songs AND ≥ SIM_RATIO × candidate songs
  //   • Target key must be ≥ SIM_MIN_KEY_LEN chars (avoids "dj"/"the" false matches)
  //   • Containment must be at a word boundary (space, paren, ampersand, comma)

  // Compute per-group song totals from variant counts
  const groupTotals = new Map();
  for (const [key, group] of groups) {
    groupTotals.set(key, group.rawVariants.reduce((s, v) => s + v.count, 0));
  }

  // Collect merge operations (don't mutate map while iterating)
  const toMerge = []; // [{ from, into }]

  for (const [candidateKey] of groups) {
    const cTotal = groupTotals.get(candidateKey);
    if (cTotal > SIM_MAX_CANDIDATE) continue;

    let bestTarget = null, bestScore = 0;

    for (const [targetKey] of groups) {
      if (targetKey === candidateKey) continue;
      if (targetKey.length < SIM_MIN_KEY_LEN) continue;
      const tTotal = groupTotals.get(targetKey);
      if (tTotal < SIM_MIN_TARGET) continue;
      if (tTotal < cTotal * SIM_RATIO) continue;

      // Containment: targetKey must appear inside candidateKey
      const idx = candidateKey.indexOf(targetKey);
      if (idx === -1) continue;

      // Word-boundary check: char before and after the match must be non-alphanumeric
      const before = idx === 0 ? null : candidateKey[idx - 1];
      const after  = idx + targetKey.length === candidateKey.length
        ? null
        : candidateKey[idx + targetKey.length];
      const bOk = before === null || /[\s(&,-]/.test(before);
      const aOk = after  === null || /[\s)&,-]/.test(after);
      if (!bOk || !aOk) continue;

      // Among all qualifying targets, prefer the one with most songs (break ties by key length)
      const score = tTotal * 1000 + targetKey.length;
      if (score > bestScore) { bestTarget = targetKey; bestScore = score; }
    }

    if (bestTarget) toMerge.push({ from: candidateKey, into: bestTarget });
  }

  // Execute merges: move all rawVariants from 'from' into 'into', delete 'from'
  for (const { from, into } of toMerge) {
    const src = groups.get(from);
    const dst = groups.get(into);
    if (!src || !dst) continue;
    for (const v of src.rawVariants) dst.rawVariants.push(v);
    groups.delete(from);
  }

  return groups;
}

export { buildArtistGroups, pickCanonicalName, stripDigitPrefix, toKey };
