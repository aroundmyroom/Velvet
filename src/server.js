import winston from 'winston';
import express from 'express';
import compression from 'compression';
import helmet from 'helmet';
import fs from 'node:fs';
import path from 'node:path';
import Joi from 'joi';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import http from 'node:http';
import https from 'node:https';
import { createRequire } from 'node:module';

import * as dbApi from './api/db.js';
import * as playlistApi from './api/playlist.js';
import * as authApi from './api/auth.js';
import * as fileExplorerApi from './api/file-explorer.js';
import * as downloadApi from './api/download.js';
import * as adminApi from './api/admin.js';
import * as remoteApi from './api/remote.js';
import * as sharedApi from './api/shared.js';
import * as scrobblerApi from './api/scrobbler.js';
import * as discordWebhookApi from './api/discord-webhook.js';
import * as customWebhooksApi from './api/custom-webhooks.js';
import * as discogsApi from './api/discogs.js';
import * as waveformApi from './api/waveform.js';
import * as config from './state/config.js';
import * as logger from './logger.js';
import * as transcode from './api/transcode.js';
import * as dbManager from './db/manager.js';
import * as dbQueue from './db/task-queue.js';
import * as syncthing from './state/syncthing.js';
import * as federationApi from './api/federation.js';
import * as scannerApi from './api/scanner.js';
import * as subsonicApi from './api/subsonic.js';
import * as userSettingsApi from './api/user-settings.js';
import * as lyricsApi from './api/lyrics.js';
import * as radioApi from './api/radio.js';
import * as radioRecorderApi from './api/radio-recorder.js';
import * as radioSchedulerApi from './api/radio-scheduler.js';
import * as backupApi from './api/backup.js';
import * as migrateApi from './api/migrate.js';
import * as telemetryApi from './api/telemetry.js';
import * as podcastApi from './api/podcasts.js';
import * as smartPlaylistApi from './api/smart-playlists.js';
import * as ytdlApi from './api/ytdl.js';
import * as albumsBrowseApi from './api/albums-browse.js';
import * as artistsBrowseApi from './api/artists-browse.js';
import * as wrappedApi from './api/wrapped.js';
import * as serverPlaybackApi from './api/server-playback.js';
import * as acoustidApi from './api/acoustid.js';
import * as tagWorkshopApi from './api/tagworkshop.js';
import * as rgAnalysisApi from './api/rg-analysis.js';
import * as albumArtWorkshopApi from './api/album-art-workshop.js';
import * as bpmAnalysisApi from './api/bpm-analysis.js';
import * as genreEnricherApi from './api/genre-enricher.js';
import * as dupWorkshopApi from './api/duplicate-workshop.js';
import * as dlnaApi from './api/dlna.js';
import * as sonosApi from './api/sonos.js';
import * as smartPlaylistMlApi from './smartplaylist/routes.js';
import WebError from './util/web-error.js';
import { sanitizeFilename } from './util/validation.js';
import { ensureFfmpeg } from './util/ffmpeg-bootstrap.js';
import { canAccessMediaVpath } from './util/media-access.js';
import { resolvePathWithinRoot } from './util/path-security.js';

const require = createRequire(import.meta.url);
const packageJson = require('../package.json');

let velvet;
let server;

// ── Module-scope helpers ─────────────────────────────────────────────────────
// Phone detection: a "phone" is a small handheld with a mobile-class user agent.
// Tablets (iPad, large Android tablets) get the regular desktop UI at `/`.
function isPhoneUA(req) {
  const ua = String(req.headers['user-agent'] || '');
  if (!ua) return false;
  // Explicit tablet exclusions first
  if (/\biPad\b/i.test(ua)) return false;
  // Android tablets do NOT have "Mobile" in their UA string
  if (/\bAndroid\b/i.test(ua) && !/\bMobile\b/i.test(ua)) return false;
  if (/\b(Tablet|Tab|Kindle|Silk|PlayBook|Nexus 7|Nexus 9|Nexus 10|SM-T)\b/i.test(ua)) return false;
  // Now match real phones
  return /iPhone|iPod|Android.*Mobile|Windows Phone|IEMobile|BlackBerry|BB10|webOS|Opera Mini|Opera Mobi|Mobile Safari/i.test(ua);
}

