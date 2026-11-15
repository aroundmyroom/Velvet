/**
 * Smart Playlist — Feature Extractor
 *
 * Converts a `files` row into a 7-dimensional normalised feature vector
 * used for cosine-similarity scoring.
 *
 * Dimensions:
 *   [0] genre_bucket   — hash-based genre bucket (0.0–0.95)
 *   [1] year_norm      — normalised year 1950–2030
 *   [2] bpm_norm       — normalised BPM 40–220
 *   [3] key_norm       — camelot wheel position 1–12, normalised
 *   [4] dur_norm       — normalised duration 30–600 s
 *   [5] danceability   — constant 0.5 (not computed)
 *   [6] energy         — constant 0.5 (not computed)
 *
 * [5] and [6] stay in the vector so the stored 7-element slot profiles keep working.
 */

import { toCamelot } from '../util/camelot.js';

const DANCEABILITY = 0.5;
const ENERGY = 0.5;

function camelotPosition(musicalKey) {
  const code = toCamelot(musicalKey);
  return code ? Number.parseInt(code, 10) : 6;
}

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
 * Build a 7-element float array from a files row.
 * Missing values fall back to sensible midpoints so every track
 * gets a valid vector even without BPM/key analysis.
 *
 * @param {object} row — files row (genre, year, bpm, musical_key, duration)
 * @returns {number[]} 7-element vector, all values in [0, 1]
 */
export function extractVector(row) {
  const genre = hashGenre(row.genre);
  const year  = Math.min(1, Math.max(0, ((row.year || 1985) - 1950) / 80));
  const bpm   = Math.min(1, Math.max(0, ((row.bpm  || 120)  - 40)  / 180));
  const key   = row.musical_key
    ? camelotPosition(row.musical_key) / 12
    : 0.5;
  const dur   = Math.min(1, Math.max(0, ((row.duration || 210) - 30) / 570));
  return [genre, year, bpm, key, dur, DANCEABILITY, ENERGY];
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
