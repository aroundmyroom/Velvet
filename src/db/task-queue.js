import child from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import winston from 'winston';
import { nanoid } from 'nanoid';
import jwt from 'jsonwebtoken';
import * as config from '../state/config.js';
import { getDirname } from '../util/esm-helpers.js';
import * as db from '../db/manager.js';
import * as scanProgress from '../state/scan-progress.js';
import { ffprobeBin } from '../util/ffmpeg-bootstrap.js';
import { scanStarted, scanEnded } from '../state/scan-lock.js';

const __dirname = getDirname(import.meta.url);

// ── Scan resume checkpoint ────────────────────────────────────────────────────
// When a scan is interrupted (server restart, crash), a checkpoint file
// preserves the scanId and the set of fully-completed directories. On the
// next scan for the same vpath, the same scanId is reused so files already
// confirmed in the interrupted run are recognized by sID===scanId and skipped,
// and completed directories are bypassed entirely in the filesystem walk.
const SCAN_STATE_DIR = path.join(__dirname, '../../save/scan-state');
const RESUME_MAX_AGE_MS = 48 * 60 * 60 * 1000; // 48 h

// ── Scheduled-scan once-per-calendar-day guard ───────────────────────────────
// Persisted so the rule survives server restarts: if the daily scan already
// fired today, neither a restart nor a resetScanInterval() call can fire it
// again until midnight rolls over.
const SCHEDULED_DATE_FILE = path.join(SCAN_STATE_DIR, 'scheduled-fired-date.txt');

function _todayDateStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function _readScheduledFiredDate() {
  try { return fs.readFileSync(SCHEDULED_DATE_FILE, 'utf8').trim() || null; } catch { return null; }
}

function _writeScheduledFiredDate(dateStr) {
  try {
    if (!fs.existsSync(SCAN_STATE_DIR)) fs.mkdirSync(SCAN_STATE_DIR, { recursive: true });
    fs.writeFileSync(SCHEDULED_DATE_FILE, dateStr, 'utf8');
  } catch (e) { console.debug('[velvet]', e?.message ?? e); }
}

// Initialised on module load; kept in-sync by the scheduler callbacks.
let _lastScheduledScanDate = _readScheduledFiredDate();

/**
 * Called by the scheduled-scan timeout. Fires scanAll() only once per
 * calendar day. Records today's date both in memory and on disk so that
 * a server restart later in the day cannot re-trigger the scan.
 */
function _fireScheduledScan() {
  const today = _todayDateStr();
  if (_lastScheduledScanDate === today) {
    winston.info('[scheduler] Scheduled scan already fired today — skipping until tomorrow 15:00');
    return;
  }
  _lastScheduledScanDate = today;
  _writeScheduledFiredDate(today);
  if (runningTasks.size === 0) {
    scanAll();
  }
}

function _getScanStatePath(vpath) {
  const safe = vpath.replaceAll(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(SCAN_STATE_DIR, `${safe}.json`);
}

function _readScanState(vpath) {
  try {
    const p = _getScanStatePath(vpath);
    if (!fs.existsSync(p)) return null;
    const s = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!s.scanId || !s.startedAt || (Date.now() - s.startedAt) > RESUME_MAX_AGE_MS) {
      try { fs.unlinkSync(p); } catch { /* already gone */ }
      return null;
    }
    return s; // { scanId, startedAt, completedDirs: string[] }
  } catch { return null; }
}

function _writeScanState(vpath, scanId) {
  try {
    if (!fs.existsSync(SCAN_STATE_DIR)) fs.mkdirSync(SCAN_STATE_DIR, { recursive: true });
    const p = _getScanStatePath(vpath);
    // Preserve completedDirs if the file already exists (scanner writes those)
    let completedDirs = [];
    try { completedDirs = JSON.parse(fs.readFileSync(p, 'utf8')).completedDirs || []; } catch { /* no existing checkpoint */ }
    fs.writeFileSync(p, JSON.stringify({ scanId, startedAt: Date.now(), completedDirs }));
  } catch (e) { console.debug('[velvet]', e?.message ?? e); }
}

