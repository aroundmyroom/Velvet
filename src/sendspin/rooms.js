import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { GroupStream, serverNow } from './scheduler.js';
import { RoomVisualizer, canVisualize } from './visualizer.js';
import { encodeArtworkAnnounce, encodeArtworkParts, encodeArtworkCancel } from './wire.js';
import { defaultEq, normalizeEq, isDefaultEq } from './eq.js';
import {
  RoomSonos, SONOS_ID_PREFIX, MAX_SONOS_PER_ROOM, MAX_SONOS_DELAY_MS, DEFAULT_SONOS_DELAY_MS, isSonosUuid,
} from './sonos.js';

export const ROOMS_FILE = 'rooms.json';
export const IDLE_GRACE_MS = 10_000;
// The reference daemon reports available:false before its clock is synced, then true.
export const INITIAL_UNAVAILABLE_GRACE_MS = 5_000;
export const SCHEDULE_AHEAD_MS = 20_000;
export const PREVIOUS_RESTART_MS = 3_000;
export const ARTWORK_PART_GAP_MS = 2;
export const MAX_ROOM_NAME_BYTES = 64;
export const REPEAT_MODES = Object.freeze(['off', 'one', 'all']);

const BASE_COMMANDS = Object.freeze([
  'play', 'pause', 'stop', 'next', 'previous', 'repeat_off', 'repeat_one', 'repeat_all', 'shuffle', 'unshuffle', 'switch',
]);
const TEXT_FIELDS = ['title', 'artist', 'album_artist', 'album'];
const LIVE_COMMANDS = Object.freeze(['play', 'pause', 'stop', 'switch']);

export class RoomError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const newRoomId = () => crypto.randomBytes(32).toString('base64url');

function truncateUtf8(s, max) {
  const buf = Buffer.from(String(s), 'utf8');
  if (buf.length <= max) return String(s);
  let end = max;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8');
}

export function groupVolumes(volumes, target) {
  const level = Math.max(0, Math.min(100, target));
  const vols = volumes.map(Number);
  if (!vols.length) return [];
  let delta = level - vols.reduce((a, b) => a + b, 0) / vols.length;
  let active = vols.map((_, i) => i);
  while (active.length) {
    let lost = 0;
    const next = [];
    for (const i of active) {
      const proposed = vols[i] + delta;
      const clamped = Math.max(0, Math.min(100, proposed));
      lost += proposed - clamped;
      if (clamped === proposed) next.push(i);
      vols[i] = clamped;
    }
    if (next.length === active.length) break;
    if (next.length) delta = lost / next.length;
    active = next;
  }
  return vols.map((v) => Math.round(v));
}

function defaultSetPlayback(member, on) {
  const has = member.activities.includes('playback');
  if (has === on) return true;
  return member.activate({ activities: on ? [...member.activities, 'playback'] : member.activities.filter((a) => a !== 'playback') });
}

function playerOf(c) {
  const m = c.member;
  return m && m.isOpen !== false && m.hasRole('player') && m.state?.player ? m.state.player : null;
}

function artworkChannels(member) {
  const raw = member.state?.roles?.artwork?.channels;
  if (!Array.isArray(raw)) return null;
  const channels = raw.slice(0, 4).map((ch) => (ch && ch.source !== 'none' && ['album', 'artist'].includes(ch.source)
    ? { source: ch.source, format: ch.format, width: ch.width, height: ch.height }
    : { source: 'none' }));
  while (channels.length > 1 && channels.at(-1).source === 'none') channels.pop();
  return channels;
}

const rolesKey = (member) => (member.activeRoles ?? []).join(',');
const channelKey = (ch) => JSON.stringify(ch ?? { source: 'none' });

export class RoomManager extends EventEmitter {
  #file;
  #now;
  #log;
  #opts;
  #rooms = new Map();
  #clients = new Map();
  #saveTimer = null;
  #writing = Promise.resolve();
  #sonos;

  constructor({
    dir, file = ROOMS_FILE, now = serverNow, ffmpeg, logger = null, artworkFor = null, colorFor = null,
    setPlayback = defaultSetPlayback, idleGraceMs = IDLE_GRACE_MS, initialUnavailableGraceMs = INITIAL_UNAVAILABLE_GRACE_MS,
    random = Math.random, streamOptions = {}, visualizerOptions = {},
    sonos = null, sonosOptions = {},
  }) {
    super();
    if (!dir) throw new Error('RoomManager needs a dir');
    this.#file = path.join(dir, file);
    this.#now = now;
    this.#log = logger;
    this.#opts = { ffmpeg, artworkFor, colorFor, setPlayback, idleGraceMs, initialUnavailableGraceMs, random, streamOptions, visualizerOptions };
    this.#sonos = { bridge: sonos, ...sonosOptions };
  }

  static async open(dir, opts = {}) {
    const rm = new RoomManager({ dir, ...opts });
    await rm.load();
    return rm;
  }

