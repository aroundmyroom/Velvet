/**
 * acoustid-worker.mjs
 *
 * Long-running worker thread that fingerprints every audio file in the
 * library using fpcalc (Chromaprint) and looks up the result against the
 * AcoustID web service. Results (AcoustID UUID + MusicBrainz Recording ID)
 * are written directly back to the SQLite database.
 *
 * Receives via workerData:
 *   {
 *     dbPath:    string,        // absolute path to velvet.sqlite
 *     apiKey:    string,        // AcoustID application API key
 *     fpcalcBin: string,        // absolute path to fpcalc binary
 *     folders:   { [vpath]: string }  // vpath → absolute root directory
 *   }
 *
 * Messages from main thread:
 *   { type: 'stop' }  — drain after current file and exit cleanly
 *
 * Messages to main thread:
 *   { type: 'status', stats: { total, found, not_found, errors, pending, queued } }
 *   { type: 'ready' }
 *   { type: 'stopped' }
 *   { type: 'error', message: string }
 */

import { workerData, parentPort } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { spawn, execFileSync } from 'node:child_process';
import https from 'node:https';
import path from 'node:path';
import fs from 'node:fs';
import { resolvePathWithinRoot } from './path-security.js';

// Absolute path for ionice — avoids PATH-injection (sonarjs/no-os-command-from-path)
const _IONICE_BIN = ['/usr/bin/ionice', '/bin/ionice'].find(p => fs.existsSync(p)) ?? null;

const { dbPath, apiKey, fpcalcBin, folders } = workerData;

// ── Rate limiting ─────────────────────────────────────────────────────────────
// AcoustID max = 3 req/s. We use 500 ms = 2 req/s with comfortable margin.
const REQUEST_DELAY_MS  = 500;
// Seconds before retrying a file that previously errored
const RETRY_AFTER_SEC   = 7 * 24 * 60 * 60; // 7 days
// Batch size: how many files to pull from DB per iteration
const BATCH_SIZE        = 50;
// Idle sleep when nothing is left to process
const IDLE_SLEEP_MS     = 60_000;
// HTTP timeout for AcoustID requests
const HTTP_TIMEOUT_MS   = 15_000;

let _stopRequested = false;

// ── Main + stop signal ───────────────────────────────────────────────────────

parentPort.on('message', msg => {
  if (msg?.type === 'stop') {
    _stopRequested = true;
  }
});

// ── SQLite (direct access, WAL mode supports concurrent readers) ─────────────

const db = new DatabaseSync(dbPath, { timeout: 30_000 });
db.exec('PRAGMA busy_timeout = 30000');
db.exec('PRAGMA journal_mode=WAL');
db.exec('PRAGMA synchronous = NORMAL');
db.exec('PRAGMA cache_size = -4000');

const _getQueue = db.prepare(`
  SELECT filepath, vpath, duration
  FROM files
  WHERE format IS NOT NULL
    AND (
      acoustid_status IS NULL
      OR (acoustid_status = 'error' AND (acoustid_ts IS NULL OR acoustid_ts < ?))
    )
  ORDER BY ts ASC
  LIMIT ?
`);

const _setPending = db.prepare(
  `UPDATE files SET acoustid_status = 'pending', acoustid_ts = ? WHERE filepath = ? AND vpath = ?`
);

const _setResult = db.prepare(
  `UPDATE files SET acoustid_id = ?, mbid = ?, acoustid_score = ?, acoustid_status = ?, acoustid_ts = ?,
                   mb_title = ?, mb_artist = ?, mb_artist_id = ?
   WHERE filepath = ? AND vpath = ?`
);

const _resetPending = db.prepare(
  `UPDATE files SET acoustid_status = NULL WHERE acoustid_status = 'pending'`
);

const _getStats = db.prepare(`
  SELECT
    COUNT(*) AS total,
    COUNT(CASE WHEN acoustid_status = 'found'     THEN 1 END) AS found,
    COUNT(CASE WHEN acoustid_status = 'not_found' THEN 1 END) AS not_found,
    COUNT(CASE WHEN acoustid_status = 'error'     THEN 1 END) AS errors,
    COUNT(CASE WHEN acoustid_status = 'pending'   THEN 1 END) AS pending,
    COUNT(CASE WHEN acoustid_status IS NULL        THEN 1 END) AS queued
  FROM files
  WHERE format IS NOT NULL
`);

