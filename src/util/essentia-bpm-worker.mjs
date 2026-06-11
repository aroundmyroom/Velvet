/**
 * essentia-bpm-worker.mjs
 *
 * Worker thread: Tier-2 BPM & musical-key analysis using Essentia.js (WASM).
 * Runs on files that were not covered by tag data or AcousticBrainz lookups.
 *
 * Queue: files WHERE (bpm IS NULL OR musical_key IS NULL)
 *                AND bpm_status IS NULL
 *
 * For each file:
 *   1. Decode audio → mono 22050 Hz raw PCM (f32le) via FFmpeg pipe
 *   2. Run Essentia RhythmExtractor2013 → bpm
 *   3. Run Essentia KeyExtractor        → key_name + key_scale
 *   4. UPDATE files SET bpm, musical_key, bpm_source='essentia', bpm_status='done'
 *
 * workerData fields:
 *   dbPath     {string}  path to velvet.sqlite
 *   folders    {object}  config.program.folders (vpath name → { root, ... })
 *   ffmpegBin  {string}  absolute path to the ffmpeg binary
 */

import { workerData, parentPort } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { resolvePathWithinRoot } from './path-security.js';

const require = createRequire(import.meta.url);

// ── Config ────────────────────────────────────────────────────────────────────

const { dbPath, folders, ffmpegBin } = workerData;

const SAMPLE_RATE     = 22050;  // Hz — sufficient for BPM & key; halved from CD quality
const BATCH_SIZE      = 20;
const IDLE_WAIT_MS    = 60_000; // re-check queue after 1 min idle
const INTER_FILE_MS   = 200;    // brief pause between files — keeps CPU from pegging at 100%

// Processing timeout: 0.3 s budget per second of audio, minimum 60 s.
// A 60-min DJ mix: 60*60*0.3 = 1080 s → ~18 min is the worst case (uncommon).
const TIMEOUT_PER_AUDIO_SEC = 300;
const MIN_TIMEOUT_MS        = 60_000;

// Files longer than this are auto-skipped WITHOUT decode: duration alone tells
// us the track is a continuous mix where a single BPM value is meaningless.
const MAX_DURATION_SEC = 1_200; // 20 minutes

// Secondary guard AFTER decode: if the decoded PCM Float32Array exceeds this
// size the WASM heap will OOM during arrayToVector + RhythmExtractor working
// buffers (~3× input).  60 MB ≈ 13.6 min at 22050 Hz mono f32le.
// High-bitrate sources (e.g. 96 kHz / 24-bit FLACs) can produce large decoded
// buffers even for sub-20-min files.  This guard prevents the OOM kill.
const MAX_PCM_BYTES = 60 * 1024 * 1024; // 60 MB

// ── DB setup ──────────────────────────────────────────────────────────────────

const db = new DatabaseSync(dbPath, { timeout: 300_000 });
db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=300000');

const _resetPending = db.prepare(
  `UPDATE files SET bpm_status = NULL WHERE bpm_status = 'pending'`
);

const _getQueue = db.prepare(`
  SELECT rowid, filepath, vpath, duration
  FROM files
  WHERE (bpm IS NULL OR musical_key IS NULL)
    AND bpm_status IS NULL
    AND format IS NOT NULL
  ORDER BY rowid
  LIMIT ?
`);
// NOTE: bpm_status = 'error' files are intentionally excluded — they only get
// re-queued when the admin explicitly clicks "Reset Failed". This prevents the
// infinite retry loop where WASM-crashing files (e.g. 3-hour DJ mixes that
// exceed WASM heap limits) are hammered on every batch cycle.

const _setPending = db.prepare(
  `UPDATE files SET bpm_status = 'pending' WHERE filepath = ? AND vpath = ?`
);

const _setDone = db.prepare(`
  UPDATE files
  SET bpm = ?, musical_key = ?, bpm_source = 'essentia', bpm_status = 'done'
  WHERE filepath = ? AND vpath = ?
`);

const _setError = db.prepare(
  `UPDATE files SET bpm_status = 'error' WHERE filepath = ? AND vpath = ?`
);

