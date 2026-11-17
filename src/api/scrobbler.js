import crypto from 'node:crypto';
import https from 'node:https';
import Joi from 'joi';
import axios from 'axios';
import * as config from '../state/config.js';
import Scribble from '../state/lastfm.js';
import * as db from '../db/manager.js';
import { joiValidate } from '../util/validation.js';
import { getVPathInfo, dbLocationCandidates } from '../util/vpath.js';
import WebError from '../util/web-error.js';
import { artistLookupCandidates } from '../util/artist-credit.js';

const Scrobbler = new Scribble();

const SIMILAR_TTL_MS = 6 * 60 * 60 * 1000;
const SIMILAR_CACHE_MAX = 2000;
const LASTFM_TIMEOUT_MS = 4000;
const LASTFM_SCROBBLE_TIMEOUT_MS = 15_000;
const _similarCache = new Map();
// Resolved to library variants; shorter-lived so newly scanned artists show up.
const RESOLVED_TTL_MS = 30 * 60 * 1000;
const _resolvedCache = new Map();

function _lastfmCall(start) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), LASTFM_TIMEOUT_MS);
    start(data => { clearTimeout(timer); resolve(data); });
  });
}

function _lastfmCached(key, load) {
  const hit = _similarCache.get(key);
  if (hit && Date.now() - hit.at < SIMILAR_TTL_MS) return hit.value;
  const value = load().then(v => {
    if (v == null) _similarCache.delete(key);
    return v;
  });
  if (_similarCache.size >= SIMILAR_CACHE_MAX) _similarCache.delete(_similarCache.keys().next().value);
  _similarCache.set(key, { at: Date.now(), value });
  return value;
}

function _similarArtistNames(artistName) {
  return _lastfmCached('sa\0' + artistName.toLowerCase(), () =>
    _lastfmCall(cb => Scrobbler.GetSimilarArtists(artistName, cb, 50)).then(data => data == null ? null :
      (data?.similarartists?.artist || []).slice(0, 50).map(a => a.name).filter(Boolean)));
}

/**
 * Last.fm similar artists for a credited artist, resolved to library artist
 * variants. Tries the exact credit, then collaboration halves, then duo parts
 * (util/artist-credit.js) and moves on while Last.fm knows nothing or fewer than
 * SIMILAR_MIN_IN_LIBRARY of the names are in the library (keeping the best
 * list found as the fallback). variantRankMap: library variant → 1-based
 * Last.fm rank (lower = more similar). Used by the browser Auto-DJ (route
 * below) and the server-side radio (src/autodj/radio.js).
 */
export function similarArtistsFor(originalArtist, vpaths) {
  if (!Scrobbler.apiKey || !originalArtist) return Promise.resolve(_emptySimilar());
  const key = `res\0${(vpaths || []).join('\0')}\0${String(originalArtist).trim().toLowerCase()}`;
  const hit = _resolvedCache.get(key);
  if (hit && Date.now() - hit.at < RESOLVED_TTL_MS) return hit.value;
  const value = _resolveSimilarArtists(originalArtist, vpaths).then(r => {
    if (r.failed) _resolvedCache.delete(key);
    return r.result;
  });
  if (_resolvedCache.size >= SIMILAR_CACHE_MAX) _resolvedCache.delete(_resolvedCache.keys().next().value);
  _resolvedCache.set(key, { at: Date.now(), value });
  return value;
}

function _emptySimilar() {
  return { artists: [], displayArtists: [], displayVariantMap: {}, variantRankMap: {}, via: null };
}

// A collaboration credit ("Armin van Buuren & AVIRA feat. Sam Martin") can be a
// Last.fm artist of its own whose similar artists are barely in the library;
// such a thin list locks Auto-DJ onto the same few artists, so the next name
// in the credit is tried until the library holds enough of them.
const SIMILAR_MIN_IN_LIBRARY = 5;

