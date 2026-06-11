/**
 * DLNA / UPnP MediaServer for Velvet — full feature implementation
 *
 * Protocol support
 * ─────────────────
 * ContentDirectory 1.0  — Browse, Search, GetSearchCapabilities,
 *                          GetSortCapabilities, GetSystemUpdateID,
 *                          X_GetFeatureList (Samsung BASICVIEW shortcut)
 * ConnectionManager 1.0 — GetProtocolInfo, GetCurrentConnectionIDs,
 *                          GetCurrentConnectionInfo
 * GENA events           — real SUBSCRIBE/NOTIFY per service, per-subscriber
 *                          seq numbers, expiry management
 * SSDP                  — raw dgram (no npm dep), UPnP 1.1 BOOTID/CONFIGID,
 *                          MX-delayed M-SEARCH responses, ssdp:byebye on stop
 * TimeSeekRange         — ffmpeg-based seek for AV receivers (Sony, Marantz…)
 * protocolInfo          — proper DLNA.ORG_PN / DLNA.ORG_OP / DLNA.ORG_FLAGS
 *
 * Browse hierarchy
 * ─────────────────
 *   Root (0)
 *   └── Music (music)
 *       ├── [VPath] (lib-<b64>)
 *       │   ├── Folders   (folders-<b64>)    — directory tree
 *       │   ├── Artists   (artists-<b64>)    — artist → albums → tracks
 *       │   ├── Albums    (albums-<b64>)     — flat album list → tracks
 *       │   ├── Genres    (genres-<b64>)     — genre → artists → albums
 *       │   └── All Tracks(tracks-<b64>)     — sortable flat track list
 *       ├── Recently Added (recent)          — last 200 by ts
 *       ├── Most Played    (mostplayed)       — by play_events count
 *       ├── By Year        (years)            — year buckets
 *       └── Playlists      (playlists)        — user playlists
 *
 * Security
 * ─────────
 * The DLNA port (default 10293) serves media without authentication.
 * Never expose it to the internet — LAN only. Documented in docs/dlna.md.
 */

import os     from 'node:os';
import path   from 'node:path';
import fs     from 'node:fs';
import http   from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import express from 'express';
import helmet from 'helmet';
import winston from 'winston';
import Joi    from 'joi';

const require = createRequire(import.meta.url);

import * as config    from '../state/config.js';
import * as db        from '../db/manager.js';
import * as adminUtil from '../util/admin.js';
import { joiValidate } from '../util/validation.js';
import { ffmpegBin }            from '../util/ffmpeg-bootstrap.js';
import { resolveDlnaSources } from './albums-browse.js';

// ── Module state ──────────────────────────────────────────────────────────────

/** @type {import('http').Server|null} */
let _httpServer  = null;
let _running     = false;
let _baseUrl     = '';           // e.g. 'http://192.168.1.10:10293'
/** @type {import('@lvcabral/node-ssdp').Server|null} */
let _ssdpServer  = null;

// ── GENA subscriber registry ──────────────────────────────────────────────────

// keyed by SID string; value: { service, callbacks, expiresAt, seq }
const _subscribers = new Map();
const MAX_SUBSCRIBERS = 256;
const GENA_DEFAULT_TIMEOUT = 1800; // seconds
setInterval(() => { const now = Date.now(); for (const [sid, sub] of _subscribers) { if (sub.expiry < now) _subscribers.delete(sid); } }, 60_000).unref();

// SystemUpdateID — bumped after each scan complete; clients use it to
// invalidate their browse caches. Wraps at 2^32.
let _systemUpdateID = 1;

const MAX_BROWSE_COUNT = 5000; // hard cap per Browse/Search response

// ── Helpers ───────────────────────────────────────────────────────────────────

/** First non-loopback IPv4 address */
function getLanIp() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

function dlnaUuid() {
  return config.program.instanceId || 'velvet-velvet-default';
}

// ── SSDP via node-ssdp ────────────────────────────────────────────────────────

function _startSsdp(port) {
  if (_ssdpServer) return;
  const { Server: SsdpServer } = require('@lvcabral/node-ssdp');
  const uuid = dlnaUuid();
  _ssdpServer = new SsdpServer({
    location:       { port, path: '/dlna/description.xml' },
    udn:            `uuid:${uuid}`,
    ssdpSig:        'Velvet/1.0',
    allowWildcards: true,
  });
  _ssdpServer.addUSN('upnp:rootdevice');
  _ssdpServer.addUSN(`uuid:${uuid}`);
  _ssdpServer.addUSN('urn:schemas-upnp-org:device:MediaServer:1');
  _ssdpServer.addUSN('urn:schemas-upnp-org:service:ContentDirectory:1');
  _ssdpServer.addUSN('urn:schemas-upnp-org:service:ConnectionManager:1');
  return _ssdpServer.start();
}

function _stopSsdp() {
  if (!_ssdpServer) return;
  const s = _ssdpServer;
  _ssdpServer = null;
  try { s.stop(); } catch (e) { console.debug('[velvet]', e?.message ?? e); }
}

// ── XML / SOAP helpers ────────────────────────────────────────────────────────

// XML 1.0 forbids C0 control chars (except \x09 HT, \x0A LF, \x0D CR),
// lone UTF-16 surrogate halves (U+D800–U+DFFF), and the two non-characters
// U+FFFE/U+FFFF. Mojibake-ridden ID3 tags occasionally smuggle these in;
// without stripping them, a rogue \x00 or \uD800 would emit &#x0; / &#xD800;
// and crash strict DIDL parsers on renderers like Plex, Sonos, or LG TVs.
// eslint-disable-next-line no-control-regex
const XML_INVALID_CTRL = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;
const XML_INVALID_SURR = /[\uD800-\uDFFF\uFFFE\uFFFF]/g;

