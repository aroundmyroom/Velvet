import { EventEmitter } from 'node:events';
import winston from 'winston';
import {
  NoiseInitiator, NoiseError, SUITES, encodeMsg1Payload, parseMsg2Payload, packHandshake, unpackHandshake,
} from './noise.js';
import { SENTINEL_PSK, SENTINEL_PSK_ID, PSK_CATEGORY, pskId, decodeKeyId, isKeyId } from './keys.js';
import { MSG, WireError, Reassembler, fragment, frame, decodeJson, encodeAudioChunk, SEND_AHEAD_MAX } from './wire.js';

export const PROTOCOL_VERSION = 1;
export const MAX_WS_PAYLOAD = 65535;
export const MAX_CLIENT_HELLO_BYTES = 16384;
export const MAX_CLIENT_HELLO_DEPTH = 10;
export const MAX_INBOUND_MESSAGE = 1024 * 1024;
export const MAX_NAME_BYTES = 64;
export const IMPLEMENTED_ROLES = Object.freeze(['player@v1', 'controller@v1', 'metadata@v1', 'artwork@v1', 'color@v1']);
export const GOODBYE_REASONS = Object.freeze([
  'another_server', 'shutdown', 'restart', 'user_request', 'unauthorized', 'pairing_required', 'concurrent_attempt', 'unpaired',
]);
export const ACTIVITIES = Object.freeze(['playback', 'pairing']);
export const PAIR_METHODS = Object.freeze(['dynamic_pairing_code', 'pairing_psk', 'static_pairing_code']);
export const PAIR_FORMATS = Object.freeze(['digits', 'qr_code']);
export const PLAYER_COMMANDS = Object.freeze(['volume', 'mute', 'set_output_delay']);
export const CODECS = Object.freeze(['opus', 'flac', 'pcm']);
export const STREAM_ROLES = Object.freeze(['player', 'artwork', 'visualizer']);

const DEFAULT_TIMEOUTS = Object.freeze({ handshakeMs: 30_000, helloMs: 30_000, activateFallbackMs: 20_000, pingMs: 30_000, pongMs: 15_000 });
const SUPPORT_REQUIRED = new Set(['player@v1', 'visualizer@v1']);
const FAMILY_ORDER = ['player', 'controller'];
const MAX_LOGGED = 80;
const MAX_ROLES = 64;
const MAX_FORMATS = 64;

export class SendspinError extends Error {}

export function nowUs() {
  return process.hrtime.bigint() / 1000n;
}

// Peer JSON can carry objects whose toString is not a function; never coerce them.
export function cleanText(value, max = MAX_LOGGED) {
  let text;
  if (typeof value === 'string') text = value;
  else if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) text = `${value}`;
  else text = `[${Array.isArray(value) ? 'array' : typeof value}]`;
  // eslint-disable-next-line no-control-regex
  const s = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '?');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export function roleFamily(roleId) {
  const at = roleId.indexOf('@');
  return at < 0 ? roleId : roleId.slice(0, at);
}

function isVersionedRole(roleId) {
  const at = roleId.indexOf('@');
  return at > 0 && at < roleId.length - 1;
}

export function negotiateRoles(supportedRoles, hello = {}, implemented = IMPLEMENTED_ROLES) {
  const active = new Map();
  for (const roleId of supportedRoles) {
    const family = roleFamily(roleId);
    if (active.has(family) || !implemented.includes(roleId)) continue;
    if (SUPPORT_REQUIRED.has(roleId) && !isObject(hello[`${roleId}_support`])) continue;
    active.set(family, roleId);
  }
  const rank = (id) => {
    const i = FAMILY_ORDER.indexOf(roleFamily(id));
    return i < 0 ? FAMILY_ORDER.length : i;
  };
  return [...active.values()].sort((a, b) => rank(a) - rank(b));
}

export function unimplementedRoles(supportedRoles, implemented = IMPLEMENTED_ROLES) {
  return supportedRoles.filter((r) => !implemented.includes(r) && isVersionedRole(r)
    && !r.startsWith('_') && !r.slice(r.indexOf('@') + 1).startsWith('_'));
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isInt(v, min = -Infinity, max = Infinity) {
  return Number.isSafeInteger(v) && v >= min && v <= max;
}

function utf8Bytes(s) {
  return Buffer.byteLength(s, 'utf8');
}

function truncateUtf8(s, maxBytes) {
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= maxBytes) return s;
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8');
}

function jsonDepth(root) {
  let max = 0;
  const stack = [[root, 1]];
  while (stack.length) {
    const [v, d] = stack.pop();
    if (d > max) max = d;
    if (d > MAX_CLIENT_HELLO_DEPTH) return d;
    for (const child of Object.values(v)) {
      if (child !== null && typeof child === 'object') stack.push([child, d + 1]);
    }
  }
  return max;
}

function plainString(v, maxBytes = MAX_NAME_BYTES) {
  return typeof v === 'string' && utf8Bytes(v) <= maxBytes;
}

