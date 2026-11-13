import crypto from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { ffmpegBin } from '../util/ffmpeg-bootstrap.js';
import { MASTER_BYTES_PER_SAMPLE } from './audio.js';

// A Sonos speaker cannot speak Sendspin and cannot be sample-synced. It follows a room instead: Velvet serves the
// room's master timeline as an endless MP3 radio stream, paced in real time, some lead ahead of what the room plays.
// How long the Sonos buffers before it plays varies (boot load, Wi-Fi), so Velvet measures it: GetPositionInfo's
// RelTime counts the seconds the Sonos has played of the stream, and the moment it ticks over pins down which frame
// it plays right then. The lead is then set so that frame sounds on the room's timeline; `trimMs` covers the
// Sonos's own output latency, which the network cannot see.

export const SONOS_RATE = 48_000;
export const SONOS_START_LEAD_MS = 2_000;
export const MAX_SONOS_LEAD_MS = 8_000;
export const MAX_SONOS_TRIM_MS = 1_000;
export const SONOS_CAL_FIRST_MS = 3_000;
export const SONOS_CAL_RETRY_MS = 2_000;
// A Sonos trims its start-up buffer in jumps during the first minutes: measure often then, rarely after.
export const SONOS_CAL_EARLY_MS = 5_000;
export const SONOS_CAL_EARLY_FOR_MS = 180_000;
export const SONOS_CAL_EVERY_MS = 30_000;
const CAL_PRE_EDGE_US = 120_000;
const CAL_WINDOW_US = 2_500_000;
const CAL_MAX_GAP_US = 80_000;
const CAL_TOLERANCE_US = 60_000;
const CAL_MAX_TRIES = 15;
export const SONOS_IDLE_MS = 30_000;
export const SONOS_TICK_MS = 20;
export const MAX_SONOS_PER_ROOM = 8;
export const SONOS_ID_PREFIX = 'sonos:';
export const STREAM_PATH = '/api/v1/rooms/sonos-stream/';
const MAX_FEEDS = 2;
const MAX_BACKLOG_BYTES = 2 * 1024 * 1024;
const MAX_CATCHUP_FRAMES = SONOS_RATE;
const KEEP_BEHIND_US = 1_000_000;
const ICY_METAINT = 16_000;
const OUT_FRAME_BYTES = 4;
const MASTER_FRAME_BYTES = MASTER_BYTES_PER_SAMPLE * 2;
const AVT = 'AVTransport';
const RC = 'RenderingControl';
const SERVICES = {
  [AVT]: { type: 'urn:schemas-upnp-org:service:AVTransport:1', path: '/MediaRenderer/AVTransport/Control' },
  [RC]: { type: 'urn:schemas-upnp-org:service:RenderingControl:1', path: '/MediaRenderer/RenderingControl/Control' },
};

// eslint-disable-next-line no-control-regex
const XML_BAD = /[\x00-\x08\x0B\x0C\x0E-\x1F\uD800-\uDFFF￾￿]/g;
export const xmlEsc = (s) => String(s ?? '').replaceAll(XML_BAD, '').replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');

export const isPrivateLan = (ip) => /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)\d{1,3}\.\d{1,3}(\.\d{1,3})?$/.test(String(ip));
const isLoopback = (ip) => ip === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip);
export function sonosStreamPeerAllowed(remoteAddress, { loopback = false } = {}) {
  const peer = String(remoteAddress || '').replace(/^::ffff:/, '');
  return isPrivateLan(peer) || (loopback && isLoopback(peer));
}
export const isSonosUuid = (s) => typeof s === 'string' && /^RINCON_[0-9A-Fa-f]{12,20}$/.test(s);

