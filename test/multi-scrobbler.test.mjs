import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startServer } from './helpers/server.mjs';

const ADMIN = { username: 'admin', password: 'admin123' };
const BOB   = { username: 'bob',   password: 'bob123', admin: false };
const SERVER_TOKEN = 'velvet-server-token';
const BOB_TOKEN    = 'bob-own-token';
const SONG = 'testlib/Artist A/Album X/01 - Track One.mp3';

// A stand-in for multi-scrobbler: its ListenBrainz endpoint source matches the token like the real one
// (src/backend/server/endpointListenbrainzRoutes.ts) and answers 409 when no source has it.
function fakeMultiScrobbler(tokens) {
  const listens = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.method === 'GET' && req.url === '/api/version') return json(200, { version: '0.21.1' });
      if (req.method === 'GET' && req.url === '/api/health') return json(200, {});
      if (req.method === 'GET' && req.url === '/1/validate-token') return json(200, { code: 200, valid: true, user_name: 'velvet' });
      if (req.method === 'POST' && req.url === '/1/submit-listens') {
        const token = /^Token (.+)$/.exec(req.headers.authorization || '')?.[1]?.trim();
        if (!tokens.includes(token)) return json(409, { error: `No Listenbrainz endpoint config matched => Token: ${token}`, code: 409 });
        listens.push({ token, body: JSON.parse(body) });
        return json(200, { status: 'ok' });
      }
      json(404, {});
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, listens, url: `http://127.0.0.1:${server.address().port}` })));
}

async function login(baseUrl, { username, password }) {
  const r = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }),
  });
  return (await r.json()).token;
}

