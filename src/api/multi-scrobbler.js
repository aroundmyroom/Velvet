// multi-scrobbler (https://github.com/FoxxMD/multi-scrobbler) as a scrobble target: Velvet posts its listens to the
// "ListenBrainz endpoint" source of a multi-scrobbler server, which forwards them to the services set up there
// (ListenBrainz, Maloja, Koito, Libre.fm, teal.fm, Rocksky, …). Same listen body and timing as ListenBrainz.
import Joi from 'joi';
import * as config from '../state/config.js';
import { joiValidate } from '../util/validation.js';
import WebError from '../util/web-error.js';
import { lbRequest, findUserFile, listenMetaOf, lbListenBody, editUserConfig } from './scrobbler.js';

const NO_AUTH_USER = 'velvet-user';
const TIMEOUT_MS = 6000;

// username → { at, ok, status, message } of the last listen sent, shown in the player and admin settings.
const _lastResult = new Map();

const msConfig = () => config.program.multiScrobbler ?? {};

function msServerReady() {
  const c = msConfig();
  return c.enabled === true && Boolean(c.url);
}

const userOptedIn = (user) => user.username === NO_AUTH_USER || user['ms-enabled'] === true;

// The token this user's listens carry: their own (one multi-scrobbler source per person), else the server's.
const tokenFor = (user) => (user.username !== NO_AUTH_USER && user['ms-token']) || msConfig().token || '';

export function msActive(user) {
  return msServerReady() && userOptedIn(user);
}

function record(username, outcome) {
  _lastResult.set(username, outcome);
}

function describe(status, body) {
  if (status === 409) return 'token';
  if (status === 0) return 'unreachable';
  return `${status} ${String(body || '').replace(/\s+/g, ' ').slice(0, 160)}`.trim();
}

function send(user, filePath, listenedAt) {
  if (!msActive(user)) return null;
  const file = findUserFile(filePath, user);
  if (!file) return null;
  return submit(user, listenMetaOf(file), listenedAt);
}

/** Now-playing ping for a song that starts. -> null when not sent, else a promise of true/false. */
export function msPlayingNow(user, filePath) {
  return send(user, filePath, 'playing_now');
}

/** Listen for a song played 30 s. -> null when not sent (off / unknown file), else a promise of true/false. */
export function msScrobbleByFilepath(user, filePath) {
  return send(user, filePath);
}

/** Listen from metadata only (Subsonic clients, CUE tracks). */
export function scrobbleMsForUser(username, meta) {
  const userObj = username === NO_AUTH_USER ? { username } : { ...config.program.users?.[username], username };
  if (!msActive(userObj)) return;
  submit(userObj, meta, Math.floor(Date.now() / 1000)).catch(() => {});
}

/** Now-playing from metadata only (Subsonic clients reporting a song that starts). */
export function msPlayingNowForUser(username, row) {
  const userObj = username === NO_AUTH_USER ? { username } : { ...config.program.users?.[username], username };
  if (!row || !msActive(userObj)) return;
  submit(userObj, listenMetaOf(row), 'playing_now').catch(() => {});
}

// -> a promise of true/false; never rejects.
async function submit(user, meta, listenedAt) {
  const target = { base: msConfig().url, token: tokenFor(user) };
  const r = await lbRequest(target, 'POST', '/1/submit-listens', lbListenBody(meta, listenedAt))
    .catch(() => ({ status: 0, body: '' }));
  if (listenedAt !== 'playing_now') {
    record(user.username, r.status === 200 ? { at: Date.now(), ok: true } : { at: Date.now(), ok: false, message: describe(r.status, r.body) });
  }
  return r.status === 200;
}

async function getJson(base, apiPath) {
  try {
    const r = await Promise.race([
      lbRequest({ base }, 'GET', apiPath),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), TIMEOUT_MS)),
    ]);
    let json = null;
    try { json = JSON.parse(r.body); } catch { /* not JSON */ }
    return { status: r.status, json };
  } catch {
    return { status: 0, json: null };
  }
}

