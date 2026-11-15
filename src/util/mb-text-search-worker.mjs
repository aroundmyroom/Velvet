/**
 * mb-text-search-worker.mjs
 * Worker thread: MusicBrainz text-search fallback for files with acoustid_status = 'not_found'.
 * Queries the MB search API (1 req/s) using existing title + artist tags.
 * On a match (score >= 70) it stores the MBID with mb_text_search_status = 'found' and clears
 * mb_enrichment_status, so mb-enrich-worker picks the file up; tags change only after review in the Tag Workshop.
 */
import { workerData, parentPort } from 'node:worker_threads';
import { openWorkerDb } from '../db/worker-connection.js';
import https from 'node:https';
import { MB_USER_AGENT, mbAcquire } from './mb-client.mjs';
import { sleep, stopRequested, dbWriteWithRetry, runBatchQueue } from './worker-helpers.mjs';

const { dbPath } = workerData;

const BATCH_SIZE     = 50;
const IDLE_WAIT_MS   = 60_000;
const HTTP_TIMEOUT_MS = 25_000;

const SCORE_STORE_MIN  = 70;   // minimum score to store a result

// Placeholder title/artist patterns — these are not worth querying
const TITLE_PLACEHOLDER  = /^(track|track\s*\d+|song|audio|untitled|unknown|no title|\d+)$/i;
const ARTIST_PLACEHOLDER = /^(unknown|artist|various|va|various artists|n\/a|no artist)$/i;

// Strip common tracknumber prefixes like "A1. " or "B2 - " before querying
function cleanTitle(raw) {
  return raw.replace(/^[A-Za-z]?\d+[-.\s]+/i, '').trim() || raw.trim(); // NOSONAR S5869 — false positive: \s (whitespace) and . (period) are distinct, no duplicates
}

const db = openWorkerDb(dbPath, { busyTimeoutMs: 60_000 });

const _getQueue = db.prepare(`
  SELECT filepath, vpath, title, artist, duration
  FROM files
  WHERE acoustid_status = 'not_found'
    AND mb_text_search_status IS NULL
    AND title  IS NOT NULL AND LENGTH(TRIM(title))  > 2
    AND artist IS NOT NULL AND LENGTH(TRIM(artist)) > 2
  ORDER BY ts ASC
  LIMIT ?
`);

const _setPending = db.prepare(
  `UPDATE files SET mb_text_search_status = 'pending', mb_text_search_ts = ? WHERE filepath = ? AND vpath = ?`
);

const _setFound = db.prepare(`
  UPDATE files
  SET mb_text_search_status = 'found',
      mb_text_search_score  = ?,
      mb_text_search_ts     = ?,
      mbid                  = ?,
      mb_title              = ?,
      mb_artist             = ?,
      mb_artist_id          = ?,
      mb_enrichment_status  = NULL
  WHERE filepath = ? AND vpath = ?
`);

const _setNotFound = db.prepare(
  `UPDATE files SET mb_text_search_status = ?, mb_text_search_ts = ? WHERE filepath = ? AND vpath = ?`
);

const _setError = db.prepare(
  `UPDATE files SET mb_text_search_status = 'error', mb_text_search_ts = ?, mb_text_search_error = ? WHERE filepath = ? AND vpath = ?`
);

const _resetPending = db.prepare(
  `UPDATE files SET mb_text_search_status = NULL WHERE mb_text_search_status = 'pending'`
);

const _getStats = db.prepare(`
  SELECT
    COUNT(CASE WHEN acoustid_status = 'not_found'
                 AND title IS NOT NULL AND LENGTH(TRIM(title)) > 2
                 AND artist IS NOT NULL AND LENGTH(TRIM(artist)) > 2
                 AND mb_text_search_status IS NULL THEN 1 END) AS queued,
    COUNT(CASE WHEN mb_text_search_status = 'found'       THEN 1 END) AS found,
    COUNT(CASE WHEN mb_text_search_status = 'not_found'   THEN 1 END) AS not_found,
    COUNT(CASE WHEN mb_text_search_status LIKE 'skipped%' THEN 1 END) AS skipped,
    COUNT(CASE WHEN mb_text_search_status = 'error'       THEN 1 END) AS errors
  FROM files
`);

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Translate a raw network/HTTP error into a plain-language message for display. */
function friendlyError(err) {
  const msg = err?.message ?? 'Unknown error';
  if (msg.includes('HTTP 503') || msg.includes('search HTTP 503')) return 'MusicBrainz is temporarily unavailable (server busy) — click \'Retry all\' to try again';
  if (msg.includes('HTTP 429') || msg.includes('search HTTP 429')) return 'Too many requests sent to MusicBrainz (rate limited) — click \'Retry all\' to try again';
  if (msg.includes('timeout'))  return 'MusicBrainz request timed out — click \'Retry all\' to try again';
  const m = msg.match(/HTTP (\d+)/);
  if (m) return `MusicBrainz error (HTTP ${m[1]}) — click 'Retry all' to try again`;
  return msg.slice(0, 200);
}