function parseFormat(f) {
  if (!isObject(f) || !CODECS.includes(f.codec) || !isInt(f.channels, 1, 32) || !isInt(f.sample_rate, 1, 768000)) return null;
  if (f.codec !== 'opus' && !isInt(f.bit_depth, 1, 64)) return null;
  const out = { codec: f.codec, sample_rate: f.sample_rate, channels: f.channels };
  if (isInt(f.bit_depth, 1, 64)) out.bit_depth = f.bit_depth;
  return out;
}

export function sameFormat(a, b) {
  return a.codec === b.codec && a.sample_rate === b.sample_rate && a.channels === b.channels
    && (a.codec === 'opus' || a.bit_depth === b.bit_depth);
}

class ProtocolError extends Error {}

function helloFail(m) {
  throw new ProtocolError(`client/hello: ${m}`);
}

function optional(payload, key, check, message) {
  const v = payload[key];
  if (v === undefined) return undefined;
  if (!check(v)) helloFail(message);
  return v;
}

function parseDeviceInfo(di) {
  const out = {};
  for (const k of ['product_name', 'manufacturer', 'software_version', 'mac_address']) {
    const v = optional(di, k, plainString, `device_info.${k} must be a string of at most 64 bytes`);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function parsePlayerSupport(ps) {
  const formats = ps.supported_formats;
  if (!Array.isArray(formats) || formats.length === 0 || formats.length > MAX_FORMATS || !isInt(ps.buffer_capacity, 1)) {
    helloFail('player@v1_support needs supported_formats and buffer_capacity');
  }
  return { supportedFormats: formats.map(parseFormat).filter(Boolean), bufferCapacity: ps.buffer_capacity };
}

function isRoleList(v) {
  return Array.isArray(v) && v.length <= MAX_ROLES && v.every((r) => typeof r === 'string' && r.length > 0 && r.length <= 64);
}

export function parseClientHello(payload) {
  if (!plainString(payload.name)) helloFail('name missing or longer than 64 bytes');
  if (!isRoleList(payload.supported_roles)) helloFail('supported_roles must be an array of role ids');
  const supportedRoles = [...new Set(payload.supported_roles)];
  const deviceInfo = optional(payload, 'device_info', isObject, 'device_info must be an object');
  const playerSupport = supportedRoles.includes('player@v1')
    ? optional(payload, 'player@v1_support', isObject, 'player@v1_support must be an object')
    : undefined;
  const unpaired = optional(payload, 'unpaired_access', (v) => isObject(v) && typeof v.enabled === 'boolean', 'unpaired_access.enabled must be a boolean');
  return {
    name: payload.name,
    supportedRoles,
    deviceInfo: deviceInfo ? parseDeviceInfo(deviceInfo) : {},
    player: playerSupport ? parsePlayerSupport(playerSupport) : null,
    supportedPairMethods: optional(payload, 'supported_pair_methods', isObject, 'supported_pair_methods must be an object') ?? {},
    unpairedAccess: unpaired?.enabled ?? false,
    raw: payload,
  };
}

function stateFail(m) {
  throw new ProtocolError(`client/state player: ${m}`);
}

function checkTiming(obj) {
  if (!isInt(obj.output_delay_ms, 0, 5000)) stateFail('output_delay_ms must be 0-5000');
  if (!isInt(obj.min_buffer_ms, 0, 5000)) stateFail('min_buffer_ms must be 0-5000');
  if (!isInt(obj.required_lead_time_ms, 0)) stateFail('required_lead_time_ms must be a non-negative integer');
  if (!Array.isArray(obj.supported_commands) || obj.supported_commands.length > 32) stateFail('supported_commands must be an array');
}

export function parsePlayerState(obj, player) {
  if (!isObject(obj)) stateFail('must be an object');
  checkTiming(obj);
  const commands = PLAYER_COMMANDS.filter((c) => obj.supported_commands.includes(c));
  if (obj.volume !== undefined && !isInt(obj.volume, 0, 100)) stateFail('volume must be 0-100');
  if (obj.muted !== undefined && typeof obj.muted !== 'boolean') stateFail('muted must be a boolean');
  if (commands.includes('volume') && obj.volume === undefined) stateFail('volume is required with the volume command');
  if (commands.includes('mute') && obj.muted === undefined) stateFail('muted is required with the mute command');
  const f = obj.format === undefined ? null : parseFormat(obj.format);
  return {
    outputDelayMs: obj.output_delay_ms,
    minBufferMs: obj.min_buffer_ms,
    requiredLeadTimeMs: obj.required_lead_time_ms,
    supportedCommands: commands,
    volume: obj.volume ?? null,
    muted: obj.muted ?? null,
    format: f && player?.supportedFormats.some((s) => sameFormat(s, f)) ? f : null,
  };
}

const ARTWORK_SOURCES = ['album', 'artist'];
const ARTWORK_FORMATS = ['jpeg', 'png'];
const MAX_ARTWORK_CHANNELS = 4;
const MAX_ARTWORK_SIDE = 4096;
const VISUALIZER_TYPES = ['beat', 'loudness', 'f_peak', 'peak', 'spectrum'];
const SPECTRUM_SCALES = ['mel', 'log', 'lin'];
const SOURCE_SIGNALS = ['present', 'absent'];
const MAX_SEEK_OFFSET_MS = 86_400_000;

function parseArtworkChannel(ch) {
  if (!isObject(ch) || !ARTWORK_SOURCES.includes(ch.source) || !ARTWORK_FORMATS.includes(ch.format)
    || !isInt(ch.width, 1, MAX_ARTWORK_SIDE) || !isInt(ch.height, 1, MAX_ARTWORK_SIDE)) return { source: 'none' };
  return { source: ch.source, format: ch.format, width: ch.width, height: ch.height };
}

export function parseArtworkState(obj) {
  if (!isObject(obj) || !Array.isArray(obj.channels) || !obj.channels.length || obj.channels.length > MAX_ARTWORK_CHANNELS) return null;
  return { channels: obj.channels.map(parseArtworkChannel) };
}

export function parseVisualizerState(obj) {
  if (!isObject(obj) || !Array.isArray(obj.types) || obj.types.length > 16 || !isInt(obj.rate_max, 1, 1000)) return null;
  const types = VISUALIZER_TYPES.filter((t) => obj.types.includes(t));
  const out = { types, rate_max: obj.rate_max };
  if (types.includes('spectrum')) {
    const sp = obj.spectrum;
    if (!isObject(sp) || !isInt(sp.n_disp_bins, 1, 4096) || !SPECTRUM_SCALES.includes(sp.scale)
      || !isInt(sp.f_min, 0, 192_000) || !isInt(sp.f_max, 1, 192_000)) {
      throw new ProtocolError('client/state visualizer: spectrum requested without a valid spectrum object');
    }
    out.spectrum = { n_disp_bins: sp.n_disp_bins, scale: sp.scale, f_min: sp.f_min, f_max: sp.f_max };
  }
  return out;
}

export function parseSourceState(obj) {
  return isObject(obj) && SOURCE_SIGNALS.includes(obj.signal) ? { signal: obj.signal } : null;
}

const ROLE_STATE_PARSERS = Object.freeze({ artwork: parseArtworkState, visualizer: parseVisualizerState, source: parseSourceState });

export function parseControllerCommand(c) {
  if (!isObject(c) || typeof c.command !== 'string' || c.command.length > 64) return null;
  const out = { command: c.command };
  if (isInt(c.volume, 0, 100)) out.volume = c.volume;
  if (typeof c.mute === 'boolean') out.mute = c.mute;
  if (isInt(c.position_ms, 0, Number.MAX_SAFE_INTEGER)) out.position_ms = c.position_ms;
  if (isInt(c.offset_ms, -MAX_SEEK_OFFSET_MS, MAX_SEEK_OFFSET_MS)) out.offset_ms = c.offset_ms;
  return out;
}

const TRANSPORT_PHASES = new Set(['hello', 'activate', 'active']);

export class SendspinConnection extends EventEmitter {
  #ws;
  #identity;
  #log;
  #timeouts;
  #resolvePsk;
  #hasPairingRecord;
  #implemented;
  #phase = 'init';
  #clientInitRaw = null;
  #initiator = null;
  #tx = null;
  #rx = null;
  #reassembler = new Reassembler({ maxBytes: MAX_INBOUND_MESSAGE });
  #timer = null;
  #pingTimer = null;
  #pongTimer = null;
  #rehandshake = null;
  #activated = false;
  #closing = false;
  #closed = false;
  #mismatchCheck = Promise.resolve();
  #streams = new Set();
  #playerStateReceived = false;

  constructor({ ws, identity, name, languages, direction = 'inbound', url = null, remoteAddress = null,
    resolvePsk = null, hasPairingRecord = null, implementedRoles = IMPLEMENTED_ROLES, logger = winston, timeouts = {} }) {
    super();
    this.#ws = ws;
    this.#identity = identity;
    this.#log = logger;
    this.#timeouts = { ...DEFAULT_TIMEOUTS, ...timeouts };
    this.#resolvePsk = resolvePsk ?? (() => ({ psk: SENTINEL_PSK, category: PSK_CATEGORY.SENTINEL }));
    this.#hasPairingRecord = hasPairingRecord ?? (() => false);
    this.#implemented = implementedRoles;
    this.serverName = truncateUtf8(String(name || 'Velvet'), MAX_NAME_BYTES);
    this.languages = Array.isArray(languages) && languages.length ? languages.filter((l) => typeof l === 'string') : null;
    this.direction = direction;
    this.url = url;
    this.remoteAddress = remoteAddress;
    this.clientId = null;
    this.suite = null;
    this.pskCategory = null;
    this.offeredCategory = null;
    this.pskId = null;
    this.pairingIndex = 0;
    this.credentialMismatch = false;
    this.handshakeHash = null;
    this.info = null;
    this.negotiatedRoles = [];
    this.unimplementedRoles = [];
    this.activities = [];
    this.activeRoles = [];
    this.state = null;
    this.goodbyeReason = null;
    this.connectedAt = Date.now();
    this.closed = new Promise((resolve) => this.once('close', resolve));
    this.closed.catch(() => {});

    ws.on('message', (data, isBinary) => this.#onMessage(data, isBinary));
    ws.on('close', this.#guard('close', (code) => this.#onClose(code)));
    ws.on('error', this.#guard('error', (err) => this.#debug(`websocket error: ${cleanText(err?.message)}`)));
    ws.on('pong', this.#guard('pong', () => this.#onPong()));
    this.#arm(this.#timeouts.handshakeMs, 'client/init');
  }

  get phase() {
    return this.#phase;
  }

  get isActivated() {
    return this.#activated;
  }

  get isOpen() {
    return !this.#closed && this.#ws.readyState === 1;
  }

  get bufferedAmount() {
    return this.#ws.bufferedAmount;
  }

  get activeStreams() {
    return [...this.#streams];
  }

  get playerStateReceived() {
    return this.#playerStateReceived;
  }

  get isPaired() {
    return this.pskCategory === PSK_CATEGORY.LONG_TERM;
  }

  get playbackAllowed() {
    if (this.credentialMismatch) return false;
    if (this.pskCategory === PSK_CATEGORY.LONG_TERM) return true;
    return Boolean(this.info?.unpairedAccess);
  }

  get rehandshaking() {
    return Boolean(this.#rehandshake && !this.#rehandshake.done);
  }

  nextPairingIndex() {
    return ++this.pairingIndex;
  }

  hasRole(family) {
    return this.activeRoles.some((r) => roleFamily(r) === family);
  }

  // No error may escape a socket event or timer: an uncaught one takes the whole Velvet process down.
  #guard(what, fn) {
    return (...args) => {
      try {
        fn(...args);
      } catch (err) {
        this.#fail(err, what);
      }
    };
  }

  #fail(err, what) {
    if (err instanceof NoiseError || err instanceof WireError || err instanceof ProtocolError) {
      this.#debug(`closing: ${cleanText(err.message, 160)}`);
      this.#abort(1002);
      return;
    }
    try {
      this.#log.warn(`[sendspin] ${this.#tag()} ${what} failed; closing: ${cleanText(err?.message, 160)}`);
    } catch {
      // a broken logger must not turn this into an uncaught exception either
    }
    this.#abort(1011);
  }

  #debug(msg) {
    this.#log.debug(`[sendspin] ${this.#tag()} ${msg}`);
  }

  #tag() {
    return this.clientId ? this.clientId.slice(0, 8) : (this.remoteAddress || this.url || 'peer');
  }

  #arm(ms, what) {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(this.#guard('timer', () => {
      this.#debug(`timed out waiting for ${what}`);
      this.#abort(1002);
    }), ms);
    this.#timer.unref?.();
  }

  #disarm() {
    clearTimeout(this.#timer);
    this.#timer = null;
  }

  #onMessage(data, isBinary) {
    if (this.#closed || this.#closing) return;
    try {
      const recvUs = nowUs();
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
      if (this.#phase === 'init') this.#onClientInit(buf, isBinary);
      else if (this.#phase === 'msg2') this.#onMessage2(buf, isBinary);
      else if (!TRANSPORT_PHASES.has(this.#phase) || !this.#rx) throw new ProtocolError(`message while ${this.#phase}`);
      else if (isBinary) this.#onTransport(buf, recvUs);
      else throw new ProtocolError('cleartext message in transport mode');
    } catch (err) {
      this.#fail(err, 'message handling');
    }
  }

  #sendText(text) {
    this.#ws.send(text, { binary: false });
  }

  #initError(reason) {
    this.#debug(`client/init rejected: ${reason}`);
    if (this.#ws.readyState === 1) this.#sendText(JSON.stringify({ payload: { reason }, type: 'server/error' }));
    this.#abort(1002);
  }

  #onClientInit(raw, isBinary) {
    if (isBinary) return this.#initError('malformed');
    let obj;
    try {
      obj = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
    } catch {
      return this.#initError('malformed');
    }
    if (!isObject(obj) || obj.type !== 'client/init' || !isObject(obj.payload)) return this.#initError('malformed');
    const { version, suite, client_id: clientId } = obj.payload;
    if (typeof version !== 'number' || !Number.isInteger(version)) return this.#initError('malformed');
    if (version !== PROTOCOL_VERSION) return this.#initError('unsupported_version');
    if (typeof suite !== 'string') return this.#initError('malformed');
    if (!SUITES.includes(suite)) return this.#initError('unsupported_suite');
    if (!isKeyId(clientId)) return this.#initError('malformed');
    this.#clientInitRaw = raw;
    this.clientId = clientId;
    this.suite = suite;
    this.#phase = 'resolving';
    this.#disarm();
    Promise.resolve()
      .then(() => this.#resolvePsk(clientId))
      .then((resolved) => this.#startHandshake(resolved))
      .catch((err) => this.#fail(err, 'handshake setup'));
  }

  #startHandshake(resolved) {
    if (this.#closed || this.#closing) return;
    if (!resolved) {
      this.#debug('no PSK admits this client');
      this.#abort(1008);
      return;
    }
    const serverInit = Buffer.from(JSON.stringify({ payload: { server_id: this.#identity.serverId, version: PROTOCOL_VERSION }, type: 'server/init' }), 'utf8');
    this.#initiator = new NoiseInitiator({
      suite: this.suite,
      staticKeyPair: { publicKey: this.#identity.publicKey, privateKey: this.#identity.privateKey },
      remoteStaticPublicKey: decodeKeyId(this.clientId),
      prologue: Buffer.concat([this.#clientInitRaw, serverInit]),
      psk: resolved.psk,
    });
    this.pskCategory = resolved.category;
    this.offeredCategory = resolved.category;
    this.pskId = pskId(resolved.psk);
    const msg1 = this.#initiator.writeMessage1(encodeMsg1Payload(pskId(resolved.psk), resolved.category));
    this.#phase = 'msg2';
    this.#ws.send(serverInit, { binary: false });
    this.#sendText(packHandshake(msg1));
    this.#arm(this.#timeouts.handshakeMs, 'Noise message 2');
  }

  #onMessage2(raw, isBinary) {
    if (isBinary) throw new ProtocolError('binary message during the handshake');
    const msg2 = unpackHandshake(raw.toString('utf8'));
    let payload;
    let mismatch = false;
    try {
      payload = this.#initiator.readMessage2(msg2);
    } catch (err) {
      if (!(err instanceof NoiseError) || this.pskCategory === PSK_CATEGORY.SENTINEL) throw err;
      payload = this.#initiator.readMessage2(msg2, SENTINEL_PSK);
      mismatch = true;
    }
    if (!parseMsg2Payload(payload).canonical) this.#debug('Noise message 2 payload is not the literal {}');
    const { send, recv } = this.#initiator.split();
    this.#tx = send;
    this.#rx = recv;
    this.handshakeHash = this.#initiator.handshakeHash;
    this.#initiator = null;
    this.#clientInitRaw = null;
    this.#phase = 'hello';
    this.pairingIndex = 0;
    if (mismatch) {
      this.pskCategory = PSK_CATEGORY.SENTINEL;
      this.pskId = SENTINEL_PSK_ID;
      this.#mismatchCheck = Promise.resolve(this.#hasPairingRecord(this.clientId)).then((has) => {
        this.credentialMismatch = Boolean(has);
        if (has) this.#log.warn(`[sendspin] ${this.#tag()} could not use its pairing record (credential mismatch); re-pair it`);
      }).catch(() => { this.credentialMismatch = true; });
    }
    this.#debug(`handshake complete (${this.suite}, psk ${this.pskCategory}${mismatch ? ', sentinel fallback' : ''})`);
    this.#sendJsonNow('server/hello', this.languages ? { name: this.serverName, languages: this.languages } : { name: this.serverName });
    this.#arm(this.#timeouts.helloMs, 'client/hello');
    this.#startPing();
  }

  #onTransport(raw, recvUs) {
    if (this.#rehandshake && !this.#rehandshake.done) {
      this.#onRehandshakeMessage(raw);
      return;
    }
    const plaintext = this.#rx.decrypt(raw);
    const msg = this.#reassembler.push(plaintext);
    if (!msg) return;
    if (msg.type !== MSG.JSON) return;
    if (this.#phase === 'hello' && msg.payload.length > MAX_CLIENT_HELLO_BYTES) throw new ProtocolError('client/hello exceeds 16384 bytes');
    this.#onJson(decodeJson(msg.payload), recvUs);
  }

  #onJson(msg, recvUs) {
    const { type, payload } = msg;
    if (type === 'client/goodbye') return this.#onGoodbye(payload);
    if (this.#phase === 'hello') {
      if (type !== 'client/hello') {
        this.#debug(`ignoring ${cleanText(type)} before client/hello`);
        return;
      }
      return this.#onClientHello(payload);
    }
    if (!this.#activated) {
      this.#debug(`ignoring ${cleanText(type)} before server/activate`);
      return;
    }
    switch (type) {
      case 'client/time': return this.#onTime(payload, recvUs);
      case 'client/state': return this.#onState(payload);
      case 'client/command': return this.#onCommand(payload);
      case 'client/leave': return this.emit('leave');
      case 'client/hello': throw new ProtocolError('duplicate client/hello');
      default:
        this.emit('message', type, payload);
    }
  }

  #onClientHello(payload) {
    if (jsonDepth(payload) > MAX_CLIENT_HELLO_DEPTH - 1) throw new ProtocolError('client/hello nests deeper than 10 levels');
    this.info = parseClientHello(payload);
    this.negotiatedRoles = negotiateRoles(this.info.supportedRoles, payload, this.#implemented);
    this.unimplementedRoles = unimplementedRoles(this.info.supportedRoles, this.#implemented);
    this.#phase = 'activate';
    this.#disarm();
    if (this.unimplementedRoles.length) {
      this.#log.info(`[sendspin] ${this.#tag()} offers roles we do not implement: ${cleanText(this.unimplementedRoles.join(', '), 160)}`);
    }
    this.#debug(`client/hello from "${cleanText(this.info.name)}" roles=${cleanText(this.info.supportedRoles.join(','), 160)} unpaired_access=${this.info.unpairedAccess}`);
    this.#timer = setTimeout(this.#guard('activation fallback', () => {
      if (!this.#activated && !this.#closed && !this.#closing) {
        this.#log.warn(`[sendspin] ${this.#tag()} no activation decided in time; activating idle`);
        this.activate({ activities: [], roles: [] });
      }
    }), this.#timeouts.activateFallbackMs);
    this.#timer.unref?.();
    this.#mismatchCheck
      .then(() => {
        if (!this.#closed && !this.#closing) this.emit('hello', this.info);
      })
      .catch((err) => this.#fail(err, 'client/hello'));
  }

  #onGoodbye(payload) {
    const reason = typeof payload.reason === 'string' && GOODBYE_REASONS.includes(payload.reason) ? payload.reason : null;
    this.goodbyeReason = reason ?? 'unknown';
    this.#debug(`client/goodbye ${reason ?? cleanText(payload.reason)}`);
    this.emit('goodbye', this.goodbyeReason);
    this.close(1000, 'goodbye');
  }

  #onTime(payload, recvUs) {
    const ct = payload.client_transmitted;
    if (!Number.isSafeInteger(ct)) throw new ProtocolError('client/time client_transmitted must be an integer');
    const serverReceived = Number(recvUs);
    let serverTransmitted = 0;
    this.#sendJsonNow('server/time', () => {
      serverTransmitted = Number(nowUs());
      return { client_transmitted: ct, server_received: serverReceived, server_transmitted: serverTransmitted };
    });
    this.emit('time', { clientTransmitted: ct, serverReceived, serverTransmitted });
  }

  #onState(payload) {
    if (typeof payload.available !== 'boolean') throw new ProtocolError('client/state available must be a boolean');
    const prev = this.state;
    const next = { available: payload.available, player: prev?.player ?? null, roles: { ...prev?.roles } };
    if (this.hasRole('player') && payload.player !== undefined) {
      next.player = parsePlayerState(payload.player, this.info.player);
      this.#playerStateReceived = true;
    }
    for (const [family, parse] of Object.entries(ROLE_STATE_PARSERS)) {
      if (!this.hasRole(family) || payload[family] === undefined) continue;
      const parsed = parse(payload[family]);
      if (parsed) next.roles[family] = parsed;
    }
    this.state = next;
    this.emit('state', next, prev);
  }

  #onCommand(payload) {
    if (!this.hasRole('controller')) return;
    const controller = parseControllerCommand(payload.controller);
    if (controller) this.emit('command', { controller });
  }

  #canSendApp() {
    return this.isOpen && this.#tx !== null && !(this.#rehandshake && !this.#rehandshake.done);
  }

  #sendPlaintext(plaintext) {
    for (const part of fragment(plaintext)) this.#ws.send(this.#tx.encrypt(part), { binary: true });
  }

  #sendJsonNow(type, payload) {
    const body = typeof payload === 'function' ? payload() : payload;
    this.#sendPlaintext(frame(MSG.JSON, Buffer.from(JSON.stringify({ type, payload: body }), 'utf8')));
  }

  #requireActive(what) {
    if (!this.#activated) throw new SendspinError(`${what} before server/activate`);
    return this.#canSendApp();
  }

  sendJson(type, payload = {}) {
    if (!this.#requireActive(type)) return false;
    this.#sendJsonNow(type, payload);
    return true;
  }

  sendBinary(plaintext) {
    if (!this.#requireActive('binary message')) return false;
    this.#sendPlaintext(plaintext);
    return true;
  }

  #allowedSet(acts, withPlayback, category, mismatch) {
    const set = withPlayback ? new Set([...acts, 'playback']) : new Set(acts);
    if (category === PSK_CATEGORY.LONG_TERM) return !set.has('pairing');
    return !set.has('playback') || (!mismatch && Boolean(this.info?.unpairedAccess));
  }

  #checkPairing(acts, pairing, category) {
    if (!acts.includes('pairing')) {
      if (pairing) throw new SendspinError('pairing object without the pairing activity');
      return;
    }
    if (!isObject(pairing) || !PAIR_METHODS.includes(pairing.method)) throw new SendspinError('pairing activity needs a pairing method');
    if (!Object.hasOwn(this.info.supportedPairMethods, pairing.method)) throw new SendspinError('client does not offer this pairing method');
    if ((pairing.method === 'pairing_psk') !== (category === PSK_CATEGORY.PAIRING)) throw new SendspinError('pairing_psk iff the pairing PSK matched');
    if ((pairing.method === 'dynamic_pairing_code') !== PAIR_FORMATS.includes(pairing.format)) throw new SendspinError('format belongs to dynamic_pairing_code only');
  }

  #checkActivation(activities, nextRoles, pairing, category = this.pskCategory, mismatch = this.credentialMismatch) {
    if (!this.info) throw new SendspinError('server/activate before client/hello');
    if (!Array.isArray(activities) || !activities.every((a) => ACTIVITIES.includes(a))) throw new SendspinError('invalid activities');
    if (!nextRoles.every((r) => this.negotiatedRoles.includes(r))) throw new SendspinError('role was not negotiated with this client');
    if (!this.#allowedSet(activities, false, category, mismatch) || (nextRoles.length && !this.#allowedSet(activities, true, category, mismatch))) {
      throw new SendspinError(mismatch ? 'credential mismatch: re-pair before playback' : 'activity set not allowed for this session');
    }
    this.#checkPairing(activities, pairing, category);
    if (this.#rehandshake && !this.#rehandshake.done) throw new SendspinError('re-handshake in progress');
  }

  #streamsEndedBy(activities, nextRoles) {
    const kept = (s) => nextRoles.some((r) => roleFamily(r) === s);
    return [...this.#streams].filter((s) => !kept(s) || (s !== 'artwork' && !activities.includes('playback')));
  }

  activate({ activities = this.activities, roles, pairing } = {}) {
    const nextRoles = roles ?? (this.#activated ? this.activeRoles : []);
    this.#checkActivation(activities, nextRoles, pairing);
    if (!this.isOpen) return false;
    const acts = [...new Set(activities)];
    const ended = this.#streamsEndedBy(acts, nextRoles);
    if (ended.length) this.streamEnd(ended);
    const first = !this.#activated;
    const payload = { activities: acts };
    if (first || roles !== undefined) payload.active_roles = nextRoles;
    if (pairing) payload.pairing = pairing.format ? { method: pairing.method, format: pairing.format } : { method: pairing.method };
    this.#sendJsonNow('server/activate', payload);
    if (!nextRoles.some((r) => roleFamily(r) === 'player')) this.#playerStateReceived = false;
    this.activities = acts;
    this.activeRoles = [...nextRoles];
    if (first) {
      this.#activated = true;
      this.#phase = 'active';
      clearTimeout(this.#timer);
    }
    this.emit('activated', { activities: acts, roles: this.activeRoles, first });
    return true;
  }

  groupUpdate({ playbackState, groupId, groupName }) {
    if (!['playing', 'stopped'].includes(playbackState)) throw new SendspinError('playback_state must be playing or stopped');
    if (!isKeyId(groupId)) throw new SendspinError('group_id must be 43 base64url characters');
    return this.sendJson('group/update', {
      playback_state: playbackState, group_id: groupId, group_name: truncateUtf8(String(groupName), MAX_NAME_BYTES),
    });
  }

  serverState(state) {
    return this.sendJson('server/state', state);
  }

  serverCommand({ player, ...rest }) {
    if (player) {
      if (!this.hasRole('player') || !this.state?.player) throw new SendspinError('player command before the initial player state');
      if (!this.state.player.supportedCommands.includes(player.command)) throw new SendspinError(`player does not support ${player.command}`);
    }
    return this.sendJson('server/command', player ? { player, ...rest } : rest);
  }

  #checkStreamStart({ player, artwork, visualizer }) {
    if (!this.state?.available) throw new SendspinError('stream/start needs available: true');
    const playback = this.activities.includes('playback');
    if (player) {
      if (!playback || !this.hasRole('player')) throw new SendspinError('player stream needs playback and the player role');
      if (!this.#playerStateReceived) throw new SendspinError('player stream before the player state');
      if (!this.info.player.supportedFormats.some((f) => sameFormat(f, player))) throw new SendspinError('format not in supported_formats');
    }
    if (artwork && !this.hasRole('artwork')) throw new SendspinError('artwork stream without the artwork role');
    if (visualizer && (!playback || !this.hasRole('visualizer'))) throw new SendspinError('visualizer stream needs playback and the visualizer role');
  }

  streamStart(roles = {}) {
    this.#checkStreamStart(roles);
    if (!this.#requireActive('stream/start')) return false;
    const payload = Object.fromEntries(Object.entries(roles).filter(([, v]) => v));
    this.#sendJsonNow('stream/start', () => ({ server_transmitted: Number(nowUs()), ...payload }));
    for (const r of Object.keys(payload)) this.#streams.add(r);
    return true;
  }

  streamClear({ roles, fromTimestamp } = {}) {
    const targets = roles ?? [...this.#streams].filter((r) => r === 'player' || r === 'visualizer');
    if (!targets.length || !targets.every((r) => this.#streams.has(r))) throw new SendspinError('stream/clear targets an inactive stream');
    if (!this.#requireActive('stream/clear')) return false;
    this.#sendJsonNow('stream/clear', () => {
      const p = { server_transmitted: Number(nowUs()) };
      if (fromTimestamp !== undefined) p.from_timestamp = Number(fromTimestamp);
      if (roles) p.roles = roles;
      return p;
    });
    return true;
  }

  streamEnd(roles) {
    const targets = roles ?? [...this.#streams];
    if (!targets.length || !targets.every((r) => this.#streams.has(r))) throw new SendspinError('stream/end targets an inactive stream');
    if (!this.#requireActive('stream/end')) return false;
    this.#sendJsonNow('stream/end', roles ? { roles } : {});
    for (const r of targets) this.#streams.delete(r);
    return true;
  }

  sendAudioChunk(timestampUs, audioFrame) {
    if (!this.#streams.has('player') || !this.activities.includes('playback')) throw new SendspinError('audio outside an active player stream');
    if (!this.#canSendApp()) return 0;
    const ts = BigInt(timestampUs);
    const plaintext = encodeAudioChunk(ts, 0n, audioFrame);
    let ahead = ts - nowUs();
    if (ahead < 0n) ahead = 0n;
    else if (ahead > SEND_AHEAD_MAX) ahead = SEND_AHEAD_MAX;
    plaintext.writeUInt32BE(Number(ahead), 9);
    this.#sendPlaintext(plaintext);
    return plaintext.length;
  }

  rehandshake({ psk, category, activation = {}, beforeActivate = null }) {
    if (!this.#activated || this.#rehandshake) throw new SendspinError('re-handshake needs an activated, idle connection');
    const acts = activation.activities ?? this.activities;
    const nextRoles = activation.roles ?? this.activeRoles;
    this.#checkActivation(acts, nextRoles, activation.pairing, category, false);
    const ended = this.#streamsEndedBy(acts, nextRoles);
    if (ended.length) this.streamEnd(ended);
    const initiator = new NoiseInitiator({
      suite: this.suite,
      staticKeyPair: { publicKey: this.#identity.publicKey, privateKey: this.#identity.privateKey },
      remoteStaticPublicKey: decodeKeyId(this.clientId),
      prologue: this.handshakeHash,
      psk,
    });
    const msg1 = initiator.writeMessage1(encodeMsg1Payload(pskId(psk), category));
    const state = { done: false, initiator, category, activation, beforeActivate, pskId: pskId(psk) };
    state.promise = new Promise((resolve, reject) => { state.resolve = resolve; state.reject = reject; });
    state.promise.catch(() => {});
    this.#sendJsonNow('noise/handshake', { data: msg1.toString('base64url') });
    this.#rehandshake = state;
    this.#arm(this.#timeouts.handshakeMs, 're-handshake Noise message 2');
    return state.promise;
  }

  // Runs fn now, or once the running re-handshake has re-activated; dropped if the connection closes first.
  afterRehandshake(fn) {
    const rh = this.#rehandshake;
    if (!rh || rh.done) {
      fn();
      return;
    }
    rh.promise.then(() => fn(), () => {}).catch((err) => this.#fail(err, 'deferred activation'));
  }

  #onRehandshakeMessage(raw) {
    const plaintext = this.#rx.decrypt(raw);
    const msg = this.#reassembler.push(plaintext);
    if (!msg || msg.type !== MSG.JSON) return;
    const obj = decodeJson(msg.payload);
    if (obj.type !== 'noise/handshake') return;
    const data = obj.payload.data;
    if (typeof data !== 'string' || !/^[A-Za-z0-9_-]+$/.test(data)) throw new ProtocolError('malformed noise/handshake');
    const state = this.#rehandshake;
    parseMsg2Payload(state.initiator.readMessage2(Buffer.from(data, 'base64url')));
    const { send, recv } = state.initiator.split();
    this.#tx = send;
    this.#rx = recv;
    this.#reassembler = new Reassembler({ maxBytes: MAX_INBOUND_MESSAGE });
    this.handshakeHash = state.initiator.handshakeHash;
    this.pskCategory = state.category;
    this.pskId = state.pskId;
    this.pairingIndex = 0;
    this.credentialMismatch = false;
    state.done = true;
    this.#rehandshake = null;
    this.#disarm();
    state.beforeActivate?.();
    this.activate(state.activation);
    state.resolve();
  }

  #startPing() {
    this.#pingTimer = setInterval(this.#guard('ping', () => {
      if (!this.isOpen) return;
      this.#ws.ping();
      if (this.#pongTimer) return;
      this.#pongTimer = setTimeout(this.#guard('pong timeout', () => {
        this.#debug('no pong; dropping connection');
        this.#ws.terminate();
      }), this.#timeouts.pongMs);
      this.#pongTimer.unref?.();
    }), this.#timeouts.pingMs);
    this.#pingTimer.unref?.();
  }

  #onPong() {
    clearTimeout(this.#pongTimer);
    this.#pongTimer = null;
  }

  #abort(code) {
    if (this.#closed || this.#closing) return;
    this.#closing = true;
    try {
      if (this.#ws.readyState === 1) this.#ws.close(code);
      else this.#ws.terminate();
    } catch {
      this.#ws.terminate();
    }
    const t = setTimeout(() => this.#ws.terminate(), 2000);
    t.unref?.();
  }

  terminate() {
    if (!this.#closed) this.#ws.terminate();
  }

  close(code = 1000, reason = '') {
    if (this.#closed) return;
    this.#closing = true;
    if (this.#ws.readyState === 1) this.#ws.close(code, typeof reason === 'string' ? reason.slice(0, 120) : '');
    else this.#ws.terminate();
    const t = setTimeout(() => this.#ws.terminate(), 2000);
    t.unref?.();
  }

  #onClose(code) {
    if (this.#closed) return;
    this.#closed = true;
    clearTimeout(this.#timer);
    clearInterval(this.#pingTimer);
    clearTimeout(this.#pongTimer);
    this.#rehandshake?.reject(new SendspinError('connection closed'));
    this.#streams.clear();
    this.emit('close', {
      code,
      goodbye: this.goodbyeReason,
      handshakeCompleted: this.#tx !== null,
      activated: this.#activated,
      activities: this.activities,
      durationMs: Date.now() - this.connectedAt,
    });
  }
}
