// Compute audio identity hash — based on song metadata (artist+album+title+duration)
// Survives transcoding: if audio content is the same, audio_hash stays the same
// even if file encoding changes (MP3 → FLAC, 128k → 320k, etc.)
function calculateAudioHash(songInfo) {
  const audioId = `${(songInfo.artist || '').toLowerCase().trim()}|${(songInfo.album || '').toLowerCase().trim()}|${(songInfo.title || '').toLowerCase().trim()}|${Math.round(songInfo.duration || 0)}`;
  return crypto.createHash('sha256').update(audioId).digest('hex');
}

// ── Album version detection ───────────────────────────────────────────────────
// Default ordered list of tag fields to try for album_version.
// Resolved first-non-empty wins; heuristic fallback runs if all yield nothing.
const DEFAULT_ALBUM_VERSION_TAGS = [
  'TIT3', 'SUBTITLE', 'DISCSUBTITLE',
  'TXXX:EDITION', 'TXXX:VERSION', 'TXXX:ALBUMVERSION',
  'TXXX:QUALITY', 'TXXX:REMASTER', 'TXXX:DESCRIPTION',
  'EDITION', 'VERSION', 'ALBUMVERSION', 'QUALITY', 'REMASTER',
  // COMMENT intentionally excluded from default — too noisy; add via admin config if desired
];

/** Flatten raw music-metadata native tag arrays into lookup maps by format. */
function buildNativeMap(native) {
  const map = { txxx: {}, vorbis: {}, ape: {}, itunesCustom: {} };
  for (const [format, tags] of Object.entries(native || {})) {
    if (!Array.isArray(tags)) continue;
    for (const tag of tags) {
      if (!tag?.id) continue;
      if (tag.id === 'TXXX' && tag.value?.description) {
        map.txxx[tag.value.description.toUpperCase()] = tag.value.text;
      } else if (format === 'vorbis') {
        map.vorbis[tag.id.toUpperCase()] = Array.isArray(tag.value) ? tag.value[0] : tag.value;
      } else if (format === 'APEv2') {
        map.ape[tag.id.toUpperCase()] = tag.value;
      } else if (tag.id.startsWith('----:com.apple.iTunes:')) {
        const k = tag.id.replaceAll('----:com.apple.iTunes:', '').toUpperCase();
        map.itunesCustom[k] = tag.value;
      }
    }
  }
  return map;
}

function _firstOf(v) {
  if (v == null) return null;
  if (Array.isArray(v)) return v[0] ?? null;
  if (typeof v === 'object' && 'text' in v) return v.text ?? null;
  return String(v);
}

/** Resolve one configured field name against all tag formats. Returns string or null. */
function resolveTagField(fieldName, songInfo, nativeMap) {
  const key = fieldName.toUpperCase().trim();

  // TXXX:KEY — ID3v2 user-defined text frame
  if (key.startsWith('TXXX:')) {
    const desc = key.slice(5);
    const val = nativeMap.txxx?.[desc];
    return val == null ? null : String(val).trim() || null;
  }

  // music-metadata normalised common fields
  const commonAlias = {
    'TIT3':        () => _firstOf(songInfo.subtitle),
    'SUBTITLE':    () => _firstOf(songInfo.subtitle),
    'DISCSUBTITLE':() => _firstOf(songInfo.discsubtitle),
    'COMMENT':     () => {
      const c = songInfo.comment;
      if (!c) return null;
      const arr = Array.isArray(c) ? c : [c];
      for (const item of arr) {
        const t = (typeof item === 'object') ? (item.text ?? item) : item;
        if (t && String(t).trim()) return String(t).trim();
      }
      return null;
    },
  };
  if (commonAlias[key]) return commonAlias[key]() ?? null;

  // Raw Vorbis / APE / iTunes custom atom by exact key name
  const raw = nativeMap.vorbis?.[key] ?? nativeMap.ape?.[key] ?? nativeMap.itunesCustom?.[key];
  if (raw != null) return String(raw).trim() || null;
  return null;
}

// ── Heuristic fallback ────────────────────────────────────────────────────────
/** Normalise a string for reliable regex matching: strip diacritics, lowercase, unify dashes. */
function normaliseForHeuristic(s) {
  return String(s)
    .normalize('NFD')
    .replaceAll(/[\u0300-\u036f]/g, '')       // strip diacritics
    .toLowerCase()
    .replaceAll(/[\u2012-\u2015]/g, '-')    // normalise all dashes to hyphen
    .replaceAll(/[^\x20-\x7e]/g, ' ')         // replace remaining non-ASCII with space
    .replaceAll(/\s+/g, ' ')
    .trim();
}

/** Minimal Levenshtein distance (edit distance) between two strings. */
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    }
  }
  return dp[m][n];
}

const FUZZY_WORDS = {
  'deluxe':       'Deluxe Edition',
  'dleuxe':       'Deluxe Edition',   // common typo
  'expanded':     'Expanded Edition',
  'remaster':     'Remaster',
  'remastered':   'Remaster',
  'anniversary':  'Anniversary Edition',
};

function fuzzyMatch(normalised) {
  const words = normalised.split(/[-\s[\](){}]+/).filter(w => w.length >= 4);
  for (const [target, label] of Object.entries(FUZZY_WORDS)) {
    for (const word of words) {
      if (Math.abs(word.length - target.length) <= 1 && levenshtein(word, target) <= 1) {
        return label;
      }
    }
  }
  return null;
}

