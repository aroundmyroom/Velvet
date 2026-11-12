// The web player's 8-band EQ (webapp/app.js EQ_BANDS) for a room's decode. Same bands, same Web Audio biquads
// (Audio EQ Cookbook; shelves at slope 1), mapped onto ffmpeg's cookbook filters so a room sounds like the browser.
export const EQ_BANDS = Object.freeze([
  { freq: 60, type: 'lowshelf', q: 1 },
  { freq: 100, type: 'peaking', q: 1.8 },
  { freq: 200, type: 'peaking', q: 1.4 },
  { freq: 500, type: 'peaking', q: 1.8 },
  { freq: 1000, type: 'peaking', q: 1.4 },
  { freq: 3000, type: 'peaking', q: 1.4 },
  { freq: 10000, type: 'peaking', q: 1.4 },
  { freq: 14000, type: 'highshelf', q: 1 },
]);
export const EQ_MIN_DB = -12;
export const EQ_MAX_DB = 12;
export const MAX_PRESET_LENGTH = 32;

const FILTER = { lowshelf: 'lowshelf', peaking: 'equalizer', highshelf: 'highshelf' };
const GRID_POINTS = 2048;
const GRID_LOW_HZ = 10;
export const LIMITER = 'alimiter=limit=0.98855:attack=1:release=50:level=0:latency=1';

export function defaultEq() {
  return { enabled: true, gains: EQ_BANDS.map(() => 0), preset: null };
}

export function normalizeEq(eq) {
  const gains = EQ_BANDS.map((_, i) => {
    const g = Number(eq?.gains?.[i]);
    return Number.isFinite(g) ? Math.max(EQ_MIN_DB, Math.min(EQ_MAX_DB, Math.round(g * 10) / 10)) : 0;
  });
  const preset = typeof eq?.preset === 'string' && eq.preset ? eq.preset.slice(0, MAX_PRESET_LENGTH) : null;
  return { enabled: eq?.enabled !== false, gains, preset };
}

export function isDefaultEq(eq) {
  return eq.enabled && eq.preset === null && eq.gains.every((g) => g === 0);
}

export function eqActive(eq) {
  return Boolean(eq?.enabled) && Array.isArray(eq.gains) && eq.gains.some((g) => g !== 0);
}

function coefficients(band, gainDb, rate) {
  const A = 10 ** (gainDb / 40);
  const w0 = 2 * Math.PI * Math.min(band.freq, rate / 2) / rate;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  if (band.type === 'peaking') {
    const alpha = sin / (2 * band.q);
    return [1 + alpha * A, -2 * cos, 1 - alpha * A, 1 + alpha / A, -2 * cos, 1 - alpha / A];
  }
  const k = 2 * Math.sqrt(A) * (sin / 2) * Math.SQRT2;
  const s = band.type === 'lowshelf' ? 1 : -1;
  return [
    A * ((A + 1) - s * (A - 1) * cos + k),
    s * 2 * A * ((A - 1) - s * (A + 1) * cos),
    A * ((A + 1) - s * (A - 1) * cos - k),
    (A + 1) + s * (A - 1) * cos + k,
    -s * 2 * ((A - 1) + s * (A + 1) * cos),
    (A + 1) + s * (A - 1) * cos - k,
  ];
}

function magnitude([b0, b1, b2, a0, a1, a2], w) {
  const c1 = Math.cos(w);
  const s1 = Math.sin(w);
  const c2 = Math.cos(2 * w);
  const s2 = Math.sin(2 * w);
  const num = Math.hypot(b0 + b1 * c1 + b2 * c2, b1 * s1 + b2 * s2);
  const den = Math.hypot(a0 + a1 * c1 + a2 * c2, a1 * s1 + a2 * s2);
  return num / den;
}

export function eqResponseDb(gains, freq, rate) {
  const w = 2 * Math.PI * freq / rate;
  let mag = 1;
  EQ_BANDS.forEach((b, i) => {
    if (gains[i]) mag *= magnitude(coefficients(b, gains[i], rate), w);
  });
  return 20 * Math.log10(mag);
}

// The loudest point of the whole cascade, not the largest band: neighbouring boosts add up (60 Hz shelf + 100 Hz
// peak at +12 dB each reach about +19 dB in between).
export function eqHeadroomDb(gains, rate) {
  if (!gains.some((g) => g > 0)) return 0;
  const nyquist = rate / 2;
  const span = Math.log(nyquist / GRID_LOW_HZ);
  let peak = 0;
  for (let i = 0; i <= GRID_POINTS; i++) {
    peak = Math.max(peak, eqResponseDb(gains, GRID_LOW_HZ * Math.exp(span * i / GRID_POINTS), rate));
  }
  for (const b of EQ_BANDS) if (b.freq < nyquist) peak = Math.max(peak, eqResponseDb(gains, b.freq, rate));
  return peak;
}

const num = (v) => Number(v.toFixed(4)).toString();

// headroomDb goes into the decoder's volume= ahead of the bands, so steady tones never pass the source peak. A
// biquad still overshoots on full-scale square-ish material (brick-walled masters measured +2.4 dB at +12 dB), so a
// look-ahead limiter at -0.1 dBFS guards the end; below that it passes samples bit-exact, latency compensated.
export function eqFilterChain(eq, rate) {
  if (!eqActive(eq)) return { headroomDb: 0, filters: [] };
  const bands = EQ_BANDS.flatMap((b, i) => {
    if (!eq.gains[i] || b.freq >= rate / 2) return [];
    const width = b.type === 'peaking' ? `t=q:w=${num(b.q)}` : 't=s:w=1';
    return [`${FILTER[b.type]}=f=${b.freq}:${width}:g=${num(eq.gains[i])}`];
  });
  if (!bands.length) return { headroomDb: 0, filters: [] };
  return {
    headroomDb: Math.ceil(eqHeadroomDb(eq.gains, rate) * 100) / 100,
    filters: [`aformat=sample_fmts=fltp:sample_rates=${rate}`, ...bands, LIMITER],
  };
}
