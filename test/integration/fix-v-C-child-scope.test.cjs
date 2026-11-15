'use strict';

// A user who only has a child vpath (here "kidsA" = testlib/Artist A) must not see rows from the
// rest of the parent library in any list route, nor zip the parent with a '..' directory.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

describe('v-C: child-only users stay inside their sub-folder', async () => {
  const { startServer } = await import('../helpers/server.mjs');
  const { ensureFixtures } = await import('../helpers/fixtures.mjs');
  let srv;
  const tokens = {};

  const call = async (who, method, p, body) => {
    const headers = { 'x-access-token': tokens[who] };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const r = await fetch(srv.baseUrl + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    try { return { status: r.status, body: text ? JSON.parse(text) : null, text }; } catch { return { status: r.status, body: text, text }; }
  };
  const leaksParent = (r) => /Artist B|Track Three|Album Y/.test(r.text);

  before(async () => {
    const fixtures = await ensureFixtures();
    srv = await startServer({
      users: [
        { username: 'admin', password: 'pw-admin', vpaths: ['testlib', 'kidsA'] },
        { username: 'kid', password: 'pw-kid', admin: false, vpaths: ['kidsA'] },
      ],
      extraFolders: { kidsA: path.join(fixtures, 'Artist A') },
    });
    for (const [u, p] of [['admin', 'pw-admin'], ['kid', 'pw-kid']]) {
      const r = await fetch(srv.baseUrl + '/api/v1/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }),
      });
      tokens[u] = (await r.json()).token;
    }
  });
  after(async () => { await srv?.stop(); });

  it('search returns only the sub-folder (the admin still sees everything)', async () => {
    const kid = await call('kid', 'POST', '/api/v1/db/search', { search: 'Track' });
    assert.equal(kid.status, 200, kid.text);
    assert.ok(kid.body.title.some(t => t.name.includes('Track One')), kid.text);
    assert.ok(!leaksParent(kid), kid.text);
    const folders = await call('kid', 'POST', '/api/v1/db/search', { search: 'Album' });
    assert.ok(!leaksParent(folders), folders.text);
    const admin = await call('admin', 'POST', '/api/v1/db/search', { search: 'Track' });
    assert.ok(admin.body.title.some(t => t.name.includes('Track Three')), admin.text);
  });

  it('a client filepathPrefix outside the sub-folder finds nothing', async () => {
    const r = await call('kid', 'POST', '/api/v1/db/search', { search: 'Track', filepathPrefix: 'Artist B/' });
    assert.deepEqual(r.body.title, []);
  });

  it('recently added, album songs, artist albums, songs by artist and unplayed gems are scoped', async () => {
    for (const [p, body] of [
      ['/api/v1/db/recent/added', { limit: 50 }],
      ['/api/v1/db/recent/added/by-day', {}],
      ['/api/v1/db/album-songs', { album: 'Album Y' }],
      ['/api/v1/db/artists-albums', { artist: 'Artist B' }],
      ['/api/v1/db/songs-by-artists', { artists: ['Artist B'] }],
      ['/api/v1/db/artists', {}],
      ['/api/v1/db/albums', {}],
    ]) {
      const r = await call('kid', 'POST', p, body);
      assert.equal(r.status, 200, `${p}: ${r.text}`);
      assert.ok(!leaksParent(r), `${p}: ${r.text}`);
    }
    const gems = await call('kid', 'POST', '/api/v1/db/unplayed-gems', {});
    assert.equal(gems.body.count, 3, gems.text);
    assert.ok(!leaksParent(gems), gems.text);
  });

  it('a client includeFilepathPrefixes cannot widen the scope', async () => {
    const r = await call('kid', 'POST', '/api/v1/db/albums', { includeFilepathPrefixes: [{ vpath: 'testlib', prefix: 'Artist B/' }] });
    assert.ok(!leaksParent(r), r.text);
  });

  it('random songs never pick from the rest of the parent', async () => {
    for (let i = 0; i < 8; i++) {
      const r = await call('kid', 'POST', '/api/v1/db/random-songs', {});
      assert.equal(r.status, 200, r.text);
      assert.ok(!leaksParent(r), r.text);
    }
  });

  it('rate-song refuses a file outside the sub-folder', async () => {
    const own = await call('kid', 'POST', '/api/v1/db/rate-song', { filepath: 'testlib/Artist A/Album X/01 - Track One.mp3', rating: 6 });
    assert.equal(own.status, 200, own.text);
    const other = await call('kid', 'POST', '/api/v1/db/rate-song', { filepath: 'testlib/Artist B/Album Y/01 - Track Three.mp3', rating: 6 });
    assert.equal(other.status, 404, other.text);
  });

  it('download/directory refuses a ".." that climbs to the parent root', async () => {
    const climb = await call('kid', 'POST', '/api/v1/download/directory', { directory: 'testlib/Artist A/..' });
    assert.notEqual(climb.status, 200);
    const own = await call('kid', 'POST', '/api/v1/download/directory', { directory: 'testlib/Artist A/Album X' });
    assert.equal(own.status, 200);
  });
});