function xmlEsc(s) {
  if (s == null) return '';
  return String(s)
    .replaceAll(XML_INVALID_CTRL, '')
    .replaceAll(XML_INVALID_SURR, '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function xmlUnescape(s) {
  return String(s || '')
    .replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"').replaceAll('&apos;', "'");
}

/** Extract <FieldName> value from SOAP XML body (namespace-agnostic) */
function soapField(xml, field) {
  const m = xml.match(new RegExp(String.raw`<(?:[^:>]+:)?${field}[^>]*>([\s\S]*?)<\/(?:[^:>]+:)?${field}>`, 'i'));
  return m ? xmlUnescape(m[1].trim()) : '';
}

function soapEnvelope(serviceNs, actionName, innerXml) {
  return `<?xml version="1.0" encoding="utf-8"?>\
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"\
            s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">\
  <s:Body>\
    <u:${actionName}Response xmlns:u="${serviceNs}">\
      ${innerXml}\
    </u:${actionName}Response>\
  </s:Body>\
</s:Envelope>`;
}

function soapError(code, description) {
  return `<?xml version="1.0" encoding="utf-8"?>\
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">\
  <s:Body><s:Fault>\
    <faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring>\
    <detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0">\
      <errorCode>${code}</errorCode>\
      <errorDescription>${xmlEsc(description)}</errorDescription>\
    </UPnPError></detail>\
  </s:Fault></s:Body>\
</s:Envelope>`;
}

function sendXml(res, body, status = 200) {
  res.status(status).set('Content-Type', 'text/xml; charset="utf-8"').send(body);
}

// ── MIME / protocolInfo ───────────────────────────────────────────────────────

const DLNA_FLAGS = '01700000000000000000000000000000';

const MIME_MAP = {
  mp3:  { mime: 'audio/mpeg', dlnaProfile: 'MP3' },
  flac: { mime: 'audio/flac', dlnaProfile: 'FLAC' },
  wav:  { mime: 'audio/wav',  dlnaProfile: 'WAV' },
  m4a:  { mime: 'audio/mp4',  dlnaProfile: 'AAC_ISO' },
  m4b:  { mime: 'audio/mp4',  dlnaProfile: 'AAC_ISO' },
  aac:  { mime: 'audio/aac',  dlnaProfile: null },
  ogg:  { mime: 'audio/ogg',  dlnaProfile: null },
  opus: { mime: 'audio/opus', dlnaProfile: null },
  wma:  { mime: 'audio/x-ms-wma', dlnaProfile: 'WMABASE' },
};

function mimeInfo(filepath) {
  const ext = path.extname(String(filepath || '')).replace(/^\./, '').toLowerCase();
  return MIME_MAP[ext] || { mime: 'audio/mpeg', dlnaProfile: null };
}

function protocolInfo(filepath) {
  const info = mimeInfo(filepath);
  const parts = [`DLNA.ORG_OP=11`, `DLNA.ORG_CI=0`, `DLNA.ORG_FLAGS=${DLNA_FLAGS}`];
  if (info.dlnaProfile) parts.unshift(`DLNA.ORG_PN=${info.dlnaProfile}`);
  return `http-get:*:${info.mime}:${parts.join(';')}`;
}

// ── Duration formatting ───────────────────────────────────────────────────────
// Use integer milliseconds to avoid float carry (e.g. 59.9996s → "60.000")

function formatDuration(secs) {
  if (!secs || secs <= 0) return undefined;
  const totalMs = Math.round(secs * 1000);
  const h = Math.floor(totalMs / 3600000);
  const m = Math.floor((totalMs % 3600000) / 60000);
  const s = (totalMs % 60000) / 1000;
  return `${h}:${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`;
}

// ── DIDL-Lite builders ────────────────────────────────────────────────────────

function didlWrapper(items) {
  return `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"\
  xmlns:dc="http://purl.org/dc/elements/1.1/"\
  xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"\
  xmlns:dlna="urn:schemas-dlna-org:metadata-1-0/">${items}</DIDL-Lite>`;
}

function artXml(aaFile) {
  if (!aaFile) return '';
  const artUrl = `${_baseUrl}/album-art/${encodeURIComponent(aaFile)}`;
  return `\n    <upnp:albumArtURI dlna:profileID="JPEG_TN">${xmlEsc(artUrl)}</upnp:albumArtURI>`;
}

function containerXml(id, parentId, title, childCount, upnpClass = 'object.container', aaFile = null) {
  return `  <container id="${xmlEsc(id)}" parentID="${xmlEsc(parentId)}" restricted="1" childCount="${childCount}">${artXml(aaFile)}\n    <dc:title>${xmlEsc(title)}</dc:title>\n    <upnp:class>${upnpClass}</upnp:class>\n  </container>`;
}

function trackItem(track, parentId) {
  const fp  = String(track.filepath || '').split('/').map(encodeURIComponent).join('/');
  const vp  = encodeURIComponent(track.vpath);
  const mediaUrl = `${_baseUrl}/media/${vp}/${fp}`;
  const dur = formatDuration(track.duration);
  const durAttr = dur ? ` duration="${dur}"` : '';
  const sizeAttr = track.filesize ? ` size="${track.filesize}"` : '';
  const title = track.title || path.basename(String(track.filepath), path.extname(String(track.filepath)));
  const isAudioBook = config.program.folders?.[track.vpath]?.type === 'audio-books';
  const itemClass = isAudioBook ? 'object.item.audioItem.audioBook' : 'object.item.audioItem.musicTrack';
  return `  <item id="${xmlEsc(trackId(track.vpath, track.filepath))}" parentID="${xmlEsc(parentId)}" restricted="1">
    <dc:title>${xmlEsc(title)}</dc:title>
    <dc:creator>${xmlEsc(track.artist || '')}</dc:creator>${artXml(track.aaFile)}
    ${track.year ? `<dc:date>${track.year}-01-01</dc:date>\n    <upnp:originalYear>${track.year}</upnp:originalYear>` : ''}
    <upnp:artist>${xmlEsc(track.artist || '')}</upnp:artist>
    <upnp:album>${xmlEsc(track.album || '')}</upnp:album>
    ${track.track ? `<upnp:originalTrackNumber>${track.track}</upnp:originalTrackNumber>` : ''}
    ${track.genre ? `<upnp:genre>${xmlEsc(track.genre)}</upnp:genre>` : ''}
    <upnp:class>${itemClass}</upnp:class>
    <res protocolInfo="${xmlEsc(protocolInfo(track.filepath))}"${durAttr}${sizeAttr}>${xmlEsc(mediaUrl)}</res>
  </item>`;
}

// ── Object ID encoding ────────────────────────────────────────────────────────

function b64e(s) { return Buffer.from(String(s)).toString('base64url'); }
function b64d(s) { try { return Buffer.from(String(s), 'base64url').toString(); } catch { return ''; } }

function _vpathId(vpath)          { return `lib-${b64e(vpath)}`; }
function idToVpath(id)           { return b64d(id.replace(/^lib-/, '')); }

function trackId(vpath, filepath){ return `track-${b64e(vpath + '\x00' + filepath)}`; }
function trackIdDecode(id) {
  const raw = b64d(id.replace(/^track-/, ''));
  const i = raw.indexOf('\x00');
  return i === -1 ? { vpath: '', filepath: raw } : { vpath: raw.slice(0, i), filepath: raw.slice(i + 1) };
}

function _dirId(vpath, relPath)   { return `dir-${b64e(vpath + '\x00' + relPath)}`; }
function _dirIdDecode(id) {
  const raw = b64d(id.replace(/^dir-/, ''));
  const i = raw.indexOf('\x00');
  return i === -1 ? { vpath: '', relPath: raw } : { vpath: raw.slice(0, i), relPath: raw.slice(i + 1) };
}

function _genreId(vpath, genre)   { return `genre-${b64e(vpath + '\x00' + (genre ?? ''))}`; }
function _genreIdDecode(id) {
  const raw = b64d(id.replace(/^genre-/, ''));
  const i = raw.indexOf('\x00');
  return i === -1 ? { vpath: '', genre: raw } : { vpath: raw.slice(0, i), genre: raw.slice(i + 1) };
}

function _playlistId(name, user)  { return `playlist-${b64e(name + '\x00' + user)}`; }
function _playlistIdDecode(id) {
  const raw = b64d(id.replace(/^playlist-/, ''));
  const i = raw.indexOf('\x00');
  return i === -1 ? { name: raw, user: '' } : { name: raw.slice(0, i), user: raw.slice(i + 1) };
}

// ── AlbumsOnly source helpers ─────────────────────────────────────────────────
// Loads all files for each albumsOnly source once, then filters in-memory.
// Uses the same 5-min cache strategy as albums-browse.js.

const _sourceFilesCache = new Map();
const _childrenCache    = new Map();
const SOURCE_FILES_TTL  = 5 * 60 * 1000;

function encSrc(vpathName) {
  return 'src_' + Buffer.from(String(vpathName)).toString('base64url');
}
function decSrc(id) {
  try { return Buffer.from(id.replace(/^src_/, ''), 'base64url').toString(); }
  catch { return null; }
}
function encDir(dbVpath, dirPath) {
  return 'dir_' + Buffer.from(String(dbVpath) + '\x00' + String(dirPath)).toString('base64url');
}
function decDir(id) {
  try {
    const raw = Buffer.from(id.replace(/^dir_/, ''), 'base64url').toString();
    const sep = raw.indexOf('\x00');
    return { dbVpath: raw.slice(0, sep), dirPath: raw.slice(sep + 1) };
  } catch { return { dbVpath: '', dirPath: '' }; }
}

function getSourceFiles(source) {
  const key    = source.dbVpath + '\x00' + (source.prefix || '');
  const cached = _sourceFilesCache.get(key);
  if (cached && Date.now() - cached.ts < SOURCE_FILES_TTL) return cached.files;
  const files = db.getFilesForAlbumsBrowse([{ vpath: source.dbVpath, prefix: source.prefix }]);
  _sourceFilesCache.set(key, { files, ts: Date.now() });
  // Source refresh invalidates child listings derived from previous file set.
  _childrenCache.clear();
  return files;
}

function listChildren(source, parentPrefix) {
  const cacheKey = source.dbVpath + '\x00' + (source.prefix || '') + '\x00' + parentPrefix;
  const cached = _childrenCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < SOURCE_FILES_TTL) return cached.data;

  const files  = getSourceFiles(source);
  const dirMap = new Map();
  const songs  = [];
  const prefixLen = parentPrefix.length;
  for (const row of files) {
    if (parentPrefix && !row.filepath.startsWith(parentPrefix)) continue;
    const rest  = row.filepath.slice(prefixLen);
    const slash = rest.indexOf('/');
    if (slash === -1) songs.push(row);
    else {
      const name = rest.slice(0, slash);
      if (!dirMap.has(name)) {
        dirMap.set(name, { name, sampleFile: null });
      }
      if (!dirMap.get(name).sampleFile && row.aaFile) {
        dirMap.get(name).sampleFile = row;
      }
    }
  }
  const dirs = [...dirMap.values()]
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  const data = { dirs, songs };
  _childrenCache.set(cacheKey, { ts: Date.now(), data });
  return data;
}

