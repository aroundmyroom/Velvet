import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import Joi from 'joi';
import winston from 'winston';
import * as config from '../state/config.js';
import { ensureFfmpeg, getFfmpegDir } from '../util/ffmpeg-bootstrap.js';
import { getDirname } from '../util/esm-helpers.js';
import { downloadToFile } from '../util/bootstrap-helpers.js';
import { dbFilepath } from '../util/db-filepath.js';
import { resolvesToPrivate } from '../util/ssrf-check.js';
import { canEmbedCover, embedCover, writeAudioWithTags } from '../util/ffmpeg-tags.js';

const __dirname = getDirname(import.meta.url);
const binaryExt = process.platform === 'win32' ? '.exe' : '';

const BUNDLED_YTDLP = path.join(__dirname, '../../bin/yt-dlp/yt-dlp' + binaryExt);

// Map platform+arch to the correct yt-dlp release asset name
function _ytdlpReleaseAsset() {
  if (process.platform === 'win32') return 'yt-dlp.exe';
  const arch = process.arch;
  if (process.platform === 'darwin') {
    return arch === 'arm64' ? 'yt-dlp_macos' : 'yt-dlp_macos_legacy';
  }
  // Linux
  if (arch === 'arm64' || arch === 'aarch64') return 'yt-dlp_linux_aarch64';
  if (arch === 'arm')                          return 'yt-dlp_linux_armv7l';
  return 'yt-dlp_linux'; // x86_64 + musl (works on Alpine)
}

