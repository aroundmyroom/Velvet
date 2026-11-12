import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fsp from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import winston from 'winston';
import { WebSocket, WebSocketServer } from 'ws';
import { loadOrCreateServerKey, isKeyId, PSK_CATEGORY, SENTINEL_PSK } from './keys.js';
import { TrustStore } from './trust-store.js';
import { SendspinConnection, MAX_WS_PAYLOAD, cleanText } from './connection.js';
import {
  SendspinDiscovery, isValidPath, normalizeAddress, isLoopbackAddress, onLocalSubnet, localSubnets, buildUrl,
} from './discovery.js';
import {
  METHODS, FORMATS, PAIRING_MESSAGE_TYPES, DYNAMIC_DIGITS, STATIC_DIGITS, PairingProtocolError, PairingInputError, Cooldown,
  createPairingAttempt, decodePskToken, assertTokenForClient, parseSupportedPairMethods, chooseCodeMethod, pairingActivation,
} from './pairing.js';

export const DEFAULT_PORT = 8927;
export const DEFAULT_PATH = '/sendspin';
export const DEFAULT_CLIENT_PORT = 8928;

const DEFAULT_RECONNECT = Object.freeze({ minMs: 1000, maxMs: 300_000, concurrentMs: 60_000, stableMs: 60_000 });
export const KNOWN_DEVICES_FILE = 'known-devices.json';
export const PAIRING_STATUS_TTL_MS = 60_000;
export const MAX_KNOWN_DEVICES = 256;
export const MAX_UNTRUSTED_CLIENTS = 16;
export const CLOSE_GRACE_MS = 1_500;
export const MAX_PENDING_PER_ADDRESS = 4;
export const MAX_UNTRUSTED_PER_ADDRESS = 4;
export const INIT_TIMEOUT_MS = 5_000;
const OTHER_SERVER_GOODBYES = new Set(['another_server', 'concurrent_attempt']);
const STATUS_BY_EVENT = Object.freeze({
  started: 'waiting', code_queued: 'waiting', code_sent: 'waiting', confirmed: 'waiting', persist: 'waiting',
  pending: 'pending', need_code: 'need_code', wrong_code: 'wrong_code', paired: 'paired', aborted: 'aborted',
});

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

function statusPatch(ev) {
  const patch = { status: STATUS_BY_EVENT[ev.kind] };
  if (ev.round !== undefined) patch.round = ev.round;
  if (ev.kind === 'pending') patch.message = ev.message;
  if (ev.kind === 'wrong_code') patch.retryAfterMs = ev.retryAfterMs;
  if (ev.kind === 'need_code' || ev.kind === 'code_sent') patch.retryAfterMs = 0;
  if (ev.kind === 'aborted') patch.reason = ev.reason;
  return patch;
}

const str = (v, max = 256) => (typeof v === 'string' ? v.slice(0, max) : null);

function parseKnown(d) {
  return {
    clientId: d.clientId, name: str(d.name, 64),
    deviceInfo: publicDeviceInfo({ product_name: str(d.deviceInfo?.productName), manufacturer: str(d.deviceInfo?.manufacturer), software_version: str(d.deviceInfo?.softwareVersion) }),
    pairMethods: Array.isArray(d.pairMethods) ? d.pairMethods.filter((m) => Object.values(METHODS).includes(m)) : [],
    unpairedAccess: d.unpairedAccess === true, address: str(d.address), url: str(d.url, 512), manual: d.manual === true && typeof d.url === 'string',
    lastSeen: Number.isSafeInteger(d.lastSeen) ? d.lastSeen : null, lastGoodbye: str(d.lastGoodbye, 64),
  };
}

function toActivate({ activities, active_roles: roles, pairing }) {
  return { activities, roles, pairing };
}

function publicDeviceInfo(di = {}) {
  return { productName: di.product_name ?? null, manufacturer: di.manufacturer ?? null, softwareVersion: di.software_version ?? null };
}

function connAddress(conn) {
  if (conn.url) return new URL(conn.url).host;
  return conn.remoteAddress?.replace(/^::ffff:/, '') ?? null;
}

function urlHost(url) {
  try {
    return normalizeAddress(new URL(url).hostname.replace(/^\[|\]$/g, ''));
  } catch {
    return null;
  }
}

function peerAddress(conn) {
  return conn.url ? urlHost(conn.url) : normalizeAddress(conn.remoteAddress);
}