// ── Sort / order helpers (used by handleSearch) ───────────────────────────────
export function buildOrderBy(sortTerms, defaultOrder) {
  if (!sortTerms?.length) return defaultOrder;
  const MAP = {
    'dc:title':                 'f.title COLLATE NOCASE',
    'dc:creator':               'f.artist COLLATE NOCASE',
    'upnp:artist':              'f.artist COLLATE NOCASE',
    'upnp:album':               'f.album COLLATE NOCASE',
    'upnp:genre':               'f.genre COLLATE NOCASE',
    'upnp:originalTrackNumber': 'f.track',
    'dc:date':                  'f.year',
    'upnp:originalYear':        'f.year',
    'res@duration':             'f.duration',
  };
  const clauses = sortTerms.map(t => {
    const col = MAP[t.prop];
    if (!col) return null;
    return `${col} ${t.dir === '-' ? 'DESC' : 'ASC'}`;
  }).filter(Boolean);
  return clauses.length ? clauses.join(', ') : defaultOrder;
}

function parseSortCriteria(s) {
  if (!s?.trim()) return [];
  return s.split(',').map(p => {
    const clean = p.trim();
    if (clean.startsWith('+')) return { prop: clean.slice(1), dir: '+' };
    if (clean.startsWith('-')) return { prop: clean.slice(1), dir: '-' };
    return { prop: clean, dir: '+' };
  }).filter(t => t.prop);
}
// ── Search helpers ────────────────────────────────────────────────────────────
const SEARCH_PROP_MAP = {
  'dc:title':                 "COALESCE(f.title, '')",
  'dc:creator':               "COALESCE(f.artist, '')",
  'upnp:artist':              "COALESCE(f.artist, '')",
  'upnp:album':               "COALESCE(f.album, '')",
  'upnp:genre':               "COALESCE(f.genre, '')",
  'upnp:originalTrackNumber': 'f.track',
};

export function tokenizeSearch(input) {
  const tokens = [];
  const re = /"(?:[^"\\]|\\.)*"|!=|<=|>=|[()=!<>]|[\w:.]+/g;
  for (const m of (input || '').matchAll(re)) tokens.push(m[0]);
  return tokens;
}

class SearchParser {
  constructor(tokens) { this.tokens = tokens; this.pos = 0; }
  peek() { return this.tokens[this.pos]; }
  next() { return this.tokens[this.pos++]; }
  parse() { return this.tokens.length ? this.parseOr() : null; }
  parseOr() {
    let left = this.parseAnd();
    while (this.peek()?.toLowerCase() === 'or') { this.next(); left = { op: 'or', left, right: this.parseAnd() }; }
    return left;
  }
  parseAnd() {
    let left = this.parseRelational();
    while (this.peek()?.toLowerCase() === 'and') { this.next(); left = { op: 'and', left, right: this.parseRelational() }; }
    return left;
  }
  parseRelational() {
    if (this.peek() === '(') { this.next(); const n = this.parseOr(); if (this.peek() === ')') { this.next(); } return n; }
    const property = this.next();
    const relOp    = this.next();
    let value = this.next() || '';
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    return { op: 'rel', property, relOp: relOp?.toLowerCase(), value };
  }
}

export function searchNodeToSql(node, params) {
  if (!node) return '1=1';
  if (node.op === 'and') return `(${searchNodeToSql(node.left, params)} AND ${searchNodeToSql(node.right, params)})`;
  if (node.op === 'or')  return `(${searchNodeToSql(node.left, params)} OR ${searchNodeToSql(node.right, params)})`;
  if (node.op === 'rel') {
    const { property, relOp, value } = node;
    if (property === 'upnp:class') {
      if (relOp === 'exists') return value === 'true' ? '1=1' : '1=0';
      if (relOp === '=' || relOp === 'derivedfrom') {
        return (value.includes('audioItem') || value === '*') ? '1=1' : '1=0';
      }
      return '1=1';
    }
    const col = SEARCH_PROP_MAP[property];
    if (!col) return '1=1';
    const esc = value.replaceAll('\\', String.raw`\\`).replaceAll('%', String.raw`\%`).replaceAll('_', String.raw`\_`);
    switch (relOp) {
      case '=':            params.push(value);         return `${col} = ?`;
      case '!=':           params.push(value);         return `${col} != ?`;
      case 'contains':     params.push(`%${esc}%`);    return String.raw`${col} LIKE ? ESCAPE '\'`;
      case 'doesnotcontain': params.push(`%${esc}%`);  return String.raw`(${col} NOT LIKE ? ESCAPE '\')`;
      case 'startswith':   params.push(`${esc}%`);     return String.raw`${col} LIKE ? ESCAPE '\'`;
      case 'exists':       return value === 'true' ? `${col} IS NOT NULL` : `${col} IS NULL`;
      default:             return '1=1';
    }
  }
  return '1=1';
}

function _normText(v) {
  return (v ?? '').toString().toLowerCase();
}

function _numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function _searchValue(row, property) {
  switch (property) {
    case 'dc:title':
      return row.title;
    case 'dc:creator':
    case 'upnp:artist':
      return row.artist;
    case 'upnp:album':
      return row.album;
    case 'upnp:genre':
      return row.genre;
    case 'upnp:originalTrackNumber':
      return row.track;
    default:
      return null;
  }
}

function _evalSearchRel(row, property, relOp, value) {
  if (property === 'upnp:class') {
    if (relOp === 'exists') return value === 'true';
    if (relOp === '=' || relOp === 'derivedfrom') {
      return value.includes('audioItem') || value === '*';
    }
    return true;
  }

  const current = _searchValue(row, property);
  if (current === null && property !== 'upnp:originalTrackNumber') {
    if (relOp === 'exists') return value !== 'true';
    return relOp === 'doesnotcontain';
  }

  if (property === 'upnp:originalTrackNumber') {
    const curNum = _numOrNull(current);
    const valNum = _numOrNull(value);
    switch (relOp) {
      case '=':
        return curNum !== null && valNum !== null && curNum === valNum;
      case '!=':
        return curNum === null || valNum === null || curNum !== valNum;
      case 'exists':
        return value === 'true' ? curNum !== null : curNum === null;
      default:
        return true;
    }
  }

  const lhs = _normText(current);
  const rhs = _normText(value);
  switch (relOp) {
    case '=':
      return lhs === rhs;
    case '!=':
      return lhs !== rhs;
    case 'contains':
      return lhs.includes(rhs);
    case 'doesnotcontain':
      return !lhs.includes(rhs);
    case 'startswith':
      return lhs.startsWith(rhs);
    case 'exists':
      return value === 'true' ? current !== null && current !== undefined : current === null || current === undefined;
    default:
      return true;
  }
}

