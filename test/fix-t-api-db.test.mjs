import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('t-api: queries moved into src/db', () => {
  let backend, dir, raw;
  const file = (o) => raw.prepare(
    `INSERT INTO files (vpath, filepath, hash, audio_hash, format, artist, title, album, duration, genre, genre_lastfm, genre_mb, genre_discogs,
       genre_enrich_lastfm, genre_enrich_mb, genre_enrich_discogs, replaygainTrackDb)
     VALUES (@vpath, @filepath, @hash, @audio_hash, 'mp3', @artist, @title, 'A', @duration, @genre, @lf, @mb, @dg, @slf, @smb, @sdg, @rg)`
  ).run({ vpath: 'M', hash: null, audio_hash: null, artist: 'x', title: 't', duration: 200, genre: null,
    lf: null, mb: null, dg: null, slf: 'ok', smb: 'ok', sdg: 'ok', rg: null, ...o });

  before(async () => {
    backend = await import('../src/db/sqlite-backend.js');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'velvet-tapi-db-'));
    backend.init(dir);
    backend.genreEnricherMigrate();
    raw = backend.getDB();
    file({ filepath: 'a/1.mp3', hash: 'h1', artist: 'Maj', lf: 'house', mb: 'House', dg: null, sdg: 'nf', rg: -6.5 });
    file({ filepath: 'a/2.mp3', hash: 'h1', artist: 'Con', lf: 'pop', mb: 'pop', dg: 'Pop' });
    file({ filepath: 'Albums/b/3.mp3', hash: 'h3', artist: 'Short', duration: 30 });
    file({ filepath: 'b/4.mp3', hash: 'h4', artist: 'Other', vpath: 'N' });
  });
  after(() => { backend.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  it('genre enricher: majority and consensus apply the agreed genre', () => {
    const stats = backend.genreEnricherStats();
    assert.equal(stats.majority, 1);
    assert.equal(stats.consensus, 1);
    assert.equal(backend.genreEnricherApplyMajority(), 1);
    assert.equal(backend.genreEnricherApplyConsensus(), 1);
    const g = raw.prepare('SELECT artist, genre, genre_user_reviewed r FROM files WHERE artist IN (?, ?) ORDER BY artist').all('Con', 'Maj');
    assert.deepEqual(g.map(x => [x.artist, x.genre, x.r]), [['Con', 'pop', 1], ['Maj', 'house', 1]]);
  });

  it('genre enricher: reset-all keeps the review flag and the genre', () => {
    backend.genreEnricherResetAll();
    const r = raw.prepare("SELECT genre, genre_user_reviewed r, genre_lastfm FROM files WHERE artist = 'Con'").get();
    assert.deepEqual([r.genre, r.r, r.genre_lastfm], ['pop', 1, null]);
  });

  it('duplicate workshop: exact groups by file hash', () => {
    const groups = backend.dupExactGroups();
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0].paths.split('||').sort(), ['M/a/1.mp3', 'M/a/2.mp3']);
    assert.deepEqual(backend.dupHashesForPaths(['M/a/1.mp3', 'N/b/4.mp3']).sort(), ['h1', 'h4']);
  });

  it('DLNA tracks are limited to the DLNA sources (vpath + prefix)', () => {
    const rows = backend.getDlnaTracks([{ dbVpath: 'M', prefix: 'Albums/' }]);
    assert.deepEqual(rows.map(r => r.filepath), ['Albums/b/3.mp3']);
    assert.equal(backend.getDlnaTracks([]).length, 0);
  });

  it('random single pick counts respect the duration window', () => {
    assert.equal(backend.countFilesForRandom(['M'], 'u', {}), 3);
    assert.equal(backend.countFilesForRandom(['M'], 'u', { maxDuration: 60 }), 1);
    assert.equal(backend.countFilesForRandom(['M'], 'u', { minDuration: 100 }), 2);
  });

  it('ReplayGain status counts files with a ReplayGain tag', () => {
    assert.equal(backend.getRgStatus().has_tags, 1);
  });

  it('artist search with an empty folder list finds nothing', () => {
    const id = raw.prepare("INSERT INTO artists_normalized (artist_clean, artist_raw_variants, vpaths_json) VALUES ('Zebra Band', '[\"Zebra Band\"]', '[\"M\"]')").run().lastInsertRowid;
    raw.prepare('INSERT INTO fts_artists (rowid, artist_clean) VALUES (?, ?)').run(id, 'Zebra Band');
    assert.equal(backend.searchArtistsNormalized('Zebra', ['M']).length, 1);
    assert.equal(backend.searchArtistsNormalized('Zebra', ['N']).length, 0);
    assert.equal(backend.searchArtistsNormalized('Zebra', []).length, 0);
  });

  it('migration v6 converts last-played stored in seconds to ms, once', () => {
    raw.prepare("INSERT INTO user_metadata (hash, user, pc, lp) VALUES ('h9', 'u', 1, 1700000000)").run();
    raw.exec('PRAGMA user_version = 5');
    backend.close();
    backend.init(dir);
    raw = backend.getDB();
    assert.equal(raw.prepare("SELECT lp FROM user_metadata WHERE hash = 'h9'").get().lp, 1700000000000);
    assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 6);
    raw.prepare("INSERT INTO user_metadata (hash, user, pc, lp) VALUES ('h10', 'u', 1, 5)").run();
    backend.close();
    backend.init(dir);
    raw = backend.getDB();
    assert.equal(raw.prepare("SELECT lp FROM user_metadata WHERE hash = 'h10'").get().lp, 5);
  });
});

describe('t-api: shared helpers', () => {
  it('xmlEscape keeps emoji, drops lone surrogates and XML-illegal controls', async () => {
    const { xmlEscape } = await import('../src/util/xml.js');
    assert.equal(xmlEscape('a🎵&<b>'), 'a🎵&amp;&lt;b&gt;');
    assert.equal(xmlEscape('x\uD800y\u0001z￾'), 'xyz');
    assert.equal(xmlEscape(null), '');
  });

  it('rootFolders keeps only vpaths that are not inside another vpath', async () => {
    const { rootFolders } = await import('../src/util/vpath.js');
    assert.deepEqual(rootFolders({
      Music: { root: '/m' }, Child: { root: '/m/kids' }, Same: { root: '/m' }, Other: { root: '/o' },
    }), { Music: '/m', Same: '/m', Other: '/o' });
  });
});
