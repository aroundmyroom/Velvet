import { samplesToUs } from './audio.js';
import { encodeVisLoudness, encodeVisBeat, encodeVisFPeak, encodeVisSpectrum, encodeVisPeak } from './wire.js';

export const VIS_TYPES = Object.freeze(['beat', 'loudness', 'f_peak', 'peak', 'spectrum']);
const PERIODIC = ['loudness', 'f_peak', 'spectrum'];
export const RATE_MAX_CAP = 60;
export const MAX_DISP_BINS = 1024;
// Visualizer frames go out at most this far beyond the group's send-ahead, so they never run far ahead of the audio.
export const LEAD_MS = 500;
export const JOIN_MARGIN_MS = 50;
export const TICK_MS = 20;
export const KEEP_BEHIND_MS = 1000;
const REFERENCE_RATE = 48_000;
const REFERENCE_FFT = 2048;
const SMOOTH_MS = 40;
const F_PEAK_SWITCH = 1.1;
const ODF_GAMMA = 100;
const ODF_MIN_HZ = 30;
const ACTIVITY = 0.004;
const PEAK_GAP_MS = 80;
const PEAK_HALF_LIFE_S = 4;
const BPM_MIN = 55;
const BPM_MAX = 215;
const BPM_DEFAULT = 120;
const PRIOR_SIGMA_FREE = 0.7;
const PRIOR_SIGMA_DB = 0.05;
const CONTINUITY_SIGMA = 0.08;
const ACQUIRE_S = 3;
const TEMPO_BACK_S = 8;
const TEMPO_AHEAD_S = 2;
const PLL_GAIN = 0.8;
const MAX_COAST = 4;
const LOOKAHEAD_S = ACQUIRE_S + 0.5;
const KIND = { beat: 0, peak: 1, frame: 2 };

export function fftSize(rate) {
  const target = REFERENCE_FFT * rate / REFERENCE_RATE;
  let n = 256;
  while (n < target) n <<= 1;
  return n;
}