  async load() {
    let data;
    try {
      data = JSON.parse(await fsp.readFile(this.#file, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw err;
    }
    for (const r of data.rooms ?? []) this.#restoreRoom(r);
    for (const [id, c] of Object.entries(data.clients ?? {})) {
      const client = this.#client(id, c.name);
      client.roomId = this.#rooms.has(c.roomId) ? c.roomId : null;
      client.previousRoomId = c.previousRoomId ?? null;
      client.parked = Boolean(c.parked);
    }
    for (const room of this.#rooms.values()) room.members = room.members.filter((id) => this.#clients.get(id)?.roomId === room.id);
    for (const c of this.#clients.values()) if (!c.roomId) this.#moveTo(c, this.#soloRoomFor(c));
  }

  #restoreRoom(r) {
    const room = this.#newRoom({ id: r.id, name: r.name ?? null, solo: r.solo ?? null });
    Object.assign(room, {
      members: [...(r.members ?? [])], queue: r.queue ?? [], index: r.index ?? 0, positionMs: r.positionMs ?? 0,
      repeat: REPEAT_MODES.includes(r.repeat) ? r.repeat : 'off', shuffle: Boolean(r.shuffle),
      lastPlayedAt: r.lastPlayedAt ?? null, queueVersion: Number.isInteger(r.queueVersion) ? r.queueVersion : 1,
      state: r.state === 'playing' || r.state === 'paused' ? 'paused' : 'stopped',
      eq: normalizeEq(r.eq ?? defaultEq()),
    });
    room.order = Array.isArray(r.order) && r.order.length === room.queue.length ? r.order : room.queue.map((_, i) => i);
    for (const x of Array.isArray(r.sonos) ? r.sonos : []) {
      if (!isSonosUuid(x?.uuid) || this.#sonosRoom(x.uuid)) continue;
      const delayMs = Number.isInteger(x.delayMs) ? Math.max(0, Math.min(MAX_SONOS_DELAY_MS, x.delayMs)) : DEFAULT_SONOS_DELAY_MS;
      this.#sonosGroup(room).add({ uuid: x.uuid, name: String(x.name ?? x.uuid), ip: x.ip ?? null, base: x.base ?? null, delayMs });
    }
  }

  async flush() {
    if (this.#saveTimer) {
      clearTimeout(this.#saveTimer);
      this.#saveTimer = null;
      this.#write();
    }
    await this.#writing;
  }

  async close() {
    for (const room of this.#rooms.values()) {
      if (room.state === 'playing') this.#halt(room, 'paused');
      clearTimeout(room.idleTimer);
      room.sonos?.close();
      room.stream?.close();
    }
    await this.flush();
  }

  attach(member) {
    const c = this.#client(member.clientId, member.info?.name);
    if (c.member && c.member !== member) this.detach(member.clientId);
    if (member.info?.name) c.name = member.info.name;
    if (!c.roomId) this.#moveTo(c, this.#soloRoomFor(c));
    c.member = member;
    c.art = { started: null, inFlight: null, queue: [], scheduled: new Set() };
    c.sent = { group: null, controller: null, metadata: false };
    c.rolesKey = rolesKey(member);
    const room = this.#rooms.get(c.roomId);
    const on = (ev, fn) => {
      member.on(ev, fn);
      c.listeners.push([ev, fn]);
    };
    on('state', (next, prev) => this.#onState(c, next, prev));
    on('command', (cmd) => this.#onCommand(c, cmd));
    on('leave', () => this.#park(c, 'leave'));
    on('activated', () => this.#onActivated(c));
    on('close', () => {
      if (c.member === member) this.detach(member.clientId);
    });
    this.#sendGroup(c, true);
    this.#sendAllState(c, room);
    if (member.state) this.#onState(c, member.state, null);
    this.#save();
    this.#changed(room);
    return room.id;
  }

  detach(clientId) {
    const c = this.#clients.get(clientId);
    if (!c?.member) return;
    clearTimeout(c.parkTimer);
    for (const [ev, fn] of c.listeners) c.member.off(ev, fn);
    c.listeners = [];
    const room = this.#rooms.get(c.roomId);
    room?.stream?.removeMember(clientId, { end: false });
    room?.vis?.removeMember(clientId, { end: false });
    if (c.art?.inFlight) clearTimeout(c.art.inFlight.timer);
    c.member = null;
    c.art = null;
    c.sent = null;
    if (room) {
      this.#pushController(room);
      this.#changed(room);
    }
  }

  isAttached(clientId) {
    return Boolean(this.#clients.get(clientId)?.member);
  }

  // Drops detached clients that keep() rejects when all they own is their own unnamed solo room.
  pruneClients(keep) {
    let dropped = 0;
    for (const c of [...this.#clients.values()]) {
      if (c.member || keep(c.id)) continue;
      const room = this.#rooms.get(c.roomId);
      if (room && (room.solo !== c.id || room.name !== null || room.members.length !== 1)) continue;
      this.forget(c.id);
      dropped++;
    }
    return dropped;
  }

  listRooms() {
    return [...this.#rooms.values()]
      .filter((r) => r.members.length || r.name !== null)
      .map((r) => this.#view(r, { queue: false }));
  }

  getRoom(id) {
    return this.#view(this.#room(id), { queue: true });
  }

  roomOf(clientId) {
    return this.#clients.get(clientId)?.roomId ?? null;
  }

  createRoom(name, clientIds = []) {
    const room = this.#newRoom({ name: this.#checkName(name) });
    this.setMembers(room.id, clientIds);
    this.#save();
    this.#changed(room);
    return room.id;
  }

  renameRoom(id, name) {
    const room = this.#room(id);
    room.name = this.#checkName(name);
    for (const cid of room.members) this.#sendGroup(this.#clients.get(cid));
    this.#save();
    this.#changed(room);
  }

  setMembers(id, clientIds) {
    const room = this.#room(id);
    const wanted = [...new Set(clientIds)];
    for (const cid of room.members.filter((x) => !wanted.includes(x))) {
      const c = this.#clients.get(cid);
      this.#moveTo(c, this.#soloRoomFor(c, room));
    }
    for (const cid of wanted) {
      const c = this.#client(cid);
      c.parked = false;
      c.previousRoomId = null;
      this.#moveTo(c, room);
    }
    this.#save();
    this.#changed(room);
  }

  deleteRoom(id) {
    const room = this.#room(id);
    if (room.solo && room.members.length === 1 && room.members[0] === room.solo) {
      throw new RoomError('invalid', 'a speaker\'s own room cannot be deleted');
    }
    this.#halt(room, 'stopped');
    for (const cid of [...room.members]) {
      const c = this.#clients.get(cid);
      this.#moveTo(c, this.#soloRoomFor(c, room));
    }
    this.#dropRoom(room);
    this.#save();
  }

  #dropRoom(room) {
    if (room.state === 'playing') this.#halt(room, 'stopped');
    room.sonos?.close();
    room.stream?.close();
    this.#clearTimers(room);
    clearTimeout(room.idleTimer);
    this.#rooms.delete(room.id);
    for (const c of this.#clients.values()) if (c.previousRoomId === room.id) c.previousRoomId = null;
    this.emit('change', room.id);
  }

  play(id, { items, index = 0, positionMs = 0, paused = false } = {}) {
    const room = this.#room(id);
    if (items) {
      if (room.state === 'playing' && paused) this.#halt(room, 'paused');
      room.queue = items.map((it) => ({ ...it }));
      room.order = room.queue.map((_, i) => i);
      room.index = Math.max(0, Math.min(index, room.queue.length - 1));
      room.positionMs = Math.max(0, positionMs);
      room.current = null;
      if (room.shuffle) this.#shuffleOrder(room, room.index);
      room.queueVersion++;
    } else if (room.state === 'playing') {
      return this.getRoom(id);
    }
    if (!room.queue.length) throw new RoomError('empty', 'nothing to play');
    if (paused) this.#load(room, room.index, room.positionMs);
    else this.#start(room, room.index, room.positionMs);
    return this.getRoom(id);
  }

  add(id, items, { next = false } = {}) {
    const room = this.#room(id);
    const fresh = items.map((it) => ({ ...it }));
    this.#editTail(room, (anchor) => (next && room.queue.length ? this.#insertAfter(room, anchor, fresh) : this.#append(room, anchor, fresh)));
    room.queueVersion++;
    this.#pushController(room);
    this.#save();
    this.#changed(room);
    return room.queue.length;
  }

  // Line-in: the room plays a live feed instead of its queue; the queue keeps its place (paused) underneath.
  // feed(track) -> async generator function in GroupStream's decode shape (see SourceSession.feed).
  playLive(id, { sourceId, name, feed }) {
    const room = this.#room(id);
    if (room.state === 'playing') this.#halt(room, room.queue.length ? 'paused' : 'stopped');
    const item = { filepath: null, live: true, meta: { title: truncateUtf8(`Line-in — ${name}`, 255), durationMs: 0 } };
    room.live = { sourceId, name, item };
    this.#clearTimers(room);
    clearTimeout(room.idleTimer);
    room.token++;
    room.state = 'playing';
    room.current = null;
    const stream = this.#stream(room);
    stream.removeMember(sourceId);
    for (const cid of room.members) this.#join(room, this.#clients.get(cid));
    stream.play({ live: feed({ item, startMs: 0, live: true, get index() { return room.index; } }) });
    for (const cid of room.members) this.#sendGroup(this.#clients.get(cid));
    this.#changed(room);
    return this.getRoom(id);
  }

  stopLive(id, sourceId = null) {
    const room = this.#rooms.get(id);
    if (!room?.live || (sourceId && room.live.sourceId !== sourceId)) return;
    this.#halt(room, room.queue.length ? 'paused' : 'stopped');
  }

  #endLive(room) {
    const live = room.live;
    if (!live) return;
    room.live = null;
    this.emit('live-ended', room.id, live.sourceId);
  }

  jump(id, index) {
    const room = this.#room(id);
    if (!room.queue.length) throw new RoomError('empty', 'nothing to play');
    if (!Number.isInteger(index) || index < 0 || index >= room.queue.length) throw new RoomError('invalid', 'index is out of range');
    this.#start(room, index, 0);
    return this.getRoom(id);
  }

  remove(id, indexes) {
    const room = this.#room(id);
    const drop = new Set(this.#checkIndexes(room, indexes));
    if (!drop.size) return;
    this.#rearrange(room, room.queue.filter((_, i) => !drop.has(i)));
  }

  move(id, from, to) {
    const room = this.#room(id);
    this.#checkIndexes(room, [from, to]);
    if (from === to) return;
    const next = room.queue.slice();
    next.splice(to, 0, ...next.splice(from, 1));
    this.#rearrange(room, next);
  }

  reorder(id, order) {
    const room = this.#room(id);
    this.#checkIndexes(room, order);
    if (order.length !== room.queue.length || new Set(order).size !== order.length) {
      throw new RoomError('invalid', 'order must list every queue index once');
    }
    if (order.every((i, at) => i === at)) return;
    this.#rearrange(room, order.map((i) => room.queue[i]));
  }

  forget(clientId) {
    const c = this.#clients.get(clientId);
    if (!c) return false;
    const member = c.member;
    if (member) this.detach(clientId);
    const from = this.#rooms.get(c.roomId);
    if (from) {
      from.members = from.members.filter((x) => x !== clientId);
      from.stream?.removeMember(clientId);
      from.vis?.removeMember(clientId);
      if (!from.members.length && from.state === 'playing') this.#halt(from, 'paused');
      this.#pushController(from);
      this.#changed(from);
    }
    this.#clients.delete(clientId);
    this.#releaseSoloRooms(c);
    if (member && member.isOpen !== false) this.attach(member);
    this.#save();
    return true;
  }

  // An empty solo room goes; one others still use becomes a named room.
  #releaseSoloRooms(c) {
    for (const room of [...this.#rooms.values()].filter((r) => r.solo === c.id)) {
      if (room.name === null && !room.members.length) {
        this.#dropRoom(room);
        continue;
      }
      room.name ??= c.name;
      room.solo = null;
    }
  }

  pause(id) {
    const room = this.#room(id);
    if (room.state !== 'playing') return;
    this.#halt(room, 'paused');
  }

  resume(id) {
    const room = this.#room(id);
    if (room.state === 'playing') return;
    if (!room.queue.length) throw new RoomError('empty', 'nothing to play');
    this.#start(room, room.index, room.positionMs);
  }

  stop(id) {
    const room = this.#room(id);
    if (room.state === 'stopped' && !room.stream?.playing) return;
    this.#halt(room, 'stopped');
  }

  next(id) {
    const room = this.#room(id);
    const n = this.#step(room, this.#currentIndex(room), 1);
    if (n === null) return this.stop(id);
    return this.#jump(room, n, 0);
  }

  previous(id) {
    const room = this.#room(id);
    const cur = this.#currentIndex(room);
    if (this.#currentPosition(room) >= PREVIOUS_RESTART_MS) return this.#jump(room, cur, 0);
    return this.#jump(room, this.#step(room, cur, -1) ?? cur, 0);
  }

  seek(id, positionMs) {
    const room = this.#room(id);
    const dur = room.queue[this.#currentIndex(room)]?.meta?.durationMs;
    const target = Math.max(0, Math.min(Math.round(positionMs), dur > 0 ? dur : Infinity));
    return this.#jump(room, this.#currentIndex(room), target);
  }

  seekRelative(id, offsetMs) {
    const room = this.#room(id);
    return this.seek(id, this.#currentPosition(room) + offsetMs);
  }

  setVolume(id, value) {
    const room = this.#room(id);
    const players = this.#players(room).filter(({ p }) => p.supportedCommands.includes('volume'));
    const sonos = (room.sonos?.volumes() ?? []).filter((s) => Number.isInteger(s.volume));
    const vols = groupVolumes([...players.map(({ p }) => p.volume ?? 0), ...sonos.map((s) => s.volume)], value);
    players.forEach(({ c }, i) => this.#command(c, { command: 'volume', volume: vols[i] }));
    sonos.forEach((s, i) => room.sonos.setVolume(s.id.slice(SONOS_ID_PREFIX.length), vols[players.length + i]));
    if (sonos.length) this.#sonosChanged(room);
    return Object.fromEntries([...players.map(({ c }) => c.id), ...sonos.map((s) => s.id)].map((k, i) => [k, vols[i]]));
  }

  setMemberVolume(id, clientId, value) {
    if (clientId.startsWith(SONOS_ID_PREFIX)) {
      const room = this.#room(id);
      const uuid = this.#sonosIn(room, clientId);
      room.sonos.setVolume(uuid, Math.max(0, Math.min(100, Math.round(value))));
      this.#sonosChanged(room);
      return;
    }
    const c = this.#memberOf(id, clientId);
    if (!playerOf(c)?.supportedCommands.includes('volume')) throw new RoomError('invalid', 'speaker volume is read-only');
    this.#command(c, { command: 'volume', volume: Math.max(0, Math.min(100, Math.round(value))) });
  }

  mute(id, muted) {
    const room = this.#room(id);
    for (const { c, p } of this.#players(room)) {
      if (p.supportedCommands.includes('mute')) this.#command(c, { command: 'mute', mute: Boolean(muted) });
    }
    for (const s of room.sonos?.volumes() ?? []) room.sonos.setMute(s.id.slice(SONOS_ID_PREFIX.length), Boolean(muted));
    if (room.sonos?.size) this.#sonosChanged(room);
  }

  setMemberMute(id, clientId, muted) {
    if (clientId.startsWith(SONOS_ID_PREFIX)) {
      const room = this.#room(id);
      room.sonos.setMute(this.#sonosIn(room, clientId), Boolean(muted));
      this.#sonosChanged(room);
      return;
    }
    const c = this.#memberOf(id, clientId);
    if (!playerOf(c)?.supportedCommands.includes('mute')) throw new RoomError('invalid', 'speaker mute is read-only');
    this.#command(c, { command: 'mute', mute: Boolean(muted) });
  }

  setRepeat(id, mode) {
    if (!REPEAT_MODES.includes(mode)) throw new RoomError('invalid', 'repeat must be off, one or all');
    const room = this.#room(id);
    if (room.repeat === mode) return;
    this.#editTail(room, () => {
      room.repeat = mode;
    });
    this.#pushController(room);
    this.#save();
    this.#changed(room);
  }

  // One EQ per room, for whatever plays from its queue (a line-in stays unequalised). A change while playing
  // re-renders from the earliest sample the speakers can still take back; the song plays on at its position.
  setEq(id, eq) {
    const room = this.#room(id);
    room.eq = normalizeEq(eq);
    if (room.state === 'playing' && !room.live && room.stream?.playing) {
      const done = room.stream.rerender((track, offsetMs, atUs) => {
        this.#dropScheduledFrom(room, atUs);
        return this.#tracksResuming(room, track, offsetMs);
      });
      if (!done) this.#start(room, this.#currentIndex(room), this.#currentPosition(room));
    }
    this.#save();
    this.#changed(room);
    return { ...room.eq, gains: room.eq.gains.slice() };
  }

  setShuffle(id, on) {
    const room = this.#room(id);
    if (room.shuffle === Boolean(on)) return;
    room.shuffle = Boolean(on);
    this.#editTail(room, (anchor) => {
      if (room.shuffle) this.#shuffleOrder(room, anchor);
      else room.order = room.queue.map((_, i) => i);
    });
    room.queueVersion++;
    this.#pushController(room);
    this.#save();
    this.#changed(room);
  }

  // Sonos followers (sonos.js): a Sonos is in at most one room; adding it elsewhere moves it.
  addSonos(id, { uuid, name, ip = null, base = null, delayMs }) {
    if (!this.#sonos.bridge) throw new RoomError('invalid', 'Sonos is not enabled');
    const room = this.#room(id);
    if (!isSonosUuid(uuid)) throw new RoomError('invalid', 'not a Sonos device id');
    const from = this.#sonosRoom(uuid);
    const keep = from?.sonos.toJSON().find((s) => s.uuid === uuid);
    const delay = delayMs ?? keep?.delayMs ?? DEFAULT_SONOS_DELAY_MS;
    if (!Number.isInteger(delay) || delay < 0 || delay > MAX_SONOS_DELAY_MS) throw new RoomError('invalid', 'delayMs is out of range');
    if (from !== room && (room.sonos?.size ?? 0) >= MAX_SONOS_PER_ROOM) throw new RoomError('invalid', 'too many Sonos speakers in this room');
    if (from && from !== room) {
      from.sonos.remove(uuid);
      this.#sonosChanged(from);
    }
    this.#sonosGroup(room).add({ uuid, name: String(name ?? keep?.name ?? uuid), ip: ip ?? keep?.ip ?? null, base: base ?? keep?.base ?? null, delayMs: delay });
    this.#sonosChanged(room);
  }

  removeSonos(id, uuid) {
    const room = this.#room(id);
    if (!room.sonos?.remove(uuid)) throw new RoomError('not_found', 'this Sonos is not in the room');
    this.#sonosChanged(room);
  }

  setSonosDelay(id, uuid, delayMs) {
    const room = this.#room(id);
    if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > MAX_SONOS_DELAY_MS) throw new RoomError('invalid', 'delayMs is out of range');
    if (!room.sonos?.setDelay(uuid, delayMs)) throw new RoomError('not_found', 'this Sonos is not in the room');
    this.#sonosChanged(room);
  }

  sonosRoomOf(uuid) {
    return this.#sonosRoom(uuid)?.id ?? null;
  }

  // The live stream a Sonos asked for, by the session token in its URL: { serve(req, res) } or null.
  sonosStream(token) {
    for (const room of this.#rooms.values()) {
      const f = room.sonos?.sessionFor(token);
      if (f) return { roomId: room.id, serve: (req, res) => room.sonos.serve(f, req, res) };
    }
    return null;
  }

  #sonosRoom(uuid) {
    for (const r of this.#rooms.values()) if (r.sonos?.has(uuid)) return r;
    return null;
  }

  #sonosIn(room, id) {
    const uuid = id.slice(SONOS_ID_PREFIX.length);
    if (!room.sonos?.has(uuid)) throw new RoomError('not_found', 'speaker is not in this room');
    return uuid;
  }

  #sonosGroup(room) {
    if (room.sonos) return room.sonos;
    const { bridge, ...opts } = this.#sonos;
    room.sonos = new RoomSonos({
      bridge, now: this.#now, logger: this.#log, ffmpeg: this.#opts.ffmpeg, ...opts,
      info: () => this.#sonosInfo(room),
      onChange: () => this.#sonosChanged(room),
    });
    if (room.stream) room.sonos.setStream(room.stream);
    return room.sonos;
  }

  #sonosInfo(room) {
    const item = room.live?.item ?? room.queue[this.#currentIndex(room)] ?? null;
    const meta = room.state === 'playing' ? item?.meta ?? {} : {};
    return { roomName: this.#roomName(room), title: meta.title ?? null, artist: meta.artist ?? null, aaFile: meta.aaFile ?? null };
  }

  #sonosChanged(room) {
    if (!this.#rooms.has(room.id)) return;
    this.#pushController(room);
    this.#save();
    this.#changed(room);
  }

  #client(id, name = null) {
    let c = this.#clients.get(id);
    if (!c) {
      c = {
        id, name: name ?? id.slice(0, 8), member: null, roomId: null, previousRoomId: null, parked: false,
        listeners: [], art: null, sent: null,
      };
      this.#clients.set(id, c);
    }
    return c;
  }

  #newRoom({ id = newRoomId(), name = null, solo = null }) {
    const room = {
      id, name, solo, members: [], queue: [], order: [], index: 0, positionMs: 0, state: 'stopped',
      repeat: 'off', shuffle: false, lastPlayedAt: null, stream: null, timers: [], idleTimer: null,
      current: null, scheduled: null, token: 0, queueVersion: 1, live: null, eq: defaultEq(),
    };
    this.#rooms.set(room.id, room);
    return room;
  }

  #room(id) {
    const room = this.#rooms.get(id);
    if (!room) throw new RoomError('not_found', 'no such room');
    return room;
  }

  #memberOf(id, clientId) {
    const room = this.#room(id);
    if (!room.members.includes(clientId)) throw new RoomError('not_found', 'speaker is not in this room');
    return this.#clients.get(clientId);
  }

  #checkName(name) {
    const s = String(name ?? '').trim();
    if (!s || Buffer.byteLength(s, 'utf8') > MAX_ROOM_NAME_BYTES) throw new RoomError('invalid', 'room name must be 1-64 bytes');
    return s;
  }

  #roomName(room) {
    if (room.name !== null) return room.name;
    return this.#clients.get(room.solo)?.name ?? 'Speaker';
  }

  #soloRoomFor(c, except = null) {
    for (const r of this.#rooms.values()) {
      if (r !== except && r.solo === c.id && r.name === null && r.members.every((x) => x === c.id)) return r;
    }
    for (const r of this.#rooms.values()) if (r.solo === c.id && r.name === null) r.solo = null;
    return this.#newRoom({ solo: c.id });
  }

  #moveTo(c, target) {
    const from = c.roomId ? this.#rooms.get(c.roomId) : null;
    if (from === target) return;
    if (from) {
      from.members = from.members.filter((x) => x !== c.id);
      from.stream?.removeMember(c.id);
      from.vis?.removeMember(c.id);
      if (from.solo && from.name === null && from.members.length && !from.members.includes(from.solo)) {
        from.name = this.#roomName(from);
      }
      if (!from.members.length && from.state === 'playing') this.#halt(from, 'paused');
      this.#pushController(from);
      this.#changed(from);
    }
    target.members.push(c.id);
    c.roomId = target.id;
    if (!c.member) return;
    this.#cancelScheduledArtwork(c);
    this.#sendGroup(c);
    this.#sendAllState(c, target);
    if (target.state === 'playing') this.#join(target, c);
    else this.#idleLater(target);
    this.#pushController(target);
    this.#changed(target);
  }

  #park(c, why) {
    const room = this.#rooms.get(c.roomId);
    if (!room) return;
    const solo = room.solo === c.id && room.members.length === 1 && room.name === null;
    if (solo) {
      if (room.state === 'playing') this.#halt(room, 'stopped');
      else if (room.state === 'paused') {
        room.state = 'stopped';
        this.#sendGroup(c);
      }
    } else {
      c.previousRoomId = room.id;
      c.parked = true;
      this.#moveTo(c, this.#soloRoomFor(c, room));
    }
    if (why === 'unavailable' && c.member) {
      this.#endArtwork(c);
      const streams = c.member.activeStreams;
      if (streams?.length) this.#safe(c, () => c.member.streamEnd());
    }
    this.#setPlayback(c, false);
    this.#save();
  }

  #switch(c) {
    const current = this.#rooms.get(c.roomId);
    const inOwnSolo = current.solo === c.id && current.members.length === 1;
    if (c.parked && inOwnSolo && this.#rooms.has(c.previousRoomId)) {
      const target = this.#rooms.get(c.previousRoomId);
      c.parked = false;
      c.previousRoomId = null;
      this.#moveTo(c, target);
      this.#save();
      return;
    }
    const playing = [...this.#rooms.values()].filter((r) => r.state === 'playing');
    const others = (r) => r.members.filter((x) => x !== c.id).length;
    const multi = playing.filter((r) => others(r) >= 2);
    const single = playing.filter((r) => others(r) === 1);
    const cycle = [...multi, ...single];
    if (c.member?.hasRole('player')) cycle.push(inOwnSolo ? current : this.#soloRoomFor(c, current));
    if (!cycle.length) return;
    const at = cycle.indexOf(current);
    const target = cycle[(at + 1) % cycle.length];
    c.parked = false;
    c.previousRoomId = null;
    this.#moveTo(c, target);
    this.#save();
  }

  #parkLater(c) {
    const member = c.member;
    c.parkTimer = setTimeout(() => {
      if (c.member === member && member.state && !member.state.available) this.#park(c, 'unavailable');
    }, this.#opts.initialUnavailableGraceMs);
    c.parkTimer.unref?.();
  }

  #onActivated(c) {
    const key = rolesKey(c.member);
    if (key === c.rolesKey) return;
    c.rolesKey = key;
    const room = this.#rooms.get(c.roomId);
    if (c.art?.inFlight) clearTimeout(c.art.inFlight.timer);
    c.art = { started: null, inFlight: null, queue: [], scheduled: new Set() };
    c.sent = { group: c.sent.group, controller: null, metadata: false };
    this.#sendAllState(c, room);
  }

  #onState(c, next, prev) {
    const room = this.#rooms.get(c.roomId);
    clearTimeout(c.parkTimer);
    if (!next.available) {
      if (!prev) this.#parkLater(c);
      else if (prev.available !== false) this.#park(c, 'unavailable');
      this.#pushController(room);
      this.#changed(room);
      return;
    }
    if (room.state === 'playing') {
      if (room.stream?.has(c.id)) room.stream.memberChanged(c.id);
      room.vis?.memberChanged(c.id);
      this.#join(room, c);
    }
    const before = prev ? JSON.stringify(prev.roles?.artwork ?? null) : null;
    if (before !== JSON.stringify(next.roles?.artwork ?? null) || prev?.available === false) this.#syncArtwork(c, room);
    this.#pushController(room);
    this.#changed(room);
  }

  #onCommand(c, { controller: cmd }) {
    const room = this.#rooms.get(c.roomId);
    if (!room || !cmd) return;
    const ctl = this.#controllerState(room);
    if (!ctl.supported_commands.includes(cmd.command)) return;
    try {
      this.#runCommand(c, room, ctl, cmd);
    } catch (err) {
      if (!(err instanceof RoomError)) throw err;
    }
  }

  #runCommand(c, room, ctl, cmd) {
    const isInt = Number.isInteger;
    switch (cmd.command) {
      case 'play': return this.play(room.id);
      case 'pause': return this.pause(room.id);
      case 'stop': return this.stop(room.id);
      case 'next': return this.next(room.id);
      case 'previous': return this.previous(room.id);
      case 'volume': return isInt(cmd.volume) && cmd.volume >= 0 && cmd.volume <= 100 ? this.setVolume(room.id, cmd.volume) : undefined;
      case 'mute': return typeof cmd.mute === 'boolean' ? this.mute(room.id, cmd.mute) : undefined;
      case 'repeat_off': return this.setRepeat(room.id, 'off');
      case 'repeat_one': return this.setRepeat(room.id, 'one');
      case 'repeat_all': return this.setRepeat(room.id, 'all');
      case 'shuffle': return this.setShuffle(room.id, true);
      case 'unshuffle': return this.setShuffle(room.id, false);
      case 'switch': return this.#switch(c);
      case 'seek':
        return isInt(cmd.position_ms) && cmd.position_ms >= 0 && cmd.position_ms <= ctl.seek_max_ms
          ? this.seek(room.id, cmd.position_ms) : undefined;
      case 'seek_relative': return isInt(cmd.offset_ms) ? this.seekRelative(room.id, cmd.offset_ms) : undefined;
      default: return undefined;
    }
  }

  #stream(room) {
    if (room.stream) return room.stream;
    const s = new GroupStream({ ffmpeg: this.#opts.ffmpeg, now: this.#now, logger: this.#log, ...this.#opts.streamOptions });
    s.on('track', (t) => this.#onTrack(room, t));
    s.on('ended', () => this.#onEnded(room));
    s.on('error', (err) => this.#onStreamError(room, err));
    s.on('member-error', (cid, err) => this.emit('member-error', room.id, cid, err));
    room.stream = s;
    room.sonos?.setStream(s);
    room.vis = new RoomVisualizer(s, { now: this.#now, logger: this.#log, ...this.#opts.visualizerOptions });
    return s;
  }

  #eligible(c) {
    const m = c.member;
    return Boolean(m && m.isOpen !== false && m.state?.available && m.hasRole('player') && m.playerStateReceived);
  }

  #setPlayback(c, on) {
    if (!c.member || c.member.isOpen === false) return false;
    return this.#safe(c, () => this.#opts.setPlayback(c.member, on)) === true;
  }

  #join(room, c) {
    // A device never hears its own line-in: it would play its input back with the room's delay (an echo).
    if (room.live?.sourceId === c.id) return;
    const audio = this.#eligible(c) && !room.stream?.has(c.id);
    const vis = canVisualize(c.member);
    if ((!audio && !vis) || !this.#setPlayback(c, true)) return;
    const joined = audio && this.#stream(room).addMember(c.member);
    if (vis) this.#stream(room);
    const watching = vis && room.vis.addMember(c.member);
    if (audio && !joined && !watching) this.#setPlayback(c, false);
  }

  #start(room, index, positionMs) {
    this.#endLive(room);
    this.#clearTimers(room);
    clearTimeout(room.idleTimer);
    room.token++;
    room.state = 'playing';
    room.index = index;
    room.positionMs = positionMs;
    room.lastPlayedAt = Date.now();
    room.current = null;
    const stream = this.#stream(room);
    for (const cid of room.members) this.#join(room, this.#clients.get(cid));
    stream.play(this.#tracksFrom(room, index, positionMs));
    for (const cid of room.members) this.#sendGroup(this.#clients.get(cid));
    this.#save();
    this.#changed(room);
  }

  #jump(room, index, positionMs) {
    if (room.state === 'playing') return this.#start(room, index, positionMs);
    this.#cancelScheduled(room);
    room.index = index;
    room.positionMs = positionMs;
    room.current = null;
    room.token++;
    this.#pushTrackState(room, this.#now());
    this.#pushController(room);
    this.#save();
    this.#changed(room);
    return undefined;
  }

  #load(room, index, positionMs) {
    if (room.state === 'playing') this.#halt(room, 'paused');
    room.state = 'paused';
    this.#jump(room, index, positionMs);
    for (const cid of room.members) this.#sendGroup(this.#clients.get(cid));
    this.#idleLater(room);
  }

  // A queue/order change while playing: the current track plays on, what the decode already read ahead is
  // replaced from the track the scheduler can still change (see GroupStream.replaceUpcoming).
  #editTail(room, edit) {
    if (room.state !== 'playing' || !room.stream?.playing || room.live) {
      edit(this.#currentIndex(room));
      return;
    }
    const spliced = room.stream.replaceUpcoming((anchor, atUs) => {
      edit(anchor.index);
      this.#dropScheduledFrom(room, atUs);
      return this.#tracksAfter(room, anchor.item);
    });
    if (spliced) return;
    const pos = this.#currentPosition(room);
    edit(this.#currentIndex(room));
    this.#start(room, this.#currentIndex(room), pos);
  }

  #insertAfter(room, anchor, items) {
    const at = anchor + 1;
    const k = items.length;
    room.queue.splice(at, 0, ...items);
    room.order = room.order.map((i) => (i >= at ? i + k : i));
    room.order.splice(room.order.indexOf(anchor) + 1, 0, ...items.map((_, j) => at + j));
    if (room.index >= at) room.index += k;
  }

  #append(room, anchor, items) {
    const base = room.queue.length;
    room.queue.push(...items);
    const added = items.map((_, i) => base + i);
    const pos = room.order.indexOf(anchor);
    if (room.shuffle && pos >= 0) {
      const rest = this.#shuffleArray(room.order.slice(pos + 1).concat(added));
      room.order = room.order.slice(0, pos + 1).concat(rest);
    } else {
      room.order.push(...added);
    }
  }

  #checkIndexes(room, indexes) {
    if (!Array.isArray(indexes)) throw new RoomError('invalid', 'indexes must be a list');
    for (const i of indexes) {
      if (!Number.isInteger(i) || i < 0 || i >= room.queue.length) throw new RoomError('invalid', 'index is out of range');
    }
    return indexes;
  }

  // nextQueue holds existing entries (a subset, any order). Entries keep their identity, so the track playing
  // is never interrupted unless it is the one removed; the shuffle order is kept for the entries that stay.
  #rearrange(room, nextQueue) {
    const cur = room.queue[this.#currentIndex(room)] ?? null;
    const keep = new Set(nextQueue);
    if (cur && !keep.has(cur) && room.live) {
      this.#dropUnderLive(room, cur, keep, nextQueue);
    } else if (cur && !keep.has(cur)) {
      this.#dropCurrent(room, cur, keep, nextQueue);
    } else {
      let restart = null;
      this.#editTail(room, (anchor) => {
        const committed = room.queue[anchor];
        // The track after the current one was already handed to the stream (a boundary is a moment away).
        if (committed && committed !== cur && !keep.has(committed)) restart = { from: this.#survivorAfter(room, committed, keep) };
        this.#applyQueue(room, nextQueue);
        if (cur) room.index = room.queue.indexOf(cur);
      });
      if (cur) room.index = room.queue.indexOf(cur);
      if (restart?.from) this.#start(room, room.queue.indexOf(restart.from), 0);
      else if (restart) this.#halt(room, 'stopped');
    }
    room.queueVersion++;
    this.#pushController(room);
    this.#save();
    this.#changed(room);
  }

  #dropCurrent(room, cur, keep, nextQueue) {
    const next = this.#survivorAfter(room, cur, keep);
    if (!next && room.state !== 'stopped') this.#halt(room, 'stopped');
    this.#applyQueue(room, nextQueue);
    if (next) {
      this.#jump(room, room.queue.indexOf(next), 0);
      return;
    }
    room.index = room.order[0] ?? 0;
    room.positionMs = 0;
    room.current = null;
    this.#pushTrackState(room, this.#now());
  }

