/**
 * src/api/sonos.js — Sonos integration
 *
 * Endpoints (all require JWT auth):
 *   GET  /api/v1/sonos/devices              — return cached room list (triggers discovery if empty)
 *   POST /api/v1/sonos/scan                 — force re-scan
 *   GET  /api/v1/sonos/probe                — probe a single IP for Sonos info
 *   POST /api/v1/sonos/save-default         — save a room as the default cast target
 *   POST /api/v1/sonos/cast                 — cast a specific track to a Sonos device (player use)
 *   POST /api/v1/sonos/cast-queue           — mirror a window of the player queue onto the Sonos queue
 *   POST /api/v1/sonos/queue/clear          — wipe the Sonos queue, only if it belongs to Velvet
 *   GET  /api/v1/sonos/transcode-stream     — dedicated ffmpeg pipe for Sonos-incompatible formats
 *   POST /api/v1/sonos/test-play            — play a random song on a Sonos device (admin test)
 *   GET  /api/v1/sonos/sleep                — read native sleep-timer remaining duration
 *   POST /api/v1/sonos/sleep                — set/clear native sleep timer (ConfigureSleepTimer)
 *   GET  /api/v1/sonos/led                  — read status-LED state (GetLEDState)
 *   POST /api/v1/sonos/led                  — set status-LED On/Off (SetLEDState) — sleep cue
 *   GET  /api/v1/sonos/favorites            — list ALL "My Favorites" (radio + Spotify + etc.), tagged by service
 *   GET  /api/v1/sonos/radio-favorites      — Sonos Radio subset of favorites
 *   POST /api/v1/sonos/play-favorite        — play any favorite by FV:2 id (uses its own res/resMD auth)
 *   POST /api/v1/sonos/favorite-visibility  — hide/show a favorite (admin; persisted in config)
 *
 * Admin endpoints:
 *   POST /api/v1/admin/sonos                — update enabled + transcodeOpus + sleepEnabled + pauseSleepMinutes
 *
 * Sonos UPnP/SOAP protocol is a public standard; all interaction is via direct
 * HTTP on port 1400. We do not use @svrooij/sonos because its internal
 * event-subscription server (port 6329) caused EADDRINUSE crashes on restart.
 */

import http from 'node:http';
import https from 'node:https';
import dgram from 'node:dgram';
import os from 'node:os';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import * as config from '../state/config.js';
import * as db from '../db/manager.js';
import { spawn } from 'node:child_process';
import { loadFile, saveFile } from '../util/admin.js';
import { ffmpegBin } from '../util/ffmpeg-bootstrap.js';
import * as vpath from '../util/vpath.js';
import { DatabaseSync } from 'node:sqlite';

// ── Shared helpers ────────────────────────────────────────────────────────────

const SONOS_DP_SVC = 'urn:schemas-upnp-org:service:DeviceProperties:1';

/** XML-escape a string for embedding in SOAP/DIDL XML. */
const xmlEsc = s => String(s)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');

/**
 * Build the base URL Velvet uses for audio streams sent to Sonos.
 * Priority: explicit localHttpPort (plain HTTP on LAN IP) → main server address.
 * Sonos hardware handles plain HTTP fine for streaming.
 * req is the Express request object (used to derive host when no explicit address).
 */
function buildBaseUrl(req) {
  if (config.program.localHttpPort) {
    // Prefer plain HTTP on LAN IP — works even when domain uses HTTPS
    const nets = os.networkInterfaces();
    let lanIp = '127.0.0.1';
    outer: for (const iface of Object.values(nets)) {
      for (const net of iface) {
        if (net.family === 'IPv4' && !net.internal) { lanIp = net.address; break outer; }
      }
    }
    return `http://${lanIp}:${config.program.localHttpPort}`;
  }
  // Fall back to the main server endpoint (works when hostname resolves to LAN IP)
  const proto = (config.program.ssl?.cert) ? 'https' : 'http';
  const host  = (config.program.address && config.program.address !== '::' && config.program.address !== '0.0.0.0')
    ? `${config.program.address}:${config.program.port}`
    : (req.headers.host || `localhost:${config.program.port}`);
  return `${proto}://${host}`;
}

/**
 * Build the base URL for album art — always uses the main HTTPS server.
 * iOS apps (CLIC, etc.) enforce App Transport Security: plain http:// URLs are
 * blocked silently. Art must come from an HTTPS endpoint so iOS can load it.
 * Sonos hardware can also load HTTPS art without issues.
 */
function buildArtBaseUrl(req) {
  const proto = (config.program.ssl?.cert) ? 'https' : 'http';
  const host  = (config.program.address && config.program.address !== '::' && config.program.address !== '0.0.0.0')
    ? `${config.program.address}:${config.program.port}`
    : (req.headers.host || `localhost:${config.program.port}`);
  return `${proto}://${host}`;
}

/**
 * Build a DIDL-Lite metadata string for a single audio track.
 * All string values are XML-escaped.
 * streamUrl: the actual stream URL — included as <res> so Sonos treats this as a
 *   proper file/track (not a broadcast), ensuring both mini-bar and full-screen
 *   use the same DIDL metadata (art + title + artist + album).
 * artUrl (optional): full URL to album art image.
 */
function buildDidl({ title, artist, album, duration }, streamUrl, artUrl = null, itemId = '1') {
  // dlna: namespace MUST be declared on the root element, not inline on the child tag.
  // No dlna:profileID attribute — many iOS/Android DLNA stacks silently skip
  // the image when dlna:profileID is present but not negotiated via DLNA headers.
  const artTag = artUrl ? `<upnp:albumArtURI>${xmlEsc(artUrl)}</upnp:albumArtURI>` : '';
  // <res> element: ties the stream URI to the metadata item so Sonos uses our DIDL
  // for both the mini-bar and full-screen "Now Playing" view.
  // duration attribute tells Sonos this is a finite track (not a live stream) —
  // without it, TrackDuration=0 and S2 app switches to radio-stream display mode.
  const durAttr = duration ? ` duration="${secsToTime(duration)}"` : '';
  const resTag = streamUrl ? `<res protocolInfo="http-get:*:audio/mpeg:*"${durAttr}>${xmlEsc(streamUrl)}</res>` : '';
  return [
    '<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/"',
    ' xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"',
    ' xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/"',
    ' xmlns:dlna="urn:schemas-dlna-org:metadata-1-0/"',
    ' xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/">',
    // id must be a positive integer AND unique per queue item — Sonos ignores the
    // metadata of items that share an id (all-same-id => only the first renders
    // title/art/duration). Multi-track queues therefore pass a distinct itemId.
    `<item id="${xmlEsc(itemId)}" restricted="1" parentID="A:TRACKS">`,
    `<dc:title>${xmlEsc(title || 'Unknown')}</dc:title>`,
    `<dc:creator>${xmlEsc(artist || '')}</dc:creator>`,
    `<upnp:artist>${xmlEsc(artist || '')}</upnp:artist>`,
    `<upnp:album>${xmlEsc(album || '')}</upnp:album>`,
    artTag,
    '<upnp:class>object.item.audioItem.musicTrack</upnp:class>',
    resTag,
    '<desc id="cdudn" nameSpace="urn:schemas-rinconnetworks-com:metadata-1-0/">',
    'RINCON_AssociatedZPUDN</desc>',
    '</item></DIDL-Lite>',
  ].join('');
}

/**
 * Send a raw UPnP AVTransport SOAP call to a Sonos device.
 * ip: device LAN IP, action: 'SetAVTransportURI' | 'Play', extraBody: inner XML
 */
function soapCall(ip, action, extraBody) {
  return new Promise((resolve, reject) => {
    const svcType = 'urn:schemas-upnp-org:service:AVTransport:1';
    const body = [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"',
      ' s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">',
      '<s:Body>',
      `<u:${action} xmlns:u="${svcType}">`,
      '<InstanceID>0</InstanceID>',
      extraBody,
      `</u:${action}>`,
      '</s:Body></s:Envelope>',
    ].join('');
    const reqOpts = {
      hostname: ip, port: 1400,
      path: '/MediaRenderer/AVTransport/Control',
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        'Content-Length': Buffer.byteLength(body),
        'soapaction': `"${svcType}#${action}"`,
      },
    };
    const hreq = http.request(reqOpts, hres => {
      let data = '';
      hres.on('data', c => data += c);
      hres.on('end', () => {
        if (hres.statusCode >= 400) {
          const code = (data.match(/<errorCode>(\d+)<\/errorCode>/i) || [])[1] || null;
          const desc = (data.match(/<errorDescription>([^<]+)<\/errorDescription>/i) || [])[1] || '';
          const err = new Error(`Sonos SOAP ${action} HTTP ${hres.statusCode}${code ? ` code=${code}` : ''}: ${desc || data.slice(0, 800)}`);
          if (code) err.code = code;
          reject(err);
        } else {
          resolve(data);
        }
      });
    });
    hreq.on('error', reject);
    // Sonos can briefly stay busy during rapid track switches (especially when
    // the previous cast used a live transcode stream). A slightly longer
    // timeout reduces false negatives while still failing fast enough for retry.
    hreq.setTimeout(9000, () => { hreq.destroy(new Error(`Sonos timeout on ${action}`)); });
    hreq.write(body);
    hreq.end();
  });
}

/**
 * Send a raw UPnP RenderingControl SOAP call to a Sonos device.
 * Used for volume/mute — different service path + type than AVTransport.
 */
function rcSoapCall(ip, action, extraBody) {
  return new Promise((resolve, reject) => {
    const svcType = 'urn:schemas-upnp-org:service:RenderingControl:1';
    const body = [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"',
      ' s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">',
      '<s:Body>',
      `<u:${action} xmlns:u="${svcType}">`,
      '<InstanceID>0</InstanceID>',
      extraBody,
      `</u:${action}>`,
      '</s:Body></s:Envelope>',
    ].join('');
    const reqOpts = {
      hostname: ip, port: 1400,
      path: '/MediaRenderer/RenderingControl/Control',
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        'Content-Length': Buffer.byteLength(body),
        'soapaction': `"${svcType}#${action}"`,
      },
    };
    const hreq = http.request(reqOpts, hres => {
      let data = '';
      hres.on('data', c => data += c);
      hres.on('end', () => {
        if (hres.statusCode >= 400) {
          reject(new Error(`Sonos RC ${action} HTTP ${hres.statusCode}: ${data.slice(0,200)}`));
        } else {
          resolve(data);
        }
      });
    });
    hreq.on('error', reject);
    hreq.setTimeout(6000, () => { hreq.destroy(new Error(`Sonos RC timeout on ${action}`)); });
    hreq.write(body);
    hreq.end();
  });
}

/** Generic SOAP request helper for local Sonos services (port 1400). */
function localSoapCall(ip, pathName, serviceType, action, actionBody = '') {
  return new Promise((resolve, reject) => {
    const body = [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"',
      ' s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">',
      '<s:Body>',
      `<u:${action} xmlns:u="${serviceType}">`,
      actionBody,
      `</u:${action}>`,
      '</s:Body></s:Envelope>',
    ].join('');
    const reqOpts = {
      hostname: ip,
      port: 1400,
      path: pathName,
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        'Content-Length': Buffer.byteLength(body),
        'soapaction': `"${serviceType}#${action}"`,
      },
    };
    const hreq = http.request(reqOpts, hres => {
      let data = '';
      hres.on('data', c => data += c);
      hres.on('end', () => {
        if (hres.statusCode >= 400) {
          const code = (data.match(/<errorCode>(\d+)<\/errorCode>/i) || [])[1] || null;
          const desc = (data.match(/<errorDescription>([^<]+)<\/errorDescription>/i) || [])[1] || '';
          const err = new Error(`Sonos SOAP ${action} HTTP ${hres.statusCode}${code ? ` code=${code}` : ''}: ${desc || data.slice(0, 800)}`);
          if (code) err.code = code;
          reject(err);
        } else {
          resolve(data);
        }
      });
    });
    hreq.on('error', reject);
    hreq.setTimeout(7000, () => { hreq.destroy(new Error(`Sonos timeout on ${action}`)); });
    hreq.write(body);
    hreq.end();
  });
}

