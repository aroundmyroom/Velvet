/**
 * P089 vpathMetaData parent is the indexed root with 3 levels, P142 m3u reads check the library root,
 * P086 removed lastfm/test-login, P137 playlist writes persist without the old save calls.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

describe('r-db: vpath metadata, m3u root check, removed routes', async () => {
  const { startServer } = await import('../helpers/server.mjs');
  const { ensureFixtures } = await import('../helpers/fixtures.mjs');
  let srv, listDir, outsideDir, token;

  const call = async (method, p, body) => {
    const headers = { 'x-access-token': token };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const r = await fetch(srv.baseUrl + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    try { return { status: r.status, body: text ? JSON.parse(text) : null }; } catch { return { status: r.status, body: text }; }
  };

  before(async () => {
    const fixtures = await ensureFixtures();
    listDir = fs.mkdtempSync(path.join(os.tmpdir(), 'velvet-rdb-lists-'));
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'velvet-rdb-outside-'));
    fs.mkdirSync(path.join(listDir, 'sub'));
    fs.writeFileSync(path.join(listDir, 'a.m3u'), 'one.mp3\nsub/two.mp3\n');
    fs.symlinkSync('../a.m3u', path.join(listDir, 'sub', 'link.m3u'));
    fs.writeFileSync(path.join(outsideDir, 'evil.m3u'), 'x.mp3\n');
    fs.symlinkSync(path.join(outsideDir, 'evil.m3u'), path.join(listDir, 'evil.m3u'));
    srv = await startServer({
      users: [{ username: 'admin', password: 'pw-admin', vpaths: ['testlib', 'inner', 'mid', 'lists'] }],
      extraFolders: {
        inner: path.join(fixtures, 'Artist A/Album X'),
        mid: path.join(fixtures, 'Artist A'),
        lists: listDir,
      },
    });
    const login = await fetch(srv.baseUrl + '/api/v1/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'pw-admin' }),
    });
    token = (await login.json()).token;
  });
  after(async () => {
    await srv?.stop();
    for (const d of [listDir, outsideDir]) if (d) fs.rmSync(d, { recursive: true, force: true });
  });

  it('vpathMetaData points a 3rd-level folder at the root', async () => {
    const r = await call('GET', '/api/v1/ping');
    assert.equal(r.status, 200);
    assert.equal(r.body.vpathMetaData.inner.parentVpath, 'testlib');
    assert.equal(r.body.vpathMetaData.inner.filepathPrefix, 'Artist A/Album X/');
    assert.equal(r.body.vpathMetaData.mid.parentVpath, 'testlib');
  });

  it('file-explorer/m3u reads a playlist through an in-library symlink', async () => {
    const r = await call('POST', '/api/v1/file-explorer/m3u', { path: 'lists/sub/link.m3u' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.files.map(f => f.name), ['one.mp3', 'two.mp3']);
  });

  it('file-explorer/m3u refuses a symlink that leaves the library', async () => {
    const r = await call('POST', '/api/v1/file-explorer/m3u', { path: 'lists/evil.m3u' });
    assert.notEqual(r.status, 200);
  });

  it('lastfm/test-login is gone', async () => {
    const r = await call('POST', '/api/v1/lastfm/test-login', { username: 'x', password: 'y' });
    assert.equal(r.status, 404);
  });

  it('playlist create, rename and delete take effect at once', async () => {
    assert.equal((await call('POST', '/api/v1/playlist/new', { title: 'rdb-pl' })).status, 200);
    assert.equal((await call('POST', '/api/v1/playlist/rename', { oldName: 'rdb-pl', newName: 'rdb-pl2' })).status, 200);
    let names = (await call('GET', '/api/v1/playlist/getall')).body.map(p => p.name);
    assert.ok(names.includes('rdb-pl2'), names.join(','));
    assert.equal((await call('POST', '/api/v1/playlist/delete', { playlistname: 'rdb-pl2' })).status, 200);
    names = (await call('GET', '/api/v1/playlist/getall')).body.map(p => p.name);
    assert.equal(names.includes('rdb-pl2'), false);
  });
});