async function _resolveSimilarArtists(originalArtist, vpaths) {
  const parts = artistLookupCandidates(String(originalArtist).trim());
  let failed = false;
  let best = null;
  for (const artistName of parts) {
    const rawNames = await _similarArtistNames(artistName);
    if (rawNames == null) failed = true;
    if (!rawNames?.length) continue;
    const nameVariantsMap = new Map();
    for (const name of rawNames) {
      const variants = db.resolveArtistNamesForDJ([name]);
      if (variants.length > 0) nameVariantsMap.set(name, variants);
    }
    console.log(`[autodj] similar-artists "${originalArtist}" → ${rawNames.length} from Last.fm${artistName === originalArtist ? '' : ` via "${artistName}"`}, ${nameVariantsMap.size} in library`);
    if (nameVariantsMap.size === 0) continue;
    if (!best || nameVariantsMap.size > best.nameVariantsMap.size) best = { artistName, rawNames, nameVariantsMap };
    if (nameVariantsMap.size >= SIMILAR_MIN_IN_LIBRARY) break;
  }
  if (!best) {
    console.log(`[autodj] similar-artists "${originalArtist}" → 0 (tried: ${parts.map(p => `"${p}"`).join(', ')}) — pick falls back to bpm/key/genre/year`);
    return { failed, result: _emptySimilar() };
  }
  return { failed, result: _similarResult(best, vpaths) };
}

function _similarResult({ artistName, rawNames, nameVariantsMap }, vpaths) {
  const allVariants = [...new Set([...nameVariantsMap.values()].flat())];
  const hasAlbumsSet = db.artistsWithAlbums(allVariants, vpaths);
  const displayArtists = [];
  const displayVariantMap = {};
  const variantRankMap = {};
  for (const [i, name] of rawNames.entries()) {
    const variants = nameVariantsMap.get(name);
    if (!variants) continue;
    for (const v of variants) variantRankMap[v] = i + 1;
    if (variants.some(v => hasAlbumsSet.has(v))) {
      displayArtists.push(name);
      displayVariantMap[name] = variants;
    }
  }
  return { artists: allVariants, displayArtists, displayVariantMap, variantRankMap, via: artistName };
}

/** Last.fm top tracks for an artist as [{ title, artist, rank }], [] when unknown. */
export async function artistTopTracks(artistName, limit = 50) {
  if (!Scrobbler.apiKey || !artistName) return [];
  const list = await _lastfmCached(`tt\0${limit}\0${String(artistName).toLowerCase()}`, () =>
    _lastfmCall(cb => Scrobbler.GetArtistTopTracks(String(artistName), cb, limit)).then(data => data == null ? null :
      (data?.toptracks?.track || [])
        .filter(t => t?.name && t.artist?.name)
        .map((t, i) => ({ title: t.name, artist: t.artist.name, rank: i + 1 }))));
  return list || [];
}

