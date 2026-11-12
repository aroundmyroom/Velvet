import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { generateStaticKeyPair, publicKeyFromPrivate } from './noise.js';

export const KEY_ID_LENGTH = 43;
export const PSK_ID_LABEL = Buffer.from('sendspin-psk-id-v1', 'utf8');
export const SENTINEL_PSK = crypto.createHash('sha256').update('sendspin-sentinel-psk-v1', 'utf8').digest();
export const PSK_CATEGORY = Object.freeze({ LONG_TERM: 'lt', PAIRING: 'pr', SENTINEL: 'sn' });
export const SERVER_KEY_FILE = 'server-key.json';

const KEY_ID_RE = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

export function encodeKeyId(publicKey) {
  if (!Buffer.isBuffer(publicKey) || publicKey.length !== 32) throw new TypeError('public key must be a 32-byte Buffer');
  return publicKey.toString('base64url');
}

export function decodeKeyId(id) {
  if (typeof id !== 'string' || !KEY_ID_RE.test(id)) throw new TypeError('invalid key id: expected 43 base64url characters');
  return Buffer.from(id, 'base64url');
}

export function isKeyId(id) {
  return typeof id === 'string' && KEY_ID_RE.test(id);
}

export function pskId(psk) {
  if (!Buffer.isBuffer(psk) || psk.length !== 32) throw new TypeError('PSK must be a 32-byte Buffer');
  return crypto.createHash('sha256').update(PSK_ID_LABEL).update(psk).digest('base64url');
}

export const SENTINEL_PSK_ID = pskId(SENTINEL_PSK);

export function generatePsk() {
  return crypto.randomBytes(32);
}

export async function loadOrCreateServerKey(dir) {
  const file = path.join(dir, SERVER_KEY_FILE);
  let raw = null;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (raw !== null) {
    const data = JSON.parse(raw);
    const privateKey = decodeKeyId(data.privateKey);
    const publicKey = publicKeyFromPrivate(privateKey);
    if (data.publicKey !== encodeKeyId(publicKey)) throw new Error(`${file}: public key does not match private key`);
    return { publicKey, privateKey, serverId: encodeKeyId(publicKey) };
  }
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const pair = generateStaticKeyPair();
  const body = JSON.stringify({ privateKey: encodeKeyId(pair.privateKey), publicKey: encodeKeyId(pair.publicKey) }, null, 2) + '\n';
  const tmp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  await fsp.writeFile(tmp, body, { mode: 0o600, flag: 'wx' });
  try {
    await fsp.link(tmp, file);
  } catch (err) {
    await fsp.unlink(tmp);
    if (err.code === 'EEXIST') return loadOrCreateServerKey(dir);
    throw err;
  }
  await fsp.unlink(tmp);
  return { ...pair, serverId: encodeKeyId(pair.publicKey) };
}
