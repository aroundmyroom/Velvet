/**
 * t-api round 4: playlist/save validation, random-songs duration window on the single pick,
 * custom artist placeholder upload → serve, ping allowMpvCast for admins, migrate apply keeps the
 * DB open and the current users, Subsonic createBookmark and last-played in ms.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const json = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };

describe('t-api: public-mode routes', async () => {
  const { startServer } = await import('../helpers/server.mjs');
  let srv;
  const post = (p, body) => fetch(srv.baseUrl + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  before(async () => {
    srv = await startServer({ extraConfig: { serverAudio: { enabled: true } } });
  });
  after(async () => { await srv?.stop(); });

  it('playlist/save without songs is a 400, an empty list still saves', async () => {
    assert.equal((await post('/api/v1/playlist/save', { title: 'x' })).status, 400);
    assert.equal((await post('/api/v1/playlist/save', { title: 'x', songs: [] })).status, 200);
  });

  it('random-songs single pick honours minDuration/maxDuration', async () => {
    const none = await post('/api/v1/db/random-songs', { minDuration: 3600 });
    assert.equal(none.status, 400);
    const some = await post('/api/v1/db/random-songs', { minDuration: 0.1, maxDuration: 3600 });
    assert.equal(some.status, 200);
    assert.equal((await json(some)).songs.length, 1);
  });

  it('ping: an admin without allow-mpv-cast may cast when MPV is enabled', async () => {
    const r = await json(await fetch(srv.baseUrl + '/api/v1/ping'));
    assert.equal(r.allowMpvCast, true);
  });

  it('an uploaded artist placeholder is the one served', async () => {
    const sharp = require('sharp');
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#f00' } }).png().toBuffer();
    const form = new FormData();
    form.append('file', new Blob([png], { type: 'image/png' }), 'p.png');
    const up = await fetch(srv.baseUrl + '/api/v1/admin/artists/placeholder', { method: 'POST', body: form });
    assert.equal(up.status, 200, await up.text());
    const info = await json(await fetch(srv.baseUrl + '/api/v1/admin/artists/placeholder-info'));
    assert.equal(info.hasCustom, true);
    const served = await fetch(srv.baseUrl + '/api/v1/artists/placeholder');
    assert.match(served.headers.get('content-type'), /image\/jpeg/);
    assert.ok(fs.existsSync(path.join(srv.tmpDir, 'artist-placeholder.jpg')));
    await fetch(srv.baseUrl + '/api/v1/admin/artists/placeholder', { method: 'DELETE' });
    assert.match((await fetch(srv.baseUrl + '/api/v1/artists/placeholder')).headers.get('content-type'), /image\/webp/);
  });

  it('migrate/apply keeps the database open and keeps the current users', async () => {
    const id = `velvet-import-${Date.now()}`;
    const dir = path.join(srv.tmpDir, 'migrate', id);
    fs.mkdirSync(dir, { recursive: true });
    const cfg = JSON.parse(fs.readFileSync(path.join(srv.tmpDir, 'config.json'), 'utf8'));
    cfg.users = { intruder: { password: 'x', salt: 'y', admin: true, vpaths: ['testlib'] } };
    fs.writeFileSync(path.join(dir, 'default.json'), JSON.stringify(cfg));
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ version: 'test' }));
    fs.copyFileSync(path.join(srv.tmpDir, 'db', 'velvet.sqlite'), path.join(dir, 'velvet.sqlite'));

    const r = await post('/api/v1/admin/migrate/apply', { id });
    assert.equal(r.status, 200, await r.text());
    const status = await fetch(srv.baseUrl + '/api/v1/db/status');
    assert.equal(status.status, 200, 'DB answers after the import and the server is still in public mode');
    const saved = JSON.parse(fs.readFileSync(path.join(srv.tmpDir, 'config.json'), 'utf8'));
    assert.deepEqual(saved.users ?? {}, {});
  });
});

describe('t-api: DLNA only reaches DLNA-enabled folders', async () => {
  const { startServer } = await import('../helpers/server.mjs');
  const net = require('node:net');
  let srv, dlnaPort, base;
  const freePort = () => new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
  const soap = (action, inner) => fetch(`http://127.0.0.1:${dlnaPort}/dlna/control/content-directory`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml', SOAPACTION: `"urn:schemas-upnp-org:service:ContentDirectory:1#${action}"` },
    body: `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:${action} xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1">${inner}</u:${action}></s:Body></s:Envelope>`,
  }).then(r => r.text());

  before(async () => {
    dlnaPort = await freePort();
    const { ensureFixtures } = await import('../helpers/fixtures.mjs');
    const track = path.join(await ensureFixtures(), 'Artist A', 'Album X', '01 - Track One.mp3');
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'velvet-tapi-dlna-'));
    for (const d of ['on', 'off']) {
      fs.mkdirSync(path.join(base, d));
      fs.copyFileSync(track, path.join(base, d, `${d}.mp3`));
    }
    srv = await startServer({
      extraFolders: { shared: path.join(base, 'on'), private: path.join(base, 'off') },
      extraConfig: { dlna: { mode: 'separate-port', enabled: true, port: dlnaPort, name: 'Velvet Test' } },
    });
    const r = await fetch(srv.baseUrl + '/api/v1/admin/directory/flags', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ vpath: 'shared', dlnaEnabled: true }),
    });
    assert.equal(r.status, 200, await r.text());
    for (let i = 0; i < 50; i++) {
      if ((await json(await fetch(`${srv.baseUrl}/api/v1/admin/dlna/config`))).running) break;
      await new Promise(res => setTimeout(res, 200));
    }
  });
  after(async () => { await srv?.stop(); fs.rmSync(base, { recursive: true, force: true }); });

  it('/media serves the enabled folder and 404s the other one', async () => {
    assert.equal((await fetch(`http://127.0.0.1:${dlnaPort}/media/shared/on.mp3`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${dlnaPort}/media/private/off.mp3`)).status, 404);
  });

  it('Search returns only tracks from the enabled folder', async () => {
    const xml = await soap('Search', '<ContainerID>0</ContainerID><SearchCriteria>*</SearchCriteria><Filter>*</Filter><StartingIndex>0</StartingIndex><RequestedCount>0</RequestedCount><SortCriteria></SortCriteria>');
    assert.match(xml, /on\.mp3/);
    assert.doesNotMatch(xml, /off\.mp3/);
  });

  it('device config no longer reports the unused browse setting', async () => {
    assert.ok(!('browse' in await json(await fetch(`${srv.baseUrl}/api/v1/admin/dlna/config`))));
  });
});

describe('t-api: YouTube download folders are not scanned', async () => {
  const { startServer } = await import('../helpers/server.mjs');
  let srv, ytDir;
  before(async () => {
    const { ensureFixtures } = await import('../helpers/fixtures.mjs');
    const musicDir = await ensureFixtures();
    ytDir = fs.mkdtempSync(path.join(os.tmpdir(), 'velvet-tapi-yt-'));
    fs.copyFileSync(path.join(musicDir, 'Artist A', 'Album X', '01 - Track One.mp3'), path.join(ytDir, 'yt.mp3'));
    srv = await startServer({
      extraConfig: { folders: { testlib: { root: musicDir }, yt: { root: ytDir, type: 'youtube' } } },
    });
  });
  after(async () => { await srv?.stop(); fs.rmSync(ytDir, { recursive: true, force: true }); });

  it('a full scan indexes the music folder but not the youtube folder', async () => {
    const r = await fetch(srv.baseUrl + '/api/v1/db/search', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ search: 'Track One' }),
    });
    const files = ((await json(r)).title || []).map(t => t.filepath);
    assert.ok(files.some(f => f.startsWith('testlib/')), JSON.stringify(files));
    assert.ok(!files.some(f => f.startsWith('yt/')), JSON.stringify(files));
  });
});

describe('t-api: Subsonic bookmarks and last played', async () => {
  const { startServer } = await import('../helpers/server.mjs');
  let srv;
  const sub = async (action, params = {}) => {
    const q = new URLSearchParams({ u: 'admin', p: 'pw-admin', v: '1.16.1', c: 'test', f: 'json', ...params });
    return (await json(await fetch(`${srv.subsonicBaseUrl}/rest/${action}?${q}`)))['subsonic-response'];
  };

  before(async () => {
    srv = await startServer({ users: [{ username: 'admin', password: 'pw-admin' }] });
  });
  after(async () => { await srv?.stop(); });

  it('createBookmark is accepted and listed', async () => {
    const id = (await sub('getRandomSongs', { size: '1' })).randomSongs.song[0].id;
    assert.equal((await sub('createBookmark', { id, position: '1500' })).status, 'ok');
    const marks = (await sub('getBookmarks')).bookmarks.bookmark;
    assert.equal(marks.length, 1);
    assert.equal(marks[0].position, 1500);
  });

  it('a scrobble stores last-played so `played` is now, not 1970', async () => {
    const id = (await sub('getRandomSongs', { size: '1' })).randomSongs.song[0].id;
    assert.equal((await sub('scrobble', { id, submission: 'true' })).status, 'ok');
    const song = (await sub('getSong', { id })).song;
    assert.ok(Math.abs(Date.parse(song.played) - Date.now()) < 5 * 60_000, `played=${song.played}`);
  });
});
