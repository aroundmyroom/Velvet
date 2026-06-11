import path from 'node:path';
import fs from 'node:fs';
import * as db from '../db/manager.js';
import * as config from '../state/config.js';
import * as scanProgress from '../state/scan-progress.js';
import * as dlnaApi from './dlna.js';
import * as taskQueue from '../db/task-queue.js';
import { resolveChildPath, resolvePathWithinRoot } from '../util/path-security.js';

// Returns true when the directory cover image has been replaced since it was
// last scanned. Two cases:
//   1. The stored cover_file no longer exists — user renamed or replaced it
//   2. The stored cover_file still exists but its mtime is newer than last scan
// Per-scan cache for _dirHasNewArt — avoids repeated readdirSync calls when
// many tracks share the same album directory. Reset whenever a new scanId is
// observed so a fresh scan re-reads the filesystem.
let _newArtCacheScanId = null;
const _newArtCache = new Map();
const _NAMED_ART_FILES = new Set([
  'folder.jpg', 'folder.jpeg', 'folder.png',
  'cover.jpg',  'cover.jpeg',  'cover.png',
  'album.jpg',  'album.jpeg',  'album.png',
  'front.jpg',  'front.jpeg',  'front.png',
]);

// Returns true if the given directory now contains a cover image. Used to
// detect the case where a folder previously had no art (DB sentinel
// `aaFile === ''`) but the user has since dropped a cover.jpg / folder.jpg
// into it. Matches the filename set checked by scanner.mjs's
// checkDirectoryForAlbumArt(): named cover files first, then any .jpg/.png.
function _dirHasNewArt(audioDir, scanId) {
  if (scanId !== _newArtCacheScanId) {
    _newArtCache.clear();
    _newArtCacheScanId = scanId;
  }
  if (_newArtCache.has(audioDir)) return _newArtCache.get(audioDir);
  let result = false;
  try {
    const files = fs.readdirSync(audioDir);
    for (const f of files) {
      if (_NAMED_ART_FILES.has(f.toLowerCase())) { result = true; break; }
    }
    if (!result) {
      for (const f of files) {
        const ext = path.extname(f).toLowerCase();
        if (ext === '.jpg' || ext === '.jpeg' || ext === '.png') {
          // Confirm it's a regular file before counting it
          try {
            if (fs.statSync(resolvePathWithinRoot(audioDir, f)).isFile()) { result = true; break; }
          } catch { /* ignore */ }
        }
      }
    }
  } catch { result = false; }
  _newArtCache.set(audioDir, result);
  return result;
}

function _dirCoverChanged(dbFileInfo, vpathRoot) {
  try {
    if (dbFileInfo.art_source !== 'directory') return false;
    const audioDir = resolvePathWithinRoot(vpathRoot, path.dirname(dbFileInfo.filepath));

    // Case 1: stored cover_file is gone — art was likely replaced with a new file
    if (dbFileInfo.cover_file) {
      const oldCoverPath = resolveChildPath(audioDir, dbFileInfo.cover_file);
      if (!fs.existsSync(oldCoverPath)) return true;
      // Case 2: cover_file still exists but was modified after last audio scan
      const coverMtimeMs = fs.statSync(oldCoverPath).mtimeMs;
      if (coverMtimeMs > (dbFileInfo.modified || 0)) return true;
    }
    return false;
  } catch { return false; }
}

// Compute albumsOnly filepath prefixes for a given root vpath.
// Returns null if the vpath itself is albumsOnly (all files apply),
// [] if no children are albumsOnly (skip album_version entirely),
// or an array of relative prefixes like ['Disco/', 'Albums/'] to check.
// album_version is only meaningful for files that belong to an Albums Library source.
function _albumOnlyPrefixes(vpathName) {
  const vpathCfg = config.program.folders[vpathName];
  if (!vpathCfg) return [];
  if (vpathCfg.albumsOnly) return null; // vpath itself is albumsOnly — all files apply
  const vpathRoot = vpathCfg.root;
  const prefixes = [];
  for (const [, cfg] of Object.entries(config.program.folders)) {
    if (!cfg.albumsOnly) continue;
    if (!cfg.root.startsWith(vpathRoot + '/')) continue;
    const rel = path.relative(vpathRoot, cfg.root).replaceAll('\\', '/');
    prefixes.push(rel + '/');
  }
  return prefixes;
}

