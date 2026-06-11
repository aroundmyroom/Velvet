import url from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import Joi from 'joi';
import { nanoid } from 'nanoid';
import jwt from 'jsonwebtoken';
import { WebSocketServer } from 'ws';
import winston from 'winston';
import * as config from '../state/config.js';
import { joiValidate } from '../util/validation.js';
import WebError from '../util/web-error.js';

// list of currently connected clients (users)
const clients = {};
// Map code to JWT
const codeTokenMap = {};
// Map code to session start time (unix ms)
const codeStartTime = {};
const playlistCache = {};
const nowPlayingCache = {};
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

export function setupAfterAuth(velvet, server) {
  const wss = new WebSocketServer({ server: server, verifyClient: (info, cb) => {
    try {
      let decoded;
      if (config.program.users && Object.keys(config.program.users).length !== 0) {
        const token = url.parse(info.req.url, true).query.token;
        if (!token) { throw new Error('Token Not Found'); }
        decoded = jwt.verify(token, config.program.secret);
      }

      info.req.code = url.parse(info.req.url, true).query.code;
      if (info.req.code in clients) { throw new Error('Code In Use'); }

      info.req.jwt = jwt.sign({
        username: decoded?.username ?? 'velvet-user',
        jukebox: true
      }, config.program.secret);
      cb(true);
    } catch (err) {
      winston.error('WS Connection Failed', { stack: err });
      cb(false, 401, 'Unauthorized');
    }
  }});

  wss.on('connection', (connection, req) => {
    const code = nanoid(8);
    winston.info(`Websocket Connection Accepted With Code: ${code}`);
    clients[code] = connection;
    codeStartTime[code] = Date.now();

    if (req.jwt) { codeTokenMap[code] = req.jwt; }

    connection.send(JSON.stringify({ code: code, token: req.jwt ? req.jwt : false }));

    // user sent message
    connection.on('message', (_message) => {
      connection.send(JSON.stringify({ code: code }));
    });

    connection.on('close', (_connection) => {
      delete clients[code];
      if (codeTokenMap[code])  { delete codeTokenMap[code]; }
      if (codeStartTime[code]) { delete codeStartTime[code]; }
      delete playlistCache[code];
      delete nowPlayingCache[code];
    });
  });

  // GET /api/v1/jukebox/sessions — admin-only list of all active jukebox sessions
  velvet.get('/api/v1/jukebox/sessions', (req, res) => {
    if (config.program.lockAdmin === true) { return res.status(405).json({ error: 'Admin API Disabled' }); }
    if (req.user.admin !== true)           { return res.status(403).json({ error: 'Forbidden' }); }

    const sessions = Object.keys(clients).map(code => ({
      code,
      token:     codeTokenMap[code]  || null,
      startTime: codeStartTime[code] || null,
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

    if (!(req.body.code in clients)) {
      throw new WebError('Code Not Found', 404);
    }

    if (!allowedCommands.has(req.body.command)) {
      throw new WebError('Command Not Recognized', 400);
    }

    // Push command to client
    clients[req.body.code].send(JSON.stringify({ command: req.body.command, file: req.body.file ? req.body.file : '' }));

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
    if (!(req.body.code in clients)) { return res.status(404).json({ error: 'Code Not Found' }); }
    playlistCache[req.body.code] = { tracks: req.body.tracks, idx: req.body.idx, ts: Date.now() };
    res.json({});
  });

  // Player → server: cache now-playing state (no auth, code-validated)
  velvet.post('/api/v1/jukebox/update-now-playing', (req, res) => {
    const schema = Joi.object({
      code:       Joi.string().required(),
      nowPlaying: Joi.object().required(),
    });
    joiValidate(schema, req.body);
    if (!(req.body.code in clients)) { return res.status(404).json({ error: 'Code Not Found' }); }
    nowPlayingCache[req.body.code] = { ...req.body.nowPlaying, ts: Date.now() };
    res.json({});
  });

  // Remote → server: read cached playlist
  velvet.get('/api/v1/jukebox/get-playlist', (req, res) => {
    const code = req.query.code;
    if (!code || !(code in clients)) { return res.json({ tracks: [], idx: 0 }); }
    res.json(playlistCache[code] || { tracks: [], idx: 0 });
  });

  // Remote → server: read cached now-playing
  velvet.get('/api/v1/jukebox/get-now-playing', (req, res) => {
    const code = req.query.code;
    if (!code || !(code in clients)) { return res.json(null); }
    res.json(nowPlayingCache[code] || null);
  });

  velvet.post('/api/v1/jukebox/does-code-exist', (req, res) => {
    const clientCode = req.body.code;
    if (!(clientCode in clients) || !(clientCode in codeTokenMap)) {
      return res.json({ status: false });
    }
    res.json({ status: true, token: codeTokenMap[clientCode] });
  });

  velvet.get('/remote/:remoteId', async (req, res) => {
    const clientCode = req.params.remoteId;
    const invalid = !(clientCode in clients) || !(clientCode in codeTokenMap);

    let sharePage = await fs.readFile(path.join(config.program.webAppDirectory, 'remote/index.html'), 'utf-8');
    sharePage = sharePage.replaceAll('../', '../../');
    sharePage = sharePage.replace(
      '<script></script>',
      `<script>var remoteProperties = ${JSON.stringify(invalid
        ? { error: true }
        : { code: clientCode, error: false, token: codeTokenMap[clientCode] })}</script>`
    );
    res.send(sharePage);
  });
}