// _resetPending is called inside run() so we can use async retry if the DB is locked at startup.

// ── fpcalc ───────────────────────────────────────────────────────────────────

// Detect ionice once at module start. Present on all standard Linux distros and
// Debian-based Docker images (util-linux). Absent on Alpine / minimal containers.
// Fall back to bare fpcalc so AcoustID still works everywhere.
let _ioniceAvailable = false;
if (_IONICE_BIN) {
  try { execFileSync(_IONICE_BIN, ['--version'], { stdio: 'ignore' }); _ioniceAvailable = true; } catch (e) { console.debug('[velvet]', e?.message ?? e); }
}

function runFpcalc(absolutePath) {
  return new Promise((resolve, reject) => {
    // -json: JSON output  -length 120: only first 120 s needed (saves time on long tracks)
    // Run fpcalc at idle I/O class + nice 19 when ionice is available so disk
    // fingerprinting never competes with the audio stream being served.
    // Falls back to bare fpcalc on Alpine / minimal Docker images.
    const [cmd, args] = _ioniceAvailable
      ? [_IONICE_BIN, ['-c', '3', 'nice', '-n', '19', fpcalcBin, '-json', '-length', '120', absolutePath]]
      : [fpcalcBin, ['-json', '-length', '120', absolutePath]];
    const proc = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });
    proc.on('close', code => {
      clearTimeout(killTimer);
      if (code !== 0) {
        return reject(new Error(`fpcalc exited ${code}: ${stderr.slice(0, 200)}`));
      }
      try {
        const parsed = JSON.parse(stdout);
        if (!parsed.fingerprint || !parsed.duration) {
          return reject(new Error('fpcalc returned incomplete output'));
        }
        resolve({ fingerprint: parsed.fingerprint, duration: Math.round(parsed.duration) });
      } catch (e) {
        reject(new Error(`fpcalc JSON parse error: ${e.message}`));
      }
    });
    proc.on('error', e => { clearTimeout(killTimer); reject(e); });
    // Kill fpcalc if it hangs (e.g. corrupt file, slow mount) — 90 s is generous
    const killTimer = setTimeout(() => {
      proc.kill();
      reject(new Error('fpcalc timed out after 90s'));
    }, 90_000);
  });
}

// ── AcoustID API lookup ──────────────────────────────────────────────────────

function acoustidLookup(duration, fingerprint) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      client:      apiKey,
      duration:    String(duration),
      fingerprint: fingerprint,
      meta:        'recordings',
      format:      'json',
    });
    const url = `https://api.acoustid.org/v2/lookup?${params.toString()}`;

    const timer = setTimeout(() => {
      req.destroy(new Error('AcoustID request timed out'));
    }, HTTP_TIMEOUT_MS);

    const req = https.get(url, { headers: { 'User-Agent': 'Velvet/dev +https://github.com/aroundmyroom/Velvet' } }, res => {
      clearTimeout(timer);
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`AcoustID HTTP ${res.statusCode}`));
      }
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error(`AcoustID JSON parse error: ${e.message}`));
        }
      });
      res.on('error', reject);
    });
    req.on('error', e => { clearTimeout(timer); reject(e); });
  });
}

// ── Delay helper ─────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── DB write retry ───────────────────────────────────────────────────────────
// SQLite can throw "database is locked" when another writer (artist-rebuild,
// MB-enrich, main-thread scan) holds the write lock.  PRAGMA busy_timeout only
// blocks up to 30 s — not enough for a full-library artist FTS rebuild.
// Instead of crashing the worker, wait and retry for up to ~3 minutes.
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
      // Abort retry loop immediately if a stop was requested
      if (_stopRequested) throw err;
      await sleep(DB_RETRY_DELAY_MS);
    }
  }
}

// ── Process one file ─────────────────────────────────────────────────────────

// Shorthand for null results (error/not_found paths — no MB data)
async function _setResultNull(status, row) {
  await dbWriteWithRetry(() => _setResult.run(null, null, null, status, Math.floor(Date.now() / 1000),
    null, null, null, row.filepath, row.vpath));
}

