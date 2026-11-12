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
 *   POST /api/v1/admin/sendspin/devices/unpair            — server/unpair + delete the record
 *   POST /api/v1/admin/sendspin/devices/pair-token        — pair with a Pairing PSK token
 *   POST /api/v1/admin/sendspin/devices/pair-code/start   — start code pairing
 *   GET  /api/v1/admin/sendspin/devices/pair-code/status  — poll a pairing attempt
 *   POST /api/v1/admin/sendspin/devices/pair-code/submit  — submit the code shown on the device
 *   POST /api/v1/admin/sendspin/devices/pair-code/cancel  — cancel the attempt
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
 *   POST   /api/v1/rooms/:id/pause|resume|next|previous|stop
 *   POST   /api/v1/rooms/:id/seek|volume|mute|repeat|shuffle
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import Joi from 'joi';
import winston from 'winston';
import * as config from '../state/config.js';
import * as db from '../db/manager.js';
import * as vpath from '../util/vpath.js';
import { loadFile, saveFile } from '../util/admin.js';
import { resolvePathWithinRoot } from '../util/path-security.js';
import { resolveTrackGain } from './db.js';
import { RoomsService, RoomError } from '../sendspin/service.js';
import { createArtwork } from '../sendspin/artwork.js';
import { PairingInputError, decodePskToken } from '../sendspin/pairing.js';

const MAX_SONGS = 10_000;
const MAX_FILEPATH = 4096;
const STAT_BATCH = 64;
const PAIR_LIMIT = { windowMs: 60_000, mutate: 20, poll: 180 };

let service = null;
let serviceOpts = {};
let sigHandler = null;
const roomItems = new Map();
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
  rg: {
    rgEnabled: Joi.boolean(), rgMode: Joi.string().valid('track', 'album'),
    rgPreamp: Joi.number().min(-15).max(15), rgClip: Joi.boolean(),
  },
  index: Joi.object({ index: Joi.number().integer().min(0).required() }),
  seek: Joi.object({ positionMs: Joi.number().integer().min(0).required() }),
  volume: Joi.object({ volume: Joi.number().integer().min(0).max(100).required(), clientId: Joi.string().min(1).max(128) }),
  mute: Joi.object({ muted: Joi.boolean().required(), clientId: Joi.string().min(1).max(128) }),
  repeat: Joi.object({ repeat: Joi.string().valid('off', 'all', 'one').required() }),
  shuffle: Joi.object({ shuffle: Joi.boolean().required() }),
  empty: Joi.object({}),
};
SCHEMAS.play = Joi.object({
  songs: SCHEMAS.songs, index: Joi.number().integer().min(0).default(0), positionMs: Joi.number().integer().min(0).default(0),
  paused: Joi.boolean().default(false), ...SCHEMAS.rg,
});
SCHEMAS.add = Joi.object({ songs: SCHEMAS.songs, next: Joi.boolean().default(false), ...SCHEMAS.rg });

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

