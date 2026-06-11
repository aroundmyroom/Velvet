import { ZipArchive } from 'archiver';
import path from 'node:path';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import crypto from 'node:crypto';
import { parseFile } from 'music-metadata';
import sharp from 'sharp';
import Joi from 'joi';
import winston from 'winston';
import * as config from '../state/config.js';
import * as vpath from '../util/vpath.js';
import * as db from '../db/manager.js';
import * as shared from '../api/shared.js';
import * as m3u from '../util/m3u.js';
import WebError from '../util/web-error.js';
import { resolvePathWithinRoot } from '../util/path-security.js';

async function downloadM3U(req, res) {
  if (!req.body.path) { throw new WebError('Validation Error', 403); }
  const pathInfo = vpath.getVPathInfo(req.body.path, req.user);
  const playlistParentDir = path.dirname(pathInfo.fullPath);
  const songs = await m3u.readPlaylistSongs(pathInfo.fullPath);

  const archive = new ZipArchive();
  archive.on('error', function (err) {
    winston.error('Download Error', { stack: err });
    res.status(500).json({ error: err.message });
  });

  res.attachment(`${path.basename(req.body.path)}.zip`);
  archive.pipe(res);
  const normalizedBase = pathInfo.basePath.endsWith(path.sep) ? pathInfo.basePath : pathInfo.basePath + path.sep;
  for (const song of songs) {
    const songPath = path.resolve(playlistParentDir, song);
    if (songPath !== pathInfo.basePath && !songPath.startsWith(normalizedBase)) {
      winston.warn(`M3U entry escaped library root: ${song}`);
      continue;
    }
    archive.file(songPath, { name: path.basename(song) });
  }

  archive.file(pathInfo.fullPath, { name: path.basename(pathInfo.fullPath) });
  archive.finalize();
}

async function downloadDir(req, res) {
  if (!req.body.directory) { throw new WebError('Validation Error', 403); }

  const pathInfo = vpath.getVPathInfo(req.body.directory, req.user);
  if (!(await fs.stat(pathInfo.fullPath)).isDirectory()) { throw new Error('Not A Directory'); }

  const archive = new ZipArchive();
  archive.on('error', (err) => {
    winston.error('Download Error', { stack: err })
    res.status(500).json({ error: 'Download Error' });
  });

  res.attachment('velvet-directory.zip');

  archive.pipe(res);

  archive.directory(pathInfo.basePath, false);
  archive.finalize();
}

async function download(req, res, fileArray, filename = 'velvet-download') {
  const maxMb    = config.program.scanOptions.maxZipMb || 500;
  const validFiles = await _preflightZip(fileArray, req.user, maxMb);
  if (!Array.isArray(validFiles)) {
    return res.status(validFiles.code).json(validFiles.body);
  }

  const archive = new ZipArchive();
  archive.on('error', err => {
    winston.error('Download Error', { stack: err });
    if (!res.headersSent) res.status(500).json({ error: 'Archive error' });
  });

  res.attachment(`${filename}.zip`);
  archive.pipe(res);
  for (const { pathInfo, file } of validFiles) {
    archive.file(pathInfo.fullPath, { name: path.basename(file) });
  }
  archive.finalize();
}

