const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const ADMIN = { username: 'boss', password: 'boss123' };
const PLAIN = { username: 'bob', password: 'bob123', admin: false, vpaths: ['testlib'] };
const CASTER = { username: 'carol', password: 'carol123', admin: false, vpaths: ['Child'] };

describe('server speaker access (P008 / P003)', () => {
  let srv, otherDir;
  const tokens = {};

  const api = async (who, method, url, body) => {
    const r = await fetch(`${srv.baseUrl}${url}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-access-token': tokens[who] },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await r.json(); } catch { /* not json */ }
    return { status: r.status, json };
  };

  before(async () => {
    const { startServer } = await import('../helpers/server.mjs');
    const { ensureFixtures } = await import('../helpers/fixtures.mjs');
    const musicDir = await ensureFixtures();
    otherDir = await fs.mkdtemp(path.join(os.tmpdir(), 'velvet-other-'));
    srv = await startServer({
      users: [ADMIN, PLAIN, CASTER],
      extraFolders: { Child: path.join(musicDir, 'Artist A'), Other: otherDir },
    });
    for (const u of [ADMIN, PLAIN, CASTER]) {
      const r = await fetch(`${srv.baseUrl}/api/v1/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: u.username, password: u.password }),
      });
      tokens[u.username] = (await r.json()).token;
    }
    const r = await api('boss', 'POST', '/api/v1/admin/users/allow-mpv-cast', { username: 'carol', allow: true });
    assert.equal(r.status, 200);
  });

  after(async () => {
    await srv?.stop();
    await fs.rm(otherDir, { recursive: true, force: true }).catch(() => {});
  });

  it('every user can read the availability probe; it never 403s', async () => {
    for (const who of ['boss', 'bob', 'carol']) {
      const r = await api(who, 'GET', '/api/v1/server-playback/available');
      assert.equal(r.status, 200, who);
      assert.equal(typeof r.json.enabled, 'boolean');
      assert.equal(typeof r.json.running, 'boolean');
    }
    assert.equal((await api('bob', 'GET', '/api/v1/server-playback/available')).json.allowed, false);
    assert.equal((await api('carol', 'GET', '/api/v1/server-playback/available')).json.allowed, true);
  });

  it('a user without cast or remote rights is refused on every playback route', async () => {
    for (const [method, url, body] of [
      ['GET', '/api/v1/server-playback/status'],
      ['POST', '/api/v1/server-playback/queue/add', { filepath: 'testlib/Artist A/Album X/01 - Track One.mp3' }],
      ['POST', '/api/v1/server-playback/play', { file: { filepath: 'testlib/Artist A/Album X/01 - Track One.mp3' } }],
      ['POST', '/api/v1/server-playback/queue/clear', {}],
      ['POST', '/api/v1/server-playback/volume', { volume: 10 }],
    ]) {
      assert.equal((await api('bob', method, url, body)).status, 403, url);
    }
  });

  it('a caster gets the status with a boolean running', async () => {
    const r = await api('carol', 'GET', '/api/v1/server-playback/status');
    assert.equal(r.status, 200);
    assert.equal(typeof r.json.running, 'boolean');
  });

  it('path traversal is refused without echoing the path', async () => {
    for (const filepath of ['Child/../../../etc/passwd', 'Child/./x.mp3', 'Child/a\\b.mp3', '/etc/passwd']) {
      const r = await api('carol', 'POST', '/api/v1/server-playback/queue/add', { filepath });
      assert.equal(r.status, 404, filepath);
      assert.equal(r.json.error, 'File not available');
    }
  });

  it('folders the user has no access to are not available', async () => {
    const r = await api('carol', 'POST', '/api/v1/server-playback/queue/add', { filepath: 'testlib/Artist B/Album Y/01 - Track Three.mp3' });
    assert.equal(r.status, 404);
    assert.equal(r.json.error, 'File not available');
  });

  it('a file in the user\'s child folder resolves (fails only because mpv is off)', async () => {
    const r = await api('carol', 'POST', '/api/v1/server-playback/queue/add', { filepath: 'Child/Album X/01 - Track One.mp3' });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /not running/);
  });

  it('the diagnostics routes are admin-only', async () => {
    assert.equal((await api('carol', 'GET', '/api/v1/server-playback/audio-health')).status, 403);
    assert.equal((await api('carol', 'GET', '/api/v1/server-playback/detect')).status, 403);
    assert.equal((await api('carol', 'POST', '/api/v1/server-playback/test-tone', {})).status, 403);
    assert.equal((await api('boss', 'GET', '/api/v1/server-playback/audio-health')).status, 200);
  });
});
