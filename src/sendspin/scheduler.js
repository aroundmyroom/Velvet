import { EventEmitter } from 'node:events';
import {
  createEncoder, decodeQueue, samplesToUs, MASTER_BYTES_PER_SAMPLE, OPUS_SAMPLE_RATES, opusPreRoll,
} from './audio.js';
import { AUDIO_HEADER_LEN } from './wire.js';

export const MIN_LEAD_FLOOR_MS = 50;
export const MAX_LEAD_MS = 10_000;
export const SAFETY_MS = 50;
export const LATE_JOIN_MIN_LEAD_MS = 100;
export const JOIN_MARGIN_MS = 150;
export const LOW_WATER_MS = 2_000;
export const READ_AHEAD_MS = 15_000;
export const HISTORY_KEEP_MS = 1_000;
// A tail change keeps this much beyond the send-ahead: room for one whole chunk (<= 150 ms) before the cut.
export const SPLICE_MARGIN_MS = 200;
// How often a member held back only by bytes still queued in its socket is re-checked.
export const SOCKET_POLL_MS = 10;
export const MASTER_CHANNELS = 2;
export const DEFAULT_MASTER_RATE = 48_000;

export function serverNow() {
  return Number(process.hrtime.bigint() / 1000n);
}

export function producible(f) {
  if (f.codec === 'opus') return (f.channels === 1 || f.channels === 2) && OPUS_SAMPLE_RATES.includes(f.sample_rate);
  return (f.codec === 'pcm' || f.codec === 'flac') && (f.bit_depth === 16 || f.bit_depth === 24)
    && (f.channels === 1 || f.channels === 2) && Number.isInteger(f.sample_rate)
    && f.sample_rate >= 8000 && f.sample_rate <= 192_000;
}

export function sameFormat(a, b) {
  return Boolean(a && b) && a.codec === b.codec && a.sample_rate === b.sample_rate
    && a.channels === b.channels && (a.codec === 'opus' || a.bit_depth === b.bit_depth);
}

// bit_depth is ignored for opus but stream/start still carries one; 16 as aiosendspin sends.
const pickFormat = (f) => ({
  codec: f.codec, sample_rate: f.sample_rate, channels: f.channels, bit_depth: f.codec === 'opus' ? 16 : f.bit_depth,
});

export function negotiateFormat(member) {
  const formats = member.info?.player?.supportedFormats ?? [];
  const pref = member.state?.player?.format;
  if (pref && producible(pref) && formats.some((f) => sameFormat(f, pref))) return pickFormat(pref);
  const f = formats.find(producible);
  return f ? pickFormat(f) : null;
}

// Live audio gets no extension toward required_lead_time_ms: it would only add latency (spec, send constraints).
export function memberLeadUs(member, live = false) {
  const p = member.state.player;
  const lead = Math.max(p.minBufferMs, live ? 0 : Math.min(p.requiredLeadTimeMs, MAX_LEAD_MS), MIN_LEAD_FLOOR_MS);
  return (lead + p.outputDelayMs) * 1000;
}

const usToSamples = (us, rate) => Math.ceil(us * rate / 1_000_000);
const hasPlayerStream = (member) => member.activeStreams.includes('player');

function streamFormat(format, encoder) {
  const p = pickFormat(format);
  if (encoder.codecHeader) p.codec_header = encoder.codecHeader;
  return p;
}

export class GroupStream extends EventEmitter {
  #now;
  #ffmpeg;
  #log;
  #opts;
  #members = new Map();
  #epoch = null;
  #timer = null;
  #kickQueued = false;
  // Followers outside the Sendspin buffer model (Sonos, see sonos.js) hear the timeline this much later: t0 and the
  // decode stay this far ahead so they get every sample in time.
  #tapLeadUs = 0;

