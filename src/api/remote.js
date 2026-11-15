import url from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import Joi from 'joi';
import { nanoid } from 'nanoid';
import jwt from 'jsonwebtoken';
import { isTokenCurrent, signUserToken } from './auth.js';
import { WebSocketServer } from 'ws';
import winston from 'winston';
import * as config from '../state/config.js';
import { joiValidate } from '../util/validation.js';
import WebError from '../util/web-error.js';

// list of currently connected clients (users)
// Maps, not plain objects: codes arrive unauthenticated, and "__proto__" or
// "toString" must never resolve to a session
const clients = new Map();
// Map code to JWT
const codeTokenMap = new Map();
// Map code to session start time (unix ms)
const codeStartTime = new Map();
const playlistCache = new Map();
const nowPlayingCache = new Map();
const allowedCommands = new Set([
  'next',
  'previous',
  'playPause',
  'addSong',
  'getPlaylist',
  'removeSong',
  'getNowPlaying',
  'goToSong',
]);

// Anyone holding the code (shared by QR with party guests) gets this token, so it only
// opens the routes the remote page uses (auth.js enforces scope 'jukebox') and expires.
const JUKEBOX_TOKEN_TTL_SEC = 12 * 60 * 60;

function mintJukeboxToken(username, code) {
  return signUserToken(username, { scope: 'jukebox', code }, { expiresIn: JUKEBOX_TOKEN_TTL_SEC });
}

export function setupAfterAuth(velvet, server) {
  const wss = new WebSocketServer({ server: server, verifyClient: (info, cb) => {
    try {
      let decoded;
      if (config.program.users && Object.keys(config.program.users).length !== 0) {
        const token = url.parse(info.req.url, true).query.token;
        if (!token) { throw new Error('Token Not Found'); }
        decoded = jwt.verify(token, config.program.secret);
        // A scoped or revoked token must not mint itself a fresh one
        if (decoded.scope || !isTokenCurrent(decoded)) { throw new Error('Not a current login token'); }
      }

      info.req.jukeboxUser = decoded?.username ?? 'velvet-user';
      cb(true);
    } catch (err) {
      winston.error('WS Connection Failed', { stack: err });
      cb(false, 401, 'Unauthorized');
    }
  }});

  wss.on('connection', (connection, req) => {
    const code = nanoid(8);
    winston.info(`Websocket Connection Accepted With Code: ${code}`);
    clients.set(code, connection);
    codeStartTime.set(code, Date.now());

    const token = mintJukeboxToken(req.jukeboxUser, code);
    codeTokenMap.set(code, token);

    connection.send(JSON.stringify({ code: code, token }));

    // user sent message
    connection.on('message', (_message) => {
      connection.send(JSON.stringify({ code: code }));
    });

    connection.on('close', (_connection) => {
      clients.delete(code);
      codeTokenMap.delete(code);
      codeStartTime.delete(code);
      playlistCache.delete(code);
      nowPlayingCache.delete(code);
    });
  });

  // GET /api/v1/jukebox/sessions — admin-only list of all active jukebox sessions
  velvet.get('/api/v1/jukebox/sessions', (req, res) => {
    if (config.program.lockAdmin === true) { return res.status(405).json({ error: 'Admin API Disabled' }); }
    if (req.user.admin !== true)           { return res.status(403).json({ error: 'Forbidden' }); }

    const sessions = [...clients.keys()].map(code => ({
      code,
      token:     codeTokenMap.get(code)  || null,
      startTime: codeStartTime.get(code) || null,
      url:       `/remote/${code}`,
    }));

    res.json({ sessions });
  });

  velvet.post('/api/v1/jukebox/push-to-client', (req, res) => {
    const schema = Joi.object({
      code:    Joi.string().required(),
      command: Joi.string().required(),
      file:    Joi.string().optional()
    });
    joiValidate(schema, req.body);

    const claims = req.token ? jwt.decode(req.token) : null;
    if (claims?.scope === 'jukebox' && claims.code !== req.body.code) {
      throw new WebError('Forbidden', 403);
    }

    if (!clients.has(req.body.code)) {
      throw new WebError('Code Not Found', 404);
    }

    if (!allowedCommands.has(req.body.command)) {
      throw new WebError('Command Not Recognized', 400);
    }

    // Push command to client
    clients.get(req.body.code).send(JSON.stringify({ command: req.body.command, file: req.body.file ? req.body.file : '' }));

    res.json({});
  });
}

// This part is run before the login middleware
export function setupBeforeAuth(velvet) {
  // Player → server: cache the current playlist (no auth, code-validated)
  velvet.post('/api/v1/jukebox/update-playlist', (req, res) => {
    const schema = Joi.object({
      code:   Joi.string().required(),
      tracks: Joi.array().required(),
      idx:    Joi.number().integer().min(0).required(),
    });
    joiValidate(schema, req.body);
    if (!clients.has(req.body.code)) { return res.status(404).json({ error: 'Code Not Found' }); }
    playlistCache.set(req.body.code, { tracks: req.body.tracks, idx: req.body.idx, ts: Date.now() });
    res.json({});
  });

  // Player → server: cache now-playing state (no auth, code-validated)
  velvet.post('/api/v1/jukebox/update-now-playing', (req, res) => {
    const schema = Joi.object({
      code:       Joi.string().required(),
      nowPlaying: Joi.object().required(),
    });
    joiValidate(schema, req.body);
    if (!clients.has(req.body.code)) { return res.status(404).json({ error: 'Code Not Found' }); }
    nowPlayingCache.set(req.body.code, { ...req.body.nowPlaying, ts: Date.now() });
    res.json({});
  });

  // Remote → server: read cached playlist
  velvet.get('/api/v1/jukebox/get-playlist', (req, res) => {
    const code = req.query.code;
    if (!clients.has(code)) { return res.json({ tracks: [], idx: 0 }); }
    res.json(playlistCache.get(code) || { tracks: [], idx: 0 });
  });

  // Remote → server: read cached now-playing
  velvet.get('/api/v1/jukebox/get-now-playing', (req, res) => {
    const code = req.query.code;
    if (!clients.has(code)) { return res.json(null); }
    res.json(nowPlayingCache.get(code) || null);
  });

  velvet.post('/api/v1/jukebox/does-code-exist', (req, res) => {
    const clientCode = req.body.code;
    if (!clients.has(clientCode) || !codeTokenMap.has(clientCode)) {
      return res.json({ status: false });
    }
    res.json({ status: true, token: codeTokenMap.get(clientCode) });
  });

  velvet.get('/remote/:remoteId', async (req, res) => {
    const clientCode = req.params.remoteId;
    const invalid = !clients.has(clientCode) || !codeTokenMap.has(clientCode);

    const data = invalid
      ? { error: true }
      : { code: clientCode, error: false, token: codeTokenMap.get(clientCode) };
    const page = await fs.readFile(path.join(config.program.webAppDirectory, 'remote/index.html'), 'utf-8');
    const dataJson = JSON.stringify(data).replace(/</g, '\\u003c');
    const sharePage = page.replace(
      '<script type="application/json" id="remote-data"></script>',
      `<script type="application/json" id="remote-data">${dataJson}</script>`
    );
    res.send(sharePage);
  });
}
