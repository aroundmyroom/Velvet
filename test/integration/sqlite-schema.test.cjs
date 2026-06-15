/**
 * SQLite Schema — Integration Tests
 * Validates the core `files` table schema, FTS5 virtual table, user_metadata,
 * and key query patterns that our application depends on.
 *
 * Uses an in-memory SQLite DB with the exact schema from src/db/sqlite-backend.js
 * (post-all-migrations) to verify the column structure and queries work correctly.
 */

'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

// ── Schema ────────────────────────────────────────────────────────────────────
// Mirrors the fully-migrated schema from src/db/sqlite-backend.js.
// Keep this in sync when adding new columns via migrations.
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS files (
    title TEXT, artist TEXT, year INTEGER, album TEXT,
    filepath TEXT NOT NULL, format TEXT, track INTEGER, trackOf INTEGER, disk INTEGER,
    modified REAL, hash TEXT, audio_hash TEXT, aaFile TEXT, vpath TEXT NOT NULL,
    ts INTEGER, sID TEXT, replaygainTrackDb REAL, genre TEXT, cuepoints TEXT,
    art_source TEXT, duration REAL, artist_id TEXT, album_id TEXT,
    cover_file TEXT, acoustid_id TEXT, mbid TEXT, acoustid_score REAL,
    acoustid_status TEXT, acoustid_ts INTEGER, mb_title TEXT, mb_artist TEXT,
    mb_artist_id TEXT, mb_album TEXT, mb_year INTEGER, mb_track INTEGER,
    mb_release_id TEXT, mb_enrichment_status TEXT, mb_enriched_ts INTEGER,
    tag_status TEXT, mb_album_dir TEXT, mb_enrichment_error TEXT,
    bitrate REAL, sample_rate REAL, channels INTEGER,
    UNIQUE(filepath, vpath)
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
    title, artist, album, filepath,
    content=files, content_rowid=rowid
  );

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

  CREATE TABLE IF NOT EXISTS user_settings (
    username TEXT NOT NULL PRIMARY KEY,
    prefs TEXT NOT NULL DEFAULT '{}',
    queue TEXT NOT NULL DEFAULT 'null'
  );
`;

function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  return db;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function insertFile(db, data) {
  const id = db.prepare(`
    INSERT INTO files (title, artist, year, album, filepath, format, track, trackOf, disk,
      modified, hash, audio_hash, aaFile, vpath, ts, replaygainTrackDb, genre,
      duration, artist_id, album_id, bitrate, sample_rate, channels)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    data.title ?? null, data.artist ?? null, data.year ?? null, data.album ?? null,
    data.filepath, data.format ?? null, data.track ?? null, data.trackOf ?? null, data.disk ?? null,
    data.modified ?? null, data.hash ?? null, data.audio_hash ?? null, data.aaFile ?? null,
    data.vpath, data.ts ?? null, data.replaygainTrackDb ?? null, data.genre ?? null,
    data.duration ?? null, data.artist_id ?? null, data.album_id ?? null,
    data.bitrate ?? null, data.sample_rate ?? null, data.channels ?? null
  ).lastInsertRowid;

  // Sync FTS5
  db.prepare('INSERT INTO files_fts(rowid, title, artist, album, filepath) VALUES (?,?,?,?,?)')
    .run(id, data.title ?? null, data.artist ?? null, data.album ?? null, data.filepath);

  return Number(id);
}

