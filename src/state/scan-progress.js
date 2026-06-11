// In-memory scan progress tracker — resets on server restart.
// Keyed by scanId (nanoid(8) assigned to each scan run).
const _scans = new Map();

/**
 * Called when a scan begins.
 * @param {string} scanId
 * @param {string} vpath
 * @param {number|null} expected  - file count from DB before scan (null = first scan)
 * @param {number} [resumeOffset=0]  - files already processed in a prior interrupted run (pre-seeds scanned)
 */
export function startScan(scanId, vpath, expected, resumeOffset = 0) {
  _scans.set(scanId, {
    scanId,
    vpath,
    expected,           // null means no baseline (first scan)
    scanned: resumeOffset,  // pre-seed with already-done files so % is correct on resume
    added: 0,           // files actually inserted into the DB
    countingFound: 0,   // grows during pre-count walk (first scans only)
    currentFile: null,
    startedAt: Date.now(),
    _rateBase: resumeOffset,  // rate window starts from the resume point
    _rateTs: Date.now(),
    filesPerSec: null,
  });
}

/**
 * Called by the get-file endpoint for each file processed.
 * @param {string} scanId
 * @param {string} filepath
 */
export function tick(scanId, filepath) {
  const s = _scans.get(scanId);
  if (!s) return;
  s.scanned++;
  s.currentFile = filepath;
  // Recalculate rate every 5 seconds
  const elapsed = Date.now() - s._rateTs;
  if (elapsed >= 5000) {
    s.filesPerSec = (s.scanned - s._rateBase) / (elapsed / 1000);
    s._rateBase = s.scanned;
    s._rateTs = Date.now();
  }
}

/**
 * Called when a new file is inserted into the DB.
 * @param {string} scanId
 */
export function tickInsert(scanId) {
  const s = _scans.get(scanId);
  if (!s) return;
  s.added++;
}

/**
 * Update the expected file count after a pre-count pass.
 * @param {string} scanId
 * @param {number} expected
 */
export function setExpected(scanId, expected) {
  const s = _scans.get(scanId);
  if (!s) return;
  s.expected = expected;
}

/**
 * Update the in-progress counting total during the pre-count walk.
 * Called every 5 000 files so the UI shows activity rather than a blank bar.
 * @param {string} scanId
 * @param {number} found
 */
export function updateCountingFound(scanId, found) {
  const s = _scans.get(scanId);
  if (!s) return;
  s.countingFound = found;
}

/**
 * Remove scan from in-memory tracker.
 * @param {string} scanId
 */
export function finish(scanId) {
  _scans.delete(scanId);
}

/**
 * Returns a snapshot of all active scans suitable for the API response.
 */
export function getAll() {
  const now = Date.now();
  return [..._scans.values()].map(s => {
    let pct = null;
    if (s.expected && s.expected > 0) {
      // Cap at 99 while scan is still running — 100 only shows after finish-scan.
      // This prevents false "100%" when DB estimate is lower than actual file count
      // (e.g. a previously interrupted scan where DB=20K but disk=138K).
      pct = Math.min(99, Math.round((s.scanned / s.expected) * 100));
    }
    const elapsedSec = Math.round((now - s.startedAt) / 1000);
    let etaSec = null;
    if (pct !== null && pct > 0 && pct < 100 && s.filesPerSec > 0) {
      etaSec = Math.round((s.expected - s.scanned) / s.filesPerSec);
    }
    return {
      scanId: s.scanId,
      vpath: s.vpath,
      scanned: s.scanned,
      added: s.added,
      expected: s.expected,
      countingFound: s.countingFound || 0,
      pct,
      currentFile: s.currentFile,
      elapsedSec,
      filesPerSec: s.filesPerSec == null ? null : Math.round(s.filesPerSec * 10) / 10,
      etaSec,
    };
  });
}
