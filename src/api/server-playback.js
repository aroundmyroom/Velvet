/**
 * server-playback.js — mpv-based server-side audio playback
 *
 * Architecture:
 *   - Spawns mpv with --input-ipc-server (Unix socket) to control playback
 *   - Maintains a server-side queue mirror (relPath + metadata)
 *   - Exposes REST API under /api/v1/server-playback/* (auth required)
 *   - Serves the /server-remote SPA (before auth, no token needed for the page itself)
 *
 * mpv IPC protocol (JSON, one object per line):
 *   Send:    { "command": [...], "request_id": N }
 *   Receive: { "data": ..., "error": "success"|"...", "request_id": N }
 *   Events:  { "event": "end-file"|"file-loaded"|..., ... }
 */

import net from 'node:net';
import path from 'node:path';
import child_process from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import winston from 'winston';
import * as config from '../state/config.js';
import * as db from '../db/manager.js';
import { resolveTrackGain } from './db.js';

// ── Socket path ────────────────────────────────────────────────────────────
const sockPath = path.join(os.tmpdir(), `mpv-velvet-${process.pid}.sock`);

// Build the mpv af chain from a RG gainDb value and a stereo balance.
// gainDb: float dB (null = no RG filter).
// balance: -1.0 (full left) … 0.0 (centre) … +1.0 (full right), default 0.
function _buildAfChain(gainDb, balance = 0) {
  const parts = [];
  if (gainDb != null) {
    const lin = Math.pow(10, gainDb / 20);
    parts.push(`volume=${lin}`);
  }
  if (balance !== 0 && balance != null) {
    // MPV requires the lavfi wrapper for the pan filter.
    // lg/rg are 0.0–1.0 gain factors for left/right output channels.
    const lg = Math.max(0, Math.min(1, 1 - balance));
    const rg = Math.max(0, Math.min(1, 1 + balance));
    parts.push(`lavfi=[pan=stereo|c0=${lg}*c0|c1=${rg}*c1]`);
  }
  return parts.join(',');
}

// ── Process & IPC state ───────────────────────────────────────────────────
let mpvProc        = null;   // ChildProcess | null
let ipcSock        = null;   // net.Socket | null
let ipcBuf         = '';     // partial line buffer
let reqId          = 1;      // monotonic request_id counter
const pending      = new Map(); // request_id → { resolve, reject, timer }
let connectRetries = 0;

// Persistent audio-state: re-applied on every file-loaded event
let _currentBalance   = 0;    // -1.0 … +1.0
let _currentVolumePct = 80;   // 0 … 130

const SERVER_AUDIO_CTRL_CANDIDATES = ['Master', 'Speaker', 'PCM', 'Headphone'];

// ── Queue mirror ──────────────────────────────────────────────────────────
// Each entry: { relPath, title, artist, album, albumArt }
let serverQueue  = [];
let currentIndex = -1;
let _pendingSeek = null; // seconds to seek to once the next file-loaded event fires

// ── Cast heartbeat watchdog ───────────────────────────────────────────────
// While a client is casting, it sends POST /api/v1/server-playback/heartbeat
// every HEARTBEAT_INTERVAL_MS.  If HEARTBEAT_TIMEOUT_MS elapses without a
// ping, MPV is stopped — covering crashes, network drops and force-kills.
const _HEARTBEAT_INTERVAL_MS = 8000;   // client sends every 8 s
// 5 minutes — generous safety net. The Web Worker heartbeat fires reliably
// even in backgrounded tabs (navigator.locks keeps it alive). This long
// timeout only fires if the browser process is killed or network drops for
// an extended period; it should never trigger during normal background use.
const HEARTBEAT_TIMEOUT_MS  = 300000; // stop mpv after 5 min of silence
let _heartbeatTimer = null;

function _resolveSafeBinary(bin, fallback) {
  const value = typeof bin === 'string' ? bin.trim() : '';
  if (!value || value.includes('\0')) return fallback;

  // Only allow a bare command name or a verified executable path.
  // This keeps the subprocess API away from shell metacharacters and
  // avoids passing arbitrary strings into process execution.
  if (!path.isAbsolute(value)) {
    if (/^[A-Za-z0-9._-]+$/.test(value)) return value;
    return fallback;
  }

  try {
    fs.accessSync(value, fs.constants.X_OK);
    return value;
  } catch {
    return fallback;
  }
}

