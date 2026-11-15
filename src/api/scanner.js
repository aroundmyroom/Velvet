import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import * as db from '../db/manager.js';
import * as config from '../state/config.js';
import * as scanProgress from '../state/scan-progress.js';
import * as dlnaApi from './dlna.js';
import * as taskQueue from '../db/task-queue.js';
import { resolveChildPath, resolvePathWithinRoot } from '../util/path-security.js';
import { childPrefixWithin } from '../util/vpath.js';

// Returns true when the directory cover image has been replaced since it was
// last scanned. Two cases:
//   1. The stored cover_file no longer exists — user renamed or replaced it
//   2. The stored cover_file still exists but its mtime is newer than last scan
// Per-scan filesystem caches (promises, so concurrent tracks of one album share
// a single readdir/stat). All fs access is async so a slow network mount
// (NFS, CIFS/Samba, Docker bind mounts) never blocks the event loop, and
// nothing relies on kernel attribute caching. Keyed by scanId; only the most
// recent scans are kept.
const _MAX_SCAN_CACHES = 4;
const _scanCaches = new Map();
function _scanCache(scanId) {
  let c = _scanCaches.get(scanId);
  if (!c) {
    if (_scanCaches.size >= _MAX_SCAN_CACHES) _scanCaches.delete(_scanCaches.keys().next().value);
    c = { newArt: new Map(), coverMtime: new Map() };
    _scanCaches.set(scanId, c);
  }
  return c;
}
const _NAMED_ART_FILES = new Set([
  'folder.jpg', 'folder.jpeg', 'folder.png',
  'cover.jpg',  'cover.jpeg',  'cover.png',
  'album.jpg',  'album.jpeg',  'album.png',
  'front.jpg',  'front.jpeg',  'front.png',
  'frente.jpg', 'frente.jpeg', 'frente.png',
]);

// Returns true if the given directory now contains a cover image. Used to
// detect the case where a folder previously had no art (DB sentinel
// `aaFile === ''`) but the user has since dropped a cover.jpg / folder.jpg
// into it. Matches the filename set checked by scanner.mjs's
// checkDirectoryForAlbumArt(): named cover files first, then any .jpg/.png.
function _dirHasNewArt(audioDir, scanId) {
  const cache = _scanCache(scanId).newArt;
  let p = cache.get(audioDir);
  if (!p) {
    p = _scanDirForArt(audioDir);
    cache.set(audioDir, p);
  }
  return p;
}

async function _scanDirForArt(audioDir) {
  try {
    const files = await fsp.readdir(audioDir);
    if (files.some(f => _NAMED_ART_FILES.has(f.toLowerCase()))) return true;
    for (const f of files) {
      const ext = path.extname(f).toLowerCase();
      if (ext === '.jpg' || ext === '.jpeg' || ext === '.png') {
        // Confirm it's a regular file before counting it
        try {
          if ((await fsp.stat(resolvePathWithinRoot(audioDir, f))).isFile()) return true;
        } catch { /* ignore */ }
      }
    }
    return false;
  } catch { return false; }
}

// Resolves to the cover file's mtimeMs, or null when it no longer exists.
function _coverMtime(coverPath, scanId) {
  const cache = _scanCache(scanId).coverMtime;
  let p = cache.get(coverPath);
  if (!p) {
    p = fsp.stat(coverPath).then(st => st.mtimeMs, () => null);
    cache.set(coverPath, p);
  }
  return p;
}