function _decodeXmlEntitiesSimple(value) {
  return String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

async function _sonosGetString(ip, variableName) {
  const svcType = 'urn:schemas-upnp-org:service:SystemProperties:1';
  const resp = await localSoapCall(
    ip,
    '/SystemProperties/Control',
    svcType,
    'GetString',
    `<VariableName>${xmlEsc(variableName)}</VariableName>`
  );
  const value = (resp.match(/<StringValue[^>]*>([\s\S]*?)<\/StringValue>/i) || [])[1];
  return _decodeXmlEntitiesSimple(value || '').trim();
}

async function _sonosGetHouseholdId(ip) {
  const svcType = 'urn:schemas-upnp-org:service:DeviceProperties:1';
  const resp = await localSoapCall(ip, '/DeviceProperties/Control', svcType, 'GetHouseholdID', '');
  const value = (resp.match(/<(CurrentHouseholdID|HouseholdID)[^>]*>([^<]+)<\/(CurrentHouseholdID|HouseholdID)>/i) || [])[2] || '';
  return value.trim();
}

function _extractServiceIdFromAuthToken(authToken) {
  const m = String(authToken || '').match(/Svc(\d+)-\d+-Token/i);
  return m ? m[1] : null;
}

async function _sonosListAvailableServices(ip) {
  const svcType = 'urn:schemas-upnp-org:service:MusicServices:1';
  const resp = await localSoapCall(ip, '/MusicServices/Control', svcType, 'ListAvailableServices', '');
  const encoded = (resp.match(/<AvailableServiceDescriptorList[^>]*>([\s\S]*?)<\/AvailableServiceDescriptorList>/i) || [])[1] || '';
  const decoded = _decodeXmlEntitiesSimple(encoded);
  return [...decoded.matchAll(/<Service\s+([^>]+)>/g)].map(match => {
    const attrs = match[1] || '';
    const id = (attrs.match(/\bId="([^"]+)"/i) || [])[1] || null;
    const name = (attrs.match(/\bName="([^"]+)"/i) || [])[1] || null;
    const uri = (attrs.match(/\bUri="([^"]+)"/i) || [])[1] || null;
    const secureUri = (attrs.match(/\bSecureUri="([^"]+)"/i) || [])[1] || null;
    return { id, name, uri, secureUri };
  });
}

async function _resolveSmapiCredentials(ip, serviceId, authTokenHint) {
  const deviceId = await _sonosGetString(ip, 'R_TrialZPSerial').catch(() => '');
  const householdId = await _sonosGetHouseholdId(ip).catch(() => '');
  const scopeId = String(serviceId || '').trim();
  const tokenBaseCandidates = scopeId ? [`Svc${scopeId}-0`] : [];
  const authBase = (String(authTokenHint || '').match(/#(Svc\d+-\d+)-Token/i) || [])[1] || null;
  if (authBase && !tokenBaseCandidates.includes(authBase)) tokenBaseCandidates.unshift(authBase);

  const varCandidates = tokenBaseCandidates.flatMap(base => [
    `${base}-Token`,
    `${base}-Key`,
    `R_${base}-Token`,
    `R_${base}-Key`,
  ]);

  let token = '';
  let key = '';
  for (const name of varCandidates) {
    const value = await _sonosGetString(ip, name).catch(() => '');
    if (!value) continue;
    if (/token/i.test(name) && !token) token = value;
    if (/key/i.test(name) && !key) key = value;
    if (token && key) break;
  }

  if (!token && authTokenHint) token = authTokenHint;

  return {
    deviceId,
    householdId,
    token,
    key,
    complete: Boolean(deviceId && householdId && token && key),
  };
}

async function _smapiCall(endpoint, action, actionBody, credentials) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint);
    const isHttps = url.protocol === 'https:';
    const client = isHttps ? https : http;
    const svcNs = 'http://www.sonos.com/Services/1.1';
    const body = [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:s="http://www.sonos.com/Services/1.1">',
      '<soap:Header>',
      '<s:context><s:timezone>+00:00</s:timezone></s:context>',
      '<s:credentials>',
      `<s:deviceId>${xmlEsc(credentials.deviceId)}</s:deviceId>`,
      '<s:loginToken>',
      `<s:token>${xmlEsc(credentials.token)}</s:token>`,
      `<s:key>${xmlEsc(credentials.key)}</s:key>`,
      `<s:householdId>${xmlEsc(credentials.householdId)}</s:householdId>`,
      '</s:loginToken>',
      '</s:credentials>',
      '</soap:Header>',
      '<soap:Body>',
      `<s:${action}>`,
      actionBody,
      `</s:${action}>`,
      '</soap:Body>',
      '</soap:Envelope>',
    ].join('');

    const req = client.request({
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        'SOAPACTION': `"${svcNs}#${action}"`,
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        const fault = (data.match(/<faultstring>([^<]+)<\/faultstring>/i) || [])[1] || null;
        if (fault) {
          const err = new Error(`Sonos SMAPI ${action} fault: ${fault}`);
          err.code = 'SMAPI_FAULT';
          return reject(err);
        }
        resolve(data);
      });
    });
    req.on('error', reject);
    req.setTimeout(9000, () => { req.destroy(new Error(`Sonos SMAPI timeout on ${action}`)); });
    req.write(body);
    req.end();
  });
}

async function _resolveCloudPlayableUriViaSmapi(ip, cloudObjectId, authTokenHint) {
  const services = await _sonosListAvailableServices(ip);
  const preferredServiceId = _extractServiceIdFromAuthToken(authTokenHint) || '303';
  const service = services.find(s => s.id === preferredServiceId)
    || services.find(s => s.id === '303')
    || services.find(s => String(s.name || '').toLowerCase() === 'sonos radio');
  if (!service?.secureUri && !service?.uri) return null;

  const endpoint = service.secureUri || service.uri;
  const creds = await _resolveSmapiCredentials(ip, service.id, authTokenHint);
  const attempts = [
    creds,
    { ...creds, key: '' },
    { ...creds, token: authTokenHint || creds.token || '', key: '' },
    { ...creds, token: authTokenHint || creds.token || '', key: creds.key || '' },
  ];

  for (const attempt of attempts) {
    if (!attempt.deviceId || !attempt.householdId || !attempt.token) continue;
    try {
      const mediaResp = await _smapiCall(endpoint, 'getMediaURI', `<id>${xmlEsc(cloudObjectId)}</id>`, attempt);
      const mediaUri = (mediaResp.match(/<getMediaURIResult[^>]*>([^<]+)<\/getMediaURIResult>/i) || [])[1] || '';
      const resolved = _decodeXmlEntitiesSimple(mediaUri).trim();
      if (resolved) return resolved;
    } catch {
      // Try next credential variant.
    }
  }
  return null;
}

/** Format seconds as HH:MM:SS for UPnP Seek target. */
function secsToTime(s) {
  const t = Math.max(0, Math.floor(s));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = t % 60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
}

/** Parse an ISO8601 / UPnP HH:MM:SS string to seconds. Empty / NOT_IMPLEMENTED → 0. */
function timeToSecs(t) {
  if (!t || t === 'NOT_IMPLEMENTED') return 0;
  const p = String(t).trim().split(':');
  if (p.length < 3) return 0;
  return Number.parseInt(p[0], 10) * 3600 + Number.parseInt(p[1], 10) * 60 + Math.floor(Number.parseFloat(p[2]));
}

/** Validate that an IP is RFC-1918 (SSRF guard). */
function assertPrivateIp(ip) {
  if (!/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(ip)) {
    throw new Error(`IP ${ip} is not a private LAN address`);
  }
}

/**
 * Build stream URL + DIDL, then SOAP-cast to a Sonos device.
 * track:  { vpath, filepath, title, artist, album, aaFile (optional) }
 * ip:     Sonos device LAN IP
 * seekTo: seconds to seek to after Play (0 = from start)
 * paused: if true, Pause the device after searching
 */
async function castTrackToSonos({ track, ip, username, req, seekTo = 0, paused = false }) {
  assertPrivateIp(ip);
  const streamToken = jwt.sign({ username }, config.program.secret, { expiresIn: '8h' });
  const streamUrl   = _resolveStreamUrl(track, buildBaseUrl(req), streamToken, seekTo);

  const seekLabel  = seekTo > 1 ? ` @${secsToTime(seekTo)}` : '';
  const pauseLabel = paused ? ' (paused)' : '';
  console.log(`[sonos] cast → ${track.artist} — ${track.title}${seekLabel}${pauseLabel} → ${ip}`);

  const artUrl = track.aaFile ? `${buildArtBaseUrl(req)}/album-art/${encodeURIComponent(track.aaFile)}` : null;
  const didl   = buildDidl(track, streamUrl, artUrl);

  // For transcoded (live-pipe) streams the seek position is already embedded
  // in the stream URL via ?start=N — ffmpeg fast-seeks internally, so Sonos
  // must NOT be sent a Seek REL_TIME SOAP command (it silently fails on a live
  // pipe and leaves the device in a broken playing-but-no-audio state).
  const isTranscodeStream = streamUrl.includes('/api/v1/sonos/transcode-stream');
  const soapSeekTo = isTranscodeStream ? 0 : seekTo;
  // For transcoded streams Sonos reports position relative to the stream start
  // (not the original file). The client must add this offset to Sonos position
  // before comparing it with browser audioEl.currentTime, otherwise drift
  // correction snaps the playbar back to ~0. For native streams the offset is 0.
  const streamStartOffset = isTranscodeStream && seekTo > 0.5 ? Math.floor(seekTo) : 0;

  await _queueAndPlay(ip, streamUrl, didl, soapSeekTo, paused);
  return { streamUrl, didl, streamStartOffset, isTranscodeStream };
}

function _resolveStreamUrl(track, baseUrl, streamToken, seekTo = 0) {
  const encodedPath = track.filepath.split('/').map(encodeURIComponent).join('/');
  const lc         = track.filepath.toLowerCase();
  const isOpus     = lc.endsWith('.opus');
  const isWav      = lc.endsWith('.wav');
  const isHiRes    = (track.sample_rate ?? 0) > 48000;
  const sonosTranscodeEnabled = config.program?.sonos?.transcodeOpus === true;

  if ((isOpus || isWav || isHiRes) && sonosTranscodeEnabled) {
    const params = new URLSearchParams({ token: streamToken, fp: `${track.vpath}/${track.filepath}` });
    // Embed the seek position so ffmpeg fast-seeks internally — no Seek REL_TIME SOAP needed
    if (seekTo > 0.5) params.set('start', String(Math.floor(seekTo)));
    let reason;
    if (isOpus) reason = 'Opus';
    else if (isWav) reason = 'WAV';
    else reason = `${track.sample_rate} Hz hi-res`;
    const seekNote = seekTo > 0.5 ? ` (start=${Math.floor(seekTo)}s)` : '';
    console.log(`[sonos] ${reason} — routing via Sonos transcode stream → MP3${seekNote}`);
    return `${baseUrl}/api/v1/sonos/transcode-stream?${params}`;
  }
  if (isOpus)  console.warn('[sonos] Opus file sent to Sonos but Sonos transcoding is disabled — enable it in Admin → Sonos.');
  if (isWav)   console.warn('[sonos] WAV file sent to Sonos but Sonos transcoding is disabled — enable it in Admin → Sonos.');
  if (isHiRes) console.warn(`[sonos] Hi-res ${track.sample_rate} Hz file sent to Sonos but Sonos transcoding is disabled — enable it in Admin → Sonos.`);
  return `${baseUrl}/media/${encodeURIComponent(track.vpath)}/${encodedPath}?token=${streamToken}`;
}

async function _queueAndPlay(ip, streamUrl, didl, seekTo, paused) {
  await soapCall(ip, 'RemoveAllTracksFromQueue', '');
  await soapCall(ip, 'AddURIToQueue', [
    `<EnqueuedURI>${xmlEsc(streamUrl)}</EnqueuedURI>`,
    `<EnqueuedURIMetaData>${xmlEsc(didl)}</EnqueuedURIMetaData>`,
    '<DesiredFirstTrackNumberEnqueued>1</DesiredFirstTrackNumberEnqueued>',
    '<EnqueueAsNext>1</EnqueueAsNext>',
  ].join(''));

  let uuid = _cachedRooms.find(r => r.ip === ip)?.uuid;
  if (!uuid) {
    try { const room = await _fetchDeviceDescription(ip, 3000); if (room?.uuid) uuid = room.uuid; } catch { /* device description unavailable — proceed without queue UUID */ }
  }
  const queueUri  = uuid ? `x-rincon-queue:${uuid}#0` : streamUrl;
  const queueMeta = uuid ? '' : didl;
  await soapCall(ip, 'SetAVTransportURI', [
    `<CurrentURI>${xmlEsc(queueUri)}</CurrentURI>`,
    `<CurrentURIMetaData>${xmlEsc(queueMeta)}</CurrentURIMetaData>`,
  ].join(''));
  await soapCall(ip, 'Seek', '<Unit>TRACK_NR</Unit><Target>1</Target>');
  if (seekTo > 1) await soapCall(ip, 'Seek', `<Unit>REL_TIME</Unit><Target>${secsToTime(seekTo)}</Target>`);
  await soapCall(ip, 'Play', '<Speed>1</Speed>');
  if (paused) await soapCall(ip, 'Pause', '');
}

