import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Joi from 'joi';
import * as config from '../state/config.js';
import * as dbManager from '../db/manager.js';
import { resolvePathWithinRoot } from '../util/path-security.js';
import { fetchPublicJson, fetchPublicUrlBuffer, isPrivateHost } from '../util/ssrf-check.js';
import { getVPathInfo } from '../util/vpath.js';
import { joiValidate } from '../util/validation.js';
import { ffmpegBin } from '../util/ffmpeg-bootstrap.js';

const execFileAsync = promisify(execFile);

const UA_BASE = 'Velvet/dev +https://github.com/aroundmyroom/Velvet';

function discogsHeaders() {
  const { apiKey, apiSecret, userAgentTag } = config.program.discogs;
  const ua = userAgentTag ? `Velvet/dev/${userAgentTag} +https://github.com/aroundmyroom/Velvet` : UA_BASE;
  return {
    'User-Agent': ua,
    'Authorization': `Discogs key=${apiKey}, secret=${apiSecret}`,
  };
}

async function discogsGet(url) {
  const parsed = new URL(url);
  if (parsed.hostname.toLowerCase() !== 'api.discogs.com') {
    throw new Error('Discogs API host not allowed');
  }
  return fetchPublicJson(url, {
    headers: discogsHeaders(),
    allowedHosts: new Set(['api.discogs.com']),
    maxRedirects: 0,
    maxContentLength: 5 * 1024 * 1024,
  });
}

async function fetchImageBuf(url, useDiscogsAuth = true) {
  const buf = await fetchPublicUrlBuffer(url, {
    headers: useDiscogsAuth ? discogsHeaders() : { 'User-Agent': UA_BASE },
    maxContentLength: 20 * 1024 * 1024,
  });
  // Validate JPEG magic bytes — redirects or HTML error pages must not be
  // treated as images.
  if (buf.length < 3 || buf[0] !== 0xFF || buf[1] !== 0xD8 || buf[2] !== 0xFF) {
    throw new Error(`Discogs returned non-JPEG data (${buf.length} bytes, starts: ${buf.subarray(0, 4).toString('hex')})`);
  }
  return buf;
}

/**
 * Extract a catalog number from a folder/file name segment.
 * Looks for trailing parenthetical or bracket groups whose content matches
 * a catalog-number pattern: letter prefix + optional digits + digits.
 * Examples: "(SMR 624)", "[SP5-1306]", "(DGCD-24425)", "(12CL 001)"
 * Skips: "(FLAC)", "(2004)", "(2xLP)", "(320kbps)"
 */
function extractCatno(s) {
  if (!s) return null;
  const YEAR_ONLY  = /^\d{4}$/;
  const FORMAT_KW  = /^(FLAC|MP3|WAV|OGG|AAC|ALAC|WMA|APE|WV|OPUS|DSD|320|256|192|128|CBR|VBR|lossless|lossy|CD|LP|EP|vinyl|dvd)$/i;
  const DISC_LABEL = /^\d+(x|CD|LP|EP)/i;   // "2xLP", "3CD", "2LP"
  // catno must start with letters, contain digits; may have space/dash between prefix and number
  // OK: "SMR 624", "SP5-1306", "DGCD-24425", "12CL 001", "ATL 50-123", "SMR624"
  const CATNO_RE = /^[A-Za-z]{1,6}\d{0,4}[\s-]?\d{2,7}[A-Za-z]{0,3}$/;
  const re = /[([]\s*([^\])]{2,25})\s*[)\]]/g;
  const blocks = [];
  let m;
  while ((m = re.exec(s)) !== null) blocks.push(m[1].trim());
  // Check from last (trailing) to first  — trailing parens hold catnos more often
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (YEAR_ONLY.test(b) || FORMAT_KW.test(b) || DISC_LABEL.test(b)) continue;
    if (CATNO_RE.test(b)) return b;
  }
  return null;
}

/**
 * Detect "X Presents [Y]"-style artist names (label/DJ compilations).
 * Returns the label part (before "Presents") or null when not a Presents artist.
 * Examples: "Salsoul Presents" → "Salsoul"
 *           "Larry Levan Presents" → "Larry Levan"
 */
function presentsLabel(artist) {
  if (!artist) return null;
  const m = artist.match(/^(.+?)\s+presents?\b/i);
  return m ? m[1].trim() : null;
}

/**
 * Cleans a raw filename/title string by stripping audio extension and
 * dot-separated hash/ID segments (e.g. ".G12U", ".3FAB8").
 * Works on both spaced and CamelCase filenames.
 */
function cleanFilenameNoise(s) {
  if (!s) return s;
  // Strip audio extension
  s = s.replace(/\.(mp3|flac|wav|ogg|aac|m4a|m4b|opus|aiff|wma|ape|wv)$/i, '');
  // Strip dot-separated short hash/ID segments (2-8 uppercase alphanum chars)
  s = s.replaceAll(/\.[A-Z0-9]{2,8}(?=\.|$)/gi, '');
  return s.trim();
}

