import crypto from 'node:crypto';

const FRAME_PREFIX_BYTES = 13;
const AUDIO_TYPE = 4;
const ARTWORK_TYPES = new Set([8, 9, 10, 11]);
const ARTWORK_FLAG_CANCEL = 0x01;
const ARTWORK_FLAG_ANNOUNCE = 0x02;

const nowUs = () => Number(process.hrtime.bigint() / 1000n);
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function parseText(data) {
  try {
    const obj = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data));
    return { type: typeof obj?.type === 'string' ? obj.type : null, payload: obj?.payload ?? null };
  } catch {
    return { type: null, payload: null };
  }
}

// Records every message of every Sendspin connection as plaintext: outbound
// immediately before encryption, inbound right after decryption, and each
// outbound write once the socket has flushed it. Velvet has no trace hook, so
// this wraps CipherState and the ws WebSocket prototype from outside.
export function installTracer({ CipherState, WebSocket, Reassembler, decodeJson }) {
  const log = [];
  const sockets = new Map();
  let seq = 0;
  let pendingOut = null;
  let currentIn = null;

  const socket = (ws) => {
    let s = sockets.get(ws);
    if (!s) {
      s = { id: sockets.size + 1, clientId: null, rx: new Reassembler(), tx: new Reassembler() };
      sockets.set(ws, s);
    }
    return s;
  };

  const push = (entry) => {
    const e = { seq: ++seq, tUs: nowUs(), ...entry };
    log.push(e);
    return e;
  };

  const recordText = (ws, dir, data) => {
    const s = socket(ws);
    const { type, payload } = parseText(data);
    if (dir === 'in' && type === 'client/init' && typeof payload?.client_id === 'string') s.clientId = payload.client_id;
    return [push({ kind: 'msg', socket: s.id, dir, frame: 'text', msgType: null, type, payload })];
  };

  const recordBinary = (ws, dir, plaintext) => {
    const s = socket(ws);
    const out = [push({
      kind: 'frame', socket: s.id, dir, msgType: plaintext[0], byteCount: plaintext.length,
      leadingHex: plaintext.subarray(0, FRAME_PREFIX_BYTES).toString('hex'),
      data: plaintext[0] === 0 ? null : Buffer.from(plaintext),
    })];
    let msg;
    try {
      msg = (dir === 'in' ? s.rx : s.tx).push(plaintext);
    } catch (err) {
      out.push(push({ kind: 'error', socket: s.id, dir, detail: err.message }));
      return out;
    }
    if (msg && msg.type === 0) {
      let obj = { type: null, payload: null };
      try {
        obj = decodeJson(msg.payload);
      } catch (err) {
        obj.error = err.message;
      }
      out.push(push({ kind: 'msg', socket: s.id, dir, frame: 'binary', msgType: 0, type: obj.type, payload: obj.payload }));
    }
    return out;
  };

  const origEncrypt = CipherState.prototype.encrypt;
  CipherState.prototype.encrypt = function encrypt(plaintext, ad) {
    const ciphertext = origEncrypt.call(this, plaintext, ad);
    pendingOut = { plaintext: Buffer.from(plaintext), ciphertext };
    return ciphertext;
  };

  const origDecrypt = CipherState.prototype.decrypt;
  CipherState.prototype.decrypt = function decrypt(ciphertext, ad) {
    const plaintext = origDecrypt.call(this, ciphertext, ad);
    if (currentIn?.isBinary) recordBinary(currentIn.ws, 'in', plaintext);
    return plaintext;
  };

  const origEmit = WebSocket.prototype.emit;
  WebSocket.prototype.emit = function emit(event, ...rest) {
    if (event !== 'message') return origEmit.call(this, event, ...rest);
    const [data, isBinary] = rest;
    if (!isBinary) recordText(this, 'in', data);
    const prev = currentIn;
    currentIn = { ws: this, isBinary: Boolean(isBinary) };
    try {
      return origEmit.call(this, event, ...rest);
    } finally {
      currentIn = prev;
    }
  };

  const origSend = WebSocket.prototype.send;
  WebSocket.prototype.send = function send(data, options, cb) {
    let opts = options;
    let done = cb;
    if (typeof opts === 'function') {
      done = opts;
      opts = {};
    }
    let entries = null;
    if (pendingOut && data === pendingOut.ciphertext) {
      entries = recordBinary(this, 'out', pendingOut.plaintext);
      pendingOut = null;
    } else if (typeof data === 'string' || opts?.binary === false) {
      entries = recordText(this, 'out', data);
    }
    const id = socket(this).id;
    return origSend.call(this, data, opts, (err) => {
      if (!err && entries) {
        for (const e of entries) if (e.kind !== 'error') push({ kind: 'written', socket: id, ref: e.seq });
      }
      done?.(err);
    });
  };

  return {
    log,
    socketFor(clientId) {
      for (const s of sockets.values()) if (s.clientId === clientId) return s.id;
      return null;
    },
    uninstall() {
      CipherState.prototype.encrypt = origEncrypt;
      CipherState.prototype.decrypt = origDecrypt;
      WebSocket.prototype.emit = origEmit;
      WebSocket.prototype.send = origSend;
    },
  };
}