/** Reachability check of a multi-scrobbler server: version, health, and whether a ListenBrainz endpoint source exists. */
async function msProbe(base) {
  const [version, health, endpoint] = await Promise.all([
    getJson(base, '/api/version'),
    getJson(base, '/api/health'),
    getJson(base, '/1/validate-token'),
  ]);
  return {
    reachable: version.status === 200 || health.status !== 0,
    version: version.json?.version ?? null,
    healthy: health.status === 200,
    healthStatus: health.status,
    endpointSource: endpoint.status === 200,
  };
}

async function editConfig(edit) {
  await config.updateConfigFile(c => {
    c.multiScrobbler ??= {};
    edit(c.multiScrobbler);
  });
  config.program.multiScrobbler ??= {};
  edit(config.program.multiScrobbler);
}

const urlSchema = Joi.string().trim().uri({ scheme: ['http', 'https'] }).allow('');

export function setup(velvet) {
  // ── Admin ──────────────────────────────────────────────────────────────────
  velvet.get('/api/v1/admin/multi-scrobbler/config', (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });
    const c = msConfig();
    res.json({ enabled: c.enabled === true, url: c.url || '', hasToken: Boolean(c.token) });
  });

  velvet.post('/api/v1/admin/multi-scrobbler/config', async (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });
    joiValidate(Joi.object({
      enabled: Joi.boolean().required(),
      url: urlSchema.required(),
      msToken: Joi.string().trim().allow('').max(256).optional(),
    }), req.body);
    if (req.body.enabled && !req.body.url.trim()) throw new WebError('A multi-scrobbler URL is required', 400);
    await editConfig(c => {
      c.enabled = req.body.enabled;
      c.url = req.body.url.trim().replace(/\/+$/, '');
      if (req.body.msToken !== undefined) c.token = req.body.msToken.trim();
    });
    res.json({});
  });

  velvet.post('/api/v1/admin/multi-scrobbler/test', async (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });
    joiValidate(Joi.object({ url: urlSchema.optional() }), req.body);
    const base = (req.body.url || msConfig().url || '').trim().replace(/\/+$/, '');
    if (!base) throw new WebError('A multi-scrobbler URL is required', 400);
    res.json(await msProbe(base));
  });

  // ── Per user ───────────────────────────────────────────────────────────────
  velvet.get('/api/v1/multi-scrobbler/status', (req, res) => {
    const isNoAuth = req.user.username === NO_AUTH_USER;
    res.json({
      serverEnabled: msServerReady(),
      enabled: userOptedIn(req.user),
      ownToken: !isNoAuth && Boolean(req.user['ms-token']),
      serverToken: Boolean(msConfig().token),
      canEdit: !isNoAuth,
      last: _lastResult.get(req.user.username) ?? null,
    });
  });

  velvet.post('/api/v1/multi-scrobbler/settings', async (req, res) => {
    if (req.user.username === NO_AUTH_USER) throw new WebError('Not available without user accounts', 400);
    joiValidate(Joi.object({
      enabled: Joi.boolean().required(),
      msToken: Joi.string().trim().allow('').max(256).optional(),
    }), req.body);
    await editUserConfig(req.user.username, u => {
      u['ms-enabled'] = req.body.enabled;
      if (req.body.msToken !== undefined) {
        if (req.body.msToken.trim()) u['ms-token'] = req.body.msToken.trim();
        else delete u['ms-token'];
      }
    });
    res.json({});
  });

  velvet.post('/api/v1/multi-scrobbler/playing-now', (req, res) => {
    joiValidate(Joi.object({ filePath: Joi.string().required() }), req.body);
    res.json({ sent: Boolean(msPlayingNow(req.user, req.body.filePath)) });
  });

  velvet.post('/api/v1/multi-scrobbler/scrobble-by-filepath', async (req, res) => {
    joiValidate(Joi.object({ filePath: Joi.string().required() }), req.body);
    if (!msActive(req.user)) return res.json({ scrobbled: null });
    const outcome = msScrobbleByFilepath(req.user, req.body.filePath);
    res.json({ scrobbled: outcome === null ? false : await outcome === true });
  });
}
