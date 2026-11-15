'use strict';

// Server-level fixes: open redirect, /shared/:id/ redirect, FLAC suffix ranges, transcoding
// (AAC muxer, ping), album detail/art per user, m3u entries outside the playlist folder,
// scrobble outcomes, random-songs ignorePercentage and the DLNA GENA callback check.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { execFileSync } = require('node:child_process');

const FFMPEG = path.join(__dirname, '..', '..', 'bin', 'ffmpeg', 'ffmpeg');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

function rawRequest(port, opts) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, agent: false, ...opts }, (res) => {
      res.resume();
      res.on('end', () => resolve(res));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('v-C: server routes', async () => {
  const { startServer } = await import('../helpers/server.mjs');
  const { ensureFixtures } = await import('../helpers/fixtures.mjs');
  let srv, work, dlnaPort, flacBytes;
  const tokens = {};

  const call = async (who, method, p, body, extra = {}) => {
    const headers = { 'x-access-token': tokens[who], ...(extra.headers || {}) };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const r = await fetch(srv.baseUrl + p, { method, headers, redirect: 'manual', body: body === undefined ? undefined : JSON.stringify(body) });
    const buf = Buffer.from(await r.arrayBuffer());
    let json = null;
    try { json = JSON.parse(buf.toString('utf8')); } catch { /* binary */ }
    return { status: r.status, headers: r.headers, buf, body: json };
  };

  before(async () => {
    const fixtures = await ensureFixtures();
    const track = path.join(fixtures, 'Artist A', 'Album X', '01 - Track One.mp3');
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'velvet-vc-'));

    const album = path.join(work, 'alib', 'Albums', 'Band - Record (1990)');
    fs.mkdirSync(album, { recursive: true });
    fs.copyFileSync(track, path.join(album, '01 - Song.mp3'));
    fs.writeFileSync(path.join(album, 'cover.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    fs.mkdirSync(path.join(work, 'alib', 'Playlists'));
    fs.writeFileSync(path.join(work, 'alib', 'Playlists', 'p.m3u'),
      '../Albums/Band - Record (1990)/01 - Song.mp3\n..\\Albums\\Band - Record (1990)\\01 - Song.mp3\n../../outside.mp3\n');

    const flacDir = path.join(work, 'flaclib');
    fs.mkdirSync(flacDir);
    const plain = path.join(work, 'plain.flac');
    execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=d=1', '-y', plain]);
    const id3 = Buffer.concat([Buffer.from('ID3'), Buffer.from([3, 0, 0, 0, 0, 0, 20]), Buffer.alloc(20)]);
    flacBytes = fs.readFileSync(plain);
    fs.writeFileSync(path.join(flacDir, 'x.flac'), Buffer.concat([id3, flacBytes]));

    dlnaPort = await freePort();
    srv = await startServer({
      users: [
        { username: 'admin', password: 'pw-admin', vpaths: ['testlib', 'alib', 'flaclib'] },
        { username: 'other', password: 'pw-other', admin: false, vpaths: ['testlib'] },
      ],
      extraFolders: { alib: path.join(work, 'alib'), flaclib: flacDir },
      extraConfig: {
        transcode: { enabled: true, defaultCodec: 'mp3', defaultBitrate: '128k', algorithm: 'stream' },
        dlna: { mode: 'separate-port', enabled: true, port: dlnaPort, name: 'Velvet Test' },
      },
    });
    for (const [u, p] of [['admin', 'pw-admin'], ['other', 'pw-other']]) {
      const r = await fetch(srv.baseUrl + '/api/v1/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }),
      });
      tokens[u] = (await r.json()).token;
    }
  });
  after(async () => {
    await srv?.stop();
    if (work) fs.rmSync(work, { recursive: true, force: true });
  });

  it('a double-slash path is never redirected off-site', async () => {
    const r = await call('admin', 'GET', '//evil.com//');
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), '/evil.com/');
    const q = await call('admin', 'GET', '/foo//?a=1');
    assert.equal(q.headers.get('location'), '/foo/?a=1');
  });

  it('the admin page refuses a token whose version was revoked', async () => {
    const jwt = require('jsonwebtoken');
    const { secret } = JSON.parse(fs.readFileSync(path.join(srv.tmpDir, 'config.json'), 'utf8'));
    const page = (token) => call('admin', 'GET', '/admin/index.html', undefined, { headers: { Cookie: `x-access-token=${token}` } });
    assert.equal((await page(tokens.admin)).status, 200);
    const stale = await page(jwt.sign({ username: 'admin', tv: 99 }, secret));
    assert.equal(stale.status, 302);
    assert.equal(stale.headers.get('location'), '/');
  });

  it('db/genre-groups returns the automatic groups while none are saved', async () => {
    const r = await call('admin', 'GET', '/api/v1/db/genre-groups');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.groups), JSON.stringify(r.body));
  });

  it('/shared/:id/ redirects to the id without the slash', async () => {
    const r = await call('admin', 'GET', '/shared/abc/');
    assert.equal(r.status, 301);
    assert.equal(r.headers.get('location'), '/shared/abc');
    const q = await call('admin', 'GET', '/shared/abc/?x=1');
    assert.equal(q.headers.get('location'), '/shared/abc?x=1');
  });

  it('a FLAC with an ID3 preamble serves a suffix range from the end', async () => {
    const r = await call('admin', 'GET', '/media/flaclib/x.flac', undefined, { headers: { Range: 'bytes=-100' } });
    assert.equal(r.status, 206);
    const size = flacBytes.length;
    assert.equal(r.headers.get('content-range'), `bytes ${size - 100}-${size - 1}/${size}`);
    assert.deepEqual(r.buf, flacBytes.subarray(size - 100));
  });

  it('ping reports transcoding and every codec transcodes (AAC as ADTS)', async () => {
    let ping;
    for (let i = 0; i < 50; i++) {
      ping = await call('admin', 'GET', '/api/v1/ping');
      if (ping.body.transcode) break;
      await new Promise(r => setTimeout(r, 200));
    }
    assert.deepEqual(ping.body.transcode, { defaultCodec: 'mp3', defaultBitrate: '128k', defaultAlgorithm: 'stream' });
    for (const codec of ['mp3', 'opus', 'aac']) {
      for (const algo of ['stream', 'buffer']) {
        const r = await call('admin', 'GET', `/transcode/testlib/Artist%20A/Album%20X/01%20-%20Track%20One.mp3?codec=${codec}&algo=${algo}`);
        assert.equal(r.status, 200);
        assert.ok(r.buf.length > 200, `${codec}/${algo}: ${r.buf.length} bytes`);
        if (codec === 'aac') assert.equal(r.buf[0] === 0xff && (r.buf[1] & 0xf0) === 0xf0, true);
      }
    }
  });

  it('album detail and art-file are only served to users of the album source', async () => {
    const browse = await call('admin', 'GET', '/api/v1/albums/browse');
    const album = browse.body.albums.find(a => a.displayName?.includes('Record') || a.path?.includes('Record'));
    assert.ok(album, JSON.stringify(browse.body));
    assert.equal((await call('admin', 'GET', `/api/v1/albums/detail?id=${album.id}`)).status, 200);
    assert.equal((await call('other', 'GET', `/api/v1/albums/detail?id=${album.id}`)).status, 404);
    assert.ok(album.artFile, JSON.stringify(album));
    const p = encodeURIComponent(album.artFile);
    assert.equal((await call('admin', 'GET', `/api/v1/albums/art-file?p=${p}`)).status, 200, album.artFile);
    assert.equal((await call('other', 'GET', `/api/v1/albums/art-file?p=${p}`)).status, 404);
  });

  it('m3u entries may leave the playlist folder but not the vpath', async () => {
    const r = await call('admin', 'POST', '/api/v1/file-explorer/m3u', { path: 'alib/Playlists/p.m3u' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.files.map(f => f.path), [
      'alib/Albums/Band - Record (1990)/01 - Song.mp3',
      'alib/Albums/Band - Record (1990)/01 - Song.mp3',
    ]);
  });

  it('scrobble routes report "not linked" instead of a silent success', async () => {
    const fp = 'testlib/Artist A/Album X/01 - Track One.mp3';
    const lfm = await call('admin', 'POST', '/api/v1/lastfm/scrobble-by-filepath', { filePath: fp });
    assert.deepEqual(lfm.body, { scrobbled: null });
    const lb = await call('admin', 'POST', '/api/v1/listenbrainz/scrobble-by-filepath', { filePath: fp });
    assert.deepEqual(lb.body, { scrobbled: null });
  });

  it('random-songs honours ignorePercentage', async () => {
    const r = await call('admin', 'POST', '/api/v1/db/random-songs', { ignoreVPaths: ['alib', 'flaclib'], ignoreList: [0, 1, 2], ignorePercentage: 0.25 });
    assert.equal(r.status, 200);
    assert.equal(r.body.ignoreList.length, 2);
  });

  it('DLNA GENA SUBSCRIBE only accepts a callback on the subscriber itself', async () => {
    for (let i = 0; i < 50; i++) {
      if ((await call('admin', 'GET', '/api/v1/admin/dlna/config')).body.running) break;
      await new Promise(r => setTimeout(r, 200));
    }
    const sub = (callback, timeout) => rawRequest(dlnaPort, {
      method: 'SUBSCRIBE', path: '/dlna/events/content-directory',
      headers: { CALLBACK: callback, NT: 'upnp:event', TIMEOUT: timeout },
    });
    assert.equal((await sub('<http://203.0.113.9:8080/cb>', 'Second-300')).statusCode, 412);
    const ok = await sub('<http://127.0.0.1:9/cb>', 'Second-999999');
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.headers.timeout, 'Second-1800');
  });
});