// Real-input radix-2 FFT: an n/2-point complex FFT on the packed even/odd samples, then the split step.
export class FFT {
  constructor(n) {
    if (n < 8 || (n & (n - 1))) throw new Error('FFT size must be a power of two');
    const h = n / 2;
    this.n = n;
    this.re = new Float64Array(h);
    this.im = new Float64Array(h);
    this.cos = new Float64Array(h + 1);
    this.sin = new Float64Array(h + 1);
    for (let k = 0; k <= h; k++) {
      this.cos[k] = Math.cos(2 * Math.PI * k / n);
      this.sin[k] = Math.sin(2 * Math.PI * k / n);
    }
    this.rev = new Uint32Array(h);
    const bits = Math.log2(h);
    for (let i = 0; i < h; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.window = new Float64Array(n);
    for (let i = 0; i < n; i++) this.window[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n);
  }

  // Hann-windowed magnitudes |X_k|, k = 0..n/2. A full-scale sine peaks at n/4.
  magnitudes(input, out = new Float64Array(this.n / 2 + 1)) {
    const { n, re, im, rev, window, cos, sin } = this;
    const h = n / 2;
    for (let m = 0; m < h; m++) {
      const r = rev[m];
      re[r] = input[2 * m] * window[2 * m];
      im[r] = input[2 * m + 1] * window[2 * m + 1];
    }
    for (let a = 0; a < h; a += 2) {
      const r = re[a + 1];
      const i = im[a + 1];
      re[a + 1] = re[a] - r;
      im[a + 1] = im[a] - i;
      re[a] += r;
      im[a] += i;
    }
    for (let size = 4; size <= h; size <<= 1) {
      const half = size >> 1;
      const step = 2 * (h / size);
      for (let i = 0; i < h; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const a = i + j;
          const b = a + half;
          const tr = cos[k] * re[b] + sin[k] * im[b];
          const ti = cos[k] * im[b] - sin[k] * re[b];
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }
    for (let k = 0; k <= h; k++) {
      const p = k % h;
      const q = (h - k) % h;
      const ar = re[p];
      const ai = im[p];
      const br = re[q];
      const bi = -im[q];
      const dr = ar - br;
      const di = ai - bi;
      const xr = (ar + br) / 2 + (cos[k] * di + sin[k] * -dr) / 2;
      const xi = (ai + bi) / 2 + (cos[k] * -dr - sin[k] * di) / 2;
      out[k] = Math.sqrt(xr * xr + xi * xi);
    }
    return out;
  }
}

export function aWeightDb(f) {
  const f2 = Math.max(f, 1) ** 2;
  const ra = (12194 ** 2 * f2 * f2) / ((f2 + 20.6 ** 2) * Math.sqrt((f2 + 107.7 ** 2) * (f2 + 737.9 ** 2)) * (f2 + 12194 ** 2));
  return Math.max(-50, Math.min(6, 20 * Math.log10(ra) + 2));
}

function aWeightGains(n, rate) {
  const g = new Float64Array(n / 2 + 1);
  for (let k = 1; k <= n / 2; k++) g[k] = 10 ** (aWeightDb(k * rate / n) / 20);
  return g;
}

// -60 dB -> 0, 0 dB -> 65535, linear in dB.
export function dbScale(ratio) {
  if (Number.isNaN(ratio) || ratio <= 0) return 0;
  const t = (20 * Math.log10(ratio) + 60) / 60;
  return Math.round(Math.max(0, Math.min(1, t)) * 65535);
}

const hzToMel = (f) => 2595 * Math.log10(1 + f / 700);
const melToHz = (m) => 700 * (10 ** (m / 2595) - 1);

export function bandEdges(nBins, scale, fMin, fMax) {
  const e = new Float64Array(nBins + 1);
  for (let i = 0; i <= nBins; i++) {
    const t = i / nBins;
    if (scale === 'lin') e[i] = fMin + t * (fMax - fMin);
    else if (scale === 'log') {
      const lo = Math.log10(Math.max(fMin, 1));
      e[i] = 10 ** (lo + t * (Math.log10(fMax) - lo));
    } else e[i] = melToHz(hzToMel(fMin) + t * (hzToMel(fMax) - hzToMel(fMin)));
  }
  return e;
}

export const spectrumKey = (sp) => `${sp.n_disp_bins}:${sp.scale}:${sp.f_min}:${sp.f_max}`;

// Display bin -> FFT bins inside it; a bin too narrow to hold one FFT bin reads the spectrum at its centre instead.
function bandMap(sp, n, rate) {
  const edges = bandEdges(sp.n_disp_bins, sp.scale, sp.f_min, sp.f_max);
  const df = rate / n;
  const bands = [];
  for (let i = 0; i < sp.n_disp_bins; i++) {
    const lo = Math.max(1, Math.ceil(edges[i] / df));
    const hi = Math.min(n / 2, Math.ceil(edges[i + 1] / df) - 1);
    if (hi >= lo) bands.push({ lo, hi, at: -1 });
    else {
      const c = (edges[i] + edges[i + 1]) / 2 / df;
      bands.push({ lo: 0, hi: -1, at: c > 0 && c < n / 2 ? c : -1 });
    }
  }
  return bands;
}

export function spectrumUsable(sp) {
  return Boolean(sp) && sp.n_disp_bins <= MAX_DISP_BINS && sp.f_max > sp.f_min;
}

// The stream/start visualizer object for a client/state request: a subset of the requested types, rate capped.
export function streamConfig(req) {
  const types = VIS_TYPES.filter((t) => req.types.includes(t) && (t !== 'spectrum' || spectrumUsable(req.spectrum)));
  const out = { types, rate_max: Math.min(req.rate_max, RATE_MAX_CAP) };
  if (types.includes('beat')) out.tracks_downbeats = false;
  if (types.includes('spectrum')) out.spectrum = { ...req.spectrum };
  return out;
}

export function trackBpm(track) {
  const v = track?.bpm ?? track?.item?.bpm ?? track?.item?.meta?.bpm ?? track?.meta?.bpm;
  return Number.isFinite(v) && v >= 30 && v <= 300 ? v : null;
}

class MonoBuffer {
  buf = new Float32Array(1 << 16);
  start = 0;
  len = 0;

  get end() {
    return this.start + this.len;
  }

  append(sample, data) {
    if (sample < this.end) this.truncate(sample);
    const gap = sample - this.end;
    this.#reserve(this.len + gap + data.length);
    if (gap > 0) this.buf.fill(0, this.len, this.len + gap);
    this.buf.set(data, this.len + gap);
    this.len += gap + data.length;
  }

  truncate(at) {
    if (at < this.end) this.len = Math.max(0, at - this.start);
  }

  dropBefore(sample) {
    const n = Math.min(this.len, sample - this.start);
    if (n < 1 << 16 && n < this.len) return;
    if (n <= 0) return;
    this.buf.copyWithin(0, n, this.len);
    this.start += n;
    this.len -= n;
  }

  read(from, out) {
    const off = from - this.start;
    for (let i = 0; i < out.length; i++) {
      const j = off + i;
      out[i] = j >= 0 && j < this.len ? this.buf[j] : 0;
    }
    return out;
  }

  #reserve(n) {
    if (n <= this.buf.length) return;
    let cap = this.buf.length;
    while (cap < n) cap *= 2;
    const next = new Float32Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }
}

// Bin -> band for the onset curve: linear below 250 Hz, then six bands per octave up to 16 kHz.
function onsetBands(n, rate) {
  const map = new Int16Array(n / 2 + 1).fill(-1);
  let band = -1;
  let edge = 0;
  for (let k = 1; k <= n / 2; k++) {
    const f = k * rate / n;
    if (f < ODF_MIN_HZ || f > 16_000) continue;
    if (band < 0 || f >= edge) {
      band++;
      edge = Math.max(f + rate / n, f * 2 ** (1 / 6));
    }
    map[k] = band;
  }
  return map;
}

function downmix(pcm, channels) {
  const frames = Math.floor(pcm.length / (4 * channels));
  const out = new Float32Array(frames);
  const scale = 1 / (2 ** 31 * channels);
  for (let i = 0, p = 0; i < frames; i++) {
    let s = 0;
    for (let c = 0; c < channels; c++, p += 4) s += pcm.readInt32LE(p);
    out[i] = s * scale;
  }
  return out;
}

function insertSorted(events, e) {
  let i = events.length;
  while (i > 0 && events[i - 1].key > e.key) i--;
  events.splice(i, 0, e);
}

// Tempo (comb over the onset autocorrelation, log-Gaussian prior) and beat phase (comb, then a PLL) on the onset curve.
export class BeatTracker {
  constructor(fps) {
    this.fps = fps;
    this.tauMin = 60 * fps / BPM_MAX;
    this.tauMax = 60 * fps / BPM_MIN;
    this.reset(0, null);
  }

