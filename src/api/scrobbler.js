import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import https from 'node:https';
import Joi from 'joi';
import axios from 'axios';
import * as config from '../state/config.js';
import Scribble from '../state/lastfm.js';
import * as db from '../db/manager.js';
import { joiValidate } from '../util/validation.js';
import { getVPathInfo } from '../util/vpath.js';
import WebError from '../util/web-error.js';

const Scrobbler = new Scribble();

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

  velvet.post('/api/v1/lastfm/scrobble-by-filepath', (req, res) => {
    const schema = Joi.object({ filePath: Joi.string().required() });
    joiValidate(schema, req.body);

    const pathInfo  = getVPathInfo(req.body.filePath, req.user);
    const dbFileInfo = _lookupFileWithChildFallback(pathInfo, req.user);

    if (!dbFileInfo) return res.json({ scrobble: false });

    const result = db.findUserMetadata(dbFileInfo.hash, req.user.username);
    if (result) {
      result.pc = result.pc && typeof result.pc === 'number' ? result.pc + 1 : 1;
      result.lp = Date.now();
      db.updateUserMetadata(result);
    } else {
      db.insertUserMetadata({ user: req.user.username, hash: dbFileInfo.hash, pc: 1, lp: Date.now() });
    }
    db.saveUserDB();
    res.json({});

    if (req.user['lastfm-user'] && (req.user['lastfm-session'] || req.user['lastfm-password'])) {
      Scrobbler.Scrobble(
        { artist: dbFileInfo.artist, album: dbFileInfo.album, track: dbFileInfo.title },
        req.user['lastfm-user'],
        (_post_return_data) => {}
      );
    }
  });

  velvet.get('/api/v1/lastfm/similar-artists', (req, res) => {
    if (!req.query.artist) return res.json({ artists: [] });
    if (!Scrobbler.apiKey) {
      console.warn('[lastfm] similar-artists: no API key configured — set lastFM.apiKey in config');
      return res.json({ artists: [] });
    }
    // Strip "feat. X", "ft. X", "featuring X", "vs. X" suffixes so Last.fm
    // can match the primary artist name (e.g. "C+C Music Factory feat. Deborah Cooper"
    // → "C+C Music Factory").
    const artistName = String(req.query.artist)
      .replace(/\s+(feat\.|ft\.|featuring|vs\.?)\s+.*/i, '')
      .trim();
    Scrobbler.GetSimilarArtists(
      artistName,
      (data) => {
        if (!data) return res.json({ artists: [], displayArtists: [], displayVariantMap: {} });
        try {
          const rawNames = (data?.similarartists?.artist || [])
            .slice(0, 50)
            .map(a => a.name)
            .filter(Boolean);
          // Resolve each Last.fm name individually to find their raw DB variants.
          // displayArtists = clean Last.fm names confirmed to have actual ALBUMS in the
          //   library (not just featuring credits on compilations).
          // artists = all raw DB variants across all matched names (for Auto-DJ SQL IN filter).
          // displayVariantMap = name → raw DB variants, so the client can navigate to the
          //   correct artist profile using the actual DB artist values.
          const nameVariantsMap = new Map(); // name → variants[]
          const allVariantsSet = new Set();
          const displayVariantMap = {};
          for (const name of rawNames) {
            const variants = db.resolveArtistNamesForDJ([name]);
            if (variants.length > 0) {
              nameVariantsMap.set(name, variants);
              for (const v of variants) allVariantsSet.add(v);
            }
          }
          // Single batch query: which resolved variants are primary album artists?
          // Replaces 50 individual artistHasAlbums() calls with one IN-clause query.
          const hasAlbumsSet = db.artistsWithAlbums([...allVariantsSet], req.user.vpaths);
          const displayArtists = [];
          for (const [name, variants] of nameVariantsMap) {
            if (variants.some(v => hasAlbumsSet.has(v))) {
              displayArtists.push(name);
              displayVariantMap[name] = variants;
            }
          }
          res.json({ artists: [...allVariantsSet], displayArtists, displayVariantMap });
        } catch {
          res.json({ artists: [], displayArtists: [], displayVariantMap: {} });
        }
      },
      50
    );
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

  velvet.post('/api/v1/lastfm/test-login', async (req, res) => {
    const schema = Joi.object({
      username: Joi.string().required(),
      password: Joi.string().required()
    });
    joiValidate(schema, req.body);

    const token = crypto.createHash('md5').update(req.body.username + crypto.createHash('md5').update(req.body.password, 'utf8').digest("hex"), 'utf8').digest("hex"); // NOSONAR: Last.fm API requires MD5 per protocol specification
    const cryptoString = `api_key${config.program.lastFM.apiKey}authToken${token}methodauth.getMobileSessionusername${req.body.username}${config.program.lastFM.apiSecret}`;
    const hash = crypto.createHash('md5').update(cryptoString, 'utf8').digest("hex"); // NOSONAR: Last.fm API requires MD5 per protocol specification

    await axios({
      method: 'GET',
      url: `https://ws.audioscrobbler.com/2.0/?method=auth.getMobileSession&username=${req.body.username}&authToken=${token}&api_key=${config.program.lastFM.apiKey}&api_sig=${hash}`
    });
    res.json({});
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
    const loadConfig = JSON.parse(await fs.readFile(config.configFile, 'utf-8'));
    if (!loadConfig.users) loadConfig.users = {};
    if (!loadConfig.users[req.user.username]) loadConfig.users[req.user.username] = {};
    loadConfig.users[req.user.username]['lastfm-user']    = req.body.lastfmUser;
    loadConfig.users[req.user.username]['lastfm-session'] = sessionKey;
    delete loadConfig.users[req.user.username]['lastfm-password'];
    await fs.writeFile(config.configFile, JSON.stringify(loadConfig, null, 2), 'utf8');

    config.program.users[req.user.username]['lastfm-user']    = req.body.lastfmUser;
    config.program.users[req.user.username]['lastfm-session'] = sessionKey;
    delete config.program.users[req.user.username]['lastfm-password'];

    Scrobbler.addUserWithSession(req.body.lastfmUser, sessionKey);
    res.json({ linkedUser: req.body.lastfmUser });
  });

  velvet.post('/api/v1/lastfm/disconnect', async (req, res) => {
    const lfmUser = req.user['lastfm-user'];

    // Remove from config.json
    const loadConfig = JSON.parse(await fs.readFile(config.configFile, 'utf-8'));
    if (loadConfig.users?.[req.user.username]) {
      delete loadConfig.users[req.user.username]['lastfm-user'];
      delete loadConfig.users[req.user.username]['lastfm-session'];
      delete loadConfig.users[req.user.username]['lastfm-password'];
      await fs.writeFile(config.configFile, JSON.stringify(loadConfig, null, 2), 'utf8');
    }
    delete config.program.users[req.user.username]['lastfm-user'];
    delete config.program.users[req.user.username]['lastfm-session'];
    delete config.program.users[req.user.username]['lastfm-password'];

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
    const loadConfig = JSON.parse(await fs.readFile(config.configFile, 'utf-8'));
    if (!loadConfig.listenBrainz) loadConfig.listenBrainz = {};
    loadConfig.listenBrainz.enabled = req.body.enabled;
    await fs.writeFile(config.configFile, JSON.stringify(loadConfig, null, 2), 'utf8');
    config.program.listenBrainz.enabled = req.body.enabled;
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
      const loadConfig = JSON.parse(await fs.readFile(config.configFile, 'utf-8'));
      if (!loadConfig.listenBrainz) loadConfig.listenBrainz = {};
      loadConfig.listenBrainz.noAuthToken = token;
      await fs.writeFile(config.configFile, JSON.stringify(loadConfig, null, 2), 'utf8');
      if (!config.program.listenBrainz) config.program.listenBrainz = {};
      config.program.listenBrainz.noAuthToken = token;
    } else {
      const loadConfig = JSON.parse(await fs.readFile(config.configFile, 'utf-8'));
      if (!loadConfig.users) loadConfig.users = {};
      if (!loadConfig.users[username]) loadConfig.users[username] = {};
      loadConfig.users[username]['listenbrainz-token'] = token;
      await fs.writeFile(config.configFile, JSON.stringify(loadConfig, null, 2), 'utf8');
      config.program.users[username]['listenbrainz-token'] = token;
    }
    res.json({ linked: true, lbUsername: vtJson.user_name || null });
  });

  velvet.post('/api/v1/listenbrainz/disconnect', async (req, res) => {
    const username = req.user.username;
    if (username === 'velvet-user') {
      _noAuthLbToken = null;
      const loadConfig = JSON.parse(await fs.readFile(config.configFile, 'utf-8'));
      if (loadConfig.listenBrainz) {
        delete loadConfig.listenBrainz.noAuthToken;
        await fs.writeFile(config.configFile, JSON.stringify(loadConfig, null, 2), 'utf8');
      }
      if (config.program.listenBrainz) delete config.program.listenBrainz.noAuthToken;
    } else {
      const loadConfig = JSON.parse(await fs.readFile(config.configFile, 'utf-8'));
      if (loadConfig.users?.[username]) {
        delete loadConfig.users[username]['listenbrainz-token'];
        await fs.writeFile(config.configFile, JSON.stringify(loadConfig, null, 2), 'utf8');
      }
      if (config.program.users[username]) delete config.program.users[username]['listenbrainz-token'];
    }
    res.json({});
  });

  // ── Now-playing ping (appears instantly on ListenBrainz) ───────────────────
  velvet.post('/api/v1/listenbrainz/playing-now', async (req, res) => {
    const schema = Joi.object({ filePath: Joi.string().required() });
    joiValidate(schema, req.body);

    const username = req.user.username;
    const token = username === 'velvet-user'
      ? _noAuthLbToken
      : req.user['listenbrainz-token'];
    if (!token) return res.json({ sent: false });

    const pathInfo = getVPathInfo(req.body.filePath, req.user);
    let dbFileInfo = db.findFileByPath(pathInfo.relativePath, pathInfo.vpath);
    if (!dbFileInfo) {
      const folders = config.program?.folders || {};
      const myRoot  = folders[pathInfo.vpath]?.root.replace(/\/?$/, '/');
      if (myRoot) {
        for (const [parentKey, parentFolder] of Object.entries(folders)) {
          if (parentKey === pathInfo.vpath) continue;
          if (!req.user.vpaths.includes(parentKey)) continue;
          const parentRoot = parentFolder.root.replace(/\/?$/, '/');
          if (myRoot.startsWith(parentRoot) && myRoot !== parentRoot) {
            const prefix = myRoot.slice(parentRoot.length);
            dbFileInfo = db.findFileByPath(prefix + pathInfo.relativePath, parentKey);
            if (dbFileInfo) break;
          }
        }
      }
    }
    if (!dbFileInfo) return res.json({ sent: false });

    res.json({ sent: true });
    try {
      await lbSubmit(token, dbFileInfo.artist, dbFileInfo.title, dbFileInfo.album, 'playing_now');
    } catch (e) { console.debug('[velvet]', e?.message ?? e); }
  });

  // ── Scrobble ────────────────────────────────────────────────────────────────
  velvet.post('/api/v1/listenbrainz/scrobble-by-filepath', async (req, res) => {
    const schema = Joi.object({ filePath: Joi.string().required() });
    joiValidate(schema, req.body);

    const username = req.user.username;
    const token = username === 'velvet-user'
      ? _noAuthLbToken
      : req.user['listenbrainz-token'];
    if (!token) return res.json({ scrobble: false });

    const pathInfo = getVPathInfo(req.body.filePath, req.user);
    let dbFileInfo = db.findFileByPath(pathInfo.relativePath, pathInfo.vpath);
    if (!dbFileInfo) {
      const folders = config.program?.folders || {};
      const myRoot  = folders[pathInfo.vpath]?.root.replace(/\/?$/, '/');
      if (myRoot) {
        for (const [parentKey, parentFolder] of Object.entries(folders)) {
          if (parentKey === pathInfo.vpath) continue;
          if (!req.user.vpaths.includes(parentKey)) continue;
          const parentRoot = parentFolder.root.replace(/\/?$/, '/');
          if (myRoot.startsWith(parentRoot) && myRoot !== parentRoot) {
            const prefix = myRoot.slice(parentRoot.length);
            dbFileInfo = db.findFileByPath(prefix + pathInfo.relativePath, parentKey);
            if (dbFileInfo) break;
          }
        }
      }
    }
    if (!dbFileInfo) return res.json({ scrobble: false });

    res.json({});
    try {
      await lbSubmit(token, dbFileInfo.artist, dbFileInfo.title, dbFileInfo.album);
    } catch (e) { console.debug('[velvet]', e?.message ?? e); }
  });
}

function _lookupFileWithChildFallback(pathInfo, user) {
  let fileInfo = db.findFileByPath(pathInfo.relativePath, pathInfo.vpath);
  if (fileInfo) return fileInfo;
  const folders = config.program?.folders || {};
  const myRoot  = folders[pathInfo.vpath]?.root.replace(/\/?$/, '/');
  if (!myRoot) return null;
  for (const [parentKey, parentFolder] of Object.entries(folders)) {
    if (parentKey === pathInfo.vpath) continue;
    if (!user.vpaths.includes(parentKey)) continue;
    const parentRoot = parentFolder.root.replace(/\/?$/, '/');
    if (myRoot.startsWith(parentRoot) && myRoot !== parentRoot) {
      const prefix = myRoot.slice(parentRoot.length);
      fileInfo = db.findFileByPath(prefix + pathInfo.relativePath, parentKey);
      if (fileInfo) return fileInfo;
    }
  }
  return null;
}