const playerFormat = (p) => ({ codec: p.codec, sample_rate: p.sample_rate, channels: p.channels, bit_depth: p.bit_depth });

// Everything the matrix judges, read back from one connection's trace.
export class ConnectionTrace {
  constructor(log, socketId) {
    this.entries = log.filter((e) => e.socket === socketId);
    this.bySeq = new Map(this.entries.map((e) => [e.seq, e]));
    this.messages = this.entries.filter((e) => e.kind === 'msg');
  }

  written(entry) {
    return this.entries.find((e) => e.kind === 'written' && e.ref === entry.seq) ?? null;
  }

  firstOut(type) {
    return this.messages.find((m) => m.dir === 'out' && m.type === type) ?? null;
  }

  wire(m) {
    return m ? { type: m.type, payload: m.payload } : null;
  }

  get clientHello() {
    return this.messages.find((m) => m.dir === 'in' && m.type === 'client/hello') ?? null;
  }

  get activation() {
    return this.wire(this.firstOut('server/activate'));
  }

  get groupUpdates() {
    const first = this.firstOut('server/activate');
    if (!first) return [];
    return this.messages.filter((m) => m.dir === 'out' && m.type === 'group/update' && m.seq > first.seq).map((m) => this.wire(m));
  }

  get availabilityTrace() {
    const out = [];
    for (const e of this.entries) {
      if (e.kind === 'msg' && e.dir === 'in' && e.type === 'client/state') {
        out.push({ type: 'client/state', available: typeof e.payload?.available === 'boolean' ? e.payload.available : null });
      } else if (e.kind === 'msg' && e.dir === 'out' && e.type === 'stream/start') {
        out.push({ type: 'stream/start', phase: 'sending', roles: streamRoles(e.payload) });
      } else if (e.kind === 'written') {
        const ref = this.bySeq.get(e.ref);
        if (ref?.kind === 'msg' && ref.type === 'stream/start') out.push({ type: 'stream/start', phase: 'sent', roles: streamRoles(ref.payload) });
      }
    }
    return out;
  }

  get timeExchange() {
    const out = [];
    for (const e of this.entries) {
      if (e.kind === 'msg' && e.dir === 'in' && e.type === 'client/time') {
        out.push({ type: 'client/time', payload: e.payload });
      } else if (e.kind === 'msg' && e.dir === 'out' && e.type !== 'server/time') {
        if (out.length && out.at(-1).type !== 'other-sent') out.push({ type: 'other-sent' });
      } else if (e.kind === 'written') {
        const ref = this.bySeq.get(e.ref);
        if (ref?.kind === 'msg' && ref.type === 'server/time') out.push({ type: 'server/time', payload: ref.payload });
      }
    }
    return out;
  }