function rejectUpgrade(socket) {
  socket.once('finish', () => socket.destroy());
  socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
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
  #discovery = null;
  #stopping = false;
  #pairings = new Map();
  #cooldowns = new Map();
  #roomHolds = new Set();
  #sourceHolds = new Set();
  #known = new Map();
  #knownWrite = Promise.resolve();
  #knownTimer = null;
  #pendingByAddress = new Map();
  #slots = new WeakMap();

  constructor({
    dataDir, name = 'Velvet', languages = ['en'], host = '0.0.0.0', port = DEFAULT_PORT, path: wsPath = DEFAULT_PATH,
    roles = ['player@v1'], logger = winston, maxClients = 64, maxUntrusted = MAX_UNTRUSTED_CLIENTS, maxPending = 32, maxKnown = MAX_KNOWN_DEVICES,
    reconnect = {}, timeouts = {}, discovery = false, allowLoopback = false, cooldown = {}, subnets = localSubnets,
    maxPendingPerAddress = MAX_PENDING_PER_ADDRESS, maxUntrustedPerAddress = MAX_UNTRUSTED_PER_ADDRESS, initTimeoutMs = INIT_TIMEOUT_MS,
  }) {
    super();
    if (!dataDir) throw new Error('SendspinServer needs a dataDir');
    if (!isValidPath(wsPath)) throw new Error('path must be an absolute path');
    this.#opts = {
      dataDir, name, languages, host, port, path: wsPath, roles, maxClients, maxUntrusted, maxPending, maxKnown,
      reconnect: { ...DEFAULT_RECONNECT, ...reconnect }, timeouts, discovery, allowLoopback, cooldown, subnets,
      maxPendingPerAddress, maxUntrustedPerAddress, initTimeoutMs,
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
    await this.#loadKnown();
    this.#http = http.createServer((req, res) => {
      res.writeHead(404).end();
    });
    this.#wss = new WebSocketServer({ noServer: true, path: this.#opts.path, maxPayload: MAX_WS_PAYLOAD, perMessageDeflate: false });
    this.#wss.on('connection', (ws, req) => this.#onInbound(ws, req));
    this.#http.on('upgrade', (req, socket, head) => this.#onUpgrade(req, socket, head));
    this.#wss.on('error', (err) => this.#log.warn(`[sendspin] listener error: ${err.message}`));
    await new Promise((resolve, reject) => {
      this.#http.once('error', reject);
      this.#http.listen(this.#opts.port, this.#opts.host, () => {
        this.#http.off('error', reject);
        resolve();
      });
    });
    this.#http.on('error', (err) => this.#log.warn(`[sendspin] listener error: ${err.message}`));
    this.#log.info(`[sendspin] listening on ws://${this.#opts.host}:${this.port}${this.#opts.path} as ${this.serverId.slice(0, 8)}`);
    for (const k of this.#known.values()) if (k.manual) this.#dialSafe(k.url);
    if (this.#opts.discovery) await this.#startDiscovery();
  }

  #dialSafe(url) {
    try {
      this.connectTo(url, { source: 'address' });
    } catch (err) {
      this.#log.warn(`[sendspin] not dialing ${cleanText(url)}: ${err.message}`);
    }
  }

  // For speakers whose mDNS never reaches Velvet (Wi-Fi often drops multicast). LAN addresses only: an admin form must not dial arbitrary hosts.
  dialAddress(address, port = DEFAULT_CLIENT_PORT, wsPath = DEFAULT_PATH) {
    const a = normalizeAddress(address);
    const lan = a && (isLoopbackAddress(a) ? this.#opts.allowLoopback : onLocalSubnet(a, this.#opts.subnets()));
    const url = lan ? buildUrl(a, port, wsPath, { allowLoopback: this.#opts.allowLoopback }) : null;
    if (url) this.connectTo(url, { source: 'address' });
    return url;
  }

  async #startDiscovery() {
    const d = this.#opts.discovery instanceof SendspinDiscovery
      ? this.#opts.discovery
      : new SendspinDiscovery({ logger: this.#log, allowLoopback: this.#opts.allowLoopback });
    this.#discovery = d;
    d.on('found', this.#guard('mDNS found', (svc, prevUrl) => {
      if (prevUrl) this.disconnectFrom(prevUrl);
      this.emit('discovered', svc);
      this.connectTo(svc.url, { source: 'mdns' });
    }));
    d.on('lost', this.#guard('mDNS lost', (svc) => {
      this.emit('discovery-lost', svc);
      const dial = this.#dials.get(svc.url);
      if (dial && !dial.conn) this.disconnectFrom(svc.url);
      else if (dial) dial.wanted = false;
    }));
    try {
      await d.start();
      d.advertise({ instance: this.serverId, port: this.port, path: this.#opts.path, name: this.#opts.name, ipv6: net.isIP(this.#opts.host) === 6 });
    } catch (err) {
      this.#log.warn(`[sendspin] mDNS unavailable: ${err.message}`);
    }
  }

  // Socket and discovery events run outside any request: an error escaping one would end the process.
  #guard(what, fn, onError = null) {
    return (...args) => {
      try {
        fn(...args);
      } catch (err) {
        this.#log.warn(`[sendspin] ${what} failed: ${cleanText(err?.message, 160)}`);
        onError?.(...args);
      }
    };
  }

  // Pre-hello slots are taken before the WebSocket handshake, per peer address, so one host opening idle
  // sockets cannot use up maxPending; addresses of paired/approved devices are never capped.
  #onUpgrade(req, socket, head) {
    this.#guard('upgrade', () => {
      const address = normalizeAddress(req.socket.remoteAddress) ?? String(req.socket.remoteAddress);
      const held = this.#pendingByAddress.get(address) ?? 0;
      if (this.#stopping || this.#pending.size >= this.#opts.maxPending
        || (held >= this.#opts.maxPendingPerAddress && !this.#trustedAddress(address))) {
        this.#log.debug(`[sendspin] refusing a connection from ${cleanText(address, 64)} (${held} pending)`);
        rejectUpgrade(socket);
        return;
      }
      this.#pendingByAddress.set(address, held + 1);
      let holding = true;
      const release = () => {
        if (!holding) return;
        holding = false;
        const left = (this.#pendingByAddress.get(address) ?? 1) - 1;
        if (left > 0) this.#pendingByAddress.set(address, left);
        else this.#pendingByAddress.delete(address);
      };
      socket.once('close', release);
      this.#slots.set(socket, release);
      this.#wss.handleUpgrade(req, socket, head, (ws) => this.#wss.emit('connection', ws, req));
    }, () => socket.destroy())();
  }

  #trustedAddress(address) {
    for (const k of this.#known.values()) {
      const host = normalizeAddress(k.address) ?? (k.url ? urlHost(k.url) : null);
      if (host === address && this.isTrusted(k.clientId)) return true;
    }
    return false;
  }

  #onInbound(ws, req) {
    this.#guard('inbound connection', () => {
      const release = this.#slots.get(req.socket);
      this.#slots.delete(req.socket);
      if (this.#stopping) {
        ws.terminate();
        return;
      }
      const conn = this.#attach(ws, { direction: 'inbound', remoteAddress: req.socket.remoteAddress });
      const timer = setTimeout(() => {
        if (conn.phase === 'init') conn.terminate();
      }, this.#opts.initTimeoutMs);
      timer.unref?.();
      this.#slots.set(conn, () => {
        clearTimeout(timer);
        release?.();
      });
    }, () => ws.terminate())();
  }

  #releaseSlot(conn) {
    this.#slots.get(conn)?.();
    this.#slots.delete(conn);
  }

  #attach(ws, { direction, url = null, remoteAddress = null }) {
    const conn = new SendspinConnection({
      ws, identity: this.#identity, name: this.#opts.name, languages: this.#opts.languages, direction, url, remoteAddress,
      resolvePsk: (id) => this.#store.pskForClient(id), hasPairingRecord: (id) => this.#store.isPaired(id), logger: this.#log, timeouts: this.#opts.timeouts,
    });
    this.#pending.add(conn);
    conn.on('hello', (info) => this.#onHello(conn, info));
    conn.on('state', (state, prev) => {
      if (state.available) conn.left = false;
      this.emit('state', conn, state, prev);
    });
    conn.on('time', (t) => this.emit('time', conn, t));
    conn.on('command', (cmd) => this.emit('command', conn, cmd));
    conn.on('leave', () => {
      conn.left = true;
      this.emit('leave', conn);
    });
    conn.on('goodbye', (reason) => this.emit('goodbye', conn, reason));
    conn.on('message', (type, payload) => {
      if (PAIRING_MESSAGE_TYPES.has(type)) this.#onPairingMessage(conn, type, payload);
      else this.emit('message', conn, type, payload);
    });
    conn.on('close', (info) => this.#onClose(conn, info));
    return conn;
  }

  // Trusted (paired, approved or with a staged token) and untrusted clients have separate limits,
  // so a flood of throwaway keys cannot lock out a real speaker.
  #admitted(conn) {
    return this.#trusted(conn) || Boolean(this.#store.stagedPairingPsk(conn.clientId));
  }

  #full(conn) {
    const admitted = this.#admitted(conn);
    const peers = [...this.#clients.values()].filter((c) => this.#admitted(c) === admitted);
    if (admitted) {
      if (peers.length < this.#opts.maxClients) return false;
      this.#log.warn(`[sendspin] client limit reached; refusing ${conn.clientId.slice(0, 8)}`);
      return true;
    }
    const address = peerAddress(conn);
    const fromAddress = peers.filter((c) => peerAddress(c) === address).length;
    if (peers.length < this.#opts.maxUntrusted && fromAddress < this.#opts.maxUntrustedPerAddress) return false;
    this.#log.debug(`[sendspin] untrusted client limit reached; refusing ${conn.clientId.slice(0, 8)}`);
    return true;
  }

  #onHello(conn, info) {
    this.#pending.delete(conn);
    this.#releaseSlot(conn);
    const id = conn.clientId;
    const existing = this.#clients.get(id);
    if (!existing && this.#full(conn)) {
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
    const staged = this.#store.stagedPairingPsk(id);
    const stagedMatch = staged && conn.pskCategory === PSK_CATEGORY.PAIRING && conn.pskId === staged.pskId && this.#offers(conn, METHODS.PAIRING_PSK);
    if (stagedMatch) this.#activatePairing(conn, this.#newEntry(conn, METHODS.PAIRING_PSK, null, { staged: true }), { pairingPsk: staged.psk, activeRoles: roles });
    else conn.activate({ activities: [], roles });
    this.#log.info(`[sendspin] client "${cleanText(info.name, 64)}" (${id.slice(0, 8)}) connected ${conn.direction}; roles [${roles.join(', ')}] (${this.#store.trustState(id)})`);
    this.#syncMismatch(conn);
    this.#remember(conn);
    this.emit('client', conn, info);
    if (conn.credentialMismatch) this.emit('credential-mismatch', conn);
    if (!staged || stagedMatch) return;
    if (conn.offeredCategory === PSK_CATEGORY.PAIRING) {
      this.#log.warn(`[sendspin] ${id.slice(0, 8)} did not accept the staged pairing token; dropping it`);
      this.#store.unstagePairingPsk(id).catch((err) => this.#log.warn(`[sendspin] trust store update failed: ${err.message}`));
      this.#setStatus(id, { status: 'aborted', method: METHODS.PAIRING_PSK, format: null, reason: 'token_rejected' });
    } else if (this.#offers(conn, METHODS.PAIRING_PSK)) {
      this.#pairLive(conn, { pairingPsk: staged.psk, pskId: staged.pskId }, { staged: true });
    }
  }

  #syncMismatch(conn) {
    let update = null;
    if (conn.credentialMismatch) update = this.#store.markCredentialMismatch(conn.clientId);
    else if (conn.pskCategory === PSK_CATEGORY.LONG_TERM) update = this.#store.clearCredentialMismatch(conn.clientId);
    update?.catch((err) => this.#log.warn(`[sendspin] trust store update failed: ${err.message}`));
  }

  // An lt-keyed session stays lt after unpair(), so the trust store decides, not the session alone.
  #trusted(conn) {
    return (conn.isPaired && this.#store.isPaired(conn.clientId)) || this.isApproved(conn.clientId);
  }

  isTrusted(clientId) {
    const conn = this.#clients.get(clientId);
    if (conn) return this.#trusted(conn);
    return this.#store.isPaired(clientId) || this.isApproved(clientId);
  }

  trustedIds() {
    return new Set([...this.#store.listRecords().map((r) => r.clientId), ...this.#store.listApprovals().map((a) => a.clientId)]);
  }

  #allowedRoles(conn) {
    if (!conn.playbackAllowed || !this.#trusted(conn)) return [];
    return conn.negotiatedRoles.filter((r) => this.#opts.roles.includes(r) && (r !== 'source@v1' || this.#sourceRoleAllowed(conn)));
  }

  // spec: an unpaired device gets source@v1 only after the operator approved it as a source, never implied.
  #sourceRoleAllowed(conn) {
    return (conn.isPaired && this.#store.isPaired(conn.clientId)) || this.#store.isSourceAllowed(conn.clientId);
  }

  async allowSource(clientId, on) {
    if (!isKeyId(clientId)) throw new Error('invalid client id');
    const changed = await this.#store.allowSource(clientId, on);
    if (changed) this.#trustChanged(clientId);
    return changed;
  }

  canPlay(clientId) {
    const conn = this.#clients.get(clientId);
    return Boolean(conn?.isActivated && conn.playbackAllowed && this.#trusted(conn));
  }

  // 'playback' is declared while a room plays on the client or while we want its source to stream.
  setPlayback(clientId, on) {
    return this.#holdPlayback(this.#roomHolds, clientId, on);
  }

  setSourcePlayback(clientId, on) {
    return this.#holdPlayback(this.#sourceHolds, clientId, on);
  }

  #holdPlayback(holds, clientId, wanted) {
    if (wanted) holds.add(clientId);
    else holds.delete(clientId);
    const on = this.#roomHolds.has(clientId) || this.#sourceHolds.has(clientId);
    const conn = this.#clients.get(clientId);
    if (!conn?.isActivated || (on && !this.canPlay(clientId))) {
      if (wanted) holds.delete(clientId);
      return false;
    }
    const has = conn.activities.includes('playback');
    if (has === on) return true;
    const activities = on ? [...conn.activities, 'playback'] : conn.activities.filter((a) => a !== 'playback');
    const needsRoles = on && !conn.activeRoles.length;
    return conn.activate(needsRoles ? { activities, roles: this.#allowedRoles(conn) } : { activities });
  }

  #onClose(conn, info) {
    this.#pending.delete(conn);
    this.#releaseSlot(conn);
    this.#pairingClosed(conn);
    if (this.#clients.get(conn.clientId) === conn) {
      this.#clients.delete(conn.clientId);
      this.#roomHolds.delete(conn.clientId);
      this.#sourceHolds.delete(conn.clientId);
      this.#forgetLive(conn, info);
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
    ws.once('open', this.#guard('outbound connection', () => {
      dial.conn = this.#attach(ws, { direction: 'outbound', url: dial.url });
    }, () => ws.terminate()));
    ws.on('error', (err) => {
      if (dial.conn) return;
      this.#log.debug(`[sendspin] dial ${dial.url} failed: ${cleanText(err?.message)}`);
    });
    ws.once('close', this.#guard('dial close', () => {
      if (dial.conn) return;
      dial.socket = null;
      this.#scheduleRedial(dial, 'backoff');
    }));
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
    dial.timer = setTimeout(this.#guard('redial', () => this.#dial(dial)), delay);
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
    if (approved) this.#trustChanged(clientId);
    return approved;
  }

  async revoke(clientId) {
    if (!(await this.#store.revokeApproval(clientId))) return;
    this.#trustChanged(clientId);
  }

  #trustChanged(clientId) {
    const conn = this.#clients.get(clientId);
    if (conn) this.#syncTrust(conn);
    this.emit('trust', clientId);
  }

  // Grants or withdraws roles to match the trust store. A running re-handshake or pairing attempt
  // finishes first: the re-activation it ends with (or #leavePairing) applies the new trust.
  #syncTrust(conn) {
    if (!conn.isOpen || !conn.isActivated || this.#clients.get(conn.clientId) !== conn) return;
    if (conn.rehandshaking) {
      conn.afterRehandshake(() => this.#syncTrust(conn));
      return;
    }
    if (conn.activities.includes('pairing')) return;
    if (this.#trusted(conn)) {
      const roles = this.#allowedRoles(conn);
      const same = roles.length === conn.activeRoles.length && roles.every((r) => conn.activeRoles.includes(r));
      if (conn.activeRoles.length ? !same : conn.playbackAllowed) conn.activate({ roles });
    } else if (conn.activeRoles.length || conn.activities.includes('playback')) {
      conn.activate({ activities: conn.activities.filter((a) => a !== 'playback'), roles: [] });
    }
  }

  async stop() {
    this.#stopping = true;
    this.#clearTimers();
    this.#dropDials();
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
    await Promise.race([Promise.all(conns.map((c) => c.closed)), new Promise((r) => setTimeout(r, CLOSE_GRACE_MS).unref?.())]);
    for (const conn of conns) conn.terminate();
    const discovery = this.#discovery;
    this.#discovery = null;
    await discovery?.stop().catch((err) => this.#log.debug(`[sendspin] mDNS stop failed: ${err.message}`));
    await this.#closeListener();
    await this.#store?.flush();
    await this.#saveKnown();
  }

  // Last resort when stop() did not finish in time: drop every socket without waiting for anyone.
  destroy() {
    this.#stopping = true;
    this.#clearTimers();
    this.#dropDials();
    for (const conn of [...this.#clients.values(), ...this.#pending]) conn.terminate();
    const discovery = this.#discovery;
    this.#discovery = null;
    discovery?.stop().catch(() => {});
    this.#closeListener();
  }

  #dropDials() {
    for (const dial of this.#dials.values()) {
      clearTimeout(dial.timer);
      dial.wanted = false;
      if (!dial.conn) dial.socket?.terminate();
    }
    this.#dials.clear();
  }

  // http.close() alone waits for every TCP connection, including one that never sends a request.
  #closeListener() {
    const wss = this.#wss;
    const server = this.#http;
    this.#wss = null;
    this.#http = null;
    if (wss) {
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    }
    if (!server) return Promise.resolve();
    const closed = new Promise((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    return closed;
  }

  #clearTimers() {
    for (const entry of this.#pairings.values()) clearTimeout(entry.timer);
    clearTimeout(this.#knownTimer);
    this.#knownTimer = null;
  }

  // ---- pairing ----

  #offers(conn, method) {
    return Object.hasOwn(parseSupportedPairMethods(conn.info?.supportedPairMethods).methods, method);
  }

  #cooldown(clientId) {
    let c = this.#cooldowns.get(clientId);
    if (!c) {
      c = new Cooldown(this.#opts.cooldown);
      this.#cooldowns.set(clientId, c);
    }
    return c;
  }

  #liveEntry(clientId) {
    const e = this.#pairings.get(clientId);
    return e && !e.finished && this.#clients.get(clientId) === e.conn ? e : null;
  }

  #newEntry(conn, method, format, extra = {}) {
    const prev = this.#pairings.get(conn.clientId);
    if (prev) clearTimeout(prev.timer);
    const entry = {
      conn, method, format, attempt: null, timer: null, finished: false, finishedAt: null, cancelRequested: false,
      fromLongTerm: conn.pskCategory === PSK_CATEGORY.LONG_TERM, playback: conn.activities.includes('playback'),
      status: { status: 'waiting', method, format, round: 0, message: null, reason: null, retryAfterMs: 0 },
      ...extra,
    };
    this.#pairings.set(conn.clientId, entry);
    this.#emitStatus(conn.clientId);
    return entry;
  }

  #keepsPlayback(conn, category) {
    if (!conn.activities.includes('playback')) return false;
    if (category === PSK_CATEGORY.LONG_TERM) return true;
    return Boolean(conn.info.unpairedAccess) && !(category === PSK_CATEGORY.SENTINEL && this.#store.isPaired(conn.clientId));
  }

  #pairingActivationFor(conn, entry, category) {
    const playback = this.#keepsPlayback(conn, category);
    return pairingActivation({ method: entry.method, format: entry.format, playback, activeRoles: playback ? conn.activeRoles : [] });
  }

  #createAttempt(conn, entry, pairingPsk = null) {
    entry.attempt = createPairingAttempt({
      method: entry.method, format: entry.format, suite: conn.suite, handshakeHash: conn.handshakeHash,
      pairingIndex: conn.nextPairingIndex(), clientId: conn.clientId, pairingPsk, cooldown: this.#cooldown(conn.clientId),
    });
    entry.status.deadline = entry.attempt.deadline;
    this.#armPairingTimer(entry);
  }

  #activatePairing(conn, entry, { pairingPsk = null, activeRoles } = {}) {
    this.#createAttempt(conn, entry, pairingPsk);
    const act = activeRoles === undefined
      ? this.#pairingActivationFor(conn, entry, conn.pskCategory)
      : entry.attempt.activation({ activeRoles });
    conn.activate(toActivate(act));
    this.#log.info(`[sendspin] ${conn.clientId.slice(0, 8)} pairing started (${[entry.method, entry.format].filter(Boolean).join('/')})`);
  }

  #rehandshakeIntoPairing(conn, entry, { psk, category, pairingPsk = null }) {
    entry.rehandshaking = true;
    const activation = toActivate(this.#pairingActivationFor(conn, entry, category));
    conn.rehandshake({ psk, category, activation, beforeActivate: () => this.#createAttempt(conn, entry, pairingPsk) })
      .then(() => {
        entry.rehandshaking = false;
        this.#log.info(`[sendspin] ${conn.clientId.slice(0, 8)} pairing started after re-handshake (${entry.method})`);
        if (entry.cancelRequested) this.#runStep(entry, entry.attempt.cancel());
      })
      .catch((err) => this.#log.debug(`[sendspin] pairing re-handshake failed: ${err.message}`));
  }

  #pairLive(conn, token, { staged = false } = {}) {
    const entry = this.#newEntry(conn, METHODS.PAIRING_PSK, null, { staged });
    if (conn.pskCategory === PSK_CATEGORY.PAIRING && conn.pskId === token.pskId) {
      this.#activatePairing(conn, entry, { pairingPsk: token.pairingPsk });
    } else {
      this.#rehandshakeIntoPairing(conn, entry, { psk: token.pairingPsk, category: PSK_CATEGORY.PAIRING, pairingPsk: token.pairingPsk });
    }
    return entry;
  }

  #requireIdle(conn) {
    if (this.#liveEntry(conn.clientId)) {
      throw new PairingInputError('pairing_in_progress', 'a pairing attempt already runs for this device');
    }
    if (conn.rehandshaking) throw new PairingInputError('pairing_in_progress', 'a re-handshake is running on this connection');
  }

  async pairWithToken(tokenText, clientId = null) {
    const token = decodePskToken(tokenText);
    if (clientId) assertTokenForClient(token, clientId);
    const conn = this.#clients.get(token.clientId);
    if (!conn?.isActivated || !conn.isOpen) {
      await this.#store.stagePairingPsk(token.clientId, token.pairingPsk);
      this.#log.info(`[sendspin] pairing token staged for ${token.clientId.slice(0, 8)} (used on its next connection)`);
      return { result: 'staged', clientId: token.clientId, status: null };
    }
    assertTokenForClient(token, conn.clientId);
    if (!this.#offers(conn, METHODS.PAIRING_PSK)) throw new PairingInputError('method_not_supported', 'the device does not offer pairing_psk');
    this.#requireIdle(conn);
    this.#pairLive(conn, token);
    return { result: 'pairing', clientId: conn.clientId, status: this.getPairingStatus(conn.clientId) };
  }

  startCodePairing(clientId, { format = FORMATS.DIGITS } = {}) {
    const conn = this.#clients.get(clientId);
    if (!conn?.isActivated || !conn.isOpen) throw new PairingInputError('not_connected', 'the device is not connected');
    this.#requireIdle(conn);
    const choice = chooseCodeMethod(parseSupportedPairMethods(conn.info.supportedPairMethods).methods, { canScanQr: format === FORMATS.QR_CODE });
    if (!choice) throw new PairingInputError('method_not_supported', 'the device offers no pairing code method');
    const entry = this.#newEntry(conn, choice.method, choice.format ?? null);
    if (conn.pskCategory === PSK_CATEGORY.SENTINEL) this.#activatePairing(conn, entry);
    else this.#rehandshakeIntoPairing(conn, entry, { psk: SENTINEL_PSK, category: PSK_CATEGORY.SENTINEL });
    return this.getPairingStatus(clientId);
  }

  submitPairingCode(clientId, code) {
    const entry = this.#liveEntry(clientId);
    if (!entry?.attempt) throw new PairingInputError('no_pairing', 'no pairing attempt for this device');
    this.#runStep(entry, entry.attempt.submitCode(code));
    return this.getPairingStatus(clientId);
  }

  cancelPairing(clientId) {
    const entry = this.#pairings.get(clientId);
    if (!entry) throw new PairingInputError('no_pairing', 'no pairing attempt for this device');
    if (!entry.finished) {
      if (entry.rehandshaking) entry.cancelRequested = true;
      else this.#runStep(entry, entry.attempt.cancel());
    }
    return this.getPairingStatus(clientId);
  }

  getPairingStatus(clientId) {
    const entry = this.#pairings.get(clientId);
    if (!entry) return null;
    if (entry.finished && Date.now() - entry.finishedAt > PAIRING_STATUS_TTL_MS) return null;
    const s = entry.status;
    let digits = s.format === FORMATS.DIGITS ? DYNAMIC_DIGITS : null;
    if (s.method === METHODS.STATIC) digits = STATIC_DIGITS;
    const retryAfterMs = entry.finished ? 0 : Math.max(s.retryAfterMs ?? 0, this.#cooldowns.get(clientId)?.remainingMs() ?? 0);
    return {
      status: s.status, method: s.method, format: s.format ?? null, digits, round: s.round ?? 0, retryAfterMs,
      message: s.message ?? null, reason: s.reason ?? null, deadline: entry.finished ? null : (entry.attempt?.deadline ?? null),
    };
  }

  #setStatus(clientId, patch) {
    let entry = this.#pairings.get(clientId);
    if (!entry) {
      entry = { conn: null, method: patch.method, format: patch.format, attempt: null, timer: null, finished: true, finishedAt: Date.now(), status: {} };
      this.#pairings.set(clientId, entry);
    }
    Object.assign(entry.status, patch);
    if (['paired', 'aborted'].includes(entry.status.status) && !entry.finished) {
      entry.finished = true;
      entry.finishedAt = Date.now();
      clearTimeout(entry.timer);
    }
    this.#emitStatus(clientId);
  }

  #emitStatus(clientId) {
    this.emit('pairing', clientId, this.getPairingStatus(clientId));
  }

  #armPairingTimer(entry) {
    clearTimeout(entry.timer);
    entry.timer = null;
    const deadline = entry.attempt?.deadline;
    if (!entry.attempt?.active || deadline == null) return;
    entry.timer = setTimeout(() => this.#runStep(entry, entry.attempt.expire()), Math.max(0, deadline - Date.now()));
    entry.timer.unref?.();
  }

  #onPairingMessage(conn, type, payload) {
    const entry = this.#pairings.get(conn.clientId);
    if (!entry?.attempt || entry.conn !== conn) return;
    let step;
    try {
      step = entry.attempt.onMessage(type, payload);
    } catch (err) {
      if (!(err instanceof PairingProtocolError)) throw err;
      this.#log.info(`[sendspin] ${conn.clientId.slice(0, 8)} pairing protocol error; closing (${cleanText(err.message, 120)})`);
      this.#setStatus(conn.clientId, { status: 'aborted', reason: 'protocol_error' });
      conn.close(1002);
      return;
    }
    this.#runStep(entry, step);
  }

  #runStep(entry, step) {
    if (!step) return;
    const { conn } = entry;
    for (const m of step.send) conn.sendJson(m.type, m.payload);
    const ev = step.event;
    if (ev && ev.kind !== 'ignored') {
      if (ev.kind === 'persist') this.#persist(entry, ev.record);
      else if (ev.kind === 'aborted') this.#leavePairing(entry, ev);
      this.#setStatus(conn.clientId, statusPatch(ev));
    }
    this.#armPairingTimer(entry);
  }

  #persist(entry, record) {
    const { conn } = entry;
    this.#store.storePairing({ clientId: record.clientId, psk: record.psk, method: record.method, name: conn.info?.name })
      .then(() => {
        if (!conn.isOpen) return;
        const step = entry.attempt.persisted();
        for (const m of step.send) conn.sendJson(m.type, m.payload);
        if (entry.staged) this.#store.unstagePairingPsk(conn.clientId).catch(() => {});
        this.#setStatus(conn.clientId, { status: 'paired' });
        this.#log.info(`[sendspin] ${conn.clientId.slice(0, 8)} paired (${record.method})`);
        this.emit('paired', conn.clientId, { method: record.method });
        const playback = entry.playback && conn.activities.includes('playback');
        const roles = conn.negotiatedRoles.filter((r) => this.#opts.roles.includes(r));
        return conn.rehandshake({ psk: record.psk, category: PSK_CATEGORY.LONG_TERM, activation: { activities: playback ? ['playback'] : [], roles } })
          .then(() => {
            this.#remember(conn);
            this.#trustChanged(conn.clientId);
          });
      })
      .catch((err) => {
        this.#log.warn(`[sendspin] ${conn.clientId.slice(0, 8)} pairing not completed: ${err.message}`);
        if (!entry.finished) this.#setStatus(conn.clientId, { status: 'aborted', reason: 'storage_failed' });
        conn.close(1011);
      });
  }

  #leavePairing(entry, ev) {
    const { conn } = entry;
    if (ev.by === 'client' && ev.reason === 'concurrent_attempt') return;
    if (!conn.isOpen || conn.rehandshaking) return;
    const activities = conn.activities.filter((a) => a !== 'pairing');
    if (entry.fromLongTerm && this.#store.isPaired(conn.clientId)) {
      const record = this.#store.record(conn.clientId);
      const roles = conn.negotiatedRoles.filter((r) => this.#opts.roles.includes(r));
      conn.rehandshake({ psk: record.psk, category: PSK_CATEGORY.LONG_TERM, activation: { activities, roles } })
        .catch((err) => this.#log.debug(`[sendspin] return to the long-term PSK failed: ${err.message}`));
      return;
    }
    const roles = this.#allowedRoles(conn);
    conn.activate({ activities: roles.length || this.#trusted(conn) ? activities : activities.filter((a) => a !== 'playback'), roles });
  }

  #pairingClosed(conn) {
    const entry = this.#pairings.get(conn.clientId);
    if (!entry || entry.conn !== conn || entry.finished) return;
    if (entry.staged && entry.rehandshaking) {
      this.#store.unstagePairingPsk(conn.clientId).catch(() => {});
      this.#setStatus(conn.clientId, { status: 'aborted', reason: 'token_rejected' });
    } else {
      this.#setStatus(conn.clientId, { status: 'aborted', reason: 'disconnected' });
    }
  }

  async unpair(clientId) {
    const removed = await this.#store.unpair(clientId);
    const conn = this.#clients.get(clientId);
    if (conn) this.#afterUnpair(conn);
    if (removed) {
      this.#log.info(`[sendspin] ${clientId.slice(0, 8)} unpaired`);
      this.emit('unpaired', clientId);
      this.emit('trust', clientId);
    }
    return removed;
  }

  // The lt-keyed session outlives its record: idle it, tell the device, and close it if the device does not.
  #afterUnpair(conn) {
    if (!conn.isOpen || !conn.isActivated) return;
    if (conn.rehandshaking) {
      conn.afterRehandshake(() => this.#afterUnpair(conn));
      return;
    }
    if (!conn.isPaired) {
      conn.credentialMismatch = false;
      this.#syncTrust(conn);
      return;
    }
    if (conn.activeRoles.length || conn.activities.length) conn.activate({ activities: [], roles: [] });
    conn.sendJson('server/unpair', {});
    const t = setTimeout(() => conn.close(1000, 'unpaired'), CLOSE_GRACE_MS);
    t.unref?.();
  }

  async forget(clientId) {
    const entry = this.#liveEntry(clientId);
    if (entry && !entry.finished) this.cancelPairing(clientId);
    await this.unpair(clientId);
    await this.#store.revokeApproval(clientId);
    await this.#store.unstagePairingPsk(clientId);
    this.#pairings.delete(clientId);
    this.#cooldowns.delete(clientId);
    const known = this.#known.get(clientId);
    if (known?.manual) this.disconnectFrom(known.url);
    this.#known.delete(clientId);
    this.#scheduleKnownSave();
    this.#trustChanged(clientId);
  }

  // ---- device listing ----

  devices() {
    const ids = new Set([...this.#known.keys(), ...this.#clients.keys(), ...this.#store.listRecords().map((r) => r.clientId),
      ...this.#store.listApprovals().map((a) => a.clientId)]);
    return [...ids].map((id) => this.device(id));
  }

  device(clientId) {
    const conn = this.#clients.get(clientId);
    const live = conn?.isActivated ? conn : null;
    const known = this.#known.get(clientId) ?? {};
    const pairing = this.getPairingStatus(clientId);
    const stored = this.#store.record(clientId)?.name ?? this.#store.approval(clientId)?.name ?? null;
    let connection;
    if (pairing && !this.#pairings.get(clientId).finished) connection = 'pairing';
    else if (live) connection = live.left || live.state?.available === false ? 'in-use-elsewhere' : 'online';
    else connection = OTHER_SERVER_GOODBYES.has(known.lastGoodbye) ? 'other-server' : 'offline';
    return {
      clientId,
      name: stored ?? live?.info.name ?? known.name ?? null,
      deviceInfo: live ? publicDeviceInfo(live.info.deviceInfo) : (known.deviceInfo ?? publicDeviceInfo()),
      trust: this.#store.trustState(clientId),
      connection,
      unpairedAccess: live ? live.info.unpairedAccess : (known.unpairedAccess ?? false),
      pairMethods: live ? Object.keys(parseSupportedPairMethods(live.info.supportedPairMethods).methods) : (known.pairMethods ?? []),
      roles: live ? [...live.activeRoles] : [],
      address: live ? connAddress(live) : (known.address ?? null),
      url: live?.url ?? known.url ?? null,
      manual: known.manual === true,
      lastSeen: live ? Date.now() : (known.lastSeen ?? null),
      pairing,
    };
  }

  #remember(conn) {
    const prev = this.#known.get(conn.clientId);
    this.#known.delete(conn.clientId);
    this.#known.set(conn.clientId, {
      clientId: conn.clientId, name: conn.info.name, deviceInfo: publicDeviceInfo(conn.info.deviceInfo),
      pairMethods: Object.keys(parseSupportedPairMethods(conn.info.supportedPairMethods).methods), unpairedAccess: conn.info.unpairedAccess,
      address: connAddress(conn), url: conn.url ?? prev?.url ?? null, lastSeen: Date.now(), lastGoodbye: null,
      manual: Boolean(conn.url) && (this.#dials.get(conn.url)?.source === 'address' || (prev?.manual === true && prev.url === conn.url)),
    });
    this.#capKnown();
    this.#scheduleKnownSave();
  }

  // Least recently seen untrusted devices go first; paired and approved ones are never evicted.
  #capKnown() {
    for (const id of this.#known.keys()) {
      if (this.#known.size <= this.#opts.maxKnown) return;
      if (!this.#clients.has(id) && !this.isTrusted(id)) this.#known.delete(id);
    }
  }

  get knownCount() {
    return this.#known.size;
  }

  #forgetLive(conn, info) {
    const k = this.#known.get(conn.clientId);
    if (!k) return;
    k.lastSeen = Date.now();
    k.lastGoodbye = info.goodbye ?? null;
    this.#scheduleKnownSave();
  }

  async #loadKnown() {
    this.#known.clear();
    let data;
    try {
      data = JSON.parse(await fsp.readFile(path.join(this.#opts.dataDir, KNOWN_DEVICES_FILE), 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') this.#log.warn(`[sendspin] ignoring ${KNOWN_DEVICES_FILE}: ${err.message}`);
      return;
    }
    const devices = (Array.isArray(data.devices) ? data.devices : []).filter((d) => isKeyId(d?.clientId)).map(parseKnown);
    devices.sort((a, b) => (a.lastSeen ?? 0) - (b.lastSeen ?? 0));
    for (const d of devices) this.#known.set(d.clientId, d);
    this.#capKnown();
  }

  #scheduleKnownSave() {
    if (this.#knownTimer || this.#stopping) return;
    this.#knownTimer = setTimeout(() => {
      this.#knownTimer = null;
      this.#saveKnown().catch((err) => this.#log.warn(`[sendspin] saving ${KNOWN_DEVICES_FILE} failed: ${err.message}`));
    }, 500);
    this.#knownTimer.unref?.();
  }

  #saveKnown() {
    const devices = [...this.#known.values()].sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0)).slice(0, MAX_KNOWN_DEVICES);
    const file = path.join(this.#opts.dataDir, KNOWN_DEVICES_FILE);
    const body = JSON.stringify({ version: 1, devices }, null, 2) + '\n';
    this.#knownWrite = this.#knownWrite.catch(() => {}).then(async () => {
      const tmp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
      await fsp.writeFile(tmp, body, { mode: 0o600 });
      await fsp.rename(tmp, file);
    });
    return this.#knownWrite;
  }
}