export function deleteScanState(vpath) {
  const p = _getScanStatePath(vpath);
  if (!fs.existsSync(p)) return;
  try {
    fs.unlinkSync(p);
    winston.debug(`[scanner] Scan checkpoint removed for "${vpath}"`);
  } catch { /* file already gone */ }
}

export function getScanStatePath(vpath) {
  return _getScanStatePath(vpath);
}

/** Returns vpaths that have a valid (non-expired) scan checkpoint file. */
export function getResumableVpaths() {
  const result = [];
  for (const vpath of Object.keys(config.program.folders)) {
    if (_readScanState(vpath)) result.push(vpath);
  }
  return result;
}

/** Clears scan checkpoint files for all configured vpaths (fresh-start helper). */
export function clearAllScanStates() {
  winston.info('[scanner] Clearing all scan checkpoints (admin request)');
  for (const vpath of Object.keys(config.program.folders)) {
    deleteScanState(vpath);
  }
}

const taskQueue = [];
const runningTasks = new Set();
const vpathLimiter = new Set();
const currentScanDirs = new Map(); // vpath → { dir: string, root: string }
let scanIntervalTimer = null; // This gets set after the server boots
let _nextScanAt = null; // epoch ms of next scheduled scan (for countdown)

/**
 * Parse "HH:MM" into { h, m }. Returns null if invalid.
 */
function _parseStartTime(str) {
  if (!str) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(str.trim());
  if (!m) return null;
  const h = Number.parseInt(m[1], 10);
  const min = Number.parseInt(m[2], 10);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return { h, min };
}

/**
 * Return the next Date object representing the upcoming HH:MM.
 * If that time has already passed today, returns tomorrow's occurrence.
 */
function _nextOccurrence(h, min) {
  const now = new Date();
  const candidate = new Date(now);
  candidate.setHours(h, min, 0, 0);
  if (candidate <= now) {
    candidate.setDate(candidate.getDate() + 1);
  }
  return candidate;
}

/** Exposed for the API countdown endpoint */
export function getNextScanMs() { return _nextScanAt; }

function _startClockAlignedScan(parsed) {
  const scheduleNext = () => {
    const next = _nextOccurrence(parsed.h, parsed.min);
    _nextScanAt = next.getTime();
    const delay = _nextScanAt - Date.now();
    scanIntervalTimer = setTimeout(() => {
      _nextScanAt = null;
      _fireScheduledScan();
      scheduleNext();
    }, delay);
  };
  scheduleNext();
}

function addScanTask(vpath) {
  // Skip if this vpath is already running or already waiting in the queue
  if (vpathLimiter.has(vpath) || taskQueue.some(t => t.vpath === vpath)) return;
  const scanObj = { task: 'scan', vpath: vpath, id: nanoid(8) };
  if (runningTasks.size < config.program.scanOptions.maxConcurrentTasks) {
    runScan(scanObj);
  } else {
    taskQueue.push(scanObj);
  }
}

// Returns true if vpathB's root is a subdirectory of vpathA's root.
function isChildOf(vpathA, vpathB) {
  const a = config.program.folders[vpathA].root.replace(/\/?$/, '/');
  const b = config.program.folders[vpathB].root.replace(/\/?$/, '/');
  return b.startsWith(a) && a !== b;
}

function _normalizedRoot(folders, vpath) {
  return (folders[vpath]?.root || '').replace(/\/?$/, '/');
}

