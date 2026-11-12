import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { ffmpegBin } from '../util/ffmpeg-bootstrap.js';
import { parseFlacFrameHeader } from './audio.js';
import { serverNow } from './scheduler.js';
import { cleanText } from './connection.js';

export const SOURCE_ROLE = 'source@v1';
export const MAX_SOURCE_RATE = 384_000;
export const MAX_SOURCE_CHANNELS = 8;
export const MAX_CHUNK_MS = 150;
// Jitter buffer between the arriving source audio and the room's clock.
export const TARGET_MS = 150;
// Above target + this the oldest audio is dropped (a burst after a stall must not add latency for good).
export const MAX_EXCESS_MS = 250;
// Rate correction is bounded: +-1000 ppm is ~1.7 cents, inaudible; a source further off is broken, not drifting.
export const MAX_PPM = 1000;
// Critically damped PI on the buffer level (s^2 + kp s + ki, ki = kp^2/4): time constant ~2/kp = 100 s.
export const KP = 0.02;
export const KI = KP * KP / 4;
export const LEVEL_EMA_MS = 1000;
// A chunk later than the recent best delay by this much is stale backlog (spec: never burst stale audio).
export const STALE_MS = 500;
export const STALE_WINDOW_MS = 5000;
// Timestamps that move more than this against the sample count are a discontinuity (counted, never cut at).
export const JUMP_MS = 20;
export const STALL_MS = 250;
// A source may not run ahead of real time by more than this (bounds decode work per connection).
export const MAX_AHEAD_US = 1_000_000;
export const TICK_MS = 10;
// Shorter chunks are refused: per-chunk work must stay proportional to the audio it carries.
export const MIN_CHUNK_MS = 1;
// Bytes queued to the ffmpeg decoder, in seconds of the input's uncompressed size: above this chunks are
// dropped, and a decoder that stays behind for BACKLOG_END_MS ends the line-in.
export const BACKLOG_MS = 1500;
export const BACKLOG_END_MS = 3000;

export class SourceError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// Validates a client-stream/start source object against what we decode. -> { codec, rate, channels, bitDepth,
// header, maxBlock } | null
export function checkSourceFormat(f) {
  if (!f || !['pcm', 'flac'].includes(f.codec)) return null;
  const rate = f.sample_rate;
  const channels = f.channels;
  if (!Number.isInteger(rate) || rate < 8000 || rate > MAX_SOURCE_RATE) return null;
  if (!Number.isInteger(channels) || channels < 1 || channels > MAX_SOURCE_CHANNELS) return null;
  if (f.codec === 'pcm') {
    if (![16, 24, 32].includes(f.bit_depth) || f.codec_header !== undefined) return null;
    return { codec: 'pcm', rate, channels, bitDepth: f.bit_depth, header: null, maxBlock: 0 };
  }
  if (typeof f.codec_header !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(f.codec_header)) return null;
  const h = Buffer.from(f.codec_header, 'base64');
  if (h.length < 42 || h.toString('latin1', 0, 4) !== 'fLaC' || (h[4] & 0x7f) !== 0 || h.readUIntBE(5, 3) !== 34) return null;
  const hdrRate = (h[18] << 12) | (h[19] << 4) | (h[20] >> 4);
  const hdrChannels = ((h[20] >> 1) & 7) + 1;
  const bits = (((h[20] & 1) << 4) | (h[21] >> 4)) + 1;
  const maxBlock = h.readUInt16BE(10);
  if (hdrRate !== rate || hdrChannels !== channels || bits !== f.bit_depth || bits < 4 || maxBlock < 16) return null;
  // ffmpeg reads exactly what we feed it: STREAMINFO must be the last metadata block.
  const header = Buffer.from(h.subarray(0, 42));
  header[4] |= 0x80;
  return { codec: 'flac', rate, channels, bitDepth: bits, header, maxBlock };
}

const FLAC_RATES = [0, 88200, 176400, 192000, 8000, 16000, 22050, 24000, 32000, 44100, 48000, 96000];
const FLAC_BITS = [0, 8, 12, -1, 16, 20, 24, 32];

// A frame header's own rate/channels/bit depth fields agree with STREAMINFO (0 = "see STREAMINFO").
function flacHeaderFits(data, i, info) {
  if (!info) return true;
  const sr = data[i + 2] & 0x0f;
  const ch = data[i + 3] >> 4;
  const bits = FLAC_BITS[(data[i + 3] >> 1) & 7];
  if (sr >= 1 && sr <= 11 && FLAC_RATES[sr] !== info.rate) return false;
  if ((ch <= 7 ? ch + 1 : 2) !== info.channels) return false;
  return bits === 0 || bits === info.bitDepth;
}