function _evalSearchAst(row, node) {
  if (!node) return true;
  if (node.op === 'and') return _evalSearchAst(row, node.left) && _evalSearchAst(row, node.right);
  if (node.op === 'or') return _evalSearchAst(row, node.left) || _evalSearchAst(row, node.right);
  if (node.op === 'rel') return _evalSearchRel(row, node.property, node.relOp, node.value);
  return true;
}

function _sortVal(row, prop) {
  switch (prop) {
    case 'dc:title':
      return row.title ?? '';
    case 'dc:creator':
    case 'upnp:artist':
      return row.artist ?? '';
    case 'upnp:album':
      return row.album ?? '';
    case 'upnp:genre':
      return row.genre ?? '';
    case 'upnp:originalTrackNumber':
      return _numOrNull(row.track) ?? -1;
    case 'dc:date':
    case 'upnp:originalYear':
      return _numOrNull(row.year) ?? -1;
    case 'res@duration':
      return _numOrNull(row.duration) ?? -1;
    default:
      return '';
  }
}

function _compareSort(a, b, sortTerms) {
  const terms = sortTerms?.length ? sortTerms : [{ prop: 'dc:title', dir: '+' }];
  for (const term of terms) {
    const dir = term.dir === '-' ? -1 : 1;
    const av = _sortVal(a, term.prop);
    const bv = _sortVal(b, term.prop);
    if (typeof av === 'number' && typeof bv === 'number') {
      if (av !== bv) return (av - bv) * dir;
      continue;
    }
    const cmp = String(av).localeCompare(String(bv), undefined, { sensitivity: 'base' });
    if (cmp !== 0) return cmp * dir;
  }
  return 0;
}

// ── Pagination helper ─────────────────────────────────────────────────────────
function _paginate(arr, start, count) {
  return count > 0 ? arr.slice(start, start + count) : arr.slice(start);
}

// ── Browse response builder ───────────────────────────────────────────────────
function sendBrowse(res, didl, returned, total) {
  const xml = soapEnvelope(CDS_NS, 'Browse', `<Result>${xmlEsc(didlWrapper(didl))}</Result><NumberReturned>${returned}</NumberReturned><TotalMatches>${total}</TotalMatches><UpdateID>${_systemUpdateID}</UpdateID>`);
  sendXml(res, xml);
}

const CDS_NS = 'urn:schemas-upnp-org:service:ContentDirectory:1';
const CM_NS  = 'urn:schemas-upnp-org:service:ConnectionManager:1';

// ── View layout ───────────────────────────────────────────────────────────────
// Main browse handler — per-vpath DLNA source tree
// Root -> DLNA-enabled sources -> directory tree -> songs
async function handleBrowse(body, res) {
  const objectId   = soapField(body, 'ObjectID') || '0';
  const browseFlag = soapField(body, 'BrowseFlag') || 'BrowseDirectChildren';
  const startIdx   = Math.max(0, Number.parseInt(soapField(body, 'StartingIndex') || '0', 10) || 0);
  const rawCount   = Math.max(0, Number.parseInt(soapField(body, 'RequestedCount') || '0', 10) || 0);
  const reqCount   = rawCount === 0 ? MAX_BROWSE_COUNT : Math.min(rawCount, MAX_BROWSE_COUNT);
  const sources    = await resolveDlnaSources();
  const pg         = arr => arr.slice(startIdx, startIdx + reqCount);

  if (objectId === '0')              return _browseRoot(res, browseFlag, sources, pg);
  if (objectId.startsWith('src_'))   return _browseSrc(res, objectId, browseFlag, sources, pg);
  if (objectId.startsWith('dir_'))   return _browseDir(res, objectId, browseFlag, sources, pg);
  if (objectId.startsWith('track-')) return _browseTrack(res, objectId);
  return sendXml(res, soapError(701, 'No Such Object'), 500);
}

function _browseRoot(res, browseFlag, sources, pg) {
  if (browseFlag === 'BrowseMetadata') {
    return sendBrowse(res, containerXml('0', '-1', config.program.dlna?.name || 'Velvet', sources.length), 1, 1);
  }
  const all = sources.map(s => {
    const srcType  = config.program.folders?.[s.vpathName]?.type || config.program.folders?.[s.dbVpath]?.type || 'music';
    const libClass = srcType === 'audio-books' ? 'object.container.album.audioBook' : 'object.container.storageFolder';
    return containerXml(encSrc(s.vpathName), '0', s.vpathName, -1, libClass);
  });
  const slice = pg(all);
  return sendBrowse(res, slice.join(''), slice.length, all.length);
}

function _browseSrc(res, objectId, browseFlag, sources, pg) {
  const vpathName = decSrc(objectId);
  const source    = sources.find(s => s.vpathName === vpathName);
  if (!source) return sendXml(res, soapError(701, 'No Such Object'), 500);
  if (browseFlag === 'BrowseMetadata') {
    return sendBrowse(res, containerXml(objectId, '0', vpathName, -1), 1, 1);
  }
  const srcPrefix = source.prefix || '';
  const { dirs, songs } = listChildren(source, srcPrefix);
  const all = [
    ...dirs.map(d => containerXml(
      encDir(source.dbVpath, srcPrefix + d.name), objectId, d.name, -1,
      'object.container.storageFolder',
      d.sampleFile?.aaFile ? d.sampleFile.aaFile : null
    )),
    ...songs.map(t => trackItem(t, objectId)),
  ];
  const slice = pg(all);
  return sendBrowse(res, slice.join(''), slice.length, all.length);
}

function _browseDir(res, objectId, browseFlag, sources, pg) {
  const { dbVpath, dirPath } = decDir(objectId);
  if (!dbVpath || !dirPath) return sendXml(res, soapError(701, 'No Such Object'), 500);
  const source = sources.find(s => s.dbVpath === dbVpath && dirPath.startsWith(s.prefix || ''));
  if (!source) return sendXml(res, soapError(701, 'No Such Object'), 500);
  if (browseFlag === 'BrowseMetadata') {
    return sendBrowse(res, containerXml(objectId, '-1', path.basename(dirPath), -1), 1, 1);
  }
  const dirPrefix = dirPath + '/';
  const { dirs, songs } = listChildren(source, dirPrefix);
  const all = [
    ...dirs.map(d => containerXml(
      encDir(dbVpath, dirPrefix + d.name), objectId, d.name, -1,
      'object.container.storageFolder',
      d.sampleFile?.aaFile ? d.sampleFile.aaFile : null
    )),
    ...songs.map(t => trackItem(t, objectId)),
  ];
  const slice = pg(all);
  return sendBrowse(res, slice.join(''), slice.length, all.length);
}

function _browseTrack(res, objectId) {
  const { vpath, filepath } = trackIdDecode(objectId);
  const row = db.getDB().prepare(
    'SELECT title, artist, album, year, genre, filepath, vpath, aaFile, duration, track, disk, hash FROM files WHERE vpath=? AND filepath=? LIMIT 1'
  ).get(vpath, filepath);
  if (!row) return sendXml(res, soapError(701, 'No Such Object'), 500);
  return sendBrowse(res, trackItem(row, '-1'), 1, 1);
}

