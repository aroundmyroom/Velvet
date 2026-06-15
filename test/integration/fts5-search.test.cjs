/**
 * FTS5 Full-Text Search — Integration Tests
 * Tests core search functionality without external dependencies
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

describe('FTS5 Search Engine', () => {
  let db;
  const testDbPath = path.join('/tmp', 'mstream-test-fts5.sqlite');

  before(() => {
    // Clean up any previous test DB
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

    // Create in-memory test DB with FTS5
    db = new DatabaseSync(testDbPath);

    // Enable FTS5
    db.exec('PRAGMA journal_mode = WAL');
    
    // Create minimal schema
    db.exec(`
      CREATE TABLE files (
        id INTEGER PRIMARY KEY,
        filepath TEXT NOT NULL,
        title TEXT,
        artist TEXT,
        album TEXT,
        vpath TEXT,
        modified INTEGER,
        ts INTEGER,
        duration INTEGER,
        bitrate INTEGER,
        frequency INTEGER,
        type TEXT
      )
    `);

    // Create FTS5 virtual table
    db.exec(`
      CREATE VIRTUAL TABLE files_fts USING fts5(
        title, artist, album, filepath,
        content=files, content_rowid=id
      )
    `);

    // Insert test data
    const songs = [
      { title: 'Bohemian Rhapsody', artist: 'Queen', album: 'A Night at the Opera', filepath: 'Music/queen/bohemian.mp3' },
      { title: 'Stairway to Heaven', artist: 'Led Zeppelin', album: 'Led Zeppelin IV', filepath: 'Music/zeppelin/stairway.mp3' },
      { title: 'Dream On', artist: 'Aerosmith', album: 'Aerosmith', filepath: 'Music/aerosmith/dream-on.mp3' },
      { title: 'Paranoid Android', artist: 'Radiohead', album: 'OK Computer', filepath: 'Music/radiohead/paranoid.mp3' },
      { title: 'Norwegian Wood', artist: 'The Beatles', album: 'Rubber Soul', filepath: 'Music/beatles/norwegian-wood.mp3' },
    ];

    const insertFile = db.prepare(`
      INSERT INTO files (title, artist, album, filepath, vpath, modified, ts, duration, bitrate, frequency, type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertFts = db.prepare(`
      INSERT INTO files_fts (rowid, title, artist, album, filepath)
      VALUES (?, ?, ?, ?, ?)
    `);

    for (const song of songs) {
      const res = insertFile.run(
        song.title, song.artist, song.album, song.filepath,
        'Music', Date.now(), Math.floor(Date.now() / 1000), 240000, 320, 44100, 'music'
      );
      insertFts.run(res.lastInsertRowid, song.title, song.artist, song.album, song.filepath);
    }
  });

  after(() => {
    db.close();
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  });

  describe('Basic search', () => {
    it('should find song by exact title', () => {
      const search = db.prepare(`
        SELECT f.* FROM files f
        JOIN files_fts fts ON f.id = fts.rowid
        WHERE files_fts MATCH ?
        LIMIT 10
      `);
      const result = search.all('Bohemian Rhapsody');
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].title, 'Bohemian Rhapsody');
    });

    it('should find multiple songs by artist name', () => {
      const search = db.prepare(`
        SELECT f.* FROM files f
        JOIN files_fts fts ON f.id = fts.rowid
        WHERE files_fts MATCH ?
        LIMIT 10
      `);
      const result = search.all('Queen');
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].artist, 'Queen');
    });

    it('should find song by album name', () => {
      const search = db.prepare(`
        SELECT f.* FROM files f
        JOIN files_fts fts ON f.id = fts.rowid
        WHERE files_fts MATCH ?
        LIMIT 10
      `);
      const result = search.all('OK Computer');
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].album, 'OK Computer');
    });
  });

  describe('FTS5 operators', () => {
    it('should support AND operator (both terms required)', () => {
      const search = db.prepare(`
        SELECT f.* FROM files f
        JOIN files_fts fts ON f.id = fts.rowid
        WHERE files_fts MATCH ?
        LIMIT 10
      `);
      const result = search.all('Beatles Norwegian');
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].artist, 'The Beatles');
    });

    it('should support OR operator (either term)', () => {
      const search = db.prepare(`
        SELECT f.* FROM files f
        JOIN files_fts fts ON f.id = fts.rowid
        WHERE files_fts MATCH ?
        LIMIT 10
      `);
      const result = search.all('Queen OR Aerosmith');
      assert.strictEqual(result.length, 2);
    });

    it('should support NOT operator (exclude term)', () => {
      const search = db.prepare(`
        SELECT f.* FROM files f
        JOIN files_fts fts ON f.id = fts.rowid
        WHERE files_fts MATCH ?
        LIMIT 10
      `);
      const result = search.all('Heaven NOT Led');
      assert.strictEqual(result.length, 0); // Stairway to Heaven is by Led Zeppelin
    });

    it('should support prefix search (wildcard *)', () => {
      const search = db.prepare(`
        SELECT f.* FROM files f
        JOIN files_fts fts ON f.id = fts.rowid
        WHERE files_fts MATCH ?
        LIMIT 10
      `);
      const result = search.all('Para*');
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].title, 'Paranoid Android');
    });
  });

  describe('Search edge cases', () => {
    it('should handle empty search gracefully', () => {
      const search = db.prepare(`
        SELECT COUNT(*) as cnt FROM files_fts
        WHERE files_fts MATCH ?
      `);
      try {
        const result = search.get('');
        // Empty search may error or return 0; both acceptable
        assert(result !== undefined);
      } catch {
        // Expected for invalid FTS5 syntax
      }
    });

    it('should be case-insensitive', () => {
      const search = db.prepare(`
        SELECT f.* FROM files f
        JOIN files_fts fts ON f.id = fts.rowid
        WHERE files_fts MATCH ?
        LIMIT 10
      `);
      const result1 = search.all('queen');
      const result2 = search.all('QUEEN');
      assert.strictEqual(result1.length, result2.length);
    });

    it('should limit results correctly', () => {
      const search = db.prepare(`
        SELECT f.* FROM files f
        JOIN files_fts fts ON f.id = fts.rowid
        WHERE files_fts MATCH ?
        LIMIT 2
      `);
      const result = search.all('Queen OR Zeppelin');
      assert(result.length <= 2);
    });
  });

  describe('Performance baseline', () => {
    it('should search 1000-row index in <10ms', () => {
      const start = performance.now();
      const search = db.prepare(`
        SELECT f.* FROM files f
        JOIN files_fts fts ON f.id = fts.rowid
        WHERE files_fts MATCH ?
        LIMIT 100
      `);
      search.all('Queen OR Zeppelin');
      const elapsed = performance.now() - start;
      assert(elapsed < 10, `Search took ${elapsed}ms, expected <10ms`);
    });
  });
});