// Ensure yt-dlp binary is present, downloading it if needed.
// Safe to call multiple times; only downloads once.
let _ytdlpReady = null;
async function _ensureYtdlp() {
  if (_ytdlpReady) return _ytdlpReady;
  _ytdlpReady = (async () => {
    try {
      await fsp.access(BUNDLED_YTDLP, fs.constants.X_OK);
      // Also reject 0-byte files (failed download baked into image)
      const stat = await fsp.stat(BUNDLED_YTDLP);
      if (stat.size > 0) return BUNDLED_YTDLP; // exists, executable, non-empty
      // 0-byte — delete and re-download
      await fsp.unlink(BUNDLED_YTDLP).catch(() => {});
    } catch (e) {
      // File exists but not executable — chmod it and return
      if (e.code === 'EACCES') {
        await fsp.chmod(BUNDLED_YTDLP, 0o750);
        return BUNDLED_YTDLP;
      }
      // File missing — fall through to download
    }

    const asset = _ytdlpReleaseAsset();
    const url   = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`;
    winston.info(`yt-dlp not found or empty — downloading ${asset}…`);
    await fsp.mkdir(path.dirname(BUNDLED_YTDLP), { recursive: true });
    await downloadToFile(url, BUNDLED_YTDLP, 'velvet-ytdlp-installer');
    await fsp.chmod(BUNDLED_YTDLP, 0o750);
    winston.info('yt-dlp downloaded successfully');
    return BUNDLED_YTDLP;
  })().catch(e => {
    _ytdlpReady = null; // allow retry on next call
    throw e;
  });
  return _ytdlpReady;
}

async function _ytdlpBin() {
  try { return await _ensureYtdlp(); } catch (e) {
    winston.warn('yt-dlp auto-download failed: ' + e.message + ' — falling back to system PATH');
    return 'yt-dlp';
  }
}

function _ffmpegDir() {
  return getFfmpegDir();
}

function _ffmpegBin() {
  return path.join(_ffmpegDir(), `ffmpeg${binaryExt}`);
}

// yt-dlp's generic extractor fetches any page, so private hosts are refused up front
async function _urlError(raw) {
  let parsed;
  try { parsed = new URL(raw); } catch { return 'Invalid URL'; }
  if (!['https:', 'http:'].includes(parsed.protocol)) return 'Only http/https URLs are supported';
  if (await resolvesToPrivate(parsed.hostname)) return 'That URL is not allowed';
  return null;
}

function _getUserRecordingFolder(user) {
  const folders = config.program.folders || {};
  const accessible = user.vpaths || [];
  // Prefer a dedicated 'youtube' folder; fall back to 'recordings' if none configured
  for (const vpath of accessible) {
    const f = folders[vpath];
    if (f?.type === 'youtube') return { vpath, root: f.root };
  }
  for (const vpath of accessible) {
    const f = folders[vpath];
    if (f?.type === 'recordings') return { vpath, root: f.root };
  }
  return null;
}

// Strip common YouTube title noise and split "Artist - Title"
function _parseTitle(rawTitle, channelName = '') {
  let artist = channelName;
  let title  = rawTitle    || '';

  const dashIdx = title.indexOf(' - ');
  if (dashIdx > 0) {
    artist = title.slice(0, dashIdx).trim();
    title  = title.slice(dashIdx + 3).trim();
  }

  // Strip common video suffixes
  title = title
    .replaceAll(/\s*\(Official\s+(Video|Audio|Music\s+Video|Lyric\s+Video|Visualizer)\)/gi, '')
    .replaceAll(/\s*\[Official\s+(Video|Audio|Music\s+Video)\]/gi, '')
    .replaceAll(/\s*\(Lyrics?\)/gi, '')
    .replaceAll(/\s*\[Lyrics?\]/gi, '')
    .replaceAll(/\s*\(HD\)/gi, '')
    .replaceAll(/\s*\[HD\]/gi, '')
    .replaceAll(/\s*\(4K\)/gi, '')
    .replaceAll(/\s*\(Audio\)/gi, '')
    .replace(/\s*ft\.?\s+[^([\n]+/i, '')
    .replace(/\s*feat\.?\s+[^([\n]+/i, '')
    .trim();

  return { artist, title };
}

// Run yt-dlp --dump-json and return parsed metadata object
async function _ytdlpInfo(url, ytdlp, ffmpegDir) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ytdlp, [
      '--dump-json', '--no-playlist', '--no-warnings', '--quiet',
      '--ffmpeg-location', ffmpegDir,
      '--', url,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    proc.stdout.on('data', d => out += d);
    proc.stderr.on('data', d => err += d);
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(err.trim() || `yt-dlp exited with code ${code}`));
      try { resolve(JSON.parse(out)); } catch { reject(new Error('Failed to parse yt-dlp output')); }
    });
    proc.on('error', reject);
  });
}

// Download audio + thumbnail via yt-dlp into tmpDir using 'track' as the base name.
// Produces: tmpDir/track.<ext>  and  tmpDir/track.jpg
async function _ytdlpDownload(url, tmpDir, format, ffmpegDir, ytdlp) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ytdlp, [
      '-x', '--audio-format', format,
      '--write-thumbnail', '--convert-thumbnails', 'jpg',
      '--no-playlist', '--no-warnings', '--quiet', '--no-part',
      '--ffmpeg-location', ffmpegDir,
      '-o', path.join(tmpDir, 'track.%(ext)s'),
      '--', url,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    proc.stderr.on('data', d => err += d);
    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(err.trim() || `yt-dlp download failed with code ${code}`));
    });
    proc.on('error', reject);
  });
}

// Re-tag the download (codec copy, no re-encode) into outputFile, with the
// thumbnail as cover when there is one.
async function _ffmpegTag(inputFile, outputFile, { title, artist, album, year, thumbFile }) {
  try { await fsp.access(_ffmpegBin()); } catch {
    await fsp.rename(inputFile, outputFile);
    return;
  }
  const metadata = { title: title || null, artist: artist || null, album: album || null, date: year || null };
  if (thumbFile && canEmbedCover(outputFile)) {
    await embedCover({ input: inputFile, output: outputFile, artPath: thumbFile, metadata });
  } else {
    await writeAudioWithTags({ input: inputFile, output: outputFile, metadata });
  }
}

async function _updateYtdlp() {
  let bin;
  try { bin = await _ensureYtdlp(); } catch { return; }
  return new Promise(resolve => {
    const proc = spawn(bin, ['--update'], { stdio: 'pipe' });
    let out = '';
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => { out += d; });
    proc.on('close', code => {
      const trimmed = out.trim().split('\n').pop() || '';
      if (trimmed) winston.info('yt-dlp update: ' + trimmed);
      if (code !== 0) winston.warn('yt-dlp --update exited ' + code);
      resolve();
    });
    proc.on('error', e => { winston.warn('yt-dlp --update error: ' + e.message); resolve(); });
  });
}

// ── Download tracker (module-scoped, survives multiple setup calls) ────────
const downloadTracker = new Map(); // jobId → { status, url, title, started, filePath?, vpath?, filepath? (DB path), error?, finished? }
let _jobCounter = 0;

function _cleanTracker() {
  const cutoff = Date.now() - 10 * 60 * 1000; // remove finished entries after 10 min
  for (const [id, job] of downloadTracker) {
    if ((job.status === 'done' || job.status === 'error') && job.finished < cutoff) {
      downloadTracker.delete(id);
    }
  }
}

async function _runDownloadJob(jobId, value, recFolder) {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'velvet-ytdl-'));
  let finalFile;
  try {
    const safePart = (s) => (s || '').replaceAll(/[/\\?%*:|"<>]/g, '_').trim();
    const safeTitle  = safePart(value.title)  || 'track';
    const safeArtist = safePart(value.artist);
    const baseName   = safeArtist ? `${safeArtist} - ${safeTitle}`.slice(0, 200) : safeTitle.slice(0, 200);
    const extMap = { mp3: 'mp3', m4a: 'm4a', ogg: 'ogg' };
    const ext = extMap[value.outputCodec] || 'opus';

    await fsp.mkdir(recFolder.root, { recursive: true });
    finalFile = await _resolveNonColliding(recFolder.root, baseName, ext);

    const tmpFile  = path.join(tmpDir, `track.${ext}`);
    const tmpThumb = path.join(tmpDir, 'track.jpg');
    const ytdlp     = await _ytdlpBin();
    const ffmpegDir = _ffmpegDir();

    await _ytdlpDownload(value.url, tmpDir, ext, ffmpegDir, ytdlp);

    const hasThumb = await fsp.access(tmpThumb).then(() => true).catch(() => false);
    await _ffmpegTag(tmpFile, finalFile, {
      title: value.title, artist: value.artist, album: value.album, year: value.year,
      thumbFile: hasThumb ? tmpThumb : null,
    });

    downloadTracker.set(jobId, {
      ...downloadTracker.get(jobId),
      status: 'done', filePath: path.basename(finalFile), vpath: recFolder.vpath,
      filepath: dbFilepath(recFolder.vpath, path.basename(finalFile)), finished: Date.now(),
    });
  } catch (err) {
    downloadTracker.set(jobId, {
      ...downloadTracker.get(jobId),
      status: 'error', error: err.message || 'Download failed', finished: Date.now(),
    });
    if (finalFile) await fsp.unlink(finalFile).catch(() => {});
  } finally {
    fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    _cleanTracker();
  }
}

async function _resolveNonColliding(dir, baseName, ext) {
  let candidate = path.join(dir, `${baseName}.${ext}`);
  let suffix = 1;
  while (true) {
    try { await fsp.access(candidate); candidate = path.join(dir, `${baseName}_${suffix}.${ext}`); suffix++; }
    catch { return candidate; }
  }
}

export function setup(velvet) {
  // Ensure yt-dlp and ffmpeg binaries are present — both non-blocking.
  // yt-dlp is a PyInstaller one-file binary: each --update run unpacks ~40 MB
  // into $TMPDIR/_MEI* and leaks it when the process is killed, which the
  // integration tests (NODE_ENV=test via test/helpers/server.mjs) do constantly.
  _ensureYtdlp()
    .then(() => process.env.NODE_ENV === 'test' ? undefined : _updateYtdlp())
    .catch(e => winston.warn('yt-dlp prefetch/update failed: ' + e.message));
  ensureFfmpeg()
    .catch(e => winston.warn('ffmpeg prefetch failed: ' + e.message));

  // ── GET /api/v1/ytdl/metadata?url=... ──────────────────────────────────────
  velvet.get('/api/v1/ytdl/metadata', async (req, res) => {
    if (config.program.noUpload) {
      return res.status(403).json({ error: 'YouTube download is disabled on this server' });
    }
    if (!req.user['allow-youtube-download']) {
      return res.status(403).json({ error: 'YouTube download not enabled for this user' });
    }
    const rawUrl = req.query.url;
    if (!rawUrl) return res.status(400).json({ error: 'url required' });
    const urlError = await _urlError(rawUrl);
    if (urlError) return res.status(400).json({ error: urlError });
    try {
      const ytdlp = await _ytdlpBin();
      const info  = await _ytdlpInfo(rawUrl, ytdlp, _ffmpegDir());
      const { artist, title } = _parseTitle(info.title || '', info.artist || info.uploader || info.channel || '');
      let year = '';
      if (info.release_year) year = String(info.release_year);
      else if (info.release_date) year = info.release_date.substring(0, 4);
      else if (info.upload_date) year = info.upload_date.slice(0, 4);
      const thumbnail = info.thumbnail || null;
      res.json({ title, artist, album: '', year, thumbnail });
    } catch (err) {
      res.status(400).json({ error: err.message || 'Failed to fetch video info' });
    }
  });

  // ── POST /api/v1/ytdl/ ────────────────────────────────────────────────────
  // Body: { url, outputCodec, metadata: { title, artist, album, year } }
  // Matches upstream Velvet API shape. Returns { jobId } immediately;
  // poll GET /api/v1/ytdl/downloads for completion.
  velvet.post('/api/v1/ytdl/', async (req, res) => {
    if (config.program.noUpload) {
      return res.status(403).json({ error: 'YouTube download is disabled on this server' });
    }
    if (!req.user['allow-youtube-download']) {
      return res.status(403).json({ error: 'YouTube download not enabled for this user' });
    }
    const schema = Joi.object({
      url:         Joi.string().required(),
      outputCodec: Joi.string().valid('opus', 'mp3', 'm4a', 'ogg').default('opus'),
      metadata: Joi.object({
        title:  Joi.string().max(200).allow('').optional(),
        artist: Joi.string().max(200).allow('').optional(),
        album:  Joi.string().max(200).allow('').optional(),
        year:   Joi.string().max(4).allow('').optional(),
      }).optional().default({}),
    });
    const { error, value } = schema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });
    const flatMeta = value.metadata || {};
    value.title  = flatMeta.title  || '';
    value.artist = flatMeta.artist || '';
    value.album  = flatMeta.album  || '';
    value.year   = flatMeta.year   || '';
    const urlError = await _urlError(value.url);
    if (urlError) return res.status(400).json({ error: urlError });
    const recFolder = _getUserRecordingFolder(req.user);
    if (!recFolder) {
      return res.status(400).json({ error: 'No recordings folder configured and accessible. Set a folder type to "recordings" in Admin → Folders.' });
    }

    // Return job ID immediately — client polls GET /api/v1/ytdl/downloads
    const jobId = String(++_jobCounter);
    downloadTracker.set(jobId, { status: 'running', url: value.url, title: value.title || value.url, started: Date.now(), user: req.user.username });
    res.json({ jobId, message: 'Download started' });
    _runDownloadJob(jobId, value, recFolder);
  });

  // ── GET /api/v1/ytdl/downloads ─────────────────────────────────────────────
  // Returns the caller's tracked jobs (running + recently completed) keyed by jobId; admins see every user's jobs.
  velvet.get('/api/v1/ytdl/downloads', (req, res) => {
    if (config.program.noUpload) {
      return res.status(403).json({ error: 'YouTube download is disabled on this server' });
    }
    if (!req.user['allow-youtube-download'] && req.user.admin !== true) {
      return res.status(403).json({ error: 'YouTube download not enabled for this user' });
    }
    const out = {};
    for (const [id, job] of downloadTracker) {
      if (req.user.admin === true || job.user === req.user.username) out[id] = job;
    }
    res.json(out);
  });
}
