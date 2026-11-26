// Where "similar artists" (and an artist's top tracks) come from. The admin picks one source:
// ListenBrainz (no key; needs MusicBrainz artist IDs), TIDAL (developer client credentials) or
// Last.fm (API key; needs Last.fm Pro from 1 December 2026). Answers are kept in the database
// (similar_cache) so a restart or an outage at the source does not empty Auto-DJ.
import { createRequire } from 'node:module';
import Joi from 'joi';
import * as config from '../state/config.js';
import * as db from '../db/manager.js';
import { joiValidate } from '../util/validation.js';
import WebError from '../util/web-error.js';

const VELVET_VERSION = createRequire(import.meta.url)('../../package.json').version;
const USER_AGENT = `Velvet/${VELVET_VERSION} ( https://github.com/aroundmyroom/Velvet )`;

const DEFAULT_LB_ALGORITHM = 'session_based_days_7500_session_300_contribution_3_threshold_10_limit_100_filter_True_skip_30';
const SOURCES = ['listenbrainz', 'tidal', 'lastfm', 'off'];
const LIST_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ID_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const EMPTY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const HTTP_TIMEOUT_MS = 8000;
const MB_GAP_MS = 1100;
const MB_RETRIES = 2;
const TIDAL_MAX_PAGES = 3;
const MAX_RESULTS = 100;

// VELVET_SIMILAR_URLS (JSON) points the sources at stand-ins in tests.
const urls = () => ({
  lbLabs: 'https://labs.api.listenbrainz.org',
  lbApi: 'https://api.listenbrainz.org',
  mb: 'https://musicbrainz.org',
  tidalApi: 'https://openapi.tidal.com/v2',
  tidalAuth: 'https://auth.tidal.com/v1/oauth2/token',
  lastfm: 'https://ws.audioscrobbler.com',
  ...JSON.parse(process.env.VELVET_SIMILAR_URLS || '{}'),
});

const cfg = () => config.program.similarArtists ?? {};
const source = () => cfg().source || 'listenbrainz';
const lbAlgorithm = () => cfg().listenbrainzAlgorithm || DEFAULT_LB_ALGORITHM;
const tidalCountry = () => cfg().tidalCountry || 'US';
const lastfmKey = () => config.program.lastFM?.apiKey || '';

const fold = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

function ready(src) {
  if (src === 'listenbrainz') return true;
  if (src === 'tidal') return Boolean(cfg().tidalClientId && cfg().tidalClientSecret);
  if (src === 'lastfm') return Boolean(lastfmKey());
  return false;
}

/** True when the chosen source can answer, so Auto-DJ's similar mode and artist pages can use it. */
export function similarActive() {
  return ready(source());
}

const SOURCE_LABELS = { listenbrainz: 'ListenBrainz', tidal: 'TIDAL', lastfm: 'Last.fm' };

/** Changes when the source, its settings or the stored answers change; part of in-memory cache keys elsewhere. */
let _generation = 0;
export function similarCacheTag() {
  return `${source()}:${_generation}`;
}

export function similarSourceLabel() {
  return SOURCE_LABELS[source()] ?? '';
}

async function getJson(url, init = {}) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, json, text };
}

function fail(label, r) {
  const detail = r.json?.error || r.json?.message || r.json?.errors?.[0]?.detail || r.text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return new Error(`${label} answered ${r.status}${detail ? `: ${String(detail).slice(0, 200)}` : ''}`);
}

const isEmpty = (v) => v == null || (Array.isArray(v) && v.length === 0) || (typeof v === 'object' && !Array.isArray(v) && Object.values(v).every(x => x == null));

// Fresh answer from the database when there is one; otherwise ask the source and store it.
// When the source fails, an older stored answer is used. `fresh` (the admin test) skips the stored one.
async function cached(src, key, ttl, load, fresh = false) {
  const hit = fresh ? null : db.getSimilarCache(src, key);
  if (hit && Date.now() - hit.at < (isEmpty(hit.value) ? EMPTY_TTL_MS : ttl)) return hit.value;
  try {
    const value = await load();
    db.putSimilarCache(src, key, value);
    return value;
  } catch (e) {
    const stale = fresh ? null : (hit ?? db.getSimilarCache(src, key));
    if (stale) return stale.value;
    throw e;
  }
}