async function _castWithRetry(track, ip, req, seekTo, paused) {
  const username = req.user.username;

  // Supersede any previous in-flight cast to this device.
  // Mark it as superseded so its result is discarded even if it completes.
  const prev = _castInFlight.get(ip);
  if (prev) { prev.superseded = true; }
  const guard = { superseded: false };
  _castInFlight.set(ip, guard);

  // Rapid back-to-back casts can hit Sonos while AVTransport is still
  // transitioning from the previous URI (most visible after hi-res transcode
  // playback). Add a short adaptive settle delay before issuing SOAP calls.
  const last = _castStateByIp.get(ip);
  if (last) {
    const ageMs = Date.now() - last.ts;
    const rapid = ageMs < 12000;
    const trackLc = String(track?.filepath || '').toLowerCase();
    const currentNeedsTranscode = (config.program?.sonos?.transcodeOpus === true)
      && (trackLc.endsWith('.opus') || trackLc.endsWith('.wav') || Number(track?.sample_rate || 0) > 48000);
    const sensitive = last.wasTranscode || currentNeedsTranscode;
    if (rapid && sensitive) {
      const waitMs = Math.max(0, Math.min(3500, 12000 - ageMs));
      if (waitMs > 0) {
        console.info(`[sonos] rapid cast after ${ageMs} ms (transcode path) — waiting ${waitMs} ms before SOAP`);
        await new Promise(r => setTimeout(r, waitMs));
      }
    }
  }
  if (guard.superseded) {
    _castInFlight.delete(ip);
    throw new Error('Superseded by newer cast');
  }

  try {
    const result = await castTrackToSonos({ track, ip, username, req, seekTo, paused });
    if (guard.superseded) return { ...result, actualIp: ip }; // a newer cast already took over — still return
    _castStateByIp.set(ip, { ts: Date.now(), wasTranscode: !!result.isTranscodeStream });
    _castInFlight.delete(ip);
    return { ...result, actualIp: ip };
  } catch (e) {
    if (guard.superseded) {
      // Newer cast arrived while we were retrying — silently discard this attempt.
      _castInFlight.delete(ip);
      throw e;
    }
    const msg = String(e.message ?? e);
    const isTimeout = msg.includes('timeout');
    const isUnreachable = e.code === 'EHOSTUNREACH' || e.code === 'ECONNREFUSED' || e.code === 'ETIMEDOUT';
    if (!isUnreachable && !isTimeout) { _castInFlight.delete(ip); throw e; }
    if (isTimeout) {
      // UPnP stack waking up — wait 2 s before retrying (device is reachable but busy).
      // This covers the common case where the Sonos device accepts TCP but its renderer
      // is not yet ready to process RemoveAllTracksFromQueue or Seek commands.
      console.info(`[sonos] /cast: ${ip} timed out — waiting 2 s then retrying`);
      await new Promise(r => setTimeout(r, 2000));
    } else {
      console.info(`[sonos] /cast: ${ip} unreachable — running SSDP re-discovery`);
    }

    // Check again after the wait — a newer cast may have taken over
    if (guard.superseded) { _castInFlight.delete(ip); throw e; }

    _lastScanTime = 0;
    const freshRooms = await _scanNow(ip);
    const cachedUuid = _cachedRooms.find(r => r.ip === ip)?.uuid;
    const newRoom = (cachedUuid && freshRooms.find(r => r.uuid === cachedUuid)) || freshRooms[0];
    const targetIp = (newRoom?.ip && newRoom.ip !== ip) ? newRoom.ip : ip;
    if (newRoom?.ip && newRoom.ip !== ip) {
      console.info(`[sonos] /cast: redirecting ${ip} → ${targetIp} (${newRoom.name})`);
      // Store alias so /set-volume, /set-pause, /seek can resolve the correct IP
      // without requiring the client to update its stored room IP first.
      _ipAliases.set(ip, targetIp);
      await _healDefaultRoomIp(newRoom);
    }
    const result = await castTrackToSonos({ track, ip: targetIp, username, req, seekTo, paused });
    _castStateByIp.set(targetIp, { ts: Date.now(), wasTranscode: !!result.isTranscodeStream });
    _castInFlight.delete(ip);
    return { ...result, actualIp: targetIp };
  }
}

// In-memory cache: array of { name, ip, uuid, coordinator, model }
let _cachedRooms  = [];
let _lastScanTime = 0;           // 0 = never scanned
let _scanInFlight = null;        // Promise — prevents parallel SSDP storms
let _lastDiscoveryLog = '';      // de-dupe discovery logging: only log on state change
const SCAN_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Discovery runs every ~5 min (TTL) for as long as a client is open. Logging
// the outcome every time floods the journal when a device is simply offline.
// Log only when the outcome changes (device found / went away / error), so a
// persistent state produces exactly one line, not one every scan.
function _logDiscovery(sig, level, msg) {
  if (sig === _lastDiscoveryLog) return;
  _lastDiscoveryLog = sig;
  (level === 'warn' ? console.warn : console.log)(msg);
}

// Per-IP cast guard: only ONE cast can be in flight per device at a time.
// When a new cast arrives while one is already running, the previous attempt
// is superseded — its result is silently discarded so Sonos always ends up
// playing the most recently requested track.
const _castInFlight = new Map(); // ip → { superseded: boolean }
const _ipAliases    = new Map(); // oldIp → currentIp — set when /cast auto-redirects after SSDP re-discovery
const _castStateByIp = new Map(); // ip → { ts:number, wasTranscode:boolean }
const _queueAppendGen = new Map(); // ip → number — cancels stale background queue appends when a newer cast-queue arrives

/**
 * Run a discovery scan with deduplication.
 * If a scan is already in progress, all callers share the same Promise.
 * This prevents concurrent requests (e.g. browser page load) from each
 * starting their own SSDP M-SEARCH at the same time.
 */
async function _scanNow(seedIp) {
  if (_scanInFlight) return _scanInFlight;
  _scanInFlight = _discoverRooms(seedIp).then(rooms => {
    _cachedRooms  = rooms;
    _lastScanTime = Date.now();
    _scanInFlight = null;
    return rooms;
  }).catch(e => {
    _scanInFlight = null;
    throw e;
  });
  return _scanInFlight;
}

/**
 * Resolve the actual current IP for a device given a client-supplied IP.
 * When /cast auto-redirects (SSDP re-discovery found the device at a new IP),
 * the alias is stored in _ipAliases so subsequent /set-volume, /set-pause,
 * and /seek calls use the correct IP without requiring the client to update first.
 *
 * Priority:  1. Exact match in current cache  2. Known alias from last redirect
 *            3. Single-device shortcut (only one room discovered)
 */
function _resolveIp(requestedIp) {
  if (_cachedRooms.some(r => r.ip === requestedIp)) return requestedIp;
  const alias = _ipAliases.get(requestedIp);
  if (alias && _cachedRooms.some(r => r.ip === alias)) return alias;
  if (_cachedRooms.length === 1) return _cachedRooms[0].ip;
  return requestedIp;
}

/**
 * Persist a rediscovered IP back to the saved default room when DHCP has moved
 * the device. Matches the saved room by uuid (preferred) or by its old IP, so a
 * stale defaultRoom.ip self-heals after the first /cast redirect instead of
 * leaving every subsequent favorites/cast call pointed at a dead address.
 */
async function _healDefaultRoomIp(newRoom) {
  const dr = config.program?.sonos?.defaultRoom;
  if (!dr || !newRoom?.ip) return;
  const matches = (dr.uuid && newRoom.uuid && dr.uuid === newRoom.uuid) || dr.ip === newRoom.ip;
  if (!matches || dr.ip === newRoom.ip) return;
  try {
    const loadedCfg = await loadFile(config.configFile);
    if (!loadedCfg.sonos) loadedCfg.sonos = {};
    loadedCfg.sonos.defaultRoom = { ...dr, ip: newRoom.ip, uuid: newRoom.uuid || dr.uuid };
    await saveFile(loadedCfg, config.configFile);
    config.program.sonos.defaultRoom = loadedCfg.sonos.defaultRoom;
    console.info(`[sonos] default room IP healed: ${dr.ip} → ${newRoom.ip} (${newRoom.name})`);
  } catch (e) {
    console.warn('[sonos] failed to persist healed default room IP:', e.message || e);
  }
}

/**
 * Fetch the UPnP device description from a single Sonos device via plain HTTP.
 * Returns a room object or null if unreachable.
 * This avoids SonosManager which starts an event-listener HTTP server on port 6329
 * and crashes on EADDRINUSE when the server restarts.
 */
function _fetchDeviceDescription(ip, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const hreq = http.request(
      { hostname: ip, port: 1400, path: '/xml/device_description.xml', method: 'GET' },
      hres => {
        let data = '';
        hres.on('data', c => data += c);
        hres.on('end', () => {
          if (hres.statusCode !== 200) return resolve(null);
          // Extract fields via simple regex — no XML parser dependency needed.
          const tag = (t, fallback = '') => {
            const m = new RegExp(`<${t}[^>]*>([^<]+)</${t}>`, 'i').exec(data);
            return m ? m[1].trim() : fallback;
          };
          const rawUdn = tag('UDN', '');
          resolve({
            name:        tag('roomName') || tag('friendlyName', 'Unknown').replace(/^\S+\s+-\s+/, '').replace(/\s+-\s+RINCON_\S+$/, ''),
            ip,
            port:        1400,
            uuid:        rawUdn.replace(/^uuid:/i, ''),
            model:       tag('modelName', ''),
            coordinator: true, // single-device fetch always coordinator
            groupName:   '',
          });
        });
      }
    );
    hreq.on('error', () => resolve(null));
    hreq.setTimeout(timeoutMs, () => { hreq.destroy(); resolve(null); });
    hreq.end();
  });
}

/**
 * SSDP M-SEARCH discovery — pure UDP/dgram, no third-party library.
 * Sends a multicast M-SEARCH to 239.255.255.250:1900 with Sonos search target,
 * collects LOCATION headers from responses, then fetches device descriptions.
 * Returns array of room objects.
 */
function _ssdpDiscover(timeoutMs = 4000) {
  return new Promise(resolve => {
    const SSDP_ADDR = '239.255.255.250'; // eslint-disable-line sonarjs/no-hardcoded-ip -- IANA SSDP multicast
    const SSDP_PORT = 1900;
    const ST = 'urn:schemas-upnp-org:device:ZonePlayer:1';
    const msearch = [
      'M-SEARCH * HTTP/1.1',
      `HOST: ${SSDP_ADDR}:${SSDP_PORT}`,
      'MAN: "ssdp:discover"',
      'MX: 3',
      `ST: ${ST}`,
      '',
      ''
    ].join('\r\n');

    const locations = new Set();
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    const done = () => {
      try { sock.close(); } catch { /* socket already closed */ }
    };

    const timer = setTimeout(() => {
      done();
      // Fetch all collected device descriptions in parallel
      const ips = [...locations].map(loc => {
        try { return new URL(loc).hostname; } catch { return null; }
      }).filter(Boolean);
      Promise.all(ips.map(ip => {
        try { assertPrivateIp(ip); return _fetchDeviceDescription(ip, 3000); } catch { return null; }
      })).then(rooms => resolve(rooms.filter(Boolean)));
    }, timeoutMs);

    sock.on('message', msg => {
      const text = msg.toString();
      const m = text.match(/^LOCATION:\s*(http:\/\/[^\s]+)/im);
      if (m) locations.add(m[1]);
    });

    sock.on('error', () => { clearTimeout(timer); done(); resolve([]); });

    sock.bind(() => {
      const buf = Buffer.from(msearch);
      sock.send(buf, 0, buf.length, SSDP_PORT, SSDP_ADDR);
    });
  });
}

/**
 * Discover Sonos rooms.
 * Strategy:
 *  1. Try SSDP multicast (works on most LANs, no dependency needed — pure UDP).
 *  2. If SSDP returns nothing AND a seedIp is configured, probe that IP directly
 *     (covers networks where multicast is filtered / Sonos is on a different VLAN).
 */
async function _discoverRooms(seedIp) {
  // Step 1: SSDP multicast
  try {
    const rooms = await _ssdpDiscover(4000);
    if (rooms.length > 0) {
      _logDiscovery('ssdp:' + rooms.map(r => r.ip).sort().join(','), 'info',
        `[sonos] SSDP found ${rooms.length} device(s): ${rooms.map(r => `${r.name} @ ${r.ip}`).join(', ')}`);
      return rooms;
    }
  } catch (e) {
    console.warn('[sonos] SSDP error:', e.message || e);
  }

  // Step 2: fall back to configured seed IP
  if (!seedIp) {
    _logDiscovery('no-seed', 'warn', '[sonos] SSDP found nothing and no seed IP configured.');
    return [];
  }
  try {
    assertPrivateIp(seedIp);
    const room = await _fetchDeviceDescription(seedIp);
    if (!room) {
      _logDiscovery('unreachable:' + seedIp, 'warn',
        `[sonos] Device at ${seedIp} unreachable or not a Sonos device.`);
      return [];
    }
    _logDiscovery('seed-ok:' + room.ip, 'info',
      `[sonos] Seed-IP probe succeeded: ${room.name} @ ${room.ip}`);
    return [room];
  } catch (e) {
    _logDiscovery('seed-error:' + seedIp, 'warn', `[sonos] Seed-IP probe error: ${e.message || e}`);
    return [];
  }
}

