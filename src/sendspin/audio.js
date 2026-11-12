import { spawn } from 'node:child_process';
import path from 'node:path';
import { ffmpegBin, ffprobeBin } from '../util/ffmpeg-bootstrap.js';

export const MASTER_BYTES_PER_SAMPLE = 4;
export const MIN_CHUNK_MS = 15;
export const MAX_CHUNK_MS = 150;
export const DEFAULT_CHUNK_MS = { pcm: 25, flac: 50, opus: 20 };
export const OPUS_SAMPLE_RATES = Object.freeze([8000, 12000, 16000, 24000, 48000]);
export const OPUS_FRAME_MS = Object.freeze([20, 40, 60]);

const STDERR_TAIL = 2048;
const PROBE_TIMEOUT_MS = 5000;

export function samplesToUs(samples, sampleRate) {
  return Math.floor(samples / sampleRate) * 1_000_000
    + Math.floor((samples % sampleRate) * 1_000_000 / sampleRate);
}

export class Timeline {
  constructor(sampleRate, baseUs = 0) {
    this.sampleRate = sampleRate;
    this.baseUs = baseUs;
    this.sample = 0;
  }

  usAt(sample) {
    return this.baseUs + samplesToUs(sample, this.sampleRate);
  }

  get nowUs() {
    return this.usAt(this.sample);
  }

  advance(samples) {
    const startUs = this.usAt(this.sample);
    this.sample += samples;
    return { startUs, durationUs: this.usAt(this.sample) - startUs };
  }
}

class ChunkQueue {
  #items = [];
  #waiters = [];
  #done = false;
  #error = null;

  push(item) {
    const w = this.#waiters.shift();
    if (w) w.resolve(item);
    else this.#items.push(item);
  }