/** Parse a syncsafe-integer ID3v2 header and return the number of bytes to skip. */
function flacId3Skip(buf) {
  if (buf.length < 10 || buf.slice(0, 3).toString('ascii') !== 'ID3') return 0;
  const hasFooter = (buf[5] & 0x10) !== 0;
  const tagSize = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) |
                  ((buf[8] & 0x7f) << 7)  |  (buf[9] & 0x7f);
  return 10 + tagSize + (hasFooter ? 10 : 0);
}

export async function serveIt(configFile) {
  velvet = express();

  try {
    await config.setup(configFile);
  } catch (err) {
    winston.error('Failed to validate config file', { stack: err });
    process.exit(1);
  }

  // Logging
  if (config.program.writeLogs) {
    logger.addFileLogger(config.program.storage.logsDirectory, config.program.logRetention);
  }

  // Stamp the package.json version into every webapp cache-buster / version
  // string so a release only ever edits package.json.
  try {
    const { syncWebappVersion } = require('../scripts/sync-webapp-version.cjs');
    const { changed } = syncWebappVersion();
    if (changed) winston.info(`[version] synced webapp to v${packageJson.version} (${changed} file(s))`);
  } catch (e) { winston.warn('[version] webapp version sync skipped: ' + (e?.message || e)); }

  // Set server
  _createHttpServer();

  // Setup middleware, static files and admin auth
  _setupExpressMiddleware(velvet);

  // Setup DB
  await dbManager.initDB();

  // ── Phone detection ──────────────────────────────────────────────────────
  // A "phone" is a small handheld with a mobile-class user agent. Tablets
  // (iPad, large Android tablets) get the regular desktop UI at `/` — only
  // narrow phones see the dedicated PWA.

  // Main UI — served with the cache-buster version injected from package.json.
  // This ensures the browser always loads a fresh app.js whenever the server
  // version changes, regardless of what the static file on disk contains.
  //
  // Phones (narrow handheld user-agents) get the dedicated PWA at /mobile/
  // served from the root URL instead. Tablets and desktops keep the regular UI.
  let _indexHtmlCache = null;
  let _mobileIndexCache = null;
  // Parse a single cookie value without depending on the cookie-parser
  // middleware (which is mounted later in the stack).
  const _readCookie = (req, name) => {
    const h = req.headers.cookie;
    if (!h) return null;
    for (const part of h.split(';')) {
      const eq = part.indexOf('=');
      if (eq < 0) continue;
      if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
    }
    return null;
  };
  velvet.get('/', (req, res) => {
    // Explicit override via ?ui=desktop|mobile — set a sticky cookie so future
    // hard refreshes honour the choice regardless of User-Agent. This is the
    // escape hatch for desktop users whose UA gets spoofed by DevTools' device
    // toolbar and for phone users who prefer the desktop UI.
    const uiQ = req.query?.ui;
    if (uiQ === 'desktop' || uiQ === 'mobile') {
      res.setHeader('Set-Cookie', `ms2_ui=${uiQ}; Path=/; Max-Age=31536000; SameSite=Lax`);
    }
    const uiPref = (uiQ === 'desktop' || uiQ === 'mobile') ? uiQ : _readCookie(req, 'ms2_ui');
    const serveMobile = uiPref === 'mobile' || (uiPref !== 'desktop' && isPhoneUA(req));
    if (serveMobile) {
      if (!_mobileIndexCache) {
        _mobileIndexCache = fs.readFileSync(path.join(config.program.webAppDirectory, 'mobile', 'index.html'), 'utf-8');
      }
      return res.type('text/html').send(_mobileIndexCache);
    }
    if (!_indexHtmlCache) {
      const raw = fs.readFileSync(path.join(config.program.webAppDirectory, 'index.html'), 'utf-8');
      _indexHtmlCache = raw.replace(/app\.js\?v=[^"']+/, `app.js?v=${packageJson.version}`);
    }
    res.type('text/html').send(_indexHtmlCache);
  });

  // Classic UI has been removed. /classic returns 410 Gone.
  velvet.get('/classic', (_req, res) => res.status(410).send('<p>Classic UI has been removed.</p>'));
  velvet.get('/login', (_req, res) => res.redirect(301, '/'));
  velvet.get('/login/', (_req, res) => res.redirect(301, '/'));
  velvet.get('/login/index.html', (_req, res) => res.redirect(301, '/'));

  // ── Phone-only PWA at root ────────────────────────────────────────────────
  // The root `/` handler above already serves the PWA HTML to phones.
  // These additional routes provide the root-scoped manifest and service
  // worker so the PWA is installable from `/` on phones.

  // Phone-rooted manifest (scope = "/", start_url = "/") so the PWA can be
  // installed from the root URL. Phones-only — non-phones get a 404 here.
  velvet.get('/manifest.json', (req, res, next) => {
    if (!isPhoneUA(req)) return next();
    res.type('application/manifest+json').json({
      name: 'Velvet',
      short_name: 'Velvet',
      description: 'Your personal music player',
      display: 'standalone',
      orientation: 'portrait-primary',
      start_url: '/',
      scope: '/',
      background_color: '#0D0D0D',
      theme_color: '#0D0D0D',
      categories: ['music'],
      icons: [
        { src: '/mobile/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/mobile/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    });
  });

  // Root-scoped service worker for phones — proxies the mobile SW file.
  // Must be served from `/` so it can claim the root scope.
  velvet.get('/sw.js', (req, res, next) => {
    if (!isPhoneUA(req)) return next();
    res.type('application/javascript');
    res.setHeader('Service-Worker-Allowed', '/');
    res.sendFile(path.join(config.program.webAppDirectory, 'mobile', 'sw.js'));
  });

  // Mount admin panel (webapp/admin/) at /admin — must be before general static
  velvet.use('/admin', express.static(path.join(config.program.webAppDirectory, 'admin')));

  // Give access to public folder
  velvet.use('/', express.static(config.program.webAppDirectory));

  // Serve browser-standard paths without auth
  velvet.get('/favicon.ico', (_req, res) => res.redirect(301, '/assets/fav/favicon.ico'));
  velvet.get('/robots.txt', (_req, res) => {
    res.type('text/plain').send('User-agent: *\nDisallow: /\n');
  });
  const manifestFile = path.join(config.program.webAppDirectory, 'assets/fav/site.webmanifest');
  velvet.get('/assets/fav/site.webmanifest', (_req, res) => res.sendFile(manifestFile));

  // Public APIs
  remoteApi.setupBeforeAuth(velvet, server);
  serverPlaybackApi.setupBeforeAuth(velvet);
  sharedApi.setupBeforeSecurity(velvet);

  // Subsonic REST API — has its own auth, must be before authApi.setup()
  subsonicApi.setup(velvet);

  // Public lightweight ping — reachability check without credentials.
  // Also returns instanceId so the client can detect server identity changes
  // and wipe stale localStorage from a previous instance.
  // `hasUsers` lets the client tell a no-auth server from an auth-required one
  // WITHOUT probing a protected endpoint (which would log a noisy 401 on the
  // login page or behind a reverse proxy).
  velvet.get('/api/v1/ping/public', (_req, res) => res.json({
    status: 'ok',
    instanceId: config.program.instanceId,
    hasUsers: Object.keys(config.program.users || {}).length > 0,
  }));

  // Public — returns enabled languages so the player picker only shows active ones
  const _ALL_LANG_CODES = ['en','nl','de','fr','es','it','pt','pl','ru','zh','ja','ko'];
  velvet.get('/api/v1/languages/enabled', (_req, res) => {
    res.json({ enabled: config.program.languages?.enabled || _ALL_LANG_CODES });
  });

  // Public — artist placeholder image (no auth: used in <img src> throughout the player)
  const _ARTIST_PLACEHOLDER_FILE    = path.join(process.cwd(), 'save', 'conf', 'artist-placeholder.jpg');
  const _ARTIST_PLACEHOLDER_FILE_OLD = path.join(process.cwd(), 'image-cache', 'artist-placeholder.jpg');
  const _ARTIST_PLACEHOLDER_DEFAULT = path.join(config.program.webAppDirectory, 'assets', 'img', 'unknownartist.webp');
  // One-time migration: move placeholder from old image-cache/ location to save/conf/
  if (!fs.existsSync(_ARTIST_PLACEHOLDER_FILE) && fs.existsSync(_ARTIST_PLACEHOLDER_FILE_OLD)) {
    try {
      fs.renameSync(_ARTIST_PLACEHOLDER_FILE_OLD, _ARTIST_PLACEHOLDER_FILE);
      winston.info('Migrated artist-placeholder.jpg from image-cache/ to save/conf/');
    } catch (e) { console.debug('[velvet]', e?.message ?? e); }
  }
  velvet.get('/api/v1/artists/placeholder', (_req, res) => {
    if (fs.existsSync(_ARTIST_PLACEHOLDER_FILE)) {
      return res.sendFile(_ARTIST_PLACEHOLDER_FILE);
    }
    res.sendFile(_ARTIST_PLACEHOLDER_DEFAULT);
  });

  // Everything below this line requires authentication
  authApi.setup(velvet);

  scannerApi.setup(velvet);
  adminApi.setup(velvet);
  dbApi.setup(velvet);
  playlistApi.setup(velvet);
  downloadApi.setup(velvet);
  fileExplorerApi.setup(velvet);
  transcode.setup(velvet);
  scrobblerApi.setup(velvet);
  scrobblerApi.setupListenBrainz(velvet);
  discordWebhookApi.setup(velvet);
  customWebhooksApi.setup(velvet);
  discogsApi.setup(velvet);
  waveformApi.setup(velvet);
  userSettingsApi.setup(velvet);
  lyricsApi.setup(velvet);
  radioApi.setup(velvet);
  radioRecorderApi.setup(velvet);
  radioSchedulerApi.setup(velvet);
  backupApi.setup(velvet);
  migrateApi.setup(velvet);
  telemetryApi.setup(packageJson.version);
  podcastApi.setup(velvet);
  smartPlaylistApi.setup(velvet);
  ytdlApi.setup(velvet);
  albumsBrowseApi.setup(velvet);
  artistsBrowseApi.setup(velvet);
  wrappedApi.setup(velvet);
  serverPlaybackApi.setup(velvet);
  acoustidApi.setup(velvet);
  tagWorkshopApi.setup(velvet);
  rgAnalysisApi.setup(velvet);
  albumArtWorkshopApi.setup(velvet);
  bpmAnalysisApi.setup(velvet);
  genreEnricherApi.setup(velvet);
  dupWorkshopApi.setup(velvet);
  dlnaApi.setup(velvet);
  sonosApi.setup(velvet);
  smartPlaylistMlApi.setup(velvet);
  // Kick off ffmpeg auto-download early so it's ready for radio-recorder,
  // discogs cover-art and ytdl use — non-blocking, safe to ignore errors here.
  ensureFfmpeg().catch(e => winston.warn('[ffmpeg-bootstrap] startup prefetch failed: ' + e.message));
  import('./util/rsgain-bootstrap.js').then(m => m.ensureRsgain()).catch(e => winston.warn('[rsgain-bootstrap] startup prefetch failed: ' + e.message));
  remoteApi.setupAfterAuth(velvet, server);
  sharedApi.setupAfterSecurity(velvet);
  syncthing.setup();
  federationApi.setup(velvet);

  // Versioned APIs
  velvet.get('/api/', (req, res) => res.json({ "server": packageJson.version, "apiVersions": ["1"] }));

  // album art folder
  // Rule: NEVER return 404. If the file is in the DB but missing from disk
  // (cache cleared, partial scan, manual deletion) serve a neutral SVG placeholder
  // so the browser shows something consistent instead of a broken-image icon.
  const ALBUM_ART_FALLBACK_SVG = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1">' +
    '<rect width="1" height="1" fill="#1e1e2e"/>' +
    '<circle cx=".5" cy=".5" r=".28" fill="none" stroke="#45475a" stroke-width=".06"/>' +
    '<circle cx=".5" cy=".5" r=".08" fill="#45475a"/>' +
    '</svg>'
  );
  function sendArtFallback(res) {
    res.set('Content-Type', 'image/svg+xml');
    res.set('Cache-Control', 'no-store');
    res.end(ALBUM_ART_FALLBACK_SVG);
  }

  velvet.get('/album-art/:file', (req, res) => {
    if (!req.params.file) { return sendArtFallback(res); }

    const filename = sanitizeFilename(req.params.file);
    const albumArtRoot = config.program.storage.albumArtDirectory;
    const compress = typeof req.query.compress === 'string' && /^[a-z0-9_-]{1,16}$/i.test(req.query.compress)
      ? req.query.compress
      : '';

    const compressedFileName = `z${compress}-${filename}`;
    if (compress) {
      let compressedTarget;
      try {
        compressedTarget = resolvePathWithinRoot(albumArtRoot, compressedFileName);
      } catch {
        return sendArtFallback(res);
      }
      if (fs.existsSync(compressedTarget)) {
        return res.sendFile(path.basename(compressedTarget), { root: albumArtRoot });
      }
    }

    let fullPath;
    try {
      fullPath = resolvePathWithinRoot(albumArtRoot, filename);
    } catch {
      return sendArtFallback(res);
    }
    if (!fs.existsSync(fullPath)) { return sendArtFallback(res); }
    res.sendFile(path.basename(fullPath), { root: albumArtRoot }, err => {
      if (err && !res.headersSent) sendArtFallback(res);
    });
  });

  // Access control for raw media URLs: only serve files from vpaths
  // that the authenticated user can access. Return 404 for unknown or
  // unauthorized vpaths to avoid revealing library names.
  velvet.use('/media/', (req, res, next) => {
    if (!canAccessMediaVpath(req.path, req.user, config.program.folders)) {
      return res.status(404).end();
    }
    return next();
  });

  // ── FLAC ID3-preamble stripper ─────────────────────────────────
  // Some FLAC files (typically from iTunes / Picard) have an ID3v2 tag
  // prepended before the native fLaC marker.  ffprobe handles them fine,
  // but Chromium's built-in FFmpeg demuxer requires fLaC at byte 0 and
  // throws DEMUXER_ERROR_NO_SUPPORTED_STREAMS otherwise.
  //
  // This middleware intercepts any /media/…/*.flac request, detects the
  // ID3 preamble, and serves the file from the fLaC offset with correct
  // Content-Length / Content-Range so seeking still works.
  // Non-ID3 files are passed straight through to express.static below.

  velvet.use('/media/', async (req, res, next) => {
    if (!req.path.toLowerCase().endsWith('.flac')) return next();
    // Reconstruct the absolute file path from the vpath + relative path.
    const parts = req.path.split('/').filter(Boolean);
    if (parts.length < 2) return next();
    const vpath = decodeURIComponent(parts[0]);
    const folder = config.program.folders[vpath]?.root;
    if (!folder) return next();
    const relPath = parts.slice(1).map(p => decodeURIComponent(p)).join('/');
    let filePath;
    try {
      filePath = resolvePathWithinRoot(folder, relPath);
    } catch {
      return next();
    }

    try {
      // Read just the first 10 bytes to check for ID3 preamble.
      const fh = await fs.promises.open(filePath, 'r');
      const hdr = Buffer.alloc(10);
      await fh.read(hdr, 0, 10, 0);
      await fh.close();
      const skip = flacId3Skip(hdr);
      if (skip === 0) return next(); // clean fLaC file — let express.static handle it

      const stat = await fs.promises.stat(filePath);
      const effectiveSize = stat.size - skip;
      const rangeHeader = req.headers['range'];

      res.setHeader('Content-Type', 'audio/flac');
      res.setHeader('Accept-Ranges', 'bytes');

      if (rangeHeader) {
        const m = rangeHeader.match(/bytes=(\d*)-(\d*)/);
        if (!m) { res.status(416).end(); return; }
        const start = m[1] ? Number.parseInt(m[1], 10) : 0;
        const end   = m[2] ? Number.parseInt(m[2], 10) : effectiveSize - 1;
        if (start > effectiveSize - 1) {
          res.setHeader('Content-Range', `bytes */${effectiveSize}`);
          res.status(416).end(); return;
        }
        const clampedEnd = Math.min(end, effectiveSize - 1);
        res.setHeader('Content-Range', `bytes ${start}-${clampedEnd}/${effectiveSize}`);
        res.setHeader('Content-Length', clampedEnd - start + 1);
        res.status(206);
        fs.createReadStream(filePath, { start: skip + start, end: skip + clampedEnd }).pipe(res);
      } else {
        res.setHeader('Content-Length', effectiveSize);
        res.status(200);
        fs.createReadStream(filePath, { start: skip }).pipe(res);
      }
    } catch {
      next(); // file not found / unreadable → let express.static return 404
    }
  });

  // audio/flac is the IANA-registered MIME type; audio/x-flac (the mime package
  // default) is rejected by Chromium's FFmpeg demuxer → DEMUXER_ERROR_NO_SUPPORTED_STREAMS.
  const setMediaHeaders = (res, filePath) => {
    if (filePath.toLowerCase().endsWith('.flac')) res.setHeader('Content-Type', 'audio/flac');
  };

  const escapeMediaVpathRoute = value => value.replace(/[()[\]?+*!:]/g, '\\$&');

  Object.keys(config.program.folders).forEach(key => {
    // Express 5 route parser treats these characters as tokens unless escaped.
    // Escaping keeps legacy/imported folder names from crashing server boot.
    const routeVpath = escapeMediaVpathRoute(key);
    velvet.use(
      '/media/' + routeVpath + '/',
      express.static(config.program.folders[key].root, { setHeaders: setMediaHeaders })
    );
  });

  // error handling
  velvet.use((error, req, res, _next) => {
    // Honour .status from any HTTP-aware error (e.g. send module's
    // RangeNotSatisfiableError has status=416). Fall back to 500 only when
    // there is no explicit status.
    const status = (error.status && Number.isInteger(error.status))
      ? error.status
      : 500;

    if (status === 401 || status === 403) {
      // Auth failures on unknown paths are internet scanner noise — log at debug only.
      // Real Velvet routes all start with /api/, /rest/, /media/, /album-art/, /waveform/.
      const isApiPath = /^\/(api|rest|media|album-art|waveform)(\/|$)/i.test(req.originalUrl);
      if (isApiPath) {
        winston.warn(`Auth failure on route ${req.originalUrl} [${status}]`);
      } else {
        winston.debug(`Auth probe (ignored) on ${req.originalUrl} [${status}]`);
      }
    } else if (status === 416) {
      // Range Not Satisfiable — happens when the client cached a byte-offset
      // from before a file was rewritten. Not a server bug; log at debug level.
      winston.debug(`Range not satisfiable on ${req.originalUrl} [416] — client will retry from 0`);
    } else if (error.code === 'CLIENT_DISCONNECTED') {
      // Client navigated away before an async response (e.g. waveform pre-fetch) completed.
      // This is normal during playback transitions — log at debug only.
      winston.debug(`Client disconnected before response on ${req.originalUrl}`);
    } else {
      winston.error(`Server error on route ${req.originalUrl}: ${error.message}`, { stack: error });
    }

    // Check for validation error
    if (error instanceof Joi.ValidationError) {
      return res.status(403).json({ error: error.message });
    }

    if (error instanceof WebError) {
      return res.status(error.status).json({ error: error.message });
    }

    // For errors that carry their own HTTP status (send, multer, etc.) return
    // that status so the browser can handle it correctly.
    if (status !== 500) {
      return res.status(status).end();
    }

    res.status(500).json({ error: 'Server Error' });
  });

  // Start the server!
  server.on('request', velvet);
  server.listen(config.program.port, config.program.address, () => {
    const protocol = config.program.ssl?.cert && config.program.ssl?.key ? 'https' : 'http';
    winston.info(`Access Velvet locally: ${protocol}://localhost:${config.program.port}`);

    dbQueue.runAfterBoot();
    // Boot mpv if server audio is enabled in config
    serverPlaybackApi.startIfEnabled();
  });

  // Optional plain-HTTP listener for local devices (e.g. Sonos) that can't use HTTPS
  // Only started when running in HTTPS mode AND localHttpPort is configured.
  if (config.program.ssl?.cert && config.program.localHttpPort) {
    const localHttpServer = http.createServer();
    localHttpServer.on('request', velvet);
    localHttpServer.listen(config.program.localHttpPort, config.program.address, () => {
      winston.info(`Local HTTP port for LAN devices: http://localhost:${config.program.localHttpPort}`);
    });
  }
}

export function reboot() {
  try {
    winston.info('Rebooting Server');
    logger.reset();
    scrobblerApi.reset();
    transcode.reset();
    dbQueue.reset();

    if (config.program.federation.enabled === false) {
      syncthing.kill2();
    }

    // Close the server
    server.close(() => {
      serveIt(config.configFile);
    });
  } catch (err) {
    winston.error('Reboot Failed', { stack: err });
    process.exit(1);
  }
}

function _createHttpServer() {
  if (config.program.ssl?.cert && config.program.ssl?.key) {
    try {
      config.setIsHttps(true);
      server = https.createServer({
        key: fs.readFileSync(config.program.ssl.key),
        cert: fs.readFileSync(config.program.ssl.cert),
      });
    } catch (error) {
      winston.error('FAILED TO CREATE HTTPS SERVER');
      error.code = 'BAD CERTS';
      throw error;
    }
  } else {
    config.setIsHttps(false);
    server = http.createServer();
  }
}

function _setupExpressMiddleware(app) {
  const _withUnsafeEval = csp => String(csp || '').includes("'unsafe-eval'")
    ? String(csp || '')
    : String(csp || '').replace("script-src 'self'", "script-src 'self' 'unsafe-eval'");
  const _withAdminImageSources = csp => {
    const src = String(csp || '');
    if (!src) return src;
    if (!src.includes('img-src ')) return src;
    return src.replace(/img-src\s+([^;]+)/, (_m, val) => {
      const tokens = val.split(/\s+/).filter(Boolean);
      if (!tokens.includes('https:')) tokens.push('https:');
      if (!tokens.includes('blob:')) tokens.push('blob:');
      return `img-src ${tokens.join(' ')}`;
    });
  };

  const _cspDirectives = {
    ...helmet.contentSecurityPolicy.getDefaultDirectives(),
    'img-src': ["'self'", 'data:', 'https://flagcdn.com'],
    // The MPV cast heartbeat runs in a Worker created from a same-origin blob:
    // URL. Without an explicit worker-src, it falls back to script-src ('self')
    // and the blob worker is blocked by CSP.
    'worker-src': ["'self'", 'blob:'],
  };
  // Do not force upgrade-insecure-requests. Some deployments intentionally run
  // HTTP on custom LAN/domain ports (or terminate TLS upstream), and forcing
  // upgrades rewrites static asset URLs to https://, causing ERR_SSL_PROTOCOL_ERROR.
  delete _cspDirectives['upgrade-insecure-requests'];

  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: _cspDirectives,
    },
  }));

  // Subsonic clients like Feishin run in their own webview origins.
  // Helmet defaults can enforce same-origin isolation headers that cause
  // ERR_BLOCKED_BY_RESPONSE.NotSameOrigin even when /rest responses are 200.
  // Relax only /rest routes.
  app.use('/rest', (_req, res, next) => {
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Cross-Origin-Opener-Policy', 'unsafe-none');
    res.setHeader('Cross-Origin-Embedder-Policy', 'unsafe-none');
    next();
  });

  // Vue 2's runtime template compiler uses new Function() which requires
  // 'unsafe-eval'. Butterchurn visualizer presets also compile via new Function().
  // Keep this scoped to admin + player entry documents instead of making CSP global.
  app.use('/admin', (_req, res, next) => {
    const csp = _withUnsafeEval(res.getHeader('Content-Security-Policy'));
    res.setHeader('Content-Security-Policy', _withAdminImageSources(csp));
    next();
  });

  app.use((req, res, next) => {
    if (req.path === '/' || req.path === '/index.html') {
      const csp = _withUnsafeEval(res.getHeader('Content-Security-Policy'));
      res.setHeader('Content-Security-Policy', _withAdminImageSources(csp));
    }
    next();
  });

  app.use(compression());
  app.use(cookieParser());
  app.use(express.json({ limit: config.program.maxRequestSize }));
  app.use(express.urlencoded({ extended: true }));
  app.use((_req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
  });

  // Remove trailing slashes — needed for relative URLs on the webapp
  app.get('{*path}', (req, res, next) => {
    if (req.path.endsWith('//')) {
      const matchEnd = req.path.match(/(\/)+$/g);
      const queryString = req.url.match(/(\?.*)/g) === null ? '' : req.url.match(/(\?.*)/g);
      return res.redirect(302, req.path.slice(0, (matchEnd[0].length - 1) * -1) + queryString);
    }
    next();
  });

  // Admin panel auth guard
  app.get('/admin', (req, res, next) => {
    if (config.program.lockAdmin === true) return res.send('<p>Admin Page Disabled</p>');
    if (Object.keys(config.program.users).length === 0) return next();
    try {
      jwt.verify(req.cookies['x-access-token'], config.program.secret);
      next();
    } catch { return res.redirect(302, '/'); }
  });

  app.get('/admin/index.html', (req, res, next) => {
    if (config.program.lockAdmin === true) return res.send('<p>Admin Page Disabled</p>');
    next();
  });
}