export function setup(velvet) {
  Scrobbler.setKeys(config.program.lastFM.apiKey, config.program.lastFM.apiSecret)

  for (const user in config.program.users) {
    if (!Object.hasOwn(config.program.users, user)) { continue; }
    const u = config.program.users[user];
    if (!u['lastfm-user']) { continue; }
    if (u['lastfm-session']) {
      // Preferred: session key from a previous connect — password never stored
      Scrobbler.addUserWithSession(u['lastfm-user'], u['lastfm-session']);
    } else if (u['lastfm-password']) {
      // Legacy: plain-text password in old config — works until user reconnects
      Scrobbler.addUser(u['lastfm-user'], u['lastfm-password']);
    }
  }

  velvet.post('/api/v1/lastfm/scrobble-by-metadata', (req, res) => {
    const schema = Joi.object({
      artist: Joi.string().optional().allow(''),
      album: Joi.string().optional().allow(''),
      track: Joi.string().required(),
    });
    joiValidate(schema, req.body);

    // NOTE(pending): update last-played field in DB
    if (!req.user['lastfm-user'] || (!req.user['lastfm-session'] && !req.user['lastfm-password'])) {
      return res.json({ scrobble: false });
    }

    Scrobbler.Scrobble(
      req.body,
      req.user['lastfm-user'],
      (_post_return_data) => { res.json({}); }
    );
  });

  velvet.post('/api/v1/lastfm/scrobble-by-filepath', async (req, res) => {
    const schema = Joi.object({ filePath: Joi.string().required() });
    joiValidate(schema, req.body);
    if (!lastfmActive(req.user)) return res.json({ scrobbled: null });
    await sendScrobbleOutcome(res, scrobbleByFilepath(req.user, req.body.filePath));
  });

  velvet.get('/api/v1/lastfm/similar-artists', async (req, res) => {
    if (!req.query.artist) return res.json({ artists: [] });
    if (!Scrobbler.apiKey) {
      console.warn('[lastfm] similar-artists: no API key configured — set lastFM.apiKey in config');
      return res.json({ artists: [] });
    }
    try {
      const { via: _via, ...body } = await similarArtistsFor(String(req.query.artist), req.user.vpaths);
      res.json(body);
    } catch {
      res.json({ artists: [], displayArtists: [], displayVariantMap: {}, variantRankMap: {} });
    }
  });

  velvet.get('/api/v1/lastfm/artist-info', (req, res) => {
    if (!req.query.artist) return res.json({});
    if (!Scrobbler.apiKey) return res.json({});
    Scrobbler.GetArtistInfo(String(req.query.artist), (data) => {
      if (!data?.artist) return res.json({});
      try {
        const a = data.artist;
        // Strip HTML/links from bio summary
        const rawBio = a.bio?.summary || '';
        const bio = rawBio.replaceAll(/<a[^>]*>.*?<\/a>/gi, '').replaceAll(/<[^>]+>/g, '').trim();
        const tags = (a.tags?.tag || []).map(tag => tag.name).slice(0, 5);
        const listeners = a.stats?.listeners ? Number.parseInt(a.stats.listeners, 10) : null;
        const plays = a.stats?.playcount ? Number.parseInt(a.stats.playcount, 10) : null;
        res.json({ bio, tags, listeners, plays });
      } catch {
        res.json({});
      }
    });
  });

  // ── Per-user self-service Last.fm endpoints ──────────────────

  velvet.get('/api/v1/lastfm/status', (req, res) => {
    res.json({
      serverEnabled: config.program.lastFM?.enabled !== false,
      hasApiKey: !!(config.program.lastFM?.apiKey),
      linkedUser: req.user['lastfm-user'] || null,
    });
  });

  // ── Subsonic scrobble forwarding settings (per user) ─────────
  // Returns whether each service is available+linked and what the user's
  // current forwarding preferences are.
  velvet.get('/api/v1/subsonic/scrobble-settings', (req, res) => {
    const lastfmAvailable = !!(
      config.program.lastFM?.enabled !== false &&
      config.program.lastFM?.apiKey &&
      (req.user['lastfm-session'] || req.user['lastfm-password']) &&
      req.user['lastfm-user']
    );
    const lbAvailable = !!(
      config.program.listenBrainz?.enabled === true &&
      (req.user.username === 'velvet-user'
        ? _noAuthLbToken
        : req.user['listenbrainz-token'])
    );
    res.json({
      lastfmAvailable,
      lbAvailable,
      scrobbleLastfm: lastfmAvailable && req.user['subsonic-scrobble-lastfm'] === true,
      scrobbleLb:     lbAvailable     && req.user['subsonic-scrobble-lb']     === true,
    });
  });

  velvet.post('/api/v1/lastfm/connect', async (req, res) => {
    const schema = Joi.object({
      lastfmUser:     Joi.string().required(),
      lastfmPassword: Joi.string().required(),
    });
    joiValidate(schema, req.body);

    // Authenticate against Last.fm before saving
    const token = crypto.createHash('md5').update( // NOSONAR: Last.fm API requires MD5 per protocol specification
      req.body.lastfmUser + crypto.createHash('md5').update(req.body.lastfmPassword, 'utf8').digest('hex'), // NOSONAR: Last.fm API requires MD5 per protocol specification
      'utf8'
    ).digest('hex');
    const apiSig = crypto.createHash('md5').update( // NOSONAR: Last.fm API requires MD5 per protocol specification
      `api_key${config.program.lastFM.apiKey}authToken${token}methodauth.getMobileSessionusername${req.body.lastfmUser}${config.program.lastFM.apiSecret}`,
      'utf8'
    ).digest('hex');
    // Call Last.fm — validateStatus:null lets us read error bodies instead of axios throwing
    let lfmResponse;
    try {
      lfmResponse = await axios({
        method: 'GET',
        url: `https://ws.audioscrobbler.com/2.0/?method=auth.getMobileSession&username=${encodeURIComponent(req.body.lastfmUser)}&authToken=${token}&api_key=${config.program.lastFM.apiKey}&api_sig=${apiSig}&format=json`,
        validateStatus: null,
      });
    } catch (netErr) {
      throw new WebError('Could not reach Last.fm: ' + netErr.message, 502);
    }
    if (lfmResponse.data?.error) {
      throw new WebError(`Last.fm error: ${lfmResponse.data.message || 'Authentication failed'} (code ${lfmResponse.data.error})`, 401);
    }
    const sessionKey = lfmResponse.data?.session?.key;
    if (!sessionKey) { throw new WebError('Last.fm returned no session key', 502); }

    // Persist session key only — password is never written to disk
    await editUserConfig(req.user.username, u => {
      u['lastfm-user']    = req.body.lastfmUser;
      u['lastfm-session'] = sessionKey;
      delete u['lastfm-password'];
    });

    Scrobbler.addUserWithSession(req.body.lastfmUser, sessionKey);
    res.json({ linkedUser: req.body.lastfmUser });
  });

  velvet.post('/api/v1/lastfm/disconnect', async (req, res) => {
    const lfmUser = req.user['lastfm-user'];

    await editUserConfig(req.user.username, u => {
      delete u['lastfm-user'];
      delete u['lastfm-session'];
      delete u['lastfm-password'];
    });

    // Remove from runtime scrobbler
    if (lfmUser && Scrobbler.users[lfmUser]) delete Scrobbler.users[lfmUser];

    res.json({});
  });
}

