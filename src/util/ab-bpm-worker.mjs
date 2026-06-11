/**
 * ab-bpm-worker.mjs
 * Worker thread: looks up each MBID-matched file on AcousticBrainz (~3 req/s),
 * stores BPM and musical key. Mirrors mb-enrich-worker.mjs pattern.
 *
 * AcousticBrainz API:
 *   GET https://acousticbrainz.org/api/v1/{mbid}/low-level
 *   Parse: rhythm.bpm  +  tonal.key_key + tonal.key_scale
 */
import { workerData, parentPort } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import https from 'node:https';

const { dbPath } = workerData;

const RATE_DELAY_MS   = 350;   // ~2.8 req/s — safely under AB's 3 req/s limit
const BATCH_SIZE      = 50;
const IDLE_WAIT_MS    = 60_000;
const HTTP_TIMEOUT_MS = 8_000;  // fail fast when AB is slow/down
const USER_AGENT      = 'Velvet/1.0 (https://github.com/aroundmyroom/Velvet)';

const db = new DatabaseSync(dbPath, { timeout: 300_000 });
db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=300000');  // 5 min — covers scanner long-running transactions

// On start: reset any stuck 'pending' rows from a previous interrupted run
const _resetPending = db.prepare(
  `UPDATE files SET ab_status = NULL WHERE ab_status = 'pending'`
);

const _getQueue = db.prepare(`
  SELECT rowid, filepath, vpath, mbid
  FROM files
  WHERE acoustid_status = 'found'
    AND mbid IS NOT NULL
    AND (ab_status IS NULL OR ab_status = 'error')
  LIMIT ?
`);

const _setPending = db.prepare(
  `UPDATE files SET ab_status = 'pending' WHERE filepath = ? AND vpath = ?`
);

const _setDone = db.prepare(`
  UPDATE files
  SET bpm = ?, musical_key = ?, bpm_source = 'acousticbrainz', ab_status = 'done'
  WHERE filepath = ? AND vpath = ?
`);

const _setNotFound = db.prepare(
  `UPDATE files SET ab_status = 'not_found' WHERE filepath = ? AND vpath = ?`
);

const _setError = db.prepare(
  `UPDATE files SET ab_status = 'error' WHERE filepath = ? AND vpath = ?`
);

const _getStats = db.prepare(`
  SELECT
    COUNT(CASE WHEN acoustid_status = 'found' AND mbid IS NOT NULL THEN 1 END) AS total,
    COUNT(CASE WHEN ab_status = 'done'      THEN 1 END) AS done,
    COUNT(CASE WHEN ab_status = 'not_found' THEN 1 END) AS not_found,
    COUNT(CASE WHEN ab_status = 'error'     THEN 1 END) AS errors,
    COUNT(CASE WHEN acoustid_status = 'found' AND mbid IS NOT NULL
               AND (ab_status IS NULL OR ab_status = 'error') THEN 1 END) AS queued
  FROM files
`);

// ── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// DB write retry — AcoustID/scanner may hold write lock for extended periods
const DB_RETRY_ATTEMPTS = 60;
const DB_RETRY_DELAY_MS = 3_000;

async function dbWriteWithRetry(fn) {
  for (let i = 0; i < DB_RETRY_ATTEMPTS; i++) {
    try {
      return fn();
    } catch (err) {
      const locked = err && typeof err.message === 'string' &&
        (err.message.includes('database is locked') || err.message.includes('SQLITE_BUSY'));
      if (!locked || i === DB_RETRY_ATTEMPTS - 1) throw err;
      if (_stopping) throw err;
      await sleep(DB_RETRY_DELAY_MS);
    }
  }
}