/**
 * If `raw` looks like a filename-style string, parse it into { artist, title }.
 * Handles two patterns:
 *   A) Spaced:    "Kool & the Gang - Fresh (Mark Berry Remix).G12U.wav"
 *                  → artist="Kool & the Gang", title="Fresh (Mark Berry Remix)"
 *   B) CamelCase: "RobinS-ShowMeLove-Acappella.G12U.wav"
 *                  → artist="Robin S", title="Show Me Love"
 * Returns null when `raw` doesn't look filename-like.
 */
function parseFilename(raw) {
  if (!raw) return null;
  const s = cleanFilenameNoise(raw);
  if (!s) return null;

  // Pattern A: contains " - " (spaced dash) → "Artist - Title" convention
  if (/ - /.test(s)) {
    const idx = s.indexOf(' - ');
    const artist = s.slice(0, idx).trim();
    const title  = s.slice(idx + 3).trim();
    if (artist && title) return { artist, title };
    if (title) return { artist: null, title };
  }

  // Pattern B: no spaces at all → CamelCase/dash joined
  if (!/\s/.test(s)) {
    let t = s;
    // Strip trailing version/descriptor words
    t = t.replace(/[-_\s]+(acappella|acapella|a[\s-]?cappella|instrumental|instr\b|extended|radio[\s-]?edit|club[\s-]?mix|original[\s-]?mix|dub[\s-]?mix|dub\b|remix|remaster(?:ed)?|version\b|edit\b|vip\b|bootleg|demo\b|live\b)$/i, '');
    // Split on dashes, expand each CamelCase segment into words
    const parts = t.split('-').map(seg =>
      seg
        .replaceAll('_', ' ')
        .replaceAll(/([a-z])([A-Z])/g, '$1 $2')
        .replaceAll(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .replaceAll(/\s{2,}/g, ' ')
        .trim()
    ).filter(Boolean);
    if (!parts.length) return null;
    if (parts.length === 1) return { artist: null, title: parts[0] };
    return { artist: parts[0], title: parts[1] };
  }

  return null;
}

/**
 * Returns true when the album string looks like a generic compilation /
 * various-artists release where the album title is NOT specific to one artist
 * (e.g. "Complete Top 40 Van 1982", "Greatest Hits of the 80s", …).
 * In that case it makes no sense to search Discogs by album name first.
 */
function isCompilationAlbum(album) {
  if (!album) return false;
  return /\b(top\s*\d+|chart\s*hit|nr\.?\s*\d|number\s*\d|\bva\b|various|compilation|collection|greatest\s*hit|best\s*of|\bgold\b|\bhits\b|all\s*star|one\s*hit|radio\s*hit|nostalg|evergre|classic\s*hit|essential|playlist|mixtape)/i.test(album);
}

/**
 * Score how well the Discogs result artist (extracted from "Artist - Title"
 * format) matches the requested artist. Returns 0 (no match) → 1 (exact).
 * Handles Discogs split-artist titles like "Artist A / Artist B - Release".
 */
function artistMatchScore(requestedArtist, discogsTitle) {
  if (!requestedArtist || !discogsTitle) return 0.5;
  const normalize = s => s.toLowerCase().replaceAll(/[^a-z0-9 ]/g, '').replaceAll(/\s+/g, ' ').trim();
  // Discogs title format: "Artists - Release Title" (last ' - ' separates)
  const dashIdx = discogsTitle.lastIndexOf(' - ');
  const artistPart = dashIdx > 0 ? discogsTitle.slice(0, dashIdx) : '';
  if (!artistPart) return 0.5; // no artist portion extractable → neutral
  const req = normalize(requestedArtist);
  const art = normalize(artistPart);

  // "X Presents [Y]" artists: the actual Discogs artist will be "Various" or
  // something similar. Treat Various/label results as a good match.
  const presLbl = presentsLabel(requestedArtist);
  if (presLbl) {
    if (art === 'various' || art.startsWith('various ')) return 0.85;
    if (art.includes(normalize(presLbl))) return 0.9;  // label name in artist
    return 0.7;  // any result from a Presents search is plausible
  }

  if (art === req) return 1;
  if (art.includes(req) || req.includes(art)) return 0.9;
  // word-level overlap for partial matches (e.g. "Francine McGee" in "A / Francine McGee")
  const reqWords = req.split(' ').filter(w => w.length > 1);
  const artWords = new Set(art.split(' '));
  if (!reqWords.length) return 0.5;
  const matched = reqWords.filter(w => artWords.has(w)).length;
  return matched / reqWords.length;
}

export function setup(velvet) {

  // ── GET /api/v1/discogs/coverart?artist=X&title=Y&album=Z&year=N ──────────
  // Admin only. Returns up to 8 Discogs release cover thumbs (base64).
  velvet.get('/api/v1/discogs/coverart', async (req, res) => {
    if (config.program.discogs?.enabled === false) return res.status(404).json({ error: 'Discogs not enabled' });
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });

    let artist = String(req.query.artist || '').trim();
    const title   = cleanFilenameNoise(String(req.query.title  || '').trim());
    let album   = cleanFilenameNoise(String(req.query.album  || '').trim());
    const year  = String(req.query.year   || '').trim();
    const rawFilepath = String(req.query.filepath || '').trim();

    const albumTagIsCompilation = isCompilationAlbum(album);
    ({ artist, album } = _enrichFromFilepath(artist, album, albumTagIsCompilation, rawFilepath));

    let catno = _extractCatnoFromPath(rawFilepath);
    if (!catno && album) catno = extractCatno(album);
    const presLabel = presentsLabel(artist);

    if (!artist && !title && !album) return res.status(400).json({ error: 'artist, title, or album required' });

    const compilationAlbum = isCompilationAlbum(album);
    const albumPhase = (compilationAlbum && artist && title) ? 'C' : 'A';

    const searches = _buildSearches(artist, title, album, year, catno, presLabel, albumPhase);

    try {
      const searchSettled = await Promise.allSettled(
        searches.map(({ params }) =>
          discogsGet(`https://api.discogs.com/database/search?${params}`)
        )
      );
      const candidates = _buildCandidates(searchSettled, searches, artist);
      const choices    = await _resolveImages(candidates);
      res.json({ choices });
    } catch (e) {
      const status = e?.response?.status;
      if (status === 429) return res.status(429).json({ error: 'Discogs rate limit reached — please wait a minute before searching again' });
      res.status(500).json({ error: e.message });
    }
  });
  // ── GET /api/v1/deezer/search ──────────────────────────────────
  // Server-side proxy for the Deezer album search API.
  // Required because the Deezer API does not set CORS headers, so browsers
  // can't call it directly from an HTTPS origin.
  // Accepts optional ?artist=&album= in addition to ?q= to allow server-side
  // smart query building (Presents stripping, catalog number injection).
  velvet.get('/api/v1/deezer/search', async (req, res) => {
    let q = (req.query.q || '').trim();
    // Smart query: if artist+album are supplied separately, build a clean q.
    // Strip "X Presents" from artist — Deezer doesn't know about it.
    if (!q && (req.query.artist || req.query.album)) {
      let a = (req.query.artist || '').trim();
      const b = (req.query.album  || '').trim();
      const pres = presentsLabel(a);
      if (pres) a = '';  // drop "Salsoul Presents" — search album name only
      q = [a, b].filter(Boolean).join(' ');
    }
    if (!q) return res.status(400).json({ error: 'q is required' });
    try {
      const url = `https://api.deezer.com/search/album?q=${encodeURIComponent(q)}&limit=10`;
      const data = await fetchPublicJson(url, {
        headers: { 'User-Agent': UA_BASE },
        allowedHosts: new Set(['api.deezer.com']),
        maxRedirects: 0,
        maxContentLength: 5 * 1024 * 1024,
      });
      res.json(data);
    } catch (e) {
      const status = e?.httpStatus;
      if (status === 429) return res.status(429).json({ error: 'Deezer rate limit reached — please wait a minute before searching again' });
      res.status(502).json({ error: 'Deezer request failed: ' + e.message });
    }
  });

  // ── GET /api/v1/itunes/search ──────────────────────────────────
  // Server-side proxy for the iTunes Search API (album art lookup).
  // Returns up to 10 album results with 600×600 artwork URLs.
  velvet.get('/api/v1/itunes/search', async (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });
    let artist = (req.query.artist || '').trim();
    const album  = (req.query.album  || '').trim();
    // Strip "X Presents" from artist — iTunes treats it as part of the artist name
    // and fails to find "Various Artists" compilations.
    const pres = presentsLabel(artist);
    if (pres) artist = '';  // search album-only; iTunes finds it without the presents prefix
    const q = [artist, album].filter(Boolean).join(' ');
    if (!q) return res.json({ results: [] });
    try {
      const url = `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&entity=album&limit=10`;
      const data = await fetchPublicJson(url, {
        headers: { 'User-Agent': UA_BASE },
        allowedHosts: new Set(['itunes.apple.com']),
        maxRedirects: 0,
        maxContentLength: 5 * 1024 * 1024,
      });
      const results = (data.results || [])
        .filter(r => r.artworkUrl100)
        .map(r => ({
          coverUrl: r.artworkUrl100.replaceAll('100x100bb', '3000x3000bb'),
          label:    `${r.collectionName}` + (r.releaseDate ? ` (${r.releaseDate.substring(0,4)})` : ''),
          thumb:    r.artworkUrl100.replaceAll('100x100bb', '250x250bb'),
        }));
      res.json({ results });
    } catch (e) {
      const status = e?.httpStatus;
      if (status === 429) return res.status(429).json({ error: 'iTunes rate limit reached — please wait a minute before searching again' });
      res.status(502).json({ error: 'iTunes request failed: ' + e.message });
    }
  });

  // ── POST /api/v1/discogs/embed ─────────────────────────────────
  // Admin only. Downloads full-res cover from Discogs and embeds
  // it into the audio file using ffmpeg (no cover.jpg written to disk).
  velvet.post('/api/v1/discogs/embed', async (req, res) => {
    if (config.program.discogs?.enabled === false) return res.status(404).json({ error: 'Discogs not enabled' });
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });

    const schema = Joi.object({
      filepath:  Joi.string().required(),
      releaseId: Joi.number().integer(),
      coverUrl:  Joi.string().uri(),
    }).or('releaseId', 'coverUrl');

    let pathInfo;
    try {
      joiValidate(schema, req.body);
      pathInfo = getVPathInfo(req.body.filepath, req.user);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
    const absPath = pathInfo.fullPath;
    if (!fs.existsSync(absPath)) return res.status(404).json({ error: 'File not found' });

    // WAV and AIFF containers don't support embedded cover art — cache to DB only
    const extLower = path.extname(absPath).toLowerCase();
    const cacheOnly = ['.wav', '.aiff', '.aif', '.w64'].includes(extLower);

    // Declare temp paths before try so the catch block can clean them up.
    // tmpCover goes to the OS temp dir so it never appears as a visible file in
    // the user's NFS music directory during download.
    // tmpOut must be in the same directory as absPath so fs.renameSync is a
    // single-syscall atomic replace (same filesystem, avoids EXDEV errors).
    const _ts      = Date.now();
    const tmpCover = path.join(os.tmpdir(), `.velvet-cover-${_ts}.jpg`);
    const tmpOut   = path.join(path.dirname(absPath), `.velvet-out-${_ts}${extLower}`);

    try {
      let imgUrl;
      if (req.body.coverUrl) {
        // Direct URL path (e.g. from Deezer) — skip Discogs API call.
        // Guard against SSRF: reject private/loopback hosts.
        let parsedCoverUrl;
        try { parsedCoverUrl = new URL(req.body.coverUrl); } catch {
          return res.status(400).json({ error: 'Invalid coverUrl' });
        }
        if (parsedCoverUrl.protocol !== 'https:' && parsedCoverUrl.protocol !== 'http:') {
          return res.status(400).json({ error: 'coverUrl must be http or https' });
        }
        if (isPrivateHost(parsedCoverUrl.hostname)) {
          return res.status(400).json({ error: 'coverUrl resolves to a private address' });
        }
        imgUrl = req.body.coverUrl;
      } else {
        // Fetch full-res primary image from Discogs
        const release = await discogsGet(`https://api.discogs.com/releases/${req.body.releaseId}`);
        const images  = release.images || [];
        const img     = images.find(i => i.type === 'primary') || images[0];
        if (!img?.uri) return res.status(404).json({ error: 'No cover image for this release' });
        imgUrl = img.uri;
      }

      const imgBuf   = await fetchImageBuf(imgUrl, !req.body.coverUrl);
      fs.writeFileSync(tmpCover, imgBuf);

      if (!cacheOnly) {
        const ffmpegBinPath = ffmpegBin();
        await _embedCoverArt(ffmpegBinPath, absPath, tmpCover, tmpOut);
        fs.renameSync(tmpOut, absPath);
        await _fixPtsIssues(ffmpegBinPath, absPath, tmpCover, extLower, _ts);
        // Keep DB mtime aligned with the rewritten file so incremental scans
        // don't treat this server-side edit as an external stale change.
        try {
          const newMtime = fs.statSync(absPath).mtime.getTime();
          dbManager.updateFileModified(pathInfo.relativePath, pathInfo.vpath, newMtime);
        } catch (mtimeErr) {
          console.debug('[velvet]', mtimeErr?.message ?? mtimeErr);
        }
      }

      try { fs.unlinkSync(tmpCover); } catch (e) { console.debug('[velvet]', e?.message ?? e); }

      const { aaFile } = await _updateArtRecord(imgBuf, pathInfo, config.program.storage.albumArtDirectory, req.body.coverUrl);
      res.json({ ok: true, aaFile, cacheOnly });
    } catch (e) {
      try { fs.unlinkSync(tmpCover); } catch (e) { console.debug('[velvet]', e?.message ?? e); }
      try { fs.unlinkSync(tmpOut);   } catch (e) { console.debug('[velvet]', e?.message ?? e); }
      console.error('[discogs/embed] ERROR:', e);
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/v1/discogs/release-images?id=X&type=release|master ──────────
  // Admin only. Returns thumbnails for a specific Discogs release/master ID.
  velvet.get('/api/v1/discogs/release-images', async (req, res) => {
    if (!req.user?.admin) return res.status(403).json({ error: 'Admin only' });
    const { error, value } = Joi.object({
      id:   Joi.number().integer().positive().required(),
      type: Joi.string().valid('release', 'master').default('release'),
    }).validate(req.query, { convert: true });
    if (error) return res.status(400).json({ error: error.message });

    try {
      const choices = await _resolveImages([{ result: { id: value.id, type: value.type } }]);
      res.json({ choices });
    } catch (e) {
      const status = e?.response?.status === 429 ? 429 : 500;
      res.status(status).json({ error: e.message || 'Discogs lookup failed' });
    }
  });
}

/**
 * Exported helper used by albums-browse set-art endpoint.
 * Fetches the primary cover image buffer for a Discogs release ID.
 */
export async function getReleaseCoverBuf(releaseId) {
  if (config.program.discogs?.enabled === false) {
    throw new Error('Discogs not enabled');
  }
  const release = await discogsGet(`https://api.discogs.com/releases/${releaseId}`);
  const images  = release.images || [];
  const img     = images.find(i => i.type === 'primary') || images[0];
  if (!img?.uri) throw new Error('No cover image for this release');
  return fetchImageBuf(img.uri);
}

// ── Album-Art Workshop: unified multi-service suggestion helper ────────────────
// Standalone Deezer/iTunes query helpers (kept separate from the GET routes above
// so those keep their existing response shapes — these return the workshop's
// unified { source, coverUrl, thumb, label } descriptor instead).
async function _deezerChoices(artist, album) {
  let a = String(artist || '').trim();
  const b = String(album || '').trim();
  if (presentsLabel(a)) a = '';
  const q = [a, b].filter(Boolean).join(' ');
  if (!q) return [];
  const url = `https://api.deezer.com/search/album?q=${encodeURIComponent(q)}&limit=10`;
  const data = await fetchPublicJson(url, {
    headers: { 'User-Agent': UA_BASE },
    allowedHosts: new Set(['api.deezer.com']),
    maxRedirects: 0,
    maxContentLength: 5 * 1024 * 1024,
  });
  return (data.data || [])
    .filter(r => r.cover_xl || r.cover_big)
    .map(r => ({
      source:   'deezer',
      coverUrl: r.cover_xl || r.cover_big,
      thumb:    r.cover_medium || r.cover_small || r.cover_big,
      label:    `${r.title || ''}${r.artist?.name ? ' — ' + r.artist.name : ''}`,
    }));
}

async function _itunesChoices(artist, album) {
  let a = String(artist || '').trim();
  const b = String(album || '').trim();
  if (presentsLabel(a)) a = '';
  const q = [a, b].filter(Boolean).join(' ');
  if (!q) return [];
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&entity=album&limit=10`;
  const data = await fetchPublicJson(url, {
    headers: { 'User-Agent': UA_BASE },
    allowedHosts: new Set(['itunes.apple.com']),
    maxRedirects: 0,
    maxContentLength: 5 * 1024 * 1024,
  });
  return (data.results || [])
    .filter(r => r.artworkUrl100)
    .map(r => ({
      source:   'itunes',
      coverUrl: r.artworkUrl100.replaceAll('100x100bb', '3000x3000bb'),
      thumb:    r.artworkUrl100.replaceAll('100x100bb', '250x250bb'),
      label:    `${r.collectionName || ''}${r.releaseDate ? ` (${r.releaseDate.substring(0, 4)})` : ''}`,
    }));
}

/**
 * Query every enabled art service for cover suggestions for one album.
 * Returns a unified list of descriptors the Album-Art Workshop can present and,
 * on approval, apply via /api/v1/albums/set-art (releaseId for Discogs, coverUrl
 * for Deezer/iTunes). Each service failure is isolated — one outage never blocks
 * the others.
 */
export async function suggestCovers({ artist, title, album, year, filepath }) {
  const out = [];
  const cfg = config.program.discogs || {};

  if (cfg.enabled !== false && cfg.apiKey) {
    try {
      let a    = String(artist || '').trim();
      const t  = cleanFilenameNoise(String(title || '').trim());
      let al   = cleanFilenameNoise(String(album || '').trim());
      const albumTagIsCompilation = isCompilationAlbum(al);
      ({ artist: a, album: al } = _enrichFromFilepath(a, al, albumTagIsCompilation, filepath || ''));
      let catno = _extractCatnoFromPath(filepath || '');
      if (!catno && al) catno = extractCatno(al);
      const presLabel  = presentsLabel(a);
      const albumPhase = (isCompilationAlbum(al) && a && t) ? 'C' : 'A';
      const searches   = _buildSearches(a, t, al, String(year || ''), catno, presLabel, albumPhase);
      const settled    = await Promise.allSettled(
        searches.map(({ params }) => discogsGet(`https://api.discogs.com/database/search?${params}`))
      );
      const choices = await _resolveImages(_buildCandidates(settled, searches, a));
      for (const c of choices) {
        out.push({ source: 'discogs', releaseId: c.releaseId, thumb: c.thumbB64, label: `${c.releaseTitle}${c.year ? ` (${c.year})` : ''}` });
      }
    } catch (e) { console.debug('[art-suggest] discogs:', e?.message ?? e); }
  }
  if (cfg.deezerEnabled !== false) {
    try { out.push(...await _deezerChoices(artist, album)); } catch (e) { console.debug('[art-suggest] deezer:', e?.message ?? e); }
  }
  if (cfg.itunesEnabled !== false) {
    try { out.push(...await _itunesChoices(artist, album)); } catch (e) { console.debug('[art-suggest] itunes:', e?.message ?? e); }
  }
  return out;
}