// ── MusicBrainz: name → artist ID (1 request per second, as MusicBrainz asks) ──
let _mbChain = Promise.resolve();
function mbThrottled(fn) {
  const run = _mbChain.then(fn);
  _mbChain = run.catch(() => {}).then(() => new Promise(r => setTimeout(r, MB_GAP_MS)));
  return run;
}

async function mbSearch(name) {
  const q = encodeURIComponent(`artist:"${name.replaceAll('"', '')}"`);
  const ask = () => mbThrottled(() => getJson(`${urls().mb}/ws/2/artist?query=${q}&fmt=json&limit=5`, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } }));
  let r = await ask();
  // MusicBrainz answers 503 when it is busy or the 1/s budget is exceeded; the throttle spaces the retries.
  for (let retry = 0; r.status === 503 && retry < MB_RETRIES; retry++) r = await ask();
  if (r.status !== 200) throw fail('MusicBrainz', r);
  const want = fold(name);
  const hit = (r.json?.artists || []).find(a => fold(a.name) === want || fold(a['sort-name']) === want);
  return { mbid: hit?.id ?? null };
}

/** The MusicBrainz artist ID of a name: from the library's own tags first, else a stored MusicBrainz search. */
async function mbidFor(name, fresh) {
  const fromFiles = db.deriveArtistMbidFromFiles(name);
  if (fromFiles) return fromFiles;
  return (await cached('mb-artist', name.toLowerCase(), ID_TTL_MS, () => mbSearch(name), fresh)).mbid;
}

// ── ListenBrainz ────────────────────────────────────────────────────────────
async function lbSimilar(name, fresh) {
  const mbid = await mbidFor(name, fresh);
  if (!mbid) return [];
  const alg = lbAlgorithm();
  return cached(`listenbrainz:${alg}`, mbid, LIST_TTL_MS, async () => {
    const r = await getJson(`${urls().lbLabs}/similar-artists/json?artist_mbids=${mbid}&algorithm=${encodeURIComponent(alg)}`, { headers: { 'User-Agent': USER_AGENT } });
    if (r.status !== 200) throw fail('ListenBrainz', r);
    const rows = (Array.isArray(r.json) ? r.json : []).filter(a => a?.name);
    const top = rows[0]?.score || 1;
    return rows.slice(0, MAX_RESULTS).map(a => ({ name: a.name, mbid: a.artist_mbid || null, score: Math.round((a.score / top) * 1000) / 1000 }));
  }, fresh);
}

// A ListenBrainz user token: the one set for this feature, else one a user connected for scrobbling (admins first).
function lbToken() {
  if (cfg().listenbrainzToken) return cfg().listenbrainzToken;
  const users = Object.values(config.program.users || {}).filter(u => u?.['listenbrainz-token']);
  users.sort((a, b) => Number(b.admin === true) - Number(a.admin === true));
  return users[0]?.['listenbrainz-token'] || '';
}

async function lbTopTracks(name) {
  const token = lbToken();
  if (!token) return [];
  const mbid = await mbidFor(name);
  if (!mbid) return [];
  return cached('listenbrainz-top', mbid, LIST_TTL_MS, async () => {
    const r = await getJson(`${urls().lbApi}/1/popularity/top-recordings-for-artist/${mbid}`, { headers: { Authorization: `Token ${token}`, 'User-Agent': USER_AGENT } });
    if (r.status !== 200) throw fail('ListenBrainz', r);
    return (Array.isArray(r.json) ? r.json : [])
      .filter(t => t?.recording_name && t.artist_name)
      .slice(0, MAX_RESULTS)
      .map((t, i) => ({ title: t.recording_name, artist: t.artist_name, rank: i + 1 }));
  });
}

// ── TIDAL ───────────────────────────────────────────────────────────────────
let _tidalToken = null;