function _detectParentVpath(vpath, folders = config.program.folders) {
  const myRoot = _normalizedRoot(folders, vpath);
  if (!myRoot) return null;

  let parent = null;
  let parentLen = -1;
  for (const other of Object.keys(folders)) {
    if (other === vpath) continue;
    const otherRoot = _normalizedRoot(folders, other);
    if (!otherRoot) continue;
    if (!myRoot.startsWith(otherRoot) || myRoot === otherRoot) continue;
    if (otherRoot.length > parentLen) {
      parent = other;
      parentLen = otherRoot.length;
    }
  }
  return parent;
}

export function getScanHierarchy(folders = config.program.folders) {
  const all = Object.keys(folders);
  const roots = [];
  const parents = {};
  const childrenByParent = {};

  for (const vpath of all) {
    const parent = _detectParentVpath(vpath, folders);
    parents[vpath] = parent;
    if (parent) {
      if (!childrenByParent[parent]) childrenByParent[parent] = [];
      childrenByParent[parent].push(vpath);
    } else {
      roots.push(vpath);
    }
  }

  return { roots, parents, childrenByParent };
}

// Vpaths whose root sits inside another vpath's root — they need no separate
// scan because the parent will cover them once otherRoots no longer skips them.
function childVpaths() {
  const { roots } = getScanHierarchy(config.program.folders);
  const rootSet = new Set(roots);
  return new Set(Object.keys(config.program.folders).filter(v => !rootSet.has(v)));
}

function scanAll() {
  const children = childVpaths();
  Object.keys(config.program.folders).forEach((vpath) => {
    if (config.program.folders[vpath]?.type === 'recordings') { return; } // recordings folders are never scanned
    if (config.program.folders[vpath]?.type === 'excluded') { return; } // excluded folders are never scanned
    if (!children.has(vpath)) { addScanTask(vpath); }
  });
}

function nextTask() {
  if (
    taskQueue.length > 0
    && runningTasks.size < config.program.scanOptions.maxConcurrentTasks
    && !vpathLimiter.has(taskQueue.at(-1).vpath))
  {
    runScan(taskQueue.pop());
  }
}

