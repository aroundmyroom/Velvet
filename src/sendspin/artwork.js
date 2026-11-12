import fsp from 'node:fs/promises';
import path from 'node:path';
import { parseFile } from 'music-metadata';
import sharp from 'sharp';
import { resolvePathWithinRoot } from '../util/path-security.js';

const AA_FILE = /^[A-Za-z0-9_-]{1,100}\.[A-Za-z0-9]{1,7}$/;
const FOLDER_IMAGES = ['cover.jpg', 'cover.jpeg', 'cover.png', 'folder.jpg', 'folder.jpeg', 'folder.png', 'front.jpg', 'front.jpeg', 'front.png'];
const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const MAX_DIMENSION = 4096;
const MIN_CONTRAST = 4.5;
const WHITE = [255, 255, 255];
const BLACK = [0, 0, 0];

class Lru {
  #max;
  #map = new Map();

  constructor(max) {
    this.#max = max;
  }

  get(key) {
    if (!this.#map.has(key)) return undefined;
    const v = this.#map.get(key);
    this.#map.delete(key);
    this.#map.set(key, v);
    return v;
  }

  set(key, value) {
    this.#map.delete(key);
    this.#map.set(key, value);
    while (this.#map.size > this.#max) this.#map.delete(this.#map.keys().next().value);
    return value;
  }
}

function channelLinear(c) {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function luminance([r, g, b]) {
  return 0.2126 * channelLinear(r) + 0.7152 * channelLinear(g) + 0.0722 * channelLinear(b);
}

export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function toHsl([r, g, b]) {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return [h * 60, s, l];
}

function fromHsl([h, s, l]) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)].map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255));
}

function adjustUntil(rgb, dir, ok) {
  const [h, s, l0] = toHsl(rgb);
  for (let l = l0; l >= 0 && l <= 1; l += dir * 0.01) {
    const c = fromHsl([h, s, l]);
    if (ok(c)) return c;
  }
  return dir > 0 ? WHITE : BLACK;
}

function hueDistance(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

export function paletteFrom(primary, pixels) {
  const [ph] = toHsl(primary);
  let accent = null;
  let best = 0;
  for (const px of pixels) {
    const [h, s, l] = toHsl(px);
    if (l < 0.15 || l > 0.9) continue;
    const score = s * (hueDistance(h, ph) >= 30 ? 1 : 0.2);
    if (score > best) {
      best = score;
      accent = px;
    }
  }
  if (!accent || best < 0.15) {
    const [h, s, l] = toHsl(primary);
    accent = fromHsl([(h + 180) % 360, Math.max(s, 0.35), Math.min(Math.max(l, 0.35), 0.65)]);
  }
  const backgroundDark = adjustUntil(primary, -1, (c) => contrast(c, WHITE) >= MIN_CONTRAST);
  const onDark = adjustUntil(primary, 1, (c) => contrast(c, backgroundDark) >= MIN_CONTRAST && contrast(c, BLACK) >= MIN_CONTRAST);
  const backgroundLight = adjustUntil(primary, 1, (c) => contrast(c, BLACK) >= MIN_CONTRAST);
  const onLight = adjustUntil(primary, -1, (c) => contrast(c, backgroundLight) >= MIN_CONTRAST && contrast(c, WHITE) >= MIN_CONTRAST);
  return {
    primary: [...primary], accent, background_dark: backgroundDark, background_light: backgroundLight, on_dark: onDark, on_light: onLight,
  };
}

async function readCapped(file) {
  const st = await fsp.stat(file);
  if (!st.isFile() || st.size > MAX_SOURCE_BYTES) return null;
  return fsp.readFile(file);
}

export function createArtwork({ artDir, maxImages = 64, maxSources = 8, maxColors = 256 }) {
  const images = new Lru(maxImages);
  const sources = new Lru(maxSources);
  const colors = new Lru(maxColors);

  async function cachedArt(aaFile) {
    if (!artDir || typeof aaFile !== 'string' || !AA_FILE.test(aaFile)) return null;
    try {
      return await readCapped(resolvePathWithinRoot(artDir, aaFile));
    } catch {
      return null;
    }
  }

  async function embeddedOrFolder(file) {
    try {
      const meta = await parseFile(file, { skipCovers: false, duration: false });
      const pic = meta.common?.picture?.[0];
      if (pic?.data?.length && pic.data.length <= MAX_SOURCE_BYTES) return Buffer.from(pic.data);
    } catch {
      // Not every container parses; fall back to a folder image.
    }
    const dir = path.dirname(file);
    for (const name of FOLDER_IMAGES) {
      try {
        const buf = await readCapped(resolvePathWithinRoot(dir, name));
        if (buf) return buf;
      } catch {
        // missing candidate
      }
    }
    return null;
  }

  function sourceKey(item) {
    return item.meta?.aaFile ? `aa:${item.meta.aaFile}` : `file:${item.file}`;
  }

  function source(item) {
    const key = sourceKey(item);
    let p = sources.get(key);
    if (p === undefined) {
      p = sources.set(key, (async () => (await cachedArt(item.meta?.aaFile)) ?? (item.file ? embeddedOrFolder(item.file) : null))());
    }
    return p;
  }

  function render(buf, { format, width, height }) {
    const out = sharp(buf, { failOn: 'none', limitInputPixels: 64 * 1024 * 1024 })
      .rotate()
      .resize(width, height, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 1 } })
      .flatten({ background: { r: 0, g: 0, b: 0 } });
    return format === 'png' ? out.png().toBuffer() : out.jpeg({ quality: 85 }).toBuffer();
  }

  function artworkFor(item, spec) {
    if (!item || spec?.source !== 'album' || !['jpeg', 'png'].includes(spec.format)) return null;
    const { width, height } = spec;
    if (![width, height].every((v) => Number.isInteger(v) && v >= 1 && v <= MAX_DIMENSION)) return null;
    const key = `${sourceKey(item)}|${spec.format}|${width}x${height}`;
    let p = images.get(key);
    if (p === undefined) {
      p = images.set(key, source(item).then((buf) => (buf ? render(buf, { format: spec.format, width, height }) : null)).catch(() => null));
    }
    return p;
  }

  async function extractColors(buf) {
    const img = sharp(buf, { failOn: 'none', limitInputPixels: 64 * 1024 * 1024 }).flatten({ background: { r: 0, g: 0, b: 0 } });
    const { dominant } = await img.clone().stats();
    const { data, info } = await img.resize(12, 12, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const pixels = [];
    for (let i = 0; i + 2 < data.length; i += info.channels) pixels.push([data[i], data[i + 1], data[i + 2]]);
    return paletteFrom([dominant.r, dominant.g, dominant.b], pixels);
  }

  function colorFor(item) {
    if (!item) return null;
    const key = sourceKey(item);
    let p = colors.get(key);
    if (p === undefined) p = colors.set(key, source(item).then((buf) => (buf ? extractColors(buf) : null)).catch(() => null));
    return p;
  }

  return { artworkFor, colorFor };
}