// ── Search handler ────────────────────────────────────────────────────────────
function handleSearch(body, res) {
  const containerId = soapField(body, 'ContainerID') || '0';
  const criteria    = soapField(body, 'SearchCriteria');
  const startIdx    = Math.max(0, Number.parseInt(soapField(body, 'StartingIndex') || '0', 10) || 0);
  const rawCount    = Math.max(0, Number.parseInt(soapField(body, 'RequestedCount') || '0', 10) || 0);
  const reqCount    = rawCount === 0 ? MAX_BROWSE_COUNT : Math.min(rawCount, MAX_BROWSE_COUNT);
  const sortTerms   = parseSortCriteria(soapField(body, 'SortCriteria'));

  // Limit search scope to a specific vpath if ID is a lib-xx container.
  let scopedVpath = null;
  if (containerId !== '0' && containerId !== 'music') {
    const m = /^lib-(.+)$/.exec(containerId);
    if (m) scopedVpath = idToVpath(containerId);
  }

  let ast = null;
  if (criteria && criteria.trim() !== '*') {
    try {
      ast = new SearchParser(tokenizeSearch(criteria)).parse();
    } catch {
      ast = null;
    }
  }

  // Keep SQL fixed/parameterized; apply parsed criteria and sort in-memory.
  const raw = db.getDB();
  const scopedRows = raw.prepare(`
    SELECT f.title, f.artist, f.album, f.year, f.genre, f.filepath, f.vpath,
           f.aaFile, f.duration, f.track, f.disk, f.hash
    FROM files f
    WHERE (? IS NULL OR f.vpath = ?)
  `).all(scopedVpath, scopedVpath);

  const filtered = ast ? scopedRows.filter(r => _evalSearchAst(r, ast)) : scopedRows;
  filtered.sort((a, b) => _compareSort(a, b, sortTerms));

  const total = filtered.length;
  const rows = reqCount > 0
    ? filtered.slice(startIdx, startIdx + reqCount)
    : filtered.slice(startIdx);

  const xml = soapEnvelope(CDS_NS, 'Search',
    `<Result>${xmlEsc(didlWrapper(rows.map(t => trackItem(t, containerId)).join('')))}</Result>` +
    `<NumberReturned>${rows.length}</NumberReturned>` +
    `<TotalMatches>${total}</TotalMatches>` +
    `<UpdateID>${_systemUpdateID}</UpdateID>`
  );
  sendXml(res, xml);
}

// ── GENA subscription management ─────────────────────────────────────────────

function _genaCleanExpired() {
  const now = Date.now();
  for (const [sid, sub] of _subscribers) {
    if (sub.expiry < now) _subscribers.delete(sid);
  }
}

function _sendNotify(sub, seq, xml) {
  return new Promise(resolve => {
    try {
      const u = new URL(sub.callback);
      const body = Buffer.from(xml, 'utf8');
      const req = http.request({
        hostname: u.hostname,
        port:     u.port || 80,
        path:     u.pathname + u.search,
        method:   'NOTIFY',
        headers: {
          'Content-Type':  'text/xml; charset="utf-8"',
          'Content-Length': body.length,
          'NT':            'upnp:event',
          'NTS':           'upnp:propchange',
          'SID':           sub.sid,
          'SEQ':           seq,
        },
        timeout: 5000,
      }, () => resolve());
      req.on('error', () => resolve());
      req.on('timeout', () => { req.destroy(); resolve(); });
      req.write(body);
      req.end();
    } catch { resolve(); }
  });
}

async function _notifySubscribers() {
  _genaCleanExpired();
  if (_subscribers.size === 0) return;
  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<e:propertyset xmlns:e="urn:schemas-upnp-org:event-1-0">' +
    '<e:property><SystemUpdateID>' + _systemUpdateID + '</SystemUpdateID></e:property>' +
    '<e:property><ContainerUpdateIDs></ContainerUpdateIDs></e:property>' +
    '</e:propertyset>';
  for (const [, sub] of _subscribers) {
    const seq = sub.seq++;
    _sendNotify(sub, seq, xml).catch(() => {});
  }
}

function _registerSubscriber(callback, timeoutSecs) {
  _genaCleanExpired();
  if (_subscribers.size >= MAX_SUBSCRIBERS) {
    // Evict oldest
    const oldest = [..._subscribers.entries()].sort((a, b) => a[1].expiry - b[1].expiry)[0];
    if (oldest) _subscribers.delete(oldest[0]);
  }
  const sid    = 'uuid:' + crypto.randomUUID();
  const expiry = Date.now() + timeoutSecs * 1000;
  _subscribers.set(sid, { sid, callback, expiry, seq: 0 });
  return sid;
}

function _renewSubscriber(sid, timeoutSecs) {
  const sub = _subscribers.get(sid);
  if (!sub) return false;
  sub.expiry = Date.now() + timeoutSecs * 1000;
  return true;
}

function _sendInitialEvent(sid) {
  const sub = _subscribers.get(sid);
  if (!sub) return;
  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<e:propertyset xmlns:e="urn:schemas-upnp-org:event-1-0">' +
    '<e:property><SystemUpdateID>' + _systemUpdateID + '</SystemUpdateID></e:property>' +
    '<e:property><ContainerUpdateIDs></ContainerUpdateIDs></e:property>' +
    '<e:property><SearchCapabilities>' + SEARCH_CAPS + '</SearchCapabilities></e:property>' +
    '<e:property><SortCapabilities>' + SORT_CAPS + '</SortCapabilities></e:property>' +
    '</e:propertyset>';
  _sendNotify(sub, sub.seq++, xml).catch(() => {});
}

const SEARCH_CAPS =
  'dc:title,dc:creator,upnp:artist,upnp:album,upnp:genre,upnp:class,upnp:originalTrackNumber';
const SORT_CAPS =
  '+dc:title,-dc:title,+dc:creator,-dc:creator,+upnp:artist,-upnp:artist,' +
  '+upnp:album,-upnp:album,+upnp:genre,-upnp:genre,' +
  '+upnp:originalTrackNumber,-upnp:originalTrackNumber,+dc:date,-dc:date';

// ── Device description XML ────────────────────────────────────────────────────

function deviceXml() {
  const uuid = xmlEsc(config.program.instanceId || 'velvet-velvet');
  const name = xmlEsc(config.program.dlna?.name || 'Velvet');
  const base = xmlEsc(_baseUrl);
  return `<?xml version="1.0" encoding="UTF-8"?>
<root xmlns="urn:schemas-upnp-org:device-1-0"
      xmlns:dlna="urn:schemas-dlna-org:device-1-0"
      xmlns:sec="http://www.sec.co.kr/dlna">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <URLBase>${base}</URLBase>
  <device>
    <deviceType>urn:schemas-upnp-org:device:MediaServer:1</deviceType>
    <friendlyName>${name}</friendlyName>
    <manufacturer>Velvet</manufacturer>
    <manufacturerURL>https://github.com/aroundmyroom/Velvet</manufacturerURL>
    <modelDescription>Velvet Music Server</modelDescription>
    <modelName>Velvet</modelName>
    <modelNumber>1</modelNumber>
    <modelURL>https://github.com/aroundmyroom/Velvet</modelURL>
    <serialNumber>1</serialNumber>
    <UDN>uuid:${uuid}</UDN>
    <dlna:X_DLNADOC>DMS-1.50</dlna:X_DLNADOC>
    <sec:X_ProductCap>smi,DCM10,getMediaInfo.sec,getCaptionInfo.sec</sec:X_ProductCap>
    <presentationURL>${base}/</presentationURL>
    <serviceList>
      <service>
        <serviceType>urn:schemas-upnp-org:service:ContentDirectory:1</serviceType>
        <serviceId>urn:upnp-org:serviceId:ContentDirectory</serviceId>
        <SCPDURL>/dlna/scpd/content-directory.xml</SCPDURL>
        <controlURL>/dlna/control/content-directory</controlURL>
        <eventSubURL>/dlna/events/content-directory</eventSubURL>
      </service>
      <service>
        <serviceType>urn:schemas-upnp-org:service:ConnectionManager:1</serviceType>
        <serviceId>urn:upnp-org:serviceId:ConnectionManager</serviceId>
        <SCPDURL>/dlna/scpd/connection-manager.xml</SCPDURL>
        <controlURL>/dlna/control/connection-manager</controlURL>
        <eventSubURL>/dlna/events/connection-manager</eventSubURL>
      </service>
    </serviceList>
  </device>
</root>`;
}

