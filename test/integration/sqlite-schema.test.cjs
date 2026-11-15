'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

describe('SQLite schema (src/db/sqlite-backend.js init)', () => {
  let backend, workDir;

  before(async () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-schema-'));
    backend = await import('../../src/db/sqlite-backend.js');
    backend.init(workDir);
  });

  after(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  describe('files table', () => {
    it('has every column the scanner writes', () => {
      const cols = new Set(backend.getDB().prepare('PRAGMA table_info(files)').all().map(c => c.name));
      for (const c of ['title', 'artist', 'album_artist', 'year', 'album', 'filepath', 'format', 'track', 'trackOf', 'disk',
        'modified', 'hash', 'audio_hash', 'aaFile', 'vpath', 'ts', 'sID', 'replaygainTrackDb', 'genre', 'cuepoints',
        'art_source', 'duration', 'artist_id', 'album_id', 'cover_file', 'bitrate', 'sample_rate', 'channels',
        'album_version', 'bit_depth', 'bpm', 'musical_key']) {
        assert.ok(cols.has(c), `files.${c} missing`);
      }
    });

    it('allows the same filepath in different vpaths', () => {
      backend.insertFile({ filepath: 'Rock/song.mp3', vpath: 'MusicA', title: 'Song A' });
      backend.insertFile({ filepath: 'Rock/song.mp3', vpath: 'MusicB', title: 'Song B' });
      assert.equal(backend.findFileByPath('Rock/song.mp3', 'MusicA').title, 'Song A');
      assert.equal(backend.findFileByPath('Rock/song.mp3', 'MusicB').title, 'Song B');
    });

    it('stores and retrieves all core fields', () => {
      backend.insertFile({
        filepath: 'Artist/Album/Track 01.flac', vpath: 'Music',
        title: 'Track One', artist: 'The Artist', albumArtist: 'Album Artist', album: 'The Album',
        year: 2024, track: 1, trackOf: 12, disk: 1, hash: 'deadbeef', genre: 'Electronic',
        duration: 240, bitrate: 1411, sample_rate: 44100, channels: 2, bit_depth: 16,
        replaygainTrackDb: -7.3, aaFile: 'cover-deadbeef.jpg', bpm: 124, musical_key: '8A',
      });
      const row = backend.findFileByPath('Artist/Album/Track 01.flac', 'Music');
      assert.equal(row.title, 'Track One');
      assert.equal(row.artist, 'The Artist');
      assert.equal(row.album_artist, 'Album Artist');
      assert.equal(row.album, 'The Album');
      assert.equal(row.year, 2024);
      assert.equal(row.track, 1);
      assert.equal(row.trackOf, 12);
      assert.equal(row.disk, 1);
      assert.equal(row.hash, 'deadbeef');
      assert.equal(row.genre, 'Electronic');
      assert.equal(row.duration, 240);
      assert.equal(row.bitrate, 1411);
      assert.equal(row.sample_rate, 44100);
      assert.equal(row.channels, 2);
      assert.equal(row.bit_depth, 16);
      assert.equal(row.replaygainTrackDb, -7.3);
      assert.equal(row.aaFile, 'cover-deadbeef.jpg');
      assert.equal(row.bpm, 124);
      assert.equal(row.musical_key, '8A');
      assert.equal(row.bpm_source, 'tag');
      assert.ok(row.artist_id, 'artist_id is derived on insert');
      assert.ok(row.album_id, 'album_id is derived on insert');
    });

    it('stores null for omitted optional fields', () => {
      backend.insertFile({ filepath: 'minimal.mp3', vpath: 'Music' });
      const row = backend.findFileByPath('minimal.mp3', 'Music');
      assert.equal(row.title, null);
      assert.equal(row.artist, null);
      assert.equal(row.hash, null);
      assert.equal(row.bpm_source, null);
    });

    it('removes a row by (filepath, vpath) only', () => {
      backend.removeFileByPath('Rock/song.mp3', 'MusicA');
      assert.equal(backend.findFileByPath('Rock/song.mp3', 'MusicA'), null);
      assert.ok(backend.findFileByPath('Rock/song.mp3', 'MusicB'));
    });
  });

  describe('user_metadata table', () => {
    before(() => {
      backend.insertUserMetadata({ hash: 'hash1', user: 'alice', rating: 5, pc: 42 });
      backend.insertUserMetadata({ hash: 'hash1', user: 'bob', rating: 3, pc: 7 });
      backend.insertUserMetadata({ hash: 'hash2', user: 'alice', pc: 1 });
    });

    it('stores per-user metadata independently', () => {
      const alice = backend.findUserMetadata('hash1', 'alice');
      const bob = backend.findUserMetadata('hash1', 'bob');
      assert.equal(alice.rating, 5);
      assert.equal(alice.pc, 42);
      assert.equal(bob.rating, 3);
      assert.equal(bob.pc, 7);
      assert.equal(backend.findUserMetadata('hash2', 'bob'), null);
    });

    it('rejects a duplicate (hash, user) pair', () => {
      assert.throws(() => backend.insertUserMetadata({ hash: 'hash1', user: 'alice', pc: 99 }), /UNIQUE constraint/);
    });

    it('updates an existing row in place', () => {
      backend.updateUserMetadata({ hash: 'hash1', user: 'alice', rating: 5, pc: 50 });
      assert.equal(backend.findUserMetadata('hash1', 'alice').pc, 50);
      assert.equal(backend.findUserMetadata('hash1', 'bob').pc, 7);
    });
  });

  describe('user_settings table', () => {
    it('stores and retrieves JSON prefs', () => {
      backend.saveUserSettings('dennis', { prefs: { theme: 'dark', lang: 'nl' } });
      const { prefs, queue } = backend.getUserSettings('dennis');
      assert.equal(prefs.theme, 'dark');
      assert.equal(prefs.lang, 'nl');
      assert.equal(queue, null);
    });

    it('merges prefs and keeps one row per username', () => {
      backend.saveUserSettings('dennis', { prefs: { lang: 'de' }, queue: { idx: 2 } });
      const s = backend.getUserSettings('dennis');
      assert.deepEqual(s.prefs, { theme: 'dark', lang: 'de' });
      assert.deepEqual(s.queue, { idx: 2 });
      const n = backend.getDB().prepare('SELECT COUNT(*) AS n FROM user_settings WHERE username = ?').get('dennis').n;
      assert.equal(n, 1);
    });

    it('returns defaults for an unknown user', () => {
      assert.deepEqual(backend.getUserSettings('nobody'), { prefs: {}, queue: null });
    });
  });
});