function runScan(scanObj) {
  // ── Resume checkpoint ─────────────────────────────────────────────────────
  const existingState = _readScanState(scanObj.vpath);
  const isResume = existingState !== null;
  const scanId = isResume ? existingState.scanId : scanObj.id;
  const completedDirs = isResume ? (existingState.completedDirs || []) : [];

  if (isResume) {
    winston.info(`[scanner] Resuming interrupted scan for "${scanObj.vpath}" — scanId: ${scanId}, ${completedDirs.length} dir(s) already completed, skipping those`);
  } else {
    // Fresh scan: null all existing sIDs for this vpath so that any file not
    // reached by this scan stays NULL and gets correctly pruned at finish-scan.
    // This prevents partial scans from silently pruning files they didn't reach.
    db.clearScanIds(scanObj.vpath);
    winston.info(`[scanner] Fresh scan for "${scanObj.vpath}" — cleared all sIDs, scanId: ${scanId}`);
  }

  // Write / refresh the checkpoint so the scanner child can update completedDirs
  _writeScanState(scanObj.vpath, scanId);

  const jsonLoad = {
    directory: config.program.folders[scanObj.vpath].root,
    vpath: scanObj.vpath,
    port: config.program.port,
    token: jwt.sign({ scan: true }, config.program.secret),
    albumArtDirectory: config.program.storage.albumArtDirectory,
    skipImg: config.program.scanOptions.skipImg,
    pause: config.program.scanOptions.pause,
    supportedFiles: config.program.supportedAudioFiles,
    scanId: scanId,           // ← may be resumed from checkpoint
    isHttps: config.getIsHttps(),
    compressImage: config.program.scanOptions.compressImage,
    otherRoots: Object.keys(config.program.folders)
      .filter(v => v !== scanObj.vpath && !isChildOf(scanObj.vpath, v))
      .map(v => config.program.folders[v].root),
    excludedPaths: Object.keys(config.program.folders)
      .filter(v => v !== scanObj.vpath && isChildOf(scanObj.vpath, v) && config.program.folders[v].type === 'excluded')
      .map(v => config.program.folders[v].root),
    ffprobePath: fs.existsSync(ffprobeBin()) ? ffprobeBin() : null,
    // Resume state: path to checkpoint file — scanner reads completedDirs from it directly
    // (avoids E2BIG when completedDirs is large — do NOT pass it as a CLI arg)
    scanStateFile: _getScanStatePath(scanObj.vpath),
    isResume,
    ...(Array.isArray(config.program.albumVersionTags) ? { albumVersionTags: config.program.albumVersionTags } : {}),
  };

  const baseline = db.countFilesByVpath(scanObj.vpath) || 0;
  jsonLoad.hasBaseline = baseline > 0;
  // On resume: pre-seed the scanned counter with files already stamped with this scanId
  const resumeOffset = isResume ? (db.countFilesByScanId(scanObj.vpath, scanId) || 0) : 0;
  scanProgress.startScan(scanId, scanObj.vpath, baseline > 0 ? baseline : null, resumeOffset); // ← use scanId (may be resumed)
  scanStarted(); // pause background DB writers while this scan runs

  const forkedScan = child.fork(path.join(__dirname, './scanner.mjs'), [JSON.stringify(jsonLoad)], { silent: true });
  winston.info(`File scan started on ${jsonLoad.directory}`);
  runningTasks.add(forkedScan);
  vpathLimiter.add(scanObj.vpath);

  forkedScan.on('message', (msg) => {
    if (msg?.dir) currentScanDirs.set(scanObj.vpath, { dir: msg.dir, root: jsonLoad.directory });
  });

  forkedScan.stdout.on('data', (data) => {
    winston.info(`File scan message: ${data}`);
  });

  forkedScan.stderr.on('data', (data) => {
    winston.error(`File scan error: ${data}`);
  });

  forkedScan.on('close', (code) => {
    winston.info(`File scan completed with code ${code}`);
    // Delete checkpoint on clean exit — prevents spurious resume on next scan
    if (code === 0) deleteScanState(scanObj.vpath);
    scanProgress.finish(scanObj.id);
    db.clearAaFileForDirCache();
    runningTasks.delete(forkedScan);
    vpathLimiter.delete(scanObj.vpath);
    currentScanDirs.delete(scanObj.vpath);
    scanEnded(); // allow background DB writers to resume
    nextTask();
    // When the last vpath finishes, clean up orphaned art and waveform files
    if (runningTasks.size === 0 && taskQueue.length === 0) {
      setImmediate(runOrphanCleanup);
    }
  });
}

async function runOrphanCleanup() {
  try {
    const artDir      = config.program.storage.albumArtDirectory;
    const waveformDir = config.program.storage.waveformDirectory;

    // Collect all live references from the DB
    const liveArt    = new Set(db.getLiveArtFilenames());   // aaFile values
    const liveHashes = new Set(db.getLiveHashes());         // hash values

    const COMPRESSED_RE = /^z[^-]+-(.+)$/;

    let deleted = 0;

    // --- Album art orphan cleanup ---
    if (artDir && fs.existsSync(artDir)) {
      for (const ent of fs.readdirSync(artDir, { withFileTypes: true })) {
        if (!ent.isFile()) continue; // skip subdirs (e.g. artists/) — EISDIR fix
        const file     = ent.name;
        if (file === 'README.md') continue;
        const m        = file.match(COMPRESSED_RE);
        const baseName = m ? m[1] : file;
        if (!liveArt.has(baseName)) {
          try { fs.unlinkSync(path.join(artDir, file)); deleted++; } catch (e) { console.debug('[velvet]', e?.message ?? e); }
        }
      }
    }

    // --- Waveform orphan cleanup ---
    const WAVEFORM_RE = /^wf-(.+)\.json$/;
    if (waveformDir && fs.existsSync(waveformDir)) {
      for (const file of fs.readdirSync(waveformDir)) {
        const wfMatch = file.match(WAVEFORM_RE);
        if (!wfMatch) continue;
        if (!liveHashes.has(wfMatch[1])) {
          try { fs.unlinkSync(path.join(waveformDir, file)); deleted++; } catch (e) { console.debug('[velvet]', e?.message ?? e); }
        }
      }
    }

    if (deleted > 0) winston.info(`Post-scan cleanup: removed ${deleted} orphaned file(s) from cache`);
  } catch (err) {
    winston.warn(`Post-scan orphan cleanup failed: ${err.message}`);
  }
}

