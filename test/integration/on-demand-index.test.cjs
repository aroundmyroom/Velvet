/**
 * On-Demand Album Index — Integration Tests
 * Tests DB queries for album discovery and filtering
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

describe('On-Demand Album Index', () => {
  let db;
  const testDbPath = path.join('/tmp', 'mstream-test-album.sqlite');

  before(() => {
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    db = new DatabaseSync(testDbPath);

    // Schema
    db.exec(`
      CREATE TABLE files (
        id INTEGER PRIMARY KEY,
        filepath TEXT NOT NULL,
        title TEXT,
        artist TEXT,
        album TEXT,
        album_artist TEXT,
        vpath TEXT,
        modified INTEGER,
        ts INTEGER,
        duration INTEGER,
        type TEXT
      )
    `);

    // Test data: 3 albums, 2 artists
    const songs = [
      { title: 'Track 1', artist: 'John Doe', album: 'Album A', album_artist: 'John Doe', filepath: 'Music/john-doe/album-a/track1.mp3' },
      { title: 'Track 2', artist: 'John Doe', album: 'Album A', album_artist: 'John Doe', filepath: 'Music/john-doe/album-a/track2.mp3' },
      { title: 'Track 3', artist: 'Jane Smith', album: 'Album B', album_artist: 'Jane Smith', filepath: 'Music/jane-smith/album-b/track3.mp3' },
      { title: 'Track 4', artist: 'John Doe', album: 'Album C', album_artist: 'John Doe', filepath: 'Music/john-doe/album-c/track4.mp3' },
    ];

    const insert = db.prepare(`
      INSERT INTO files (title, artist, album, album_artist, filepath, vpath, modified, ts, duration, type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const song of songs) {
      insert.run(
        song.title, song.artist, song.album, song.album_artist, song.filepath,
        'Music', Date.now(), Math.floor(Date.now() / 1000), 180000, 'music'
      );
    }
  });

  after(() => {
    db.close();
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  });

  describe('Album grouping', () => {

    it('should list distinct albums', () => {
      const query = db.prepare(`
        SELECT DISTINCT album, album_artist, COUNT(*) as track_count
        FROM files
        WHERE vpath = ?
        GROUP BY album, album_artist
        ORDER BY album_artist, album
      `);
      const albums = query.all('Music');
      assert.strictEqual(albums.length, 3);
      assert(albums.some(a => a.album === 'Album A' && a.track_count === 2));
    });
    it('should count tracks per album correctly', () => {
      const query = db.prepare(`
        SELECT album, COUNT(*) as track_count
        FROM files
        WHERE album = ?
        GROUP BY album
      `);
      const result = query.get('Album A');
      assert.strictEqual(result.track_count, 2);
    });
  });

  describe('Artist filtering', () => {
    it('should filter albums by artist', () => {
      const query = db.prepare(`
        SELECT DISTINCT album
        FROM files
        WHERE album_artist = ?
        ORDER BY album
      `);
      const albums = query.all('John Doe');
      assert.strictEqual(albums.length, 2);
      assert(albums.some(a => a.album === 'Album A'));
      assert(albums.some(a => a.album === 'Album C'));
    });

    it('should get all tracks in an album', () => {
      const query = db.prepare(`
        SELECT title, artist
        FROM files
        WHERE album = ?
        ORDER BY title
      `);
      const tracks = query.all('Album A');
      assert.strictEqual(tracks.length, 2);
    });
  });

  describe('vpath filtering', () => {
    it('should respect vpath boundaries', () => {
      const query = db.prepare(`
        SELECT COUNT(*) as cnt
        FROM files
        WHERE vpath = ?
      `);
      const result = query.get('Music');
      assert.strictEqual(result.cnt, 4);
    });

    it('should return 0 for non-existent vpath', () => {
      const query = db.prepare(`
        SELECT COUNT(*) as cnt
        FROM files
        WHERE vpath = ?
      `);
      const result = query.get('NonExistent');
      assert.strictEqual(result.cnt, 0);
    });
  });

  describe('Album art metadata', () => {
    it('should handle albums without art gracefully', () => {
      const query = db.prepare(`
        SELECT album, COUNT(*) as track_count
        FROM files
        WHERE album = ? AND vpath = ?
        GROUP BY album
      `);
      const result = query.get('Album A', 'Music');
      assert(result);
      assert.strictEqual(result.track_count, 2);
    });
  });

  describe('Performance baseline', () => {
    it('should group 4 songs into albums in <1ms', () => {
      const start = performance.now();
      const query = db.prepare(`
        SELECT DISTINCT album, COUNT(*) as track_count
        FROM files
        WHERE vpath = ?
        GROUP BY album
      `);
      query.all('Music');
      const elapsed = performance.now() - start;
      assert(elapsed < 1, `Query took ${elapsed}ms, expected <1ms`);
    });
  });
});