function _resetHeartbeat() {
  clearTimeout(_heartbeatTimer);
  _heartbeatTimer = setTimeout(() => {
    if (!isRunning()) return;
    getStatus().then(st => {
      // Some browsers can still miss heartbeats while backgrounded/discarded.
      // If MPV is actively playing, keep it alive and re-arm the timer.
      if (st?.running && st?.playing) {
        winston.info('[server-audio] Heartbeat grace: MPV still playing, skipping timeout stop');
        _resetHeartbeat();
        return;
      }
      winston.info('[server-audio] Cast heartbeat timed out — stopping mpv');
      clearQueue().catch(() => {});
    }).catch(() => {
      winston.info('[server-audio] Cast heartbeat timed out — status unknown, stopping mpv');
      clearQueue().catch(() => {});
    });
  }, HEARTBEAT_TIMEOUT_MS);
}

function _clearHeartbeat() {
  clearTimeout(_heartbeatTimer);
  _heartbeatTimer = null;
}

function _touchHeartbeat() {
  if (serverQueue.length > 0) _resetHeartbeat();
}


const RUN_CMD_KIND = Object.freeze({
  MPV_VERSION: 'mpv-version',
  AMIXER_VERSION: 'amixer-version',
  APLAY_VERSION: 'aplay-version',
  AMIXER_SCONTROLS: 'amixer-scontrols',
  AMIXER_GET: 'amixer-get',
  APLAY_LIST: 'aplay-list',
  AMIXER_SET: 'amixer-set',
  AMIXER_SSET: 'amixer-sset',
});

function _safeMixerControl(name) {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (!trimmed || trimmed.includes('\0')) return null;
  return /^[A-Za-z0-9 _.-]{1,64}$/.test(trimmed) ? trimmed : null;
}

function runCmd(kind, options = {}) {
  try {
    const timeout = Number.isFinite(options.timeout) ? options.timeout : 5000;
    const mpvBin = _resolveSafeBinary(config.program.serverAudio?.mpvBin, 'mpv');
    let safeBin = null;
    let safeArgs = [];

    switch (kind) {
      case RUN_CMD_KIND.MPV_VERSION:
        safeBin = mpvBin;
        safeArgs = ['--version'];
        break;
      case RUN_CMD_KIND.AMIXER_VERSION:
        safeBin = 'amixer';
        safeArgs = ['--version'];
        break;
      case RUN_CMD_KIND.APLAY_VERSION:
        safeBin = 'aplay';
        safeArgs = ['--version'];
        break;
      case RUN_CMD_KIND.AMIXER_SCONTROLS:
        safeBin = 'amixer';
        safeArgs = ['scontrols'];
        break;
      case RUN_CMD_KIND.AMIXER_GET: {
        const ctl = _safeMixerControl(options.control);
        if (!ctl) throw new Error('Invalid mixer control name');
        safeBin = 'amixer';
        safeArgs = ['get', ctl];
        break;
      }
      case RUN_CMD_KIND.APLAY_LIST:
        safeBin = 'aplay';
        safeArgs = ['-l'];
        break;
      case RUN_CMD_KIND.AMIXER_SET: {
        const ctl = _safeMixerControl(options.control);
        if (!ctl) throw new Error('Invalid mixer control name');
        safeBin = 'amixer';
        safeArgs = ['set', ctl, '90%', 'unmute'];
        break;
      }
      case RUN_CMD_KIND.AMIXER_SSET: {
        const ctl = _safeMixerControl(options.control);
        if (!ctl) throw new Error('Invalid mixer control name');
        safeBin = 'amixer';
        safeArgs = ['sset', ctl, '90%', 'unmute'];
        break;
      }
      default:
        throw new Error('Unsupported command kind');
    }

    const res = child_process.spawnSync(safeBin, safeArgs, {
      encoding: 'utf8',
      timeout,
      windowsHide: true,
    });
    return {
      ok: !res.error && res.status === 0,
      status: res.status,
      stdout: res.stdout || '',
      stderr: res.stderr || '',
      error: res.error ? String(res.error.message || res.error) : null,
    };
  } catch (err) {
    return {
      ok: false,
      status: null,
      stdout: '',
      stderr: '',
      error: String(err?.message || err),
    };
  }
}

function parseMixerState(output) {
  const text = String(output || '');
  const muteMatches = Array.from(text.matchAll(/\[(on|off)\]/g)).map(m => m[1]);
  const volumeMatches = Array.from(text.matchAll(/\[(\d{1,3})%\]/g)).map(m => Number(m[1]));
  const muted = muteMatches.length > 0 && muteMatches.every(v => v === 'off');
  return {
    muted,
    hasOn: muteMatches.includes('on'),
    hasOff: muteMatches.includes('off'),
    volumes: volumeMatches,
  };
}