async function _dirCoverChanged(dbFileInfo, vpathRoot, scanId) {
  try {
    if (dbFileInfo.art_source !== 'directory') return false;
    const audioDir = resolvePathWithinRoot(vpathRoot, path.dirname(dbFileInfo.filepath));

    // Case 1: stored cover_file is gone — art was likely replaced with a new file
    if (dbFileInfo.cover_file) {
      const oldCoverPath = resolveChildPath(audioDir, dbFileInfo.cover_file);
      const coverMtimeMs = await _coverMtime(oldCoverPath, scanId);
      if (coverMtimeMs === null) return true;
      // Case 2: cover_file still exists but was modified after last audio scan
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
  return Object.entries(config.program.folders)
    .filter(([, cfg]) => cfg.albumsOnly)
    .map(([name]) => childPrefixWithin(vpathName, name))
    .filter(prefix => prefix !== null);
}

export function setup(velvet) {
  velvet.all('/api/v1/scanner/{*path}', (req, res, next) => {
    if (req.scanApproved !== true) { return res.status(403).json({ error: 'Access Denied' }); }
    next();
  });

  velvet.post('/api/v1/scanner/set-expected', (req, res) => {
    if (req.body.scanId && req.body.expected > 0) {
      scanProgress.setExpected(req.body.scanId, req.body.expected);
    }
    res.json({});
  });

  const _BATCH_FS_CONCURRENCY = 8;

  velvet.post('/api/v1/scanner/get-files-batch', async (req, res) => {
    const { items, vpath, scanId } = req.body;
    if (!Array.isArray(items) || !items.length || !vpath || !scanId) {
      return res.status(400).json({ error: 'Invalid batch request' });
    }
    try {
      const filepaths = items.map(i => i.filepath);
      const dbMap = db.findFilesByPaths(filepaths, vpath);
      const results = {};
      const batchScanIdUpdates = [];

      const processItem = async item => {
        scanProgress.tick(scanId, item.filepath);
        const dbFileInfo = dbMap.get(item.filepath);
        if (!dbFileInfo) { results[item.filepath] = {}; return; }
        if (dbFileInfo.sID === scanId) { results[item.filepath] = { _alreadyDone: true }; return; }

        // A stale row stays in place until add-files replaces it, so an interrupted scan loses nothing.
        if (item.modTime !== dbFileInfo.modified) {
          results[item.filepath] = { ..._makeStaleResult(dbFileInfo), _oldHash: dbFileInfo.hash || null };
          return;
        }
        if (dbFileInfo.hash === null || dbFileInfo.hash === undefined || dbFileInfo.sID === db.ON_DEMAND_SCAN_ID) {
          results[item.filepath] = _makeStaleResult(dbFileInfo);
          return;
        }

        const flags = await _buildFileFlags(dbFileInfo, vpath, scanId);
        if (Object.keys(flags).length > 0) {
          db.updateFileScanId(dbFileInfo, scanId);
          results[item.filepath] = { ...flags, filepath: dbFileInfo.filepath, vpath: dbFileInfo.vpath };
        } else {
          batchScanIdUpdates.push(item.filepath);
          results[item.filepath] = dbFileInfo;
        }
      };

      let next = 0;
      const worker = async () => {
        while (next < items.length) await processItem(items[next++]);
      };
      await Promise.all(Array.from({ length: Math.min(_BATCH_FS_CONCURRENCY, items.length) }, worker));

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

  // Called by the scanner worker when a mount guard or the directory integrity
  // check fails. Rows already written by this scan stay; nothing is pruned.
  velvet.post('/api/v1/scanner/abort-scan', (req, res) => {
    const { scanId, vpath, reason } = req.body || {};
    if (scanId) scanProgress.finish(scanId);
    // Delete the resume checkpoint — a mount-failure abort should not be resumed
    if (vpath) taskQueue.deleteScanState(vpath);
    console.error(`[scanner] Scan aborted for vpath "${vpath || '?'}": ${reason || 'unknown reason'}. No files were removed from the database.`);
    res.json({ ok: true, aborted: true, reason });
  });

  velvet.post('/api/v1/scanner/finish-scan', (req, res) => {
    const scanFinishedAt = Math.floor(Date.now() / 1000);
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
      const known = new Set(Object.keys(config.program.folders || {}));
      const orphans = db.getOrphanedVpaths(known);
      if (orphans.length) {
        console.warn(`[finish-scan] Orphaned vpaths in files table: ${orphans.join(', ')} — these folders were removed from config but rows remain. Use Admin → Library → "Purge orphaned vpaths" to clean up.`);
      }
    } catch (e) { console.debug('[velvet]', e?.message ?? e); }

    try { _pruneExcludedVchilds(req.body.vpath); } catch (e) { console.debug('[velvet]', e?.message ?? e); }

    if (req.body.scanStartTs) {
      try { db.clearResolvedErrors(req.body.vpath, req.body.scanStartTs); } catch (e) { console.debug('[velvet]', e?.message ?? e); }
    }
    try { db.recordCompletedScan(req.body.vpath, req.body.scanId, req.body.scanStartTs, scanFinishedAt); } catch (e) { console.debug('[velvet]', e?.message ?? e); }

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

  // The scanner sends its parsed rows in batches and each batch is written in
  // one short transaction inside this request: one WAL commit per batch instead
  // of one fsync per file, and no transaction ever stays open between requests
  // on the shared connection (other writers would join it or fail on BEGIN).
  velvet.post('/api/v1/scanner/add-files', (req, res) => {
    const { files } = req.body || {};
    if (!Array.isArray(files) || !files.length) return res.status(400).json({ error: 'Invalid batch request' });
    const failed = [];
    db.beginTransactionStrict();
    try {
      for (const file of files) {
        db.savepoint('scan_file');
        try {
          db.removeFileByPath(file.filepath, file.vpath);
          db.insertFile(file);
          // Migrate play counts / ratings / history if the file hash changed (e.g. tag rewrite changed bytes)
          if (file._oldHash && file.hash && file._oldHash !== file.hash) db.migrateHash(file._oldHash, file.hash);
          db.confirmScanErrorOk(file.filepath, file.vpath);
          db.releasePoint('scan_file');
        } catch (e) {
          db.rollbackToPoint('scan_file');
          db.releasePoint('scan_file');
          failed.push({ filepath: file.filepath, error: String(e?.message ?? e) });
        }
      }
      db.commitTransactionStrict();
    } catch (e) {
      db.rollbackTransactionStrict();
      console.error('[scanner] Database write failed in add-files: ' + (e?.message ?? e));
      return res.status(500).json({ error: 'Scanner database write failed', details: String(e?.message ?? e) });
    }
    scanProgress.tickInsert(files[0].sID, files.length - failed.length);
    res.json({ failed });
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

async function _buildFileFlags(dbFileInfo, vpath, scanId) {
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
    const sidecarAdded = dbFileInfo.aaFile === '' && audioDir && await _dirHasNewArt(audioDir, scanId);
    let artMissing = false;
    if (dbFileInfo.aaFile) {
      try {
        await fsp.access(resolveChildPath(config.program.storage.albumArtDirectory, dbFileInfo.aaFile));
      } catch {
        artMissing = true;
      }
    }
    if (
      artMissing ||
      await _dirCoverChanged(dbFileInfo, vpathRoot, scanId) ||
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
      const wfPath = resolvePathWithinRoot(cacheDir, `wf2-${hash}.json`);
      if (fs.existsSync(wfPath)) fs.unlinkSync(wfPath);
    }
  } catch (e) { console.debug('[velvet]', e?.message ?? e); }
}

function _pruneExcludedVchilds(vpath) {
  for (const [vk, vf] of Object.entries(config.program.folders)) {
    if (vf.type !== 'excluded') continue;
    const prefix = childPrefixWithin(vpath, vk);
    if (prefix) db.removeFilesByPrefix(vpath, prefix);
  }
}
