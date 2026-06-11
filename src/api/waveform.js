import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import * as config from '../state/config.js';
import { ffmpegBin } from '../util/ffmpeg-bootstrap.js';
import * as db from '../db/manager.js';
import { getVPathInfo } from '../util/vpath.js';
import WebError from '../util/web-error.js';
import { resolvePathWithinRoot } from '../util/path-security.js';

// Number of waveform points returned to the client.
const POINTS = 600;

// PCM sample rate fed to ffmpeg.
// 4000 Hz is sufficient for waveform visualisation — each of the 600 display
// bars covers ~2400 raw samples on a 10-minute track (RMS naturally smooth).
// Halved from 8000 Hz: ~2× faster ffmpeg decode for the same visual quality.
const SAMPLE_RATE = 4000;

// ── WAVEFORM GENERATION QUEUE ──────────────────────────────────────────────
// Serialises ffmpeg spawns to at most _WF_MAX_CONCURRENT at a time.
// Live requests (priority=1) are sorted ahead of background prefetch (priority=0).
// In-flight dedup: if the same cacheHash is already generating, all callers
// share the same Promise — no duplicate ffmpeg processes for the same file.
const _WF_MAX_CONCURRENT = 2;  // 1 live + 1 prefetch can overlap; avoids stalling
const _wfInFlight = new Map(); // cacheHash → { promise, priority }
const _wfQueue    = [];        // { cacheHash, fullPath, cachePath, priority, resolve, reject }
let   _wfRunning  = 0;

function _wfDequeue() {
  if (_wfRunning >= _WF_MAX_CONCURRENT || _wfQueue.length === 0) return;
  _wfQueue.sort((a, b) => b.priority - a.priority); // high priority first
  const job = _wfQueue.shift();
  _wfRunning++;
  _wfRunJob(job).finally(() => {
    _wfRunning--;
    _wfInFlight.delete(job.cacheHash);
    _wfDequeue();
  });
}

async function _wfRunJob(job) {
  try {
    const chunks = [];
    await new Promise((resolve, reject) => {
      const proc = spawn(ffmpegBin(), [
        '-i', job.fullPath,
        '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE),
        '-f', 'f32le', '-'
      ], { stdio: ['ignore', 'pipe', 'ignore'] });
      // Kill ffmpeg if client disconnected before we could deliver the result
      job.killProc = () => { try { proc.kill('SIGKILL'); } catch (e) { console.debug('[velvet]', e?.message ?? e); } };
      proc.on('error', reject);
      proc.stdout.on('data', chunk => chunks.push(chunk));
      proc.stdout.on('end',  resolve);
      proc.stdout.on('error', reject);
    });
    const buf      = Buffer.concat(chunks);
    const f32      = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
    const waveform = downsample(f32, POINTS);
    if (job.cachePath) {
      try { fs.writeFileSync(job.cachePath, JSON.stringify(waveform)); } catch (e) { console.debug('[velvet]', e?.message ?? e); }
    }
    job.resolve(waveform);
  } catch (err) {
    job.reject(err);
  }
}

function _wfGenerate(cacheHash, fullPath, cachePath, priority = 0) {
  if (_wfInFlight.has(cacheHash)) {
    const entry = _wfInFlight.get(cacheHash);
    // Upgrade priority in-queue if a live caller joins after a prefetch queued it
    if (priority > entry.priority) {
      entry.priority = priority;
      const qe = _wfQueue.find(j => j.cacheHash === cacheHash);
      if (qe) qe.priority = priority;
    }
    return entry.promise;
  }
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  _wfInFlight.set(cacheHash, { promise, priority });
  _wfQueue.push({ cacheHash, fullPath, cachePath, priority, resolve, reject });
  _wfDequeue();
  return promise;
}

/**
 * Downsample a Float32Array of PCM amplitudes into `count` points,
 * normalised to 0–255.
 *
 * Approach: RMS per chunk, p99 ceiling, sqrt (γ=0.5) curve — no smoothing pass.
 *
 * At 8000 Hz sample rate each of the 1400 display bars covers ~2400 raw
 * samples (for a 7-minute track).  RMS over ~2400 samples naturally averages
 * into a smooth energy envelope — no extra smoothing is needed or applied.
 * This is the same principle used by SoundCloud / Beatport waveform generators.
 *
 * Loudness curve: γ=0.7 (mild compression — more dynamic range than sqrt).
 *   — Linear (γ=1.0): quiet intro at 2% → 2% bar (invisible)
 *   — sqrt  (γ=0.5): 2% → 14% bar, but loud 40–100% collapses to 63–100% (37% spread, flat)
 *   — γ=0.7:         2% →  8% bar; loud 40–100% maps to 53–100% (47% spread,
 *     individual kick/hi-hat/drop all clearly distinct; quiet breaks low but visible).
 */