function getLinuxAudioHealth() {
  const mpvBin = _resolveSafeBinary(config.program.serverAudio?.mpvBin, 'mpv');
  const mpvVer = runCmd(RUN_CMD_KIND.MPV_VERSION);
  const amixerVer = runCmd(RUN_CMD_KIND.AMIXER_VERSION);
  const aplayVer = runCmd(RUN_CMD_KIND.APLAY_VERSION);
  const controlsRes = amixerVer.ok ? runCmd(RUN_CMD_KIND.AMIXER_SCONTROLS) : { ok: false, stdout: '' };

  const controls = [];
  if (controlsRes.ok) {
    const matches = String(controlsRes.stdout || '').match(/'([^']+)'/g) || [];
    for (const m of matches) {
      const name = m.slice(1, -1);
      if (!controls.includes(name)) controls.push(name);
    }
  }

  const inspected = [];
  const targets = controls.length ? SERVER_AUDIO_CTRL_CANDIDATES.filter(c => controls.includes(c)) : SERVER_AUDIO_CTRL_CANDIDATES;
  for (const ctl of targets) {
    const r = runCmd(RUN_CMD_KIND.AMIXER_GET, { control: ctl });
    if (!r.ok) continue;
    const parsed = parseMixerState(r.stdout);
    inspected.push({
      name: ctl,
      muted: parsed.muted,
      volumes: parsed.volumes,
      hasOn: parsed.hasOn,
      hasOff: parsed.hasOff,
    });
  }

  const cardsRes = aplayVer.ok ? runCmd(RUN_CMD_KIND.APLAY_LIST) : { ok: false, stdout: '' };
  const cardLines = cardsRes.ok
    ? String(cardsRes.stdout || '').split('\n').filter(l => /^card\s+\d+/i.test(l.trim())).slice(0, 6)
    : [];

  const mutedControls = inspected.filter(i => i.muted).map(i => i.name);
  const issues = [];
  if (!mpvVer.ok) issues.push('mpv-not-found');
  if (!amixerVer.ok) issues.push('amixer-not-found');
  if (amixerVer.ok && inspected.length === 0) issues.push('no-mixer-controls');
  if (mutedControls.length > 0) issues.push('muted-controls');

  return {
    platform: process.platform,
    mpv: {
      found: mpvVer.ok,
      path: mpvBin,
      version: (() => {
        if (!mpvVer.ok) return null;
        const m = /mpv\s+(\S+)/i.exec(String(mpvVer.stdout || ''));
        return m ? m[1] : 'unknown';
      })(),
      error: mpvVer.ok ? null : (mpvVer.error || mpvVer.stderr || 'Not found'),
    },
    alsa: {
      amixerFound: amixerVer.ok,
      aplayFound: aplayVer.ok,
      controls,
      inspected,
      mutedControls,
      cards: cardLines,
    },
    healthy: issues.length === 0,
    issues,
  };
}

function applyLinuxAudioFix() {
  const health = getLinuxAudioHealth();
  if (!health.alsa.amixerFound) {
    return { changed: false, attempted: [], health };
  }

  const controls = health.alsa.inspected.length
    ? health.alsa.inspected.map(c => c.name)
    : SERVER_AUDIO_CTRL_CANDIDATES;
  const attempted = [];
  for (const ctl of controls) {
    const r1 = runCmd(RUN_CMD_KIND.AMIXER_SET, { control: ctl });
    const r2 = r1.ok ? { ok: true } : runCmd(RUN_CMD_KIND.AMIXER_SSET, { control: ctl });
    attempted.push({ name: ctl, ok: !!(r1.ok || r2.ok) });
  }

  return {
    changed: attempted.some(a => a.ok),
    attempted,
    health: getLinuxAudioHealth(),
  };
}

function bestEffortPrepareLinuxAudio() {
  if (process.platform !== 'linux') return;
  const autoUnmute = config.program.serverAudio?.autoUnmute !== false;
  if (!autoUnmute) return;
  try {
    const result = applyLinuxAudioFix();
    if (result.changed) winston.info('[server-audio] Applied ALSA unmute/volume fix before mpv start');
  } catch (err) {
    winston.warn(`[server-audio] Audio auto-fix failed: ${err?.message || err}`);
  }
}