// ── discogs/coverart helpers ──────────────────────────────────────────────────

function _stripDiscSuffix(s) {
  return s
    .replace(/[\s,-\u2013]+(?:CD|Disc|Disk|Vol\.?|Volume|Part|Pt\.?)\s*\d+\s*$/i, '')
    .replace(/\s*[[(](?:CD|Disc|Disk|Vol\.?|Volume|Part|Pt\.?)\s*\d+[\])]\s*$/i, '')
    .trim();
}

function _parseAlbumTitle(title) {
  const t = _stripDiscSuffix(title);
  const m = / - [A-Za-z]{0,6}\d[A-Za-z0-9-]{0,30}$/.exec(t);
  if (m) return t.slice(0, m.index).trim();
  return t.trim();
}

function _enrichFromFilepath(artist, album, albumTagIsCompilation, rawFilepath) {
  if (!rawFilepath || (artist && album && !albumTagIsCompilation)) return { artist, album };
  const segments = rawFilepath.replaceAll('\\', '/').split('/').filter(Boolean);
  for (let i = segments.length - 2; i >= 1; i--) {
    const parsed = parseFilename(segments[i]);
    if (!parsed) continue;
    if (!artist && parsed.artist) artist = parsed.artist;
    const needAlbum = !album || albumTagIsCompilation;
    if (needAlbum && parsed.title) album = _parseAlbumTitle(parsed.title);
    if (artist && album) break;
  }
  return { artist, album };
}

