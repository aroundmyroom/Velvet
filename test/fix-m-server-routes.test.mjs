import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { startServer } from './helpers/server.mjs';

const ADMIN = { username: 'admin', password: 'admin123' };
const BOB   = { username: 'bob',   password: 'bob123', admin: false };

async function login(baseUrl, u) {
  const r = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: u.username, password: u.password }),
  });
  return (await r.json()).token;
}

function post(baseUrl, route, token, body) {
  return fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-access-token': token },
    body: JSON.stringify(body),
  });
}

async function ping(baseUrl, u, p) {
  const q = new URLSearchParams({ u, p, v: '1.16.1', c: 'test', f: 'json' });
  return (await (await fetch(`${baseUrl}/rest/ping.view?${q}`)).json())['subsonic-response'].status;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

describe('P018/P032: self-service Subsonic routes for normal users', () => {
  let srv, bobToken, adminToken;
  before(async () => {
    srv = await startServer({ users: [ADMIN, BOB] });
    bobToken   = await login(srv.baseUrl, BOB);
    adminToken = await login(srv.baseUrl, ADMIN);
  });
  after(async () => { await srv.stop(); });

  it('non-admin sets own Subsonic password and can then ping', async () => {
    const r = await post(srv.baseUrl, '/api/v1/user/subsonic-password', bobToken, { password: 'bob-sub-pw' });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), {});
    assert.equal(await ping(srv.subsonicBaseUrl, 'bob', 'bob-sub-pw'), 'ok');
  });

  it('a username in the body is rejected and never touches another user', async () => {
    const r = await post(srv.baseUrl, '/api/v1/user/subsonic-password', bobToken, { username: 'admin', password: 'pwned' });
    assert.ok(r.status >= 400);
    assert.equal(await ping(srv.subsonicBaseUrl, 'admin', 'pwned'), 'failed');
    assert.equal(await ping(srv.subsonicBaseUrl, 'admin', ADMIN.password), 'ok');
  });

  it('non-admin toggles own scrobble forwarding', async () => {
    const r = await post(srv.baseUrl, '/api/v1/user/subsonic-scrobble', bobToken, { scrobbleLastfm: true, scrobbleLb: false });
    assert.equal(r.status, 200);
    const cfg = JSON.parse(await fs.readFile(path.join(srv.tmpDir, 'config.json'), 'utf8'));
    assert.equal(cfg.users.bob['subsonic-scrobble-lastfm'], true);
    assert.equal(cfg.users.bob['subsonic-scrobble-lb'], false);
    assert.equal(cfg.users.admin['subsonic-scrobble-lastfm'], undefined);
  });

  it('non-admin still gets 403 on the admin routes', async () => {
    const a = await post(srv.baseUrl, '/api/v1/admin/users/subsonic-password', bobToken, { username: 'bob', password: 'x' });
    assert.equal(a.status, 403);
    const b = await post(srv.baseUrl, '/api/v1/admin/users/subsonic-scrobble', bobToken, { username: 'bob', scrobbleLb: true });
    assert.equal(b.status, 403);
  });

  it('admin routes still manage other users', async () => {
    const p = await post(srv.baseUrl, '/api/v1/admin/users/subsonic-password', adminToken, { username: 'bob', password: 'by-admin' });
    assert.equal(p.status, 200);
    assert.equal(await ping(srv.subsonicBaseUrl, 'bob', 'by-admin'), 'ok');
  });
});

describe('P045: orphan scanner routes are gone', () => {
  let srv;
  before(async () => { srv = await startServer(); });
  after(async () => { await srv.stop(); });

  it('scan progress no longer reports countingFound', async () => {
    const r = await fetch(`${srv.baseUrl}/api/v1/admin/db/scan/progress`);
    assert.equal(r.status, 200);
    const j = await r.json();
    for (const sp of Array.isArray(j) ? j : []) assert.equal('countingFound' in sp, false);
  });
});

describe('P035/P087: DLNA starts and serves vpaths with ( ) ! and spaces', () => {
  let srv, dlnaPort, dirs;
  before(async () => {
    dlnaPort = await freePort();
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'velvet-dlna-names-'));
    dirs = { 'Music (FLAC)': path.join(base, 'a'), 'Hits!': path.join(base, 'b'), 'My Music': path.join(base, 'c') };
    const src = path.join((await import('./helpers/fixtures.mjs').then(m => m.ensureFixtures())), 'Artist A', 'Album X', '01 - Track One.mp3');
    for (const d of Object.values(dirs)) {
      await fs.mkdir(d, { recursive: true });
      await fs.copyFile(src, path.join(d, 'track one.mp3'));
    }
    srv = await startServer({
      extraFolders: dirs,
      extraConfig: { dlna: { mode: 'separate-port', enabled: true, port: dlnaPort, name: 'Velvet Test' } },
    });
    for (const vpath of Object.keys(dirs)) {
      const r = await fetch(`${srv.baseUrl}/api/v1/admin/directory/flags`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ vpath, dlnaEnabled: true }),
      });
      assert.equal(r.status, 200, `enable DLNA for ${vpath}`);
    }
    for (let i = 0; i < 50; i++) {
      const j = await (await fetch(`${srv.baseUrl}/api/v1/admin/dlna/config`)).json();
      if (j.running) break;
      await new Promise(r => setTimeout(r, 200));
    }
    dirs._base = base;
  });
  after(async () => {
    await srv?.stop();
    if (dirs?._base) await fs.rm(dirs._base, { recursive: true, force: true });
  });

  it('DLNA reports running', async () => {
    const j = await (await fetch(`${srv.baseUrl}/api/v1/admin/dlna/config`)).json();
    assert.equal(j.running, true);
  });

  for (const name of ['Music (FLAC)', 'Hits!', 'My Music']) {
    it(`serves /media/${name}/ by encoded name`, async () => {
      const r = await fetch(`http://127.0.0.1:${dlnaPort}/media/${encodeURIComponent(name)}/${encodeURIComponent('track one.mp3')}`);
      assert.equal(r.status, 200);
      assert.ok((await r.arrayBuffer()).byteLength > 0);
    });
  }

  it('also accepts %28/%29-encoded names', async () => {
    const r = await fetch(`http://127.0.0.1:${dlnaPort}/media/Music%20%28FLAC%29/track%20one.mp3`);
    assert.equal(r.status, 200);
  });

  it('time-seek works for a name that needs URL-encoding', async () => {
    const r = await fetch(`http://127.0.0.1:${dlnaPort}/media/My%20Music/track%20one.mp3`, {
      headers: { 'TimeSeekRange.dlna.org': 'npt=0.5-' },
    });
    assert.equal(r.status, 200);
    assert.ok(r.headers.get('timeseekrange.dlna.org'));
    await r.arrayBuffer();
  });

  it('rejects traversal and unknown vpaths', async () => {
    const t = await fetch(`http://127.0.0.1:${dlnaPort}/media/Hits!/..%2F..%2Fetc%2Fpasswd`);
    assert.equal(t.status, 403);
    const u = await fetch(`http://127.0.0.1:${dlnaPort}/media/Nope/track%20one.mp3`);
    assert.equal(u.status, 404);
  });
});
