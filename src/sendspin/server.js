import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import winston from 'winston';
import { WebSocket, WebSocketServer } from 'ws';
import { loadOrCreateServerKey, isKeyId, PSK_CATEGORY } from './keys.js';
import { TrustStore } from './trust-store.js';
import { SendspinConnection, MAX_WS_PAYLOAD, cleanText } from './connection.js';
import { SendspinDiscovery, isValidPath } from './discovery.js';

export const DEFAULT_PORT = 8927;
export const DEFAULT_PATH = '/sendspin';

const DEFAULT_RECONNECT = Object.freeze({ minMs: 1000, maxMs: 300_000, concurrentMs: 60_000, stableMs: 60_000 });

export function reconnectDecision(closeInfo) {
  const reason = closeInfo.goodbye;
  if (reason === 'restart') return 'now';
  if (reason === 'concurrent_attempt') return 'later';
  if (reason) return 'never';
  if (!closeInfo.handshakeCompleted) return 'backoff';
  const acts = closeInfo.activities ?? [];
  return acts.length === 0 || acts.includes('playback') ? 'now' : 'never';
}

function parseWsUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'ws:' || u.username || u.password || u.hash || !isValidPath(u.pathname)) return null;
  return u.href;
}

function groupId() {
  return crypto.randomBytes(32).toString('base64url');
}

export class SendspinServer extends EventEmitter {
  #opts;
  #log;
  #identity = null;
  #http = null;
  #wss = null;
  #clients = new Map();
  #pending = new Set();
  #dials = new Map();
  #store = null;
  #soloGroups = new Map();
  #discovery = null;
  #stopping = false;