// Confidence gate: only run heuristics if at least one known keyword/bracket is present
const HAS_BRACKET_OR_KEYWORD = /[[\](]|remast|deluxe|hi.?res|\d{2,3}.?bit|\d{3,6}.?k?hz|dsd|sacd|expanded|anniversary|bonus\s|live\b|mono\b|stereo\b/i;

function matchEdition(s) {
  // Order matters: more specific patterns before generic ones
  if (/anni?ver\w*/.test(s))                           return 'Anniversary Edition';
  if (/expan\w*/.test(s))                              return 'Expanded Edition';
  if (/de?luxe/.test(s))                            return 'Deluxe Edition';
  if (/complet\w+\s*(edition|ed\.?|coll\w+)?/.test(s)) return 'Complete Edition';
  if (/box\s*set|boxset/.test(s))                      return 'Box Set';
  if (/bonus\s*(track|disc|edition|cd)?/.test(s))      return 'Bonus Edition';
  if (/\blive\b(?!\s*remast)/.test(s))                return 'Live';
  if (/\bmono\b/.test(s))                              return 'Mono';
  if (/\bstereo\b/.test(s))                            return 'Stereo';
  if (/\bsacd\b/.test(s))                              return 'SACD';

  // Remaster — capture optional year
  const rmYear1 = s.match(/(\d{4})\s*(?:digital\s+)?remast\w*/);
  if (rmYear1) return `${rmYear1[1]} Remaster`;
  const rmYear2 = s.match(/remast\w*\s*(\d{4})/);
  if (rmYear2) return `Remaster ${rmYear2[1]}`;
  if (/remast\w*/.test(s)) return 'Remaster';

  return null;
}

function matchQuality(s) {
  const parts = [];

  // Hi-Res marker
  if (/hi.?res/.test(s)) parts.push('Hi-Res');

  // DSD
  const dsd = s.match(/\bdsd\s*(\d+)?/);
  if (dsd) parts.push(dsd[1] ? `DSD${dsd[1]}` : 'DSD');

  // Bit depth
  const bits = s.match(/(\d{2,3})\s*-?\s*bit/);
  if (bits) parts.push(`${bits[1]}bit`);

  // Sample rate — match e.g. 96khz, 96kHz, 192.0 kHz, 44100hz
  const hz = s.match(/(\d{2,6}(?:\.\d)?)\s*k?hz/);
  if (hz) {
    const val = Number.parseFloat(hz[1]);
    // If the raw value looks like Hz (>= 1000), convert to kHz label
    const khz = val >= 1000 ? Math.round(val / 1000) : val;
    if (khz >= 44) parts.push(`${khz}kHz`);
  }

  return parts.length ? parts.join('/') : null;
}

function parseVersionHeuristic(rawInput) {
  if (!rawInput) return null;
  const s = normaliseForHeuristic(rawInput);
  if (!HAS_BRACKET_OR_KEYWORD.test(s)) return null;  // plain name, skip heuristics

  const editionMatch = matchEdition(s);
  const qualityMatch = matchQuality(s);

  if (!editionMatch && !qualityMatch) {
    const fuzzy = fuzzyMatch(s);
    return fuzzy || null;
  }

  const parts = [];
  if (editionMatch) parts.push(editionMatch);
  if (qualityMatch) parts.push(qualityMatch);
  return parts.join(' · ');
}

// Module-level variable so deriveAlbumVersion can communicate the source
let _lastAlbumVersionSource = null;

/** Main orchestrator: walk configured tag fields, fall back to heuristics, infer from audio. */
function deriveAlbumVersion(songInfo, native, fmtInfo, configuredFields) {
  _lastAlbumVersionSource = null;
  const fields = Array.isArray(configuredFields) && configuredFields.length > 0
    ? configuredFields : DEFAULT_ALBUM_VERSION_TAGS;
  const nativeMap = buildNativeMap(native);

  for (const field of fields) {
    const val = resolveTagField(field, songInfo, nativeMap);
    if (val?.trim()) {
      _lastAlbumVersionSource = field;
      return val.trim();
    }
  }

  // Heuristic: album title string
  const fromTitle = parseVersionHeuristic(songInfo.album || '');
  if (fromTitle) {
    _lastAlbumVersionSource = 'heuristic:title';
    return fromTitle;
  }

  // Heuristic: parent folder name
  const folder = (songInfo.filePath || '').split('/').slice(-2, -1)[0] || '';
  const fromFolder = parseVersionHeuristic(folder);
  if (fromFolder) {
    _lastAlbumVersionSource = 'heuristic:folder';
    return fromFolder;
  }

  // Infer from audio technical properties
  const bits = fmtInfo.bitsPerSample ?? 0;
  const sr   = fmtInfo.sampleRate   ?? 0;
  if (bits >= 24 && sr >= 88200) {
    const khz = Math.round(sr / 1000);
    _lastAlbumVersionSource = 'inferred:audio';
    return `Hi-Res ${bits}bit/${khz}kHz`;
  }

  return null;
}
// ─────────────────────────────────────────────────────────────────────────────

import { parseFile } from 'music-metadata';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Joi from 'joi';
import sharp from 'sharp';
import mime from 'mime-types';
import axios from 'axios';
import http from 'node:http';
import https from 'node:https';
import { execFile } from 'node:child_process';
import { resolvePathWithinRoot } from '../util/path-security.js';

// Disable keep-alive on both agents: between batch flushes the server-side
// keep-alive timeout can expire, leaving a stale socket in the pool. When
// axios reuses that dead socket the next write raises EPIPE. Creating a fresh
// connection per request is cheap compared to metadata parsing overhead.
const ax = axios.create({
  httpAgent:  new http.Agent({  keepAlive: false }),
  httpsAgent: new https.Agent({ keepAlive: false, rejectUnauthorized: false }),
});

let loadJson;
try {
  loadJson = JSON.parse(process.argv.at(-1), 'utf8');
} catch {
  console.error(`Warning: failed to parse JSON input`);
  process.exit(1);
}

// Validate input
const schema = Joi.object({
  vpath: Joi.string().required(),
  directory: Joi.string().required(),
  port: Joi.number().port().required(),
  token: Joi.string().required(),
  pause: Joi.number().required(),
  skipImg: Joi.boolean().required(),
  albumArtDirectory: Joi.string().required(),
  scanId: Joi.string().required(),
  isHttps: Joi.boolean().required(),
  compressImage: Joi.boolean().required(),
  hasBaseline: Joi.boolean().required(),
  supportedFiles: Joi.object().pattern(
    Joi.string(), Joi.boolean()
  ).required(),
  otherRoots: Joi.array().items(Joi.string()).required(),
  excludedPaths: Joi.array().items(Joi.string()).default([]),
  ffprobePath: Joi.string().optional().allow('', null),
  albumVersionTags: Joi.array().items(Joi.string()).optional(),
  // Resume state (optional — injected only when resuming an interrupted scan)
  completedDirs: Joi.array().items(Joi.string()).optional(),
  scanStateFile: Joi.string().optional().allow('', null),
  isResume: Joi.boolean().optional(),
}).unknown(true);

const { error: validationError } = schema.validate(loadJson);
if (validationError) {
  console.error(`Invalid JSON Input`);
  console.log(validationError);
  process.exit(1);
}

// ── Genre canonicalization ─────────────────────────────────────────────────────
// Normalises raw genre strings from tags into consistent Title-Case values.
// A small overrides map handles common acronyms and compound genres; everything
// else is Title-Cased.
const _GENRE_MAP = new Map([
  ['r&b', 'R&B'],        ['r & b', 'R&B'],    ['rhythm and blues', 'R&B'], ['rnb', 'R&B'],
  ['hip hop', 'Hip-Hop'], ['hip-hop', 'Hip-Hop'], ['hiphop', 'Hip-Hop'],
  ['edm', 'EDM'],        ['electronic dance music', 'EDM'],
  ['k-pop', 'K-Pop'],    ['kpop', 'K-Pop'],    ['korean pop', 'K-Pop'],
  ['j-pop', 'J-Pop'],    ['jpop', 'J-Pop'],    ['japanese pop', 'J-Pop'],
  ['lo-fi', 'Lo-Fi'],    ['lofi', 'Lo-Fi'],    ['lo fi', 'Lo-Fi'],
  ['nu metal', 'Nu Metal'], ['nu-metal', 'Nu Metal'],
  ['drum and bass', 'Drum and Bass'], ['drum & bass', 'Drum and Bass'],
  ['dnb', 'Drum and Bass'], ['d&b', 'Drum and Bass'], ['drum n bass', 'Drum and Bass'],
  ['trip hop', 'Trip-Hop'],   ['trip-hop', 'Trip-Hop'],
  ['post punk', 'Post-Punk'], ['post-punk', 'Post-Punk'],
  ['alt rock', 'Alternative Rock'], ['alt-rock', 'Alternative Rock'],
  ['prog rock', 'Progressive Rock'],
  ['dance pop', 'Dance-Pop'],  ['dance-pop', 'Dance-Pop'],
  ['synthpop', 'Synth-Pop'],   ['synth pop', 'Synth-Pop'], ['synth-pop', 'Synth-Pop'],
  ['deep house', 'Deep House'], ['tech house', 'Tech House'],
  ['progressive house', 'Progressive House'], ['electro house', 'Electro House'],
  ['future house', 'Future House'], ['tropical house', 'Tropical House'],
  ['neo soul', 'Neo Soul'],
  ['new wave', 'New Wave'],
]);

function canonicalGenreName(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const key = s.toLowerCase().replaceAll('_', ' ').replaceAll(/\s+/g, ' ');
  if (_GENRE_MAP.has(key)) return _GENRE_MAP.get(key);
  // Title-case: uppercase first letter of each word
  return key.replaceAll(/\b\w/g, c => c.toUpperCase());
}

// ── Subsonic ID helpers ───────────────────────────────────────────────────────
function _makeArtistId(artist) {
  return crypto.createHash('md5').update((artist || '').toLowerCase().trim()).digest('hex').slice(0, 16); // NOSONAR: MD5 used as DB identity key, not for security
}
function _makeAlbumId(artist, album) {
  return crypto.createHash('md5') // NOSONAR: MD5 used as DB identity key, not for security
    .update(`${(artist || '').toLowerCase().trim()}|||${(album || '').toLowerCase().trim()}`)
    .digest('hex').slice(0, 16);
}
// Strip embedded null bytes (and anything after) from tag text.
// Some encoders store multi-value ID3/APE frames with NUL separators;
// keeping only the first part prevents corrupt DB values.
function _tagText(v) {
  if (!v) return null;
  const s = String(v).split('\0')[0].trim();
  return s || null;
}

async function insertEntries(song) {
  const modifiedSec = Number.isFinite(song.modified) ? Math.floor(song.modified / 1000) : null;
  const data = {
    "title": _tagText(song.title),
    "artist": _tagText(song.artist),
    "albumArtist": _tagText(song.albumartist),
    "year": song.year ? song.year : null,
    "album": _tagText(song.album),
    "filepath": song.filePath,
    "format": song.format,
    "track": song.track.no ? song.track.no : null,
    "trackOf": song.track.of ? song.track.of : null,
    "disk": song.disk.no ? song.disk.no : null,
    "modified": song.modified,
    "hash": song.hash,
    "audio_hash": song.audio_hash,
    "aaFile": song.aaFile ? song.aaFile : null,
    "art_source": song._artSource || null,
    "cover_file": song._coverFile || null,
    "vpath": loadJson.vpath,
    "ts": song._preserveTs || (song._isReindex ? null : Math.floor(Date.now() / 1000)) || null,
    "sID": loadJson.scanId,
    "replaygainTrackDb": song.replaygain_track_gain ? song.replaygain_track_gain.dB : null,
    "genre": song.genre ? (canonicalGenreName(String(song.genre)) ?? String(song.genre)) : null,
    "cuepoints": song.cuepoints || null,
    "duration": song._duration ?? null,
    "bitrate":     song._bitrate     ?? null,
    "sample_rate": song._sampleRate  ?? null,
    "channels":    song._channels    ?? null,
    "bit_depth":   song._bitDepth    ?? null,
    "album_version":        song._albumVersion       ?? null,
    "album_version_source": song._albumVersionSource ?? null,
    "bpm":         song._bpm         ?? null,
    "musical_key": song._musicalKey  ?? null,
    "bpm_source":  song._bpmSource   ?? null,
    "ab_status":   song._abStatus    ?? null,
    "artist_id": _makeArtistId(_tagText(song.artist)),
    "album_id": _makeAlbumId(_tagText(song.artist), _tagText(song.album)),
    "_oldHash": song._oldHash || null,
    "_preserveRgMeasuredTs": song._preserveRgMeasuredTs ?? null,
    "_preserveRgMeasurementTool": song._preserveRgMeasurementTool ?? null,
    "_preserveRgIntegratedLufs": song._preserveRgIntegratedLufs ?? null,
    "_preserveRgTruePeakDbfs": song._preserveRgTruePeakDbfs ?? null,
    "_preserveRgTrackGainDb": song._preserveRgTrackGainDb ?? null,
    "_preserveRgLra": song._preserveRgLra ?? null,
    "_preserveRgAlbumGainDb": song._preserveRgAlbumGainDb ?? null,
    "_preserveRgAlbumPeakDbfs": song._preserveRgAlbumPeakDbfs ?? null
  };

  await ax({
    method: 'POST',
    url: `http${loadJson.isHttps === true ? 's': ''}://localhost:${loadJson.port}/api/v1/scanner/add-file`,
    headers: { 'accept': 'application/json', 'x-access-token': loadJson.token },
    responseType: 'json',
    data: data
  });
}

/**
 * Report a scan error back to the Velvet server database for persistent
 * auditing.  The GUID = md5(relativeFilePath + '|' + errorType) so the same
 * recurring problem on the same file increments its count instead of creating
 * duplicate rows.  Errors here must never crash or stall the scanner.
 */
async function reportError(absoluteFilepath, errorType, errorMsg, stack) {
  try {
    const rel = absoluteFilepath
      ? path.relative(loadJson.directory, absoluteFilepath)
      : '';
    const guid = crypto.createHash('md5').update(`${rel}|${errorType}`).digest('hex'); // NOSONAR: MD5 used as collision-free error-dedup key, not for security
    await ax({
      method: 'POST',
      url: `http${loadJson.isHttps === true ? 's': ''}://localhost:${loadJson.port}/api/v1/scanner/report-error`,
      headers: { 'accept': 'application/json', 'x-access-token': loadJson.token },
      responseType: 'json',
      data: {
        guid,
        filepath: rel,
        vpath: loadJson.vpath,
        errorType,
        errorMsg:  String(errorMsg  || '').slice(0, 500),
        stack:     String(stack     || '').slice(0, 2000)
      }
    });
  } catch {
    // error reporting must never crash the scanner
  }
}

async function confirmOk(absoluteFilepath) {
  try {
    const rel = absoluteFilepath
      ? path.relative(loadJson.directory, absoluteFilepath)
      : '';
    await ax({
      method: 'POST',
      url: `http${loadJson.isHttps === true ? 's': ''}://localhost:${loadJson.port}/api/v1/scanner/confirm-ok`,
      headers: { 'accept': 'application/json', 'x-access-token': loadJson.token },
      responseType: 'json',
      data: { filepath: rel, vpath: loadJson.vpath }
    });
  } catch {
    // confirm-ok must never crash the scanner
  }
}

// Running total of valid files discovered during recursiveScan.
// Updated as directories are walked so set-expected pings reflect the
// current tree-walk progress rather than requiring a separate pre-count pass.
let _totalSeen = 0;

// ── Scan resume state ─────────────────────────────────────────────────────────
// Directories fully processed in an earlier interrupted run of the same scanId.
// Populated from the checkpoint file (loadJson.scanStateFile) on startup; updated
// as each directory finishes and written back periodically.
// completedDirs is intentionally NOT passed as a CLI arg (E2BIG for large libraries).
function _readCompletedDirsFromFile() {
  if (!loadJson.scanStateFile) return [];
  try {
    const raw = fs.readFileSync(loadJson.scanStateFile, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed.scanId === loadJson.scanId && Array.isArray(parsed.completedDirs)) {
      return parsed.completedDirs;
    }
  } catch (e) { console.debug('[velvet]', e?.message ?? e); }
  return [];
}
const _completedDirsSet = new Set(loadJson.isResume ? _readCompletedDirsFromFile() : []);
let _checkpointDirty = false;
let _lastCheckpointWrite = 0;
const CHECKPOINT_WRITE_INTERVAL_MS = 60 * 1000; // write at most once per 60 s

// ── Batch scan helpers ────────────────────────────────────────────────────────
// Instead of one HTTP call per file, files are accumulated and sent in batches
// of SCAN_BATCH_SIZE.  This reduces 138K sequential round trips to ~700, and
// wraps all unchanged-file scanId UPDATEs in a single SQL transaction per batch.
const SCAN_BATCH_SIZE = 200;
const _pendingBatch = [];
let _totalDirsEntered = 0; // incremented per dir entered this scan run (after resume-skip)
const HASH_READ_LIMIT = 524288; // 512 KB — max bytes read when hashing (avoids 30-s timeouts on large files)
const PARSE_TIMEOUT_MS = 30000; // 30 s — enough for any normal file; hangs abort cleanly
const mapOfDirectoryAlbumArt = {};
const _visitedRealDirs = new Set();

function _flushCheckpoint() {
  if (!loadJson.scanStateFile || !_checkpointDirty) return;
  try {
    fs.writeFileSync(
      loadJson.scanStateFile,
      JSON.stringify({ scanId: loadJson.scanId, startedAt: Date.now(), completedDirs: [..._completedDirsSet] })
    );
    _lastCheckpointWrite = Date.now();
    _checkpointDirty = false;
  } catch (e) { console.debug('[velvet]', e?.message ?? e); }
}

async function _markDirComplete(dir) {
  // Flush any pending batch first so files in this dir are confirmed in DB
  // before we declare the directory "done" in the checkpoint.
  if (_pendingBatch.length > 0) await flushBatch();
  _completedDirsSet.add(dir);
  _checkpointDirty = true;
  if (Date.now() - _lastCheckpointWrite >= CHECKPOINT_WRITE_INTERVAL_MS) {
    _flushCheckpoint();
  }
}
await run();
async function run() {
  try {
    // ── Sentinel file (mount guard) check ─────────────────────────────────────
    // After every successful scan, Velvet writes .velvet.md to the vpath
    // root. If this file is missing when hasBaseline=true, the music share is
    // almost certainly not mounted — abort before touching the DB.
    //
    // Exception: if the sentinel has never been written (e.g. first scan after
    // upgrading from a version that predates the sentinel feature), we allow the
    // scan to proceed. The zero-files guard below still protects against a
    // genuinely absent mount in that case. The sentinel will be written by
    // finish-scan at the end of this run, protecting all future scans.
    if (loadJson.hasBaseline) {
      const sentinelPath = path.join(loadJson.directory, '.velvet.md');
      if (!fs.existsSync(sentinelPath)) {
        // Check whether the directory itself is accessible and non-empty.
        // If it has at least one entry it is almost certainly mounted —
        // treat this as a first-time run (post-upgrade) and continue.
        let dirEntries = [];
        try { dirEntries = fs.readdirSync(loadJson.directory); } catch (e) { console.debug('[velvet]', e?.message ?? e); }
        if (dirEntries.length === 0) {
          console.error(
            `[scanner] ABORTED scan for vpath "${loadJson.vpath}": ` +
            `sentinel file ".velvet.md" not found in "${loadJson.directory}" ` +
            `and the directory appears empty. Music share may not be mounted. ` +
            `Database was NOT modified.`
          );
          try {
            await ax({
              method: 'POST',
              url: `http${loadJson.isHttps === true ? 's': ''}://localhost:${loadJson.port}/api/v1/scanner/abort-scan`,
              headers: { 'accept': 'application/json', 'x-access-token': loadJson.token },
              responseType: 'json',
              data: { scanId: loadJson.scanId, vpath: loadJson.vpath, reason: 'sentinel_missing' }
            });
          } catch (e) { console.debug('[velvet]', e?.message ?? e); }
          return;
        }
        console.warn(
          `[scanner] sentinel file ".velvet.md" not found in "${loadJson.directory}" ` +
          `but directory is accessible — treating as first scan after upgrade. ` +
          `Sentinel will be written after this scan completes.`
        );
      }
    }

    // Prune stale error entries before starting — respects the configured retention window.
    try {
      await ax({
        method: 'POST',
        url: `http${loadJson.isHttps === true ? 's': ''}://localhost:${loadJson.port}/api/v1/scanner/prune-errors`,
        headers: { 'accept': 'application/json', 'x-access-token': loadJson.token },
        responseType: 'json',
        data: { vpath: loadJson.vpath }
      });
    } catch (e) { console.debug('[velvet]', e?.message ?? e); }

    // Progress strategy (both first scans and rescans):
    //  - Rescan (hasBaseline=true): expected is already set from DB count; no
    //    change needed. pct is capped at 99 until finish-scan fires.
    //  - First scan (hasBaseline=false): no pre-count pass — scanning starts
    //    immediately. _totalSeen is incremented per file in recursiveScan.
    //    After the full tree walk a single set-expected ping sends the true
    //    total. The UI shows an indeterminate bar + growing file count with no
    //    double-traverse and no 10+ min pre-scan delay.

    const scanStartTs = Math.floor(Date.now() / 1000);
    // Capture completed count at scan start so resume dirs aren't double-counted
    // in the integrity check at the end.
    const _initialCompletedCount = _completedDirsSet.size;
    await recursiveScan(loadJson.directory);

    // ── Mount / access failure guard ──────────────────────────────────────────
    // If this vpath had files in the DB (hasBaseline=true) but the walk found
    // zero files, the music directory is almost certainly unreachable (NFS/SMB
    // disconnected, Docker volume not mounted, permissions lost, etc.).
    // Calling finish-scan in this state would wipe the entire DB for this vpath.
    // Abort instead and log a clear warning — the existing DB rows are preserved.
    if (loadJson.hasBaseline && _totalSeen === 0) {
      console.error(
        `[scanner] ABORTED scan for vpath "${loadJson.vpath}": ` +
        `directory returned 0 files but DB has existing records. ` +
        `The music directory may be unmounted or inaccessible. ` +
        `Database was NOT modified.`
      );
      // Signal the progress tracker that this scan did not finish cleanly.
      try {
        await ax({
          method: 'POST',
          url: `http${loadJson.isHttps === true ? 's': ''}://localhost:${loadJson.port}/api/v1/scanner/abort-scan`,
          headers: { 'accept': 'application/json', 'x-access-token': loadJson.token },
          responseType: 'json',
          data: { scanId: loadJson.scanId, vpath: loadJson.vpath, reason: 'mount_failure' }
        });
      } catch (e) { console.debug('[velvet]', e?.message ?? e); }
      return;
    }

    // Final set-expected: after the full tree walk, _totalSeen is the true total.
    // For rescans the DB count is already set; this is only meaningful for first scans.
    if (!loadJson.hasBaseline && _totalSeen > 0) {
      try {
        await ax({
          method: 'POST',
          url: `http${loadJson.isHttps === true ? 's': ''}://localhost:${loadJson.port}/api/v1/scanner/set-expected`,
          headers: { 'accept': 'application/json', 'x-access-token': loadJson.token },
          responseType: 'json',
          data: { scanId: loadJson.scanId, expected: _totalSeen }
        });
      } catch (e) { console.debug('[velvet]', e?.message ?? e); }
    }

    await flushBatch();

    // ── Directory integrity check ─────────────────────────────────────────────
    // Before finish-scan is allowed to run (and potentially prune the DB),
    // verify that every directory entered during this scan was also completed.
    // _totalDirsEntered is incremented at the start of each recursiveScan call
    // (after the resume-skip check). Any dir that threw a readdirSync error
    // was entered but never reached _markDirComplete, so it stays absent from
    // _completedDirsSet. If ANY entered dirs are missing, finish-scan is
    // blocked to prevent data loss. The scan will resume on next start.
    {
      const completedThisRun = _completedDirsSet.size - _initialCompletedCount;
      if (completedThisRun < _totalDirsEntered) {
        console.error(
          `[scanner] INTEGRITY CHECK FAILED for vpath "${loadJson.vpath}": ` +
          `${_totalDirsEntered} dirs were entered but only ${completedThisRun} completed. ` +
          `${_totalDirsEntered - completedThisRun} dir(s) were not fully processed. ` +
          `finish-scan BLOCKED to prevent data loss. Scan will resume on next start.`
        );
        try {
          await ax({
            method: 'POST',
            url: `http${loadJson.isHttps === true ? 's': ''}://localhost:${loadJson.port}/api/v1/scanner/abort-scan`,
            headers: { 'accept': 'application/json', 'x-access-token': loadJson.token },
            responseType: 'json',
            data: { scanId: loadJson.scanId, vpath: loadJson.vpath, reason: 'incomplete_dirs' }
          });
        } catch (e) { console.debug('[velvet]', e?.message ?? e); }
        return;
      }
      console.log(`[scanner] Integrity check passed: ${completedThisRun}/${_totalDirsEntered} dirs completed.`);
    }

    await ax({
      method: 'POST',
      url: `http${loadJson.isHttps === true ? 's': ''}://localhost:${loadJson.port}/api/v1/scanner/finish-scan`,
      headers: { 'accept': 'application/json', 'x-access-token': loadJson.token },
      responseType: 'json',
      data: {
        vpath: loadJson.vpath,
        scanId: loadJson.scanId,
        scanStartTs
      }
    });
  }catch (err) {
    console.error('Scan Failed');
    console.error(err.stack)
  }
}

async function processFileResult(absPath, relPath, modTime, data) {
  // Resume optimisation: file was already confirmed in the interrupted scan
  // (the server returned _alreadyDone because sID === scanId in the DB).
  // Skip all re-processing — the DB row is already up to date.
  if (data._alreadyDone) return;

  if (Object.entries(data).length === 0 || data._stale) {
    // New or modified file — full parse + insert (cuepoints extracted inside parseMyFile)
    const songInfo = await parseMyFile(absPath, modTime);
    // Preserve Discogs-assigned art (DB cache only, e.g. WAV files) when the
    // re-parsed file carries no embedded art — prevents orphan cleanup from
    // deleting art the user manually picked via the Discogs picker.
    if (!songInfo.aaFile && data._preserveAaFile) {
      songInfo.aaFile = data._preserveAaFile;
      songInfo._artSource = data._preserveArtSource || null;
    }
    // Preserve original insertion timestamp so editing tags/art doesn't
    // re-flood "Recently Added" (file hash changes after rewrite → ts = now without this).
    // Only set _isReindex for files that were already in the DB (_stale).
    // For brand-new files (data = {}), _isReindex must remain unset so that
    // ts = song.modified (file mtime) — making them appear in Recently Added.
    if (data._stale) {
      songInfo._isReindex = true;
    }
    if (data._preserveTs) {
      songInfo._preserveTs = data._preserveTs;
    }
    if (data._oldHash) {
      songInfo._oldHash = data._oldHash;
    }
    if (Object.hasOwn(data, '_preserveRgMeasuredTs')) {
      songInfo._preserveRgMeasuredTs = data._preserveRgMeasuredTs;
      songInfo._preserveRgMeasurementTool = data._preserveRgMeasurementTool ?? null;
      songInfo._preserveRgIntegratedLufs = data._preserveRgIntegratedLufs ?? null;
      songInfo._preserveRgTruePeakDbfs = data._preserveRgTruePeakDbfs ?? null;
      songInfo._preserveRgTrackGainDb = data._preserveRgTrackGainDb ?? null;
      songInfo._preserveRgLra = data._preserveRgLra ?? null;
      songInfo._preserveRgAlbumGainDb = data._preserveRgAlbumGainDb ?? null;
      songInfo._preserveRgAlbumPeakDbfs = data._preserveRgAlbumPeakDbfs ?? null;
    }
    // Preserve AB/Essentia BPM data across file content changes so analysis work isn't lost
    if (data._preserveBpm != null && songInfo._bpm == null) {
      songInfo._bpm = data._preserveBpm;
    }
    if (data._preserveMusicalKey != null && songInfo._musicalKey == null) {
      songInfo._musicalKey = data._preserveMusicalKey;
    }
    if (data._preserveBpmSource != null) {
      songInfo._bpmSource = data._preserveBpmSource;
    }
    if (data._preserveAbStatus != null) {
      songInfo._abStatus = data._preserveAbStatus;
    }
    await insertEntries(songInfo);
    await confirmOk(absPath);
  } else {
    // File already in DB — run targeted updates for anything still missing

    if (data._needsArt) {
      try {
        let songInfo;
        try {
          songInfo = (await parseFile(absPath, { skipCovers: false })).common;
        } catch (_e) {
          await reportError(absPath, 'art', `Failed to parse file for embedded art: ${_e.message}`, _e.stack);
          songInfo = {};
        }
        songInfo.filePath = relPath;
        await getAlbumArt(songInfo);
        // Always call update-art: use '' as a sentinel meaning "checked, no art found".
        // This prevents re-parsing the file on every subsequent scan when there is no art.
        // The server will only trigger _needsArt again if the file genuinely changes (mtime)
        // or if a cached art file goes missing from disk.
        await ax({
          method: 'POST',
          url: `http${loadJson.isHttps === true ? 's': ''}://localhost:${loadJson.port}/api/v1/scanner/update-art`,
          headers: { 'accept': 'application/json', 'x-access-token': loadJson.token },
          responseType: 'json',
          data: { filepath: data.filepath, vpath: loadJson.vpath, aaFile: songInfo.aaFile || '', scanId: loadJson.scanId, artSource: songInfo._artSource || null, coverFile: songInfo._coverFile || null }
        });
      } catch (_artErr) {
        await reportError(absPath, 'art', `Art update failed: ${_artErr.message}`, _artErr.stack);
      }
    }

    if (data._needsCue) {
      try {
        let cuepoints = '[]';
        try {
          const parsed = await parseFile(absPath, { skipCovers: true });
          const cue = parsed.common?.cuesheet;
          const sampleRate = parsed.format?.sampleRate || null;
          if (cue && Array.isArray(cue.tracks) && cue.tracks.length && sampleRate) {
            const pts = [];
            for (const t of cue.tracks) {
              if (t.number === 170) continue;
              const idx1 = Array.isArray(t.indexes) && t.indexes.find(i => i.number === 1);
              if (!idx1) continue;
              pts.push({ no: t.number, title: t.title || null, t: Math.round((idx1.offset / sampleRate) * 100) / 100 });
            }
            if (pts.length > 1) cuepoints = JSON.stringify(pts);
          }
        } catch (_e) {
          await reportError(absPath, 'cue', `Embedded cue sheet parse failed: ${_e.message}`, _e.stack);
        }
        if (cuepoints === '[]') {
          try {
            const sidecar = parseSidecarCue(absPath);
            if (sidecar) cuepoints = JSON.stringify(sidecar);
          } catch (_e) {
            await reportError(absPath, 'cue', `Sidecar .cue file parse failed: ${_e.message}`, _e.stack);
          }
        }
        // M4B chapter fallback (only when no cuepoints found yet)
        if (cuepoints === '[]' && /\.m4b$/i.test(absPath) && loadJson.ffprobePath) {
          try {
            const chapters = await extractM4bChapters(absPath, loadJson.ffprobePath);
            if (chapters) cuepoints = JSON.stringify(chapters);
          } catch (_e) {
            await reportError(absPath, 'cue', `M4B chapter extraction failed: ${_e.message}`, _e.stack);
          }
        }
        await ax({
          method: 'POST',
          url: `http${loadJson.isHttps === true ? 's': ''}://localhost:${loadJson.port}/api/v1/scanner/update-cue`,
          headers: { 'accept': 'application/json', 'x-access-token': loadJson.token },
          responseType: 'json',
          data: { filepath: data.filepath, vpath: loadJson.vpath, cuepoints }
        });
      } catch (_cueErr) {
        await reportError(absPath, 'cue', `Cue update failed: ${_cueErr.message}`, _cueErr.stack);
      }
    }

    if (data._needsDuration) {
      try {
        let duration = null;
        try {
          const parsed = await parseFile(absPath, { skipCovers: true });
          const d = parsed.format?.duration;
          if (d != null && Number.isFinite(d)) { duration = Math.round(d * 1000) / 1000; }
        } catch (_e) {
          await reportError(absPath, 'duration', `Duration parse failed: ${_e.message}`, _e.stack);
        }
        if (duration !== null) {
          await ax({
            method: 'POST',
            url: `http${loadJson.isHttps === true ? 's': ''}://localhost:${loadJson.port}/api/v1/scanner/update-duration`,
            headers: { 'accept': 'application/json', 'x-access-token': loadJson.token },
            responseType: 'json',
            data: { filepath: data.filepath, vpath: loadJson.vpath, duration }
          });
        }
      } catch (_durErr) {
        await reportError(absPath, 'duration', `Duration update failed: ${_durErr.message}`, _durErr.stack);
      }
    }

    if (data._needsBitrate) {
      try {
        let bitrate = null, sampleRate = null, channels = null, bitDepth = null;
        try {
          // Use duration:true so FLAC/WAV files return accurate bitrate and duration
          const parsed = await parseFile(absPath, { skipCovers: true, duration: true });
          const fmt = parsed.format || {};
          if (fmt.bitrate != null && Number.isFinite(fmt.bitrate) && fmt.bitrate > 0) {
            bitrate = Math.round(fmt.bitrate / 1000);
          }
          sampleRate = fmt.sampleRate || null;
          channels   = fmt.numberOfChannels || null;
          bitDepth   = fmt.bitsPerSample || null;
          // Fallback: calculate bitrate from filesize / duration for lossless files
          // where music-metadata does not embed a bitrate value (e.g. some FLAC, WAV)
          if (bitrate == null && fmt.duration > 0) {
            try {
              const { size } = fs.statSync(absPath);
              bitrate = Math.round(size * 8 / fmt.duration / 1000);
            } catch (e) { console.debug('[velvet]', e?.message ?? e); }
          }
        } catch (_e) {
          await reportError(absPath, 'bitrate', `Tech-meta parse failed: ${_e.message}`, _e.stack);
        }
        await ax({
          method: 'POST',
          url: `http${loadJson.isHttps === true ? 's': ''}://localhost:${loadJson.port}/api/v1/scanner/update-tech-meta`,
          headers: { 'accept': 'application/json', 'x-access-token': loadJson.token },
          responseType: 'json',
          data: { filepath: data.filepath, vpath: loadJson.vpath, bitrate, sample_rate: sampleRate, channels, bit_depth: bitDepth }
        });
      } catch (_techErr) {
        await reportError(absPath, 'bitrate', `Tech-meta update failed: ${_techErr.message}`, _techErr.stack);
      }
    }

    if (data._needsAlbumVersion) {
      try {
        let albumVersion = null, albumVersionSource = null;
        try {
          const parsed = await parseFile(absPath, { skipCovers: true });
          const common = parsed.common || {};
          const native = parsed.native || {};
          const fmt    = parsed.format || {};
          // relPath must be set on common so the folder-name heuristic works
          common.filePath = relPath;
          const cfgFields = Array.isArray(loadJson.albumVersionTags) ? loadJson.albumVersionTags : null;
          albumVersion       = deriveAlbumVersion(common, native, fmt, cfgFields);
          albumVersionSource = _lastAlbumVersionSource;
        } catch (_e) {
          await reportError(absPath, 'album-version', `Album version parse failed: ${_e.message}`, _e.stack);
        }
        await ax({
          method: 'POST',
          url: `http${loadJson.isHttps === true ? 's': ''}://localhost:${loadJson.port}/api/v1/scanner/update-album-version`,
          headers: { 'accept': 'application/json', 'x-access-token': loadJson.token },
          responseType: 'json',
          // Use '' as sentinel = 'checked, no version found'. This prevents the server from
          // flagging _needsAlbumVersion on every subsequent scan for files with no version tag.
          data: { filepath: data.filepath, vpath: loadJson.vpath, album_version: albumVersion ?? '', album_version_source: albumVersionSource }
        });
      } catch (_avErr) {
        await reportError(absPath, 'album-version', `Album version update failed: ${_avErr.message}`, _avErr.stack);
      }
    }

    await confirmOk(absPath);
  }
}

async function flushBatch() {
  if (_pendingBatch.length === 0) return;
  const batch = _pendingBatch.splice(0);
  let batchResults;
  try {
    const res = await ax({
      method: 'POST',
      url: `http${loadJson.isHttps === true ? 's' : ''}://localhost:${loadJson.port}/api/v1/scanner/get-files-batch`,
      headers: { 'accept': 'application/json', 'x-access-token': loadJson.token },
      responseType: 'json',
      data: {
        vpath: loadJson.vpath,
        scanId: loadJson.scanId,
        items: batch.map(b => ({ filepath: b.relPath, modTime: b.modTime }))
      }
    });
    batchResults = res.data;
  } catch (batchErr) {
    // If the batch endpoint itself fails, report errors for all files in the batch
    for (const b of batch) {
      await reportError(b.absPath, 'insert', `Batch lookup failed: ${batchErr.message}`, batchErr.stack);
    }
    return;
  }

  for (const b of batch) {
    try {
      const data = batchResults[b.relPath] ?? {};
      await processFileResult(b.absPath, b.relPath, b.modTime, data);
    } catch (err) {
      console.error(`Warning: failed to add file ${b.absPath} to database: ${err.message}`);
      await reportError(b.absPath, 'insert', err.message, err.stack);
    }
    if (loadJson.pause) await timeout(loadJson.pause);
  }
}

async function recursiveScan(dir) {
  // Resume: skip directories that were fully completed in the interrupted scan.
  // This avoids readdirSync + statSync + batch HTTP calls for entire subtrees.
  if (_completedDirsSet.has(dir)) {
    return;
  }

  // Follow-symlink walks can loop forever when a linked directory points to an
  // ancestor (or another already-visited subtree). Track canonical real paths
  // and skip repeats to guarantee an acyclic walk.
  let realDir;
  try {
    realDir = fs.realpathSync(dir);
  } catch {
    return;
  }
  if (_visitedRealDirs.has(realDir)) {
    return;
  }
  _visitedRealDirs.add(realDir);

  _totalDirsEntered++;
  if (process.send) process.send({ dir });
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    return;
  }

  for (const file of files) {
    let filepath;
    try {
      filepath = resolvePathWithinRoot(dir, file);
    } catch {
      continue;
    }
    let stat;
    try {
      stat = fs.statSync(filepath);
    } catch {
      // Bad file, ignore and continue
      continue;
    }

    if (stat.isDirectory()) {
      if (loadJson.otherRoots.includes(filepath)) { continue; }
      if (loadJson.excludedPaths.includes(filepath)) { continue; }
      await recursiveScan(filepath);
    } else if (stat.isFile()) {
      if (!loadJson.supportedFiles[getFileType(file).toLowerCase()]) { continue; }
      _pendingBatch.push({ absPath: filepath, relPath: path.relative(loadJson.directory, filepath), modTime: stat.mtime.getTime() });
      _totalSeen++;
      if (_pendingBatch.length >= SCAN_BATCH_SIZE) await flushBatch();
    }
  }

  // Mark this directory as fully processed so it can be skipped on resume.
  // _markDirComplete flushes the pending batch first to ensure all files in
  // this dir are confirmed in the DB before we record the dir as done.
  await _markDirComplete(dir);
}