// Worst case for FLAC: verbatim subframes (side channel one bit wider) plus header, footer and padding per frame.
export function flacMaxBytes(samples, frames, channels, bitDepth) {
  return Math.ceil(samples * (channels * bitDepth + 1) / 8) + frames * (16 + 2 + 1 + 2 * channels);
}

// Samples in a chunk of whole FLAC frames, counted from the frame headers without decoding. A frame header is
// one that passes the CRC-8, agrees with STREAMINFO and continues the chunk's frame numbering; anything else is
// frame data. -> { samples, frames } | null when the chunk does not start with a frame header. Throws
// SourceError('bad_chunk') for a frame larger than STREAMINFO's maximum block size (a few header bytes could
// otherwise declare 65535 samples, or hide megabytes as one sample).
export function flacFrameScan(data, maxBlock, limit, info = null) {
  const first = parseFlacFrameHeader(data, 0);
  if (!first || !flacHeaderFits(data, 0, info)) return null;
  const tooBig = (h) => new SourceError('bad_chunk', `flac frame of ${h.blockSize} samples above the stream's maximum ${maxBlock}`);
  if (first.blockSize > maxBlock) throw tooBig(first);
  let total = first.blockSize;
  let frames = 1;
  let prev = first;
  for (let i = first.length; i < data.length - 1 && total <= limit; i++) {
    if (data[i] !== 0xff || (data[i + 1] & 0xfe) !== 0xf8) continue;
    const h = parseFlacFrameHeader(data, i);
    if (!h || h.variable !== prev.variable || !flacHeaderFits(data, i, info)) continue;
    if (h.number !== (prev.variable ? prev.number + prev.blockSize : prev.number + 1)) continue;
    if (h.blockSize > maxBlock) throw tooBig(h);
    total += h.blockSize;
    frames++;
    prev = h;
    i += h.length - 1;
  }
  return { samples: total, frames };
}

export function flacChunkSamples(data, maxBlock, limit, info = null) {
  return flacFrameScan(data, maxBlock, limit, info)?.samples ?? null;
}

const maxChunkSamples = (fmt) => Math.ceil(fmt.rate * MAX_CHUNK_MS / 1000) + (fmt.codec === 'flac' ? fmt.maxBlock : 0);

// -> samples | null (not a chunk we can count). Throws SourceError('bad_chunk') when the bytes cannot be the
// audio the chunk claims: more than the uncompressed size of its samples.
export function chunkSamples(fmt, data) {
  if (fmt.codec === 'pcm') {
    const frameBytes = (fmt.bitDepth / 8) * fmt.channels;
    return data.length && data.length % frameBytes === 0 ? data.length / frameBytes : null;
  }
  if (!data.length) return null;
  const limit = maxChunkSamples(fmt);
  const cap = (samples, frames) => flacMaxBytes(samples, frames, fmt.channels, fmt.bitDepth);
  if (data.length > cap(limit, Math.ceil(limit / 16))) throw new SourceError('bad_chunk', `flac chunk of ${data.length} bytes is larger than any valid chunk`);
  const scan = flacFrameScan(data, fmt.maxBlock, limit, fmt);
  if (!scan || scan.samples > limit) return scan?.samples ?? null;
  if (data.length > cap(scan.samples, scan.frames)) {
    throw new SourceError('bad_chunk', `flac chunk of ${data.length} bytes for ${scan.samples} samples in ${scan.frames} frames`);
  }
  return scan.samples;
}

// Little-endian signed PCM -> interleaved stereo float (mono doubled, extra channels dropped).
export function pcmToStereo(buf, bitDepth, channels) {
  const bytes = bitDepth / 8;
  const n = Math.floor(buf.length / (bytes * channels));
  const out = new Float32Array(n * 2);
  const scale = 1 / 2 ** (bitDepth - 1);
  const readers = { 16: (o) => buf.readInt16LE(o), 24: (o) => buf.readIntLE(o, 3), 32: (o) => buf.readInt32LE(o) };
  const read = readers[bitDepth];
  for (let i = 0, o = 0; i < n; i++, o += bytes * channels) {
    const l = read(o) * scale;
    out[2 * i] = l;
    out[2 * i + 1] = channels > 1 ? read(o + bytes) * scale : l;
  }
  return out;
}

