import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import fsp from 'node:fs/promises';
import winston from 'winston';
import * as vpath from '../util/vpath.js';
import * as config from '../state/config.js';
import { ensureFfmpeg, ffmpegBin } from '../util/ffmpeg-bootstrap.js';

const codecMap = {
  'mp3': { codec: 'libmp3lame', contentType: 'audio/mpeg' },
  'opus': { codec: 'libopus', contentType: 'audio/ogg' },
  'aac': { codec: 'aac', contentType: 'audio/aac' }
};

const algoSet = new Set(['buffer', 'stream']);
const bitrateSet = new Set(['64k', '128k', '192k', '96k']);

export function getTransAlgos() {
  return Array.from(algoSet);
}

export function getTransBitrates() {
  return Array.from(bitrateSet);
}

export function getTransCodecs() {
  return Object.keys(codecMap);
}

function initHeaders(res, audioTypeId, contentLength) {
  const contentType = codecMap[audioTypeId].contentType;
  return res.header({
    'Accept-Ranges': 'bytes',
    'Content-Type': contentType,
    'Content-Length': contentLength
  });
}

let lockInit = false;

async function init() {
  await ensureFfmpeg();
  try {
    await fsp.access(ffmpegBin());
  } catch {
    throw new Error(`FFmpeg binary not found at ${ffmpegBin()}`);
  }
  lockInit = true;
  winston.info('FFmpeg OK!');
}

export function reset() {
  lockInit = false;
}

export function isEnabled() {
  return lockInit === true && config.program.transcode.enabled === true;
}

export function isDownloaded() {
  return lockInit;
}

export async function downloadedFFmpeg() {
  await init();
}

// Per-entry ceiling: large files (audiobooks, hour-long mixes) are not
// buffered in full — collection stops once a stream crosses this line.
const CACHE_MAX_ENTRY_BYTES = 32 * 1024 * 1024; // 32 MB
const transCache = {};

function spawnTranscode(inputPath, codec, bitrate, gainDb = null, offsetSec = 0) {
  // Optional ReplayGain volume adjustment via a simple volume= filter.
  // A limiter (alimiter) prevents clipping after gain is applied.
  // Only applied when gainDb is a finite non-zero number.
  const afParts = [];
  if (gainDb != null && Number.isFinite(gainDb) && gainDb !== 0) {
    const linearGain = Math.pow(10, gainDb / 20).toFixed(6);
    afParts.push(`volume=${linearGain}`, 'alimiter=level_in=1:level_out=1:limit=0.9998:attack=5:release=50');
  }
  const args = [];
  if (offsetSec > 0) args.push('-ss', String(offsetSec));
  args.push('-i', inputPath, '-vn', '-f', codec, '-acodec', codecMap[codec].codec, '-ab', bitrate);
  if (afParts.length) args.push('-af', afParts.join(','));
  args.push('-');
  return spawn(ffmpegBin(), args, { stdio: ['ignore', 'pipe', 'ignore'] });
}

export function setup(velvet) {
  if (config.program.transcode.enabled === true) {
    init().catch(err => {
      winston.error('FFmpeg init failed — transcoding disabled', { stack: err });
    });
  }

  velvet.all("/transcode/{*filepath}", async (req, res) => {
    if (config.program.transcode?.enabled !== true) {
      return res.status(500).json({ error: 'transcoding disabled' });
    }

    if (lockInit !== true) {
      return res.status(500).json({ error: 'transcoding disabled' });
    }

    const codec = codecMap[req.query.codec] ? req.query.codec : config.program.transcode.defaultCodec;
    const algo = algoSet.has(req.query.algo) ? req.query.algo : config.program.transcode.algorithm;
    const bitrate = bitrateSet.has(req.query.bitrate) ? req.query.bitrate : config.program.transcode.defaultBitrate;
    const rawOffset = Number.parseFloat(String(req.query.offset ?? '0'));
    const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0;

    // Express 5 / path-to-regexp v8 returns wildcard {*filepath} params as an array,
    // not a string. Use req.path instead — it is always a plain decoded string.
    const rawFilepath = decodeURI(req.path.slice('/transcode/'.length));

    let pathInfo;
    try {
      pathInfo = vpath.getVPathInfo(rawFilepath, req.user);
    } catch (err) {
      winston.warn(`[transcode] vpath rejected for user '${req.user?.username}': '${rawFilepath}' (${err.message})`);
      return res.status(404).json({ error: 'file not found' });
    }

    // Stat up front: a missing file returns a real 404 instead of an empty
    // 200 after ffmpeg fails to open the input. The mtime+size also feed the
    // cache key so a replaced or re-tagged file doesn't keep serving a stale
    // cached transcode.
    let st;
    try {
      st = await fsp.stat(pathInfo.fullPath);
      if (!st.isFile()) { throw new Error('not a regular file'); }
    } catch (err) {
      winston.warn(`[transcode] stat failed for '${pathInfo.fullPath}': ${err.message}`);
      return res.status(404).json({ error: 'file not found' });
    }

    // HEAD is a header-only probe — return immediately without running ffmpeg.
    if (req.method === 'HEAD') {
      return res.status(200).header({ 'Content-Type': codecMap[codec].contentType }).end();
    }

    const cacheKey = `${pathInfo.fullPath}|${st.mtimeMs}|${st.size}|${bitrate}|${codec}`;

    // Stream audio data
    if (req.method === 'GET') {

      // check cache
      if (offset === 0 && transCache[cacheKey]) {
        const t = transCache[cacheKey].deref();
        if (t !== undefined) {
          initHeaders(res, codec, t.contentLength);
          Readable.from(t.bufs).pipe(res);
          return;
        }
      }

      if (algo === 'stream') {
        const proc = spawnTranscode(pathInfo.fullPath, codec, bitrate, null, offset);
        proc.once('error', err => {
          winston.error('[transcode] spawn error', { stack: err, path: pathInfo.fullPath });
          if (!res.headersSent) res.status(500).json({ error: 'transcode failed' });
          else try { res.end(); } catch { /* already closed */ }
        });
        return proc.stdout.pipe(res);
      }

      // Buffer mode
      let cacheable = offset === 0;
      let bufs = [];
      let contentLength = 0;
      let aborted = false;

      const proc = spawnTranscode(pathInfo.fullPath, codec, bitrate, null, offset);

      proc.once('error', err => {
        winston.error('[transcode] spawn error', { stack: err, path: pathInfo.fullPath });
        if (!res.headersSent) res.status(500).json({ error: 'transcode failed' });
        else try { res.end(); } catch { /* already closed */ }
      });

      req.on('close', () => { aborted = true; });

      proc.stdout.on('data', chunk => {
        if (!cacheable) { return; }
        contentLength += chunk.length;
        if (contentLength > CACHE_MAX_ENTRY_BYTES) {
          cacheable = false;
          bufs = [];
          return;
        }
        bufs.push(chunk);
      });

      proc.stdout.on('end', () => {
        if (cacheable && !aborted && bufs.length > 0) {
          transCache[cacheKey] = new WeakRef({ contentLength, bufs });
        }
      });

      proc.stdout.pipe(res);

    } else {
      res.sendStatus(405);
    }
  });
}