export function reset() {
  Scrobbler.reset();
}

// Allow admin.js to update the runtime API keys without restarting
export function updateApiKeys(apiKey, apiSecret) {
  Scrobbler.setKeys(apiKey, apiSecret);
}

// Expose the shared Scrobbler instance for Last.fm API calls from other modules
export { Scrobbler };

const lastfmLinked = (user) => Boolean(user['lastfm-user'] && (user['lastfm-session'] || user['lastfm-password']));

/** The web player's Last.fm switch (scrobble-by-filepath runs at all) and whether the user is linked as well. */
export function lastfmEnabled() {
  return config.program.lastFM?.enabled !== false;
}

export function lastfmActive(user) {
  return lastfmEnabled() && Boolean(config.program.lastFM?.apiKey) && lastfmLinked(user);
}

export function findUserFile(filePath, user) {
  return _lookupFileWithChildFallback(getVPathInfo(filePath, user), user);
}

/**
 * The play count (pc/lp) of a song played 30 s, plus its Last.fm scrobble when the user is linked.
 * user: { ...config.program.users[name], username }. -> null when the file is unknown, else a promise
 * of the Last.fm outcome: true / false, null when the user is not linked.
 */
export function scrobbleByFilepath(user, filePath) {
  // The play count is raised once per play by log-play (src/api/db.js logPlay), not again here.
  const file = findUserFile(filePath, user);
  if (!file) return null;
  if (!lastfmLinked(user)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), LASTFM_SCROBBLE_TIMEOUT_MS);
    const done = (ok) => { clearTimeout(timer); resolve(ok); };
    try {
      Scrobbler.Scrobble({ artist: file.artist, album: file.album, track: file.title }, user['lastfm-user'],
        (body) => done(body != null && !/status="failed"/.test(body)));
    } catch (e) {
      console.debug('[velvet]', e?.message ?? e);
      done(false);
    }
  });
}

/**
 * Submit a Last.fm scrobble on behalf of a user object from config.program.users.
 * No-op if the user hasn't linked Last.fm or the API key is missing.
 */
export function scrobbleLastfmForUser(userObj, { artist, album, track }) {
  if (!userObj['lastfm-user']) return;
  if (!config.program.lastFM?.apiKey) return;
  Scrobbler.Scrobble({ artist, album, track }, userObj['lastfm-user'], () => {});
}