export function setup(velvet) {
  velvet.post('/api/v1/download/m3u', (req, res) => {
    // custom wrap download functions to avoid an error with the archiver module
    downloadM3U(req, res).catch(err  => {
      throw err;
    })
  });

  velvet.post('/api/v1/download/directory',  (req, res) => {
    downloadDir(req, res).catch(err => {
      throw err;
    })
  });

  velvet.get('/api/v1/download/shared', (req, res) => {
    if (!req.sharedPlaylistId) { throw new WebError('Missing Playlist Id', 403); }
    const fileArray = shared.lookupPlaylist(req.sharedPlaylistId).playlist;
    download(req, res, fileArray, 'velvet-shared').catch(err => {
      throw err;
    });
  });

  velvet.post('/api/v1/download/zip', (req, res) => {
    const fileArray = JSON.parse(req.body.fileArray);
    const filename = (req.body.filename || 'velvet-download').replaceAll(/[/\\:*?"<>|]/g, '_').slice(0, 120);
    download(req, res, fileArray, filename).catch(err => {
      throw err;
    });
  });

  // Delete a recording file from a recordings-type vpath.
  // Only available when the folder has allowRecordDelete=true.
  velvet.delete('/api/v1/files/recording', async (req, res) => {
    const schema = Joi.object({ filepath: Joi.string().required() });
    const { error, value } = schema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });

    let pathInfo;
    try {
      pathInfo = vpath.getVPathInfo(value.filepath, req.user);
    } catch (e) {
      return res.status(403).json({ error: e.message });
    }

    if (!_isAllowedRecordingPath(pathInfo.fullPath)) {
      return res.status(403).json({ error: 'Not a recordings folder or deletion not permitted' });
    }

    const ext = path.extname(pathInfo.fullPath).toLowerCase().replaceAll('.', '');
    const allowed = config.program.supportedAudioFiles || {};
    if (!allowed[ext]) return res.status(400).json({ error: 'File type not allowed' });

    try {
      await fs.unlink(pathInfo.fullPath);
      const dbFilepath = path.relative(pathInfo.vpath, value.filepath);
      db.removeFileByPath(dbFilepath, pathInfo.vpath);
      winston.info(`Recording deleted by ${req.user.username}: ${pathInfo.fullPath}`);
      res.json({ deleted: true });
    } catch (e) {
      if (e.code === 'ENOENT') return res.status(404).json({ error: 'File not found' });
      winston.error('Failed to delete recording', { stack: e });
      res.status(500).json({ error: 'Failed to delete file' });
    }
  });

  // ── GET /api/v1/files/art?fp=<vpath/filename> ─────────────────────────────
  // Extracts cover art from an audio file (embedded) or a folder image
  // (cover.jpg / folder.jpg / front.jpg etc.) in the same directory.
  // Returns { aaFile: "md5hash.jpg" } which the client can pass to /album-art/.
  // The result is written to the album-art cache directory so subsequent requests
  // (and the scanner) reuse the same cached file — no duplicate writes.
  velvet.get('/api/v1/files/art', async (req, res) => {
    if (!req.query.fp) return res.status(400).json({ error: 'fp required' });

    let pathInfo;
    try {
      pathInfo = vpath.getVPathInfo(req.query.fp, req.user);
    } catch (e) {
      return res.status(403).json({ error: e.message });
    }

    const artDir  = config.program.storage.albumArtDirectory;

    // Helper: cache raw image buffer and return its filename
    async function cacheImage(buf, format) {
      const ext    = format === 'image/png' ? 'png' : 'jpg';
      const hash   = crypto.createHash('sha256').update(buf).digest('hex');
      const aaFile = `${hash}.${ext}`;
      const artPath = path.join(artDir, aaFile);
      if (!fsSync.existsSync(artPath)) {
        await fs.mkdir(artDir, { recursive: true });
        await fs.writeFile(artPath, buf);
      }
      // Generate size thumbnails if not already present
      if (config.program.scanOptions?.compressImage !== false && buf.length >= 100) {
        const zlPath = path.join(artDir, 'zl-' + aaFile);
        const zsPath = path.join(artDir, 'zs-' + aaFile);
        const zmPath = path.join(artDir, 'zm-' + aaFile);
        try {
          if (!fsSync.existsSync(zlPath)) await sharp(buf).resize(256, 256, { fit: 'inside', withoutEnlargement: true }).toFile(zlPath);
          if (!fsSync.existsSync(zsPath)) await sharp(buf).resize(92,  92,  { fit: 'inside', withoutEnlargement: true }).toFile(zsPath);
          if (!fsSync.existsSync(zmPath)) await sharp(buf).resize(512, 512, { fit: 'inside', withoutEnlargement: true }).toFile(zmPath);
        } catch (e) { console.debug('[velvet]', e?.message ?? e); }
      }
      return aaFile;
    }

    try {
      // Guard: if the file doesn't exist on disk, return no-art rather than 500
      if (!fsSync.existsSync(pathInfo.fullPath)) {
        return res.json({ aaFile: null });
      }

      // 1. Try embedded art — only for known audio formats.
      //    Non-audio sidecar files in the same folder (.m3u, .cue, .txt, .pdf …)
      //    are sometimes passed here by the file browser; parseFile would throw on
      //    them which previously caused a 500.
      const AUDIO_EXTS = new Set(['.flac','.mp3','.mp4','.m4a','.aac','.ogg','.opus','.wav','.wma','.ape','.aiff','.aif','.wv','.tta','.tak','.dsf','.dff','.webm','.mka']);
      const fileExt = path.extname(pathInfo.fullPath).toLowerCase();
      let pic;
      if (AUDIO_EXTS.has(fileExt)) {
        const meta = await parseFile(pathInfo.fullPath, { skipCovers: false, duration: false });
        pic = meta.common?.picture?.[0];
      }
      if (pic) {
        return res.json({ aaFile: await cacheImage(pic.data, pic.format) });
      }

      // 2. Fall back to a folder image in the same directory
      const folderDir   = path.dirname(pathInfo.fullPath);
      const candidates  = ['cover.jpg', 'cover.jpeg', 'cover.png', 'folder.jpg', 'folder.jpeg', 'folder.png', 'front.jpg', 'front.jpeg', 'front.png', 'artwork.jpg', 'artwork.jpeg', 'artwork.png'];
      for (const name of candidates) {
        const imgPath = resolvePathWithinRoot(folderDir, name);
        if (fsSync.existsSync(imgPath)) {
          const buf    = await fs.readFile(imgPath);
          const format = name.endsWith('.png') ? 'image/png' : 'image/jpeg';
          return res.json({ aaFile: await cacheImage(buf, format) });
        }
      }

      // 3. Check one level up (parent dir) — covers multi-disc albums where
      //    tracks live in CD1/CD2 subfolders but cover.jpg is in the album root
      const parentDir = path.dirname(folderDir);
      if (parentDir && parentDir !== folderDir) {
        for (const name of candidates) {
          const imgPath = resolvePathWithinRoot(parentDir, name);
          if (fsSync.existsSync(imgPath)) {
            const buf    = await fs.readFile(imgPath);
            const format = name.endsWith('.png') ? 'image/png' : 'image/jpeg';
            return res.json({ aaFile: await cacheImage(buf, format) });
          }
        }
      }

      res.json({ aaFile: null });
    } catch (e) {
      // Art extraction is non-critical — return no-art rather than a 500
      // that would spam the browser console on every file that can't be parsed.
      console.debug('[velvet] art extraction error:', e?.message ?? e);
      res.json({ aaFile: null });
    }
  });
}