const _getStats = db.prepare(`
  SELECT
    COUNT(CASE WHEN (bpm IS NULL OR musical_key IS NULL) AND format IS NOT NULL THEN 1 END) AS total,
    COUNT(CASE WHEN bpm_status = 'done'  THEN 1 END) AS done,
    COUNT(CASE WHEN bpm_status = 'error' THEN 1 END) AS errors,
    COUNT(CASE WHEN (bpm IS NULL OR musical_key IS NULL)
               AND (bpm_status IS NULL OR bpm_status = 'error')
               AND format IS NOT NULL THEN 1 END) AS queued
  FROM files
`);

// ── State ─────────────────────────────────────────────────────────────────────

let _stopping = false;
let _processedCount = 0;

// ── Essentia init (lazy, once) ────────────────────────────────────────────────

let _essentia = null;

// Suppress Emscripten WASM runtime noise: when essentia.js aborts, its Module.print
// and Module.printErr callbacks fire with `undefined` as their argument, producing
// bare "undefined" lines in systemd journal. Filter those out without hiding real logs.
const _origLog  = console.log.bind(console);
const _origWarn = console.warn.bind(console);
const _origErr  = console.error.bind(console);
console.log   = (...a) => { if (a.length !== 1 || a[0] !== undefined) _origLog(...a); };
console.warn  = (...a) => { if (a.length !== 1 || a[0] !== undefined) _origWarn(...a); };
console.error = (...a) => { if (a.length !== 1 || a[0] !== undefined) _origErr(...a); };

function getEssentia() {
  if (_essentia) return _essentia;
  const { EssentiaWASM, Essentia } = require('essentia.js');
  _essentia = new Essentia(EssentiaWASM);
  return _essentia;
}