/**
 * Submit a ListenBrainz scrobble on behalf of a username string.
 * No-op if the user hasn't linked LB or LB is disabled.
 */
export function scrobbleLbForUser(username, { artist, album, track }) {
  const token = username === 'velvet-user'
    ? _noAuthLbToken
    : config.program.users?.[username]?.['listenbrainz-token'];
  if (!token) return;
  lbSubmit(token, artist, track, album, Math.floor(Date.now() / 1000)).catch(() => {});
}

// ── ListenBrainz ─────────────────────────────────────────────────────────────

// In no-auth mode there is no persistent user object, so the token is stored
// under config.program.listenBrainz.noAuthToken in default.json.
// Initialized in setupListenBrainz() once config.program is available.
let _noAuthLbToken = null;

const lbToken = (user) => (user.username === 'velvet-user' ? _noAuthLbToken : user['listenbrainz-token']);

export function lbActive(user) {
  return config.program.listenBrainz?.enabled === true && Boolean(lbToken(user));
}

function lbSend(user, filePath, listenedAt) {
  const token = lbToken(user);
  if (!token) return null;
  const file = findUserFile(filePath, user);
  if (!file) return null;
  return lbSubmit(token, file.artist, file.title, file.album, listenedAt).then(() => true, (e) => {
    console.debug('[velvet]', e?.message ?? e);
    return false;
  });
}

/** ListenBrainz now-playing for a song that starts. -> null when not sent (no token / unknown file), else a promise of the outcome. */
export function lbPlayingNow(user, filePath) {
  return lbSend(user, filePath, 'playing_now');
}

/** ListenBrainz listen for a song played 30 s. -> null when not sent, else a promise of the outcome. */
export function lbScrobbleByFilepath(user, filePath) {
  return lbSend(user, filePath);
}

/**
 * Submit a listen to ListenBrainz.
 * listen_type: 'single' (scrobble) or 'playing_now' (now-playing ping).
 * https://listenbrainz.readthedocs.io/en/latest/users/api/index.html
 */
function lbSubmit(token, artist, track, release, listenedAt) {
  const isNowPlaying = listenedAt === 'playing_now';
  return new Promise((resolve, reject) => {
    const trackMeta = {
      artist_name: artist || '',
      track_name:  track  || '',
      ...(release ? { release_name: release } : {}),
      additional_info: { submission_client: 'Velvet', media_player: 'Velvet' },
    };
    const listenEntry = isNowPlaying
      ? { track_metadata: trackMeta }
      : { listened_at: listenedAt || Math.floor(Date.now() / 1000), track_metadata: trackMeta };
    const payload = JSON.stringify({
      listen_type: isNowPlaying ? 'playing_now' : 'single',
      payload: [listenEntry],
    });
    const req = https.request({
      hostname: 'api.listenbrainz.org',
      path: '/1/submit-listens',
      method: 'POST',
      headers: {
        'Authorization': `Token ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        if (res.statusCode === 200) { resolve(true); }
        else {
          const contentType = res.headers['content-type'] ?? '';
          const body = contentType.includes('text/html')
            ? data.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120)
            : data.slice(0, 200);
          reject(new Error(`ListenBrainz ${res.statusCode}: ${body}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('ListenBrainz timeout')); });
    req.write(payload);
    req.end();
  });
}