  finish(error = null) {
    if (this.#done) return;
    this.#done = true;
    this.#error = error;
    for (const w of this.#waiters.splice(0)) {
      if (error) w.reject(error);
      else w.resolve(null);
    }
  }

  get finished() {
    return this.#done;
  }

  get error() {
    return this.#error;
  }

  read() {
    if (this.#items.length) return Promise.resolve(this.#items.shift());
    if (this.#done) return this.#error ? Promise.reject(this.#error) : Promise.resolve(null);
    return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
  }
}

function tailOf(buf, chunk) {
  const next = buf + chunk.toString();
  return next.length > STDERR_TAIL ? next.slice(-STDERR_TAIL) : next;
}

function ffmpegError(what, code, signal, stderr) {
  return new Error(`ffmpeg ${what} failed (${signal || code}): ${stderr.trim()}`);
}

function inputUrl(file) {
  return 'file:' + path.resolve(file);
}

function ffprobeFor(ffmpeg) {
  if (!ffmpeg) return ffprobeBin();
  const base = path.basename(ffmpeg);
  const i = base.lastIndexOf('ffmpeg');
  if (i < 0) return ffprobeBin();
  const probe = base.slice(0, i) + 'ffprobe' + base.slice(i + 6);
  return ffmpeg.includes(path.sep) ? path.join(path.dirname(ffmpeg), probe) : probe;
}

// Channel count of the first audio stream, or null when it cannot be told
// (the decode itself then reports the real error).
export function probeChannels(file, { ffmpeg, ffprobe = ffprobeFor(ffmpeg), signal } = {}) {
  return new Promise((resolve) => {
    const child = spawn(ffprobe, [
      '-v', 'error', '-protocol_whitelist', 'file', '-select_streams', 'a:0',
      '-show_entries', 'stream=channels', '-of', 'csv=p=0', inputUrl(file),
    ], { stdio: ['ignore', 'pipe', 'ignore'], signal, timeout: PROBE_TIMEOUT_MS, killSignal: 'SIGKILL' });
    let out = '';
    child.stdout.on('data', (c) => { if (out.length < 64) out += c; });
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      const n = Number.parseInt(out, 10);
      resolve(code === 0 && n > 0 ? n : null);
    });
  });
}

// ffmpeg's -ac upmixes mono to stereo at -3 dB per side; a mono source must reach
// both sides unchanged. Stereo to mono is the plain average; anything else gets
// ffmpeg's standard downmix via -ac.
function channelFilter(inputChannels, channels) {
  if (inputChannels === 1 && channels === 2) return 'pan=stereo|c0=c0|c1=c0';
  if (inputChannels === 2 && channels === 1) return 'pan=mono|c0=0.5*c0+0.5*c1';
  return null;
}

export function createDecoder({
  file, startMs = 0, gainDb = 0, sampleRate, channels, inputChannels = null, signal, ffmpeg = ffmpegBin(),
}) {
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-protocol_whitelist', 'file'];
  if (startMs > 0) args.push('-ss', (startMs / 1000).toFixed(3));
  args.push(
    '-i', inputUrl(file), '-map', '0:a:0', '-vn', '-sn', '-dn',
  );
  const filters = [channelFilter(inputChannels, channels), gainDb ? `volume=${Number(gainDb).toFixed(2)}dB` : null]
    .filter(Boolean);
  if (filters.length) args.push('-af', filters.join(','));
  args.push(
    '-f', 's32le', '-c:a', 'pcm_s32le', '-ar', String(sampleRate), '-ac', String(channels), 'pipe:1',
  );
  const child = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'], signal });
  const frameBytes = MASTER_BYTES_PER_SAMPLE * channels;
  let stderr = '';
  let spawnError = null;
  child.stderr.on('data', (c) => { stderr = tailOf(stderr, c); });
  child.on('error', (err) => { spawnError = err; });
  const exited = new Promise((resolve) => child.on('close', (code, sig) => resolve({ code, sig })));

  async function* iterate() {
    let rest = null;
    try {
      for await (const data of child.stdout) {
        const buf = rest ? Buffer.concat([rest, data]) : data;
        const whole = buf.length - (buf.length % frameBytes);
        rest = whole < buf.length ? buf.subarray(whole) : null;
        if (whole) yield buf.subarray(0, whole);
      }
      const { code, sig } = await exited;
      if (spawnError) throw spawnError;
      if (code !== 0) throw ffmpegError('decode', code, sig, stderr);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  }

  const it = iterate();
  return {
    pid: child.pid,
    sampleRate,
    channels,
    exited,
    [Symbol.asyncIterator]: () => it,
    close: () => it.return(),
  };
}

export async function openDecoder(opts) {
  const inputChannels = opts.inputChannels ?? await probeChannels(opts.file, { ffmpeg: opts.ffmpeg, signal: opts.signal });
  return createDecoder({ ...opts, inputChannels });
}

async function* decodeFile(opts) {
  yield* await openDecoder(opts);
}

export async function* decodeQueue(tracks, { sampleRate, channels, signal, ffmpeg }) {
  let sample = 0;
  const frameBytes = MASTER_BYTES_PER_SAMPLE * channels;
  for await (const track of tracks) {
    const decoder = await openDecoder({
      file: track.file, startMs: track.startMs, gainDb: track.gainDb, inputChannels: track.channels,
      sampleRate, channels, signal, ffmpeg,
    });
    let first = true;
    for await (const pcm of decoder) {
      yield { track, pcm, sample, trackStart: first };
      first = false;
      sample += pcm.length / frameBytes;
    }
  }
}

function convertMaster(pcm, bitDepth) {
  const bytes = bitDepth / 8;
  const skip = MASTER_BYTES_PER_SAMPLE - bytes;
  const n = pcm.length / MASTER_BYTES_PER_SAMPLE;
  const out = Buffer.allocUnsafe(n * bytes);
  for (let i = 0, o = 0, p = skip; i < n; i++, p += MASTER_BYTES_PER_SAMPLE) {
    for (let b = 0; b < bytes; b++) out[o++] = pcm[p + b];
  }
  return out;
}

class PcmChunker {
  #pending = [];
  #pendingBytes = 0;

  constructor(frameBytes, chunkSamples) {
    this.frameBytes = frameBytes;
    this.chunkBytes = frameBytes * chunkSamples;
  }

  push(buf) {
    this.#pending.push(buf);
    this.#pendingBytes += buf.length;
    if (this.#pendingBytes < this.chunkBytes) return [];
    const all = Buffer.concat(this.#pending);
    const out = [];
    let pos = 0;
    while (all.length - pos >= this.chunkBytes) {
      out.push(all.subarray(pos, pos + this.chunkBytes));
      pos += this.chunkBytes;
    }
    const rest = all.subarray(pos);
    this.#pending = rest.length ? [rest] : [];
    this.#pendingBytes = rest.length;
    return out;
  }

  flush() {
    const whole = this.#pendingBytes - (this.#pendingBytes % this.frameBytes);
    const all = Buffer.concat(this.#pending);
    this.#pending = [];
    this.#pendingBytes = 0;
    return whole ? [all.subarray(0, whole)] : [];
  }
}

const CRC8 = new Uint8Array(256);
const CRC16 = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  let c8 = i;
  let c16 = i << 8;
  for (let b = 0; b < 8; b++) {
    c8 = (c8 & 0x80) ? ((c8 << 1) ^ 0x07) & 0xff : (c8 << 1) & 0xff;
    c16 = (c16 & 0x8000) ? ((c16 << 1) ^ 0x8005) & 0xffff : (c16 << 1) & 0xffff;
  }
  CRC8[i] = c8;
  CRC16[i] = c16;
}

const BLOCK_SIZES = [0, 192, 576, 1152, 2304, 4608, -8, -16, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768];
const RATE_EXTRA = { 12: 1, 13: 2, 14: 2 };
const UTF8_LEAD = [
  { mask: 0x80, bits: 0x00, extra: 0 }, { mask: 0xe0, bits: 0xc0, extra: 1 }, { mask: 0xf0, bits: 0xe0, extra: 2 },
  { mask: 0xf8, bits: 0xf0, extra: 3 }, { mask: 0xfc, bits: 0xf8, extra: 4 }, { mask: 0xfe, bits: 0xfc, extra: 5 },
  { mask: 0xff, bits: 0xfe, extra: 6 },
];

const crc16 = (crc, byte) => ((crc << 8) & 0xffff) ^ CRC16[(crc >> 8) ^ byte];

// Returns undefined when more bytes are needed, null when the bytes are not a valid frame header.
export function parseFlacFrameHeader(buf, pos) {
  if (buf.length - pos < 4) return undefined;
  if (buf[pos] !== 0xff || (buf[pos + 1] & 0xfe) !== 0xf8) return null;
  const bsCode = buf[pos + 2] >> 4;
  const srCode = buf[pos + 2] & 0x0f;
  const chCode = buf[pos + 3] >> 4;
  if (bsCode === 0 || srCode === 15 || chCode > 10 || ((buf[pos + 3] >> 1) & 7) === 3 || (buf[pos + 3] & 1)) return null;
  let p = pos + 4;
  if (p >= buf.length) return undefined;
  const lead = UTF8_LEAD.find((l) => (buf[p] & l.mask) === l.bits);
  if (!lead) return null;
  const extra = lead.extra;
  let number = buf[p] & ~lead.mask & 0xff;
  const bsExtra = BLOCK_SIZES[bsCode] < 0 ? -BLOCK_SIZES[bsCode] / 8 : 0;
  const end = p + 1 + extra + bsExtra + (RATE_EXTRA[srCode] || 0);
  if (end >= buf.length) return undefined;
  p++;
  for (let i = 0; i < extra; i++, p++) {
    if ((buf[p] & 0xc0) !== 0x80) return null;
    number = number * 64 + (buf[p] & 0x3f);
  }
  let blockSize = BLOCK_SIZES[bsCode];
  if (bsExtra === 1) blockSize = buf[p] + 1;
  else if (bsExtra === 2) blockSize = buf.readUInt16BE(p) + 1;
  let crc = 0;
  for (let i = pos; i < end; i++) crc = CRC8[crc ^ buf[i]];
  if (crc !== buf[end]) return null;
  return { length: end + 1 - pos, blockSize, number, variable: (buf[pos + 1] & 1) === 1 };
}

export class FlacFramer {
  #buf = Buffer.alloc(0);
  #inHeader = true;
  #scan = 0;
  #crc = 0;
  #current = null;

  #stripStreamHeader() {
    const b = this.#buf;
    if (b.length < 4) return false;
    if (b.toString('latin1', 0, 4) !== 'fLaC') throw new Error('FLAC stream marker missing');
    let p = 4;
    for (;;) {
      if (b.length < p + 4) return false;
      const last = b[p] & 0x80;
      const len = b.readUIntBE(p + 1, 3);
      if (b.length < p + 4 + len) return false;
      p += 4 + len;
      if (last) break;
    }
    this.#buf = b.subarray(p);
    this.#inHeader = false;
    return true;
  }

  #isNextHeader(h) {
    const cur = this.#current;
    return h.variable === cur.variable && h.number === (cur.variable ? cur.number + cur.blockSize : cur.number + 1);
  }

  #findNextFrame(b) {
    const minLength = this.#current.length + 2;
    let i = this.#scan;
    let crc = this.#crc;
    let found = -1;
    for (; i < b.length; i++) {
      if (crc === 0 && i >= minLength && b[i] === 0xff) {
        const h = parseFlacFrameHeader(b, i);
        if (h === undefined) break;
        if (h && this.#isNextHeader(h)) { found = i; break; }
      }
      crc = crc16(crc, b[i]);
    }
    this.#scan = i;
    this.#crc = crc;
    return found;
  }

  push(data) {
    this.#buf = this.#buf.length ? Buffer.concat([this.#buf, data]) : data;
    if (this.#inHeader && !this.#stripStreamHeader()) return [];
    const frames = [];
    for (;;) {
      const b = this.#buf;
      if (!this.#current) {
        const h = parseFlacFrameHeader(b, 0);
        if (h === undefined) return frames;
        if (h === null) throw new Error('FLAC frame sync lost');
        this.#current = h;
        this.#scan = 0;
        this.#crc = 0;
      }
      const found = this.#findNextFrame(b);
      if (found < 0) return frames;
      const cur = this.#current;
      frames.push({ frame: b.subarray(0, found), samples: cur.blockSize });
      this.#buf = b.subarray(found);
      this.#current = null;
    }
  }

  end() {
    if (this.#inHeader) throw new Error('FLAC stream ended before its header');
    if (!this.#buf.length) return [];
    const frames = this.push(Buffer.alloc(0));
    const b = this.#buf;
    if (!b.length) return frames;
    let crc = 0;
    for (const byte of b) crc = crc16(crc, byte);
    if (!this.#current || crc !== 0) throw new Error('FLAC stream ended with a truncated frame');
    frames.push({ frame: b, samples: this.#current.blockSize });
    this.#buf = Buffer.alloc(0);
    this.#current = null;
    return frames;
  }
}

const OGG_CRC = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i << 24;
  for (let b = 0; b < 8; b++) c = (c & 0x80000000) ? ((c << 1) ^ 0x04c11db7) : (c << 1);
  OGG_CRC[i] = c >>> 0;
}

export function oggCrc(buf) {
  let crc = 0;
  for (let i = 0; i < buf.length; i++) crc = ((crc << 8) ^ OGG_CRC[((crc >>> 24) ^ buf[i]) & 0xff]) >>> 0;
  return crc;
}

const OGG_HEADER = 27;
const MAX_OGG_PACKET = 65536;

// One logical stream (what ffmpeg's ogg muxer writes for one audio stream); packets may span pages.
export class OggPacketReader {
  #buf = Buffer.alloc(0);
  #partial = [];
  #partialBytes = 0;
  #serial = null;
  #seq = -1;
  #eos = false;

  push(data) {
    this.#buf = this.#buf.length ? Buffer.concat([this.#buf, data]) : data;
    const packets = [];
    for (;;) {
      const b = this.#buf;
      if (b.length < OGG_HEADER) return packets;
      if (b.toString('latin1', 0, 4) !== 'OggS' || b[4] !== 0) throw new Error('Ogg capture pattern lost');
      const nseg = b[26];
      if (b.length < OGG_HEADER + nseg) return packets;
      let bodyLen = 0;
      for (let i = 0; i < nseg; i++) bodyLen += b[OGG_HEADER + i];
      const pageLen = OGG_HEADER + nseg + bodyLen;
      if (b.length < pageLen) return packets;
      const page = b.subarray(0, pageLen);
      this.#buf = b.subarray(pageLen);
      this.#page(page, nseg, packets);
    }
  }

  #check(page) {
    const want = page.readUInt32LE(22);
    const copy = Buffer.from(page);
    copy.writeUInt32LE(0, 22);
    if (oggCrc(copy) !== want) throw new Error('Ogg page CRC mismatch');
    const type = page[5];
    const serial = page.readUInt32LE(14);
    const seq = page.readUInt32LE(18);
    if (this.#eos) throw new Error('Ogg page after end of stream');
    if (this.#serial === null) {
      if (!(type & 2)) throw new Error('Ogg stream does not begin with a BOS page');
      this.#serial = serial;
    } else if (serial !== this.#serial || (type & 2)) {
      throw new Error('Ogg stream is not a single logical stream');
    }
    if (seq !== this.#seq + 1) throw new Error('Ogg page sequence gap');
    this.#seq = seq;
    if (((type & 1) === 1) !== (this.#partial.length > 0)) throw new Error('Ogg continuation flag mismatch');
  }

  #page(page, nseg, packets) {
    this.#check(page);
    const type = page[5];
    let pos = OGG_HEADER + nseg;
    for (let i = 0; i < nseg; i++) {
      const lace = page[OGG_HEADER + i];
      if (lace) {
        this.#partial.push(page.subarray(pos, pos + lace));
        this.#partialBytes += lace;
        if (this.#partialBytes > MAX_OGG_PACKET) throw new Error('Ogg packet too large');
      }
      pos += lace;
      if (lace < 255) {
        packets.push(this.#partial.length === 1 ? this.#partial[0] : Buffer.concat(this.#partial));
        this.#partial = [];
        this.#partialBytes = 0;
      }
    }
    if (type & 4) this.#eos = true;
  }

  end() {
    if (this.#buf.length || this.#partial.length) throw new Error('Ogg stream ended inside a page or packet');
  }
}

const OPUS_CONFIG_48K = [480, 960, 1920, 2880, 480, 960, 1920, 2880, 480, 960, 1920, 2880, 480, 960, 480, 960,
  120, 240, 480, 960, 120, 240, 480, 960, 120, 240, 480, 960, 120, 240, 480, 960];

// Samples at 48 kHz from the TOC byte (RFC 6716 §3.1); null for a malformed packet.
export function opusPacketSamples(packet) {
  if (!packet.length) return null;
  const toc = packet[0];
  const per = OPUS_CONFIG_48K[toc >> 3];
  const code = toc & 3;
  let frames = code === 0 ? 1 : 2;
  if (code === 3) {
    if (packet.length < 2) return null;
    frames = packet[1] & 0x3f;
    if (!frames) return null;
  }
  const n = per * frames;
  return n > 5760 ? null : n;
}

export function parseOpusHead(packet) {
  if (packet.length < 19 || packet.toString('latin1', 0, 8) !== 'OpusHead' || (packet[8] >> 4) !== 0) return null;
  return { channels: packet[9], preSkip: packet.readUInt16LE(10), inputRate: packet.readUInt32LE(12) };
}

// Ogg Opus -> raw packets: OpusHead, OpusTags, then one { packet, samples48k } per audio packet.
export class OpusDemuxer {
  #ogg = new OggPacketReader();
  #index = 0;
  head = null;

  push(data) {
    return this.#take(this.#ogg.push(data));
  }

  end() {
    this.#ogg.end();
    if (this.#index < 2) throw new Error('Opus stream ended before its headers');
    return [];
  }

  #take(packets) {
    const out = [];
    for (const p of packets) {
      const i = this.#index++;
      if (i === 0) {
        this.head = parseOpusHead(p);
        if (!this.head) throw new Error('OpusHead missing');
      } else if (i === 1) {
        if (p.length < 8 || p.toString('latin1', 0, 8) !== 'OpusTags') throw new Error('OpusTags missing');
      } else {
        const samples = opusPacketSamples(p);
        if (samples === null) throw new Error('malformed Opus packet');
        out.push({ packet: p, samples });
      }
    }
    return out;
  }
}

export function flacCodecHeader({ sampleRate, channels, bitDepth, blockSize }) {
  const si = Buffer.alloc(34);
  si.writeUInt16BE(blockSize, 0);
  si.writeUInt16BE(blockSize, 2);
  si.writeUInt32BE(((sampleRate << 12) | ((channels - 1) << 9) | ((bitDepth - 1) << 4)) >>> 0, 10);
  return Buffer.concat([Buffer.from('fLaC', 'latin1'), Buffer.from([0x80, 0, 0, 34]), si]);
}

function opusFrameMs(chunkMs) {
  return OPUS_FRAME_MS.findLast((ms) => ms <= (chunkMs ?? DEFAULT_CHUNK_MS.opus)) ?? OPUS_FRAME_MS[0];
}

function chunkSamplesFor(format, chunkMs) {
  if (format.codec === 'opus') return format.sample_rate * opusFrameMs(chunkMs) / 1000;
  const ms = Math.min(MAX_CHUNK_MS, Math.max(MIN_CHUNK_MS, chunkMs ?? DEFAULT_CHUNK_MS[format.codec]));
  return Math.floor(format.sample_rate * ms / 1000);
}

function validateFormat(format) {
  if (format.codec === 'opus') {
    if (!OPUS_SAMPLE_RATES.includes(format.sample_rate)) throw new Error(`Unsupported Opus sample rate ${format.sample_rate}`);
    if (format.channels !== 1 && format.channels !== 2) throw new Error(`Unsupported Opus channel count ${format.channels}`);
    return;
  }
  if (format.codec !== 'pcm' && format.codec !== 'flac') throw new Error(`Unsupported codec ${format.codec}`);
  if (format.bit_depth !== 16 && format.bit_depth !== 24) throw new Error(`Unsupported bit depth ${format.bit_depth}`);
}

class Encoder {
  #queue = new ChunkQueue();
  #timeline;

  constructor(format, chunkSamples, baseUs) {
    this.format = format;
    this.chunkSamples = chunkSamples;
    this.codecHeader = null;
    this.#timeline = new Timeline(format.sample_rate, baseUs);
  }

  get endUs() {
    return this.#timeline.nowUs;
  }

  shiftTimeline(us) {
    this.#timeline.baseUs += us;
  }

  get samples() {
    return this.#timeline.sample;
  }

  emit(frame, samples) {
    const { startUs, durationUs } = this.#timeline.advance(samples);
    this.#queue.push({ frame, samples, startUs, durationUs });
  }

  finish(error) {
    this.#queue.finish(error);
  }

  get finished() {
    return this.#queue.finished;
  }

  get error() {
    return this.#queue.error;
  }

  read() {
    return this.#queue.read();
  }

  async *[Symbol.asyncIterator]() {
    for (let c = await this.read(); c; c = await this.read()) yield c;
  }
}

class PcmRepackEncoder extends Encoder {
  #chunker;

  constructor(format, chunkSamples, baseUs) {
    super(format, chunkSamples, baseUs);
    this.#chunker = new PcmChunker(format.bit_depth / 8 * format.channels, chunkSamples);
  }

  #emitAll(bufs) {
    const fb = this.#chunker.frameBytes;
    for (const b of bufs) this.emit(b, b.length / fb);
  }

  write(pcm) {
    if (this.finished) return this.error ? Promise.reject(this.error) : Promise.resolve();
    this.#emitAll(this.#chunker.push(convertMaster(pcm, this.format.bit_depth)));
    return Promise.resolve();
  }

  end() {
    if (this.finished) return;
    this.#emitAll(this.#chunker.flush());
    this.finish(null);
  }

  close(reason = null) {
    this.finish(reason);
  }
}

class FfmpegEncoder extends Encoder {
  #child;
  #closed = false;
  #exit;

  constructor({ format, chunkSamples, baseUs, inputRate, inputChannels, signal, ffmpeg }) {
    super(format, chunkSamples, baseUs);
    const out = ['-ar', String(format.sample_rate), '-ac', String(format.channels)];
    const filter = channelFilter(inputChannels, format.channels);
    if (filter) out.unshift('-af', filter);
    let onData;
    let onEnd;
    if (format.codec === 'flac') {
      this.codecHeader = flacCodecHeader({
        sampleRate: format.sample_rate, channels: format.channels, bitDepth: format.bit_depth, blockSize: chunkSamples,
      }).toString('base64');
      out.push('-c:a', 'flac', '-sample_fmt', format.bit_depth === 16 ? 's16' : 's32');
      if (format.bit_depth === 24) out.push('-bits_per_raw_sample', '24');
      out.push('-frame_size', String(chunkSamples), '-fflags', '+bitexact', '-f', 'flac');
      const framer = new FlacFramer();
      onData = (d) => { for (const f of framer.push(d)) this.emit(f.frame, f.samples); };
      onEnd = () => { for (const f of framer.end()) this.emit(f.frame, f.samples); };
    } else if (format.codec === 'opus') {
      out.push(
        '-c:a', 'libopus', '-b:a', `${64 * format.channels}k`, '-vbr', 'on', '-application', 'audio',
        '-frame_duration', String(chunkSamples * 1000 / format.sample_rate), '-f', 'ogg', '-page_duration', '20000',
      );
      const demux = new OpusDemuxer();
      const scale = format.sample_rate / 48000;
      // As aiosendspin: no OpusHead reaches the player, so its decoder outputs the encoder's pre-skip too.
      // Moving the timeline back by pre-skip puts input sample n at baseUs + n exactly.
      let shifted = false;
      const emitAll = (packets) => {
        for (const p of packets) {
          if (!shifted) {
            this.shiftTimeline(-samplesToUs(demux.head.preSkip, 48000));
            shifted = true;
          }
          this.emit(p.packet, p.samples * scale);
        }
      };
      onData = (d) => emitAll(demux.push(d));
      onEnd = () => emitAll(demux.end());
    } else {
      out.push('-f', format.bit_depth === 16 ? 's16le' : 's24le');
      const chunker = new PcmChunker(format.bit_depth / 8 * format.channels, chunkSamples);
      const fb = chunker.frameBytes;
      onData = (d) => { for (const b of chunker.push(d)) this.emit(b, b.length / fb); };
      onEnd = () => { for (const b of chunker.flush()) this.emit(b, b.length / fb); };
    }
    const args = [
      '-hide_banner', '-nostdin', '-loglevel', 'error',
      '-f', 's32le', '-ar', String(inputRate), '-ac', String(inputChannels), '-i', 'pipe:0',
      ...out, '-flush_packets', '1', 'pipe:1',
    ];
    const child = spawn(ffmpeg, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.#child = child;
    this.pid = child.pid;
    let stderr = '';
    child.stderr.on('data', (c) => { stderr = tailOf(stderr, c); });
    child.stdin.on('error', () => {});
    child.stdout.on('data', (d) => {
      if (this.#closed) return;
      try { onData(d); } catch (err) { this.close(err); }
    });
    this.#exit = new Promise((resolve) => {
      child.on('error', (err) => { this.close(err); resolve(); });
      child.on('close', (code, sig) => {
        if (!this.#closed) {
          if (code !== 0) this.finish(ffmpegError('encode', code, sig, stderr));
          else {
            try { onEnd(); this.finish(null); } catch (err) { this.finish(err); }
          }
        }
        resolve();
      });
    });
    if (signal) {
      if (signal.aborted) this.close(signal.reason);
      else signal.addEventListener('abort', () => this.close(signal.reason), { once: true });
    }
  }

  get exited() {
    return this.#exit;
  }

  async write(pcm) {
    if (this.finished) {
      if (this.error) throw this.error;
      return;
    }
    const stdin = this.#child.stdin;
    if (stdin.write(pcm)) return;
    await new Promise((resolve) => {
      const done = () => {
        stdin.off('drain', done);
        this.#child.off('close', done);
        resolve();
      };
      stdin.on('drain', done);
      this.#child.on('close', done);
    });
    if (this.error) throw this.error;
  }

  end() {
    if (!this.#child.stdin.writableEnded) this.#child.stdin.end();
  }

  close(reason = null) {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#child.exitCode === null && this.#child.signalCode === null) this.#child.kill('SIGKILL');
    this.finish(reason);
  }
}

export function createEncoder({ format, inputRate, inputChannels, chunkMs, baseUs = 0, signal, ffmpeg }) {
  validateFormat(format);
  const chunkSamples = chunkSamplesFor(format, chunkMs);
  if (format.codec === 'pcm' && inputRate === format.sample_rate && inputChannels === format.channels) {
    const enc = new PcmRepackEncoder(format, chunkSamples, baseUs);
    if (signal) {
      if (signal.aborted) enc.close(signal.reason);
      else signal.addEventListener('abort', () => enc.close(signal.reason), { once: true });
    }
    return enc;
  }
  return new FfmpegEncoder({
    format, chunkSamples, baseUs, inputRate, inputChannels, signal, ffmpeg: ffmpeg ?? ffmpegBin(),
  });
}

export async function pump(pcmSource, encoders) {
  try {
    for await (const item of pcmSource) {
      const pcm = Buffer.isBuffer(item) ? item : item.pcm;
      await Promise.all(encoders.map((e) => e.write(pcm)));
    }
    for (const e of encoders) e.end();
  } catch (err) {
    for (const e of encoders) e.close(err);
  }
}

export function openTrack({ file, startMs = 0, format, chunkMs, baseUs = 0, signal, ffmpeg }) {
  const encoder = createEncoder({
    format, inputRate: format.sample_rate, inputChannels: format.channels, chunkMs, baseUs, signal, ffmpeg,
  });
  pump(decodeFile({ file, startMs, sampleRate: format.sample_rate, channels: format.channels, signal, ffmpeg }), [encoder]);
  return encoder;
}
