/**
 * Integration tests for the Subsonic API layer.
 *
 * Each describe block spins up a fresh isolated server instance. Tests use
 * JSON format (?f=json) throughout for easy assertion without XML parsing.
 *
 * Run with:
 *   node --test test/subsonic.test.mjs
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startServer } from './helpers/server.mjs';
import { ensureFixtures } from './helpers/fixtures.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a Subsonic query-string parameter set.
 * Defaults to the test user created by startServer with users=[ALICE].
 */
function qs(extra = {}, { u = 'alice', p = 'alice123' } = {}) {
  const params = new URLSearchParams({ u, p, v: '1.16.1', c: 'velvet-test', f: 'json', ...extra });
  return '?' + params.toString();
}

function subUrl(base, action, extra = {}, auth = {}) {
  return `${base}/rest/${action}${qs(extra, auth)}`;
}

async function subGet(base, action, extra = {}, auth = {}) {
  const r = await fetch(subUrl(base, action, extra, auth));
  assert.ok(r.ok, `HTTP ${r.status} for ${action}`);
  const j = await r.json();
  return j['subsonic-response'];
}

const ALICE = { username: 'alice', password: 'alice123' };

// ---------------------------------------------------------------------------
// Suite: basic connectivity and auth
// ---------------------------------------------------------------------------

describe('Subsonic – ping and auth', () => {
  let srv;

  before(async () => {
    srv = await startServer({ users: [ALICE] });
  });

  after(async () => { await srv.stop(); });

  it('ping returns ok', async () => {
    const sr = await subGet(srv.subsonicBaseUrl, 'ping');
    assert.equal(sr.status, 'ok');
    assert.ok(sr.version);
    assert.ok(sr.openSubsonic);
  });

  it('wrong password returns auth error', async () => {
    const r = await fetch(subUrl(srv.subsonicBaseUrl, 'ping', {}, { u: 'alice', p: 'wrong' }));
    assert.ok(r.ok);
    const j = await r.json();
    assert.equal(j['subsonic-response'].status, 'failed');
    assert.equal(j['subsonic-response'].error.code, 40);
  });

  it('unknown user returns auth error', async () => {
    const r = await fetch(subUrl(srv.subsonicBaseUrl, 'ping', {}, { u: 'nobody', p: 'x' }));
    assert.ok(r.ok);
    const j = await r.json();
    assert.equal(j['subsonic-response'].status, 'failed');
    assert.equal(j['subsonic-response'].error.code, 40);
  });

  it('getMusicFolders returns configured vpaths', async () => {
    const sr = await subGet(srv.subsonicBaseUrl, 'getMusicFolders');
    assert.equal(sr.status, 'ok');
    const folders = [].concat(sr.musicFolders?.musicFolder ?? []);
    assert.ok(folders.length >= 1, 'at least one music folder');
    assert.ok(folders.some(f => typeof f.name === 'string'));
  });
});

// ---------------------------------------------------------------------------
// Suite: library browsing
// ---------------------------------------------------------------------------

