import crypto from 'node:crypto';

export const SUITES = ['25519_ChaChaPoly_SHA256', '25519_AESGCM_SHA256'];
export const MAX_NOISE_MESSAGE = 65535;
export const TAG_LEN = 16;
export const PSK_CATEGORIES = ['lt', 'pr', 'sn'];

const DH_LEN = 32;
const HASH_LEN = 32;
const PKCS8_X25519 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const SPKI_X25519 = Buffer.from('302a300506032b656e032100', 'hex');
const EMPTY = Buffer.alloc(0);
const NONCE_LIMIT = 2 ** 53;

export class NoiseError extends Error {}

function privateKeyObject(raw) {
  return crypto.createPrivateKey({ key: Buffer.concat([PKCS8_X25519, raw]), format: 'der', type: 'pkcs8' });
}

function publicKeyObject(raw) {
  return crypto.createPublicKey({ key: Buffer.concat([SPKI_X25519, raw]), format: 'der', type: 'spki' });
}

function checkKey(name, key) {
  if (!Buffer.isBuffer(key) || key.length !== DH_LEN) throw new NoiseError(`${name} must be a 32-byte Buffer`);
}

export function publicKeyFromPrivate(privateKey) {
  checkKey('privateKey', privateKey);
  const jwk = crypto.createPublicKey(privateKeyObject(privateKey)).export({ format: 'jwk' });
  return Buffer.from(jwk.x, 'base64url');
}

export function generateStaticKeyPair() {
  const { privateKey } = crypto.generateKeyPairSync('x25519');
  const jwk = privateKey.export({ format: 'jwk' });
  return { publicKey: Buffer.from(jwk.x, 'base64url'), privateKey: Buffer.from(jwk.d, 'base64url') };
}

function dh(privateKey, publicKey) {
  try {
    return crypto.diffieHellman({ privateKey: privateKeyObject(privateKey), publicKey: publicKeyObject(publicKey) });
  } catch (err) {
    throw new NoiseError(`X25519 failed: ${err.message}`);
  }
}

function hash(...parts) {
  const h = crypto.createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
}

function hmac(key, ...parts) {
  const h = crypto.createHmac('sha256', key);
  for (const p of parts) h.update(p);
  return h.digest();
}

function hkdf(chainingKey, ikm, count) {
  const tempKey = hmac(chainingKey, ikm);
  const out1 = hmac(tempKey, Buffer.from([1]));
  const out2 = hmac(tempKey, out1, Buffer.from([2]));
  if (count === 2) return [out1, out2];
  return [out1, out2, hmac(tempKey, out2, Buffer.from([3]))];
}

function nonceBytes(suite, n) {
  const iv = Buffer.alloc(12);
  const lo = n % 0x100000000;
  const hi = Math.floor(n / 0x100000000);
  if (suite === '25519_AESGCM_SHA256') {
    iv.writeUInt32BE(hi, 4);
    iv.writeUInt32BE(lo, 8);
  } else {
    iv.writeUInt32LE(lo, 4);
    iv.writeUInt32LE(hi, 8);
  }
  return iv;
}

function algorithm(suite) {
  return suite === '25519_AESGCM_SHA256' ? 'aes-256-gcm' : 'chacha20-poly1305';
}

export class CipherState {
  #suite;
  #key = null;
  #n = 0;

  constructor(suite, key = null) {
    this.#suite = suite;
    if (key) this.#key = Buffer.from(key);
  }

  get hasKey() {
    return this.#key !== null;
  }

  get nonce() {
    return this.#n;
  }

