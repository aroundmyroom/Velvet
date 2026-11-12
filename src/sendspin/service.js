import { EventEmitter } from 'node:events';
import { SendspinServer } from './server.js';
import { RoomManager, RoomError } from './rooms.js';
import { IMPLEMENTED_ROLES } from './connection.js';

const START_TIMEOUT_MS = 15_000;
export const STOP_TIMEOUT_MS = 3_000;

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

export class RoomsService extends EventEmitter {
  #log;
  #deps;
  #server = null;
  #rooms = null;
  #error = null;
  #settings = null;
  #names = new Map();
  #busy = Promise.resolve();

  constructor({ dataDir, logger, artworkFor = null, colorFor = null, serverOptions = {}, roomOptions = {} }) {
    super();
    this.#log = logger;
    this.#deps = { dataDir, artworkFor, colorFor, serverOptions, roomOptions };
  }

  get running() {
    return Boolean(this.#server && this.#rooms);
  }

  get error() {
    return this.#error;
  }

  get server() {
    return this.#server;
  }

  get rooms() {
    return this.#rooms;
  }

  get settings() {
    return this.#settings;
  }

  apply(settings) {
    this.#busy = this.#busy.catch(() => {}).then(async () => {
      await this.#stop();
      this.#settings = { ...settings };
      if (settings.enabled) await this.#start(settings);
    });
    return this.#busy;
  }

  stop() {
    this.#busy = this.#busy.catch(() => {}).then(() => this.#stop());
    return this.#busy;
  }

  async #start(s) {
    this.#error = null;
    const { dataDir, artworkFor, colorFor, serverOptions, roomOptions } = this.#deps;
    const server = new SendspinServer({
      dataDir, name: s.name, languages: s.languages, host: s.bind, port: s.port, path: s.path,
      roles: [...IMPLEMENTED_ROLES], logger: this.#log, discovery: s.discovery, ...serverOptions,
    });
    try {
      await withTimeout(server.start(), START_TIMEOUT_MS, 'Sendspin listener start');
      const rooms = await RoomManager.open(dataDir, {
        logger: this.#log, artworkFor, colorFor,
        setPlayback: (member, on) => server.setPlayback(member.clientId, on),
        ...roomOptions,
      });
      rooms.on('error', (err) => this.#log.warn(`[rooms] ${err.message}`));
      rooms.on('member-error', (roomId, clientId, err) => this.#log.debug(`[rooms] ${String(clientId).slice(0, 8)} dropped: ${err.message}`));
      const pruned = rooms.pruneClients((id) => server.isTrusted(id));
      if (pruned) this.#log.info(`[rooms] dropped ${pruned} untrusted speaker(s) from rooms.json`);
      // Only paired or approved speakers get a room: an unknown key must not create state or pass for a known device.
      const sync = (id) => this.#syncMember(server, rooms, id);
      server.on('client', (conn) => sync(conn.clientId));
      server.on('trust', sync);
      server.on('client-removed', (conn) => rooms.detach(conn.clientId));
      for (const conn of server.clients.values()) sync(conn.clientId);
      this.#server = server;
      this.#rooms = rooms;
    } catch (err) {
      this.#error = err.code ? `${err.code}: ${err.message}` : err.message;
      this.#log.warn(`[rooms] Sendspin listener not started: ${this.#error}`);
      await server.stop().catch(() => {});
    }
  }

  // Bounded: a peer that never answers or a half-open socket must not keep Velvet from exiting.
  async #stop() {
    const { server } = this;
    const rooms = this.#rooms;
    this.#server = null;
    this.#rooms = null;
    const graceful = async () => {
      if (rooms) {
        rooms.removeAllListeners();
        await rooms.close().catch((err) => this.#log.warn(`[rooms] close failed: ${err.message}`));
      }
      if (server) {
        server.removeAllListeners('client');
        server.removeAllListeners('trust');
        server.removeAllListeners('client-removed');
        await server.stop().catch((err) => this.#log.warn(`[rooms] Sendspin stop failed: ${err.message}`));
      }
    };
    try {
      await withTimeout(graceful(), STOP_TIMEOUT_MS, 'Sendspin stop');
    } catch (err) {
      this.#log.warn(`[rooms] ${err.message}; closing everything now`);
      server?.destroy();
    }
  }

  #syncMember(server, rooms, clientId) {
    const conn = server.getClient(clientId);
    const wanted = Boolean(conn?.isActivated && conn.isOpen && server.isTrusted(clientId));
    if (wanted && !rooms.isAttached(clientId)) rooms.attach(conn);
    else if (!wanted && rooms.isAttached(clientId)) rooms.detach(clientId);
  }

  trustedIds() {
    return this.#server ? this.#server.trustedIds() : new Set();
  }

  setName(clientId, name) {
    this.#names.set(clientId, name);
  }

  forgetName(clientId) {
    this.#names.delete(clientId);
  }

  knownIds() {
    if (!this.#server) return new Set();
    return new Set(this.#server.devices().map((d) => d.clientId));
  }

  device(clientId, base = null) {
    const d = base ?? this.#server.device(clientId);
    const conn = this.#server.getClient(clientId);
    const p = conn?.isActivated && conn.hasRole('player') ? conn.state?.player : null;
    const rest = { ...d };
    delete rest.url;
    return {
      ...rest,
      name: d.name ?? this.#names.get(clientId) ?? conn?.info?.name ?? clientId.slice(0, 8),
      roomId: this.#rooms?.roomOf(clientId) ?? null,
      volume: p?.volume ?? null,
      muted: p?.muted ?? null,
      canSetVolume: Boolean(p?.supportedCommands?.includes('volume')),
      canMute: Boolean(p?.supportedCommands?.includes('mute')),
      otherServer: d.connection === 'other-server' ? { name: null } : null,
    };
  }

  devices() {
    if (!this.#server) return [];
    return this.#server.devices().map((d) => this.device(d.clientId, d));
  }

  playable(view) {
    return view.members.some((m) => m.connected && m.available && m.player && this.#server.canPlay(m.clientId));
  }

  roomView(view) {
    const idle = view.queueLength === 0;
    const meta = view.current?.meta ?? {};
    const aaFile = typeof meta.aaFile === 'string' ? meta.aaFile : null;
    const devices = new Map(this.devices().map((d) => [d.clientId, d]));
    return {
      id: view.id,
      name: view.name,
      members: view.members.map((m) => {
        const d = devices.get(m.clientId);
        return {
          clientId: m.clientId,
          name: d?.name ?? m.name,
          connection: d?.connection ?? (m.connected ? 'online' : 'offline'),
          volume: m.volume,
          muted: m.muted,
          canSetVolume: m.volumeSettable,
          canMute: m.muteSettable,
        };
      }),
      state: idle ? 'idle' : view.state,
      current: view.current && !idle ? {
        filepath: view.current.filepath,
        title: meta.title ?? null,
        artist: meta.artist ?? null,
        album: meta.album ?? null,
        aaFile,
        artUrl: aaFile ? `/album-art/${encodeURIComponent(aaFile)}` : null,
        durationMs: meta.durationMs > 0 ? meta.durationMs : null,
      } : null,
      positionMs: Math.max(0, Math.round(view.positionMs ?? 0)),
      positionAt: Date.now(),
      index: idle ? -1 : view.index,
      queueLength: view.queueLength,
      queueVersion: view.queueVersion,
      volume: view.volume,
      muted: view.muted,
      repeat: view.repeat,
      shuffle: view.shuffle,
      canSeek: view.supportedCommands.includes('seek'),
      playable: this.playable(view),
    };
  }

  listRooms() {
    if (!this.#rooms) return [];
    const known = this.trustedIds();
    return this.#rooms.listRooms()
      .filter((r) => r.members.some((m) => known.has(m.clientId)))
      .map((r) => this.roomView(r))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  room(id) {
    const view = this.#rooms.listRooms().find((r) => r.id === id) ?? this.#rooms.getRoom(id);
    return this.roomView(view);
  }
}

export { RoomError };