  reset(from, bpm) {
    this.acqFrom = from;
    this.lastBeat = null;
    this.tau = null;
    this.tempoAt = -Infinity;
    this.coast = 0;
    this.bpm = bpm;
  }

  tempo(odf, from, to) {
    const a = Math.floor(from);
    const len = Math.floor(to) - a;
    if (len < 2 * this.tauMin) return this.tau ?? 60 * this.fps / (this.bpm ?? BPM_DEFAULT);
    let mean = 0;
    for (let i = a; i < a + len; i++) mean += odf(i);
    mean /= len;
    const x = new Float64Array(len);
    for (let i = 0; i < len; i++) x[i] = odf(a + i) - mean;
    const maxLag = Math.min(len - 1, Math.ceil(4 * this.tauMax));
    const acf = new Float64Array(maxLag + 2);
    for (let l = 1; l <= maxLag; l++) {
      let s = 0;
      for (let i = 0; i + l < len; i++) s += x[i] * x[i + l];
      acf[l] = s / (len - l);
    }
    const at = (lag) => {
      const i = Math.floor(lag);
      return i + 1 > maxLag ? 0 : acf[i] + (lag - i) * (acf[i + 1] - acf[i]);
    };
    const centre = 60 * this.fps / (this.bpm ?? BPM_DEFAULT);
    const sigma = this.bpm ? PRIOR_SIGMA_DB : PRIOR_SIGMA_FREE;
    let best = centre;
    let bestScore = -Infinity;
    for (let tau = this.tauMin; tau <= this.tauMax; tau += 0.1) {
      let s = 0;
      let k = 1;
      for (; k <= 4 && k * tau <= Math.min(maxLag, len * 0.6); k++) s += at(k * tau);
      if (k === 1) continue;
      s /= k - 1;
      let w = Math.exp(-0.5 * (Math.log2(tau / centre) / sigma) ** 2);
      if (this.tau) w *= 0.5 + Math.exp(-0.5 * (Math.log2(tau / this.tau) / CONTINUITY_SIGMA) ** 2);
      const score = s > 0 ? s * w : s / w;
      if (score > bestScore) {
        bestScore = score;
        best = tau;
      }
    }
    return best;
  }

  // Runs as far as the onset curve allows; returns { beats, final } where no beat can still appear before frame final.
  run(odf, avail, ended, segEnd) {
    const beats = [];
    for (;;) {
      const final = this.lastBeat === null ? this.#acquire(odf, avail, ended, segEnd, beats) : this.#follow(odf, avail, ended, segEnd, beats);
      if (final !== null) return { beats, final };
    }
  }

  #acquire(odf, avail, ended, segEnd, beats) {
    const need = Math.min(this.acqFrom + Math.ceil(ACQUIRE_S * this.fps), segEnd);
    if (avail < need && !ended) return this.acqFrom;
    const end = Math.min(need, avail);
    if (end - this.acqFrom < 2 * this.tauMin) {
      if (end >= segEnd) return segEnd;
      return ended ? Infinity : this.acqFrom;
    }
    if (!this.#active(odf, this.acqFrom, end)) {
      this.acqFrom = Math.max(this.acqFrom + 1, Math.floor(end - ACQUIRE_S * this.fps / 2));
      return end >= segEnd ? segEnd : null;
    }
    this.tau = this.tempo(odf, this.acqFrom, end);
    this.tempoAt = this.acqFrom;
    let first = this.#phase(odf, this.acqFrom, end);
    while (first + this.tau < end && this.#onsetNear(odf, first, 0.2 * this.tau, end) < 0) first += this.tau;
    beats.push({ frame: first, tau: this.tau });
    this.lastBeat = first;
    this.coast = 0;
    return null;
  }

  #follow(odf, avail, ended, segEnd, beats) {
    const fps = this.fps;
    const p = this.lastBeat + this.tau;
    const w = 0.2 * this.tau;
    if (p >= segEnd) return segEnd;
    if (avail < Math.min(p + w + 2, segEnd) && !ended) return p - w;
    if (p >= avail) return ended ? Infinity : p - w;
    if (p - this.tempoAt >= fps) {
      this.tau = this.tempo(odf, Math.max(0, p - TEMPO_BACK_S * fps), Math.min(avail, segEnd, p + TEMPO_AHEAD_S * fps));
      this.tempoAt = p;
    }
    const m = this.#onsetNear(odf, p, w, Math.min(avail, segEnd));
    let beat = p;
    if (m >= 0 && odf(m) > this.#localMean(odf, p, this.tau, avail) + ACTIVITY) {
      beat = p + PLL_GAIN * (refine(odf, m) - p);
      this.coast = 0;
    } else if (++this.coast > MAX_COAST) {
      this.reset(Math.ceil(p), this.bpm);
      return null;
    }
    beats.push({ frame: beat, tau: this.tau });
    this.lastBeat = beat;
    return null;
  }

