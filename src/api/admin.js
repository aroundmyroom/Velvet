import { randomBytes } from 'node:crypto';
import WebError from '../util/web-error.js';
import path from 'node:path';
import child from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import Joi from 'joi';
import winston from 'winston';
import { ZipArchive } from 'archiver';
import * as fileExplorer from '../util/file-explorer.js';
import * as admin from '../util/admin.js';
import * as config from '../state/config.js';
import * as dbQueue from '../db/task-queue.js';
import * as imageCompress from '../db/image-compress-manager.js';
import * as transcode from './transcode.js';
import * as db from '../db/manager.js';
import { joiValidate } from '../util/validation.js';
import { getVPathInfo } from '../util/vpath.js';
import { resolveExistingFileWithinRoots, resolvePathWithinRoot } from '../util/path-security.js';

import { getTransAlgos, getTransCodecs, getTransBitrates } from '../api/transcode.js';
import * as scanProgress from '../state/scan-progress.js';
import { invalidateCache as invalidateAlbumsCache, resolveAlbumsSources } from './albums-browse.js';
import { invalidateArtistCache } from './artists-browse.js';
import * as scrobblerApi from './scrobbler.js';
import { mergeGenreRows, autoGroupGenres } from '../util/genre-merge.js';
import * as serverPlaybackApi from './server-playback.js';
import { VALID_RETENTIONS } from '../logger.js';
import { writeTags } from '../util/ffmpeg-tags.js';
import { ffmpegBin, ffprobeBin } from '../util/ffmpeg-bootstrap.js';
import { signUserToken, setTokenCookie } from './auth.js';

// A vpath is a URL segment (/media/<vpath>/) and the first segment of every song path, so no slashes.
// eslint-disable-next-line no-control-regex
const VPATH_SCHEMA = Joi.string().pattern(/^[^/\\\x00-\x1F\x7F]+$/).invalid('.', '..', '__proto__', 'constructor', 'prototype');

// Fields of a user the admin Users view needs; secrets and third-party tokens stay on the server.
const ADMIN_USER_FIELDS = [
  'vpaths', 'admin',
  'allow-radio-recording', 'allow-youtube-download', 'allow-upload', 'allow-ai-dj',
  'allow-server-remote', 'allow-mpv-cast',
];

let _artistRebuildState = {
  running: false,
  startedAt: null,
  finishedAt: null,
  lastError: null,
};

// Revoking the admin's own tokens would end this session too, so hand it a fresh token.
function _freshOwnToken(req, res, username) {
  if (username !== req.user.username) return {};
  const token = signUserToken(username);
  setTokenCookie(req, res, token);
  return { token };
}

/** Remove flags incompatible with a newly-assigned folder type */
function _clearIncompatibleFlags(folderObj, type) {
  if (type !== 'recordings' && type !== 'youtube') delete folderObj.allowRecordDelete;
  if (type === 'recordings' || type === 'youtube' || type === 'excluded') delete folderObj.albumsOnly;
  if (type === 'recordings' || type === 'youtube' || type === 'excluded') delete folderObj.dlnaEnabled;
}

/** After marking a vpath as excluded, trigger a re-scan of its parent root */
function _triggerExcludedParentScan(vpath) {
  const thisRoot = config.program.folders[vpath]?.root;
  if (!thisRoot) return;
  const parentVpath = Object.keys(config.program.folders).find(other => {
    if (other === vpath) return false;
    const otherRoot = config.program.folders[other].root.replace(/\/?$/, '/');
    return thisRoot.replace(/\/?$/, '/').startsWith(otherRoot);
  });
  if (parentVpath) dbQueue.scanVPath(parentVpath);
}

// ── Helpers for /api/v1/admin/tags/write ────────────────────────────────────────

/** Write updated tag values to the DB and sync the mtime. */
function _updateTagsInDb(pathInfo, body, absPath) {
  const tags = {};
  if (body.title  !== undefined) tags.title  = body.title  || null;
  if (body.artist !== undefined) tags.artist = body.artist || null;
  if (body.album  !== undefined) tags.album  = body.album  || null;
  if (body.year   !== undefined) tags.year   = body.year   ? Number(body.year)  || null : null;
  if (body.genre  !== undefined) tags.genre  = body.genre  || null;
  if (body.track  !== undefined) tags.track  = body.track  ? Number(body.track) || null : null;
  if (body.disk   !== undefined) tags.disk   = body.disk   ? Number(body.disk)  || null : null;
  db.updateFileTags(pathInfo.relativePath, pathInfo.vpath, tags);
  // Sync mtime so the scanner doesn't flag this as stale on next pass
  try {
    const newMtime = fs.statSync(absPath).mtime.getTime();
    db.updateFileModified(pathInfo.relativePath, pathInfo.vpath, newMtime);
  } catch (e) { console.debug('[velvet]', e?.message ?? e); }
}

// ── Helpers for /api/v1/admin/db/scan-errors/fix ──────────────────────────────

/** Throw-able HTTP error with a status code */
function _scanErrHttp(status, msg) {
  return Object.assign(new Error(msg), { httpStatus: status });
}

async function _fixArtError(err, guid) {
  const vpathFolder = config.program.folders[err.vpath];
  if (!vpathFolder) throw _scanErrHttp(400, `Unknown vpath: ${err.vpath}`);
  let absPath;
  try {
    absPath = resolvePathWithinRoot(vpathFolder.root, err.filepath);
  } catch {
    throw _scanErrHttp(400, `File not found on disk: ${err.filepath}`);
  }
  if (!fs.existsSync(absPath)) throw _scanErrHttp(400, `File not found on disk: ${absPath}`);
  const result = await stripEmbeddedImages(absPath);
  if (!result.ok) throw _scanErrHttp(500, result.reason);
  db.markScanErrorFixed(guid, 'art_fixed');
  return { ok: true, action: 'art_fixed' };
}

async function _fixParseOrDurationError(err, guid) {
  const vpathFolder = config.program.folders[err.vpath];
  if (!vpathFolder) throw _scanErrHttp(400, `Unknown vpath: ${err.vpath}`);
  let absPath;
  try {
    absPath = resolvePathWithinRoot(vpathFolder.root, err.filepath);
  } catch {
    throw _scanErrHttp(400, `File not found on disk: ${err.filepath}`);
  }
  if (!fs.existsSync(absPath)) throw _scanErrHttp(400, `File not found on disk: ${absPath}`);
  const ext = path.extname(absPath).toLowerCase();
  const remuxable = ['.mp3', '.flac', '.wav', '.ogg', '.opus', '.m4a', '.aac', '.wma', '.ape'];
  if (!remuxable.includes(ext)) {
    db.markScanErrorFixed(guid);
    return { ok: true, action: 'dismissed' };
  }
  // Pre-check: if no valid audio stream, remuxing is pointless
  const probeOk = await probeHasAudio(absPath);
  if (!probeOk) {
    console.error(`[scan-error-fix] file is unrecoverable (no valid audio stream): ${absPath}`);
    db.markScanErrorFixed(guid, 'unrecoverable');
    return { ok: true, action: 'unrecoverable' };
  }

  // Player-reported parse errors (Chrome DEMUXER_ERROR / PTS not defined) require a full
  // re-encode to regenerate timestamps from scratch.  Stream-copy preserves the broken
  // timestamp layout even with -fflags +genpts because the underlying frame data is
  // unchanged at the codec level.  For FLAC this is lossless (FLAC → FLAC re-encode).
  // For non-FLAC formats, fall through to remuxAudio which now includes -fflags +genpts.
  const isPlayerReport = err.stack === 'reported by player';
  if (isPlayerReport && ext === '.flac') {
    const ffmpegBinPath = ffmpegBin();
    if (!fs.existsSync(ffmpegBinPath)) {
      throw _scanErrHttp(500, 'ffmpeg binary not found');
    }
    const dir  = path.dirname(absPath);
    const base = path.basename(absPath, ext);
    const tmp  = path.join(dir, `.__velvet_fix_${base}${ext}`);
    try {
      await _runFfmpegReencode(ffmpegBinPath, absPath, tmp);
      fs.renameSync(tmp, absPath);
      db.markScanErrorFixed(guid, 'reencoded');
      return { ok: true, action: 'reencoded', note: 'File re-encoded with fresh timestamps — trigger a rescan to update the library.' };
    } catch (reEncodeErr) {
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* non-fatal cleanup */ }
      console.error(`[scan-error-fix] FLAC re-encode failed for ${absPath}: ${reEncodeErr.message}`);
      db.markScanErrorFixed(guid, 'unrecoverable');
      return { ok: true, action: 'unrecoverable' };
    }
  }

  const result = await remuxAudio(absPath);
  if (!result.ok) {
    if (result.unrecoverable) {
      console.error(`[scan-error-fix] file is unrecoverable (corrupt frames): ${absPath}`);
      db.markScanErrorFixed(guid, 'unrecoverable');
      return { ok: true, action: 'unrecoverable' };
    }
    console.error(`[scan-error-fix] fix failed for ${absPath}: ${result.reason}`);
    throw _scanErrHttp(500, result.reason);
  }
  const action = result.reencoded ? 'reencoded' : 'remuxed';
  const note   = result.reencoded
    ? 'File re-encoded (some corrupt frames discarded) — trigger a rescan to update the library.'
    : 'File rewritten — trigger a rescan to update the library.';
  db.markScanErrorFixed(guid, action);
  return { ok: true, action, note };
}