// ── mpv boot / kill ────────────────────────────────────────────────────────
export function bootMpv() {
  if (mpvProc?.exitCode === null) return; // already running

  const mpvBin = _resolveSafeBinary(config.program.serverAudio?.mpvBin, 'mpv');

  // Clean up any stale socket from a previous run
  try { fs.unlinkSync(sockPath); } catch (e) { console.debug('[velvet]', e?.message ?? e); }

  bestEffortPrepareLinuxAudio();

  winston.info(`[server-audio] Starting mpv: ${mpvBin}`);
  winston.info('[server-audio] Note: any pw.conf warnings from mpv are PipeWire client library noise — not a bug. PIPEWIRE_DEBUG=0 is set to suppress them.');

  mpvProc = child_process.spawn(mpvBin, [
    '--idle=yes',
    '--no-video',
    '--no-terminal',
    '--really-quiet',
    '--gapless-audio=yes',
    `--input-ipc-server=${sockPath}`,
  ], { stdio: 'ignore', detached: false, env: { ...process.env, PIPEWIRE_DEBUG: '0' } });

  mpvProc.on('error', err => {
    winston.error(`[server-audio] mpv failed to start: ${err.message}`);
    mpvProc = null;
  });

  mpvProc.on('exit', code => {
    winston.info(`[server-audio] mpv exited (code ${code})`);
    mpvProc = null;
    if (ipcSock) { try { ipcSock.destroy(); } catch (e) { console.debug('[velvet]', e?.message ?? e); } ipcSock = null; }
    // Reject any pending IPC requests
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error('mpv process exited'));
      pending.delete(id);
    }
  });

  // mpv takes ~200–500ms to create the socket; retry a few times
  connectRetries = 0;
  setTimeout(connectIpc, 600);
}

export function killMpv() {
  if (ipcSock) { try { ipcSock.destroy(); } catch (e) { console.debug('[velvet]', e?.message ?? e); } ipcSock = null; }
  if (mpvProc) { try { mpvProc.kill('SIGTERM'); } catch (e) { console.debug('[velvet]', e?.message ?? e); } mpvProc = null; }
  serverQueue  = [];
  currentIndex = -1;
}

export function isRunning() {
  return mpvProc !== null && mpvProc.exitCode === null;
}

// ── IPC connection ─────────────────────────────────────────────────────────
function connectIpc() {
  if (mpvProc?.exitCode !== null) return;

  const sock = net.connect(sockPath);

  sock.on('connect', () => {
    connectRetries = 0;
    ipcSock        = sock;
    ipcBuf         = '';
    winston.info('[server-audio] IPC socket connected');
    // Observe playlist-pos so we get push notifications on track changes
    sendRaw('{"command":["observe_property",1,"playlist-pos"]}\n');
  });

  sock.on('data', chunk => {
    ipcBuf += chunk.toString();
    const lines = ipcBuf.split('\n');
    ipcBuf = lines.pop(); // last element may be an incomplete line
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      try { handleIpcMessage(JSON.parse(t)); } catch (e) { console.debug('[velvet]', e?.message ?? e); }
    }
  });

  sock.on('error', err => {
    if (connectRetries < 8 && mpvProc?.exitCode === null) {
      connectRetries++;
      setTimeout(connectIpc, 400 * connectRetries);
    } else {
      winston.warn(`[server-audio] IPC connect failed: ${err.message}`);
    }
  });

  sock.on('close', () => {
    if (ipcSock === sock) ipcSock = null;
    // If mpv is still running reconnect (socket can be temporarily unavailable)
    if (mpvProc?.exitCode === null) {
      setTimeout(connectIpc, 1000);
    }
  });
}

function sendRaw(str) {
  if (ipcSock && !ipcSock.destroyed) {
    try { ipcSock.write(str); } catch (e) { console.debug('[velvet]', e?.message ?? e); }
  }
}

function ipcCommand(args, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    if (!ipcSock || ipcSock.destroyed) {
      return reject(new Error('mpv IPC not connected'));
    }
    const id    = reqId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('IPC command timed out'));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    sendRaw(JSON.stringify({ command: args, request_id: id }) + '\n');
  });
}

function waitForIpcConnected(timeoutMs = 5000) {
  return new Promise(resolve => {
    if (ipcSock && !ipcSock.destroyed) return resolve(true);
    const started = Date.now();
    const iv = setInterval(() => {
      if (ipcSock && !ipcSock.destroyed) {
        clearInterval(iv);
        resolve(true);
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        clearInterval(iv);
        resolve(false);
      }
    }, 100);
  });
}

function handleIpcMessage(msg) {
  // Response to a pending request
  if (msg.request_id !== undefined) {
    const p = pending.get(msg.request_id);
    if (p) {
      pending.delete(msg.request_id);
      clearTimeout(p.timer);
      if (msg.error === 'success') p.resolve(msg.data === undefined ? null : msg.data);
      else p.reject(new Error(msg.error || 'mpv error'));
    }
    return;
  }

  // Push event: observed property changed (playlist-pos)
  if (msg.event === 'property-change' && msg.name === 'playlist-pos') {
    if (msg.data != null) {
      currentIndex = msg.data;
    }
  }

  // File has loaded and playback started — apply any pending seek position and RG gain.
  // This replaces the old client-side hardcoded 2500 ms delay and fires at
  // exactly the right moment regardless of file size or network latency.
  if (msg.event === 'file-loaded') {
    const pos = _pendingSeek;
    _pendingSeek = null;
    if (pos !== null && pos > 1) {
      ipcCommand(['seek', pos, 'absolute']).catch(() => {});
    }
    // Apply ReplayGain + balance via mpv af filter, and restore the user's volume.
    // Both are persisted in _currentBalance/_currentVolumePct so they survive track changes.
    const entry = serverQueue[currentIndex] ?? serverQueue.at(-1);
    const chain = _buildAfChain(entry?.gainDb ?? null, _currentBalance);
    ipcCommand(['af', 'set', chain]).catch(() => {});
    ipcCommand(['set_property', 'volume', _currentVolumePct]).catch(() => {});
  }
}

