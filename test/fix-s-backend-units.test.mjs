import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BACKEND = path.join(REPO, 'src/db/sqlite-backend.js');
const read = rel => fs.readFileSync(path.join(REPO, rel), 'utf8');

describe('resolveMediaPath', () => {
  let resolveMediaPath, dir;
  before(async () => {
    ({ resolveMediaPath } = await import('../src/util/media-access.js'));
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'velvet-sb-media-'));
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('decodes the vpath and the rest and resolves inside the root', () => {
    const folders = { 'Other Lib': { root: dir } };
    assert.deepEqual(resolveMediaPath('/Other%20Lib/A%20b/c.mp3', folders), {
      vpath: 'Other Lib', relPath: 'A b/c.mp3', filePath: path.join(dir, 'A b', 'c.mp3'),
    });
  });

  it('refuses unknown vpaths, bare vpaths, bad encoding and traversal with a status', () => {
    const folders = { Music: { root: dir } };
    assert.deepEqual(resolveMediaPath('/Nope/a.mp3', folders), { status: 404 });
    assert.deepEqual(resolveMediaPath('/Music', folders), { status: 404 });
    assert.deepEqual(resolveMediaPath('/', folders), { status: 404 });
    assert.deepEqual(resolveMediaPath('/constructor/x', folders), { status: 404 });
    assert.deepEqual(resolveMediaPath('/Music/%E0%A4%A.mp3', folders), { status: 400 });
    assert.deepEqual(resolveMediaPath('/Music/..%2F..%2Fetc%2Fpasswd', folders), { status: 403 });
  });

  it('is the one resolver for /media and DLNA', () => {
    assert.doesNotMatch(read('src/server.js'), /function resolveMediaRequest/);
    assert.doesNotMatch(read('src/api/dlna.js'), /function resolveMediaFile|resolvePathWithinRoot/);
    assert.match(read('src/api/dlna.js'), /resolveMediaPath\(req\.path, config\.program\.folders\)/);
    assert.match(read('src/server.js'), /resolveMediaPath\(req\.path, config\.program\.folders\)/);
  });
});

describe('shutdown sequence', () => {
  it('runs the phases in order, waits for each, and survives a failing or hanging hook', async () => {
    const { onShutdown, runShutdown, PHASE } = await import('../src/state/shutdown.js');
    const order = [];
    onShutdown('t-db', PHASE.DB, () => { order.push('db'); });
    onShutdown('t-http', PHASE.HTTP, () => { order.push('http'); });
    onShutdown('t-rooms', PHASE.SERVICES, async () => { await new Promise(r => setTimeout(r, 50)); order.push('rooms'); });
    onShutdown('t-broken', PHASE.SERVICES, () => { throw new Error('boom'); });
    await runShutdown();
    assert.deepEqual(order, ['rooms', 'http', 'db']);
    assert.equal(runShutdown(), runShutdown(), 'one shutdown per process');
  });

  it('sendspin registers on it instead of owning the signals', () => {
    const src = read('src/api/sendspin.js');
    assert.doesNotMatch(src, /process\.on\('SIG/);
    assert.match(src, /onShutdown\('sendspin', PHASE\.SERVICES/);
    assert.match(read('src/server.js'), /onShutdown\('db', PHASE\.DB, \(\) => dbManager\.close\(\)\)/);
    assert.match(read('src/db/manager.js'), /export function close\(\)/);
  });
});

describe('v5 migration drops audio_features', () => {
  let dir;
  const initIn = d => execFileSync(process.execPath, ['--input-type=module', '-e',
    `import * as b from ${JSON.stringify(BACKEND)}; b.init(${JSON.stringify(d)}); b.close();`], { stdio: 'ignore' });
  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'velvet-sb-v5-')); });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('a v4 DB loses the table and moves to v5', () => {
    initIn(dir);
    const raw = new DatabaseSync(path.join(dir, 'velvet.sqlite'));
    raw.exec('CREATE TABLE audio_features (hash TEXT PRIMARY KEY, danceability REAL)');
    raw.exec('PRAGMA user_version = 4');
    raw.close();
    initIn(dir);
    const after = new DatabaseSync(path.join(dir, 'velvet.sqlite'));
    assert.equal(after.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'audio_features'").get().n, 0);
    assert.equal(after.prepare('PRAGMA user_version').get().user_version, 6);
    after.close();
  });

  it('a fresh DB never creates the table', () => {
    const fresh = fs.mkdtempSync(path.join(dir, 'fresh-'));
    initIn(fresh);
    const raw = new DatabaseSync(path.join(fresh, 'velvet.sqlite'));
    assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'audio_features'").get().n, 0);
    raw.close();
  });

  it('smart-playlist feature queries work without the table', async () => {
    const backend = await import('../src/db/sqlite-backend.js');
    const d = fs.mkdtempSync(path.join(dir, 'sp-'));
    backend.init(d);
    try {
      backend.getDB().prepare("INSERT INTO files (vpath, filepath, hash, format, genre, bpm) VALUES ('M', 'a.mp3', 'h1', 'mp3', 'disco', 120)").run();
      const rows = backend.spGetAllTracksWithFeatures(['M']);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].genre, 'disco');
      assert.ok(!('danceability' in rows[0]));
      assert.equal(backend.spGetTrackFeatures('h1').bpm, 120);
    } finally {
      backend.close();
    }
  });
});

describe('feature vector', () => {
  it('dimensions 5 and 6 are fixed midpoints', async () => {
    const { extractVector } = await import('../src/smartplaylist/feature-extractor.js');
    const v = extractVector({ genre: 'disco', year: 1980, bpm: 120, musical_key: 'A minor', duration: 300, danceability: 0.9, loudness: -2 });
    assert.equal(v.length, 7);
    assert.equal(v[5], 0.5);
    assert.equal(v[6], 0.5);
  });
});

describe('dead code is gone', () => {
  it('audio-features route and helpers', () => {
    assert.doesNotMatch(read('src/api/db.js'), /audio-features/);
    for (const f of ['src/db/manager.js', 'src/db/sqlite-backend.js']) {
      assert.doesNotMatch(read(f), /saveAudioFeatures|getAudioFeatures|LEFT JOIN audio_features/);
    }
  });

  it('duplicate-hash set, unused exports', () => {
    const mgr = read('src/db/manager.js');
    const be = read('src/db/sqlite-backend.js');
    assert.doesNotMatch(mgr + be + read('src/api/scanner.js'), /refreshDuplicateHashes|_duplicateHashes/);
    assert.doesNotMatch(mgr, /getMbTextSearchStats|artistHasAlbums/);
    assert.doesNotMatch(be, /export function (getMbTextSearchStats|getMbEnrichStats|deleteAllApiKeysByUsername|artistHasAlbums)\b/);
  });

  it('DLNA queries go through the manager', () => {
    assert.doesNotMatch(read('src/api/dlna.js'), /getDB\(\)/);
  });

  it('workers open their connection through src/db/worker-connection.js', () => {
    for (const f of fs.readdirSync(path.join(REPO, 'src/util')).filter(n => n.endsWith('-worker.mjs'))) {
      assert.doesNotMatch(read(`src/util/${f}`), /DatabaseSync/, f);
    }
  });
});