function resetEssentia() {
  // After a WASM abort the instance is in an undefined state — discard it so
  // the next file gets a fresh module rather than a corrupted one.
  try { if (_essentia) _essentia.shutdown?.(); } catch (e) { console.debug('[velvet]', e?.message ?? e); }
  _essentia = null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function DB_RETRY_ATTEMPTS() { return 60; }
const DB_RETRY_DELAY_MS = 3_000;

async function dbWriteWithRetry(fn) {
  for (let i = 0; i < DB_RETRY_ATTEMPTS(); i++) {
    try { return fn(); }
    catch (err) {
      const locked = err?.message?.includes('database is locked') ||
                     err?.message?.includes('SQLITE_BUSY');
      if (!locked || i === DB_RETRY_ATTEMPTS() - 1) throw err;
      if (_stopping) throw err;
      await sleep(DB_RETRY_DELAY_MS);
    }
  }
}

/**
 * Resolve the absolute filesystem path for a (vpath, filepath) pair.
 * Returns null if the vpath is not in the folders config.
 */
function resolveAbsPath(vpath, filepath) {
  const folder = folders[vpath];
  if (!folder?.root) return null;
  try {
    return resolvePathWithinRoot(folder.root, filepath);
  } catch {
    return null;
  }
}

/**
 * Decode an audio file to raw mono PCM using FFmpeg.
 * Returns a Float32Array of PCM samples at the given sampleRate.
 * Throws on decode failure; rejects after timeoutMs.
 */
function decodeAudioPcm(absolutePath, timeoutMs, sampleRate = SAMPLE_RATE) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let stderr = '';
    let killed = false;

    const proc = spawn(ffmpegBin, [
      '-i', absolutePath,
      '-vn',               // drop video/art streams
      '-ac', '1',          // mono
      '-ar', String(sampleRate),
      '-f', 'f32le',       // raw 32-bit float little-endian PCM
      '-'                  // pipe to stdout
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    const timer = setTimeout(() => {
      killed = true;
      try { proc.kill('SIGKILL'); } catch (e) { console.debug('[velvet]', e?.message ?? e); }
      reject(new Error(`ffmpeg decode timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.stdout.on('data', chunk => chunks.push(chunk));
    proc.stderr.on('data', d => { stderr += d; });

    proc.on('close', code => {
      clearTimeout(timer);
      if (killed) return; // already rejected
      if (code !== 0) {
        // Extract the most useful error line from stderr
        const errLine = (stderr.split('\n').find(l =>
          l.toLowerCase().includes('error') || l.toLowerCase().includes('invalid') ||
          l.toLowerCase().includes('no such') || l.toLowerCase().includes('unable')
        ) || `exit code ${code}`).trim().slice(0, 200);
        return reject(new Error(`ffmpeg: ${errLine}`));
      }
      if (chunks.length === 0) {
        return reject(new Error('ffmpeg produced no PCM output — file may be silent, corrupt, or a cover-only container'));
      }
      const buf = Buffer.concat(chunks);
      const f32 = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
      resolve(f32);
    });

    proc.on('error', err => { clearTimeout(timer); reject(err); });
  });
}

/**
 * Run Essentia BPM + Key analysis on a PCM Float32Array.
 * Returns { bpm: number, key: string, scale: string } or throws.
 *
 * Phase 3 — octave correction via estimates histogram:
 * After RhythmExtractor2013 returns `bpm`, scan the `estimates` VectorFloat
 * to count how many passes landed near the raw BPM vs near bpm/2.
 * If rawBpm > 120 and the half-tempo is almost as well-represented
 * (countHalf >= countFull * 0.75) and the result would be in range (>= 60),
 * prefer the half-tempo — Essentia has doubled the true tempo.
 */
function analyseWithEssentia(pcm) {
  const essentia = getEssentia();
  const vec = essentia.arrayToVector(pcm);

  // BPM
  let bpm = null;
  try {
    const rhythmResult = essentia.RhythmExtractor2013(vec);
    if (rhythmResult.bpm > 0) {
      const rawBpm  = rhythmResult.bpm;
      const halfBpm = rawBpm / 2;

      // Count estimates near the reported BPM and near its half
      let countFull = 0;
      let countHalf = 0;
      const nEst = rhythmResult.estimates?.size?.() ?? 0;
      for (let i = 0; i < nEst; i++) {
        const e = rhythmResult.estimates.get(i);
        if (Math.abs(e - rawBpm)  <= 5) countFull++;
        if (Math.abs(e - halfBpm) <= 5) countHalf++;
      }

      // If rawBpm is suspiciously fast (>120) AND the half-tempo is nearly as
      // well-supported, correct downward. Log the decision for diagnostics.
      let finalBpm = rawBpm;
      if (rawBpm > 120 && halfBpm >= 60 && nEst > 0 && countHalf >= countFull * 0.75) {
        finalBpm = halfBpm;
        parentPort.postMessage({
          type: 'log',
          message: `[bpm-octave] Halved ${rawBpm.toFixed(1)} → ${halfBpm.toFixed(1)} BPM (estimates: full=${countFull}, half=${countHalf})`,
        });
      }

      bpm = Math.round(finalBpm * 10) / 10;
    }
  } catch {
    // BPM extraction failed — leave as null
  }

  // Key + scale
  let key = null;
  try {
    const keyResult = essentia.KeyExtractor(vec);
    if (keyResult.key && keyResult.scale) {
      // Normalise to match AcousticBrainz / tag format: e.g. "C major" → "C major"
      key = `${keyResult.key} ${keyResult.scale}`;
    }
  } catch {
    // Key extraction failed — leave as null
  }

  // Free WASM vector to avoid memory leak across files
  try { vec.delete(); } catch (e) { console.debug('[velvet]', e?.message ?? e); }

  return { bpm, key };
}

// ── Core processing loop ──────────────────────────────────────────────────────

/**
 * Returns true if a sidecar .cue file exists in the same directory as absPath,
 * or a .cue file sharing the same base name as the audio file.
 * Long files with a cue sheet are intentional single-file disc images — a global
 * BPM value is meaningless for them, and the skip is expected and harmless.
 */
function _hasSidecarCue(absPath) {
  try {
    const dir = path.dirname(absPath);
    const base = path.basename(absPath, path.extname(absPath));
    // Fast check: exact-name sidecar first (most common case)
    if (fs.existsSync(resolvePathWithinRoot(dir, base + '.cue'))) return true;
    // Fallback: any .cue file in the same directory
    return fs.readdirSync(dir).some(f => f.toLowerCase().endsWith('.cue'));
  } catch {
    return false;
  }
}

async function processFile(row) {
  const absPath = resolveAbsPath(row.vpath, row.filepath);
  if (!absPath) {
    await dbWriteWithRetry(() => _setError.run(row.filepath, row.vpath));
    return;
  }

  const durationSec = row.duration || 300; // fallback 5 min if unknown

  // Auto-skip files that are too long for the WASM heap — they will always crash.
  // These are marked as 'error' once and never retried unless admin resets.
  if (durationSec > MAX_DURATION_SEC) {
    await dbWriteWithRetry(() => _setError.run(row.filepath, row.vpath));
    // Check for a sidecar .cue file — long single-file rips from CDMs/disc images
    // always have one and are intentionally stored as one track with cue markers.
    const hasCue = _hasSidecarCue(absPath);
    const hint = hasCue
      ? ' (cue sheet found — multi-track disc image, single BPM meaningless)'
      : '';
    parentPort.postMessage({
      type: 'error',
      file: row.filepath,
      message: `Skipped: duration ${Math.round(durationSec / 60)} min exceeds ${MAX_DURATION_SEC / 60} min WASM limit${hint}`,
    });
    return;
  }

  const timeoutMs = Math.max(MIN_TIMEOUT_MS, durationSec * TIMEOUT_PER_AUDIO_SEC);

  try {
    let pcm = await decodeAudioPcm(absPath, timeoutMs);

    // Secondary PCM size guard: high-bitrate or long sources can produce buffers
    // that exceed the WASM heap limit (256 MB fixed Emscripten limit).
    // Retry at half sample rate (11025 Hz) before giving up — BPM detection is
    // still accurate at 11025 Hz since rhythm information lives in low frequencies
    // well below the 5512 Hz Nyquist.  This allows long 12" mixes (10-20 min) and
    // high-bitrate FLACs to be analysed where they were previously rejected.
    if (pcm.byteLength > MAX_PCM_BYTES) {
      pcm = await decodeAudioPcm(absPath, timeoutMs, Math.floor(SAMPLE_RATE / 2));
    }

    // If still too large after halving the sample rate, the file is genuinely too
    // big for the WASM heap — mark as error and move on.
    if (pcm.byteLength > MAX_PCM_BYTES) {
      await dbWriteWithRetry(() => _setError.run(row.filepath, row.vpath));
      parentPort.postMessage({
        type: 'error',
        file: row.filepath,
        message: `Skipped: decoded PCM ${Math.round(pcm.byteLength / 1024 / 1024)} MB exceeds ${MAX_PCM_BYTES / 1024 / 1024} MB WASM limit even at half sample rate`,
      });
      return;
    }

    const { bpm, key } = analyseWithEssentia(pcm);

    await dbWriteWithRetry(() => _setDone.run(bpm, key, row.filepath, row.vpath));
    _processedCount++;

  } catch (err) {
    // If the WASM aborted, reset the essentia instance — it's in an undefined state.
    const msg = err?.message || String(err) || 'unknown error';
    if (msg.includes('abort')) resetEssentia();
    await dbWriteWithRetry(() => _setError.run(row.filepath, row.vpath));
    parentPort.postMessage({ type: 'error', file: row.filepath, message: msg });
  }
}

async function runLoop() {
  // Initialise Essentia once before starting
  try {
    getEssentia();
  } catch (err) {
    parentPort.postMessage({ type: 'stopped', error: `Failed to load Essentia WASM: ${err.message}` });
    process.exit(1);
  }

  // Reset any rows left in 'pending' state from a previous interrupted run
  try { _resetPending.run(); } catch (e) { console.debug('[velvet]', e?.message ?? e); }

  parentPort.postMessage({ type: 'ready', stats: _getStats.get() });

  while (!_stopping) {
    const batch = _getQueue.all(BATCH_SIZE);

    if (batch.length === 0) {
      parentPort.postMessage({ type: 'idle', stats: _getStats.get() });
      await sleep(IDLE_WAIT_MS);
      continue;
    }

    for (const row of batch) {
      if (_stopping) break;

      try { _setPending.run(row.filepath, row.vpath); } catch (e) { console.debug('[velvet]', e?.message ?? e); }

      await processFile(row);

      parentPort.postMessage({
        type:           'progress',
        currentFile:    `${row.vpath}/${row.filepath}`,
        processedCount: _processedCount,
        stats:          _getStats.get(),
      });

      if (!_stopping) await sleep(INTER_FILE_MS);
    }
  }

  parentPort.postMessage({ type: 'stopped', processedCount: _processedCount, stats: _getStats.get() });
}

// ── Message handling ──────────────────────────────────────────────────────────

parentPort.on('message', msg => {
  if (msg === 'stop' || msg?.type === 'stop') {
    _stopping = true;
  }
});

// ── Boot ─────────────────────────────────────────────────────────────────────

await runLoop().catch(err => {
  parentPort.postMessage({ type: 'stopped', error: err.message });
  process.exit(1);
});
