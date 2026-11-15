import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import winston from 'winston';
import * as vpath from '../util/vpath.js';
import * as config from '../state/config.js';
import { ensureFfmpeg, ffmpegBin, ffprobeBin } from '../util/ffmpeg-bootstrap.js';

// format = the ffmpeg muxer; ffmpeg has no 'aac' muxer, raw AAC streams are ADTS
const codecMap = {
  'mp3': { codec: 'libmp3lame', format: 'mp3', contentType: 'audio/mpeg' },
  'opus': { codec: 'libopus', format: 'opus', contentType: 'audio/opus' },
  'aac': { codec: 'aac', format: 'adts', contentType: 'audio/aac' }
};

const algoSet = new Set(['buffer', 'stream']);
const bitrateSet = new Set(['64k', '96k', '128k', '192k', '256k', '320k']);

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

function binariesExist() {
  return fs.existsSync(ffmpegBin()) && fs.existsSync(ffprobeBin());
}

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

// A client that goes away (seek, skip) unpipes stdout; ffmpeg would then block on
// a full pipe forever, so it is killed when the response closes unfinished.
export function pipeTranscodeToRes(res, fullPath, codec, bitrate, offset = 0) {
  const proc = spawnTranscode(fullPath, codec, bitrate, offset);
  res.set('Content-Type', codecMap[codec].contentType);
  proc.once('error', err => {
    winston.error('[transcode] spawn error', { stack: err, path: fullPath });
    if (!res.headersSent) res.status(500).json({ error: 'transcode failed' });
    else try { res.end(); } catch { /* already closed */ }
  });
  res.once('close', () => {
    if (!res.writableFinished && proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
  });
  proc.stdout.pipe(res);
  return proc;
}

export function codecContentType(codec) {
  return codecMap[codec]?.contentType ?? 'audio/mpeg';
}

export function isEnabled() {
  return lockInit === true && config.program.transcode.enabled === true;
}

export function isDownloaded() {
  if (lockInit) return true;
  // ensureFfmpeg() is async — if it hasn't resolved yet (e.g. admin panel
  // opened immediately after boot) check synchronously so the UI shows the
  // correct Ready status instead of waiting for the next page load.
  if (binariesExist()) {
    lockInit = true;
    return true;
  }
  return false;
}

export async function downloadedFFmpeg() {
  await init();
}

// Per-entry ceiling: large files (audiobooks, hour-long mixes) are not
// buffered in full — collection stops once a stream crosses this line.
const CACHE_MAX_ENTRY_BYTES = 32 * 1024 * 1024; // 32 MB
const transCache = {};

function spawnTranscode(inputPath, codec, bitrate, offsetSec = 0) {
  const args = [];
  if (offsetSec > 0) args.push('-ss', String(offsetSec));
  args.push('-i', inputPath, '-vn', '-f', codecMap[codec].format, '-acodec', codecMap[codec].codec, '-ab', bitrate, '-');
  return spawn(ffmpegBin(), args, { stdio: ['ignore', 'pipe', 'ignore'] });
}

export function setup(velvet) {
  if (config.program.transcode.enabled === true) {
    // Full init: verify version and download if needed.
    init().catch(err => {
      winston.error('FFmpeg init failed — transcoding disabled', { stack: err });
    });
  } else {
    // Transcoding disabled — just probe for an existing binary so the admin
    // panel shows the correct "Ready"/"Not ready" status without triggering
    // a download. In Docker the binary is pre-bundled; this removes the need
    // for the user to click "Verify / Download" to get the correct status.
    Promise.all([fsp.access(ffmpegBin()), fsp.access(ffprobeBin())]).then(() => {
      lockInit = true;
      winston.info('FFmpeg OK!');
    }).catch(() => { /* binary absent — lockInit stays false */ });
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

      const proc = pipeTranscodeToRes(res, pathInfo.fullPath, codec, bitrate, offset);
      if (algo === 'stream') return;

      // Buffer mode: also keep the output for the cache
      let cacheable = offset === 0;
      let bufs = [];
      let contentLength = 0;

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

      // A killed (aborted) or failed ffmpeg leaves a partial output: cache only a clean exit
      proc.once('close', code => {
        if (code === 0 && cacheable && bufs.length > 0) {
          transCache[cacheKey] = new WeakRef({ contentLength, bufs });
        }
      });

    } else {
      res.sendStatus(405);
    }
  });
}