export function setupListenBrainz(velvet) {
  // Restore no-auth token from config file (survives server restarts)
  _noAuthLbToken = config.program.listenBrainz?.noAuthToken || null;

  // ── Admin: enable/disable ───────────────────────────────────────────────────
  velvet.get('/api/v1/admin/listenbrainz/config', (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });
    res.json({ enabled: config.program.listenBrainz?.enabled === true });
  });

  velvet.post('/api/v1/admin/listenbrainz/config', async (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });
    const schema = Joi.object({ enabled: Joi.boolean().required() });
    joiValidate(schema, req.body);
    await editListenBrainzConfig(lb => { lb.enabled = req.body.enabled; });
    res.json({});
  });

  // ── Per-user: status / connect / disconnect ─────────────────────────────────
  velvet.get('/api/v1/listenbrainz/status', (req, res) => {
    const isNoAuth = req.user.username === 'velvet-user';
    const linked   = isNoAuth ? !!_noAuthLbToken : !!req.user['listenbrainz-token'];
    res.json({
      serverEnabled: config.program.listenBrainz?.enabled === true,
      linked,
    });
  });

  velvet.post('/api/v1/listenbrainz/connect', async (req, res) => {
    const schema = Joi.object({ lbToken: Joi.string().required() });
    joiValidate(schema, req.body);
    const token = req.body.lbToken.trim();

    // Validate the token by calling the LB validate-token endpoint
    const vtRes = await new Promise((resolve) => {
      https.get({
        hostname: 'api.listenbrainz.org',
        path: `/1/validate-token`,
        headers: { 'Authorization': `Token ${token}` },
      }, r => {
        let d = ''; r.on('data', c => { d += c; }); r.on('end', () => resolve({ status: r.statusCode, body: d }));
      }).on('error', () => resolve({ status: 0, body: '' }));
    });
    let vtJson;
    try { vtJson = JSON.parse(vtRes.body); } catch { vtJson = {}; }
    if (vtRes.status !== 200 || !vtJson.valid) {
      throw new WebError('Invalid ListenBrainz token — check and try again', 401);
    }

    // Persist token — no-auth uses listenBrainz.noAuthToken in config file
    const username = req.user.username;
    if (username === 'velvet-user') {
      _noAuthLbToken = token;
      await editListenBrainzConfig(lb => { lb.noAuthToken = token; });
    } else {
      await editUserConfig(username, u => { u['listenbrainz-token'] = token; });
    }
    res.json({ linked: true, lbUsername: vtJson.user_name || null });
  });

  velvet.post('/api/v1/listenbrainz/disconnect', async (req, res) => {
    const username = req.user.username;
    if (username === 'velvet-user') {
      _noAuthLbToken = null;
      await editListenBrainzConfig(lb => { delete lb.noAuthToken; });
    } else {
      await editUserConfig(username, u => { delete u['listenbrainz-token']; });
    }
    res.json({});
  });

  // ── Now-playing ping (appears instantly on ListenBrainz) ───────────────────
  velvet.post('/api/v1/listenbrainz/playing-now', (req, res) => {
    const schema = Joi.object({ filePath: Joi.string().required() });
    joiValidate(schema, req.body);
    res.json({ sent: Boolean(lbPlayingNow(req.user, req.body.filePath)) });
  });

  // ── Scrobble ────────────────────────────────────────────────────────────────
  velvet.post('/api/v1/listenbrainz/scrobble-by-filepath', async (req, res) => {
    const schema = Joi.object({ filePath: Joi.string().required() });
    joiValidate(schema, req.body);
    if (!lbActive(req.user)) return res.json({ scrobbled: null });
    await sendScrobbleOutcome(res, lbScrobbleByFilepath(req.user, req.body.filePath));
  });
}

// { scrobbled: true } sent, false when the file is unknown to the user or the service refused it
// (null = not linked, answered by the caller). outcome: null for an unknown file, else a promise of true/false.
async function sendScrobbleOutcome(res, outcome) {
  res.json({ scrobbled: outcome === null ? false : await outcome === true });
}

// One edit applied to the user's entry in the config file (serialised, atomic write) and in memory.
async function editUserConfig(username, edit) {
  await config.updateConfigFile(c => { if (c.users?.[username]) edit(c.users[username]); });
  if (config.program.users[username]) edit(config.program.users[username]);
}

async function editListenBrainzConfig(edit) {
  await config.updateConfigFile(c => {
    c.listenBrainz ??= {};
    edit(c.listenBrainz);
  });
  config.program.listenBrainz ??= {};
  edit(config.program.listenBrainz);
}

function _lookupFileWithChildFallback(pathInfo, user) {
  for (const c of dbLocationCandidates(pathInfo, user)) {
    const row = db.findFileByPath(c.relPath, c.vpath);
    if (row) return row;
  }
  return null;
}
