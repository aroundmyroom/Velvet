'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const { DatabaseSync } = require('node:sqlite');

const SONG = 'testlib/Artist A/Album X/01 - Track One.mp3';
const SONG_REL = 'Artist A/Album X/01 - Track One.mp3';

describe('scanner writes never hold a transaction open between requests', () => {
  let server, userToken, scanToken, dbFile;

  const post = async (url, body, token) => {
    const r = await fetch(server.baseUrl + url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-access-token': token },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null };
  };

  const readOnly = fn => {
    const conn = new DatabaseSync(dbFile, { readOnly: true });
    try { return fn(conn); } finally { conn.close(); }
  };

  const waitForScanIdle = async () => {
    for (let i = 0; i < 200; i++) {
      const r = await fetch(server.baseUrl + '/api/v1/db/status', { headers: { 'x-access-token': userToken } });
      if (!(await r.json()).locked) return;
      await new Promise(res => setTimeout(res, 100));
    }
    throw new Error('scan did not finish');
  };

  before(async () => {
    const { startServer } = await import('../helpers/server.mjs');
    server = await startServer({ users: [{ username: 'admin', password: 'pw' }] });
    const login = await fetch(server.baseUrl + '/api/v1/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'pw' }),
    });
    userToken = (await login.json()).token;
    const cfg = JSON.parse(fs.readFileSync(path.join(server.tmpDir, 'config.json'), 'utf8'));
    scanToken = jwt.sign({ scan: true }, cfg.secret);
    dbFile = path.join(server.tmpDir, 'db', 'velvet.sqlite');
  });

  after(async () => { await server?.stop(); });

  it('commits a scan batch inside its request; playlist saves and ratings work and survive abort-scan', async () => {
    const add = await post('/api/v1/scanner/add-files', {
      files: [{ filepath: 'ghost/ghost.mp3', vpath: 'testlib', sID: 'scan-tx-test', hash: 'feedfacefeedfacefeedfacefeedface', title: 'Ghost', modified: 1 }],
    }, scanToken);
    assert.equal(add.status, 200);
    assert.deepEqual(add.body.failed, []);
    assert.equal(readOnly(c => c.prepare("SELECT COUNT(*) AS n FROM files WHERE filepath = 'ghost/ghost.mp3'").get().n), 1,
      'the batch is committed before the request returns');

    const save = await post('/api/v1/playlist/save', { title: 'during-scan', songs: [SONG] }, userToken);
    assert.equal(save.status, 200, 'playlist save must not hit "cannot start a transaction within a transaction"');
    const rate = await post('/api/v1/db/rate-song', { filepath: SONG, rating: 8 }, userToken);
    assert.equal(rate.status, 200);

    const abort = await post('/api/v1/scanner/abort-scan', { scanId: 'scan-tx-test', vpath: 'testlib', reason: 'incomplete_dirs' }, scanToken);
    assert.equal(abort.status, 200);

    readOnly(c => {
      assert.equal(c.prepare("SELECT COUNT(*) AS n FROM playlists WHERE name = 'during-scan' AND user = 'admin'").get().n, 2);
      const hash = c.prepare('SELECT hash FROM files WHERE vpath = ? AND filepath = ?').get('testlib', SONG_REL).hash;
      assert.equal(c.prepare('SELECT rating FROM user_metadata WHERE hash = ? AND user = ?').get(hash, 'admin').rating, 8);
    });
  });

  it('reports a row that fails to insert and still commits the rest of the batch', async () => {
    const add = await post('/api/v1/scanner/add-files', {
      files: [
        { filepath: 'ghost/ok.mp3', vpath: 'testlib', sID: 'scan-tx-test', hash: 'abababababababababababababababab' },
        { filepath: 'ghost/bad.mp3', vpath: null, sID: 'scan-tx-test' },
      ],
    }, scanToken);
    assert.equal(add.status, 200);
    assert.equal(add.body.failed.length, 1);
    assert.equal(readOnly(c => c.prepare("SELECT COUNT(*) AS n FROM files WHERE filepath = 'ghost/ok.mp3'").get().n), 1);
  });

  const resumable = async () => {
    const r = await fetch(server.baseUrl + '/api/v1/admin/db/scan/resume-state', { headers: { 'x-access-token': userToken } });
    return (await r.json()).resumable;
  };

  it('a stopped scan leaves later writes committed and a resume checkpoint behind', async () => {
    await post('/api/v1/admin/db/scan/all', {}, userToken);
    await post('/api/v1/admin/db/scan/stop', {}, userToken);
    assert.ok((await resumable()).includes('testlib'));
    assert.ok(fs.existsSync(path.join(server.tmpDir, 'scan-state', 'testlib.json')), 'checkpoint lives next to the test DB directory');
    assert.ok(!fs.existsSync(path.join(__dirname, '..', '..', 'save', 'scan-state', 'testlib.json')), 'nothing written under save/');
    const rate = await post('/api/v1/db/rate-song', { filepath: SONG, rating: 4 }, userToken);
    assert.equal(rate.status, 200);
    readOnly(c => {
      const hash = c.prepare('SELECT hash FROM files WHERE vpath = ? AND filepath = ?').get('testlib', SONG_REL).hash;
      assert.equal(c.prepare('SELECT rating FROM user_metadata WHERE hash = ? AND user = ?').get(hash, 'admin').rating, 4);
    });
    await waitForScanIdle();
  });

  it('the next scan resumes, fully parses a row that was indexed on demand, and clears the checkpoint', async () => {
    const conn = new DatabaseSync(dbFile);
    try {
      conn.exec('PRAGMA busy_timeout = 10000');
      conn.prepare("UPDATE files SET sID = 'on-demand', track = NULL, album_artist = NULL, title = 'thin' WHERE vpath = 'testlib' AND filepath = ?").run(SONG_REL);
    } finally { conn.close(); }

    await post('/api/v1/admin/db/scan/all', {}, userToken);
    await waitForScanIdle();

    readOnly(c => {
      const row = c.prepare('SELECT sID, title, track FROM files WHERE vpath = ? AND filepath = ?').get('testlib', SONG_REL);
      assert.equal(row.title, 'Track One');
      assert.equal(row.track, 1);
      assert.notEqual(row.sID, 'on-demand');
    });
    assert.deepEqual(await resumable(), []);
  });
});