  #onsetNear(odf, p, w, limit) {
    let m = -1;
    let best = 0;
    for (let i = Math.max(0, Math.ceil(p - w)); i <= Math.min(Math.floor(p + w), limit - 1); i++) {
      const v = odf(i) * Math.exp(-0.5 * ((i - p) / (0.5 * w)) ** 2);
      if (v > best && odf(i) > 4 * ACTIVITY) {
        best = v;
        m = i;
      }
    }
    return m;
  }

  #active(odf, a, b) {
    let s = 0;
    for (let i = a; i < b; i++) s = Math.max(s, odf(i));
    return s > 4 * ACTIVITY;
  }

  #localMean(odf, p, tau, avail) {
    const a = Math.max(0, Math.floor(p - tau));
    const b = Math.min(avail, Math.ceil(p + tau));
    let s = 0;
    for (let i = a; i < b; i++) s += odf(i);
    return b > a ? s / (b - a) : 0;
  }

  #phase(odf, a, b) {
    const tau = this.tau;
    let best = a;
    let bestScore = -Infinity;
    for (let phi = 0; phi < tau; phi += 0.5) {
      let s = 0;
      for (let t = a + phi; t < b; t += tau) {
        const i = Math.round(t);
        s += Math.max(odf(i - 1), odf(i), odf(i + 1));
      }
      if (s > bestScore) {
        bestScore = s;
        best = a + phi;
      }
    }
    let m = Math.round(best);
    for (let i = m - 1; i <= m + 1; i++) if (i >= a && odf(i) > odf(m)) m = i;
    return refine(odf, m);
  }
}

function refine(odf, m) {
  const a = odf(m - 1);
  const b = odf(m);
  const c = odf(m + 1);
  const d = a - 2 * b + c;
  return d < 0 ? m + Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / d)) : m;
}

// Sample-domain analysis of one timeline (one GroupStream epoch). Lazy: runs only as far as advance() is asked.
export class Analyser {
  constructor(rate, { channels = 2 } = {}) {
    this.rate = rate;
    this.channels = channels;
    this.n = fftSize(rate);
    this.fft = new FFT(this.n);
    this.mag = new Float64Array(this.n / 2 + 1);
    this.win = new Float32Array(this.n);
    this.aw = aWeightGains(this.n, rate);
    this.nOdf = this.n / 2;
    this.hop = this.nOdf / 4;
    this.fftOdf = new FFT(this.nOdf);
    this.magOdf = new Float64Array(this.nOdf / 2 + 1);
    this.winOdf = new Float32Array(this.nOdf);
    this.odfBands = onsetBands(this.nOdf, rate);
    this.odfBandCount = Math.max(...this.odfBands) + 1;
    this.bandSum = new Float64Array(this.odfBandCount);
    this.bandWidth = new Float64Array(this.odfBandCount);
    for (const b of this.odfBands) if (b >= 0) this.bandWidth[b]++;
    this.fps = rate / this.hop;
    // Calibrated on clicks (test/sendspin-visualizer.test.mjs): the log-flux peak leads the transient by about a quarter window.
    this.onsetOffset = Math.round(this.nOdf / 4);
    this.mono = new MonoBuffer();
    this.ended = false;
    this.segments = [];
    this.events = [];
    this.needs = { display: false, onsets: false, rate: 1, spectra: new Map() };
    this.nextCentre = 0;
    this.smooth = { loud: null, spectra: new Map(), fIdx: -1 };
    this.odf = new Float32Array(1024);
    this.odfBase = 0;
    this.odfLen = 0;
    this.yA = new Float64Array(this.odfBandCount);
    this.yB = new Float64Array(this.odfBandCount);
    this.prevY = null;
    this.peakNext = 0;
    this.lastPeak = -Infinity;
    this.runMax = 0;
    this.tracker = new BeatTracker(this.fps);
    this.beatFinal = 0;
    this.peakFinal = 0;
  }

  get decodedEnd() {
    return this.mono.end;
  }

  push(item) {
    if (item.trackStart) this.segment(item.sample, trackBpm(item.track));
    this.mono.append(item.sample, downmix(item.pcm, this.channels));
  }

  segment(sample, bpm) {
    this.segments = this.segments.filter((s) => s.sample < sample);
    this.segments.push({ sample, bpm });
  }

  end() {
    this.ended = true;
  }

