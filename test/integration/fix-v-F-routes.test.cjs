const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { WebSocket } = require('ws');

const ADMIN = { username: 'boss', password: 'boss123' };
const CASTER = { username: 'carol', password: 'carol123', admin: false, vpaths: ['testlib'] };
const TRACK = 'testlib/Artist A/Album X/01 - Track One.mp3';

describe('v-F: server speaker, pairing and jukebox routes', () => {
  let srv;
  const tokens = {};

  const api = async (who, method, url, body) => {
    const headers = { 'Content-Type': 'application/json' };
    if (who) headers['x-access-token'] = tokens[who] ?? who;
    const r = await fetch(`${srv.baseUrl}${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    let json = null;
    try { json = await r.json(); } catch { /* not json */ }
    return { status: r.status, json };
  };

  const openJukebox = (token) => new Promise((resolve, reject) => {
    const ws = new WebSocket(`${srv.baseUrl.replace('http', 'ws')}/?token=${encodeURIComponent(token)}`);
    ws.once('message', (data) => resolve({ ws, hello: JSON.parse(String(data)) }));
    ws.once('error', reject);
    ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });

  before(async () => {
    const { startServer } = await import('../helpers/server.mjs');
    srv = await startServer({ users: [ADMIN, CASTER] });
    for (const u of [ADMIN, CASTER]) {
      const r = await fetch(`${srv.baseUrl}/api/v1/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: u.username, password: u.password }),
      });
      tokens[u.username] = (await r.json()).token;
    }
    assert.equal((await api('boss', 'POST', '/api/v1/admin/users/allow-mpv-cast', { username: 'carol', allow: true })).status, 200);
  });

  after(async () => { await srv?.stop(); });

  describe('N133: queue/add-many is all or nothing', () => {
    it('a missing file anywhere in the batch queues nothing', async () => {
      const r = await api('carol', 'POST', '/api/v1/server-playback/queue/add-many', {
        files: [{ filepath: TRACK }, { filepath: 'testlib/nope.mp3' }],
      });
      assert.equal(r.status, 404);
      assert.equal((await api('carol', 'GET', '/api/v1/server-playback/status')).json.queueLength, 0);
    });

    it('an entry without filepath is refused before anything is queued', async () => {
      const r = await api('carol', 'POST', '/api/v1/server-playback/queue/add-many', { files: [{ filepath: TRACK }, { title: 'x' }] });
      assert.equal(r.status, 400);
      assert.equal((await api('carol', 'GET', '/api/v1/server-playback/status')).json.queueLength, 0);
    });

    it('a failed add (Server Audio off) leaves no ghost entry behind', async () => {
      for (const [url, body] of [
        ['/api/v1/server-playback/queue/add', { filepath: TRACK }],
        ['/api/v1/server-playback/queue/add-many', { files: [{ filepath: TRACK }, { filepath: TRACK }] }],
      ]) {
        const r = await api('carol', 'POST', url, body);
        assert.equal(r.status, 400, url);
        assert.match(r.json.error, /not running/);
      }
      assert.equal((await api('carol', 'GET', '/api/v1/server-playback/status')).json.queueLength, 0);
    });
  });

  describe('N045: reapply-gain and volume reject non-numbers', () => {
    it('400 for a non-finite gainDb, volumePct or balance', async () => {
      for (const body of [{ gainDb: 'loud' }, { volumePct: 'x' }, { balance: 'left' }]) {
        assert.equal((await api('carol', 'POST', '/api/v1/server-playback/reapply-gain', body)).status, 400, JSON.stringify(body));
      }
      assert.equal((await api('carol', 'POST', '/api/v1/server-playback/reapply-gain', { gainDb: 60, volumePct: 80 })).status, 200);
      assert.equal((await api('carol', 'POST', '/api/v1/server-playback/reapply-gain', { gainDb: null })).status, 200);
      assert.equal((await api('carol', 'POST', '/api/v1/server-playback/volume', { volume: 'max' })).status, 400);
    });
  });

  describe('Sonos settings are written through the shared config writer', () => {
    it('admin/sonos, save-default and favorite-visibility persist together', async () => {
      const readCfg = () => JSON.parse(require('node:fs').readFileSync(require('node:path').join(srv.tmpDir, 'config.json'), 'utf8'));
      const [a, b, c] = await Promise.all([
        api('boss', 'POST', '/api/v1/admin/sonos', { transcodeOpus: true, sleepEnabled: true }),
        api('boss', 'POST', '/api/v1/sonos/save-default', { ip: '192.168.1.50', name: 'Living', uuid: 'RINCON_000E58000001' }),
        api('boss', 'POST', '/api/v1/sonos/favorite-visibility', { key: 'fav-1', hidden: true }),
      ]);
      assert.deepEqual([a.status, b.status, c.status], [200, 200, 200]);
      assert.deepEqual(c.json.hiddenFavorites, ['fav-1']);
      const sonos = readCfg().sonos;
      assert.equal(sonos.transcodeOpus, true);
      assert.equal(sonos.sleepEnabled, true);
      assert.deepEqual(sonos.defaultRoom, { ip: '192.168.1.50', name: 'Living', uuid: 'RINCON_000E58000001' });
      assert.deepEqual(sonos.hiddenFavorites, ['fav-1']);
      const off = await api('boss', 'POST', '/api/v1/sonos/favorite-visibility', { key: 'fav-1', hidden: false });
      assert.deepEqual(off.json.hiddenFavorites, []);
      assert.deepEqual(readCfg().sonos.hiddenFavorites, []);
    });
  });

  describe('N129: anonymous pair/start is rate limited', () => {
    it('answers 429 after the per-address budget', async () => {
      const codes = [];
      for (let i = 0; i < 12; i++) codes.push((await api(null, 'POST', '/api/v1/auth/pair/start')).status);
      assert.deepEqual(codes.slice(0, 10), Array(10).fill(200));
      assert.deepEqual(codes.slice(10), [429, 429]);
    });
  });

  describe('N044 / N139: jukebox connect, token and push', () => {
    let player, code, jukeToken;
    before(async () => {
      const { ws, hello } = await openJukebox(tokens.carol);
      player = ws;
      code = hello.code;
      jukeToken = hello.token;
    });
    after(() => player?.close());

    it('the player gets a code and a scoped, expiring jukebox token', () => {
      assert.match(code, /^[\w-]{8}$/);
      const claims = jwt.decode(jukeToken);
      assert.equal(claims.username, 'carol');
      assert.equal(claims.scope, 'jukebox');
      assert.equal(claims.code, code);
      assert.ok(claims.exp > claims.iat, 'expires');
    });

    it('the public code routes hand out the same scoped token', async () => {
      assert.deepEqual((await api(null, 'POST', '/api/v1/jukebox/does-code-exist', { code })).json, { status: true, token: jukeToken });
      assert.deepEqual((await api(null, 'POST', '/api/v1/jukebox/does-code-exist', { code: 'nope' })).json, { status: false });
      const page = await fetch(`${srv.baseUrl}/remote/${code}`).then(r => r.text());
      assert.ok(page.includes(jukeToken));
    });

    it('a jukebox token cannot open a new jukebox session', async () => {
      await assert.rejects(openJukebox(jukeToken), /401/);
      await assert.rejects(openJukebox('garbage'), /401/);
    });

    it('push-to-client with the jukebox token reaches the player socket', async () => {
      const got = new Promise(r => player.once('message', d => r(JSON.parse(String(d)))));
      const r = await api(jukeToken, 'POST', '/api/v1/jukebox/push-to-client', { code, command: 'addSong', file: TRACK });
      assert.equal(r.status, 200);
      assert.deepEqual(await got, { command: 'addSong', file: TRACK });
    });

    it('the jukebox token cannot push to another session; unknown commands are refused', async () => {
      const other = await openJukebox(tokens.boss);
      try {
        assert.equal((await api(jukeToken, 'POST', '/api/v1/jukebox/push-to-client', { code: other.hello.code, command: 'next' })).status, 403);
        assert.equal((await api('boss', 'POST', '/api/v1/jukebox/push-to-client', { code, command: 'rm -rf' })).status, 400);
        assert.equal((await api('boss', 'POST', '/api/v1/jukebox/push-to-client', { code: 'missing1', command: 'next' })).status, 404);
      } finally { other.ws.close(); }
    });

    it('after a password change the old login cannot open a session; a fresh one gets a working token', async () => {
      const oldToken = tokens.carol;
      const changed = await api('carol', 'POST', '/api/v1/auth/change-password', { currentPassword: CASTER.password, newPassword: 'carol456' });
      assert.equal(changed.status, 200);
      await assert.rejects(openJukebox(oldToken), /401/);
      const login = await api(null, 'POST', '/api/v1/auth/login', { username: 'carol', password: 'carol456' });
      tokens.carol = login.json.token;
      const s = await openJukebox(tokens.carol);
      try {
        assert.ok(jwt.decode(s.hello.token).tv >= 1);
        const got = new Promise(r => s.ws.once('message', d => r(JSON.parse(String(d)))));
        assert.equal((await api(s.hello.token, 'POST', '/api/v1/jukebox/push-to-client', { code: s.hello.code, command: 'next' })).status, 200);
        assert.deepEqual(await got, { command: 'next', file: '' });
        assert.equal((await api(s.hello.token, 'GET', '/api/v1/server-playback/status')).status, 401, 'scoped to the jukebox routes');
      } finally { s.ws.close(); }
    });

    it('the session and its token are gone once the player disconnects', async () => {
      const s = await openJukebox(tokens.boss);
      const closed = new Promise(r => s.ws.once('close', r));
      s.ws.close();
      await closed;
      await new Promise(r => setTimeout(r, 100));
      assert.deepEqual((await api(null, 'POST', '/api/v1/jukebox/does-code-exist', { code: s.hello.code })).json, { status: false });
    });
  });
});