function timeout(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Fast directory-only count under rootDir.
 * Uses readdirSync with withFileTypes to avoid extra statSync calls.
 * Skips otherRoots and excludedPaths — same exclusion rules as recursiveScan.
 * Returns the total number of directories (including rootDir itself).
 */
function _quickCountDirs(rootDir) {
  let count = 0;
  const stack = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    count++;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      let full;
      try { full = resolvePathWithinRoot(dir, ent.name); }
      catch { continue; }
      if (loadJson.otherRoots.includes(full)) continue;
      if (loadJson.excludedPaths.includes(full)) continue;
      stack.push(full);
    }
  }
  return count;
}

// Parse a sidecar .cue file alongside an audio file.
// Returns [{no, title, t}] (t = seconds) or null.
// Only applies to single-FILE cue sheets where the FILE entry matches this audio file.
function parseSidecarCue(audioFilePath) {
  const dir  = path.dirname(audioFilePath);
  const base = path.basename(audioFilePath, path.extname(audioFilePath));
  const audioFilename = path.basename(audioFilePath);

  // Try candidates in preference order:
  //  1. {audioFilename}.cue  e.g. "album.flac.cue"  (double-extension — most specific)
  //  2. {base}.cue           e.g. "album.cue"        (EAC/EZ CD Audio Converter default)
  //  3. sole .cue file in the directory
  let cuePath;
  try { cuePath = resolvePathWithinRoot(dir, audioFilename + '.cue'); }
  catch { return null; }
  if (!fs.existsSync(cuePath)) {
    try { cuePath = resolvePathWithinRoot(dir, base + '.cue'); }
    catch { return null; }
    if (!fs.existsSync(cuePath)) {
      let cueFiles;
      try { cueFiles = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.cue')); } catch { return null; }
      if (cueFiles.length !== 1) return null;
      try { cuePath = resolvePathWithinRoot(dir, cueFiles[0]); }
      catch { return null; }
    }
  }

  let content;
  try { content = fs.readFileSync(cuePath, 'utf8'); } catch { return null; }

  // Only handle single-FILE cue sheets whose FILE line references this audio file.
  // Allow same base name with a different extension — EAC generates FILE "album.wav"
  // even when ripping to FLAC, which is the most common real-world case.
  const fileLines = [...content.matchAll(/^FILE\s+"([^"]+)"/gim)];
  if (fileLines.length !== 1) return null;
  const cueRef = path.basename(fileLines[0][1]);
  const cueRefBase = cueRef.toLowerCase().replace(/\.[^.]+$/, '');
  const audioBase  = audioFilename.toLowerCase().replace(/\.[^.]+$/, '');
  if (cueRefBase !== audioBase) return null;

  // Parse TRACK / TITLE / INDEX 01 MM:SS:FF
  const tracks = [];
  let cur = null;
  for (const line of content.split(/\r?\n/)) {
    const trackM = line.match(/^\s*TRACK\s+(\d+)\s+AUDIO/i);
    if (trackM) { cur = { no: Number.parseInt(trackM[1], 10), title: null }; continue; }
    if (!cur) continue;
    const titleM = line.match(/^\s*TITLE\s+"(.*)"/i);
    if (titleM) { cur.title = titleM[1]; continue; }
    const idxM = line.match(/^\s*INDEX\s+01\s+(\d+):(\d+):(\d+)/i);
    if (idxM) {
      const t = Number.parseInt(idxM[1], 10) * 60 + Number.parseInt(idxM[2], 10) + Number.parseInt(idxM[3], 10) / 75;
      tracks.push({ no: cur.no, title: cur.title, t: Math.round(t * 100) / 100 });
      cur = null;
    }
  }
  return tracks.length > 1 ? tracks : null;
}

// Extract chapters from an M4B/M4A file via ffprobe.
// Returns [{no, title, t}] (t = seconds) or null if no chapters found.
function extractM4bChapters(filePath, ffprobePath) {
  return new Promise((resolve, reject) => {
    const args = ['-v', 'quiet', '-print_format', 'json', '-show_chapters', filePath];
    execFile(ffprobePath, args, { maxBuffer: 2 * 1024 * 1024, timeout: 20000 }, (err, stdout) => {
      if (err) { reject(err instanceof Error ? err : new Error(err?.message ?? 'ffprobe error')); return; }
      let chapters;
      try { chapters = JSON.parse(stdout).chapters; } catch { resolve(null); return; }
      if (!Array.isArray(chapters) || chapters.length < 2) { resolve(null); return; }
      const pts = chapters.map((ch, i) => ({
        no:    i + 1,
        title: (ch.tags?.title || `Chapter ${i + 1}`).trim(),
        t:     Math.round(Number.parseFloat(ch.start_time) * 100) / 100 || 0,
      })).filter(cp => cp.t >= 0);
      resolve(pts.length >= 2 ? pts : null);
    });
  });
}

// Returns a promise that rejects after `ms` milliseconds with a timeout error.
function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
    })
  ]).finally(() => clearTimeout(timer));
}