function _extractCatnoFromPath(rawFilepath) {
  if (!rawFilepath) return null;
  const segs = rawFilepath.replaceAll('\\', '/').split('/').filter(Boolean);
  for (let i = segs.length - 2; i >= 1; i--) {
    const c = extractCatno(segs[i]);
    if (c) return c;
  }
  return null;
}

// Build a URLSearchParams for a Discogs release/master search.
// Omits artist/year if falsy to avoid empty query params.
function _releaseParams(type, perPage, artist, title, year) {
  const p = new URLSearchParams({ type, per_page: String(perPage) });
  if (artist) p.set('artist', artist);
  if (title)  p.set('release_title', title);
  if (year)   p.set('year', year);
  return p;
}

function _buildPhaseAAlbumVariants(albumInfo, albumPhase, add) {
  const { artist, album, cleanAlbum, albumFirstSegment, albumBareTitle, year } = albumInfo;
  // raw album tag
  if (album) add(_releaseParams('release', 8, artist, album, year), albumPhase);
  // stripped disc suffix
  if (cleanAlbum && cleanAlbum !== album) add(_releaseParams('release', 8, artist, cleanAlbum, null), albumPhase);
  // first segment before punctuation
  if (albumFirstSegment && albumFirstSegment !== cleanAlbum && albumFirstSegment.length > 3)
    add(_releaseParams('release', 8, artist, albumFirstSegment, null), albumPhase);
  // bare title (no trailing parenthetical)
  if (albumBareTitle && albumBareTitle !== cleanAlbum && albumBareTitle !== albumFirstSegment && albumBareTitle.length > 2)
    add(_releaseParams('release', 8, artist, albumBareTitle, null), albumPhase);
  // master release
  if (album) add(_releaseParams('master', 8, artist, album, year), albumPhase);
}

