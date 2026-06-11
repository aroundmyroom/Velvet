import path from 'node:path';
import { mkdirSync, existsSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import * as config from '../state/config.js';
import * as broker from '../state/bg-task-broker.js';

const _workerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../util/artist-rebuild-worker.mjs');

// ── Subsonic ID helpers ───────────────────────────────────────────────────────
// Artist ID = MD5(normalised artist name).slice(0,16)
// Album ID  = MD5(normalised "artist|||album").slice(0,16)
// 16 hex chars = 64 bits — collision-free for any practical library size.
function _makeArtistId(artist) {
  return createHash('md5').update((artist || '').toLowerCase().trim()).digest('hex').slice(0, 16); // NOSONAR: MD5 used as DB identity key, not for security
}
function _makeAlbumId(artist, album) {
  return createHash('md5') // NOSONAR: MD5 used as DB identity key, not for security
    .update(`${(artist || '').toLowerCase().trim()}|||${(album || '').toLowerCase().trim()}`)
    .digest('hex').slice(0, 16);
}

// ── Folder-based album grouping ───────────────────────────────────────────────
// An album is a *directory*, not a tag combination: every track in the same
// folder belongs to the same album — exactly how the user organises the library
// and how the web ALBUMS view groups (src/api/albums-browse.js). This makes a
// folder of 150 loose tracks (e.g. "Complete Top 40 Van 1971") ONE album, and
// makes Various-Artists compilations group correctly instead of splitting one
// album-per-track-artist over the Subsonic API.
//
// A trailing disc folder (CD1, Disc 2, …) collapses into the album above it so
// multi-disc albums stay together. Files that sit directly in a vpath root (no
// folder of their own) fall back to tag-based identity.
//
// The disc-folder detection MUST stay in sync with albums-browse.js so the
// Subsonic grouping matches the web view 1:1.
const _DISC_RE         = /^(cd|disc)\s*[-–]?\s*\d/i;
const _DISC_SUFFIX_RE  = /\b(cd|disc)\s*[-–]?\s*\d+\s*$/i;
const _NUMERIC_DISC_RE = /^\d{1,2}$/;
function _isDiscFolder(name) {
  return _DISC_RE.test(name) || _DISC_SUFFIX_RE.test(name) || _NUMERIC_DISC_RE.test(name);
}
// Album directory (vpath-relative) for a file, collapsing a trailing disc folder
// (CD1, Disc 2, …) into the album above it. Returns null for a file sitting
// directly in the vpath root (no album folder).
function _albumFolderPath(filepath) {
  const parts = String(filepath || '').split('/');
  if (parts.length < 2) return null;
  const immediateParent = parts[parts.length - 2];
  const albumDepth = (parts.length >= 3 && _isDiscFolder(immediateParent))
    ? parts.length - 3
    : parts.length - 2;
  if (albumDepth < 0) return null;
  return parts.slice(0, albumDepth + 1).join('/');
}
// Folder-based album_id: the file's album directory identifies the album. Loose
// root files (no folder) fall back to the tag-based scheme.
function _albumIdFor(vpath, filepath, artist, album) {
  const dir = _albumFolderPath(filepath);
  if (dir) {
    return createHash('md5') // NOSONAR: MD5 used as DB identity key, not for security
      .update(`dir|||${vpath}|||${dir}`)
      .digest('hex').slice(0, 16);
  }
  return _makeAlbumId(artist, album);
}

// Display name for a folder-based album = the album directory's last segment
// (the folder the user sees), matching the web ALBUMS view. Resolved from a
// representative file per album_id and cached — the (album_id → folder) mapping
// is immutable (a moved file gets a new album_id). Null for tag-based/root
// albums, where callers fall back to the album tag.
const _albumNameCache = new Map();
let _albumNameStmt = null;
export function albumFolderName(albumId) {
  if (!albumId) return null;
  if (_albumNameCache.has(albumId)) return _albumNameCache.get(albumId);
  let name = null;
  try {
    if (!_albumNameStmt) _albumNameStmt = db.prepare('SELECT filepath FROM files WHERE album_id = ? LIMIT 1');
    const row = _albumNameStmt.get(albumId);
    const dir = row ? _albumFolderPath(row.filepath) : null;
    if (dir) name = dir.slice(dir.lastIndexOf('/') + 1) || null;
  } catch { /* fall back to tag name */ }
  _albumNameCache.set(albumId, name);
  return name;
}

/**
 * Compute the "physical album directory" from a file's relative filepath.
 * Strips the filename, then collapses any trailing /CD N / Disc N / Side N
 * indicator so that multi-disc albums group together under one directory key.
 */
function _normalizeAlbumDir(filepath) {
  const lastSlash = filepath.lastIndexOf('/');
  let dir = lastSlash > 0 ? filepath.slice(0, lastSlash) : '';
  // Collapse trailing disc-indicator segment so CD 1 and CD 2 share the same key
  dir = dir.replace(/\/(CD|Disc|Disk|Side)\s*\d+\s*$/i, '');
  return dir;
}

let db;
let _dbPath = null;
const _s = {}; // cached prepared statements — populated in init(), reused on every call
// Dynamic statement cache: keyed by SQL string. Covers search queries whose SQL
// varies by vpath count. On a typical server the vpath set is stable, so the
// cache always hits after the first search — saves sqlite3_prepare_v2 overhead
// on every keystroke (6 queries × every search request).
const _stmtCache = new Map();
function _prepare(sql) {
  let s = _stmtCache.get(sql);
  if (!s) { s = db.prepare(sql); _stmtCache.set(sql, s); }
  return s;
}

/** Expose raw DatabaseSync instance for modules (like DLNA) that need custom queries. */
export function getDB() { return db; }

export function init(dbDirectory) {
  mkdirSync(dbDirectory, { recursive: true });

  // Migration: rename legacy velvet.sqlite → velvet.sqlite on first run after upgrade
  const legacyPath = path.join(dbDirectory, 'velvet.sqlite');
  const newPath    = path.join(dbDirectory, 'velvet.sqlite');
  if (existsSync(legacyPath) && !existsSync(newPath)) {
    renameSync(legacyPath, newPath);
    // Also rename WAL/SHM sidecar files if present
    for (const suffix of ['-wal', '-shm']) {
      const legacySide = legacyPath + suffix;
      if (existsSync(legacySide)) renameSync(legacySide, newPath + suffix);
    }
  }

  const dbPath = path.join(dbDirectory, 'velvet.sqlite');
  _dbPath = dbPath;
  db = new DatabaseSync(dbPath);
  // Reset folder-name cache + its prepared statement (bound to the old db handle).
  _albumNameCache.clear();
  _albumNameStmt = null;
  db.exec('PRAGMA journal_mode=WAL');
  // NORMAL skips per-write fsync (safe with WAL); prevents 50-200ms event-loop
  // stalls on slow storage (SD card, HDD) that would interrupt audio streaming.
  db.exec('PRAGMA synchronous = NORMAL');
  // Wait up to 30 s for write locks before throwing "database is locked".
  // Needed when the acoustid worker thread also writes to the same DB.
  db.exec('PRAGMA busy_timeout = 30000');
  // Raise auto-checkpoint threshold so SQLite never triggers a blocking
  // checkpoint while a song is streaming. The WAL is cleaned up on DB close.
  db.exec('PRAGMA wal_autocheckpoint(10000)');
  // 32 MB page cache — default 2 MB is far too small for a 123K-song library;
  // keeps frequently-used B-tree pages (indexes, hot rows) in RAM.
  db.exec('PRAGMA cache_size = -32000');
  // Keep sort/temp B-trees in memory instead of spilling to disk.
  db.exec('PRAGMA temp_store = MEMORY');
  // Memory-mapped I/O (128 MB): reads map pages directly from the OS page cache
  // without an extra kernel→user memcpy. Especially useful on Docker bind mounts
  // and systems with multiple music roots where random page reads are frequent.
  db.exec('PRAGMA mmap_size = 134217728');
  // Migrate to 8 KB pages if still on the SQLite default 4 KB.
  // Larger pages = shallower B-trees = fewer reads per query on a 167 MB+ DB.
  // IMPORTANT: page_size cannot be changed while journal_mode=WAL is active.
  // We must temporarily switch to DELETE journal mode, VACUUM, then restore WAL.
  // Runs once on first boot after this change (~3–5 s for 167 MB); skipped on
  // all subsequent boots because page_size is already 8192.
  const currentPageSize = db.prepare('PRAGMA page_size').get().page_size;
  if (currentPageSize !== 8192) {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');  // flush WAL before switching modes
    db.exec('PRAGMA journal_mode = DELETE');     // WAL must be off for page_size change
    db.exec('PRAGMA page_size = 8192');
    db.exec('VACUUM');                           // rebuilds file with new page size
    db.exec('PRAGMA journal_mode = WAL');        // restore WAL
    _stmtCache.clear();                          // invalidate any pre-migration stmts
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      title TEXT, artist TEXT, year INTEGER, album TEXT,
      filepath TEXT NOT NULL, format TEXT, track INTEGER, trackOf INTEGER, disk INTEGER,
      modified REAL, hash TEXT, audio_hash TEXT, aaFile TEXT, vpath TEXT NOT NULL,
      ts INTEGER, sID TEXT, replaygainTrackDb REAL, genre TEXT, cuepoints TEXT,
      duration REAL, artist_id TEXT, album_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_files_filepath_vpath ON files(filepath, vpath);
    CREATE INDEX IF NOT EXISTS idx_files_vpath ON files(vpath);
    CREATE INDEX IF NOT EXISTS idx_files_hash ON files(hash);
    CREATE INDEX IF NOT EXISTS idx_files_ts ON files(ts);
    CREATE INDEX IF NOT EXISTS idx_files_year ON files(year);
    CREATE INDEX IF NOT EXISTS idx_files_genre ON files(genre);
    CREATE INDEX IF NOT EXISTS idx_files_album ON files(album);
    CREATE INDEX IF NOT EXISTS idx_files_artist ON files(artist);
    CREATE INDEX IF NOT EXISTS idx_files_full_path ON files(vpath || '/' || filepath);

    CREATE TABLE IF NOT EXISTS user_metadata (
      hash TEXT NOT NULL, user TEXT NOT NULL,
      rating INTEGER, pc INTEGER DEFAULT 0, lp INTEGER, starred INTEGER DEFAULT 0,
      UNIQUE(hash, user)
    );
    CREATE INDEX IF NOT EXISTS idx_um_user ON user_metadata(user);

    CREATE TABLE IF NOT EXISTS playlists (
      name TEXT NOT NULL, filepath TEXT,
      user TEXT NOT NULL, live INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_pl_user_name ON playlists(user, name);

    CREATE TABLE IF NOT EXISTS shared_playlists (
      playlistId TEXT NOT NULL UNIQUE,
      playlist TEXT NOT NULL,
      user TEXT NOT NULL, expires INTEGER, token TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sp_expires ON shared_playlists(expires);

    CREATE TABLE IF NOT EXISTS scan_errors (
      guid      TEXT NOT NULL PRIMARY KEY,
      filepath  TEXT NOT NULL,
      vpath     TEXT NOT NULL,
      error_type TEXT NOT NULL,
      error_msg  TEXT,
      stack      TEXT,
      first_seen INTEGER NOT NULL,
      last_seen  INTEGER NOT NULL,
      count      INTEGER NOT NULL DEFAULT 1,
      fixed_at   INTEGER,
      fix_action TEXT,
      confirmed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_se_last_seen ON scan_errors(last_seen);
    CREATE INDEX IF NOT EXISTS idx_se_vpath    ON scan_errors(vpath);
    CREATE INDEX IF NOT EXISTS idx_se_fixed_at ON scan_errors(fixed_at);

    CREATE TABLE IF NOT EXISTS scan_runs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      scan_id     TEXT,
      vpath       TEXT NOT NULL,
      started_at  INTEGER,
      finished_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_scan_runs_finished_at ON scan_runs(finished_at);
    CREATE INDEX IF NOT EXISTS idx_scan_runs_vpath ON scan_runs(vpath);

    CREATE TABLE IF NOT EXISTS user_settings (
      username TEXT NOT NULL PRIMARY KEY,
      prefs    TEXT NOT NULL DEFAULT '{}',
      queue    TEXT NOT NULL DEFAULT 'null'
    );

    CREATE TABLE IF NOT EXISTS radio_stations (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      user    TEXT NOT NULL,
      name    TEXT NOT NULL,
      genre   TEXT,
      country TEXT,
      link_a  TEXT,
      link_b  TEXT,
      link_c  TEXT,
      img     TEXT,
      sort_order INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_rs_user ON radio_stations(user);

    CREATE TABLE IF NOT EXISTS podcast_feeds (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user         TEXT NOT NULL,
      url          TEXT NOT NULL,
      title        TEXT,
      description  TEXT,
      img          TEXT,
      author       TEXT,
      language     TEXT,
      last_fetched INTEGER,
      created_at   INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_pf_user ON podcast_feeds(user);

    CREATE TABLE IF NOT EXISTS podcast_episodes (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      feed_id       INTEGER NOT NULL,
      guid          TEXT NOT NULL,
      title         TEXT,
      description   TEXT,
      audio_url     TEXT NOT NULL,
      pub_date      INTEGER,
      duration_secs INTEGER DEFAULT 0,
      img           TEXT,
      played        INTEGER DEFAULT 0,
      play_position REAL DEFAULT 0,
      created_at    INTEGER,
      UNIQUE(feed_id, guid)
    );
    CREATE INDEX IF NOT EXISTS idx_pe_feed_id ON podcast_episodes(feed_id);

    CREATE TABLE IF NOT EXISTS smart_playlists (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      user     TEXT NOT NULL,
      name     TEXT NOT NULL,
      filters  TEXT NOT NULL DEFAULT '{}',
      sort     TEXT NOT NULL DEFAULT 'artist',
      limit_n  INTEGER NOT NULL DEFAULT 100,
      created  INTEGER NOT NULL,
      UNIQUE(user, name)
    );
    CREATE INDEX IF NOT EXISTS idx_spl_user ON smart_playlists(user);

    CREATE TABLE IF NOT EXISTS genre_groups (
      id     INTEGER PRIMARY KEY DEFAULT 1,
      groups TEXT NOT NULL DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS radio_schedules (
      id           TEXT PRIMARY KEY,
      username     TEXT NOT NULL,
      station_name TEXT NOT NULL,
      stream_url   TEXT NOT NULL,
      art_file     TEXT,
      vpath        TEXT NOT NULL,
      start_time   TEXT NOT NULL,
      start_date   TEXT,
      duration_min INTEGER NOT NULL DEFAULT 60,
      recurrence   TEXT NOT NULL DEFAULT 'once',
      recur_days   TEXT,
      description  TEXT,
      enabled      INTEGER NOT NULL DEFAULT 1,
      created_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_rsched_user    ON radio_schedules(username);
    CREATE INDEX IF NOT EXISTS idx_rsched_enabled ON radio_schedules(enabled);

    CREATE TABLE IF NOT EXISTS play_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      TEXT NOT NULL,
      file_hash    TEXT NOT NULL,
      started_at   INTEGER NOT NULL,
      ended_at     INTEGER,
      duration_ms  INTEGER,
      played_ms    INTEGER,
      completed    INTEGER DEFAULT 0,
      skipped      INTEGER DEFAULT 0,
      source       TEXT,
      session_id   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_pe_user_started  ON play_events(user_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_pe_user_hash     ON play_events(user_id, file_hash);
    CREATE INDEX IF NOT EXISTS idx_pe_session       ON play_events(session_id);
    CREATE INDEX IF NOT EXISTS idx_pe_user_completed ON play_events(user_id, completed);

    CREATE TABLE IF NOT EXISTS listening_sessions (
      session_id   TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL,
      started_at   INTEGER NOT NULL,
      ended_at     INTEGER,
      total_tracks INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_ls_user_started ON listening_sessions(user_id, started_at);

    CREATE TABLE IF NOT EXISTS radio_play_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      TEXT NOT NULL,
      station_id   INTEGER,
      station_name TEXT NOT NULL,
      started_at   INTEGER NOT NULL,
      ended_at     INTEGER,
      listened_ms  INTEGER DEFAULT 0,
      session_id   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_rpe_user_started ON radio_play_events(user_id, started_at);

    CREATE TABLE IF NOT EXISTS podcast_play_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     TEXT NOT NULL,
      episode_id  INTEGER NOT NULL,
      feed_id     INTEGER NOT NULL,
      started_at  INTEGER NOT NULL,
      ended_at    INTEGER,
      played_ms   INTEGER DEFAULT 0,
      completed   INTEGER DEFAULT 0,
      session_id  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_ppe_user_started ON podcast_play_events(user_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_ppe_user_feed    ON podcast_play_events(user_id, feed_id);

    CREATE TABLE IF NOT EXISTS bookmarks (
      username TEXT NOT NULL,
      song_id  TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      comment  TEXT,
      created  INTEGER NOT NULL,
      changed  INTEGER NOT NULL,
      PRIMARY KEY (username, song_id)
    );
  `);
  // Migration: add cuepoints column for databases created before this feature
  try { db.exec('ALTER TABLE files ADD COLUMN cuepoints TEXT'); } catch { /* already exists */ }
  // Migration: add fixed_at column for scan-error auto-fix feature
  try { db.exec('ALTER TABLE scan_errors ADD COLUMN fixed_at INTEGER'); } catch { /* already exists */ }
  // Migration: add art_source column to track art provenance (embedded / directory / discogs)
  try { db.exec('ALTER TABLE files ADD COLUMN art_source TEXT'); } catch { /* already exists */ }
  // Migration: add audio_hash column for dual-hash identity (prevents data loss on transcodes)
  try { db.exec('ALTER TABLE files ADD COLUMN audio_hash TEXT'); } catch { /* already exists */ }
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_files_audio_hash ON files(audio_hash)'); } catch { /* already exists */ }
  // Migration: add duration column (track length in seconds)
  try { db.exec('ALTER TABLE files ADD COLUMN duration REAL'); } catch { /* already exists */ }
  // Migration: add description column to radio_schedules
  try { db.exec('ALTER TABLE radio_schedules ADD COLUMN description TEXT'); } catch { /* already exists */ }
  // Migration: add fix_action column to record what the fix button actually did
  try { db.exec('ALTER TABLE scan_errors ADD COLUMN fix_action TEXT'); } catch { /* already exists */ }
  // Migration: add confirmed_at column to record when a rescan confirmed the file is OK
  try { db.exec('ALTER TABLE scan_errors ADD COLUMN confirmed_at INTEGER'); } catch { /* already exists */ }
  // Migration: add artist_id / album_id columns for indexed Subsonic-style lookups
  try { db.exec('ALTER TABLE files ADD COLUMN artist_id TEXT'); } catch { /* already exists */ }
  try { db.exec('ALTER TABLE files ADD COLUMN album_id TEXT'); } catch { /* already exists */ }
  // Migration: add starred column to user_metadata for Subsonic star/unstar
  try { db.exec('ALTER TABLE user_metadata ADD COLUMN starred INTEGER DEFAULT 0'); } catch { /* already exists */ }
  // Migration: add sort_order to podcast_feeds for drag-to-reorder
  try { db.exec('ALTER TABLE podcast_feeds ADD COLUMN sort_order INTEGER DEFAULT 0'); } catch { /* already exists */ }
  // Migration: add trackOf (track total) for complete-album detection
  try { db.exec('ALTER TABLE files ADD COLUMN trackOf INTEGER'); } catch { /* already exists */ }
  // Migration: add cover_file to store the original cover image filename (e.g. "cover.jpg") discovered during scan
  try { db.exec('ALTER TABLE files ADD COLUMN cover_file TEXT'); } catch { /* already exists */ }
  // Migration: add pause_count to play_events to track user-initiated pauses
  try { db.exec('ALTER TABLE play_events ADD COLUMN pause_count INTEGER DEFAULT 0'); } catch { /* already exists */ }
  // Migration: AcoustID fingerprinting columns
  try { db.exec('ALTER TABLE files ADD COLUMN acoustid_id TEXT'); }     catch { /* noop */ }
  try { db.exec('ALTER TABLE files ADD COLUMN mbid TEXT'); }             catch { /* noop */ }
  try { db.exec('ALTER TABLE files ADD COLUMN acoustid_score REAL'); }   catch { /* noop */ }
  try { db.exec('ALTER TABLE files ADD COLUMN acoustid_status TEXT'); }  catch { /* noop */ }
  try { db.exec('ALTER TABLE files ADD COLUMN acoustid_ts INTEGER'); }   catch { /* noop */ }
  // Migration: AcoustID v2 — canonical MB title/artist stored from recordings meta
  try { db.exec('ALTER TABLE files ADD COLUMN mb_title TEXT'); }         catch { /* noop */ }
  try { db.exec('ALTER TABLE files ADD COLUMN mb_artist TEXT'); }        catch { /* noop */ }
  try { db.exec('ALTER TABLE files ADD COLUMN mb_artist_id TEXT'); }     catch { /* noop */ }
  // Migration: Tag Workshop — MusicBrainz enrichment columns (Phase 2)
  try { db.exec('ALTER TABLE files ADD COLUMN mb_album TEXT'); }              catch { /* noop */ }
  try { db.exec('ALTER TABLE files ADD COLUMN mb_year INTEGER'); }            catch { /* noop */ }
  try { db.exec('ALTER TABLE files ADD COLUMN mb_track INTEGER'); }           catch { /* noop */ }
  try { db.exec('ALTER TABLE files ADD COLUMN mb_release_id TEXT'); }         catch { /* noop */ }
  try { db.exec('ALTER TABLE files ADD COLUMN mb_enrichment_status TEXT'); }  catch { /* noop */ }
  try { db.exec('ALTER TABLE files ADD COLUMN mb_enriched_ts INTEGER'); }     catch { /* noop */ }
  try { db.exec('ALTER TABLE files ADD COLUMN mb_enrichment_error TEXT'); }   catch { /* noop */ }
  try { db.exec('ALTER TABLE files ADD COLUMN tag_status TEXT'); }            catch { /* noop */ }
  // Migration: Tag Workshop Phase 3 — per-physical-album grouping
  try { db.exec('ALTER TABLE files ADD COLUMN mb_album_dir TEXT'); }          catch { /* noop */ }
  // Migration: Tag Workshop — MB Text Search fallback columns (Phase 4)
  try { db.exec('ALTER TABLE files ADD COLUMN mb_text_search_status TEXT'); } catch { /* already exists */ }
  try { db.exec('ALTER TABLE files ADD COLUMN mb_text_search_score REAL'); }  catch { /* already exists */ }
  try { db.exec('ALTER TABLE files ADD COLUMN mb_text_search_ts INTEGER'); }  catch { /* already exists */ }
  try { db.exec('ALTER TABLE files ADD COLUMN mb_text_search_error TEXT'); }  catch { /* already exists */ }
  // Migration: audio technical metadata — bitrate (kbps), sample_rate (Hz), channels
  try { db.exec('ALTER TABLE files ADD COLUMN bitrate INTEGER'); }             catch { /* noop */ }
  try { db.exec('ALTER TABLE files ADD COLUMN sample_rate INTEGER'); }         catch { /* noop */ }
  try { db.exec('ALTER TABLE files ADD COLUMN channels INTEGER'); }            catch { /* noop */ }
  // Migration: album_artist tag (ID3 TPE2 / ALBUMARTIST) — stored separately from track artist
  try { db.exec('ALTER TABLE files ADD COLUMN album_artist TEXT'); }           catch { /* noop */ }
  // Migration: album_artist — ALBUMARTIST as fetched from MusicBrainz release artist-credit
  try { db.exec('ALTER TABLE files ADD COLUMN mb_album_artist TEXT'); }        catch { /* noop */ }
  // Backfill mb_album_dir for all existing enriched rows (idempotent)
  try {
    const _bfDir = db.prepare(
      "SELECT filepath, vpath FROM files WHERE mb_release_id IS NOT NULL AND mb_album_dir IS NULL"
    ).all();
    if (_bfDir.length > 0) {
      const _bfDirUpd = db.prepare('UPDATE files SET mb_album_dir = ? WHERE filepath = ? AND vpath = ?');
      db.exec('BEGIN');
      for (const r of _bfDir) _bfDirUpd.run(_normalizeAlbumDir(r.filepath), r.filepath, r.vpath);
      db.exec('COMMIT');
    }
  } catch (e) { console.debug('[velvet]', e?.message ?? e); }
  db.exec('CREATE INDEX IF NOT EXISTS idx_files_mb_enrichment_status ON files(mb_enrichment_status)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_files_tag_status ON files(tag_status)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_files_mb_text_search_status ON files(mb_text_search_status)');
  // Tag Workshop performance: mb_release_id lookups and combined tag_status+mb_release_id listing queries
  db.exec('CREATE INDEX IF NOT EXISTS idx_files_mb_release_id ON files(mb_release_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_files_tag_status_mb_release ON files(tag_status, mb_release_id)');
  // Reset any 'found' rows that have null mbid (processed with broken meta flag) so they re-queue
  try {
    const _fixCount = db.prepare("SELECT COUNT(*) AS n FROM files WHERE acoustid_status='found' AND mbid IS NULL").get().n;
    if (_fixCount > 0) {
      db.exec("UPDATE files SET acoustid_status = NULL, acoustid_ts = NULL WHERE acoustid_status = 'found' AND mbid IS NULL");
    }
  } catch (e) { console.debug('[velvet]', e?.message ?? e); }
  // Ensure indexes exist (IF NOT EXISTS is idempotent — safe on every startup)
  db.exec('CREATE INDEX IF NOT EXISTS idx_files_artist_id ON files(artist_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_files_album_id ON files(album_id)');
  // Covering index for getAaFileForDir: fast folder-art lookups by (vpath, filepath prefix)
  db.exec('CREATE INDEX IF NOT EXISTS idx_files_vpath_filepath_aa ON files(vpath, filepath, aaFile)');
  // AcoustID: worker scans for NULL status to find unprocessed files
  db.exec('CREATE INDEX IF NOT EXISTS idx_files_acoustid_status ON files(acoustid_status)');
  // Composite index for the MB enrichment worker queue (acoustid_status + mb_enrichment_status + mbid)
  db.exec('CREATE INDEX IF NOT EXISTS idx_files_mb_enrich_queue ON files(acoustid_status, mb_enrichment_status, mbid)');
  // One-time backfill: compute artist_id / album_id for all records added before this migration
  const _bfCount = db.prepare('SELECT COUNT(*) AS cnt FROM files WHERE artist_id IS NULL').get().cnt;
  if (_bfCount > 0) {
    const _bfRows = db.prepare('SELECT rowid, artist, album FROM files WHERE artist_id IS NULL').all();
    const _bfUpd  = db.prepare('UPDATE files SET artist_id = ?, album_id = ? WHERE rowid = ?');
    db.exec('BEGIN');
    for (const r of _bfRows) _bfUpd.run(_makeArtistId(r.artist), _makeAlbumId(r.artist, r.album), r.rowid);
    db.exec('COMMIT');
  }

  // ── One-time recompute: folder-based album_id ──────────────────────────────
  // Subsonic clients group albums by the album_id column. To make that grouping
  // match how the library is organised on disk (folder = album, incl. multi-disc
  // and Various-Artists compilations), recompute album_id for every row with the
  // folder-based scheme. Gated by PRAGMA user_version so it runs once per scheme
  // bump and is skipped on every subsequent boot.
  //   v1 — folder-based for albumsOnly folders only
  //   v2 — folder-based for ALL folders (a folder of loose tracks is one album)
  const _ALBUM_ID_SCHEME_VERSION = 2;
  try {
    const _uv = db.prepare('PRAGMA user_version').get().user_version || 0;
    if (_uv < _ALBUM_ID_SCHEME_VERSION) {
      const _aiRows = db.prepare('SELECT rowid, vpath, filepath, artist, album FROM files').all();
      const _aiUpd  = db.prepare('UPDATE files SET album_id = ? WHERE rowid = ?');
      db.exec('BEGIN');
      for (const r of _aiRows) _aiUpd.run(_albumIdFor(r.vpath, r.filepath, r.artist, r.album), r.rowid);
      db.exec('COMMIT');
      db.exec(`PRAGMA user_version = ${_ALBUM_ID_SCHEME_VERSION}`);
      console.log(`[velvet] album_id recomputed (folder-based, scheme v${_ALBUM_ID_SCHEME_VERSION}) for ${_aiRows.length} rows`);
    }
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* no active txn */ }
    console.debug('[velvet] album_id recompute skipped:', e?.message ?? e);
  }

  // ── album_version columns (added post-initial-release) ─────────────────────
  try { db.exec('ALTER TABLE files ADD COLUMN album_version TEXT'); }        catch { /* noop */ }
  try { db.exec('ALTER TABLE files ADD COLUMN album_version_source TEXT'); } catch { /* already exists */ }
  try { db.exec('ALTER TABLE files ADD COLUMN bit_depth INTEGER'); }         catch { /* noop */ }

  // ── Additional migration indexes (idempotent, safe on every startup) ──────
  // aaFile: used by countArtUsage (per-file during art cleanup) and getLiveArtFilenames
  db.exec('CREATE INDEX IF NOT EXISTS idx_files_aaFile ON files(aaFile)');
  // (vpath, sID): used by getStaleFileHashes and removeStaleFiles after every scan pass
  db.exec('CREATE INDEX IF NOT EXISTS idx_files_vpath_sID ON files(vpath, sID)');
  // Effective artist: COALESCE(album_artist, artist) — used by artist browse and artist rebuild
  db.exec('CREATE INDEX IF NOT EXISTS idx_files_effective_artist ON files(COALESCE(album_artist, artist))');
  // user_metadata sort/filter indexes: Recently Played, Most Played, Rated, Starred
  db.exec('CREATE INDEX IF NOT EXISTS idx_um_user_lp      ON user_metadata(user, lp)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_um_user_pc      ON user_metadata(user, pc)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_um_user_rating  ON user_metadata(user, rating)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_um_user_starred ON user_metadata(user, starred)');

  // ── FTS5 full-text index (songs) ─────────────────────────────────────────
  // External-content table: FTS5 tokenises title/artist/album_artist/album/album_version/filepath
  // from the `files` table without duplicating the raw data.
  // unicode61 tokenizer with remove_diacritics=1: café == cafe, case-insensitive.
  //
  // Migration: if fts_files exists but lacks album_version or album_artist, drop and
  // recreate it — external-content tables cannot be ALTER TABLE'd. Data lives in
  // `files`; a rebuild restores everything with zero data loss.
  try {
    db.prepare('SELECT album_version, album_artist FROM fts_files LIMIT 0').run();
    // Full schema already in place — standard empty-index check
    const _ftsDataRows = db.prepare('SELECT COUNT(*) AS cnt FROM fts_files_data').get().cnt;
    if (_ftsDataRows < 5) {
      db.exec("INSERT INTO fts_files(fts_files) VALUES ('rebuild')");
    }
  } catch {
    // Missing album_version, album_artist, or fresh install — recreate the table.
    db.exec('DROP TABLE IF EXISTS fts_files');
    db.exec(`CREATE VIRTUAL TABLE fts_files USING fts5(
      title, artist, album_artist, album, album_version, filepath,
      content='files', content_rowid='rowid',
      tokenize='unicode61 remove_diacritics 1'
    )`);
    db.exec("INSERT INTO fts_files(fts_files) VALUES ('rebuild')");
  }

  // ── Folder index ─────────────────────────────────────────────────────────
  // One row per unique directory path extracted from files.filepath.
  // folder_name = the last path component (most information-dense part).
  db.exec(`CREATE TABLE IF NOT EXISTS folders (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    vpath       TEXT NOT NULL,
    dirpath     TEXT NOT NULL,
    folder_name TEXT NOT NULL,
    UNIQUE(vpath, dirpath)
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_folders_vpath ON folders(vpath)');
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS fts_folders USING fts5(
    folder_name,
    content='folders', content_rowid='id',
    tokenize='trigram'
  )`);

  // ── Normalized artist index ───────────────────────────────────────────────
  // One row per unique normalized artist name. artist_raw_variants stores all
  // raw tag variants that normalize to the same name (JSON array).
  // The DB itself is NOT modified — normalization happens at index-build time.
  db.exec(`CREATE TABLE IF NOT EXISTS artists_normalized (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    artist_clean        TEXT NOT NULL UNIQUE,
    artist_raw_variants TEXT NOT NULL DEFAULT '[]'
  )`);
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS fts_artists USING fts5(
    artist_clean,
    content='artists_normalized', content_rowid='id',
    tokenize='trigram'
  )`);
  // Migrations: add columns introduced after initial release
  try { db.exec("ALTER TABLE artists_normalized ADD COLUMN vpaths_json    TEXT DEFAULT '[]'"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE artists_normalized ADD COLUMN bio           TEXT"); }             catch { /* already exists */ }
  try { db.exec("ALTER TABLE artists_normalized ADD COLUMN image_file    TEXT"); }             catch { /* already exists */ }
  try { db.exec("ALTER TABLE artists_normalized ADD COLUMN image_source  TEXT"); }             catch { /* already exists */ }
  try { db.exec("ALTER TABLE artists_normalized ADD COLUMN last_fetched  INTEGER"); }          catch { /* already exists */ }
  try { db.exec("ALTER TABLE artists_normalized ADD COLUMN image_flag_wrong INTEGER DEFAULT 0"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE artists_normalized ADD COLUMN name_override INTEGER DEFAULT 0"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE artists_normalized ADD COLUMN song_count    INTEGER DEFAULT 0"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE artists_normalized ADD COLUMN mbid          TEXT"); }             catch { /* already exists */ }
  try { db.exec("ALTER TABLE artists_normalized ADD COLUMN fanart_file   TEXT"); }             catch { /* already exists */ }
  try { db.exec("ALTER TABLE artists_normalized ADD COLUMN genre         TEXT"); }             catch { /* already exists */ }
  try { db.exec("ALTER TABLE artists_normalized ADD COLUMN country       TEXT"); }             catch { /* already exists */ }
  try { db.exec("ALTER TABLE artists_normalized ADD COLUMN formed_year   INTEGER"); }          catch { /* already exists */ }

  // ── ReplayGain 2.0 / EBU R128 measurement columns (added v6.14.0) ─────────
  // Worker-measured values (rsgain / ffmpeg ebur128)
  try { db.exec('ALTER TABLE files ADD COLUMN rg_integrated_lufs  REAL'); }    catch { /* noop */ }
  try { db.exec('ALTER TABLE files ADD COLUMN rg_true_peak_dbfs   REAL'); }    catch { /* noop */ }
  try { db.exec('ALTER TABLE files ADD COLUMN rg_track_gain_db    REAL'); }    catch { /* noop */ }
  try { db.exec('ALTER TABLE files ADD COLUMN rg_lra              REAL'); }    catch { /* noop */ }
  try { db.exec('ALTER TABLE files ADD COLUMN rg_album_gain_db    REAL'); }    catch { /* noop */ }
  try { db.exec('ALTER TABLE files ADD COLUMN rg_album_peak_dbfs  REAL'); }    catch { /* noop */ }
  try { db.exec('ALTER TABLE files ADD COLUMN rg_measured_ts      INTEGER'); } catch { /* already exists */ }
  try { db.exec('ALTER TABLE files ADD COLUMN rg_measurement_tool TEXT'); }    catch { /* noop */ }
  try { db.exec('ALTER TABLE files ADD COLUMN rg_measurement_error TEXT'); }   catch { /* noop */ }
  // Tag-sourced fallback values (read from file tags at scan time)
  try { db.exec('ALTER TABLE files ADD COLUMN rg_tag_track_gain   REAL'); }    catch { /* noop */ }
  try { db.exec('ALTER TABLE files ADD COLUMN rg_tag_track_peak   REAL'); }    catch { /* noop */ }
  try { db.exec('ALTER TABLE files ADD COLUMN rg_tag_album_gain   REAL'); }    catch { /* noop */ }
  try { db.exec('ALTER TABLE files ADD COLUMN rg_tag_album_peak   REAL'); }    catch { /* noop */ }
  try { db.exec('ALTER TABLE files ADD COLUMN r128_track_gain_db  REAL'); }    catch { /* noop */ }
  try { db.exec('ALTER TABLE files ADD COLUMN r128_album_gain_db  REAL'); }    catch { /* noop */ }

  // ── BPM & Key Analysis ────────────────────────────────────────────────────
  try { db.exec('ALTER TABLE files ADD COLUMN bpm            INTEGER'); } catch { /* already exists */ }
  try { db.exec('ALTER TABLE files ADD COLUMN musical_key    TEXT'); }    catch { /* noop */ }
  try { db.exec('ALTER TABLE files ADD COLUMN bpm_source     TEXT'); }    catch { /* noop */ }
  try { db.exec('ALTER TABLE files ADD COLUMN ab_status      TEXT'); }    catch { /* noop */ }
  try { db.exec('ALTER TABLE files ADD COLUMN bpm_status     TEXT'); }    catch { /* noop */ }
  try { db.exec('ALTER TABLE files ADD COLUMN bpm_raw        REAL'); }    catch { /* noop */ }

  // ── RG backup table — stores pre-reset snapshot for undo-reset-all ────────
  // One row per file (file_rowid = rowid in `files`). Replaced atomically on
  // every Reset All; deleted on Undo or when the worker starts a new pass.
  db.exec(`CREATE TABLE IF NOT EXISTS rg_backup (
    file_rowid          INTEGER PRIMARY KEY,
    rg_measured_ts      INTEGER,
    rg_measurement_tool TEXT,
    rg_integrated_lufs  REAL,
    rg_true_peak_dbfs   REAL,
    rg_track_gain_db    REAL,
    rg_lra              REAL,
    rg_album_gain_db    REAL,
    rg_album_peak_dbfs  REAL,
    reset_ts            INTEGER NOT NULL
  )`);

  // ── Essentia audio_features table ────────────────────────────────────────
  // Stores per-track audio features computed by the Essentia WASM worker.
  // Linked to `files` via hash (content hash). Separate table so it does not
  // bloat the main files table with large JSON vectors.
  db.exec(`CREATE TABLE IF NOT EXISTS audio_features (
    hash               TEXT PRIMARY KEY,
    bpm                REAL,
    bpm_confidence     REAL,
    key_name           TEXT,
    key_scale          TEXT,
    key_strength       REAL,
    danceability       REAL,
    loudness           REAL,
    dynamic_complexity REAL,
    mfcc_mean          TEXT,
    hpcp_mean          TEXT,
    analyzed_at        INTEGER
  )`);

  // ── Smart Playlist ML tables ──────────────────────────────────────────────
  db.exec(`CREATE TABLE IF NOT EXISTS sp_slot_profiles (
    user_id       TEXT NOT NULL,
    slot          TEXT NOT NULL,
    profile       TEXT NOT NULL DEFAULT '[0.5,0.5,0.5,0.5,0.5,0.5,0.5]',
    play_count    INTEGER DEFAULT 0,
    last_event_id INTEGER DEFAULT 0,
    updated_at    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, slot)
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS sp_generated_playlists (
    user_id      TEXT NOT NULL,
    slot         TEXT NOT NULL,
    tracks       TEXT NOT NULL DEFAULT '[]',
    generated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, slot)
  )`);

  // ── Subsonic Play Queue (savePlayQueue / getPlayQueue) ────────────────────
  db.exec(`CREATE TABLE IF NOT EXISTS play_queues (
    username   TEXT PRIMARY KEY,
    current_id TEXT,
    position_ms INTEGER NOT NULL DEFAULT 0,
    changed    INTEGER NOT NULL,
    changed_by TEXT,
    song_ids   TEXT NOT NULL DEFAULT '[]'
  )`);

  // ── Missing indexes (added post-initial-release) ──────────────────────────
  // Artist Home page: ORDER BY song_count DESC LIMIT 20 — was a full 18k-row
  // scan + temp B-TREE sort on every page load.
  db.exec('CREATE INDEX IF NOT EXISTS idx_an_song_count ON artists_normalized(song_count DESC)');
  // Audit queries: WHERE image_flag_wrong=1 — full scan without this index.
  db.exec('CREATE INDEX IF NOT EXISTS idx_an_image_flag ON artists_normalized(image_flag_wrong, song_count DESC)');
  // Artist browse: WHERE vpath=? AND artist=? — was hitting idx_files_vpath_sID
  // then scanning the entire vpath partition to match artist.
  db.exec('CREATE INDEX IF NOT EXISTS idx_files_vpath_artist ON files(vpath, artist)');

  // ── Cache hot-path prepared statements ───────────────────────────────────
  // These functions are called once per file during scans (up to 123K times).
  // Caching avoids re-running sqlite3_prepare_v2 on every call.
  Object.assign(_s, {
    findFile:       db.prepare('SELECT rowid AS id, * FROM files WHERE filepath = ? AND vpath = ?'),
    updateScanId:   db.prepare('UPDATE files SET sID = ? WHERE filepath = ? AND vpath = ?'),
    updateArt:      db.prepare('UPDATE files SET aaFile = ?, sID = ?, art_source = ?, cover_file = ? WHERE filepath = ? AND vpath = ?'),
    countArtUsage:  db.prepare('SELECT COUNT(*) AS cnt FROM files WHERE aaFile = ?'),
    updateCue:      db.prepare('UPDATE files SET cuepoints = ? WHERE filepath = ? AND vpath = ?'),
    updateDuration: db.prepare('UPDATE files SET duration = ? WHERE filepath = ? AND vpath = ?'),
    updateTechMeta: db.prepare('UPDATE files SET bitrate = ?, sample_rate = ?, channels = ?, bit_depth = ? WHERE filepath = ? AND vpath = ?'),
    updateAlbumVersion: db.prepare('UPDATE files SET album_version = ?, album_version_source = ? WHERE filepath = ? AND vpath = ?'),
    liveArt:        db.prepare('SELECT DISTINCT aaFile FROM files WHERE aaFile IS NOT NULL'),
    liveHashes:     db.prepare('SELECT DISTINCT hash FROM files WHERE hash IS NOT NULL'),
    staleHashes:    db.prepare('SELECT hash FROM files WHERE vpath = ? AND (sID IS NULL OR sID != ?) AND hash IS NOT NULL'),
    removeStale:    db.prepare('DELETE FROM files WHERE vpath = ? AND (sID IS NULL OR sID != ?)'),
    clearScanIds:   db.prepare('UPDATE files SET sID = NULL WHERE vpath = ?'),
    removeByPath:   db.prepare('DELETE FROM files WHERE filepath = ? AND vpath = ?'),
    rgByHash:       db.prepare(`
      SELECT rg_measured_ts, rg_measurement_tool, rg_integrated_lufs,
             rg_true_peak_dbfs, rg_track_gain_db, rg_lra,
             rg_album_gain_db, rg_album_peak_dbfs
      FROM files
      WHERE hash = ? AND rg_measured_ts > 0
      ORDER BY rg_measured_ts DESC, rowid DESC
      LIMIT 1
    `),
    insertScanRun:  db.prepare('INSERT INTO scan_runs (scan_id, vpath, started_at, finished_at) VALUES (?, ?, ?, ?)'),
    getLastScanRun: db.prepare('SELECT MAX(finished_at) AS ts FROM scan_runs'),
    insertFileTs:   db.prepare('SELECT ts FROM files WHERE hash = ? AND ts IS NOT NULL LIMIT 1'),
    insertFileRow:  db.prepare(
      'INSERT INTO files (title, artist, album_artist, year, album, filepath, format, track, trackOf, disk, modified, hash, audio_hash, aaFile, vpath, ts, sID, replaygainTrackDb, genre, cuepoints, art_source, duration, artist_id, album_id, cover_file, bitrate, sample_rate, channels, album_version, album_version_source, bit_depth, bpm, musical_key, bpm_source, ab_status) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    restoreInsertedRg: db.prepare(`
      UPDATE files SET
        rg_measured_ts = ?,
        rg_measurement_tool = ?,
        rg_integrated_lufs = ?,
        rg_true_peak_dbfs = ?,
        rg_track_gain_db = ?,
        rg_lra = ?,
        rg_album_gain_db = ?,
        rg_album_peak_dbfs = ?
      WHERE rowid = ?
    `),
    // FTS5 write statements — used in insert / remove / tag-update paths
    ftsInsert:  db.prepare('INSERT INTO fts_files(rowid, title, artist, album_artist, album, album_version, filepath) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    ftsDel:     db.prepare("INSERT INTO fts_files(fts_files, rowid, title, artist, album_artist, album, album_version, filepath) VALUES ('delete', ?, ?, ?, ?, ?, ?, ?)"),
    ftsRebuild: db.prepare("INSERT INTO fts_files(fts_files) VALUES ('rebuild')"),
    // Metadata lookup — called on every queue restore; caching avoids repeated prepare overhead
    getFileWithMeta: db.prepare(`
      SELECT f.rowid AS id, f.*, um.rating
      FROM files f
      LEFT JOIN user_metadata um ON f.hash = um.hash AND um.user = ?
      WHERE f.filepath = ? AND f.vpath = ?`),
    // Artist search — static SQL (all vpath filtering done in JS); cached here
    // to avoid re-prepare on every keystroke.
    searchArtists: db.prepare(`
      SELECT an.id, an.artist_clean, an.artist_raw_variants, an.vpaths_json
      FROM artists_normalized an
      JOIN fts_artists fa ON an.id = fa.rowid
      WHERE fts_artists MATCH ?
      ORDER BY rank`),  // No LIMIT — full result set returned for accurate counts
  });
  // Run ANALYZE deferred so startup latency is not affected.
  // ANALYZE populates sqlite_stat1 with accurate row counts, letting the query
  // planner make optimal decisions for FTS JOIN queries and ORDER BY plans.
  // Critical for Docker deployments with multiple music roots.
  setImmediate(() => { try { db.exec('ANALYZE'); } catch (e) { console.debug('[velvet]', e?.message ?? e); } });
}

export function close() {
  if (db) { db.close(); }
}

// Produce a clean, fully-checkpointed, WAL-free snapshot of the database at
// destPath. Uses SQLite's built-in VACUUM INTO which is safe to run while the
// database is live (no external lock required).
export function vacuumInto(destPath) {
  db.exec(`VACUUM INTO '${destPath.replaceAll("'", "''")}'`);
}

// Save operations (no-ops for SQLite - writes are immediate)
export function saveFilesDB() { /* no-op: SQLite writes are immediate */ }

export function beginTransaction() {
  try { db.exec('BEGIN'); } catch (e) { console.debug('[velvet]', e?.message ?? e); }
}
export function commitTransaction() {
  try { db.exec('COMMIT'); } catch (e) { console.debug('[velvet]', e?.message ?? e); }
}
export function beginTransactionStrict() {
  db.exec('BEGIN');
}
export function commitTransactionStrict() {
  db.exec('COMMIT');
}
export function rollbackTransactionStrict() {
  db.exec('ROLLBACK');
}
export function savepoint(name) { db.exec(`SAVEPOINT ${name}`); }
export function releasePoint(name) { db.exec(`RELEASE ${name}`); }
export function rollbackToPoint(name) { db.exec(`ROLLBACK TO ${name}`); }
export function saveUserDB() { /* no-op: SQLite writes are immediate */ }
export function saveShareDB() { /* no-op: SQLite writes are immediate */ }

// ── Artist name normalization ─────────────────────────────────────────────
// Server-side equivalent of the frontend cleanArtistDisplay() / normalizeArtist().
// Strip leading noise (symbols, zero-padded numbers like "01 ", "02 ") from
// artist tag values that were maltagged with track numbers.
// Genuinely numeric names (10cc, 2Pac, 808 State) are preserved because they
// don't match the zero-padded number pattern.
function _cleanArtist(name) {
  if (!name) return '';
  const noise = /^[\s#'"`()|[\]{}_.,\-\u2013\u2014*!/\\]+/;
  return String(name)
    .replace(noise, '')               // strip leading symbols
    .replace(/^\d{2,}[\s.,)\]]+/, '') // strip any 2-digit+ leading number ("01 ", "28 ", "100 ", etc.)
    .replace(noise, '')               // strip any newly-exposed leading symbols
    .trim();
}
function _normalizeArtist(name) {
  return _cleanArtist(name).toLowerCase();
}

// ── Rebuild folder index ──────────────────────────────────────────────────
// Called after every scan completes. Extracts all unique directory paths from
// the files table, populates the `folders` table, and rebuilds fts_folders.
export function rebuildFolderIndex() {
  // Extract unique (vpath, dirpath) combinations from files.filepath
  const rows = db.prepare(
    "SELECT vpath, filepath FROM files WHERE filepath IS NOT NULL"
  ).all();

  const seen = new Set();
  const toInsert = [];
  for (const row of rows) {
    // dirpath = everything except the filename (last path component)
    const slashIdx = row.filepath.lastIndexOf('/');
    if (slashIdx <= 0) continue; // file is directly at root of vpath, no folder
    const dirpath = row.filepath.slice(0, slashIdx);
    const key = `${row.vpath}\0${dirpath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // folder_name = the last component of the dirpath
    const lastSlash = dirpath.lastIndexOf('/');
    const folder_name = lastSlash >= 0 ? dirpath.slice(lastSlash + 1) : dirpath;
    toInsert.push({ vpath: row.vpath, dirpath, folder_name });
  }

  db.exec('BEGIN');
  db.exec('DELETE FROM folders');
  const ins = db.prepare('INSERT INTO folders (vpath, dirpath, folder_name) VALUES (?, ?, ?)');
  for (const r of toInsert) ins.run(r.vpath, r.dirpath, r.folder_name);
  db.exec('COMMIT');

  // Rebuild FTS from the freshly populated folders table
  db.exec("INSERT INTO fts_folders(fts_folders) VALUES ('rebuild')");
}

// ── Rebuild normalized artist index ──────────────────────────────────────
// Called after every scan completes. Groups all raw artist tag values by their
// normalized form and stores the grouping in artists_normalized.
// Uses the smart buildArtistGroups() algorithm that:
//   • merges zero-padded duplicates ("01 DJ Deep" → "DJ Deep") when a clean
//     version exists with ≥50% as many songs
//   • preserves real digit-named artists ("2 Unlimited", "808 State", "50 Cent")
//   • preserves admin-set name_override, bio, image_file across rebuilds
// Queued callbacks to fire after the current in-flight rebuild completes.
const _rebuildDoneCallbacks = [];

/**
 * Inner logic: spawns the artist-rebuild worker thread and returns a Promise
 * that resolves (never rejects) when the worker exits.  The broker awaits
 * this Promise before starting any subsequent task.
 */
function _doRebuildArtistIndex() {
  return new Promise((resolve) => {
    const filter = getArtistFolderFilter();
    const worker = new Worker(_workerPath, {
      workerData: {
        dbPath: _dbPath,
        vpaths: filter.vpaths,
        includeFilepathPrefixes: filter.includeFilepathPrefixes,
        excludeFilepathPrefixes: filter.excludeFilepathPrefixes,
      },
    });

    worker.on('message', msg => {
      if (msg.error) {
        import('winston').then(w => w.default.error(`Artist index rebuild failed: ${msg.error}`)).catch(() => {});
      }
    });

    worker.on('exit', () => {
      const cbs = _rebuildDoneCallbacks.splice(0);
      for (const cb of cbs) { try { cb(); } catch (e) { console.debug('[velvet]', e?.message ?? e); } }
      resolve();
    });

    worker.on('error', err => {
      import('winston').then(w => w.default.error(`Artist rebuild worker error: ${err.message}`)).catch(() => {});
      resolve(); // never leave broker stuck
    });
  });
}

export function rebuildArtistIndex(onComplete) {
  if (typeof onComplete === 'function') _rebuildDoneCallbacks.push(onComplete);
  broker.submit('artist-rebuild', 'Artist index rebuild', _doRebuildArtistIndex);
}

// Helper: build IN clause for variable-length arrays
function vpathFilter(vpaths, ignoreVPaths) {
  const filtered = [];
  for (const v of vpaths) {
    if (ignoreVPaths && typeof ignoreVPaths === 'object' && ignoreVPaths.includes(v)) {
      continue;
    }
    filtered.push(v);
  }
  return filtered;
}

function inClause(column, values) {
  if (values.length === 0) { return { sql: '1=0', params: [] }; }
  const placeholders = values.map(() => '?').join(',');
  return { sql: `${column} IN (${placeholders})`, params: values };
}

// Returns an additional AND clause that restricts filepath to a subfolder prefix.
// Used when a Subsonic client selects a child vpath (stored in DB under a parent vpath).
function prefixClause(prefix, col = 'filepath') {
  if (!prefix) return { sql: '', params: [] };
  const escaped = prefix.replaceAll(/[%_\\]/g, String.raw`\$&`);
  return { sql: String.raw` AND ${col} LIKE ? ESCAPE '\'`, params: [escaped + '%'] };
}

// Generates NOT clauses to exclude filepath prefixes under specific vpaths.
// Used to exclude 'audio-books' child folders from music queries.
function excludePrefixClauses(excludeFilepathPrefixes, vpathCol = 'vpath', pathCol = 'filepath') {
  if (!Array.isArray(excludeFilepathPrefixes) || excludeFilepathPrefixes.length === 0) {
    return { sql: '', params: [] };
  }
  const parts = [];
  const params = [];
  for (const { vpath, prefix } of excludeFilepathPrefixes) {
    parts.push(String.raw`NOT (${vpathCol} = ? AND ${pathCol} LIKE ? ESCAPE '\')`);
    params.push(vpath, prefix.replaceAll(/[%_\\]/g, String.raw`\$&`) + '%');
  }
  return { sql: ' AND ' + parts.join(' AND '), params };
}

// Generates AND clauses to WHITELIST filepath prefixes under specific vpaths.
// Used for albumsOnly filtering: for each named parent vpath, only include rows
// where the filepath starts with one of the given prefixes.
// Other vpaths (not named here) are passed through unrestricted.
// Logic per parent: AND (vpath != 'parent' OR (filepath LIKE 'prefix1%' OR ...))
function includePrefixClauses(includeFilepathPrefixes, vpathCol = 'vpath', pathCol = 'filepath') {
  if (!Array.isArray(includeFilepathPrefixes) || includeFilepathPrefixes.length === 0) {
    return { sql: '', params: [] };
  }
  const byVpath = {};
  for (const { vpath, prefix } of includeFilepathPrefixes) {
    if (!byVpath[vpath]) byVpath[vpath] = [];
    byVpath[vpath].push(prefix);
  }
  const parts = [];
  const params = [];
  for (const [vpath, prefixes] of Object.entries(byVpath)) {
    const orParts = prefixes.map(() => String.raw`${pathCol} LIKE ? ESCAPE '\'`);
    parts.push(`(${vpathCol} != ? OR (${orParts.join(' OR ')}))`);
    params.push(vpath, ...prefixes.map(p => p.replaceAll(/[%_\\]/g, String.raw`\$&`) + '%'));
  }
  return { sql: ' AND ' + parts.join(' AND '), params };
}

function withSlash(p) {
  return String(p || '').replace(/\/?$/, '/');
}

function getArtistFolderFilter() {
  const folders = config.program?.folders || {};
  const entries = Object.entries(folders);

  function findParent(name) {
    const myRoot = withSlash(folders[name]?.root);
    let best = null;
    let bestLen = -1;
    for (const [other, folder] of entries) {
      if (other === name) continue;
      const otherRoot = withSlash(folder.root);
      if (myRoot === otherRoot) continue;
      if (!myRoot.startsWith(otherRoot)) continue;
      if (otherRoot.length > bestLen) {
        best = other;
        bestLen = otherRoot.length;
      }
    }
    return best;
  }

  function findRoot(name) {
    let cur = name;
    let parent = findParent(cur);
    while (parent) {
      cur = parent;
      parent = findParent(cur);
    }
    return cur;
  }

  const rootNames = entries.map(([name]) => name).filter(name => !findParent(name));
  const allowedRoots = new Set();
  const includeFilepathPrefixes = [];
  const excludeFilepathPrefixes = [];

  for (const rootName of rootNames) {
    const rootFolder = folders[rootName] || {};
    if (rootFolder.type === 'excluded') continue;

    const rootEnabled = rootFolder.artistsOn !== false;
    const rootPath = withSlash(rootFolder.root);
    const descendants = entries.filter(([name, folder]) => {
      if (name === rootName) return false;
      if ((folder.type || 'music') === 'excluded') return false;
      return findRoot(name) === rootName;
    });

    const enabledPrefixes = [];
    for (const [, folder] of descendants) {
      const prefix = withSlash(folder.root).slice(rootPath.length);
      if (!prefix) continue;
      if (folder.artistsOn === false) {
        excludeFilepathPrefixes.push({ vpath: rootName, prefix });
      } else if (!rootEnabled) {
        enabledPrefixes.push(prefix);
      }
    }

    if (rootEnabled) {
      allowedRoots.add(rootName);
      continue;
    }

    if (enabledPrefixes.length > 0) {
      allowedRoots.add(rootName);
      for (const prefix of enabledPrefixes) {
        includeFilepathPrefixes.push({ vpath: rootName, prefix });
      }
    }
  }

  return {
    vpaths: [...allowedRoots],
    includeFilepathPrefixes,
    excludeFilepathPrefixes,
  };
}

// File Operations
export function findFileByPath(filepath, vpath) {
  const row = _s.findFile.get(filepath, vpath);
  return row || null;
}

// Batch lookup: returns a Map<filepath, row> for all matching filepaths.
// Uses the cached _s.findFile prepared statement in a read transaction —
// avoids building dynamic SQL with variable-length IN clauses, which can
// trigger SQLITE_MAX_VARIABLE_NUMBER errors in node:sqlite's DatabaseSync.
export function findFilesByPaths(filepaths, vpath) {
  const map = new Map();
  if (!filepaths.length) return map;
  for (const fp of filepaths) {
    const row = _s.findFile.get(fp, vpath);
    if (row) map.set(fp, row);
  }
  return map;
}

export function updateFileScanId(file, scanId) {
  _s.updateScanId.run(scanId, file.filepath, file.vpath);
}

// Batch scanId update: wraps all individual UPDATEs in a single transaction.
// Reduces 200 auto-commit transactions to 1, giving ~200x write throughput.
export function batchUpdateScanIds(filepaths, vpath, scanId) {
  db.exec('SAVEPOINT batchScanIds');
  try {
    for (const fp of filepaths) _s.updateScanId.run(scanId, fp, vpath);
    db.exec('RELEASE batchScanIds');
  } catch (e) {
    db.exec('ROLLBACK TO batchScanIds');
    throw e;
  }
}

export function updateFileArt(filepath, vpath, aaFile, scanId, artSource = null, coverFile = null) {
  _s.updateArt.run(aaFile, scanId, artSource, coverFile, filepath, vpath);
}

export function countArtUsage(aaFile) {
  return _s.countArtUsage.get(aaFile).cnt;
}

export function updateFileCue(filepath, vpath, cuepoints) {
  // cuepoints is either a JSON string or '[]' (sentinel = checked, no cue)
  _s.updateCue.run(cuepoints, filepath, vpath);
}

export function updateFileDuration(filepath, vpath, duration) {
  _s.updateDuration.run(duration, filepath, vpath);
}

export function updateFileTechMeta(filepath, vpath, bitrate, sampleRate, channels, bitDepth) {
  const r = _s.updateTechMeta.run(bitrate ?? null, sampleRate ?? null, channels ?? null, bitDepth ?? null, filepath, vpath);
  return r.changes;
}

export function updateFileAlbumVersion(filepath, vpath, albumVersion, albumVersionSource) {
  const r = _s.updateAlbumVersion.run(albumVersion ?? null, albumVersionSource ?? null, filepath, vpath);
  return r.changes;
}

export function getFileDuration(filepath) {
  const row = db.prepare('SELECT duration FROM files WHERE filepath = ? LIMIT 1').get(filepath);
  return row?.duration ?? null;
}

export function updateFileTags(filepath, vpath, tags) {
  const fields = [], values = [];
  if ('title'        in tags) { fields.push('title = ?');        values.push(tags.title        ?? null); }
  if ('artist'       in tags) { fields.push('artist = ?');       values.push(tags.artist       ?? null); }
  if ('album_artist' in tags) { fields.push('album_artist = ?'); values.push(tags.album_artist ?? null); }
  if ('album'        in tags) { fields.push('album = ?');        values.push(tags.album        ?? null); }
  if ('year'         in tags) { fields.push('year = ?');         values.push(tags.year         ?? null); }
  if ('genre'        in tags) { fields.push('genre = ?');        values.push(tags.genre        ?? null); }
  if ('track'        in tags) { fields.push('track = ?');        values.push(tags.track        ?? null); }
  if ('disk'         in tags) { fields.push('disk = ?');         values.push(tags.disk         ?? null); }
  if ('artist' in tags || 'album' in tags) {
    const cur = db.prepare('SELECT artist, album FROM files WHERE filepath = ? AND vpath = ?').get(filepath, vpath);
    const a = 'artist' in tags ? (tags.artist ?? null) : (cur?.artist ?? null);
    const b = 'album'  in tags ? (tags.album  ?? null) : (cur?.album  ?? null);
    fields.push('artist_id = ?'); values.push(_makeArtistId(a));
    fields.push('album_id = ?');  values.push(_albumIdFor(vpath, filepath, a, b));
  }
  if (!fields.length) return;
  // Snapshot current FTS values before we overwrite them
  const ftsAffected = 'title' in tags || 'artist' in tags || 'album_artist' in tags || 'album' in tags;
  let ftsOld = null;
  if (ftsAffected) {
    ftsOld = db.prepare('SELECT rowid, title, artist, album_artist, album, album_version, filepath FROM files WHERE filepath = ? AND vpath = ?').get(filepath, vpath);
  }
  values.push(filepath, vpath);
  db.prepare(`UPDATE files SET ${fields.join(', ')} WHERE filepath = ? AND vpath = ?`).run(...values);
  // Keep FTS index in sync: delete old entry, insert updated one
  if (ftsAffected && ftsOld) {
    const updated = db.prepare('SELECT rowid, title, artist, album_artist, album, album_version, filepath FROM files WHERE filepath = ? AND vpath = ?').get(filepath, vpath);
    if (updated) {
      _s.ftsDel.run(ftsOld.rowid, ftsOld.title ?? null, ftsOld.artist ?? null, ftsOld.album_artist ?? null, ftsOld.album ?? null, ftsOld.album_version ?? null, ftsOld.filepath);
      _s.ftsInsert.run(updated.rowid, updated.title ?? null, updated.artist ?? null, updated.album_artist ?? null, updated.album ?? null, updated.album_version ?? null, updated.filepath);
    }
  }
}

export function updateFileModified(filepath, vpath, modifiedMs) {
  db.prepare('UPDATE files SET modified = ? WHERE filepath = ? AND vpath = ?').run(modifiedMs, filepath, vpath);
}

// Safety guard for Recently Added: if a scan run assigns scan-time ts to files
// whose mtime is clearly older, clamp ts back to mtime to avoid false "new"
// floods caused by path-identity drift or scan regressions.
export function clampRecentTsToModified(vpath, scanId, scanStartTs, oldMtimeCutoffTs) {
  if (!vpath || !scanId || !scanStartTs || !oldMtimeCutoffTs) return 0;
  const r = db.prepare(`
    UPDATE files
    SET ts = CAST(modified / 1000 AS INTEGER)
    WHERE vpath = ?
      AND sID = ?
      AND ts >= ?
      AND modified IS NOT NULL
      AND CAST(modified / 1000 AS INTEGER) > 0
      AND CAST(modified / 1000 AS INTEGER) < ?
  `).run(vpath, scanId, scanStartTs, oldMtimeCutoffTs);
  return r?.changes ?? 0;
}

function _toSec(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n >= 1e12 ? Math.floor(n / 1000) : Math.floor(n);
}

function _toEpochMs(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n >= 1e12 ? Math.floor(n) : Math.floor(n * 1000);
}

export function insertFile(fileData) {
  // If this hash already exists under a different vpath, inherit that ts so the
  // file doesn't appear as "newly added" just because a new vpath was created.
  let ts = _toSec(fileData.ts);
  if (ts == null) {
    // Safety fallback: when scanner doesn't provide ts (or a future regression
    // drops it), prefer file mtime so old files aren't reclassified as recent.
    ts = _toSec(fileData.modified) ?? Math.floor(Date.now() / 1000);
  }
  if (fileData.hash) {
    const existing = _s.insertFileTs.get(fileData.hash);
    if (existing) { ts = _toSec(existing.ts); }
  }
  const result = _s.insertFileRow.run(
    fileData.title ?? null, fileData.artist ?? null, fileData.albumArtist ?? null, fileData.year ?? null, fileData.album ?? null,
    fileData.filepath, fileData.format ?? null, fileData.track ?? null, fileData.trackOf ?? null, fileData.disk ?? null,
    fileData.modified ?? null, fileData.hash ?? null, fileData.audio_hash ?? null, fileData.aaFile ?? null, fileData.vpath,
    ts, fileData.sID ?? null, fileData.replaygainTrackDb ?? null, fileData.genre ?? null, fileData.cuepoints ?? null,
    fileData.art_source ?? null, fileData.duration ?? null,
    fileData.artist_id ?? _makeArtistId(fileData.artist), _albumIdFor(fileData.vpath, fileData.filepath, fileData.artist, fileData.album),
    fileData.cover_file ?? null,
    fileData.bitrate ?? null, fileData.sample_rate ?? null, fileData.channels ?? null,
    fileData.album_version ?? null, fileData.album_version_source ?? null, fileData.bit_depth ?? null,
    fileData.bpm ?? null, fileData.musical_key ?? null,
    fileData.bpm_source ?? ((fileData.bpm != null || fileData.musical_key != null) ? 'tag' : null),
    fileData.ab_status ?? null
  );
  const rowId = Number(result.lastInsertRowid);
  const preservedRg = fileData._preserveRgMeasuredTs != null
    ? {
        rg_measured_ts: fileData._preserveRgMeasuredTs,
        rg_measurement_tool: fileData._preserveRgMeasurementTool ?? null,
        rg_integrated_lufs: fileData._preserveRgIntegratedLufs ?? null,
        rg_true_peak_dbfs: fileData._preserveRgTruePeakDbfs ?? null,
        rg_track_gain_db: fileData._preserveRgTrackGainDb ?? null,
        rg_lra: fileData._preserveRgLra ?? null,
        rg_album_gain_db: fileData._preserveRgAlbumGainDb ?? null,
        rg_album_peak_dbfs: fileData._preserveRgAlbumPeakDbfs ?? null,
      }
    : null;
  const inheritedRg = preservedRg
    || (fileData.hash ? _s.rgByHash.get(fileData.hash) : null)
    || (fileData._oldHash ? _s.rgByHash.get(fileData._oldHash) : null);
  if (inheritedRg) {
    _s.restoreInsertedRg.run(
      inheritedRg.rg_measured_ts,
      inheritedRg.rg_measurement_tool ?? null,
      inheritedRg.rg_integrated_lufs ?? null,
      inheritedRg.rg_true_peak_dbfs ?? null,
      inheritedRg.rg_track_gain_db ?? null,
      inheritedRg.rg_lra ?? null,
      inheritedRg.rg_album_gain_db ?? null,
      inheritedRg.rg_album_peak_dbfs ?? null,
      rowId
    );
  }
  _s.ftsInsert.run(rowId, fileData.title ?? null, fileData.artist ?? null, fileData.albumArtist ?? null, fileData.album ?? null, fileData.album_version ?? null, fileData.filepath);
  return { ...fileData, id: rowId };
}

export function removeFileByPath(filepath, vpath) {
  // Delete from FTS before removing the row (we need the old values)
  const old = db.prepare('SELECT rowid, title, artist, album_artist, album, album_version, filepath FROM files WHERE filepath = ? AND vpath = ?').get(filepath, vpath);
  if (old) {
    _s.ftsDel.run(old.rowid, old.title ?? null, old.artist ?? null, old.album_artist ?? null, old.album ?? null, old.album_version ?? null, old.filepath);
  }
  _s.removeByPath.run(filepath, vpath);
}

// Migrate user_metadata and play_events rows from oldHash to newHash.
// Called when a file is re-inserted with a new hash (e.g. external tag editor rewrites
// bytes and mtime changes) so play counts, ratings, stars, and play history survive.
export function migrateHash(oldHash, newHash) {
  if (!oldHash || !newHash || oldHash === newHash) return;
  db.prepare('UPDATE user_metadata SET hash = ? WHERE hash = ?').run(newHash, oldHash);
  db.prepare('UPDATE play_events SET file_hash = ? WHERE file_hash = ?').run(newHash, oldHash);
}

export function getLiveArtFilenames() {
  const musicArt = _s.liveArt.all().map(r => r.aaFile);
  // Protect locally-cached radio station logos — only for stations that still exist in the DB.
  // If a station is deleted, its img ref is gone from this query and the cached file
  // will be removed by runOrphanCleanup() after the next completed scan.
  const radioArt = db.prepare(
    "SELECT DISTINCT img FROM radio_stations WHERE img IS NOT NULL AND img NOT LIKE 'http%'"
  ).all().map(r => r.img);
  // Same logic for podcast feed artwork — art for deleted feeds is not protected
  // and will be cleaned up by runOrphanCleanup() after the next completed scan.
  const podcastArt = db.prepare(
    "SELECT DISTINCT img FROM podcast_feeds WHERE img IS NOT NULL AND img NOT LIKE 'http%'"
  ).all().map(r => r.img);
  return musicArt.concat(radioArt, podcastArt);
}

export function getLiveHashes() {
  return _s.liveHashes.all().map(r => r.hash);
}

export function getStaleFileHashes(vpath, scanId) {
  return _s.staleHashes.all(vpath, scanId).map(r => r.hash);
}

export function removeStaleFiles(vpath, scanId) {
  _s.removeStale.run(vpath, scanId);
  // Rebuild FTS after bulk delete — individual ftsDel on 10K+ rows would be slow
  _s.ftsRebuild.run();
}

/**
 * Clear all sID values for a vpath before starting a fresh scan.
 * This ensures that files not reached by the new scan (sID stays NULL)
 * are correctly identified as stale and pruned at finish-scan time.
 * Only call this for a FRESH scan — never for a resume.
 */
export function clearScanIds(vpath) {
  _s.clearScanIds.run(vpath);
}

export function removeFilesByVpath(vpath) {
  db.prepare('DELETE FROM files WHERE vpath = ?').run(vpath);
  _s.ftsRebuild.run();
}

export function removeFilesByPrefix(vpath, prefix) {
  const escaped = prefix.replaceAll(/[%_\\]/g, String.raw`\$&`);
  db.prepare(String.raw`DELETE FROM files WHERE vpath = ? AND filepath LIKE ? ESCAPE '\'`).run(vpath, escaped + '%');
  _s.ftsRebuild.run();
}

export function countFilesByVpath(vpath) {
  const row = db.prepare('SELECT COUNT(*) AS cnt FROM files WHERE vpath = ?').get(vpath);
  return row.cnt;
}

export function countFilesByScanId(vpath, scanId) {
  const row = db.prepare('SELECT COUNT(*) AS cnt FROM files WHERE vpath = ? AND sID = ?').get(vpath, scanId);
  return row.cnt;
}

// Batch version: one GROUP BY query instead of one query per vpath.
// Used by /api/v1/db/status to avoid N+1 on users with many vpaths.
export function countFilesByVpaths(vpaths) {
  if (!vpaths || vpaths.length === 0) return 0;
  const vIn = inClause('vpath', vpaths);
  const rows = db.prepare(
    `SELECT vpath, COUNT(*) AS cnt FROM files WHERE ${vIn.sql} GROUP BY vpath`
  ).all(...vIn.params);
  return rows.reduce((sum, r) => sum + r.cnt, 0);
}

export function recordCompletedScan(vpath, scanId, scanStartTs, finishedAtSec) {
  _s.insertScanRun.run(scanId || null, vpath, _toSec(scanStartTs), _toSec(finishedAtSec) || Math.floor(Date.now() / 1000));
}

export function getLastScannedMs() {
  const row = _s.getLastScanRun.get();
  return _toEpochMs(row?.ts);
}

/**
 * Count distinct albums (by album_id) across one or more albumsOnly sources.
 * Each source has { dbVpath, prefix } — prefix may be null (entire vpath).
 */
export function countAlbumsForSources(sources) {
  if (!Array.isArray(sources) || sources.length === 0) return 0;
  const parts = [];
  const params = [];
  for (const src of sources) {
    if (src.prefix) {
      parts.push(String.raw`(vpath = ? AND filepath LIKE ? ESCAPE '\')`);
      params.push(src.dbVpath, src.prefix.replaceAll(/[%_\\]/g, String.raw`\$&`) + '%');
    } else {
      parts.push('vpath = ?');
      params.push(src.dbVpath);
    }
  }
  const sql = `SELECT COUNT(DISTINCT album_id) AS cnt FROM files WHERE (${parts.join(' OR ')}) AND album_id IS NOT NULL`;
  return db.prepare(sql).get(...params).cnt;
}

export function getStats() {

  const totalFiles      = db.prepare('SELECT COUNT(*) AS cnt FROM files').get().cnt;
  const totalArtists    = db.prepare("SELECT COUNT(DISTINCT artist) AS cnt FROM files WHERE artist IS NOT NULL AND artist != ''").get().cnt;
  const totalAlbums     = db.prepare("SELECT COUNT(DISTINCT album) AS cnt FROM files WHERE album IS NOT NULL AND album != ''").get().cnt;
  const totalGenres     = db.prepare("SELECT COUNT(DISTINCT genre) AS cnt FROM files WHERE genre IS NOT NULL AND genre != ''").get().cnt;

  // Collapse 11 scalar aggregate queries into one conditional-aggregate pass.
  const nowSec = Math.floor(Date.now() / 1000);
  const agg = db.prepare(`
    SELECT
      COUNT(*) FILTER (WHERE aaFile IS NOT NULL AND aaFile != '')                                                 AS withArt,
      COUNT(*) FILTER (WHERE art_source = 'discogs')                                                             AS artFromDiscogs,
      COUNT(*) FILTER (WHERE art_source = 'deezer')                                                              AS artFromDeezer,
      COUNT(*) FILTER (WHERE art_source = 'embedded')                                                            AS artEmbedded,
      COUNT(*) FILTER (WHERE art_source = 'directory')                                                           AS artFromDirectory,
      COUNT(*) FILTER (WHERE replaygainTrackDb IS NOT NULL)                                                      AS withReplaygain,
      COUNT(*) FILTER (WHERE cuepoints IS NOT NULL AND cuepoints != '[]')                                        AS withCue,
      COUNT(*) FILTER (WHERE cuepoints IS NULL)                                                                   AS cueUnchecked,
      MIN(CASE WHEN year >= 1900 AND year <= 2030 THEN year END)                                                 AS oldestYear,
      MAX(CASE WHEN year >= 1900 AND year <= 2030 THEN year END)                                                 AS newestYear,
      SUM(CASE WHEN duration IS NOT NULL THEN duration END)                                                      AS totalDuration,
      COUNT(*) FILTER (WHERE (CASE WHEN ts >= 1000000000000 THEN CAST(ts/1000 AS INT) ELSE ts END) >= ?)        AS last7Days,
      COUNT(*) FILTER (WHERE (CASE WHEN ts >= 1000000000000 THEN CAST(ts/1000 AS INT) ELSE ts END) >= ?)        AS last30Days
    FROM files
  `).get(nowSec - 7 * 86400, nowSec - 30 * 86400);

  const withArt          = agg.withArt;
  const artFromDiscogs   = agg.artFromDiscogs;
  const artFromDeezer    = agg.artFromDeezer;
  const artUserPicked    = artFromDiscogs + artFromDeezer;
  const artEmbedded      = agg.artEmbedded;
  const artFromDirectory = agg.artFromDirectory;
  const withReplaygain   = agg.withReplaygain;
  const withCue          = agg.withCue;
  const cueUnchecked     = agg.cueUnchecked;
  const last7Days        = agg.last7Days;
  const last30Days       = agg.last30Days;
  const totalDurationSec = agg.totalDuration ? Math.round(agg.totalDuration) : 0;

  const newestTsRow = _s.getLastScanRun.get();

  const formats = db.prepare(
    'SELECT LOWER(TRIM(format)) AS format, COUNT(*) AS cnt FROM files WHERE format IS NOT NULL AND TRIM(format) != \'\' GROUP BY LOWER(TRIM(format)) ORDER BY cnt DESC'
  ).all();

  const perVpath = db.prepare(
    'SELECT vpath, COUNT(*) AS cnt FROM files GROUP BY vpath ORDER BY cnt DESC'
  ).all();

  const topArtists = db.prepare(
    "SELECT artist, COUNT(*) AS cnt FROM files WHERE artist IS NOT NULL AND artist != '' GROUP BY artist ORDER BY cnt DESC LIMIT 5"
  ).all();

  const topGenres = db.prepare(
    "SELECT genre, COUNT(*) AS cnt FROM files WHERE genre IS NOT NULL AND genre != '' GROUP BY genre ORDER BY cnt DESC LIMIT 5"
  ).all();

  const decadeRows = db.prepare(
    'SELECT (year / 10 * 10) AS decade, COUNT(*) AS cnt FROM files WHERE year >= 1900 AND year <= 2030 GROUP BY decade ORDER BY decade'
  ).all();

  return {
    totalFiles,
    totalArtists,
    totalAlbums,
    totalGenres,
    withArt,
    withoutArt: totalFiles - withArt,
    artFromDiscogs,
    artFromDeezer,
    artUserPicked,
    artEmbedded,
    artFromDirectory,
    withReplaygain,
    withCue,
    cueUnchecked,
    oldestYear:  agg.oldestYear  || null,
    newestYear:  agg.newestYear  || null,
    lastScannedTs: _toEpochMs(newestTsRow.ts),
    addedLast7Days:  last7Days,
    addedLast30Days: last30Days,
    formats,
    perVpath,
    topArtists,
    topGenres,
    decades: decadeRows,
    totalDurationSec,
  };
}

// Metadata Queries
export function getFileWithMetadata(filepath, vpath, username) {
  const row = _s.getFileWithMeta.get(username, filepath, vpath);

  if (!row) { return null; }
  return mapFileRow(row);
}

function mapFileRow(row) {
  return {
    ...row,
    'replaygain-track-db': row.replaygainTrackDb
  };
}

export function getArtists(vpaths, ignoreVPaths, excludeFilepathPrefixes) {
  const filtered = vpathFilter(vpaths, ignoreVPaths);
  if (filtered.length === 0) { return []; }
  const vIn = inClause('vpath', filtered);
  const ep = excludePrefixClauses(excludeFilepathPrefixes);
  const rows = db.prepare(`SELECT DISTINCT artist FROM files WHERE ${vIn.sql}${ep.sql} AND artist IS NOT NULL ORDER BY artist COLLATE NOCASE`).all(...vIn.params, ...ep.params);
  return rows.map(r => r.artist);
}

// Multi-artist variant of getArtistAlbums — accepts an array of raw artist
// tag values and fetches all albums in a single SQL query using artist IN (...).
// Used from the normalized-artist search path to avoid N parallel HTTP calls.
// Strip trailing /CD1, /Disc 2, /Side A etc. so multi-disc albums group as one.
// rtrim() in SQL produces a trailing slash on the dir value, so strip that too.
function _normaliseAlbumDir(dir) {
  return (dir || '').replace(/[/\\]$/, '').replace(/[/\\](cd|disc|disk|side)\s*\d+\s*$/i, '');
}

// Returns raw file rows for an artist, excluding albumsOnly prefixes.
// Used by the Artists2 "Songs" section.  The caller is responsible for
// applying the albumsOnly exclusion via excludeFilepathPrefixes.
export function getArtistFolderSongs(artists, vpaths, username, ignoreVPaths, excludeFilepathPrefixes) {
  if (!Array.isArray(artists) || artists.length === 0) return [];
  const filtered = vpathFilter(vpaths, ignoreVPaths);
  if (filtered.length === 0) return [];
  const vIn = inClause('f.vpath', filtered);
  const ep  = excludePrefixClauses(excludeFilepathPrefixes, 'f.vpath', 'f.filepath');
  const artistList = artists.map(String);
  const placeholders = artistList.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT f.rowid AS id, f.*, um.rating
    FROM files f
    LEFT JOIN user_metadata um ON f.hash = um.hash AND um.user = ?
    WHERE ${vIn.sql}${ep.sql}
      AND COALESCE(f.album_artist, f.artist) IN (${placeholders})
    ORDER BY f.filepath
  `).all(username, ...vIn.params, ...ep.params, ...artistList);
  return rows.map(mapFileRow);
}

export function getArtistAlbumsMulti(artists, vpaths, ignoreVPaths, excludeFilepathPrefixes, includeFilepathPrefixes) {
  if (!Array.isArray(artists) || artists.length === 0) return [];
  const filtered = vpathFilter(vpaths, ignoreVPaths);
  if (filtered.length === 0) return [];
  const vIn = inClause('vpath', filtered);
  const ep  = excludePrefixClauses(excludeFilepathPrefixes);
  const ip  = includePrefixClauses(includeFilepathPrefixes);
  const artistList = artists.map(String);
  const placeholders = artistList.map(() => '?').join(',');

  const baseSelect = `
    SELECT album AS name, MAX(year) AS year,
      MAX(aaFile) AS album_art_file,
      MAX(cover_file) AS cover_file,
      MAX(album_version) AS album_version,
      rtrim(filepath, replace(filepath, '/', '')) AS dir
    FROM files
    WHERE ${vIn.sql}${ep.sql}${ip.sql}`;
  const baseParams = [...vIn.params, ...ep.params, ...ip.params];

  // Pass 1: albums where this artist is directly credited (artist or album_artist)
  const pass1 = db.prepare(`${baseSelect} AND COALESCE(album_artist, artist) IN (${placeholders})
    GROUP BY album, rtrim(filepath, replace(filepath, '/', ''))
    ORDER BY MAX(year) DESC
  `).all(...baseParams, ...artistList);

  // Pass 2: sibling discs under the same MULTI-DISC parent folder not caught by pass 1.
  // Only runs for dirs where a CD/Disc sub-folder was stripped by _normaliseAlbumDir.
  // This is intentionally narrow — it handles multi-disc CUE sets where some discs
  // carry a different artist tag (e.g. disc 3+4 of a Barry White set tagged
  // "Love Unlimited Orchestra"). Flat album folders (compilations, singles) are
  // deliberately excluded to avoid polluting results with hundreds of unrelated tracks.
  const normDirSet = new Set();
  for (const r of pass1) {
    const rawDir0 = (r.dir || '').replace(/[/\\]+$/, '');
    const nd0 = _normaliseAlbumDir(r.dir);
    if (nd0 !== rawDir0) normDirSet.add(nd0); // Only multi-disc album parent dirs
  }
  let allRows = pass1;
  if (normDirSet.size > 0) {
    const ndArr = [...normDirSet];
    const likeClauses = ndArr.map(() => 'filepath LIKE ?').join(' OR ');
    const likeParams  = ndArr.map(nd => nd + '/%');
    const pass2 = db.prepare(`${baseSelect}
      AND NOT (COALESCE(album_artist, artist) IN (${placeholders})) AND (${likeClauses})
      GROUP BY album, rtrim(filepath, replace(filepath, '/', ''))
    `).all(...baseParams, ...artistList, ...likeParams);
    if (pass2.length) allRows = [...pass1, ...pass2];
  }

  // Dedup strategy:
  // • Multi-disc albums (disc sub-folder was stripped by _normaliseAlbumDir) → dedup
  //   by normDir alone so all disc files collapse into one card regardless of their
  //   individual album tags.  Pass 1 rows sort first so the correctly-credited disc
  //   provides the display name.
  // • Flat albums (no disc sub-folder) → keep the old (album, normDir) key so two
  //   different albums that happen to share a parent folder stay separate.
  const albums = [], store = {};
  for (const row of allRows) {
    const nd = _normaliseAlbumDir(row.dir);
    const rawDir = (row.dir || '').replace(/[/\\]+$/, '');
    const isMultiDisc = nd !== rawDir;
    let key;
    if (isMultiDisc) {
      key = nd;
    } else if (row.name === null) {
      key = 'null\x00' + nd;
    } else {
      key = row.name + '\x00' + nd;
    }
    if (!store[key]) {
      albums.push({ name: row.name, year: row.year, album_art_file: row.album_art_file || null, album_version: row.album_version || null, dir: row.dir || '', normDir: nd });
      store[key] = true;
    }
  }
  return albums;
}

export function getArtistAlbums(artist, vpaths, ignoreVPaths, excludeFilepathPrefixes, includeFilepathPrefixes) {
  const filtered = vpathFilter(vpaths, ignoreVPaths);
  if (filtered.length === 0) { return []; }
  const vIn = inClause('vpath', filtered);
  const ep = excludePrefixClauses(excludeFilepathPrefixes);
  const ip = includePrefixClauses(includeFilepathPrefixes);
  const rows = db.prepare(`
    SELECT album AS name, MAX(year) AS year,
      MAX(aaFile) AS album_art_file,
      MAX(cover_file) AS cover_file,
      MAX(album_version) AS album_version,
      rtrim(filepath, replace(filepath, '/', '')) AS dir
    FROM files
    WHERE ${vIn.sql}${ep.sql}${ip.sql} AND COALESCE(album_artist, artist) = ?
    GROUP BY album, rtrim(filepath, replace(filepath, '/', ''))
    ORDER BY MAX(year) DESC
  `).all(...vIn.params, ...ep.params, ...ip.params, String(artist));

  const albums = [];
  const store = {};
  for (const row of rows) {
    if (row.name === null) {
      const key = 'null\x00' + _normaliseAlbumDir(row.dir);
      if (!store[key]) { albums.push({ name: null, year: null, album_art_file: row.album_art_file || null, album_version: null }); store[key] = true; }
    } else {
      const key = row.name + '\x00' + _normaliseAlbumDir(row.dir);
      if (!store[key]) {
        albums.push({ name: row.name, year: row.year, album_art_file: row.album_art_file || null, album_version: row.album_version || null });
        store[key] = true;
      }
    }
  }
  return albums;
}

export function getAlbums(vpaths, ignoreVPaths, excludeFilepathPrefixes, includeFilepathPrefixes) {
  const filtered = vpathFilter(vpaths, ignoreVPaths);
  if (filtered.length === 0) { return []; }
  const vIn = inClause('vpath', filtered);
  const ep = excludePrefixClauses(excludeFilepathPrefixes);
  const ip = includePrefixClauses(includeFilepathPrefixes);
  const rows = db.prepare(`
    SELECT album AS name, MAX(aaFile) AS album_art_file, MAX(year) AS year,
      MAX(album_version) AS album_version,
      rtrim(filepath, replace(filepath, '/', '')) AS dir
    FROM files
    WHERE ${vIn.sql}${ep.sql}${ip.sql} AND album IS NOT NULL
    GROUP BY album, rtrim(filepath, replace(filepath, '/', ''))
    ORDER BY album COLLATE NOCASE
  `).all(...vIn.params, ...ep.params, ...ip.params);

  const albums = [];
  const store = {};
  for (const row of rows) {
    const key = row.name + '\x00' + _normaliseAlbumDir(row.dir);
    if (!store[key]) {
      albums.push({ name: row.name, album_art_file: row.album_art_file, year: row.year, album_version: row.album_version || null });
      store[key] = true;
    }
  }
  return albums;
}

export function getFilesForAlbumsBrowse(sources) {
  // sources: array of { vpath, prefix } where prefix may be null (root vpath — include all)
  if (!sources || sources.length === 0) return [];
  const clauses = sources.map(s =>
    s.prefix
      ? `(vpath = ? AND filepath LIKE ?)`
      : `(vpath = ?)`
  );
  const params = [];
  for (const s of sources) {
    params.push(s.vpath);
    if (s.prefix) params.push(s.prefix.replace(/\/$/, '') + '/%');
  }
  return db.prepare(
    `SELECT filepath, title, artist, album_artist, album, track, disk, year, duration, aaFile, vpath, cuepoints, cover_file, album_version
     FROM files WHERE ${clauses.join(' OR ')}`
  ).all(...params);
}

export function getAlbumSongs(album, vpaths, username, opts) {
  const filtered = vpathFilter(vpaths, opts.ignoreVPaths);
  if (filtered.length === 0) { return []; }
  const vIn = inClause('f.vpath', filtered);
  const ep  = excludePrefixClauses(opts.excludeFilepathPrefixes, 'f.vpath', 'f.filepath');
  const ip  = includePrefixClauses(opts.includeFilepathPrefixes, 'f.vpath', 'f.filepath');

  let sql = `
    SELECT f.rowid AS id, f.*, um.rating
    FROM files f
    LEFT JOIN user_metadata um ON f.hash = um.hash AND um.user = ?
    WHERE ${vIn.sql}${ep.sql}${ip.sql}
  `;
  const params = [username, ...vIn.params, ...ep.params, ...ip.params];

  if (!opts.folderOnly) {
    // folderOnly: skip ALL album/artist filters — albumDir alone defines the folder.
    // This handles Various Artists, multi-album folders, and same-named albums in different dirs.
    if (album === null) {
      sql += ' AND f.album IS NULL';
    } else {
      sql += ' AND f.album = ?';
      params.push(album);
    }

    if (opts.artists && Array.isArray(opts.artists) && opts.artists.length) {
      // Use COALESCE so CUE-based albums where artist=null but album_artist is set still match
      const aIn = inClause('COALESCE(f.album_artist, f.artist)', opts.artists.map(String));
      sql += ` AND ${aIn.sql}`;
      params.push(...aIn.params);
    } else if (opts.artist) {
      sql += ' AND COALESCE(f.album_artist, f.artist) = ?';
      params.push(opts.artist);
    }
  }

  if (opts.year) {
    sql += ' AND f.year = ?';
    params.push(Number(opts.year));
  }

  // Directory-based filter: when albumDir is provided, restrict to that folder.
  // This is critical for albums whose album tag is generic (e.g. "Catalogue") —
  // the dir uniquely identifies the physical release folder in the library.
  // normDir is the normalised dir (disc sub-folders collapsed) so multi-disc
  // albums like "Album/CD 1" and "Album/CD 2" both fall under "Album".
  if (opts.albumDir) {
    const dirPrefix = opts.albumDir.replace(/\/$/, '') + '/';
    sql += ' AND f.filepath LIKE ?';
    params.push(dirPrefix + '%');
  }

  sql += ' ORDER BY f.disk, f.track, f.filepath';

  const rows = db.prepare(sql).all(...params);
  return rows.map(mapFileRow);
}

// Escape a raw search term for use in an FTS5 MATCH expression.
// Double-quotes inside the term are escaped by doubling them.
function escapeFts(term) { return String(term).replaceAll('"', '""'); }

function normalizeSearchLimit(limit, fallback = 800) {
  const n = Number.parseInt(limit, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(1, Math.min(5000, n));
}

// Sanitize raw user input for FTS5 trigram queries:
// trigram doesn't use operators, but strip characters that could cause issues.
function sanitizeTrigram(raw) {
  // Wrap in double-quotes to form a phrase/literal query.
  // This prevents FTS5 syntax errors on names containing . ( ) * - etc.
  // Any literal " inside the input is escaped by doubling (FTS5 convention).
  const cleaned = String(raw).replaceAll(/\s+/g, ' ').trim();
  if (cleaned.length < 3) return ''; // trigram needs at least 3 chars
  return '"' + cleaned.replaceAll('"', '""') + '"';
}

// ── Folder search ─────────────────────────────────────────────────────────
// Searches folder names using the trigram FTS index.
// Returns folders the user has access to, ranked by match quality.
// Each result includes enough info for the frontend to open the file browser.
export function searchFolders(query, vpaths, ignoreVPaths) {
  if (!query?.trim()) return [];
  const filtered = vpathFilter(vpaths, ignoreVPaths);
  if (filtered.length === 0) return [];

  const q = sanitizeTrigram(query);
  if (!q) return []; // trigram needs at least 3 chars

  const vIn = inClause('f.vpath', filtered);
  const sql = `SELECT f.id, f.vpath, f.dirpath, f.folder_name
    FROM folders f
    JOIN fts_folders ft ON f.id = ft.rowid
    WHERE ${vIn.sql}
    AND fts_folders MATCH ?
    ORDER BY rank`;
  const rows = _prepare(sql).all(...vIn.params, q);
  return rows;
}

// ── Normalized artist search ───────────────────────────────────────────────
// Searches the normalized artist index using trigram FTS.
// Returns artist_clean (display name) + artist_raw_variants[] (all raw tag
// values that normalize to this name) — the variants are needed by the
// frontend to query artist-albums across all maltagged variants at once.
export function searchArtistsNormalized(query, vpaths, ignoreVPaths) {
  if (!query?.trim()) return [];

  const q = sanitizeTrigram(query);
  if (!q) return [];

  // Compute the set of vpaths the user is allowed to see
  let filteredVpaths = null;
  if (Array.isArray(vpaths) && vpaths.length > 0) {
    filteredVpaths = vpathFilter(vpaths, ignoreVPaths);
    if (filteredVpaths.length === 0) return [];
  }

  // Uses cached prepared statement — static SQL, no dynamic parts.
  const rows = _s.searchArtists.all(q);

  return rows
    .filter(r => {
      if (!filteredVpaths) return true;
      try {
        const artistVpaths = JSON.parse(r.vpaths_json || '[]');
        return artistVpaths.some(v => filteredVpaths.includes(v));
      } catch { return true; }
    })
    .map(r => ({
      name:     r.artist_clean,
      variants: (() => { try { return JSON.parse(r.artist_raw_variants); } catch { return [r.artist_clean]; } })(),
    }));
}

// ── Artist browse / profile ───────────────────────────────────────────────

// Returns artists starting with a given letter (or '0' for all digit-starting names).
// Uses precomputed song_count — no join with files needed.
export function getArtistsByLetter(letter) {
  let rows;
  if (letter === '0') {
    // Digits: artist_clean starts with 0-9
    rows = db.prepare(
      "SELECT * FROM artists_normalized WHERE artist_clean != '' AND artist_clean GLOB '[0-9]*' ORDER BY artist_clean COLLATE NOCASE"
    ).all();
  } else {
    const l = letter.toUpperCase();
    rows = db.prepare(
      "SELECT * FROM artists_normalized WHERE artist_clean != '' AND upper(substr(artist_clean,1,1)) = ? ORDER BY artist_clean COLLATE NOCASE"
    ).all(l);
  }
  return rows.map(r => ({
    artistKey:    r.artist_clean.toLowerCase(),
    canonicalName: r.artist_clean,
    imageFile:    r.image_file || null,
    hasBio:       !!r.bio,
    songCount:    r.song_count || 0,
    rawVariants:  (() => { try { return JSON.parse(r.artist_raw_variants); } catch { return [r.artist_clean]; } })(),
  }));
}

// Returns home-page artist stats:
//   topArtists  — top 20 by song_count
//   recentArtists — up to 10 most recently played (from play_events + files join)
//   totalCount  — total number of distinct artists
export function getArtistHomeStats() {
  const totalRow = db.prepare("SELECT COUNT(*) AS c FROM artists_normalized WHERE artist_clean != ''").get();
  const totalCount = totalRow ? totalRow.c : 0;

  const topRows = db.prepare(
    "SELECT artist_clean, image_file, bio, song_count, artist_raw_variants FROM artists_normalized WHERE artist_clean != '' ORDER BY song_count DESC LIMIT 20"
  ).all();

  const topArtists = topRows.map(r => ({
    artistKey:    r.artist_clean.toLowerCase(),
    canonicalName: r.artist_clean,
    imageFile:    r.image_file || null,
    hasBio:       !!r.bio,
    songCount:    r.song_count || 0,
    rawVariants:  (() => { try { return JSON.parse(r.artist_raw_variants); } catch { return [r.artist_clean]; } })(),
  }));

  // Most played: aggregate play_events by raw file artist first, then map to canonical groups.
  const playedRawRows = db.prepare(`
    SELECT f.artist AS raw_artist, COUNT(*) AS plays
    FROM play_events pe
    JOIN files f ON f.hash = pe.file_hash
    WHERE f.artist IS NOT NULL AND f.artist != ''
    GROUP BY f.artist
    ORDER BY plays DESC
    LIMIT 500
  `).all();

  // Recent: join last N play_events with files to get the artist, deduplicated
  const recentRows = db.prepare(`
    SELECT DISTINCT f.artist
    FROM play_events pe
    JOIN files f ON f.hash = pe.file_hash
    WHERE f.artist IS NOT NULL AND f.artist != ''
    ORDER BY pe.started_at DESC
    LIMIT 50
  `).all();

  // Resolve ALL raw artist names in ONE CTE query instead of N individual lookups.
  // Collect unique raw artist values needed across both played and recent lists.
  const allRawArtists = [...new Set([
    ...playedRawRows.map(r => r.raw_artist),
    ...recentRows.map(r => r.artist),
  ])];

  // variantMap: rawArtist -> { artist_clean, image_file, bio, song_count, artist_raw_variants }
  const variantMap = new Map();
  if (allRawArtists.length > 0) {
    // SQLite default max params = 999; cap to stay safe
    const safeList = allRawArtists.slice(0, 900);
    const placeholders = safeList.map(() => '?').join(',');
    const cteRows = db.prepare(`
      WITH expanded AS (
        SELECT an.artist_clean, an.image_file, an.bio, an.song_count, an.artist_raw_variants,
               je.value AS raw_variant
        FROM artists_normalized an, json_each(an.artist_raw_variants) AS je
        WHERE an.artist_clean != ''
      )
      SELECT raw_variant, artist_clean, image_file, bio, song_count, artist_raw_variants
      FROM expanded
      WHERE raw_variant IN (${placeholders})
    `).all(...safeList);
    for (const row of cteRows) {
      variantMap.set(row.raw_variant, row);
    }
  }

  const playByCanonical = new Map();
  for (const row of playedRawRows) {
    const anRow = variantMap.get(row.raw_artist);
    if (!anRow) continue;
    const key = anRow.artist_clean.toLowerCase();
    const prev = playByCanonical.get(key);
    if (prev) {
      prev.playCount += Number(row.plays || 0);
      continue;
    }
    playByCanonical.set(key, {
      artistKey: key,
      canonicalName: anRow.artist_clean,
      imageFile: anRow.image_file || null,
      hasBio: !!anRow.bio,
      songCount: anRow.song_count || 0,
      playCount: Number(row.plays || 0),
      rawVariants: (() => { try { return JSON.parse(anRow.artist_raw_variants); } catch { return [anRow.artist_clean]; } })(),
    });
  }

  const mostPlayedArtists = Array.from(playByCanonical.values())
    .sort((a, b) => (b.playCount - a.playCount) || a.canonicalName.localeCompare(b.canonicalName))
    .slice(0, 20);

  // Map each raw artist to its canonical group
  const recentArtists = [];
  const seen = new Set();
  for (const row of recentRows) {
    const anRow = variantMap.get(row.artist);
    if (!anRow) continue;
    const key = anRow.artist_clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    recentArtists.push({
      artistKey:    key,
      canonicalName: anRow.artist_clean,
      imageFile:    anRow.image_file || null,
      hasBio:       !!anRow.bio,
      songCount:    anRow.song_count || 0,
      rawVariants:  (() => { try { return JSON.parse(anRow.artist_raw_variants); } catch { return [anRow.artist_clean]; } })(),
    });
    if (recentArtists.length >= 10) break;
  }

  return { totalCount, topArtists, recentArtists, mostPlayedArtists };
}

// Returns all artists for the Artist Library grid, sorted by display name.
// Uses precomputed song_count (no expensive join with files).
export function getArtistsForBrowse(_vpaths, _ignoreVPaths) {
  // Legacy function — kept for any future bulk use.
  // For the home page, use getArtistHomeStats(). For letter browse, use getArtistsByLetter().
  const rows = db.prepare(
    'SELECT * FROM artists_normalized ORDER BY artist_clean COLLATE NOCASE'
  ).all();
  return rows.map(r => ({
    artistKey:    r.artist_clean.toLowerCase(),
    canonicalName: r.artist_clean,
    imageFile:    r.image_file || null,
    hasBio:       !!r.bio,
    songCount:    r.song_count || 0,
  }));
}

// Returns the full profile row for one artist by its artist_clean (case-insensitive).
// Returns null if not found.
export function getArtistRow(artistClean) {
  const row = db.prepare(
    "SELECT * FROM artists_normalized WHERE lower(artist_clean) = lower(?)"
  ).get(artistClean);
  if (!row) return null;
  return {
    artistKey:    row.artist_clean.toLowerCase(),
    canonicalName: row.artist_clean,
    bio:          row.bio || null,
    imageFile:    row.image_file || null,
    imageSource:  row.image_source || null,
    fanartFile:   row.fanart_file || null,
    genre:        row.genre || null,
    country:      row.country || null,
    formedYear:   row.formed_year || null,
    lastFetched:  row.last_fetched || null,
    nameOverride: row.name_override || 0,
    songCount:    row.song_count || 0,
    mbid:         row.mbid || null,
    rawVariants:  (() => { try { return JSON.parse(row.artist_raw_variants); } catch { return [row.artist_clean]; } })(),
  };
}

/**
 * Find an artist row by either canonical name OR any raw variant tag value.
 * Used by the Playing Now image endpoint to resolve song artist tags that may
 * not match the canonical name exactly (e.g. featuring variants).
 */
export function getArtistRowByName(name) {
  if (!name) return null;
  // 1. Exact canonical match (fast — indexed)
  const direct = getArtistRow(name);
  if (direct) return direct;
  // 2. Search inside raw_variants JSON array for an exact match
  const row = db.prepare(
    `SELECT * FROM artists_normalized
     WHERE EXISTS (SELECT 1 FROM json_each(artist_raw_variants) WHERE value = ?)
     LIMIT 1`
  ).get(name);
  if (!row) return null;
  return {
    artistKey:    row.artist_clean.toLowerCase(),
    canonicalName: row.artist_clean,
    bio:          row.bio || null,
    imageFile:    row.image_file || null,
    imageSource:  row.image_source || null,
    fanartFile:   row.fanart_file || null,
    genre:        row.genre || null,
    country:      row.country || null,
    formedYear:   row.formed_year || null,
    lastFetched:  row.last_fetched || null,
    nameOverride: row.name_override || 0,
    songCount:    row.song_count || 0,
    rawVariants:  (() => { try { return JSON.parse(row.artist_raw_variants); } catch { return [row.artist_clean]; } })(),
  };
}

/**
 * Normalize an artist name for fuzzy matching.
 * Lowercases, converts ' & ' and '&' → ' and ', collapses spaces, trims.
 * Used to match Last.fm artist names (which may use 'and') against library
 * artist names (which may use '&') and vice versa.
 */
function _normArtist(name) {
  return name.toLowerCase()
    .replaceAll(/\s*&\s*/g, ' and ')
    .replaceAll(/\s+/g, ' ')
    .trim();
}

/**
 * Given a list of artist names from an external source (e.g. Last.fm similar-artists),
 * resolve each against the library's artists_normalized table using fuzzy normalization.
 * Returns an array of raw artist tag values (as stored in files.artist) for all matched
 * library artists — suitable for use in an IN(...) filter on the files table.
 *
 * Matching strategy (in order):
 *   1. Exact case-insensitive match on artist_clean
 *   2. Normalized match: '&' ↔ 'and', whitespace collapsed (both sides normalized)
 *
 * Artists not found in the library are silently dropped so the caller gets only
 * names that will actually match rows in the files table.
 */
export function resolveArtistNamesForDJ(names) {
  if (!names || names.length === 0) return [];
  // Exact case-insensitive match on canonical artist name
  const exactStmt = db.prepare(
    `SELECT artist_raw_variants FROM artists_normalized WHERE lower(artist_clean) = lower(?)`
  );
  // Normalized match — normalize '&' variants and whitespace in both SQL and param
  // SQL: lower → replace ' & '→' and ' → replace '&'→' and ' → collapse '  '→' '
  const normStmt = db.prepare(
    `SELECT artist_raw_variants FROM artists_normalized
     WHERE replace(replace(replace(lower(trim(artist_clean)), ' & ', ' and '), '&', ' and '), '  ', ' ') = ?`
  );
  const result = new Set();
  for (const name of names) {
    if (!name || typeof name !== 'string') continue;
    let row = exactStmt.get(name.trim());
    if (!row) row = normStmt.get(_normArtist(name));
    if (!row) continue;
    try {
      const variants = JSON.parse(row.artist_raw_variants);
      for (const v of variants) result.add(v);
    } catch (e) { console.debug('[velvet]', e?.message ?? e); }
  }
  return [...result];
}

/**
 * Returns true if any of the supplied raw artist variants are credited as the
 * primary album artist (COALESCE(album_artist, artist)) on at least one file
 * in the accessible vpaths.  Used to filter similar-artist chips to artists
 * that actually have albums, not just featuring credits on compilations.
 */
export function artistHasAlbums(variants, vpaths) {
  if (!variants || variants.length === 0 || !vpaths || vpaths.length === 0) return false;
  const filtered = vpathFilter(vpaths, undefined);
  if (filtered.length === 0) return false;
  const vIn = inClause('vpath', filtered);
  const pl  = variants.map(String).map(() => '?').join(',');
  const row = db.prepare(
    `SELECT 1 FROM files WHERE ${vIn.sql} AND COALESCE(album_artist, artist) IN (${pl}) LIMIT 1`
  ).get(...vIn.params, ...variants.map(String));
  return !!row;
}

// Returns the SET of artist values (from COALESCE(album_artist, artist)) that appear as
// the primary album artist on at least one file in the user's vpaths.
// Accepts a flat list of raw variant strings.  One single SQL query instead of one per artist.
export function artistsWithAlbums(variants, vpaths) {
  if (!variants || variants.length === 0 || !vpaths || vpaths.length === 0) return new Set();
  const filtered = vpathFilter(vpaths, undefined);
  if (filtered.length === 0) return new Set();
  const vIn = inClause('vpath', filtered);
  const aIn = inClause('COALESCE(album_artist, artist)', variants.map(String));
  const rows = db.prepare(
    `SELECT DISTINCT COALESCE(album_artist, artist) AS a FROM files WHERE ${vIn.sql} AND ${aIn.sql}`
  ).all(...vIn.params, ...aIn.params);
  return new Set(rows.map(r => r.a));
}

// Returns all file rows for an artist (by raw variant list) with their filepaths.
// Includes all columns needed to build release groups.
export function getArtistFiles(rawVariants, vpaths, ignoreVPaths) {
  const filtered = vpathFilter(vpaths, ignoreVPaths);
  if (filtered.length === 0 || rawVariants.length === 0) return [];

  const vIn = inClause('vpath', filtered);
  const variantList = rawVariants.map(String);
  const placeholders = variantList.map(() => '?').join(',');
  return db.prepare(`
    SELECT filepath, vpath, title, artist, album_artist, album, track, trackOf, disk, year,
           duration, aaFile, cover_file, genre, cuepoints
    FROM files
    WHERE ${vIn.sql} AND COALESCE(album_artist, artist) IN (${placeholders})
    ORDER BY filepath
  `).all(...vIn.params, ...variantList);
}

// Saves bio + image info fetched from an external service.
// Never overwrites name_override.
export function saveArtistInfo(artistClean, { bio, imageFile, imageSource, fanartFile, genre, country, formedYear, mbid } = {}) {
  db.prepare(`
    UPDATE artists_normalized
    SET bio = ?, image_file = ?, image_source = ?, last_fetched = ?,
        image_flag_wrong = CASE WHEN ? IS NOT NULL THEN 0 ELSE image_flag_wrong END,
        fanart_file  = COALESCE(?, fanart_file),
        genre        = COALESCE(?, genre),
        country      = COALESCE(?, country),
        formed_year  = COALESCE(?, formed_year),
        mbid         = COALESCE(?, mbid)
    WHERE lower(artist_clean) = lower(?)
  `).run(
    bio || null, imageFile || null, imageSource || null, Date.now(),
    imageFile || null,
    fanartFile  || null,
    genre       || null,
    country     || null,
    formedYear  || null,
    mbid        || null,
    artistClean
  );
}

/** Derive a MusicBrainz artist ID from file-level AcoustID data.
 *  Finds the most common mb_artist_id in files whose artist tag matches the
 *  canonical name (case-insensitive). Returns null if nothing is found. */
export function deriveArtistMbidFromFiles(canonicalName) {
  if (!canonicalName) return null;
  const row = db.prepare(`
    SELECT mb_artist_id, COUNT(*) AS cnt
    FROM files
    WHERE mb_artist_id IS NOT NULL
      AND lower(COALESCE(mb_artist, artist, '')) = lower(?)
    GROUP BY mb_artist_id
    ORDER BY cnt DESC
    LIMIT 1
  `).get(canonicalName);
  return row?.mb_artist_id || null;
}

// Admin: override the canonical display name for an artist.
export function setArtistNameOverride(artistClean, newName) {
  db.prepare(`
    UPDATE artists_normalized
    SET artist_clean = ?, name_override = 1
    WHERE lower(artist_clean) = lower(?)
  `).run(newName, artistClean);
}

// Admin: set a custom artist image (downloaded externally and stored in image-cache/artists/).
export function setArtistImage(artistClean, imageFile, imageSource) {
  db.prepare(`
    UPDATE artists_normalized
    SET image_file = ?, image_source = ?, last_fetched = ?, image_flag_wrong = 0
    WHERE lower(artist_clean) = lower(?)
  `).run(imageFile, imageSource || 'custom', Date.now(), artistClean);
}

export function setArtistImageWrongFlag(artistClean, isWrong) {
  db.prepare(`
    UPDATE artists_normalized
    SET image_flag_wrong = ?, last_fetched = CASE WHEN ? = 1 THEN NULL ELSE last_fetched END
    WHERE lower(artist_clean) = lower(?)
  `).run(isWrong ? 1 : 0, isWrong ? 1 : 0, artistClean);
}

export function markArtistFetchAttempt(artistClean) {
  db.prepare(`
    UPDATE artists_normalized
    SET last_fetched = ?
    WHERE lower(artist_clean) = lower(?)
  `).run(Date.now(), artistClean);
}

/**
 * Given a Subsonic artist_id (16-char hex), return the image_file filename
 * from artists_normalized (or null if not found / no image).
 * Used by the Subsonic getCoverArt handler for ar-<artist_id> IDs.
 */
export function getArtistImageByArtistId(artistId) {
  if (!artistId) return null;
  const fileRow = db.prepare(
    'SELECT artist FROM files WHERE artist_id = ? AND artist IS NOT NULL LIMIT 1'
  ).get(artistId);
  if (!fileRow?.artist) return null;
  const anRow = db.prepare(
    'SELECT image_file FROM artists_normalized WHERE lower(trim(artist_clean)) = lower(trim(?)) LIMIT 1'
  ).get(fileRow.artist);
  return anRow?.image_file ?? null;
}

export function getArtistImageAudit(kind, limit = 200) {
  const n = Math.max(1, Math.min(1000, Number(limit) || 200));
  let where = "artist_clean != ''";
  if (kind === 'missing') {
    where += " AND (image_file IS NULL OR image_file = '') AND last_fetched IS NULL";
  } else if (kind === 'no-image') {
    where += " AND (image_file IS NULL OR image_file = '') AND last_fetched IS NOT NULL";
  } else if (kind === 'wrong') {
    where += ' AND image_flag_wrong = 1';
  } else if (kind === 'with-image') {
    where += " AND image_file IS NOT NULL AND image_file != ''";
  }
  const rows = db.prepare(`
    SELECT artist_clean, image_file, image_source, song_count, image_flag_wrong, last_fetched
    FROM artists_normalized
    WHERE ${where}
    ORDER BY song_count DESC, artist_clean COLLATE NOCASE
    LIMIT ?
  `).all(n);
  return rows.map(r => ({
    artistKey: String(r.artist_clean || '').toLowerCase(),
    canonicalName: r.artist_clean,
    imageFile: r.image_file || null,
    imageSource: r.image_source || null,
    songCount: r.song_count || 0,
    wrongFlag: !!r.image_flag_wrong,
    lastFetched: r.last_fetched || null,
  }));
}

export function getArtistImageAuditCounts() {
  const row = db.prepare(`
    SELECT
      SUM(CASE WHEN (image_file IS NULL OR image_file = '') AND last_fetched IS NULL THEN 1 ELSE 0 END) AS missing,
      SUM(CASE WHEN (image_file IS NULL OR image_file = '') AND last_fetched IS NOT NULL THEN 1 ELSE 0 END) AS no_image,
      SUM(CASE WHEN image_flag_wrong = 1 THEN 1 ELSE 0 END) AS wrong,
      SUM(CASE WHEN image_file IS NOT NULL AND image_file != '' THEN 1 ELSE 0 END) AS withImage
    FROM artists_normalized
    WHERE artist_clean != ''
  `).get() || { missing: 0, no_image: 0, wrong: 0, withImage: 0 };
  return {
    missing: Number(row.missing || 0),
    noImage: Number(row.no_image || 0),
    wrong: Number(row.wrong || 0),
    withImage: Number(row.withImage || 0),
  };
}

// Returns artist_clean values where last_fetched IS NULL (never fetched) — used
// by the auto-fetch queue after a scan completes.
export function getArtistsNeedingFetch(limit = 500) {
  return db.prepare(
    `SELECT artist_clean FROM artists_normalized
     WHERE last_fetched IS NULL AND (image_file IS NULL OR image_file = '')
     ORDER BY song_count DESC NULLS LAST, artist_clean COLLATE NOCASE
     LIMIT ?`
  ).all(Math.max(1, Math.min(100000, Number(limit) || 500))).map(r => r.artist_clean);
}

export function getArtistsForTadbRetry(limit = 500, force = false) {
  // Returns no-image artists (tried before but got no image) ordered by song count desc.
  // These will be retried via TheAudioDB only — Discogs was already tried.
  //
  // force=false (background/automatic): enforces a 30-day per-artist cooldown so
  //   niche artists not found in any database are not hammered on every trigger.
  // force=true (user-initiated via admin UI): bypasses the cooldown so the user
  //   can always explicitly re-trigger a full retry regardless of last_fetched.
  const n = Math.max(1, Math.min(2000, Number(limit) || 500));
  if (force) {
    return db.prepare(
      `SELECT artist_clean FROM artists_normalized
       WHERE image_file IS NULL AND last_fetched IS NOT NULL
       ORDER BY song_count DESC NULLS LAST, artist_clean COLLATE NOCASE
       LIMIT ?`
    ).all(n).map(r => r.artist_clean);
  }
  const TADB_RETRY_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
  const cutoff = Date.now() - TADB_RETRY_COOLDOWN_MS;
  return db.prepare(
    `SELECT artist_clean FROM artists_normalized
     WHERE image_file IS NULL AND last_fetched IS NOT NULL AND last_fetched < ?
     ORDER BY song_count DESC NULLS LAST, artist_clean COLLATE NOCASE
     LIMIT ?`
  ).all(cutoff, n).map(r => r.artist_clean);
}

export function searchFiles(searchCol, searchTerm, vpaths, ignoreVPaths, filepathPrefix, excludeFilepathPrefixes, negativeTerms = [], limit) {
  const validCols = ['title', 'artist', 'album', 'filepath'];
  // String = one FTS5 column; array = column-filter set (term matches ANY listed column).
  let colSet;
  if (Array.isArray(searchCol)) {
    if (searchCol.length === 0 || !searchCol.every(c => validCols.includes(c))) { return []; }
    colSet = searchCol.join(' ');
  } else {
    if (!validCols.includes(searchCol)) { return []; }
    colSet = searchCol;
  }

  const filtered = vpathFilter(vpaths, ignoreVPaths);
  if (filtered.length === 0) { return []; }

  const vIn = inClause('f.vpath', filtered);
  const ep = excludePrefixClauses(excludeFilepathPrefixes, 'f.vpath', 'f.filepath');

  // Build FTS5 MATCH query: column-filtered prefix match + optional NOT exclusions
  const notClause = negativeTerms.map(t => ` NOT "${escapeFts(t)}"`).join('');
  const ftsQuery = `{${colSet}} : "${escapeFts(searchTerm)}"*${notClause}`;
  const rowLimit = normalizeSearchLimit(limit, 800);
  const shortTerm = String(searchTerm || '').trim().length < 2;

  const params = [...vIn.params, ...ep.params, ftsQuery];
  // fts_files is the outer (driving) table so SQLite uses the FTS5 index scan.
  // ORDER BY rank for relevance ordering on regular queries, with a bounded
  // LIMIT to prevent broad terms from scanning huge candidate sets.
  let sql = `SELECT f.rowid AS id, f.* FROM fts_files ft
    JOIN files f ON f.rowid = ft.rowid
    WHERE ${vIn.sql}${ep.sql}
    AND ft.fts_files MATCH ?`;
  if (filepathPrefix && typeof filepathPrefix === 'string') {
    sql += String.raw` AND f.filepath LIKE ? ESCAPE '\'`;
    params.push(filepathPrefix.replaceAll(/[%_\\]/g, String.raw`\$&`) + '%');
  }
  if (!shortTerm) sql += ' ORDER BY rank';
  sql += ' LIMIT ?';
  params.push(rowLimit);
  const rows = _prepare(sql).all(...params);
  return rows.map(mapFileRow);
}

// Artist→Album search: find unique albums whose ARTIST column matches the query.
// Unlike searchFiles('artist',...) which fetches 50 rows and deduplicates in JS
// (giving only the albums with the most tracks), this query groups at the SQL
// level so LIMIT 50 counts unique albums. This way "Cerrone" returns 50 Cerrone
// albums instead of the same 3-5 albums that happen to have the most tracks.
export function getAlbumVersionInventory() {
  return _prepare(`
    SELECT album_version_source, COUNT(*) AS cnt
    FROM files
    WHERE album_version_source IS NOT NULL
    GROUP BY album_version_source
    ORDER BY cnt DESC
  `).all();
}

export function searchAlbumsByArtist(searchTerm, vpaths, ignoreVPaths, filepathPrefix, excludeFilepathPrefixes, negativeTerms = [], limit) {
  const filtered = vpathFilter(vpaths, ignoreVPaths);
  if (filtered.length === 0) { return []; }

  const vIn = inClause('f.vpath', filtered);
  const ep = excludePrefixClauses(excludeFilepathPrefixes, 'f.vpath', 'f.filepath');

  const notClause = negativeTerms.map(t => ` NOT "${escapeFts(t)}"`).join('');
  const ftsQuery = `{artist} : "${escapeFts(searchTerm)}"*${notClause}`;
  const rowLimit = normalizeSearchLimit(limit, 800);

  const params = [...vIn.params, ...ep.params, ftsQuery];
  // GROUP BY album at SQL level: LIMIT 50 counts distinct albums, not rows.
  // MAX(aaFile) / MAX(cover_file) picks a non-null art file from the group.
  let sql = `SELECT f.album, MAX(f.aaFile) AS aaFile, MAX(f.cover_file) AS cover_file, MAX(f.album_version) AS album_version
    FROM fts_files ft
    JOIN files f ON f.rowid = ft.rowid
    WHERE ${vIn.sql}${ep.sql}
    AND ft.fts_files MATCH ?`;
  if (filepathPrefix && typeof filepathPrefix === 'string') {
    sql += String.raw` AND f.filepath LIKE ? ESCAPE '\'`;
    params.push(filepathPrefix.replaceAll(/[%_\\]/g, String.raw`\$&`) + '%');
  }
  sql += ' GROUP BY f.album';
  sql += ' LIMIT ?';
  params.push(rowLimit);
  return _prepare(sql).all(...params);
}

// Multi-word cross-field search: every positive token must appear somewhere
// across title/artist/album/filepath. Enables queries like "chaka khan fate"
// where artist words and title words are spread across columns.
export function searchFilesAllWords(tokens, vpaths, ignoreVPaths, filepathPrefix, excludeFilepathPrefixes, negativeTerms = [], limit) {
  const filtered = vpathFilter(vpaths, ignoreVPaths);
  if (filtered.length === 0 || tokens.length === 0) { return []; }

  const vIn = inClause('f.vpath', filtered);
  const ep = excludePrefixClauses(excludeFilepathPrefixes, 'f.vpath', 'f.filepath');

  // Each positive token must match at least one column (prefix match)
  const posClause = tokens.map(t => `"${escapeFts(t)}"*`).join(' AND ');
  const notClause = negativeTerms.map(t => ` NOT "${escapeFts(t)}"`).join('');
  const ftsQuery = posClause + notClause;
  const rowLimit = normalizeSearchLimit(limit, 800);

  const params = [...vIn.params, ...ep.params, ftsQuery];
  // Same optimizations as searchFiles: FTS as outer table, ORDER BY rank, bounded LIMIT.
  let sql = `SELECT f.rowid AS id, f.* FROM fts_files ft
    JOIN files f ON f.rowid = ft.rowid
    WHERE ${vIn.sql}${ep.sql}
    AND ft.fts_files MATCH ?`;
  if (filepathPrefix && typeof filepathPrefix === 'string') {
    sql += String.raw` AND f.filepath LIKE ? ESCAPE '\'`;
    params.push(filepathPrefix.replaceAll(/[%_\\]/g, String.raw`\$&`) + '%');
  }
  sql += ' ORDER BY rank';
  sql += ' LIMIT ?';
  params.push(rowLimit);
  const rows = _prepare(sql).all(...params);
  return rows.map(mapFileRow);
}

// Paginated "list all songs" — used by Subsonic search3 with empty query.
// OpenSubsonic spec: "A blank query will return everything."
export function listAllSongs(vpaths, ignoreVPaths, excludeFilepathPrefixes, filepathPrefix, offset, limit) {
  const filtered = vpathFilter(vpaths, ignoreVPaths);
  if (filtered.length === 0) { return []; }
  const vIn = inClause('vpath', filtered);
  const ep = excludePrefixClauses(excludeFilepathPrefixes);
  const params = [...vIn.params, ...ep.params];
  let sql = `SELECT rowid AS id, * FROM files WHERE ${vIn.sql}${ep.sql}`;
  if (filepathPrefix && typeof filepathPrefix === 'string') {
    sql += String.raw` AND filepath LIKE ? ESCAPE '\'`;
    params.push(filepathPrefix.replaceAll(/[%_\\]/g, String.raw`\$&`) + '%');
  }
  // NULLs/whitespace-only last so properly tagged songs are returned first in paginated sync
  // Use REPLACE to strip all whitespace types (tabs, newlines) before TRIM check
  const wsNull = c => `CASE WHEN TRIM(REPLACE(REPLACE(REPLACE(COALESCE(${c},''),CHAR(9),' '),CHAR(10),' '),CHAR(13),' '))='' THEN 1 ELSE 0 END`;
  sql += ` ORDER BY ${wsNull('artist')}, artist COLLATE NOCASE,` +
         ` ${wsNull('album')}, album COLLATE NOCASE, track LIMIT ? OFFSET ?`;
  params.push(limit, offset);
  const rows = db.prepare(sql).all(...params);
  return rows.map(mapFileRow);
}

export function getUserSettings(username) {
  const row = db.prepare('SELECT prefs, queue FROM user_settings WHERE username = ?').get(username);
  if (!row) return { prefs: {}, queue: null };
  return {
    prefs: JSON.parse(row.prefs || '{}'),
    queue: JSON.parse(row.queue || 'null'),
  };
}

export function saveUserSettings(username, patch) {
  const existing = getUserSettings(username);
  if (patch.prefs !== undefined) existing.prefs = Object.assign(existing.prefs, patch.prefs);
  if (patch.queue !== undefined) existing.queue = patch.queue;
  db.prepare(
    'INSERT INTO user_settings (username, prefs, queue) VALUES (?, ?, ?) ON CONFLICT(username) DO UPDATE SET prefs = excluded.prefs, queue = excluded.queue'
  ).run(username, JSON.stringify(existing.prefs), JSON.stringify(existing.queue));
}

export function getRatedSongs(vpaths, username, ignoreVPaths, excludeFilepathPrefixes) {
  const filtered = vpathFilter(vpaths, ignoreVPaths);
  if (filtered.length === 0) { return []; }
  const vIn = inClause('f.vpath', filtered);
  const ep = excludePrefixClauses(excludeFilepathPrefixes, 'f.vpath', 'f.filepath');
  const rows = db.prepare(`
    SELECT f.rowid AS id, f.*, um.rating
    FROM user_metadata um
    INNER JOIN files f ON f.hash = um.hash
    WHERE um.user = ? AND um.rating > 0 AND ${vIn.sql}${ep.sql}
    ORDER BY um.rating DESC
  `).all(username, ...vIn.params, ...ep.params);
  return rows.map(mapFileRow);
}

export function getRecentlyAdded(vpaths, username, limit, ignoreVPaths, opts = {}) {
  const filtered = vpathFilter(vpaths, ignoreVPaths);
  if (filtered.length === 0) { return []; }
  const vIn = inClause('f.vpath', filtered);
  const pf = prefixClause(opts.filepathPrefix, 'f.filepath');
  const ep = excludePrefixClauses(opts.excludeFilepathPrefixes, 'f.vpath', 'f.filepath');
  const ip = includePrefixClauses(opts.includeFilepathPrefixes, 'f.vpath', 'f.filepath');
  const rows = db.prepare(`
    SELECT f.rowid AS id, f.*, um.rating
    FROM files f
    LEFT JOIN user_metadata um ON f.hash = um.hash AND um.user = ?
    WHERE ${vIn.sql}${pf.sql}${ep.sql}${ip.sql} AND f.ts > 0
    ORDER BY CASE WHEN f.ts > unixepoch() THEN 0 ELSE f.ts END DESC, f.rowid DESC
    LIMIT ?
  `).all(username, ...vIn.params, ...pf.params, ...ep.params, ...ip.params, limit);
  return rows.map(mapFileRow);
}

export function getRecentlyPlayed(vpaths, username, limit, ignoreVPaths, opts = {}) {
  const filtered = vpathFilter(vpaths, ignoreVPaths);
  if (filtered.length === 0) { return []; }
  const vIn = inClause('f.vpath', filtered);
  const pf = prefixClause(opts.filepathPrefix, 'f.filepath');
  const ep = excludePrefixClauses(opts.excludeFilepathPrefixes, 'f.vpath', 'f.filepath');
  const ip = includePrefixClauses(opts.includeFilepathPrefixes, 'f.vpath', 'f.filepath');
  const rows = db.prepare(`
    SELECT f.rowid AS id, f.*, um.rating, um.lp AS lastPlayed, um.pc AS playCount
    FROM user_metadata um
    INNER JOIN files f ON f.hash = um.hash
    WHERE um.user = ? AND um.lp > 0 AND ${vIn.sql}${pf.sql}${ep.sql}${ip.sql}
    ORDER BY um.lp DESC
    LIMIT ?
  `).all(username, ...vIn.params, ...pf.params, ...ep.params, ...ip.params, limit);
  return rows.map(mapFileRow);
}

export function getMostPlayed(vpaths, username, limit, ignoreVPaths, opts = {}) {
  const filtered = vpathFilter(vpaths, ignoreVPaths);
  if (filtered.length === 0) { return []; }
  const vIn = inClause('f.vpath', filtered);
  const pf = prefixClause(opts.filepathPrefix, 'f.filepath');
  const ep = excludePrefixClauses(opts.excludeFilepathPrefixes, 'f.vpath', 'f.filepath');
  const ip = includePrefixClauses(opts.includeFilepathPrefixes, 'f.vpath', 'f.filepath');
  const rows = db.prepare(`
    SELECT f.rowid AS id, f.*, um.rating, um.lp AS lastPlayed, um.pc AS playCount
    FROM user_metadata um
    INNER JOIN files f ON f.hash = um.hash
    WHERE um.user = ? AND um.pc > 0 AND ${vIn.sql}${pf.sql}${ep.sql}${ip.sql}
    ORDER BY um.pc DESC
    LIMIT ?
  `).all(username, ...vIn.params, ...pf.params, ...ep.params, ...ip.params, limit);
  return rows.map(mapFileRow);
}

export function getAllFilesWithMetadata(vpaths, username, opts) {
  const filtered = vpathFilter(vpaths, opts.ignoreVPaths);
  if (filtered.length === 0) { return []; }
  const vIn = inClause('f.vpath', filtered);
  const ep = excludePrefixClauses(opts.excludeFilepathPrefixes, 'f.vpath', 'f.filepath');

  let sql = `
    SELECT f.rowid AS id, f.*, um.rating
    FROM files f
    LEFT JOIN user_metadata um ON f.hash = um.hash AND um.user = ?
    WHERE ${vIn.sql}${ep.sql}
  `;
  const params = [username, ...vIn.params, ...ep.params];

  if (opts.filepathPrefix && typeof opts.filepathPrefix === 'string') {
    sql += String.raw` AND f.filepath LIKE ? ESCAPE '\'`;
    params.push(opts.filepathPrefix.replaceAll(/[%_\\]/g, String.raw`\$&`) + '%');
  }

  const minRating = Number(opts.minRating);
  if (minRating && typeof minRating === 'number' && minRating <= 10 && minRating >= 1) {
    sql += ' AND um.rating >= ?';
    params.push(opts.minRating);
  }

  if (opts.artists && Array.isArray(opts.artists) && opts.artists.length > 0) {
    const aIn = inClause('f.artist', opts.artists);
    sql += ` AND ${aIn.sql}`;
    params.push(...aIn.params);
  }

  if (opts.ignoreArtists && Array.isArray(opts.ignoreArtists) && opts.ignoreArtists.length > 0) {
    const placeholders = opts.ignoreArtists.map(() => '?').join(',');
    sql += ` AND (f.artist IS NULL OR REPLACE(LOWER(f.artist), '.', '') NOT IN (${placeholders}))`;
    params.push(...opts.ignoreArtists.map(a => String(a).toLowerCase().replaceAll('.', '')));
  }

  sql = _appendBpmKeyFilters(sql, params, opts);
  sql = _appendGenreFilter(sql, params, opts);

  const rows = db.prepare(sql).all(...params);
  return rows.map(mapFileRow);
}

// ── Lightweight random-pick helpers (used by Auto-DJ no-filter path) ──────────
// Avoid loading all 100k+ rows into heap just to pick one index.
// Reverse Camelot lookup: code → all long-form key names stored by scanner/AcousticBrainz.
// Includes enharmonic equivalents (Ab=G#, Bb=A#, Eb=D#, Db=C#, Gb=F#).
const _CAMELOT_TO_KEYS = {
  '1A':  ['Ab minor',  'G# minor'],
  '1B':  ['B major'],
  '2A':  ['Eb minor',  'D# minor'],
  '2B':  ['F# major',  'Gb major'],
  '3A':  ['Bb minor',  'A# minor'],
  '3B':  ['Db major',  'C# major'],
  '4A':  ['F minor'],
  '4B':  ['Ab major',  'G# major'],
  '5A':  ['C minor'],
  '5B':  ['Eb major',  'D# major'],
  '6A':  ['G minor'],
  '6B':  ['Bb major',  'A# major'],
  '7A':  ['D minor'],
  '7B':  ['F major'],
  '8A':  ['A minor'],
  '8B':  ['C major'],
  '9A':  ['E minor'],
  '9B':  ['G major'],
  '10A': ['B minor'],
  '10B': ['D major'],
  '11A': ['F# minor'],
  '11B': ['A major'],
  '12A': ['C# minor'],
  '12B': ['E major'],
};

// Strategy: COUNT(*) to get candidate size → caller picks a random offset →
// fetch LIMIT 1 OFFSET n.  The ignore list is a small array of previously-picked
// offsets; we skip any that map onto ignored offsets by advancing the offset by
// the number of ignored positions below it.
//
// Shared BPM + musical-key SQL filter appender — used by multiple query builders.
function _appendBpmRangeFilter(sql, params, opts) {
  if (Array.isArray(opts.bpmRanges) && opts.bpmRanges.length > 0) {
    const clauses = opts.bpmRanges.map(() => '(f.bpm >= ? AND f.bpm <= ?)').join(' OR ');
    sql += ` AND f.bpm IS NOT NULL AND (${clauses})`;
    for (const r of opts.bpmRanges) { params.push(Number(r.min), Number(r.max)); }
  } else {
    if (opts.requireBpm)    { sql += ' AND f.bpm IS NOT NULL'; }
    if (opts.bpmMin != null) { sql += ' AND f.bpm IS NOT NULL AND f.bpm >= ?'; params.push(Number(opts.bpmMin)); }
    if (opts.bpmMax != null) { sql += ' AND f.bpm IS NOT NULL AND f.bpm <= ?'; params.push(Number(opts.bpmMax)); }
  }
  return sql;
}

function _appendMusicalKeyFilter(sql, params, opts) {
  if (opts.requireMusicalKey) { sql += ' AND f.musical_key IS NOT NULL'; }
  if (Array.isArray(opts.musicalKeys) && opts.musicalKeys.length > 0) {
    const rawKeys = [...new Set(opts.musicalKeys.flatMap(c => _CAMELOT_TO_KEYS[c] || []))];
    if (rawKeys.length > 0) {
      const kIn = rawKeys.map(() => '?').join(',');
      sql += ` AND f.musical_key IS NOT NULL AND f.musical_key IN (${kIn})`;
      params.push(...rawKeys);
    }
  }
  return sql;
}

function _appendBpmKeyFilters(sql, params, opts) {
  sql = _appendBpmRangeFilter(sql, params, opts);
  sql = _appendMusicalKeyFilter(sql, params, opts);
  return sql;
}

function _appendGenreFilter(sql, params, opts) {
  if (!Array.isArray(opts.genreRawStrings) || opts.genreRawStrings.length === 0) return sql;
  const placeholders = opts.genreRawStrings.map(() => '?').join(',');
  if (opts.genreMode === 'blacklist') {
    sql += ` AND (f.genre IS NULL OR f.genre = '' OR f.genre NOT IN (${placeholders}))`;
  } else {
    sql += ` AND f.genre IS NOT NULL AND f.genre != '' AND f.genre IN (${placeholders})`;
  }
  params.push(...opts.genreRawStrings);
  return sql;
}

// Shared WHERE-clause builder (same filters as getAllFilesWithMetadata minus artists).
function _buildRandomWhere(opts, filtered) {
  const vIn = inClause('f.vpath', filtered);
  const ep = excludePrefixClauses(opts.excludeFilepathPrefixes, 'f.vpath', 'f.filepath');
  let sql = `FROM files f LEFT JOIN user_metadata um ON f.hash = um.hash AND um.user = ? WHERE ${vIn.sql}${ep.sql}`;
  const params = [...vIn.params, ...ep.params];

  if (opts.filepathPrefix && typeof opts.filepathPrefix === 'string') {
    sql += String.raw` AND f.filepath LIKE ? ESCAPE '\'`;
    params.push(opts.filepathPrefix.replaceAll(/[%_\\]/g, String.raw`\$&`) + '%');
  }
  const minRating = Number(opts.minRating);
  if (minRating && minRating <= 10 && minRating >= 1) {
    sql += ' AND um.rating >= ?';
    params.push(minRating);
  }
  if (opts.ignoreArtists && Array.isArray(opts.ignoreArtists) && opts.ignoreArtists.length > 0) {
    const placeholders = opts.ignoreArtists.map(() => '?').join(',');
    sql += ` AND (f.artist IS NULL OR REPLACE(LOWER(f.artist), '.', '') NOT IN (${placeholders}))`;
    params.push(...opts.ignoreArtists.map(a => String(a).toLowerCase().replaceAll('.', '')));
  }
  sql = _appendBpmKeyFilters(sql, params, opts);
  sql = _appendGenreFilter(sql, params, opts);
  return { sql, params };
}

export function countFilesForRandom(vpaths, username, opts) {
  const filtered = vpathFilter(vpaths, opts.ignoreVPaths);
  if (filtered.length === 0) return 0;
  const { sql, params } = _buildRandomWhere(opts, filtered);
  const row = db.prepare(`SELECT COUNT(*) AS n ${sql}`).get(username, ...params);
  return row ? row.n : 0;
}

// Returns the single row at the given 0-based offset within the same candidate set.
export function pickFileAtOffset(vpaths, username, opts, offset) {
  const filtered = vpathFilter(vpaths, opts.ignoreVPaths);
  if (filtered.length === 0) return null;
  const { sql, params } = _buildRandomWhere(opts, filtered);
  const row = db.prepare(
    `SELECT f.rowid AS id, f.*, um.rating ${sql} ORDER BY f.rowid LIMIT 1 OFFSET ?`
  ).get(username, ...params, offset);
  return row ? mapFileRow(row) : null;
}

export function getGenres(vpaths, ignoreVPaths, opts = {}) {
  const filtered = vpathFilter(vpaths, ignoreVPaths);
  if (filtered.length === 0) return [];
  const vIn = inClause('vpath', filtered);
  const pf = prefixClause(opts.filepathPrefix);
  return db.prepare(
    `SELECT genre, COUNT(*) AS cnt FROM files WHERE ${vIn.sql}${pf.sql} AND genre IS NOT NULL AND genre != '' GROUP BY genre ORDER BY genre COLLATE NOCASE`
  ).all(...vIn.params, ...pf.params);
}

export function getSongsByGenre(genre, vpaths, username, ignoreVPaths, opts = {}) {
  const filtered = vpathFilter(vpaths, ignoreVPaths);
  if (filtered.length === 0) return [];
  const vIn = inClause('f.vpath', filtered);
  const pf = prefixClause(opts.filepathPrefix, 'f.filepath');
  const rows = db.prepare(`
    SELECT f.rowid AS id, f.*, um.rating
    FROM files f
    LEFT JOIN user_metadata um ON f.hash = um.hash AND um.user = ?
    WHERE ${vIn.sql}${pf.sql} AND f.genre = ?
    ORDER BY f.artist COLLATE NOCASE, f.album COLLATE NOCASE, f.disk, f.track
  `).all(username, ...vIn.params, ...pf.params, genre);
  return rows.map(mapFileRow);
}

/**
 * Fetch songs matching any of the given raw DB genre strings.
 * rawGenres is the full Set/Array from mergeGenreRows().rawMap — it contains
 * the original multi-value strings (e.g. "House, Trance, Chillout") as well
 * as single-tag values so an exact IN clause is sufficient.
 */
export function getSongsByGenreRaw(rawGenres, vpaths, username, ignoreVPaths) {
  const filtered = vpathFilter(vpaths, ignoreVPaths);
  if (filtered.length === 0) return [];
  const genreList = [...rawGenres];
  if (genreList.length === 0) return [];
  const vIn    = inClause('f.vpath', filtered);
  const gIn    = inClause('f.genre', genreList);
  const rows = db.prepare(`
    SELECT f.rowid AS id, f.*, um.rating
    FROM files f
    LEFT JOIN user_metadata um ON f.hash = um.hash AND um.user = ?
    WHERE ${vIn.sql} AND ${gIn.sql}
    ORDER BY f.artist COLLATE NOCASE, f.album COLLATE NOCASE, f.disk, f.track
  `).all(username, ...vIn.params, ...gIn.params);
  return rows.map(mapFileRow);
}

export function getDecades(vpaths, ignoreVPaths) {
  const filtered = vpathFilter(vpaths, ignoreVPaths);
  if (filtered.length === 0) return [];
  const vIn = inClause('vpath', filtered);
  return db.prepare(
    `SELECT (year / 10 * 10) AS decade, COUNT(*) AS cnt, COUNT(DISTINCT album) AS albums FROM files WHERE ${vIn.sql} AND year >= 1900 AND year <= 2030 GROUP BY decade ORDER BY decade`
  ).all(...vIn.params);
}

export function getAlbumsByDecade(decade, vpaths, ignoreVPaths, excludeFilepathPrefixes) {
  const filtered = vpathFilter(vpaths, ignoreVPaths);
  if (filtered.length === 0) return [];
  const vIn = inClause('vpath', filtered);
  const ep  = excludePrefixClauses(excludeFilepathPrefixes);
  // GROUP BY album+artist so SQLite deduplicates — no JS loop needed.
  // MIN(year) picks a representative year; MAX(aaFile) prefers a non-null art file.
  return db.prepare(`
    SELECT album AS name,
           MAX(aaFile) AS album_art_file,
           MIN(year)   AS year,
           artist
    FROM files
    WHERE ${vIn.sql}${ep.sql} AND album IS NOT NULL AND year >= ? AND year <= ?
    GROUP BY album, artist
    ORDER BY MIN(year), album COLLATE NOCASE
  `).all(...vIn.params, ...ep.params, decade, decade + 9);
}

export function getSongsByDecade(decade, vpaths, username, ignoreVPaths) {
  const filtered = vpathFilter(vpaths, ignoreVPaths);
  if (filtered.length === 0) return [];
  const vIn = inClause('f.vpath', filtered);
  const rows = db.prepare(`
    SELECT f.rowid AS id, f.*, um.rating
    FROM files f
    LEFT JOIN user_metadata um ON f.hash = um.hash AND um.user = ?
    WHERE ${vIn.sql} AND f.year >= ? AND f.year <= ?
    ORDER BY f.artist COLLATE NOCASE, f.album COLLATE NOCASE, f.disk, f.track
  `).all(username, ...vIn.params, decade, decade + 9);
  return rows.map(mapFileRow);
}

export function getUnplayedGems(username, vpaths, ignoreVPaths, limit = 100) {
  const filtered = vpathFilter(vpaths, ignoreVPaths);
  if (filtered.length === 0) return [];
  const safeLimit = Math.min(Math.max(1, Number(limit) || 100), 500);
  const vIn = inClause('f.vpath', filtered);
  return db.prepare(`
    SELECT f.rowid AS id, f.*, NULL AS rating
    FROM files f
    LEFT JOIN user_metadata um ON f.hash = um.hash AND um.user = ?
    WHERE ${vIn.sql} AND COALESCE(um.pc, 0) = 0
    ORDER BY f.year DESC, f.album COLLATE NOCASE, f.disk, f.track
    LIMIT ${safeLimit}
  `).all(username, ...vIn.params).map(mapFileRow);
}

export function countUnplayedGems(username, vpaths, ignoreVPaths) {
  const filtered = vpathFilter(vpaths, ignoreVPaths);
  if (filtered.length === 0) return 0;
  const vIn = inClause('f.vpath', filtered);
  const row = db.prepare(`
    SELECT COUNT(*) AS cnt
    FROM files f
    LEFT JOIN user_metadata um ON f.hash = um.hash AND um.user = ?
    WHERE ${vIn.sql} AND COALESCE(um.pc, 0) = 0
  `).get(username, ...vIn.params);
  return row?.cnt ?? 0;
}

export function getAlbumsByGenre(rawGenres, vpaths, ignoreVPaths, excludeFilepathPrefixes) {
  const filtered = vpathFilter(vpaths, ignoreVPaths);
  if (filtered.length === 0) return [];
  const genreList = [...rawGenres];
  if (genreList.length === 0) return [];
  const vIn = inClause('vpath', filtered);
  const gIn = inClause('genre', genreList);
  const ep  = excludePrefixClauses(excludeFilepathPrefixes);
  return db.prepare(`
    SELECT album AS name,
           MAX(aaFile) AS album_art_file,
           MIN(year)   AS year,
           artist
    FROM files
    WHERE ${vIn.sql} AND ${gIn.sql}${ep.sql} AND album IS NOT NULL
    GROUP BY album, artist
    ORDER BY artist COLLATE NOCASE, album COLLATE NOCASE
  `).all(...vIn.params, ...gIn.params, ...ep.params);
}


// User Metadata
export function findUserMetadata(hash, username) {
  const row = db.prepare('SELECT rowid AS id, * FROM user_metadata WHERE hash = ? AND user = ?').get(hash, username);
  return row || null;
}

export function insertUserMetadata(obj) {
  db.prepare('INSERT INTO user_metadata (hash, user, rating, pc, lp) VALUES (?, ?, ?, ?, ?)').run(
    obj.hash, obj.user, obj.rating ?? null, obj.pc ?? 0, obj.lp ?? null
  );
}

export function updateUserMetadata(obj) {
  db.prepare('UPDATE user_metadata SET rating = ?, pc = ?, lp = ? WHERE hash = ? AND user = ?').run(
    obj.rating ?? null, obj.pc ?? 0, obj.lp ?? null, obj.hash, obj.user
  );
}

export function removeUserMetadataByUser(username) {
  db.prepare('DELETE FROM user_metadata WHERE user = ?').run(username);
}

export function resetPlayCounts(username) {
  db.prepare('UPDATE user_metadata SET pc = 0 WHERE user = ?').run(username);
}

export function resetRecentlyPlayed(username) {
  db.prepare('UPDATE user_metadata SET lp = NULL WHERE user = ?').run(username);
}

// Playlists
export function getUserPlaylists(username) {
  // Split the stored full-path (vpath + '/' + filepath) into its two parts so
  // SQLite can use the existing (filepath, vpath) composite index instead of
  // doing a full-table concat scan on 130 k+ rows (was 7 s, now <5 ms).
  return db.prepare(`
    SELECT p.name,
           COUNT(f.rowid) AS songCount,
           CAST(COALESCE(SUM(f.duration), 0) AS INTEGER) AS totalDuration
    FROM playlists p
    LEFT JOIN playlists e ON e.user = p.user AND e.name = p.name AND e.filepath IS NOT NULL
    LEFT JOIN files f
      ON f.vpath   = SUBSTR(e.filepath, 1, INSTR(e.filepath, '/') - 1)
     AND f.filepath = SUBSTR(e.filepath, INSTR(e.filepath, '/') + 1)
    WHERE p.user = ? AND p.filepath IS NULL
    GROUP BY p.name
  `).all(username);
}

export function findPlaylist(username, playlistName) {
  const row = db.prepare('SELECT rowid AS id, * FROM playlists WHERE user = ? AND name = ? LIMIT 1').get(username, playlistName);
  return row || null;
}

export function createPlaylistEntry(entry) {
  db.prepare('INSERT INTO playlists (name, filepath, user, live) VALUES (?, ?, ?, ?)').run(
    entry.name, entry.filepath ?? null, entry.user, entry.live ? 1 : 0
  );
}

export function deletePlaylist(username, playlistName) {
  db.prepare('DELETE FROM playlists WHERE user = ? AND name = ?').run(username, playlistName);
}

export function renamePlaylist(username, oldName, newName) {
  db.prepare('UPDATE playlists SET name = ? WHERE user = ? AND name = ?').run(newName, username, oldName);
}

export function getPlaylistEntryById(id) {
  const row = db.prepare('SELECT rowid AS id, * FROM playlists WHERE rowid = ?').get(id);
  return row || null;
}

export function removePlaylistEntryById(id) {
  db.prepare('DELETE FROM playlists WHERE rowid = ?').run(id);
}

export function loadPlaylistEntries(username, playlistName) {
  return db.prepare('SELECT rowid AS id, * FROM playlists WHERE user = ? AND name = ? AND filepath IS NOT NULL').all(username, playlistName);
}

export function removePlaylistsByUser(username) {
  db.prepare('DELETE FROM playlists WHERE user = ?').run(username);
}

// Shared Playlists
export function findSharedPlaylist(playlistId) {
  const row = db.prepare('SELECT rowid AS id, * FROM shared_playlists WHERE playlistId = ?').get(playlistId);
  if (!row) { return null; }
  row.playlist = JSON.parse(row.playlist);
  return row;
}

export function insertSharedPlaylist(item) {
  db.prepare('INSERT INTO shared_playlists (playlistId, playlist, user, expires, token) VALUES (?, ?, ?, ?, ?)').run(
    item.playlistId, JSON.stringify(item.playlist), item.user, item.expires ?? null, item.token
  );
}

export function getAllSharedPlaylists() {
  const rows = db.prepare('SELECT rowid AS id, * FROM shared_playlists').all();
  return rows.map(r => ({ ...r, playlist: JSON.parse(r.playlist) }));
}

export function removeSharedPlaylistById(playlistId) {
  db.prepare('DELETE FROM shared_playlists WHERE playlistId = ?').run(playlistId);
}

export function removeExpiredSharedPlaylists() {
  db.prepare('DELETE FROM shared_playlists WHERE expires IS NOT NULL AND expires < ?').run(Math.floor(Date.now() / 1000));
}

export function removeEternalSharedPlaylists() {
  db.prepare('DELETE FROM shared_playlists WHERE expires IS NULL').run();
}

export function removeSharedPlaylistsByUser(username) {
  db.prepare('DELETE FROM shared_playlists WHERE user = ?').run(username);
}

// ── Scan Errors ─────────────────────────────────────────────────────────────

/**
 * Upsert a scan error.  If an entry with the same guid already exists, its
 * last_seen timestamp and detection count are updated instead of creating a
 * duplicate row.  guid = md5(relativeFilePath + '|' + errorType) so the same
 * problem recurs as count increments rather than flooding the table.
 */
export function insertScanError(guid, filepath, vpath, errorType, errorMsg, stack) {
  const now = Math.floor(Date.now() / 1000);
  const existing = db.prepare('SELECT count FROM scan_errors WHERE guid = ?').get(guid);
  if (existing) {
    // Re-occurrence resets fixed_at and fix_action so a re-broken file becomes
    // unfixed again; also refresh error_msg/stack in case the message changed.
    db.prepare('UPDATE scan_errors SET last_seen = ?, count = count + 1, fixed_at = NULL, fix_action = NULL, error_msg = ?, stack = ? WHERE guid = ?').run(now, errorMsg || '', stack || '', guid);
  } else {
    db.prepare(
      'INSERT INTO scan_errors (guid, filepath, vpath, error_type, error_msg, stack, first_seen, last_seen, count) VALUES (?,?,?,?,?,?,?,?,1)'
    ).run(guid, filepath, vpath, errorType, errorMsg || '', stack || '', now, now);
  }
}

export function getScanErrors(limit = 500) {
  const rows = db.prepare(`
    SELECT se.*,
      CASE WHEN f.filepath IS NOT NULL THEN 1 ELSE 0 END AS file_in_db
    FROM scan_errors se
    LEFT JOIN files f ON f.filepath = se.filepath AND f.vpath = se.vpath
    ORDER BY se.fixed_at DESC NULLS LAST, se.last_seen DESC
    LIMIT ?
  `).all(limit);
  const total = db.prepare('SELECT COUNT(*) AS cnt FROM scan_errors').get().cnt;
  return { errors: rows, total };
}

export function getScanErrorByGuid(guid) {
  return db.prepare(`
    SELECT se.*,
      CASE WHEN f.filepath IS NOT NULL THEN 1 ELSE 0 END AS file_in_db
    FROM scan_errors se
    LEFT JOIN files f ON f.filepath = se.filepath AND f.vpath = se.vpath
    WHERE se.guid = ?
  `).get(guid) || null;
}

export function clearScanErrors() {
  db.prepare('DELETE FROM scan_errors').run();
}

/** Remove entries whose last_seen is older than retentionHours, plus fixed entries older than 48 h. */
export function pruneScanErrors(retentionHours) {
  const cutoff      = Math.floor(Date.now() / 1000) - retentionHours * 3600;
  const fixedCutoff = Math.floor(Date.now() / 1000) - 48 * 3600;
  db.prepare('DELETE FROM scan_errors WHERE last_seen < ?').run(cutoff);
  db.prepare('DELETE FROM scan_errors WHERE fixed_at IS NOT NULL AND fixed_at < ?').run(fixedCutoff);
}

/** Remove errors for this vpath that were NOT re-encountered in the current scan.
 *  Called at finish-scan — any error whose last_seen < scanStartTs was not triggered
 *  this run, meaning the underlying problem is resolved. */
export function clearResolvedErrors(vpath, scanStartTs) {
  db.prepare('DELETE FROM scan_errors WHERE vpath = ? AND last_seen < ?').run(vpath, scanStartTs);
}

/** Mark a single error as fixed, storing what action was taken. */
export function markScanErrorFixed(guid, fixAction) {
  const now = Math.floor(Date.now() / 1000);
  db.prepare('UPDATE scan_errors SET fixed_at = ?, fix_action = ?, confirmed_at = NULL WHERE guid = ?').run(now, fixAction || null, guid);
}

/**
 * After a successful rescan of a previously-errored file, mark all fixed errors
 * for that filepath+vpath as confirmed OK.  Only touches rows where fixed_at IS
 * NOT NULL (i.e. someone already clicked Fix) — unfixed errors are untouched.
 */
export function confirmScanErrorOk(filepath, vpath) {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    'UPDATE scan_errors SET confirmed_at = ? WHERE filepath = ? AND vpath = ? AND fixed_at IS NOT NULL AND confirmed_at IS NULL'
  ).run(now, filepath, vpath);
}

/**
 * Mark a file's album-art lookup as "checked, none found" by setting aaFile = ''
 * (empty string). The scanner treats null as "never tried" and '' as "tried, nothing".
 */
export function markFileArtChecked(filepath, vpath) {
  db.prepare("UPDATE files SET aaFile = '' WHERE (aaFile IS NULL OR aaFile = '') AND filepath = ? AND vpath = ?").run(filepath, vpath);
}

/** Mark a file's cue-sheet check as done-with-nothing by setting cuepoints = '[]'. */
export function markFileCueChecked(filepath, vpath) {
  db.prepare("UPDATE files SET cuepoints = '[]' WHERE (cuepoints IS NULL) AND filepath = ? AND vpath = ?").run(filepath, vpath);
}

/** Count only actionable errors (unfixed AND file still in library) — used for the sidebar badge. */
export function getScanErrorCount() {
  return db.prepare(`
    SELECT COUNT(*) AS cnt FROM scan_errors se
    INNER JOIN files f ON f.filepath = se.filepath AND f.vpath = se.vpath
    WHERE se.fixed_at IS NULL
  `).get().cnt;
}

// ── Subsonic-specific queries ────────────────────────────────────────────────

export function getFilesByArtistId(artistId, vpaths, username, opts = {}) {
  const filtered = vpathFilter(vpaths, null);
  if (filtered.length === 0) return [];
  const vIn = inClause('f.vpath', filtered);
  const pf = prefixClause(opts.filepathPrefix, 'f.filepath');
  const rows = db.prepare(`
    SELECT f.rowid AS id, f.*, um.rating, um.starred, um.lp AS lastPlayed, um.pc AS playCount
    FROM files f
    LEFT JOIN user_metadata um ON f.hash = um.hash AND um.user = ?
    WHERE f.artist_id = ? AND ${vIn.sql}${pf.sql}
    ORDER BY f.album COLLATE NOCASE, f.disk, f.track, f.filepath
  `).all(username, artistId, ...vIn.params, ...pf.params);
  return rows.map(mapFileRow);
}

export function getFilesByAlbumId(albumId, vpaths, username, opts = {}) {
  const filtered = vpathFilter(vpaths, null);
  if (filtered.length === 0) return [];
  const vIn = inClause('f.vpath', filtered);
  const pf = prefixClause(opts.filepathPrefix, 'f.filepath');
  const rows = db.prepare(`
    SELECT f.rowid AS id, f.*, um.rating, um.starred, um.lp AS lastPlayed, um.pc AS playCount
    FROM files f
    LEFT JOIN user_metadata um ON f.hash = um.hash AND um.user = ?
    WHERE f.album_id = ? AND ${vIn.sql}${pf.sql}
    ORDER BY f.disk, f.track, f.filepath
  `).all(username, albumId, ...vIn.params, ...pf.params);
  return rows.map(mapFileRow);
}

export function getSongByHash(hash, username) {
  // ORDER BY f.rowid makes resolution deterministic: when more than one physical
  // file shares a content hash (duplicate files, or legacy rows), a bare-hash id
  // always maps to the SAME file instead of an arbitrary one. The exact-file case
  // is handled by getSongByRowid via the "<hash>@<rowid>" id format.
  const row = db.prepare(`
    SELECT f.rowid AS id, f.*, um.rating, um.starred, um.lp AS lastPlayed, um.pc AS playCount
    FROM files f
    LEFT JOIN user_metadata um ON f.hash = um.hash AND um.user = ?
    WHERE f.hash = ?
    ORDER BY f.rowid
    LIMIT 1
  `).get(username, hash);
  return row ? mapFileRow(row) : null;
}

// Exact-file lookup by SQLite rowid. Used to resolve the "<hash>@<rowid>" Subsonic
// id form so that two files sharing a content hash each resolve to their own file.
export function getSongByRowid(rowid, username) {
  const rid = Number.parseInt(rowid, 10);
  if (!Number.isInteger(rid)) return null;
  const row = db.prepare(`
    SELECT f.rowid AS id, f.*, um.rating, um.starred, um.lp AS lastPlayed, um.pc AS playCount
    FROM files f
    LEFT JOIN user_metadata um ON f.hash = um.hash AND um.user = ?
    WHERE f.rowid = ?
    LIMIT 1
  `).get(username, rid);
  return row ? mapFileRow(row) : null;
}

// Batch variant of getSongByRowid. Returns Map<rowid, row>.
export function getSongsByRowids(rowids, username) {
  const out = new Map();
  if (!Array.isArray(rowids) || rowids.length === 0) return out;
  const uniq = [...new Set(rowids.map(r => Number.parseInt(r, 10)).filter(Number.isInteger))];
  const chunkSize = 400;
  for (let i = 0; i < uniq.length; i += chunkSize) {
    const chunk = uniq.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT f.rowid AS id, f.*, um.rating, um.starred, um.lp AS lastPlayed, um.pc AS playCount
      FROM files f
      LEFT JOIN user_metadata um ON f.hash = um.hash AND um.user = ?
      WHERE f.rowid IN (${placeholders})
    `).all(username, ...chunk);
    for (const row of rows) out.set(row.id, mapFileRow(row));
  }
  return out;
}

// In-memory set of content hashes that are shared by 2+ physical files. Used by the
// Subsonic layer to decide when a song id needs the "@<rowid>" disambiguator so the
// client always streams the exact file it selected. Rebuilt on startup and after
// every scan (hashes only change when files are added/removed/rescanned).
let _duplicateHashes = new Set();
export function refreshDuplicateHashes() {
  try {
    const rows = db.prepare(
      'SELECT hash FROM files WHERE hash IS NOT NULL GROUP BY hash HAVING COUNT(*) > 1'
    ).all();
    _duplicateHashes = new Set(rows.map(r => r.hash));
  } catch {
    _duplicateHashes = new Set();
  }
  return _duplicateHashes.size;
}
export function isDuplicatedHash(hash) {
  return hash != null && _duplicateHashes.has(hash);
}

// Batch variant of getSongByHash used by Subsonic handlers to avoid N+1 lookups.
// Returns Map<hash, row> for hashes that exist.
export function getSongsByHashes(hashes, username) {
  const out = new Map();
  if (!Array.isArray(hashes) || hashes.length === 0) return out;

  const uniq = [...new Set(hashes.map(String).filter(Boolean))];
  const chunkSize = 400;
  for (let i = 0; i < uniq.length; i += chunkSize) {
    const chunk = uniq.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT f.rowid AS id, f.*, um.rating, um.starred, um.lp AS lastPlayed, um.pc AS playCount
      FROM files f
      LEFT JOIN user_metadata um ON f.hash = um.hash AND um.user = ?
      WHERE f.hash IN (${placeholders})
    `).all(username, ...chunk);
    for (const row of rows) out.set(row.hash, mapFileRow(row));
  }

  return out;
}

// Batch metadata lookup for one vpath: returns Map<filepath, row>
// where filepath is the relative DB filepath within that vpath.
export function getFilesWithMetadataByPaths(filepaths, vpath, username) {
  const out = new Map();
  if (!Array.isArray(filepaths) || filepaths.length === 0) return out;

  const uniq = [...new Set(filepaths.map(String).filter(Boolean))];
  const chunkSize = 400;
  for (let i = 0; i < uniq.length; i += chunkSize) {
    const chunk = uniq.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT f.rowid AS id, f.*, um.rating
      FROM files f
      LEFT JOIN user_metadata um ON f.hash = um.hash AND um.user = ?
      WHERE f.vpath = ? AND f.filepath IN (${placeholders})
    `).all(username, vpath, ...chunk);
    for (const row of rows) out.set(row.filepath, mapFileRow(row));
  }

  return out;
}

/**
 * Resolve a raw coverArt/id string to an aaFile filename.
 * Handles album_id (16-char hex), artist_id (16-char hex), and song hash (32-char hex).
 * Returns null if nothing is found.
 */
export function getAaFileById(id) {
  if (!db || !id) return null;
  let row = db.prepare('SELECT MAX(aaFile) AS aaFile FROM files WHERE album_id = ? AND aaFile IS NOT NULL').get(id);
  if (row?.aaFile) return row.aaFile;
  row = db.prepare('SELECT MAX(aaFile) AS aaFile FROM files WHERE artist_id = ? AND aaFile IS NOT NULL').get(id);
  if (row?.aaFile) return row.aaFile;
  row = db.prepare('SELECT aaFile FROM files WHERE hash = ? AND aaFile IS NOT NULL LIMIT 1').get(id);
  return row?.aaFile || null;
}

// In-memory cache for getAaFileForDir — cleared on scan to stay consistent.
const _aaFileForDirCache = new Map();
export function clearAaFileForDirCache() { _aaFileForDirCache.clear(); }

export function getAaFileForDir(vpath, dirRelPath) {
  if (!db) return null;
  const cacheKey = vpath + '\0' + (dirRelPath || '');
  if (_aaFileForDirCache.has(cacheKey)) return _aaFileForDirCache.get(cacheKey);
  const prefix = dirRelPath ? dirRelPath + '/' : '';
  const escaped = prefix.replaceAll(/[%_\\]/g, String.raw`\$&`);
  const row = db.prepare(
    String.raw`SELECT MAX(aaFile) AS aaFile FROM files WHERE vpath = ? AND filepath LIKE ? ESCAPE '\' AND aaFile IS NOT NULL`
  ).get(vpath, escaped + '%');
  const result = row?.aaFile || null;
  _aaFileForDirCache.set(cacheKey, result);
  return result;
}

export function getStarredSongs(vpaths, username, opts = {}) {
  const filtered = vpathFilter(vpaths, null);
  if (filtered.length === 0) return [];
  const vIn = inClause('f.vpath', filtered);
  const pf = prefixClause(opts.filepathPrefix, 'f.filepath');
  const ip = includePrefixClauses(opts.includeFilepathPrefixes, 'f.vpath', 'f.filepath');
  const rows = db.prepare(`
    SELECT f.rowid AS id, f.*, um.rating, um.starred, um.lp AS lastPlayed, um.pc AS playCount
    FROM user_metadata um
    INNER JOIN files f ON f.hash = um.hash
    WHERE um.user = ? AND um.starred = 1 AND ${vIn.sql}${pf.sql}${ip.sql}
    ORDER BY f.artist COLLATE NOCASE, f.album COLLATE NOCASE, f.disk, f.track
  `).all(username, ...vIn.params, ...pf.params, ...ip.params);
  return rows.map(mapFileRow);
}

export function getStarredAlbums(vpaths, username, opts = {}) {
  const filtered = vpathFilter(vpaths, null);
  if (filtered.length === 0) return [];
  const vIn = inClause('f.vpath', filtered);
  const pf = prefixClause(opts.filepathPrefix, 'f.filepath');
  // Return one representative row per album_id that has at least one starred song
  const rows = db.prepare(`
    SELECT f.rowid AS id, f.*, um.rating, um.starred
    FROM files f
    INNER JOIN user_metadata um ON f.hash = um.hash AND um.user = ?
    WHERE um.starred = 1 AND ${vIn.sql}${pf.sql}
    GROUP BY f.album_id
    ORDER BY f.album COLLATE NOCASE
  `).all(username, ...vIn.params, ...pf.params);
  return rows.map(mapFileRow);
}

export function setStarred(hash, username, starred) {
  const existing = db.prepare('SELECT rowid FROM user_metadata WHERE hash = ? AND user = ?').get(hash, username);
  if (existing) {
    db.prepare('UPDATE user_metadata SET starred = ? WHERE hash = ? AND user = ?').run(starred ? 1 : 0, hash, username);
  } else {
    db.prepare('INSERT INTO user_metadata (hash, user, rating, pc, lp, starred) VALUES (?, ?, NULL, 0, NULL, ?)').run(hash, username, starred ? 1 : 0);
  }
}

export function getRandomSongs(vpaths, username, opts) {
  const filtered = vpathFilter(vpaths, null);
  if (filtered.length === 0) return [];
  const vIn = inClause('f.vpath', filtered);
  const pf = prefixClause(opts.filepathPrefix, 'f.filepath');
  const ip = includePrefixClauses(opts.includeFilepathPrefixes, 'f.vpath', 'f.filepath');
  const limit = Math.min(Number(opts.size) || 10, 500);

  const joinSql = `FROM files f LEFT JOIN user_metadata um ON f.hash = um.hash AND um.user = ?`;
  let whereSql = `WHERE ${vIn.sql}${pf.sql}${ip.sql}`;
  const params = [username, ...vIn.params, ...pf.params, ...ip.params];

  if (opts.genre)    { whereSql += ' AND f.genre = ?';  params.push(opts.genre); }
  if (opts.fromYear) { whereSql += ' AND f.year >= ?';  params.push(Number(opts.fromYear)); }
  if (opts.toYear)   { whereSql += ' AND f.year <= ?';  params.push(Number(opts.toYear)); }

  whereSql = _appendBpmKeyFilters(whereSql, params, opts);

  // COUNT first — avoids loading all matching rows into heap.
  const count = db.prepare(`SELECT COUNT(*) AS n ${joinSql} ${whereSql}`).get(...params).n;
  if (count === 0) return [];

  // Prepare the single-row OFFSET fetch once, reuse for each pick.
  const rowStmt = db.prepare(
    `SELECT f.rowid AS id, f.*, um.rating, um.starred, um.lp AS lastPlayed, um.pc AS playCount ` +
    `${joinSql} ${whereSql} ORDER BY f.rowid LIMIT 1 OFFSET ?`
  );

  const results = [];
  const pickedOffsets = new Set();
  for (let i = 0; i < limit && pickedOffsets.size < count; i++) {
    let offset = Math.floor(Math.random() * count); // NOSONAR: non-security random music selection
    // Collision avoidance — practically never triggers at library scale
    let attempts = 0;
    while (pickedOffsets.has(offset) && attempts < count) {
      offset = Math.floor(Math.random() * count); // NOSONAR: non-security random music selection
      attempts++;
    }
    if (pickedOffsets.has(offset)) break;
    pickedOffsets.add(offset);
    const row = rowStmt.get(...params, offset);
    if (row) results.push(mapFileRow(row));
  }
  return results;
}

export function getAlbumsByArtistId(artistId, vpaths, opts = {}) {
  const filtered = vpathFilter(vpaths, null);
  if (filtered.length === 0) return [];
  const vIn = inClause('vpath', filtered);
  const pf = prefixClause(opts.filepathPrefix);
  const rows = db.prepare(`
    SELECT DISTINCT album_id, artist_id, album, artist,
           MAX(year) AS year, MAX(aaFile) AS aaFile, COUNT(*) AS songCount,
           CAST(SUM(duration) AS INTEGER) AS totalDuration
    FROM files
    WHERE artist_id = ? AND ${vIn.sql}${pf.sql}
    GROUP BY album_id
    ORDER BY year DESC, album COLLATE NOCASE
  `).all(artistId, ...vIn.params, ...pf.params);
  return rows;
}

export function getAlbumStatsByIds(albumIds) {
  if (!albumIds || albumIds.length === 0) return {};
  const placeholders = albumIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT album_id, COUNT(*) AS songCount,
           CAST(SUM(duration) AS INTEGER) AS totalDuration
    FROM files
    WHERE album_id IN (${placeholders})
    GROUP BY album_id
  `).all(...albumIds);
  const map = {};
  for (const r of rows) map[r.album_id] = r;
  return map;
}

export function getAllAlbumIds(vpaths, opts = {}) {
  const filtered = vpathFilter(vpaths, null);
  if (filtered.length === 0) return [];
  const vIn = inClause('vpath', filtered);
  const pf = prefixClause(opts.filepathPrefix);
  const ep = excludePrefixClauses(opts.excludeFilepathPrefixes);
  const ip = includePrefixClauses(opts.includeFilepathPrefixes);
  const limit  = opts.limit  ?? -1;  // -1 = no limit in SQLite
  const offset = opts.offset ?? 0;
  const orderCol = opts.orderBy === 'artist' ? 'artist' : 'album';
  const rows = db.prepare(`
    SELECT DISTINCT album_id, artist_id, album, artist, MAX(album_artist) AS album_artist,
           MAX(year) AS year, MAX(aaFile) AS aaFile, COUNT(*) AS songCount,
           CAST(SUM(duration) AS INTEGER) AS totalDuration, MAX(ts) AS ts
    FROM files
    WHERE ${vIn.sql}${pf.sql}${ep.sql}${ip.sql} AND album IS NOT NULL AND TRIM(REPLACE(REPLACE(REPLACE(album, CHAR(9), ' '), CHAR(10), ' '), CHAR(13), ' ')) != ''
    GROUP BY album_id
    ORDER BY ${orderCol} COLLATE NOCASE
    LIMIT ? OFFSET ?
  `).all(...vIn.params, ...pf.params, ...ep.params, ...ip.params, limit, offset);
  return rows;
}

export function getAllArtistIds(vpaths, opts = {}) {
  const filtered = vpathFilter(vpaths, null);
  if (filtered.length === 0) return [];
  const vIn = inClause('vpath', filtered);
  const pf = prefixClause(opts.filepathPrefix);
  const ep = excludePrefixClauses(opts.excludeFilepathPrefixes);
  const limit  = opts.limit  ?? -1;
  const offset = opts.offset ?? 0;
  const rows = db.prepare(`
    SELECT DISTINCT artist_id, artist, MAX(aaFile) AS aaFile,
           COUNT(DISTINCT album_id) AS albumCount
    FROM files
    WHERE ${vIn.sql}${pf.sql}${ep.sql} AND artist IS NOT NULL AND TRIM(REPLACE(REPLACE(REPLACE(artist, CHAR(9), ' '), CHAR(10), ' '), CHAR(13), ' ')) != ''
    GROUP BY artist_id
    ORDER BY artist COLLATE NOCASE
    LIMIT ? OFFSET ?
  `).all(...vIn.params, ...pf.params, ...ep.params, limit, offset);
  return rows;
}

/**
 * Return the immediate children of a directory within a single vpath.
 * dirRelPath: path relative to vpath root, NO trailing slash.
 *   ""                  → list root of vpath
 *   "12 inches A-Z/A"  → list that sub-folder
 * Returns { dirs: string[], files: row[] }
 */
export function getDirectoryContents(vpath, dirRelPath, username) {
  if (!db) return { dirs: [], files: [] };

  const prefix = dirRelPath ? dirRelPath + '/' : '';
  const escaped = prefix.replaceAll(/[%_\\]/g, String.raw`\$&`);

  let dirRows, fileRows;

  if (prefix) {
    // Sub-directory names + one representative cover art per dir
    dirRows = db.prepare(String.raw`
      SELECT
        substr(filepath, length(?) + 1,
          instr(substr(filepath, length(?) + 1), '/') - 1
        ) AS subdir,
        MAX(aaFile) AS aaFile
      FROM files
      WHERE vpath = ?
        AND filepath LIKE ? ESCAPE '\'
        AND instr(substr(filepath, length(?) + 1), '/') > 0
      GROUP BY subdir
      ORDER BY subdir COLLATE NOCASE
    `).all(prefix, prefix, vpath, escaped + '%', prefix);

    fileRows = db.prepare(String.raw`
      SELECT f.*, um.rating, um.starred, um.lp AS lastPlayed, um.pc AS playCount
      FROM files f
      LEFT JOIN user_metadata um ON um.hash = f.hash AND um.user = ?
      WHERE f.vpath = ?
        AND f.filepath LIKE ? ESCAPE '\'
        AND instr(substr(f.filepath, length(?) + 1), '/') = 0
      ORDER BY f.track, f.title COLLATE NOCASE
    `).all(username || '', vpath, escaped + '%', prefix);
  } else {
    // Root of vpath: no LIKE filter needed
    dirRows = db.prepare(`
      SELECT
        substr(filepath, 1, instr(filepath, '/') - 1) AS subdir,
        MAX(aaFile) AS aaFile
      FROM files
      WHERE vpath = ?
        AND instr(filepath, '/') > 0
      GROUP BY subdir
      ORDER BY subdir COLLATE NOCASE
    `).all(vpath);

    fileRows = db.prepare(`
      SELECT f.*, um.rating, um.starred, um.lp AS lastPlayed, um.pc AS playCount
      FROM files f
      LEFT JOIN user_metadata um ON um.hash = f.hash AND um.user = ?
      WHERE f.vpath = ?
        AND instr(f.filepath, '/') = 0
      ORDER BY f.track, f.title COLLATE NOCASE
    `).all(username || '', vpath);
  }

  return {
    dirs: dirRows.map(r => r.subdir ? { name: r.subdir, aaFile: r.aaFile || null } : null).filter(Boolean),
    files: fileRows,
  };
}

// ── Radio Stations ────────────────────────────────────────────
export function getRadioStations(username) {
  return db.prepare('SELECT * FROM radio_stations WHERE user = ? ORDER BY sort_order, id').all(username);
}
export function createRadioStation(username, data) {
  const r = db.prepare(
    'INSERT INTO radio_stations (user, name, genre, country, link_a, link_b, link_c, img) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(username, data.name, data.genre || null, data.country || null, data.link_a || null, data.link_b || null, data.link_c || null, data.img || null);
  return r.lastInsertRowid;
}
export function updateRadioStation(id, username, data) {
  const r = db.prepare(
    'UPDATE radio_stations SET name=?, genre=?, country=?, link_a=?, link_b=?, link_c=?, img=? WHERE id=? AND user=?'
  ).run(data.name, data.genre || null, data.country || null, data.link_a || null, data.link_b || null, data.link_c || null, data.img || null, id, username);
  return r.changes > 0;
}
export function deleteRadioStation(id, username) {
  const r = db.prepare('DELETE FROM radio_stations WHERE id=? AND user=?').run(id, username);
  return r.changes > 0;
}
export function getRadioStationImgUsageCount(imgFilename) {
  return db.prepare('SELECT COUNT(*) AS cnt FROM radio_stations WHERE img=?').get(imgFilename)?.cnt ?? 0;
}
// ── Radio Schedules ──────────────────────────────────────────
export function getRadioSchedules(username) {
  return db.prepare('SELECT * FROM radio_schedules WHERE username=? ORDER BY created_at DESC').all(username);
}
export function createRadioSchedule(data) {
  db.prepare(
    'INSERT INTO radio_schedules (id,username,station_name,stream_url,art_file,vpath,start_time,start_date,duration_min,recurrence,recur_days,description,enabled,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?)'
  ).run(data.id, data.username, data.station_name, data.stream_url, data.art_file || null, data.vpath, data.start_time, data.start_date || null, data.duration_min, data.recurrence, data.recur_days || null, data.description || null, data.created_at);
  return data.id;
}
export function deleteRadioSchedule(id, username) {
  return db.prepare('DELETE FROM radio_schedules WHERE id=? AND username=?').run(id, username).changes > 0;
}
export function toggleRadioSchedule(id, username, enabled) {
  return db.prepare('UPDATE radio_schedules SET enabled=? WHERE id=? AND username=?').run(enabled, id, username).changes > 0;
}
export function toggleRadioScheduleById(id, enabled) {
  return db.prepare('UPDATE radio_schedules SET enabled=? WHERE id=?').run(enabled, id).changes > 0;
}
export function getAllEnabledRadioSchedules() {
  return db.prepare('SELECT * FROM radio_schedules WHERE enabled=1').all();
}

export function reorderRadioStations(username, orderedIds) {
  const update = db.prepare('UPDATE radio_stations SET sort_order=? WHERE id=? AND user=?');
  db.exec('BEGIN');
  try {
    orderedIds.forEach((id, idx) => update.run(idx, id, username));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// ── Podcast Feeds ─────────────────────────────────────────────
export function getPodcastFeeds(username) {
  return db.prepare(`
    SELECT f.*,
      (SELECT COUNT(*) FROM podcast_episodes e WHERE e.feed_id = f.id) AS episode_count,
      (SELECT MAX(e.pub_date) FROM podcast_episodes e WHERE e.feed_id = f.id AND e.pub_date IS NOT NULL) AS latest_pub_date
    FROM podcast_feeds f WHERE f.user = ? ORDER BY f.sort_order ASC, f.created_at DESC
  `).all(username);
}

export function reorderPodcastFeeds(username, orderedIds) {
  const update = db.prepare('UPDATE podcast_feeds SET sort_order=? WHERE id=? AND user=?');
  db.exec('BEGIN');
  try {
    orderedIds.forEach((id, idx) => update.run(idx, id, username));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function getPodcastFeed(id, username) {
  const row = db.prepare(`
    SELECT f.*,
      (SELECT COUNT(*) FROM podcast_episodes e WHERE e.feed_id = f.id) AS episode_count,
      (SELECT MAX(e.pub_date) FROM podcast_episodes e WHERE e.feed_id = f.id AND e.pub_date IS NOT NULL) AS latest_pub_date
    FROM podcast_feeds f WHERE f.id = ? AND f.user = ?
  `).get(id, username);
  return row || null;
}

export function createPodcastFeed(username, data) {
  const now = Math.floor(Date.now() / 1000);
  const r = db.prepare(
    'INSERT INTO podcast_feeds (user, url, title, description, img, author, language, last_fetched, created_at) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(username, data.url, data.title || null, data.description || null, data.img || null, data.author || null, data.language || null, data.last_fetched || now, now);
  return Number(r.lastInsertRowid);
}

export function deletePodcastFeed(id, username) {
  db.prepare('DELETE FROM podcast_episodes WHERE feed_id = ?').run(id);
  db.prepare('DELETE FROM podcast_feeds WHERE id = ? AND user = ?').run(id, username);
}

export function updatePodcastFeedFetched(id, username, ts) {
  db.prepare('UPDATE podcast_feeds SET last_fetched = ? WHERE id = ? AND user = ?').run(ts, id, username);
}
export function updatePodcastFeedTitle(id, username, title) {
  db.prepare('UPDATE podcast_feeds SET title = ? WHERE id = ? AND user = ?').run(title, id, username);
}
export function updatePodcastFeedImg(id, username, img) {
  db.prepare('UPDATE podcast_feeds SET img = ? WHERE id = ? AND user = ?').run(img, id, username);
}
export function updatePodcastFeedUrl(id, username, url) {
  db.prepare('UPDATE podcast_feeds SET url = ? WHERE id = ? AND user = ?').run(url, id, username);
}

export function getPodcastFeedImgUsageCount(img) {
  return db.prepare('SELECT COUNT(*) AS cnt FROM podcast_feeds WHERE img = ?').get(img)?.cnt ?? 0;
}

// ── Podcast Episodes ──────────────────────────────────────────
export function getPodcastEpisode(id) {
  return db.prepare('SELECT * FROM podcast_episodes WHERE id = ?').get(id);
}

export function getPodcastEpisodes(feedId) {
  return db.prepare(
    'SELECT * FROM podcast_episodes WHERE feed_id = ? ORDER BY pub_date DESC, id DESC'
  ).all(feedId);
}

export function upsertPodcastEpisodes(feedId, episodes) {
  const now = Math.floor(Date.now() / 1000);
  const stmt = db.prepare(`
    INSERT INTO podcast_episodes (feed_id, guid, title, description, audio_url, pub_date, duration_secs, img, created_at)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(feed_id, guid) DO UPDATE SET
      title=excluded.title, description=excluded.description,
      audio_url=excluded.audio_url, pub_date=excluded.pub_date,
      duration_secs=excluded.duration_secs, img=excluded.img
  `);
  db.exec('BEGIN');
  try {
    for (const ep of episodes) {
      stmt.run(feedId, ep.guid, ep.title || null, ep.description || null, ep.audio_url,
        ep.pub_date || null, ep.duration_secs || 0, ep.img || null, now);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

export function saveEpisodeProgress(episodeId, feedId, position, played) {
  db.prepare(
    'UPDATE podcast_episodes SET play_position = ?, played = ? WHERE id = ? AND feed_id = ?'
  ).run(position, played ? 1 : 0, episodeId, feedId);
}

// ── Smart Playlists ──────────────────────────────────────────────────────────

function _applyPlayedStatusFilter(sql, params, filters) {
  if (filters.playedStatus === 'never') {
    sql += ' AND (um.pc IS NULL OR um.pc = 0)';
  } else if (filters.playedStatus === 'played') {
    sql += ' AND um.pc > 0';
  } else if (filters.minPlayCount > 0) {
    sql += ' AND um.pc >= ?';
    params.push(Number(filters.minPlayCount));
  }
  return sql;
}

function _buildSmartPlaylistQuery(filters, vpaths, username, countOnly, ignoreVPaths, filepathPrefix) {
  const filtered = vpathFilter(vpaths, ignoreVPaths || null);
  if (filtered.length === 0) return null;
  const vIn = inClause('f.vpath', filtered);
  const params = [username, ...vIn.params];
  let whereSql = `WHERE ${vIn.sql}`;

  if (filepathPrefix && typeof filepathPrefix === 'string') {
    whereSql += String.raw` AND f.filepath LIKE ? ESCAPE '\'`;
    params.push(filepathPrefix.replaceAll(/[%_\\]/g, String.raw`\$&`) + '%');
  }

  if (filters.genres && filters.genres.length > 0) {
    const gIn = inClause('f.genre', filters.genres);
    whereSql += ` AND ${gIn.sql}`;
    params.push(...gIn.params);
  }
  if (filters.yearFrom) { whereSql += ' AND f.year >= ?'; params.push(Number(filters.yearFrom)); }
  if (filters.yearTo)   { whereSql += ' AND f.year <= ?'; params.push(Number(filters.yearTo)); }
  if (filters.minRating > 0) {
    whereSql += ' AND COALESCE(um.rating,0) >= ?';
    params.push(Number(filters.minRating));
  }
  whereSql = _applyPlayedStatusFilter(whereSql, params, filters);
  if (filters.starred) { whereSql += ' AND um.starred = 1'; }
  if (filters.artistSearch?.trim()) {
    whereSql += ' AND f.artist LIKE ? COLLATE NOCASE';
    params.push(`%${filters.artistSearch.trim()}%`);
  }

  const joinSql = 'FROM files f LEFT JOIN user_metadata um ON f.hash = um.hash AND um.user = ?';
  return { joinSql, whereSql, params };
}

const _SORT_MAP = {
  artist:      'f.artist COLLATE NOCASE, f.album COLLATE NOCASE, COALESCE(f.disk,0), COALESCE(f.track,0)',
  album:       'f.album COLLATE NOCASE, COALESCE(f.disk,0), COALESCE(f.track,0)',
  year_asc:    'f.year ASC, f.artist COLLATE NOCASE',
  year_desc:   'f.year DESC, f.artist COLLATE NOCASE',
  rating:      'COALESCE(um.rating,0) DESC, f.artist COLLATE NOCASE',
  play_count:  'COALESCE(um.pc,0) DESC, f.artist COLLATE NOCASE',
  last_played: 'um.lp DESC, f.artist COLLATE NOCASE',
  random:      'RANDOM()',
};

export function runSmartPlaylist(filters, sort, limitN, vpaths, username, ignoreVPaths, filepathPrefix) {
  const q = _buildSmartPlaylistQuery(filters, vpaths, username, false, ignoreVPaths, filepathPrefix);
  if (!q) return [];
  const orderSql = 'ORDER BY ' + (_SORT_MAP[sort] || _SORT_MAP.artist);
  const limit = Math.min(Number(limitN) || 100, 1000);
  const rows = db.prepare(
    `SELECT f.rowid AS id, f.*, COALESCE(um.rating,0) AS rating, COALESCE(um.starred,0) AS starred, um.lp AS lastPlayed, COALESCE(um.pc,0) AS playCount ` +
    `${q.joinSql} ${q.whereSql} ${orderSql} LIMIT ?`
  ).all(...q.params, limit);
  return rows.map(mapFileRow);
}

export function countSmartPlaylist(filters, vpaths, username, ignoreVPaths, filepathPrefix) {
  const q = _buildSmartPlaylistQuery(filters, vpaths, username, true, ignoreVPaths, filepathPrefix);
  if (!q) return 0;
  return db.prepare(`SELECT COUNT(*) AS n ${q.joinSql} ${q.whereSql}`).get(...q.params).n;
}

export function getSmartPlaylists(username) {
  return db.prepare('SELECT * FROM smart_playlists WHERE user = ? ORDER BY name COLLATE NOCASE').all(username)
    .map(r => ({ ...r, filters: JSON.parse(r.filters) }));
}

export function getSmartPlaylist(id, username) {
  const r = db.prepare('SELECT * FROM smart_playlists WHERE id = ? AND user = ?').get(id, username);
  if (!r) return null;
  return { ...r, filters: JSON.parse(r.filters) };
}

export function saveSmartPlaylist(username, name, filters, sort, limitN) {
  const result = db.prepare(
    'INSERT INTO smart_playlists (user, name, filters, sort, limit_n, created) VALUES (?,?,?,?,?,?)'
  ).run(username, name, JSON.stringify(filters), sort, limitN, Math.floor(Date.now() / 1000));
  return result.lastInsertRowid;
}

export function updateSmartPlaylist(id, username, data) {
  const existing = db.prepare('SELECT id FROM smart_playlists WHERE id = ? AND user = ?').get(id, username);
  if (!existing) return false;
  db.prepare('UPDATE smart_playlists SET name = ?, filters = ?, sort = ?, limit_n = ? WHERE id = ? AND user = ?')
    .run(data.name, JSON.stringify(data.filters), data.sort, data.limit_n, id, username);
  return true;
}

export function deleteSmartPlaylist(id, username) {
  const result = db.prepare('DELETE FROM smart_playlists WHERE id = ? AND user = ?').run(id, username);
  return result.changes > 0;
}

// ── Genre Groups (admin-configured display groupings) ─────────────────────
export function getGenreGroups() {
  const row = db.prepare('SELECT groups FROM genre_groups WHERE id = 1').get();
  if (!row) return [];
  try { return JSON.parse(row.groups); } catch { return []; }
}

export function saveGenreGroups(groups) {
  db.prepare('INSERT INTO genre_groups(id, groups) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET groups=excluded.groups')
    .run(JSON.stringify(groups));
}

// ── Wrapped / Play Events ─────────────────────────────────────────────────

export function insertPlayEvent({ user_id, file_hash, started_at, duration_ms, source, session_id }) {
  const result = db.prepare(
    'INSERT INTO play_events (user_id, file_hash, started_at, duration_ms, source, session_id) VALUES (?,?,?,?,?,?)'
  ).run(user_id, file_hash, started_at, duration_ms ?? null, source ?? null, session_id ?? null);
  return Number(result.lastInsertRowid);
}

// Deduplication for page-reload resume: find the most recent play event for
// this user+hash within windowMs. Returns { id, completed } or null.
// Caller decides: if completed=0 → it's an interrupted (reload) play, reuse it.
//                 if completed=1 → user genuinely replayed after finishing, allow new row.
export function findRecentPlayEvent(userId, fileHash, windowMs) {
  const row = db.prepare(
    'SELECT id, completed FROM play_events WHERE user_id=? AND file_hash=? AND started_at >= ? ORDER BY started_at DESC LIMIT 1'
  ).get(userId, fileHash, Date.now() - windowMs);
  return row ? { id: Number(row.id), completed: row.completed === 1 } : null;
}

export function getPlayEventById(id, userId) {
  return db.prepare('SELECT id, user_id, duration_ms FROM play_events WHERE id=? AND user_id=?').get(id, userId) ?? null;
}

export function hasPlayEventBefore(userId, fileHash, beforeMs) {
  const row = db.prepare('SELECT 1 AS found FROM play_events WHERE user_id=? AND file_hash=? AND started_at < ? LIMIT 1').get(userId, fileHash, beforeMs);
  return !!row;
}

export function updatePlayEvent(id, userId, { ended_at, played_ms, completed, skipped }) {
  db.prepare(
    'UPDATE play_events SET ended_at=?, played_ms=?, completed=?, skipped=? WHERE id=? AND user_id=?'
  ).run(ended_at ?? Date.now(), played_ms ?? null, completed ? 1 : 0, skipped ? 1 : 0, id, userId);
}

export function incrementPauseCount(id, userId) {
  db.prepare('UPDATE play_events SET pause_count = pause_count + 1 WHERE id = ? AND user_id = ?').run(id, userId);
}

export function upsertListeningSession({ session_id, user_id, started_at }) {
  db.prepare(
    `INSERT INTO listening_sessions (session_id, user_id, started_at, total_tracks)
     VALUES (?,?,?,1)
     ON CONFLICT(session_id) DO UPDATE SET total_tracks = total_tracks + 1`
  ).run(session_id, user_id, started_at);
}

export function updateListeningSession(sessionId, userId, { ended_at }) {
  db.prepare(
    'UPDATE listening_sessions SET ended_at=? WHERE session_id=? AND user_id=?'
  ).run(ended_at ?? Date.now(), sessionId, userId);
}

export function getHistoryEvents(userId, fromMs, toMs = null) {
  if (toMs != null) {
    return db.prepare(`
    SELECT
      pe.id, pe.started_at, pe.played_ms, pe.skipped, pe.completed,
      f.title, f.artist, f.album, f.aaFile, f.filepath, f.vpath
    FROM play_events pe
    LEFT JOIN (SELECT hash, title, artist, album, aaFile, filepath, vpath FROM files GROUP BY hash) f
      ON f.hash = pe.file_hash
    WHERE pe.user_id = ? AND pe.started_at >= ? AND pe.started_at < ?
    ORDER BY pe.started_at DESC
  `).all(userId, fromMs, toMs);
  }
  return db.prepare(`
    SELECT
      pe.id, pe.started_at, pe.played_ms, pe.skipped, pe.completed,
      f.title, f.artist, f.album, f.aaFile, f.filepath, f.vpath
    FROM play_events pe
    LEFT JOIN (SELECT hash, title, artist, album, aaFile, filepath, vpath FROM files GROUP BY hash) f
      ON f.hash = pe.file_hash
    WHERE pe.user_id = ? AND pe.started_at >= ?
    ORDER BY pe.started_at DESC
  `).all(userId, fromMs);
}

export function getWrappedPeriods(userId) {
  // Returns distinct year-month buckets that have play_events for this user
  // (most recent first, max 36 months back)
  return db.prepare(`
    SELECT
      strftime('%Y', datetime(started_at/1000,'unixepoch','localtime')) AS year,
      strftime('%m', datetime(started_at/1000,'unixepoch','localtime')) AS month,
      COUNT(*) AS play_count
    FROM play_events
    WHERE user_id = ?
    GROUP BY year, month
    ORDER BY year DESC, month DESC
    LIMIT 36
  `).all(userId);
}

export function getWrappedDataInRange(userId, fromMs, toMs) {
  // Returns all play_events in range joined to file metadata
  // Used by wrapped-stats.mjs for aggregation
  return db.prepare(`
    SELECT
      pe.id, pe.file_hash, pe.started_at, pe.ended_at,
      pe.duration_ms, pe.played_ms, pe.completed, pe.skipped,
      pe.source, pe.session_id, pe.pause_count,
      f.title, f.artist, f.album, f.year, f.genre,
      f.aaFile, f.artist_id, f.album_id, f.filepath
    FROM play_events pe
    LEFT JOIN (SELECT hash, title, artist, album, year, genre, aaFile, artist_id, album_id, filepath FROM files GROUP BY hash) f ON f.hash = pe.file_hash
    WHERE pe.user_id = ? AND pe.started_at >= ? AND pe.started_at < ?
    ORDER BY pe.started_at ASC
  `).all(userId, fromMs, toMs);
}

export function getWrappedSessionsInRange(userId, fromMs, toMs) {
  return db.prepare(`
    SELECT session_id, started_at, ended_at, total_tracks
    FROM listening_sessions
    WHERE user_id = ? AND started_at >= ? AND started_at < ?
    ORDER BY started_at ASC
  `).all(userId, fromMs, toMs);
}

export function getTotalFileCount(vpaths) {
  if (!vpaths || vpaths.length === 0) return 0;
  const placeholders = vpaths.map(() => '?').join(',');
  return db.prepare(`SELECT COUNT(*) AS cnt FROM files WHERE vpath IN (${placeholders})`).get(...vpaths).cnt;
}

export function getWrappedAdminStats() {
  const total = db.prepare('SELECT COUNT(*) AS cnt FROM play_events').get().cnt;
  const totalRadio = db.prepare('SELECT COUNT(*) AS cnt FROM radio_play_events').get().cnt;
  const totalPodcast = db.prepare('SELECT COUNT(*) AS cnt FROM podcast_play_events').get().cnt;
  // Storage estimate via dbstat virtual table (available in SQLite 3.31+)
  let storageBytes = 0;
  try {
    const row = db.prepare("SELECT SUM(payload) AS sz FROM dbstat WHERE name IN ('play_events','listening_sessions','radio_play_events','podcast_play_events')").get();
    storageBytes = row?.sz ?? 0;
  } catch (e) { console.debug('[velvet]', e?.message ?? e); }
  const perUser = db.prepare(`
    SELECT
      COALESCE(pe.user_id, re.user_id, pod.user_id) AS user_id,
      COALESCE(pe.event_count, 0)         AS event_count,
      COALESCE(pe.total_played_ms, 0)     AS total_played_ms,
      COALESCE(re.radio_sessions, 0)      AS radio_sessions,
      COALESCE(re.total_radio_ms, 0)      AS total_radio_ms,
      COALESCE(pod.podcast_episodes, 0)   AS podcast_episodes,
      COALESCE(pod.total_podcast_ms, 0)   AS total_podcast_ms
    FROM
      (SELECT user_id, COUNT(*) AS event_count, SUM(COALESCE(played_ms,0)) AS total_played_ms
       FROM play_events GROUP BY user_id) pe
    FULL OUTER JOIN
      (SELECT user_id, COUNT(*) AS radio_sessions, SUM(COALESCE(listened_ms,0)) AS total_radio_ms
       FROM radio_play_events GROUP BY user_id) re ON pe.user_id = re.user_id
    FULL OUTER JOIN
      (SELECT user_id, COUNT(*) AS podcast_episodes, SUM(COALESCE(played_ms,0)) AS total_podcast_ms
       FROM podcast_play_events GROUP BY user_id) pod ON COALESCE(pe.user_id, re.user_id) = pod.user_id
    ORDER BY event_count DESC
  `).all();
  return { total_events: total, total_radio: totalRadio, total_podcast: totalPodcast, storage_bytes: storageBytes, per_user: perUser };
}

export function purgePlayEvents(userId, fromMs, toMs) {
  // Delete events for a specific user within the [fromMs, toMs] time window (inclusive)
  const evRes = db.prepare('DELETE FROM play_events WHERE user_id = ? AND started_at >= ? AND started_at <= ?').run(userId, fromMs, toMs);
  // Prune sessions that have no remaining events
  db.prepare(`
    DELETE FROM listening_sessions
    WHERE user_id = ? AND session_id NOT IN (
      SELECT DISTINCT session_id FROM play_events WHERE session_id IS NOT NULL
    )
  `).run(userId);
  // Also purge radio and podcast events for the same user/period
  db.prepare('DELETE FROM radio_play_events WHERE user_id = ? AND started_at >= ? AND started_at <= ?').run(userId, fromMs, toMs);
  db.prepare('DELETE FROM podcast_play_events WHERE user_id = ? AND started_at >= ? AND started_at <= ?').run(userId, fromMs, toMs);
  return evRes.changes;
}

function _deriveArtist(filepath) {
  const parts = filepath.split('/');
  const folder = parts.length >= 2 ? parts[parts.length - 2] : null;
  if (!folder) return null;
  const m = folder.match(/^(.+?)\s+[-\u2013]\s+/);
  return m ? m[1].trim() : null;
}
function _deriveAlbum(filepath) {
  const parts = filepath.split('/');
  const folder = parts.length >= 2 ? parts[parts.length - 2] : null;
  if (!folder) return folder;
  return folder.replace(/\s*[-\u2013]\s*(SP\d[\d-]*|[A-Z]{2,}-\d[\w-]*|-cd-|-\d+)[^/]*$/i, '').trim();
}
function _deriveTitle(filepath) {
  const base = filepath.split('/').pop().replace(/\.[^.]+$/, '');
  return base.replace(/^[\d\s._-]+/, '').trim() || base;
}

/**
 * Preview folder-name metadata derivation without writing anything.
 * Returns { total, canDerive, skipped, examples[] } where examples
 * are up to 8 files that would actually be updated.
 */
export function previewFolderMetadata() {

  const rows = db.prepare(
    "SELECT rowid, filepath, artist, album, title FROM files WHERE (artist IS NULL OR artist = '') AND filepath IS NOT NULL"
  ).all();

  const total = rows.length;
  let canDerive = 0;
  const examples = [];
  for (const row of rows) {
    const artist = _deriveArtist(row.filepath);
    if (!artist) continue;
    canDerive++;
    if (examples.length < 8) {
      examples.push({
        filepath:      row.filepath,
        artist,
        album:  row.album  || _deriveAlbum(row.filepath),
        title:  row.title  || _deriveTitle(row.filepath),
      });
    }
  }
  return { total, canDerive, skipped: total - canDerive, examples };
}

/**
 * Backfill artist / album / title for files whose tags are null.
 * Derives values from the folder name pattern "Artist - Release info".
 * Returns the number of rows updated.
 */
export function backfillFolderMetadata() {
  const rows = db.prepare(
    "SELECT rowid, filepath, artist, album, title FROM files WHERE (artist IS NULL OR artist = '') AND filepath IS NOT NULL"
  ).all();

  const _md5 = s => createHash('md5').update((s || '').toLowerCase().trim()).digest('hex'); // NOSONAR: MD5 used as DB identity key, not for security

  const upd = db.prepare(
    'UPDATE files SET artist=?, album=?, title=?, artist_id=?, album_id=? WHERE rowid=?'
  );

  let updated = 0;
  try { db.exec('BEGIN'); } catch (e) { console.debug('[velvet]', e?.message ?? e); }
  try {
    for (const row of rows) {
      const artist = _deriveArtist(row.filepath);
      if (!artist) continue; // can't derive — skip
      const album  = row.album  || _deriveAlbum(row.filepath);
      const title  = row.title  || _deriveTitle(row.filepath);
      const aid = _md5(artist).slice(0, 16);
      const alid = _md5(`${artist}|||${album || ''}`).slice(0, 16);
      upd.run(artist, album, title, aid, alid, row.rowid);
      updated++;
    }
    try { db.exec('COMMIT'); } catch (e) { console.debug('[velvet]', e?.message ?? e); }
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (e) { console.debug('[velvet]', e?.message ?? e); }
    throw e;
  }
  return updated;
}

// ── Radio Play Events ─────────────────────────────────────────────────────────

export function insertRadioPlayEvent({ user_id, station_id, station_name, started_at, session_id }) {
  const result = db.prepare(
    'INSERT INTO radio_play_events (user_id, station_id, station_name, started_at, session_id) VALUES (?,?,?,?,?)'
  ).run(user_id, station_id ?? null, station_name, started_at, session_id ?? null);
  return Number(result.lastInsertRowid);
}

export function updateRadioPlayEvent(id, userId, { ended_at, listened_ms }) {
  db.prepare(
    'UPDATE radio_play_events SET ended_at=?, listened_ms=? WHERE id=? AND user_id=?'
  ).run(ended_at ?? Date.now(), listened_ms ?? 0, id, userId);
}

export function getRadioStatsInRange(userId, fromMs, toMs) {
  return db.prepare(`
    SELECT station_name, station_id,
           COUNT(*) AS sessions,
           SUM(listened_ms) AS total_ms
    FROM radio_play_events
    WHERE user_id = ? AND started_at >= ? AND started_at < ?
    GROUP BY station_name
    ORDER BY total_ms DESC
  `).all(userId, fromMs, toMs);
}

// ── Podcast Play Events ───────────────────────────────────────────────────────

export function insertPodcastPlayEvent({ user_id, episode_id, feed_id, started_at, session_id }) {
  const result = db.prepare(
    'INSERT INTO podcast_play_events (user_id, episode_id, feed_id, started_at, session_id) VALUES (?,?,?,?,?)'
  ).run(user_id, episode_id, feed_id, started_at, session_id ?? null);
  return Number(result.lastInsertRowid);
}

export function updatePodcastPlayEvent(id, userId, { ended_at, played_ms, completed }) {
  db.prepare(
    'UPDATE podcast_play_events SET ended_at=?, played_ms=?, completed=? WHERE id=? AND user_id=?'
  ).run(ended_at ?? Date.now(), played_ms ?? 0, completed ? 1 : 0, id, userId);
}

export function getPodcastStatsInRange(userId, fromMs, toMs) {
  return db.prepare(`
    SELECT ppe.feed_id,
           pf.title AS feed_title,
           pf.img   AS feed_img,
           COUNT(*) AS episodes_played,
           SUM(ppe.played_ms) AS total_ms,
           SUM(ppe.completed) AS completed_count
    FROM podcast_play_events ppe
    LEFT JOIN podcast_feeds pf ON pf.id = ppe.feed_id AND pf.user = ppe.user_id
    WHERE ppe.user_id = ? AND ppe.started_at >= ? AND ppe.started_at < ?
    GROUP BY ppe.feed_id
    ORDER BY total_ms DESC
  `).all(userId, fromMs, toMs);
}

// ── AcoustID Fingerprinting ───────────────────────────────────────────────────

/**
 * Returns a batch of up to `limit` files that need fingerprinting:
 *  - acoustid_status IS NULL (never attempted)
 *  - OR status='error' with a timestamp older than retryAfterSec seconds
 * Ordered oldest-indexed-first so newly scanned songs complete roughly in
 * library order rather than most-recently-added order.
 */
export function getAcoustidQueue(limit, retryAfterSec) {
  const cutoff = Math.floor(Date.now() / 1000) - retryAfterSec;
  return db.prepare(`
    SELECT filepath, vpath, duration
    FROM files
    WHERE format IS NOT NULL
      AND (
        acoustid_status IS NULL
        OR (acoustid_status = 'error' AND (acoustid_ts IS NULL OR acoustid_ts < ?))
      )
    ORDER BY ts ASC
    LIMIT ?
  `).all(cutoff, limit);
}

/** Mark a file as pending (in-progress) so a restart doesn't double-process it. */
export function setAcoustidPending(filepath, vpath) {
  db.prepare(
    `UPDATE files SET acoustid_status = 'pending', acoustid_ts = ? WHERE filepath = ? AND vpath = ?`
  ).run(Math.floor(Date.now() / 1000), filepath, vpath);
}

/** Persist the result of a successful AcoustID lookup. */
export function setAcoustidResult(filepath, vpath, { acoustid_id, mbid, score, status }) {
  db.prepare(
    `UPDATE files SET acoustid_id = ?, mbid = ?, acoustid_score = ?, acoustid_status = ?, acoustid_ts = ?
     WHERE filepath = ? AND vpath = ?`
  ).run(acoustid_id ?? null, mbid ?? null, score ?? null, status, Math.floor(Date.now() / 1000), filepath, vpath);
}

// ── ReplayGain worker DB helpers ──────────────────────────────────────────────

/**
 * Return a snapshot of ReplayGain measurement progress.
 * Called by the status endpoint and by the auto-start check.
 */
export function getRgStatus() {
  return db.prepare(`
    SELECT
      COUNT(*)                                                                                              AS total,
      COUNT(CASE WHEN rg_measured_ts > 0 THEN 1 END)                                                      AS measured,
      COUNT(CASE WHEN rg_measured_ts IS NULL THEN 1 END)                                                   AS queued,
      COUNT(CASE WHEN rg_measured_ts = -1 THEN 1 END)                                                     AS failed,
      COUNT(CASE WHEN rg_measured_ts = -2 THEN 1 END)                                                     AS shelved,
      COUNT(CASE WHEN rg_tag_track_gain IS NOT NULL OR rg_tag_album_gain IS NOT NULL
                   OR r128_track_gain_db IS NOT NULL THEN 1 END)                                           AS has_tags,
      COUNT(CASE WHEN rg_measurement_tool = 'rsgain'  AND rg_measured_ts > 0 THEN 1 END)                  AS measured_rsgain,
      COUNT(CASE WHEN rg_measurement_tool = 'ffmpeg'  AND rg_measured_ts > 0 THEN 1 END)                  AS measured_ffmpeg
    FROM files WHERE format IS NOT NULL
  `).get();
}

/**
 * Reset all failed rows (rg_measured_ts = -1) so they are retried on the next
 * worker pass.  Returns the number of rows affected.
 */
export function resetRgFailed() {
  const info = db.prepare(`
    UPDATE files SET rg_measured_ts = NULL, rg_measurement_tool = NULL
    WHERE rg_measured_ts = -1
  `).run();
  return info.changes;
}

/**
 * Returns all failed rows (rg_measured_ts = -1) with enough info for the API
 * to do a file-system existence check before resetting or purging.
 */
export function getRgFailedRows() {
  return db.prepare(`
    SELECT rowid AS id, filepath, vpath, rg_measurement_tool AS reason
    FROM files
    WHERE rg_measured_ts = -1
  `).all();
}

/**
 * Returns all failed rows with detail (duration, bitrate, error message) for
 * the admin UI failed-files modal.  Ordered by duration DESC so large files
 * appear first.
 */
export function getRgFailedDetail() {
  return db.prepare(`
    SELECT rowid AS id, filepath, vpath, rg_measurement_tool AS reason,
           rg_measurement_error AS error, duration, bitrate
    FROM files
    WHERE rg_measured_ts = -1
    ORDER BY duration DESC NULLS LAST
  `).all();
}

/**
 * Shelve rows (rg_measured_ts = -2): they stay in the library but are
 * permanently excluded from RG analysis until explicitly unshelved.
 * Only transitions from -1 (failed) → -2.
 */
export function shelveRgRows(ids) {
  if (!ids.length) return 0;
  const stmt = db.prepare(`
    UPDATE files SET rg_measured_ts = -2
    WHERE rowid = ? AND rg_measured_ts = -1
  `);
  db.exec('BEGIN');
  try {
    let count = 0;
    for (const id of ids) { const r = stmt.run(id); count += r.changes; }
    db.exec('COMMIT');
    return count;
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

/**
 * Unshelve rows (rg_measured_ts = -2 → NULL): re-queues them for analysis.
 */
export function unshelveRgRows(ids) {
  if (!ids.length) return 0;
  const stmt = db.prepare(`
    UPDATE files SET rg_measured_ts = NULL, rg_measurement_tool = NULL,
                     rg_measurement_error = NULL
    WHERE rowid = ? AND rg_measured_ts = -2
  `);
  db.exec('BEGIN');
  try {
    let count = 0;
    for (const id of ids) { const r = stmt.run(id); count += r.changes; }
    db.exec('COMMIT');
    return count;
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

/**
 * Delete rows from `files` by rowid array.  Used to purge orphaned entries
 * whose physical file no longer exists.  Returns the number deleted.
 */
export function purgeRgRowsByIds(ids) {
  if (!ids.length) return 0;
  const stmt = db.prepare(`DELETE FROM files WHERE rowid = ?`);
  db.exec('BEGIN');
  try {
    for (const id of ids) stmt.run(id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return ids.length;
}

/**
 * Reset specific rows (by rowid) from failed to queued (NULL) so they are
 * retried.  Returns the number reset.
 */
export function resetRgFailedByIds(ids) {
  if (!ids.length) return 0;
  const stmt = db.prepare(`
    UPDATE files SET rg_measured_ts = NULL, rg_measurement_tool = NULL
    WHERE rowid = ? AND rg_measured_ts = -1
  `);
  db.exec('BEGIN');
  try {
    for (const id of ids) stmt.run(id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return ids.length;
}

/**
 * Reset ALL measurement data so the entire library is re-measured from scratch.
 * Before clearing, snapshots all currently-measured rows into `rg_backup` so
 * the operation can be undone via undoRgAll().
 * Should only be called when the worker is stopped.
 * Returns { reset, backedUp }.
 */
export function resetRgAll() {
  db.exec('BEGIN');
  try {
    db.prepare(`DELETE FROM rg_backup`).run();
    const bkp = db.prepare(`
      INSERT INTO rg_backup
        (file_rowid, rg_measured_ts, rg_measurement_tool,
         rg_integrated_lufs, rg_true_peak_dbfs, rg_track_gain_db, rg_lra,
         rg_album_gain_db, rg_album_peak_dbfs, reset_ts)
      SELECT rowid, rg_measured_ts, rg_measurement_tool,
         rg_integrated_lufs, rg_true_peak_dbfs, rg_track_gain_db, rg_lra,
         rg_album_gain_db, rg_album_peak_dbfs, unixepoch()
      FROM files
      WHERE format IS NOT NULL AND rg_measured_ts IS NOT NULL AND rg_measured_ts != -2
    `).run();
    const clr = db.prepare(`
      UPDATE files SET
        rg_measured_ts      = NULL,
        rg_measurement_tool = NULL,
        rg_integrated_lufs  = NULL,
        rg_true_peak_dbfs   = NULL,
        rg_track_gain_db    = NULL,
        rg_lra              = NULL,
        rg_album_gain_db    = NULL,
        rg_album_peak_dbfs  = NULL
      WHERE format IS NOT NULL AND rg_measured_ts != -2
    `).run();
    db.exec('COMMIT');
    return { reset: clr.changes, backedUp: bkp.changes };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/**
 * Restore measurements from the backup saved by the last resetRgAll() call.
 * Clears the backup table afterwards (one-shot undo).
 * Returns the number of rows restored.
 */
export function undoRgAll() {
  db.exec('BEGIN');
  try {
    const info = db.prepare(`
      UPDATE files
      SET
        rg_measured_ts      = b.rg_measured_ts,
        rg_measurement_tool = b.rg_measurement_tool,
        rg_integrated_lufs  = b.rg_integrated_lufs,
        rg_true_peak_dbfs   = b.rg_true_peak_dbfs,
        rg_track_gain_db    = b.rg_track_gain_db,
        rg_lra              = b.rg_lra,
        rg_album_gain_db    = b.rg_album_gain_db,
        rg_album_peak_dbfs  = b.rg_album_peak_dbfs
      FROM rg_backup AS b
      WHERE files.rowid = b.file_rowid
    `).run();
    db.prepare(`DELETE FROM rg_backup`).run();
    db.exec('COMMIT');
    return info.changes;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/**
 * Returns { count, resetAt } from rg_backup, or { count: 0, resetAt: null }
 * when no backup exists.  Used by the status endpoint to advertise undo availability.
 */
export function getRgUndoInfo() {
  const row = db.prepare(`SELECT COUNT(*) AS count, MIN(reset_ts) AS reset_ts FROM rg_backup`).get();
  return { count: row.count || 0, resetAt: row.reset_ts || null };
}

/**
 * Discard the undo backup (called when the measurement worker starts a new pass,
 * committing the user to re-measurement).
 */
export function clearRgBackup() {
  db.prepare(`DELETE FROM rg_backup`).run();
}

/** Reset any 'pending' rows back to NULL so they are retried on next worker start. */
export function resetAcoustidPending() {
  db.prepare(`UPDATE files SET acoustid_status = NULL WHERE acoustid_status = 'pending'`).run();
}

/** Reset all 'error' rows back to NULL so they are retried immediately on the next worker pass. */
export function resetAcoustidErrors() {
  const info = db.prepare(`UPDATE files SET acoustid_status = NULL, acoustid_ts = NULL WHERE acoustid_status = 'error'`).run();
  return info.changes;
}

/** Reset all 'not_found' rows back to NULL so they are retried. */
export function resetNotFoundForAcoustid() {
  const info = db.prepare(
    `UPDATE files SET acoustid_status = NULL, acoustid_ts = NULL WHERE acoustid_status = 'not_found'`
  ).run();
  return info.changes;
}

/** Re-queue specific files for AcoustID fingerprinting.
 *  Clears not_found/error status so they are retried even if previously failed. */
export function resetFilesForAcoustid(files) {
  const stmt = db.prepare(
    `UPDATE files SET acoustid_status = NULL, acoustid_ts = NULL
     WHERE filepath = ? AND vpath = ? AND format IS NOT NULL`
  );
  let count = 0;
  db.exec('BEGIN');
  try {
    for (const f of files) {
      const r = stmt.run(f.filepath, f.vpath);
      count += r.changes;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return count;
}

/** Return aggregate fingerprinting statistics for the admin UI. */
export function getAcoustidStats() {
  return db.prepare(`
    SELECT
      COUNT(*) AS total,
      COUNT(CASE WHEN acoustid_status = 'found'     THEN 1 END) AS found,
      COUNT(CASE WHEN acoustid_status = 'not_found' THEN 1 END) AS not_found,
      COUNT(CASE WHEN acoustid_status = 'error'     THEN 1 END) AS errors,
      COUNT(CASE WHEN acoustid_status = 'pending'   THEN 1 END) AS pending,
      COUNT(CASE WHEN acoustid_status IS NULL        THEN 1 END) AS queued
    FROM files
    WHERE format IS NOT NULL
  `).get();
}

// ── Tag Workshop — MB Enrichment ──────────────────────────────────────────────

/** Fetch next batch of files awaiting MusicBrainz enrichment. */
export function getMbEnrichQueue(limit) {
  return db.prepare(`
    SELECT filepath, vpath, mbid, title, artist, album, year, track
    FROM files
    WHERE mbid IS NOT NULL
      AND mb_enrichment_status IS NULL
      AND acoustid_status = 'found'
    LIMIT ?
  `).all(limit);
}

/** Mark a row as pending for MB enrichment. */
export function setMbEnrichPending(filepath, vpath) {
  db.prepare(
    `UPDATE files SET mb_enrichment_status = 'pending', mb_enriched_ts = ? WHERE filepath = ? AND vpath = ?`
  ).run(Math.floor(Date.now() / 1000), filepath, vpath);
}

/** Persist the result of a MusicBrainz recording lookup. */
export function setMbEnrichResult(filepath, vpath, data) {
  db.prepare(`
    UPDATE files
    SET mb_album = ?, mb_year = ?, mb_track = ?, mb_release_id = ?,
        mb_enrichment_status = ?, mb_enriched_ts = ?, tag_status = ?
    WHERE filepath = ? AND vpath = ?
  `).run(
    data.mb_album ?? null, data.mb_year ?? null, data.mb_track ?? null, data.mb_release_id ?? null,
    data.status, Math.floor(Date.now() / 1000), data.tag_status ?? null,
    filepath, vpath
  );
}

/** Reset any rows stuck in 'pending' back to NULL so they are retried on next worker start. */
export function resetMbEnrichPending() {
  db.prepare(`UPDATE files SET mb_enrichment_status = NULL WHERE mb_enrichment_status = 'pending'`).run();
}

/** Aggregate MB enrichment statistics for the admin UI. */
export function getMbEnrichStats() {
  return db.prepare(`
    SELECT
      COUNT(CASE WHEN mbid IS NOT NULL AND (acoustid_status = 'found' OR mb_text_search_status = 'found') THEN 1 END) AS total,
      COUNT(CASE WHEN mb_enrichment_status = 'done'    THEN 1 END) AS done,
      COUNT(CASE WHEN mb_enrichment_status = 'error'   THEN 1 END) AS errors,
      COUNT(CASE WHEN mb_enrichment_status = 'no_data' THEN 1 END) AS no_data,
      COUNT(CASE WHEN mb_enrichment_status IS NULL AND mbid IS NOT NULL AND (acoustid_status = 'found' OR mb_text_search_status = 'found') THEN 1 END) AS queued,
      COUNT(CASE WHEN acoustid_status IS NOT NULL THEN 1 END) AS acoustid_attempted,
      COUNT(CASE WHEN acoustid_status = 'found' THEN 1 END) AS acoustid_found
    FROM files
  `).get();
}

/** Files that failed MB enrichment — filepath + mbid + error reason for diagnosis. */
export function getMbEnrichErrors(limit = 200) {
  return db.prepare(`
    SELECT filepath, vpath, mbid, mb_enriched_ts, mb_enrichment_error
    FROM files
    WHERE mb_enrichment_status = 'error' AND mbid IS NOT NULL
    ORDER BY mb_enriched_ts DESC
    LIMIT ?
  `).all(limit);
}

/** Reset all error rows back to NULL so they are retried on next worker run. */
export function retryMbEnrichErrors() {
  const r = db.prepare(`
    UPDATE files SET mb_enrichment_status = NULL, mb_enrichment_error = NULL
    WHERE mb_enrichment_status = 'error'
  `).run();
  return { reset: r.changes };
}

/** Aggregate stats for the MB text-search fallback worker. */
export function getMbTextSearchStats() {
  return db.prepare(`
    SELECT
      COUNT(CASE WHEN acoustid_status = 'not_found'
                   AND title IS NOT NULL AND LENGTH(TRIM(title)) > 2
                   AND artist IS NOT NULL AND LENGTH(TRIM(artist)) > 2
                   AND mb_text_search_status IS NULL THEN 1 END) AS queued,
      COUNT(CASE WHEN mb_text_search_status = 'found'           THEN 1 END) AS found,
      COUNT(CASE WHEN mb_text_search_status = 'not_found'       THEN 1 END) AS not_found,
      COUNT(CASE WHEN mb_text_search_status LIKE 'skipped%'     THEN 1 END) AS skipped,
      COUNT(CASE WHEN mb_text_search_status = 'error'           THEN 1 END) AS errors
    FROM files
  `).get();
}

/** Reset all not_found text-search rows to NULL so they are retried. */
export function resetMbTextSearchNotFound() {
  const r = db.prepare(`
    UPDATE files SET mb_text_search_status = NULL, mb_text_search_ts = NULL
    WHERE mb_text_search_status = 'not_found'
  `).run();
  return { reset: r.changes };
}

/** Files that failed the text-search worker — for display in the admin error list. */
export function getMbTextSearchErrors(limit = 200) {
  return db.prepare(`
    SELECT filepath, vpath, mb_text_search_ts, mb_text_search_error
    FROM files
    WHERE mb_text_search_status = 'error'
    ORDER BY mb_text_search_ts DESC
    LIMIT ?
  `).all(limit);
}

/** Reset all text-search error rows to NULL so they are retried. */
export function retryMbTextSearchErrors() {
  const r = db.prepare(`
    UPDATE files SET mb_text_search_status = NULL, mb_text_search_ts = NULL, mb_text_search_error = NULL
    WHERE mb_text_search_status = 'error'
  `).run();
  return { reset: r.changes };
}

/**
 * Return files in a specific folder (direct children only) with current + MB enrichment data.
 * @param {string} vpathName - the root vpath name (e.g. 'Music')
 * @param {string} filepathPrefix - relative path within vpath (e.g. 'Albums/ABBA/Gold'), no leading slash
 */
export function getTagWorkshopFolderFiles(vpathName, filepathPrefix) {
  if (filepathPrefix) {
    const p = filepathPrefix.endsWith('/') ? filepathPrefix : filepathPrefix + '/';
    return db.prepare(`
      SELECT filepath, vpath, title, artist, album, year, track, disk, genre, format,
             mb_title, mb_artist, mb_album, mb_year, mb_track, mb_release_id, tag_status, aaFile,
             acoustid_status, mb_enrichment_status
      FROM files
      WHERE vpath = ? AND filepath LIKE ? AND filepath NOT LIKE ?
      ORDER BY COALESCE(mb_track, track, 0), COALESCE(title, filepath) COLLATE NOCASE
    `).all(vpathName, p + '%', p + '%/%');
  }
  return db.prepare(`
    SELECT filepath, vpath, title, artist, album, year, track, disk, genre, format,
           mb_title, mb_artist, mb_album, mb_year, mb_track, mb_release_id, tag_status, aaFile,
           acoustid_status, mb_enrichment_status
    FROM files
    WHERE vpath = ? AND filepath NOT LIKE '%/%'
    ORDER BY COALESCE(track, 0), COALESCE(title, filepath) COLLATE NOCASE
  `).all(vpathName);
}

/** Reset enrichment status for specific files so the worker picks them up again.
 *  Only affects files with acoustid_status='found'. Returns count reset. */
export function resetFilesForEnrichment(files) {
  const stmt = db.prepare(
    `UPDATE files SET mb_enrichment_status = NULL
     WHERE filepath = ? AND vpath = ? AND acoustid_status = 'found'`
  );
  let count = 0;
  db.exec('BEGIN');
  try {
    for (const f of files) {
      const r = stmt.run(f.filepath, f.vpath);
      count += r.changes;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return count;
}

/** Combined status for the Tag Workshop dashboard. */
export function getTagWorkshopStatus() {
  const mb         = getMbEnrichStats();
  const textSearch = getMbTextSearchStats();
  const tags = db.prepare(`
    SELECT
      COUNT(CASE WHEN tag_status = 'needs_review' THEN 1 END) AS needs_review,
      COUNT(CASE WHEN tag_status = 'confirmed'    THEN 1 END) AS confirmed,
      COUNT(CASE WHEN tag_status = 'accepted'     THEN 1 END) AS accepted,
      COUNT(CASE WHEN tag_status = 'skipped'      THEN 1 END) AS skipped
    FROM files
    WHERE mb_enrichment_status = 'done'
  `).get();
  const coverage = db.prepare(`
    SELECT
      COUNT(*) AS library_total,
      COUNT(CASE WHEN acoustid_status = 'not_found' THEN 1 END) AS ac_not_found
    FROM files
  `).get();
  return { mb, textSearch, tags, coverage };
}

const _TWS_PAGE_SIZE = 40;

/** Paginated album cards grouped by mb_release_id. */
export function getTagWorkshopAlbums(filter = 'all', sort = 'broken', page = 1, search = '') {
  const offset = (Math.max(1, Number(page) || 1) - 1) * _TWS_PAGE_SIZE;

  const searchSql = search.trim()
    ? `AND (mb_album LIKE '%' || ? || '%' OR mb_artist LIKE '%' || ? || '%')`
    : '';
  const searchParams = search.trim() ? [search.trim(), search.trim()] : [];

  // Filter is a HAVING condition on aggregated values so track_count always
  // reflects the full album (not just the filtered subset of tracks).
  let havingSql;
  switch (filter) {
    case 'missing': havingSql = `HAVING SUM(CASE WHEN title IS NULL OR title = '' OR artist IS NULL OR artist = '' OR album IS NULL OR album = '' THEN 1 ELSE 0 END) > 0`; break;
    case 'year':    havingSql = `HAVING SUM(CASE WHEN mb_year IS NOT NULL AND (year IS NULL OR ABS(year - mb_year) > 1) THEN 1 ELSE 0 END) > 0`; break;
    case 'artist':  havingSql = `HAVING SUM(CASE WHEN mb_artist IS NOT NULL AND lower(REPLACE(COALESCE(artist,''),' ','')) != lower(REPLACE(mb_artist,' ','')) THEN 1 ELSE 0 END) > 0`; break;
    case 'junk':    havingSql = `HAVING SUM(CASE WHEN artist IS NOT NULL AND artist != '' AND NOT artist GLOB '*[^0-9]*' THEN 1 ELSE 0 END) > 0`; break;
    default:        havingSql = '';
  }

  let orderSql;
  switch (sort) {
    case 'tracks': orderSql = `track_count DESC, COALESCE(mb_artist,'') COLLATE NOCASE, COALESCE(mb_album,'') COLLATE NOCASE`; break;
    case 'alpha':  orderSql = `COALESCE(mb_artist,'') COLLATE NOCASE, COALESCE(mb_album,'') COLLATE NOCASE`; break;
    default:       orderSql = `tracks_needing_fix DESC, COALESCE(mb_artist,'') COLLATE NOCASE, COALESCE(mb_album,'') COLLATE NOCASE`;
  }

  const albums = db.prepare(`
    SELECT
      mb_release_id,
      COALESCE(mb_album_dir, '') AS mb_album_dir,
      mb_album,
      mb_artist,
      mb_year,
      COUNT(*) AS track_count,
      COUNT(CASE WHEN
        (mb_title IS NOT NULL AND lower(REPLACE(COALESCE(title,''),' ','')) != lower(REPLACE(mb_title,' ','')))
        OR (mb_artist IS NOT NULL AND lower(REPLACE(COALESCE(artist,''),' ','')) != lower(REPLACE(mb_artist,' ','')))
        OR (mb_album IS NOT NULL AND lower(REPLACE(COALESCE(album,''),' ','')) != lower(REPLACE(mb_album,' ','')))
        OR (mb_year IS NOT NULL AND ABS(COALESCE(year,0) - mb_year) > 1)
        THEN 1 END) AS tracks_needing_fix,
      MAX(aaFile) AS album_art,
      SUM(CASE WHEN mb_text_search_score IS NOT NULL AND acoustid_id IS NULL THEN 1 ELSE 0 END) AS has_text_search
    FROM files
    WHERE tag_status = 'needs_review' AND mb_release_id IS NOT NULL ${searchSql}
    GROUP BY mb_release_id, COALESCE(mb_album_dir, '')
    ${havingSql}
    ORDER BY ${orderSql}
    LIMIT ? OFFSET ?
  `).all(...searchParams, _TWS_PAGE_SIZE, offset);

  const countRow = db.prepare(
    `SELECT COUNT(*) AS cnt FROM (
       SELECT mb_release_id, COALESCE(mb_album_dir,'') FROM files
       WHERE tag_status = 'needs_review' AND mb_release_id IS NOT NULL ${searchSql}
       GROUP BY mb_release_id, COALESCE(mb_album_dir, '')
       ${havingSql}
     )`
  ).get(...searchParams);

  return { albums, total: countRow.cnt, page: Number(page), pageSize: _TWS_PAGE_SIZE };
}

/** All tracks for one release card (side-by-side file vs MB comparison). */
export function getTagWorkshopAlbumTracks(mb_release_id, album_dir = null) {
  const dirFilter = album_dir == null ? '' : `AND COALESCE(mb_album_dir, '') = ?`;
  const params    = album_dir == null ? [mb_release_id] : [mb_release_id, album_dir];
  return db.prepare(`
    SELECT filepath, vpath, title, artist, album, year, track, format,
           mb_title, mb_artist, mb_album, mb_year, mb_track,
           mb_release_id, tag_status, aaFile,
           acoustid_id, acoustid_score, mb_text_search_score
    FROM files
    WHERE mb_release_id = ? ${dirFilter}
    ORDER BY COALESCE(mb_track, track, 0), filepath COLLATE NOCASE
  `).all(...params);
}

/** Return tracks needing tag updates for an accept operation. */
export function getTracksForAccept(mb_release_id, album_dir = null) {
  const dirFilter = album_dir == null ? '' : `AND COALESCE(mb_album_dir, '') = ?`;
  const params    = album_dir == null ? [mb_release_id] : [mb_release_id, album_dir];
  return db.prepare(`
    SELECT filepath, vpath, mb_title, mb_artist, mb_album, mb_year, mb_track, title, artist, album, year, track, format
    FROM files
    WHERE mb_release_id = ? AND tag_status IN ('needs_review', 'confirmed', 'skipped') ${dirFilter}
  `).all(...params);
}

/** Single-track lookup by filepath + vpath for per-track accept operations. */
export function getTrackForAccept(filepath, vpath) {
  return db.prepare(`
    SELECT filepath, vpath, mb_title, mb_artist, mb_album, mb_year, mb_track, title, artist, album, year, track, format
    FROM files
    WHERE filepath = ? AND vpath = ? AND tag_status IN ('needs_review', 'confirmed', 'skipped')
  `).get(filepath, vpath);
}

/** Mark a single track's tag_status as accepted after a successful disk write. */
export function markTrackAccepted(filepath, vpath) {
  db.prepare(`UPDATE files SET tag_status = 'accepted' WHERE filepath = ? AND vpath = ?`).run(filepath, vpath);
}

/** Mark all tracks in a release as skipped. */
export function skipAlbumTags(mb_release_id, album_dir = null) {
  const dirFilter = album_dir == null ? '' : `AND COALESCE(mb_album_dir, '') = ?`;
  const params    = album_dir == null ? [mb_release_id] : [mb_release_id, album_dir];
  db.prepare(`
    UPDATE files SET tag_status = 'skipped'
    WHERE mb_release_id = ? AND tag_status IN ('needs_review', 'confirmed') ${dirFilter}
  `).run(...params);
}

/** Move a shelved (skipped) album back into the review queue. */
export function unshelveAlbum(mb_release_id, album_dir = null) {
  const dirFilter = album_dir == null ? '' : `AND COALESCE(mb_album_dir, '') = ?`;
  const params    = album_dir == null ? [mb_release_id] : [mb_release_id, album_dir];
  db.prepare(`
    UPDATE files SET tag_status = 'needs_review'
    WHERE mb_release_id = ? AND tag_status = 'skipped' ${dirFilter}
  `).run(...params);
}

/** Return paginated shelved (skipped) albums. */
export function getShelvedAlbums(page = 1) {
  const offset = (Math.max(1, Number(page) || 1) - 1) * _TWS_PAGE_SIZE;
  const albums = db.prepare(`
    SELECT mb_release_id, COALESCE(mb_album_dir,'') AS mb_album_dir, mb_album, mb_artist, mb_year,
           COUNT(*) AS track_count,
           MAX(aaFile) AS album_art
    FROM files
    WHERE tag_status = 'skipped' AND mb_release_id IS NOT NULL
    GROUP BY mb_release_id, COALESCE(mb_album_dir, '')
    ORDER BY mb_artist COLLATE NOCASE, mb_album COLLATE NOCASE
    LIMIT ? OFFSET ?
  `).all(_TWS_PAGE_SIZE, offset);
  const countRow = db.prepare(
    `SELECT COUNT(*) AS cnt FROM (
       SELECT DISTINCT mb_release_id, COALESCE(mb_album_dir,'') FROM files WHERE tag_status = 'skipped' AND mb_release_id IS NOT NULL
     )`
  ).get();
  return { albums, total: countRow.cnt, page: Number(page), pageSize: _TWS_PAGE_SIZE };
}

/** Find tracks where normalised file tags already match MB tags (casing/punctuation only).
    Returns their rows; caller updates DB + disk. */
export function getCasingOnlyCandidates() {
  const rows = db.prepare(`
    SELECT filepath, vpath, title, artist, album, year, track,
           mb_title, mb_artist, mb_album, mb_year, mb_track
    FROM files
    WHERE tag_status = 'needs_review'
      AND mb_enrichment_status = 'done'
      AND mb_release_id IS NOT NULL
  `).all();

  const norm = s => (s || '').toLowerCase().replaceAll(/[^a-z0-9]/g, '');

  return rows.filter(r => {
    const titleOk  = !r.mb_title  || norm(r.title)  === norm(r.mb_title);
    const artistOk = !r.mb_artist || norm(r.artist) === norm(r.mb_artist);
    const albumOk  = !r.mb_album  || norm(r.album)  === norm(r.mb_album);
    const yearOk   = !r.mb_year   || Math.abs((r.year || 0) - r.mb_year) <= 1;
    return titleOk && artistOk && albumOk && yearOk;
  });
}

export function getHomeSummary(userId, vpaths, todayStart, weekStart, timeWindows) {
  // songs played today
  const todayCount = db.prepare(
    'SELECT COUNT(*) AS c FROM play_events WHERE user_id=? AND started_at>=?'
  ).get(userId, todayStart).c;

  // songs played this week
  const weekCount = db.prepare(
    'SELECT COUNT(*) AS c FROM play_events WHERE user_id=? AND started_at>=?'
  ).get(userId, weekStart).c;

  // listening streak: consecutive calendar days (UTC midnight boundaries) with at least 1 play.
  // Single query fetches all distinct day-buckets descending — avoids up to 365 individual queries.
  const DAY_MS = 86400000;
  let streak = 0;
  {
    const dayBuckets = db.prepare(
      'SELECT DISTINCT CAST(started_at / 86400000 AS INTEGER) AS b FROM play_events WHERE user_id=? ORDER BY b DESC LIMIT 366'
    ).all(userId).map(r => r.b);
    const todayBucket = Math.floor(todayStart / DAY_MS);
    if (dayBuckets.length > 0) {
      const mostRecent = dayBuckets[0];
      // Only count a streak if the most recent play day is today or yesterday
      // (today may have no plays yet — still counts yesterday's streak as active)
      if (mostRecent === todayBucket || mostRecent === todayBucket - 1) {
        let expected = mostRecent;
        for (const b of dayBuckets) {
          if (b === expected) { streak++; expected--; }
          else break;
        }
      }
    }
  }

  // How many days of play history do we have?
  const earliestRow = db.prepare('SELECT MIN(started_at) AS t FROM play_events WHERE user_id=?').get(userId);
  const dataSpanDays = earliestRow?.t ? Math.floor((todayStart - earliestRow.t) / DAY_MS) : 0;

  // Temporal sections: query each eligible window for distinct songs played
  const vpathSet = new Set(vpaths);
  const stmtWindow = db.prepare(`
    SELECT DISTINCT pe.file_hash, f.title, f.artist, f.album, f.aaFile, f.filepath, f.vpath
    FROM play_events pe
    LEFT JOIN files f ON f.hash = pe.file_hash
    WHERE pe.user_id = ? AND pe.started_at >= ? AND pe.started_at < ?
    LIMIT 10
  `);
  const sections = [];
  for (const w of (timeWindows || [])) {
    if (dataSpanDays < (w.minDays || 0)) continue;
    const rows = stmtWindow.all(userId, w.from, w.to);
    const songs = rows.filter(r => r.vpath && vpathSet.has(r.vpath));
    if (songs.length) sections.push({ key: w.key, songs });
  }

  return { todayCount, weekCount, streak, dataSpanDays, sections };
}

// ── BPM & Key Analysis ─────────────────────────────────────────────────────

export function getBpmStats() {
  return db.prepare(`
    SELECT
      COUNT(*) AS total,
      COUNT(CASE WHEN bpm IS NOT NULL THEN 1 END) AS has_bpm,
      COUNT(CASE WHEN musical_key IS NOT NULL THEN 1 END) AS has_key,
      COUNT(CASE WHEN bpm_source = 'tag' THEN 1 END) AS source_tag,
      COUNT(CASE WHEN bpm_source = 'acousticbrainz' THEN 1 END) AS source_ab,
      COUNT(CASE WHEN bpm_source = 'essentia' THEN 1 END) AS source_essentia,
      COUNT(CASE WHEN acoustid_status = 'found' AND mbid IS NOT NULL THEN 1 END) AS ab_eligible,
      COUNT(CASE WHEN acoustid_status = 'found' AND mbid IS NOT NULL AND (ab_status IS NULL OR ab_status = 'error') THEN 1 END) AS ab_queued,
      COUNT(CASE WHEN ab_status = 'done' THEN 1 END) AS ab_done,
      COUNT(CASE WHEN ab_status = 'not_found' THEN 1 END) AS ab_not_found,
      COUNT(CASE WHEN ab_status = 'error' THEN 1 END) AS ab_errors,
      COUNT(CASE WHEN (bpm IS NULL OR musical_key IS NULL) AND bpm_status IS NULL THEN 1 END) AS essentia_queued,
      COUNT(CASE WHEN bpm_status = 'done' THEN 1 END) AS essentia_done,
      COUNT(CASE WHEN bpm_status = 'error' THEN 1 END) AS essentia_errors
    FROM files
    WHERE format IS NOT NULL
  `).get();
}

export function resetAbErrors() {
  const r = db.prepare(`UPDATE files SET ab_status = NULL WHERE ab_status = 'error'`).run();
  return r.changes;
}

export function resetAbNotFound() {
  const r = db.prepare(`UPDATE files SET ab_status = NULL WHERE ab_status = 'not_found'`).run();
  return r.changes;
}

export function resetEssentiaErrors() {
  const r = db.prepare(`UPDATE files SET bpm_status = NULL WHERE bpm_status = 'error'`).run();
  return r.changes;
}

export function resetAllBpmData() {
  const r = db.prepare(`
    UPDATE files SET bpm = NULL, musical_key = NULL, bpm_source = NULL,
                     ab_status = NULL, bpm_status = NULL
    WHERE format IS NOT NULL
  `).run();
  return r.changes;
}

// ── BPM Genre-Matrix Correction (Phase 2) ──────────────────────────────────
//
// Genre-window families: map keyword patterns to [minBpm, maxBpm] ranges.
// - Keywords are matched case-insensitively anywhere in the genre string.
// - Families are checked in priority order (DnB must come before Electronic
//   to avoid "jungle techno" being caught by Electronic first).
// - Only corrects bpm_source = 'essentia' rows.
// - A single correction step only: halve OR double once.

const _GENRE_FAMILIES = [
  // [ familyName, keywords[], minBpm, maxBpm ]
  ['dnb',         ['drum and bass', 'drum & bass', 'd&b', 'dnb', 'jungle'],         155, 190],
  ['disco',       ['disco'],                                                          95, 135],
  ['hiphop',      ['hip-hop', 'hip hop', 'rap', 'trap', 'r&b', 'rnb', 'soul', 'funk'], 60, 115],
  ['reggae',      ['reggae', 'dancehall', 'dub'],                                    60, 105],
  ['electronic',  ['house', 'euro house', 'euro-house', 'eurodance', 'dance',
                   'club', 'trance', 'techno', 'electronic', 'electro'],            115, 145],
  // Pop/Rock: no correction — too wide a range of real tempos.
  // Explicitly listed so we can report "no-correction" families in dry-run.
  ['pop',         ['top 40', 'pop rock', 'pop', 'rock'],                            null, null],
];

function _matchGenreFamily(genre) {
  const g = String(genre ?? '').toLowerCase();
  if (!g.trim()) return null;
  for (const [family, keywords, min, max] of _GENRE_FAMILIES) {
    if (keywords.some(kw => g.includes(kw))) return { family, min, max };
  }
  return null;
}

function _applyCorrection(bpm, min, max) {
  if (min === null) return null; // no-correction family
  if (bpm > max) {
    const half = Math.round(bpm / 2 * 10) / 10;
    return half >= min && half <= max ? half : null; // only if result lands in window
  }
  if (bpm < min) {
    const doubled = Math.round(bpm * 2 * 10) / 10;
    return doubled >= min && doubled <= max ? doubled : null; // only if result lands in window
  }
  return null; // already in window
}

/**
 * Run (or dry-run) genre-based BPM octave correction.
 * @param {boolean} dryRun  – if true: analyse only, write nothing
 * @returns {{ dryRun, changed, skipped, noGenre, noFamily, alreadyOk,
 *             byFamily: Record<string, {halved:number, doubled:number, skipped:number}> }}
 */
export function genreCorrectBpm(dryRun = false) {
  const rows = db.prepare(`
    SELECT filepath, vpath, bpm, genre, title, artist
    FROM files
    WHERE bpm_source = 'essentia'
      AND bpm IS NOT NULL
      AND bpm > 0
      AND format IS NOT NULL
  `).all();

  const _writeCorrection = db.prepare(`
    UPDATE files SET bpm = ?, bpm_raw = ?, bpm_status = 'genre-corrected'
    WHERE filepath = ? AND vpath = ?
  `);

  let changed = 0, skipped = 0, noGenre = 0, noFamily = 0, alreadyOk = 0;
  const byFamily = {};
  const corrections = dryRun ? [] : null;

  for (const [f] of _GENRE_FAMILIES) {
    byFamily[f] = { halved: 0, doubled: 0, skipped: 0 };
  }

  for (const row of rows) {
    if (!row.genre?.trim()) { noGenre++; continue; }
    const match = _matchGenreFamily(row.genre);
    if (!match) { noFamily++; continue; }

    const { family, min, max } = match;
    const corrected = _applyCorrection(row.bpm, min, max);

    if (corrected === null) {
      alreadyOk++;
      byFamily[family].skipped++;
      continue;
    }

    if (corrected < 40 || corrected > 300) { skipped++; continue; } // sanity guard

    if (dryRun) {
      corrections.push({
        family,
        filepath:  row.filepath,
        vpath:     row.vpath,
        title:     row.title  || row.filepath.split('/').at(-1),
        artist:    row.artist ?? '—',
        genre:     row.genre,
        bpm:       Math.round(row.bpm * 10) / 10,
        corrected,
      });
    } else {
      _writeCorrection.run(corrected, row.bpm, row.filepath, row.vpath);
    }

    if (corrected < row.bpm) byFamily[family].halved++;
    else                      byFamily[family].doubled++;
    changed++;
  }

  return { dryRun, changed, skipped, noGenre, noFamily, alreadyOk, byFamily, corrections };
}

/**
 * Apply a user-selected subset of dry-run corrections.
 * @param {Array<{filepath:string, vpath:string, bpm:number, corrected:number}>} corrections
 * @returns {number} rows actually updated
 */
export function genreCorrectBpmSelected(corrections) {
  const stmt = db.prepare(`
    UPDATE files SET bpm = ?, bpm_raw = ?, bpm_status = 'genre-corrected'
    WHERE filepath = ? AND vpath = ? AND bpm_source = 'essentia'
  `);
  let count = 0;
  for (const { filepath, vpath, corrected, bpm } of corrections) {
    const r = stmt.run(corrected, bpm, filepath, vpath);
    count += r.changes;
  }
  return count;
}

/**
 * Undo genre-matrix correction — restore bpm_raw where bpm_status='genre-corrected'.
 */
export function genreCorrectBpmUndo() {
  const r = db.prepare(`
    UPDATE files
    SET bpm = bpm_raw, bpm_status = 'done', bpm_raw = NULL
    WHERE bpm_status = 'genre-corrected' AND bpm_raw IS NOT NULL
  `).run();
  return r.changes;
}

// ── Essentia audio_features helpers ────────────────────────────────────────

export function saveAudioFeatures(hash, features) {
  db.prepare(`
    INSERT INTO audio_features
      (hash, bpm, bpm_confidence, key_name, key_scale, key_strength,
       danceability, loudness, dynamic_complexity, mfcc_mean, hpcp_mean, analyzed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(hash) DO UPDATE SET
      bpm               = excluded.bpm,
      bpm_confidence    = excluded.bpm_confidence,
      key_name          = excluded.key_name,
      key_scale         = excluded.key_scale,
      key_strength      = excluded.key_strength,
      danceability      = excluded.danceability,
      loudness          = excluded.loudness,
      dynamic_complexity = excluded.dynamic_complexity,
      mfcc_mean         = excluded.mfcc_mean,
      hpcp_mean         = excluded.hpcp_mean,
      analyzed_at       = excluded.analyzed_at
  `).run(
    hash,
    features.bpm ?? null, features.bpm_confidence ?? null,
    features.key_name ?? null, features.key_scale ?? null, features.key_strength ?? null,
    features.danceability ?? null, features.loudness ?? null,
    features.dynamic_complexity ?? null,
    features.mfcc_mean ? JSON.stringify(features.mfcc_mean) : null,
    features.hpcp_mean ? JSON.stringify(features.hpcp_mean) : null,
    Date.now()
  );
}

export function getAudioFeatures(hash) {
  const row = db.prepare('SELECT * FROM audio_features WHERE hash = ?').get(hash);
  if (!row) return null;
  if (row.mfcc_mean) { try { row.mfcc_mean = JSON.parse(row.mfcc_mean); } catch (e) { console.debug('[velvet]', e?.message ?? e); } }
  if (row.hpcp_mean) { try { row.hpcp_mean = JSON.parse(row.hpcp_mean); } catch (e) { console.debug('[velvet]', e?.message ?? e); } }
  return row;
}

/**
 * Find similar songs to the given track hash.
 *
 * Similarity is scored as a weighted sum of:
 *   - BPM proximity (within ±10% or ±5 BPM window)
 *   - Musical key compatibility (same key, relative key, dominant key)
 *
 * Returns up to `limit` rows from `files` table, ordered by similarity score.
 * Each row includes: filepath, vpath, title, artist, album, bpm, musical_key, hash, aaFile
 */
export function getSimilarSongs(hash, limit = 50) {
  // Get reference track data
  const ref = db.prepare(
    'SELECT bpm, musical_key FROM files WHERE hash = ? AND format IS NOT NULL'
  ).get(hash);
  if (!ref) return [];

  const { bpm, musical_key } = ref;
  if (!bpm && !musical_key) return [];

  // Camelot wheel for key compatibility (relative + dominant)
  const CAMELOT = {
    'C major': '8B', 'A minor': '8A',
    'G major': '9B', 'E minor': '9A',
    'D major': '10B', 'B minor': '10A',
    'A major': '11B', 'F# minor': '11A',
    'E major': '12B', 'C# minor': '12A',
    'B major': '1B', 'G# minor': '1A',
    'F# major': '2B', 'D# minor': '2A',
    'C# major': '3B', 'A# minor': '3A',
    'F major': '7B', 'D minor': '7A',
    'Bb major': '6B', 'G minor': '6A',
    'Eb major': '5B', 'C minor': '5A',
    'Ab major': '4B', 'F minor': '4A',
  };

  function camelotCompat(key1, key2) {
    if (!key1 || !key2) return false;
    const c1 = CAMELOT[key1], c2 = CAMELOT[key2];
    if (!c1 || !c2) return key1 === key2;
    const n1 = Number.parseInt(c1), n2 = Number.parseInt(c2);
    const t1 = c1.slice(-1), t2 = c2.slice(-1);
    if (t1 === t2 && Math.abs(n1 - n2) <= 1) return true; // adjacent same type
    if (t1 !== t2 && n1 === n2) return true; // relative major/minor (same number)
    return false;
  }

  // Query candidates: same musical key or close BPM — SQLite will do pre-filtering
  const sql = `
    SELECT filepath, vpath, title, artist, album, bpm, musical_key, hash, aaFile
    FROM files
    WHERE format IS NOT NULL AND hash != ?
  `;
  const params = [hash];

  // Build scored candidate list in JS (SQLite can't express Camelot wheel arithmetic)
  const rows = db.prepare(sql).all(...params);
  const bpmRef = bpm || 0;
  const BPM_WINDOW = Math.max(5, bpmRef * 0.1); // ±10% or ±5 BPM

  const scored = [];
  for (const row of rows) {
    let score = 0;
    if (row.bpm && bpm) {
      const diff = Math.abs(row.bpm - bpmRef);
      if (diff <= BPM_WINDOW) score += 1 - diff / (BPM_WINDOW * 2);
    }
    if (musical_key && row.musical_key) {
      if (row.musical_key === musical_key) score += 2;
      else if (camelotCompat(musical_key, row.musical_key)) score += 1;
    }
    if (score > 0) scored.push({ ...row, _score: score });
  }

  scored.sort((a, b) => b._score - a._score);
  return scored.slice(0, limit);
}



export function getRandomSongsForAutoDj(vpaths, ignoreVPaths, opts) {
  // This is a thin alias — actual filtering logic lives in getRandomSongs()
  // The BPM/key params are handled there; see that function for details.
  return getRandomSongs(vpaths, ignoreVPaths, opts);
}

// ── Smart Playlist ML ─────────────────────────────────────────────────────

/** Get a single slot profile row for (userId, slot). Returns null if absent. */
export function spGetProfile(userId, slot) {
  return db.prepare(
    'SELECT * FROM sp_slot_profiles WHERE user_id = ? AND slot = ?'
  ).get(userId, slot) ?? null;
}

/** Insert or replace a slot profile. */
export function spUpsertProfile(userId, slot, profileJson, playCount, lastEventId) {
  db.prepare(
    `INSERT INTO sp_slot_profiles (user_id, slot, profile, play_count, last_event_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, slot) DO UPDATE SET
       profile = excluded.profile,
       play_count = excluded.play_count,
       last_event_id = excluded.last_event_id,
       updated_at = excluded.updated_at`
  ).run(userId, slot, profileJson, playCount, lastEventId, Date.now());
}

/**
 * Get play_events for a user that come after a given event ID,
 * ordered ascending so the EMA is applied chronologically.
 */
export function spGetNewEvents(userId, afterId) {
  return db.prepare(
    `SELECT id, file_hash, started_at, played_ms, completed
     FROM play_events
     WHERE user_id = ? AND id > ?
     ORDER BY id ASC`
  ).all(userId, afterId);
}

/**
 * Get feature data for a single track hash (files LEFT JOIN audio_features).
 * Returns null if the hash is not found or has no parseable format.
 */
export function spGetTrackFeatures(hash) {
  return db.prepare(
    `SELECT f.genre, f.year, f.bpm, f.musical_key, f.duration,
            af.danceability, af.loudness
     FROM files f
     LEFT JOIN audio_features af ON af.hash = f.hash
     WHERE f.hash = ? AND f.format IS NOT NULL
     LIMIT 1`
  ).get(hash) ?? null;
}

/**
 * Get ALL tracks with feature data for a given list of vpaths.
 * Used by the playlist generator to score the whole library.
 *
 * @param {string[]} vpaths
 * @returns {object[]} rows with vpath, filepath, genre, year, bpm, musical_key,
 *                     duration, danceability, loudness
 */
export function spGetAllTracksWithFeatures(vpaths) {
  if (!Array.isArray(vpaths) || vpaths.length === 0) return [];
  const placeholders = vpaths.map(() => '?').join(',');
  // GROUP BY hash deduplicates identical audio files stored at multiple paths.
  // MIN(f.rowid) picks the first-indexed copy; all copies have the same features.
  return db.prepare(
    `SELECT f.vpath, f.filepath,
            MIN(f.artist) AS artist,
            f.genre, f.year, f.bpm, f.musical_key, f.duration,
            af.danceability, af.loudness
     FROM files f
     LEFT JOIN audio_features af ON af.hash = f.hash
     WHERE f.format IS NOT NULL AND f.hash IS NOT NULL
       AND f.hash != 'd41d8cd98f00b204e9800998ecf8427e'
       AND f.vpath IN (${placeholders})
     GROUP BY f.hash`
  ).all(...vpaths);
}

/** Get a cached generated playlist row for (userId, slot). Returns null if absent. */
export function spGetGeneratedPlaylist(userId, slot) {
  return db.prepare(
    'SELECT * FROM sp_generated_playlists WHERE user_id = ? AND slot = ?'
  ).get(userId, slot) ?? null;
}

/** Insert or replace a generated playlist. */
export function spUpsertGeneratedPlaylist(userId, slot, tracksJson) {
  db.prepare(
    `INSERT INTO sp_generated_playlists (user_id, slot, tracks, generated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, slot) DO UPDATE SET
       tracks = excluded.tracks,
       generated_at = excluded.generated_at`
  ).run(userId, slot, tracksJson, Date.now());
}

/**
 * Return distinct user IDs that have at least one play_event.
 * The generator iterates over these to build and cache playlists.
 */
export function spGetAllUserIds() {
  return db.prepare(
    'SELECT DISTINCT user_id FROM play_events'
  ).all().map(r => r.user_id);
}

/**
 * Admin status: per-user per-slot profile summary + last generated times.
 */
export function spGetStats() {
  const profiles = db.prepare(
    `SELECT user_id, slot, play_count, updated_at
     FROM sp_slot_profiles
     ORDER BY user_id, slot`
  ).all();
  const generated = db.prepare(
    `SELECT user_id, slot, generated_at,
            json_array_length(tracks) AS track_count
     FROM sp_generated_playlists
     ORDER BY user_id, slot`
  ).all();
  // Live play_events count per user per time-slot (based on local hour of play start).
  // Uses SQLite strftime to bucket by local time so the slot matches what the generator sees.
  const slotCounts = db.prepare(
    `SELECT user_id,
       SUM(CASE WHEN CAST(strftime('%H', datetime(started_at/1000, 'unixepoch', 'localtime')) AS INTEGER) BETWEEN 6  AND 10 THEN 1 ELSE 0 END) AS morning,
       SUM(CASE WHEN CAST(strftime('%H', datetime(started_at/1000, 'unixepoch', 'localtime')) AS INTEGER) BETWEEN 11 AND 16 THEN 1 ELSE 0 END) AS afternoon,
       SUM(CASE WHEN CAST(strftime('%H', datetime(started_at/1000, 'unixepoch', 'localtime')) AS INTEGER) BETWEEN 17 AND 21 THEN 1 ELSE 0 END) AS evening,
       SUM(CASE WHEN CAST(strftime('%H', datetime(started_at/1000, 'unixepoch', 'localtime')) AS INTEGER) NOT BETWEEN 6  AND 21 THEN 1 ELSE 0 END) AS night
     FROM play_events
     GROUP BY user_id`
  ).all();
  return { profiles, generated, slotCounts };
}

/**
 * Delete all slot profiles (and generated playlists) for a user.
 * After this the generator will start from scratch for that user.
 */
export function spResetProfiles(userId) {
  db.prepare('DELETE FROM sp_slot_profiles WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM sp_generated_playlists WHERE user_id = ?').run(userId);
}

// ── Subsonic Bookmarks ───────────────────────────────────────────────────────

/** Return all bookmarks for a user as { song_id, position, comment, created, changed }[] */
export function getBookmarks(username) {
  return db.prepare(
    'SELECT song_id, position, comment, created, changed FROM bookmarks WHERE username = ? ORDER BY changed DESC'
  ).all(username);
}

/** Upsert a bookmark (position in milliseconds). */
export function saveBookmark(username, songId, position, comment) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO bookmarks (username, song_id, position, comment, created, changed)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(username, song_id) DO UPDATE SET position=excluded.position, comment=excluded.comment, changed=excluded.changed
  `).run(username, songId, position ?? 0, comment ?? null, now, now);
}

/** Delete a bookmark by song_id for a user. */
export function deleteBookmark(username, songId) {
  db.prepare('DELETE FROM bookmarks WHERE username = ? AND song_id = ?').run(username, songId);
}

// ── Subsonic Play Queue ──────────────────────────────────────────────────────

/** Return the saved play queue for a user, or null if none. */
export function getPlayQueue(username) {
  return db.prepare(
    'SELECT current_id, position_ms, changed, changed_by, song_ids FROM play_queues WHERE username = ?'
  ).get(username) ?? null;
}

/** Upsert the play queue for a user. song_ids must be a JSON-serialised array of song ID strings. */
export function savePlayQueue(username, currentId, positionMs, changedBy, songIds) {
  db.prepare(`
    INSERT INTO play_queues (username, current_id, position_ms, changed, changed_by, song_ids)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(username) DO UPDATE SET
      current_id  = excluded.current_id,
      position_ms = excluded.position_ms,
      changed     = excluded.changed,
      changed_by  = excluded.changed_by,
      song_ids    = excluded.song_ids
  `).run(username, currentId ?? null, positionMs ?? 0, Date.now(), changedBy ?? null, songIds ?? '[]');
}