async function _parseFileWithFallback(thisSong) {
  const empty = { songInfo: {track: { no: null, of: null }, disk: { no: null, of: null }}, fmtInfo: {}, nativeInfo: {} };
  try {
    const parsed = await withTimeout(parseFile(thisSong, { skipCovers: loadJson.skipImg }), PARSE_TIMEOUT_MS);
    return { songInfo: parsed.common, fmtInfo: parsed.format || {}, nativeInfo: parsed.native || {} };
  } catch (err) {
    if (!loadJson.skipImg) {
      try {
        const fallback = await withTimeout(parseFile(thisSong, { skipCovers: true }), PARSE_TIMEOUT_MS);
        console.error(`Warning: metadata parse error (covers skipped) on ${thisSong}: ${err.message}`);
        await reportError(thisSong, 'parse', err.message, err.stack);
        return { songInfo: fallback.common, fmtInfo: fallback.format || {}, nativeInfo: fallback.native || {} };
      } catch (error) {
        console.error(`Warning: metadata parse error on ${thisSong}: ${error.message}`);
        await reportError(thisSong, 'parse', error.message, error.stack);
        return empty;
      }
    }
    console.error(`Warning: metadata parse error on ${thisSong}: ${err.message}`);
    await reportError(thisSong, 'parse', err.message, err.stack);
    return empty;
  }
}