/** Fetch AcousticBrainz low-level data for an MBID. Returns parsed JSON or null (404). */
function abLookup(mbid) {
  return new Promise((resolve, reject) => {
    const url = `https://acousticbrainz.org/api/v1/${encodeURIComponent(mbid)}/low-level`;
    const timer = setTimeout(() => { req.destroy(new Error('AB timeout')); }, HTTP_TIMEOUT_MS);
    const req = https.get(url, { headers: { 'User-Agent': USER_AGENT } }, res => {
      clearTimeout(timer);
      if (res.statusCode === 404) { res.resume(); return resolve(null); }
      if (res.statusCode === 429) {
        // Rate limited — signal caller to back off
        res.resume();
        return reject(Object.assign(new Error('AB HTTP 429'), { status: 429 }));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`AB HTTP ${res.statusCode}`));
      }
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error(`AB JSON: ${e.message}`)); }
      });
      res.on('error', reject);
    });
    req.on('error', e => { clearTimeout(timer); reject(e); });
  });
}

// ── Process one file ──────────────────────────────────────────────────────────

let _processedCount = 0;

async function processFile(row) {
  await dbWriteWithRetry(() => _setPending.run(row.filepath, row.vpath));

  let apiData;
  let _wasRateLimited = false;
  try {
    apiData = await abLookup(row.mbid);
  } catch (err) {
    if (err.status === 429) {
      _wasRateLimited = true;
      // Back off 5 s and retry once
      await sleep(5_000);
      try {
        apiData = await abLookup(row.mbid);
      } catch {
        await dbWriteWithRetry(() => _setError.run(row.filepath, row.vpath));
        return;
      }
    } else {
      await dbWriteWithRetry(() => _setError.run(row.filepath, row.vpath));
      return;
    }
  }

  if (!apiData) {
    // 404 — MBID not in AcousticBrainz
    await dbWriteWithRetry(() => _setNotFound.run(row.filepath, row.vpath));
    _processedCount++;
    return;
  }

  // Parse BPM (round to integer, valid range 20–300)
  let bpm = null;
  try {
    const rawBpm = apiData?.rhythm?.bpm;
    if (rawBpm != null) {
      const n = Math.round(Number(rawBpm));
      if (Number.isFinite(n) && n >= 20 && n <= 300) bpm = n;
    }
  } catch (e) { console.debug('[velvet]', e?.message ?? e); }

  // Parse musical key ("C# minor", "G major", etc.)
  let musicalKey = null;
  try {
    const keyNote  = apiData?.tonal?.key_key;    // e.g. "C#"
    const keyScale = apiData?.tonal?.key_scale;  // e.g. "minor"
    if (keyNote && keyScale && typeof keyNote === 'string' && typeof keyScale === 'string') {
      const k = `${keyNote.trim()} ${keyScale.trim()}`.slice(0, 12);
      if (k.trim().length > 0) musicalKey = k;
    }
  } catch (e) { console.debug('[velvet]', e?.message ?? e); }

  // If both values are invalid, mark as error
  if (bpm === null && musicalKey === null) {
    await dbWriteWithRetry(() => _setError.run(row.filepath, row.vpath));
    _processedCount++;
    return;
  }

  await dbWriteWithRetry(() => _setDone.run(bpm, musicalKey, row.filepath, row.vpath));
  _processedCount++;

  parentPort.postMessage({
    type: 'progress',
    currentFile: `${row.vpath}/${row.filepath}`,
    processedCount: _processedCount,
  });
}

// ── Main loop ─────────────────────────────────────────────────────────────────

let _stopping = false;

async function run() {
  // Reset pending rows left over from an interrupted previous run
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
  if (msg === 'stop' || msg?.type === 'stop') _stopping = true;
});

// Retry loop: if the DB is locked (scanner running a long transaction), wait and retry
// instead of crashing.  Any other error is just reported.
async function runWithRetry() {
  const LOCK_RETRY_DELAY_MS = 60_000;
  for (;;) {
    try {
      await run();
      return;
    } catch (err) {
      const isLock = /database is locked|SQLITE_BUSY|ERR_SQLITE/i.test(err.message || '');
      if (isLock) {
        parentPort.postMessage({ type: 'log', message: '[bpm-ab] DB locked (scanner running) — waiting 60 s then retrying' });
        await new Promise(r => setTimeout(r, LOCK_RETRY_DELAY_MS));
        // continue retry loop
      } else {
        parentPort.postMessage({ type: 'error', message: err.message });
      }
    }
  }
}
await runWithRetry();