function _buildPhaseASearches(albumInfo, catno, presLabel, albumPhase, add) {
  const { artist, cleanAlbum, year } = albumInfo;
  _buildPhaseAAlbumVariants(albumInfo, albumPhase, add);
  if (artist && cleanAlbum) {
    const p = new URLSearchParams({ type: 'release', per_page: '8' });
    p.set('q', `${artist} ${cleanAlbum}`);
    add(p, albumPhase);
  }
  if (artist && cleanAlbum) {
    const p = new URLSearchParams({ type: 'master', per_page: '8' });
    p.set('q', year ? `${artist} ${cleanAlbum} ${year}` : `${artist} ${cleanAlbum}`);
    add(p, albumPhase);
  }
  if (cleanAlbum && cleanAlbum.length > 4) {
    const p = new URLSearchParams({ type: 'release', per_page: '5' });
    p.set('q', cleanAlbum);
    add(p, albumPhase);
  }
  _buildPhaseACatnoLabel(cleanAlbum, year, catno, presLabel, albumPhase, add);
}

function _buildPhaseACatnoLabel(cleanAlbum, year, catno, presLabel, albumPhase, add) {
  if (catno) {
    if (cleanAlbum) {
      const p = new URLSearchParams({ type: 'release', per_page: '5' });
      p.set('catno', catno); p.set('release_title', cleanAlbum);
      add(p, albumPhase);
    }
    const p2 = new URLSearchParams({ type: 'release', per_page: '5' });
    p2.set('catno', catno);
    add(p2, albumPhase);
  }
  if (presLabel && cleanAlbum) {
    const p1 = new URLSearchParams({ type: 'release', per_page: '5' });
    p1.set('release_title', cleanAlbum); if (year) p1.set('year', year);
    add(p1, albumPhase);
    const p2 = new URLSearchParams({ type: 'release', per_page: '5' });
    p2.set('label', presLabel); p2.set('release_title', cleanAlbum);
    add(p2, albumPhase);
    const p3 = new URLSearchParams({ type: 'master', per_page: '5' });
    p3.set('release_title', cleanAlbum); if (year) p3.set('year', year);
    add(p3, albumPhase);
  }
}

