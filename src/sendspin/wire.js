export const MSG = Object.freeze({
  JSON: 0,
  FRAGMENT: 1,
  AUDIO: 4,
  ARTWORK0: 8,
  ARTWORK1: 9,
  ARTWORK2: 10,
  ARTWORK3: 11,
  SOURCE_AUDIO: 12,
  VIS_LOUDNESS: 16,
  VIS_BEAT: 17,
  VIS_F_PEAK: 18,
  VIS_SPECTRUM: 19,
  VIS_PEAK: 20,
});

export const MAX_PLAINTEXT = 65535 - 16;
export const MAX_PAYLOAD = MAX_PLAINTEXT - 1;
export const DEFAULT_MAX_MESSAGE = 64 * 1024 * 1024;
export const FRAGMENT_FLAG_LAST = 0x01;
export const FRAGMENT_FLAG_FIRST = 0x02;
export const AUDIO_HEADER_LEN = 13;
export const SEND_AHEAD_MAX = 0xffffffffn;

const FRAGMENT_FLAGS_RESERVED = 0xfc;
const TRANSPORT_TYPES = new Set([1, 2, 3]);
const ARTWORK_FLAG_CANCEL = 0x01;
const ARTWORK_FLAG_ANNOUNCE = 0x02;

export class WireError extends Error {}

export function frame(type, payload) {
  return Buffer.concat([Buffer.from([type]), payload]);
}

export function fragment(plaintext) {
  if (plaintext.length === 0) throw new WireError('empty plaintext');
  if (plaintext.length <= MAX_PLAINTEXT) return [plaintext];
  const origType = plaintext[0];
  if (TRANSPORT_TYPES.has(origType)) throw new WireError(`type ${origType} is reserved for the transport`);
  const firstCap = MAX_PLAINTEXT - 3;
  const contCap = MAX_PLAINTEXT - 2;
  const frames = [];
  let off = 1;
  let first = true;
  while (off < plaintext.length) {
    const cap = first ? firstCap : contCap;
    const end = Math.min(off + cap, plaintext.length);
    const flags = end === plaintext.length ? FRAGMENT_FLAG_LAST : 0;
    const header = first
      ? Buffer.from([MSG.FRAGMENT, flags | FRAGMENT_FLAG_FIRST, origType])
      : Buffer.from([MSG.FRAGMENT, flags]);
    frames.push(Buffer.concat([header, plaintext.subarray(off, end)]));
    off = end;
    first = false;
  }
  return frames;
}

export function encodeJson(obj) {
  return fragment(frame(MSG.JSON, Buffer.from(JSON.stringify(obj), 'utf8')));
}

export function encodeAudioChunk(timestampUs, sendAheadUs, audioFrame) {
  return encodeTimed(MSG.AUDIO, timestampUs, audioFrame, BigInt(sendAheadUs));
}

function encodeTimed(type, timestampUs, data, sendAhead = null) {
  const headerLen = sendAhead === null ? 9 : AUDIO_HEADER_LEN;
  const buf = Buffer.allocUnsafe(headerLen + data.length);
  buf[0] = type;
  buf.writeBigInt64BE(BigInt(timestampUs), 1);
  if (sendAhead !== null) {
    let sa = sendAhead;
    if (sa < 0n) sa = 0n;
    else if (sa > SEND_AHEAD_MAX) sa = SEND_AHEAD_MAX;
    buf.writeUInt32BE(Number(sa), 9);
  }
  if (data.length) buf.set(data, headerLen);
  return buf;
}

export function decodeAudioChunk(plaintext) {
  if (plaintext.length < AUDIO_HEADER_LEN || plaintext[0] !== MSG.AUDIO) throw new WireError('malformed audio chunk');
  return {
    timestampUs: plaintext.readBigInt64BE(1),
    sendAheadUs: plaintext.readUInt32BE(9),
    frame: plaintext.subarray(AUDIO_HEADER_LEN),
  };
}

export function decodeSourceAudio(plaintext) {
  if (plaintext.length < 9 || plaintext[0] !== MSG.SOURCE_AUDIO) throw new WireError('malformed source audio chunk');
  return { timestampUs: plaintext.readBigInt64BE(1), frame: plaintext.subarray(9) };
}

function artworkType(channel) {
  if (!Number.isInteger(channel) || channel < 0 || channel > 3) throw new WireError(`invalid artwork channel ${channel}`);
  return MSG.ARTWORK0 + channel;
}

export function encodeArtworkAnnounce(channel, timestampUs, totalSize) {
  if (!Number.isInteger(totalSize) || totalSize < 0 || totalSize > 0xffffffff) throw new WireError('invalid artwork total_size');
  const buf = Buffer.alloc(14);
  buf[0] = artworkType(channel);
  buf[1] = ARTWORK_FLAG_ANNOUNCE;
  buf.writeBigInt64BE(BigInt(timestampUs), 2);
  buf.writeUInt32BE(totalSize, 10);
  return buf;
}