export function setup(velvet) {
  velvet.all('/api/v1/scanner/{*path}', (req, res, next) => {
    if (req.scanApproved !== true) { return res.status(403).json({ error: 'Access Denied' }); }
    next();
  });

  velvet.post('/api/v1/scanner/get-file', (req, res) => {
    if (req.body.scanId) { scanProgress.tick(req.body.scanId, req.body.filepath); }
    const dbFileInfo = db.findFileByPath(req.body.filepath, req.body.vpath);

    if (!dbFileInfo) return res.json({});

    if (req.body.modTime !== dbFileInfo.modified) {
      db.removeFileByPath(req.body.filepath, req.body.vpath);
      return res.json({ ..._makeStaleResult(dbFileInfo), _oldHash: dbFileInfo.hash || null });
    }

    if (dbFileInfo.hash === null || dbFileInfo.hash === undefined) {
      db.removeFileByPath(req.body.filepath, req.body.vpath);
      return res.json(_makeStaleResult(dbFileInfo));
    }

    db.updateFileScanId(dbFileInfo, req.body.scanId);
    const flags = _buildFileFlags(dbFileInfo, req.body.vpath, req.body.scanId);

    if (Object.keys(flags).length > 0) {
      return res.json({ ...flags, filepath: dbFileInfo.filepath, vpath: dbFileInfo.vpath });
    }
    res.json(dbFileInfo);
  });

  velvet.post('/api/v1/scanner/set-expected', (req, res) => {
    if (req.body.scanId && req.body.expected > 0) {
      scanProgress.setExpected(req.body.scanId, req.body.expected);
    }
    res.json({});
  });

  // Incremental pre-count update — called every 5 000 files during the
  // first-scan pre-count walk so the UI shows a growing "Counting…" counter.
  velvet.post('/api/v1/scanner/counting-update', (req, res) => {
    if (req.body.scanId && req.body.found > 0) {
      scanProgress.updateCountingFound(req.body.scanId, req.body.found);
    }
    res.json({});
  });

  velvet.post('/api/v1/scanner/get-files-batch', (req, res) => {
    const { items, vpath, scanId } = req.body;
    if (!Array.isArray(items) || !items.length || !vpath || !scanId) {
      return res.status(400).json({ error: 'Invalid batch request' });
    }
    try {
      const filepaths = items.map(i => i.filepath);
      const dbMap = db.findFilesByPaths(filepaths, vpath);
      const results = {};
      const batchScanIdUpdates = [];

      for (const item of items) {
        scanProgress.tick(scanId, item.filepath);
        const dbFileInfo = dbMap.get(item.filepath);
        if (!dbFileInfo) { results[item.filepath] = {}; continue; }
        if (dbFileInfo.sID === scanId) { results[item.filepath] = { _alreadyDone: true }; continue; }

        if (item.modTime !== dbFileInfo.modified) {
          db.removeFileByPath(item.filepath, vpath);
          results[item.filepath] = { ..._makeStaleResult(dbFileInfo), _oldHash: dbFileInfo.hash || null };
          continue;
        }
        if (dbFileInfo.hash === null || dbFileInfo.hash === undefined) {
          db.removeFileByPath(item.filepath, vpath);
          results[item.filepath] = _makeStaleResult(dbFileInfo);
          continue;
        }

        const flags = _buildFileFlags(dbFileInfo, vpath, scanId);
        if (Object.keys(flags).length > 0) {
          db.updateFileScanId(dbFileInfo, scanId);
          results[item.filepath] = { ...flags, filepath: dbFileInfo.filepath, vpath: dbFileInfo.vpath };
        } else {
          batchScanIdUpdates.push(item.filepath);
          results[item.filepath] = dbFileInfo;
        }
      }

      if (batchScanIdUpdates.length > 0) db.batchUpdateScanIds(batchScanIdUpdates, vpath, scanId);
      res.json(results);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  velvet.post('/api/v1/scanner/update-art', (req, res) => {
    db.updateFileArt(req.body.filepath, req.body.vpath, req.body.aaFile, req.body.scanId, req.body.artSource || null, req.body.coverFile || null);
    res.json({});
  });

  velvet.post('/api/v1/scanner/update-cue', (req, res) => {
    // cuepoints is either a JSON string or '[]' (sentinel: checked, no cue found)
    db.updateFileCue(req.body.filepath, req.body.vpath, req.body.cuepoints);
    res.json({});
  });

  velvet.post('/api/v1/scanner/update-duration', (req, res) => {
    db.updateFileDuration(req.body.filepath, req.body.vpath, req.body.duration);
    res.json({});
  });

  velvet.post('/api/v1/scanner/update-tech-meta', (req, res) => {
    const changes = db.updateFileTechMeta(req.body.filepath, req.body.vpath, req.body.bitrate ?? null, req.body.sample_rate ?? null, req.body.channels ?? null, req.body.bit_depth ?? null);
    if (changes === 0) {
      import('winston').then(w => w.default.warn(`[tech-meta] 0 rows updated — fp="${req.body.filepath}" vp="${req.body.vpath}" bitrate=${req.body.bitrate}`));
    }
    res.json({});
  });

  velvet.post('/api/v1/scanner/update-album-version', (req, res) => {
    db.updateFileAlbumVersion(req.body.filepath, req.body.vpath, req.body.album_version ?? null, req.body.album_version_source ?? null);
    res.json({});
  });

  // Scan error audit: called by the scanner child process to record an error.
  // The guid (md5 of filepath|errorType) ensures deduplication: the same problem
  // on the same file is counted (count++) rather than creating duplicate rows.
  velvet.post('/api/v1/scanner/report-error', (req, res) => {
    const { guid, filepath, vpath, errorType, errorMsg, stack } = req.body;
    if (!guid || !filepath || !vpath || !errorType) { return res.json({}); }
    db.insertScanError(guid, filepath, vpath, errorType, errorMsg || '', stack || '');
    res.json({});
  });

  // After a file is successfully parsed/inserted, confirm any fixed scan errors
  // for it are now resolved.  Only rows where fixed_at IS NOT NULL are touched.
  velvet.post('/api/v1/scanner/confirm-ok', (req, res) => {
    const { filepath, vpath } = req.body;
    if (!filepath || !vpath) return res.json({});
    db.confirmScanErrorOk(filepath, vpath);
    res.json({});
  });

  // Prune old scan errors before each scan run.
  velvet.post('/api/v1/scanner/prune-errors', (req, res) => {
    const retentionHours = config.program.scanOptions.scanErrorRetentionHours || 48;
    db.pruneScanErrors(retentionHours);
    res.json({});
  });

  // Called by the scanner worker when it detects a likely mount failure
  // (hasBaseline=true but 0 files found). Cleans up progress state without
  // touching the database — existing rows are preserved.
  velvet.post('/api/v1/scanner/abort-scan', (req, res) => {
    const { scanId, vpath, reason } = req.body || {};
    if (scanId) scanProgress.finish(scanId);
    // Delete the resume checkpoint — a mount-failure abort should not be resumed
    if (vpath) taskQueue.deleteScanState(vpath);
    const msg = `Scan aborted for vpath "${vpath || '?'}": ${reason || 'unknown reason'}. Database was NOT modified.`;
    console.error(`[scanner] ${msg}`);
    try {
      if (_txActive) db.rollbackTransactionStrict();
    } catch (e) {
      console.error('[scanner] Failed to rollback scanner transaction on abort: ' + (e?.message ?? e));
    }
    _txActive = false;
    _txBatch = 0;
    res.json({ ok: true, aborted: true, reason });
  });

  velvet.post('/api/v1/scanner/finish-scan', (req, res) => {
    const scanFinishedAt = Math.floor(Date.now() / 1000);
    const scanStartTs = Number(req.body.scanStartTs || scanFinishedAt);
    scanProgress.finish(req.body.scanId);
    if (req.body.vpath) taskQueue.deleteScanState(req.body.vpath);

    _cleanWaveformCache(req.body.vpath, req.body.scanId);

    const totalInDB      = db.countFilesByVpath(req.body.vpath);
    const confirmedByScan = totalInDB > 0 ? db.countFilesByScanId(req.body.vpath, req.body.scanId) : 0;
    const pruneAllowed   = totalInDB === 0 || confirmedByScan >= totalInDB * 0.7;
    if (!pruneAllowed) {
      console.warn(`[finish-scan] SAFETY GUARD: vpath="${req.body.vpath}" confirmed ${confirmedByScan}/${totalInDB} files — skipping removeStaleFiles to avoid data loss`);
    }
    if (pruneAllowed) db.removeStaleFiles(req.body.vpath, req.body.scanId);

    try {
      const rootDir = config.program.folders[req.body.vpath]?.root;
      if (rootDir) _pruneExcludedVchilds(req.body.vpath, rootDir);
    } catch (e) { console.debug('[velvet]', e?.message ?? e); }

    if (req.body.scanStartTs) {
      try { db.clearResolvedErrors(req.body.vpath, req.body.scanStartTs); } catch (e) { console.debug('[velvet]', e?.message ?? e); }
    }
    try { db.recordCompletedScan(req.body.vpath, req.body.scanId, req.body.scanStartTs, scanFinishedAt); } catch (e) { console.debug('[velvet]', e?.message ?? e); }

    // Refresh the duplicate-content-hash set so the Subsonic layer keeps emitting
    // exact-file ("<hash>@<rowid>") ids for files added/removed during this scan.
    try { db.refreshDuplicateHashes(); } catch (e) { console.debug('[velvet]', e?.message ?? e); }

    db.saveFilesDB();
    if (_txActive) {
      try {
        db.commitTransactionStrict();
        _txActive = false;
        _txBatch = 0;
      } catch (e) {
        console.error('[scanner] Failed to finalize scanner transaction: ' + (e?.message ?? e));
        try { db.rollbackTransactionStrict(); } catch (rollbackErr) { console.debug('[velvet]', rollbackErr?.message ?? rollbackErr); }
        _txActive = false;
        _txBatch = 0;
        return res.status(500).json({ error: 'Failed to finalize scanner transaction', details: String(e?.message ?? e) });
      }
    }

    try {
      const rootDir = config.program.folders[req.body.vpath]?.root;
      if (rootDir) {
        const sentinelPath = path.join(rootDir, '.velvet.md');
        const sentinelContent =
          '# Velvet — Mount Guard\n\n' +
          'This file protects your Velvet database from being wiped\n' +
          'when your music share (NFS, SMB, or Docker volume) is not mounted.\n\n' +
          'How it works:\n' +
          '- Velvet writes this file after every successful library scan.\n' +
          '- Before each new scan, Velvet checks that this file is present.\n' +
          '- If this file is missing when a scan starts, the scan is aborted\n' +
          '  and your database is left untouched.\n\n' +
          'Do NOT delete this file. It is safe to leave it in your music root.\n';
        fs.writeFileSync(sentinelPath, sentinelContent, 'utf8');
      }
    } catch (e) { console.debug('[velvet]', e?.message ?? e); }

    try { db.rebuildFolderIndex(); } catch (e) { console.debug('[velvet]', e?.message ?? e); }
    db.rebuildArtistIndex();
    try { dlnaApi.bumpSystemUpdateID(); } catch (e) { console.debug('[velvet]', e?.message ?? e); }
    res.json({});
  });

  // Batch scan inserts into explicit SQLite transactions (500 at a time).
  // Without batching, every insertFile() is its own auto-commit which causes
  // an fsync/WAL flush per file.  On HDD/SD that takes 20-200 ms each,
  // blocking the Node.js event loop and starving the audio stream of bytes
  // — causing the browser to pause playback mid-song.
  // 500 batches = ~276 commits for 138K files instead of 2760 — fewer WAL fsyncs.
  let _txBatch = 0;
  let _txActive = false;
  const TX_BATCH_SIZE = 500;

  velvet.post('/api/v1/scanner/add-file', (req, res) => {
    try {
      if (!_txActive) {
        db.beginTransactionStrict();
        _txActive = true;
        _txBatch = 0;
      }
      db.insertFile(req.body);
      // Migrate play counts / ratings / history if the file hash changed (e.g. tag rewrite changed bytes)
      if (req.body._oldHash && req.body.hash && req.body._oldHash !== req.body.hash) {
        db.migrateHash(req.body._oldHash, req.body.hash);
      }
      scanProgress.tickInsert(req.body.sID);
      _txBatch++;
      if (_txBatch >= TX_BATCH_SIZE) {
        db.commitTransactionStrict();
        _txActive = false;
        _txBatch = 0;
      }
      res.json({});
    } catch (e) {
      console.error('[scanner] Database write failed in add-file: ' + (e?.message ?? e));
      try {
        if (_txActive) db.rollbackTransactionStrict();
      } catch (rollbackErr) {
        console.debug('[velvet]', rollbackErr?.message ?? rollbackErr);
      }
      _txActive = false;
      _txBatch = 0;
      res.status(500).json({ error: 'Scanner database write failed', details: String(e?.message ?? e) });
    }
  });
}

function _makeStaleResult(dbFileInfo) {
  return {
    _stale: true,
    _preserveAaFile:     dbFileInfo.aaFile       || null,
    _preserveArtSource:  dbFileInfo.art_source   || null,
    _preserveTs:         dbFileInfo.ts           || null,
    _preserveRgMeasuredTs:      dbFileInfo.rg_measured_ts      ?? null,
    _preserveRgMeasurementTool: dbFileInfo.rg_measurement_tool ?? null,
    _preserveRgIntegratedLufs:  dbFileInfo.rg_integrated_lufs  ?? null,
    _preserveRgTruePeakDbfs:    dbFileInfo.rg_true_peak_dbfs   ?? null,
    _preserveRgTrackGainDb:     dbFileInfo.rg_track_gain_db    ?? null,
    _preserveRgLra:             dbFileInfo.rg_lra              ?? null,
    _preserveRgAlbumGainDb:     dbFileInfo.rg_album_gain_db    ?? null,
    _preserveRgAlbumPeakDbfs:   dbFileInfo.rg_album_peak_dbfs  ?? null,
    _preserveBpm:        dbFileInfo.bpm          ?? null,
    _preserveMusicalKey: dbFileInfo.musical_key  ?? null,
    _preserveBpmSource:  dbFileInfo.bpm_source   ?? null,
    _preserveAbStatus:   dbFileInfo.ab_status    ?? null,
  };
}

function _buildFileFlags(dbFileInfo, vpath, scanId) {
  const flags = {};
  if (dbFileInfo.aaFile === null || dbFileInfo.aaFile === undefined) {
    flags._needsArt = true;
  } else {
    const vpathRoot = config.program.folders[vpath]?.root || '';
    let audioDir = '';
    if (vpathRoot) {
      try { audioDir = resolvePathWithinRoot(vpathRoot, path.dirname(dbFileInfo.filepath)); }
      catch { audioDir = ''; }
    }
    // The empty-string sentinel means "no art was found on a previous scan".
    // Re-check the directory in case the user has since dropped a cover image in.
    const sidecarAdded = dbFileInfo.aaFile === '' && audioDir && _dirHasNewArt(audioDir, scanId);
    let artMissing = false;
    if (dbFileInfo.aaFile) {
      try {
        artMissing = !fs.existsSync(resolveChildPath(config.program.storage.albumArtDirectory, dbFileInfo.aaFile));
      } catch {
        artMissing = true;
      }
    }
    if (
      artMissing ||
      _dirCoverChanged(dbFileInfo, vpathRoot) ||
      sidecarAdded
    ) {
      flags._needsArt = true;
      db.updateFileArt(dbFileInfo.filepath, dbFileInfo.vpath, null, scanId, null);
    }
  }
  if (dbFileInfo.cuepoints === null || dbFileInfo.cuepoints === undefined) flags._needsCue = true;
  if (dbFileInfo.duration  === null || dbFileInfo.duration  === undefined) flags._needsDuration = true;
  if (dbFileInfo.bitrate   === null || dbFileInfo.bitrate   === undefined) flags._needsBitrate = true;
  if (dbFileInfo.album_version === null || dbFileInfo.album_version === undefined) {
    const ap = _albumOnlyPrefixes(vpath);
    if (ap === null || ap.some(p => (dbFileInfo.filepath || '').startsWith(p))) flags._needsAlbumVersion = true;
  }
  return flags;
}

function _cleanWaveformCache(vpath, scanId) {
  try {
    const cacheDir    = config.program.storage.waveformDirectory;
    const staleHashes = db.getStaleFileHashes(vpath, scanId);
    for (const hash of staleHashes) {
      const wfPath = resolvePathWithinRoot(cacheDir, `wf-${hash}.json`);
      if (fs.existsSync(wfPath)) fs.unlinkSync(wfPath);
    }
  } catch (e) { console.debug('[velvet]', e?.message ?? e); }
}

function _pruneExcludedVchilds(vpath, rootDir) {
  for (const [vk, vf] of Object.entries(config.program.folders)) {
    if (vk === vpath || vf.type !== 'excluded') continue;
    const childRoot  = vf.root.replace(/\/?$/, '/');
    const parentRoot = rootDir.replace(/\/?$/, '/');
    if (!childRoot.startsWith(parentRoot)) continue;
    const relPrefix = path.relative(rootDir, vf.root);
    if (relPrefix) db.removeFilesByPrefix(vpath, relPrefix + '/');
  }
}