function _buildPhaseBSearches(artist, title, album, add) {
  if (title && title !== album) {
    const p = new URLSearchParams({ type: 'release', per_page: '5' });
    if (artist) p.set('artist', artist);
    p.set('release_title', title);
    add(p, 'B');
  }
  if (artist && album && album === title) {
    const p = new URLSearchParams({ type: 'master', per_page: '8' });
    p.set('artist', artist);
    add(p, 'B');
  }
  if (artist && title && title !== album) {
    const p = new URLSearchParams({ type: 'release', per_page: '5' });
    p.set('q', `${artist} ${title}`);
    add(p, 'B');
  }
}

function _buildPhaseCSearches(artist, title, album, add) {
  if (!artist || !album) {
    const parsed = parseFilename(title) || parseFilename(album);
    if (parsed?.title) {
      const p = new URLSearchParams({ type: 'release', per_page: '8' });
      const ea = artist || parsed.artist;
      if (ea) p.set('artist', ea);
      p.set('release_title', parsed.title);
      add(p, 'C');
    }
    if (parsed?.artist && parsed?.title) {
      const p = new URLSearchParams({ type: 'release', per_page: '8' });
      p.set('q', `${parsed.artist} ${parsed.title}`);
      add(p, 'C');
    }
  }
  if (artist) {
    const p = new URLSearchParams({ type: 'master', per_page: '8' });
    p.set('artist', artist);
    add(p, 'C');
  }
}