export function stereoToS32(f) {
  const out = new Int32Array(f.length);
  for (let i = 0; i < f.length; i++) {
    const v = f[i];
    out[i] = Math.round(Math.max(-1, Math.min(v, 2147483647 / 2147483648)) * 2147483648);
  }
  return Buffer.from(out.buffer, out.byteOffset, out.byteLength);
}

// Asynchronous rate conversion between the source's clock and the server's. The input is already at the
// nominal output rate; what is left is the source's clock error (ppm). Its effective rate is estimated from the
// samples that arrive: the FIFO level, smoothed, drives a PI controller whose integral term converges on the
// rate ratio. Output is read with 4-point cubic (Catmull-Rom) interpolation at that ratio, so the sample stream
// stays continuous: no sample is cut or repeated because of a timestamp.
export class LiveResampler {
  #rate;
  #buf;
  #len = 0;
  #pos = 1;
  #priming = true;
  #integral = 0;
  #level = null;
  #chunk = 0;
  #opts;

  constructor({ rate, targetMs = TARGET_MS, maxExcessMs = MAX_EXCESS_MS, kp = KP, ki = KI, maxPpm = MAX_PPM, emaMs = LEVEL_EMA_MS }) {
    this.#rate = rate;
    this.#buf = new Float32Array(rate * 2);
    this.#opts = { target: targetMs / 1000, maxExcess: maxExcessMs / 1000, kp, ki, maxCorr: maxPpm / 1e6, ema: emaMs / 1000 };
    this.ratio = 1;
    this.underruns = 0;
    this.dropped = 0;
  }

  get rate() {
    return this.#rate;
  }

  get priming() {
    return this.#priming;
  }

  // Chunks arrive whole, so the level is a sawtooth: start half a chunk above target to center it there.
  #startFrames() {
    return Math.ceil(this.#opts.target * this.#rate + this.#chunk / 2);
  }

  get ready() {
    return !this.#priming || this.#avail() >= this.#startFrames();
  }

  // Buffered audio in seconds, as the controller sees it (smoothed).
  get levelSeconds() {
    return this.#level ?? this.#avail() / this.#rate;
  }

  get ppm() {
    return (this.ratio - 1) * 1e6;
  }

  #avail() {
    return Math.max(0, this.#len - this.#pos - 2);
  }