function _applyFolderNameFallbacks(songInfo, thisSong) {
  const _segs = songInfo.filePath.split('/');
  const parentFolder = _segs.length >= 2 ? _segs[_segs.length - 2] : null;
  if (!songInfo.artist && !songInfo.albumartist && parentFolder) {
    songInfo.artist = /^(.+?) [-–] /.exec(parentFolder)?.[1]?.trim();
  }
  if (!songInfo.album && parentFolder) {
    const _catM = / ?[-–] ?(?:SP\d[-\d]{0,20}|[A-Z]{2,}-\d[\w-]{0,30}|-cd-|-\d+)/i.exec(parentFolder);
    songInfo.album = (_catM && _catM.index > 0) ? parentFolder.slice(0, _catM.index).trim() : parentFolder;
  }
  if (!songInfo.title) {
    const base = path.basename(thisSong, path.extname(thisSong));
    songInfo.title = base.replace(/^[\d\s._-]+/, '').trim() || base;
  }
}

async function _extractEmbeddedCue(songInfo, fmtInfo, thisSong) {
  try {
    const cue = songInfo.cuesheet;
    const sampleRate = fmtInfo.sampleRate || null;
    if (cue && Array.isArray(cue.tracks) && cue.tracks.length && sampleRate) {
      const cuePoints = [];
      for (const t of cue.tracks) {
        if (t.number === 170) continue;
        const idx1 = Array.isArray(t.indexes) && t.indexes.find(i => i.number === 1);
        if (!idx1) continue;
        cuePoints.push({ no: t.number, title: t.title || null, t: Math.round((idx1.offset / sampleRate) * 100) / 100 });
      }
      if (cuePoints.length > 1) songInfo.cuepoints = JSON.stringify(cuePoints);
    }
  } catch {
    await reportError(thisSong, 'cue', `Embedded cue sheet parse failed: ${_e.message}`, _e.stack);
  }
}