  configure({ display, onsets, rate, spectra }) {
    if (onsets && !this.needs.onsets) {
      const j = Math.ceil(this.nextCentre / this.hop);
      this.odfBase = j;
      this.odfLen = 0;
      this.prevY = j <= 0 ? this.yB.fill(0) : null;
      this.peakNext = j;
      this.lastPeak = -Infinity;
      this.tracker.reset(j, this.#segmentAt(j * this.hop)?.bpm ?? null);
      this.beatFinal = j * this.hop;
      this.peakFinal = j * this.hop;
    }
    for (const [key, sp] of spectra) {
      if (!this.needs.spectra.has(key)) this.needs.spectra.set(key, { sp, bands: bandMap(sp, this.n, this.rate) });
    }
    for (const key of [...this.needs.spectra.keys()]) if (!spectra.has(key)) this.needs.spectra.delete(key);
    this.needs.display = display;
    this.needs.onsets = onsets;
    this.needs.rate = rate;
  }

  // A timeline cut: everything from `cut` on is replaced by new audio (GroupStream.replaceUpcoming).
  truncate(cut) {
    this.mono.truncate(cut);
    this.ended = false;
    this.segments = this.segments.filter((s) => s.sample < cut);
    this.events = this.events.filter((e) => e.sample < cut);
    if (this.nextCentre >= cut) {
      this.nextCentre = Math.min(this.nextCentre, this.#gridAtOrAfter(cut));
      this.smooth = { loud: null, spectra: new Map(), fIdx: -1 };
    }
    const j = Math.ceil(cut / this.hop);
    if (this.odfBase + this.odfLen > j) {
      this.#truncateOdf(j);
      this.prevY = null;
    }
    this.peakNext = Math.min(this.peakNext, j);
    const peaks = this.events.filter((e) => e.kind === KIND.peak);
    this.lastPeak = peaks.length ? (peaks.at(-1).sample - this.onsetOffset) / this.hop : -Infinity;
    const beats = this.events.filter((e) => e.kind === KIND.beat);
    const lastBeat = beats.at(-1);
    const seg = this.#segmentAt(cut - 1);
    if (lastBeat && (!seg || lastBeat.sample >= seg.sample)) {
      this.tracker.lastBeat = lastBeat.frame;
      this.tracker.tau = lastBeat.tau;
      this.tracker.coast = 0;
    } else {
      this.tracker.reset(Math.max(this.odfBase, Math.ceil((seg?.sample ?? 0) / this.hop)), seg?.bpm ?? null);
    }
    this.beatFinal = Math.min(this.beatFinal, cut);
    this.peakFinal = Math.min(this.peakFinal, cut);
  }

  #gridAtOrAfter(sample) {
    let c = this.nextCentre;
    const step = this.rate / this.needs.rate;
    while (c - step >= sample) c -= step;
    return c;
  }

  // Events with a sample before the returned bound are final for clients that asked for `types`.
  finalFor(types) {
    let f = Infinity;
    if (types.some((t) => PERIODIC.includes(t))) f = Math.min(f, this.ended && this.nextCentre >= this.mono.end ? Infinity : Math.round(this.nextCentre));
    if (types.includes('peak')) f = Math.min(f, this.peakFinal);
    if (types.includes('beat')) f = Math.min(f, this.beatFinal);
    return f;
  }

  advance(target) {
    const end = this.mono.end;
    if (this.needs.display) {
      const limit = this.ended ? end : end - this.n / 2;
      const stop = Math.min(target, limit);
      const step = this.rate / this.needs.rate;
      while (this.nextCentre < stop) {
        this.#frame(Math.round(this.nextCentre), step);
        this.nextCentre += step;
      }
      if (this.ended && this.nextCentre >= end) this.nextCentre = Math.max(this.nextCentre, end);
    } else {
      this.nextCentre = Math.max(this.nextCentre, Math.min(target, end));
    }
    if (this.needs.onsets) this.#onsets(target);
    else {
      this.beatFinal = Infinity;
      this.peakFinal = Infinity;
    }
  }

  idle(sample) {
    this.nextCentre = Math.max(this.nextCentre, sample);
    this.prune(sample);
  }

  prune(beforeSample) {
    this.mono.dropBefore(beforeSample - 2 * this.n);
    let i = 0;
    while (i < this.events.length && this.events[i].sample < beforeSample) i++;
    if (i) this.events.splice(0, i);
    const keepJ = Math.floor((beforeSample - 2 * this.n) / this.hop) - Math.ceil((TEMPO_BACK_S + 1) * this.fps);
    const drop = Math.min(this.odfLen, keepJ - this.odfBase);
    if (drop > 0) {
      this.odf.copyWithin(0, drop, this.odfLen);
      this.odfBase += drop;
      this.odfLen -= drop;
    }
  }

  #segmentAt(sample) {
    let s = null;
    for (const x of this.segments) if (x.sample <= sample) s = x;
    return s;
  }

