/**
 * rg-analysis-worker.mjs
 *
 * Long-running worker thread that measures the loudness of every audio file
 * in the library using rsgain (primary) or ffmpeg -ebur128 (fallback).
 * Results are written directly to the SQLite database.
 *
 * Receives via workerData:
 *   {
 *     dbPath:       string,  // absolute path to velvet.sqlite
 *     folders:      { [vpath]: string }  // ROOT vpath → absolute root dir
 *     rsgainBin:    string | null,       // path to rsgain binary, or null
 *     ffmpegBin:    string,              // path to ffmpeg binary
 *   }
 *
 * Messages from main thread:
 *   { type: 'stop' }  — drain after current file and exit cleanly
 *
 * Messages to main thread:
 *   { type: 'status', stats: { total, measured, queued, failed, tool } }
 *   { type: 'ready' }
 *   { type: 'stopped' }
 *   { type: 'error', message: string }
 */

import { workerData, parentPort } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { resolvePathWithinRoot } from './path-security.js';

const { dbPath, folders, rsgainBin, ffmpegBin } = workerData;

// ── Tuning constants ──────────────────────────────────────────────────────────
const BATCH_SIZE          = 50;
const YIELD_BETWEEN_MS    = 250;  // ms between files — gives OS room to breathe alongside other workers
const IDLE_SLEEP_MS       = 60_000;

let _stopRequested = false;

parentPort.on('message', msg => {
  if (msg?.type === 'stop') _stopRequested = true;
});

// ── SQLite ────────────────────────────────────────────────────────────────────

const db = new DatabaseSync(dbPath, { timeout: 300_000 });
db.exec('PRAGMA busy_timeout = 300000');  // 5 min — covers scanner long-running transactions
db.exec('PRAGMA journal_mode=WAL');
db.exec('PRAGMA synchronous = NORMAL');
db.exec('PRAGMA cache_size = -4000');

const _rsgainAvail = Boolean(rsgainBin && fs.existsSync(rsgainBin));

const _queueSql = _rsgainAvail
  ? `(rg_measured_ts IS NULL OR (rg_measured_ts > 0 AND rg_measurement_tool = 'ffmpeg'))`
  : `rg_measured_ts IS NULL`;

const _getQueue = db.prepare(`
  SELECT rowid AS id, filepath, vpath, artist, album_artist, album, title, mb_album_dir,
         rg_album_gain_db, rg_album_peak_dbfs, duration
  FROM files
  WHERE format IS NOT NULL AND ${_queueSql}
  ORDER BY rowid
  LIMIT ?
`);

const _setMeasurement = db.prepare(`
  UPDATE files SET
    rg_integrated_lufs  = ?,
    rg_true_peak_dbfs   = ?,
    rg_track_gain_db    = ?,
    rg_lra              = ?,
    rg_measured_ts      = ?,
    rg_measurement_tool = ?
  WHERE rowid = ?
`);

const _setFailed = db.prepare(`
  UPDATE files SET rg_measured_ts = -1, rg_measurement_tool = ?,
                   rg_measurement_error = ? WHERE rowid = ?
`);

const _setAlbumGain = db.prepare(`
  UPDATE files SET rg_album_gain_db = ?, rg_album_peak_dbfs = ? WHERE rowid = ?
`);

const _clearAlbumGain = db.prepare(`
  UPDATE files SET rg_album_gain_db = NULL, rg_album_peak_dbfs = NULL WHERE rowid = ?
`);

const _getStats = db.prepare(`
  SELECT
    COUNT(*) AS total,
    COUNT(CASE WHEN rg_measured_ts IS NOT NULL AND rg_measured_ts != -1 THEN 1 END) AS measured,
    COUNT(CASE WHEN rg_measured_ts IS NULL THEN 1 END)                              AS queued,
    COUNT(CASE WHEN rg_measured_ts = -1 THEN 1 END)                                AS failed
  FROM files WHERE format IS NOT NULL
`);

function _getSiblings(row) {
  if (row.mb_album_dir) {
    return db.prepare(`
      SELECT rowid AS id, rg_album_gain_db, rg_track_gain_db, rg_integrated_lufs, rg_true_peak_dbfs
      FROM files WHERE mb_album_dir = ? AND format IS NOT NULL
    `).all(row.mb_album_dir);
  }
  const albumArtist = row.album_artist || row.artist || '';
  return db.prepare(`
    SELECT rowid AS id, rg_album_gain_db, rg_track_gain_db, rg_integrated_lufs, rg_true_peak_dbfs
    FROM files
    WHERE vpath = ? AND album = ?
      AND (album_artist = ? OR (album_artist IS NULL AND artist = ?))
      AND format IS NOT NULL
  `).all(row.vpath, row.album ?? '', albumArtist, albumArtist);
}

