// N128: a room's Auto-DJ picks inside a child-only user's folders, like /api/v1/autodj/next does.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const FFMPEG = ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg'].find(p => fs.existsSync(p)) ?? 'ffmpeg';

// Unrelated names, so nothing but the folder scope separates the kid's songs from the rest
const NAMES = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel', 'India', 'Juliet', 'Kilo', 'Lima', 'Mike', 'November'];

function makeTone(root, rel, freq, name) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=f=${freq}:r=44100:d=20`, '-ac', '2',
    '-metadata', `title=${name}`, '-metadata', `artist=${name}`, '-metadata', `album=${name}`, p]);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

describe('room Auto-DJ keeps a child-only user inside their folders (N128)', async () => {
  const { startServer } = await import('../helpers/server.mjs');
  const { RoomClient } = await import('../helpers/sendspin-room-client.mjs');
  let srv, lib, speaker;
  const tokens = {};
  const ADULTS = 12;

  const call = async (who, method, p, body) => {
    const headers = { 'x-access-token': tokens[who] };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const r = await fetch(srv.baseUrl + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null };
  };

  before(async () => {
    lib = fs.mkdtempSync(path.join(os.tmpdir(), 'velvet-vF-dj-'));
    makeTone(lib, 'Kids/k1.flac', 300, NAMES[0]);
    makeTone(lib, 'Kids/k2.flac', 320, NAMES[1]);
    for (let i = 0; i < ADULTS; i++) makeTone(lib, `Adults/a${i}.flac`, 400 + i * 20, NAMES[i + 2]);
    const ssPort = await freePort();
    srv = await startServer({
      extraFolders: { lib, kids: path.join(lib, 'Kids') },
      extraConfig: { sendspin: { enabled: true, port: ssPort, bind: '127.0.0.1', discovery: false, name: 'Velvet DJ Test' } },
      users: [
        { username: 'admin', password: 'admin123', vpaths: ['testlib', 'lib', 'kids'] },
        { username: 'kid', password: 'kid123', admin: false, vpaths: ['kids'] },
      ],
    });
    for (const [u, pw] of [['admin', 'admin123'], ['kid', 'kid123']]) {
      const r = await fetch(`${srv.baseUrl}/api/v1/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: pw }),
      });
      tokens[u] = (await r.json()).token;
    }
    assert.equal((await call('admin', 'POST', '/api/v1/admin/users/allow-mpv-cast', { username: 'kid', allow: true })).status, 200);
    for (const t0 = Date.now(); ;) {
      const s = await call('admin', 'GET', '/api/v1/db/status');
      if (s.body && !s.body.locked && s.body.totalFileCount >= ADULTS + 2) break;
      if (Date.now() - t0 > 60000) throw new Error(`library scan incomplete: ${JSON.stringify(s.body)}`);
      await new Promise(res => setTimeout(res, 200));
    }
    const st = await call('admin', 'GET', '/api/v1/admin/sendspin/status');
    if (!st.body.running) assert.equal((await call('admin', 'POST', '/api/v1/admin/sendspin/settings', { enabled: true })).body.running, true);
    speaker = new RoomClient({ name: 'Nursery' });
    await speaker.dial(`ws://127.0.0.1:${ssPort}/sendspin`);
    await speaker.connect();
    for (let i = 0; i < 50; i++) {
      const dev = (await call('admin', 'GET', '/api/v1/admin/sendspin/status')).body.devices.find(d => d.clientId === speaker.clientId);
      if (dev) break;
      await new Promise(res => setTimeout(res, 100));
    }
    assert.equal((await call('admin', 'POST', '/api/v1/admin/sendspin/devices/approve', { clientId: speaker.clientId })).status, 200);
  });

  after(async () => {
    speaker?.close();
    await srv?.stop();
    fs.rmSync(lib, { recursive: true, force: true });
  });

  it('the pick comes from the kid\'s folder, not from the rest of the parent library', async () => {
    const id = (await call('kid', 'GET', '/api/v1/rooms')).body.rooms[0].id;
    const play = await call('kid', 'POST', `/api/v1/rooms/${id}/play`, { songs: ['kids/k1.flac'], index: 0 });
    assert.equal(play.status, 200, JSON.stringify(play.body));
    assert.equal(play.body.queueLength, 1);
    const on = await call('kid', 'PUT', `/api/v1/rooms/${id}/autodj`, { on: true });
    assert.equal(on.status, 200, JSON.stringify(on.body));

    let songs = [];
    for (const t0 = Date.now(); Date.now() - t0 < 10000 && songs.length < 2;) {
      songs = (await call('kid', 'GET', `/api/v1/rooms/${id}/queue`)).body.songs;
      if (songs.length < 2) await new Promise(res => setTimeout(res, 200));
    }
    assert.equal(songs.length, 2, 'Auto-DJ added a song');
    assert.match(songs[1].filepath, /Kids\/k2\.flac$/);
    await call('kid', 'PUT', `/api/v1/rooms/${id}/autodj`, { on: false });
  });
});
