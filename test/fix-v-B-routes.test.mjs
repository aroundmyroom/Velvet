import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import jwt from 'jsonwebtoken';
import { startServer } from './helpers/server.mjs';
import { ensureFixtures } from './helpers/fixtures.mjs';

const execFileP = promisify(execFile);
const ADMIN = { username: 'admin', password: 'admin123' };
const BOB   = { username: 'bob',   password: 'bob123', admin: false };

async function login(baseUrl, username, password) {
  const r = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  return (await r.json()).token;
}

function call(baseUrl, method, route, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['x-access-token'] = token;
  return fetch(`${baseUrl}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

const refresh = (baseUrl, token) => call(baseUrl, 'GET', '/api/v1/auth/refresh', token);
const readConfig = async (srv) => JSON.parse(await fs.readFile(path.join(srv.tmpDir, 'config.json'), 'utf8'));

describe('v-B: token revocation (N084)', () => {
  let srv, adminToken;
  before(async () => {
    srv = await startServer({ users: [ADMIN, BOB], waitForScan: false });
    adminToken = await login(srv.baseUrl, ADMIN.username, ADMIN.password);
  });
  after(async () => { await srv.stop(); });

  it('a token signed before tokenVersion existed keeps working', async () => {
    const legacy = jwt.sign({ username: 'admin' }, (await readConfig(srv)).secret);
    assert.equal((await refresh(srv.baseUrl, legacy)).status, 200);
  });

  it('an admin password reset revokes the user\'s old tokens', async () => {
    const old = await login(srv.baseUrl, 'bob', BOB.password);
    assert.equal((await refresh(srv.baseUrl, old)).status, 200);
    const r = await call(srv.baseUrl, 'POST', '/api/v1/admin/users/password', adminToken, { username: 'bob', password: 'bob456' });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), {});
    assert.equal((await refresh(srv.baseUrl, old)).status, 401);
    const fresh = await login(srv.baseUrl, 'bob', 'bob456');
    assert.equal((await refresh(srv.baseUrl, fresh)).status, 200);
    assert.equal((await readConfig(srv)).users.bob.tokenVersion, 1);
  });

  it('self-service password change revokes old tokens and returns a working one', async () => {
    const old = await login(srv.baseUrl, 'bob', 'bob456');
    const r = await call(srv.baseUrl, 'POST', '/api/v1/auth/change-password', old, { currentPassword: 'bob456', newPassword: 'bob789' });
    assert.equal(r.status, 200);
    const { token } = await r.json();
    assert.equal((await refresh(srv.baseUrl, old)).status, 401);
    assert.equal((await refresh(srv.baseUrl, token)).status, 200);
  });

  it('"log out everywhere" revokes every token of that user', async () => {
    const a = await login(srv.baseUrl, 'bob', 'bob789');
    const r = await call(srv.baseUrl, 'POST', '/api/v1/admin/users/revoke-tokens', adminToken, { username: 'bob' });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), {});
    assert.equal((await refresh(srv.baseUrl, a)).status, 401);
    assert.equal((await refresh(srv.baseUrl, adminToken)).status, 200, 'other users stay signed in');
  });

  it('an admin revoking their own sessions gets a fresh token back', async () => {
    const r = await call(srv.baseUrl, 'POST', '/api/v1/admin/users/revoke-tokens', adminToken, { username: 'admin' });
    const { token } = await r.json();
    assert.equal((await refresh(srv.baseUrl, adminToken)).status, 401);
    assert.equal((await refresh(srv.baseUrl, token)).status, 200);
    adminToken = token;
  });

  it('revoke-tokens is admin-only and 404s for an unknown user', async () => {
    const bob = await login(srv.baseUrl, 'bob', 'bob789');
    assert.equal((await call(srv.baseUrl, 'POST', '/api/v1/admin/users/revoke-tokens', bob, { username: 'bob' })).status, 403);
    assert.equal((await call(srv.baseUrl, 'POST', '/api/v1/admin/users/revoke-tokens', adminToken, { username: 'nobody' })).status, 404);
  });
});

describe('v-B: scoped tokens only open what they were made for', () => {
  let srv, secret;
  const fp = 'testlib/Artist A/Album X/01 - Track One.mp3';
  const mediaUrl = (p) => '/media/' + p.split('/').map(encodeURIComponent).join('/');
  before(async () => {
    srv = await startServer({ users: [ADMIN, BOB], waitForScan: false });
    secret = (await readConfig(srv)).secret;
  });
  after(async () => { await srv.stop(); });

  it('a stream token opens its own file and nothing else', async () => {
    const t = jwt.sign({ username: 'admin', scope: 'stream', fp }, secret, { expiresIn: '1h' });
    assert.equal((await call(srv.baseUrl, 'GET', mediaUrl(fp), t)).status, 200);
    assert.equal((await call(srv.baseUrl, 'GET', mediaUrl('testlib/Artist A/Album X/02 - Track Two.mp3'), t)).status, 401);
    assert.equal((await call(srv.baseUrl, 'GET', '/api/v1/ping', t)).status, 401);
  });

  it('a jukebox token is refused on admin routes', async () => {
    const t = jwt.sign({ username: 'admin', scope: 'jukebox', code: 'abc' }, secret, { expiresIn: '1h' });
    assert.equal((await call(srv.baseUrl, 'GET', '/api/v1/admin/users', t)).status, 401);
    assert.equal((await call(srv.baseUrl, 'GET', '/api/v1/ping', t)).status, 401);
  });

  it('an unknown scope opens nothing', async () => {
    const t = jwt.sign({ username: 'admin', scope: 'other' }, secret);
    assert.equal((await call(srv.baseUrl, 'GET', '/api/v1/ping', t)).status, 401);
  });

  it('a revoked user\'s scoped tokens stop working', async () => {
    const admin = await login(srv.baseUrl, ADMIN.username, ADMIN.password);
    const t = jwt.sign({ username: 'bob', scope: 'stream', fp }, secret, { expiresIn: '1h' });
    assert.equal((await call(srv.baseUrl, 'GET', mediaUrl(fp), t)).status, 200);
    await call(srv.baseUrl, 'POST', '/api/v1/admin/users/revoke-tokens', admin, { username: 'bob' });
    assert.equal((await call(srv.baseUrl, 'GET', mediaUrl(fp), t)).status, 401);
  });
});

describe('v-B: admin routes', () => {
  let srv, token;
  before(async () => {
    srv = await startServer({ users: [ADMIN, BOB], waitForScan: false });
    token = await login(srv.baseUrl, ADMIN.username, ADMIN.password);
  });
  after(async () => { await srv.stop(); });

  it('GET /admin/users returns only the fields the Users view needs (N086)', async () => {
    const bob = await login(srv.baseUrl, 'bob', BOB.password);
    await call(srv.baseUrl, 'POST', '/api/v1/user/subsonic-scrobble', bob, { scrobbleLb: true });
    const users = await (await call(srv.baseUrl, 'GET', '/api/v1/admin/users', token)).json();
    const allowed = new Set(['vpaths', 'admin', 'allow-radio-recording', 'allow-youtube-download', 'allow-upload', 'allow-ai-dj', 'allow-server-remote', 'allow-mpv-cast']);
    for (const u of Object.values(users)) for (const k of Object.keys(u)) assert.ok(allowed.has(k), k);
    assert.deepEqual(users.bob.vpaths, ['testlib']);
  });

  it('config/secret refuses a weak or huge strength (N085)', async () => {
    for (const strength of [1, 31, 513, 1e9]) {
      assert.equal((await call(srv.baseUrl, 'POST', '/api/v1/admin/config/secret', token, { strength })).status, 400, String(strength));
    }
  });

  it('directory routes refuse vpaths with a slash or dots (N099)', async () => {
    for (const vpath of ['a/b', '../x', '..', '__proto__']) {
      const r = await call(srv.baseUrl, 'PUT', '/api/v1/admin/directory', token, { directory: srv.musicDir, vpath });
      assert.equal(r.status, 400, vpath);
    }
    const flags = await call(srv.baseUrl, 'PATCH', '/api/v1/admin/directory/flags', token, { vpath: 'x/y', artistsOn: true });
    assert.equal(flags.status, 400);
  });

  it('a new folder root is stored without a trailing slash', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'velvet-vb-rec-'));
    try {
      const r = await call(srv.baseUrl, 'PUT', '/api/v1/admin/directory', token, { directory: dir + '/', vpath: 'Rec Folder', isRecording: true });
      assert.equal(r.status, 200, await r.text());
      assert.equal((await readConfig(srv)).folders['Rec Folder'].root, dir);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('reset-sentinel and admin users/subsonic-scrobble are gone (N025, N088)', async () => {
    assert.equal((await call(srv.baseUrl, 'POST', '/api/v1/admin/directory/reset-sentinel', token, { vpath: 'testlib' })).status, 404);
    assert.equal((await call(srv.baseUrl, 'POST', '/api/v1/admin/users/subsonic-scrobble', token, { username: 'bob', scrobbleLb: true })).status, 404);
  });

  it('log retention is saved and logs/prune deletes only old files (N088)', async () => {
    const r = await call(srv.baseUrl, 'POST', '/api/v1/admin/config/log-retention', token, { logRetention: '7d' });
    assert.equal(r.status, 200);
    assert.equal((await readConfig(srv)).logRetention, '7d');
    const logs = path.join(srv.tmpDir, 'logs');
    const today = new Date().toISOString().slice(0, 10);
    await fs.writeFile(path.join(logs, 'velvet-2020-01-01.log'), 'old');
    await fs.writeFile(path.join(logs, `velvet-${today}.log`), 'new');
    const p = await call(srv.baseUrl, 'POST', '/api/v1/admin/logs/prune', token);
    assert.deepEqual(await p.json(), { deleted: 1 });
    const left = await fs.readdir(logs);
    assert.ok(!left.includes('velvet-2020-01-01.log'));
    assert.ok(left.includes(`velvet-${today}.log`));
  });

  it('the admin Logs card calls both routes', async () => {
    const ui = await fs.readFile(new URL('../webapp/admin/index.js', import.meta.url), 'utf8');
    assert.match(ui, /api\/v1\/admin\/config\/log-retention/);
    assert.match(ui, /api\/v1\/admin\/logs\/prune/);
    assert.match(ui, /api\/v1\/admin\/users\/revoke-tokens/);
  });

  it('a manual backup holds the config and a database snapshot, owner-only (N022, N098)', async () => {
    const r = await call(srv.baseUrl, 'POST', '/api/v1/admin/backup', token);
    const body = await r.text();
    assert.equal(r.status, 200, body);
    const { filename } = JSON.parse(body);
    const file = path.join(srv.tmpDir, 'backups', filename);
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    const zip = await fs.readFile(file);
    assert.ok(zip.includes('default.json'));
    assert.ok(zip.includes('velvet.sqlite'));
    assert.deepEqual((await fs.readdir(path.join(srv.tmpDir, 'backups'))).filter(f => f.endsWith('.sqlite')), []);
  });

  it('exports are staged in an owner-only folder, not the shared temp folder (N023)', async () => {
    const before = (await fs.readdir(os.tmpdir())).filter(f => f.startsWith('velvet-migrate-') || f.startsWith('velvet-export-'));
    const { id } = await (await call(srv.baseUrl, 'POST', '/api/v1/admin/migrate/export/start', token, { includeWaveforms: false })).json();
    let status;
    for (let i = 0; i < 100; i++) {
      status = await (await call(srv.baseUrl, 'GET', `/api/v1/admin/migrate/export/status/${id}`, token)).json();
      if (status.status !== 'building') break;
      await new Promise(r => setTimeout(r, 100));
    }
    assert.equal(status.status, 'ready', JSON.stringify(status));
    const staging = path.join(srv.tmpDir, 'migrate');
    assert.equal((await fs.stat(staging)).mode & 0o777, 0o700);
    const zips = (await fs.readdir(staging)).filter(f => f.endsWith('.zip'));
    assert.equal(zips.length, 1);
    assert.equal((await fs.stat(path.join(staging, zips[0]))).mode & 0o777, 0o600);
    const after = (await fs.readdir(os.tmpdir())).filter(f => f.startsWith('velvet-migrate-') || f.startsWith('velvet-export-'));
    assert.deepEqual(after.sort(), before.sort());

    const dl = await call(srv.baseUrl, 'GET', `/api/v1/admin/migrate/export/download/${id}`, token);
    assert.equal(dl.status, 200);
    await dl.arrayBuffer();
    await new Promise(r => setTimeout(r, 200));
    assert.deepEqual((await fs.readdir(staging)).filter(f => f.endsWith('.zip')), []);
  });

  it('import upload answers 501 without storing the body (N089)', async () => {
    const r = await fetch(`${srv.baseUrl}/api/v1/admin/migrate/upload`, {
      method: 'POST', headers: { 'x-access-token': token, 'Content-Type': 'application/octet-stream' }, body: Buffer.alloc(1024),
    });
    assert.equal(r.status, 501);
  });

  it('migrate/apply ignores import folders in the shared temp folder (N089)', async () => {
    const id = `velvet-import-${Date.now()}`;
    const planted = path.join(os.tmpdir(), id);
    await fs.mkdir(planted, { recursive: true });
    try {
      await fs.writeFile(path.join(planted, 'manifest.json'), '{}');
      await fs.writeFile(path.join(planted, 'default.json'), JSON.stringify({ secret: 'planted' }));
      const r = await call(srv.baseUrl, 'POST', '/api/v1/admin/migrate/apply', token, { id });
      assert.equal(r.status, 500);
      assert.notEqual((await readConfig(srv)).secret, 'planted');
    } finally {
      await fs.rm(planted, { recursive: true, force: true });
    }
  });
});

describe('v-B: per-user webhook settings in no-user mode (N021)', () => {
  let srv;
  before(async () => { srv = await startServer({ waitForScan: false }); });
  after(async () => { await srv.stop(); });

  it('discord, custom webhooks and subsonic scrobble answer 403 and leave the config alone', async () => {
    const before = await readConfig(srv);
    assert.equal((await call(srv.baseUrl, 'POST', '/api/v1/discord-webhook/save', null, { enabled: true, nick: 'x' })).status, 403);
    assert.equal((await call(srv.baseUrl, 'POST', '/api/v1/custom-webhooks/save', null, { slot: 0, enabled: true })).status, 403);
    assert.equal((await call(srv.baseUrl, 'POST', '/api/v1/user/subsonic-scrobble', null, { scrobbleLb: true })).status, 403);
    const after = await readConfig(srv);
    assert.deepEqual(after.users ?? {}, before.users ?? {});
  });
});

describe('v-B: scan-error auto-fix rewrites files safely (N026)', () => {
  let srv, token, lib;
  before(async () => {
    lib = await fs.mkdtemp(path.join(os.tmpdir(), 'velvet-vb-fix-'));
    const track = path.join(await ensureFixtures(), 'Artist A', 'Album X', '01 - Track One.mp3');
    await fs.copyFile(track, path.join(lib, 'good.mp3'));
    await fs.writeFile(path.join(lib, 'garbage.mp3'), Buffer.alloc(4096, 7));
    srv = await startServer({ users: [{ ...ADMIN, vpaths: ['testlib', 'fixlib'] }], waitForScan: false, extraFolders: { fixlib: lib } });
    token = await login(srv.baseUrl, ADMIN.username, ADMIN.password);
  });
  after(async () => {
    await srv.stop();
    await fs.rm(lib, { recursive: true, force: true });
  });

  async function report(name) {
    const r = await call(srv.baseUrl, 'POST', '/api/v1/db/scan-errors/report-playback', token, { filepath: `fixlib/${name}` });
    const body = await r.text();
    assert.equal(r.status, 200, body);
    return JSON.parse(body).guid;
  }

  it('a readable mp3 is remuxed in place and stays playable', async () => {
    const guid = await report('good.mp3');
    const r = await call(srv.baseUrl, 'POST', '/api/v1/admin/db/scan-errors/fix', token, { guid });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).action, 'remuxed');
    const ffprobe = path.join(process.cwd(), 'bin', 'ffmpeg', 'ffprobe');
    const { stdout } = await execFileP(ffprobe, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', path.join(lib, 'good.mp3')]);
    assert.equal(stdout.trim(), 'audio');
    assert.deepEqual((await fs.readdir(lib)).filter(f => f.startsWith('.__velvet_fix_')), []);
  });

  it('a file with no audio is marked unrecoverable and left untouched', async () => {
    const guid = await report('garbage.mp3');
    const r = await call(srv.baseUrl, 'POST', '/api/v1/admin/db/scan-errors/fix', token, { guid });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).action, 'unrecoverable');
    assert.deepEqual(await fs.readFile(path.join(lib, 'garbage.mp3')), Buffer.alloc(4096, 7));
  });

  it('an unknown guid is a 404', async () => {
    assert.equal((await call(srv.baseUrl, 'POST', '/api/v1/admin/db/scan-errors/fix', token, { guid: 'nope' })).status, 404);
  });
});

describe('v-B: passkey challenge store is capped (N087)', () => {
  let srv;
  before(async () => { srv = await startServer({ users: [ADMIN], waitForScan: false }); });
  after(async () => { await srv.stop(); });

  const options = async () => (await (await call(srv.baseUrl, 'POST', '/api/v1/auth/passkey/auth/options', null, {})).json()).challenge;
  const verify = (challenge) => call(srv.baseUrl, 'POST', '/api/v1/auth/passkey/auth/verify', null, { challenge, credential: { id: 'unknown' } });

  it('a flood of option requests evicts the oldest challenge instead of growing without bound', async () => {
    const first = await options();
    assert.equal((await verify(await options())).status, 401, 'a stored challenge gets as far as the credential check');
    for (let i = 0; i < 10_000; i += 200) await Promise.all(Array.from({ length: 200 }, options));
    const r = await verify(first);
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /Challenge expired or not found/);
  });
});
