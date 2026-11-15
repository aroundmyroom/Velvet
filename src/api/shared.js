import { nanoid } from 'nanoid';
import jwt from 'jsonwebtoken';
import path from 'node:path';
import fs from 'node:fs/promises';
import Joi from 'joi';
import * as config from '../state/config.js';
import * as db from '../db/manager.js';
import { joiValidate } from '../util/validation.js';
import WebError from '../util/web-error.js';

function lookupShared(playlistId) {
  const playlistItem = db.findSharedPlaylist(playlistId);
  if (!playlistItem) { throw new WebError('Playlist Not Found', 404); }

  try {
    jwt.verify(playlistItem.token, config.program.secret);
  } catch (err) {
    if (err.name === 'TokenExpiredError') throw new WebError('Share Link Expired', 410);
    throw new WebError('Invalid Share Link', 401);
  }
  return {
    token: playlistItem.token,
    playlist: playlistItem.playlist
  };
}

export function lookupPlaylist(playlistId) {
  return lookupShared(playlistId);
}

export function setupBeforeSecurity(velvet) {
  velvet.get('/shared/:playlistId', async (req, res) => {
    // don't end this with a slash. otherwise relative URLs don't work
    if (req.path.endsWith('/')) {
      const q = req.url.indexOf('?');
      return res.redirect(301, `/shared/${encodeURIComponent(req.params.playlistId)}${q === -1 ? '' : req.url.slice(q)}`);
    }

    if (!req.params.playlistId) { throw new WebError('Validation Error', 403); }
    let sharePage;
    try {
      sharePage = await fs.readFile(path.join(config.program.webAppDirectory, 'shared/index.html'), 'utf-8');
    } catch {
      throw new WebError('Page not found', 404);
    }

    // An expired or unknown link gets the same page with { error }; shared/app.js shows
    // the message in the visitor's language.
    let sharedData;
    let status = 200;
    try {
      sharedData = lookupShared(req.params.playlistId);
    } catch (e) {
      status = e?.status === 410 ? 410 : 404;
      sharedData = { error: status === 410 ? 'expired' : 'not-found' };
    }

    // Inject the data into a non-executable JSON data block (read by shared/app.js).
    // Escaping '<' prevents a "</script>" breakout and keeps the page free of inline
    // executable scripts, so it works under script-src 'self'.
    const dataJson = JSON.stringify(sharedData).replace(/</g, '\\u003c');
    sharePage = sharePage.replace(
      '<script type="application/json" id="sh-data"></script>',
      `<script type="application/json" id="sh-data">${dataJson}</script>`
    );
    res.status(status).send(sharePage);
  });

  velvet.get('/api/v1/shared/:playlistId', (req, res) => {
    if (!req.params.playlistId) { throw new WebError('Validation Error', 403); }
    res.json(lookupShared(req.params.playlistId));
  });
}

export function setupAfterSecurity(velvet) {
  velvet.post('/api/v1/share', (req, res) => {
    const schema = Joi.object({
      playlist: Joi.array().items(Joi.string()).required(),
      time: Joi.number().integer().positive().optional()
    });
    joiValidate(schema, req.body);

    // Setup Token Data
    const playlistId = nanoid(10);

    const tokenData = {
      playlistId: playlistId,
      shareToken: true,
      username: req.user.username
    };

    const jwtOptions = {};
    if (req.body.time) { jwtOptions.expiresIn = `${req.body.time}d`; }
    const token = jwt.sign(tokenData, config.program.secret, jwtOptions)

    const sharedItem = {
      playlistId: playlistId,
      playlist: req.body.playlist,
      user: req.user.username,
      expires: req.body.time ? jwt.verify(token, config.program.secret).exp : null,
      token: token
    };

    db.insertSharedPlaylist(sharedItem);
    res.json(sharedItem);
  });

  velvet.get('/api/v1/share/list', (req, res) => {
    const all = db.getAllSharedPlaylists() || [];
    const userItems = all.filter(p => p.user === req.user.username).map(p => ({
      playlistId: p.playlistId,
      songCount: (p.playlist || []).length,
      expires: p.expires || null
    }));
    res.json(userItems);
  });

  velvet.delete('/api/v1/share/:playlistId', (req, res) => {
    if (!req.params.playlistId) { throw new WebError('Validation Error', 403); }
    const all = db.getAllSharedPlaylists() || [];
    const item = all.find(p => p.playlistId === req.params.playlistId);
    if (!item) { throw new WebError('Not Found', 404); }
    if (item.user !== req.user.username) { throw new WebError('Forbidden', 403); }
    db.removeSharedPlaylistById(req.params.playlistId);
    res.json({ success: true });
  });
}