async function tidalAccessToken() {
  if (_tidalToken && _tidalToken.until > Date.now()) return _tidalToken.token;
  const basic = Buffer.from(`${cfg().tidalClientId}:${cfg().tidalClientSecret}`).toString('base64');
  const r = await getJson(urls().tidalAuth, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (r.status !== 200 || !r.json?.access_token) throw fail('TIDAL login', r);
  _tidalToken = { token: r.json.access_token, until: Date.now() + Math.max(60, (r.json.expires_in || 3600) - 60) * 1000 };
  return _tidalToken.token;
}

async function tidalGet(pathOrUrl, retried = false) {
  const base = urls().tidalApi;
  const url = /^https?:/.test(pathOrUrl) ? pathOrUrl : base + pathOrUrl.replace(/^\/v2(?=\/)/, '');
  const r = await getJson(url, { headers: { Authorization: `Bearer ${await tidalAccessToken()}`, Accept: 'application/vnd.api+json' } });
  if (r.status === 401 && !retried) {
    _tidalToken = null;
    return tidalGet(pathOrUrl, true);
  }
  if (r.status !== 200) throw fail('TIDAL', r);
  return r.json;
}

const tidalNames = (doc) => new Map((doc?.included || []).filter(x => x.type === 'artists').map(x => [x.id, x.attributes?.name]));

async function tidalArtistId(name, fresh) {
  const c = tidalCountry();
  return (await cached(`tidal-artist:${c}`, name.toLowerCase(), ID_TTL_MS, async () => {
    const doc = await tidalGet(`/searchResults/${encodeURIComponent(name)}/relationships/artists?countryCode=${c}&include=artists`);
    const names = tidalNames(doc);
    const ids = (doc?.data || []).map(d => d.id);
    const want = fold(name);
    return { id: ids.find(id => fold(names.get(id)) === want) ?? null };
  }, fresh)).id;
}

async function tidalSimilar(name, fresh) {
  const id = await tidalArtistId(name, fresh);
  if (!id) return [];
  const c = tidalCountry();
  return cached(`tidal:${c}`, id, LIST_TTL_MS, async () => {
    const out = [];
    let next = `/artists/${id}/relationships/similarArtists?countryCode=${c}&include=similarArtists`;
    for (let page = 0; next && page < TIDAL_MAX_PAGES && out.length < MAX_RESULTS; page++) {
      const doc = await tidalGet(next);
      const names = tidalNames(doc);
      for (const d of doc?.data || []) if (names.get(d.id)) out.push({ name: names.get(d.id), mbid: null });
      next = doc?.links?.next || null;
    }
    const n = out.length;
    return out.slice(0, MAX_RESULTS).map((a, i) => ({ ...a, score: Math.round((1 - i / Math.max(n, 1)) * 1000) / 1000 }));
  }, fresh);
}

// ── Last.fm ─────────────────────────────────────────────────────────────────
async function lastfmGet(method, params) {
  const qs = new URLSearchParams({ method, ...params, api_key: lastfmKey(), format: 'json' });
  const r = await getJson(`${urls().lastfm}/2.0/?${qs}`);
  if (r.json?.error === 6) return null;
  if (r.status !== 200 || r.json?.error) throw fail('Last.fm', r);
  return r.json;
}

function lastfmSimilar(name, fresh) {
  return cached('lastfm', name.toLowerCase(), LIST_TTL_MS, async () => {
    const j = await lastfmGet('artist.getSimilar', { artist: name, limit: '100' });
    return (j?.similarartists?.artist || []).filter(a => a?.name).slice(0, MAX_RESULTS)
      .map(a => ({ name: a.name, mbid: a.mbid || null, score: Number(a.match) || 0 }));
  }, fresh);
}

function lastfmTopTracks(name) {
  return cached('lastfm-top', name.toLowerCase(), LIST_TTL_MS, async () => {
    const j = await lastfmGet('artist.getTopTracks', { artist: name, limit: '100' });
    return (j?.toptracks?.track || []).filter(t => t?.name && t.artist?.name)
      .map((t, i) => ({ title: t.name, artist: t.artist.name, rank: i + 1 }));
  });
}

// ── Public ──────────────────────────────────────────────────────────────────
const PROVIDERS = { listenbrainz: lbSimilar, tidal: tidalSimilar, lastfm: lastfmSimilar };

function listFrom(src, name, fresh) {
  return PROVIDERS[src](String(name).trim(), fresh);
}

/** Similar artists of a name from the chosen source as [{ name, mbid, score 0–1 }], most similar first;
 *  null when the source failed and nothing is stored. */
export async function similarArtistList(name) {
  if (!similarActive() || !name) return [];
  try {
    return await listFrom(source(), name, false);
  } catch (e) {
    console.warn(`[similar] ${similarSourceLabel()} "${name}": ${e.message}`);
    return null;
  }
}

/** An artist's most played tracks as [{ title, artist, rank }]: from Last.fm when that is the source, else ListenBrainz. */
export async function topTracksFor(name, limit = 50) {
  if (!name || source() === 'off') return [];
  try {
    const list = source() === 'lastfm' ? (lastfmKey() ? await lastfmTopTracks(String(name)) : []) : await lbTopTracks(String(name));
    return list.slice(0, limit);
  } catch (e) {
    console.warn(`[similar] top tracks "${name}": ${e.message}`);
    return [];
  }
}

// Whether the source identified the artist at all (an empty list then means it knows no similar artists).
async function sourceKnows(src, name) {
  if (src === 'listenbrainz') return Boolean(await mbidFor(name));
  if (src === 'tidal') return Boolean(await tidalArtistId(name));
  return true;
}

function inLibrary(list) {
  const byMbid = db.artistNamesForMbids([...new Set(list.map(a => a.mbid).filter(Boolean))]);
  return list.map(a => ({ ...a, inLibrary: byMbid.has(a.mbid) || db.resolveArtistNamesForDJ([a.name]).length > 0 }));
}

async function editConfig(edit) {
  await config.updateConfigFile(c => {
    c.similarArtists ??= {};
    edit(c.similarArtists);
  });
  config.program.similarArtists ??= {};
  edit(config.program.similarArtists);
}

export function setup(velvet) {
  const adminOnly = (req) => { if (req.user.admin !== true) throw new WebError('Admin only', 403); };

  velvet.get('/api/v1/admin/similar-artists/config', (req, res) => {
    adminOnly(req);
    const c = cfg();
    res.json({
      source: source(),
      ready: Object.fromEntries(SOURCES.filter(s => s !== 'off').map(s => [s, ready(s)])),
      listenbrainzAlgorithm: c.listenbrainzAlgorithm || '',
      defaultAlgorithm: DEFAULT_LB_ALGORITHM,
      hasListenbrainzToken: Boolean(c.listenbrainzToken),
      topTracksToken: c.listenbrainzToken ? 'own' : (lbToken() ? 'user' : null),
      tidalClientId: c.tidalClientId || '',
      hasTidalSecret: Boolean(c.tidalClientSecret),
      tidalCountry: tidalCountry(),
      hasLastfmKey: Boolean(lastfmKey()),
    });
  });

  velvet.post('/api/v1/admin/similar-artists/config', async (req, res) => {
    adminOnly(req);
    joiValidate(Joi.object({
      source: Joi.string().valid(...SOURCES).required(),
      listenbrainzAlgorithm: Joi.string().trim().allow('').pattern(/^[A-Za-z0-9_]*$/).max(200).optional(),
      lbToken: Joi.string().trim().allow('').max(256).optional(),
      tidalClientId: Joi.string().trim().allow('').max(256).optional(),
      tidalSecret: Joi.string().trim().allow('').max(256).optional(),
      tidalCountry: Joi.string().trim().uppercase().pattern(/^[A-Z]{2}$/).optional(),
    }), req.body);
    const b = req.body;
    await editConfig(c => {
      c.source = b.source;
      if (b.listenbrainzAlgorithm !== undefined) c.listenbrainzAlgorithm = b.listenbrainzAlgorithm.trim();
      if (b.lbToken !== undefined) c.listenbrainzToken = b.lbToken.trim();
      if (b.tidalClientId !== undefined) c.tidalClientId = b.tidalClientId.trim();
      if (b.tidalSecret !== undefined) c.tidalClientSecret = b.tidalSecret.trim();
      if (b.tidalCountry !== undefined) c.tidalCountry = b.tidalCountry.trim().toUpperCase();
    });
    _tidalToken = null;
    _generation++;
    res.json({});
  });

  velvet.post('/api/v1/admin/similar-artists/test', async (req, res) => {
    adminOnly(req);
    joiValidate(Joi.object({
      artist: Joi.string().trim().min(1).max(200).required(),
      source: Joi.string().valid('listenbrainz', 'tidal', 'lastfm').optional(),
    }), req.body);
    const src = req.body.source || source();
    if (!ready(src)) return res.json({ source: src, ok: false, error: 'not-configured', artists: [] });
    const t0 = Date.now();
    try {
      const list = await listFrom(src, req.body.artist, true);
      const notFound = list.length === 0 && !(await sourceKnows(src, req.body.artist));
      res.json({ source: src, ok: true, ms: Date.now() - t0, artists: inLibrary(list.slice(0, 25)), total: list.length, notFound });
    } catch (e) {
      res.json({ source: src, ok: false, ms: Date.now() - t0, error: e.message, artists: [] });
    }
  });

  velvet.post('/api/v1/admin/similar-artists/clear-cache', async (req, res) => {
    adminOnly(req);
    _generation++;
    res.json({ removed: db.clearSimilarCache() });
  });
}
