import jwt from 'jsonwebtoken';
import Joi from 'joi';
import winston from 'winston';
import * as auth from '../util/auth.js';
import * as adminUtil from '../util/admin.js';
import * as config from '../state/config.js';
import { expandDbVpaths } from '../util/vpath.js';
import * as shared from '../api/shared.js';
import WebError from '../util/web-error.js';
import { resolveExtAuthUser } from '../util/ext-auth.js';

// `tv` mirrors the user's tokenVersion; tokens without it count as version 0, so
// logins from before this claim existed keep working until the version is bumped.
export function signUserToken(username, claims = {}, options = {}) {
  const tv = config.program.users[username]?.tokenVersion;
  return jwt.sign({ username, ...claims, ...(tv ? { tv } : {}) }, config.program.secret, options);
}

export function isTokenCurrent(decoded) {
  const user = config.program.users[decoded.username];
  return !!user && (decoded.tv || 0) === (user.tokenVersion || 0);
}

export function setTokenCookie(req, res, token) {
  res.cookie('x-access-token', token, {
    maxAge: 30 * 24 * 60 * 60 * 1000,
    sameSite: 'Strict',
    // Not httpOnly: the client reads this cookie to repopulate its token when a
    // reverse proxy strips the x-access-token header.
    secure: req.secure || req.headers['x-forwarded-proto'] === 'https',
  });
}

export function setup(velvet) {
  velvet.post('/api/v1/auth/login', async (req, res) => {
    try {
      const schema = Joi.object({
        username: Joi.string().required(),
        password: Joi.string().required()
      });
      await schema.validateAsync(req.body);

      const user = config.program.users[req.body.username];
      if (!user) { throw new Error('user not found'); }

      await auth.authenticateUser(user.password, user.salt, req.body.password);
      if (auth.needsRehash(user.salt)) await _upgradePasswordHash(req.body.username, req.body.password);

      const token = signUserToken(req.body.username);
      setTokenCookie(req, res, token);

      res.json({
        vpaths: user.vpaths,
        token: token
      });
    } catch (err) {
      winston.warn(`Failed login attempt from ${req.ip}. Username: ${req.body.username}`, { stack: err });
      setTimeout(() => { res.status(401).json({ error: 'Login Failed' }); }, 800);
    }
  });

  velvet.use(async (req, res, next) => {
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

    let token = _findToken(req);
    if (!token) {
      const extAuthUsername = await resolveExtAuthUser(req);
      if (extAuthUsername) {
        token = signUserToken(extAuthUsername);
        setTokenCookie(req, res, token);
      }
    }
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

    if (decoded.scope && !_scopedTokenAllows(decoded, req)) {
      throw new WebError('Authentication Error', 401);
    }

    if (!decoded.username || !config.program.users[decoded.username]) {
      throw new WebError('Authentication Error', 401);
    }
    // Share links stay valid across a password change; everything else (scoped tokens too) is revoked.
    if (decoded.shareToken !== true && !isTokenCurrent(decoded)) {
      throw new WebError('Authentication Error', 401);
    }

    // A copy, so per-request fields never leak into config (and from there into the saved file).
    req.user = { ...config.program.users[decoded.username], username: decoded.username };
    delete req.user.dbVpaths;

    // Files are indexed under the ROOT vpath, so child-only users need the parent roots for DB
    // queries (dbVpaths); vpaths stays the strict list for access checks.
    const expanded = expandDbVpaths(req.user.vpaths, config.program.folders || {});
    if (expanded.length > (req.user.vpaths?.length ?? 0)) req.user.dbVpaths = expanded;

    // Handle Shared Tokens
    if (decoded.shareToken && decoded.shareToken === true) {
      _validateSharedTokenAccess(req, decoded);
      req.sharedPlaylistId = decoded.playlistId;
    }

    next();
  });

  // Self-service password change — any logged-in user can change their own
  // Velvet password by providing the current password for verification.
  velvet.post('/api/v1/auth/change-password', async (req, res) => {
    const schema = Joi.object({
      currentPassword: Joi.string().required(),
      newPassword:     Joi.string().min(1).required(),
    });
    const { error, value } = schema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });

    const username = req.user.username;
    const user = config.program.users[username];
    if (!user) return res.status(401).json({ error: 'User not found' });

    try {
      await auth.authenticateUser(user.password, user.salt, value.currentPassword);
    } catch {
      // Delay like login to slow brute-force
      return new Promise(resolve => setTimeout(() => {
        res.status(401).json({ error: 'Current password is incorrect' });
        resolve();
      }, 800));
    }

    await adminUtil.editUserPassword(username, value.newPassword);
    // The change revoked every older token, this session's included, so hand back a fresh one.
    const token = signUserToken(username);
    setTokenCookie(req, res, token);
    res.json({ token });
  });

  // Issue a fresh token from a valid session — call on every page load so
  // localStorage always holds a token signed by the current server secret.
  // Returns { token: null } for no-auth servers (no users configured).
  velvet.get('/api/v1/auth/refresh', (req, res) => {
    if (!req.user?.username || !config.program.users[req.user.username]) {
      return res.json({ token: null });
    }
    const newToken = signUserToken(req.user.username);
    setTokenCookie(req, res, newToken);
    res.json({ token: newToken });
  });
}

// The plain password is only at hand during a login, so that is where an old hash moves to the
// current iteration count. Same password, so the user's tokens stay valid. A failed write
// leaves the old hash in place and must not fail the login.
async function _upgradePasswordHash(username, password) {
  try {
    const { salt, hashPassword } = await auth.hashPassword(password);
    await config.updateUserFields(username, { password: hashPassword, salt });
  } catch (err) {
    winston.warn(`Could not upgrade the password hash of ${username}`, { stack: err });
  }
}

// Accept token from multiple sources; also support standard "Authorization: Bearer <token>"
// because some reverse proxies strip custom headers like x-access-token.
function _findToken(req) {
  const bearerToken = req.headers?.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.slice(7)
    : undefined;
  return req.body?.token || req.query?.token || req.headers?.['x-access-token'] || bearerToken || req.cookies?.['x-access-token'] || null;
}

// Sonos stream tokens open one file; jukebox tokens drive one remote session.
function _scopedTokenAllows(decoded, req) {
  if (decoded.scope === 'jukebox') return req.path === '/api/v1/jukebox/push-to-client' || req.path === '/api/v1/file-explorer';
  if (decoded.scope !== 'stream') return false;
  if (req.path === '/api/v1/sonos/transcode-stream') return req.query?.fp === decoded.fp;
  if (!req.path.startsWith('/media/')) return false;
  try {
    return req.path.slice(7).split('/').map(decodeURIComponent).join('/') === decoded.fp;
  } catch {
    return false;
  }
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