  encrypt(plaintext, ad = EMPTY) {
    if (!this.#key) return Buffer.from(plaintext);
    if (plaintext.length + TAG_LEN > MAX_NOISE_MESSAGE) throw new NoiseError('Noise message exceeds 65535 bytes');
    if (this.#n >= NONCE_LIMIT) throw new NoiseError('nonce exhausted');
    const cipher = crypto.createCipheriv(algorithm(this.#suite), this.#key, nonceBytes(this.#suite, this.#n), { authTagLength: TAG_LEN });
    cipher.setAAD(ad, { plaintextLength: plaintext.length });
    const out = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
    this.#n++;
    return out;
  }

  decrypt(ciphertext, ad = EMPTY) {
    if (!this.#key) return Buffer.from(ciphertext);
    if (ciphertext.length < TAG_LEN) throw new NoiseError('ciphertext shorter than the AEAD tag');
    if (ciphertext.length > MAX_NOISE_MESSAGE) throw new NoiseError('Noise message exceeds 65535 bytes');
    if (this.#n >= NONCE_LIMIT) throw new NoiseError('nonce exhausted');
    const body = ciphertext.subarray(0, ciphertext.length - TAG_LEN);
    const decipher = crypto.createDecipheriv(algorithm(this.#suite), this.#key, nonceBytes(this.#suite, this.#n), { authTagLength: TAG_LEN });
    decipher.setAAD(ad, { plaintextLength: body.length });
    decipher.setAuthTag(ciphertext.subarray(ciphertext.length - TAG_LEN));
    let out;
    try {
      out = Buffer.concat([decipher.update(body), decipher.final()]);
    } catch {
      throw new NoiseError('Noise message failed authentication');
    }
    this.#n++;
    return out;
  }
}

class SymmetricState {
  constructor(suite, protocolName) {
    this.suite = suite;
    const name = Buffer.from(protocolName, 'ascii');
    this.h = name.length <= HASH_LEN ? Buffer.concat([name, Buffer.alloc(HASH_LEN - name.length)]) : hash(name);
    this.ck = this.h;
    this.cipher = new CipherState(suite);
  }

  clone() {
    const copy = Object.create(SymmetricState.prototype);
    copy.suite = this.suite;
    copy.h = this.h;
    copy.ck = this.ck;
    copy.cipher = this.cipher;
    return copy;
  }

  mixHash(data) {
    this.h = hash(this.h, data);
  }

  mixKey(ikm) {
    const [ck, k] = hkdf(this.ck, ikm, 2);
    this.ck = ck;
    this.cipher = new CipherState(this.suite, k);
  }

  mixKeyAndHash(ikm) {
    const [ck, h, k] = hkdf(this.ck, ikm, 3);
    this.ck = ck;
    this.mixHash(h);
    this.cipher = new CipherState(this.suite, k);
  }

  encryptAndHash(plaintext) {
    const ct = this.cipher.encrypt(plaintext, this.h);
    this.mixHash(ct);
    return ct;
  }

  decryptAndHash(ciphertext) {
    const pt = this.cipher.decrypt(ciphertext, this.h);
    this.mixHash(ciphertext);
    return pt;
  }

  split() {
    const [k1, k2] = hkdf(this.ck, EMPTY, 2);
    return [new CipherState(this.suite, k1), new CipherState(this.suite, k2)];
  }
}

function checkCommon({ suite, staticKeyPair, remoteStaticPublicKey, prologue, ephemeralKeyPair }) {
  if (!SUITES.includes(suite)) throw new NoiseError(`unsupported suite ${suite}`);
  checkKey('staticKeyPair.privateKey', staticKeyPair?.privateKey);
  checkKey('staticKeyPair.publicKey', staticKeyPair.publicKey);
  checkKey('remoteStaticPublicKey', remoteStaticPublicKey);
  if (!Buffer.isBuffer(prologue)) throw new NoiseError('prologue must be a Buffer');
  if (ephemeralKeyPair) {
    checkKey('ephemeralKeyPair.privateKey', ephemeralKeyPair.privateKey);
    checkKey('ephemeralKeyPair.publicKey', ephemeralKeyPair.publicKey);
  }
}

function initSymmetric(suite, prologue, initiatorStatic, responderStatic) {
  const ss = new SymmetricState(suite, `Noise_KKpsk2_${suite}`);
  ss.mixHash(prologue);
  ss.mixHash(initiatorStatic);
  ss.mixHash(responderStatic);
  return ss;
}

function checkPsk(psk) {
  if (!Buffer.isBuffer(psk) || psk.length !== 32) throw new NoiseError('PSK must be a 32-byte Buffer');
}

export class NoiseInitiator {
  #s;
  #rs;
  #e;
  #psk;
  #ss;
  #afterMsg1 = null;
  #done = false;

  constructor(opts) {
    checkCommon(opts);
    checkPsk(opts.psk);
    this.suite = opts.suite;
    this.#s = opts.staticKeyPair;
    this.#rs = opts.remoteStaticPublicKey;
    this.#e = opts.ephemeralKeyPair ?? generateStaticKeyPair();
    this.#psk = opts.psk;
    this.#ss = initSymmetric(opts.suite, opts.prologue, this.#s.publicKey, this.#rs);
  }

  writeMessage1(payload) {
    if (this.#afterMsg1) throw new NoiseError('message 1 already written');
    const ss = this.#ss;
    ss.mixHash(this.#e.publicKey);
    ss.mixKey(this.#e.publicKey);
    ss.mixKey(dh(this.#e.privateKey, this.#rs));
    ss.mixKey(dh(this.#s.privateKey, this.#rs));
    const out = Buffer.concat([this.#e.publicKey, ss.encryptAndHash(payload)]);
    this.#afterMsg1 = ss.clone();
    return out;
  }

  // In KKpsk2 the PSK enters only at message 2, so a failed read can be retried
  // under another PSK (the Sentinel fallback) from the state saved after message 1.
  readMessage2(message, psk = this.#psk) {
    if (!this.#afterMsg1 || this.#done) throw new NoiseError('not awaiting message 2');
    checkPsk(psk);
    if (message.length < DH_LEN + TAG_LEN) throw new NoiseError('Noise message 2 too short');
    if (message.length > MAX_NOISE_MESSAGE) throw new NoiseError('Noise message exceeds 65535 bytes');
    const ss = this.#afterMsg1.clone();
    const re = Buffer.from(message.subarray(0, DH_LEN));
    ss.mixHash(re);
    ss.mixKey(re);
    ss.mixKey(dh(this.#e.privateKey, re));
    ss.mixKey(dh(this.#s.privateKey, re));
    ss.mixKeyAndHash(psk);
    const payload = ss.decryptAndHash(message.subarray(DH_LEN));
    this.#ss = ss;
    this.#psk = psk;
    this.#afterMsg1 = null;
    this.#e = null;
    this.#done = true;
    return payload;
  }

  get psk() {
    return this.#psk;
  }

  get handshakeComplete() {
    return this.#done;
  }

  get handshakeHash() {
    if (!this.#done) throw new NoiseError('handshake not complete');
    return this.#ss.h;
  }

  split() {
    if (!this.#done) throw new NoiseError('handshake not complete');
    const [c1, c2] = this.#ss.split();
    return { send: c1, recv: c2 };
  }
}

export class NoiseResponder {
  #s;
  #rs;
  #e;
  #re = null;
  #ss;
  #done = false;

  constructor(opts) {
    checkCommon(opts);
    this.suite = opts.suite;
    this.#s = opts.staticKeyPair;
    this.#rs = opts.remoteStaticPublicKey;
    this.#e = opts.ephemeralKeyPair ?? generateStaticKeyPair();
    this.#ss = initSymmetric(opts.suite, opts.prologue, this.#rs, this.#s.publicKey);
  }

  readMessage1(message) {
    if (this.#re) throw new NoiseError('message 1 already read');
    if (message.length < DH_LEN + TAG_LEN) throw new NoiseError('Noise message 1 too short');
    if (message.length > MAX_NOISE_MESSAGE) throw new NoiseError('Noise message exceeds 65535 bytes');
    const ss = this.#ss;
    const re = Buffer.from(message.subarray(0, DH_LEN));
    ss.mixHash(re);
    ss.mixKey(re);
    ss.mixKey(dh(this.#s.privateKey, re));
    ss.mixKey(dh(this.#s.privateKey, this.#rs));
    const payload = ss.decryptAndHash(message.subarray(DH_LEN));
    this.#re = re;
    return payload;
  }

  writeMessage2(payload, psk) {
    if (!this.#re || this.#done) throw new NoiseError('not ready to write message 2');
    checkPsk(psk);
    const ss = this.#ss;
    ss.mixHash(this.#e.publicKey);
    ss.mixKey(this.#e.publicKey);
    ss.mixKey(dh(this.#e.privateKey, this.#re));
    ss.mixKey(dh(this.#e.privateKey, this.#rs));
    ss.mixKeyAndHash(psk);
    const out = Buffer.concat([this.#e.publicKey, ss.encryptAndHash(payload)]);
    this.#e = null;
    this.#done = true;
    return out;
  }

  get handshakeComplete() {
    return this.#done;
  }

  get handshakeHash() {
    if (!this.#done) throw new NoiseError('handshake not complete');
    return this.#ss.h;
  }

  split() {
    if (!this.#done) throw new NoiseError('handshake not complete');
    const [c1, c2] = this.#ss.split();
    return { send: c2, recv: c1 };
  }
}

export const MSG2_PAYLOAD = Buffer.from('{}');

export function encodeMsg1Payload(pskId, pskCategory) {
  if (!PSK_CATEGORIES.includes(pskCategory)) throw new NoiseError(`invalid psk_category ${pskCategory}`);
  return Buffer.from(JSON.stringify({ psk_id: pskId, psk_category: pskCategory }), 'utf8');
}

function parseJsonObject(buf, what) {
  let obj;
  try {
    obj = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buf));
  } catch {
    throw new NoiseError(`malformed ${what}`);
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) throw new NoiseError(`malformed ${what}`);
  return obj;
}

export function parseMsg1Payload(buf) {
  const obj = parseJsonObject(buf, 'Noise message 1 payload');
  if (typeof obj.psk_id !== 'string' || obj.psk_id.length !== 43 || !PSK_CATEGORIES.includes(obj.psk_category)) {
    throw new NoiseError('malformed Noise message 1 payload');
  }
  return { pskId: obj.psk_id, pskCategory: obj.psk_category };
}

export function parseMsg2Payload(buf) {
  parseJsonObject(buf, 'Noise message 2 payload');
  return { canonical: buf.equals(MSG2_PAYLOAD) };
}

export function packHandshake(noiseMessage) {
  return JSON.stringify({ payload: { data: noiseMessage.toString('base64url') }, type: 'noise/handshake' });
}

export function unpackHandshake(text) {
  const obj = parseJsonObject(Buffer.from(text, 'utf8'), 'noise/handshake');
  const data = obj.payload?.data;
  if (obj.type !== 'noise/handshake' || typeof data !== 'string' || !/^[A-Za-z0-9_-]*={0,2}$/.test(data)) {
    throw new NoiseError('malformed noise/handshake');
  }
  return Buffer.from(data, 'base64url');
}