// ── ContentDirectory SCPD ──────────────────────────────────────────────────────
const CDS_SCPD = `<?xml version="1.0" encoding="UTF-8"?>
<scpd xmlns="urn:schemas-upnp-org:service-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <actionList>
    <action><name>Browse</name><argumentList>
      <argument><name>ObjectID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_ObjectID</relatedStateVariable></argument>
      <argument><name>BrowseFlag</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_BrowseFlag</relatedStateVariable></argument>
      <argument><name>Filter</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_Filter</relatedStateVariable></argument>
      <argument><name>StartingIndex</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_Index</relatedStateVariable></argument>
      <argument><name>RequestedCount</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_Count</relatedStateVariable></argument>
      <argument><name>SortCriteria</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_SortCriteria</relatedStateVariable></argument>
      <argument><name>Result</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_Result</relatedStateVariable></argument>
      <argument><name>NumberReturned</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_Count</relatedStateVariable></argument>
      <argument><name>TotalMatches</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_Count</relatedStateVariable></argument>
      <argument><name>UpdateID</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_UpdateID</relatedStateVariable></argument>
    </argumentList></action>
    <action><name>Search</name><argumentList>
      <argument><name>ContainerID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_ObjectID</relatedStateVariable></argument>
      <argument><name>SearchCriteria</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_SearchCriteria</relatedStateVariable></argument>
      <argument><name>Filter</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_Filter</relatedStateVariable></argument>
      <argument><name>StartingIndex</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_Index</relatedStateVariable></argument>
      <argument><name>RequestedCount</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_Count</relatedStateVariable></argument>
      <argument><name>SortCriteria</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_SortCriteria</relatedStateVariable></argument>
      <argument><name>Result</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_Result</relatedStateVariable></argument>
      <argument><name>NumberReturned</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_Count</relatedStateVariable></argument>
      <argument><name>TotalMatches</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_Count</relatedStateVariable></argument>
      <argument><name>UpdateID</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_UpdateID</relatedStateVariable></argument>
    </argumentList></action>
    <action><name>GetSystemUpdateID</name><argumentList>
      <argument><name>Id</name><direction>out</direction><relatedStateVariable>SystemUpdateID</relatedStateVariable></argument>
    </argumentList></action>
    <action><name>GetSearchCapabilities</name><argumentList>
      <argument><name>SearchCaps</name><direction>out</direction><relatedStateVariable>SearchCapabilities</relatedStateVariable></argument>
    </argumentList></action>
    <action><name>GetSortCapabilities</name><argumentList>
      <argument><name>SortCaps</name><direction>out</direction><relatedStateVariable>SortCapabilities</relatedStateVariable></argument>
    </argumentList></action>
    <action><name>X_GetFeatureList</name><argumentList>
      <argument><name>FeatureList</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_Featurelist</relatedStateVariable></argument>
    </argumentList></action>
  </actionList>
  <serviceStateTable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_ObjectID</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_Result</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_BrowseFlag</name><dataType>string</dataType>
      <allowedValueList><allowedValue>BrowseMetadata</allowedValue><allowedValue>BrowseDirectChildren</allowedValue></allowedValueList>
    </stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_Filter</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_SortCriteria</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_Index</name><dataType>ui4</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_Count</name><dataType>ui4</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_UpdateID</name><dataType>ui4</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_SearchCriteria</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_Featurelist</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="yes"><name>SystemUpdateID</name><dataType>ui4</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>SearchCapabilities</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>SortCapabilities</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="yes"><name>ContainerUpdateIDs</name><dataType>string</dataType></stateVariable>
  </serviceStateTable>
</scpd>`;

// ── ConnectionManager SCPD ────────────────────────────────────────────────────
const CM_SCPD = `<?xml version="1.0" encoding="UTF-8"?>
<scpd xmlns="urn:schemas-upnp-org:service-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <actionList>
    <action><name>GetProtocolInfo</name><argumentList>
      <argument><name>Source</name><direction>out</direction><relatedStateVariable>SourceProtocolInfo</relatedStateVariable></argument>
      <argument><name>Sink</name><direction>out</direction><relatedStateVariable>SinkProtocolInfo</relatedStateVariable></argument>
    </argumentList></action>
    <action><name>GetCurrentConnectionIDs</name><argumentList>
      <argument><name>ConnectionIDs</name><direction>out</direction><relatedStateVariable>CurrentConnectionIDs</relatedStateVariable></argument>
    </argumentList></action>
    <action><name>GetCurrentConnectionInfo</name><argumentList>
      <argument><name>ConnectionID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_ConnectionID</relatedStateVariable></argument>
      <argument><name>RcsID</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_RcsID</relatedStateVariable></argument>
      <argument><name>AVTransportID</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_AVTransportID</relatedStateVariable></argument>
      <argument><name>ProtocolInfo</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_ProtocolInfo</relatedStateVariable></argument>
      <argument><name>PeerConnectionManager</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_ConnectionManager</relatedStateVariable></argument>
      <argument><name>PeerConnectionID</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_ConnectionID</relatedStateVariable></argument>
      <argument><name>Direction</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_Direction</relatedStateVariable></argument>
      <argument><name>Status</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_ConnectionStatus</relatedStateVariable></argument>
    </argumentList></action>
  </actionList>
  <serviceStateTable>
    <stateVariable sendEvents="yes"><name>SourceProtocolInfo</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="yes"><name>SinkProtocolInfo</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="yes"><name>CurrentConnectionIDs</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_ConnectionStatus</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_ConnectionManager</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_Direction</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_ProtocolInfo</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_ConnectionID</name><dataType>i4</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_RcsID</name><dataType>i4</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_AVTransportID</name><dataType>i4</dataType></stateVariable>
  </serviceStateTable>
</scpd>`;

// ── Source protocolInfo list (for GetProtocolInfo) ────────────────────────────
const SOURCE_PROTOCOL_INFO = [
  'http-get:*:audio/mpeg:DLNA.ORG_PN=MP3;DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=' + DLNA_FLAGS,
  'http-get:*:audio/flac:DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=' + DLNA_FLAGS,
  'http-get:*:audio/mp4:DLNA.ORG_PN=AAC_ISO;DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=' + DLNA_FLAGS,
  'http-get:*:audio/ogg:DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=' + DLNA_FLAGS,
  'http-get:*:audio/opus:DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=' + DLNA_FLAGS,
  'http-get:*:audio/wav:DLNA.ORG_PN=LPCM;DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=' + DLNA_FLAGS,
  'http-get:*:audio/aac:DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=' + DLNA_FLAGS,
  'http-get:*:audio/x-flac:DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=' + DLNA_FLAGS,
  'http-get:*:audio/x-wav:DLNA.ORG_PN=LPCM;DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=' + DLNA_FLAGS,
].join(',');

// ── Samsung X_GetFeatureList ────────────────────────────────────────────────────
const SAMSUNG_FEATURE_LIST = `<?xml version="1.0" encoding="UTF-8"?>
<Features xmlns="urn:schemas-upnp-org:av:avs"
          xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
          xsi:schemaLocation="urn:schemas-upnp-org:av:avs http://www.upnp.org/schemas/av/avs.xsd">
  <Feature name="samsung.com_BASICVIEW" version="1">
    <container id="A" type="object.item.audioItem"/>
  </Feature>
</Features>`;

// ── Time-seek middleware ───────────────────────────────────────────────────────
// Intercepts TimeSeekRange.dlna.org header, transcodes via ffmpeg from the
// requested position and streams back as audio/mpeg (MP3 CBR 192k).

