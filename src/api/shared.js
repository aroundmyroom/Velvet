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
  if (!playlistItem) { throw new WebError('Playlist Not Found'); }

  // make sure the token is still good
  jwt.verify(playlistItem.token, config.program.secret);
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
      const matchEnd = req.path.match(/(\/)+$/g);
      const queryString = req.url.match(/(\?.*)/g) === null ? '' : req.url.match(/(\?.*)/g);
      // redirect to a more sane URL
      return res.redirect(301, req.path.slice(0, (matchEnd[0].length)*-1) + queryString[0]);
    }

    if (!req.params.playlistId) { throw new WebError('Validation Error', 403); }
    let sharePage;
    try {
      sharePage = await fs.readFile(path.join(config.program.webAppDirectory, 'shared/index.html'), 'utf-8');
    } catch {
      throw new WebError('Page not found', 404);
    }

    let sharedData;
    try {
      sharedData = lookupShared(req.params.playlistId);
    } catch (e) {
      // Link is expired or not found — serve a friendly HTML error page
      const isExpired = e instanceof Error && e.name === 'TokenExpiredError';
      const headline  = isExpired ? 'This link has expired' : 'Link not found';
      const detail    = isExpired
        ? 'The shared playlist link you followed is no longer valid.'
        : 'This shared playlist link does not exist or has been revoked.';
      const errorPage = sharePage.replace(
        '<script></script>',
        `<script>const sharedPlaylist = null</script>`
      ).replace(
        /<title>[^<]*<\/title>/,
        `<title>Velvet – ${headline}</title>`
      ).replace(
        /<body[^>]*>/,
        `$&<div style="position:fixed;inset:0;z-index:9999;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1.4rem;background:#0f0f1a;color:#f0f0ff;font-family:system-ui,sans-serif;padding:2rem;text-align:center;">` +
        `<svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>` +
        `<h1 style="margin:0;font-size:2rem;font-weight:700;color:#f0f0ff;">${headline}</h1>` +
        `<p style="margin:0;font-size:1.1rem;color:#b0b0d0;max-width:400px;line-height:1.6;">${detail}</p>` +
        `</div>`
      );
      return res.status(isExpired ? 410 : 404).send(errorPage);
    }

    sharePage = sharePage.replace(
      '<script></script>',
      `<script>const sharedPlaylist = ${JSON.stringify(sharedData)}</script>`
    );
    res.send(sharePage);
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
    db.saveShareDB();
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
    db.saveShareDB();
    res.json({ success: true });
  });
}
