import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { nanoid } from 'nanoid';
import Joi from 'joi';
import * as config from '../state/config.js';
import { joiValidate } from '../util/validation.js';
import { ffmpegBin } from '../util/ffmpeg-bootstrap.js';
import { resolvePathWithinRoot } from '../util/path-security.js';

import { isPrivateHost } from '../util/ssrf-check.js';

// ── Content-Type → file extension map ────────────────────────────────────────
const CT_EXT = {
  'audio/mpeg':      '.mp3',
  'audio/mp3':       '.mp3',
  'audio/aac':       '.aac',
  'audio/x-aac':     '.aac',
  'audio/aacp':      '.aac',
  'audio/flac':      '.flac',
  'audio/x-flac':    '.flac',
  'audio/ogg':       '.ogg',
  'audio/opus':      '.opus',
  'audio/mp4':       '.m4a',
  'audio/x-m4a':     '.m4a',
  'audio/wav':       '.wav',
  'audio/x-wav':     '.wav',
};

function _extFromContentType(ct) {
  if (!ct) return '.mp3';
  const base = ct.split(';')[0].trim().toLowerCase();
  if (/\baacp\b|aac\+/i.test(base)) return '.aac';
  return CT_EXT[base] || '.mp3';
}

// ── Filename sanitiser ────────────────────────────────────────────────────────
// Strips non-ASCII and unsafe filesystem characters, produces short safe name.
function _safeName(str) {
  return String(str || '')
    .replaceAll(/[^\w\s-]/g, '')       // remove anything not word/space/dash
    .replaceAll(/\s+/g, '_')           // spaces → underscores
    .replaceAll(/-+/g, '-')
    .replaceAll(/_+/g, '_')
    .slice(0, 60)
    .replaceAll(/^[-_]+|[-_]+$/g, '')  // trim leading/trailing sep
    || 'recording';
}