function downsample(data, count) {
  const total = data.length;
  if (total === 0) return new Array(count).fill(0);
  const result = new Array(count);
  const chunkSize = total / count;

  // RMS per chunk — robust energy estimate, naturally smooth at high sample rate
  for (let i = 0; i < count; i++) {
    const start = Math.floor(i * chunkSize);
    const end   = Math.min(total, Math.floor((i + 1) * chunkSize));
    let sum = 0;
    for (let j = start; j < end; j++) sum += data[j] * data[j];
    result[i] = end > start ? Math.sqrt(sum / (end - start)) : 0;
  }

  // p99 ceiling — one brief transient won't compress the whole track
  const sorted = [...result].sort((a, b) => a - b);
  const p99   = sorted[Math.floor(sorted.length * 0.99)] || sorted.at(-1);
  const scale = Math.max(p99, 1e-6);

  // Gate at 0.1% of p99 — kills only true digital silence / DC offset
  const GATE  = scale * 0.001;
  const GAMMA = 0.7;

  return result.map(v => {
    if (v <= GATE) return 0;
    const norm = Math.min(1, v / scale);
    return Math.round(Math.pow(norm, GAMMA) * 255);
  });
}

export function setup(velvet) {
  velvet.get('/api/v1/db/waveform', async (req, res) => {
    if (!req.query.filepath) throw new WebError('Missing filepath', 400);

    let pathInfo;
    try {
      pathInfo = getVPathInfo(req.query.filepath, req.user);
    } catch {
      throw new WebError('Access denied or file not found', 403);
    }

    const fileRow = _findFileRow(pathInfo);

    if (!fileRow && !fs.existsSync(pathInfo.fullPath)) {
      throw new WebError('File not found', 404);
    }

    const cacheDir  = config.program.storage.waveformDirectory;
    const cacheHash = fileRow?.hash ?? crypto.createHash('sha256').update(pathInfo.fullPath).digest('hex');
    const cacheKey  = `wf-${cacheHash}.json`;
    const cachePath = resolvePathWithinRoot(cacheDir, cacheKey);

    if (cachePath && fs.existsSync(cachePath)) {
      try {
        const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
        return res.json({ waveform: cached });
      } catch (e) { console.debug('[velvet]', e?.message ?? e); }
    }

    if (!fs.existsSync(ffmpegBin())) {
      throw new WebError('FFmpeg not available — enable transcoding in config to use the waveform scrubber', 503);
    }

    const priority = req.query.prefetch === '1' ? 0 : 1;
    const waveform = await _generateWithDisconnect(req, cacheHash, pathInfo.fullPath, cachePath, priority);
    if (!res.writableEnded) res.json({ waveform });
  });
}

function _findFileRow(pathInfo) {
  const row = db.findFileByPath(pathInfo.relativePath, pathInfo.vpath);
  if (row) return row;
  const allFolders = config.program.folders || {};
  for (const [fvpath, folder] of Object.entries(allFolders)) {
    if (fvpath === pathInfo.vpath) continue;
    const normRoot = folder.root.endsWith(path.sep) ? folder.root : folder.root + path.sep;
    if (pathInfo.fullPath.startsWith(normRoot)) {
      const found = db.findFileByPath(path.relative(folder.root, pathInfo.fullPath), fvpath);
      if (found) return found;
    }
  }
  return null;
}

function _generateWithDisconnect(req, cacheHash, fullPath, cachePath, priority) {
  return new Promise((resolve, reject) => {
    _wfGenerate(cacheHash, fullPath, cachePath, priority).then(resolve).catch(reject);
    req.on('close', () => {
      const job = _wfQueue.find(j => j.cacheHash === cacheHash);
      if (job?.killProc) job.killProc();
      const err = new Error('client disconnected');
      err.code = 'CLIENT_DISCONNECTED';
      reject(err);
    });
  });
}
