import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startServer } from './helpers/server.mjs';
import { computeFileHash } from '../src/util/file-hash.js';

const execFileP = promisify(execFile);

async function makeTrack(dest, title, { cover, flac = false } = {}) {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const args = ['-nostdin', '-y', '-f', 'lavfi', '-t', '1', '-i', 'anullsrc=r=44100:cl=stereo'];
  if (cover) args.push('-i', cover, '-map', '0:a', '-map', '1:v', '-c:v', 'mjpeg', '-disposition:v:0', 'attached_pic');
  if (flac) args.push('-codec:a', 'flac');
  else args.push('-codec:a', 'libmp3lame', '-b:a', '128k', '-id3v2_version', '3');
  args.push('-metadata', `title=${title}`, '-metadata', 'artist=Fixlib Artist', '-metadata', `album=${title} Album`, dest);
  await execFileP('ffmpeg', args);
}

function zipEntryNames(buf) {
  const names = [];
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) !== 0x06054b50) continue;
    let off = buf.readUInt32LE(i + 16);
    const count = buf.readUInt16LE(i + 10);
    for (let n = 0; n < count; n++) {
      const nameLen = buf.readUInt16LE(off + 28);
      const extraLen = buf.readUInt16LE(off + 30);
      const commentLen = buf.readUInt16LE(off + 32);
      names.push(buf.toString('utf8', off + 46, off + 46 + nameLen));
      off += 46 + nameLen + extraLen + commentLen;
    }
    break;
  }
  return names;
}

const ADMIN = { username: 'boss', password: 'boss123' };
const KID = { username: 'kid', password: 'kid123', admin: false, vpaths: ['Child'] };

