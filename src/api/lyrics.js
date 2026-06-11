import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as config from '../state/config.js';
import * as db from '../db/manager.js';

function lrclibFetch(artist, title, duration) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({ artist_name: artist, track_name: title });
    const dur = Math.round(Number(duration));
    if (dur > 0) params.set('duration', String(dur));
    const url = `https://lrclib.net/api/get?${params}`;
    const req = https.get(url, { headers: { 'User-Agent': 'Velvet-Velvet/1.0 (https://github.com/aroundmyroom/Velvet)' } }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          try { resolve(JSON.parse(data)); } catch { resolve(null); }
        } else {
          resolve(null);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('lrclib timeout')); });
  });
}

function parseLrc(lrc) {
  const lines = [];
  const re = /\[(\d+):(\d+(?:\.\d+)?)\](.*)/;
  for (const raw of lrc.split('\n')) {
    const m = raw.match(re);
    if (m) {
      const time = Number.parseInt(m[1], 10) * 60 + Number.parseFloat(m[2]);
      lines.push({ time, text: m[3].trim() });
    }
  }
  return lines;
}

function cacheDir() {
  return path.join(config.program.storage.dbDirectory, '..', 'lyrics');
}

export function setup(velvet) {
  // GET /api/v1/lyrics?artist=&title=&filepath=&duration=
  // Returns { synced: true, lines: [{time, text}] }
  //       | { synced: false, lines: [{time:null, text}] }
  //       | { notFound: true }
  velvet.get('/api/v1/lyrics', async (req, res) => {
    if (config.program.lyrics?.enabled === false) return res.json({ notFound: true });
    let artist     = (req.query.artist   || '').trim();
    let title      = (req.query.title    || '').trim();
    const filepath = (req.query.filepath || '').trim();

    // If the client passed a raw filename as the title (no DB metadata yet),
    // strip the audio extension and attempt to parse "Artist - Title" from it.
    // e.g. "Alesso & Katy Perry - When I'm Gone.mp3" → artist + title
    const AUDIO_EXT_RE = /\.(mp3|flac|ogg|m4a|aac|wav|opus|wma|aiff?|dsf|dsd)$/i;
    if (AUDIO_EXT_RE.test(title)) {
      const bare = title.replace(AUDIO_EXT_RE, '').trim();
      const sep  = bare.indexOf(' - ');
      if (sep > 0 && !artist) {
        artist = bare.slice(0, sep).trim();
        title  = bare.slice(sep + 3).trim();
      } else {
        title = bare;
      }
    }

    // Prefer authoritative duration from DB; fall back to client-supplied value
    let duration = Number(req.query.duration) || 0;
    if (filepath) {
      try {
        const dbDur = db.getFileDuration(filepath);
        if (dbDur != null && dbDur > 0) duration = dbDur;
      } catch (e) { console.debug('[velvet]', e?.message ?? e); }
    }

    if (!title) return res.json({ notFound: true });

    const hash    = crypto.createHash('sha256')
      .update(`${artist}||${title}||${Math.round(Number(duration))}`)
      .digest('hex');
    const dir     = cacheDir();
    const hitPath = path.join(dir, `${hash}.json`);

    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { console.debug('[velvet]', e?.message ?? e); }

    // Serve from cache (successful hits only — never cache "not found")
    if (fs.existsSync(hitPath)) {
      try { return res.json(JSON.parse(fs.readFileSync(hitPath, 'utf8'))); } catch (e) { console.debug('[velvet]', e?.message ?? e); }
    }

    // Fetch from lrclib.net — try with duration first (exact match),
    // then without duration (fuzzy title+artist) as fallback.
    // Each call is wrapped in its own try/catch so a timeout or error on the
    // exact-duration call does NOT prevent the fuzzy fallback from running.
    try {
      let data = null;
      if (duration > 0) {
        try { data = await lrclibFetch(artist, title, duration); } catch (e) { console.debug('[velvet]', e?.message ?? e); }
      }
      if (!data) {
        try { data = await lrclibFetch(artist, title, 0); } catch (e) { console.debug('[velvet]', e?.message ?? e); }
      }

      if (!data || (!data.syncedLyrics && !data.plainLyrics)) {
        return res.json({ notFound: true });
      }

      let result;
      if (data.syncedLyrics) {
        const lines = parseLrc(data.syncedLyrics);
        result = { synced: true, lines };
      } else {
        const lines = data.plainLyrics
          .split('\n')
          .map(t => ({ time: null, text: t.trim() }))
          .filter(l => l.text);
        result = { synced: false, lines };
      }

      try { fs.writeFileSync(hitPath, JSON.stringify(result)); } catch (e) { console.debug('[velvet]', e?.message ?? e); }
      return res.json(result);
    } catch {
      return res.json({ notFound: true });
    }
  });
}