// ── Helpers for /api/v1/admin/directories/test ───────────────────────────────
function _detectStorageType(root, platform) {
  if (platform === 'win32') return root.startsWith('\\\\') ? 'windows-network' : 'windows-local';
  if (platform === 'darwin') return root.startsWith('/Volumes/') ? 'mac-external' : 'mac-local';
  // Linux / other POSIX — /mnt/, /media/, /run/media/, /net/ are mount points
  return /^\/(?:mnt|media|run\/media|net)\//.test(root) ? 'linux-mounted' : 'linux-local';
}

async function _testDirectoryAccess(root) {
  let readable = false, writable = false, errorMsg = null;
  try {
    await fs.promises.access(root, fs.constants.R_OK);
    readable = true;
  } catch (e) {
    errorMsg = e.code || e.message;
  }
  // Write test — temp file uses random suffix so it never collides; always cleaned up
  if (readable) {
    const rnd     = Math.random().toString(36).slice(2, 9); // NOSONAR: non-security random temp file suffix
    const tmpFile = path.join(root, `.velvet-writetest-${Date.now()}-${rnd}`);
    try {
      await fs.promises.writeFile(tmpFile, 'velvet-access-test', { flag: 'wx' });
      const data = await fs.promises.readFile(tmpFile, 'utf8');
      writable = (data === 'velvet-access-test');
    } catch (e) {
      if (!errorMsg) errorMsg = e.code || e.message;
    } finally {
      try { await fs.promises.unlink(tmpFile); } catch (e) { console.debug('[velvet]', e?.message ?? e); }
    }
  }
  return { readable, writable, error: errorMsg };
}