describe('library fixes (auth copy, folder zip, on-demand index, art names, subsonic mime)', () => {
  let srv, libDir, workDir, adminToken, kidToken;

  const api = async (token, method, url, body) => {
    const r = await fetch(`${srv.baseUrl}${url}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-access-token': token },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return r;
  };
  const login = async (u) => {
    const r = await fetch(`${srv.baseUrl}/api/v1/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: u.username, password: u.password }),
    });
    return (await r.json()).token;
  };

  before(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fixlib-'));
    libDir = path.join(workDir, 'lib');
    const cover = path.join(workDir, 'cover-src.jpg');
    await execFileP('ffmpeg', ['-nostdin', '-y', '-f', 'lavfi', '-i', 'testsrc=size=128x128', '-frames:v', '1', cover]);
    await makeTrack(path.join(libDir, 'sub', 'Zebra Sub One.mp3'), 'Zebra Sub One');
    await makeTrack(path.join(libDir, 'sub', 'inner', 'Zebra Sub Two.mp3'), 'Zebra Sub Two');
    await makeTrack(path.join(libDir, 'other', 'Zebra Other.mp3'), 'Zebra Other');
    await makeTrack(path.join(libDir, 'art', 'Zebra Art.mp3'), 'Zebra Art', { cover });
    await makeTrack(path.join(libDir, 'flac', 'Zebra Flac.flac'), 'Zebra Flac', { flac: true });
    await fs.mkdir(path.join(libDir, 'big'), { recursive: true });
    await fs.writeFile(path.join(libDir, 'big', 'blob.bin'), crypto.randomBytes(2 * 1024 * 1024));

    srv = await startServer({
      users: [{ ...ADMIN, vpaths: ['testlib', 'Lib', 'Child', 'Other'] }, KID],
      extraFolders: { Lib: libDir, Child: path.join(libDir, 'sub'), Other: path.join(libDir, 'other') },
      extraConfig: { scanOptions: { bootScanEnabled: true, bootScanDelay: 0, maxZipMb: 1 } },
    });
    adminToken = await login(ADMIN);
    kidToken = await login(KID);

    const deadline = Date.now() + 30_000;
    for (;;) {
      const r = await api(adminToken, 'POST', '/api/v1/db/metadata', { filepath: 'Lib/flac/Zebra Flac.flac' });
      const j = await r.json();
      const st = await (await fetch(`${srv.baseUrl}/api/v1/db/status`)).json();
      if (j.metadata && !st.locked) break;
      if (Date.now() > deadline) throw new Error('Lib scan did not finish');
      await new Promise(r2 => setTimeout(r2, 250));
    }
  });

  after(async () => {
    await srv?.stop();
    await fs.rm(workDir, { recursive: true, force: true });
  });

  it('P006: folder zip holds only the chosen folder for a child-only user', async () => {
    const r = await api(kidToken, 'POST', '/api/v1/download/directory', { directory: 'Lib/sub/inner' });
    assert.equal(r.status, 200);
    const names = zipEntryNames(Buffer.from(await r.arrayBuffer()));
    assert.deepEqual(names.filter(n => !n.endsWith('/')), ['Zebra Sub Two.mp3']);
  });

  it('P006: folder zip over the size budget returns 413', async () => {
    const r = await api(adminToken, 'POST', '/api/v1/download/directory', { directory: 'Lib/big' });
    assert.equal(r.status, 413);
    const j = await r.json();
    assert.equal(j.maxMb, 1);
  });

  it('P095: a play sent with a child-vpath path counts against the parent-root row', async () => {
    const r = await api(kidToken, 'POST', '/api/v1/wrapped/play-start', { filePath: 'Child/Zebra Sub One.mp3', sessionId: 'fixlib-s1' });
    assert.equal(r.status, 200);
    assert.notEqual((await r.json()).ok, false);
    const lp = await api(kidToken, 'POST', '/api/v1/db/stats/log-play', { filePath: 'Child/Zebra Sub One.mp3' });
    assert.equal((await lp.json()).ok, true);
    const meta = await (await api(kidToken, 'POST', '/api/v1/db/metadata', { filepath: 'Child/Zebra Sub One.mp3' })).json();
    assert.equal(meta.filepath, 'Lib/sub/Zebra Sub One.mp3');
    const recent = await (await api(kidToken, 'POST', '/api/v1/db/stats/recently-played', { limit: 10 })).json();
    assert.ok(recent.some(s => s.filepath === 'Lib/sub/Zebra Sub One.mp3'), JSON.stringify(recent));
  });

  it('P009/P052: an unscanned file is indexed on first play under the ROOT vpath with the scanner hash', async () => {
    const dest = path.join(libDir, 'sub', 'Zebra Late.mp3');
    await makeTrack(dest, 'Zebra Late');
    const lp = await api(kidToken, 'POST', '/api/v1/db/stats/log-play', { filePath: 'Child/Zebra Late.mp3' });
    assert.equal(lp.status, 200);
    assert.equal((await lp.json()).ok, true);
    const meta = await (await api(kidToken, 'POST', '/api/v1/db/metadata', { filepath: 'Child/Zebra Late.mp3' })).json();
    assert.equal(meta.filepath, 'Lib/sub/Zebra Late.mp3');
    assert.match(meta.metadata.hash, /^[a-f0-9]{32}$/);
    assert.equal(meta.metadata.hash, await computeFileHash(dest));
  });

  it('P088: on-demand art uses the same cache name as the scanner and writes one set', async () => {
    const meta = await (await api(adminToken, 'POST', '/api/v1/db/metadata', { filepath: 'Lib/art/Zebra Art.mp3' })).json();
    const scanned = meta.metadata['album-art'];
    assert.match(scanned, /^[a-f0-9]{32}\.jpg$/);
    const r = await api(adminToken, 'GET', `/api/v1/files/art?fp=${encodeURIComponent('Lib/art/Zebra Art.mp3')}`);
    assert.equal((await r.json()).aaFile, scanned);
    const base = scanned.replace(/\.jpg$/, '');
    const files = (await fs.readdir(path.join(srv.tmpDir, 'image-cache'))).filter(f => f.includes(base)).sort();
    assert.deepEqual(files, [scanned, `zl-${scanned}`, `zm-${scanned}`, `zs-${scanned}`].sort());
  });

  it('P094: subsonic advertises and serves audio/flac for FLAC', async () => {
    const q = (extra) => '?' + new URLSearchParams({ u: ADMIN.username, p: ADMIN.password, v: '1.16.1', c: 'fixlib', f: 'json', ...extra });
    const sr = (await (await fetch(`${srv.subsonicBaseUrl}/rest/search3${q({ query: 'Zebra Flac', songCount: 5 })}`)).json())['subsonic-response'];
    const song = sr.searchResult3.song.find(s => s.title === 'Zebra Flac');
    assert.equal(song.contentType, 'audio/flac');
    const st = await fetch(`${srv.subsonicBaseUrl}/rest/stream${q({ id: song.id, format: 'raw' })}`);
    assert.equal(st.status, 200);
    assert.match(st.headers.get('content-type'), /^audio\/flac/);
    await st.arrayBuffer();
  });

  it('P005: per-request fields never reach the saved config, and a folder change takes effect at once', async () => {
    const before = await (await api(kidToken, 'POST', '/api/v1/db/search', { search: 'Zebra Sub' })).json();
    assert.ok(before.title.length > 0);

    const r = await api(adminToken, 'POST', '/api/v1/admin/users/vpaths', { username: 'kid', vpaths: ['testlib'] });
    assert.equal(r.status, 200);

    const saved = JSON.parse(await fs.readFile(path.join(srv.tmpDir, 'config.json'), 'utf8'));
    for (const [name, u] of Object.entries(saved.users)) {
      assert.ok(!('dbVpaths' in u), `${name} has dbVpaths saved`);
      assert.ok(!('username' in u), `${name} has username saved`);
    }

    const after = await (await api(kidToken, 'POST', '/api/v1/db/search', { search: 'Zebra' })).json();
    assert.deepEqual(after.title.filter(t => t.filepath.startsWith('Lib/')), []);
  });
});