  push(frames) {
    const n = frames.length / 2;
    if (!n) return;
    if ((this.#len + n) * 2 > this.#buf.length) this.#compact(n);
    this.#buf.set(frames, this.#len * 2);
    this.#len += n;
    this.#chunk = Math.max(n, this.#chunk * 0.9);
    const excess = this.#avail() / this.#rate - this.#opts.target;
    if (excess > this.#opts.maxExcess) {
      const drop = Math.floor(excess * this.#rate);
      this.#pos += drop;
      this.dropped += drop;
      this.#level = null;
    }
  }

  #compact(extra) {
    const keep = Math.max(0, Math.floor(this.#pos) - 1);
    const live = this.#len - keep;
    let buf = this.#buf;
    if ((live + extra) * 2 > buf.length) buf = new Float32Array(Math.max(buf.length * 2, (live + extra) * 2));
    buf.set(this.#buf.subarray(keep * 2, this.#len * 2), 0);
    this.#buf = buf;
    this.#len = live;
    this.#pos -= keep;
  }

  pull(n) {
    const out = new Float32Array(n * 2);
    const dt = n / this.#rate;
    const { kp, ki, maxCorr, target, ema } = this.#opts;
    if (this.#priming) {
      if (!this.ready) return out;
      // (Re)start at the target latency: what piled up while starved is stale backlog, not a reason to lag.
      const surplus = Math.floor(this.#avail() - this.#startFrames());
      if (surplus > 0) {
        this.#pos += surplus;
        this.dropped += surplus;
      }
      this.#priming = false;
      this.#level = null;
    }
    const avail = this.#avail() / this.#rate;
    this.#level = this.#level === null ? avail : this.#level + (avail - this.#level) * Math.min(1, dt / ema);
    const err = this.#level - target;
    this.#integral = Math.max(-maxCorr / ki, Math.min(maxCorr / ki, this.#integral + err * dt));
    const corr = Math.max(-maxCorr, Math.min(maxCorr, kp * err + ki * this.#integral));
    this.ratio = 1 + corr;
    const b = this.#buf;
    let pos = this.#pos;
    for (let k = 0; k < n; k++) {
      const i = Math.floor(pos);
      if (i + 2 >= this.#len) {
        this.#priming = true;
        this.underruns++;
        break;
      }
      const t = pos - i;
      for (let c = 0; c < 2; c++) {
        const xm = b[(i - 1) * 2 + c];
        const x0 = b[i * 2 + c];
        const x1 = b[(i + 1) * 2 + c];
        const x2 = b[(i + 2) * 2 + c];
        out[k * 2 + c] = x0 + 0.5 * t * (x1 - xm + t * (2 * xm - 5 * x0 + 4 * x1 - x2 + t * (3 * (x0 - x1) + x2 - xm)));
      }
      pos += this.ratio;
    }
    this.#pos = pos;
    return out;
  }
}

// FLAC (and PCM at another rate) goes through one long-lived ffmpeg per input stream: codec header first, then
// the chunks as they come; out comes float stereo at the room's rate. ffmpeg's own resampler does the nominal
// rate change; LiveResampler only the clock error.
export function createFfmpegDecoder({ fmt, outRate, onPcm, onError, ffmpeg = ffmpegBin() }) {
  const input = fmt.codec === 'flac'
    ? ['-f', 'flac']
    : ['-f', `s${fmt.bitDepth}le`, '-ar', String(fmt.rate), '-ac', String(fmt.channels)];
  const args = [
    '-hide_banner', '-nostdin', '-loglevel', 'error', '-probesize', '32', '-analyzeduration', '0', '-fflags', 'nobuffer',
    ...input, '-i', 'pipe:0',
    ...(fmt.channels === 1 ? ['-af', 'pan=stereo|c0=c0|c1=c0'] : []),
    '-f', 'f32le', '-ac', '2', '-ar', String(outRate), '-flush_packets', '1', 'pipe:1',
  ];
  const child = spawn(ffmpeg, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let rest = null;
  let stderr = '';
  let closed = false;
  child.stdout.on('data', (data) => {
    const buf = rest ? Buffer.concat([rest, data]) : data;
    const whole = buf.length - (buf.length % 8);
    rest = whole < buf.length ? Buffer.from(buf.subarray(whole)) : null;
    if (!whole) return;
    const copy = new Float32Array(whole / 4);
    Buffer.from(copy.buffer).set(buf.subarray(0, whole));
    onPcm(copy);
  });
  child.stderr.on('data', (c) => { stderr = (stderr + c).slice(-400); });
  child.stdin.on('error', () => {});
  child.on('error', (err) => onError?.(err));
  child.on('close', (code) => {
    if (!closed && code) onError?.(new Error(`source decoder exited ${code}: ${stderr.trim()}`));
  });
  if (fmt.header) child.stdin.write(fmt.header);
  return {
    get backlog() {
      return closed ? 0 : child.stdin.writableLength;
    },
    write: (data) => {
      if (!closed) child.stdin.write(data);
    },
    close: () => {
      if (closed) return;
      closed = true;
      child.stdin.end();
      const t = setTimeout(() => child.kill('SIGKILL'), 1000);
      t.unref?.();
      child.once('close', () => clearTimeout(t));
    },
  };
}

function createPcmDecoder({ fmt, onPcm }) {
  return { backlog: 0, write: (data) => onPcm(pcmToStereo(data, fmt.bitDepth, fmt.channels)), close: () => {} };
}

// Per source connection: validates and paces incoming chunks, keeps statistics, decodes into the resampler of
// the feed that currently plays it (one room at a time).
export class SourceSession {
  #now;
  #log;
  #ffmpeg;
  #opts;
  #decoder = null;
  // Monotonic deque of [arrival, delay] over the stale window: its head is the window's best delay.
  #recent = [];
  #recentHead = 0;
  #backlogSince = null;

  constructor(conn, { now = serverNow, logger = null, ffmpeg, resampler = {} } = {}) {
    this.conn = conn;
    this.clientId = conn.clientId;
    this.#now = now;
    this.#log = logger;
    this.#ffmpeg = ffmpeg;
    this.#opts = resampler;
    this.format = null;
    this.resampler = null;
    this.signal = null;
    this.roomId = null;
    this.startPending = false;
    this.#resetTiming();
    this.stats = { chunks: 0, rejected: 0, stale: 0, ahead: 0, jumps: 0, gaps: 0, backlog: 0 };
  }

  #resetTiming() {
    this.lastTs = null;
    this.lastDurUs = 0;
    this.lastArrival = null;
    this.aheadUs = 0;
    this.#recent = [];
    this.#recentHead = 0;
    this.#backlogSince = null;
  }

  get streaming() {
    return this.format !== null;
  }

  attach(outRate) {
    this.resampler = new LiveResampler({ rate: outRate, ...this.#opts });
    this.#rebuild();
    return this.resampler;
  }

  detach(rs) {
    if (this.resampler !== rs) return;
    this.resampler = null;
    this.#closeDecoder();
  }

  onStart(format) {
    const fmt = format ? checkSourceFormat(format) : null;
    if (format && !fmt) this.#log?.info?.(`[sendspin] ${this.clientId.slice(0, 8)} source format not supported: ${cleanText(format.codec)} ${format.sample_rate}/${format.channels}/${format.bit_depth}`);
    this.format = fmt;
    this.#resetTiming();
    this.#rebuild();
  }

  onEnd() {
    this.format = null;
    this.#closeDecoder();
  }

  #rebuild() {
    this.#closeDecoder();
    const rs = this.resampler;
    const fmt = this.format;
    if (!rs || !fmt) return;
    const onPcm = (frames) => {
      if (this.resampler === rs) rs.push(frames);
    };
    const onError = (err) => this.#log?.warn?.(`[sendspin] ${this.clientId.slice(0, 8)} source decode: ${cleanText(err.message, 200)}`);
    this.#decoder = fmt.codec === 'pcm' && fmt.rate === rs.rate
      ? createPcmDecoder({ fmt, onPcm })
      : createFfmpegDecoder({ fmt, outRate: rs.rate, onPcm, onError, ffmpeg: this.#ffmpeg });
  }

  #closeDecoder() {
    this.#decoder?.close();
    this.#decoder = null;
  }

  #bestDelay(now, delay) {
    const q = this.#recent;
    while (q.length > this.#recentHead && q[q.length - 1][1] >= delay) q.pop();
    q.push([now, delay]);
    while (now - q[this.#recentHead][0] >= STALE_WINDOW_MS * 1000) this.#recentHead++;
    if (this.#recentHead > 1024) {
      q.splice(0, this.#recentHead);
      this.#recentHead = 0;
    }
    return q[this.#recentHead][1];
  }

  // A decoder that cannot keep up must not buffer without bound: drop while behind, give up when it stays behind.
  #decoderBehind(fmt, now) {
    const backlog = this.#decoder?.backlog ?? 0;
    if (backlog <= fmt.rate * fmt.channels * (fmt.bitDepth / 8) * BACKLOG_MS / 1000) {
      this.#backlogSince = null;
      return false;
    }
    this.#backlogSince ??= now;
    return true;
  }

  // Timestamps anchor (stale backlog) and classify (jumps, gaps); the samples themselves are never cut by them.
  // -> 'ok' | 'dropped' | 'invalid' (the peer sent audio it cannot have: close it) | 'overloaded' (end the line-in)
  onAudio(timestampUs, data) {
    const fmt = this.format;
    if (!fmt) return 'dropped';
    let n;
    try {
      n = chunkSamples(fmt, data);
    } catch (err) {
      if (!(err instanceof SourceError)) throw err;
      this.stats.rejected++;
      this.lastReject = err.message;
      return 'invalid';
    }
    if (n === null || n > maxChunkSamples(fmt) || n < fmt.rate * MIN_CHUNK_MS / 1000) {
      this.stats.rejected++;
      return 'dropped';
    }
    const now = this.#now();
    if (this.#decoderBehind(fmt, now)) {
      this.stats.backlog++;
      return now - this.#backlogSince > BACKLOG_END_MS * 1000 ? 'overloaded' : 'dropped';
    }
    const durUs = n * 1e6 / fmt.rate;
    if (this.aheadUs - now > MAX_AHEAD_US) {
      this.stats.ahead++;
      return 'dropped';
    }
    this.aheadUs = Math.max(this.aheadUs, now) + durUs / 1.01;
    const ts = Number(timestampUs);
    if (this.lastTs !== null && Math.abs(ts - (this.lastTs + this.lastDurUs)) > JUMP_MS * 1000) {
      this.stats.jumps++;
      if (now - this.lastArrival > STALL_MS * 1000) this.stats.gaps++;
    }
    this.lastTs = ts;
    this.lastDurUs = durUs;
    this.lastArrival = now;
    const delay = now - ts - durUs;
    const best = this.#bestDelay(now, delay);
    this.stats.chunks++;
    this.stats.delayMs = Math.round(delay / 1000);
    if (delay - best > STALE_MS * 1000) {
      this.stats.stale++;
      return 'dropped';
    }
    this.#decoder?.write(data);
    return 'ok';
  }

  // The room's audio: a clock-driven generator in the shape GroupStream's decode loop takes. Starts once the
  // jitter buffer is filled, then yields exactly sampleRate samples per second of server time, silence on underrun.
  feed(track, { now = this.#now, tickMs = TICK_MS } = {}) {
    const session = this;
    return async function* liveFeed({ sampleRate, channels, signal }) {
      if (channels !== 2) throw new Error('line-in needs a stereo master');
      const rs = session.attach(sampleRate);
      let start = null;
      let produced = 0;
      try {
        while (!signal.aborted) {
          try {
            await sleep(tickMs, undefined, { signal });
          } catch {
            return;
          }
          const t = now();
          if (start === null) {
            if (!rs.ready) continue;
            start = t;
          }
          const due = Math.floor((t - start) * sampleRate / 1e6) - produced;
          if (due <= 0) continue;
          const pcm = stereoToS32(rs.pull(due));
          yield { track, pcm, sample: produced, trackStart: produced === 0 };
          produced += due;
        }
      } finally {
        session.detach(rs);
      }
    };
  }

  close() {
    this.resampler = null;
    this.#closeDecoder();
  }

  view() {
    const rs = this.resampler;
    return {
      format: this.format ? { codec: this.format.codec, sampleRate: this.format.rate, channels: this.format.channels, bitDepth: this.format.bitDepth } : null,
      bufferMs: rs ? Math.round(rs.levelSeconds * 1000) : null,
      ppm: rs ? Math.round(rs.ppm) : null,
      underruns: rs?.underruns ?? 0,
      ...this.stats,
    };
  }
}

const hasSource = (conn) => conn?.negotiatedRoles?.includes(SOURCE_ROLE);

// Policy: which device streams into which room, explicit approval, start/stop, auto-switch on line sense.
export class SourceManager extends EventEmitter {
  #server;
  #rooms;
  #store;
  #log;
  #opts;
  #sessions = new Map();
  #unsub = [];

  constructor({ server, rooms, logger = null, now = serverNow, ffmpeg, resampler = {}, tickMs = TICK_MS }) {
    super();
    this.#server = server;
    this.#rooms = rooms;
    this.#store = server.trustStore;
    this.#log = logger;
    this.#opts = { now, ffmpeg, resampler, tickMs };
    this.#on(server, 'client', (conn) => this.#attach(conn));
    this.#on(server, 'client-removed', (conn) => this.#detach(conn));
    this.#on(server, 'trust', (id) => this.#trustChanged(id));
    this.#on(rooms, 'live-ended', (roomId, sourceId) => this.#liveEnded(roomId, sourceId));
    for (const conn of server.clients.values()) this.#attach(conn);
  }

  #on(emitter, event, fn) {
    const guarded = (...args) => {
      try {
        fn(...args);
      } catch (err) {
        this.#log?.warn?.(`[sendspin] source ${event}: ${err.message}`);
      }
    };
    emitter.on(event, guarded);
    this.#unsub.push(() => emitter.off(event, guarded));
  }

  #attach(conn) {
    if (!hasSource(conn)) return;
    const prev = this.#sessions.get(conn.clientId);
    if (prev && prev.conn !== conn) this.#end(prev, 'replaced');
    const s = new SourceSession(conn, { now: this.#opts.now, logger: this.#log, ffmpeg: this.#opts.ffmpeg, resampler: this.#opts.resampler });
    this.#sessions.set(conn.clientId, s);
    const live = () => this.#sessions.get(conn.clientId) === s;
    const on = (event, fn) => conn.on(event, (...args) => {
      if (!live()) return;
      try {
        fn(...args);
      } catch (err) {
        this.#log?.warn?.(`[sendspin] source ${event}: ${err.message}`);
      }
    });
    on('state', (next, prev2) => this.#onState(s, next, prev2));
    on('activated', ({ roles }) => this.#onActivated(s, roles));
    on('source-start', (format) => {
      s.onStart(format);
      this.#changed(s);
    });
    on('source-end', (why) => {
      s.onEnd();
      if (s.roomId) {
        this.#log?.info?.(`[sendspin] ${s.clientId.slice(0, 8)} ended its line-in (${why})`);
        this.stop(s.clientId);
      }
      this.#changed(s);
    });
    on('source-declined', () => {
      this.#log?.info?.(`[sendspin] ${s.clientId.slice(0, 8)} declined to stream its input`);
      s.lastError = 'declined';
      this.stop(s.clientId);
    });
    on('source-audio', (ts, data) => {
      const verdict = s.onAudio(ts, data);
      if (verdict === 'invalid') {
        this.#log?.info?.(`[sendspin] ${s.clientId.slice(0, 8)} sent an invalid source chunk; closing: ${cleanText(s.lastReject, 160)}`);
        s.conn.close(1002, 'invalid source chunk');
      } else if (verdict === 'overloaded' && s.roomId) {
        this.#log?.warn?.(`[sendspin] ${s.clientId.slice(0, 8)} line-in stopped: its decoder stayed more than ${BACKLOG_END_MS / 1000} s behind`);
        this.stop(s.clientId);
        s.lastError = 'overloaded';
        this.#changed(s);
      }
    });
    this.#changed(s);
  }

  #detach(conn) {
    const s = this.#sessions.get(conn.clientId);
    if (s?.conn === conn) this.#end(s, 'disconnected');
  }

  #end(s, why) {
    this.#sessions.delete(s.clientId);
    const roomId = s.roomId;
    s.roomId = null;
    s.close();
    this.#server.setSourcePlayback(s.clientId, false);
    if (roomId) {
      this.#log?.info?.(`[sendspin] line-in from ${s.clientId.slice(0, 8)} stopped (${why})`);
      this.#safeRoom(() => this.#rooms.stopLive(roomId, s.clientId));
    }
    this.emit('change', s.clientId);
  }

  #safeRoom(fn) {
    try {
      fn();
    } catch (err) {
      this.#log?.debug?.(`[sendspin] line-in room: ${err.message}`);
    }
  }

  #roleActive(s) {
    return Boolean(s.conn.isOpen && s.conn.isActivated && s.conn.hasRole('source'));
  }

  #onActivated(s, roles) {
    if (!roles.includes(SOURCE_ROLE)) {
      s.signal = null;
      if (s.roomId) this.stop(s.clientId);
    }
    this.#changed(s);
  }

  #onState(s, next, prev) {
    if (!next.available) {
      s.signal = null;
      if (s.roomId) this.stop(s.clientId);
      this.#changed(s);
      return;
    }
    if (s.startPending) this.#sendStart(s);
    const signal = next.roles?.source?.signal ?? null;
    const changed = signal !== null && (signal !== s.signal || prev?.available === false);
    s.signal = signal ?? s.signal;
    if (changed) this.#autoSwitch(s, signal);
    this.#changed(s);
  }

  #autoSwitch(s, signal) {
    const policy = this.#store.sourcePolicy(s.clientId);
    if (!policy?.autoSwitch) return;
    if (signal === 'absent' && s.roomId) {
      this.#log?.info?.(`[sendspin] ${s.clientId.slice(0, 8)} signal gone; stopping its line-in`);
      this.stop(s.clientId);
    } else if (signal === 'present' && !s.roomId && policy.roomId) {
      try {
        this.start(policy.roomId, s.clientId);
        this.#log?.info?.(`[sendspin] ${s.clientId.slice(0, 8)} signal present; line-in started`);
      } catch (err) {
        this.#log?.info?.(`[sendspin] auto-start of ${s.clientId.slice(0, 8)} failed: ${err.message}`);
      }
    }
  }

  #trustChanged(id) {
    const s = this.#sessions.get(id);
    if (s && s.roomId && !this.#store.isSourceAllowed(id)) this.stop(id);
    if (s) this.#changed(s);
    else this.emit('change', id);
  }

  #liveEnded(roomId, sourceId) {
    const s = this.#sessions.get(sourceId);
    if (s?.roomId === roomId) this.stop(sourceId);
  }

  #sendStart(s) {
    const c = s.conn;
    if (!c.sourceStateReceived || c.state?.available !== true) {
      s.startPending = true;
      return;
    }
    s.startPending = false;
    c.sourceCommand('start');
  }

  async allow(clientId, on) {
    if (on) {
      const ok = this.#server.isTrusted(clientId);
      if (!ok) {
        const d = this.#server.device(clientId);
        throw new SourceError(d.unpairedAccess ? 'not_approved' : 'pairing_required', 'approve or pair the device first');
      }
    }
    const changed = await this.#server.allowSource(clientId, on);
    if (!on) this.stop(clientId);
    this.emit('change', clientId);
    return changed;
  }

  async setAutoSwitch(clientId, on, roomId) {
    if (!this.#store.isSourceAllowed(clientId)) throw new SourceError('not_allowed', 'the device is not allowed as a source');
    await this.#store.setSourcePolicy(clientId, roomId === undefined ? { autoSwitch: on } : { autoSwitch: on, roomId });
    this.emit('change', clientId);
  }

  start(roomId, clientId) {
    if (!this.#store.isSourceAllowed(clientId)) throw new SourceError('not_allowed', 'the device is not allowed as a source');
    const s = this.#sessions.get(clientId);
    if (!s || !this.#roleActive(s)) throw new SourceError('not_connected', 'the source is not connected');
    if (s.conn.state?.available === false) throw new SourceError('unavailable', 'the source is in use elsewhere');
    if (s.roomId === roomId) return;
    if (s.roomId) this.stop(clientId);
    const room = this.#rooms.getRoom(roomId);
    if (!this.#server.setSourcePlayback(clientId, true)) throw new SourceError('not_allowed', 'the source cannot be used now');
    const name = this.#name(clientId);
    s.roomId = roomId;
    s.lastError = null;
    try {
      this.#rooms.playLive(room.id, { sourceId: clientId, name, feed: (track) => s.feed(track, { tickMs: this.#opts.tickMs }) });
    } catch (err) {
      s.roomId = null;
      this.#server.setSourcePlayback(clientId, false);
      throw err;
    }
    this.#store.setSourcePolicy(clientId, { roomId }).catch((err) => this.#log?.warn?.(`[sendspin] trust store update failed: ${err.message}`));
    this.#sendStart(s);
    this.#changed(s);
  }

  stop(clientId) {
    const s = this.#sessions.get(clientId);
    if (!s) return;
    const roomId = s.roomId;
    s.roomId = null;
    s.startPending = false;
    if (s.conn.isOpen && s.conn.isActivated && s.conn.hasRole('source')) {
      try {
        s.conn.sourceCommand('stop');
      } catch (err) {
        this.#log?.debug?.(`[sendspin] source stop: ${err.message}`);
      }
    }
    this.#server.setSourcePlayback(clientId, false);
    if (roomId) this.#safeRoom(() => this.#rooms.stopLive(roomId, clientId));
    this.#changed(s);
  }

  stopRoom(roomId) {
    for (const s of this.#sessions.values()) if (s.roomId === roomId) this.stop(s.clientId);
  }

  #name(clientId) {
    return this.#store.record(clientId)?.name ?? this.#store.approval(clientId)?.name ?? this.#sessions.get(clientId)?.conn.info?.name ?? clientId.slice(0, 8);
  }

  #changed(s) {
    this.emit('change', s.clientId);
  }

  session(clientId) {
    return this.#sessions.get(clientId) ?? null;
  }

  // Device-row view: null for a device that neither offers the role nor was allowed.
  view(clientId) {
    const s = this.#sessions.get(clientId);
    const policy = this.#store.sourcePolicy(clientId);
    if (!s && !policy) return null;
    const conn = s?.conn ?? null;
    return {
      allowed: Boolean(policy),
      roleActive: Boolean(s && this.#roleActive(s)),
      available: conn ? conn.state?.available !== false : false,
      signal: s?.signal ?? null,
      streaming: Boolean(s?.streaming),
      roomId: s?.roomId ?? null,
      autoSwitch: Boolean(policy?.autoSwitch),
      autoRoomId: policy?.roomId ?? null,
      lastError: s?.lastError ?? null,
      stats: s ? s.view() : null,
    };
  }

  // Sources a player can start: explicitly allowed and connected with the role active.
  list() {
    const out = [];
    for (const s of this.#sessions.values()) {
      if (!this.#store.isSourceAllowed(s.clientId) || !this.#roleActive(s)) continue;
      out.push({
        clientId: s.clientId,
        name: this.#name(s.clientId),
        available: s.conn.state?.available !== false,
        signal: s.signal,
        streaming: s.streaming,
        roomId: s.roomId,
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  close() {
    for (const s of [...this.#sessions.values()]) {
      if (s.roomId) this.stop(s.clientId);
      s.close();
    }
    this.#sessions.clear();
    for (const off of this.#unsub.splice(0)) off();
    this.removeAllListeners();
  }
}