function _buildSearches(artist, title, album, year, catno, presLabel, albumPhase) {
  const searches = [];
  const add = (params, phase) => searches.push({ params, phase });
  const cleanAlbum        = album ? _stripDiscSuffix(album) : '';
  const albumFirstSegment = cleanAlbum.split(/\s*[,\-–:]\s*/)[0].trim();
  const albumBareTitle    = cleanAlbum.replace(/\s*\([^)]*\)\s*$/, '').trim();

  const albumInfo = { artist, album, cleanAlbum, albumFirstSegment, albumBareTitle, year };
  _buildPhaseASearches(albumInfo, catno, presLabel, albumPhase, add);
  _buildPhaseBSearches(artist, title, album, add);
  _buildPhaseCSearches(artist, title, album, add);

  if (!searches.length) {
    const p = new URLSearchParams({ type: 'release', per_page: '5' });
    p.set('release_title', title || album);
    searches.push({ params: p, phase: 'C' });
  }
  return searches;
}

function _buildCandidates(searchSettled, searches, artist) {
  const candidates = [];
  const seenIds    = new Set();
  for (let i = 0; i < searches.length; i++) {
    if (candidates.length >= 18) break;
    const settled = searchSettled[i];
    if (settled.status !== 'fulfilled') continue;
    const { phase } = searches[i];
    for (const result of (settled.value.results || [])) {
      if (candidates.length >= 18) break;
      if (!result.id || seenIds.has(result.id)) continue;
      seenIds.add(result.id);
      candidates.push({ result, phase, score: artistMatchScore(artist, result.title || '') });
    }
  }
  const phaseOrder = { A: 0, B: 1, C: 2 };
  candidates.sort((a, b) => (phaseOrder[a.phase] - phaseOrder[b.phase]) || (b.score - a.score));
  return candidates;
}

async function _resolveImages(candidates) {
  const imageSettled = await Promise.allSettled(
    candidates.slice(0, 12).map(async ({ result }) => {
      let releaseId = result.id;
      if (result.type === 'master') {
        const master = await discogsGet(`https://api.discogs.com/masters/${result.id}`);
        if (!master.main_release) throw new Error('no main_release');
        releaseId = master.main_release;
      }
      const release = await discogsGet(`https://api.discogs.com/releases/${releaseId}`);
      const images  = release.images || [];
      const img     = images.find(i => i.type === 'primary') || images[0];
      if (!img?.uri) throw new Error('no image');
      const imgBuf   = await fetchImageBuf(img.uri);
      const thumbB64 = `data:image/jpeg;base64,${imgBuf.toString('base64')}`;
      return { releaseId, releaseTitle: release.title || result.title || '', year: String(release.year || result.year || ''), thumbB64 };
    })
  );
  const choices = [], seenReleases = new Set();
  for (const s of imageSettled) {
    if (choices.length >= 8) break;
    if (s.status !== 'fulfilled') continue;
    if (seenReleases.has(s.value.releaseId)) continue;
    seenReleases.add(s.value.releaseId);
    choices.push(s.value);
  }
  return choices;
}