async function _preflightZip(fileArray, user, maxMb) {
  const maxBytes  = maxMb * 1024 * 1024;
  let totalBytes  = 0;
  const validFiles = [];
  for (const file of fileArray) {
    try {
      const pathInfo = vpath.getVPathInfo(file, user);
      const stat = await fs.stat(pathInfo.fullPath);
      totalBytes += stat.size;
      if (totalBytes > maxBytes) {
        return { code: 413, body: { error: `ZIP would exceed the ${maxMb} MB server limit`, maxMb, sizeMb: Math.ceil(totalBytes / (1024 * 1024)) } };
      }
      validFiles.push({ pathInfo, file });
    } catch {
      winston.warn(`Skipping file for ZIP (not accessible): ${file}`);
    }
  }
  if (!validFiles.length) return { code: 404, body: { error: 'No accessible files found' } };
  return validFiles;
}

function _isAllowedRecordingPath(fullPath) {
  const allFolders = config.program.folders || {};
  return Object.values(allFolders).some(cfg => {
    if (cfg.type !== 'recordings' || !cfg.allowRecordDelete) return false;
    const base = cfg.root.endsWith(path.sep) ? cfg.root : cfg.root + path.sep;
    return fullPath === cfg.root || fullPath.startsWith(base);
  });
}