export function setup(velvet) {
  // ── GET /api/v1/sonos/devices ─────────────────────────────────────────
  // Returns cached room list. If cache is stale (>5 min) or empty, triggers a fresh scan.
  velvet.get('/api/v1/sonos/devices', async (req, res) => {
    try {
      const now = Date.now();
      // Only rescan when TTL has expired — NOT when rooms is empty.
      // If rooms is [] after a scan (device off/unreachable), we still honour
      // the TTL to avoid SSDP storms when no device is reachable.
      if (now - _lastScanTime > SCAN_TTL_MS) {
        const seedIp = config.program?.sonos?.knownIps?.[0]
          || config.program?.sonos?.defaultRoom?.ip
          || null;
        await _scanNow(seedIp);
      }
      res.json({
        rooms:          _cachedRooms,
        lastScan:       _lastScanTime,
        cached:         true,
        defaultRoom:        config.program?.sonos?.defaultRoom || null,
        enabled:            config.program?.sonos?.enabled !== false,
        transcodeOpus:      config.program?.sonos?.transcodeOpus === true,
        sleepEnabled:       config.program?.sonos?.sleepEnabled === true,
        pauseSleepMinutes:  Number(config.program?.sonos?.pauseSleepMinutes) || 5,
      });
    } catch (e) {
      console.error('[sonos] /devices error:', e);
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  // ── POST /api/v1/sonos/save-default ──────────────────────────────────
  // Save a room as the default cast target.
  // Body: { ip, name, uuid }
  velvet.post('/api/v1/sonos/save-default', async (req, res) => {
    if (!req.user?.admin) return res.status(403).json({ error: 'Admin only' });
    const { ip, name, uuid } = req.body || {};
    if (!ip || !name) return res.status(400).json({ error: 'ip and name required' });
    try {
      const defaultRoom = { ip: String(ip), name: String(name), uuid: String(uuid || '') };
      // Persist to config file
      const loadedCfg = await loadFile(config.configFile);
      if (!loadedCfg.sonos) loadedCfg.sonos = {};
      loadedCfg.sonos.defaultRoom = defaultRoom;
      await saveFile(loadedCfg, config.configFile);
      // Update in-memory config
      if (!config.program.sonos) config.program.sonos = {};
      config.program.sonos.defaultRoom = defaultRoom;
      res.json({ ok: true, defaultRoom });
    } catch (e) {
      console.error('[sonos] /save-default error:', e);
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  // ── POST /api/v1/admin/sonos — update Sonos config
  // Body: { enabled?: boolean, transcodeOpus?: boolean, sleepEnabled?: boolean, pauseSleepMinutes?: number }
  velvet.post('/api/v1/admin/sonos', async (req, res) => {
    if (!req.user?.admin) return res.status(403).json({ error: 'Admin only' });
    const { enabled, transcodeOpus, sleepEnabled, pauseSleepMinutes } = req.body || {};
    if (enabled === undefined && transcodeOpus === undefined && sleepEnabled === undefined && pauseSleepMinutes === undefined) {
      return res.status(400).json({ error: 'enabled, transcodeOpus, sleepEnabled or pauseSleepMinutes required' });
    }
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be boolean' });
    }
    if (transcodeOpus !== undefined && typeof transcodeOpus !== 'boolean') {
      return res.status(400).json({ error: 'transcodeOpus must be boolean' });
    }
    if (sleepEnabled !== undefined && typeof sleepEnabled !== 'boolean') {
      return res.status(400).json({ error: 'sleepEnabled must be boolean' });
    }
    if (pauseSleepMinutes !== undefined && (!Number.isFinite(pauseSleepMinutes) || pauseSleepMinutes < 1 || pauseSleepMinutes > 120)) {
      return res.status(400).json({ error: 'pauseSleepMinutes must be a number between 1 and 120' });
    }
    try {
      const loadedCfg = await loadFile(config.configFile);
      if (!loadedCfg.sonos) loadedCfg.sonos = {};
      if (!config.program.sonos) config.program.sonos = {};
      if (enabled !== undefined) {
        loadedCfg.sonos.enabled = enabled;
        config.program.sonos.enabled = enabled;
      }
      if (transcodeOpus !== undefined) {
        loadedCfg.sonos.transcodeOpus = transcodeOpus;
        config.program.sonos.transcodeOpus = transcodeOpus;
      }
      if (sleepEnabled !== undefined) {
        loadedCfg.sonos.sleepEnabled = sleepEnabled;
        config.program.sonos.sleepEnabled = sleepEnabled;
      }
      if (pauseSleepMinutes !== undefined) {
        loadedCfg.sonos.pauseSleepMinutes = pauseSleepMinutes;
        config.program.sonos.pauseSleepMinutes = pauseSleepMinutes;
      }
      await saveFile(loadedCfg, config.configFile);
      res.json({
        ok: true,
        enabled: config.program.sonos.enabled !== false,
        transcodeOpus: config.program.sonos.transcodeOpus === true,
        sleepEnabled: config.program.sonos.sleepEnabled === true,
        pauseSleepMinutes: Number(config.program.sonos.pauseSleepMinutes) || 5,
      });
    } catch (e) {
      console.error('[sonos] /admin/sonos error:', e);
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  // ── GET /api/v1/sonos/transcode-stream ────────────────────────────────
  // Dedicated ffmpeg transcoding endpoint for Sonos-incompatible audio formats.
  // Completely independent of the main transcode module — no transcode config needed.
  // Query params: fp=<vpath/filepath>, token=<jwt>, start=<seconds> (optional)
  // Pipes ffmpeg output as audio/mpeg (MP3 192k) directly to the response.
  // The start param uses ffmpeg's -ss pre-input fast seek so Sonos doesn't need
  // a Seek REL_TIME SOAP command (which silently fails on a live pipe).
  velvet.get('/api/v1/sonos/transcode-stream', async (req, res) => {
    const fp = req.query?.fp;
    if (!fp) return res.status(400).json({ error: 'fp query param required' });

    // Resolve the full filesystem path — reuses the vpath helper
    let pathInfo;
    try {
      pathInfo = vpath.getVPathInfo(fp, req.user);
    } catch {
      return res.status(404).json({ error: 'File not found or access denied' });
    }
    if (!pathInfo?.fullPath) return res.status(404).json({ error: 'File not found' });

    // Optional start offset (seconds) — embedded in URL so no SOAP Seek is needed
    const startSecs = Number.parseFloat(req.query?.start ?? '0') || 0;

    try {
      // Spawn ffmpeg: read input → strip video streams → encode MP3 192k @ 48 kHz → stdout
      // -ar 48000 ensures hi-res (88/96/176/192 kHz) FLAC is downsampled to a
      // sample rate all Sonos hardware supports.
      // -ss before -i is a fast seek (keyframe-accurate, no full decode to offset)
      // which is ideal for live streaming — accurate enough for this use case.
      const ffmpegArgs = startSecs > 0.5
        ? ['-ss', String(startSecs), '-i', pathInfo.fullPath]
        : ['-i', pathInfo.fullPath];
      const proc = spawn(ffmpegBin(), [
        ...ffmpegArgs,
        '-vn',                 // drop video/cover streams
        '-ar', '48000',        // normalise to 48 kHz (Sonos max for most devices)
        '-f', 'mp3',
        '-acodec', 'libmp3lame',
        '-ab', '192k',
        '-'
      ], { stdio: ['ignore', 'pipe', 'ignore'] });

      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Transfer-Encoding', 'chunked');
      proc.stdout.pipe(res);

      proc.on('error', err => {
        console.error('[sonos] transcode-stream ffmpeg error:', err.message);
        if (!res.headersSent) res.status(500).json({ error: 'Transcode failed' });
      });

      // If the client disconnects, kill ffmpeg to avoid zombie processes
      res.on('close', () => { try { proc.kill('SIGTERM'); } catch (e) { console.debug('[velvet]', e?.message ?? e); } });
      res.on('finish', () => { try { proc.kill('SIGTERM'); } catch (e) { console.debug('[velvet]', e?.message ?? e); } });
    } catch (e) {
      console.error('[sonos] transcode-stream error:', e);
      if (!res.headersSent) res.status(500).json({ error: String(e.message || e) });
    }
  });

  // ── POST /api/v1/sonos/scan ───────────────────────────────────────────
  // Force a fresh discovery scan (ignores cache TTL).
  velvet.post('/api/v1/sonos/scan', async (req, res) => {
    try {
      const seedIp = req.body?.seedIp
        || config.program?.sonos?.knownIps?.[0]
        || config.program?.sonos?.defaultRoom?.ip
        || null;
      // Force-expire the TTL so _scanNow always runs a fresh scan
      _lastScanTime = 0;
      await _scanNow(seedIp);
      res.json({ rooms: _cachedRooms, lastScan: _lastScanTime, cached: false });
    } catch (e) {
      console.error('[sonos] /scan error:', e);
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  // ── GET /api/v1/sonos/probe?ip=X.X.X.X ───────────────────────────────
  // Probe a single IP and return basic device info (for manual seed-IP verification).
  // Uses a direct HTTP fetch to avoid SonosDevice which can trigger event subscriptions.
  velvet.get('/api/v1/sonos/probe', async (req, res) => {
    const ip = req.query?.ip;
    if (!ip) return res.status(400).json({ error: 'ip query param required' });
    try {
      assertPrivateIp(ip);
      const room = await _fetchDeviceDescription(ip, 5000);
      if (!room) return res.json({ ok: false, error: 'Device unreachable or not a Sonos device', ip });
      res.json({ ok: true, name: room.name, model: room.model, uuid: room.uuid, ip });
    } catch (e) {
      res.json({ ok: false, error: String(e.message || e), ip });
    }
  });

  // ── POST /api/v1/sonos/cast ───────────────────────────────────────────
  // Cast a specific track to a Sonos device. Called by the player when a song changes
  // while Sonos cast is active.
  // Body: { ip, filepath, title, artist, album, seekTo, paused }
  //   filepath must include the vpath prefix (e.g. "Music/Albums/song.flac")
  //   seekTo  (optional) — seconds to seek to after play
  //   paused  (optional) — pause immediately after seeking
  //   ip defaults to the configured defaultRoom if not provided
  velvet.post('/api/v1/sonos/cast', async (req, res) => {
    const ip       = req.body?.ip || config.program?.sonos?.defaultRoom?.ip;
    let   filepath = req.body?.filepath;
    if (!ip)       return res.status(400).json({ error: 'ip required (or set a default room in admin)' });
    if (!filepath) return res.status(400).json({ error: 'filepath required' });

    // Strip any leading slash — server-remote may send paths like "/Music/song.flac"
    filepath = filepath.replace(/^\/+/, '');

    // Split "vpath/rest/of/path" → { vpath, filepath }
    const slashIdx = filepath.indexOf('/');
    if (slashIdx < 1) {
      console.error('[sonos] /cast bad filepath:', JSON.stringify(req.body?.filepath));
      return res.status(400).json({ error: 'filepath must include vpath prefix' });
    }
    const vpath    = filepath.slice(0, slashIdx);
    const relPath  = filepath.slice(slashIdx + 1);

    const track = {
      vpath,
      filepath: relPath,
      title:    req.body?.title  || '',
      artist:   req.body?.artist || '',
      album:    req.body?.album  || '',
      aaFile:   req.body?.aaFile || null,
    };

    // Look up aaFile, duration and sample_rate from DB if not provided by client
    try {
      const row = db.findFileByPath(relPath, vpath);
      if (row?.aaFile && !track.aaFile) track.aaFile = row.aaFile;
      if (row?.duration && !track.duration) track.duration = row.duration;
      if (row?.sample_rate) track.sample_rate = row.sample_rate;

      // Fallback: the sent vpath might not be the DB-indexed root vpath.
      // Example: vpath "12-inches" (root /media/music/12 inches A-Z) is a
      // sub-directory of "Music" (root /media/music) and its files are only
      // indexed in the DB under vpath="Music". Resolve the full filesystem path
      // and try every configured folder whose root is a prefix of that path.
      if (track.sample_rate == null) {
        const sentRoot = config.program?.folders?.[vpath]?.root;
        if (sentRoot) {
          const fullPath = path.join(sentRoot, relPath);
          for (const [dbVpath, dbCfg] of Object.entries(config.program?.folders ?? {})) {
            if (dbVpath === vpath) continue;
            const base = dbCfg.root.endsWith(path.sep) ? dbCfg.root : dbCfg.root + path.sep;
            if (fullPath === dbCfg.root || fullPath.startsWith(base)) {
              const dbRelPath = fullPath.slice(base.length);
              const fbRow = db.findFileByPath(dbRelPath, dbVpath);
              if (fbRow != null) {
                if (fbRow.aaFile && !track.aaFile) track.aaFile = fbRow.aaFile;
                if (fbRow.duration && !track.duration) track.duration = fbRow.duration;
                if (fbRow.sample_rate != null) track.sample_rate = fbRow.sample_rate;
                break;
              }
            }
          }
        }
      }
    } catch (e) { console.debug('[velvet]', e?.message ?? e); }
    const seekTo = Number(req.body?.seekTo) || 0;
    const paused = !!req.body?.paused;

    try {
      const { streamUrl, actualIp, streamStartOffset, isTranscodeStream } = await _castWithRetry(track, ip, req, seekTo, paused);
      // Return actualIp so the client can update S.sonosRoom.ip when /cast auto-redirected
      // (e.g. device got a new DHCP lease). Without this, subsequent /set-volume and
      // /set-pause calls keep using the stale IP → EHOSTUNREACH.
      // streamStartOffset > 0 for transcoded streams started mid-file — client uses
      // this to compensate position-sync drift correction so playbar doesn't reset to 0.
      res.json({
        ok: true, ip, actualIp: actualIp ?? ip,
        title: track.title, artist: track.artist, streamUrl,
        streamStartOffset: streamStartOffset ?? 0,
        isTranscodeStream: !!isTranscodeStream,
      });
    } catch (e) {
      const msg = String(e.message ?? e);
      // Timeout after retry = device still unresponsive — log concisely without stack trace
      if (msg.includes('timeout')) {
        console.info(`[sonos] /cast: ${ip} still unresponsive after retry — ${msg}`);
      } else {
        console.error('[sonos] /cast error:', e);
      }
      res.status(500).json({ ok: false, error: msg });
    }
  });

  // ── POST /api/v1/sonos/cast-queue ────────────────────────────────────
  // Mirror a window of the player's queue onto the Sonos queue and play at `index`.
  // The player remains the source of truth; this just keeps the Sonos app's
  // played/upcoming list in sync while Sonos is the active output.
  // Body: { ip, tracks:[{filepath,title,artist,album,aaFile}], index, seekTo, paused }
  //   tracks[].filepath must include the vpath prefix; only the played track (index) is seeked.
  velvet.post('/api/v1/sonos/cast-queue', async (req, res) => {
    const ip        = req.body?.ip || config.program?.sonos?.defaultRoom?.ip;
    const rawTracks = Array.isArray(req.body?.tracks) ? req.body.tracks : [];
    const seekTo    = Number(req.body?.seekTo) || 0;
    const paused    = !!req.body?.paused;
    if (!ip)              return res.status(400).json({ error: 'ip required' });
    if (!rawTracks.length) return res.status(400).json({ error: 'tracks required' });
    const index = Math.max(0, Math.min(rawTracks.length - 1, Number.parseInt(req.body?.index, 10) || 0));
    try {
      const resolvedIp = _resolveIp(ip);
      assertPrivateIp(resolvedIp);
      const streamToken = jwt.sign({ username: req.user.username }, config.program.secret, { expiresIn: '8h' });
      const baseUrl = buildBaseUrl(req);
      const artBase = buildArtBaseUrl(req);

      const items = [];
      for (let i = 0; i < rawTracks.length; i++) {
        const raw = rawTracks[i];
        const fp = String(raw?.filepath || '').replace(/^\/+/, '');
        const slash = fp.indexOf('/');
        if (slash < 1) continue;
        const track = { vpath: fp.slice(0, slash), filepath: fp.slice(slash + 1), title: raw.title || '', artist: raw.artist || '', album: raw.album || '', aaFile: raw.aaFile || null };
        try {
          const row = db.findFileByPath(track.filepath, track.vpath);
          if (row?.aaFile && !track.aaFile) track.aaFile = row.aaFile;
          if (row?.duration) track.duration = row.duration;
          if (row?.sample_rate != null) track.sample_rate = row.sample_rate;
        } catch (e) { console.debug('[velvet]', e?.message ?? e); }
        const trackSeek = i === index ? seekTo : 0;
        const streamUrl = _resolveStreamUrl(track, baseUrl, streamToken, trackSeek);
        // Per-row art: controllers (CLIC, Sonos app) only render queue-row art that the
        // speaker serves via its own /getaa proxy — not external URLs. /getaa?u=<stream>
        // makes the speaker extract the embedded cover from our stream (relative URL, so
        // it resolves against the speaker). Transcoded streams drop the cover (-vn), so
        // fall back to the cached /album-art/ URL there (no per-row art, but now-playing works).
        const isTranscode = streamUrl.includes('/api/v1/sonos/transcode-stream');
        const artUrl = isTranscode
          ? (track.aaFile ? `${artBase}/album-art/${encodeURIComponent(track.aaFile)}` : null)
          : `/getaa?u=${encodeURIComponent(streamUrl)}`;
        items.push({ streamUrl, didl: buildDidl(track, streamUrl, artUrl, String(i + 1)) });
      }
      if (!items.length) return res.status(400).json({ error: 'no valid tracks' });
      // The currently-playing track is sent first (items[0]); upcoming tracks follow.
      // We add the current track, start playback immediately, then append the rest in
      // the background — so casting starts fast instead of waiting for the whole window.
      const curIsTranscode = items[0].streamUrl.includes('/api/v1/sonos/transcode-stream');
      const soapSeekTo = curIsTranscode ? 0 : seekTo;
      const streamStartOffset = curIsTranscode && seekTo > 0.5 ? Math.floor(seekTo) : 0;
      const addUri = it => soapCall(resolvedIp, 'AddURIToQueue', [
        `<EnqueuedURI>${xmlEsc(it.streamUrl)}</EnqueuedURI>`,
        `<EnqueuedURIMetaData>${xmlEsc(it.didl)}</EnqueuedURIMetaData>`,
        '<DesiredFirstTrackNumberEnqueued>0</DesiredFirstTrackNumberEnqueued>',
        '<EnqueueAsNext>0</EnqueueAsNext>',
      ].join(''));

      const gen = (_queueAppendGen.get(resolvedIp) || 0) + 1;
      _queueAppendGen.set(resolvedIp, gen);

      await soapCall(resolvedIp, 'RemoveAllTracksFromQueue', '');
      await addUri(items[0]);
      let uuid = _cachedRooms.find(r => r.ip === resolvedIp)?.uuid;
      if (!uuid) { try { const room = await _fetchDeviceDescription(resolvedIp, 3000); if (room?.uuid) uuid = room.uuid; } catch (e) { console.debug('[velvet]', e?.message ?? e); } }
      const queueUri = uuid ? `x-rincon-queue:${uuid}#0` : items[0].streamUrl;
      await soapCall(resolvedIp, 'SetAVTransportURI', [
        `<CurrentURI>${xmlEsc(queueUri)}</CurrentURI>`,
        `<CurrentURIMetaData>${uuid ? '' : xmlEsc(items[0].didl)}</CurrentURIMetaData>`,
      ].join(''));
      await soapCall(resolvedIp, 'Seek', '<Unit>TRACK_NR</Unit><Target>1</Target>');
      if (soapSeekTo > 1) await soapCall(resolvedIp, 'Seek', `<Unit>REL_TIME</Unit><Target>${secsToTime(soapSeekTo)}</Target>`);
      await soapCall(resolvedIp, 'Play', '<Speed>1</Speed>');
      if (paused) await soapCall(resolvedIp, 'Pause', '');
      res.json({ ok: true, actualIp: resolvedIp, count: items.length, index: 0, streamStartOffset, isTranscodeStream: !!curIsTranscode });

      // Append the upcoming tracks in the background; abort if a newer cast-queue supersedes us.
      (async () => {
        for (let i = 1; i < items.length; i++) {
          if (_queueAppendGen.get(resolvedIp) !== gen) return;
          try { await addUri(items[i]); } catch { return; }
        }
        console.log(`[sonos] cast-queue: ${items.length} track(s) queued → ${resolvedIp}`);
      })();
    } catch (e) {
      console.error('[sonos] /cast-queue error:', e);
      res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  });

  // ── POST /api/v1/sonos/queue/clear ───────────────────────────────────
  // Wipe the Sonos queue, but ONLY if every track belongs to Velvet (points at
  // our server). A user-built queue (streaming service, line-in, another server)
  // is left untouched. Body: { ip }
  velvet.post('/api/v1/sonos/queue/clear', async (req, res) => {
    const ip = req.body?.ip || config.program?.sonos?.defaultRoom?.ip;
    if (!ip) return res.status(400).json({ error: 'ip required' });
    try {
      const resolvedIp = _resolveIp(ip);
      assertPrivateIp(resolvedIp);
      let uris;
      try {
        uris = await _sonosQueueResUris(resolvedIp);
      } catch (e) {
        const msg = String(e.message || e);
        if (e.code === 'EHOSTUNREACH' || e.code === 'ECONNREFUSED' || msg.includes('timeout')) {
          return res.status(503).json({ ok: false, unreachable: true, error: msg });
        }
        throw e;
      }
      if (uris.length === 0) return res.json({ ok: true, wiped: false, reason: 'empty' });
      const base = buildBaseUrl(req);
      const isOurs = u => u.startsWith(base) || u.includes('/api/v1/sonos/transcode-stream') || (u.includes('/media/') && u.includes('token='));
      if (!uris.every(isOurs)) {
        console.log(`[sonos] queue/clear: foreign queue on ${resolvedIp} (${uris.length} tracks) — leaving untouched`);
        return res.json({ ok: true, wiped: false, reason: 'foreign-queue', count: uris.length });
      }
      await soapCall(resolvedIp, 'RemoveAllTracksFromQueue', '');
      console.log(`[sonos] queue/clear: wiped ${uris.length} Velvet track(s) → ${resolvedIp}`);
      res.json({ ok: true, wiped: true, count: uris.length });
    } catch (e) {
      console.error('[sonos] /queue/clear error:', e);
      res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  });

  // ── POST /api/v1/sonos/set-pause ─────────────────────────────────────
  // Mirror browser pause/resume to a Sonos device.
  // Body: { ip, paused: true|false }
  velvet.post('/api/v1/sonos/set-pause', async (req, res) => {
    const ip       = req.body?.ip || config.program?.sonos?.defaultRoom?.ip;
    const paused   = !!req.body?.paused;
    if (!ip) return res.status(400).json({ error: 'ip required' });
    try {
      const resolvedIp = _resolveIp(ip);
      assertPrivateIp(resolvedIp);
      await soapCall(resolvedIp, paused ? 'Pause' : 'Play', paused ? '' : '<Speed>1</Speed>');
      res.json({ ok: true, paused });
    } catch (e) {
      // UPnP 500 = device has no track loaded (idle/just rebooted) — not a real error
      const msg = String(e.message || e);
      if (msg.includes('HTTP 500') || msg.includes('UPnPError')) {
        return res.json({ ok: true, paused, ignored: 'device idle' });
      }
      // EHOSTUNREACH / timeout = device is offline — expected, log concisely without stack trace
      if (e.code === 'EHOSTUNREACH' || e.code === 'ECONNREFUSED' || msg.includes('timeout')) {
        console.info(`[sonos] /set-pause: device offline (${ip}) — ${msg}`);
        return res.status(503).json({ ok: false, error: msg });
      }
      console.error('[sonos] /set-pause error:', e);
      res.status(500).json({ ok: false, error: msg });
    }
  });

  // ── POST /api/v1/sonos/seek ───────────────────────────────────────────
  // Mirror browser seek to a Sonos device.
  // Body: { ip, position: <seconds> }
  velvet.post('/api/v1/sonos/seek', async (req, res) => {
    const ip         = req.body?.ip || config.program?.sonos?.defaultRoom?.ip;
    const position   = Number(req.body?.position) || 0;
    if (!ip) return res.status(400).json({ error: 'ip required' });
    try {
      const resolvedIp = _resolveIp(ip);
      assertPrivateIp(resolvedIp);
      await soapCall(resolvedIp, 'Seek', `<Unit>REL_TIME</Unit><Target>${secsToTime(position)}</Target>`);
      res.json({ ok: true, position });
    } catch (e) {
      // UPnP 500 = device idle/no track — silently ignore
      const msg = String(e.message ?? e);
      if (msg.includes('HTTP 500') || msg.includes('UPnPError')) {
        return res.json({ ok: true, position, ignored: 'device idle' });
      }
      // Timeout = device waking up/busy — expected, log concisely without stack trace
      if (msg.includes('timeout')) {
        console.info(`[sonos] /seek: device busy (${resolvedIp}) — ${msg}`);
        return res.status(503).json({ ok: false, error: msg });
      }
      console.error('[sonos] /seek error:', e);
      res.status(500).json({ ok: false, error: msg });
    }
  });

  // ── POST /api/v1/sonos/set-volume ─────────────────────────────────────
  // Mirror browser volume + mute to a Sonos device via RenderingControl.
  // Body: { ip, volume: 0-100, muted: bool }
  velvet.post('/api/v1/sonos/set-volume', async (req, res) => {
    const ip         = req.body?.ip || config.program?.sonos?.defaultRoom?.ip;
    const volume     = Math.min(100, Math.max(0, Math.round(Number(req.body?.volume) || 0)));
    const muted      = !!req.body?.muted;
    if (!ip) return res.status(400).json({ error: 'ip required' });
    try {
      const resolvedIp = _resolveIp(ip);
      assertPrivateIp(resolvedIp);
      const sonosVol = muted ? 0 : volume;
      await rcSoapCall(resolvedIp, 'SetVolume', `<Channel>Master</Channel><DesiredVolume>${sonosVol}</DesiredVolume>`);
      res.json({ ok: true, volume: sonosVol });
    } catch (e) {
      console.error('[sonos] /set-volume error:', e);
      res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  });

  // ── GET /api/v1/sonos/battery?ip=X ───────────────────────────────────
  // Returns battery info from a Sonos portable device (Roam, Roam 2, Move, Move 2).
  // Mains-powered devices return { supported: false }.
  // Response: { supported, level, powerSource, health, temperature }
  velvet.get('/api/v1/sonos/battery', async (req, res) => {
    const ip = req.query?.ip || config.program?.sonos?.defaultRoom?.ip;
    if (!ip) return res.status(400).json({ error: 'ip required' });
    try {
      assertPrivateIp(ip);
      const data = await new Promise((resolve, reject) => {
        const reqOpts = {
          hostname: ip, port: 1400,
          path: '/status/batterystatus',
          method: 'GET',
        };
        const hreq = http.request(reqOpts, hres => {
          let body = '';
          hres.on('data', c => body += c);
          hres.on('end', () => resolve({ status: hres.statusCode, body }));
        });
        hreq.on('error', reject);
        hreq.setTimeout(5000, () => hreq.destroy(new Error('timeout')));
        hreq.end();
      });

      if (data.status === 404 || !data.body.includes('LocalBatteryStatus')) {
        return res.json({ supported: false });
      }

      const tag = name => {
        const m = data.body.match(new RegExp('<Data name="' + name + '">([^<]+)<'));
        return m ? m[1].trim() : null;
      };

      res.json({
        supported   : true,
        level       : tag('Level') == null ? null : Number.parseInt(tag('Level'), 10),
        powerSource : tag('PowerSource'),   // USB_POWER | BATTERY
        health      : tag('Health'),        // GREEN | YELLOW | RED
        temperature : tag('Temperature'),   // NORMAL | HIGH
      });
    } catch {
      // Network errors (ECONNREFUSED, timeout, unreachable host) are expected when
      // the device is offline — return supported:false so the client stays silent.
      res.json({ supported: false });
    }
  });

  // ── GET /api/v1/sonos/device-info?ip=X ──────────────────────────────
  // Returns zone info + wireless status from a Sonos device.
  // Fetches /status/zp and /status/wireless in parallel.
  velvet.get('/api/v1/sonos/device-info', async (req, res) => {
    const ip = req.query?.ip || config.program?.sonos?.defaultRoom?.ip;
    if (!ip) return res.status(400).json({ error: 'ip required' });
    try {
      assertPrivateIp(ip);
      const fetchPath = (path) => new Promise((resolve, reject) => {
        const reqOpts = { hostname: ip, port: 1400, path, method: 'GET' };
        const hreq = http.request(reqOpts, hres => {
          let body = ''; hres.on('data', c => body += c);
          hres.on('end', () => resolve(body));
        });
        hreq.on('error', reject);
        hreq.setTimeout(5000, () => hreq.destroy(new Error('timeout')));
        hreq.end();
      });
      const [zpBody, wifiBody] = await Promise.all([
        fetchPath('/status/zp'),
        fetchPath('/status/wireless'),
      ]);
      const zp = name => { const m = zpBody.match(new RegExp('<' + name + '>([^<]+)<')); return m ? m[1].trim() : null; };
      const wf = name => { const m = wifiBody.match(new RegExp('<' + name + '>([^<]+)<')); return m ? m[1].trim() : null; };
      res.json({
        zoneName      : zp('ZoneName'),
        model         : zp('HardwareVersion'),
        firmware      : zp('SoftwareVersion'),
        firmwareDate  : zp('SoftwareDate') ? zp('SoftwareDate').substring(0, 10) : null,
        ipAddress     : zp('IPAddress'),
        macAddress    : zp('MACAddress'),
        seriesId      : zp('SeriesID'),
        wifi          : wf('ConnectionTypeString'),   // 'WiFi' | 'Ethernet'
        wifiMode      : wf('WifiModeString'),          // 'STATION_MODE' etc.
        sonosNetPeers : wf('BusyClients'),             // 'NO_SONOSNET_PEERS' or peer list
      });
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  // ── GET /api/v1/sonos/transport-status?ip=X ──────────────────────────
  // Returns current play state + position from a Sonos device via UPnP AVTransport.
  // Used by the server-remote SPA to poll Sonos output mode.
  velvet.get('/api/v1/sonos/transport-status', async (req, res) => {
    const ip = req.query?.ip || config.program?.sonos?.defaultRoom?.ip;
    if (!ip) return res.status(400).json({ error: 'ip required' });
    try {
      assertPrivateIp(ip);
      const [transportXml, posXml] = await Promise.all([
        soapCall(ip, 'GetTransportInfo', ''),
        soapCall(ip, 'GetPositionInfo',  ''),
      ]);
      const tag = (xml, t) => { const m = xml.match(new RegExp(`<${t}[^>]*>([^<]+)</${t}>`, 'i')); return m ? m[1].trim() : ''; };
      const parseTime = t => {
        if (!t || t === 'NOT_IMPLEMENTED') return 0;
        const p = t.split(':'); if (p.length < 3) return 0;
        return Number.parseInt(p[0]) * 3600 + Number.parseInt(p[1]) * 60 + Number.parseFloat(p[2]);
      };
      const state = tag(transportXml, 'CurrentTransportState') || 'STOPPED';
      // Parse the current track's embedded DIDL metadata (title/artist/art) so the
      // client can render now-playing for external content (Sonos favourites:
      // Spotify, radio, …) that isn't in Velvet's own queue.
      const trackUri = tag(posXml, 'TrackURI');
      const metaRaw = (posXml.match(/<TrackMetaData[^>]*>([\s\S]*?)<\/TrackMetaData>/i) || [])[1] || '';
      const didl = _decodeXmlEntities(metaRaw);
      const didlTag = t => { const m = didl.match(new RegExp(`<${t}[^>]*>([^<]+)</${t}>`, 'i')); return m ? _decodeXmlEntities(m[1].trim()) : ''; };
      const streamContent = didlTag('r:streamContent');
      res.json({
        playing:  state === 'PLAYING',
        paused:   state === 'PAUSED_PLAYBACK',
        stopped:  state === 'STOPPED',
        state,
        position: parseTime(tag(posXml, 'RelTime')),
        duration: parseTime(tag(posXml, 'TrackDuration')),
        track:    Number.parseInt(tag(posXml, 'Track'), 10) || 0,
        trackUri,
        trackTitle:  didlTag('dc:title') || streamContent || '',
        trackArtist: didlTag('upnp:artist') || didlTag('dc:creator') || (didlTag('dc:title') ? streamContent : '') || '',
        trackAlbum:  didlTag('upnp:album') || '',
        trackArt:    didlTag('upnp:albumArtURI') || '',
      });
    } catch {
      // Any error reaching the Sonos device (timeout, ECONNREFUSED, EHOSTUNREACH,
      // UPnP 500 when idle, network outage) → return a safe stopped state.
      // unreachable:true lets the client distinguish device-offline from device-stopped
      // so it can auto-deactivate cast and fall back to browser audio.
      return res.json({ playing: false, paused: false, stopped: true, state: 'STOPPED', position: 0, duration: 0, unreachable: true });
    }
  });

  // ── GET /api/v1/sonos/sleep?ip=X ─────────────────────────────────────
  // Read the native Sonos sleep-timer state via AVTransport GetRemainingSleepTimerDuration.
  // Response: { ok, active, remaining (secs), generation, raw }
  velvet.get('/api/v1/sonos/sleep', async (req, res) => {
    const ip = req.query?.ip || config.program?.sonos?.defaultRoom?.ip;
    if (!ip) return res.status(400).json({ error: 'ip required' });
    try {
      const resolvedIp = _resolveIp(ip);
      assertPrivateIp(resolvedIp);
      const xml = await soapCall(resolvedIp, 'GetRemainingSleepTimerDuration', '');
      const raw = (xml.match(/<RemainingSleepTimerDuration[^>]*>([^<]*)<\/RemainingSleepTimerDuration>/i) || [])[1] || '';
      const generation = Number.parseInt((xml.match(/<CurrentSleepTimerGeneration[^>]*>([^<]*)<\/CurrentSleepTimerGeneration>/i) || [])[1] || '0', 10) || 0;
      const remaining = timeToSecs(raw);
      res.json({ ok: true, active: remaining > 0, remaining, generation, raw: raw.trim() });
    } catch (e) {
      const msg = String(e.message || e);
      if (e.code === 'EHOSTUNREACH' || e.code === 'ECONNREFUSED' || msg.includes('timeout')) {
        return res.status(503).json({ ok: false, unreachable: true, error: msg });
      }
      res.status(500).json({ ok: false, error: msg });
    }
  });

  // ── POST /api/v1/sonos/sleep ─────────────────────────────────────────
  // Set or clear the native Sonos sleep timer via AVTransport ConfigureSleepTimer.
  // Body: { ip, seconds?: number, minutes?: number, play?: boolean }
  //   seconds/minutes <= 0  → wake (clear timer); if play:true also resume playback
  //   seconds/minutes  > 0  → sleep after that duration
  // ConfigureSleepTimer accepts an ISO8601 HH:MM:SS duration; an empty string cancels it.
  velvet.post('/api/v1/sonos/sleep', async (req, res) => {
    const ip = req.body?.ip || config.program?.sonos?.defaultRoom?.ip;
    if (!ip) return res.status(400).json({ error: 'ip required' });
    const totalSecs = req.body?.seconds != null
      ? Math.floor(Number(req.body.seconds) || 0)
      : Math.floor((Number(req.body?.minutes) || 0) * 60);
    try {
      const resolvedIp = _resolveIp(ip);
      assertPrivateIp(resolvedIp);
      const duration = totalSecs > 0 ? secsToTime(totalSecs) : '';
      await soapCall(resolvedIp, 'ConfigureSleepTimer', `<NewSleepTimerDuration>${duration}</NewSleepTimerDuration>`);
      if (totalSecs <= 0 && req.body?.play === true) {
        try { await soapCall(resolvedIp, 'Play', '<Speed>1</Speed>'); }
        catch (e) { console.info(`[sonos] /sleep wake-play ignored (${resolvedIp}): ${e.message || e}`); }
      }
      // Re-read so the client sees the authoritative device state
      let remaining = totalSecs;
      try {
        const xml = await soapCall(resolvedIp, 'GetRemainingSleepTimerDuration', '');
        const raw = (xml.match(/<RemainingSleepTimerDuration[^>]*>([^<]*)<\/RemainingSleepTimerDuration>/i) || [])[1] || '';
        remaining = timeToSecs(raw);
      } catch { /* keep optimistic value */ }
      console.log(`[sonos] sleep ${totalSecs > 0 ? `→ ${duration}` : 'cleared'}${totalSecs <= 0 && req.body?.play === true ? ' + play' : ''} → ${resolvedIp}`);
      res.json({ ok: true, active: remaining > 0, remaining, requested: totalSecs });
    } catch (e) {
      const msg = String(e.message || e);
      if (msg.includes('HTTP 500') || msg.includes('UPnPError')) {
        return res.json({ ok: true, active: false, remaining: 0, ignored: 'device idle' });
      }
      if (e.code === 'EHOSTUNREACH' || e.code === 'ECONNREFUSED' || msg.includes('timeout')) {
        console.info(`[sonos] /sleep: device offline (${ip}) — ${msg}`);
        return res.status(503).json({ ok: false, unreachable: true, error: msg });
      }
      console.error('[sonos] /sleep error:', e);
      res.status(500).json({ ok: false, error: msg });
    }
  });

  // ── GET /api/v1/sonos/led?ip=X ───────────────────────────────────────
  // Read the status-LED state via DeviceProperties GetLEDState. Returns { ok, state }.
  velvet.get('/api/v1/sonos/led', async (req, res) => {
    const ip = req.query?.ip || config.program?.sonos?.defaultRoom?.ip;
    if (!ip) return res.status(400).json({ error: 'ip required' });
    try {
      const resolvedIp = _resolveIp(ip);
      assertPrivateIp(resolvedIp);
      const xml = await localSoapCall(resolvedIp, '/DeviceProperties/Control', SONOS_DP_SVC, 'GetLEDState', '');
      const state = (xml.match(/<CurrentLEDState[^>]*>([^<]*)<\/CurrentLEDState>/i) || [])[1] || '';
      res.json({ ok: true, state: state.trim() });
    } catch (e) {
      const msg = String(e.message || e);
      if (e.code === 'EHOSTUNREACH' || e.code === 'ECONNREFUSED' || msg.includes('timeout')) {
        return res.status(503).json({ ok: false, unreachable: true, error: msg });
      }
      res.status(500).json({ ok: false, error: msg });
    }
  });

  // ── POST /api/v1/sonos/led ───────────────────────────────────────────
  // Set the status-LED state via DeviceProperties SetLEDState. Body: { ip, state: 'On'|'Off' }.
  // Used as a visual sleep cue — the LED is a persistent global device setting.
  velvet.post('/api/v1/sonos/led', async (req, res) => {
    const ip = req.body?.ip || config.program?.sonos?.defaultRoom?.ip;
    const state = String(req.body?.state || '').toLowerCase() === 'off' ? 'Off' : 'On';
    if (!ip) return res.status(400).json({ error: 'ip required' });
    try {
      const resolvedIp = _resolveIp(ip);
      assertPrivateIp(resolvedIp);
      await localSoapCall(resolvedIp, '/DeviceProperties/Control', SONOS_DP_SVC, 'SetLEDState', `<DesiredLEDState>${state}</DesiredLEDState>`);
      console.log(`[sonos] LED ${state} → ${resolvedIp}`);
      res.json({ ok: true, state });
    } catch (e) {
      const msg = String(e.message || e);
      if (e.code === 'EHOSTUNREACH' || e.code === 'ECONNREFUSED' || msg.includes('timeout')) {
        return res.status(503).json({ ok: false, unreachable: true, error: msg });
      }
      console.error('[sonos] /led error:', e);
      res.status(500).json({ ok: false, error: msg });
    }
  });

  // ── POST /api/v1/sonos/test-play ──────────────────────────────────────
  // TEST ONLY — picks a random MP3 from the library and plays it on the given Sonos device.
  // Body: { ip: '192.168.x.x' }
  velvet.post('/api/v1/sonos/test-play', async (req, res) => {
    const ip = req.body?.ip;
    if (!ip) return res.status(400).json({ error: 'ip required' });

    try {
      // Pick a random MP3 from the DB
      const dbPath = path.join(config.program.storage.dbDirectory, 'velvet.sqlite');
      const db = new DatabaseSync(dbPath);
      const row = db.prepare(
        `SELECT vpath, filepath, title, artist, album FROM files
         WHERE format = 'mp3'
         ORDER BY RANDOM() LIMIT 1`
      ).get();
      db.close();

      if (!row) return res.status(404).json({ error: 'No MP3 files in library' });

      await castTrackToSonos({ track: row, ip, username: req.user.username, req });

      res.json({
        ok:       true,
        title:    row.title  || '(unknown)',
        artist:   row.artist || '(unknown)',
        filepath: `${row.vpath}/${row.filepath}`,
        ip,
      });
    } catch (e) {
      console.error('[sonos] test-play error:', e);
      res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  });

  // ── GET /api/v1/sonos/favorites?ip=X ──────────────────────────────────
  // Returns ALL Sonos "My Favorites" (FV:2) — Sonos Radio stations, Spotify /
  // Apple Music playlists, TuneIn, etc. — each tagged with the originating
  // service so the frontend can group them. Use /radio-favorites for the
  // radio-only subset.
  velvet.get('/api/v1/sonos/favorites', async (req, res) => {
    const ip = req.query?.ip || config.program?.sonos?.defaultRoom?.ip;
    if (!ip) return res.status(400).json({ error: 'ip query param required (or set a default room in admin)' });
    try {
      assertPrivateIp(ip);
      const favorites = await _listSonosFavorites(_resolveIp(ip));
      res.json({ ok: true, favorites, deviceIp: ip });
    } catch (e) {
      console.error('[sonos] /favorites error:', e);
      res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  });

  // ── GET /api/v1/sonos/radio-favorites?ip=X ────────────────────────────
  // Returns the Sonos Radio subset of favorites (Now Trendy, Sonos Presents,
  // Sonos Radio discovery). Kept for the radio picker; see /favorites for all.
  velvet.get('/api/v1/sonos/radio-favorites', async (req, res) => {
    const ip = req.query?.ip || config.program?.sonos?.defaultRoom?.ip;
    if (!ip) return res.status(400).json({ error: 'ip query param required (or set a default room in admin)' });
    try {
      assertPrivateIp(ip);
      const all = await _listSonosFavorites(_resolveIp(ip));
      const radioFavorites = all.filter(f => f.serviceKey === 'sonos-radio' && String(f.type || '').toLowerCase() === 'instantplay');
      res.json({ ok: true, favorites: radioFavorites, deviceIp: ip });
    } catch (e) {
      console.error('[sonos] /radio-favorites error:', e);
      res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  });

  // ── POST /api/v1/sonos/play-favorite ──────────────────────────────────
  // Play any "My Favorites" item by its FV:2 id, regardless of service. Unlike
  // /play-cloud-object (Sonos Radio only), this replays the favorite's own
  // stored <res>/<resMD> — which carries the device's service auth token — so
  // Spotify/Apple Music playlists work. Container favorites are enqueued; single
  // streams are set directly on the transport.
  // Body: { ip, favoriteId }
  velvet.post('/api/v1/sonos/play-favorite', async (req, res) => {
    const ip = req.body?.ip || config.program?.sonos?.defaultRoom?.ip;
    const favoriteId = req.body?.favoriteId;
    if (!ip) return res.status(400).json({ error: 'ip required' });
    if (!favoriteId) return res.status(400).json({ error: 'favoriteId required' });
    try {
      assertPrivateIp(ip);
      const resolvedIp = _resolveIp(ip);
      const fav = (await _listSonosFavorites(resolvedIp)).find(f => f.id === favoriteId);
      if (!fav) return res.status(404).json({ ok: false, error: 'favorite not found' });
      if (!fav.res) return res.status(422).json({ ok: false, error: 'favorite has no playable resource' });

      const resMD = fav.resMD ? _decodeXmlEntities(fav.resMD) : '';
      if (fav.isContainer) {
        await soapCall(resolvedIp, 'RemoveAllTracksFromQueue', '');
        await soapCall(resolvedIp, 'AddURIToQueue', [
          `<EnqueuedURI>${xmlEsc(fav.res)}</EnqueuedURI>`,
          `<EnqueuedURIMetaData>${xmlEsc(resMD)}</EnqueuedURIMetaData>`,
          '<DesiredFirstTrackNumberEnqueued>0</DesiredFirstTrackNumberEnqueued>',
          '<EnqueueAsNext>0</EnqueueAsNext>',
        ].join(''));
        // The queue URI needs the device UUID. Use the cache, else fetch the
        // device description directly (cache may be empty right after a restart).
        let uuid = _cachedRooms.find(r => r.ip === resolvedIp)?.uuid;
        if (!uuid) uuid = (await _fetchDeviceDescription(resolvedIp))?.uuid;
        if (!uuid) return res.status(500).json({ ok: false, error: 'could not resolve device uuid' });
        await soapCall(resolvedIp, 'SetAVTransportURI', [
          `<CurrentURI>x-rincon-queue:${uuid}#0</CurrentURI>`,
          '<CurrentURIMetaData></CurrentURIMetaData>',
        ].join(''));
        await soapCall(resolvedIp, 'Seek', '<Unit>TRACK_NR</Unit><Target>1</Target>');
      } else {
        await soapCall(resolvedIp, 'SetAVTransportURI', [
          `<CurrentURI>${xmlEsc(fav.res)}</CurrentURI>`,
          `<CurrentURIMetaData>${xmlEsc(resMD)}</CurrentURIMetaData>`,
        ].join(''));
      }
      await soapCall(resolvedIp, 'Play', '<Speed>1</Speed>');
      res.json({ ok: true, playing: fav.title, service: fav.service, via: fav.isContainer ? 'queue' : 'transport' });
    } catch (e) {
      console.error('[sonos] /play-favorite error:', e);
      res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  });

  // ── POST /api/v1/sonos/favorite-visibility ────────────────────────────
  // Hide or show a favourite in Velvet's Sonos view. Persisted in config as
  // sonos.hiddenFavorites (a list of stable favourite keys) so the preference
  // applies to all users and survives restarts. Admin only — shared config.
  // Body: { key, hidden }
  velvet.post('/api/v1/sonos/favorite-visibility', async (req, res) => {
    if (!req.user?.admin) return res.status(403).json({ error: 'Admin only' });
    const { key, hidden } = req.body || {};
    if (!key || typeof hidden !== 'boolean') return res.status(400).json({ error: 'key and hidden (boolean) required' });
    try {
      const loadedCfg = await loadFile(config.configFile);
      if (!loadedCfg.sonos) loadedCfg.sonos = {};
      const set = new Set(loadedCfg.sonos.hiddenFavorites || []);
      if (hidden) set.add(key); else set.delete(key);
      loadedCfg.sonos.hiddenFavorites = [...set];
      await saveFile(loadedCfg, config.configFile);
      if (!config.program.sonos) config.program.sonos = {};
      config.program.sonos.hiddenFavorites = loadedCfg.sonos.hiddenFavorites;
      res.json({ ok: true, hiddenFavorites: loadedCfg.sonos.hiddenFavorites });
    } catch (e) {
      console.error('[sonos] /favorite-visibility error:', e);
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  // ── GET /api/v1/sonos/browse-content?ip=X&objectId=Y ────────────────
  // Browse a Sonos ContentDirectory object (e.g., a Sonos Radio station container).
  velvet.get('/api/v1/sonos/browse-content', async (req, res) => {
    const ip = req.query?.ip || config.program?.sonos?.defaultRoom?.ip;
    const objectId = req.query?.objectId;
    if (!ip) return res.status(400).json({ error: 'ip query param required' });
    if (!objectId) return res.status(400).json({ error: 'objectId query param required' });
    
    try {
      assertPrivateIp(ip);
      const browseFlag = req.query?.browseFlag || 'BrowseDirectChildren';
      const startingIndex = Number(req.query?.startingIndex) || 0;
      const requestedCount = Number(req.query?.requestedCount) || 100;
      
      const items = await _browseSonosContentDirectory(ip, objectId, browseFlag, startingIndex, requestedCount);
      
      res.json({ ok: true, objectId, items, totalMatches: items.length });
    } catch (e) {
      console.error('[sonos] /browse-content error:', e);
      res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  });

  // ── POST /api/v1/sonos/play-cloud-object ──────────────────────────────
  // Play a Sonos Radio cloud object on a Sonos device.
  // Body: { ip, cloudObjectId, title, authToken }
  velvet.post('/api/v1/sonos/play-cloud-object', async (req, res) => {
    const ip = req.body?.ip || config.program?.sonos?.defaultRoom?.ip;
    const cloudObjectId = req.body?.cloudObjectId;
    const title = req.body?.title || 'Sonos Radio';
    const authToken = req.body?.authToken || null;
    
    if (!ip) return res.status(400).json({ error: 'ip required' });
    if (!cloudObjectId) return res.status(400).json({ error: 'cloudObjectId required' });
    
    try {
      assertPrivateIp(ip);
      const resolvedIp = _resolveIp(ip);

      // First attempt: direct Sonos Radio URI transport for station-like IDs.
      // This path is more reliable for 100c2068sonos:* IDs than transient SMAPI stream URLs.
      try {
        const sidCandidates = ['303', _extractServiceIdFromAuthToken(authToken)].filter(Boolean);
        const sidUnique = [...new Set(sidCandidates)];
        const radioDidl = buildSonosRadioDirectDidl(cloudObjectId, title, authToken);
        const cloudEncoded = encodeURIComponent(String(cloudObjectId || ''));
        const cloudCandidates = [String(cloudObjectId || ''), cloudEncoded].filter(Boolean);
        const flagsCandidates = ['32', '8224', '8300'];
        const snCandidates = ['0', '1', '9'];

        const _tryDirectMatrix = async () => {
          for (const sid of sidUnique) {
            for (const cloudVal of cloudCandidates) {
              for (const flags of flagsCandidates) {
                for (const sn of snCandidates) {
                  const directUri = `x-sonosapi-radio:${cloudVal}?sid=${sid}&flags=${flags}&sn=${sn}`;
                  try {
                    await soapCall(resolvedIp, 'SetAVTransportURI', [
                      `<CurrentURI>${xmlEsc(directUri)}</CurrentURI>`,
                      `<CurrentURIMetaData>${xmlEsc(radioDidl)}</CurrentURIMetaData>`,
                    ].join(''));
                    await soapCall(resolvedIp, 'Play', '<Speed>1</Speed>');
                    return directUri;
                  } catch {
                    // Try next direct URI variant.
                  }
                }
              }
            }
          }
          return null;
        };

        // First pass
        let directUri = await _tryDirectMatrix();
        if (!directUri) {
          // Transient Sonos busy state while changing stations; retry once.
          await new Promise((r) => setTimeout(r, 700));
          directUri = await _tryDirectMatrix();
        }
        if (directUri) {
          return res.json({ ok: true, playing: directUri, via: 'direct-radio' });
        }
      } catch {
        // Fall through to SMAPI/legacy paths.
      }

      // Second attempt: authenticated SMAPI resolution for DeviceLink shortcuts.
      // On Sonos Radio this can resolve cloud shortcut IDs to a playable URI.
      try {
        const playableUri = await _resolveCloudPlayableUriViaSmapi(resolvedIp, cloudObjectId, authToken);
        if (playableUri) {
          try {
            await soapCall(resolvedIp, 'SetAVTransportURI', [
              `<CurrentURI>${xmlEsc(playableUri)}</CurrentURI>`,
              '<CurrentURIMetaData></CurrentURIMetaData>',
            ].join(''));
            await soapCall(resolvedIp, 'Play', '<Speed>1</Speed>');
            return res.json({ ok: true, playing: playableUri, via: 'smapi' });
          } catch (transportErr) {
            console.info('[sonos] SMAPI URI transport fallback:', String(transportErr?.message || transportErr));
          }
        }
      } catch (smapiErr) {
        // Keep fallback behavior for devices/services where SMAPI credentials are unavailable.
        console.info('[sonos] SMAPI shortcut resolution fallback:', String(smapiErr?.message || smapiErr));
      }
      
      // Build DIDL-Lite with the cloud object reference
      const didl = buildSonosCloudDidl(cloudObjectId, title, authToken);
      
      // Use the cloud object ID as the URI
      const queueUri = cloudObjectId;
      
      await soapCall(resolvedIp, 'RemoveAllTracksFromQueue', '');
      await soapCall(resolvedIp, 'AddURIToQueue', [
        `<EnqueuedURI>${xmlEsc(cloudObjectId)}</EnqueuedURI>`,
        `<EnqueuedURIMetaData>${xmlEsc(didl)}</EnqueuedURIMetaData>`,
        '<DesiredFirstTrackNumberEnqueued>1</DesiredFirstTrackNumberEnqueued>',
        '<EnqueueAsNext>1</EnqueueAsNext>',
      ].join(''));
      
      await soapCall(resolvedIp, 'SetAVTransportURI', [
        `<CurrentURI>${xmlEsc(cloudObjectId)}</CurrentURI>`,
        `<CurrentURIMetaData>${xmlEsc(didl)}</CurrentURIMetaData>`,
      ].join(''));
      await soapCall(resolvedIp, 'Seek', '<Unit>TRACK_NR</Unit><Target>1</Target>');
      await soapCall(resolvedIp, 'Play', '<Speed>1</Speed>');
      
      res.json({ ok: true, playing: cloudObjectId });
    } catch (e) {
      const msg = String(e.message ?? e);
      const code = e?.code || (msg.match(/\bcode=(\d+)\b/) || [])[1] || null;

      // Sonos cloud shortcuts are visible in favorites, but some devices/firmware
      // reject direct AVTransport queueing for these IDs (714/800). Return a
      // handled response so the frontend can show a clear UX message instead of
      // browser-level failed-resource noise.
      if (code === '714' || code === '800') {
        const reason = code === '714'
          ? 'This Sonos shortcut cannot be opened via local AVTransport (error 714).'
          : 'This Sonos cloud shortcut cannot be queued directly on this device (error 800).';
        // Expected on some Sonos cloud shortcuts. Return a handled response
        // without noisy server logs on every click.
        return res.json({ ok: false, unsupported: true, code, error: reason });
      }

      console.error('[sonos] /play-cloud-object error:', e);
      res.status(500).json({ ok: false, error: msg });
    }
  });

  // ── Helper: Browse Sonos ContentDirectory ──────────────────────────────
  /**
   * Browse a Sonos device's ContentDirectory service.
   * Returns array of items/containers with parsed metadata.
   */
  // Browse the local queue (Q:0) and return the list of <res> stream URIs.
  // Used to decide whether a queue belongs to Velvet before wiping it.
  async function _sonosQueueResUris(ip) {
    const body = [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"',
      ' s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">',
      '<s:Body>',
      '<u:Browse xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1">',
      '<ObjectID>Q:0</ObjectID><BrowseFlag>BrowseDirectChildren</BrowseFlag>',
      '<Filter>*</Filter><StartingIndex>0</StartingIndex><RequestedCount>200</RequestedCount>',
      '<SortCriteria></SortCriteria>',
      '</u:Browse></s:Body></s:Envelope>',
    ].join('');
    const data = await new Promise((resolve, reject) => {
      const hreq = http.request({
        hostname: ip, port: 1400, path: '/MediaServer/ContentDirectory/Control', method: 'POST',
        headers: { 'Content-Type': 'text/xml; charset="utf-8"', 'Content-Length': Buffer.byteLength(body), soapaction: '"urn:schemas-upnp-org:service:ContentDirectory:1#Browse"' },
      }, hres => {
        let d = ''; hres.on('data', c => d += c);
        hres.on('end', () => hres.statusCode >= 400
          ? reject(Object.assign(new Error('Sonos Browse HTTP ' + hres.statusCode), { code: hres.statusCode }))
          : resolve(d));
      });
      hreq.on('error', reject);
      hreq.setTimeout(6000, () => hreq.destroy(new Error('Sonos Browse timeout')));
      hreq.write(body); hreq.end();
    });
    const m = data.match(/<Result>(.*?)<\/Result>/s);
    if (!m) return [];
    const didl = m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    const uris = [];
    const rx = /<res[^>]*>([^<]+)<\/res>/g;
    let r; while ((r = rx.exec(didl)) !== null) uris.push(r[1].trim());
    return uris;
  }

  // Browse FV:2 and return every "My Favorites" entry, enriched with a service
  // tag and the playable <res>/<resMD> needed by /play-favorite. resMD is filled
  // in via a per-item BrowseMetadata only when the list browse omitted it.
  async function _listSonosFavorites(ip) {
    const items = await _browseSonosContentDirectory(ip, 'FV:2', 'BrowseDirectChildren', 0, 100);
    const hiddenSet = new Set(config.program?.sonos?.hiddenFavorites || []);
    const out = [];
    for (const item of items) {
      let full = item;
      if (!full.res || !full.resMD) {
        const meta = await _browseSonosContentDirectory(ip, item.id, 'BrowseMetadata', 0, 1);
        full = meta[0] || item;
      }
      const description = full.description || item.description || '';
      const serviceKey = String(description).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unknown';
      const upnpClass = full.contentClass || full.upnpClass || null;
      const isContainer = String(upnpClass || '').includes('container') || !!full.isContainer;
      const cloudObjectId = full.cloudObjectId || null;
      // Stable across favourite reordering — FV:2/N ids shift when favourites
      // are added/removed, so hide preferences key off the content id instead.
      const key = cloudObjectId || full.res || item.res || full.contentTitle || _decodeXmlEntities(full.title || item.title || '') || (full.id || item.id);
      out.push({
        id: full.id || item.id,
        localId: String(full.id || item.id || '').split('/').pop(),
        key,
        title: full.contentTitle || _decodeXmlEntities(full.title || item.title || ''),
        description,
        service: description || 'Unknown',
        serviceKey,
        type: full.type || item.type || null,
        upnpClass,
        isContainer,
        cloudObjectId,
        authToken: full.authToken || null,
        artUri: full.artUri || item.artUri || null,
        res: full.res || item.res || null,
        resMD: full.resMD || item.resMD || null,
        parentId: full.parentID || item.parentID || null,
        hidden: hiddenSet.has(key),
      });
    }
    return out;
  }

  async function _browseSonosContentDirectory(ip, objectId, browseFlag, startingIndex, requestedCount) {
    const body = [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"',
      ' s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">',
      '<s:Body>',
      `<u:Browse xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1">`,
      `<ObjectID>${xmlEsc(objectId)}</ObjectID>`,
      `<BrowseFlag>${browseFlag}</BrowseFlag>`,
      '<Filter>*</Filter>',
      `<StartingIndex>${startingIndex}</StartingIndex>`,
      `<RequestedCount>${requestedCount}</RequestedCount>`,
      '<SortCriteria></SortCriteria>',
      '</u:Browse>',
      '</s:Body></s:Envelope>',
    ].join('');
    
    const resp = await new Promise((resolve, reject) => {
      const reqOpts = {
        hostname: ip, port: 1400,
        path: '/MediaServer/ContentDirectory/Control',
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset="utf-8"',
          'Content-Length': Buffer.byteLength(body),
          'soapaction': '"urn:schemas-upnp-org:service:ContentDirectory:1#Browse"',
        },
      };
      const hreq = http.request(reqOpts, hres => {
        let data = '';
        hres.on('data', c => data += c);
        hres.on('end', () => {
          if (hres.statusCode >= 400) {
            reject(new Error(`Sonos Browse HTTP ${hres.statusCode}: ${data.slice(0, 200)}`));
          } else {
            resolve(data);
          }
        });
      });
      hreq.on('error', reject);
      hreq.setTimeout(6000, () => { hreq.destroy(new Error('Sonos Browse timeout')); });
      hreq.write(body);
      hreq.end();
    });
    
    // Parse the DIDL-Lite from the Result
    const resultMatch = resp.match(/<Result>(.*?)<\/Result>/s);
    if (!resultMatch) return [];
    
    const didl = resultMatch[1]
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&');
    
    // Parse items from DIDL-Lite
    const items = [];
    const itemRegex = /<item[^>]*id="([^"]+)"[^>]*>(.*?)<\/item>/gs;
    const containerRegex = /<container[^>]*id="([^"]+)"[^>]*>(.*?)<\/container>/gs;
    
    let match;
    while ((match = itemRegex.exec(didl)) !== null) {
      const id = match[1];
      const inner = match[2];
      const item = _parseDidlItem(id, inner, 'item');
      if (item) items.push(item);
    }
    
    while ((match = containerRegex.exec(didl)) !== null) {
      const id = match[1];
      const inner = match[2];
      const item = _parseDidlItem(id, inner, 'container');
      if (item) items.push(item);
    }
    
    return items;
  }

  /**
   * Parse a DIDL-Lite item or container element.
   */
  function _parseDidlItem(id, innerXml, type) {
    const titleMatch = innerXml.match(/<dc:title>([^<]+)<\/dc:title>/);
    const classMatch = innerXml.match(/<upnp:class>([^<]+)<\/upnp:class>/);
    const parentMatch = innerXml.match(/parentID="([^"]+)"/);
    const restrictedMatch = innerXml.match(/restricted="([^"]+)"/);
    const artMatch = innerXml.match(/<upnp:albumArtURI[^>]*>([^<]+)<\/upnp:albumArtURI>/i);
    const resMatch = innerXml.match(/<res[^>]*>([^<]+)<\/res>/i);
    
    // Extract Sonos-specific fields
    const sonosTypeMatch = innerXml.match(/<r:type>([^<]+)<\/r:type>/);
    const descriptionMatch = innerXml.match(/<r:description>([^<]+)<\/r:description>/);
    
    // Extract resMD if present
    const resMDMatch = innerXml.match(/<r:resMD>(.*?)<\/r:resMD>/s);
    
    if (!titleMatch) return null;
    
    const resMD = resMDMatch ? resMDMatch[1] : null;
    const resMDDecoded = _decodeXmlEntities(resMD || '');
    const cloudIdMatch = resMDDecoded.match(/\bid="([^"]+)"/i);
    const tokenMatch = resMDDecoded.match(/<desc[^>]*>([^<]+)<\/desc>/i);
    const innerClassMatch = resMDDecoded.match(/<upnp:class>([^<]+)<\/upnp:class>/i);
    const innerTitleMatch = resMDDecoded.match(/<dc:title>([^<]+)<\/dc:title>/i);
    const innerArtMatch = resMDDecoded.match(/<upnp:albumArtURI[^>]*>([^<]+)<\/upnp:albumArtURI>/i);

    let cloudObjectId = null;
    if (cloudIdMatch?.[1]) {
      try { cloudObjectId = decodeURIComponent(cloudIdMatch[1]); }
      catch { cloudObjectId = cloudIdMatch[1]; }
    }

    return {
      id,
      parentID: parentMatch ? parentMatch[1] : null,
      title: _decodeXmlEntities(titleMatch[1]),
      upnpClass: classMatch ? classMatch[1] : `object.${type}`,
      restricted: restrictedMatch ? restrictedMatch[1] === 'true' : false,
      type: sonosTypeMatch ? sonosTypeMatch[1] : null,
      description: descriptionMatch ? _decodeXmlEntities(descriptionMatch[1]) : null,
      res: resMatch ? _decodeXmlEntities(resMatch[1]) : null,
      resMD,
      cloudObjectId,
      authToken: tokenMatch ? _decodeXmlEntities(tokenMatch[1]) : null,
      artUri: innerArtMatch?.[1] ? _decodeXmlEntities(innerArtMatch[1]) : (artMatch?.[1] ? _decodeXmlEntities(artMatch[1]) : null),
      contentClass: innerClassMatch?.[1] ? _decodeXmlEntities(innerClassMatch[1]) : null,
      contentTitle: innerTitleMatch?.[1] ? _decodeXmlEntities(innerTitleMatch[1]) : null,
      isContainer: type === 'container' || (classMatch && classMatch[1].includes('container')),
    };
  }

  function _decodeXmlEntities(value) {
    return String(value || '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&');
  }

  /**
   * Build DIDL-Lite for a Sonos Radio cloud object.
   */
  function buildSonosCloudDidl(objectId, title, authToken) {
    const tokenTag = authToken ? `<desc id="cdudn" nameSpace="urn:schemas-rinconnetworks-com:metadata-1-0/">${xmlEsc(authToken)}</desc>` : '';
    return [
      '<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/"',
      ' xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"',
      ' xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/"',
      ' xmlns:dlna="urn:schemas-dlna-org:metadata-1-0/"',
      ' xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/">',
      '<item id="1" restricted="1" parentID="0">',
      `<dc:title>${xmlEsc(title)}</dc:title>`,
      '<upnp:class>object.item.audioItem.musicTrack</upnp:class>',
      `<res protocolInfo="x-rincon-queue:#${xmlEsc(objectId)}">${xmlEsc(objectId)}</res>`,
      tokenTag,
      '</item></DIDL-Lite>',
    ].join('');
  }

  function buildSonosRadioDirectDidl(objectId, title, authToken) {
    const tokenTag = authToken
      ? `<desc id="cdudn" nameSpace="urn:schemas-rinconnetworks-com:metadata-1-0/">${xmlEsc(authToken)}</desc>`
      : '';
    return [
      '<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/"',
      ' xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"',
      ' xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/"',
      ' xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/">',
      `<item id="${xmlEsc(objectId)}" parentID="${xmlEsc(objectId)}" restricted="1">`,
      `<dc:title>${xmlEsc(title || 'Sonos Radio')}</dc:title>`,
      '<upnp:class>object.item.audioItem.audioBroadcast</upnp:class>',
      tokenTag,
      '</item></DIDL-Lite>',
    ].join('');
  }
}