export function createSonosSoap({ port = 1400, allowHost = isPrivateLan, timeoutMs = 6000 } = {}) {
  return (ip, service, action, inner = '') => new Promise((resolve, reject) => {
    if (!allowHost(ip)) {
      reject(new Error(`${ip} is not a private LAN address`));
      return;
    }
    const svc = SERVICES[service];
    const body = '<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"'
      + ' s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>'
      + `<u:${action} xmlns:u="${svc.type}"><InstanceID>0</InstanceID>${inner}</u:${action}></s:Body></s:Envelope>`;
    const req = http.request({
      hostname: ip, port, path: svc.path, method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset="utf-8"', 'Content-Length': Buffer.byteLength(body), soapaction: `"${svc.type}#${action}"` },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        if (data.length < 64 * 1024) data += c;
      });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          const code = data.match(/<errorCode>(\d+)<\/errorCode>/i)?.[1];
          const upnp = code ? ` (UPnP ${code})` : '';
          reject(new Error(`Sonos ${action} HTTP ${res.statusCode}${upnp}`));
        } else {
          resolve(data);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Sonos ${action} timed out`)));
    req.end(body);
  });
}

export function mp3Encoder({ ffmpeg = ffmpegBin(), bitrate = '320k' } = {}) {
  // CBR at 48 kHz: one MP3 frame is 1152 samples and exactly 144 * bitrate / rate bytes (no padding at 48 kHz).
  const frameBytes = 144 * Number.parseInt(bitrate, 10) * 1000 / SONOS_RATE;
  const proc = spawn(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-probesize', '32', '-analyzeduration', '0', '-f', 's16le', '-ar', String(SONOS_RATE), '-ac', '2', '-i', 'pipe:0',
    '-c:a', 'libmp3lame', '-b:a', bitrate, '-id3v2_version', '0', '-write_xing', '0', '-flush_packets', '1', '-f', 'mp3', 'pipe:1',
  ], { stdio: ['pipe', 'pipe', 'ignore'] });
  proc.stdin.on('error', () => {});
  proc.on('error', () => {});
  return { input: proc.stdin, output: proc.stdout, close: () => proc.kill('SIGKILL'), samplesAt: (bytes) => Math.floor(bytes / frameBytes) * 1152 };
}

// The PCM itself (s16le, 48 kHz stereo): what tests listen to.
export function rawEncoder() {
  const pass = new PassThrough();
  return { input: pass, output: pass, close: () => pass.destroy(), samplesAt: (bytes) => Math.floor(bytes / OUT_FRAME_BYTES) };
}

export function radioDidl({ title, artUrl = null }) {
  const art = artUrl ? `<upnp:albumArtURI>${xmlEsc(artUrl)}</upnp:albumArtURI>` : '';
  return '<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"'
    + ' xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/">'
    + `<item id="R:0/0/0" parentID="R:0/0" restricted="true"><dc:title>${xmlEsc(title)}</dc:title>${art}`
    + '<upnp:class>object.item.audioItem.audioBroadcast</upnp:class>'
    + '<desc id="cdudn" nameSpace="urn:schemas-rinconnetworks-com:metadata-1-0/">SA_RINCON65031_</desc></item></DIDL-Lite>';
}

// Sonos plays endless MP3 over plain HTTP as internet radio; https stays a plain URL.
export function transportUri(url) {
  return url.startsWith('http://') ? `x-rincon-mp3radio://${url.slice('http://'.length)}` : url;
}

export function icyBlock(text) {
  const s = Buffer.from(`StreamTitle='${String(text ?? '').replaceAll('\'', '’').replaceAll(';', ',')}';`, 'utf8')
    .subarray(0, 255 * 16);
  const n = Math.ceil(s.length / 16);
  const out = Buffer.alloc(1 + n * 16);
  out[0] = n;
  s.copy(out, 1);
  return out;
}

// Interleaves ICY metadata every ICY_METAINT bytes; the title block is sent once per change.
// onChange(audioBytes) reports where in the audio a changed title takes effect: a Sonos restarts its RelTime there.
class IcyWriter {
  #left = ICY_METAINT;
  #sent = null;
  #audio = 0;
  #title;
  #onChange;

  constructor(title, onChange = null) {
    this.#title = title;
    this.#onChange = onChange;
  }

  wrap(chunk) {
    const parts = [];
    let at = 0;
    while (chunk.length - at >= this.#left) {
      parts.push(chunk.subarray(at, at + this.#left));
      at += this.#left;
      this.#audio += this.#left;
      this.#left = ICY_METAINT;
      const t = this.#title();
      if (t !== this.#sent && this.#sent !== null) this.#onChange?.(this.#audio);
      parts.push(t === this.#sent ? Buffer.alloc(1) : icyBlock(t));
      this.#sent = t;
    }
    parts.push(chunk.subarray(at));
    this.#audio += chunk.length - at;
    this.#left -= chunk.length - at;
    return Buffer.concat(parts);
  }
}

// The room's master PCM, kept from the GroupStream tap ('epoch', 'pcm', 'cut', 'stop') for the feeds to read by
// audible time. Items are never mutated by the scheduler; a cut drops what follows it.
export class PcmTap {
  #stream = null;
  #items = [];
  #rate = SONOS_RATE;
  #now;
  #handlers = {
    epoch: ({ rate }) => {
      this.#rate = rate;
      this.#items = [];
    },
    pcm: (item) => this.#push(item),
    cut: (sample) => this.#cut(sample),
    stop: () => {
      this.#items = [];
    },
  };

  constructor({ now }) {
    this.#now = now;
  }

  get attached() {
    return this.#stream !== null;
  }

  attach(stream) {
    if (this.#stream === stream) return;
    this.detach();
    this.#stream = stream;
    for (const [ev, fn] of Object.entries(this.#handlers)) stream.on(ev, fn);
    this.#items = [];
    if (stream.playing && stream.masterRate) {
      this.#rate = stream.masterRate;
      for (const item of stream.pcmHistory ?? []) this.#push(item);
    }
  }

  detach() {
    if (!this.#stream) return;
    for (const [ev, fn] of Object.entries(this.#handlers)) this.#stream.off(ev, fn);
    this.#stream = null;
    this.#items = [];
  }

  #push(item) {
    const end = item.sample + item.pcm.length / MASTER_FRAME_BYTES;
    const lastEnd = this.#items.length ? this.#items.at(-1).end : -Infinity;
    if (end <= lastEnd) return;
    const from = Math.max(0, lastEnd - item.sample);
    this.#items.push({ sample: item.sample + from, end, pcm: from ? item.pcm.subarray(from * MASTER_FRAME_BYTES) : item.pcm });
    this.#prune();
  }

  #cut(sample) {
    const keep = [];
    for (const it of this.#items) {
      if (it.end <= sample) keep.push(it);
      else if (it.sample < sample) keep.push({ sample: it.sample, end: sample, pcm: it.pcm.subarray(0, (sample - it.sample) * MASTER_FRAME_BYTES) });
    }
    this.#items = keep;
  }

  #prune() {
    const t0 = this.#stream?.t0;
    if (t0 === null || t0 === undefined) return;
    const keepFrom = Math.floor((this.#now() - t0 - KEEP_BEHIND_US) * this.#rate / 1_000_000);
    let n = 0;
    while (n < this.#items.length - 1 && this.#items[n].end <= keepFrom) n++;
    if (n) this.#items.splice(0, n);
  }

  #find(i, hint) {
    const items = this.#items;
    let j = Math.min(Math.max(hint, 0), items.length - 1);
    while (j > 0 && items[j].sample > i) j--;
    while (j < items.length - 1 && items[j].end <= i) j++;
    return j;
  }

  // `frames` stereo s16le frames at SONOS_RATE, the first one heard (in the room) at startUs. Silence where the room
  // plays nothing: before t0, between epochs, past the decode, or what was already pruned.
  read(startUs, frames) {
    const out = Buffer.alloc(frames * OUT_FRAME_BYTES);
    const t0 = this.#stream?.t0;
    if (t0 === null || t0 === undefined || !this.#items.length) return out;
    const rate = this.#rate;
    const step = rate / SONOS_RATE;
    const s0 = (startUs - t0) * rate / 1_000_000;
    const exact = rate === SONOS_RATE;
    let j = this.#find(Math.floor(s0), 0);
    const at = (i, ch) => {
      j = this.#find(i, j);
      const it = this.#items[j];
      if (i < it.sample || i >= it.end || i < 0) return 0;
      return it.pcm.readInt32LE((i - it.sample) * MASTER_FRAME_BYTES + ch * MASTER_BYTES_PER_SAMPLE) / 65536;
    };
    for (let k = 0; k < frames; k++) {
      const s = exact ? Math.round(s0) + k : s0 + k * step;
      const i = Math.floor(s);
      const frac = s - i;
      for (let ch = 0; ch < 2; ch++) {
        let v = at(i, ch);
        if (frac) v += (at(i + 1, ch) - v) * frac;
        out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v))), k * OUT_FRAME_BYTES + ch * 2);
      }
    }
    return out;
  }
}

// One HTTP connection from the Sonos: real-time paced, stream frame n carries the room's audio for
// shiftUs + n / SONOS_RATE. A lead change moves shiftUs, so the next frames skip ahead or fall back. `#marks` maps
// the frames actually sent (what the Sonos counts) to the timeline, across shifts and catch-up skips.
class Feed {
  #tap;
  #now;
  #enc;
  #res;
  #timer;
  #startUs;
  #shiftUs;
  #written = 0;
  #sent = 0;
  #marks;
  // Where RelTime may count from: the stream start (the absolute reference) and each title change. Where exactly a
  // Sonos restarts its counter at a title change varies by a few MP3 frames, so a change's bias is learned once,
  // from the measurement just before it.
  #origins = [{ at: 0, biasUs: 0 }];
  #onClose;
  closed = false;
  closeReason = null;
  bytes = 0;

  constructor({ tap, now, encoder, res, delayUs, icyTitle, onClose }) {
    this.#tap = tap;
    this.#now = now;
    this.#enc = encoder;
    this.#res = res;
    this.#onClose = onClose;
    this.#startUs = now();
    this.#shiftUs = this.#startUs + delayUs;
    this.#marks = [{ sent: 0, written: 0, shiftUs: this.#shiftUs }];
    const icy = icyTitle ? new IcyWriter(icyTitle, (bytes) => {
      this.#origins.push({ at: encoder.samplesAt?.(bytes) ?? 0, biasUs: null });
      if (this.#origins.length > 32) this.#origins.splice(1, 1);
    }) : null;
    encoder.output.on('data', (chunk) => {
      if (this.closed) return;
      this.bytes += chunk.length;
      if (!res.write(icy ? icy.wrap(chunk) : chunk)) encoder.output.pause();
    });
    encoder.output.on('end', () => this.close());
    encoder.output.on('error', () => this.close());
    res.on('drain', () => encoder.output.resume());
    res.on('close', () => this.close());
    this.#timer = setInterval(() => this.#tick(), SONOS_TICK_MS);
    this.#timer.unref?.();
    this.#tick();
  }

  shift(deltaUs) {
    this.#shiftUs += deltaUs;
    this.#mark();
  }

  get leadUs() {
    return this.#shiftUs - this.#startUs;
  }

  get sentFrames() {
    return this.#sent;
  }

  get ageUs() {
    return this.#now() - this.#startUs;
  }

  // Where the Sonos's RelTime may start counting: [{ at: samples, biasUs }], the stream start first.
  get origins() {
    return this.#origins;
  }

  // The room time carried by the n-th frame sent on this connection.
  timelineUs(n) {
    let m = this.#marks[0];
    for (const x of this.#marks) if (x.sent <= n) m = x;
    return m.shiftUs + (m.written + n - m.sent) * 1_000_000 / SONOS_RATE;
  }

  #mark() {
    const last = this.#marks.at(-1);
    const m = { sent: this.#sent, written: this.#written, shiftUs: this.#shiftUs };
    if (last.sent === m.sent) this.#marks[this.#marks.length - 1] = m;
    else this.#marks.push(m);
    if (this.#marks.length > 64) this.#marks.splice(1, 1);
  }

  #tick() {
    if (this.closed) return;
    const target = Math.floor((this.#now() - this.#startUs) * SONOS_RATE / 1_000_000);
    if (target - this.#written > MAX_CATCHUP_FRAMES) {
      this.#written = target - MAX_CATCHUP_FRAMES;
      this.#mark();
    }
    const frames = target - this.#written;
    if (frames <= 0) return;
    const startUs = this.#shiftUs + this.#written * 1_000_000 / SONOS_RATE;
    this.#written = target;
    this.#sent += frames;
    if (this.#enc.input.writableLength > MAX_BACKLOG_BYTES) {
      this.close('encoder backlog');
      return;
    }
    this.#enc.input.write(this.#tap.read(startUs, frames));
  }

  close(reason = null) {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    clearInterval(this.#timer);
    this.#enc.close();
    this.#res.destroy();
    this.#onClose(this);
  }
}

export const sonosId = (uuid) => SONOS_ID_PREFIX + uuid;

// GetPositionInfo's RelTime ("H:MM:SS") in whole seconds; null when absent or NOT_IMPLEMENTED.
export function parseRelTime(body) {
  const m = /<RelTime>(\d+):(\d{2}):(\d{2})<\/RelTime>/.exec(body ?? '');
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}

// The Sonos followers of one room. bridge: { soap(ip, service, action, inner), resolve(uuid, ip) -> {ip,name}|null,
// streamUrl(base, token), enabled() }; null, or enabled() false (Sonos switched off in
// Velvet), keeps the entries (persisted) dormant: no speaker driven, no tap, no lead, not playable.
export class RoomSonos {
  #bridge;
  #now;
  #log;
  #opts;
  #info;
  #onChange;
  #tap;
  #stream = null;
  #playing = false;
  #dormant = false;
  #followers = new Map();
  #onEpoch = () => this.#roomPlaying();
  #onStop = () => this.#roomHalted();

  constructor({
    bridge, now, logger = null, ffmpeg, encoder = null, idleMs = SONOS_IDLE_MS, info, onChange,
    calFirstMs = SONOS_CAL_FIRST_MS, calRetryMs = SONOS_CAL_RETRY_MS, calEveryMs = SONOS_CAL_EVERY_MS,
    calEarlyMs = SONOS_CAL_EARLY_MS, calEarlyForMs = SONOS_CAL_EARLY_FOR_MS,
  }) {
    this.#bridge = bridge;
    this.#now = now;
    this.#log = logger;
    this.#opts = { ffmpeg, encoder, idleMs, calFirstMs, calRetryMs, calEveryMs, calEarlyMs, calEarlyForMs };
    this.#info = info;
    this.#onChange = onChange;
    this.#tap = new PcmTap({ now });
  }

  get size() {
    return this.#followers.size;
  }

  get active() {
    return Boolean(this.#bridge) && this.#bridge.enabled?.() !== false;
  }

  get maxLeadMs() {
    let max = 0;
    for (const f of this.#followers.values()) max = Math.max(max, f.leadMs);
    return max;
  }

  has(uuid) {
    return this.#followers.has(uuid);
  }

  // The room's lifecycle comes from its GroupStream: every play/seek/skip is an 'epoch', a halt is a 'stop'.
  setStream(stream) {
    if (this.#stream === stream) return;
    this.#stream?.off('epoch', this.#onEpoch).off('stop', this.#onStop);
    this.#stream = stream;
    stream.on('epoch', this.#onEpoch).on('stop', this.#onStop);
    this.#sync();
    if (stream.playing) this.#onEpoch();
  }

  add({ uuid, name, ip, base, trimMs = 0 }) {
    let f = this.#followers.get(uuid);
    if (!f) {
      f = {
        uuid, name, ip, base, trimMs, leadMs: SONOS_START_LEAD_MS + trimMs, measured: false, lateMs: null,
        volume: null, muted: null, session: null, state: 'idle', error: null,
      };
      this.#followers.set(uuid, f);
    } else {
      Object.assign(f, { name: name ?? f.name, ip: ip ?? f.ip, base: base ?? f.base });
      if (trimMs !== f.trimMs) this.setTrim(uuid, trimMs);
    }
    this.#sync();
    if (this.active) {
      this.#refresh(f);
      if (this.#playing && !f.session) this.#start(f);
    }
    return f;
  }

  remove(uuid) {
    const f = this.#followers.get(uuid);
    if (!f) return false;
    this.#followers.delete(uuid);
    this.#end(f, { stop: true });
    this.#sync();
    return true;
  }

  setTrim(uuid, trimMs) {
    const f = this.#followers.get(uuid);
    if (!f) return false;
    this.#moveLead(f, (trimMs - f.trimMs) * 1000);
    f.trimMs = trimMs;
    this.#sync();
    return true;
  }

  #moveLead(f, deltaUs) {
    const lead = Math.max(0, Math.min(MAX_SONOS_LEAD_MS * 1000, f.leadMs * 1000 + deltaUs));
    const d = lead - f.leadMs * 1000;
    f.leadMs = Math.round(lead / 1000);
    for (const feed of f.session?.feeds ?? []) feed.shift(d);
  }

  #calLater(f, s, ms) {
    clearTimeout(s.calTimer);
    s.calTimer = setTimeout(() => this.#calibrate(f, s), ms);
    s.calTimer.unref?.();
  }

  // The next regular measurement, timed to start just before RelTime is expected to tick over again.
  #calNext(f, s, feed) {
    const ms = feed.ageUs < this.#opts.calEarlyForMs * 1000 ? this.#opts.calEarlyMs : this.#opts.calEveryMs;
    let at = this.#now() + ms * 1000;
    if (s.lastEdgeUs != null) at = s.lastEdgeUs + Math.ceil((at - s.lastEdgeUs) / 1_000_000) * 1_000_000 - CAL_PRE_EDGE_US;
    this.#calLater(f, s, Math.max(0, (at - this.#now()) / 1000));
  }

  // RelTime counts from the stream start or from the last title change the Sonos has played past. An origin it
  // cannot have reached yet would put it beyond what was sent; of the rest, the one nearest to in sync is it
  // (its own jumps are under a second, a wrong origin is off by a whole song).
  #lateness(f, feed, edge) {
    const origins = feed.origins;
    let best = null;
    for (let i = 0; i < origins.length; i++) {
      const pos = origins[i].at + edge.relSec * SONOS_RATE;
      if (pos > feed.sentFrames) continue;
      const rawUs = edge.atUs - feed.timelineUs(pos) + f.trimMs * 1000;
      const lateUs = rawUs + (origins[i].biasUs ?? 0);
      if (Math.abs(lateUs) <= MAX_SONOS_LEAD_MS * 1000 && (!best || Math.abs(lateUs) < Math.abs(best.lateUs))) best = { lateUs, rawUs, origin: i };
    }
    // First time on a title change: it continues where the last measurement left off (the Sonos did not jump
    // because a title changed); from then on it is measured like the stream start.
    if (best && origins[best.origin].biasUs === null) {
      const before = f.session?.lastLateUs;
      origins[best.origin].biasUs = before == null ? 0 : before - best.rawUs;
      best.lateUs = best.rawUs + origins[best.origin].biasUs;
    }
    return best;
  }

  async #calibrate(f, s) {
    if (f.session !== s || !this.active) return;
    const feed = [...s.feeds].at(-1);
    if (!feed || feed.closed) return;
    const edge = await this.#findEdge(f, s);
    if (f.session !== s || feed.closed) return;
    if (!edge) {
      s.calTries = (s.calTries ?? 0) + 1;
      if (s.calTries < CAL_MAX_TRIES) this.#calLater(f, s, this.#opts.calRetryMs);
      else this.#log?.info?.(`[rooms] Sonos ${f.name}: no position to measure; keeping a ${f.leadMs} ms lead`);
      return;
    }
    s.calTries = 0;
    s.lastEdgeUs = edge.atUs;
    // The Sonos plays stream position origin + relSec at edge.atUs; it should sound trimMs later at that frame's room time.
    const found = this.#lateness(f, feed, edge);
    if (!found) {
      this.#log?.info?.(`[rooms] Sonos ${f.name}: no plausible position (RelTime ${edge.relSec} s); measuring again`);
      s.lastEdgeUs = null;
      this.#calLater(f, s, this.#opts.calRetryMs);
      return;
    }
    const { lateUs } = found;
    const since = found.origin ? `title change ${found.origin}` : 'stream start';
    s.lastLateUs = lateUs;
    f.lateMs = Math.round(lateUs / 1000);
    f.measured = true;
    if (Math.abs(lateUs) >= CAL_TOLERANCE_US) {
      const before = f.leadMs;
      this.#moveLead(f, lateUs);
      s.lastLateUs = 0;
      this.#log?.info?.(`[rooms] Sonos ${f.name} was ${Math.abs(f.lateMs)} ms ${lateUs > 0 ? 'late' : 'early'}; lead ${before} → ${f.leadMs} ms (RelTime ${edge.relSec} s since ${since})`);
      this.#sync();
      this.#onChange();
      s.lastEdgeUs = null;
      this.#calLater(f, s, f.leadMs + this.#opts.calFirstMs);
      return;
    }
    this.#log?.debug?.(`[rooms] Sonos ${f.name} in sync (${f.lateMs} ms), lead ${f.leadMs} ms, RelTime ${edge.relSec} s since ${since}`);
    this.#onChange();
    this.#calNext(f, s, feed);
  }

  // Polls RelTime back to back until it ticks over; the tick lies between the two polls' midpoints.
  async #findEdge(f, s) {
    const end = this.#now() + CAL_WINDOW_US;
    let prev = null;
    let prevMid = 0;
    while (this.#now() < end && f.session === s) {
      const sent = this.#now();
      const body = await this.#soap(f, AVT, 'GetPositionInfo');
      const mid = (sent + this.#now()) / 2;
      const rel = parseRelTime(body);
      if (rel === null) return null;
      if (prev !== null && rel === prev + 1 && mid - prevMid <= CAL_MAX_GAP_US) return { relSec: rel, atUs: (prevMid + mid) / 2 };
      prev = rel;
      prevMid = mid;
    }
    return null;
  }

  #roomPlaying() {
    const was = this.#playing;
    this.#playing = true;
    // Every play/seek/skip re-reads whether Sonos is enabled: switching it on or off takes effect there.
    this.#sync();
    for (const f of this.#followers.values()) {
      if (f.session) {
        clearTimeout(f.session.idleTimer);
        f.session.idleTimer = null;
      }
      // Seek, skip and jump keep the stream; a fresh play takes the Sonos back if it was switched away meanwhile.
      if (this.active && !was && (!f.session || (!f.session.feeds.size && f.state !== 'starting'))) this.#start(f);
    }
  }

  #roomHalted() {
    this.#playing = false;
    for (const f of this.#followers.values()) {
      const s = f.session;
      if (!s || s.idleTimer) continue;
      s.idleTimer = setTimeout(() => {
        if (!this.#playing && f.session === s) this.#end(f, { stop: true });
      }, this.#opts.idleMs);
      s.idleTimer.unref?.();
    }
  }

  close({ stop = true } = {}) {
    this.#playing = false;
    for (const f of this.#followers.values()) this.#end(f, { stop });
    this.#tap.detach();
    this.#stream?.off('epoch', this.#onEpoch).off('stop', this.#onStop);
    this.#stream = null;
  }

  sessionFor(token) {
    if (typeof token !== 'string' || !token) return null;
    for (const f of this.#followers.values()) {
      const t = f.session?.token;
      if (t && t.length === token.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(token))) return f;
    }
    return null;
  }

  // GET of the stream URL by the Sonos. The token only lives while this Sonos is a member with a session.
  serve(f, req, res) {
    const s = f.session;
    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'no-cache, no-store',
      'icy-name': this.#info().roomName,
      ...(req.headers['icy-metadata'] === '1' ? { 'icy-metaint': String(ICY_METAINT) } : {}),
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const make = this.#opts.encoder ?? (() => mp3Encoder({ ffmpeg: this.#opts.ffmpeg }));
    const feed = new Feed({
      tap: this.#tap, now: this.#now, encoder: make(), res, delayUs: f.leadMs * 1000,
      icyTitle: req.headers['icy-metadata'] === '1' ? () => this.#title() : null,
      onClose: (x) => {
        this.#log?.info?.(`[rooms] Sonos ${f.name} stream connection closed after ${Math.round(x.bytes / 1024)} KiB (${x.closeReason ?? 'peer'})`);
        s.feeds.delete(x);
        if (f.session === s && !s.feeds.size && f.state === 'streaming') {
          f.state = 'waiting';
          this.#onChange();
        }
      },
    });
    s.feeds.add(feed);
    this.#log?.info?.(`[rooms] Sonos ${f.name} opened a stream connection (${s.feeds.size} open), lead ${f.leadMs} ms`);
    if (s.feeds.size > MAX_FEEDS) [...s.feeds][0].close('replaced');
    s.calTries = 0;
    s.lastEdgeUs = null;
    s.lastLateUs = null;
    this.#calLater(f, s, this.#opts.calFirstMs);
    f.state = 'streaming';
    f.error = null;
    this.#onChange();
  }

  volumes() {
    return [...this.#followers.values()].map((f) => ({ id: sonosId(f.uuid), volume: f.volume, muted: f.muted }));
  }

  setVolume(uuid, volume) {
    const f = this.#followers.get(uuid);
    if (!f || !this.active) return;
    f.volume = volume;
    this.#soap(f, RC, 'SetVolume', `<Channel>Master</Channel><DesiredVolume>${volume}</DesiredVolume>`);
  }

  setMute(uuid, muted) {
    const f = this.#followers.get(uuid);
    if (!f || !this.active) return;
    f.muted = muted;
    this.#soap(f, RC, 'SetMute', `<Channel>Master</Channel><DesiredMute>${muted ? 1 : 0}</DesiredMute>`);
  }

  view() {
    const dormant = !this.active;
    return [...this.#followers.values()].map((f) => ({
      id: sonosId(f.uuid), uuid: f.uuid, name: f.name, ip: f.ip, trimMs: f.trimMs, leadMs: f.measured ? f.leadMs : null,
      volume: f.volume, muted: f.muted,
      state: f.state, error: f.error, dormant,
    }));
  }

  toJSON() {
    return [...this.#followers.values()].map((f) => ({ uuid: f.uuid, name: f.name, ip: f.ip, base: f.base, trimMs: f.trimMs }));
  }

  #sync() {
    const active = this.active;
    const on = active && this.#followers.size > 0;
    if (this.#stream) this.#stream.tapLeadUs = on ? this.maxLeadMs * 1000 : 0;
    if (this.#stream && on) this.#tap.attach(this.#stream);
    else this.#tap.detach();
    const woke = active && this.#dormant;
    this.#dormant = !active;
    if (!active) for (const f of this.#followers.values()) this.#end(f, { stop: false });
    else if (woke && this.#playing) for (const f of this.#followers.values()) if (!f.session) this.#start(f);
  }

  #title() {
    const i = this.#info();
    return [i.artist, i.title].filter(Boolean).join(' - ') || i.roomName;
  }

  #soap(f, service, action, inner) {
    return this.#bridge.soap(f.ip, service, action, inner).catch((err) => {
      this.#log?.debug?.(`[rooms] Sonos ${f.name} ${action}: ${err.message}`);
      return null;
    });
  }

  async #refresh(f) {
    const vol = await this.#soap(f, RC, 'GetVolume', '<Channel>Master</Channel>');
    const mute = await this.#soap(f, RC, 'GetMute', '<Channel>Master</Channel>');
    const v = Number(vol?.match(/<CurrentVolume>(\d+)<\/CurrentVolume>/)?.[1]);
    const m = mute?.match(/<CurrentMute>([01])<\/CurrentMute>/)?.[1];
    let changed = false;
    if (Number.isInteger(v) && v !== f.volume) [f.volume, changed] = [Math.min(100, v), true];
    if (m !== undefined && (m === '1') !== f.muted) [f.muted, changed] = [m === '1', true];
    if (changed) this.#onChange();
  }

  async #start(f) {
    const prev = f.session;
    if (prev) this.#end(f, { stop: false });
    const token = crypto.randomBytes(24).toString('base64url');
    const s = { token, feeds: new Set(), idleTimer: null, calTimer: null, calTries: 0, lastEdgeUs: null, lastLateUs: null };
    f.session = s;
    f.state = 'starting';
    f.error = null;
    const loc = this.#bridge.resolve(f.uuid, f.ip);
    if (loc?.ip && loc.ip !== f.ip) f.ip = loc.ip;
    if (loc?.name) f.name = loc.name;
    this.#onChange();
    const i = this.#info();
    const url = this.#bridge.streamUrl(f.base, token);
    // A radio stream's cover is read once, when it is set: point it at the session's art URL, which always answers
    // with the cover of the song playing now (the Sonos picks it up whenever it loads the cover again).
    const didl = radioDidl({ title: [i.roomName, 'Velvet Rooms'].join(' · '), artUrl: url.replace(/\.mp3$/, '.jpg') });
    try {
      await this.#bridge.soap(f.ip, AVT, 'SetAVTransportURI',
        `<CurrentURI>${xmlEsc(transportUri(url))}</CurrentURI><CurrentURIMetaData>${xmlEsc(didl)}</CurrentURIMetaData>`);
      if (f.session !== s) return;
      await this.#bridge.soap(f.ip, AVT, 'Play', '<Speed>1</Speed>');
      if (f.session !== s) return;
      if (f.state === 'starting') f.state = 'waiting';
      this.#log?.info?.(`[rooms] Sonos ${f.name} follows "${i.roomName}"`);
    } catch (err) {
      if (f.session !== s) return;
      this.#log?.warn?.(`[rooms] Sonos ${f.name} could not start: ${err.message}`);
      this.#end(f, { stop: false });
      f.state = 'error';
      f.error = err.message;
    }
    this.#onChange();
  }

  // Stop only what is still ours: the Sonos may have been switched to something else meanwhile.
  #end(f, { stop }) {
    const s = f.session;
    if (!s) return;
    f.session = null;
    f.state = 'idle';
    clearTimeout(s.idleTimer);
    clearTimeout(s.calTimer);
    for (const feed of [...s.feeds]) feed.close('session ended');
    if (stop && this.active) {
      this.#soap(f, AVT, 'GetMediaInfo').then((info) => {
        if (info?.includes(s.token)) this.#soap(f, AVT, 'Stop');
      });
    }
    this.#onChange();
  }
}

const trimSlash = (s) => {
  let end = s.length;
  while (end > 0 && s[end - 1] === '/') end--;
  return s.slice(0, end);
};

export function streamUrlFor(base, token) {
  return `${trimSlash(String(base))}${STREAM_PATH}${token}.mp3`;
}