  #frame(centre, step) {
    const { n, mag, aw } = this;
    this.fft.magnitudes(this.mono.read(centre - n / 2, this.win), mag);
    mag[0] = 0;
    let power = 0;
    let idx = 1;
    for (let k = 1; k <= n / 2; k++) {
      mag[k] *= aw[k];
      power += mag[k] * mag[k];
      if (mag[k] > mag[idx]) idx = k;
    }
    const alpha = 1 - Math.exp(-(step / this.rate) * 1000 / SMOOTH_MS);
    const ema = (prev, v) => (prev === null ? v : prev + alpha * (v - prev));
    const rmsRatio = Math.sqrt(2 * power) / n / Math.sqrt(3 / 16);
    this.smooth.loud = ema(this.smooth.loud, dbScale(rmsRatio) / 65535);
    const s = this.smooth;
    if (s.fIdx > 0 && idx !== s.fIdx && mag[idx] < F_PEAK_SWITCH * mag[s.fIdx]) idx = s.fIdx;
    s.fIdx = idx;
    let freq = 0;
    let amp = 0;
    const ref = n / 4;
    if (mag[idx] / ref >= 1e-3) {
      let delta = 0;
      if (idx > 1 && idx < n / 2) {
        const a = Math.log(mag[idx - 1] + 1e-20);
        const b = Math.log(mag[idx]);
        const c = Math.log(mag[idx + 1] + 1e-20);
        const d = a - 2 * b + c;
        if (d < 0) delta = Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / d));
      }
      freq = Math.max(0, Math.min(65535, Math.round((idx + delta) * this.rate / n)));
      amp = freq ? dbScale(mag[idx] / ref) : 0;
    }
    const spectra = this.#spectra(alpha);
    insertSorted(this.events, {
      key: centre * 4 + KIND.frame, sample: centre, kind: KIND.frame,
      loudness: Math.round(this.smooth.loud * 65535), freq, amp, spectra,
    });
  }

  #spectra(alpha) {
    const { mag, n } = this;
    const ref = n / 4;
    const spectra = new Map();
    for (const [key, { bands }] of this.needs.spectra) {
      const prev = this.smooth.spectra.get(key);
      const vals = new Float64Array(bands.length);
      const out = new Array(bands.length);
      for (let i = 0; i < bands.length; i++) {
        const b = bands[i];
        let p = 0;
        if (b.hi >= b.lo) for (let k = b.lo; k <= b.hi; k++) p += mag[k] * mag[k];
        else if (b.at > 0) {
          const k = Math.floor(b.at);
          const m = mag[k] + (b.at - k) * (mag[k + 1] - mag[k]);
          p = m * m;
        }
        const v = dbScale(Math.sqrt(p) / ref) / 65535;
        vals[i] = prev ? prev[i] + alpha * (v - prev[i]) : v;
        out[i] = Math.round(vals[i] * 65535);
      }
      this.smooth.spectra.set(key, vals);
      spectra.set(key, out);
    }
    return spectra;
  }

  #odfAt = (j) => {
    const i = j - this.odfBase;
    return i >= 0 && i < this.odfLen ? this.odf[i] : 0;
  };

  #truncateOdf(j) {
    this.odfLen = Math.max(0, Math.min(this.odfLen, j - this.odfBase));
  }

  #pushOdf(v) {
    if (this.odfLen === this.odf.length) {
      const next = new Float32Array(this.odf.length * 2);
      next.set(this.odf);
      this.odf = next;
    }
    this.odf[this.odfLen++] = v;
  }

  #onsets(target) {
    const { nOdf, hop, magOdf } = this;
    const end = this.mono.end;
    const limit = Math.min(target + LOOKAHEAD_S * this.rate, this.ended ? end + nOdf / 2 : end - nOdf / 2);
    const { odfBands, bandSum, bandWidth, odfBandCount: nb } = this;
    const g = ODF_GAMMA / (nOdf / 4);
    for (let j = this.odfBase + this.odfLen; j * hop < limit; j = this.odfBase + this.odfLen) {
      this.fftOdf.magnitudes(this.mono.read(j * hop - nOdf / 2, this.winOdf), magOdf);
      bandSum.fill(0);
      for (let k = 1; k <= nOdf / 2; k++) if (odfBands[k] >= 0) bandSum[odfBands[k]] += magOdf[k];
      const prev = this.prevY;
      const y = prev === this.yA ? this.yB : this.yA;
      let flux = 0;
      for (let b = 0; b < nb; b++) {
        y[b] = Math.log1p(g * bandSum[b] / bandWidth[b]);
        if (prev && y[b] > prev[b]) flux += y[b] - prev[b];
      }
      this.prevY = y;
      this.#pushOdf(flux / nb);
    }
    const avail = this.odfBase + this.odfLen;
    const done = this.ended && avail * hop >= end;
    this.#peaks(avail, done);
    this.#beats(avail, done);
  }

  #peaks(avail, done) {
    const odf = this.#odfAt;
    const gap = PEAK_GAP_MS / 1000 * this.fps;
    const decay = 0.5 ** (1 / (PEAK_HALF_LIFE_S * this.fps));
    const stop = done ? avail : avail - 3;
    for (; this.peakNext < stop; this.peakNext++) {
      const j = this.peakNext;
      const v = odf(j);
      this.runMax = Math.max(v, this.runMax * decay);
      let isMax = v > ACTIVITY;
      for (let i = j - 3; isMax && i <= j + 3; i++) if (i !== j && (odf(i) > v || (i < j && odf(i) === v))) isMax = false;
      if (!isMax || j - this.lastPeak < gap) continue;
      let mean = 0;
      for (let i = j - 30; i <= j + 3; i++) mean += odf(i);
      mean /= 34;
      const thr = mean + Math.max(ACTIVITY, 0.1 * this.runMax);
      if (v < thr) continue;
      this.lastPeak = j;
      const strength = Math.max(1, Math.min(255, Math.round(255 * (v - mean) / Math.max(this.runMax, 1e-9))));
      const sample = j * this.hop + this.onsetOffset;
      insertSorted(this.events, { key: sample * 4 + KIND.peak, sample, kind: KIND.peak, strength });
    }
    this.peakFinal = done ? Infinity : this.peakNext * this.hop + this.onsetOffset - this.hop;
  }

  #beats(avail, done) {
    const odf = this.#odfAt;
    for (;;) {
      const pos = (this.tracker.lastBeat ?? this.tracker.acqFrom) * this.hop;
      const seg = this.#segmentAt(Math.max(0, pos));
      const next = this.segments.find((s) => s.sample > pos);
      if (seg && this.tracker.bpm !== seg.bpm && this.tracker.lastBeat === null) this.tracker.bpm = seg.bpm;
      const segEnd = next ? Math.ceil(next.sample / this.hop) : Infinity;
      const { beats, final } = this.tracker.run(odf, avail, done, segEnd);
      for (const { frame, tau } of beats) {
        const sample = Math.max(0, Math.round(frame * this.hop) + this.onsetOffset);
        if (done && sample >= this.mono.end) continue;
        insertSorted(this.events, { key: sample * 4 + KIND.beat, sample, kind: KIND.beat, frame, tau });
      }
      if (next && final >= segEnd && (avail >= segEnd || done)) {
        this.tracker.reset(segEnd, next.bpm);
        continue;
      }
      this.beatFinal = final === Infinity ? Infinity : Math.max(0, Math.floor((final - 1) * this.hop) + this.onsetOffset);
      return;
    }
  }
}

export function canVisualize(member) {
  return Boolean(member && member.isOpen !== false && member.state?.available && member.hasRole?.('visualizer')
    && member.state.roles?.visualizer && member.info?.visualizer?.bufferCapacity > 0);
}

