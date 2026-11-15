/**
 * s-backend round: clean DB shutdown on SIGTERM, POST /api/v1/autodj/next,
 * the removed audio-features route and the shared /media resolver — all on a
 * real server instance with a temp config.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

async function waitFor(fn, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if (await fn()) return; } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('timed out');
}

describe('SIGTERM closes the main DB', () => {
  let tmp, proc, dbDir;

  before(async () => {
    const { ensureFixtures } = await import('../helpers/fixtures.mjs');
    const musicDir = await ensureFixtures();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'velvet-sb-term-'));
    dbDir = path.join(tmp, 'db');
    const port = await freePort();
    const storage = {
      albumArtDirectory: path.join(tmp, 'image-cache'),
      dbDirectory: dbDir,
      logsDirectory: path.join(tmp, 'logs'),
    };
    for (const d of Object.values(storage)) fs.mkdirSync(d, { recursive: true });
    const cfg = {
      port, address: '127.0.0.1', dlna: { mode: 'disabled' }, subsonic: { mode: 'same-port', port: 3012 },
      scanOptions: { bootScanEnabled: true, bootScanDelay: 0 }, folders: { testlib: { root: musicDir } }, storage,
    };
    const cfgPath = path.join(tmp, 'config.json');
    fs.writeFileSync(cfgPath, JSON.stringify(cfg));
    proc = spawn(process.execPath, ['cli-boot-wrapper.js', '-j', cfgPath], { cwd: REPO, stdio: 'ignore', env: { ...process.env, NODE_ENV: 'test' } });
    const base = `http://127.0.0.1:${port}`;
    await waitFor(async () => {
      const r = await fetch(`${base}/api/v1/db/status`);
      if (!r.ok) return false;
      const j = await r.json();
      return !j.locked && j.totalFileCount > 0;
    });
  });

  after(() => {
    if (proc.exitCode == null && proc.signalCode == null) proc.kill('SIGKILL');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('exits by the signal and leaves no WAL behind', async () => {
    const wal = path.join(dbDir, 'velvet.sqlite-wal');
    assert.ok(fs.existsSync(wal) && fs.statSync(wal).size > 0, 'the running server has a WAL');
    const exited = new Promise(r => proc.once('exit', (code, signal) => r({ code, signal })));
    proc.kill('SIGTERM');
    const { code, signal } = await exited;
    assert.equal(signal, 'SIGTERM');
    assert.equal(code, null);
    assert.ok(!fs.existsSync(wal) || fs.statSync(wal).size === 0, 'WAL checkpointed and removed on close');
  });
});

describe('POST /api/v1/autodj/next', () => {
  let srv, adminToken, kidToken;
  const ALL = new Set([
    'testlib/Artist A/Album X/01 - Track One.mp3',
    'testlib/Artist A/Album X/02 - Track Two.mp3',
    'testlib/Artist B/Album Y/01 - Track Three.mp3',
    'testlib/Artist A/Album Z/01 - Track Four.mp3',
  ]);

  const login = async (username, password) => {
    const r = await fetch(`${srv.baseUrl}/api/v1/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }),
    });
    return (await r.json()).token;
  };
  const next = (token, body) => fetch(`${srv.baseUrl}/api/v1/autodj/next`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-access-token': token }, body: JSON.stringify(body),
  });

  before(async () => {
    const { startServer } = await import('../helpers/server.mjs');
    const { ensureFixtures } = await import('../helpers/fixtures.mjs');
    const musicDir = await ensureFixtures();
    srv = await startServer({
      extraFolders: { kid: path.join(musicDir, 'Artist B') },
      users: [
        { username: 'admin', password: 'pw-admin', admin: true, vpaths: ['testlib', 'kid'] },
        { username: 'kid', password: 'pw-kid', admin: false, vpaths: ['kid'] },
      ],
    });
    adminToken = await login('admin', 'pw-admin');
    kidToken = await login('kid', 'pw-kid');
  });

  after(async () => { await srv?.stop(); });

  it('without a seed returns a random song in the random-songs shape', async () => {
    const r = await next(adminToken, { recent: [] });
    assert.equal(r.status, 200);
    const { song } = await r.json();
    assert.ok(ALL.has(song.filepath), song.filepath);
    for (const k of ['title', 'artist', 'album', 'album-art', 'hash', 'duration']) assert.ok(k in song.metadata, k);
    assert.ok(song.metadata.title);
    assert.ok(song.metadata.artist);
    assert.ok(song.metadata.album);
    assert.ok('rg' in song);
  });

  it('with a seed never repeats the seed or a recent song', async () => {
    const seedFilepath = 'testlib/Artist A/Album X/01 - Track One.mp3';
    const recent = ['testlib/Artist A/Album X/02 - Track Two.mp3', 'testlib/Artist A/Album Z/01 - Track Four.mp3'];
    for (let i = 0; i < 5; i++) {
      const { song } = await (await next(adminToken, { seedFilepath, recent })).json();
      assert.equal(song.filepath, 'testlib/Artist B/Album Y/01 - Track Three.mp3');
    }
  });

  it('without a seed skips the recent songs', async () => {
    const recent = [...ALL].filter(p => !p.includes('Track Four'));
    for (let i = 0; i < 5; i++) {
      const { song } = await (await next(adminToken, { recent })).json();
      assert.equal(song.filepath, 'testlib/Artist A/Album Z/01 - Track Four.mp3');
    }
  });

  it('keeps a child-only user inside the child folder, whatever scope the client sends', async () => {
    for (let i = 0; i < 5; i++) {
      const r = await next(kidToken, { recent: [], scope: { includeFilepathPrefixes: [{ vpath: 'testlib', prefix: 'Artist A/' }] } });
      const { song } = await r.json();
      assert.equal(song, null, 'Artist A is outside the child folder');
      const { song: own } = await (await next(kidToken, {})).json();
      assert.equal(own.filepath, 'testlib/Artist B/Album Y/01 - Track Three.mp3');
    }
  });

  it('ignores a seed the user may not read', async () => {
    const { song } = await (await next(kidToken, { seedFilepath: 'testlib/Artist A/Album X/01 - Track One.mp3' })).json();
    assert.equal(song.filepath, 'testlib/Artist B/Album Y/01 - Track Three.mp3');
  });

  it('applies the scope (minDuration above every track gives no song)', async () => {
    const { song } = await (await next(adminToken, { scope: { minDuration: 3600 } })).json();
    assert.equal(song, null);
  });

  it('validates the body', async () => {
    assert.equal((await next(adminToken, { recent: 'x' })).status, 400);
    assert.equal((await next(adminToken, { recent: Array(201).fill('a/b') })).status, 400);
    assert.equal((await next(adminToken, { scope: { bogus: 1 } })).status, 400);
    assert.equal((await next(adminToken, { scope: { minDuration: 10, maxDuration: 5 } })).status, 400);
  });

  it('the audio-features route is gone', async () => {
    const r = await fetch(`${srv.baseUrl}/api/v1/db/audio-features/${'a'.repeat(32)}`, { headers: { 'x-access-token': adminToken } });
    assert.equal(r.status, 404);
    assert.doesNotMatch(await r.text(), /Not found"|Invalid hash/);
  });

  it('serves /media for a child vpath with encoded spaces, supports Range and refuses traversal', async () => {
    const url = `${srv.baseUrl}/media/kid/Album%20Y/01%20-%20Track%20Three.mp3`;
    const full = await fetch(url, { headers: { 'x-access-token': adminToken } });
    assert.equal(full.status, 200);
    const part = await fetch(url, { headers: { 'x-access-token': adminToken, Range: 'bytes=0-99' } });
    assert.equal(part.status, 206);
    assert.equal((await part.arrayBuffer()).byteLength, 100);
    const escape = await fetch(`${srv.baseUrl}/media/kid/..%2F..%2Fetc%2Fpasswd`, { headers: { 'x-access-token': adminToken } });
    assert.ok([403, 404].includes(escape.status), String(escape.status));
  });
});