// ── Timestamp (UTC) ───────────────────────────────────────────────────────────
function _ts() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}_${pad(d.getUTCHours())}-${pad(d.getUTCMinutes())}-${pad(d.getUTCSeconds())}`;
}

// ── In-memory store for active recordings ────────────────────────────────────
// id → { req, writer, filePath, stationName, startedAt, bytesWritten, username }
const activeRecordings = new Map();

// ── Write-permission test ─────────────────────────────────────────────────────
async function _checkWritable(dir) {
  const rnd   = Math.random().toString(36).slice(2, 9); // NOSONAR: non-security random temp file suffix
  const probe = path.join(dir, `.velvet-rec-probe-${rnd}`);
  try {
    await fsp.writeFile(probe, '', { flag: 'wx' });
    await fsp.unlink(probe);
    return true;
  } catch {
    return false;
  }
}

// ── Remux raw ADTS AAC stream → seekable M4A container via FFmpeg ─────────────
// Raw ADTS .aac files recorded from internet radio are not seekable / may be
// rejected by browsers and many players.  Remuxing into .m4a (MP4 container)
// with -c copy fixes this with zero re-encoding.  Best-effort: returns original
// filePath on any failure so the recording is never lost.
async function _remuxAacToM4a(aacPath) {
  const ext = path.extname(aacPath).toLowerCase();
  if (ext !== '.aac') return aacPath;

  const ffmpegPath = ffmpegBin();
  try { await fsp.access(ffmpegPath); } catch { return aacPath; }

  const m4aPath = aacPath.slice(0, -4) + '.m4a';

  try {
    await new Promise((resolve, reject) => {
      const proc = spawn(ffmpegPath,
        ['-y', '-i', aacPath, '-c', 'copy', '-movflags', '+faststart', m4aPath],
        { stdio: 'pipe' });
      proc.on('close', code => (code === 0 ? resolve() : reject(new Error(`FFmpeg exited ${code}`))));
      proc.on('error', reject);
    });
    await fsp.unlink(aacPath);
    console.info(`[radio-recorder] Remuxed ${path.basename(aacPath)} → ${path.basename(m4aPath)}`);
    return m4aPath;
  } catch (err) {
    console.error(`[radio-recorder] AAC→M4A remux failed: ${err.message}`);
    try { await fsp.unlink(m4aPath); } catch (e) { console.debug('[velvet]', e?.message ?? e); }
    return aacPath;
  }
}

// ── Embed cover art into a recorded audio file via FFmpeg ─────────────────────
// Best-effort: returns original filePath on any failure.
async function _embedCoverArt(audioPath, artFilename) {
  // Security: artFilename must be a bare filename — no path separators or traversal
  if (!artFilename || /[/\\]/.test(artFilename)) return audioPath;

  const ext = path.extname(audioPath).toLowerCase();
  // Only formats where FFmpeg cover-art embedding is well-supported
  if (!['.mp3', '.m4a', '.aac', '.flac'].includes(ext)) return audioPath;

  let artPath;
  try {
    artPath = resolvePathWithinRoot(config.program.storage.albumArtDirectory, artFilename);
  } catch {
    return audioPath;
  }
  try { await fsp.access(artPath); } catch { return audioPath; }  // art file missing

  const ffmpegPath = ffmpegBin();
  if (!ffmpegPath) return audioPath;
  try { await fsp.access(ffmpegPath); } catch { return audioPath; }  // ffmpeg not present

  const tmpPath = audioPath + '.art-tmp' + ext;

  const args = ext === '.mp3'
    ? ['-y', '-i', audioPath, '-i', artPath,
       '-map', '0:a', '-map', '1:v',
       '-c:a', 'copy', '-c:v', 'mjpeg',
       '-id3v2_version', '3',
       '-metadata:s:v', 'title=Album cover',
       '-metadata:s:v', 'comment=Cover (front)',
       tmpPath]
    : ['-y', '-i', audioPath, '-i', artPath,
       '-map', '0:a', '-map', '1:v',
       '-c:a', 'copy', '-c:v', 'copy',
       '-disposition:v:0', 'attached_pic',
       tmpPath];

  try {
    await new Promise((resolve, reject) => {
      const proc = spawn(ffmpegPath, args, { stdio: 'pipe' });
      proc.on('close', code => (code === 0 ? resolve() : reject(new Error(`FFmpeg exited ${code}`))));
      proc.on('error', reject);
    });
    await fsp.rename(tmpPath, audioPath);
  } catch (err) {
    console.error(`[radio-recorder] cover-art embed failed for ${path.basename(audioPath)}: ${err.message}`);
    try { await fsp.unlink(tmpPath); } catch (e) { console.debug('[velvet]', e?.message ?? e); }
  }
  return audioPath;
}

// ── Auto-stop a recording when max duration is reached ────────────────────────
async function _autoStopRecording(id) {
  const rec = activeRecordings.get(id);
  if (!rec) return;

  rec.upRes.unpipe(rec.writer);
  rec.upReq.destroy();
  activeRecordings.delete(id);

  await new Promise(resolve => {
    if (rec.writer.writableEnded) { resolve(); return; }
    rec.writer.on('finish', resolve);
    rec.writer.on('error', resolve);
    rec.writer.end();
  });

  rec.filePath = await _remuxAacToM4a(rec.filePath);
  if (rec.artFile) {
    await _embedCoverArt(rec.filePath, rec.artFile);
  }
  console.info(`[radio-recorder] Auto-stopped recording ${id} after max duration`);
}

// ── Internal start helper (called by HTTP endpoint + scheduler) ───────────────
// SSRF check and vpath validation must be done by the caller.
// Returns: Promise<{ id, relPath, filename }>
export function startStreamRecording({ username, url, vpath, recordDir, stationName, artFile, durationMinutes, description }) {
  return new Promise((resolve, reject) => {
    const id   = nanoid(10);
    const name = stationName ? _safeName(stationName) : 'radio';
    _attemptStreamConnect(url, 0, { id, name, username, vpath, recordDir, stationName, artFile, durationMinutes, description, resolve, reject });
  });
}

function _attemptStreamConnect(streamUrl, tries, ctx) {
  const { id, name, username, vpath, recordDir, stationName, artFile, durationMinutes, description, resolve, reject } = ctx;
  if (tries > 3) return reject(new Error('Could not connect to stream after redirects'));

  const parsed = new URL(streamUrl);
  const useLib = parsed.protocol === 'https:' ? https : http;
  const upReq  = useLib.request({
    hostname: parsed.hostname,
    port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
    path:     parsed.pathname + parsed.search,
    method:   'GET',
    headers:  { 'User-Agent': 'Velvet/5 RadioRecorder', 'Icy-MetaData': '0' },
  }, upRes => {
    if ([301, 302, 307, 308].includes(upRes.statusCode) && upRes.headers.location) {
      upRes.resume();
      _attemptStreamConnect(upRes.headers.location, tries + 1, ctx);
      return;
    }
    if (upRes.statusCode !== 200) {
      upRes.resume(); reject(new Error(`Stream returned HTTP ${upRes.statusCode}`)); return;
    }

    const ext        = _extFromContentType(upRes.headers['content-type']);
    const descSuffix = description ? `_${_safeName(description)}` : '';
    const filename   = `${name}_${_ts()}${descSuffix}${ext}`;
    const filePath   = resolvePathWithinRoot(recordDir, filename);
    const writer     = fs.createWriteStream(filePath);

    const rec = {
      upReq, upRes, writer, filePath,
      vpath, stationName: stationName || 'Radio Station',
      artFile: artFile || null,
      startedAt: Date.now(), bytesWritten: 0, username,
    };
    activeRecordings.set(id, rec);

    const durMs = (durationMinutes || config.program.scanOptions.maxRecordingMinutes || 180) * 60000;
    rec._autoStopTimer = setTimeout(() => _autoStopRecording(id), durMs);

    upRes.on('data', chunk => { rec.bytesWritten += chunk.length; });
    upRes.pipe(writer);
    upRes.on('error', () => { writer.end(); activeRecordings.delete(id); });
    writer.on('error', () => { upRes.destroy(); activeRecordings.delete(id); });

    resolve({ id, relPath: `${vpath}/${filename}`, filename });
  });

  upReq.on('error', reject);
  upReq.setTimeout(15000, () => { upReq.destroy(); reject(new Error('Stream connection timed out')); });
  upReq.end();
}

export const stopStreamRecording = _autoStopRecording;

export function setup(velvet) {

  // ── GET /api/v1/radio/record/active ─────────────────────────────────────────
  // Returns active recordings for the requesting user.
  velvet.get('/api/v1/radio/record/active', (req, res) => {
    if (!req.user['allow-radio-recording']) return res.status(403).json({ error: 'Recording not enabled for this user' });

    const list = [];
    for (const [id, r] of activeRecordings) {
      if (r.username !== req.user.username) continue;
      list.push({
        id,
        stationName: r.stationName,
        filePath: r.filePath,
        vpath: r.vpath,
        startedAt: r.startedAt,
        bytesWritten: r.bytesWritten,
      });
    }
    res.json(list);
  });

  // ── POST /api/v1/radio/record/start ─────────────────────────────────────────
  // body: { url, vpath, stationName? }
  // Returns: { id, filePath }
  velvet.post('/api/v1/radio/record/start', async (req, res) => {
    if (!req.user['allow-radio-recording']) return res.status(403).json({ error: 'Recording not enabled for this user' });

    const schema = Joi.object({
      url:         Joi.string().uri({ scheme: ['http', 'https'] }).required(),
      vpath:       Joi.string().required(),
      stationName: Joi.string().max(120).allow('').optional(),
      artFile:     Joi.string().max(200).pattern(/^[^/\\]+$/).allow(null, '').optional(),
      description: Joi.string().max(80).allow(null, '').optional(),
    });
    const { error, value } = schema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });

    // Validate vpath is accessible and is a recordings folder
    const folder = config.program.folders[value.vpath];
    if (!folder) return res.status(400).json({ error: 'Unknown vpath' });
    if (!req.user.vpaths?.includes(value.vpath)) return res.status(403).json({ error: 'Access denied to this vpath' });
    if (folder.type !== 'recordings') return res.status(400).json({ error: 'Target folder must be of type \'recordings\'' });

    // SSRF protection
    let parsed;
    try { parsed = new URL(value.url); } catch { return res.status(400).json({ error: 'Invalid URL' }); }
    if (isPrivateHost(parsed.hostname)) return res.status(403).json({ error: 'SSRF protection: private/loopback addresses not allowed' });

    const recordDir = folder.root;

    // Writable check
    try { await fsp.mkdir(recordDir, { recursive: true }); } catch (e) { console.debug('[velvet]', e?.message ?? e); }
    const writable = await _checkWritable(recordDir);
    if (!writable) return res.status(500).json({ error: 'Recordings folder is not writable' });

    try {
      const result = await startStreamRecording({
        username:    req.user.username,
        url:         value.url,
        vpath:       value.vpath,
        recordDir,
        stationName: value.stationName,
        artFile:     value.artFile,
        description: value.description || null,
      });
      res.json({ id: result.id, filePath: result.relPath, filename: result.filename });
    } catch (err) {
      if (!res.headersSent) res.status(502).json({ error: err.message || 'Failed to start recording' });
    }
  });

  // ── POST /api/v1/radio/record/stop ──────────────────────────────────────────
  // body: { id }
  // Returns: { filePath, bytesWritten, durationMs }
  velvet.post('/api/v1/radio/record/stop', async (req, res) => {
    if (!req.user['allow-radio-recording']) return res.status(403).json({ error: 'Recording not enabled for this user' });

    const schema = Joi.object({ id: Joi.string().required() });
    joiValidate(schema, req.body);

    const rec = activeRecordings.get(req.body.id);
    if (!rec) return res.status(404).json({ error: 'Recording not found or already stopped' });
    if (rec.username !== req.user.username) return res.status(403).json({ error: 'Not your recording' });

    const durationMs = Date.now() - rec.startedAt;

    clearTimeout(rec._autoStopTimer);
    rec.upRes.unpipe(rec.writer);
    rec.upReq.destroy();
    activeRecordings.delete(req.body.id);

    // Wait for the file writer to fully flush before post-processing
    await new Promise(resolve => {
      if (rec.writer.writableEnded) { resolve(); return; }
      rec.writer.on('finish', resolve);
      rec.writer.on('error', resolve);
      rec.writer.end();
    });

    // Remux raw AAC → M4A container for seekability, then embed cover art
    rec.filePath = await _remuxAacToM4a(rec.filePath);
    if (rec.artFile) {
      await _embedCoverArt(rec.filePath, rec.artFile);
    }

    res.json({
      filePath:     rec.filePath,
      relPath:      `${rec.vpath}/${path.basename(rec.filePath)}`,
      bytesWritten: rec.bytesWritten,
      durationMs,
      vpath:        rec.vpath,
      stationName:  rec.stationName,
      artFile:      rec.artFile || null,
    });
  });
}
