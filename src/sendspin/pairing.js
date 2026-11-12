import crypto from 'node:crypto';
import { SENTINEL_PSK, pskId, encodeKeyId, isKeyId } from './keys.js';

export const METHODS = Object.freeze({
  PAIRING_PSK: 'pairing_psk',
  DYNAMIC: 'dynamic_pairing_code',
  STATIC: 'static_pairing_code',
});
export const FORMATS = Object.freeze({ DIGITS: 'digits', QR_CODE: 'qr_code' });
export const ABORT_REASONS = Object.freeze({
  ATTEMPT_TIMEOUT: 'attempt_timeout',
  CONCURRENT_ATTEMPT: 'concurrent_attempt',
  METHOD_NOT_SUPPORTED: 'method_not_supported',
  PAIRING_CODE_MISMATCH: 'pairing_code_mismatch',
  USER_CANCELLED: 'user_cancelled',
});
export const PAIRING_MESSAGE_TYPES = new Set([
  'client/pair-pending', 'client/pair-init', 'client/pair-auth', 'client/pair-confirm',
  'client/pair-retry', 'client/pair-finalize', 'pair/abort',
]);
export const ROUND_LIMIT = 20;
export const PENDING_MESSAGE_MAX_BYTES = 200;
export const DYNAMIC_DIGITS = 6;
export const STATIC_DIGITS = 8;
export const QR_CODE_BYTES = 24;
// Longer than the client's recommended 2-minute attempt timeout, so the client's in-band
// abort wins when both sides are alive (same bounds as aiosendspin).
export const TIMEOUTS = Object.freeze({ firstMessageMs: 60_000, gestureMs: 360_000, attemptMs: 180_000 });
export const COOLDOWN = Object.freeze({ initialMs: 2_000, maxMs: 120_000 });

const PSK_TOKEN_VERSION = '0';
const CODE_TOKEN_VERSION = '1';
const TOKEN_PREFIX = 'SP:';
const MAX_TOKEN_CHARS = 512;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const LABEL = Object.freeze({
  commit: Buffer.from('sendspin-pair-commit-v1'),
  derive: Buffer.from('sendspin-pairing-code-derive-v1'),
  sid: Buffer.from('sendspin-pair-pake-v1'),
  pskWrap: Buffer.from('sendspin-pair-psk-wrap-v1'),
  nonceWrap: Buffer.from('sendspin-pair-nonce-wrap-v1'),
});
const AD_SERVER = Buffer.from('server');
const AD_CLIENT = Buffer.from('client');
const WRAP_NONCE = Buffer.alloc(12);
const TAG_LEN = 16;
const LEFTOVER_ABORTS = new Set([ABORT_REASONS.ATTEMPT_TIMEOUT, ABORT_REASONS.PAIRING_CODE_MISMATCH]);

export class PairingProtocolError extends Error {}

export class PairingInputError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}

export class CPaceError extends Error {}

function sha256(...parts) {
  const h = crypto.createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
}

function sha512(...parts) {
  const h = crypto.createHash('sha512');
  for (const p of parts) h.update(p);
  return h.digest();
}

function u32be(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}

function b64urlField(value, name, size) {
  const chars = Math.ceil((size * 4) / 3);
  if (typeof value !== 'string' || value.length !== chars || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new PairingProtocolError(`malformed ${name}: expected ${size} bytes base64url`);
  }
  return Buffer.from(value, 'base64url');
}

