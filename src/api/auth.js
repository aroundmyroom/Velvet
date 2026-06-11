import jwt from 'jsonwebtoken';
import Joi from 'joi';
import winston from 'winston';
import * as auth from '../util/auth.js';
import * as config from '../state/config.js';
import * as shared from '../api/shared.js';
import WebError from '../util/web-error.js';

export function setup(velvet) {
  velvet.post('/api/v1/auth/login', async (req, res) => {
    try {
      const schema = Joi.object({
        username: Joi.string().required(),
        password: Joi.string().required()
      });
      await schema.validateAsync(req.body);

      if (!config.program.users[req.body.username]) { throw new Error('user not found'); }

      await auth.authenticateUser(config.program.users[req.body.username].password, config.program.users[req.body.username].salt, req.body.password)

      const token = jwt.sign({ username: req.body.username }, config.program.secret);

      res.cookie('x-access-token', token, {
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days in ms
        sameSite: 'Strict',
        // NOTE: must NOT be httpOnly — the client JS needs to read this cookie
        // to repopulate S.token when a reverse proxy strips the x-access-token
        // request header. The token is also stored in localStorage, so httpOnly
        // would provide no additional XSS protection here.
        secure: req.secure || req.headers['x-forwarded-proto'] === 'https',
      });

      res.json({
        vpaths: config.program.users[req.body.username].vpaths,
        token: token
      });
    } catch (err) {
      winston.warn(`Failed login attempt from ${req.ip}. Username: ${req.body.username}`, { stack: err });
      setTimeout(() => { res.status(401).json({ error: 'Login Failed' }); }, 800);
    }
  });

  velvet.use((req, res, next) => {
    // Album art files are served to LAN devices (Sonos, DLNA) without auth.
    // The filenames are MD5 hashes — not guessable, no sensitive content.
    if (req.path.startsWith('/album-art/')) {
      req.user = { vpaths: Object.keys(config.program.folders), username: 'album-art-public', admin: false };
      return next();
    }

    // Handle No Users
    if (Object.keys(config.program.users).length === 0
      && !req.path.startsWith('/api/v1/scanner/')
    ) {
      req.user = {
        vpaths: Object.keys(config.program.folders),
        username: 'velvet-user',
        // lockAdmin=true means the owner wants the admin API locked down — honour
        // that even in public/no-user mode where we'd otherwise grant admin:true.
        admin: config.program.lockAdmin !== true
      };

      return next();
    }

    const token = _findToken(req);
    if (!token) { throw new WebError('Authentication Error', 401); }
    req.token = token;

    let decoded;
    try {
      decoded = jwt.verify(token, config.program.secret);
    } catch {
      // TokenExpiredError, JsonWebTokenError, NotBeforeError — all are auth failures.
      // Return 401 so the client can detect and clear the stale token.
      throw new WebError('Authentication Error', 401);
    }

    if (decoded.scan === true && req.path.startsWith('/api/v1/scanner/')) {
      req.scanApproved = true;
      return next();
    }

    // handle federation invite tokens
    if (decoded.invite && decoded.invite === true) {
      // Invite tokens can only be used with one API path
      if (req.path === '/federation/invite/exchange') { return next(); }
      throw new WebError('Authentication Error', 401);
    }

    if (!decoded.username || !config.program.users[decoded.username]) {
      throw new WebError('Authentication Error', 401);
    }

    req.user = config.program.users[decoded.username];
    req.user.username = decoded.username;

    // Handle Shared Tokens
    if (decoded.shareToken && decoded.shareToken === true) {
      _validateSharedTokenAccess(req, decoded);
      req.sharedPlaylistId = decoded.playlistId;
    }

    next();
  });

  // Issue a fresh token from a valid session — call on every page load so
  // localStorage always holds a token signed by the current server secret.
  // Returns { token: null } for no-auth servers (no users configured).
  velvet.get('/api/v1/auth/refresh', (req, res) => {
    if (!req.user?.username || !config.program.users[req.user.username]) {
      return res.json({ token: null });
    }
    const newToken = jwt.sign({ username: req.user.username }, config.program.secret);
    res.cookie('x-access-token', newToken, {
      maxAge: 30 * 24 * 60 * 60 * 1000,
      sameSite: 'Strict',
      secure: req.secure || req.headers['x-forwarded-proto'] === 'https',
    });
    res.json({ token: newToken });
  });
}

// Accept token from multiple sources; also support standard "Authorization: Bearer <token>"
// because some reverse proxies strip custom headers like x-access-token.
function _findToken(req) {
  const bearerToken = req.headers?.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.slice(7)
    : undefined;
  return req.body?.token || req.query?.token || req.headers?.['x-access-token'] || bearerToken || req.cookies?.['x-access-token'] || null;
}

function _validateSharedTokenAccess(req, decoded) {
  const playlistItem = shared.lookupPlaylist(decoded.playlistId);
  const mediaPath = decodeURIComponent(req.path).slice(7);
  const mediaPathNorm = mediaPath.replace(/^\/+/, '');
  const isAllowedPath =
    req.path === '/api/v1/download/shared' ||
    req.path === '/api/v1/db/metadata' ||
    req.path.startsWith('/album-art/') ||
    playlistItem.playlist.includes(mediaPath) ||
    playlistItem.playlist.includes(mediaPathNorm) ||
    playlistItem.playlist.includes('/' + mediaPathNorm);
  if (!isAllowedPath) { throw new WebError('Authentication Error', 401); }
}