// ── Measurement: rsgain ───────────────────────────────────────────────────────
// rsgain custom --tagmode=s -O <file>
// Scan only (don't write tags), output tab-delimited to stdout.
// Header line: Filename\tLoudness (LUFS)\tGain (dB)\tPeak\t Peak (dB)\tPeak Type\tClipping Adjustment?
// Data line:   <basename>\t<LUFS>\t<gain_dB>\t<peak_linear>\t<peak_dBFS>\t<type>\t<N|Y>
//
// Hard timeout: at least 120 s, but scaled to 0.5 s per second of audio for
// very long files (mixes, audiobooks).  A 741-min megamix gets ~22 min budget.
const BASE_TIMEOUT_MS   = 120_000;
const MS_PER_AUDIO_SEC  = 500;   // 0.5 s processing budget per 1 s of audio

function _timeoutForFile(durationSec) {
  return Math.max(BASE_TIMEOUT_MS, (durationSec || 0) * MS_PER_AUDIO_SEC);
}

// Extract the most useful error line from rsgain stderr output.
// rsgain writes progress lines like "  123/456  some_file.mp3" — ignore those.
// Error lines start with "Error:", "Warning:", or contain "cannot" / "unable".
function _extractRsgainError(stderr) {
  if (!stderr) return null;
  for (const line of stderr.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const lo = t.toLowerCase();
    if (lo.startsWith('error') || lo.startsWith('warning') ||
        lo.includes('cannot') || lo.includes('unable') ||
        lo.includes('invalid') || lo.includes('failed') ||
        lo.includes('no such') || lo.includes('could not')) {
      return t.slice(0, 200);
    }
  }
  // fallback: last non-empty line that isn't a progress indicator
  const lines = stderr.split('\n').map(l => l.trim()).filter(l => l && !/^\s*\d+\/\d+/.test(l));
  return lines.length ? lines[lines.length - 1].slice(0, 200) : null;
}

// Extract the most useful error line from ffmpeg stderr output.
function _extractFfmpegError(stderr) {
  if (!stderr) return null;
  // Look for lines starting with a known ffmpeg error prefix
  for (const line of stderr.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const lo = t.toLowerCase();
    if (lo.startsWith('error') || lo.includes('invalid data') ||
        lo.includes('no such file') || lo.includes('moov atom') ||
        lo.includes('could not find') || lo.includes('unable to') ||
        lo.includes('not supported') || lo.includes('permission denied') ||
        lo.includes('i: -inf') || lo.includes('error while decoding')) {
      return t.slice(0, 200);
    }
  }
  return null;
}

function measureWithRsgain(absolutePath, timeoutMs) {
  return new Promise(resolve => {
    const proc = spawn(rsgainBin, ['custom', '--tagmode=s', '-O', absolutePath],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try { proc.kill('SIGKILL'); } catch (e) { console.debug('[velvet]', e?.message ?? e); }
    }, timeoutMs);
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => { err += d; });
    proc.on('close', code => {
      clearTimeout(timer);
      if (killed) return resolve({ timedOut: true });
      if (code !== 0) return resolve({ errorMsg: _extractRsgainError(err) || `exit code ${code}` });
      try {
        // Tab-delimited output — skip header line, skip Album summary line
        for (const line of out.split('\n')) {
          const cols = line.split('\t');
          if (cols.length < 5) continue;
          const name = cols[0].trim();
          if (!name || name === 'Filename' || name === 'Album') continue;
          const integratedLufs = Number.parseFloat(cols[1]);
          const trackGain      = Number.parseFloat(cols[2]);
          const truePeakDb     = Number.parseFloat(cols[4]);
          if (!Number.isFinite(integratedLufs) || !Number.isFinite(trackGain)) continue;
          return resolve({
            integratedLufs,
            truePeak:  Number.isFinite(truePeakDb) ? truePeakDb : null,
            trackGain,
            lra:       null,  // rsgain custom -O does not output LRA
            tool:      'rsgain',
          });
        }
      } catch (e) { console.debug('[velvet]', e?.message ?? e); }
      resolve({ errorMsg: _extractRsgainError(err) || 'No loudness data — file may be silent, too short, or in an unsupported format' });
    });
    proc.on('error', (e) => { clearTimeout(timer); resolve({ errorMsg: e.message }); });
  });
}