/**
 * Search MusicBrainz for a recording by artist + title.
 * Returns the parsed JSON response or throws.
 */
async function mbSearch(artist, title) {
  await mbAcquire();
  return new Promise((resolve, reject) => {
    const q = `artist:${JSON.stringify(artist)} AND recording:${JSON.stringify(cleanTitle(title))}`;
    const url = `https://musicbrainz.org/ws/2/recording/?query=${encodeURIComponent(q)}&fmt=json&limit=5`;
    const timer = setTimeout(() => { req.destroy(new Error('MB search timeout')); }, HTTP_TIMEOUT_MS);
    const req = https.get(url, { headers: { 'User-Agent': MB_USER_AGENT } }, res => {
      clearTimeout(timer);
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`MB search HTTP ${res.statusCode}`));
      }
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error(`MB search JSON: ${e.message}`)); }
      });
      res.on('error', reject);
    });
    req.on('error', e => { clearTimeout(timer); reject(e); });
  });
}

/**
 * Run mbSearch with up to 2 retries on transient 503 / 429 / timeout errors.
 * Delays: 30 s then 60 s.
 */
async function mbSearchWithRetry(artist, title) {
  const delays = [30_000, 60_000];
  for (let i = 0; i <= delays.length; i++) {
    try { return await mbSearch(artist, title); }
    catch (err) {
      const msg = err?.message ?? '';
      const transient = msg.includes('503') || msg.includes('429') || msg.includes('timeout');
      if (!transient || i === delays.length || stopRequested()) throw err;
      await sleep(delays[i]);
    }
  }
}

/** Pick the best candidate from MB search results applying score + duration tiebreaker. */
function selectBest(recordings, durationMs) {
  // Filter to minimum score
  const candidates = recordings.filter(r => (r.score ?? 0) >= SCORE_STORE_MIN);
  if (candidates.length === 0) return null;

  // Sort by score DESC, then by duration proximity if available
  const sorted = candidates.toSorted((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Tiebreaker: duration proximity (MB `length` is in ms)
    if (durationMs && a.length && b.length) {
      return Math.abs(a.length - durationMs) - Math.abs(b.length - durationMs);
    }
    return 0;
  });

  return sorted[0];
}

// ── Process one file ──────────────────────────────────────────────────────────

async function processFile(row) {
  const ts = Math.floor(Date.now() / 1000);

  // Placeholder check
  if (TITLE_PLACEHOLDER.test(row.title.trim()) || ARTIST_PLACEHOLDER.test(row.artist.trim())) {
    await dbWriteWithRetry(() => _setNotFound.run('skipped_no_tags', ts, row.filepath, row.vpath));
    return;
  }

  await dbWriteWithRetry(() => _setPending.run(ts, row.filepath, row.vpath));

  let apiData;
  try {
    apiData = await mbSearchWithRetry(row.artist, row.title);
  } catch (err) {
    await dbWriteWithRetry(() => _setError.run(ts, friendlyError(err), row.filepath, row.vpath));
    return;
  }

  const recordings = apiData?.recordings ?? [];
  if (recordings.length === 0) {
    await dbWriteWithRetry(() => _setNotFound.run('not_found', ts, row.filepath, row.vpath));
    return;
  }

  const best = selectBest(recordings, row.duration ?? null);
  if (!best) {
    await dbWriteWithRetry(() => _setNotFound.run('skipped_low_score', ts, row.filepath, row.vpath));
    return;
  }

  // best.score is 0-100 integer from MB; we normalise to 0.0-1.0
  const normScore = (best.score ?? 0) / 100;

  const mbid      = best.id ?? null;
  const mbTitle   = best.title ?? null;
  const mbArtist  = best['artist-credit']?.[0]?.artist?.name ?? null;
  const mbArtistId = best['artist-credit']?.[0]?.artist?.id  ?? null;

  await dbWriteWithRetry(() => _setFound.run(
    normScore, ts,
    mbid, mbTitle, mbArtist, mbArtistId,
    row.filepath, row.vpath
  ));
}

// ── Main loop ─────────────────────────────────────────────────────────────────

await runBatchQueue({
  resetPending: _resetPending, getQueue: _getQueue, getStats: _getStats,
  batchSize: BATCH_SIZE, idleWaitMs: IDLE_WAIT_MS, processFile,
}).catch(err => {
  parentPort.postMessage({ type: 'error', message: err.message });
});