describe('Subsonic – library browsing', () => {
  let srv;

  before(async () => {
    srv = await startServer({ users: [ALICE] });
  });

  after(async () => { await srv.stop(); });

  it('getArtists returns at least Artist A and Artist B', async () => {
    const sr = await subGet(srv.subsonicBaseUrl, 'getArtists');
    assert.equal(sr.status, 'ok');
    const index = [].concat(sr.artists?.index ?? []);
    const names = index.flatMap(idx => [].concat(idx.artist ?? []).map(a => a.name));
    assert.ok(names.includes('Artist A'), `expected "Artist A" in ${JSON.stringify(names)}`);
    assert.ok(names.includes('Artist B'), `expected "Artist B" in ${JSON.stringify(names)}`);
  });

  it('getAlbumList2 alphabetical returns albums', async () => {
    const sr = await subGet(srv.subsonicBaseUrl, 'getAlbumList2', { type: 'alphabeticalByName', size: 20 });
    assert.equal(sr.status, 'ok');
    const albums = [].concat(sr.albumList2?.album ?? []);
    assert.ok(albums.length >= 3, `expected >=3 albums, got ${albums.length}`);
    const names = albums.map(a => a.name);
    assert.ok(names.includes('Album X'), `expected Album X in ${JSON.stringify(names)}`);
    assert.ok(names.includes('Album Y'), `expected Album Y in ${JSON.stringify(names)}`);
    assert.ok(names.includes('Album Z'), `expected Album Z in ${JSON.stringify(names)}`);
  });

  it('getAlbumList2 pagination: offset skips albums', async () => {
    const page0 = await subGet(srv.subsonicBaseUrl, 'getAlbumList2', { type: 'alphabeticalByName', size: 1, offset: 0 });
    const page1 = await subGet(srv.subsonicBaseUrl, 'getAlbumList2', { type: 'alphabeticalByName', size: 1, offset: 1 });
    const name0 = [].concat(page0.albumList2?.album ?? [])[0]?.name;
    const name1 = [].concat(page1.albumList2?.album ?? [])[0]?.name;
    assert.notEqual(name0, name1, 'page 0 and page 1 should return different albums');
  });

  it('getAlbumList2 newest returns albums', async () => {
    const sr = await subGet(srv.subsonicBaseUrl, 'getAlbumList2', { type: 'newest', size: 10 });
    assert.equal(sr.status, 'ok');
    const albums = [].concat(sr.albumList2?.album ?? []);
    assert.ok(albums.length >= 3);
  });

  it('getArtist returns albums for Artist A', async () => {
    // First resolve Artist A's ID via getArtists
    const listSr = await subGet(srv.subsonicBaseUrl, 'getArtists');
    const index  = [].concat(listSr.artists?.index ?? []);
    const allArtists = index.flatMap(idx => [].concat(idx.artist ?? []));
    const artistA = allArtists.find(a => a.name === 'Artist A');
    assert.ok(artistA, 'Artist A not found');

    const sr = await subGet(srv.subsonicBaseUrl, 'getArtist', { id: artistA.id });
    assert.equal(sr.status, 'ok');
    const artistAlbums = [].concat(sr.artist?.album ?? []);
    const albumNames = artistAlbums.map(a => a.name);
    assert.ok(albumNames.includes('Album X'), `expected Album X in ${JSON.stringify(albumNames)}`);
    assert.ok(albumNames.includes('Album Z'), `expected Album Z in ${JSON.stringify(albumNames)}`);
    assert.ok(!albumNames.includes('Album Y'), 'Album Y belongs to Artist B, not A');
  });

  it('search3 finds tracks by title', async () => {
    const sr = await subGet(srv.subsonicBaseUrl, 'search3', { query: 'Track One', songCount: 5 });
    assert.equal(sr.status, 'ok');
    const songs = [].concat(sr.searchResult3?.song ?? []);
    assert.ok(songs.some(s => s.title === 'Track One'), `expected "Track One" in results`);
  });

  it('getRandomSongs returns songs', async () => {
    const sr = await subGet(srv.subsonicBaseUrl, 'getRandomSongs', { size: 10 });
    assert.equal(sr.status, 'ok');
    const songs = [].concat(sr.randomSongs?.song ?? []);
    assert.ok(songs.length >= 1, 'expected at least one random song');
  });
});

// ---------------------------------------------------------------------------
// Suite: albumsOnly filtering
// ---------------------------------------------------------------------------

describe('Subsonic – albumsOnly filtering', () => {
  let srv;
  let musicDir;

  before(async () => {
    musicDir = await ensureFixtures();
    // Two library mounts:
    //   main:     the whole fixture tree (Artist A + Artist B)
    //   curated:  only the "Artist A" sub-folder, marked albumsOnly
    // getAlbumList2 should only return albums from "curated" (Artist A only).
    // Alice must have vpaths matching the folder names used here.
    srv = await startServer({
      users: [{ ...ALICE, vpaths: ['main', 'curated'] }],
      extraConfig: {
        folders: {
          main:    { root: musicDir },
          curated: { root: path.join(musicDir, 'Artist A'), albumsOnly: true },
        },
      },
    });
  });

  after(async () => { await srv.stop(); });

  it('getMusicFolders lists both vpaths', async () => {
    const sr = await subGet(srv.subsonicBaseUrl, 'getMusicFolders');
    const folders = [].concat(sr.musicFolders?.musicFolder ?? []);
    const names = folders.map(f => f.name);
    assert.ok(names.includes('main'),    `expected "main" in ${JSON.stringify(names)}`);
    assert.ok(names.includes('curated'), `expected "curated" in ${JSON.stringify(names)}`);
  });

  it('getAlbumList2 returns all albums across vpaths (albumsOnly does not filter global list)', async () => {
    const sr = await subGet(srv.subsonicBaseUrl, 'getAlbumList2', { type: 'alphabeticalByName', size: 50 });
    assert.equal(sr.status, 'ok');
    const albums = [].concat(sr.albumList2?.album ?? []);
    const names  = albums.map(a => a.name);

    // All albums from all user vpaths must appear — albumsOnly scoping is intentionally
    // disabled for the global Subsonic album list (see subsonic.js resolveAlbumListScope).
    assert.ok(names.includes('Album X'), `expected Album X in ${JSON.stringify(names)}`);
    assert.ok(names.includes('Album Z'), `expected Album Z in ${JSON.stringify(names)}`);
    assert.ok(names.includes('Album Y'), `expected Album Y in ${JSON.stringify(names)}`);
  });

  it('getAlbumList2 newest returns all albums across vpaths', async () => {
    const sr = await subGet(srv.subsonicBaseUrl, 'getAlbumList2', { type: 'newest', size: 50 });
    assert.equal(sr.status, 'ok');
    const names = [].concat(sr.albumList2?.album ?? []).map(a => a.name);
    assert.ok(names.length >= 3, `expected at least 3 albums (Album X, Album Y, Album Z), got ${JSON.stringify(names)}`);
    assert.ok(names.includes('Album Y'), `expected Album Y in ${JSON.stringify(names)}`);
  });
});