// ── Measurement: ffmpeg ebur128 ───────────────────────────────────────────────
// Uses the ebur128 audio filter with peak=true.
// The relevant output is printed to stderr after the "Summary:" line.
//
// ReplayGain 2.0 reference = -18 LUFS, so:
//   track_gain = -18 - integrated_loudness

const R128_REF_LUFS = -18;

function parseEbur128Stderr(stderr) {
  // Look for: "I:        -13.5 LUFS"
  const iMatch = stderr.match(/I:\s*([-\d.]+)\s*LUFS/);
  if (!iMatch) return null;
  const integratedLufs = Number.parseFloat(iMatch[1]);
  if (!Number.isFinite(integratedLufs)) return null;

  const lraMatch = stderr.match(/LRA:\s*([\d.]+)\s*LU/);
  const peakMatch = stderr.match(/True peak:\s*Peak:\s*([-\d.]+)\s*dBFS/);

  return {
    integratedLufs,
    truePeak:   peakMatch  ? Number.parseFloat(peakMatch[1])  : null,
    trackGain:  R128_REF_LUFS - integratedLufs,
    lra:        lraMatch   ? Number.parseFloat(lraMatch[1])   : null,
    tool:       'ffmpeg',
  };
}

function measureWithFfmpeg(absolutePath, timeoutMs) {
  return new Promise(resolve => {
    const proc = spawn(ffmpegBin, [
      '-hide_banner', '-nostats',
      '-i', absolutePath,
      '-af', 'ebur128=peak=true',
      '-f', 'null', '-',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try { proc.kill('SIGKILL'); } catch (e) { console.debug('[velvet]', e?.message ?? e); }
    }, timeoutMs);
    proc.stderr.on('data', d => { stderr += d; });
    proc.on('close', () => {
      clearTimeout(timer);
      if (killed) return resolve({ timedOut: true });
      const result = parseEbur128Stderr(stderr);
      if (result) return resolve(result);
      resolve({ errorMsg: _extractFfmpegError(stderr) || 'No loudness data — file may be silent, too short, or in an unsupported format' });
    });
    proc.on('error', (e) => { clearTimeout(timer); resolve({ errorMsg: e.message }); });
  });
}

async function measure(absolutePath, timeoutMs) {
  if (_rsgainAvail) {
    // When rsgain is available, use it exclusively.  Do NOT fall back to ffmpeg
    // on a per-file basis — ffmpeg measures at realtime speed (1× playback rate),
    // which means a 10-minute track takes 10 minutes.  For a library of 100K+
    // files that would take weeks.  Files rsgain can't handle are simply marked
    // as failed and can be inspected separately.
    return measureWithRsgain(absolutePath, timeoutMs);
  }
  return measureWithFfmpeg(absolutePath, timeoutMs);
}

// ── Album gain computation ────────────────────────────────────────────────────

function computeAlbumGain(siblings) {
  // Album gain: all tracks must be measured; use the loudest (lowest gain) as reference
  // Standard EBU R128 album mode: compute mean loudness across all tracks
  const measured = siblings.filter(s => s.rg_integrated_lufs != null && s.rg_track_gain_db != null);
  if (measured.length === 0 || measured.length !== siblings.length) return null;

  // Use mean integrated loudness to derive album gain
  const meanLufs = measured.reduce((sum, s) => sum + s.rg_integrated_lufs, 0) / measured.length;
  const albumGain = R128_REF_LUFS - meanLufs;

  // Album true peak = max true peak across tracks
  const peaks = measured.filter(s => s.rg_true_peak_dbfs != null).map(s => s.rg_true_peak_dbfs);
  const albumPeak = peaks.length ? Math.max(...peaks) : null;

  return { albumGain, albumPeak };
}

// ── Yield helper ──────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms).unref());
}

// ── Main loop ─────────────────────────────────────────────────────────────────