export function setup(velvet) {
  velvet.all('/api/v1/admin/{*path}', (req, res, next) => {
    if (config.program.lockAdmin === true) { return res.status(405).json({ error: 'Admin API Disabled' }); }
    if (req.user.admin !== true) { return res.status(403).json({ error: 'Admin access required' }); }
    next();
  });

  velvet.post('/api/v1/admin/lock-api', async (req, res) => {
    const schema = Joi.object({ lock: Joi.boolean().required() });
    joiValidate(schema, req.body);

    await admin.lockAdminApi(req.body.lock);
    res.json({});
  });

  velvet.get('/api/v1/admin/file-explorer/win-drives', (req, res) => {
    if (os.platform() !== 'win32') {
      return res.json([]);
    }

    // Use execFile (no shell) with absolute path — prevents PATH-injection and shell injection
    const wmicPath = process.env.SystemRoot
      ? String.raw`${process.env.SystemRoot}\System32\wbem\WMIC.exe`
      : String.raw`C:\Windows\System32\wbem\WMIC.exe`;
    child.execFile(wmicPath, ['logicaldisk', 'get', 'name'], (error, stdout) => {
      const drives = stdout.split('\r\r\n')
        .filter(value => /[A-Za-z]:/.test(value))
        .map(value => value.trim() + '\\')
      res.json(drives);
    });
  });

  // The admin file explorer can view the entire system
  velvet.post("/api/v1/admin/file-explorer", async (req, res) => {
    const schema = Joi.object({
      directory: Joi.string().required(),
      joinDirectory: Joi.string().optional()
    });
    joiValidate(schema, req.body);

    // Handle home directory
    let thisDirectory = req.body.directory;
    if (thisDirectory.includes('\0')) { throw new WebError('Invalid path', 400); }
    if (req.body.directory === '~') {
      thisDirectory = os.homedir();
    }

    if (req.body.joinDirectory) {
      const joinDirectory = String(req.body.joinDirectory || '').trim();
      if (!joinDirectory || path.isAbsolute(joinDirectory) || joinDirectory.includes('\0')) {
        throw new Error('Invalid child path');
      }
      thisDirectory = path.resolve(thisDirectory, joinDirectory);
    }

    const folderContents = await fileExplorer.getDirectoryContents(thisDirectory, {}, true);

    res.json({
      path: thisDirectory,
      directories: folderContents.directories,
      files: folderContents.files
    });
  });

  velvet.get("/api/v1/admin/directories", (req, res) => {
    res.json(config.program.folders);
  });

  // Test read/write access for every configured vpath directory.
  // Writes a temp file, reads it back, then deletes it — no artifact is ever left.
  velvet.get('/api/v1/admin/directories/test', async (req, res) => {
    const platform = os.platform();
    const results  = [];

    for (const [vpath, info] of Object.entries(config.program.folders)) {
      const root        = info.root;
      const storageType = _detectStorageType(root, platform);
      const access      = await _testDirectoryAccess(root);
      results.push({ vpath, root, storageType, ...access });
    }

    res.json({ platform, results });
  });

  // Scan each vpath root + its immediate subdirectories for permission issues.
  // Only returns subdirs that have read or write problems; fully-OK dirs are omitted.
  velvet.get('/api/v1/admin/directories/health', async (req, res) => {
    const SUBDIR_CAP = 300;
    const results = [];

    for (const [vpath, info] of Object.entries(config.program.folders)) {
      const root = info.root;
      const rootAccess = await _testDirectoryAccess(root);
      const problematic = [];

      if (rootAccess.readable) {
        try {
          const entries = await fs.promises.readdir(root, { withFileTypes: true });
          const dirs = entries
            .filter(e => e.isDirectory() && !e.name.startsWith('.'))
            .slice(0, SUBDIR_CAP);

          for (const entry of dirs) {
            const dirPath = path.join(root, entry.name);
            let readable = false, writable = false;
            try { await fs.promises.access(dirPath, fs.constants.R_OK); readable = true; } catch (_) {}
            if (readable) {
              try { await fs.promises.access(dirPath, fs.constants.W_OK); writable = true; } catch (_) {}
            }
            if (!readable || !writable) problematic.push({ name: entry.name, readable, writable });
          }
        } catch (_) { /* root unreadable — already captured in rootAccess */ }
      }

      results.push({ vpath, root, readable: rootAccess.readable, writable: rootAccess.writable, error: rootAccess.error, subdirs: problematic });
    }

    res.json({ results });
  });

  velvet.get("/api/v1/admin/db/params", (req, res) => {
    res.json({
      ...config.program.scanOptions,
      nextScanAt: dbQueue.getNextScanMs(),
      albumVersionTags: config.program.albumVersionTags || null,
      albumCategoryFolders: config.program.albumCategoryFolders || null,
    });
  });

  velvet.post("/api/v1/admin/db/params/scan-interval", async (req, res) => {
    const schema = Joi.object({
      scanInterval: Joi.number().integer().min(0).required()
    });
    joiValidate(schema, req.body);

    await admin.editScanInterval(req.body.scanInterval);
    res.json({ nextScanAt: dbQueue.getNextScanMs() });
  });

  velvet.post("/api/v1/admin/db/params/scan-start-time", async (req, res) => {
    const schema = Joi.object({
      scanStartTime: Joi.string().pattern(/^\d{1,2}:\d{2}$/).allow(null, '').required()
    });
    joiValidate(schema, req.body);

    await admin.editScanStartTime(req.body.scanStartTime);
    res.json({ nextScanAt: dbQueue.getNextScanMs() });
  });

  velvet.post("/api/v1/admin/db/params/skip-img", async (req, res) => {
    const schema = Joi.object({
      skipImg: Joi.boolean().required()
    });
    joiValidate(schema, req.body);

    await admin.editSkipImg(req.body.skipImg);
    res.json({});
  });

  velvet.post("/api/v1/admin/db/params/boot-scan-delay", async (req, res) => {
    const schema = Joi.object({
      bootScanDelay:  Joi.number().integer().min(0).required()
    });
    joiValidate(schema, req.body);

    await admin.editBootScanDelay(req.body.bootScanDelay);
    res.json({});
  });

  velvet.post("/api/v1/admin/db/params/boot-scan-enabled", async (req, res) => {
    const schema = Joi.object({
      bootScanEnabled: Joi.boolean().required()
    });
    joiValidate(schema, req.body);

    await admin.editBootScanEnabled(req.body.bootScanEnabled);
    res.json({});
  });

  velvet.post("/api/v1/admin/db/params/max-concurrent-scans", async (req, res) => {
    const schema = Joi.object({
      maxConcurrentTasks:  Joi.number().integer().min(1).required()
    });
    joiValidate(schema, req.body);

    await admin.editMaxConcurrentTasks(req.body.maxConcurrentTasks);
    res.json({});
  });

  velvet.post("/api/v1/admin/db/params/compress-image", async (req, res) => {
    const schema = Joi.object({
      compressImage:  Joi.boolean().required()
    });
    joiValidate(schema, req.body);

    await admin.editCompressImages(req.body.compressImage);
    res.json({});
  });

  velvet.post("/api/v1/admin/db/params/allow-id3edit", async (req, res) => {
    const schema = Joi.object({ allowId3Edit: Joi.boolean().required() });
    joiValidate(schema, req.body);
    await admin.editAllowId3Edit(req.body.allowId3Edit);
    res.json({});
  });

  velvet.post("/api/v1/admin/db/params/max-recording-minutes", async (req, res) => {
    const schema = Joi.object({ maxRecordingMinutes: Joi.number().integer().min(1).required() });
    joiValidate(schema, req.body);
    await admin.editMaxRecordingMinutes(req.body.maxRecordingMinutes);
    res.json({});
  });

  velvet.post("/api/v1/admin/db/params/max-zip-mb", async (req, res) => {
    const schema = Joi.object({ maxZipMb: Joi.number().integer().min(1).required() });
    joiValidate(schema, req.body);
    await admin.editMaxZipMb(req.body.maxZipMb);
    res.json({});
  });

  velvet.post("/api/v1/admin/db/params/album-version-tags", async (req, res) => {
    const schema = Joi.object({
      tags: Joi.array()
        .items(Joi.string().max(60).pattern(/^[\w:.\-\s]+$/))
        .max(20)
        .required()
    });
    joiValidate(schema, req.body);
    await admin.editAlbumVersionTags(req.body.tags);
    res.json({});
  });

  velvet.post("/api/v1/admin/db/params/album-category-folders", async (req, res) => {
    const schema = Joi.object({
      folders: Joi.array()
        .items(Joi.string().max(120))
        .max(50)
        .required()
    });
    joiValidate(schema, req.body);
    await admin.editAlbumCategoryFolders(req.body.folders);
    invalidateAlbumsCache();
    res.json({});
  });

  velvet.get("/api/v1/admin/db/album-version-inventory", (req, res) => {
    const rows = db.getAlbumVersionInventory();
    res.json(rows);
  });

  velvet.get("/api/v1/admin/users", (req, res) => {
    const users = {};
    for (const [username, user] of Object.entries(config.program.users)) {
      users[username] = Object.fromEntries(ADMIN_USER_FIELDS.filter(k => k in user).map(k => [k, user[k]]));
    }
    res.json(users);
  });

  velvet.put("/api/v1/admin/directory", async (req, res) => {
    const schema = Joi.object({
      directory: Joi.string().required(),
      vpath: VPATH_SCHEMA.required(),
      autoAccess: Joi.boolean().default(false),
      isAudioBooks: Joi.boolean().default(false),
      isRecording: Joi.boolean().default(false),
      isYoutube: Joi.boolean().default(false),
      allowRecordDelete: Joi.boolean().default(false),
      isExcluded: Joi.boolean().default(false),
      artistsOn: Joi.boolean().default(true),
    });
    const input = joiValidate(schema, req.body);

    await admin.addDirectory(
      input.value.directory,
      input.value.vpath,
      velvet,
      {
        autoAccess: input.value.autoAccess,
        isAudioBooks: input.value.isAudioBooks,
        isRecording: input.value.isRecording,
        allowRecordDelete: input.value.allowRecordDelete,
        isYoutube: input.value.isYoutube,
        isExcluded: input.value.isExcluded,
        artistsOn: input.value.artistsOn,
      });
    res.json({});

    try {
      // Skip scan for recordings/youtube/excluded folders — must not be indexed in the music library.
      const folderType = config.program.folders[input.value.vpath]?.type || 'music';
      if (folderType !== 'recordings' && folderType !== 'youtube' && folderType !== 'excluded') {
        const hierarchy = dbQueue.getScanHierarchy(config.program.folders);
        const parent = hierarchy.parents[input.value.vpath] || null;
        dbQueue.scanVPath(parent || input.value.vpath);
      }
    }catch (err) {
      winston.error('/api/v1/admin/directory failed to add ', { stack: err });
    }
  });

  // PATCH /api/v1/admin/directory/flags — update per-folder flags on an existing folder
  // Supports: allowRecordDelete (recordings/youtube folders), albumsOnly/dlnaEnabled (music/audio-books only), artistsOn (all non-excluded folders)
  velvet.patch("/api/v1/admin/directory/flags", async (req, res) => {
    const schema = Joi.object({
      vpath: VPATH_SCHEMA.required(),
      allowRecordDelete: Joi.boolean().optional(),
      albumsOnly: Joi.boolean().optional(),
      dlnaEnabled: Joi.boolean().optional(),
      artistsOn: Joi.boolean().optional(),
    }).or('allowRecordDelete', 'albumsOnly', 'dlnaEnabled', 'artistsOn');
    const input = joiValidate(schema, req.body);
    const { vpath, allowRecordDelete, albumsOnly, dlnaEnabled, artistsOn } = input.value;
    const folder = config.program.folders[vpath];
    if (!folder) return res.status(404).json({ error: 'vpath not found' });

    const validationError = _validateFolderFlags(folder, { allowRecordDelete, albumsOnly, dlnaEnabled, artistsOn });
    if (validationError) return res.status(400).json({ error: validationError });

    _applyFolderFlag(config.program.folders[vpath], 'allowRecordDelete', allowRecordDelete, true);
    _applyFolderFlag(config.program.folders[vpath], 'albumsOnly', albumsOnly, true);
    _applyFolderFlag(config.program.folders[vpath], 'dlnaEnabled', dlnaEnabled, true);
    if (artistsOn !== undefined) config.program.folders[vpath].artistsOn = artistsOn;

    await config.updateConfigFile(c => {
      if (!c.folders) c.folders = {};
      if (!c.folders[vpath]) c.folders[vpath] = {};
      _applyFolderFlag(c.folders[vpath], 'allowRecordDelete', allowRecordDelete, true);
      _applyFolderFlag(c.folders[vpath], 'albumsOnly', albumsOnly, true);
      _applyFolderFlag(c.folders[vpath], 'dlnaEnabled', dlnaEnabled, true);
      if (artistsOn !== undefined) c.folders[vpath].artistsOn = artistsOn;
    });
    if (albumsOnly !== undefined || dlnaEnabled !== undefined) invalidateAlbumsCache();
    res.json({});
    if (artistsOn !== undefined) {
      // Pass invalidateArtistCache as onComplete so the cache is cleared
      // only after the worker finishes writing the new index.
      db.rebuildArtistIndex(invalidateArtistCache);
    }
  });

  // PATCH /api/v1/admin/directory/type — change the type of an existing folder
  velvet.patch("/api/v1/admin/directory/type", async (req, res) => {
    const schema = Joi.object({
      vpath: VPATH_SCHEMA.required(),
      type: Joi.string().valid('music', 'audio-books', 'recordings', 'youtube', 'excluded').required(),
    });
    const input = joiValidate(schema, req.body);
    const { vpath, type } = input.value;
    const folder = config.program.folders[vpath];
    if (!folder) return res.status(404).json({ error: 'vpath not found' });

    await config.updateConfigFile(c => {
      if (!c.folders?.[vpath]) throw new WebError('vpath not in config', 404);
      c.folders[vpath].type = type;
      _clearIncompatibleFlags(c.folders[vpath], type);
    });
    config.program.folders[vpath].type = type;
    _clearIncompatibleFlags(config.program.folders[vpath], type);

    // When a folder is marked as excluded, trigger a scan of its parent ROOT
    // so that already-indexed files under it get purged from the DB.
    if (type === 'excluded') {
      try { _triggerExcludedParentScan(vpath); } catch (e) { console.debug('[velvet]', e?.message ?? e); }
    }
    res.json({});
  });

  // PATCH /api/v1/admin/directory/root — change filesystem path of an existing folder
  velvet.patch("/api/v1/admin/directory/root", async (req, res) => {
    const schema = Joi.object({
      vpath: VPATH_SCHEMA.required(),
      root: Joi.string().required(),
    });
    const input = joiValidate(schema, req.body);
    const { vpath } = input.value;
    const root = config.normaliseFolderRoot(input.value.root);
    if (!config.program.folders[vpath]) return res.status(404).json({ error: 'vpath not found' });

    const stat = await fs.promises.stat(root).catch(() => null);
    if (!stat?.isDirectory()) return res.status(400).json({ error: `${root} is not a valid directory` });

    await config.updateConfigFile(c => { if (c.folders?.[vpath]) c.folders[vpath].root = root; });
    config.program.folders[vpath].root = root;
    res.json({ restartRequired: true });
  });

  // PATCH /api/v1/admin/directory/users — set which users have access to a folder
  velvet.patch("/api/v1/admin/directory/users", async (req, res) => {
    const schema = Joi.object({
      vpath: VPATH_SCHEMA.required(),
      users: Joi.array().items(Joi.string()).required(),
    });
    const input = joiValidate(schema, req.body);
    const { vpath, users: newUsers } = input.value;
    if (!config.program.folders[vpath]) return res.status(404).json({ error: 'vpath not found' });

    const withAccess = (vpaths, shouldHave) => {
      const rest = (vpaths || []).filter(v => v !== vpath);
      return shouldHave ? [...rest, vpath] : rest;
    };
    await config.updateConfigFile(c => {
      for (const [uname, u] of Object.entries(c.users || {})) {
        if (newUsers.includes(uname) !== (u.vpaths || []).includes(vpath)) u.vpaths = withAccess(u.vpaths, newUsers.includes(uname));
      }
    });
    for (const [uname, u] of Object.entries(config.program.users)) {
      if (newUsers.includes(uname) !== (u.vpaths || []).includes(vpath)) u.vpaths = withAccess(u.vpaths, newUsers.includes(uname));
    }
    res.json({});
  });

  velvet.delete("/api/v1/admin/directory", async (req, res) => {
    const schema = Joi.object({
      vpath: VPATH_SCHEMA.required()
    });
    joiValidate(schema, req.body);

    await admin.removeDirectory(req.body.vpath);
    res.json({});
  });

  velvet.put("/api/v1/admin/users", async (req, res) => {
    const schema = Joi.object({
      username: Joi.string().required(),
      password: Joi.string().required(),
      vpaths: Joi.array().items(Joi.string()).required(),
      admin: Joi.boolean().optional().default(false)
    });
    const input = joiValidate(schema, req.body);

    await admin.addUser(
      input.value.username,
      input.value.password,
      input.value.admin,
      input.value.vpaths
    );
    res.json({});
  });

  velvet.post("/api/v1/admin/db/force-compress-images", (req, res) => {
    res.json({ started: imageCompress.run() });
  });

  velvet.post("/api/v1/admin/db/scan/all", (req, res) => {
    dbQueue.scanAll();
    res.json({});
  });

  velvet.post("/api/v1/admin/db/scan/stop", (req, res) => {
    dbQueue.stopScanning();
    res.json({});
  });

  velvet.get("/api/v1/admin/db/scan/resume-state", (req, res) => {
    res.json({ resumable: dbQueue.getResumableVpaths() });
  });

  velvet.post("/api/v1/admin/db/scan/clear-state", (req, res) => {
    dbQueue.clearAllScanStates();
    res.json({});
  });

  velvet.get("/api/v1/admin/db/scan/stats", async (req, res) => {
    const stats = db.getStats();
    // Override totalAlbums to count only albums from albumsOnly directories.
    try {
      const sources = await resolveAlbumsSources();
      stats.totalAlbums = db.countAlbumsForSources(sources);
    } catch (e) { console.debug('[velvet]', e?.message ?? e); }
    // Count cached waveform files (filesystem — not tracked in DB)
    try {
      const wfDir = config.program.storage?.waveformDirectory;
      stats.waveformCount = wfDir
        ? fs.readdirSync(wfDir).filter(f => /^wf2?-/.test(f) && f.endsWith('.json')).length
        : 0;
    } catch { stats.waveformCount = 0; }
    res.json(stats);
  });

  velvet.get('/api/v1/admin/db/scan/progress', (req, res) => {
    res.json(scanProgress.getAll());
  });

  velvet.post('/api/v1/admin/db/purge-orphaned-vpaths', (req, res) => {
    try {
      const known = new Set(Object.keys(config.program.folders || {}));
      const orphaned = db.getOrphanedVpaths(known);
      if (req.body.dryRun) return res.json({ orphaned, deleted: 0 });
      const deleted = db.deleteOrphanedVpathRows(orphaned);
      res.json({ orphaned, deleted });
    } catch (e) {
      res.status(500).json({ error: e?.message ?? String(e) });
    }
  });

  // ── Scan Error Audit ──────────────────────────────────────────────────────────
  velvet.get('/api/v1/admin/db/scan-errors', (req, res) => {
    const limit = Math.min(Number.parseInt(req.query.limit, 10) || 500, 5000);
    res.json(db.getScanErrors(limit));
  });

  velvet.delete('/api/v1/admin/db/scan-errors', (req, res) => {
    db.clearScanErrors();
    res.json({});
  });

  velvet.get('/api/v1/admin/db/scan-errors/count', (req, res) => {
    res.json({ count: db.getScanErrorCount() });
  });

  // ── Auto-fix a single scan error ─────────────────────────────────────────
  // For art errors: strips embedded images from the file using ffmpeg so that
  // music-metadata can parse the file cleanly on the next scan.
  // Returns an error if the file cannot be found or if ffmpeg fails — no
  // silent DB suppression fallback.
  velvet.post('/api/v1/admin/db/scan-errors/fix', async (req, res) => {
    try {
      const schema = Joi.object({ guid: Joi.string().required() });
      joiValidate(schema, req.body);
      const { guid } = req.body;

      const err = db.getScanErrorByGuid(guid);
      if (!err) return res.status(404).json({ error: 'Error not found' });

      if (err.error_type === 'art') {
        return res.json(await _fixArtError(err, guid));
      }
      if (err.error_type === 'cue') {
        // Cue data comes from text sidecar files or text tags—nothing to strip
        // from the audio binary. Just mark fixed so the error clears.
        db.markScanErrorFixed(guid, 'cue_dismissed');
        return res.json({ ok: true, action: 'cue_dismissed' });
      }
      if (err.error_type === 'parse' || err.error_type === 'duration') {
        return res.json(await _fixParseOrDurationError(err, guid));
      }
      // insert / other — no file action possible
      db.markScanErrorFixed(guid, 'dismissed');
      return res.json({ ok: true, action: 'dismissed' });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });

  velvet.post('/api/v1/admin/db/params/scan-error-retention', async (req, res) => {
    const schema = Joi.object({
      hours: Joi.number().integer().valid(12, 24, 48, 72, 168, 336, 720).required()
    });
    joiValidate(schema, req.body);
    await admin.editScanErrorRetention(req.body.hours);
    res.json({});
  });
  // ─────────────────────────────────────────────────────────────────────────────

  velvet.delete("/api/v1/admin/users", async (req, res) => {
    const schema = Joi.object({
      username: Joi.string().required()
    });
    joiValidate(schema, req.body);

    await admin.deleteUser(req.body.username);
    res.json({});
  });

  velvet.post("/api/v1/admin/users/password", async (req, res) => {
    const schema = Joi.object({
      username: Joi.string().required(),
      password: Joi.string().required()
    });
    joiValidate(schema, req.body);

    await admin.editUserPassword(req.body.username, req.body.password);
    res.json(_freshOwnToken(req, res, req.body.username));
  });

  velvet.post("/api/v1/admin/users/revoke-tokens", async (req, res) => {
    const schema = Joi.object({ username: Joi.string().required() });
    joiValidate(schema, req.body);

    await admin.revokeUserTokens(req.body.username);
    res.json(_freshOwnToken(req, res, req.body.username));
  });

  velvet.post("/api/v1/admin/users/subsonic-password", async (req, res) => {
    const schema = Joi.object({
      username: Joi.string().required(),
      password: Joi.string().required()
    });
    joiValidate(schema, req.body);

    await admin.editSubsonicPassword(req.body.username, req.body.password);
    res.json({});
  });

  // ── Subsonic API Key management ───────────────────────────────────────────────

  velvet.get("/api/v1/admin/users/subsonic-apikeys", (req, res) => {
    const targetUser = req.query.username || req.user.username;
    const keys = db.getApiKeysByUsername(targetUser).map(k => ({
      id:      k.id,
      label:   k.label ?? '',
      created: new Date(k.created).toISOString(),
      apiKey:  k.api_key,
    }));
    res.json({ keys });
  });

  velvet.post("/api/v1/admin/users/subsonic-apikeys", (req, res) => {
    const targetUser = req.body?.username || req.user.username;
    if (!Object.hasOwn(config.program.users || {}, targetUser)) return res.status(404).json({ error: 'User not found' });
    const label  = req.body?.label ?? null;
    const apiKey = randomBytes(32).toString('hex');
    db.insertApiKey(targetUser, apiKey, label);
    res.json({ apiKey, label: label ?? '', created: new Date().toISOString() });
  });

  velvet.delete("/api/v1/admin/users/subsonic-apikeys/:id", (req, res) => {
    const id         = Number.parseInt(req.params.id, 10);
    const targetUser = req.query.username || req.user.username;
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const deleted = db.deleteApiKeyById(id, targetUser);
    if (!deleted) return res.status(404).json({ error: 'Key not found' });
    res.json({});
  });

  // Update global Last.fm API key + shared secret (admin only)
  velvet.get("/api/v1/admin/lastfm/config", (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });
    res.json({
      enabled:   config.program.lastFM?.enabled   !== false,
      apiKey:    config.program.lastFM?.apiKey    || '',
      apiSecret: config.program.lastFM?.apiSecret || '',
    });
  });

  velvet.post("/api/v1/admin/lastfm/config", async (req, res) => {
    const schema = Joi.object({
      enabled:   Joi.boolean().required(),
      apiKey:    Joi.string().allow('').required(),
      apiSecret: Joi.string().allow('').required(),
    });
    joiValidate(schema, req.body);

    await config.updateConfigFile(c => {
      c.lastFM = { ...c.lastFM, enabled: req.body.enabled, apiKey: req.body.apiKey, apiSecret: req.body.apiSecret };
    });

    config.program.lastFM.enabled   = req.body.enabled;
    config.program.lastFM.apiKey    = req.body.apiKey;
    config.program.lastFM.apiSecret = req.body.apiSecret;
    scrobblerApi.updateApiKeys(req.body.apiKey, req.body.apiSecret);

    res.json({});
  });

  // ── Discord webhook config (admin only) ─────────────────────────────────
  velvet.get("/api/v1/admin/discord-webhook/config", (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });
    res.json({
      enabled: config.program.discordWebhook?.enabled === true,
      url:     config.program.discordWebhook?.url    || '',
    });
  });

  velvet.post("/api/v1/admin/discord-webhook/config", async (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });
    const schema = Joi.object({
      enabled: Joi.boolean().required(),
      url:     Joi.string().uri().allow('').required(),
    });
    joiValidate(schema, req.body);

    // Security: only allow discord.com webhook URLs
    if (req.body.url) {
      let parsed;
      try { parsed = new URL(req.body.url); } catch {
        return res.status(400).json({ error: 'Invalid webhook URL' });
      }
      if (parsed.hostname !== 'discord.com' && parsed.hostname !== 'discordapp.com') {
        return res.status(400).json({ error: 'Only discord.com webhook URLs are accepted' });
      }
    }

    await config.updateConfigFile(c => {
      c.discordWebhook = { ...c.discordWebhook, enabled: req.body.enabled, url: req.body.url };
    });

    config.program.discordWebhook.enabled = req.body.enabled;
    config.program.discordWebhook.url     = req.body.url;

    res.json({});
  });

  // ── Custom webhooks config (admin only) ─────────────────────────────────
  velvet.get("/api/v1/admin/custom-webhooks/config", (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });
    const raw = Array.isArray(config.program.customWebhooks) ? config.program.customWebhooks : [];
    const slots = Array.from({ length: 2 }, (_, i) => ({
      name:    String(raw[i]?.name    || '').slice(0, 64),
      url:     String(raw[i]?.url     || ''),
      enabled: raw[i]?.enabled === true,
    }));
    res.json({ webhooks: slots });
  });

  velvet.post("/api/v1/admin/custom-webhooks/config", async (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });
    const slotSchema = Joi.object({
      name:    Joi.string().allow('').max(64).required(),
      url:     Joi.string().uri({ scheme: ['http', 'https'] }).allow('').required(),
      enabled: Joi.boolean().required(),
    });
    const schema = Joi.object({ webhooks: Joi.array().items(slotSchema).max(2).required() });
    joiValidate(schema, req.body);

    await config.updateConfigFile(c => { c.customWebhooks = req.body.webhooks; });
    config.program.customWebhooks = req.body.webhooks;

    res.json({});
  });

  velvet.post("/api/v1/admin/users/vpaths", async (req, res) => {
    const schema = Joi.object({
      username: Joi.string().required(),
      vpaths: Joi.array().items(Joi.string()).required()
    });
    joiValidate(schema, req.body);

    await admin.editUserVPaths(req.body.username, req.body.vpaths);
    res.json({});
  });

  velvet.post("/api/v1/admin/users/access", async (req, res) => {
    const schema = Joi.object({
      username: Joi.string().required(),
      admin: Joi.boolean().required()
    });
    joiValidate(schema, req.body);

    await admin.editUserAccess(req.body.username, req.body.admin);
    res.json({});
  });

  velvet.post("/api/v1/admin/users/allow-radio-recording", async (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });
    const schema = Joi.object({
      username: Joi.string().required(),
      allow: Joi.boolean().required()
    });
    joiValidate(schema, req.body);
    await admin.editAllowRadioRecording(req.body.username, req.body.allow);
    res.json({});
  });

  velvet.post("/api/v1/admin/users/allow-youtube-download", async (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });
    const schema = Joi.object({
      username: Joi.string().required(),
      allow: Joi.boolean().required()
    });
    joiValidate(schema, req.body);
    await admin.editAllowYoutubeDownload(req.body.username, req.body.allow);
    res.json({});
  });

  velvet.post("/api/v1/admin/users/allow-ai-dj", async (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });
    joiValidate(Joi.object({ username: Joi.string().required(), allow: Joi.boolean().required() }), req.body);
    await admin.editAllowAiDj(req.body.username, req.body.allow);
    res.json({});
  });

  velvet.post("/api/v1/admin/users/allow-upload", async (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });
    const schema = Joi.object({
      username: Joi.string().required(),
      allow: Joi.boolean().required()
    });
    joiValidate(schema, req.body);
    await admin.editAllowUpload(req.body.username, req.body.allow);
    res.json({});
  });

  velvet.post("/api/v1/admin/users/allow-server-remote", async (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });
    const schema = Joi.object({ username: Joi.string().required(), allow: Joi.boolean().required() });
    joiValidate(schema, req.body);
    await admin.editAllowServerRemote(req.body.username, req.body.allow);
    res.json({});
  });

  velvet.post("/api/v1/admin/users/allow-mpv-cast", async (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });
    const schema = Joi.object({ username: Joi.string().required(), allow: Joi.boolean().required() });
    joiValidate(schema, req.body);
    await admin.editAllowMpvCast(req.body.username, req.body.allow);
    res.json({});
  });

  velvet.get("/api/v1/admin/config", (req, res) => {
    res.json({
      address: config.program.address,
      port: config.program.port,
      noUpload: config.program.noUpload,
      writeLogs: config.program.writeLogs,
      logRetention: config.program.logRetention || '14d',
      secret: config.program.secret.slice(-4),
      ssl: config.program.ssl,
      storage: config.program.storage,
      maxRequestSize: config.program.maxRequestSize,
      ui: config.program.ui || 'velvet'
    });
  });

  velvet.post("/api/v1/admin/config/theme", async (req, res) => {
    const schema = Joi.object({ ui: Joi.string().valid('velvet', 'velvet-dark', 'velvet-light').required() });
    joiValidate(schema, req.body);
    await admin.editUi(req.body.ui);
    res.json({});
  });

  velvet.post("/api/v1/admin/config/max-request-size", async (req, res) => {
    const schema = Joi.object({
      maxRequestSize: Joi.string().pattern(/\d+(KB|MB)/i).required()
    });
    joiValidate(schema, req.body);

    await admin.editMaxRequestSize(req.body.maxRequestSize);
    res.json({});
  });

  velvet.post("/api/v1/admin/config/port", async (req, res) => {
    const schema = Joi.object({
      port: Joi.number().required()
    });
    joiValidate(schema, req.body);

    await admin.editPort(req.body.port);
    res.json({});
  });

  velvet.post("/api/v1/admin/config/address", async (req, res) => {
    const schema = Joi.object({
      address: Joi.string().ip({ cidr: 'forbidden' }).required(),
    });
    joiValidate(schema, req.body);

    await admin.editAddress(req.body.address);
    res.json({});
  });

  velvet.post("/api/v1/admin/config/noupload", async (req, res) => {
    const schema = Joi.object({
      noUpload: Joi.boolean().required()
    });
    joiValidate(schema, req.body);

    await admin.editUpload(req.body.noUpload);
    res.json({});
  });

  velvet.post("/api/v1/admin/config/write-logs", async (req, res) => {
    const schema = Joi.object({
      writeLogs: Joi.boolean().required()
    });
    joiValidate(schema, req.body);

    await admin.editWriteLogs(req.body.writeLogs);
    res.json({});
  });

  velvet.post("/api/v1/admin/config/log-retention", async (req, res) => {
    const schema = Joi.object({
      logRetention: Joi.string().valid(...VALID_RETENTIONS).required()
    });
    joiValidate(schema, req.body);

    await admin.editLogRetention(req.body.logRetention);
    res.json({});
  });

  velvet.post("/api/v1/admin/logs/prune", async (req, res) => {
    const retentionDays = Number.parseInt(config.program.logRetention, 10) || 14;
    const deleted = await admin.pruneOldLogs(retentionDays);
    res.json({ deleted });
  });

  velvet.post("/api/v1/admin/config/secret", async (req, res) => {
    const schema = Joi.object({
      strength: Joi.number().integer().min(32).max(512).required()
    });
    joiValidate(schema, req.body);

    const secret = await config.asyncRandom(req.body.strength);
    await admin.editSecret(secret);
    res.json({});
  });

  velvet.get("/api/v1/admin/transcode", (req, res) => {
    const memClone = structuredClone(config.program.transcode);
    memClone.downloaded = transcode.isDownloaded();
    res.json(memClone);
  });

  velvet.post("/api/v1/admin/transcode/enable", async (req, res) => {
    const schema = Joi.object({
      enable: Joi.boolean().required()
    });
    joiValidate(schema, req.body);

    await admin.enableTranscode(req.body.enable);
    res.json({});
  });

  velvet.post("/api/v1/admin/transcode/default-codec", async (req, res) => {
    const schema = Joi.object({
      defaultCodec: Joi.string().valid(...getTransCodecs()).required()
    });
    joiValidate(schema, req.body);

    await admin.editDefaultCodec(req.body.defaultCodec);
    res.json({});
  });

  velvet.post("/api/v1/admin/transcode/default-bitrate", async (req, res) => {
    const schema = Joi.object({
      defaultBitrate: Joi.string().valid(...getTransBitrates()).required()
    });
    joiValidate(schema, req.body);

    await admin.editDefaultBitrate(req.body.defaultBitrate);
    res.json({});
  });

  velvet.post("/api/v1/admin/transcode/default-algorithm", async (req, res) => {
    const schema = Joi.object({
      algorithm: Joi.string().valid(...getTransAlgos()).required()
    });
    joiValidate(schema, req.body);

    await admin.editDefaultAlgorithm(req.body.algorithm);
    res.json({});
  });

  velvet.post("/api/v1/admin/transcode/download", async (req, res) => {
    await transcode.downloadedFFmpeg();
    res.json({});
  });

  velvet.get("/api/v1/admin/logs/download", (req, res) => {
    const archive = new ZipArchive();
    archive.on('error', err => {
      winston.error('Download Error', { stack: err });
      if (!res.headersSent) res.status(500).json({ error: err.message });
    });

    res.attachment(`velvet-logs.zip`);
    archive.pipe(res);

    // Include ONLY the app's own *.log files from the last 7 days. Keeps the
    // shareable bundle small and excludes the winston rotate `.<hash>-audit.json`
    // files, README.md, and any stray sub-folders that may sit in the log dir.
    const logsDir = config.program.storage.logsDirectory;
    const cutoff  = Date.now() - 7 * 24 * 60 * 60 * 1000;
    try {
      for (const name of fs.readdirSync(logsDir)) {
        if (!name.endsWith('.log')) continue;
        const full = path.join(logsDir, name);
        let st;
        try { st = fs.statSync(full); } catch { continue; }
        if (!st.isFile() || st.mtimeMs < cutoff) continue;
        archive.file(full, { name });
      }
    } catch (e) {
      winston.warn('[logs] download: cannot read logs directory: ' + (e?.message || e));
    }
    archive.finalize();
  });

  velvet.get("/api/v1/admin/db/shared", (req, res) => {
    res.json(db.getAllSharedPlaylists());
  });

  velvet.delete("/api/v1/admin/db/shared", (req, res) => {
    const schema = Joi.object({ id: Joi.string().required() });
    joiValidate(schema, req.body);

    db.removeSharedPlaylistById(req.body.id);
    res.json({});
  });

  velvet.delete("/api/v1/admin/db/shared/expired", (req, res) => {
    db.removeExpiredSharedPlaylists();
    res.json({});
  });

  velvet.delete("/api/v1/admin/db/shared/eternal", (req, res) => {
    db.removeEternalSharedPlaylists();
    res.json({});
  });

  velvet.delete("/api/v1/admin/ssl", async (req, res) => {
    if (!config.program.ssl?.cert) { throw new WebError('No Certs', 404); }
    await admin.removeSSL();
    res.json({});
  });

  velvet.post("/api/v1/admin/ssl", async (req, res) => {
    const schema = Joi.object({
      cert: Joi.string().required(),
      key: Joi.string().required()
    });
    joiValidate(schema, req.body);

    const sslRoots = [
      path.dirname(config.configFile),
      path.join('/etc', 'letsencrypt', 'live'),
      path.join('/etc', 'letsencrypt', 'archive'),
      path.join('/etc', 'ssl', 'certs'),
      path.join('/etc', 'ssl', 'private'),
    ];
    await admin.setSSL(
      resolveExistingFileWithinRoots(req.body.cert, sslRoots),
      resolveExistingFileWithinRoots(req.body.key, sslRoots)
    );
    res.json({});
  });

  // ── Discogs config ───────────────────────────────────────────
  velvet.get("/api/v1/admin/discogs/config", (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });
    res.json({
      enabled:        config.program.discogs?.enabled !== false,
      allowArtUpdate: config.program.discogs?.allowArtUpdate || false,
      allowId3Edit:   config.program.scanOptions?.allowId3Edit || false,
      apiKey:         config.program.discogs?.apiKey         || '',
      apiSecret:      config.program.discogs?.apiSecret      || '',
      userAgentTag:   config.program.discogs?.userAgentTag   || '',
      itunesEnabled:  config.program.discogs?.itunesEnabled  !== false,
      deezerEnabled:  config.program.discogs?.deezerEnabled  !== false,
    });
  });

  velvet.post("/api/v1/admin/discogs/config", async (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });
    const schema = Joi.object({
      enabled:        Joi.boolean().required(),
      allowArtUpdate: Joi.boolean().required(),
      apiKey:         Joi.string().allow('').required(),
      apiSecret:      Joi.string().allow('').required(),
      userAgentTag:   Joi.string().allow('').pattern(/^[a-zA-Z0-9]{0,4}$/).required(),
      itunesEnabled:  Joi.boolean().required(),
      deezerEnabled:  Joi.boolean().required(),
    });
    joiValidate(schema, req.body);

    await config.updateConfigFile(c => {
      c.discogs = {
        ...c.discogs,
        enabled:        req.body.enabled,
        allowArtUpdate: req.body.allowArtUpdate,
        apiKey:         req.body.apiKey,
        apiSecret:      req.body.apiSecret,
        userAgentTag:   req.body.userAgentTag,
        itunesEnabled:  req.body.itunesEnabled,
        deezerEnabled:  req.body.deezerEnabled,
      };
    });

    config.program.discogs.enabled        = req.body.enabled;
    config.program.discogs.allowArtUpdate = req.body.allowArtUpdate;
    config.program.discogs.apiKey         = req.body.apiKey;
    config.program.discogs.apiSecret      = req.body.apiSecret;
    config.program.discogs.userAgentTag   = req.body.userAgentTag;
    config.program.discogs.itunesEnabled  = req.body.itunesEnabled;
    config.program.discogs.deezerEnabled  = req.body.deezerEnabled;

    res.json({});
  });

  // ── Lyrics config ────────────────────────────────────────────
  velvet.get("/api/v1/admin/lyrics/config", (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });
    res.json({
      enabled: config.program.lyrics?.enabled !== false,
    });
  });

  velvet.post("/api/v1/admin/lyrics/config", async (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });
    const schema = Joi.object({ enabled: Joi.boolean().required() });
    joiValidate(schema, req.body);

    await config.updateConfigFile(c => { c.lyrics = { ...c.lyrics, enabled: req.body.enabled }; });

    if (!config.program.lyrics) config.program.lyrics = {};
    config.program.lyrics.enabled = req.body.enabled;

    res.json({});
  });

  // ── AcoustID config ───────────────────────────────────────────
  velvet.get("/api/v1/admin/acoustid/config", (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });
    const apiKey = config.program.acoustid?.apiKey || '';
    // Mask the key — show first 6 chars + asterisks so admin can confirm which key is set
    const maskedKey = apiKey.length > 6
      ? apiKey.slice(0, 6) + '*'.repeat(apiKey.length - 6)
      : apiKey.replaceAll('.', '*');
    res.json({
      enabled: config.program.acoustid?.enabled === true,
      apiKey:  maskedKey,
      hasKey:  apiKey.length >= 4,
    });
  });

  velvet.post("/api/v1/admin/acoustid/config", async (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });
    const schema = Joi.object({
      enabled: Joi.boolean().required(),
      // Allow empty string (clearing key) or a non-empty key string
      apiKey:  Joi.string().allow('').max(64).required(),
    });
    joiValidate(schema, req.body);

    // If apiKey is the masked value (contains asterisks) from the GET response,
    // the admin didn't change it — preserve the existing stored key instead of saving asterisks.
    const incomingKey = req.body.apiKey.trim();
    const isUnchangedMask = incomingKey.includes('*') && incomingKey.length > 0;
    const newKey = isUnchangedMask ? (config.program.acoustid?.apiKey || '') : incomingKey;

    await config.updateConfigFile(c => { c.acoustid = { ...c.acoustid, enabled: req.body.enabled, apiKey: newKey }; });

    if (!config.program.acoustid) config.program.acoustid = {};
    config.program.acoustid.enabled = req.body.enabled;
    config.program.acoustid.apiKey  = newKey;

    res.json({});
  });

  // ── Reverse-proxy trusted-header auth (ExtAuth) ──────────────────────────
  velvet.get("/api/v1/admin/ext-auth", (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });
    const cfg = config.program.extAuth || {};
    const secret = cfg.secretValue || '';
    const maskedSecret = secret.length > 4
      ? secret.slice(0, 4) + '*'.repeat(secret.length - 4)
      : (secret ? '*'.repeat(secret.length) : '');
    res.json({
      enabled:          cfg.enabled === true,
      headerName:       cfg.headerName || 'Remote-User',
      trustedProxies:   cfg.trustedProxies || [],
      secretHeaderName: cfg.secretHeaderName || '',
      secretValue:      maskedSecret,
      hasSecret:        secret.length > 0,
      autoCreateUsers:  cfg.autoCreateUsers === true,
      // Helps the admin UI warn when the server also listens on a non-loopback
      // interface without a proxy allowlist — a likely direct-exposure bypass.
      listenAddress:    config.program.address,
    });
  });

  velvet.post("/api/v1/admin/ext-auth", async (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });
    const schema = Joi.object({
      enabled:          Joi.boolean().required(),
      headerName:       Joi.string().min(1).max(128).required(),
      trustedProxies:   Joi.array().items(Joi.string().max(64)).required(),
      secretHeaderName: Joi.string().allow('').max(128).required(),
      // Allow empty (no secret) or the masked value (unchanged) or a new value
      secretValue:      Joi.string().allow('').max(256).required(),
      autoCreateUsers:  Joi.boolean().required(),
    });
    joiValidate(schema, req.body);

    const isUnchangedMask = req.body.secretValue.includes('*') && req.body.secretValue.length > 0;
    const newSecret = isUnchangedMask ? (config.program.extAuth?.secretValue || '') : req.body.secretValue;

    const newExtAuth = {
      enabled:          req.body.enabled,
      headerName:       req.body.headerName,
      trustedProxies:   req.body.trustedProxies,
      secretHeaderName: req.body.secretHeaderName,
      secretValue:      newSecret,
      autoCreateUsers:  req.body.autoCreateUsers,
    };

    await config.updateConfigFile(c => { c.extAuth = newExtAuth; });

    config.program.extAuth = newExtAuth;

    res.json({});
  });

  // ── Genre Groups (admin-configurable display groupings) ─────────────────
  velvet.get('/api/v1/admin/genre-groups', (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });
    try {
      const savedGroups = db.getGenreGroups();
      const rawRows = db.getGenres(req.user.vpaths);
      const { genres: merged, rawMap } = mergeGenreRows(rawRows);
      const allGenres = merged.map(g => g.genre); // merged display names
      const allGenreSet = new Set(allGenres);
      // Build reverse map: raw DB string → merged display name
      const rawToDisplay = new Map();
      for (const [display, rawSet] of rawMap) for (const raw of rawSet) rawToDisplay.set(raw, display);
      const normalizeGenre = g => allGenreSet.has(g) ? g : (rawToDisplay.get(g) || null);
      const isDefault = !savedGroups || savedGroups.length === 0;
      let groups;
      if (isDefault) {
        groups = autoGroupGenres(allGenres);
      } else {
        // Normalize any old raw strings to display names; drop genres not in current library
        groups = savedGroups.map(grp => ({
          name: grp.name,
          genres: [...new Set(grp.genres.map(normalizeGenre).filter(Boolean))],
        }));
      }
      res.json({ groups, allGenres, isDefault });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  velvet.post('/api/v1/admin/genre-groups', (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });
    const schema = Joi.array().items(
      Joi.object({
        name:   Joi.string().max(120).required(),
        genres: Joi.array().items(Joi.string().max(200)).required(),
      })
    );
    const { error, value } = schema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });
    try {
      db.saveGenreGroups(value);
      res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ── ID3 tag write ────────────────────────────────────────────
  velvet.post('/api/v1/admin/tags/write', async (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });
    if (!config.program.scanOptions?.allowId3Edit) return res.status(403).json({ error: 'ID3 editing not enabled in admin settings' });

    const schema = Joi.object({
      filepath: Joi.string().required(),
      title:    Joi.string().allow('').optional(),
      artist:   Joi.string().allow('').optional(),
      album:    Joi.string().allow('').optional(),
      year:     Joi.alternatives().try(Joi.string().allow(''), Joi.number()).optional(),
      genre:    Joi.string().allow('').optional(),
      track:    Joi.alternatives().try(Joi.string().allow(''), Joi.number()).optional(),
      disk:     Joi.alternatives().try(Joi.string().allow(''), Joi.number()).optional(),
    });
    joiValidate(schema, req.body);

    let pathInfo;
    try { pathInfo = getVPathInfo(req.body.filepath, req.user); } catch (e) { return res.status(400).json({ error: e.message }); }
    const absPath = pathInfo.fullPath;
    if (!fs.existsSync(absPath)) return res.status(404).json({ error: 'File not found' });

    const b = req.body;
    try {
      await writeTags(absPath, {
        title: b.title, artist: b.artist, album: b.album, date: b.year,
        genre: b.genre, track: b.track, disc: b.disk,
      });
      _updateTagsInDb(pathInfo, req.body, absPath);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Wrapped admin: stats + purge ──────────────────────────────────────────
  velvet.get('/api/v1/admin/wrapped/stats', (req, res) => {
    res.json(db.getWrappedAdminStats());
  });

  velvet.post('/api/v1/admin/wrapped/purge', (req, res) => {
    const schema = Joi.object({
      userId: Joi.string().required(),
      fromMs: Joi.number().integer().min(0).required(),
      toMs:   Joi.number().integer().min(0).required(),
    });
    const { value } = joiValidate(schema, req.body);
    if (value.toMs < value.fromMs) return res.status(400).json({ error: 'toMs must be >= fromMs' });
    const deleted = db.purgePlayEvents(value.userId, value.fromMs, value.toMs);
    res.json({ ok: true, deleted });
  });

  // GET /api/v1/admin/artists/rebuild-status
  velvet.get('/api/v1/admin/artists/rebuild-status', (req, res) => {
    res.json(_artistRebuildState);
  });

  // POST /api/v1/admin/artists/rebuild-index
  // Starts a background rebuild and returns immediately so the UI can show
  // a loader/poll status without reverse-proxy timeouts.
  velvet.post('/api/v1/admin/artists/rebuild-index', (req, res) => {
    if (_artistRebuildState.running) {
      return res.status(409).json({ ok: false, running: true, error: 'Artist index rebuild already running' });
    }

    _artistRebuildState = {
      running: true,
      startedAt: Date.now(),
      finishedAt: null,
      lastError: null,
    };
    res.json({ ok: true, started: true });

    db.rebuildArtistIndex((err) => {
      _artistRebuildState.running = false;
      _artistRebuildState.finishedAt = Date.now();
      _artistRebuildState.lastError = err ? String(err.message ?? err) : null;
      invalidateArtistCache();
    });
  });

  // GET /api/v1/admin/wrapped/backfill-folder-metadata/preview
  // Returns how many files have missing artist tags + up to 8 derivation examples.
  velvet.get('/api/v1/admin/wrapped/backfill-folder-metadata/preview', (req, res) => {
    try {
      res.json(db.previewFolderMetadata());
    } catch (err) {
      winston.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/v1/admin/wrapped/backfill-folder-metadata
  // For files with no artist tag, derive artist/album/title from the folder name.
  velvet.post('/api/v1/admin/wrapped/backfill-folder-metadata', async (req, res) => {
    try {
      const updated = db.backfillFolderMetadata();
      res.json({ ok: true, updated });
      db.rebuildArtistIndex(invalidateArtistCache);
    } catch (err) {
      winston.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Server Audio (mpv) Admin API ──────────────────────────────────────────

  // GET /api/v1/admin/server-audio — get current config + running state
  velvet.get('/api/v1/admin/server-audio', (req, res) => {
    const sa = config.program.serverAudio || {};
    res.json({
      enabled: sa.enabled || false,
      mpvBin:  sa.mpvBin  || 'mpv',
      autoUnmute: sa.autoUnmute !== false,
      running: serverPlaybackApi.isRunning(),
    });
  });

  // POST /api/v1/admin/server-audio — update config (enabled, mpvBin)
  velvet.post('/api/v1/admin/server-audio', async (req, res) => {
    const schema = Joi.object({
      enabled: Joi.boolean().optional(),
      mpvBin:  Joi.string().optional(),
      autoUnmute: Joi.boolean().optional(),
    }).min(1);
    joiValidate(schema, req.body);

    if (!config.program.serverAudio) config.program.serverAudio = {};
    if (req.body.enabled !== undefined) config.program.serverAudio.enabled = req.body.enabled;
    if (req.body.mpvBin  !== undefined) config.program.serverAudio.mpvBin  = req.body.mpvBin;
    if (req.body.autoUnmute !== undefined) config.program.serverAudio.autoUnmute = req.body.autoUnmute;

    await config.updateConfigFile(c => {
      if (!c.serverAudio) c.serverAudio = {};
      if (req.body.enabled !== undefined) c.serverAudio.enabled = req.body.enabled;
      if (req.body.mpvBin  !== undefined) c.serverAudio.mpvBin  = req.body.mpvBin;
      if (req.body.autoUnmute !== undefined) c.serverAudio.autoUnmute = req.body.autoUnmute;
    });

    if (req.body.enabled === true)  serverPlaybackApi.bootMpv();
    if (req.body.enabled === false) serverPlaybackApi.killMpv();

    res.json({});
  });

  // POST /api/v1/admin/server-audio/start — start mpv without changing config
  velvet.post('/api/v1/admin/server-audio/start', (req, res) => {
    serverPlaybackApi.bootMpv();
    res.json({ running: serverPlaybackApi.isRunning() });
  });

  // POST /api/v1/admin/server-audio/stop — stop mpv without changing config
  velvet.post('/api/v1/admin/server-audio/stop', (req, res) => {
    serverPlaybackApi.killMpv();
    res.json({ running: false });
  });

  // ── Languages config ──────────────────────────────────────────
  const _ALL_LANG_CODES = ['en','nl','de','fr','es','it','pt','pl','ru','zh','ja','ko'];

  velvet.get('/api/v1/admin/languages/config', (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });
    res.json({ enabled: config.program.languages?.enabled || _ALL_LANG_CODES });
  });

  velvet.post('/api/v1/admin/languages/config', async (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });
    const schema = Joi.object({
      enabled: Joi.array().items(Joi.string().max(5)).min(1).required()
    });
    joiValidate(schema, req.body);

    // English is always first and always present
    const enabled = ['en', ...req.body.enabled.filter(c => c !== 'en' && _ALL_LANG_CODES.includes(c))];

    await config.updateConfigFile(c => { c.languages = { ...c.languages, enabled }; });

    if (!config.program.languages) config.program.languages = {};
    config.program.languages.enabled = enabled;

    res.json({});
  });

  // ── GET /api/v1/admin/diagnostics/artist-albums?artist=Riverside ───────────
  // Diagnoses why albums may be missing from the artist view for a given artist.
  // Returns three diagnostic sections:
  //   1. effectiveArtistValues — all distinct COALESCE(album_artist, artist)
  //      values in `files` for tracks that mention the artist anywhere.
  //      Any value NOT in rawVariants will produce invisible albums.
  //   2. normalizedEntry — what artists_normalized knows about this artist:
  //      canonicalName, rawVariants, vpaths_json, song_count.
  //   3. albumsByVariant — per-variant album count in the DB, so you can see
  //      exactly which spelling has which albums.
  velvet.get('/api/v1/admin/diagnostics/artist-albums', (req, res) => {
    const artistParam = String(req.query.artist || '').trim();
    if (!artistParam) {
      return res.status(400).json({ error: 'Missing ?artist= parameter' });
    }
    const effectiveRows = db.diagEffectiveArtistValues(artistParam);
    const normRow = db.diagNormalizedArtist(artistParam);

    let rawVariants = [];
    if (normRow) {
      try { rawVariants = JSON.parse(normRow.artist_raw_variants); } catch { rawVariants = [normRow.artist_clean]; }
    }

    const albumsByVariant = {};
    for (const variant of rawVariants) albumsByVariant[variant] = db.diagAlbumsForEffectiveArtist(variant);

    // Albums that match the search but whose effective artist is NOT in rawVariants
    const variantSet = new Set(rawVariants.map(v => v.toLowerCase()));
    const orphanAlbums = effectiveRows
      .filter(r => !variantSet.has((r.effective || '').toLowerCase()))
      .map(r => ({ effective: r.effective, track_count: r.track_count, albums: db.diagAlbumsForEffectiveArtist(r.effective) }));

    res.json({
      query: artistParam,
      normalizedEntry: normRow ? {
        canonicalName: normRow.artist_clean,
        rawVariants,
        vpaths: (() => { try { return JSON.parse(normRow.vpaths_json); } catch { return []; } })(),
        songCount: normRow.song_count,
      } : null,
      effectiveArtistValues: effectiveRows,
      albumsByVariant,
      orphanAlbums,
      summary: {
        totalEffectiveValues: effectiveRows.length,
        coveredByVariants: effectiveRows.filter(r => variantSet.has((r.effective || '').toLowerCase())).length,
        orphanedValues: orphanAlbums.length,
        orphanedAlbumCount: orphanAlbums.reduce((s, o) => s + o.albums.length, 0),
      }
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// probeHasAudio(absFilepath)
// Returns true when ffprobe finds at least one audio stream with a non-zero
// sample rate and channel count.  Used to detect completely zeroed / truncated
// files before wasting a remux attempt.
// ─────────────────────────────────────────────────────────────────────────────
async function probeHasAudio(absFilepath) {
  const ffprobePath = ffprobeBin();
  if (!fs.existsSync(ffprobePath)) return true; // can't probe — optimistically try remux

  try {
    const stdout = await new Promise((resolve, reject) => {
      const args = [
        '-v', 'error',
        '-select_streams', 'a:0',
        '-show_entries', 'stream=codec_type,channels,sample_rate',
        '-of', 'csv=p=0',
        absFilepath
      ];
      const proc = child.spawn(ffprobePath, args);
      let out = '';
      proc.stdout.on('data', d => { out += d.toString(); });
      proc.on('close', _code => resolve(out.trim()));
      proc.on('error', reject);
    });
    // stdout looks like "audio,2,44100" — valid if we have channels > 0 and sample_rate > 0
    if (!stdout) return false;
    const parts = stdout.split(',');
    const channels   = Number.parseInt(parts[1], 10) || 0;
    const sampleRate = Number.parseInt(parts[2], 10) || 0;
    return channels > 0 && sampleRate > 0;
  } catch {
    return true; // probe failed for unexpected reason — let remux try anyway
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// remuxAudio(absFilepath)
// Re-muxes an audio file with ffmpeg to fix corrupt tag blocks that prevent
// music-metadata from reading it (e.g. APEv2 RangeError on MP3, invalid FLAC
// headers, broken WAV RIFF chunks).  For MP3 the APEv2 tag block is stripped
// and a clean ID3v2.3 header is written.  For all formats the audio stream is
// stream-copied (lossless, no re-encode) and all text metadata is preserved.
// The in-place rewrite also bumps mtime so the next scan re-processes the file.
// Caller must verify the file exists before calling this function.
// ─────────────────────────────────────────────────────────────────────────────
/** Silently delete a temp file; errors are non-fatal */
function _cleanupTmp(tmp) {
  try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e) { console.debug('[velvet]', e?.message ?? e); }
}

/** Run the stream-copy ffmpeg pass; resolves on success, rejects with Error on failure */
function _runFfmpegStreamCopy(ffmpegBin, absFilepath, tmp, isFlac, isMp3, isWav) {
  return new Promise((resolve, reject) => {
    // -fflags +genpts: generate PTS from DTS when PTS is missing (placed before -i so it
    // applies to the input demuxer).  Stream-copy preserves whatever the demuxer reads,
    // so generated PTS flow through to the output — fixing "PTS is not defined" for
    // Chrome's FFmpegDemuxer without needing a lossy re-encode.
    const args = ['-y', '-fflags', '+genpts'];
    if (isFlac) args.push('-f', 'flac');
    args.push('-i', absFilepath, '-vn', '-c:a', 'copy', '-map_metadata', '0');
    if (isMp3) args.push('-write_apetag', '0', '-id3v2_version', '3');
    if (isWav) args.push('-write_id3v2', '0');
    args.push(tmp);

    const proc = child.spawn(ffmpegBin, args);
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => {
      if (code === 0) return resolve();
      reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-600)}`));
    });
    proc.on('error', reject);
  });
}

/** Run the FLAC re-encode ffmpeg pass with error tolerance */
function _runFfmpegReencode(ffmpegBin, absFilepath, tmp) {
  return new Promise((resolve, reject) => {
    const args2 = [
      '-y',
      '-err_detect', 'ignore_err',
      '-i', absFilepath,
      '-fflags', '+discardcorrupt',
      '-vn', '-c:a', 'flac', '-map_metadata', '0',
      tmp
    ];
    const proc2 = child.spawn(ffmpegBin, args2);
    let stderr2 = '';
    proc2.stderr.on('data', d => { stderr2 += d.toString(); });
    proc2.on('close', code => {
      if (code !== 0) return reject(new Error(`ffmpeg re-encode exited ${code}: ${stderr2.slice(-600)}`));
      const outSize = fs.existsSync(tmp) ? fs.statSync(tmp).size : 0;
      if (outSize < 1024) return reject(new Error(`re-encode produced empty output (${outSize} bytes)`));
      resolve();
    });
    proc2.on('error', reject);
  });
}

async function remuxAudio(absFilepath) {
  const ffmpegPath = ffmpegBin();
  if (!fs.existsSync(ffmpegPath)) return { ok: false, reason: 'ffmpeg binary not found' };

  const dir  = path.dirname(absFilepath);
  const base = path.basename(absFilepath, path.extname(absFilepath));
  const ext  = path.extname(absFilepath);
  const tmp  = path.join(dir, `.__velvet_fix_${base}${ext}`);

  const extLc  = ext.toLowerCase();
  const isFlac = extLc === '.flac';
  const isMp3  = extLc === '.mp3';
  const isWav  = extLc === '.wav';

  // For FLAC: force -f flac so ffmpeg seeks past any prepended ID3v2 header to
  // the fLaC marker. -vn excludes image streams, -c:a copy is lossless.
  // For MP3: strip APEv2 footer (causes RangeError in music-metadata) and write
  // clean ID3v2.3. For WAV: omit ID3v2 block from RIFF container.
  try {
    await _runFfmpegStreamCopy(ffmpegPath, absFilepath, tmp, isFlac, isMp3, isWav);
    fs.renameSync(tmp, absFilepath);
    return { ok: true };
  } catch (streamCopyErr) {
    _cleanupTmp(tmp);

    // Stream-copy failed (e.g. corrupt FLAC frames).  For FLAC, try a re-encode
    // with error tolerance so surviving audio is salvaged with silence gaps.
    if (!isFlac) {
      console.error(`[scan-error-fix] remuxAudio failed for ${absFilepath}: ${streamCopyErr.message}`);
      return { ok: false, unrecoverable: true, reason: streamCopyErr.message };
    }

    try {
      await _runFfmpegReencode(ffmpegPath, absFilepath, tmp);
      fs.renameSync(tmp, absFilepath);
      return { ok: true, reencoded: true };
    } catch (reEncodeErr) {
      _cleanupTmp(tmp);
      console.error(`[scan-error-fix] FLAC re-encode also failed for ${absFilepath}: ${reEncodeErr.message}`);
      return { ok: false, unrecoverable: true, reason: reEncodeErr.message };
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// stripEmbeddedImages(absFilepath)
// Uses the bundled ffmpeg binary to copy the audio stream and all text metadata
// while discarding every video/image stream (embedded cover art, PICTURE blocks
// etc.).  This resolves UnexpectedFileContentError and InvalidCharacterError
// raised by music-metadata when it tries to parse those malformed image tags.
// The file is rewritten in-place via a temp file so the original is never
// truncated before the new file is confirmed complete.
// Caller must verify the file exists before calling this function.
// ─────────────────────────────────────────────────────────────────────────────
async function stripEmbeddedImages(absFilepath) {
  const ffmpegPath = ffmpegBin();
  if (!fs.existsSync(ffmpegPath)) {
    return { ok: false, reason: 'ffmpeg binary not found' };
  }

  const dir  = path.dirname(absFilepath);
  const base = path.basename(absFilepath, path.extname(absFilepath));
  const ext  = path.extname(absFilepath);
  const tmp  = path.join(dir, `.__velvet_fix_${base}${ext}`);

  // For WAV files: suppress ID3 tag output — the malformed id3 chunk in the
  // RIFF container (which caused UnexpectedFileContentError) must not be
  // re-written by ffmpeg into the output file.
  const isWav = ext.toLowerCase() === '.wav';

  try {
    await new Promise((resolve, reject) => {
      // -map 0:a        : keep only audio streams — drops all image/video streams
      // -c:a copy       : stream-copy (no re-encode, lossless)
      // -map_metadata 0 : preserve all text tags (title, artist, album, etc.)
      // -write_id3v2 0  : (WAV only) do NOT write an ID3v2 block into the output
      const args = ['-y', '-i', absFilepath, '-map', '0:a', '-c:a', 'copy', '-map_metadata', '0'];
      if (isWav) args.push('-write_id3v2', '0');
      args.push(tmp);

      const proc = child.spawn(ffmpegPath, args);
      let stderr = '';
      proc.stderr.on('data', d => { stderr += d.toString(); });
      proc.on('close', code => {
        if (code === 0) return resolve();
        reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-400)}`));
      });
      proc.on('error', reject);
    });

    fs.renameSync(tmp, absFilepath);
    return { ok: true };
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e) { console.debug('[velvet]', e?.message ?? e); }
    return { ok: false, reason: e.message };
  }
}

// ── Folder-flag helpers ────────────────────────────────────────────────────────

/**
 * Returns an error string if the flag combination is invalid for the folder type,
 * or null if valid.
 */
function _validateFolderFlags(folder, { allowRecordDelete, albumsOnly, dlnaEnabled, artistsOn }) {
  const isRecordingType = folder.type === 'recordings' || folder.type === 'youtube';
  if (allowRecordDelete !== undefined && !isRecordingType) {
    return 'only recordings/youtube folders support allowRecordDelete';
  }
  if (albumsOnly !== undefined && isRecordingType) {
    return 'recordings/youtube folders are not included in the albums view';
  }
  if (dlnaEnabled !== undefined && (isRecordingType || folder.type === 'excluded')) {
    return 'only indexed music/audiobooks folders support DLNA/UPnP';
  }
  if (artistsOn !== undefined && folder.type === 'excluded') {
    return 'excluded folders are never included in artist features';
  }
  return null;
}

/**
 * Sets or deletes a boolean flag on a folder config object.
 * When deleteOnFalse is true, a false value removes the key instead of setting it.
 */
function _applyFolderFlag(folderObj, key, value, deleteOnFalse = false) {
  if (value === undefined) return;
  if (value || !deleteOnFalse) folderObj[key] = value;
  else delete folderObj[key];
}