  constructor({
    dataDir, name = 'Velvet', languages = ['en'], host = '0.0.0.0', port = DEFAULT_PORT, path: wsPath = DEFAULT_PATH,
    roles = ['player@v1'], logger = winston, maxClients = 64, maxPending = 32, reconnect = {}, timeouts = {},
    discovery = false, allowLoopback = false,
  }) {
    super();
    if (!dataDir) throw new Error('SendspinServer needs a dataDir');
    if (!isValidPath(wsPath)) throw new Error('path must be an absolute path');
    this.#opts = {
      dataDir, name, languages, host, port, path: wsPath, roles, maxClients, maxPending,
      reconnect: { ...DEFAULT_RECONNECT, ...reconnect }, timeouts, discovery, allowLoopback,
    };
    this.#log = logger;
  }

  get serverId() {
    return this.#identity?.serverId ?? null;
  }

  get port() {
    return this.#http?.address()?.port ?? null;
  }

  get name() {
    return this.#opts.name;
  }

  get clients() {
    return new Map(this.#clients);
  }

  getClient(clientId) {
    return this.#clients.get(clientId) ?? null;
  }

  async start() {
    this.#stopping = false;
    this.#identity = await loadOrCreateServerKey(this.#opts.dataDir);
    this.#store = await TrustStore.open(this.#opts.dataDir);
    this.#http = http.createServer((req, res) => {
      res.writeHead(404).end();
    });
    this.#wss = new WebSocketServer({ server: this.#http, path: this.#opts.path, maxPayload: MAX_WS_PAYLOAD, perMessageDeflate: false });
    this.#wss.on('connection', (ws, req) => this.#onInbound(ws, req));
    this.#wss.on('error', (err) => this.#log.warn(`[sendspin] listener error: ${err.message}`));
    await new Promise((resolve, reject) => {
      this.#http.once('error', reject);
      this.#http.listen(this.#opts.port, this.#opts.host, () => {
        this.#http.off('error', reject);
        resolve();
      });
    });
    this.#log.info(`[sendspin] listening on ws://${this.#opts.host}:${this.port}${this.#opts.path} as ${this.serverId.slice(0, 8)}`);
    if (this.#opts.discovery) await this.#startDiscovery();
  }

  async #startDiscovery() {
    const d = this.#opts.discovery instanceof SendspinDiscovery
      ? this.#opts.discovery
      : new SendspinDiscovery({ logger: this.#log, allowLoopback: this.#opts.allowLoopback });
    this.#discovery = d;
    d.on('found', (svc, prevUrl) => {
      if (prevUrl) this.disconnectFrom(prevUrl);
      this.emit('discovered', svc);
      this.connectTo(svc.url, { source: 'mdns' });
    });
    d.on('lost', (svc) => {
      this.emit('discovery-lost', svc);
      const dial = this.#dials.get(svc.url);
      if (dial && !dial.conn) this.disconnectFrom(svc.url);
      else if (dial) dial.wanted = false;
    });
    try {
      await d.start();
      d.advertise({ instance: this.serverId, port: this.port, path: this.#opts.path, name: this.#opts.name });
    } catch (err) {
      this.#log.warn(`[sendspin] mDNS unavailable: ${err.message}`);
    }
  }

  #onInbound(ws, req) {
    if (this.#stopping || this.#pending.size >= this.#opts.maxPending) {
      ws.terminate();
      return;
    }
    this.#attach(ws, { direction: 'inbound', remoteAddress: req.socket.remoteAddress });
  }

  #attach(ws, { direction, url = null, remoteAddress = null }) {
    const conn = new SendspinConnection({
      ws, identity: this.#identity, name: this.#opts.name, languages: this.#opts.languages, direction, url, remoteAddress,
      resolvePsk: (id) => this.#store.pskForClient(id), hasPairingRecord: (id) => this.#store.isPaired(id), logger: this.#log, timeouts: this.#opts.timeouts,
    });
    this.#pending.add(conn);
    conn.on('hello', (info) => this.#onHello(conn, info));
    conn.on('state', (state, prev) => this.emit('state', conn, state, prev));
    conn.on('time', (t) => this.emit('time', conn, t));
    conn.on('command', (cmd) => this.emit('command', conn, cmd));
    conn.on('leave', () => this.emit('leave', conn));
    conn.on('goodbye', (reason) => this.emit('goodbye', conn, reason));
    conn.on('message', (type, payload) => this.emit('message', conn, type, payload));
    conn.on('close', (info) => this.#onClose(conn, info));
    return conn;
  }

  #onHello(conn, info) {
    this.#pending.delete(conn);
    const id = conn.clientId;
    const existing = this.#clients.get(id);
    if (!existing && this.#clients.size >= this.#opts.maxClients) {
      this.#log.warn(`[sendspin] client limit reached; refusing ${id.slice(0, 8)}`);
      conn.close(1013, 'server full');
      return;
    }
    if (existing && existing !== conn) {
      this.#log.info(`[sendspin] ${id.slice(0, 8)} reconnected; replacing the previous connection`);
      existing.replaced = true;
      existing.close(1000, 'replaced');
    }
    this.#clients.set(id, conn);
    const roles = this.#allowedRoles(conn);
    conn.activate({ activities: [], roles });
    let gid = this.#soloGroups.get(id);
    if (!gid) {
      gid = groupId();
      this.#soloGroups.set(id, gid);
    }
    conn.groupUpdate({ playbackState: 'stopped', groupId: gid, groupName: info.name });
    this.#log.info(`[sendspin] client "${cleanText(info.name, 64)}" (${id.slice(0, 8)}) connected ${conn.direction}; roles [${roles.join(', ')}]${this.isApproved(id) ? '' : ' (not approved)'}`);
    this.#syncMismatch(conn);
    this.emit('client', conn, info);
    if (conn.credentialMismatch) this.emit('credential-mismatch', conn);
  }

  #syncMismatch(conn) {
    let update = null;
    if (conn.credentialMismatch) update = this.#store.markCredentialMismatch(conn.clientId);
    else if (conn.pskCategory === PSK_CATEGORY.LONG_TERM) update = this.#store.clearCredentialMismatch(conn.clientId);
    update?.catch((err) => this.#log.warn(`[sendspin] trust store update failed: ${err.message}`));
  }

  #allowedRoles(conn) {
    if (!conn.playbackAllowed) return [];
    if (!conn.isPaired && !this.isApproved(conn.clientId)) return [];
    return conn.negotiatedRoles.filter((r) => this.#opts.roles.includes(r));
  }

  canPlay(clientId) {
    const conn = this.#clients.get(clientId);
    return Boolean(conn?.isActivated && conn.playbackAllowed && (conn.isPaired || this.isApproved(clientId)));
  }

  setPlayback(clientId, on) {
    const conn = this.#clients.get(clientId);
    if (!conn?.isActivated) return false;
    if (on && !this.canPlay(clientId)) return false;
    const has = conn.activities.includes('playback');
    if (has === Boolean(on)) return true;
    const activities = on ? [...conn.activities, 'playback'] : conn.activities.filter((a) => a !== 'playback');
    const needsRoles = on && !conn.activeRoles.length;
    return conn.activate(needsRoles ? { activities, roles: this.#allowedRoles(conn) } : { activities });
  }

  #onClose(conn, info) {
    this.#pending.delete(conn);
    if (this.#clients.get(conn.clientId) === conn) {
      this.#clients.delete(conn.clientId);
      this.emit('client-removed', conn, info);
    }
    if (conn.url) this.#afterDialClose(conn, info);
  }

  connectTo(url, { source = 'manual' } = {}) {
    const href = parseWsUrl(url);
    if (!href) throw new Error('connectTo needs a ws:// URL with an absolute path');
    const existing = this.#dials.get(href);
    if (existing) {
      existing.wanted = true;
      if (!existing.conn && existing.timer) {
        clearTimeout(existing.timer);
        this.#dial(existing);
      }
      return;
    }
    const dial = { url: href, source, wanted: true, backoff: this.#opts.reconnect.minMs, conn: null, socket: null, timer: null };
    this.#dials.set(href, dial);
    this.#dial(dial);
  }

  disconnectFrom(url) {
    const href = parseWsUrl(url);
    const dial = href && this.#dials.get(href);
    if (!dial) return;
    this.#dials.delete(href);
    dial.wanted = false;
    clearTimeout(dial.timer);
    if (dial.conn) dial.conn.close(1000, 'disconnect');
    else dial.socket?.terminate();
  }

  #dial(dial) {
    dial.timer = null;
    if (this.#stopping || !dial.wanted) return;
    const ws = new WebSocket(dial.url, { maxPayload: MAX_WS_PAYLOAD, perMessageDeflate: false, handshakeTimeout: 10_000, followRedirects: false });
    dial.socket = ws;
    ws.once('open', () => {
      dial.conn = this.#attach(ws, { direction: 'outbound', url: dial.url });
    });
    ws.once('error', (err) => {
      if (dial.conn) return;
      this.#log.debug(`[sendspin] dial ${dial.url} failed: ${err.message}`);
    });
    ws.once('close', () => {
      if (dial.conn) return;
      dial.socket = null;
      this.#scheduleRedial(dial, 'backoff');
    });
  }

  #afterDialClose(conn, info) {
    const dial = this.#dials.get(conn.url);
    if (!dial || dial.conn !== conn) return;
    dial.conn = null;
    dial.socket = null;
    if (conn.replaced) {
      this.#log.debug(`[sendspin] ${dial.url} superseded by another connection; not redialing`);
      return;
    }
    const decision = reconnectDecision(info);
    if (decision === 'now' && info.durationMs >= this.#opts.reconnect.stableMs) dial.backoff = this.#opts.reconnect.minMs;
    this.#scheduleRedial(dial, decision);
  }

  #scheduleRedial(dial, decision) {
    if (this.#stopping || !dial.wanted || this.#dials.get(dial.url) !== dial) return;
    if (decision === 'never') {
      this.#log.info(`[sendspin] not reconnecting to ${dial.url}`);
      this.#dials.delete(dial.url);
      return;
    }
    const { maxMs, concurrentMs } = this.#opts.reconnect;
    const delay = decision === 'later' ? Math.max(concurrentMs, dial.backoff) : dial.backoff;
    dial.backoff = Math.min(dial.backoff * 2, maxMs);
    this.#log.debug(`[sendspin] redialing ${dial.url} in ${delay} ms`);
    dial.timer = setTimeout(() => this.#dial(dial), delay);
    dial.timer.unref?.();
  }

  get trustStore() {
    return this.#store;
  }

  isApproved(clientId) {
    return this.#store.isApproved(clientId);
  }

  get approvals() {
    return this.#store.listApprovals();
  }

  async approve(clientId, name = null) {
    if (!isKeyId(clientId)) throw new Error('invalid client id');
    const conn = this.#clients.get(clientId);
    const approved = await this.#store.approve(clientId, { name: name ?? conn?.info?.name ?? null });
    if (approved && conn?.isActivated && !conn.activeRoles.length && conn.playbackAllowed) conn.activate({ roles: this.#allowedRoles(conn) });
    return approved;
  }

  async revoke(clientId) {
    if (!(await this.#store.revokeApproval(clientId))) return;
    const conn = this.#clients.get(clientId);
    if (conn?.isActivated && !conn.isPaired) conn.activate({ activities: conn.activities.filter((a) => a !== 'playback'), roles: [] });
  }

  async stop() {
    this.#stopping = true;
    for (const dial of this.#dials.values()) {
      clearTimeout(dial.timer);
      dial.wanted = false;
      if (!dial.conn) dial.socket?.terminate();
    }
    this.#dials.clear();
    const conns = [...this.#clients.values(), ...this.#pending];
    for (const conn of conns) {
      if (conn.isActivated && conn.activeStreams.length) {
        try {
          conn.streamEnd();
        } catch (err) {
          this.#log.debug(`[sendspin] stream/end on shutdown failed: ${err.message}`);
        }
      }
      conn.close(1001, 'server shutdown');
    }
    await Promise.race([Promise.all(conns.map((c) => c.closed)), new Promise((r) => setTimeout(r, 3000).unref?.())]);
    if (this.#discovery) {
      await this.#discovery.stop();
      this.#discovery = null;
    }
    if (this.#wss) {
      for (const ws of this.#wss.clients) ws.terminate();
      await new Promise((resolve) => this.#wss.close(() => resolve()));
      this.#wss = null;
    }
    if (this.#http) {
      await new Promise((resolve) => this.#http.close(() => resolve()));
      this.#http = null;
    }
    await this.#store?.flush();
  }
}