export function scanVPath(vPath) {
  if (config.program.folders[vPath]?.type === 'recordings') { return; } // recordings folders are never scanned
  addScanTask(vPath);
}

export { scanAll, isChildOf };

export function isScanning() {
  return runningTasks.size > 0;
}

export function getAdminStats() {
  return {
    taskQueue,
    vpaths: [...vpathLimiter]
  };
}

export function getScanningVpaths() {
  return [...vpathLimiter].map(vpath => {
    const info = currentScanDirs.get(vpath);
    let dir = null;
    if (info) {
      const rel = info.dir.startsWith(info.root)
        ? info.dir.slice(info.root.length).replace(/^\//, '')
        : info.dir;
      dir = rel || null;
    }
    return { vpath, dir };
  });
}

export function runAfterBoot() {
  setTimeout(() => {
    // Guard: only set up once
    if (scanIntervalTimer !== null) return;
    if (config.program.scanOptions.scanInterval <= 0) return;

    const parsed = _parseStartTime(config.program.scanOptions.scanStartTime);

    if (parsed) {
      // ── Clock-aligned daily mode ────────────────────────────────────────
      _startClockAlignedScan(parsed);
    } else {
      // ── Legacy interval mode ────────────────────────────────────────────
      const intervalMs = config.program.scanOptions.scanInterval * 60 * 60 * 1000;

      // Run on boot if explicitly enabled OR last scan was more than one interval ago
      const lastScan = db.getLastScannedMs();
      const overdue  = lastScan == null || (Date.now() - lastScan) >= intervalMs;
      if (config.program.scanOptions.bootScanEnabled === true || overdue) {
        scanAll();
      }

      _nextScanAt = Date.now() + intervalMs;
      scanIntervalTimer = setInterval(() => {
        _nextScanAt = Date.now() + intervalMs;
        scanAll();
      }, intervalMs);
    }
  }, config.program.scanOptions.bootScanDelay * 1000);
}

export function stopScanning() {
  for (const task of runningTasks) {
    task.kill();
  }
  runningTasks.clear();
  vpathLimiter.clear();
  taskQueue.length = 0;
  currentScanDirs.clear();
}

export function reset() {
  for (const task of runningTasks) {
    task.kill();
  }
  runningTasks.clear();
  vpathLimiter.clear();
  taskQueue.length = 0;
  if (scanIntervalTimer) { clearInterval(scanIntervalTimer); clearTimeout(scanIntervalTimer); }
  scanIntervalTimer = null;
  _nextScanAt = null;
}

export function resetScanInterval() {
  if (scanIntervalTimer) { clearInterval(scanIntervalTimer); clearTimeout(scanIntervalTimer); }
  scanIntervalTimer = null;
  _nextScanAt = null;

  if (config.program.scanOptions.scanInterval <= 0) return;

  const parsed = _parseStartTime(config.program.scanOptions.scanStartTime);
  if (parsed) {
    _startClockAlignedScan(parsed);
  } else {
    const intervalMs = config.program.scanOptions.scanInterval * 60 * 60 * 1000;
    _nextScanAt = Date.now() + intervalMs;
    scanIntervalTimer = setInterval(() => {
      _nextScanAt = Date.now() + intervalMs;
      scanAll();
    }, intervalMs);
  }
}