describe('SQLite Schema', () => {

  describe('files table — UNIQUE constraint', () => {
    it('allows same filepath in different vpaths', () => {
      const db = makeDb();
      insertFile(db, { filepath: 'Rock/song.mp3', vpath: 'MusicA', title: 'Song A' });
      insertFile(db, { filepath: 'Rock/song.mp3', vpath: 'MusicB', title: 'Song B' });
      const count = db.prepare('SELECT COUNT(*) AS n FROM files').get().n;
      assert.equal(count, 2);
    });

    it('rejects duplicate (filepath, vpath)', () => {
      const db = makeDb();
      insertFile(db, { filepath: 'Rock/song.mp3', vpath: 'Music', title: 'Song' });
      assert.throws(() => {
        db.prepare('INSERT INTO files (filepath, vpath) VALUES (?, ?)').run('Rock/song.mp3', 'Music');
      }, /UNIQUE constraint/);
    });
  });

  describe('files table — column storage', () => {
    let db;
    before(() => {
      db = makeDb();
      insertFile(db, {
        filepath: 'Artist/Album/Track 01.flac',
        vpath: 'Music',
        title: 'Track One',
        artist: 'The Artist',
        album: 'The Album',
        year: 2024,
        track: 1,
        trackOf: 12,
        disk: 1,
        hash: 'deadbeef',
        genre: 'Electronic',
        duration: 240000,
        bitrate: 1411,
        sample_rate: 44100,
        channels: 2,
        replaygainTrackDb: -7.3,
        aaFile: 'cover-deadbeef.jpg',
      });
    });
    after(() => db.close());

    it('stores and retrieves all core fields', () => {
      const row = db.prepare('SELECT * FROM files WHERE filepath = ?').get('Artist/Album/Track 01.flac');
      assert.equal(row.title, 'Track One');
      assert.equal(row.artist, 'The Artist');
      assert.equal(row.album, 'The Album');
      assert.equal(row.year, 2024);
      assert.equal(row.track, 1);
      assert.equal(row.trackOf, 12);
      assert.equal(row.disk, 1);
      assert.equal(row.hash, 'deadbeef');
      assert.equal(row.genre, 'Electronic');
      assert.equal(row.duration, 240000);
      assert.equal(row.bitrate, 1411);
      assert.equal(row.sample_rate, 44100);
      assert.equal(row.channels, 2);
      assert.equal(row.replaygainTrackDb, -7.3);
      assert.equal(row.aaFile, 'cover-deadbeef.jpg');
    });

    it('stores null for omitted optional fields', () => {
      const db2 = makeDb();
      insertFile(db2, { filepath: 'minimal.mp3', vpath: 'Music' });
      const row = db2.prepare('SELECT * FROM files WHERE filepath = ?').get('minimal.mp3');
      assert.equal(row.title, null);
      assert.equal(row.artist, null);
      assert.equal(row.hash, null);
      db2.close();
    });
  });

  describe('FTS5 full-text search', () => {
    let db;
    before(() => {
      db = makeDb();
      const songs = [
        { filepath: 'q/bohemian.mp3',  vpath: 'Music', title: 'Bohemian Rhapsody', artist: 'Queen',       album: 'A Night at the Opera' },
        { filepath: 'q/another.mp3',   vpath: 'Music', title: 'Another One Bites the Dust', artist: 'Queen', album: 'The Game' },
        { filepath: 'lz/stairway.mp3', vpath: 'Music', title: 'Stairway to Heaven', artist: 'Led Zeppelin', album: 'Led Zeppelin IV' },
        { filepath: 'r/paranoid.mp3',  vpath: 'Music', title: 'Paranoid Android',  artist: 'Radiohead',   album: 'OK Computer' },
      ];
      for (const s of songs) insertFile(db, s);
    });
    after(() => db.close());

    it('finds song by exact title match', () => {
      const rows = db.prepare(`
        SELECT f.title FROM files f
        JOIN files_fts ON files_fts.rowid = f.rowid
        WHERE files_fts MATCH ? LIMIT 10
      `).all('Bohemian Rhapsody');
      assert.equal(rows.length, 1);
      assert.equal(rows[0].title, 'Bohemian Rhapsody');
    });

    it('finds multiple songs by artist', () => {
      const rows = db.prepare(`
        SELECT f.title FROM files f
        JOIN files_fts ON files_fts.rowid = f.rowid
        WHERE files_fts MATCH ? LIMIT 10
      `).all('Queen');
      assert.equal(rows.length, 2);
    });

    it('supports prefix search', () => {
      const rows = db.prepare(`
        SELECT f.title FROM files f
        JOIN files_fts ON files_fts.rowid = f.rowid
        WHERE files_fts MATCH ? LIMIT 10
      `).all('Para*');
      assert.equal(rows.length, 1);
      assert.equal(rows[0].title, 'Paranoid Android');
    });

    it('supports OR operator', () => {
      const rows = db.prepare(`
        SELECT f.title FROM files f
        JOIN files_fts ON files_fts.rowid = f.rowid
        WHERE files_fts MATCH ? LIMIT 10
      `).all('Queen OR Radiohead');
      assert.equal(rows.length, 3);
    });

    it('is case-insensitive', () => {
      const upper = db.prepare(`SELECT COUNT(*) AS n FROM files_fts WHERE files_fts MATCH ?`).get('QUEEN');
      const lower = db.prepare(`SELECT COUNT(*) AS n FROM files_fts WHERE files_fts MATCH ?`).get('queen');
      assert.equal(upper.n, lower.n);
      assert.ok(upper.n > 0);
    });
  });

  describe('vpath filtering queries', () => {
    let db;
    before(() => {
      db = makeDb();
      insertFile(db, { filepath: 'Rock/song1.mp3', vpath: 'Music',  title: 'Song1', artist: 'Artist A' });
      insertFile(db, { filepath: 'Jazz/song2.mp3', vpath: 'Music',  title: 'Song2', artist: 'Artist B' });
      insertFile(db, { filepath: 'Pop/song3.mp3',  vpath: 'Albums', title: 'Song3', artist: 'Artist A' });
    });
    after(() => db.close());

    it('filters by vpath correctly', () => {
      const rows = db.prepare('SELECT * FROM files WHERE vpath = ?').all('Music');
      assert.equal(rows.length, 2);
      assert.ok(rows.every(r => r.vpath === 'Music'));
    });

    it('filters by vpath + filepath prefix (child vpath pattern)', () => {
      insertFile(db, { filepath: 'Albums/Beatles/Hey Jude.mp3', vpath: 'Music', title: 'Hey Jude', artist: 'The Beatles' });
      const rows = db.prepare("SELECT * FROM files WHERE vpath = 'Music' AND filepath LIKE 'Albums/%'").all();
      assert.ok(rows.length >= 1);
      assert.ok(rows.every(r => r.filepath.startsWith('Albums/')));
    });

    it('excludes filepath prefix (child vpath exclusion pattern)', () => {
      const rows = db.prepare("SELECT * FROM files WHERE vpath = 'Music' AND filepath NOT LIKE 'Albums/%'").all();
      assert.ok(rows.every(r => !r.filepath.startsWith('Albums/')));
    });
  });

  describe('user_metadata table', () => {
    let db;
    before(() => {
      db = makeDb();
      db.prepare('INSERT INTO user_metadata (hash, user, rating, pc, starred) VALUES (?,?,?,?,?)')
        .run('hash1', 'alice', 5, 42, 1);
      db.prepare('INSERT INTO user_metadata (hash, user, rating, pc, starred) VALUES (?,?,?,?,?)')
        .run('hash1', 'bob', 3, 7, 0);
      db.prepare('INSERT INTO user_metadata (hash, user, pc) VALUES (?,?,?)')
        .run('hash2', 'alice', 1);
    });
    after(() => db.close());

    it('stores per-user metadata independently', () => {
      const alice = db.prepare("SELECT * FROM user_metadata WHERE hash = 'hash1' AND user = 'alice'").get();
      const bob   = db.prepare("SELECT * FROM user_metadata WHERE hash = 'hash1' AND user = 'bob'").get();
      assert.equal(alice.rating, 5);
      assert.equal(alice.pc, 42);
      assert.equal(bob.rating, 3);
      assert.equal(bob.pc, 7);
    });

    it('queries all metadata for a user across hashes', () => {
      const rows = db.prepare("SELECT * FROM user_metadata WHERE user = 'alice'").all();
      assert.equal(rows.length, 2);
    });

    it('rejects duplicate (hash, user) pair', () => {
      assert.throws(() => {
        db.prepare('INSERT INTO user_metadata (hash, user, pc) VALUES (?,?,?)').run('hash1', 'alice', 99);
      }, /UNIQUE constraint/);
    });

    it('upsert pattern updates existing row', () => {
      db.prepare('INSERT OR REPLACE INTO user_metadata (hash, user, rating, pc, starred) VALUES (?,?,?,?,?)')
        .run('hash1', 'alice', 5, 50, 1);
      const row = db.prepare("SELECT pc FROM user_metadata WHERE hash='hash1' AND user='alice'").get();
      assert.equal(row.pc, 50);
    });
  });

  describe('user_settings table', () => {
    it('stores and retrieves JSON prefs', () => {
      const db = makeDb();
      db.prepare('INSERT INTO user_settings (username, prefs, queue) VALUES (?,?,?)').run(
        'dennis', JSON.stringify({ theme: 'dark', lang: 'nl' }), 'null'
      );
      const row = db.prepare('SELECT prefs FROM user_settings WHERE username = ?').get('dennis');
      assert.ok(row);
      const prefs = JSON.parse(row.prefs);
      assert.equal(prefs.theme, 'dark');
      assert.equal(prefs.lang, 'nl');
      db.close();
    });

    it('primary key prevents duplicate usernames', () => {
      const db = makeDb();
      db.prepare('INSERT INTO user_settings (username) VALUES (?)').run('alice');
      assert.throws(() => {
        db.prepare('INSERT INTO user_settings (username) VALUES (?)').run('alice');
      }, /UNIQUE constraint/);
      db.close();
    });
  });

});