// ── Status ─────────────────────────────────────────────────────────────────
export async function getStatus() {
  const running   = isRunning();
  const connected = ipcSock && !ipcSock.destroyed;

  if (!running || !connected) {
    return {
      running,
      playing:      false,
      currentTime:  0,
      duration:     0,
      currentIndex: -1,
      queueLength:  serverQueue.length,
      volume:       100,
      loopMode:     'none',
      shuffle:      false,
      queue:        serverQueue,
    };
  }

  const [timePos, duration, pause, volume, loopFile, loopPlaylist, plPos] = await Promise.all([
    ipcCommand(['get_property', 'time-pos']).catch(() => 0),
    ipcCommand(['get_property', 'duration']).catch(() => 0),
    ipcCommand(['get_property', 'pause']).catch(() => true),
    ipcCommand(['get_property', 'volume']).catch(() => 100),
    ipcCommand(['get_property', 'loop-file']).catch(() => 'no'),
    ipcCommand(['get_property', 'loop-playlist']).catch(() => 'no'),
    ipcCommand(['get_property', 'playlist-pos']).catch(() => currentIndex),
  ]);

  if (plPos != null && plPos >= 0) currentIndex = plPos;

  let loopMode = 'none';
  if (loopFile     && loopFile     !== 'no' && loopFile     !== false) loopMode = 'one';
  else if (loopPlaylist && loopPlaylist !== 'no' && loopPlaylist !== false) loopMode = 'all';

  return {
    running:      true,
    playing:      !pause,
    currentTime:  timePos    || 0,
    duration:     duration   || 0,
    currentIndex,
    queueLength:  serverQueue.length,
    volume:       volume     || 100,
    loopMode,
    shuffle:      false, // mpv shuffle state not tracked
    queue:        serverQueue,
    currentGainDb: (serverQueue[currentIndex] ?? serverQueue.at(-1))?.gainDb ?? null,
  };
}