// ---------------------------------------------------------------------------
// Suite: scrobble (no nested-transaction crash)
// ---------------------------------------------------------------------------

describe('Subsonic – scrobble', () => {
  let srv;

  before(async () => {
    srv = await startServer({ users: [ALICE] });
  });

  after(async () => { await srv.stop(); });

  it('scrobble an existing song without error', async () => {
    // Resolve a real song ID first
    const listSr = await subGet(srv.subsonicBaseUrl, 'getAlbumList2', { type: 'newest', size: 1 });
    const album  = [].concat(listSr.albumList2?.album ?? [])[0];
    assert.ok(album, 'need at least one album to scrobble');

    const albumSr = await subGet(srv.subsonicBaseUrl, 'getAlbum', { id: album.id });
    const song    = [].concat(albumSr.album?.song ?? [])[0];
    assert.ok(song, 'need at least one song to scrobble');

    const r = await fetch(subUrl(srv.subsonicBaseUrl, 'scrobble', { id: song.id, submission: 'true' }));
    assert.ok(r.ok, `HTTP ${r.status}`);
    const j = await r.json();
    assert.equal(j['subsonic-response'].status, 'ok', JSON.stringify(j));
  });

  it('rapid repeated scrobbles do not crash the server', async () => {
    const listSr = await subGet(srv.subsonicBaseUrl, 'getAlbumList2', { type: 'newest', size: 1 });
    const album  = [].concat(listSr.albumList2?.album ?? [])[0];
    const albumSr = await subGet(srv.subsonicBaseUrl, 'getAlbum', { id: album.id });
    const song    = [].concat(albumSr.album?.song ?? [])[0];
    assert.ok(song);

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        fetch(subUrl(srv.subsonicBaseUrl, 'scrobble', { id: song.id, submission: 'true' }))
          .then(r => r.json())
      )
    );
    for (const j of results) {
      assert.equal(j['subsonic-response'].status, 'ok', JSON.stringify(j));
    }
  });
});

// ---------------------------------------------------------------------------
// Suite: playlists
// ---------------------------------------------------------------------------

describe('Subsonic – playlists', () => {
  let srv;

  before(async () => {
    srv = await startServer({ users: [ALICE] });
  });

  after(async () => { await srv.stop(); });

  it('getPlaylists returns empty list initially', async () => {
    const sr = await subGet(srv.subsonicBaseUrl, 'getPlaylists');
    assert.equal(sr.status, 'ok');
    const lists = [].concat(sr.playlists?.playlist ?? []);
    assert.equal(lists.length, 0);
  });

  it('createPlaylist, getPlaylists, deletePlaylist round-trip', async () => {
    // Create
    const createSr = await subGet(srv.subsonicBaseUrl, 'createPlaylist', { name: 'Test List' });
    assert.equal(createSr.status, 'ok');

    // List
    const listSr = await subGet(srv.subsonicBaseUrl, 'getPlaylists');
    const lists  = [].concat(listSr.playlists?.playlist ?? []);
    const created = lists.find(p => p.name === 'Test List');
    assert.ok(created, 'created playlist not found in getPlaylists');

    // Delete
    const r = await fetch(subUrl(srv.subsonicBaseUrl, 'deletePlaylist', { id: created.id }));
    assert.ok(r.ok);
    const j = await r.json();
    assert.equal(j['subsonic-response'].status, 'ok');

    // Confirm gone
    const afterSr = await subGet(srv.subsonicBaseUrl, 'getPlaylists');
    const after   = [].concat(afterSr.playlists?.playlist ?? []);
    assert.ok(!after.some(p => p.name === 'Test List'), 'playlist should be deleted');
  });
});