const hasVisStream = (member) => member.activeStreams.includes('visualizer');
const sameConfig = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// The visualizer role for one room: listens to its GroupStream's master PCM tap, analyses once for every member and
// sends each member the types it asked for on the audio's own timeline.
export class RoomVisualizer {
  #stream;
  #now;
  #log;
  #opts;
  #members = new Map();
  #an = null;
  #timer = null;
  #handlers;

  constructor(stream, { now, logger = null, leadMs = LEAD_MS, tickMs = TICK_MS, joinMarginMs = JOIN_MARGIN_MS } = {}) {
    this.#stream = stream;
    this.#now = now;
    this.#log = logger;
    this.#opts = { leadUs: leadMs * 1000, tickMs, joinMarginUs: joinMarginMs * 1000 };
    this.#handlers = {
      epoch: ({ rate }) => this.#onEpoch(rate),
      pcm: (item) => this.#onPcm(item),
      'pcm-end': () => this.#an?.end(),
      cut: (sample) => this.#onCut(sample),
      stop: () => this.#onStop(),
    };
    for (const [ev, fn] of Object.entries(this.#handlers)) stream.on(ev, this.#guard(ev, fn));
  }

  get memberIds() {
    return [...this.#members.keys()];
  }

  has(clientId) {
    return this.#members.has(clientId);
  }

  stats() {
    return [...this.#members.values()].map((v) => ({
      clientId: v.member.clientId, config: v.config, sent: v.sent, dropped: v.dropped, bufferedBytes: v.bytes, active: v.active,
    }));
  }

  // Idempotent: a member whose visualizer stream went away (activation change, park) is started again as a late joiner.
  addMember(member) {
    if (!canVisualize(member)) return false;
    let v = this.#members.get(member.clientId);
    if (!v) {
      v = { member, config: null, active: false, sent: 0, dropped: 0, inflight: [], bytes: 0, lastKey: -1, lastTs: -Infinity, lastPeriodicTs: -Infinity };
      this.#members.set(member.clientId, v);
    }
    v.config = streamConfig(member.state.roles.visualizer);
    if (this.#an && !(v.active && hasVisStream(member))) this.#start(v, true);
    this.#configure();
    return this.#members.has(member.clientId);
  }

  removeMember(clientId, { end = true } = {}) {
    const v = this.#members.get(clientId);
    if (!v) return;
    this.#members.delete(clientId);
    if (end && v.active && v.member.isOpen !== false && hasVisStream(v.member)) this.#call(v, () => v.member.streamEnd(['visualizer']));
    this.#configure();
  }

  // client/state: a changed request becomes an in-place stream/start; frames after it follow the new configuration.
  memberChanged(clientId) {
    const v = this.#members.get(clientId);
    if (!v) return;
    if (!canVisualize(v.member)) {
      this.removeMember(clientId);
      return;
    }
    const config = streamConfig(v.member.state.roles.visualizer);
    if (sameConfig(config, v.config)) return;
    v.config = config;
    if (v.active && hasVisStream(v.member)) this.#call(v, () => v.member.streamStart({ visualizer: config }));
    this.#configure();
  }

  close() {
    this.#onStop();
    for (const [ev, fn] of Object.entries(this.#handlers)) this.#stream.off(ev, fn);
    this.#members.clear();
  }

  #guard(ev, fn) {
    const wrapped = (...args) => {
      try {
        fn(...args);
      } catch (err) {
        this.#log?.warn?.(`[sendspin] visualizer ${ev} failed: ${err.message}`);
      }
    };
    this.#handlers[ev] = wrapped;
    return wrapped;
  }

  #call(v, fn) {
    try {
      return fn();
    } catch (err) {
      this.#log?.warn?.(`[sendspin] ${v.member.clientId.slice(0, 8)} dropped from the visualizer stream: ${err.message}`);
      this.#members.delete(v.member.clientId);
      this.#configure();
      return undefined;
    }
  }

  #reset(v) {
    v.inflight = [];
    v.bytes = 0;
    v.lastKey = -1;
    v.lastTs = -Infinity;
    v.lastPeriodicTs = -Infinity;
    v.lastSentKey = -1;
  }