// ── File path resolution ───────────────────────────────────────────────────
function resolveAbsPath(relPath) {
  const normPath = relPath.replace(/^\//, ''); // strip leading slash if present
  const folders = config.program.folders || {};
  for (const [vname, folder] of Object.entries(folders)) {
    if (normPath === vname || normPath.startsWith(vname + '/')) {
      const rel = normPath.slice(vname.length + 1);
      const abs = path.join(folder.root, rel);
      try {
        fs.accessSync(abs, fs.constants.R_OK);
        return abs;
      } catch (e) { console.debug('[velvet]', e?.message ?? e); }
    }
  }
  return null;
}

// ── Queue management ───────────────────────────────────────────────────────
function _loadDbTechMeta(relPath) {
  try {
    const parts = relPath.split('/');
    const row   = db.findFileByPath(parts.slice(1).join('/'), parts[0]);
    if (row) return { bitrate: row.bitrate || null, sampleRate: row.sample_rate || null, channels: row.channels || null };
  } catch (e) { console.debug('[velvet]', e?.message ?? e); }
  return { bitrate: null, sampleRate: null, channels: null };
}

function _resolveRgGain(relPath, meta) {
  try {
    const parts  = relPath.split('/');
    const row    = db.findFileByPath(parts.slice(1).join('/'), parts[0]);
    if (!row) return null;
    const mode   = meta.rgMode === 'album' ? 'album' : 'track';
    const preamp = Number(meta.rgPreamp) || 0;
    const clip   = meta.rgClip !== false;
    const rg     = resolveTrackGain(row, mode);
    if (rg?.gain == null) return null;
    let db_val = Number(rg.gain) + preamp;
    if (clip && rg.peak != null) {
      const headroom = -Number(rg.peak);
      if (db_val > headroom) db_val = headroom;
    }
    return db_val;
  } catch { return null; }
}

export async function addToQueue(relPath, meta = {}) {
  relPath = relPath.replace(/^\/+/, '');
  const abs = resolveAbsPath(relPath);
  if (!abs) throw new Error('File not found: ' + relPath);

  const { bitrate, sampleRate, channels } = meta.bitrate || meta['sample-rate']
    ? { bitrate: meta.bitrate || null, sampleRate: meta['sample-rate'] || null, channels: meta.channels || null }
    : _loadDbTechMeta(relPath);

  const entry = {
    relPath,
    title:         meta.title    || path.basename(relPath, path.extname(relPath)),
    artist:        meta.artist   || '',
    album:         meta.album    || '',
    albumArt:      meta.albumArt || '',
    bitrate,
    'sample-rate': sampleRate,
    channels,
    gainDb: meta.rgEnabled === false ? null : _resolveRgGain(relPath, meta),
  };

  serverQueue.push(entry);

  const seekTo = Number(meta.seekTo) || 0;
  if (seekTo > 1) _pendingSeek = Math.floor(seekTo);

  // After backend restart, the first cast request can arrive before mpv is
  // fully running/connected. Auto-boot and wait briefly so queue/add actually
  // loads into mpv instead of silently queueing only in memory.
  if ((!isRunning() || !ipcSock || ipcSock.destroyed) && config.program.serverAudio?.enabled) {
    bootMpv();
    await waitForIpcConnected(5000);
  }

  if (!isRunning() || !ipcSock || ipcSock.destroyed) {
    throw new Error('Server Audio is not running');
  }
  await ipcCommand(['loadfile', abs, 'append-play']);
  return serverQueue.length - 1;
}

export async function clearQueue() {
  _pendingSeek = null; // cancel any pending seek from a previous load
  _clearHeartbeat();   // no client casting anymore
  serverQueue  = [];
  currentIndex = -1;
  if (isRunning() && ipcSock && !ipcSock.destroyed) {
    await ipcCommand(['playlist-clear']).catch(() => {});
    await ipcCommand(['stop']).catch(() => {});
    // Reset pause state so the next loadfile always starts playing.
    // Without this, a prior set-pause:true (e.g. from switching to Sonos)
    // persists through stop and causes the next file load to start paused.
    await ipcCommand(['set_property', 'pause', false]).catch(() => {});
  }
}

export async function removeAtIndex(index) {
  if (index < 0 || index >= serverQueue.length) throw new Error('Index out of range');
  serverQueue.splice(index, 1);

  if (isRunning() && ipcSock && !ipcSock.destroyed) {
    await ipcCommand(['playlist-remove', index]);
    if (currentIndex > index) currentIndex--;
    else if (currentIndex === index) currentIndex = Math.min(index, serverQueue.length - 1);
    if (serverQueue.length === 0) currentIndex = -1;
  }
}

export async function playAtIndex(index) {
  if (index < 0 || index >= serverQueue.length) throw new Error('Index out of range');
  currentIndex = index;
  if (isRunning() && ipcSock && !ipcSock.destroyed) {
    await ipcCommand(['set_property', 'playlist-pos', index]);
  }
}

export async function cycleLoop() {
  const status = await getStatus();
  let next;
  if (status.loopMode === 'none') { next = 'one'; }
  else if (status.loopMode === 'one') { next = 'all'; }
  else { next = 'none'; }

  if (isRunning() && ipcSock && !ipcSock.destroyed) {
    await ipcCommand(['set_property', 'loop-file',     next === 'one' ? 'inf' : 'no']);
    await ipcCommand(['set_property', 'loop-playlist', next === 'all' ? 'inf' : 'no']);
  }
  return { loop_mode: next };
}

// ── Express API (auth-protected) ───────────────────────────────────────────
export function setup(velvet) {
  // GET /api/v1/server-playback/status
  velvet.get('/api/v1/server-playback/status', async (req, res) => {
    try { res.json(await getStatus()); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST /api/v1/server-playback/queue/add  { filepath, title, artist, album, albumArt, seekTo, rgEnabled, rgMode, rgPreamp, rgClip }
  velvet.post('/api/v1/server-playback/queue/add', async (req, res) => {
    const { filepath, title, artist, album, albumArt, seekTo, rgEnabled, rgMode, rgPreamp, rgClip } = req.body;
    if (!filepath) return res.status(400).json({ error: 'filepath required' });
    try {
      const index = await addToQueue(filepath, { title, artist, album, albumArt, seekTo: seekTo || 0, rgEnabled, rgMode, rgPreamp, rgClip });
      _resetHeartbeat(); // a song was loaded — start the watchdog
      res.json({ index });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // POST /api/v1/server-playback/heartbeat — client pings this while casting
  // (every ~8 s).  Absence of pings triggers the watchdog and stops mpv.
  velvet.post('/api/v1/server-playback/heartbeat', (req, res) => {
    _touchHeartbeat();
    res.json({});
  });

  // POST /api/v1/server-playback/queue/clear
  velvet.post('/api/v1/server-playback/queue/clear', async (req, res) => {
    try { await clearQueue(); res.json({}); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST /api/v1/server-playback/queue/remove  { index }
  velvet.post('/api/v1/server-playback/queue/remove', async (req, res) => {
    const { index } = req.body;
    if (index === undefined) return res.status(400).json({ error: 'index required' });
    try { await removeAtIndex(Number(index)); res.json({}); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });

  // POST /api/v1/server-playback/queue/play-index  { index }
  velvet.post('/api/v1/server-playback/queue/play-index', async (req, res) => {
    const { index } = req.body;
    if (index === undefined) return res.status(400).json({ error: 'index required' });
    try { await playAtIndex(Number(index)); _touchHeartbeat(); res.json({}); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });

  // POST /api/v1/server-playback/next
  velvet.post('/api/v1/server-playback/next', async (req, res) => {
    try {
      if (isRunning() && ipcSock && !ipcSock.destroyed)
        await ipcCommand(['playlist-next', 'force']);
      _touchHeartbeat();
      res.json({});
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST /api/v1/server-playback/previous
  velvet.post('/api/v1/server-playback/previous', async (req, res) => {
    try {
      if (isRunning() && ipcSock && !ipcSock.destroyed)
        await ipcCommand(['playlist-prev', 'force']);
      _touchHeartbeat();
      res.json({});
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST /api/v1/server-playback/pause  (toggles)
  velvet.post('/api/v1/server-playback/pause', async (req, res) => {
    try {
      if (isRunning() && ipcSock && !ipcSock.destroyed)
        await ipcCommand(['cycle', 'pause']);
      _touchHeartbeat();
      res.json({});
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST /api/v1/server-playback/set-pause  { paused: true|false }
  velvet.post('/api/v1/server-playback/set-pause', async (req, res) => {
    const { paused } = req.body;
    try {
      if (isRunning() && ipcSock && !ipcSock.destroyed)
        await ipcCommand(['set_property', 'pause', paused === true]);
      _touchHeartbeat();
      res.json({});
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST /api/v1/server-playback/seek  { position }
  velvet.post('/api/v1/server-playback/seek', async (req, res) => {
    const { position } = req.body;
    if (position === undefined) return res.status(400).json({ error: 'position required' });
    try {
      if (isRunning() && ipcSock && !ipcSock.destroyed)
        await ipcCommand(['seek', Number(position), 'absolute']);
      _touchHeartbeat();
      res.json({});
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST /api/v1/server-playback/volume  { volume }
  velvet.post('/api/v1/server-playback/volume', async (req, res) => {
    const { volume } = req.body;
    if (volume === undefined) return res.status(400).json({ error: 'volume required' });
    try {
      const v = Math.max(0, Math.min(130, Number(volume)));
      _currentVolumePct = v; // persist for re-apply on track change
      if (isRunning() && ipcSock && !ipcSock.destroyed)
        await ipcCommand(['set_property', 'volume', v]);
      _touchHeartbeat();
      res.json({});
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST /api/v1/server-playback/loop  (cycles: none → one → all → none)
  velvet.post('/api/v1/server-playback/loop', async (req, res) => {
    try { const out = await cycleLoop(); _touchHeartbeat(); res.json(out); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST /api/v1/server-playback/reapply-gain  { gainDb, volumePct, balance }
  // Called when the user changes any audio setting while already casting to MPV.
  // All fields are optional; only provided ones are updated.
  velvet.post('/api/v1/server-playback/reapply-gain', async (req, res) => {
    const { gainDb, volumePct, balance } = req.body;
    try {
      if (volumePct != null) _currentVolumePct = Math.max(0, Math.min(130, Number(volumePct)));
      if (balance  != null) _currentBalance   = Math.max(-1, Math.min(1, Number(balance)));
      if (isRunning() && ipcSock && !ipcSock.destroyed) {
        // Update stored gainDb on the current queue entry so the next
        // file-loaded event uses the new value.
        const entry = serverQueue[currentIndex] ?? serverQueue.at(-1);
        if (entry && gainDb !== undefined) entry.gainDb = gainDb == null ? null : Number(gainDb);
        const resolvedGainDb = entry?.gainDb ?? null;
        const chain = _buildAfChain(resolvedGainDb, _currentBalance);
        await ipcCommand(['af', 'set', chain]).catch(() => {});
        await ipcCommand(['set_property', 'volume', _currentVolumePct]).catch(() => {});
      }
      _touchHeartbeat();
      res.json({});
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/v1/server-playback/detect — check mpv availability
  velvet.get('/api/v1/server-playback/detect', (req, res) => {
    const mpvBin = config.program.serverAudio?.mpvBin || 'mpv';
    child_process.execFile(mpvBin, ['--version'], { timeout: 5000 }, (err, stdout) => {
      if (err) return res.json({ found: false, version: null, path: mpvBin });
      const m = (stdout || '').match(/mpv\s+(\S+)/i);
      res.json({ found: true, version: m ? m[1] : 'unknown', path: mpvBin });
    });
  });

  // GET /api/v1/server-playback/audio-health — Linux speaker output diagnostics
  velvet.get('/api/v1/server-playback/audio-health', (req, res) => {
    try {
      if (process.platform !== 'linux') {
        return res.json({
          platform: process.platform,
          healthy: true,
          issues: [],
          note: 'Audio health checks are currently Linux-only.',
        });
      }
      return res.json(getLinuxAudioHealth());
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  // POST /api/v1/server-playback/audio-health/fix — best-effort unmute + volume set
  velvet.post('/api/v1/server-playback/audio-health/fix', (req, res) => {
    try {
      if (req.user?.admin !== true) {
        return res.status(403).json({ error: 'Admin only' });
      }
      if (process.platform !== 'linux') {
        return res.status(400).json({ error: 'Audio fix is Linux-only.' });
      }
      return res.json(applyLinuxAudioFix());
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  // POST /api/v1/server-playback/test-tone — play a stereo test tone through mpv
  velvet.post('/api/v1/server-playback/test-tone', async (req, res) => {
    try {
      if (!isRunning() || !ipcSock || ipcSock.destroyed) {
        return res.status(409).json({ ok: false, error: 'mpv is not running. Start Server Audio first.' });
      }

      // Use our bundled ffmpeg to generate a real audio file with a left/right test tone.
      // This is more reliable than lavfi:// URIs via mpv IPC.
      const { ffmpegBin } = await import('../util/ffmpeg-bootstrap.js');
      const fBin = await ffmpegBin();
      const tmpFile = path.join(os.tmpdir(), `velvet-test-tone-${Date.now()}.mp3`);

      // Generate 3s: 440 Hz on left channel, 880 Hz on right channel, then centre beep
      const ffResult = child_process.spawnSync(fBin, [
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
        '-f', 'lavfi', '-i', 'sine=frequency=880:duration=3',
        '-filter_complex', '[0:a][1:a]amerge=inputs=2,volume=0.8',
        '-ac', '2', '-ar', '44100', '-q:a', '4',
        '-y', tmpFile,
      ], { timeout: 10000 });

      if (ffResult.status !== 0 || !fs.existsSync(tmpFile)) {
        const err = String(ffResult.stderr || ffResult.stdout || 'ffmpeg failed').slice(0, 200);
        return res.status(500).json({ ok: false, error: 'Could not generate test tone: ' + err });
      }

      await ipcCommand(['loadfile', tmpFile, 'replace']);

      // Clean up temp file after playback completes (3s + buffer)
      setTimeout(() => { try { fs.unlinkSync(tmpFile); } catch (e) { console.debug('[velvet]', e?.message ?? e); } }, 6000);

      return res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });
}

// ── server-remote HTML route (before auth) ────────────────────────────────
export function setupBeforeAuth(velvet) {
  velvet.get('/server-remote', (req, res) => {
    const saEnabled = config.program.serverAudio?.enabled;
    if (!saEnabled) {
      return res.type('html').send(
        '<!doctype html><html><head><meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<title>Server Audio</title>' +
        '<style>body{font-family:system-ui,sans-serif;background:#1a1a2e;color:#e4e4e4;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}' +
        '.box{max-width:420px;padding:40px;text-align:center}h1{color:#a78bfa;margin-bottom:12px}' +
        'p{color:#8888b0;line-height:1.6;margin-bottom:24px}a{color:#a78bfa;text-decoration:none}a:hover{text-decoration:underline}</style></head>' +
        '<body><div class="box"><h1>Server Audio</h1>' +
        '<p>Server Audio playback is not enabled.<br>Go to the <a href="/admin">Admin Panel</a> → <b>Server Audio</b> to enable it, then reload this page.</p>' +
        '<a href="/admin">Admin Panel</a> &nbsp;·&nbsp; <a href="/">Normal Mode</a></div></body></html>'
      );
    }
    const filePath = path.join(config.program.webAppDirectory, 'server-remote', 'index.html');
    res.sendFile(filePath, err => {
      if (err && !res.headersSent) res.status(500).send('Server remote page not found.');
    });
  });
}

// ── Admin helper: start / stop on demand ──────────────────────────────────
export function startIfEnabled() {
  if (config.program.serverAudio?.enabled) {
    bootMpv();
  }
}