// ---------------------------------------------------------------------------
// Suite: play queue (savePlayQueue / getPlayQueue)
// ---------------------------------------------------------------------------

describe('Subsonic – play queue', () => {
  let srv;

  before(async () => {
    srv = await startServer({ users: [ALICE] });
  });

  after(async () => { await srv.stop(); });

  // Collect a few real song ids (canonical "<hash>@<rowid>" form) from the library.
  async function collectSongs(min) {
    const listSr = await subGet(srv.subsonicBaseUrl, 'getAlbumList2', { type: 'alphabeticalByName', size: 50 });
    const albums = [].concat(listSr.albumList2?.album ?? []);
    const songs = [];
    for (const al of albums) {
      const aSr = await subGet(srv.subsonicBaseUrl, 'getAlbum', { id: al.id });
      songs.push(...[].concat(aSr.album?.song ?? []));
      if (songs.length >= min) break;
    }
    return songs;
  }

  function savePlayQueueUrl(ids, current, position) {
    const p = new URLSearchParams({ u: 'alice', p: 'alice123', v: '1.16.1', c: 'feishin-test', f: 'json' });
    for (const id of ids) p.append('id', id);
    if (current != null) p.set('current', current);
    if (position != null) p.set('position', String(position));
    return `${srv.subsonicBaseUrl}/rest/savePlayQueue?${p.toString()}`;
  }

  const bareHash = id => (id.includes('@') ? id.slice(0, id.indexOf('@')) : id);

  // The Feishin bug: a queue saved by an older client used bare-hash ids, but
  // getPlayQueue rebuilt entries as "<hash>@<rowid>". The returned `current` then
  // matched none of the entry ids, so Feishin lost its place and stopped advancing.
  it('legacy bare-hash queue restores a current that matches an entry id', async () => {
    const songs = await collectSongs(3);
    assert.ok(songs.length >= 3, 'fixtures need at least 3 songs');
    const legacyIds = songs.slice(0, 3).map(s => bareHash(s.id));
    const current   = legacyIds[1];

    const saveJson = await (await fetch(savePlayQueueUrl(legacyIds, current, 4242))).json();
    assert.equal(saveJson['subsonic-response'].status, 'ok', JSON.stringify(saveJson));

    const sr = await subGet(srv.subsonicBaseUrl, 'getPlayQueue');
    assert.equal(sr.status, 'ok');
    const pq = sr.playQueue;
    const entries = [].concat(pq.entry ?? []);
    assert.equal(entries.length, 3, 'all three tracks restored');

    const entryIds = entries.map(e => e.id);
    assert.ok(entryIds.includes(pq.current),
      `current "${pq.current}" must be one of the entry ids ${JSON.stringify(entryIds)}`);
    assert.equal(bareHash(pq.current), current, 'current still points at the saved track');
    assert.equal(Number(pq.position), 4242, 'position preserved when current is valid');
  });

  it('falls back to head of queue when the saved current is unresolvable', async () => {
    const songs = await collectSongs(2);
    assert.ok(songs.length >= 2, 'fixtures need at least 2 songs');
    const ids   = songs.slice(0, 2).map(s => s.id);
    const bogus = 'deadbeefdeadbeefdeadbeefdeadbeef';

    const saveJson = await (await fetch(savePlayQueueUrl(ids, bogus, 9999))).json();
    assert.equal(saveJson['subsonic-response'].status, 'ok', JSON.stringify(saveJson));

    const sr = await subGet(srv.subsonicBaseUrl, 'getPlayQueue');
    const pq = sr.playQueue;
    const entries = [].concat(pq.entry ?? []);
    assert.equal(entries.length, 2);
    assert.equal(pq.current, entries[0].id, 'current falls back to the first entry');
    assert.equal(Number(pq.position), 0, 'position reset when current is dropped');
  });
});