async function processFile(row) {
  const rootDir = folders[row.vpath];
  if (!rootDir) {
    // vpath not in folders config — treat as permanent no-match, not an error
    await _setResultNull('not_found', row);
    return;
  }

  // Very short clips (< 7 s) can never be fingerprinted reliably — skip immediately
  if (row.duration !== null && row.duration < 7) {
    await _setResultNull('not_found', row);
    return;
  }

  let absolutePath;
  try {
    absolutePath = resolvePathWithinRoot(rootDir, row.filepath);
  } catch {
    await _setResultNull('not_found', row);
    return;
  }

  // Mark as pending immediately
  await dbWriteWithRetry(() => _setPending.run(Math.floor(Date.now() / 1000), row.filepath, row.vpath));

  let duration;
  let fingerprint;

  try {
    const fp = await runFpcalc(absolutePath);
    duration    = fp.duration;
    fingerprint = fp.fingerprint;
  } catch {
    // fpcalc failed: corrupt file, unsupported encoding, or decode error.
    // These are permanent failures — mark not_found so they are never retried.
    await _setResultNull('not_found', row);
    return;
  }

  // Use DB-stored duration if fpcalc returns 0 (very short or undecodable clip)
  if (!duration && row.duration) duration = Math.round(row.duration);
  if (!duration || duration < 1) {
    await _setResultNull('not_found', row);
    return;
  }

  let apiData;
  try {
    apiData = await acoustidLookup(duration, fingerprint);
  } catch {
    await _setResultNull('error', row);
    return;
  }

  if (apiData?.status !== 'ok' || !apiData.results?.length) {
    await _setResultNull('not_found', row);
    return;
  }

  // Pick the result with the highest score
  const best = apiData.results.reduce((a, b) => (b.score > a.score ? b : a));

  if ((best.score || 0) < 0.5) {
    await _setResultNull('not_found', row);
    return;
  }

  // Extract MusicBrainz Recording ID + canonical title/artist from best result
  const recording  = best.recordings?.[0] ?? null;
  const mbid       = recording?.id ?? null;
  const mbTitle    = recording?.title ?? null;
  const mbArtist   = recording?.artists?.[0]?.name ?? null;
  const mbArtistId = recording?.artists?.[0]?.id ?? null;

  // Only mark 'found' when we actually have a MusicBrainz recording ID.
  // If AcoustID matched by score but returned no recordings, treat as not_found
  // so the startup migration (found+mbid=null reset) never trips on these rows.
  const finalStatus = mbid ? 'found' : 'not_found';

  await dbWriteWithRetry(() => _setResult.run(
    best.id || null, mbid, best.score, finalStatus, Math.floor(Date.now() / 1000),
    mbTitle, mbArtist, mbArtistId,
    row.filepath, row.vpath));
}

// ── Main loop ─────────────────────────────────────────────────────────────────

async function run() {
  // Verify API key before starting
  if (!apiKey || apiKey.length < 4) {
    parentPort.postMessage({ type: 'error', message: 'No valid AcoustID API key configured' });
    return;
  }

  // Reset any rows left as 'pending' from a previous run (with retry in case DB is locked at startup)
  await dbWriteWithRetry(() => _resetPending.run());

  parentPort.postMessage({ type: 'ready' });

  while (!_stopRequested) {
    const cutoff = Math.floor(Date.now() / 1000) - RETRY_AFTER_SEC;
    const batch = _getQueue.all(cutoff, BATCH_SIZE);

    if (batch.length === 0) {
      // Nothing left — send final stats and idle
      const stats = _getStats.get();
      parentPort.postMessage({ type: 'status', stats });

      // Sleep IDLE_SLEEP_MS but check for stop signal every second
      for (let i = 0; i < IDLE_SLEEP_MS / 1000 && !_stopRequested; i++) {
        await sleep(1000);
      }
      continue;
    }

    for (const row of batch) {
      if (_stopRequested) break;
      try {
        await processFile(row);
      } catch (err) {
        // Non-lock error on a single file — log and continue so one bad file
        // doesn't abort the entire batch.
        parentPort.postMessage({ type: 'fileError', message: err.message });
      }
      await sleep(REQUEST_DELAY_MS);
    }

    // Send a progress update after each batch
    const stats = _getStats.get();
    parentPort.postMessage({ type: 'status', stats });
  }

  // Reset any pending rows so they retry on next start
  await dbWriteWithRetry(() => _resetPending.run());
  parentPort.postMessage({ type: 'stopped' });
}

await run().catch(err => {
  parentPort.postMessage({ type: 'error', message: err.message });
});
