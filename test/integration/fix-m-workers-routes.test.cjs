/**
 * P034 (artist image SSRF), P036 (Subsonic log scrubbing) and P021 (active radio
 * recordings route) against a real server.
 *
 * Run with:
 *   node --test test/integration/fix-m-workers-routes.test.cjs
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const ADMIN = { username: 'alice', password: 'alice123', admin: true };
const USER = { username: 'bob', password: 'bob12345', admin: false };

describe('m-workers routes', async () => {
  const { startServer } = await import('../helpers/server.mjs');
  let srv, adminToken, userToken;

  async function login(u) {
    const r = await fetch(`${srv.baseUrl}/api/v1/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: u.username, password: u.password }),
    });
    return (await r.json()).token;
  }

  const call = async (token, method, p, body) => {
    const headers = { 'x-access-token': token };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const r = await fetch(srv.baseUrl + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: r.status, body: json };
  };

  before(async () => {
    srv = await startServer({ users: [ADMIN, USER], extraConfig: { writeLogs: true } });
    adminToken = await login(ADMIN);
    userToken = await login(USER);
  });

  after(async () => { await srv?.stop(); });

  it('Subsonic request log scrubs t, s, p and apiKey (P036)', async () => {
    await fetch(`${srv.subsonicBaseUrl}/rest/ping?u=alice&t=tok3n7abc&s=s4ltdef&apiKey=SECRETKEY99&v=1.16.1&c=test&f=json`);
    await fetch(`${srv.subsonicBaseUrl}/rest/ping?u=alice&p=plainpw77&v=1.16.1&c=test&f=json`);
    const logDir = path.join(srv.tmpDir, 'logs');
    let text = '';
    for (let i = 0; i < 40 && !text.includes('[SUBSONIC] GET ping'); i++) {
      await sleep(100);
      text = fs.readdirSync(logDir).map(f => fs.readFileSync(path.join(logDir, f), 'utf8')).join('\n');
    }
    assert.ok(text.includes('[SUBSONIC] GET ping'), 'ping was logged');
    for (const secret of ['tok3n7abc', 's4ltdef', 'SECRETKEY99', 'plainpw77']) {
      assert.ok(!text.includes(secret), `${secret} must not be logged`);
    }
    assert.ok(text.includes('t=[scrubbed]'));
  });

  it('GET /api/v1/radio/record/active: 403 without permission, [] when idle (P021)', async () => {
    const denied = await call(userToken, 'GET', '/api/v1/radio/record/active');
    assert.equal(denied.status, 403);
    const set = await call(adminToken, 'POST', '/api/v1/admin/users/allow-radio-recording', { username: 'bob', allow: true });
    assert.equal(set.status, 200);
    const ok = await call(userToken, 'GET', '/api/v1/radio/record/active');
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body, []);
  });

  it('artist image from a loopback URL is refused, nothing is written (P034)', async () => {
    let artistKey = null;
    for (let i = 0; i < 50 && !artistKey; i++) {
      const r = await call(adminToken, 'GET', '/api/v1/artists/search?q=Artist');
      artistKey = r.body?.artists?.[0]?.artistKey ?? null;
      if (!artistKey) await sleep(200);
    }
    assert.ok(artistKey, 'fixture artist indexed');
    // A real, valid JPEG on loopback: before the fix it was downloaded and saved.
    const sharp = require('sharp');
    const noise = Buffer.alloc(200 * 200 * 3);
    for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) >>> 24;
    const jpeg = await sharp(noise, { raw: { width: 200, height: 200, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
    assert.ok(jpeg.length > 5000);
    let hits = 0;
    const imgSrv = http.createServer((req, res) => { hits++; res.writeHead(200, { 'Content-Type': 'image/jpeg' }); res.end(jpeg); });
    await new Promise(r => imgSrv.listen(0, '127.0.0.1', r));
    const imageUrl = `http://127.0.0.1:${imgSrv.address().port}/a.jpg`;

    const imgDir = path.join(__dirname, '..', '..', 'image-cache', 'artists');
    const outFile = path.join(imgDir, artistKey.replaceAll(/[^a-z0-9_-]/g, '_') + '.jpg');
    const existed = fs.existsSync(outFile);
    for (const route of ['/api/v1/admin/artists/apply-image', '/api/v1/artists/set-image']) {
      const r = await call(adminToken, 'POST', route, { artistKey, imageUrl });
      assert.equal(r.status, 422, `${route} → ${r.status} ${JSON.stringify(r.body)}`);
    }
    imgSrv.close();
    assert.equal(hits, 0, 'the loopback server was never contacted');
    if (!existed) assert.equal(fs.existsSync(outFile), false);
  });
});
