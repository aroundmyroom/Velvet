import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import { DatabaseSync } from 'node:sqlite';
import { parseFile } from 'music-metadata';
import { startServer } from './helpers/server.mjs';
import { ensureFixtures } from './helpers/fixtures.mjs';

const ADMIN = { username: 'admin', password: 'admin123', vpaths: ['testlib', 'Other Lib'] };
const BYTES = 'velvet-media-bytes-0123456789'.repeat(10);

async function login(baseUrl, u) {
  const r = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: u.username, password: u.password }),
  });
  return (await r.json()).token;
}

function post(baseUrl, route, token, body = {}) {
  return fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-access-token': token },
    body: JSON.stringify(body),
  });
}

describe('r-server fixes', () => {
  let srv, token, otherDir;
  before(async () => {
    otherDir = await fs.mkdtemp(path.join(os.tmpdir(), 'velvet-otherlib-'));
    await fs.writeFile(path.join(otherDir, 'note.txt'), BYTES);
    const fixtures = await ensureFixtures();
    await fs.copyFile(path.join(fixtures, 'Artist A/Album X/01 - Track One.mp3'), path.join(otherDir, 'tagme.mp3'));
    srv = await startServer({
      users: [ADMIN],
      extraFolders: { 'Other Lib': otherDir },
      extraConfig: { scanOptions: { bootScanEnabled: true, bootScanDelay: 0, allowId3Edit: true } },
    });
    token = await login(srv.baseUrl, ADMIN);
  });
  after(async () => {
    await srv.stop();
    await fs.rm(otherDir, { recursive: true, force: true });
  });

  it('P076: admin users/lastfm route is removed', async () => {
    const r = await post(srv.baseUrl, '/api/v1/admin/users/lastfm', token,
      { username: 'admin', lastfmUser: 'x', lastfmPassword: 'y' });
    assert.equal(r.status, 404);
  });

  it('P139: log retention accepts every listed value and rejects others', async () => {
    for (const v of ['1d', '3d', '7d', '14d', '30d']) {
      const r = await post(srv.baseUrl, '/api/v1/admin/config/log-retention', token, { logRetention: v });
      assert.equal(r.status, 200, v);
    }
    const bad = await post(srv.baseUrl, '/api/v1/admin/config/log-retention', token, { logRetention: '2d' });
    assert.ok(bad.status >= 400 && bad.status < 500, `got ${bad.status}`);
  });

  it('P093: unknown .view Subsonic method answers error 70', async () => {
    const q = new URLSearchParams({ u: 'admin', p: 'admin123', v: '1.16.1', c: 'test', f: 'json' });
    const j = await (await fetch(`${srv.subsonicBaseUrl}/rest/doesNotExist.view?${q}`)).json();
    assert.equal(j['subsonic-response'].error.code, 70);
    assert.equal(j['subsonic-response'].error.message, 'Subsonic method "doesNotExist" not found');
  });

  it('P092: an expired share link reports 410 "expired"', async () => {
    const cfg = JSON.parse(await fs.readFile(path.join(srv.tmpDir, 'config.json'), 'utf8'));
    const expired = jwt.sign({ playlistId: 'expiredone', shareToken: true, username: 'admin' }, cfg.secret, { expiresIn: -10 });
    const db = new DatabaseSync(path.join(srv.tmpDir, 'db', 'velvet.sqlite'));
    db.prepare('INSERT INTO shared_playlists (playlistId, playlist, user, expires, token) VALUES (?, ?, ?, ?, ?)')
      .run('expiredone', '[]', 'admin', null, expired);
    db.close();

    const page = await fetch(`${srv.baseUrl}/shared/expiredone`);
    assert.equal(page.status, 410);
    assert.match(await page.text(), /id="sh-data">\{"error":"expired"\}</);

    const api = await fetch(`${srv.baseUrl}/api/v1/shared/expiredone`);
    assert.equal(api.status, 410);

    const missing = await fetch(`${srv.baseUrl}/shared/doesnotexist`);
    assert.equal(missing.status, 404);
  });

  it('P096: /media serves a folder whose name needs URL encoding, with ranges, and refuses traversal', async () => {
    const h = { 'x-access-token': token };
    const full = await fetch(`${srv.baseUrl}/media/Other%20Lib/note.txt`, { headers: h });
    assert.equal(full.status, 200);
    assert.equal(await full.text(), BYTES);

    const part = await fetch(`${srv.baseUrl}/media/Other%20Lib/note.txt`, { headers: { ...h, Range: 'bytes=0-9' } });
    assert.equal(part.status, 206);
    assert.equal(await part.text(), BYTES.slice(0, 10));

    const trav = await fetch(`${srv.baseUrl}/media/Other%20Lib/..%2F..%2Fetc%2Fpasswd`, { headers: h });
    assert.ok([403, 404].includes(trav.status), `got ${trav.status}`);

    const track = await fetch(`${srv.baseUrl}/media/testlib/Artist%20A/Album%20X/01%20-%20Track%20One.mp3`, { headers: h });
    assert.equal(track.status, 200);
    await track.arrayBuffer();
  });

  it('P106: admin tags/write rewrites the tags through ffmpeg-tags', async () => {
    const r = await post(srv.baseUrl, '/api/v1/admin/tags/write', token,
      { filepath: 'Other Lib/tagme.mp3', title: 'Renamed Title', year: 1999 });
    assert.equal(r.status, 200, await r.clone().text());
    const meta = await parseFile(path.join(otherDir, 'tagme.mp3'));
    assert.equal(meta.common.title, 'Renamed Title');
    assert.equal(meta.common.artist, 'Artist A');
    assert.equal(meta.common.year, 1999);
    const leftovers = (await fs.readdir(otherDir)).filter(f => f.startsWith('.velvet-tag'));
    assert.deepEqual(leftovers, []);
  });

  it('P144: /login still redirects to /', async () => {
    for (const p of ['/login', '/login/', '/login/index.html']) {
      const r = await fetch(`${srv.baseUrl}${p}`, { redirect: 'manual' });
      assert.equal(r.status, 301, p);
      assert.equal(r.headers.get('location'), '/');
    }
    const js = await fetch(`${srv.baseUrl}/login/index.js`, { redirect: 'manual' });
    assert.notEqual(js.status, 200);
  });

  it('P078/P091: orphan-vpath purge works for an admin and obeys lockAdmin', async () => {
    const ok = await post(srv.baseUrl, '/api/v1/admin/db/purge-orphaned-vpaths', token, { dryRun: true });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).deleted, 0);

    const lock = await post(srv.baseUrl, '/api/v1/admin/lock-api', token, { lock: true });
    assert.equal(lock.status, 200);
    const locked = await post(srv.baseUrl, '/api/v1/admin/db/purge-orphaned-vpaths', token, { dryRun: true });
    assert.equal(locked.status, 405);
  });
});