  // A line-in plays over the queue: removing the paused entry under it only moves the queue's place.
  #dropUnderLive(room, cur, keep, nextQueue) {
    const next = this.#survivorAfter(room, cur, keep);
    this.#applyQueue(room, nextQueue);
    room.index = next ? room.queue.indexOf(next) : (room.order[0] ?? 0);
    room.positionMs = 0;
  }

  #survivorAfter(room, item, keep) {
    const start = room.queue.indexOf(item);
    let i = start;
    for (let k = 0; k < room.queue.length; k++) {
      i = this.#step(room, i, 1);
      if (i === null || i === start) return null;
      if (keep.has(room.queue[i])) return room.queue[i];
    }
    return null;
  }

  #applyQueue(room, nextQueue) {
    const at = new Map(nextQueue.map((it, i) => [it, i]));
    room.order = room.shuffle
      ? room.order.map((i) => at.get(room.queue[i])).filter((i) => i !== undefined)
      : nextQueue.map((_, i) => i);
    room.queue = nextQueue;
  }

  #dropScheduledFrom(room, atUs) {
    if (atUs === null) return;
    room.timers = room.timers.filter((t) => {
      if (t.forUs < atUs) return true;
      clearTimeout(t);
      return false;
    });
    room.lastScheduledUs = Math.max(room.current?.timestampUs ?? 0, ...room.timers.map((t) => t.forUs));
    if (room.scheduled && room.scheduled.timestampUs >= atUs) {
      room.scheduled = null;
      for (const cid of room.members) this.#cancelScheduledArtwork(this.#clients.get(cid));
    }
  }

  #halt(room, state) {
    const pos = room.stream?.stop() ?? null;
    if (pos && room.state === 'playing' && !room.live) {
      room.index = pos.track.index;
      room.positionMs = pos.positionMs;
    }
    this.#cancelScheduled(room);
    room.state = state;
    if (state === 'stopped' && !room.live) room.positionMs = 0;
    this.#endLive(room);
    room.current = null;
    for (const cid of room.members) this.#sendGroup(this.#clients.get(cid));
    this.#pushTrackState(room, this.#now());
    this.#pushController(room);
    this.#idleLater(room);
    this.#save();
    this.#changed(room);
  }

  #idleLater(room) {
    clearTimeout(room.idleTimer);
    room.idleTimer = setTimeout(() => {
      room.idleTimer = null;
      if (room.state === 'playing') return;
      for (const cid of room.members) this.#setPlayback(this.#clients.get(cid), false);
    }, this.#opts.idleGraceMs);
    room.idleTimer.unref?.();
  }

  #onEnded(room) {
    if (room.live) {
      this.#halt(room, room.queue.length ? 'paused' : 'stopped');
      return;
    }
    room.stream.stop();
    room.index = room.order[0] ?? 0;
    this.#halt(room, 'stopped');
    this.emit('ended', room.id);
  }

  #onStreamError(room, err) {
    this.#log?.warn?.(`[sendspin] room "${this.#roomName(room)}" stopped: ${err.message}`);
    this.#halt(room, 'stopped');
    this.emit('error', Object.assign(err, { roomId: room.id }));
  }

  // Tracks follow queue entries by identity, so an insert while playing never shifts what is decoded.
  #track(room, item, startMs) {
    return {
      file: item.file, startMs, gainDb: item.gainDb ?? 0, eq: room.eq, item,
      get index() { return room.queue.indexOf(item); },
    };
  }

  *#tracksResuming(room, track, offsetMs) {
    const t = this.#track(room, track.item, (track.startMs ?? 0) + offsetMs);
    if (offsetMs > 0) t.resume = true;
    yield t;
    yield* this.#tracksAfter(room, track.item);
  }

  #after(room, item) {
    const i = room.queue.indexOf(item);
    if (i < 0) return null;
    const n = room.repeat === 'one' ? i : this.#step(room, i, 1);
    return n === null ? null : room.queue[n];
  }

  *#tracksFrom(room, index, positionMs) {
    const first = room.queue[index];
    if (!first) return;
    yield this.#track(room, first, positionMs);
    yield* this.#tracksAfter(room, first);
  }

  *#tracksAfter(room, item) {
    for (let it = this.#after(room, item); it; it = this.#after(room, it)) yield this.#track(room, it, 0);
  }

  #step(room, index, dir) {
    const pos = room.order.indexOf(index);
    const n = pos + dir;
    if (n >= 0 && n < room.order.length) return room.order[n];
    if (room.repeat === 'all' && room.order.length) return dir > 0 ? room.order[0] : room.order.at(-1);
    return null;
  }

  #shuffleArray(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.#opts.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  #shuffleOrder(room, cur = this.#currentIndex(room)) {
    const rest = this.#shuffleArray(room.queue.map((_, i) => i).filter((i) => i !== cur));
    room.order = room.queue.length ? [cur, ...rest] : [];
  }

  #currentIndex(room) {
    return room.current?.index ?? room.stream?.position()?.track.index ?? room.index;
  }

  #currentPosition(room) {
    if (room.live) return 0;
    if (room.state !== 'playing') return room.positionMs;
    return room.stream?.position()?.positionMs ?? room.positionMs;
  }

  #onTrack(room, { track, timestampUs, first }) {
    const token = room.token;
    const { item } = track;
    const entry = {
      item, startMs: track.startMs ?? 0, timestampUs,
      get index() { return item.live ? room.index : room.queue.indexOf(item); },
    };
    if (first) {
      room.lastScheduledUs = timestampUs;
      this.#becomeCurrent(room, entry);
      return;
    }
    const sendAt = Math.max(this.#now(), timestampUs - SCHEDULE_AHEAD_MS * 1000, (room.lastScheduledUs ?? 0) + 1000);
    room.lastScheduledUs = timestampUs;
    this.#later(room, sendAt, timestampUs, () => {
      if (room.token !== token) return;
      room.scheduled = entry;
      this.#pushTrackState(room, timestampUs, entry);
    });
    this.#later(room, timestampUs, timestampUs, () => {
      if (room.token !== token) return;
      room.scheduled = null;
      this.#becomeCurrent(room, entry, { announce: false });
    });
  }

  #becomeCurrent(room, entry, { announce = true } = {}) {
    room.current = entry;
    room.index = entry.index;
    if (!entry.item.live) room.positionMs = entry.startMs;
    if (announce) this.#pushTrackState(room, entry.timestampUs, entry);
    this.#pushController(room);
    this.#save();
    this.#changed(room);
  }

  #later(room, atUs, forUs, fn) {
    const t = setTimeout(() => {
      room.timers = room.timers.filter((x) => x !== t);
      fn();
    }, Math.max(0, Math.ceil((atUs - this.#now()) / 1000)));
    t.forUs = forUs;
    t.unref?.();
    room.timers.push(t);
  }

  #clearTimers(room) {
    for (const t of room.timers) clearTimeout(t);
    room.timers = [];
    room.lastScheduledUs = 0;
  }

  #cancelScheduled(room) {
    this.#clearTimers(room);
    if (!room.scheduled) return;
    room.scheduled = null;
    for (const cid of room.members) this.#cancelScheduledArtwork(this.#clients.get(cid));
  }

  #players(room) {
    const out = [];
    for (const cid of room.members) {
      const c = this.#clients.get(cid);
      const p = playerOf(c);
      if (p && c.member.state.available) out.push({ c, p });
    }
    return out;
  }

  #controllerState(room) {
    const players = this.#players(room);
    const vol = players.filter(({ p }) => p.supportedCommands.includes('volume') && Number.isInteger(p.volume));
    const mute = players.filter(({ p }) => p.supportedCommands.includes('mute') && typeof p.muted === 'boolean');
    const sonos = room.sonos?.volumes() ?? [];
    const volumes = [...vol.map(({ p }) => p.volume), ...sonos.map((s) => s.volume).filter(Number.isInteger)];
    const mutes = [...mute.map(({ p }) => p.muted), ...sonos.map((s) => s.muted).filter((m) => typeof m === 'boolean')];
    const commands = room.live ? [...LIVE_COMMANDS] : [...BASE_COMMANDS];
    if (volumes.length) commands.push('volume');
    if (mutes.length) commands.push('mute');
    const dur = room.live ? 0 : room.queue[this.#currentIndex(room)]?.meta?.durationMs;
    if (dur > 0) commands.push('seek', 'seek_relative');
    const state = {
      supported_commands: commands,
      volume: volumes.length ? Math.round(volumes.reduce((a, v) => a + v, 0) / volumes.length) : 100,
      muted: mutes.length ? mutes.every(Boolean) : false,
      repeat: room.repeat,
      shuffle: room.shuffle,
    };
    if (dur > 0) state.seek_max_ms = Math.round(dur);
    return state;
  }

  #metadataState(room, timestampUs, entry, playing) {
    const md = { timestamp: Math.round(timestampUs) };
    const item = entry?.item;
    if (!item) return md;
    const meta = item.meta ?? {};
    for (const k of TEXT_FIELDS) if (typeof meta[k] === 'string' && meta[k]) md[k] = truncateUtf8(meta[k], 255);
    if (Number.isInteger(meta.year)) md.year = meta.year;
    if (Number.isInteger(meta.track) && meta.track >= 1) md.track = meta.track;
    if (typeof meta.artworkUrl === 'string' && Buffer.byteLength(meta.artworkUrl) <= 2048) md.artwork_url = meta.artworkUrl;
    md.progress = {
      track_progress: Math.max(0, Math.round(entry.positionMs ?? entry.startMs ?? 0)),
      track_duration: meta.durationMs > 0 ? Math.round(meta.durationMs) : 0,
      playback_speed: playing ? 1000 : 0,
    };
    return md;
  }

  #nowEntry(room) {
    const playing = room.state === 'playing';
    if (playing && room.current) {
      return { entry: { ...room.current, positionMs: this.#currentPosition(room) }, playing, at: this.#now() };
    }
    const index = room.current?.index ?? room.index;
    const item = room.queue[index];
    if (!item) return { entry: null, playing: false, at: this.#now() };
    return { entry: { index, item, positionMs: room.positionMs }, playing: false, at: this.#now() };
  }

  #pushTrackState(room, timestampUs, entry = null) {
    for (const cid of room.members) {
      const c = this.#clients.get(cid);
      if (!c.member || c.member.isOpen === false) continue;
      if (entry) this.#sendTrackState(c, room, entry, timestampUs);
      else this.#sendCurrentTrackState(c, room);
    }
  }

  #sendCurrentTrackState(c, room) {
    const { entry, playing, at } = this.#nowEntry(room);
    if (c.member.hasRole('metadata')) {
      this.#safe(c, () => c.member.serverState({ metadata: this.#metadataState(room, at, entry, playing) }));
      c.sent.metadata = true;
    }
    this.#sendColor(c, room, entry?.item ?? null, at);
    this.#sendArtwork(c, room, entry?.item ?? null, at);
  }

  #sendTrackState(c, room, entry, timestampUs) {
    const now = this.#now();
    if (timestampUs > now && !c.sent.metadata) this.#sendCurrentTrackState(c, room);
    if (c.member.hasRole('metadata')) {
      const md = this.#metadataState(room, timestampUs, { ...entry, positionMs: entry.startMs }, true);
      this.#safe(c, () => c.member.serverState({ metadata: md }));
      c.sent.metadata = true;
    }
    this.#sendColor(c, room, entry.item, timestampUs);
    this.#sendArtwork(c, room, entry.item, timestampUs);
  }

  #sendAllState(c, room) {
    if (!c.member || c.member.isOpen === false) return;
    if (c.member.hasRole('controller')) {
      const ctl = this.#controllerState(room);
      c.sent.controller = JSON.stringify(ctl);
      this.#safe(c, () => c.member.serverState({ controller: ctl }));
    }
    this.#sendCurrentTrackState(c, room);
    if (room.scheduled) this.#sendTrackState(c, room, room.scheduled, room.scheduled.timestampUs);
  }

  #pushController(room) {
    const ctl = this.#controllerState(room);
    const json = JSON.stringify(ctl);
    for (const cid of room.members) {
      const c = this.#clients.get(cid);
      if (!c.member || c.member.isOpen === false || !c.member.hasRole('controller') || c.sent.controller === json) continue;
      c.sent.controller = json;
      this.#safe(c, () => c.member.serverState({ controller: ctl }));
    }
  }

  #sendGroup(c, force = false) {
    if (!c?.member || c.member.isOpen === false) return;
    const room = this.#rooms.get(c.roomId);
    const g = { playbackState: room.state === 'playing' ? 'playing' : 'stopped', groupId: room.id, groupName: this.#roomName(room) };
    const json = JSON.stringify(g);
    if (!force && c.sent.group === json) return;
    c.sent.group = json;
    this.#safe(c, () => c.member.groupUpdate(g));
  }

  #sendColor(c, room, item, timestampUs) {
    if (!c.member.hasRole('color')) return;
    const token = room.token;
    const send = (colors) => {
      if (!c.member || room.token !== token || c.roomId !== room.id) return;
      this.#safe(c, () => c.member.serverState({ color: { timestamp: Math.round(timestampUs), ...(colors ?? {}) } }));
    };
    if (!item || !this.#opts.colorFor) return send(null);
    Promise.resolve(this.#opts.colorFor(item)).then(send, (err) => {
      this.#log?.debug?.(`[sendspin] colour extraction failed: ${err.message}`);
      send(null);
    });
    return undefined;
  }

  #syncArtwork(c, room) {
    const m = c.member;
    if (!m || !m.hasRole('artwork') || !m.state?.available) return;
    const channels = artworkChannels(m);
    if (!channels) return;
    const prev = c.art.started;
    if (prev && JSON.stringify(prev) === JSON.stringify(channels)) return;
    const changed = channels.map((ch, i) => !prev || channelKey(prev[i]) !== channelKey(ch));
    if (c.art.inFlight && changed[c.art.inFlight.channel] !== false) this.#cancelTransfer(c);
    c.art.queue = c.art.queue.filter((t) => !changed[t.channel]);
    if (prev) {
      prev.forEach((ch, i) => {
        if (ch.source !== 'none' && (channels[i]?.source ?? 'none') === 'none') {
          this.#safe(c, () => m.sendBinary(encodeArtworkAnnounce(i, this.#now(), 0)));
        }
      });
    }
    if (!channels.some((ch) => ch.source !== 'none')) {
      if (prev) this.#safe(c, () => m.streamEnd(['artwork']));
      c.art.started = null;
      return;
    }
    if (this.#safe(c, () => m.streamStart({ artwork: { channels } })) !== true) return;
    c.art.started = channels;
    const { entry, at } = this.#nowEntry(room);
    channels.forEach((ch, i) => {
      if (changed[i] && ch.source !== 'none') this.#queueImage(c, room, i, entry?.item ?? null, at);
    });
    if (room.scheduled) {
      channels.forEach((ch, i) => {
        if (changed[i] && ch.source !== 'none') this.#queueImage(c, room, i, room.scheduled.item, room.scheduled.timestampUs);
      });
    }
  }

  #sendArtwork(c, room, item, timestampUs) {
    if (!c.art?.started) {
      this.#syncArtwork(c, room);
      return;
    }
    c.art.started.forEach((ch, i) => {
      if (ch.source !== 'none') this.#queueImage(c, room, i, item, timestampUs);
    });
  }

  #endArtwork(c) {
    if (!c.art?.started) return;
    if (c.art.inFlight) this.#cancelTransfer(c);
    c.art.queue = [];
    c.art.started = null;
    if (c.member.activeStreams?.includes('artwork')) this.#safe(c, () => c.member.streamEnd(['artwork']));
  }

  #cancelScheduledArtwork(c) {
    if (!c?.art?.started) return;
    const now = this.#now();
    c.art.queue = c.art.queue.filter((t) => t.timestampUs <= now);
    if (c.art.inFlight && c.art.inFlight.timestampUs > now) this.#cancelTransfer(c);
    for (const ch of c.art.scheduled) this.#safe(c, () => c.member.sendBinary(encodeArtworkCancel(ch)));
    c.art.scheduled.clear();
  }

  #queueImage(c, room, channel, item, timestampUs) {
    const spec = c.art.started[channel];
    const token = room.token;
    const art = c.art;
    const enqueue = (image) => {
      if (c.art !== art || !art.started || channelKey(art.started[channel]) !== channelKey(spec) || room.token !== token) return;
      const t = { channel, timestampUs: Math.round(timestampUs), image: image ?? Buffer.alloc(0) };
      const present = t.timestampUs <= this.#now();
      art.queue = art.queue.filter((q) => q.channel !== channel || (!present && q.timestampUs <= this.#now()));
      if (art.inFlight?.channel === channel && present) this.#cancelTransfer(c);
      art.queue.push(t);
      this.#pumpArtwork(c);
    };
    if (!item || !this.#opts.artworkFor) return enqueue(null);
    Promise.resolve(this.#opts.artworkFor(item, spec)).then(enqueue, (err) => {
      this.#log?.debug?.(`[sendspin] artwork failed: ${err.message}`);
      enqueue(null);
    });
    return undefined;
  }

  #cancelTransfer(c) {
    const f = c.art.inFlight;
    clearTimeout(f.timer);
    c.art.inFlight = null;
    this.#safe(c, () => c.member.sendBinary(encodeArtworkCancel(f.channel)));
  }

  #pumpArtwork(c) {
    const art = c.art;
    if (!art || art.inFlight || !art.queue.length || !c.member) return;
    const t = art.queue.shift();
    if (this.#safe(c, () => c.member.sendBinary(encodeArtworkAnnounce(t.channel, t.timestampUs, t.image.length))) !== true) return;
    if (t.timestampUs > this.#now()) art.scheduled.add(t.channel);
    else art.scheduled.delete(t.channel);
    if (!t.image.length) {
      this.#pumpArtwork(c);
      return;
    }
    const parts = encodeArtworkParts(t.channel, t.image);
    const flight = { channel: t.channel, timestampUs: t.timestampUs, timer: null };
    art.inFlight = flight;
    const step = (i) => {
      if (art.inFlight !== flight || c.art !== art) return;
      if (this.#safe(c, () => c.member.sendBinary(parts[i])) !== true) {
        art.inFlight = null;
        return;
      }
      if (i + 1 < parts.length) {
        flight.timer = setTimeout(() => step(i + 1), ARTWORK_PART_GAP_MS);
        return;
      }
      art.inFlight = null;
      this.#pumpArtwork(c);
    };
    flight.timer = setTimeout(() => step(0), ARTWORK_PART_GAP_MS);
  }

  #command(c, player) {
    this.#safe(c, () => c.member.serverCommand({ player }));
  }

  #safe(c, fn) {
    try {
      return fn();
    } catch (err) {
      this.#log?.debug?.(`[sendspin] ${c.id.slice(0, 8)}: ${err.message}`);
      return undefined;
    }
  }

  #changed(room) {
    if (room) this.emit('change', room.id);
  }

  #view(room, { queue }) {
    const playing = room.state === 'playing';
    const pos = playing && !room.live ? room.stream?.position() : null;
    const index = pos?.track.index ?? room.current?.index ?? room.index;
    const ctl = this.#controllerState(room);
    const item = room.live?.item ?? room.queue[index] ?? null;
    const view = {
      id: room.id,
      name: this.#roomName(room),
      named: room.name !== null,
      state: room.state,
      repeat: room.repeat,
      shuffle: room.shuffle,
      index,
      positionMs: pos?.positionMs ?? room.positionMs,
      durationMs: item?.meta?.durationMs ?? 0,
      current: item ? { filepath: item.filepath, meta: item.meta ?? {} } : null,
      queueLength: room.queue.length,
      upcoming: room.order.includes(index) ? room.order.length - 1 - room.order.indexOf(index) : 0,
      volume: ctl.volume,
      muted: ctl.muted,
      supportedCommands: ctl.supported_commands,
      lastPlayedAt: room.lastPlayedAt,
      queueVersion: room.queueVersion,
      live: room.live ? { sourceId: room.live.sourceId, name: room.live.name } : null,
      members: room.members.map((cid) => this.#memberView(room, this.#clients.get(cid))),
      sonos: room.sonos?.view() ?? [],
      eq: { ...room.eq, gains: room.eq.gains.slice() },
    };
    if (queue) {
      view.queue = room.queue.map((q) => ({ filepath: q.filepath, meta: q.meta ?? {} }));
      view.order = room.order.slice();
    }
    return view;
  }

  #memberView(room, c) {
    const m = c.member;
    const p = m ? playerOf(c) : null;
    return {
      clientId: c.id,
      name: c.name,
      connected: Boolean(m && m.isOpen !== false),
      available: Boolean(m?.state?.available),
      player: Boolean(m?.hasRole('player')),
      volume: p?.volume ?? null,
      muted: p?.muted ?? null,
      volumeSettable: Boolean(p?.supportedCommands.includes('volume')),
      muteSettable: Boolean(p?.supportedCommands.includes('mute')),
      format: room.stream?.formatOf(c.id) ?? null,
      streaming: Boolean(room.stream?.has(c.id)),
      parked: c.parked,
    };
  }

  #save() {
    if (this.#saveTimer) return;
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = null;
      this.#write();
    }, 250);
    this.#saveTimer.unref?.();
  }

  #snapshot() {
    const rooms = [...this.#rooms.values()].map((r) => {
      const playing = r.state === 'playing' && !r.live;
      const pos = playing ? r.stream?.position() : null;
      return {
        id: r.id, name: r.name, solo: r.solo, members: r.members, queue: r.queue, order: r.order,
        ...(r.sonos?.size ? { sonos: r.sonos.toJSON() } : {}),
        ...(isDefaultEq(r.eq) ? {} : { eq: r.eq }),
        index: pos?.track.index ?? r.index, positionMs: pos?.positionMs ?? r.positionMs,
        repeat: r.repeat, shuffle: r.shuffle, state: r.live ? 'paused' : r.state, lastPlayedAt: r.lastPlayedAt, queueVersion: r.queueVersion,
      };
    });
    const clients = Object.fromEntries([...this.#clients.values()].map((c) => [c.id, {
      name: c.name, roomId: c.roomId, previousRoomId: c.previousRoomId, parked: c.parked,
    }]));
    return { version: 1, rooms, clients };
  }

  #write() {
    const body = JSON.stringify(this.#snapshot(), null, 2);
    const tmp = `${this.#file}.${process.pid}.tmp`;
    this.#writing = this.#writing.then(async () => {
      await fsp.mkdir(path.dirname(this.#file), { recursive: true });
      await fsp.writeFile(tmp, body, { mode: 0o600 });
      await fsp.rename(tmp, this.#file);
    }).catch((err) => {
      this.#log?.warn?.(`[sendspin] could not save rooms: ${err.message}`);
    });
  }
}
