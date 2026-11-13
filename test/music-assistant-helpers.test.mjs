/**
 * Helpers behind the Subsonic answers Music Assistant relies on: structured
 * lyrics (src/util/song-lyrics.js), top songs (src/util/top-songs.js) and the
 * in-memory similar-artist name resolution (sqlite-backend
 * resolveArtistNamesForDJ), checked against the per-name SQL it replaced.
 *
 * Run with:
 *   node --test test/music-assistant-helpers.test.mjs
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { parseLrc, lyricsFromTags, readLyricsCache, songLyrics } from '../src/util/song-lyrics.js';
import { rankTopSongs, titleKey } from '../src/util/top-songs.js';

describe('Structured lyrics', () => {
  it('parses LRC into synced lines in milliseconds, applying [offset]', () => {
    const l = parseLrc('[ar:Someone]\n[offset:+500]\n[00:01.50]One\n[00:03.25][00:10.00]Two\n');
    assert.equal(l.synced, true);
    assert.deepEqual(l.line, [{ start: 1000, value: 'One' }, { start: 2750, value: 'Two' }, { start: 9500, value: 'Two' }]);
    assert.equal(l.offset, undefined);
  });

  it('keeps plain text as unsynced lines', () => {
    const l = parseLrc('Line one\n\n[Chorus]\nLine two');
    assert.equal(l.synced, false);
    assert.deepEqual(l.line.map(x => x.value), ['Line one', '[Chorus]', 'Line two']);
  });

  it('reads music-metadata lyrics tags (objects, not strings)', () => {
    const out = lyricsFromTags([
      { text: 'plain words', syncText: [], timeStampFormat: 0, language: 'eng' },
      { syncText: [{ text: 'hello', timestamp: 1200 }, { text: 'world', timestamp: 2400 }], timeStampFormat: 2 },
      { text: '[00:05.00]lrc inside a text tag', syncText: [] },
    ]);
    assert.deepEqual(out.map(l => l.synced), [false, true, true]);
    assert.equal(out[0].lang, 'eng');
    assert.deepEqual(out[0].line, [{ value: 'plain words' }]);
    assert.deepEqual(out[1].line, [{ start: 1200, value: 'hello' }, { start: 2400, value: 'world' }]);
    assert.deepEqual(out[2].line, [{ start: 5000, value: 'lrc inside a text tag' }]);
  });

  describe('files', () => {
    let dir;
    before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'velvet-lyrics-')); });
    after(() => fs.rmSync(dir, { recursive: true, force: true }));

    it("reads the web player's lrclib cache with the same key", () => {
      const key = crypto.createHash('sha256').update('Artist||Title||200').digest('hex');
      fs.writeFileSync(path.join(dir, key + '.json'), JSON.stringify({ synced: true, lines: [{ time: 1.5, text: 'a' }] }));
      assert.deepEqual(readLyricsCache(dir, 'Artist', 'Title', 199.6).line, [{ start: 1500, value: 'a' }]);
      assert.equal(readLyricsCache(dir, 'Other', 'Title', 200), null);
    });

    it('prefers a sidecar .lrc and puts synced lyrics first', async () => {
      const audio = path.join(dir, 'song.mp3');
      fs.writeFileSync(audio, 'not really audio');
      fs.writeFileSync(path.join(dir, 'song.lrc'), '[00:02.00]From the sidecar');
      const found = await songLyrics({ fullPath: audio, artist: 'A', title: 'T', duration: 10, cacheDir: dir });
      assert.equal(found[0].synced, true);
      assert.equal(found[0].line[0].value, 'From the sidecar');
      assert.equal(found[0].displayArtist, 'A');
      assert.equal(found[0].displayTitle, 'T');
    });
  });
});

describe('Top songs', () => {
  const r = (id, title, o = {}) => ({ id, title, album: 'X', year: 1980, totalPlays: 0, ...o });

  it('blends Velvet plays with Last.fm rank and keeps one copy per title', () => {
    const rows = [
      r(1, 'Hot Stuff', { totalPlays: 10 }),
      r(2, 'Hot Stuff (12" Version)', { totalPlays: 3 }),
      r(3, 'Bad Girls', { totalPlays: 2 }),
      r(4, 'I Feel Love'),
      r(5, 'Deep Cut'),
    ];
    const lastfm = [{ title: 'I Feel Love', rank: 1 }, { title: 'Hot Stuff', rank: 2 }, { title: 'Bad Girls', rank: 3 }];
    const top = rankTopSongs(rows, lastfm, 10);
    assert.deepEqual(top.map(x => x.id), [1, 3, 4, 5]);
  });

  it('falls back to the user rating and album order without plays or Last.fm', () => {
    const rows = [r(1, 'B', { track: 2 }), r(2, 'A', { track: 1 }), r(3, 'C', { rating: 10 })];
    assert.deepEqual(rankTopSongs(rows, [], 10).map(x => x.id), [3, 2, 1]);
    assert.equal(rankTopSongs(rows, [], 1).length, 1);
  });

  it('normalises titles for matching', () => {
    assert.equal(titleKey('Hot Stuff (Remastered 2004) - Single Version'), 'hot stuff');
    assert.equal(titleKey('Café del Mar [Energy 52 Mix]'), 'cafe del mar');
  });
});

describe('Similar-artist name resolution', () => {
  let dir, backend;
  const NAMES = [
    ['Chic', ['Chic', 'CHIC']],
    ['Earth, Wind & Fire', ['Earth, Wind & Fire', 'Earth Wind and Fire']],
    ['Simon  &  Garfunkel', ['Simon & Garfunkel']],
    ['Tiësto', ['Tiësto']],
    ['Tiesto', ['Tiesto']],
    ['Kool & The Gang', ['Kool & The Gang']],
    ['Kool and The Gang', ['Kool and The Gang']],
    ['BLØF', ['BLØF']],
  ];
  const QUERIES = ['chic', 'CHIC ', 'Earth, Wind and Fire', 'earth, wind & fire', 'Simon and Garfunkel', 'Simon & Garfunkel',
    'Tiesto', 'Tiësto', 'Kool and the Gang', 'Kool & the Gang', 'bløf', 'Blof', 'Nobody'];

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'velvet-artists-'));
    backend = await import('../src/db/sqlite-backend.js');
    backend.init(dir);
    const db = new DatabaseSync(path.join(dir, 'velvet.sqlite'));
    const ins = db.prepare('INSERT INTO artists_normalized (artist_clean, artist_raw_variants) VALUES (?, ?)');
    for (const [clean, variants] of NAMES) ins.run(clean, JSON.stringify(variants));
    db.close();
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('returns what the former per-name SQL lookups returned', () => {
    const db = new DatabaseSync(path.join(dir, 'velvet.sqlite'));
    db.function('lower', { deterministic: true }, s => (s == null ? null : String(s).toLowerCase()));
    const exact = db.prepare('SELECT artist_raw_variants FROM artists_normalized WHERE lower(artist_clean) = lower(?)');
    const norm = db.prepare(`SELECT artist_raw_variants FROM artists_normalized
      WHERE replace(replace(replace(lower(trim(artist_clean)), ' & ', ' and '), '&', ' and '), '  ', ' ') = ?`);
    const normArtist = n => n.toLowerCase().replaceAll(/\s*&\s*/g, ' and ').replaceAll(/\s+/g, ' ').trim();
    for (const q of QUERIES) {
      const row = exact.get(q.trim()) || norm.get(normArtist(q));
      const legacy = new Set(row ? JSON.parse(row.artist_raw_variants) : []);
      const now = new Set(backend.resolveArtistNamesForDJ([q]));
      for (const v of legacy) assert.ok(now.has(v), `${q}: lost ${v}`);
    }
    db.close();
  });
});