function call(baseUrl, method, route, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['x-access-token'] = token;
  return fetch(`${baseUrl}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

const waitFor = async (check, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise(r => setTimeout(r, 50));
  }
  assert.fail('timed out waiting');
};

describe('multi-scrobbler target', () => {
  let ms, srv, admin, bob;
  before(async () => {
    ms = await fakeMultiScrobbler([SERVER_TOKEN, BOB_TOKEN]);
    srv = await startServer({ users: [ADMIN, BOB], extraConfig: { multiScrobbler: { enabled: true, url: ms.url, token: SERVER_TOKEN } } });
    admin = await login(srv.baseUrl, ADMIN);
    bob = await login(srv.baseUrl, BOB);
  });
  after(async () => {
    await srv.stop();
    ms.server.close();
  });

  it('the admin config never returns the token, and only admins can read or change it', async () => {
    const r = await call(srv.baseUrl, 'GET', '/api/v1/admin/multi-scrobbler/config', admin);
    assert.deepEqual(await r.json(), { enabled: true, url: ms.url, hasToken: true });
    assert.equal((await call(srv.baseUrl, 'GET', '/api/v1/admin/multi-scrobbler/config', bob)).status, 403);
    assert.equal((await call(srv.baseUrl, 'POST', '/api/v1/admin/multi-scrobbler/config', bob, { enabled: false, url: '' })).status, 403);
    assert.equal((await call(srv.baseUrl, 'POST', '/api/v1/admin/multi-scrobbler/config', admin, { enabled: true, url: 'ftp://x' })).status, 400);
    assert.equal((await call(srv.baseUrl, 'POST', '/api/v1/admin/multi-scrobbler/config', admin, { enabled: true, url: '' })).status, 400);
    const save = (body) => call(srv.baseUrl, 'POST', '/api/v1/admin/multi-scrobbler/config', admin, body);
    const hasToken = async () => (await (await call(srv.baseUrl, 'GET', '/api/v1/admin/multi-scrobbler/config', admin)).json()).hasToken;
    assert.equal((await save({ enabled: true, url: ms.url + '/' })).status, 200);
    assert.equal(await hasToken(), true, 'no msToken keeps the saved token');
    await save({ enabled: true, url: ms.url, msToken: '' });
    assert.equal(await hasToken(), false);
    await save({ enabled: true, url: ms.url, msToken: SERVER_TOKEN });
    assert.equal(await hasToken(), true);
    assert.equal(JSON.parse(await fs.readFile(path.join(srv.tmpDir, 'config.json'), 'utf8')).multiScrobbler.url, ms.url);
  });

  it('the connection test reports version, health and the ListenBrainz endpoint source', async () => {
    const r = await call(srv.baseUrl, 'POST', '/api/v1/admin/multi-scrobbler/test', admin, {});
    assert.deepEqual(await r.json(), { reachable: true, version: '0.21.1', healthy: true, healthStatus: 200, endpointSource: true });
    const down = await (await call(srv.baseUrl, 'POST', '/api/v1/admin/multi-scrobbler/test', admin, { url: 'http://127.0.0.1:1' })).json();
    assert.equal(down.reachable, false);
  });

  it('nothing is sent for a user who has not switched it on', async () => {
    const st = await (await call(srv.baseUrl, 'GET', '/api/v1/multi-scrobbler/status', bob)).json();
    assert.equal(st.serverEnabled, true);
    assert.equal(st.enabled, false);
    const r = await (await call(srv.baseUrl, 'POST', '/api/v1/multi-scrobbler/scrobble-by-filepath', bob, { filePath: SONG })).json();
    assert.deepEqual(r, { scrobbled: null });
    assert.equal(ms.listens.length, 0);
  });

  it('an opted-in user sends now-playing and the listen with the server token', async () => {
    assert.equal((await call(srv.baseUrl, 'POST', '/api/v1/multi-scrobbler/settings', bob, { enabled: true })).status, 200);
    const np = await (await call(srv.baseUrl, 'POST', '/api/v1/multi-scrobbler/playing-now', bob, { filePath: SONG })).json();
    assert.deepEqual(np, { sent: true });
    const r = await (await call(srv.baseUrl, 'POST', '/api/v1/multi-scrobbler/scrobble-by-filepath', bob, { filePath: SONG })).json();
    assert.deepEqual(r, { scrobbled: true });
    await waitFor(() => ms.listens.length >= 2);
    const [now, single] = ms.listens;
    assert.equal(now.token, SERVER_TOKEN);
    assert.equal(now.body.listen_type, 'playing_now');
    assert.equal(now.body.payload[0].listened_at, undefined);
    assert.equal(single.body.listen_type, 'single');
    const meta = single.body.payload[0].track_metadata;
    assert.equal(meta.artist_name, 'Artist A');
    assert.equal(meta.track_name, 'Track One');
    assert.equal(meta.release_name, 'Album X');
    assert.equal(meta.additional_info.submission_client, 'Velvet');
    assert.equal(meta.additional_info.tracknumber, 1);
    assert.ok(Number.isInteger(single.body.payload[0].listened_at));
    const st = await (await call(srv.baseUrl, 'GET', '/api/v1/multi-scrobbler/status', bob)).json();
    assert.equal(st.enabled, true);
    assert.equal(st.last.ok, true);
    assert.equal(JSON.stringify(st).includes(SERVER_TOKEN), false);
  });

  it('a personal token replaces the server token; a rejected one shows up as a token problem', async () => {
    assert.equal((await call(srv.baseUrl, 'POST', '/api/v1/multi-scrobbler/settings', bob, { enabled: true, msToken: BOB_TOKEN })).status, 200);
    ms.listens.length = 0;
    assert.deepEqual(await (await call(srv.baseUrl, 'POST', '/api/v1/multi-scrobbler/scrobble-by-filepath', bob, { filePath: SONG })).json(), { scrobbled: true });
    assert.equal(ms.listens[0].token, BOB_TOKEN);

    await call(srv.baseUrl, 'POST', '/api/v1/multi-scrobbler/settings', bob, { enabled: true, msToken: 'wrong' });
    assert.deepEqual(await (await call(srv.baseUrl, 'POST', '/api/v1/multi-scrobbler/scrobble-by-filepath', bob, { filePath: SONG })).json(), { scrobbled: false });
    const st = await (await call(srv.baseUrl, 'GET', '/api/v1/multi-scrobbler/status', bob)).json();
    assert.equal(st.ownToken, true);
    assert.deepEqual({ ok: st.last.ok, message: st.last.message }, { ok: false, message: 'token' });

    await call(srv.baseUrl, 'POST', '/api/v1/multi-scrobbler/settings', bob, { enabled: true, msToken: '' });
    const conf = JSON.parse(await fs.readFile(path.join(srv.tmpDir, 'config.json'), 'utf8'));
    assert.equal(conf.users.bob['ms-token'], undefined);
    assert.equal(conf.users.bob['ms-enabled'], true);
  });

  it('Subsonic plays and now-playing are forwarded when the user opts in for Subsonic', async () => {
    const sub = (action, extra = {}) => fetch(`${srv.subsonicBaseUrl}/rest/${action}?${new URLSearchParams({ u: 'bob', p: 'bob123', v: '1.16.1', c: 'velvet-test', f: 'json', ...extra })}`).then(r => r.json());
    const song = (await sub('search3', { query: 'Track One', songCount: '1' }))['subsonic-response'].searchResult3.song[0];
    ms.listens.length = 0;
    await sub('scrobble', { id: song.id });
    await new Promise(r => setTimeout(r, 300));
    assert.equal(ms.listens.length, 0, 'not forwarded before the Subsonic opt-in');

    assert.equal((await call(srv.baseUrl, 'POST', '/api/v1/user/subsonic-scrobble', bob, { scrobbleMs: true })).status, 200);
    const settings = await (await call(srv.baseUrl, 'GET', '/api/v1/subsonic/scrobble-settings', bob)).json();
    assert.equal(settings.msAvailable, true);
    assert.equal(settings.scrobbleMs, true);
    await sub('scrobble', { id: song.id, submission: 'false' });
    await sub('scrobble', { id: song.id });
    await waitFor(() => ms.listens.length >= 2);
    assert.deepEqual(ms.listens.map(l => l.body.listen_type), ['playing_now', 'single']);
    assert.equal(ms.listens[1].body.payload[0].track_metadata.track_name, 'Track One');
  });
});