export function encodeArtworkPart(channel, data) {
  if (data.length + 2 > MAX_PLAINTEXT) throw new WireError('artwork part exceeds one Noise message');
  return Buffer.concat([Buffer.from([artworkType(channel), 0]), data]);
}

export function encodeArtworkParts(channel, image, partSize = MAX_PLAINTEXT - 2) {
  if (partSize < 1 || partSize > MAX_PLAINTEXT - 2) throw new WireError('invalid artwork part size');
  const parts = [];
  for (let off = 0; off < image.length; off += partSize) {
    parts.push(encodeArtworkPart(channel, image.subarray(off, off + partSize)));
  }
  return parts;
}

export function encodeArtworkCancel(channel) {
  return Buffer.from([artworkType(channel), ARTWORK_FLAG_CANCEL]);
}

function uint16(v) {
  if (!Number.isInteger(v) || v < 0 || v > 0xffff) throw new WireError(`uint16 out of range: ${v}`);
  return v;
}

function uint8(v) {
  if (!Number.isInteger(v) || v < 0 || v > 0xff) throw new WireError(`uint8 out of range: ${v}`);
  return v;
}

export function encodeVisLoudness(timestampUs, loudness) {
  const d = Buffer.alloc(2);
  d.writeUInt16BE(uint16(loudness));
  return encodeTimed(MSG.VIS_LOUDNESS, timestampUs, d);
}

export function encodeVisBeat(timestampUs, downbeat = false) {
  return encodeTimed(MSG.VIS_BEAT, timestampUs, Buffer.from([downbeat ? 1 : 0]));
}

export function encodeVisFPeak(timestampUs, freqHz, amp) {
  if (freqHz === 0 && amp !== 0) throw new WireError('f_peak amp must be 0 when freq is 0');
  const d = Buffer.alloc(4);
  d.writeUInt16BE(uint16(freqHz), 0);
  d.writeUInt16BE(uint16(amp), 2);
  return encodeTimed(MSG.VIS_F_PEAK, timestampUs, d);
}

export function encodeVisSpectrum(timestampUs, bins) {
  const d = Buffer.alloc(bins.length * 2);
  bins.forEach((v, i) => d.writeUInt16BE(uint16(v), i * 2));
  return encodeTimed(MSG.VIS_SPECTRUM, timestampUs, d);
}

export function encodeVisPeak(timestampUs, strength) {
  return encodeTimed(MSG.VIS_PEAK, timestampUs, Buffer.from([uint8(strength)]));
}

export class Reassembler {
  #maxBytes;
  #type = null;
  #chunks = [];
  #size = 0;

  constructor({ maxBytes = DEFAULT_MAX_MESSAGE } = {}) {
    this.#maxBytes = maxBytes;
  }

  get inFlight() {
    return this.#type !== null;
  }

  push(plaintext) {
    if (plaintext.length === 0) return this.#fail('empty plaintext');
    if (plaintext[0] === MSG.FRAGMENT) return this.#onFragment(plaintext);
    if (this.#type !== null) return this.#fail('non-fragment message while a fragmented message is in flight');
    return { type: plaintext[0], payload: plaintext.subarray(1) };
  }

  #onFragment(plaintext) {
    if (plaintext.length < 2) return this.#fail('fragment missing flags byte');
    const flags = plaintext[1];
    if (flags & FRAGMENT_FLAGS_RESERVED) return this.#fail('fragment sets reserved flag bits');
    const data = flags & FRAGMENT_FLAG_FIRST ? this.#start(plaintext) : this.#continue(plaintext);
    if (this.#size + data.length > this.#maxBytes) return this.#fail('fragmented message exceeds reassembly limit');
    this.#chunks.push(data);
    this.#size += data.length;
    if (!(flags & FRAGMENT_FLAG_LAST)) return null;
    const out = { type: this.#type, payload: Buffer.concat(this.#chunks, this.#size) };
    this.#reset();
    return out;
  }

  #start(plaintext) {
    if (this.#type !== null) this.#fail('first fragment while a fragmented message is in flight');
    if (plaintext.length < 3) this.#fail('first fragment missing orig_type');
    if (plaintext[2] === MSG.FRAGMENT) this.#fail('fragment orig_type is 1');
    this.#type = plaintext[2];
    return plaintext.subarray(3);
  }

  #continue(plaintext) {
    if (this.#type === null) this.#fail('continuation fragment with none in flight');
    return plaintext.subarray(2);
  }

  #reset() {
    this.#type = null;
    this.#chunks = [];
    this.#size = 0;
  }

  #fail(msg) {
    this.#reset();
    throw new WireError(msg);
  }
}

export function decodeJson(payload) {
  let obj;
  try {
    obj = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload));
  } catch {
    throw new WireError('JSON message is not valid UTF-8 JSON');
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj) || typeof obj.type !== 'string'
    || obj.payload === null || typeof obj.payload !== 'object' || Array.isArray(obj.payload)) {
    throw new WireError('JSON message lacks a type string and payload object');
  }
  return obj;
}
