/**
 * P013 child-collection whitelist (random-songs + smart playlists), P038 podcast progress readback,
 * P051 deleting a user removes their Subsonic API keys and other per-user rows.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

describe('m-db: collection scope, podcast progress, user delete', async () => {
  const { startServer } = await import('../helpers/server.mjs');
  const { ensureFixtures } = await import('../helpers/fixtures.mjs');
  let srv, otherDir, token;

  const call = async (method, p, body) => {
    const headers = { 'x-access-token': token };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const r = await fetch(srv.baseUrl + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    try { return { status: r.status, body: text ? JSON.parse(text) : null }; } catch { return { status: r.status, body: text }; }
  };
  const paths = songs => songs.map(s => s.filepath).sort();
  const pool = async body => {
    const r = await call('POST', '/api/v1/db/random-songs', { returnAll: true, ...body });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return paths(r.body.songs);
  };

  before(async () => {
    const fixtures = await ensureFixtures();
    otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'velvet-mdb-other-'));
    fs.copyFileSync(path.join(fixtures, 'Artist B/Album Y/01 - Track Three.mp3'), path.join(otherDir, 'Other Song.mp3'));
    srv = await startServer({
      users: [{ username: 'admin', password: 'pw-admin', vpaths: ['testlib', 'albumX', 'artistB', 'other'] }],
      extraFolders: {
        albumX: path.join(fixtures, 'Artist A/Album X'),
        artistB: path.join(fixtures, 'Artist B'),
        other: otherDir,
      },
    });
    const login = await fetch(srv.baseUrl + '/api/v1/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'pw-admin' }),
    });
    token = (await login.json()).token;
    for (const t0 = Date.now(); ;) {
      const all = await pool({});
      if (all.length >= 5) break;
      if (Date.now() - t0 > 30000) throw new Error('scan of both roots did not finish: ' + all.join(','));
      await new Promise(r => setTimeout(r, 250));
    }
  });
  after(async () => {
    await srv?.stop();
    if (otherDir) fs.rmSync(otherDir, { recursive: true, force: true });
  });

  it('two children of one parent: only their folders', async () => {
    const got = await pool({
      ignoreVPaths: ['other'],
      includeFilepathPrefixes: [{ vpath: 'testlib', prefix: 'Artist A/Album X/' }, { vpath: 'testlib', prefix: 'Artist B/' }],
    });
    assert.deepEqual(got, [
      'testlib/Artist A/Album X/01 - Track One.mp3',
      'testlib/Artist A/Album X/02 - Track Two.mp3',
      'testlib/Artist B/Album Y/01 - Track Three.mp3',
    ]);
  });

  it('a child plus another root: the child folder and the whole other root', async () => {
    const got = await pool({ includeFilepathPrefixes: [{ vpath: 'testlib', prefix: 'Artist A/Album X/' }] });
    assert.deepEqual(got, [
      'other/Other Song.mp3',
      'testlib/Artist A/Album X/01 - Track One.mp3',
      'testlib/Artist A/Album X/02 - Track Two.mp3',
    ]);
  });

  it('single pick respects the whitelist too', async () => {
    for (let i = 0; i < 6; i++) {
      const r = await call('POST', '/api/v1/db/random-songs', {
        ignoreVPaths: ['other'], includeFilepathPrefixes: [{ vpath: 'testlib', prefix: 'Artist B/' }],
      });
      assert.equal(r.status, 200);
      assert.equal(r.body.songs[0].filepath, 'testlib/Artist B/Album Y/01 - Track Three.mp3');
    }
  });

  it('a malformed includeFilepathPrefixes is rejected, not a 500', async () => {
    const r = await call('POST', '/api/v1/db/random-songs', { includeFilepathPrefixes: ['Artist B/'] });
    assert.ok(r.status >= 400 && r.status < 500, String(r.status));
  });

  it('filepathPrefix still works', async () => {
    const got = await pool({ ignoreVPaths: ['other'], filepathPrefix: 'Artist B/' });
    assert.deepEqual(got, ['testlib/Artist B/Album Y/01 - Track Three.mp3']);
  });

  it('smart playlist with two children of one parent', async () => {
    const r = await call('POST', '/api/v1/smart-playlists/run', { filters: { selectedVpaths: ['albumX', 'artistB'] }, limit: 100 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(paths(r.body.songs), [
      'testlib/Artist A/Album X/01 - Track One.mp3',
      'testlib/Artist A/Album X/02 - Track Two.mp3',
      'testlib/Artist B/Album Y/01 - Track Three.mp3',
    ]);
    const c = await call('POST', '/api/v1/smart-playlists/count', { filters: { selectedVpaths: ['albumX', 'artistB'] } });
    assert.equal(c.body.count, 3);
  });

  it('smart playlist with a child plus another root', async () => {
    const r = await call('POST', '/api/v1/smart-playlists/run', { filters: { selectedVpaths: ['albumX', 'other'] }, limit: 100 });
    assert.deepEqual(paths(r.body.songs), [
      'other/Other Song.mp3',
      'testlib/Artist A/Album X/01 - Track One.mp3',
      'testlib/Artist A/Album X/02 - Track Two.mp3',
    ]);
  });

  it('smart playlist with a parent plus its child returns the whole parent', async () => {
    const r = await call('POST', '/api/v1/smart-playlists/run', { filters: { selectedVpaths: ['testlib', 'albumX'] }, limit: 100 });
    assert.equal(r.body.songs.length, 4);
    assert.ok(r.body.songs.every(s => s.filepath.startsWith('testlib/')));
  });

  it('podcast progress can be read back', async () => {
    const db = new DatabaseSync(path.join(srv.tmpDir, 'db', 'velvet.sqlite'));
    const feedId = Number(db.prepare("INSERT INTO podcast_feeds (user, url, title) VALUES ('admin', 'https://example.com/feed.xml', 'Feed')").run().lastInsertRowid);
    const epId = Number(db.prepare("INSERT INTO podcast_episodes (feed_id, guid, title, audio_url, duration_secs) VALUES (?, 'g1', 'Ep', 'https://example.com/a.mp3', 600)").run(feedId).lastInsertRowid);
    db.close();

    assert.equal((await call('POST', '/api/v1/podcast/episode/progress', { episodeId: epId, feedId, position: 61.5 })).status, 200);
    let eps = (await call('GET', `/api/v1/podcast/episodes/${feedId}`)).body;
    assert.equal(eps[0].play_position, 61.5);
    assert.equal(eps[0].played, 0);

    await call('POST', '/api/v1/podcast/episode/progress', { episodeId: epId, feedId, position: 0, played: true });
    await call('POST', '/api/v1/podcast/episode/progress', { episodeId: epId, feedId, position: 12 });
    const p = await call('GET', `/api/v1/podcast/episode/${epId}/progress`);
    assert.deepEqual(p.body, { episodeId: epId, feedId, play_position: 12, played: true, duration_secs: 600 });
    eps = (await call('GET', `/api/v1/podcast/episodes/${feedId}`)).body;
    assert.equal(eps[0].played, 1);
    assert.equal((await call('GET', '/api/v1/podcast/episode/999999/progress')).status, 404);
  });

  it('deleting a user removes API keys and per-user rows; a re-created user starts clean', async () => {
    assert.equal((await call('PUT', '/api/v1/admin/users', { username: 'u1', password: 'pw-u1', vpaths: ['testlib'] })).status, 200);
    const key = (await call('POST', '/api/v1/admin/users/subsonic-apikeys', { username: 'u1', label: 'old' })).body.apiKey;
    const ping = async () => (await fetch(`${srv.baseUrl}/rest/ping?apiKey=${key}&f=json&v=1.16.1&c=test`)).json();
    assert.equal((await ping())['subsonic-response'].status, 'ok');

    const db = new DatabaseSync(path.join(srv.tmpDir, 'db', 'velvet.sqlite'));
    db.prepare("INSERT INTO passkeys (username, credential_id, public_key, counter, created_at) VALUES ('u1', 'cred-u1', 'pk', 0, 1)").run();
    db.prepare("INSERT INTO user_settings (username, prefs, queue) VALUES ('u1', '{}', '[]')").run();
    db.prepare("INSERT INTO podcast_feeds (user, url, title) VALUES ('u1', 'https://example.com/u1.xml', 'U1 feed')").run();
    db.close();

    assert.equal((await call('DELETE', '/api/v1/admin/users', { username: 'u1' })).status, 200);
    assert.equal((await call('PUT', '/api/v1/admin/users', { username: 'u1', password: 'pw-u1b', vpaths: ['testlib'] })).status, 200);

    assert.deepEqual((await call('GET', '/api/v1/admin/users/subsonic-apikeys?username=u1')).body.keys, []);
    assert.equal((await ping())['subsonic-response'].status, 'failed');
    const db2 = new DatabaseSync(path.join(srv.tmpDir, 'db', 'velvet.sqlite'));
    for (const [t, c] of [['passkeys', 'username'], ['user_settings', 'username'], ['podcast_feeds', 'user']]) {
      assert.equal(db2.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE ${c} = 'u1'`).get().n, 0, t);
    }
    db2.close();
  });
});