function parseNpt(nptStr) {
  // Accepts forms: 30, 1:30, 1:30:00, 1:30:00.000
  if (!nptStr) return Number.NaN;
  const parts = nptStr.trim().split(':').map(Number.parseFloat);
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

function timeSeekMiddleware(rootMap) {
  // rootMap: { [vpathEncoded]: folderRoot }
  return function (req, res, next) {
    const tsHeader = req.headers['timeseekrange.dlna.org'];
    if (!tsHeader) return next();

    // Parse npt=START[-END]
    const m = tsHeader.match(/npt=([0-9:.]+)(?:-([0-9:.]+))?/i);
    if (!m) return next();
    const startSec = parseNpt(m[1]);
    if (Number.isNaN(startSec) || startSec < 0) return next();

    // Resolve the file path from URL
    // URL: /media/:vpathEncoded/rest/of/path
    const urlParts = req.path.slice(1).split('/'); // strip leading /
    // req.path under the sub-app starts from /media/:vp/... but we mount with .use('/media')
    // so req.path = '/:vpEncoded/rest/of/path'
    const vpEncoded = decodeURIComponent(urlParts[0] || '');
    const relPath   = urlParts.slice(1).map(decodeURIComponent).join(path.sep);
    const root      = rootMap[vpEncoded] || rootMap[decodeURIComponent(vpEncoded)];
    if (!root) return next();

    const filePath = path.join(root, relPath);
    // Security: must remain within root
    if (!filePath.startsWith(root + path.sep) && filePath !== root) {
      return res.status(403).end();
    }

    if (!fs.existsSync(filePath)) return next();

    // Pick the output profile.
    // MP3 inputs: every frame is independently decodable → -c:a copy is a
    // lossless passthrough seek. Big CPU win for the common case.
    // FLAC: ffmpeg's FLAC muxer writes STREAMINFO with the *original* file
    // duration, not the post-seek slice — strict decoders reject it. Stay on
    // transcode-to-MP3 path.
    // Everything else (OGG/Opus/AAC/M4A/WAV): transcode to MP3 at 192k —
    // the DLNA lowest common denominator every renderer speaks.
    const ext = path.extname(filePath).toLowerCase();
    let ffArgs;
    if (ext === '.mp3') {
      ffArgs = [
        '-nostdin',
        '-ss', String(startSec),
        '-i',  filePath,
        '-vn',
        '-c:a', 'copy',
        '-f', 'mp3',
        '-loglevel', 'error',
        '-',
      ];
    } else {
      ffArgs = [
        '-nostdin',
        '-ss', String(startSec),
        '-i',  filePath,
        '-vn',
        '-c:a', 'libmp3lame',
        '-b:a', '192k',
        '-f', 'mp3',
        '-loglevel', 'error',
        '-',
      ];
    }

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('TransferMode.dlna.org', 'Streaming');
    res.setHeader('ContentFeatures.dlna.org',
      'DLNA.ORG_PN=MP3;DLNA.ORG_OP=01;DLNA.ORG_CI=1;DLNA.ORG_FLAGS=' + DLNA_FLAGS);
    res.setHeader('TimeSeekRange.dlna.org', `npt=${startSec}-`);

    // HEAD: clients (Sony, Marantz) probe via HEAD + TimeSeekRange to verify
    // the server supports seeks before issuing GET. Return headers only.
    if (req.method === 'HEAD') {
      return res.status(200).end();
    }

    res.status(200);

    const ff = spawn(ffmpegBin(), ffArgs, { stdio: ['ignore', 'pipe', 'ignore'] });
    ff.on('error', err => {
      winston.error(`[dlna time-seek] ffmpeg error: ${err.message}`);
      if (res.headersSent) { try { res.end(); } catch (e) { console.debug('[velvet]', e?.message ?? e); } } else { res.status(500).end(); }
    });
    ff.stdout.pipe(res);
    req.on('close', () => ff.kill('SIGKILL'));
  };
}

// ── Express app builder ────────────────────────────────────────────────────────

function buildDlnaApp() {
  const app = express();

  app.use(helmet());

  // Body parser for SOAP (text/xml, application/xml, application/soap+xml)
  app.use(express.text({
    type: ['text/xml', 'application/xml', 'application/soap+xml'],
    limit: '512kb',
  }));

  // Add DLNA headers to all responses
  app.use((req, res, next) => {
    res.setHeader('Ext', '');
    res.setHeader('Server', 'UPnP/1.0 DLNADOC/1.50 UPnP/1.0');
    next();
  });

  // ── Device description ───────────────────────────────────────────────────
  app.get('/dlna/description.xml', (_req, res) => {
    res.set('Content-Type', 'text/xml; charset="utf-8"');
    res.send(deviceXml());
  });

  // ── SCPDs ────────────────────────────────────────────────────────────────
  app.get('/dlna/scpd/content-directory.xml', (_req, res) => {
    res.set('Content-Type', 'text/xml; charset="utf-8"');
    res.send(CDS_SCPD);
  });
  app.get('/dlna/scpd/connection-manager.xml', (_req, res) => {
    res.set('Content-Type', 'text/xml; charset="utf-8"');
    res.send(CM_SCPD);
  });

  // ── ContentDirectory SOAP control ────────────────────────────────────────
  app.post('/dlna/control/content-directory', (req, res) => {
    const body   = typeof req.body === 'string' ? req.body : '';
    const action = (req.headers['soapaction'] || '').replaceAll(/["']/g, '');
    try {
      if (action.endsWith('#Browse') || body.includes(':Browse ') || body.includes(':Browse>')) {
        return handleBrowse(body, res);
      }
      if (action.endsWith('#Search') || body.includes(':Search ') || body.includes(':Search>')) {
        return handleSearch(body, res);
      }
      if (action.endsWith('#GetSystemUpdateID') || body.includes('GetSystemUpdateID')) {
        return sendXml(res, soapEnvelope(CDS_NS, 'GetSystemUpdateID', `<Id>${_systemUpdateID}</Id>`));
      }
      if (action.endsWith('#GetSearchCapabilities') || body.includes('GetSearchCapabilities')) {
        return sendXml(res, soapEnvelope(CDS_NS, 'GetSearchCapabilities', `<SearchCaps>${xmlEsc(SEARCH_CAPS)}</SearchCaps>`));
      }
      if (action.endsWith('#GetSortCapabilities') || body.includes('GetSortCapabilities')) {
        return sendXml(res, soapEnvelope(CDS_NS, 'GetSortCapabilities', `<SortCaps>${xmlEsc(SORT_CAPS)}</SortCaps>`));
      }
      if (action.endsWith('#X_GetFeatureList') || body.includes('X_GetFeatureList')) {
        return sendXml(res, soapEnvelope(CDS_NS, 'X_GetFeatureList', `<FeatureList>${xmlEsc(SAMSUNG_FEATURE_LIST)}</FeatureList>`));
      }
      sendXml(res, soapError(401, 'Invalid Action'), 500);
    } catch (err) {
      winston.error('[DLNA] CDS SOAP error: ' + err.message);
      sendXml(res, soapError(501, 'Action Failed'), 500);
    }
  });

  // ── ConnectionManager SOAP control ───────────────────────────────────────
  app.post('/dlna/control/connection-manager', (req, res) => {
    const body   = typeof req.body === 'string' ? req.body : '';
    const action = (req.headers['soapaction'] || '').replaceAll(/["']/g, '');
    try {
      if (action.endsWith('#GetProtocolInfo') || body.includes('GetProtocolInfo')) {
        return sendXml(res, soapEnvelope(CM_NS, 'GetProtocolInfo',
          `<Source>${xmlEsc(SOURCE_PROTOCOL_INFO)}</Source><Sink></Sink>`));
      }
      if (action.endsWith('#GetCurrentConnectionIDs') || body.includes('GetCurrentConnectionIDs')) {
        return sendXml(res, soapEnvelope(CM_NS, 'GetCurrentConnectionIDs', `<ConnectionIDs>0</ConnectionIDs>`));
      }
      if (action.endsWith('#GetCurrentConnectionInfo') || body.includes('GetCurrentConnectionInfo')) {
        return sendXml(res, soapEnvelope(CM_NS, 'GetCurrentConnectionInfo',
          `<RcsID>-1</RcsID><AVTransportID>-1</AVTransportID>` +
          `<ProtocolInfo></ProtocolInfo><PeerConnectionManager></PeerConnectionManager>` +
          `<PeerConnectionID>-1</PeerConnectionID><Direction>Output</Direction><Status>OK</Status>`));
      }
      sendXml(res, soapError(401, 'Invalid Action'), 500);
    } catch (err) {
      winston.error('[DLNA] CM SOAP error: ' + err.message);
      sendXml(res, soapError(501, 'Action Failed'), 500);
    }
  });

  // ── GENA event subscription — ContentDirectory ────────────────────────────
  app.use('/dlna/events/content-directory', (req, res) => {
    const method = req.method.toUpperCase();
    if (method === 'SUBSCRIBE') {
      const callbackRaw = req.headers['callback'] || req.headers['Callback'] || '';
      const callbackUrl = callbackRaw.replaceAll(/^<|>$/g, '').trim();
      const nt          = req.headers['nt'] || req.headers['NT'] || '';
      const timeoutHdr  = req.headers['timeout'] || req.headers['Timeout'] || `Second-${GENA_DEFAULT_TIMEOUT}`;
      const secs        = Number.parseInt(timeoutHdr.replace(/Second-/i, ''), 10) || GENA_DEFAULT_TIMEOUT;

      // Renewal
      const existingSid = req.headers['sid'] || req.headers['SID'] || '';
      if (existingSid && !callbackUrl) {
        if (!_renewSubscriber(existingSid, secs)) return res.status(412).end();
        return res.set({ 'SID': existingSid, 'TIMEOUT': `Second-${secs}` }).status(200).end();
      }

      if (!callbackUrl || nt !== 'upnp:event') return res.status(400).end();
      const sid = _registerSubscriber(callbackUrl, secs);
      res.set({ 'SID': sid, 'TIMEOUT': `Second-${secs}` }).status(200).end();
      // Send initial event asynchronously so SUBSCRIBE gets a fast 200 first
      setImmediate(() => _sendInitialEvent(sid));
    } else if (method === 'UNSUBSCRIBE') {
      const sid = req.headers['sid'] || req.headers['SID'] || '';
      if (sid) _subscribers.delete(sid);
      res.status(200).end();
    } else {
      res.status(405).end();
    }
  });

  // No-op GENA for ConnectionManager (required by spec, no real events)
  app.use('/dlna/events/connection-manager', (req, res) => {
    if (req.method === 'SUBSCRIBE') {
      const sid = 'uuid:' + crypto.randomUUID();
      res.set({ 'SID': sid, 'TIMEOUT': 'Second-1800' }).status(200).end();
    } else {
      res.status(200).end();
    }
  });

  // ── Media serving with time-seek support ─────────────────────────────────
  // Build a vpathEncoded → root map for the time-seek middleware
  const rootMap = {};
  const folders = config.program.folders || {};
  for (const [name, cfg] of Object.entries(folders)) {
    rootMap[encodeURIComponent(name)] = cfg.root;
  }

  // Time-seek intercept (must come BEFORE express.static)
  app.use('/media', timeSeekMiddleware(rootMap));

  // Static file serving per vpath
  for (const [name, cfg] of Object.entries(folders)) {
    app.use('/media/' + encodeURIComponent(name), express.static(cfg.root));
  }

  // Album art serving
  app.use('/album-art', express.static(config.program.storage.albumArtDirectory));

  return app;
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

export function bumpSystemUpdateID() {
  _systemUpdateID = (_systemUpdateID + 1) & 0xFFFFFFFF;
  _notifySubscribers().catch(() => {});
  // Invalidate file tree cache so new scans are reflected immediately
  _sourceFilesCache.clear();
}

export function isRunning() { return _running; }

export async function start() {
  if (_running) return;

  const port    = config.program.dlna?.port || 10293;
  const ip      = getLanIp();
  _baseUrl      = `http://${ip}:${port}`;

  try {
    const app = buildDlnaApp();
    _httpServer = http.createServer(app);

    await new Promise((resolve, reject) => {
      _httpServer.once('error', reject);
      _httpServer.listen(port, '0.0.0.0', resolve);
    });

    await _startSsdp(port);
    _running = true;
    winston.info(`[DLNA] started → ${_baseUrl}/dlna/description.xml`);
  } catch (err) {
    winston.error('[DLNA] failed to start: ' + err.message);
    await stop().catch(() => {});
    throw err;
  }
}

export async function stop() {
  _running = false;
  _stopSsdp();

  if (_httpServer) {
    await new Promise(resolve => _httpServer.close(() => resolve()));
    _httpServer = null;
  }

  _subscribers.clear();
  winston.info('[DLNA] stopped');
}

// ── Admin API + boot wiring ───────────────────────────────────────────────────

/**
 * Called from server.js to register admin API routes and (optionally) auto-start.
 * @param {import('express').Application} velvet
 */
export function setup(velvet) {

  // GET /api/v1/admin/dlna/config — read current DLNA settings
  velvet.get('/api/v1/admin/dlna/config', (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });
    res.json({
      enabled: config.program.dlna?.enabled || false,
      port:    config.program.dlna?.port    || 10293,
      name:    config.program.dlna?.name    || 'Velvet',
      browse:  config.program.dlna?.browse  || 'dirs',
      running: isRunning(),
    });
  });

  // POST /api/v1/admin/dlna/config — update settings and start/stop the service
  velvet.post('/api/v1/admin/dlna/config', async (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });

    const schema = Joi.object({
      enabled: Joi.boolean().optional(),
      port:    Joi.number().integer().min(1024).max(65535).optional(),
      name:    Joi.string().allow('').max(64).optional(),
      browse:  Joi.string().valid('dirs', 'artist', 'album', 'genre', 'flat').optional(),
    }).min(1);
    joiValidate(schema, req.body);

    if (!config.program.dlna) config.program.dlna = {};
    if (req.body.enabled !== undefined) config.program.dlna.enabled = req.body.enabled;
    if (req.body.port    !== undefined) config.program.dlna.port    = req.body.port;
    if (req.body.name    !== undefined) config.program.dlna.name    = req.body.name;
    if (req.body.browse  !== undefined) config.program.dlna.browse  = req.body.browse;

    const raw = await adminUtil.loadFile(config.configFile);
    if (!raw.dlna) raw.dlna = {};
    if (req.body.enabled !== undefined) raw.dlna.enabled = req.body.enabled;
    if (req.body.port    !== undefined) raw.dlna.port    = req.body.port;
    if (req.body.name    !== undefined) raw.dlna.name    = req.body.name;
    if (req.body.browse  !== undefined) raw.dlna.browse  = req.body.browse;
    await adminUtil.saveFile(raw, config.configFile);

    if (req.body.enabled === true  && !isRunning()) {
      await start().catch(e => { throw new Error('DLNA failed to start: ' + e.message); });
    }
    if (req.body.enabled === false &&  isRunning()) {
      await stop().catch(e => winston.warn('[DLNA] stop error: ' + e.message));
    }

    res.json({ running: isRunning() });
  });

  // Auto-start on boot if previously enabled.
  // Retry once after 5 s in case the port is still in TIME_WAIT from the
  // previous process (happens on rapid service restart).
  if (config.program.dlna?.enabled) {
    start().catch(e => {
      winston.warn(`[DLNA] auto-start failed (${e.message}) — retrying in 5 s`);
      setTimeout(() => {
        start().catch(error => winston.error(`[DLNA] auto-start retry failed: ${error.message}`));
      }, 5000);
    });
  }
}

