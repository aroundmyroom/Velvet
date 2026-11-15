'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const COLS = ['title', 'artist', 'album', 'filepath'];

describe('FTS5 search (src/db/sqlite-backend.js searchFiles / searchFilesAllWords)', () => {
  let backend, workDir;
  const titles = rows => rows.map(r => r.title).sort();

  before(async () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fts5-search-'));
    backend = await import('../../src/db/sqlite-backend.js');
    backend.init(workDir);
    const songs = [
      { title: 'Bohemian Rhapsody', artist: 'Queen', album: 'A Night at the Opera', filepath: 'queen/bohemian.mp3' },
      { title: 'Another One Bites the Dust', artist: 'Queen', album: 'The Game', filepath: 'queen/another.mp3' },
      { title: 'Stairway to Heaven', artist: 'Led Zeppelin', album: 'Led Zeppelin IV', filepath: 'zeppelin/stairway.mp3' },
      { title: 'Dream On', artist: 'Aerosmith', album: 'Aerosmith', filepath: 'aerosmith/dream-on.mp3' },
      { title: 'Paranoid Android', artist: 'Radiohead', album: 'OK Computer', filepath: 'radiohead/paranoid.mp3' },
      { title: 'Norwegian Wood', artist: 'The Beatles', album: 'Rubber Soul', filepath: 'beatles/norwegian-wood.mp3' },
      { title: 'Hey Jude', artist: 'The Beatles', album: 'Hey Jude', filepath: 'Albums/beatles/hey-jude.mp3' },
      { title: 'Café del Mar', artist: 'Energy 52', album: 'Café del Mar', filepath: 'energy/cafe.mp3' },
      { title: 'Bohemian Like You', artist: 'The Dandy Warhols', album: 'Thirteen Tales', filepath: 'dandy/bohemian.mp3', vpath: 'Other' },
    ];
    for (const s of songs) backend.insertFile({ vpath: 'Music', duration: 240, ...s });
  });

  after(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  describe('basic search', () => {
    it('finds a song by its exact title', () => {
      const rows = backend.searchFiles('title', 'Bohemian Rhapsody', ['Music'], []);
      assert.deepEqual(titles(rows), ['Bohemian Rhapsody']);
    });

    it('finds every song by an artist', () => {
      assert.deepEqual(titles(backend.searchFiles('artist', 'Queen', ['Music'], [])), ['Another One Bites the Dust', 'Bohemian Rhapsody']);
    });

    it('finds a song by album name', () => {
      const rows = backend.searchFiles('album', 'OK Computer', ['Music'], []);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].album, 'OK Computer');
    });

    it('matches across several columns when given a column set', () => {
      assert.deepEqual(titles(backend.searchFiles(COLS, 'Aerosmith', ['Music'], [])), ['Dream On']);
    });

    it('is a prefix search', () => {
      assert.deepEqual(titles(backend.searchFiles('title', 'Para', ['Music'], [])), ['Paranoid Android']);
    });

    it('is case-insensitive', () => {
      const upper = backend.searchFiles('artist', 'QUEEN', ['Music'], []);
      const lower = backend.searchFiles('artist', 'queen', ['Music'], []);
      assert.equal(upper.length, 2);
      assert.equal(lower.length, upper.length);
    });

    it('ignores diacritics', () => {
      assert.deepEqual(titles(backend.searchFiles('title', 'cafe', ['Music'], [])), ['Café del Mar']);
    });
  });

  describe('operators', () => {
    it('requires every word to match somewhere across the columns (AND)', () => {
      assert.deepEqual(titles(backend.searchFilesAllWords(['Beatles', 'Norwegian'], ['Music'], [])), ['Norwegian Wood']);
    });

    it('excludes negative terms (NOT)', () => {
      assert.deepEqual(backend.searchFiles(COLS, 'Heaven', ['Music'], [], null, null, ['Led']), []);
      assert.deepEqual(titles(backend.searchFiles('artist', 'Queen', ['Music'], [], null, null, ['Dust'])), ['Bohemian Rhapsody']);
    });

    it('treats FTS5 syntax in the term as literal text', () => {
      assert.deepEqual(backend.searchFiles(COLS, 'Queen OR Aerosmith', ['Music'], []), []);
      assert.doesNotThrow(() => backend.searchFiles(COLS, 'he said "hi" (*)', ['Music'], []));
    });
  });

  describe('scoping', () => {
    it('only returns rows from the given vpaths', () => {
      assert.deepEqual(titles(backend.searchFiles('title', 'Bohemian', ['Music'], [])), ['Bohemian Rhapsody']);
      assert.deepEqual(titles(backend.searchFiles('title', 'Bohemian', ['Music', 'Other'], [])), ['Bohemian Like You', 'Bohemian Rhapsody']);
      assert.deepEqual(titles(backend.searchFiles('title', 'Bohemian', ['Music', 'Other'], ['Other'])), ['Bohemian Rhapsody']);
    });

    it('limits to a filepath prefix (child vpath pattern)', () => {
      assert.deepEqual(titles(backend.searchFiles('artist', 'Beatles', ['Music'], [], 'Albums/')), ['Hey Jude']);
    });

    it('drops excluded filepath prefixes (child vpath exclusion pattern)', () => {
      const rows = backend.searchFiles('artist', 'Beatles', ['Music'], [], null, [{ vpath: 'Music', prefix: 'Albums/' }]);
      assert.deepEqual(titles(rows), ['Norwegian Wood']);
    });

    it('returns nothing for an empty vpath list', () => {
      assert.deepEqual(backend.searchFiles('title', 'Bohemian', [], []), []);
    });

    it('rejects unknown columns instead of building SQL from them', () => {
      assert.deepEqual(backend.searchFiles('title) OR 1=1 --', 'x', ['Music'], []), []);
      assert.deepEqual(backend.searchFiles(['title', 'hash'], 'x', ['Music'], []), []);
    });

    it('honours the row limit', () => {
      assert.equal(backend.searchFiles(COLS, 'the', ['Music'], [], null, null, [], 2).length, 2);
    });
  });

  describe('index maintenance', () => {
    it('drops a removed file from the index', () => {
      backend.insertFile({ vpath: 'Music', filepath: 'tmp/zyzzyva.mp3', title: 'Zyzzyva' });
      assert.equal(backend.searchFiles('title', 'Zyzzyva', ['Music'], []).length, 1);
      backend.removeFileByPath('tmp/zyzzyva.mp3', 'Music');
      assert.equal(backend.searchFiles('title', 'Zyzzyva', ['Music'], []).length, 0);
    });
  });
});
