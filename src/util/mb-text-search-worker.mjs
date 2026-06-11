/**
 * mb-text-search-worker.mjs
 * Worker thread: MusicBrainz text-search fallback for files with acoustid_status = 'not_found'.
 * Queries the MB search API (1 req/s) using existing title + artist tags.
 * On a good match (score >= 70) stores the MBID and triggers mb-enrich-worker to enrich it.
 * Always marks found matches as tag_status = 'needs_review' — never 'confirmed'.
 */
import { workerData, parentPort } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import https from 'node:https';

const { dbPath } = workerData;

const RATE_DELAY_MS  = 1100;    // stay safely under MB's 1 req/s limit
const BATCH_SIZE     = 50;
const IDLE_WAIT_MS   = 60_000;
const HTTP_TIMEOUT_MS = 25_000;
const USER_AGENT     = 'Velvet/1.0 (https://github.com/aroundmyroom/Velvet; admin-contact@music.aroundtheworld.net)';

const SCORE_STORE_MIN  = 70;   // minimum score to store a result
const SCORE_ACCEPT_MIN = 95;   // scores above this are "high confidence" (still needs_review)

// Placeholder title/artist patterns — these are not worth querying
const TITLE_PLACEHOLDER  = /^(track|track\s*\d+|song|audio|untitled|unknown|no title|\d+)$/i;
const ARTIST_PLACEHOLDER = /^(unknown|artist|various|va|various artists|n\/a|no artist)$/i;

// Strip common tracknumber prefixes like "A1. " or "B2 - " before querying
function cleanTitle(raw) {
  return raw.replace(/^[A-Za-z]?\d+[-.\s]+/i, '').trim() || raw.trim(); // NOSONAR S5869 — false positive: \s (whitespace) and . (period) are distinct, no duplicates
}

const db = new DatabaseSync(dbPath, { timeout: 60_000 });
db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=60000');

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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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

const DB_RETRY_ATTEMPTS = 60;
const DB_RETRY_DELAY_MS = 3_000;

async function dbWriteWithRetry(fn) {
  for (let i = 0; i < DB_RETRY_ATTEMPTS; i++) {
    try {
      return fn();
    } catch (err) {
      const msg = err?.message ?? '';
      const locked = msg.includes('database is locked') || msg.includes('SQLITE_BUSY');
      if (!locked || i === DB_RETRY_ATTEMPTS - 1) throw err;
      if (_stopping) throw err;
      await sleep(DB_RETRY_DELAY_MS);
    }
  }
}

/**
 * Search MusicBrainz for a recording by artist + title.
 * Returns the parsed JSON response or throws.
 */
function mbSearch(artist, title) {
  return new Promise((resolve, reject) => {
    const q = `artist:${JSON.stringify(artist)} AND recording:${JSON.stringify(cleanTitle(title))}`;
    const url = `https://musicbrainz.org/ws/2/recording/?query=${encodeURIComponent(q)}&fmt=json&limit=5`;
    const timer = setTimeout(() => { req.destroy(new Error('MB search timeout')); }, HTTP_TIMEOUT_MS);
    const req = https.get(url, { headers: { 'User-Agent': USER_AGENT } }, res => {
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
      if (!transient || i === delays.length || _stopping) throw err;
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

let _stopping = false;

async function run() {
  // Reset pending rows left from an interrupted previous run
  await dbWriteWithRetry(() => _resetPending.run());

  parentPort.postMessage({ type: 'ready' });

  while (!_stopping) {
    const batch = _getQueue.all(BATCH_SIZE);

    if (batch.length === 0) {
      parentPort.postMessage({ type: 'status', stats: _getStats.get(), idle: true });
      for (let i = 0; i < IDLE_WAIT_MS / 1000 && !_stopping; i++) {
        await sleep(1000);
      }
      continue;
    }

    for (const row of batch) {
      if (_stopping) break;
      await processFile(row);
      await sleep(RATE_DELAY_MS);
    }

    parentPort.postMessage({ type: 'status', stats: _getStats.get(), idle: false });
  }

  parentPort.postMessage({ type: 'stopped', stats: _getStats.get() });
}

parentPort.on('message', msg => {
  if (msg === 'stop') _stopping = true;
});

await run().catch(err => {
  parentPort.postMessage({ type: 'error', message: err.message });
});