function sameBytes(a, b) {
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---- Pairing tokens -------------------------------------------------------------------------

function base32Encode(buf) {
  let out = '';
  let bits = 0;
  let acc = 0;
  for (const byte of buf) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32[(acc << (5 - bits)) & 31];
  return out;
}

function base32Decode(text) {
  if (![0, 2, 4, 5, 7].includes(text.length % 8)) throw new PairingInputError('malformed_token', 'malformed pairing token');
  const out = [];
  let bits = 0;
  let acc = 0;
  for (const ch of text) {
    const v = BASE32.indexOf(ch);
    if (v < 0) throw new PairingInputError('malformed_token', 'malformed pairing token');
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((acc >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
    acc &= (1 << bits) - 1;
  }
  return Buffer.from(out);
}

export function encodePairingToken(version, payload) {
  return `${TOKEN_PREFIX}${version}${base32Encode(payload).replaceAll('2', '9')}`;
}

export function decodePairingToken(input, expectVersion) {
  if (typeof input !== 'string' || input.length > MAX_TOKEN_CHARS) {
    throw new PairingInputError('malformed_token', 'malformed pairing token');
  }
  let text = input.trim();
  // Checked before upper-casing, which maps some non-ASCII letters onto ASCII ones.
  if (!/^[\x20-\x7e]*$/.test(text)) throw new PairingInputError('malformed_token', 'malformed pairing token');
  text = text.toUpperCase();
  if (text.startsWith(TOKEN_PREFIX)) text = text.slice(TOKEN_PREFIX.length);
  if (!text) throw new PairingInputError('malformed_token', 'malformed pairing token');
  if (text[0] !== expectVersion) {
    throw new PairingInputError('unsupported_token_version', 'unsupported pairing token version');
  }
  return base32Decode(text.slice(1).replaceAll('9', '2'));
}

export function encodePskToken(clientId, pairingPsk) {
  const key = Buffer.isBuffer(clientId) ? clientId : Buffer.from(clientId, 'base64url');
  if (key.length !== 32 || pairingPsk.length !== 32) throw new TypeError('client key and pairing PSK must be 32 bytes');
  return encodePairingToken(PSK_TOKEN_VERSION, Buffer.concat([key, pairingPsk]));
}

export function decodePskToken(input) {
  const payload = decodePairingToken(input, PSK_TOKEN_VERSION);
  if (payload.length < 64) throw new PairingInputError('malformed_token', 'malformed pairing token');
  const clientKey = Buffer.from(payload.subarray(0, 32));
  const pairingPsk = Buffer.from(payload.subarray(32, 64));
  return { clientId: encodeKeyId(clientKey), clientKey, pairingPsk, pskId: pskId(pairingPsk) };
}

export function assertTokenForClient(token, clientId) {
  if (!isKeyId(clientId) || !sameBytes(Buffer.from(clientId, 'base64url'), token.clientKey)) {
    throw new PairingInputError('wrong_client', 'pairing token belongs to a different device');
  }
}

export function encodeCodeToken(code) {
  if (code.length !== QR_CODE_BYTES) throw new TypeError(`pairing code must be ${QR_CODE_BYTES} bytes`);
  return encodePairingToken(CODE_TOKEN_VERSION, code);
}

export function decodeCodeToken(input) {
  const payload = decodePairingToken(input, CODE_TOKEN_VERSION);
  if (payload.length < QR_CODE_BYTES) throw new PairingInputError('malformed_token', 'malformed pairing token');
  return Buffer.from(payload.subarray(0, QR_CODE_BYTES));
}

// ---- Pairing codes --------------------------------------------------------------------------

export function stripSeparators(input) {
  return String(input).replace(/[\s-]/g, '');
}

export function parseDigitsCode(input, digits) {
  const code = stripSeparators(input);
  if (code.length !== digits || !/^\d+$/.test(code)) {
    throw new PairingInputError('invalid_code', `pairing code must be exactly ${digits} digits`);
  }
  return code;
}

export function formatCode(code) {
  const half = code.length / 2;
  return `${code.slice(0, half)}-${code.slice(half)}`;
}

export function commitNonce(nonceB) {
  return sha256(LABEL.commit, nonceB);
}

export function deriveCodeDigest(handshakeHash, nonceA, nonceB) {
  return sha256(LABEL.derive, handshakeHash, nonceA, nonceB);
}

export function deriveCodePrs(handshakeHash, nonceA, nonceB, format) {
  const digest = deriveCodeDigest(handshakeHash, nonceA, nonceB);
  if (format === FORMATS.QR_CODE) return digest.subarray(0, QR_CODE_BYTES);
  const value = BigInt(`0x${digest.toString('hex')}`) % 1_000_000n;
  return Buffer.from(value.toString().padStart(DYNAMIC_DIGITS, '0'), 'ascii');
}

export function pakeSid(handshakeHash, pairingIndex, round) {
  return Buffer.concat([LABEL.sid, handshakeHash, u32be(pairingIndex), u32be(round)]);
}

export function wrapKey(label, sid, isk) {
  return sha256(label === 'psk' ? LABEL.pskWrap : LABEL.nonceWrap, sid, isk);
}

function aeadAlgorithm(suite) {
  return suite === '25519_AESGCM_SHA256' ? 'aes-256-gcm' : 'chacha20-poly1305';
}

export function wrap(suite, key, value) {
  const cipher = crypto.createCipheriv(aeadAlgorithm(suite), key, WRAP_NONCE, { authTagLength: TAG_LEN });
  return Buffer.concat([cipher.update(value), cipher.final(), cipher.getAuthTag()]);
}

export function unwrap(suite, key, wrapped) {
  const decipher = crypto.createDecipheriv(aeadAlgorithm(suite), key, WRAP_NONCE, { authTagLength: TAG_LEN });
  decipher.setAuthTag(wrapped.subarray(wrapped.length - TAG_LEN));
  try {
    return Buffer.concat([decipher.update(wrapped.subarray(0, wrapped.length - TAG_LEN)), decipher.final()]);
  } catch {
    return null;
  }
}

// ---- CPACE-X25519-SHA512 (draft-irtf-cfrg-cpace-21) -----------------------------------------
// Elligator2 runs on BigInt, which is not constant time; its input is a hash of the pairing code
// and the per-round sid. The scalar multiplications run in OpenSSL's X25519.

const Q = (1n << 255n) - 19n;
const A = 486662n;
const Z = 2n;
const DSI = Buffer.from('CPace255');
const DSI_ISK = Buffer.from('CPace255_ISK');
const MAC_LABEL = Buffer.from('CPaceMac');
const PKCS8_X25519 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const SPKI_X25519 = Buffer.from('302a300506032b656e032100', 'hex');

function modPow(base, exp) {
  let result = 1n;
  let b = ((base % Q) + Q) % Q;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % Q;
    b = (b * b) % Q;
    e >>= 1n;
  }
  return result;
}

const mod = (x) => ((x % Q) + Q) % Q;
const INV2 = modPow(2n, Q - 2n);

function leb128(n) {
  const out = [];
  let len = n;
  for (;;) {
    let byte = len & 0x7f;
    len >>>= 7;
    if (len) byte |= 0x80;
    out.push(byte);
    if (!len) return Buffer.from(out);
  }
}

function lvCat(...parts) {
  return Buffer.concat(parts.flatMap((p) => [leb128(p.length), p]));
}

export function cpaceGeneratorString(prs, ci, sid) {
  const zpad = Math.max(0, 128 - 1 - (leb128(prs.length).length + prs.length) - (leb128(DSI.length).length + DSI.length));
  return lvCat(DSI, prs, Buffer.alloc(zpad), ci, sid);
}

function leToBigInt(buf) {
  return BigInt(`0x${Buffer.from(buf).reverse().toString('hex') || '0'}`);
}

function bigIntToLe(n) {
  return Buffer.from(n.toString(16).padStart(64, '0'), 'hex').reverse();
}

export function elligator2(r) {
  const rr = mod(r);
  const v = mod(-A * modPow(mod(1n + Z * rr * rr), Q - 2n));
  const eps = modPow(mod(v * v * v + A * v * v + v), (Q - 1n) / 2n);
  return bigIntToLe(mod(eps * v - mod(1n - eps) * A * INV2));
}

export function cpaceGenerator(prs, ci, sid) {
  const u = Buffer.from(sha512(cpaceGeneratorString(prs, ci, sid)).subarray(0, 32));
  u[31] &= 0x7f;
  return elligator2(leToBigInt(u));
}

function scalarMult(scalar, point) {
  try {
    return crypto.diffieHellman({
      privateKey: crypto.createPrivateKey({ key: Buffer.concat([PKCS8_X25519, scalar]), format: 'der', type: 'pkcs8' }),
      publicKey: crypto.createPublicKey({ key: Buffer.concat([SPKI_X25519, point]), format: 'der', type: 'spki' }),
    });
  } catch {
    // OpenSSL refuses an all-zero X25519 output, i.e. a low-order point.
    return null;
  }
}

export class CPace {
  #role;
  #sid;
  #ad;
  #scalar;
  #sides = null;
  #isk = null;
  #macKey = null;

  constructor({ role, prs, sid, ci = Buffer.alloc(0), ad = Buffer.alloc(0), scalar = crypto.randomBytes(32) }) {
    this.#role = role;
    this.#sid = sid;
    this.#ad = ad;
    this.#scalar = scalar;
    this.publicShare = scalarMult(scalar, cpaceGenerator(prs, ci, sid));
    if (!this.publicShare) throw new CPaceError('generator encodes a low-order point');
  }

  derive(peerShare, peerAd = Buffer.alloc(0)) {
    if (!this.#scalar) throw new CPaceError('derive() may only be called once');
    const scalar = this.#scalar;
    this.#scalar = null;
    if (peerShare.length !== 32) throw new CPaceError('peer share must be 32 bytes');
    const k = scalarMult(scalar, peerShare);
    if (!k) throw new CPaceError('peer share encodes a low-order point');
    const own = [this.publicShare, this.#ad];
    const peer = [peerShare, peerAd];
    this.#sides = this.#role === 'A' ? [own, peer] : [peer, own];
    this.#isk = sha512(lvCat(DSI_ISK, this.#sid, k), lvCat(...this.#sides[0]), lvCat(...this.#sides[1]));
    this.#macKey = sha512(MAC_LABEL, this.#sid, this.#isk);
  }

  get isk() {
    if (!this.#isk) throw new CPaceError('derive() must be called first');
    return this.#isk;
  }

  #mac(index) {
    return crypto.createHmac('sha512', this.#macKey).update(lvCat(...this.#sides[index])).digest();
  }

  tag() {
    if (!this.#isk) throw new CPaceError('derive() must be called first');
    return this.#mac(this.#role === 'A' ? 0 : 1);
  }

  verify(peerTag) {
    if (!this.#isk) throw new CPaceError('derive() must be called first');
    const [a, b] = this.#sides;
    if (sameBytes(a[0], b[0]) && sameBytes(a[1], b[1])) return false;
    return sameBytes(peerTag, this.#mac(this.#role === 'A' ? 1 : 0));
  }
}

// ---- client/hello descriptor and activation -------------------------------------------------

const LOCATIONS = new Set(['device', 'leaflet', 'operator']);
const OUT_CHANNELS = new Set(['display', 'speaker']);

const showValue = (x) => (typeof x === 'string' ? x.slice(0, 40) : `[${typeof x}]`);

export function parseSupportedPairMethods(value) {
  const methods = {};
  const ignored = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { methods, ignored };
  for (const [key, desc] of Object.entries(value)) {
    const d = desc && typeof desc === 'object' && !Array.isArray(desc) ? desc : {};
    const list = (v, allowed) => {
      if (!Array.isArray(v)) return [];
      for (const x of v) if (!allowed.has(x)) ignored.push(`${key.slice(0, 64)}:${showValue(x)}`);
      return [...new Set(v.filter((x) => allowed.has(x)))];
    };
    if (key === METHODS.PAIRING_PSK || key === METHODS.STATIC) {
      methods[key] = { locations: list(d.locations, LOCATIONS) };
    } else if (key === METHODS.DYNAMIC) {
      const formats = list(d.formats, new Set(Object.values(FORMATS)));
      const outChannels = list(d.out_channels, OUT_CHANNELS);
      if (formats.length && outChannels.length) methods[key] = { formats, outChannels };
      else ignored.push(key);
    } else {
      ignored.push(key.slice(0, 64));
    }
  }
  return { methods, ignored };
}

export function chooseCodeMethod(methods, { canScanQr = false } = {}) {
  const dyn = methods[METHODS.DYNAMIC];
  if (dyn) {
    if (canScanQr && dyn.formats.includes(FORMATS.QR_CODE)) return { method: METHODS.DYNAMIC, format: FORMATS.QR_CODE };
    if (dyn.formats.includes(FORMATS.DIGITS)) return { method: METHODS.DYNAMIC, format: FORMATS.DIGITS };
  }
  if (methods[METHODS.STATIC]) return { method: METHODS.STATIC };
  return null;
}

export function pairingActivation({ method, format, playback = false, activeRoles }) {
  const pairing = method === METHODS.DYNAMIC ? { method, format } : { method };
  const payload = { activities: playback ? ['playback', 'pairing'] : ['pairing'], pairing };
  payload.active_roles = activeRoles ?? [];
  return payload;
}

// ---- Cooldown between failed code rounds ----------------------------------------------------

export class Cooldown {
  constructor({ initialMs = COOLDOWN.initialMs, maxMs = COOLDOWN.maxMs, now = Date.now } = {}) {
    this.initialMs = initialMs;
    this.maxMs = maxMs;
    this.now = now;
    this.failures = 0;
    this.until = 0;
  }

  fail() {
    this.failures++;
    this.until = this.now() + Math.min(this.maxMs, this.initialMs * 2 ** (this.failures - 1));
    return this.until - this.now();
  }

  remainingMs() {
    return Math.max(0, this.until - this.now());
  }

  reset() {
    this.failures = 0;
    this.until = 0;
  }
}

// ---- Server-side attempt state machine ------------------------------------------------------

const msg = (type, payload = {}) => ({ type, payload });
const step = (send = [], event = null) => ({ send, event });

export function createPairingAttempt(opts) {
  return new PairingAttempt(opts);
}

export class PairingAttempt {
  #o;
  #random;
  #now;
  #cpace = null;
  #sid = null;
  #prs = null;
  #commitB = null;
  #nonceA = null;
  #pskWrapKey = null;
  #pendingCode = null;
  #pendingSeen = false;
  #initSeen = false;

  constructor({
    method, format = null, suite, handshakeHash, pairingIndex, clientId, pairingPsk = null,
    cooldown = new Cooldown(), random = crypto.randomBytes, now = Date.now,
  }) {
    if (!Object.values(METHODS).includes(method)) throw new TypeError(`unknown pairing method ${method}`);
    if (method === METHODS.DYNAMIC && !Object.values(FORMATS).includes(format)) throw new TypeError('dynamic pairing needs a format');
    if (method === METHODS.PAIRING_PSK && pairingPsk?.length !== 32) throw new TypeError('pairing_psk needs the matched pairing PSK');
    if (method !== METHODS.PAIRING_PSK && handshakeHash?.length !== 32) throw new TypeError('code pairing needs the handshake hash');
    this.#o = { method, format: method === METHODS.DYNAMIC ? format : null, suite, handshakeHash, pairingIndex, clientId, pairingPsk };
    this.cooldown = cooldown;
    this.#random = random;
    this.#now = now;
    this.state = 'awaiting_init';
    this.round = 0;
    this.pendingMessage = null;
    this.deadline = now() + TIMEOUTS.firstMessageMs;
    this.result = null;
  }

  get method() {
    return this.#o.method;
  }

  get format() {
    return this.#o.format;
  }

  get pairingIndex() {
    return this.#o.pairingIndex;
  }

  get active() {
    return !['paired', 'aborted'].includes(this.state);
  }

  activation({ playback = false, activeRoles } = {}) {
    return pairingActivation({ method: this.#o.method, format: this.#o.format, playback, activeRoles });
  }

  #end(reason, by, send = []) {
    this.state = 'aborted';
    this.deadline = null;
    this.#cpace = null;
    this.#pskWrapKey = null;
    this.result = { reason, by };
    return step(send, { kind: 'aborted', reason, by });
  }

  onMessage(type, payload) {
    if (!this.active || this.state === 'persisting') {
      if (this.state === 'persisting' && type !== 'pair/abort') throw new PairingProtocolError(`${type} while the record is being stored`);
      return step([], { kind: 'ignored' });
    }
    if (!PAIRING_MESSAGE_TYPES.has(type)) throw new TypeError(`${type} is not a pairing message`);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new PairingProtocolError(`${type} without a payload object`);
    if (type === 'pair/abort') return this.#onAbort(payload);
    if (!this.#initSeen) return this.#beforeInit(type, payload);
    switch (`${this.state} ${type}`) {
      case 'awaiting_auth client/pair-auth': return this.#onAuth(payload);
      case 'awaiting_confirm client/pair-confirm': return this.#onConfirm(payload);
      case 'awaiting_confirm client/pair-retry': return this.#onRetry();
      case 'awaiting_finalize client/pair-finalize': return this.#onFinalize(payload);
      default: throw new PairingProtocolError(`${type} out of sequence (${this.state})`);
    }
  }

  #onAbort(payload) {
    const reason = typeof payload.reason === 'string' ? payload.reason.slice(0, 64) : 'unknown';
    if (!this.#initSeen && this.#o.pairingIndex > 1 && LEFTOVER_ABORTS.has(reason)) return step([], { kind: 'ignored' });
    if (reason === ABORT_REASONS.PAIRING_CODE_MISMATCH && this.#o.method === METHODS.STATIC) this.cooldown.fail();
    return this.#end(reason, 'client');
  }

  #checkIndex(type, payload) {
    const idx = payload.pairing_index;
    if (!Number.isSafeInteger(idx)) throw new PairingProtocolError(`${type} without an integer pairing_index`);
    if (idx > this.#o.pairingIndex) throw new PairingProtocolError(`${type} pairing_index is ahead of the server's count`);
    return idx === this.#o.pairingIndex;
  }

  #beforeInit(type, payload) {
    if (type === 'client/pair-finalize' && this.#legacyFinalize(payload)) return this.#onFinalize(payload);
    if (type !== 'client/pair-init' && type !== 'client/pair-pending') {
      if (this.#pendingSeen) throw new PairingProtocolError(`${type} after client/pair-pending`);
      return step([], { kind: 'ignored' });
    }
    if (!this.#checkIndex(type, payload)) {
      if (this.#pendingSeen) throw new PairingProtocolError(`${type} pairing_index does not match the attempt`);
      return step([], { kind: 'ignored' });
    }
    return type === 'client/pair-pending' ? this.#onPending(payload) : this.#onInit(payload);
  }

  #onPending(payload) {
    if (this.#o.method === METHODS.PAIRING_PSK) throw new PairingProtocolError('client/pair-pending is not part of the Pairing PSK flow');
    if (this.#pendingSeen) throw new PairingProtocolError('second client/pair-pending');
    this.#pendingSeen = true;
    this.state = 'pending';
    this.pendingMessage = typeof payload.message === 'string' ? truncateUtf8(payload.message, PENDING_MESSAGE_MAX_BYTES) : null;
    this.deadline = this.#now() + TIMEOUTS.gestureMs;
    return step([], { kind: 'pending', message: this.pendingMessage });
  }

  // A pre-spec-pr-247 Pairing PSK client starts with client/pair-finalize and never sends
  // client/pair-init; only on the first pairing activation can such a frame not be a leftover.
  #legacyFinalize(payload) {
    return this.#o.method === METHODS.PAIRING_PSK && this.#o.pairingIndex === 1 && !this.#pendingSeen
      && payload.long_term_psk !== undefined && payload.wrapped_psk === undefined;
  }

  #onInit(payload) {
    this.#initSeen = true;
    this.deadline = this.#now() + TIMEOUTS.attemptMs;
    const { method } = this.#o;
    if (method === METHODS.DYNAMIC) {
      if (payload.commit_B === undefined) throw new PairingProtocolError('client/pair-init missing commit_B');
      this.#commitB = b64urlField(payload.commit_B, 'commit_B', 32);
      this.#nonceA = this.#random(32);
      this.round = 1;
      this.state = 'awaiting_code';
      return step([msg('server/pair-init', { nonce_A: this.#nonceA.toString('base64url') })], { kind: 'need_code', round: 1 });
    }
    if (payload.commit_B !== undefined) throw new PairingProtocolError(`client/pair-init carries commit_B for ${method}`);
    if (method === METHODS.PAIRING_PSK) {
      this.state = 'awaiting_finalize';
      return step([], { kind: 'started' });
    }
    this.round = 1;
    this.state = 'awaiting_code';
    if (this.#pendingCode) {
      const code = this.#pendingCode;
      this.#pendingCode = null;
      return this.#startPake(code);
    }
    return step([], { kind: 'need_code', round: 1 });
  }

  submitCode(input) {
    const { method, format } = this.#o;
    if (method === METHODS.PAIRING_PSK) throw new PairingInputError('not_ready', 'the Pairing PSK method takes no code');
    const waitingForInit = method === METHODS.STATIC && (this.state === 'awaiting_init' || this.state === 'pending');
    if (this.state !== 'awaiting_code' && !waitingForInit) throw new PairingInputError('not_ready', `no code expected (${this.state})`);
    const retryAfterMs = this.cooldown.remainingMs();
    if (retryAfterMs > 0) throw new PairingInputError('cooldown', 'wait before the next try', { retryAfterMs });
    let prs;
    if (method === METHODS.STATIC) prs = Buffer.from(parseDigitsCode(input, STATIC_DIGITS), 'ascii');
    else if (format === FORMATS.DIGITS) prs = Buffer.from(parseDigitsCode(input, DYNAMIC_DIGITS), 'ascii');
    else prs = decodeCodeToken(input);
    if (waitingForInit) {
      this.#pendingCode = prs;
      return step([], { kind: 'code_queued' });
    }
    return this.#startPake(prs);
  }

  #startPake(prs) {
    this.#prs = prs;
    this.#sid = pakeSid(this.#o.handshakeHash, this.#o.pairingIndex, this.round);
    this.#cpace = new CPace({ role: 'A', prs, sid: this.#sid, ad: AD_SERVER, scalar: this.#random(32) });
    this.state = 'awaiting_auth';
    return step([msg('server/pair-auth', { pake_msg_1: this.#cpace.publicShare.toString('base64url') })], { kind: 'code_sent', round: this.round });
  }

  #onAuth(payload) {
    const share = b64urlField(payload.pake_msg_2, 'pake_msg_2', 32);
    try {
      this.#cpace.derive(share, AD_CLIENT);
    } catch (err) {
      throw new PairingProtocolError(`malformed pake_msg_2: ${err.message}`);
    }
    this.state = 'awaiting_confirm';
    return step([msg('server/pair-confirm', { server_kc: this.#cpace.tag().toString('base64url') })]);
  }

  #onRetry() {
    if (this.#o.method !== METHODS.DYNAMIC) throw new PairingProtocolError('client/pair-retry outside the dynamic pairing code flow');
    this.#cpace = null;
    const retryAfterMs = this.cooldown.fail();
    if (this.round >= ROUND_LIMIT) {
      return this.#end(ABORT_REASONS.PAIRING_CODE_MISMATCH, 'server', [msg('pair/abort', { reason: ABORT_REASONS.PAIRING_CODE_MISMATCH })]);
    }
    this.round++;
    this.state = 'awaiting_code';
    return step([msg('server/pair-init', {})], { kind: 'wrong_code', round: this.round, retryAfterMs });
  }

  #onConfirm(payload) {
    const tag = b64urlField(payload.client_kc, 'client_kc', 64);
    const dynamic = this.#o.method === METHODS.DYNAMIC;
    if (!dynamic && payload.wrapped_nonce_B !== undefined) throw new PairingProtocolError('client/pair-confirm carries wrapped_nonce_B for static_pairing_code');
    if (!this.#cpace.verify(tag)) {
      this.cooldown.fail();
      return this.#end(ABORT_REASONS.PAIRING_CODE_MISMATCH, 'server', [msg('pair/abort', { reason: ABORT_REASONS.PAIRING_CODE_MISMATCH })]);
    }
    const { isk } = this.#cpace;
    if (dynamic) this.#checkBinding(payload, isk);
    this.#pskWrapKey = wrapKey('psk', this.#sid, isk);
    this.#cpace = null;
    this.state = 'awaiting_finalize';
    return step([], { kind: 'confirmed' });
  }

  #checkBinding(payload, isk) {
    if (payload.wrapped_nonce_B === undefined) throw new PairingProtocolError('client/pair-confirm missing wrapped_nonce_B');
    const wrapped = b64urlField(payload.wrapped_nonce_B, 'wrapped_nonce_B', 48);
    const nonceB = unwrap(this.#o.suite, wrapKey('nonce', this.#sid, isk), wrapped);
    if (!nonceB) throw new PairingProtocolError('malformed wrapped_nonce_B: AEAD failure');
    if (!sameBytes(commitNonce(nonceB), this.#commitB)) throw new PairingProtocolError('revealed nonce_B does not match commit_B');
    const derived = deriveCodePrs(this.#o.handshakeHash, this.#nonceA, nonceB, this.#o.format);
    if (!sameBytes(derived, this.#prs)) throw new PairingProtocolError('entered pairing code is not bound to this connection');
  }

  #onFinalize(payload) {
    const hasPlain = payload.long_term_psk !== undefined;
    const hasWrapped = payload.wrapped_psk !== undefined;
    if (hasPlain === hasWrapped) throw new PairingProtocolError('client/pair-finalize must carry exactly one of long_term_psk, wrapped_psk');
    let psk;
    if (this.#o.method === METHODS.PAIRING_PSK) {
      if (!hasPlain) throw new PairingProtocolError('client/pair-finalize is missing long_term_psk');
      psk = b64urlField(payload.long_term_psk, 'long_term_psk', 32);
    } else {
      if (!hasWrapped) throw new PairingProtocolError('client/pair-finalize is missing wrapped_psk');
      psk = unwrap(this.#o.suite, this.#pskWrapKey, b64urlField(payload.wrapped_psk, 'wrapped_psk', 48));
      if (!psk) throw new PairingProtocolError('malformed wrapped_psk: AEAD failure');
    }
    if (sameBytes(psk, SENTINEL_PSK) || (this.#o.pairingPsk && sameBytes(psk, this.#o.pairingPsk))) {
      throw new PairingProtocolError('client/pair-finalize reused the Sentinel or pairing PSK');
    }
    this.#initSeen = true;
    this.#pskWrapKey = null;
    this.state = 'persisting';
    this.deadline = null;
    const record = { clientId: this.#o.clientId, psk, pskId: pskId(psk), method: this.#o.method };
    return step([], { kind: 'persist', record });
  }

  persisted() {
    if (this.state !== 'persisting') throw new Error(`persisted() in state ${this.state}`);
    this.state = 'paired';
    this.cooldown.reset();
    this.result = { paired: true };
    return step([msg('server/pair-finalize', {})], { kind: 'paired' });
  }

  cancel() {
    if (!this.active || this.state === 'persisting') return null;
    return this.#end(ABORT_REASONS.USER_CANCELLED, 'server', [msg('pair/abort', { reason: ABORT_REASONS.USER_CANCELLED })]);
  }

  expire(nowMs = this.#now()) {
    if (!this.active || this.deadline === null || nowMs < this.deadline) return null;
    return this.#end('timeout', 'server');
  }
}

function truncateUtf8(text, maxBytes) {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  return new TextDecoder('utf-8', { fatal: false }).decode(buf.subarray(0, maxBytes)).replace(/�$/, '');
}
