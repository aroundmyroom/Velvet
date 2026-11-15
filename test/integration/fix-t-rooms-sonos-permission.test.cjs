const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const ADMIN = { username: 'boss', password: 'boss123' };
const PLAIN = { username: 'bob', password: 'bob123', admin: false };
const CASTER = { username: 'carol', password: 'carol123', admin: false };

describe('Sonos routes need the cast permission', () => {
  let srv;
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
    srv = await startServer({ users: [ADMIN, PLAIN, CASTER] });
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

  after(async () => { await srv?.stop(); });

  const routes = [
    ['GET', '/api/v1/sonos/devices'],
    ['POST', '/api/v1/sonos/scan', {}],
    ['GET', '/api/v1/sonos/probe'],
    ['POST', '/api/v1/sonos/cast', {}],
    ['POST', '/api/v1/sonos/cast-queue', {}],
    ['POST', '/api/v1/sonos/set-pause', {}],
    ['POST', '/api/v1/sonos/set-volume', {}],
    ['GET', '/api/v1/sonos/sleep'],
    ['GET', '/api/v1/sonos/favorites'],
    ['GET', '/api/v1/sonos/transcode-stream'],
    ['GET', '/api/v1/sonos/events/stream'],
  ];

  it('a user without allow-mpv-cast gets 403 on every Sonos route', async () => {
    for (const [method, url, body] of routes) {
      const r = await api('bob', method, url, body);
      assert.equal(r.status, 403, `${method} ${url}`);
      assert.deepEqual(r.json, { error: 'Not allowed' }, `${method} ${url}`);
    }
  });

  it('a user with allow-mpv-cast and an admin pass the check', async () => {
    for (const who of ['carol', 'boss']) {
      const probe = await api(who, 'GET', '/api/v1/sonos/probe');
      assert.equal(probe.status, 400, who);
      const stream = await api(who, 'GET', '/api/v1/sonos/transcode-stream');
      assert.equal(stream.status, 400, who);
    }
  });

  it('the player can tell whether to offer Sonos from server-playback/available', async () => {
    assert.equal((await api('bob', 'GET', '/api/v1/server-playback/available')).json.allowed, false);
    assert.equal((await api('carol', 'GET', '/api/v1/server-playback/available')).json.allowed, true);
    assert.equal((await api('boss', 'GET', '/api/v1/server-playback/available')).json.allowed, true);
  });

  it('the speaker event callback stays outside the gate', async () => {
    const r = await fetch(`${srv.baseUrl}/api/v1/sonos/event`, { method: 'POST' });
    assert.equal(r.status, 405);
  });

  it('admin/sonos no longer takes pauseSleepMinutes', async () => {
    const r = await api('boss', 'POST', '/api/v1/admin/sonos', { pauseSleepMinutes: 5 });
    assert.equal(r.status, 400);
    const ok = await api('boss', 'POST', '/api/v1/admin/sonos', { sleepEnabled: false });
    assert.equal(ok.status, 200);
    assert.equal('pauseSleepMinutes' in ok.json, false);
  });
});
