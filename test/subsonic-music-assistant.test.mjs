/**
 * The Subsonic answers Music Assistant's opensubsonic provider reads:
 * song fields + replayGain (loudness), the Auto-DJ radio behind
 * getSimilarSongs, getTopSongs, album lists, smart playlists and lyrics.
 *
 * Spins up a server on a small generated library, then writes BPM, keys,
 * loudness and plays straight into its database.
 *
 * Run with:
 *   node --test test/subsonic-music-assistant.test.mjs
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { startServer } from './helpers/server.mjs';

const execFileP = promisify(execFile);

const TRACKS = [
  { file: 'Alpha/One/01.mp3', artist: 'Alpha', album: 'One',   title: 'Seed Song',  bpm: 100, key: 'C major', genre: 'Disco', year: 1979 },
  { file: 'Alpha/One/02.mp3', artist: 'Alpha', album: 'One',   title: 'Alpha Two',  bpm: 131, key: 'A minor', genre: 'Disco', year: 1979 },
  { file: 'Beta/Two/01.mp3',  artist: 'Beta',  album: 'Two',   title: 'Beta One',   bpm: 102, key: 'G major', genre: 'Disco', year: 1980 },
  { file: 'Gamma/Three/01.mp3', artist: 'Gamma', album: 'Three', title: 'Gamma One', bpm: 140, key: 'F# minor', genre: 'Hardstyle', year: 2010 },
  { file: 'Gamma/Three/02.mp3', artist: 'Gamma', album: 'Three', title: 'Gamma Two', bpm: 104, key: 'E minor', genre: 'Funk, Soul', year: 1981 },
];

const AUTH = { u: 'mauser', p: 'ma-pass1', v: '1.16.1', c: 'Music Assistant', f: 'json' };

async function sub(base, action, extra = {}) {
  const r = await fetch(`${base}/rest/${action}?${new URLSearchParams({ ...AUTH, ...extra })}`);
  assert.ok(r.ok, `HTTP ${r.status} for ${action}`);
  return (await r.json())['subsonic-response'];
}

describe('Subsonic for Music Assistant', () => {
  let srv, lib, base, ids;

  before(async () => {
    lib = await fs.mkdtemp(path.join(os.tmpdir(), 'velvet-ma-lib-'));
    for (const t of TRACKS) {
      const dest = path.join(lib, t.file);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await execFileP('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', '1',
        '-codec:a', 'libmp3lame', '-b:a', '128k', '-id3v2_version', '3',
        '-metadata', `artist=${t.artist}`, '-metadata', `album=${t.album}`, '-metadata', `title=${t.title}`, dest]);
    }
    await fs.writeFile(path.join(lib, 'Beta/Two/01.lrc'), '[00:01.00]First line\n[00:02.50]Second line\n');

    srv = await startServer({ users: [{ username: 'mauser', password: 'ma-pass1', vpaths: ['malib'] }], extraFolders: { malib: lib } });
    base = srv.subsonicBaseUrl;

    const db = new DatabaseSync(path.join(srv.tmpDir, 'db', 'velvet.sqlite'));
    db.exec('PRAGMA busy_timeout = 5000');
    const upd = db.prepare(`UPDATE files SET bpm = ?, musical_key = ?, genre = ?, year = ?,
      rg_track_gain_db = ?, rg_true_peak_dbfs = ?, rg_album_gain_db = ?, rg_album_peak_dbfs = ?,
      mbid = ?, sample_rate = 44100, bit_depth = 16, channels = 2, bitrate = 128
      WHERE vpath = 'malib' AND filepath = ?`);
    TRACKS.forEach((t, i) => upd.run(t.bpm, t.key, t.genre, t.year, -2.5 - i, -1, -3, -0.5,
      `0000000${i}-1111-2222-3333-444444444444`, t.file));
    const hashOf = file => db.prepare("SELECT hash FROM files WHERE vpath = 'malib' AND filepath = ?").get(file).hash;
    const plays = db.prepare('INSERT INTO user_metadata (hash, user, pc, lp) VALUES (?, ?, ?, ?)');
    plays.run(hashOf('Alpha/One/02.mp3'), 'mauser', 9, 1700000000);
    plays.run(hashOf('Alpha/One/01.mp3'), 'mauser', 2, 1600000000);
    plays.run(hashOf('Gamma/Three/02.mp3'), 'mauser', 5, 1650000000);
    db.prepare('INSERT INTO smart_playlists (user, name, filters, sort, limit_n, created) VALUES (?, ?, ?, ?, ?, ?)')
      .run('mauser', 'Disco Only', JSON.stringify({ genres: ['Disco'] }), 'artist', 50, 1700000000);
    const bio = db.prepare("UPDATE artists_normalized SET bio = ?, mbid = ? WHERE artist_clean = 'Alpha'")
      .run('Alpha were a test band.', 'aaaaaaaa-1111-2222-3333-444444444444');
    if (bio.changes === 0) {
      db.prepare('INSERT INTO artists_normalized (artist_clean, artist_raw_variants, bio, mbid) VALUES (?, ?, ?, ?)')
        .run('Alpha', '["Alpha"]', 'Alpha were a test band.', 'aaaaaaaa-1111-2222-3333-444444444444');
    }
    db.close();

    const all = await sub(base, 'search3', { query: '', songCount: 50, artistCount: 0, albumCount: 0 });
    ids = Object.fromEntries(all.searchResult3.song.map(s => [s.title, s.id]));
  });

  after(async () => {
    await srv?.stop();
    if (lib) await fs.rm(lib, { recursive: true, force: true });
  });

  it('getSong carries replayGain, audio format and OpenSubsonic fields', async () => {
    const { song } = await sub(base, 'getSong', { id: ids['Seed Song'] });
    assert.deepEqual(song.replayGain, { trackGain: -2.5, trackPeak: 0.891251, albumGain: -3, albumPeak: 0.944061 });
    assert.equal(song.bpm, 100);
    assert.deepEqual(song.genres, [{ name: 'Disco' }]);
    assert.equal(song.musicBrainzId, '00000000-1111-2222-3333-444444444444');
    assert.equal(song.samplingRate, 44100);
    assert.equal(song.bitDepth, 16);
    assert.equal(song.channelCount, 2);
    assert.equal(song.bitRate, 128);
    assert.equal(song.displayArtist, 'Alpha');
    assert.deepEqual(song.artists, [{ id: song.artistId, name: 'Alpha' }]);
  });

  it('getArtist and getArtistInfo2 carry the stored biography and MusicBrainz id', async () => {
    const { song } = await sub(base, 'getSong', { id: ids['Seed Song'] });
    const { artist } = await sub(base, 'getArtist', { id: song.artistId });
    assert.equal(artist.musicBrainzId, 'aaaaaaaa-1111-2222-3333-444444444444');
    const { artistInfo2 } = await sub(base, 'getArtistInfo2', { id: song.artistId });
    assert.equal(artistInfo2.biography, 'Alpha were a test band.');
  });

  it('getSimilarSongs answers with an Auto-DJ chain: no seed, no repeats, best match first', async () => {
    const r = await sub(base, 'getSimilarSongs', { id: ids['Seed Song'], count: 10 });
    const titles = r.similarSongs.song.map(s => s.title);
    assert.equal(titles.length, 4);
    assert.ok(!titles.includes('Seed Song'));
    assert.equal(new Set(titles).size, 4);
    // Beta One: closest BPM (102), same genre and era, and not the seed's artist.
    assert.equal(titles[0], 'Beta One');
    const r2 = await sub(base, 'getSimilarSongs2', { id: ids['Seed Song'], count: 2 });
    assert.equal(r2.similarSongs2.song.length, 2);
  });

  it('getTopSongs ranks the artist by plays', async () => {
    const r = await sub(base, 'getTopSongs', { artist: 'Alpha', count: 5 });
    assert.deepEqual(r.topSongs.song.map(s => s.title), ['Alpha Two', 'Seed Song']);
  });

  it('getAlbumList2 lists albums, not songs', async () => {
    const newest = await sub(base, 'getAlbumList2', { type: 'newest', size: 10 });
    assert.equal(newest.albumList2.album.length, 3);
    const frequent = await sub(base, 'getAlbumList2', { type: 'frequent', size: 10 });
    assert.deepEqual(frequent.albumList2.album.map(a => a.name), ['One', 'Three']);
    const paged = await sub(base, 'getAlbumList2', { type: 'frequent', size: 1, offset: 1 });
    assert.deepEqual(paged.albumList2.album.map(a => a.name), ['Three']);
    const byYear = await sub(base, 'getAlbumList2', { type: 'byYear', fromYear: 2020, toYear: 1970, size: 10 });
    assert.deepEqual(byYear.albumList2.album.map(a => a.name), ['Three', 'Two', 'One']);
    const byGenre = await sub(base, 'getAlbumList2', { type: 'byGenre', genre: 'Soul', size: 10 });
    assert.deepEqual(byGenre.albumList2.album.map(a => a.name), ['Three']);
  });

  it('exposes smart playlists read-only', async () => {
    const { playlists } = await sub(base, 'getPlaylists');
    const smart = playlists.playlist.find(p => p.name === 'Disco Only');
    assert.match(smart.id, /^smart:\d+$/);
    assert.equal(smart.readonly, true);
    assert.equal(smart.songCount, 3);
    const { playlist } = await sub(base, 'getPlaylist', { id: smart.id });
    assert.deepEqual(playlist.entry.map(s => s.title).sort(), ['Alpha Two', 'Beta One', 'Seed Song']);
    const del = await sub(base, 'deletePlaylist', { id: smart.id });
    assert.equal(del.status, 'failed');
    assert.equal(del.error.code, 50);
  });

  it('getLyricsBySongId returns synced lyrics from a sidecar .lrc', async () => {
    const { lyricsList } = await sub(base, 'getLyricsBySongId', { id: ids['Beta One'] });
    const first = lyricsList.structuredLyrics[0];
    assert.equal(first.synced, true);
    assert.deepEqual(first.line, [{ start: 1000, value: 'First line' }, { start: 2500, value: 'Second line' }]);
    const none = await sub(base, 'getLyricsBySongId', { id: ids['Gamma One'] });
    assert.deepEqual(none.lyricsList.structuredLyrics, []);
  });
});