async function run() {
  // Reset any stale 'pending' marks from a previous crashed run
  // (rg uses -1 for failed, so no pending cleanup needed here)

  // Running counter — incremented for every file attempted (success or fail)
  let _processedCount = 0;

  parentPort.postMessage({ type: 'ready' });

  while (!_stopRequested) {
    const batch = _getQueue.all(BATCH_SIZE);

    if (!batch.length) {
      const stats = _getStats.get();
      parentPort.postMessage({ type: 'status', stats: { ...stats, tool: _rsgainAvail ? 'rsgain' : 'ffmpeg' }, processedCount: _processedCount });
      await sleep(IDLE_SLEEP_MS);
      continue;
    }

    for (const row of batch) {
      if (_stopRequested) break;

      const rootDir = folders[row.vpath];
      if (!rootDir) {
        _processedCount++;
        _setFailed.run('missing_vpath', null, row.id);
        continue;
      }
      let absolutePath;
      try {
        absolutePath = resolvePathWithinRoot(rootDir, row.filepath);
      } catch {
        _processedCount++;
        _setFailed.run('invalid_path', null, row.id);
        continue;
      }

      // macOS resource fork files (._filename) are never audio — skip immediately.
      if (path.basename(absolutePath).startsWith('._')) {
        _processedCount++;
        _setFailed.run('resource_fork', 'macOS resource fork file — not audio', row.id);
        continue;
      }

      if (!fs.existsSync(absolutePath)) {
        _processedCount++;
        _setFailed.run('file_not_found', null, row.id);
        continue;
      }

      // Announce the file we are about to measure
      parentPort.postMessage({ type: 'progress', currentFile: row.filepath, vpath: row.vpath, processedCount: _processedCount });

      const timeoutMs = _timeoutForFile(row.duration);
      let result = null;
      try {
        result = await measure(absolutePath, timeoutMs);
      } catch (e) { console.debug('[velvet]', e?.message ?? e); }

      if (!result || result.timedOut || result.errorMsg !== undefined) {
        _processedCount++;
        const reason   = result?.timedOut ? 'timed_out' : 'measure_failed';
        const errorMsg = result?.timedOut ? null : (result?.errorMsg || null);
        _setFailed.run(reason, errorMsg, row.id);
        const stats = _getStats.get();
        parentPort.postMessage({ type: 'status', stats: { ...stats, tool: _rsgainAvail ? 'rsgain' : 'ffmpeg' }, processedCount: _processedCount });
        await sleep(YIELD_BETWEEN_MS);
        continue;
      }

      const now = Math.floor(Date.now() / 1000);
      _setMeasurement.run(
        result.integratedLufs, result.truePeak, result.trackGain,
        result.lra, now, result.tool, row.id
      );

      // ── Album gain: check if the whole album is now complete ─────────────
      // Reload siblings (including this file's freshly set columns)
      const siblingsRaw = _getSiblings({ ...row, rg_integrated_lufs: result.integratedLufs });
      // The freshly updated row won't be reflected yet; patch it in memory
      const siblings = siblingsRaw.map(s =>
        s.id === row.id
          ? { ...s, rg_integrated_lufs: result.integratedLufs, rg_true_peak_dbfs: result.truePeak, rg_track_gain_db: result.trackGain }
          : s
      );

      // If any sibling had an album gain written from a previous (possibly incomplete)
      // pass and the album roster changed, we must recompute.
      const hadAlbumGain = siblings.some(s => s.id !== row.id && s.rg_album_gain_db != null);
      if (hadAlbumGain) {
        // Reset album gain on all siblings — will be rewritten below if complete
        for (const s of siblings) _clearAlbumGain.run(s.id);
        for (const s of siblings) s.rg_album_gain_db = null;
      }

      const albumResult = computeAlbumGain(siblings);
      if (albumResult) {
        for (const s of siblings) {
          _setAlbumGain.run(albumResult.albumGain, albumResult.albumPeak ?? null, s.id);
        }
      }

      _processedCount++;
      const stats = _getStats.get();
      parentPort.postMessage({ type: 'status', stats: { ...stats, tool: result.tool }, processedCount: _processedCount });

      await sleep(YIELD_BETWEEN_MS);
    }
  }

  const stats = _getStats.get();
  parentPort.postMessage({ type: 'status', stats: { ...stats, tool: _rsgainAvail ? 'rsgain' : 'ffmpeg' }, processedCount: _processedCount });
  parentPort.postMessage({ type: 'stopped' });
}

// Retry loop: if the DB is locked (scanner running a long transaction), wait and retry
// instead of crashing.  Any other error is fatal as before.
async function runWithRetry() {
  const LOCK_RETRY_DELAY_MS = 60_000;
  for (;;) {
    try {
      await run();
      return;
    } catch (e) {
      const isLock = /database is locked|SQLITE_BUSY|ERR_SQLITE/i.test(e.message || '');
      if (isLock) {
        parentPort.postMessage({ type: 'log', message: '[rg-analysis] DB locked (scanner running) — waiting 60 s then retrying' });
        await new Promise(r => setTimeout(r, LOCK_RETRY_DELAY_MS));
        // continue retry loop
      } else {
        parentPort.postMessage({ type: 'error', message: e.message });
        process.exit(1);
      }
    }
  }
}
await runWithRetry();