  constructor({
    now = serverNow, ffmpeg, logger = null, masterRate = null, chunkMs = null,
    readAheadMs = READ_AHEAD_MS, lowWaterMs = LOW_WATER_MS, safetyMs = SAFETY_MS, joinMarginMs = JOIN_MARGIN_MS,
  } = {}) {
    super();
    this.#now = now;
    this.#ffmpeg = ffmpeg;
    this.#log = logger;
    this.#opts = {
      masterRate, chunkMs, readAheadUs: readAheadMs * 1000, lowWaterUs: lowWaterMs * 1000,
      safetyUs: safetyMs * 1000, joinMarginUs: joinMarginMs * 1000,
    };
  }

  get playing() {
    return this.#epoch !== null;
  }

  get memberIds() {
    return [...this.#members.keys()];
  }

  get t0() {
    return this.#epoch?.t0 ?? null;
  }

  get masterRate() {
    return this.#epoch?.rate ?? null;
  }

  get tapLeadUs() {
    return this.#tapLeadUs;
  }

  set tapLeadUs(us) {
    this.#tapLeadUs = Math.max(0, Math.round(us) || 0);
  }

  // Decoded master PCM not yet pruned (from about a second behind the playhead), for a tap that joins mid-timeline.
  get pcmHistory() {
    return this.#epoch ? this.#epoch.history.slice() : [];
  }

  get sendAheadUs() {
    let max = this.#tapLeadUs;
    const live = Boolean(this.#epoch?.live);
    for (const m of this.#members.values()) max = Math.max(max, memberLeadUs(m.member, live));
    return max + this.#opts.safetyUs;
  }

  has(clientId) {
    return this.#members.has(clientId);
  }

  formatOf(clientId) {
    return this.#members.get(clientId)?.format ?? null;
  }

  stats() {
    return [...this.#members.values()].map((m) => ({
      clientId: m.member.clientId, format: m.format, sentChunks: m.sentChunks, dropped: m.dropped,
      bufferedBytes: m.bytes, live: m.live,
    }));
  }

  addMember(member) {
    if (this.#members.has(member.clientId)) return true;
    const format = negotiateFormat(member);
    if (!format) {
      this.#log?.warn?.(`[sendspin] ${member.clientId.slice(0, 8)} offers no format we can produce`);
      return false;
    }
    const m = {
      member, format, seg: null, nextSample: 0, sentEndUs: 0, inflight: [], bytes: 0,
      live: false, sentChunks: 0, dropped: 0,
    };
    this.#members.set(member.clientId, m);
    const ep = this.#epoch;
    if (!ep) return true;
    if (ep.t0 === null) {
      this.#openFeed(m, 0, 0, 'start');
    } else {
      const lead = Math.max(memberLeadUs(member, Boolean(ep.live)), LATE_JOIN_MIN_LEAD_MS * 1000) + this.#opts.joinMarginUs;
      const start = Math.max(0, usToSamples(this.#now() + lead - ep.t0, ep.rate));
      this.#openFeed(m, start, samplesToUs(start, ep.rate), 'start');
    }
    return this.#members.has(member.clientId);
  }

  removeMember(clientId, { end = true } = {}) {
    const m = this.#members.get(clientId);
    if (!m) return;
    this.#members.delete(clientId);
    this.#closeFeed(m);
    if (end && m.member.isOpen !== false && hasPlayerStream(m.member)) {
      try {
        m.member.streamEnd(['player']);
      } catch (err) {
        this.#log?.debug?.(`[sendspin] stream/end to a leaving member failed: ${err.message}`);
      }
    }
    this.#kick();
  }

  memberChanged(clientId) {
    const m = this.#members.get(clientId);
    if (!m) return;
    const format = negotiateFormat(m.member);
    if (!format) {
      this.removeMember(clientId);
      this.emit('member-error', clientId, new Error('no producible format left'));
      return;
    }
    if (sameFormat(format, m.format)) {
      this.#kick();
      return;
    }
    m.format = format;
    const ep = this.#epoch;
    if (!ep || !m.seg) return;
    const oldOffset = m.seg.offsetUs;
    this.#closeFeed(m);
    const resumeUs = Math.max(m.sentEndUs, oldOffset);
    const first = ep.history[0]?.sample ?? 0;
    const start = Math.max(usToSamples(resumeUs, ep.rate), first);
    this.#openFeed(m, start, Math.max(resumeUs, samplesToUs(start, ep.rate)), 'format');
  }

  play(tracks) {
    this.#teardown();
    const rate = this.#chooseRate();
    const ep = {
      rate, frameBytes: MASTER_BYTES_PER_SAMPLE * MASTER_CHANNELS, ac: new AbortController(), t0: null,
      history: [], historyOffset: 0, decodedEnd: 0, decodeDone: false, boundaries: [], pendingTracks: [],
      waiter: null, ended: false, decodeGen: 0, decodeAc: null, splice: null,
      live: typeof tracks?.live === 'function' ? tracks.live : null,
    };
    this.#epoch = ep;
    for (const m of this.#members.values()) {
      m.inflight = [];
      m.bytes = 0;
      m.sentEndUs = 0;
      this.#openFeed(m, 0, 0, 'restart');
    }
    this.emit('epoch', { rate });
    this.#decode(ep, tracks);
  }

  stop() {
    const pos = this.position();
    if (!this.#epoch) return pos;
    this.#teardown();
    for (const m of [...this.#members.values()]) {
      m.inflight = [];
      m.bytes = 0;
      if (hasPlayerStream(m.member)) this.#call(m, () => m.member.streamEnd(['player']));
    }
    this.emit('stop');
    return pos;
  }

  // Replaces what plays after the current track without touching audible audio. makeTail(anchor, atUs) is called
  // synchronously with the track the new tail follows and the cut's audible time (null when nothing was announced
  // past it) and returns the new tracks. A cut already decoded and sent becomes stream/clear with from_timestamp;
  // otherwise the cut waits for the next track boundary of the running decode. -> false while nothing is decoded yet.
  replaceUpcoming(makeTail) {
    const ep = this.#epoch;
    if (!ep || !ep.boundaries.length) return false;
    let minSample = 1;
    if (ep.t0 !== null) {
      const minUs = this.#now() + this.sendAheadUs + SPLICE_MARGIN_MS * 1000 - ep.t0;
      minSample = Math.max(1, usToSamples(minUs, ep.rate));
    }
    const at = ep.boundaries.findIndex((b) => b.sample >= minSample);
    const cutAt = (anchor, cut) => {
      const atUs = ep.t0 === null ? null : ep.t0 + samplesToUs(cut, ep.rate);
      this.#cut(ep, cut, makeTail(anchor, atUs));
    };
    if (at > 0) cutAt(ep.boundaries[at - 1].track, ep.boundaries[at].sample);
    else if (ep.decodeDone) cutAt(ep.boundaries.at(-1).track, ep.decodedEnd);
    else ep.splice = makeTail(ep.boundaries.at(-1).track, null);
    return true;
  }

  close() {
    this.stop();
    for (const id of [...this.#members.keys()]) this.removeMember(id, { end: false });
  }

  position() {
    const ep = this.#epoch;
    if (!ep || !ep.boundaries.length) return null;
    const now = this.#now();
    const rel = ep.t0 === null ? 0 : Math.max(0, now - ep.t0);
    let sample = Math.floor(rel * ep.rate / 1_000_000);
    if (ep.decodeDone) sample = Math.min(sample, ep.decodedEnd);
    let b = ep.boundaries[0];
    for (const x of ep.boundaries) if (x.sample <= sample) b = x;
    const into = Math.max(0, sample - b.sample);
    return {
      track: b.track,
      positionMs: (b.track.startMs ?? 0) + Math.floor(samplesToUs(into, ep.rate) / 1000),
      atUs: now,
      audibleAtUs: ep.t0 === null ? null : ep.t0 + samplesToUs(b.sample, ep.rate),
    };
  }

  #chooseRate() {
    if (this.#opts.masterRate) return this.#opts.masterRate;
    const rates = new Set([...this.#members.values()].map((m) => m.format.sample_rate));
    return rates.size === 1 ? [...rates][0] : DEFAULT_MASTER_RATE;
  }

  #call(m, fn) {
    try {
      return fn();
    } catch (err) {
      this.#log?.warn?.(`[sendspin] ${m.member.clientId.slice(0, 8)} dropped from the stream: ${err.message}`);
      if (this.#members.get(m.member.clientId) === m) {
        this.#members.delete(m.member.clientId);
        this.#closeFeed(m);
        this.emit('member-error', m.member.clientId, err);
      }
      return undefined;
    }
  }

  #openFeed(m, startSample, offsetUs, kind) {
    const ep = this.#epoch;
    // Opus after a cut must not start before it: prime the encoder with the audio just before (see opusEmitter).
    const preRoll = m.format.codec === 'opus' && (kind === 'splice' || kind === 'format')
      ? Math.min(opusPreRoll(ep.rate, this.#opts.chunkMs ?? undefined), Math.max(0, startSample - (ep.history[0]?.sample ?? 0)))
      : null;
    const encoder = createEncoder({
      format: m.format, inputRate: ep.rate, inputChannels: MASTER_CHANNELS, baseUs: 0, preRoll,
      signal: ep.ac.signal, ffmpeg: this.#ffmpeg, ...(this.#opts.chunkMs ? { chunkMs: this.#opts.chunkMs } : {}),
    });
    const seg = { encoder, offsetUs, pending: [], done: false };
    m.seg = seg;
    m.nextSample = startSample - (preRoll ?? 0);
    m.sentEndUs = offsetUs;
    m.live = false;
    const player = streamFormat(m.format, encoder);
    const ok = this.#call(m, () => {
      const active = hasPlayerStream(m.member);
      if (kind === 'restart' && active) {
        m.member.streamClear({ roles: ['player'] });
        if (!sameFormat(m.streamFormat, m.format)) m.member.streamStart({ player });
      } else if (kind !== 'splice' || !active) {
        m.member.streamStart({ player });
      }
      return true;
    });
    if (!ok) return;
    m.streamFormat = m.format;
    this.#read(m, seg, ep);
    this.#catchUp(m, seg, ep);
  }

  #closeFeed(m) {
    if (!m.seg) return;
    m.seg.encoder.close();
    m.seg = null;
    m.live = false;
  }

  async #read(m, seg, ep) {
    try {
      for (let c = await seg.encoder.read(); c; c = await seg.encoder.read()) {
        if (m.seg !== seg) return;
        seg.pending.push(c);
        this.#kick();
      }
      if (m.seg !== seg) return;
      seg.done = true;
      this.#kick();
    } catch (err) {
      if (m.seg === seg && this.#epoch === ep) this.#fail(err);
    }
  }

  #feed(m, seg, item) {
    const ep = this.#epoch;
    const end = item.sample + item.pcm.length / ep.frameBytes;
    if (end <= m.nextSample) return undefined;
    const from = Math.max(0, m.nextSample - item.sample);
    m.nextSample = end;
    return seg.encoder.write(from ? item.pcm.subarray(from * ep.frameBytes) : item.pcm);
  }

  async #catchUp(m, seg, ep) {
    try {
      let seq = ep.historyOffset;
      for (;;) {
        if (m.seg !== seg || this.#epoch !== ep) return;
        if (seq < ep.historyOffset) seq = ep.historyOffset;
        const item = ep.history[seq - ep.historyOffset];
        if (!item) break;
        seq++;
        await this.#feed(m, seg, item);
      }
      m.live = true;
      if (ep.decodeDone) seg.encoder.end();
      this.#kick();
    } catch (err) {
      if (m.seg === seg && this.#epoch === ep) this.#fail(err);
    }
  }

  #current(ep, gen) {
    return this.#epoch === ep && ep.decodeGen === gen;
  }

  async #decode(ep, tracks, base = 0) {
    ep.decodeAc?.abort();
    const ac = new AbortController();
    ep.decodeAc = ac;
    const gen = ++ep.decodeGen;
    const waiter = ep.waiter;
    ep.waiter = null;
    waiter?.();
    try {
      const opts = { sampleRate: ep.rate, channels: MASTER_CHANNELS, signal: AbortSignal.any([ep.ac.signal, ac.signal]), ffmpeg: this.#ffmpeg };
      for await (const item of this.#source(ep, tracks, opts)) {
        if (!(await this.#take(ep, base ? { ...item, sample: item.sample + base } : item, gen))) return;
      }
      if (!this.#current(ep, gen)) return;
      if (ep.splice) {
        const tail = ep.splice;
        ep.splice = null;
        this.#decode(ep, tail, ep.decodedEnd);
        return;
      }
      ep.decodeDone = true;
      this.emit('pcm-end');
      for (const m of this.#members.values()) if (m.live && m.seg) m.seg.encoder.end();
      this.#kick();
    } catch (err) {
      if (this.#current(ep, gen) && !ep.ac.signal.aborted) this.#fail(err);
    }
  }

  #source(ep, tracks, opts) {
    return ep.live ? ep.live(opts) : decodeQueue(tracks, opts);
  }

  async #take(ep, item, gen) {
    if (!this.#current(ep, gen)) return false;
    if (ep.splice && item.trackStart && item.sample > 0) {
      // Nothing past this boundary was fed to anyone: switch the decode, the encoders run on.
      const tail = ep.splice;
      ep.splice = null;
      this.#decode(ep, tail, item.sample);
      return false;
    }
    ep.history.push(item);
    ep.decodedEnd = item.sample + item.pcm.length / ep.frameBytes;
    // Master PCM tap (visualizer): every sample exactly once per timeline, before any member hears it.
    this.emit('pcm', item);
    if (item.trackStart) this.#boundary(ep, item);
    const live = [...this.#members.values()].filter((m) => m.live && m.seg);
    await Promise.all(live.map((m) => this.#feed(m, m.seg, item)));
    if (!this.#current(ep, gen)) return false;
    this.#kick();
    if (!ep.live && !this.#needsMore(ep)) {
      let resume;
      await new Promise((resolve) => {
        resume = resolve;
        ep.waiter = resolve;
      });
      if (ep.waiter === resume) ep.waiter = null;
    }
    return this.#current(ep, gen);
  }

  #cut(ep, cut, tail) {
    ep.splice = null;
    const drop = ep.history.findIndex((it) => it.sample >= cut);
    if (drop >= 0) ep.history.length = drop;
    ep.decodedEnd = cut;
    ep.boundaries = ep.boundaries.filter((b) => b.sample < cut);
    ep.pendingTracks = ep.pendingTracks.filter((b) => b.sample < cut);
    ep.decodeDone = false;
    ep.ended = false;
    for (const m of [...this.#members.values()]) if (m.seg) this.#resplice(m, ep, cut);
    this.emit('cut', cut);
    this.#decode(ep, tail, cut);
    this.#kick();
  }

  // Re-encode a member from the first chunk that reaches the cut; chunks already sent from there on are
  // withdrawn with stream/clear from_timestamp, everything before keeps playing.
  #resplice(m, ep, cut) {
    let resumeUs = m.sentEndUs;
    let from = null;
    if (ep.t0 !== null) {
      const cutUs = ep.t0 + samplesToUs(cut, ep.rate);
      const i = m.inflight.findIndex((f) => f.endUs > cutUs);
      if (i >= 0) {
        from = m.inflight[i].ts;
        for (const f of m.inflight.splice(i)) m.bytes -= f.size;
        resumeUs = from - ep.t0;
      }
    }
    this.#closeFeed(m);
    if (from !== null && this.#call(m, () => m.member.streamClear({ roles: ['player'], fromTimestamp: from })) === undefined) return;
    const first = ep.history[0]?.sample ?? 0;
    const start = Math.max(usToSamples(resumeUs, ep.rate), first);
    this.#openFeed(m, start, Math.max(resumeUs, samplesToUs(start, ep.rate)), 'splice');
  }

  #boundary(ep, item) {
    const b = { track: item.track, sample: item.sample };
    ep.boundaries.push(b);
    if (ep.t0 === null) ep.pendingTracks.push(b);
    else this.#emitTrack(ep, b);
  }

  #emitTrack(ep, b) {
    this.emit('track', {
      track: b.track, timestampUs: ep.t0 + samplesToUs(b.sample, ep.rate), first: b.sample === 0,
    });
  }

  #needsMore(ep) {
    const playhead = ep.t0 === null ? 0 : this.#now() - ep.t0;
    if (samplesToUs(ep.decodedEnd, ep.rate) - playhead >= this.#opts.readAheadUs) return false;
    if (samplesToUs(ep.decodedEnd, ep.rate) - playhead < this.#tapLeadUs + this.#opts.lowWaterUs) return true;
    let live = false;
    for (const m of this.#members.values()) {
      if (!m.live || !m.seg) continue;
      live = true;
      if (samplesToUs(m.nextSample, ep.rate) - m.sentEndUs < this.#opts.lowWaterUs) return true;
    }
    // Without an audio feed (metadata/artwork-only rooms) the read-ahead alone paces the decode in real time.
    return !live;
  }

  #fail(err) {
    this.#log?.warn?.(`[sendspin] stream stopped: ${err.message}`);
    this.stop();
    this.emit('error', err);
  }

  #teardown() {
    const ep = this.#epoch;
    if (!ep) return;
    this.#epoch = null;
    clearTimeout(this.#timer);
    this.#timer = null;
    ep.ac.abort();
    ep.waiter?.();
    for (const m of this.#members.values()) this.#closeFeed(m);
  }

  #kick() {
    if (this.#kickQueued) return;
    this.#kickQueued = true;
    setImmediate(() => {
      this.#kickQueued = false;
      this.#pace();
    });
  }

  #ready(ep) {
    for (const m of this.#members.values()) {
      if (m.seg && !m.seg.pending.length && !m.seg.done) return false;
    }
    return ep.boundaries.length > 0 || ep.decodeDone;
  }

  #pace() {
    clearTimeout(this.#timer);
    this.#timer = null;
    const ep = this.#epoch;
    if (!ep) return;
    const now = this.#now();
    if (ep.t0 === null && !this.#anchor(ep, now)) return;
    let wake = Infinity;
    for (const m of [...this.#members.values()]) wake = Math.min(wake, this.#send(m, ep, now));
    if (this.#epoch !== ep) return;
    this.#prune(ep, now);
    if (ep.waiter && this.#needsMore(ep)) ep.waiter();
    else if (ep.waiter) wake = Math.min(wake, ep.t0 + samplesToUs(ep.decodedEnd, ep.rate) - this.#opts.readAheadUs + 1000);
    wake = Math.min(wake, this.#endCheck(ep, now));
    if (wake < Infinity) {
      this.#timer = setTimeout(() => this.#pace(), Math.max(1, Math.ceil((wake - now) / 1000)));
      this.#timer.unref?.();
    }
  }

  #anchor(ep, now) {
    if (!this.#ready(ep)) {
      if (ep.waiter && this.#needsMore(ep)) ep.waiter();
      return false;
    }
    ep.t0 = now + this.sendAheadUs;
    for (const b of ep.pendingTracks.splice(0)) this.#emitTrack(ep, b);
    return true;
  }

  #endCheck(ep, now) {
    if (ep.ended || !ep.decodeDone) return Infinity;
    for (const m of this.#members.values()) if (m.seg && (!m.seg.done || m.seg.pending.length)) return Infinity;
    const endAt = ep.t0 + samplesToUs(ep.decodedEnd, ep.rate);
    if (now < endAt) return endAt;
    ep.ended = true;
    this.emit('ended');
    return Infinity;
  }

  #send(m, ep, now) {
    const seg = m.seg;
    if (!seg) return Infinity;
    const cap = m.member.info.player.bufferCapacity;
    const od = m.member.state.player.outputDelayMs * 1000;
    while (m.inflight.length && m.inflight[0].endUs - od <= now) m.bytes -= m.inflight.shift().size;
    while (seg.pending.length) {
      const c = seg.pending[0];
      const ts = ep.t0 + seg.offsetUs + c.startUs;
      const size = AUDIO_HEADER_LEN + c.frame.length;
      if (ts < now || (size > cap && !m.inflight.length)) {
        seg.pending.shift();
        m.dropped++;
        m.sentEndUs = seg.offsetUs + c.startUs + c.durationUs;
        continue;
      }
      if (m.bytes + size > cap) return m.inflight[0].endUs - od;
      // A chunk past its completion time still counts while its bytes sit unsent in the socket. The socket is FIFO,
      // so any such bytes are queued ahead of every in-flight chunk: max() bounds the true count from above.
      if ((m.member.bufferedAmount ?? 0) + size > cap) return now + SOCKET_POLL_MS * 1000;
      if (this.#call(m, () => m.member.sendAudioChunk(BigInt(ts), c.frame)) === undefined) return Infinity;
      seg.pending.shift();
      m.inflight.push({ ts, endUs: ts + c.durationUs, size });
      m.bytes += size;
      m.sentChunks++;
      m.sentEndUs = seg.offsetUs + c.startUs + c.durationUs;
    }
    return Infinity;
  }

  #prune(ep, now) {
    const keep = Math.floor(Math.max(0, now - ep.t0 - HISTORY_KEEP_MS * 1000) * ep.rate / 1_000_000);
    let n = 0;
    while (n < ep.history.length - 1) {
      const it = ep.history[n];
      if (it.sample + it.pcm.length / ep.frameBytes > keep) break;
      n++;
    }
    if (n) {
      ep.history.splice(0, n);
      ep.historyOffset += n;
    }
    const playSample = Math.floor(Math.max(0, now - ep.t0) * ep.rate / 1_000_000);
    while (ep.boundaries.length > 1 && ep.boundaries[1].sample <= playSample) ep.boundaries.shift();
  }
}
