/**
 * Smart Playlist — Feature Extractor
 *
 * Converts a DB row (files + audio_features join) into a 7-dimensional
 * normalised feature vector used for cosine-similarity scoring.
 *
 * Dimensions:
 *   [0] genre_bucket   — hash-based genre bucket (0.0–0.95)
 *   [1] year_norm      — normalised year 1950–2030
 *   [2] bpm_norm       — normalised BPM 40–220
 *   [3] key_norm       — camelot wheel position 1–12, normalised
 *   [4] dur_norm       — normalised duration 30–600 s
 *   [5] danceability   — from audio_features (0–1), default 0.5
 *   [6] energy         — loudness normalised –20 to 0 dB → 0–1, default 0.5
 */

// Camelot wheel position for each musical key (1–12)
const CAMELOT_POS = {
  'C major': 8,  'A minor': 8,
  'G major': 9,  'E minor': 9,
  'D major': 10, 'B minor': 10,
  'A major': 11, 'F# minor': 11,
  'E major': 12, 'C# minor': 12,
  'B major': 1,  'G# minor': 1,
  'F# major': 2, 'D# minor': 2,
  'C# major': 3, 'A# minor': 3,
  'F major': 7,  'D minor': 7,
  'Bb major': 6, 'G minor': 6,
  'Eb major': 5, 'C minor': 5,
  'Ab major': 4, 'F minor': 4,
};

/** Deterministic 0–1 bucket from a genre string. */
function hashGenre(genre) {
  if (!genre) return 0.5;
  let h = 0;
  for (let i = 0; i < genre.length; i++) {
    h = Math.imul(h * 31 + genre.codePointAt(i), 1) >>> 0;
  }
  return (h % 20) / 20;
}

/**
 * Build a 7-element float array from a files+audio_features row.
 * Missing values fall back to sensible midpoints so every track
 * gets a valid vector even without Essentia analysis.
 *
 * @param {object} row — merged row from files LEFT JOIN audio_features
 * @returns {number[]} 7-element vector, all values in [0, 1]
 */
export function extractVector(row) {
  const genre = hashGenre(row.genre);
  const year  = Math.min(1, Math.max(0, ((row.year || 1985) - 1950) / 80));
  const bpm   = Math.min(1, Math.max(0, ((row.bpm  || 120)  - 40)  / 180));
  const key   = row.musical_key
    ? (CAMELOT_POS[row.musical_key] ?? 6) / 12
    : 0.5;
  const dur   = Math.min(1, Math.max(0, ((row.duration || 210) - 30) / 570));
  const dance = (typeof row.danceability === 'number') ? row.danceability : 0.5;
  // audio_features.loudness is typically in the range –20 dB (quiet) to 0 dB (loud)
  const energy = (row.loudness == null)
    ? 0.5
    : Math.min(1, Math.max(0, (row.loudness + 20) / 20));
  return [genre, year, bpm, key, dur, dance, energy];
}

/**
 * Cosine similarity between two equal-length vectors.
 * Returns 0 if either vector is zero-length.
 *
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number} similarity score in [0, 1]
 */
export function cosineSimilarity(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Exponential moving average update.
 * profile = α * newVector + (1 – α) * oldProfile
 *
 * @param {number[]} profile — current EMA vector
 * @param {number[]} vector  — new observation
 * @param {number}   alpha   — learning rate (0–1)
 * @returns {number[]} updated profile (new array)
 */
export function emaUpdate(profile, vector, alpha) {
  return profile.map((v, i) => alpha * vector[i] + (1 - alpha) * v);
}
