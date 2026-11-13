// Lyrics for one song in the OpenSubsonic structuredLyrics shape
// ({ lang, synced, offset?, line: [{ start?, value }] }), synced first.
// Sources, cheapest first — no network: Subsonic clients such as Music
// Assistant ask for lyrics of every track they sync.
//   1. a sidecar .lrc / .txt next to the audio file
//   2. lyrics embedded in the file (USLT/SYLT, Vorbis LYRICS, …; LRC text counts as synced)
//   3. Velvet's own lyrics cache, filled when the web player fetched them from lrclib

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const LRC_TIME = /\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g;
const LRC_OFFSET = /^\[offset:\s*([+-]?\d+)\s*\]/im;
const MAX_SIDECAR_BYTES = 512 * 1024;

export function parseLrc(text) {
  const timed = [];
  const plain = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const stamps = [...raw.matchAll(LRC_TIME)];
    if (!stamps.length) {
      if (raw.trim() && !/^\[[a-z]+:.*\]$/i.test(raw.trim())) plain.push(raw.trim());
      continue;
    }
    const value = raw.replaceAll(LRC_TIME, '').trim();
    for (const m of stamps) {
      const sec = Number.parseFloat(m[2].replace(':', '.'));
      timed.push({ start: Math.round((Number.parseInt(m[1], 10) * 60 + sec) * 1000), value });
    }
  }
  if (timed.length) {
    // LRC [offset:+n] shows the lyrics n ms sooner. Applied to the start times
    // rather than passed on: clients disagree on the sign of the OpenSubsonic offset.
    const off = LRC_OFFSET.exec(String(text || ''));
    const shift = off ? Number.parseInt(off[1], 10) : 0;
    const line = timed.map(l => ({ start: Math.max(0, l.start - shift), value: l.value })).sort((a, b) => a.start - b.start);
    return { lang: 'xxx', synced: true, line };
  }
  return plain.length ? { lang: 'xxx', synced: false, line: plain.map(value => ({ value })) } : null;
}

function readSidecar(fullPath) {
  const base = fullPath.slice(0, fullPath.length - path.extname(fullPath).length);
  for (const ext of ['.lrc', '.LRC', '.txt']) {
    try {
      const st = fs.statSync(base + ext);
      if (!st.isFile() || st.size > MAX_SIDECAR_BYTES) continue;
      const parsed = parseLrc(fs.readFileSync(base + ext, 'utf8'));
      if (parsed) return parsed;
    } catch { /* no sidecar */ }
  }
  return null;
}

// music-metadata ≥ 8: common.lyrics is ILyricsTag[] ({ text?, syncText[], timeStampFormat });
// older versions gave plain strings.
export function lyricsFromTags(tags) {
  const out = [];
  for (const tag of tags || []) {
    if (typeof tag === 'string') {
      const p = parseLrc(tag);
      if (p) out.push(p);
      continue;
    }
    const sync = (tag?.syncText || []).filter(l => l?.text != null);
    // timeStampFormat 2 = milliseconds; MPEG-frame stamps cannot be converted without the frame rate.
    if (sync.length && tag.timeStampFormat === 2) {
      out.push({ lang: tag.language || 'xxx', synced: true, line: sync.map(l => ({ start: l.timestamp ?? 0, value: l.text })) });
    } else if (tag?.text) {
      const p = parseLrc(tag.text);
      if (p) out.push({ ...p, lang: tag.language || p.lang });
    } else if (sync.length) {
      out.push({ lang: tag.language || 'xxx', synced: false, line: sync.map(l => ({ value: l.text })) });
    }
  }
  return out;
}

// Same key as GET /api/v1/lyrics (src/api/lyrics.js), which the web player
// calls with the DB artist, title and duration.
export function readLyricsCache(cacheDir, artist, title, duration) {
  if (!cacheDir || !title) return null;
  for (const dur of new Set([Math.round(Number(duration) || 0), 0])) {
    const key = crypto.createHash('sha256').update(`${String(artist || '').trim()}||${String(title).trim()}||${dur}`).digest('hex');
    try {
      const hit = JSON.parse(fs.readFileSync(path.join(cacheDir, `${key}.json`), 'utf8'));
      const lines = (hit?.lines || []).filter(l => l?.text != null);
      if (!lines.length) continue;
      if (hit.synced) return { lang: 'xxx', synced: true, line: lines.map(l => ({ start: Math.round((l.time || 0) * 1000), value: l.text })) };
      return { lang: 'xxx', synced: false, line: lines.map(l => ({ value: l.text })) };
    } catch { /* not cached */ }
  }
  return null;
}

export async function songLyrics({ fullPath, artist, title, duration, cacheDir }) {
  const found = [];
  const sidecar = readSidecar(fullPath);
  if (sidecar) found.push(sidecar);
  try {
    const { parseFile } = await import('music-metadata');
    const meta = await parseFile(fullPath, { skipCovers: true, duration: false });
    found.push(...lyricsFromTags(meta?.common?.lyrics));
  } catch { /* unreadable file */ }
  if (!found.some(l => l.synced)) {
    const cached = readLyricsCache(cacheDir, artist, title, duration);
    if (cached) found.push(cached);
  }
  for (const l of found) {
    if (artist) l.displayArtist = artist;
    if (title) l.displayTitle = title;
  }
  return found.sort((a, b) => Number(b.synced) - Number(a.synced));
}