function svc() {
  if (!service) {
    const art = createArtwork({ artDir: config.program.storage.albumArtDirectory });
    service = new RoomsService({ dataDir: sendspinDataDir(), logger: winston, ...art, ...serviceOpts });
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
    Promise.race([service?.stop(), new Promise((r) => setTimeout(r, 3000).unref())]).then(done, done);
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
  if (config.program.sendspin?.enabled !== true) return res.status(404).json({ error: 'Velvet Rooms is disabled', code: 'rooms_disabled' });
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

export async function resolveSongs(songs, user, rg = {}) {
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
  for (const c of candidates) {
    if (!c?.row || !exists.get(c.l.file)) {
      skipped++;
      continue;
    }
    items.push({ filepath: c.l.fp, file: c.l.file, meta: metaOf(c.row), gainDb: gainFor(c.row, rg) });
  }
  return { items, skipped };
}

// ── Room helpers ───────────────────────────────────────────────────────────

function lightView(sv, id) {
  const v = sv.rooms.listRooms().find((r) => r.id === id);
  if (v) return v;
  return sv.rooms.getRoom(id);
}

function checkPlayable(sv, id) {
  if (!sv.playable(lightView(sv, id))) fail(409, 'not_playable', 'no speaker in this room can play now');
}

function checkMembers(sv, members) {
  const known = sv.knownIds();
  for (const m of members) if (!known.has(m)) fail(404, 'not_found', 'unknown speaker');
}

async function itemsFor(sv, id, user) {
  const view = sv.rooms.getRoom(id);
  const cached = roomItems.get(id);
  if (cached && cached.length === view.queue.length && cached.every((it, i) => it.filepath === view.queue[i].filepath)) return cached;
  const { items } = await resolveSongs(view.queue.map((q) => q.filepath), user);
  if (items.length !== view.queue.length) fail(409, 'empty_queue', 'the room queue changed; play it again');
  roomItems.set(id, items);
  return items;
}

// ── Routes ─────────────────────────────────────────────────────────────────

export function setup(velvet) {
  applySettings().catch((err) => winston.warn(`[rooms] start failed: ${err.message}`));

  const admin = (method, p, ...handlers) => velvet[method](`/api/v1/admin/sendspin${p}`, adminGuard, ...handlers);
  const player = (method, p, fn) => velvet[method](`/api/v1/rooms${p}`, playerGuard, route(fn));

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
    if (typeof sv.rooms.forget === 'function') sv.rooms.forget(id);
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

  player('get', '', () => ({ enabled: true, rooms: service.listRooms() }));

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
    roomItems.delete(req.params.id);
    return { ok: true };
  });

  player('get', '/:id/state', (req) => service.room(req.params.id));

  player('get', '/:id/queue', (req) => {
    const view = service.rooms.getRoom(req.params.id);
    const idle = view.queueLength === 0;
    return {
      queueVersion: service.queueVersion(view.id),
      index: idle ? -1 : view.index,
      songs: view.queue.map((q) => ({
        filepath: q.filepath,
        title: q.meta?.title ?? null,
        artist: q.meta?.artist ?? null,
        album: q.meta?.album ?? null,
        year: q.meta?.year ?? null,
        aaFile: q.meta?.aaFile ?? null,
        durationMs: q.meta?.durationMs ?? null,
      })),
    };
  });

  player('post', '/:id/play', async (req) => {
    const body = validate(SCHEMAS.play, req.body);
    const { id } = req.params;
    lightView(service, id);
    const { items, skipped } = await resolveSongs(body.songs, req.user, body);
    if (!items.length) fail(400, 'invalid_body', 'no playable song in songs', { skipped });
    checkPlayable(service, id);
    const index = Math.min(body.index, items.length - 1);
    service.rooms.play(id, { items, index, positionMs: body.positionMs });
    if (body.paused) service.rooms.pause(id);
    roomItems.set(id, items);
    service.bumpQueue(id);
    return { ...service.room(id), skipped };
  });

  player('post', '/:id/add', async (req) => {
    const body = validate(SCHEMAS.add, req.body);
    const { id } = req.params;
    const before = lightView(service, id);
    const { items, skipped } = await resolveSongs(body.songs, req.user, body);
    if (!items.length) fail(400, 'invalid_body', 'no playable song in songs', { skipped });
    if (before.queueLength === 0) {
      checkPlayable(service, id);
      service.rooms.play(id, { items });
      roomItems.set(id, items);
    } else {
      service.rooms.add(id, items, { next: body.next });
      roomItems.delete(id);
    }
    service.bumpQueue(id);
    const after = lightView(service, id);
    return { ok: true, queueLength: after.queueLength, queueVersion: service.queueVersion(id), skipped };
  });

  player('post', '/:id/jump', async (req) => {
    const { index } = validate(SCHEMAS.index, req.body);
    const { id } = req.params;
    const view = lightView(service, id);
    if (!view.queueLength) fail(409, 'empty_queue', 'the room has no queue');
    if (index >= view.queueLength) fail(400, 'invalid_body', 'index is invalid');
    checkPlayable(service, id);
    if (typeof service.rooms.jump === 'function') service.rooms.jump(id, index);
    else service.rooms.play(id, { items: await itemsFor(service, id, req.user), index });
    return service.room(id);
  });

  const simple = (action, fn, { needsQueue = false } = {}) => player('post', `/:id/${action}`, (req) => {
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

  player('post', '/:id/seek', (req) => {
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

  player('post', '/:id/repeat', (req) => {
    const { repeat } = validate(SCHEMAS.repeat, req.body);
    service.rooms.setRepeat(req.params.id, repeat);
    return service.room(req.params.id);
  });

  player('post', '/:id/shuffle', (req) => {
    const { shuffle } = validate(SCHEMAS.shuffle, req.body);
    service.rooms.setShuffle(req.params.id, shuffle);
    return service.room(req.params.id);
  });
}