  #start(v, late) {
    this.#reset(v);
    if (this.#call(v, () => v.member.streamStart({ visualizer: v.config })) === undefined) return;
    v.active = true;
    const t0 = this.#stream.t0;
    if (late && t0 !== null) {
      const from = Math.max(0, this.#now() + this.#opts.joinMarginUs - t0);
      v.lastKey = Math.ceil(from * this.#an.rate / 1_000_000) * 4 - 1;
    }
    this.#kick();
  }

  #onEpoch(rate) {
    this.#an = new Analyser(rate);
    for (const v of [...this.#members.values()]) {
      if (!canVisualize(v.member)) {
        this.#members.delete(v.member.clientId);
        continue;
      }
      if (v.active && hasVisStream(v.member)) {
        this.#reset(v);
        this.#call(v, () => v.member.streamClear({ roles: ['visualizer'] }));
      } else {
        this.#start(v, false);
      }
    }
    this.#configure();
    this.#kick();
  }

  // The PCM is kept even with nobody watching, so a visualizer that joins mid-track can be served from the read-ahead.
  #onPcm(item) {
    const an = this.#an;
    if (!an) return;
    an.push(item);
    const t0 = this.#stream.t0;
    if (this.#members.size || t0 === null) return;
    const at = Math.floor(Math.max(0, this.#now() - t0) * an.rate / 1_000_000);
    an.idle(at);
  }

  #onStop() {
    clearTimeout(this.#timer);
    this.#timer = null;
    this.#an = null;
    for (const v of [...this.#members.values()]) {
      if (v.active && v.member.isOpen !== false && hasVisStream(v.member)) this.#call(v, () => v.member.streamEnd(['visualizer']));
      v.active = false;
      this.#reset(v);
    }
  }

  // Frames from `cut` on were analysed from audio that will not play: withdraw what was sent (stream/clear
  // from_timestamp), keep everything before it.
  #onCut(cut) {
    const an = this.#an;
    if (!an) return;
    an.truncate(cut);
    const t0 = this.#stream.t0;
    const cutKey = cut * 4;
    for (const v of [...this.#members.values()]) {
      if (v.lastKey < cutKey) continue;
      v.lastKey = cutKey - 1;
      if (t0 === null || !v.active || !hasVisStream(v.member)) continue;
      const from = t0 + samplesToUs(cut, an.rate);
      v.inflight = v.inflight.filter((f) => f.ts < from);
      v.bytes = v.inflight.reduce((s, f) => s + f.size, 0);
      v.lastTs = Math.min(v.lastTs, from);
      const periodic = v.inflight.filter((f) => f.periodic);
      if (v.lastPeriodicTs >= from) v.lastPeriodicTs = periodic.length ? periodic.at(-1).ts : -Infinity;
      if (v.lastSentKey >= cutKey) this.#call(v, () => v.member.streamClear({ roles: ['visualizer'], fromTimestamp: from }));
    }
    this.#kick();
  }

  #configure() {
    const an = this.#an;
    if (!an) return;
    const live = [...this.#members.values()].map((v) => v.config).filter(Boolean);
    const types = new Set(live.flatMap((c) => c.types));
    const spectra = new Map();
    for (const c of live) if (c.types.includes('spectrum')) spectra.set(spectrumKey(c.spectrum), c.spectrum);
    const periodic = live.filter((c) => c.types.some((t) => PERIODIC.includes(t)));
    an.configure({
      display: PERIODIC.some((t) => types.has(t)),
      onsets: types.has('beat') || types.has('peak'),
      rate: periodic.length ? Math.max(...periodic.map((c) => c.rate_max)) : 1,
      spectra,
    });
  }

  #kick() {
    if (this.#timer || !this.#an) return;
    this.#timer = setTimeout(() => this.#pace(), 0);
    this.#timer.unref?.();
  }

  #pace() {
    this.#timer = null;
    const an = this.#an;
    if (!an || !this.#members.size) return;
    const t0 = this.#stream.t0;
    if (t0 !== null) {
      const now = this.#now();
      const horizon = now + this.#stream.sendAheadUs + this.#opts.leadUs;
      const toSample = (us) => Math.floor(Math.max(0, us - t0) * an.rate / 1_000_000);
      an.advance(toSample(horizon) + 1);
      for (const v of [...this.#members.values()]) if (v.active) this.#send(v, an, t0, now, horizon);
      an.prune(toSample(now - KEEP_BEHIND_MS * 1000));
    }
    this.#timer = setTimeout(() => this.#pace(), this.#opts.tickMs);
    this.#timer.unref?.();
  }

  #messages(v, e, ts) {
    const types = v.config.types;
    if (e.kind === KIND.beat) return types.includes('beat') ? [encodeVisBeat(ts, false)] : [];
    if (e.kind === KIND.peak) return types.includes('peak') ? [encodeVisPeak(ts, e.strength)] : [];
    if (ts - v.lastPeriodicTs < 1_000_000 / v.config.rate_max - 100) return [];
    const out = [];
    if (types.includes('loudness')) out.push(encodeVisLoudness(ts, e.loudness));
    if (types.includes('f_peak')) out.push(encodeVisFPeak(ts, e.freq, e.amp));
    if (types.includes('spectrum')) {
      const bins = e.spectra.get(spectrumKey(v.config.spectrum));
      if (bins) out.push(encodeVisSpectrum(ts, bins));
    }
    return out;
  }

  #send(v, an, t0, now, horizon) {
    if (!hasVisStream(v.member)) {
      v.active = false;
      return;
    }
    const cap = v.member.info.visualizer.bufferCapacity;
    while (v.inflight.length && v.inflight[0].ts <= now) v.bytes -= v.inflight.shift().size;
    const final = an.finalFor(v.config.types);
    const events = an.events;
    let lo = 0;
    let hi = events.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (events[mid].key <= v.lastKey) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < events.length; i++) {
      const e = events[i];
      if (e.sample >= final) return;
      const ts = t0 + samplesToUs(e.sample, an.rate);
      if (ts > horizon) return;
      if (ts < now) {
        v.lastKey = e.key;
        v.dropped++;
        continue;
      }
      const msgs = this.#messages(v, e, ts);
      const size = msgs.reduce((s, m) => s + m.length, 0);
      if (size > cap) {
        v.lastKey = e.key;
        v.dropped++;
        continue;
      }
      if (v.bytes + size > cap) return;
      v.lastKey = e.key;
      if (!msgs.length) continue;
      for (const m of msgs) if (this.#call(v, () => v.member.sendBinary(m)) === undefined) return;
      const periodic = e.kind === KIND.frame;
      if (periodic) v.lastPeriodicTs = ts;
      v.inflight.push({ ts, size, periodic });
      v.bytes += size;
      v.lastTs = ts;
      v.lastSentKey = e.key;
      v.sent += msgs.length;
    }
  }
}