async function _extractSidecarCue(songInfo, thisSong) {
  try {
    const sidecar = parseSidecarCue(thisSong);
    if (sidecar) songInfo.cuepoints = JSON.stringify(sidecar);
  } catch {
    await reportError(thisSong, 'cue', `Sidecar .cue file parse failed: ${_e.message}`, _e.stack);
  }
}

async function _extractM4bCue(songInfo, thisSong) {
  try {
    const chapters = await extractM4bChapters(thisSong, loadJson.ffprobePath);
    if (chapters) songInfo.cuepoints = JSON.stringify(chapters);
  } catch {
    await reportError(thisSong, 'cue', `M4B chapter extraction failed: ${_e.message}`, _e.stack);
  }
}

async function _extractCuePoints(songInfo, fmtInfo, thisSong) {
  await _extractEmbeddedCue(songInfo, fmtInfo, thisSong);
  if (!songInfo.cuepoints) await _extractSidecarCue(songInfo, thisSong);
  if (!songInfo.cuepoints && /\.m4b$/i.test(thisSong) && loadJson.ffprobePath)
    await _extractM4bCue(songInfo, thisSong);
}

async function parseMyFile(thisSong, modified) {
  const { songInfo, fmtInfo, nativeInfo } = await _parseFileWithFallback(thisSong);

  songInfo.modified  = modified;
  songInfo.filePath  = path.relative(loadJson.directory, thisSong);
  songInfo.format    = getFileType(thisSong);
  songInfo._duration   = (fmtInfo.duration != null && Number.isFinite(fmtInfo.duration)) ? Math.round(fmtInfo.duration * 1000) / 1000 : null;
  songInfo._bitrate    = (fmtInfo.bitrate != null && Number.isFinite(fmtInfo.bitrate) && fmtInfo.bitrate > 0) ? Math.round(fmtInfo.bitrate / 1000) : null;
  songInfo._sampleRate = fmtInfo.sampleRate || null;
  songInfo._channels   = fmtInfo.numberOfChannels || null;
  songInfo._bitDepth   = fmtInfo.bitsPerSample || null;

  songInfo._bpm = null;
  if (songInfo.bpm != null) {
    const n = Math.round(Number(songInfo.bpm));
    if (Number.isFinite(n) && n >= 20 && n <= 300) songInfo._bpm = n;
  }
  songInfo._musicalKey = null;
  const _rawKey = songInfo.key ?? null;
  if (_rawKey && typeof _rawKey === 'string') {
    const k = _rawKey.trim().slice(0, 12);
    if (k.length > 0) songInfo._musicalKey = k;
  }

  _applyFolderNameFallbacks(songInfo, thisSong);

  try {
    songInfo.hash = await withTimeout(calculateHash(thisSong), PARSE_TIMEOUT_MS);
  } catch (err) {
    console.error(`Warning: hash failed on ${thisSong}: ${err.message}`);
    await reportError(thisSong, 'parse', `Hash failed: ${err.message}`, err.stack);
    songInfo.hash = null;
  }

  try {
    songInfo.audio_hash = calculateAudioHash(songInfo);
  } catch (err) {
    console.error(`Warning: audio_hash failed on ${thisSong}: ${err.message}`);
    songInfo.audio_hash = null;
  }

  await _extractCuePoints(songInfo, fmtInfo, thisSong);
  await getAlbumArt(songInfo);

  try {
    songInfo._albumVersion = deriveAlbumVersion(
      songInfo, nativeInfo, fmtInfo,
      loadJson.albumVersionTags || DEFAULT_ALBUM_VERSION_TAGS
    );
    songInfo._albumVersionSource = _lastAlbumVersionSource;
  } catch {
    songInfo._albumVersion = null;
    songInfo._albumVersionSource = null;
  }

  return songInfo;
}