// ── discogs/embed helpers ─────────────────────────────────────────────────────

async function _embedCoverArt(ffmpegBinPath, absPath, tmpCover, tmpOut) {
  await execFileAsync(ffmpegBinPath, [
    '-y', '-i', absPath, '-i', tmpCover,
    '-map', '0:a', '-map', '1:v',
    '-c:a', 'copy', '-c:v', 'mjpeg',
    '-disposition:v:0', 'attached_pic',
    '-metadata:s:v', 'title=Cover (Front)',
    '-metadata:s:v', 'comment=Cover (Front)',
    tmpOut,
  ]);
}

async function _fixPtsIssues(ffmpegBinPath, absPath, tmpCover, extLower, ts) {
  let probeStderr;
  try {
    const pr = await execFileAsync(ffmpegBinPath, ['-v', 'error', '-i', absPath, '-f', 'null', '-']);
    probeStderr = pr.stderr || '';
  } catch (probeErr) {
    probeStderr = (probeErr.stderr || '') + String(probeErr.message || '');
  }
  if (!/PTS|non monotonous|DEMUXER_ERROR|COULD_NOT_PARSE/i.test(probeStderr)) return;

  console.warn('[discogs/embed] PTS issue detected — running recovery:', absPath);
  const dir        = path.dirname(absPath);
  const tmpRecover = resolvePathWithinRoot(dir, `.velvet-recover-${ts}${extLower}`);
  const tmpReembed = resolvePathWithinRoot(dir, `.velvet-reembed-${ts}${extLower}`);
  try {
    await execFileAsync(ffmpegBinPath, ['-y', '-i', absPath, '-map', '0:a', '-c:a', 'copy', tmpRecover]);
    await execFileAsync(ffmpegBinPath, [
      '-y', '-i', tmpRecover, '-i', tmpCover,
      '-map', '0:a', '-map', '1:v',
      '-c:a', 'copy', '-c:v', 'mjpeg', '-r', '1',
      '-disposition:v:0', 'attached_pic',
      '-metadata:s:v', 'title=Cover (Front)',
      '-metadata:s:v', 'comment=Cover (Front)',
      tmpReembed,
    ]);
    fs.renameSync(tmpReembed, absPath);
    console.log('[discogs/embed] PTS recovery completed:', absPath);
  } catch (recovErr) {
    console.error('[discogs/embed] PTS recovery failed:', recovErr.message);
  } finally {
    try { fs.unlinkSync(tmpRecover); } catch (e) { console.debug('[velvet]', e?.message ?? e); }
    try { fs.unlinkSync(tmpReembed); } catch (e) { console.debug('[velvet]', e?.message ?? e); }
  }
}

async function _generateThumbnails(imgBuf, artDir, aaFile) {
  try {
    if (imgBuf.length >= 100) {
      const { default: sharp } = await import('sharp');
      await sharp(imgBuf).resize(256, 256, { fit: 'inside', withoutEnlargement: true }).toFile(path.join(artDir, `zl-${aaFile}`));
      await sharp(imgBuf).resize(92, 92, { fit: 'inside', withoutEnlargement: true }).toFile(path.join(artDir, `zs-${aaFile}`));
    }
  } catch (e) { console.debug('[velvet]', e?.message ?? e); }
}

function _cleanupOldArt(oldAaFile, newAaFile, artDir) {
  if (!oldAaFile || oldAaFile === newAaFile) return;
  try {
    if (dbManager.countArtUsage(oldAaFile) === 0) {
      for (const prefix of ['', 'zl-', 'zs-']) {
        try {
          fs.unlinkSync(resolvePathWithinRoot(artDir, prefix + oldAaFile));
        } catch (e) { console.debug('[velvet]', e?.message ?? e); }
      }
    }
  } catch (e) { console.debug('[velvet]', e?.message ?? e); }
}

async function _updateArtRecord(imgBuf, pathInfo, artDir, coverUrl) {
  const md5     = crypto.createHash('sha256').update(imgBuf).digest('hex');
  const aaFile  = `${md5}.jpg`;
  const artPath = path.join(artDir, aaFile);

  const oldRecord = dbManager.findFileByPath(pathInfo.relativePath, pathInfo.vpath);
  const oldAaFile = oldRecord?.aaFile || null;

  if (!fs.existsSync(artPath)) fs.writeFileSync(artPath, imgBuf);

  await _generateThumbnails(imgBuf, artDir, aaFile);

  dbManager.commitTransaction();
  try {
    dbManager.updateFileArt(pathInfo.relativePath, pathInfo.vpath, aaFile, null, coverUrl ? 'deezer' : 'discogs');
  } catch (artErr) {
    console.error('[discogs/embed] updateFileArt failed:', artErr.message);
  }

  _cleanupOldArt(oldAaFile, aaFile, artDir);
  return { aaFile };
}