  get playerStreamStarts() {
    return this.messages.filter((m) => m.dir === 'out' && m.type === 'stream/start' && m.payload?.player);
  }

  get stream() {
    const last = this.playerStreamStarts.at(-1);
    if (!last) return null;
    const p = last.payload.player;
    const s = { ...playerFormat(p), codec_header: p.codec_header ?? null };
    if (p.codec_header) s.codec_header_sha256 = sha256(Buffer.from(p.codec_header, 'base64'));
    return s;
  }

  get lastFormatPreference() {
    let f = null;
    for (const m of this.messages) {
      if (m.dir === 'in' && m.type === 'client/state' && m.payload?.player?.format) f = playerFormat(m.payload.player.format);
    }
    return f;
  }

  outFrames(type = null) {
    return this.entries.filter((e) => e.kind === 'frame' && e.dir === 'out' && e.msgType !== 0 && (type === null || e.msgType === type));
  }

  get writtenAudio() {
    return this.outFrames(AUDIO_TYPE).filter((f) => this.written(f));
  }

  sentAudio() {
    const chunks = this.writtenAudio;
    const h = crypto.createHash('sha256');
    let bytes = 0;
    for (const c of chunks) {
      const audio = c.data.subarray(FRAME_PREFIX_BYTES);
      h.update(audio);
      bytes += audio.length;
    }
    return { count: chunks.length, bytes, sha256: chunks.length ? h.digest('hex') : null };
  }

  chunkTimestamps() {
    return this.outFrames(AUDIO_TYPE).map((f) => Number(f.data.readBigInt64BE(1)));
  }

  chunkFrames(payloadSizes) {
    const first = this.playerStreamStarts[0];
    if (!first) return [];
    return this.outFrames().filter((f) => f.seq > first.seq).map((f) => {
      let size = null;
      if (f.msgType === AUDIO_TYPE && f.byteCount >= FRAME_PREFIX_BYTES) size = payloadSizes.get(f.data.readBigInt64BE(1)) ?? null;
      return { byte_count: f.byteCount, leading_hex: f.leadingHex, payload_byte_count: size };
    });
  }

  lastControllerState() {
    let c = null;
    for (const m of this.messages) if (m.dir === 'out' && m.type === 'server/state' && m.payload?.controller) c = m.payload.controller;
    return c;
  }

  firstMetadataStateSent() {
    for (const m of this.messages) {
      const md = m.dir === 'out' && m.type === 'server/state' ? m.payload?.metadata : null;
      if (md && Number.isSafeInteger(md.timestamp)) {
        const w = this.written(m);
        return w ? { timestamp_us: md.timestamp, bound_us: w.tUs } : null;
      }
    }
    return null;
  }

  // Images as the client reassembles them: announce, then parts up to total_size.
  artworkImages(channel) {
    const images = [];
    let cur = null;
    for (const f of this.outFrames(8 + channel)) {
      if (!ARTWORK_TYPES.has(f.msgType)) continue;
      const flags = f.data[1];
      if (flags & ARTWORK_FLAG_CANCEL) {
        cur = null;
      } else if (flags & ARTWORK_FLAG_ANNOUNCE) {
        cur = { timestampUs: Number(f.data.readBigInt64BE(2)), total: f.data.readUInt32BE(10), parts: [], received: 0 };
        if (cur.total === 0) {
          images.push({ ...cur, image: Buffer.alloc(0) });
          cur = null;
        }
      } else if (cur) {
        cur.parts.push(f.data.subarray(2));
        cur.received += f.data.length - 2;
        if (cur.received >= cur.total) {
          images.push({ timestampUs: cur.timestampUs, total: cur.total, image: Buffer.concat(cur.parts), written: Boolean(this.written(f)) });
          cur = null;
        }
      }
    }
    return images;
  }
}

function streamRoles(payload) {
  return Object.keys(payload ?? {}).filter((k) => k !== 'server_transmitted');
}

export { sha256, nowUs };