function calculateHash(filepath) {
  return new Promise((resolve, reject) => {
    try {
      const hash = crypto.createHash('md5').setEncoding('hex'); // NOSONAR: MD5 used as file identity hash (DB primary key), not for security
      const fileStream = fs.createReadStream(filepath, { start: 0, end: HASH_READ_LIMIT - 1 });
      let bytesRead = 0;

      fileStream.on('error', (err) => {
        reject(err);
      });

      fileStream.on('data', (chunk) => { bytesRead += chunk.length; });

      fileStream.on('end', () => {
        hash.end();
        fileStream.close();
        // Guard: if zero bytes were read (empty/unreadable file or a transient
        // read failure that still ended cleanly), do NOT emit MD5("")
        // (d41d8cd98f00b204e9800998ecf8427e). That sentinel is identical for every
        // such file, so unrelated tracks would collide onto one Subsonic id and
        // stream the wrong file. Reject so the caller stores hash=null and the
        // file is retried on a later scan instead.
        if (bytesRead === 0) {
          reject(new Error(`calculateHash: 0 bytes read from ${filepath}`));
          return;
        }
        resolve(hash.read());
      });

      fileStream.pipe(hash);
    }catch(err) {
      reject(err);
    }
  });
}

async function getAlbumArt(songInfo) {
  if (loadJson.skipImg === true) { return; }

  let originalFileBuffer;

  // picture is stored in song metadata
  if (songInfo.picture?.[0]) {
    // Prefer the Front Cover (type 3 / 'Cover (front)') over whatever [0] happens to be.
    // FLAC files with both ID3 and Vorbis tag blocks can have multiple picture entries
    // in arbitrary order; picking by type avoids using a back cover or artist photo.
    const frontCover = songInfo.picture.find(p => p.type === 'Cover (front)') || songInfo.picture[0];
    // Generate unique name based off hash of album art and metadata
    const picHashString = crypto.createHash('md5').update(frontCover.data).digest('hex'); // NOSONAR: MD5 used as album-art cache filename, not for security
    // mime-types returns 'jpeg' for image/jpeg — normalise to 'jpg' so filenames
    // are consistent with what the Discogs embed endpoint writes (.jpg hardcoded).
    const _rawExt = mime.extension(frontCover.format);
    const _normExt = (_rawExt === 'jpeg') ? 'jpg' : (_rawExt || 'jpg');
    songInfo.aaFile = picHashString + '.' + _normExt;
    songInfo._artSource = 'embedded';
    // Check image-cache folder for filename and save if doesn't exist
    if (!fs.existsSync(resolvePathWithinRoot(loadJson.albumArtDirectory, songInfo.aaFile))) {
      // Save file sync
      fs.writeFileSync(resolvePathWithinRoot(loadJson.albumArtDirectory, songInfo.aaFile), frontCover.data);
      originalFileBuffer = Buffer.from(frontCover.data);
    }
  } else {
    originalFileBuffer = await checkDirectoryForAlbumArt(songInfo);
    if (songInfo.aaFile) { songInfo._artSource = 'directory'; }
  }

  if (originalFileBuffer) {
    try {
      await compressAlbumArt(originalFileBuffer, songInfo.aaFile);
    } catch (err) {
      // sharp couldn't decode the image (e.g. corrupted embedded PNG/JPEG).
      // The original is already on disk; copy it as a fallback thumbnail so
      // art still displays. Don't report a scan error — the user can't fix a
      // corrupted embedded image and the error would persist every rescan.
      try {
        const zlPath = resolvePathWithinRoot(loadJson.albumArtDirectory, 'zl-' + songInfo.aaFile);
        const zsPath = resolvePathWithinRoot(loadJson.albumArtDirectory, 'zs-' + songInfo.aaFile);
        if (!fs.existsSync(zlPath)) { fs.writeFileSync(zlPath, originalFileBuffer); }
        if (!fs.existsSync(zsPath)) { fs.writeFileSync(zsPath, originalFileBuffer); }
      } catch (e) { console.debug('[velvet]', e?.message ?? e); }
      console.warn(`Warning: could not compress album art for ${songInfo.filePath} (${err.message}) — using original`);
    }
  }
}

