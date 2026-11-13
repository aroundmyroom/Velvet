/**
 * src/api/sendspin.js — Velvet Rooms (plays a server-side queue on Sendspin speakers)
 *
 * Contract: docs/API/rooms.md. All routes need auth.
 *
 * Admin endpoints (admin only):
 *   GET  /api/v1/admin/sendspin/status                    — listener state, devices, rooms
 *   POST /api/v1/admin/sendspin/settings                  — enable / name / port (restarts the listener)
 *   POST /api/v1/admin/sendspin/devices/approve           — allow an unpaired device to play
 *   POST /api/v1/admin/sendspin/devices/revoke            — drop the approval
 *   POST /api/v1/admin/sendspin/devices/rename            — operator name
 *   POST /api/v1/admin/sendspin/devices/forget            — unpair, revoke, forget
 *   POST /api/v1/admin/sendspin/devices/connect           — dial the device now
 *   POST /api/v1/admin/sendspin/devices/add               — dial a speaker by LAN address (no mDNS)
 *   POST /api/v1/admin/sendspin/devices/unpair            — server/unpair + delete the record
 *   POST /api/v1/admin/sendspin/devices/pair-token        — pair with a Pairing PSK token
 *   POST /api/v1/admin/sendspin/devices/pair-code/start   — start code pairing
 *   GET  /api/v1/admin/sendspin/devices/pair-code/status  — poll a pairing attempt
 *   POST /api/v1/admin/sendspin/devices/pair-code/submit  — submit the code shown on the device
 *   POST /api/v1/admin/sendspin/devices/pair-code/cancel  — cancel the attempt
 *   POST /api/v1/admin/sendspin/devices/source           — allow / disallow a device as a line-in source
 *   POST /api/v1/admin/sendspin/devices/source-auto      — auto-switch on line sense
 *
 * Player endpoints (allow-mpv-cast or admin):
 *   GET    /api/v1/rooms                — rooms (capability probe)
 *   POST   /api/v1/rooms                — create a room from speakers
 *   PATCH  /api/v1/rooms/:id            — rename / set members
 *   DELETE /api/v1/rooms/:id            — dissolve a room into solo rooms
 *   GET    /api/v1/rooms/:id/state      — room state (polled)
 *   GET    /api/v1/rooms/:id/queue      — room queue
 *   POST   /api/v1/rooms/:id/play       — replace the queue and play
 *   POST   /api/v1/rooms/:id/add        — append (or play next)
 *   POST   /api/v1/rooms/:id/jump       — play the entry at index
 *   POST   /api/v1/rooms/:id/remove     — remove queue entries (the current one → next)
 *   POST   /api/v1/rooms/:id/move       — move one queue entry
 *   POST   /api/v1/rooms/:id/reorder    — reorder the whole queue
 *   POST   /api/v1/rooms/:id/pause|resume|next|previous|stop
 *   POST   /api/v1/rooms/:id/seek|volume|mute|repeat|shuffle
 *   GET    /api/v1/rooms/:id/eq         — the room's 8-band EQ
 *   PUT    /api/v1/rooms/:id/eq         — set it (applies within about a second while playing)
 *   GET    /api/v1/rooms/sonos              — Sonos speakers that can follow a room
 *   POST   /api/v1/rooms/:id/sonos          — a Sonos follows this room
 *   PATCH  /api/v1/rooms/:id/sonos/:uuid    — its delay
 *   DELETE /api/v1/rooms/:id/sonos/:uuid    — it stops following
 *
 * Public (the Sonos has no login; an unguessable per-session token in the path, LAN peers only):
 *   GET    /api/v1/rooms/sonos-stream/:token.mp3 — the room's live stream for a following Sonos
 *   POST   /api/v1/rooms/:id/line-in        — play a source device's input in the room
 *   POST   /api/v1/rooms/:id/line-in/stop   — stop the line-in (the queue stays paused)
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import Joi from 'joi';
import winston from 'winston';
import * as config from '../state/config.js';
import * as db from '../db/manager.js';
import * as vpath from '../util/vpath.js';
import { loadFile, saveFile } from '../util/admin.js';
import { resolvePathWithinRoot } from '../util/path-security.js';
import { resolveTrackGain } from './db.js';
import { RoomsService, RoomError, SourceError, STOP_TIMEOUT_MS } from '../sendspin/service.js';
import { createArtwork } from '../sendspin/artwork.js';
import {
  createSonosSoap, streamUrlFor, isSonosUuid, sonosStreamPeerAllowed, STREAM_PATH, MAX_SONOS_TRIM_MS,
} from '../sendspin/sonos.js';
import * as sonosApi from './sonos.js';
import { PairingInputError, decodePskToken } from '../sendspin/pairing.js';
import { EQ_BANDS, EQ_MIN_DB, EQ_MAX_DB, MAX_PRESET_LENGTH } from '../sendspin/eq.js';
import { nextForRoom } from '../autodj/library.js';
import { roomListen } from './room-listen.js';

const MAX_SONGS = 10_000;
const MAX_FILEPATH = 4096;
const STAT_BATCH = 64;
const PAIR_LIMIT = { windowMs: 60_000, mutate: 20, poll: 180 };

let service = null;
let serviceOpts = {};
let sigHandler = null;
const pairHits = new Map();

export function sendspinDataDir() {
  return path.join(config.program.storage.dbDirectory, '..', 'sendspin');
}

class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    Object.assign(this, { status, code, extra });
  }
}

const fail = (status, code, message, extra) => { throw new ApiError(status, code, message, extra); };

// "10.1.1.5", "10.1.1.5:8928", "[fd00::5]:8928", "fd00::5" or "ws://10.1.1.5:8928/sendspin"; IP literals only, so no DNS lookup decides where Velvet dials.
export function parseSpeakerAddress(input) {
  let text = String(input).trim();
  let path;
  if (/^ws:\/\//i.test(text)) {
    let u;
    try {
      u = new URL(text);
    } catch {
      return null;
    }
    if (u.username || u.password || u.search || u.hash) return null;
    text = u.host;
    path = u.pathname;
  }
  let host = text;
  let port;
  const v6 = text.match(/^\[([^\]]+)\](?::(\d{1,5}))?$/);
  const v4 = text.match(/^([\d.]+)(?::(\d{1,5}))?$/);
  if (v6) [, host, port] = v6;
  else if (v4) [, host, port] = v4;
  if (!net.isIP(host)) return null;
  return { host, port: port === undefined ? undefined : Number(port), path };
}

const name63 = Joi.string().trim().min(1).max(63).pattern(config.CONTROL_CHARS, { invert: true });
const clientId = Joi.string().min(1).max(128).required();
const SCHEMAS = {
  settings: Joi.object({ enabled: Joi.boolean(), name: name63, port: Joi.number().integer().min(1024).max(65535) }),
  client: Joi.object({ clientId }),
  rename: Joi.object({ clientId, name: name63.required() }),
  token: Joi.object({ pairingToken: Joi.string().max(256).required(), clientId: Joi.string().min(1).max(128) }),
  code: Joi.object({ clientId, code: Joi.string().max(32).required() }),
  createRoom: Joi.object({ name: name63.required(), members: Joi.array().items(Joi.string().min(1).max(128)).min(1).max(32).required() }),
  patchRoom: Joi.object({ name: name63, members: Joi.array().items(Joi.string().min(1).max(128)).min(1).max(32) }),
  songs: Joi.array().items(Joi.string().max(MAX_FILEPATH)).min(1).max(MAX_SONGS).required(),
  djs: Joi.array().items(Joi.boolean()).max(MAX_SONGS),
  rg: {
    rgEnabled: Joi.boolean(), rgMode: Joi.string().valid('track', 'album'),
    rgPreamp: Joi.number().min(-15).max(15), rgClip: Joi.boolean(),
  },
  index: Joi.object({ index: Joi.number().integer().min(0).required() }),
  queueVersion: Joi.number().integer().min(0),
  seek: Joi.object({ positionMs: Joi.number().integer().min(0).required() }),
  volume: Joi.object({ volume: Joi.number().integer().min(0).max(100).required(), clientId: Joi.string().min(1).max(128) }),
  mute: Joi.object({ muted: Joi.boolean().required(), clientId: Joi.string().min(1).max(128) }),
  repeat: Joi.object({ repeat: Joi.string().valid('off', 'all', 'one').required() }),
  shuffle: Joi.object({ shuffle: Joi.boolean().required() }),
  empty: Joi.object({}),
  sonosAdd: Joi.object({ uuid: Joi.string().max(64).required(), trimMs: Joi.number().integer().min(-MAX_SONOS_TRIM_MS).max(MAX_SONOS_TRIM_MS) }),
  sonosPatch: Joi.object({ trimMs: Joi.number().integer().min(-MAX_SONOS_TRIM_MS).max(MAX_SONOS_TRIM_MS).required() }),
  source: Joi.object({ clientId, allowed: Joi.boolean().required() }),
  sourceAuto: Joi.object({ clientId, autoSwitch: Joi.boolean().required(), roomId: Joi.string().min(1).max(64) }),
  lineIn: Joi.object({ clientId }),
  addAddress: Joi.object({ address: Joi.string().trim().min(1).max(300).required() }),
  eq: Joi.object({
    enabled: Joi.boolean().required(),
    gains: Joi.array().items(Joi.number().min(EQ_MIN_DB).max(EQ_MAX_DB).required()).length(EQ_BANDS.length).required(),
    preset: Joi.string().trim().max(MAX_PRESET_LENGTH).pattern(config.CONTROL_CHARS, { invert: true }).allow(null, ''),
  }),
};
SCHEMAS.play = Joi.object({
  songs: SCHEMAS.songs, djs: SCHEMAS.djs, index: Joi.number().integer().min(0).default(0), positionMs: Joi.number().integer().min(0).default(0),
  paused: Joi.boolean().default(false), ...SCHEMAS.rg,
});
// The web player's Auto-DJ settings and DJ state (see autodj/library.js nextForRoom). Bounded, typed, nothing more.
const djStrings = (n, len = 200) => Joi.array().items(Joi.string().max(len)).max(n);
SCHEMAS.autoDj = Joi.object({
  on: Joi.boolean().required(),
  ...SCHEMAS.rg,
  settings: Joi.object({
    similar: Joi.boolean(),
    bpmContinuity: Joi.boolean(),
    bpmBase: Joi.number().min(20).max(300).allow(null),
    bpmTolerance: Joi.number().min(0).max(100),
    filterWords: djStrings(200),
    genreFilter: Joi.object({ mode: Joi.string().valid('whitelist', 'blacklist').required(), genres: djStrings(2000) }).allow(null),
    scope: Joi.object({
      ignoreVPaths: djStrings(100, 256),
      filepathPrefix: Joi.string().max(MAX_FILEPATH).allow(null),
      excludeFilepathPrefixes: Joi.array().items(Joi.object({ vpath: Joi.string().max(256).required(), prefix: Joi.string().max(MAX_FILEPATH).required() })).max(100),
      minRating: Joi.number().integer().min(0).max(10),
      minDuration: Joi.number().min(0).max(86400),
      maxDuration: Joi.number().min(0).max(86400),
      allowUnknownDuration: Joi.boolean(),
    }),
  }),
  state: Joi.object({
    artistHistory: djStrings(500),
    bpmHistory: Joi.array().items(Joi.number()).max(50),
    yearHistory: Joi.array().items(Joi.number()).max(50),
    genreHistory: djStrings(50),
    familyHistory: djStrings(50),
    seedFamily: Joi.string().max(200).allow(null),
    lastPickFree: Joi.boolean(),
    similarFor: Joi.string().max(500).allow(''),
    similarArtists: djStrings(500),
    rankMap: Joi.object().pattern(Joi.string().max(500), Joi.number()).max(1000),
    similarSource: Joi.string().max(500).allow(''),
  }),
});
SCHEMAS.add = Joi.object({ songs: SCHEMAS.songs, djs: SCHEMAS.djs, next: Joi.boolean().default(false), queueVersion: SCHEMAS.queueVersion, ...SCHEMAS.rg });
const queueIndexes = Joi.array().items(Joi.number().integer().min(0)).min(1).max(MAX_SONGS).unique().required();
SCHEMAS.remove = Joi.object({ indexes: queueIndexes, queueVersion: SCHEMAS.queueVersion });
SCHEMAS.move = Joi.object({
  from: Joi.number().integer().min(0).required(), to: Joi.number().integer().min(0).required(), queueVersion: SCHEMAS.queueVersion,
});
SCHEMAS.reorder = Joi.object({ order: queueIndexes, queueVersion: SCHEMAS.queueVersion });

function validate(schema, value) {
  const { error, value: v } = schema.validate(value ?? {}, { abortEarly: true });
  if (error) {
    const where = error.details?.[0]?.path?.join('.') || 'body';
    fail(400, 'invalid_body', `${where} is invalid`);
  }
  return v;
}

function route(fn) {
  return async (req, res) => {
    try {
      const out = await fn(req, res);
      if (out !== undefined && !res.headersSent) res.json(out);
    } catch (err) {
      if (err instanceof ApiError) return res.status(err.status).json({ error: err.message, code: err.code, ...err.extra });
      if (err instanceof RoomError) {
        const map = { not_found: [404, 'not_found'], invalid: [400, 'invalid_body'], empty: [409, 'empty_queue'] };
        const [status, code] = map[err.code] ?? [400, 'invalid_body'];
        return res.status(status).json({ error: err.message, code });
      }
      if (err instanceof PairingInputError) return sendPairingError(res, err, req.body?.pairingToken);
      if (err instanceof SourceError) return res.status(409).json({ error: err.message, code: err.code });
      winston.error(`[rooms] ${req.method} ${req.path}: ${err.message}`);
      res.status(500).json({ error: 'Server Error', code: 'server_error' });
    }
  };
}

function tokenClient(token) {
  try {
    return decodePskToken(token).clientId;
  } catch {
    return null;
  }
}

function sendPairingError(res, err, token) {
  const status = {
    malformed_token: 422, unsupported_token_version: 422, wrong_client: 422, invalid_code: 422, cooldown: 429,
  }[err.code] ?? 409;
  const extra = {};
  if (err.code === 'cooldown') extra.retryAfterMs = err.retryAfterMs ?? 0;
  if (err.code === 'wrong_client') extra.tokenClientId = tokenClient(token);
  const messages = {
    malformed_token: 'pairing token is malformed', unsupported_token_version: 'unsupported pairing token version',
    wrong_client: 'pairing token belongs to another device', invalid_code: 'pairing code must be 6 or 8 digits',
    cooldown: 'wait before the next try',
  };
  return res.status(status).json({ error: messages[err.code] ?? err.message, code: err.code, ...extra });
}

function rateLimit(kind) {
  return (req, res, next) => {
    const now = Date.now();
    const key = `${kind}:${req.user?.username ?? ''}`;
    const hits = (pairHits.get(key) ?? []).filter((t) => now - t < PAIR_LIMIT.windowMs);
    if (hits.length >= PAIR_LIMIT[kind]) {
      pairHits.set(key, hits);
      return res.status(429).json({ error: 'too many pairing requests', code: 'rate_limited', retryAfterMs: PAIR_LIMIT.windowMs - (now - hits[0]) });
    }
    hits.push(now);
    pairHits.set(key, hits);
    if (pairHits.size > 1000) pairHits.clear();
    next();
  };
}

function settingsFromConfig() {
  const s = config.program.sendspin ?? {};
  const enabled = config.program.languages?.enabled;
  return {
    enabled: s.enabled === true,
    name: s.name || config.defaultSendspinName(),
    port: s.port ?? 8927,
    bind: s.bind ?? '0.0.0.0',
    path: s.path ?? '/sendspin',
    discovery: s.discovery !== false,
    languages: Array.isArray(enabled) && enabled.length ? enabled.slice(0, 12) : ['en'],
  };
}

// ── Sonos followers ────────────────────────────────────────────────────────

const sonosEnabled = () => config.program.sonos?.enabled !== false;

// Tests point Velvet at a fake Sonos on loopback; never honoured outside NODE_ENV=test.
function sonosTestSetup() {
  if (process.env.NODE_ENV !== 'test' || !process.env.VELVET_TEST_SONOS) return null;
  return JSON.parse(process.env.VELVET_TEST_SONOS);
}

function sonosDevicesNow() {
  return sonosTestSetup()?.devices ?? sonosApi.cachedSonosDevices();
}

function sonosDevices() {
  const test = sonosTestSetup();
  return test ? Promise.resolve(test.devices) : sonosApi.listSonosDevices();
}

function sonosBridge() {
  const test = sonosTestSetup();
  const soap = createSonosSoap(test ? { port: test.port, allowHost: (ip) => ip === '127.0.0.1' } : {});
  return {
    soap: (...args) => (sonosEnabled() ? soap(...args) : Promise.reject(new Error('Sonos is disabled in Velvet'))),
    resolve: (uuid) => sonosDevicesNow().find((d) => d.uuid === uuid) ?? null,
    streamUrl: streamUrlFor,
    enabled: sonosEnabled,
  };
}

function sonosBases(req) {
  return sonosApi.buildBaseUrl(req);
}

function svc() {
  if (!service) {
    const art = createArtwork({ artDir: config.program.storage.albumArtDirectory });
    const roomOptions = { sonos: sonosBridge(), autoDjPick, listen: roomListen, ...serviceOpts.roomOptions };
    service = new RoomsService({ dataDir: sendspinDataDir(), logger: winston, ...art, ...serviceOpts, roomOptions });
  }
  return service;
}

function installSignalHandlers() {
  if (sigHandler) return;
  sigHandler = (signal) => {
    process.off('SIGTERM', sigHandler);
    process.off('SIGINT', sigHandler);
    sigHandler = null;
    const done = () => process.kill(process.pid, signal);
    Promise.race([service?.stop(), new Promise((r) => setTimeout(r, STOP_TIMEOUT_MS + 1000).unref())]).then(done, done);
  };
  process.on('SIGTERM', sigHandler);
  process.on('SIGINT', sigHandler);
}

export async function applySettings() {
  const s = settingsFromConfig();
  await svc().apply(s);
  if (s.enabled) installSignalHandlers();
}

export function stop() {
  return service?.stop();
}

export function settingsChanged() {
  return JSON.stringify(service?.settings ?? null) !== JSON.stringify(settingsFromConfig());
}

export function setTestOptions(opts) {
  serviceOpts = opts;
}

function status() {
  const s = settingsFromConfig();
  const sv = service;
  const running = Boolean(sv?.running);
  const serverId = running ? sv.server.serverId : null;
  return {
    enabled: s.enabled,
    running,
    name: s.name,
    port: running ? (sv.server.port ?? s.port) : s.port,
    serverId,
    serverIdShort: serverId ? serverId.slice(0, 8) : null,
    error: s.enabled ? (sv?.error ?? null) : null,
    devices: running ? sv.devices() : [],
    rooms: running ? sv.listRooms() : [],
  };
}

function requireRunning() {
  if (!service?.running) fail(503, 'not_running', 'the Sendspin listener is not running');
  return service;
}

function requireDevice(sv, id) {
  if (!sv.knownIds().has(id)) fail(404, 'not_found', 'unknown device');
}

function canUseRooms(user) {
  return user?.admin === true || user?.['allow-mpv-cast'] === true;
}

function playerGuard(req, res, next) {
  if (config.program.sendspin?.enabled !== true) return res.status(409).json({ error: 'Velvet Rooms is disabled', code: 'rooms_disabled' });
  if (!canUseRooms(req.user)) return res.status(403).json({ error: 'Velvet Rooms is not allowed for this user', code: 'forbidden' });
  if (!service?.running) return res.status(503).json({ error: 'the Sendspin listener is not running', code: 'not_running' });
  next();
}

function adminGuard(req, res, next) {
  if (req.user?.admin !== true) return res.status(403).json({ error: 'Admin only', code: 'forbidden' });
  next();
}

// ── Item resolution ────────────────────────────────────────────────────────

function parentOf(name) {
  const folders = config.program.folders;
  const root = folders[name]?.root?.replace(/\/?$/, '/');
  if (!root) return null;
  for (const [other, f] of Object.entries(folders)) {
    const r = f.root.replace(/\/?$/, '/');
    if (other !== name && root.startsWith(r) && root !== r) return { vpath: other, prefix: root.slice(r.length) };
  }
  return null;
}

function locate(fp, user) {
  if (typeof fp !== 'string' || !fp || fp.length > MAX_FILEPATH || /[\0\\]/.test(fp)) return null;
  const segs = fp.split('/');
  if (segs.length < 2 || segs.some((s) => s === '' || s === '.' || s === '..')) return null;
  let info;
  try {
    info = vpath.getVPathInfo(fp, user);
  } catch {
    return null;
  }
  if (config.program.folders[info.vpath]?.type === 'excluded') return null;
  const rel = segs.slice(1).join('/');
  let file;
  try {
    file = resolvePathWithinRoot(info.basePath, rel);
  } catch {
    return null;
  }
  const parent = parentOf(info.vpath);
  return parent
    ? { fp, file, dbVpath: parent.vpath, dbRel: parent.prefix + rel }
    : { fp, file, dbVpath: info.vpath, dbRel: rel };
}

function gainFor(row, rg) {
  if (rg.rgEnabled === false) return 0;
  const r = resolveTrackGain(row, rg.rgMode === 'album' ? 'album' : 'track');
  if (r?.gain == null) return 0;
  let gain = Number(r.gain) + (Number(rg.rgPreamp) || 0);
  // The decoder applies volume= without a limiter: never push the peak over 0 dBFS.
  const headroom = r.peak == null ? 0 : -Number(r.peak);
  if (gain > headroom) gain = headroom;
  return Number.isFinite(gain) ? Math.max(-30, Math.min(20, gain)) : 0;
}

function metaOf(row) {
  const str = (v) => (typeof v === 'string' && v ? v : null);
  return {
    title: str(row.title),
    artist: str(row.artist),
    album_artist: str(row.album_artist),
    album: str(row.album),
    year: Number.isInteger(row.year) ? row.year : null,
    track: Number.isInteger(row.track) ? row.track : null,
    durationMs: row.duration > 0 ? Math.round(row.duration * 1000) : null,
    bpm: Number.isFinite(row.bpm) && row.bpm >= 1 ? Math.round(row.bpm) : null,
    aaFile: str(row.aaFile),
  };
}

async function isFile(file) {
  try {
    return (await fsp.stat(file)).isFile();
  } catch {
    return false;
  }
}

// djs: per song, whether it was an Auto-DJ pick in the web player (kept as the queue's DJ marker).
export async function resolveSongs(songs, user, rg = {}, djs = null) {
  const located = songs.map((fp) => locate(fp, user));
  const byVpath = new Map();
  for (const l of located) {
    if (!l) continue;
    if (!byVpath.has(l.dbVpath)) byVpath.set(l.dbVpath, new Set());
    byVpath.get(l.dbVpath).add(l.dbRel);
  }
  const rows = new Map();
  for (const [vp, rels] of byVpath) {
    const found = db.getFilesWithMetadataByPaths([...rels], vp, user.username);
    for (const [rel, row] of found) rows.set(`${vp}\0${rel}`, row);
  }
  const candidates = located.map((l) => (l ? { l, row: rows.get(`${l.dbVpath}\0${l.dbRel}`) } : null));
  const exists = new Map();
  const files = [...new Set(candidates.filter((c) => c?.row).map((c) => c.l.file))];
  for (let i = 0; i < files.length; i += STAT_BATCH) {
    const batch = files.slice(i, i + STAT_BATCH);
    const ok = await Promise.all(batch.map(isFile));
    batch.forEach((f, j) => exists.set(f, ok[j]));
  }
  const items = [];
  let skipped = 0;
  for (const [i, c] of candidates.entries()) {
    if (!c?.row || !exists.get(c.l.file)) {
      skipped++;
      continue;
    }
    const item = { filepath: c.l.fp, file: c.l.file, meta: metaOf(c.row), gainDb: gainFor(c.row, rg) };
    if (djs?.[i] === true) item.dj = true;
    if (Number.isInteger(c.row.channels) && c.row.channels > 0) item.channels = c.row.channels;
    items.push(item);
  }
  return { items, skipped };
}

// ── Auto-DJ for rooms ──────────────────────────────────────────────────────

// The DB (root) vpaths behind a user's folders: a child folder is indexed under its parent root.
function rootVpathsFor(user) {
  const folders = config.program.folders || {};
  const withSlash = (r) => r.replace(/\/?$/, '/');
  const out = new Set();
  for (const v of user.vpaths || []) {
    const root = folders[v]?.root;
    if (!root) continue;
    const parent = Object.entries(folders).find(([o, f]) => o !== v && f.root && withSlash(root).startsWith(withSlash(f.root)) && withSlash(root) !== withSlash(f.root));
    out.add(parent ? parent[0] : v);
  }
  return [...out];
}

// The next Auto-DJ song after `seed` for a room, picked like the web player picks it (autodj/library.js nextForRoom)
// with the switched-on user's settings, DJ state and folder access. -> { item, state } or null.
async function autoDjPick({ seed, history, queue, autoDj }) {
  const base = config.program.users?.[autoDj.user];
  if (!base) return null;
  const user = { ...base, username: autoDj.user };
  const rowOf = (fp) => {
    const l = locate(fp, user);
    return l ? db.getFilesWithMetadataByPaths([l.dbRel], l.dbVpath, user.username).get(l.dbRel) ?? null : null;
  };
  const seedRow = rowOf(seed.filepath);
  if (!seedRow) return null;
  const inQueue = new Set(queue);
  const picked = await nextForRoom({
    seedRow, seedIsDj: seed.dj === true, historyRows: history.map((h) => rowOf(h.filepath)).filter(Boolean),
    username: user.username, vpaths: rootVpathsFor(user), settings: autoDj.settings ?? {}, state: autoDj.state ?? null,
  });
  if (!picked) return null;
  const fp = `${picked.row.vpath}/${picked.row.filepath}`;
  if (inQueue.has(fp)) return null;
  const { items } = await resolveSongs([fp], user, autoDj.rg ?? {});
  return items.length ? { item: items[0], state: picked.state } : null;
}

// ── Room helpers ───────────────────────────────────────────────────────────

function lightView(sv, id) {
  const v = sv.rooms.listRooms().find((r) => r.id === id);
  if (v) return v;
  return sv.rooms.getRoom(id);
}

// Index-based edits name the queue the client saw; a stale view would edit the wrong entries.
function checkVersion(view, queueVersion) {
  if (queueVersion !== undefined && view.queueVersion !== queueVersion) {
    fail(409, 'queue_changed', 'the room queue changed', { queueVersion: view.queueVersion });
  }
}

function checkPlayable(sv, id) {
  if (!sv.playable(lightView(sv, id))) fail(409, 'not_playable', 'no speaker in this room can play now');
}

// Only paired or approved speakers can be seated in a room.
function checkMembers(sv, members) {
  const known = sv.trustedIds();
  for (const m of members) if (!known.has(m)) fail(404, 'not_found', 'unknown speaker');
}

// ── Routes ─────────────────────────────────────────────────────────────────


// Registered before the auth middleware: a Sonos cannot log in. The token in the path is per Sonos session
// (192 random bits) and dies when the Sonos leaves the room or its session ends.
export function setupPublic(velvet) {
  velvet.get(`${STREAM_PATH}:file`, (req, res) => {
    // Loopback is every local process and any reverse proxy on this host: only the test suite's fake Sonos.
    if (!sonosStreamPeerAllowed(req.socket?.remoteAddress, { loopback: process.env.NODE_ENV === 'test' })) return res.status(403).end();
    const [, token, ext] = /^([A-Za-z0-9_-]{32})\.(mp3|jpg)$/.exec(req.params.file) ?? [];
    const stream = token && service?.running ? service.rooms.sonosStream(token) : null;
    if (!stream) return res.status(404).end();
    if (ext === 'mp3') return stream.serve(req, res);
    // The cover of the song the room plays now, from the album-art folder only.
    const aaFile = stream.aaFile();
    const artDir = config.program.storage?.albumArtDirectory;
    if (!aaFile || !artDir) return res.status(404).end();
    res.sendFile(aaFile, { root: artDir, dotfiles: 'deny', headers: { 'Cache-Control': 'no-cache, no-store' } }, (err) => {
      if (err && !res.headersSent) res.status(404).end();
    });
  });
}

export function setup(velvet) {
  applySettings().catch((err) => winston.warn(`[rooms] start failed: ${err.message}`));

  const admin = (method, p, ...handlers) => velvet[method](`/api/v1/admin/sendspin${p}`, adminGuard, ...handlers);
  const player = (method, p, fn) => velvet[method](`/api/v1/rooms${p}`, playerGuard, route(fn));
  // A room scrobbles and counts plays for whoever last controlled it (see rooms.js setListener).
  const control = (method, p, fn) => player(method, p, (req, res) => {
    service.rooms.setListener(req.params.id, req.user.username);
    return fn(req, res);
  });

  admin('get', '/status', route(() => status()));

  admin('post', '/settings', route(async (req) => {
    const body = validate(SCHEMAS.settings, req.body);
    const loaded = await loadFile(config.configFile);
    loaded.sendspin = { ...(loaded.sendspin ?? {}), ...body };
    config.program.sendspin = { ...settingsFromConfig(), ...(config.program.sendspin ?? {}), ...body };
    await saveFile(loaded, config.configFile);
    await applySettings();
    return status();
  }));

  admin('post', '/devices/approve', route(async (req) => {
    const { clientId: id } = validate(SCHEMAS.client, req.body);
    const sv = requireRunning();
    requireDevice(sv, id);
    if (!sv.device(id).unpairedAccess) fail(409, 'not_playable', 'the device does not admit unpaired access');
    try {
      await sv.server.approve(id);
    } catch {
      fail(409, 'not_playable', 'this device cannot be approved');
    }
    return { ok: true, device: sv.device(id) };
  }));

  admin('post', '/devices/revoke', route(async (req) => {
    const { clientId: id } = validate(SCHEMAS.client, req.body);
    const sv = requireRunning();
    requireDevice(sv, id);
    await sv.server.revoke(id);
    return { ok: true, device: sv.device(id) };
  }));

  admin('post', '/devices/rename', route(async (req) => {
    const { clientId: id, name } = validate(SCHEMAS.rename, req.body);
    const sv = requireRunning();
    requireDevice(sv, id);
    if (!(await sv.server.trustStore.rename(id, name))) sv.setName(id, name);
    return { ok: true, device: sv.device(id) };
  }));

  admin('post', '/devices/forget', route(async (req) => {
    const { clientId: id } = validate(SCHEMAS.client, req.body);
    const sv = requireRunning();
    requireDevice(sv, id);
    await sv.server.forget(id);
    sv.rooms.forget(id);
    sv.forgetName(id);
    return { ok: true };
  }));

  admin('post', '/devices/connect', route((req) => {
    const { clientId: id } = validate(SCHEMAS.client, req.body);
    const sv = requireRunning();
    requireDevice(sv, id);
    const url = sv.server.device(id).url;
    if (!url) fail(409, 'not_connected', 'no address is known for this device');
    try {
      sv.server.connectTo(url, { source: 'manual' });
    } catch {
      fail(409, 'not_connected', 'the device address is not usable');
    }
    return { ok: true, device: sv.device(id) };
  }));

  admin('post', '/devices/add', rateLimit('mutate'), route((req) => {
    const { address } = validate(SCHEMAS.addAddress, req.body);
    const sv = requireRunning();
    const target = parseSpeakerAddress(address);
    const url = target && sv.server.dialAddress(target.host, target.port, target.path);
    if (!url) fail(400, 'bad_address', 'give an IP address on this network, optionally with :port');
    return { ok: true, url };
  }));

  admin('post', '/devices/unpair', route(async (req) => {
    const { clientId: id } = validate(SCHEMAS.client, req.body);
    const sv = requireRunning();
    requireDevice(sv, id);
    await sv.server.unpair(id);
    return { ok: true, device: sv.device(id) };
  }));

  admin('post', '/devices/pair-token', rateLimit('mutate'), route(async (req) => {
    const { pairingToken, clientId: id } = validate(SCHEMAS.token, req.body);
    const sv = requireRunning();
    const r = await sv.server.pairWithToken(pairingToken, id ?? null);
    const known = sv.knownIds().has(r.clientId);
    return { ok: true, result: r.result, clientId: r.clientId, device: known ? sv.device(r.clientId) : null };
  }));

  admin('post', '/devices/pair-code/start', rateLimit('mutate'), route((req) => {
    const { clientId: id } = validate(SCHEMAS.client, req.body);
    const sv = requireRunning();
    requireDevice(sv, id);
    return sv.server.startCodePairing(id);
  }));

  admin('get', '/devices/pair-code/status', rateLimit('poll'), route((req) => {
    const { clientId: id } = validate(SCHEMAS.client, { clientId: req.query.clientId });
    const sv = requireRunning();
    const st = sv.server.getPairingStatus(id);
    if (!st) fail(409, 'no_pairing', 'no pairing attempt for this device');
    return st;
  }));

  admin('post', '/devices/pair-code/submit', rateLimit('mutate'), route((req) => {
    const { clientId: id, code } = validate(SCHEMAS.code, req.body);
    const sv = requireRunning();
    return sv.server.submitPairingCode(id, code);
  }));

  admin('post', '/devices/pair-code/cancel', rateLimit('mutate'), route((req) => {
    const { clientId: id } = validate(SCHEMAS.client, req.body);
    const sv = requireRunning();
    return sv.server.cancelPairing(id);
  }));

  admin('post', '/devices/source', route(async (req) => {
    const { clientId: id, allowed } = validate(SCHEMAS.source, req.body);
    const sv = requireRunning();
    requireDevice(sv, id);
    await sv.sources.allow(id, allowed);
    return { ok: true, device: sv.device(id) };
  }));

  admin('post', '/devices/source-auto', route(async (req) => {
    const { clientId: id, autoSwitch, roomId } = validate(SCHEMAS.sourceAuto, req.body);
    const sv = requireRunning();
    requireDevice(sv, id);
    if (roomId) lightView(sv, roomId);
    await sv.sources.setAutoSwitch(id, autoSwitch, roomId);
    return { ok: true, device: sv.device(id) };
  }));

  velvet.get('/api/v1/rooms', (req, res, next) => {
    if (config.program.sendspin?.enabled !== true) return res.json({ enabled: false, allowed: canUseRooms(req.user), rooms: [], sources: [] });
    if (!canUseRooms(req.user)) return res.json({ enabled: true, allowed: false, rooms: [], sources: [] });
    next();
  });
  player('get', '', () => ({ enabled: true, allowed: true, rooms: service.listRooms(), sources: service.listSources() }));

  player('post', '', (req, res) => {
    const { name, members } = validate(SCHEMAS.createRoom, req.body);
    checkMembers(service, members);
    const id = service.rooms.createRoom(name, members);
    res.status(201);
    return service.room(id);
  });

  player('patch', '/:id', (req) => {
    const body = validate(SCHEMAS.patchRoom, req.body);
    const { id } = req.params;
    lightView(service, id);
    if (body.members) {
      checkMembers(service, body.members);
      service.rooms.setMembers(id, body.members);
    }
    if (body.name !== undefined) service.rooms.renameRoom(id, body.name);
    return service.room(id);
  });

  player('delete', '/:id', (req) => {
    const view = lightView(service, req.params.id);
    if (view.members.length <= 1) fail(409, 'solo_room', 'a one-speaker room cannot be deleted');
    service.rooms.deleteRoom(req.params.id);
    return { ok: true };
  });

  player('get', '/:id/state', (req) => service.room(req.params.id));

  player('get', '/:id/queue', (req) => {
    const view = service.rooms.getRoom(req.params.id);
    const idle = view.queueLength === 0;
    return {
      queueVersion: view.queueVersion,
      index: idle ? -1 : view.index,
      songs: view.queue.map((q) => ({
        filepath: q.filepath,
        title: q.meta?.title ?? null,
        artist: q.meta?.artist ?? null,
        album: q.meta?.album ?? null,
        year: q.meta?.year ?? null,
        aaFile: q.meta?.aaFile ?? null,
        durationMs: q.meta?.durationMs ?? null,
        ...(q.dj ? { dj: true } : {}),
      })),
    };
  });

  control('post', '/:id/play', async (req) => {
    const body = validate(SCHEMAS.play, req.body);
    const { id } = req.params;
    lightView(service, id);
    const { items, skipped } = await resolveSongs(body.songs, req.user, body, body.djs);
    if (!items.length) fail(400, 'invalid_body', 'no playable song in songs', { skipped });
    checkPlayable(service, id);
    const index = Math.min(body.index, items.length - 1);
    service.rooms.play(id, { items, index, positionMs: body.positionMs, paused: body.paused });
    return { ...service.room(id), skipped };
  });

  control('post', '/:id/add', async (req) => {
    const body = validate(SCHEMAS.add, req.body);
    const { id } = req.params;
    lightView(service, id);
    const { items, skipped } = await resolveSongs(body.songs, req.user, body, body.djs);
    if (!items.length) fail(400, 'invalid_body', 'no playable song in songs', { skipped });
    const before = lightView(service, id);
    checkVersion(before, body.queueVersion);
    // Adding to an empty queue starts it, except under a line-in: that keeps playing, the queue waits.
    if (before.queueLength === 0 && !before.live) {
      checkPlayable(service, id);
      service.rooms.play(id, { items });
    } else {
      service.rooms.add(id, items, { next: body.next });
    }
    const after = lightView(service, id);
    return { ok: true, queueLength: after.queueLength, queueVersion: after.queueVersion, skipped };
  });

  control('post', '/:id/jump', (req) => {
    const { index } = validate(SCHEMAS.index, req.body);
    const { id } = req.params;
    const view = lightView(service, id);
    if (!view.queueLength) fail(409, 'empty_queue', 'the room has no queue');
    if (index >= view.queueLength) fail(400, 'invalid_body', 'index is invalid');
    checkPlayable(service, id);
    service.rooms.jump(id, index);
    return service.room(id);
  });

  const edit = (action, schema, fn) => control('post', `/:id/${action}`, (req) => {
    const body = validate(schema, req.body);
    const { id } = req.params;
    checkVersion(lightView(service, id), body.queueVersion);
    fn(id, body);
    return service.room(id);
  });

  edit('remove', SCHEMAS.remove, (id, { indexes }) => service.rooms.remove(id, indexes));
  edit('move', SCHEMAS.move, (id, { from, to }) => service.rooms.move(id, from, to));
  edit('reorder', SCHEMAS.reorder, (id, { order }) => service.rooms.reorder(id, order));

  const simple = (action, fn, { needsQueue = false } = {}) => control('post', `/:id/${action}`, (req) => {
    validate(SCHEMAS.empty, req.body);
    const { id } = req.params;
    const view = lightView(service, id);
    if (needsQueue && !view.queueLength) fail(409, 'empty_queue', 'the room has no queue');
    return fn(id, view);
  });

  simple('pause', (id) => {
    service.rooms.pause(id);
    return service.room(id);
  });
  simple('resume', (id) => {
    checkPlayable(service, id);
    service.rooms.resume(id);
    return service.room(id);
  });
  simple('next', (id) => {
    service.rooms.next(id);
    return service.room(id);
  }, { needsQueue: true });
  simple('previous', (id) => {
    service.rooms.previous(id);
    return service.room(id);
  }, { needsQueue: true });
  simple('stop', (id) => {
    const before = service.room(id);
    service.rooms.stop(id);
    return { ...service.room(id), stoppedAt: { index: before.index, positionMs: before.positionMs } };
  });

  control('post', '/:id/line-in', (req) => {
    const { clientId: id } = validate(SCHEMAS.lineIn, req.body);
    lightView(service, req.params.id);
    if (!service.listSources().some((x) => x.clientId === id)) fail(404, 'not_found', 'unknown or not allowed source');
    service.sources.start(req.params.id, id);
    return service.room(req.params.id);
  });

  control('post', '/:id/line-in/stop', (req) => {
    validate(SCHEMAS.empty, req.body);
    lightView(service, req.params.id);
    service.sources.stopRoom(req.params.id);
    return service.room(req.params.id);
  });

  player('get', '/sonos', async () => {
    if (!sonosEnabled()) return { enabled: false, devices: [] };
    const devices = (await sonosDevices()).filter((d) => isSonosUuid(d.uuid));
    return {
      enabled: true, maxTrimMs: MAX_SONOS_TRIM_MS,
      devices: devices.map((d) => ({ uuid: d.uuid, name: d.name, model: d.model ?? null, roomId: service.rooms.sonosRoomOf(d.uuid) })),
    };
  });

  player('post', '/:id/sonos', (req) => {
    const { uuid, trimMs } = validate(SCHEMAS.sonosAdd, req.body);
    const { id } = req.params;
    lightView(service, id);
    if (!sonosEnabled()) fail(409, 'sonos_disabled', 'Sonos is disabled in Velvet');
    const d = sonosDevicesNow().find((x) => x.uuid === uuid);
    if (!d || !isSonosUuid(uuid)) fail(404, 'not_found', 'unknown Sonos speaker');
    service.rooms.addSonos(id, { uuid, name: d.name, ip: d.ip, base: sonosBases(req), trimMs });
    return service.room(id);
  });

  player('patch', '/:id/sonos/:uuid', (req) => {
    const { trimMs } = validate(SCHEMAS.sonosPatch, req.body);
    lightView(service, req.params.id);
    service.rooms.setSonosTrim(req.params.id, req.params.uuid, trimMs);
    return service.room(req.params.id);
  });

  player('delete', '/:id/sonos/:uuid', (req) => {
    lightView(service, req.params.id);
    service.rooms.removeSonos(req.params.id, req.params.uuid);
    return service.room(req.params.id);
  });

  control('post', '/:id/seek', (req) => {
    const { positionMs } = validate(SCHEMAS.seek, req.body);
    const { id } = req.params;
    const view = service.room(id);
    if (!view.canSeek) fail(409, 'not_seekable', 'this track cannot be seeked');
    service.rooms.seek(id, positionMs);
    return service.room(id);
  });

  player('post', '/:id/volume', (req) => {
    const { volume, clientId: id } = validate(SCHEMAS.volume, req.body);
    if (id) service.rooms.setMemberVolume(req.params.id, id, volume);
    else service.rooms.setVolume(req.params.id, volume);
    return service.room(req.params.id);
  });

  player('post', '/:id/mute', (req) => {
    const { muted, clientId: id } = validate(SCHEMAS.mute, req.body);
    if (id) service.rooms.setMemberMute(req.params.id, id, muted);
    else service.rooms.mute(req.params.id, muted);
    return service.room(req.params.id);
  });

  player('get', '/:id/autodj', (req) => service.rooms.getAutoDj(req.params.id));

  control('put', '/:id/autodj', (req) => {
    const { on, settings, state, ...rg } = validate(SCHEMAS.autoDj, req.body);
    lightView(service, req.params.id);
    service.rooms.setAutoDj(req.params.id, { on, user: req.user.username, rg, settings: settings ?? {}, state });
    return service.room(req.params.id);
  });

  player('get', '/:id/eq', (req) => service.rooms.getRoom(req.params.id).eq);

  player('put', '/:id/eq', (req) => {
    const body = validate(SCHEMAS.eq, req.body);
    lightView(service, req.params.id);
    service.rooms.setEq(req.params.id, body);
    return service.room(req.params.id);
  });

  control('post', '/:id/repeat', (req) => {
    const { repeat } = validate(SCHEMAS.repeat, req.body);
    service.rooms.setRepeat(req.params.id, repeat);
    return service.room(req.params.id);
  });

  control('post', '/:id/shuffle', (req) => {
    const { shuffle } = validate(SCHEMAS.shuffle, req.body);
    service.rooms.setShuffle(req.params.id, shuffle);
    return service.room(req.params.id);
  });
}