async function compressAlbumArt(buff, imgName) {
  if (loadJson.compressImage === false) { return; }
  if (buff.length < 100) { return; } // guard against malformed micro-buffers (file-type CVE workaround)

  await sharp(buff).resize(256, 256, { fit: 'inside', withoutEnlargement: true }).toFile(resolvePathWithinRoot(loadJson.albumArtDirectory, 'zl-' + imgName));
  await sharp(buff).resize(92,  92,  { fit: 'inside', withoutEnlargement: true }).toFile(resolvePathWithinRoot(loadJson.albumArtDirectory, 'zs-' + imgName));
  await sharp(buff).resize(512, 512, { fit: 'inside', withoutEnlargement: true }).toFile(resolvePathWithinRoot(loadJson.albumArtDirectory, 'zm-' + imgName));
}

function checkDirectoryForAlbumArt(songInfo) {
  const directory = resolvePathWithinRoot(loadJson.directory, path.dirname(songInfo.filePath));

  // album art has already been found
  if (mapOfDirectoryAlbumArt[directory]) {
    songInfo.aaFile = mapOfDirectoryAlbumArt[directory];
    return; // File already exists, no need to compress again
  }

  // directory was already scanned and nothing was found
  if (mapOfDirectoryAlbumArt[directory] === false) { return; }

  const imageArray = [];
  let files;
  try {
    files = fs.readdirSync(directory);
  } catch {
    return;
  }

  for (const file of files) {
    const filepath = resolvePathWithinRoot(directory, file);
    let stat;
    try {
      stat = fs.statSync(filepath);
    } catch {
      // Bad file, ignore and continue
      continue;
    }

    if (!stat.isFile()) {
      continue;
    }

    if (!["png", "jpg", "jpeg"].includes(getFileType(file).toLowerCase())) {
      continue;
    }

    imageArray.push(file);
  }

  if (imageArray.length === 0) {
    // No images directly in this directory — check common artwork subdirectories
    const artworkSubdirNames = new Set(['artwork', 'scans', 'covers', 'images', 'art', 'cover', 'scan']);
    for (const file of files) {
      const subDirPath = resolvePathWithinRoot(directory, file);
      let subDirStat;
      try { subDirStat = fs.statSync(subDirPath); } catch { continue; }
      if (!subDirStat.isDirectory()) continue;
      if (!artworkSubdirNames.has(file.toLowerCase())) continue;

      let subFiles;
      try { subFiles = fs.readdirSync(subDirPath); } catch { continue; }
      for (const subFile of subFiles) {
        const ext = getFileType(subFile).toLowerCase();
        if (ext !== 'jpg' && ext !== 'jpeg' && ext !== 'png') continue;
        let subStat;
        try { subStat = fs.statSync(resolvePathWithinRoot(subDirPath, subFile)); } catch { continue; }
        if (!subStat.isFile()) continue;
        imageArray.push(path.join(file, subFile)); // e.g. "artwork/front.jpg"
      }
      if (imageArray.length > 0) break;
    }

    if (imageArray.length === 0) {
      // No images in directory or artwork subdirs — check one level up (parent dir).
      // This handles multi-disc albums where cover.jpg lives in the album root
      // but tracks are in CD1/, CD2/, Disc 1/ etc. subdirectories.
      const parentDir = path.dirname(directory);
      // Only check if parent is inside the music root (don't escape the library)
      if (parentDir && parentDir !== directory && parentDir.startsWith(loadJson.directory)) {
        let parentFiles;
        try { parentFiles = fs.readdirSync(parentDir); } catch { parentFiles = []; }
        for (const pf of parentFiles) {
          const ext = getFileType(pf).toLowerCase();
          if (ext !== 'jpg' && ext !== 'jpeg' && ext !== 'png') continue;
          let pStat;
          try { pStat = fs.statSync(resolvePathWithinRoot(parentDir, pf)); } catch { continue; }
          if (!pStat.isFile()) continue;
          // Prefix with '../' so path.join(directory, '../cover.jpg') resolves correctly
          imageArray.push(path.join('..', pf));
        }
      }
    }

    if (imageArray.length === 0) {
      mapOfDirectoryAlbumArt[directory] = false;
      return mapOfDirectoryAlbumArt[directory];
    }
  }

  let imageBuffer;
  let picFormat;
  let selectedImageFile = null;
  let newFileFlag = false;

  // Resolve an art filename against the song directory, but validate against the
  // library root so that ../Parent.jpg paths (multi-disc albums) are allowed.
  const readArtFile = (imgFile) => {
    const abs = path.resolve(directory, imgFile);
    return fs.readFileSync(resolvePathWithinRoot(loadJson.directory, path.relative(loadJson.directory, abs)));
  };

  // Search for a named file
  for (const imgFile of imageArray) {
    const imgMod = imgFile.toLowerCase();
    if (imgMod === 'folder.jpg' || imgMod === 'folder.jpeg' || imgMod === 'cover.jpg' || imgMod === 'cover.jpeg' || imgMod === 'album.jpg' || imgMod === 'album.jpeg' || imgMod === 'front.jpg' || imgMod === 'front.jpeg' || imgMod === 'folder.png' || imgMod === 'cover.png' || imgMod === 'album.png' || imgMod === 'front.png') {
      try {
        imageBuffer = readArtFile(imgFile);
        picFormat = getFileType(imgFile);
        selectedImageFile = imgFile;
      } catch (err) {
        console.error(`Warning: failed to read album art file ${imgFile}: ${err.message}`);
      }
      break;
    }
  }

  // default to first file if none are named
  if (!imageBuffer) {
    try {
      imageBuffer = readArtFile(imageArray[0]);
      picFormat = getFileType(imageArray[0]);
      selectedImageFile = imageArray[0];
    } catch (err) {
      console.error(`Warning: failed to read album art file ${imageArray[0]}: ${err.message}`);
    }
  }

  // If we still have no buffer (all reads failed or resulted in empty data), bail out
  if (!imageBuffer || imageBuffer.length === 0) {
    mapOfDirectoryAlbumArt[directory] = false;
    return mapOfDirectoryAlbumArt[directory];
  }

  const picHashString = crypto.createHash('md5').update(imageBuffer).digest('hex'); // NOSONAR: MD5 used as album-art cache filename, not for security
  songInfo.aaFile = picHashString + '.' + picFormat;
  if (selectedImageFile) songInfo._coverFile = selectedImageFile;
  // Check image-cache folder for filename and save if doesn't exist
  if (!fs.existsSync(path.join(loadJson.albumArtDirectory, songInfo.aaFile))) {
    // Save file sync
    fs.writeFileSync(path.join(loadJson.albumArtDirectory, songInfo.aaFile), imageBuffer);
    newFileFlag = true;
  }

  mapOfDirectoryAlbumArt[directory] = songInfo.aaFile;

  if (newFileFlag === true) { return imageBuffer; }
}

function getFileType(filename) {
  return filename.split(".").pop();
}