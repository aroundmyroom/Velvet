/**
 * Round 5, group E, against a real server: RG "reset failed" never deletes
 * library rows (N038), the Duplicate Workshop scan / delete flow (N040/N041),
 * Tag Workshop child folders under a root with a trailing slash (N050/N125),
 * removed album-level accept (N119), Deezer search is admin-only (N118),
 * yt-dlp refuses private hosts (N113), AI admin handlers use the validated body
 * (N124), plus route coverage for radio schedules, podcasts and BPM (N127).
 *
 * Run with:
 *   node --test test/integration/fix-v-E-routes.test.cjs
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const FFMPEG = ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg'].find(p => fs.existsSync(p)) ?? 'ffmpeg';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// The album tag keeps the audio hash of a copy equal (without it the folder name is the album)
function makeTrack(root, rel, title) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=22050:cl=mono', '-t', '0.3',
    '-metadata', 'artist=Act', '-metadata', `title=${title}`, '-metadata', 'album=Tests', '-c:a', 'libmp3lame', '-b:a', '32k', p]);
}

describe('v-E: workshop, RG and user routes', async () => {
  const { startServer } = await import('../helpers/server.mjs');
  let srv, root, recDir, outside, dbPath;
  const tokens = {};

  const call = async (who, method, p, body) => {
    const headers = { 'x-access-token': tokens[who] };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const r = await fetch(srv.baseUrl + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    try { return { status: r.status, body: text ? JSON.parse(text) : null }; } catch { return { status: r.status, body: text }; }
  };
  const fileRow = (vpath, filepath) => {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try { return db.prepare('SELECT rowid AS id, rg_measured_ts FROM files WHERE vpath = ? AND filepath = ?').get(vpath, filepath); } finally { db.close(); }
  };

  before(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'velvet-fix-v-E-'));
    recDir = fs.mkdtempSync(path.join(os.tmpdir(), 'velvet-fix-v-E-rec-'));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'velvet-fix-v-E-out-'));
    for (let i = 1; i <= 3; i++) makeTrack(root, `Disco/${i}.mp3`, `Disco ${i}`);
    makeTrack(root, 'DupA/x.mp3', 'Dup X');
    makeTrack(root, 'DupA/y.mp3', 'Dup Y');
    fs.mkdirSync(path.join(root, 'DupB'));
    for (const f of ['x.mp3', 'y.mp3']) fs.copyFileSync(path.join(root, 'DupA', f), path.join(root, 'DupB', f));
    makeTrack(root, 'Gone/z.mp3', 'Gone');

    const vpaths = ['lib', 'child', 'rec'];
    srv = await startServer({
      users: [
        { username: 'boss', password: 'pw-boss', admin: true, vpaths },
        { username: 'alice', password: 'pw-alice', admin: false, vpaths },
        { username: 'bob', password: 'pw-bob', admin: false, vpaths },
        { username: 'carol', password: 'pw-carol', admin: false, vpaths: ['child'] },
      ],
      extraConfig: {
        folders: {
          lib: { root: root + '/' },
          child: { root: path.join(root, 'Disco') },
          rec: { root: recDir, type: 'recordings' },
        },
        aiAssist: { enabled: true },
      },
    });
    dbPath = path.join(srv.tmpDir, 'db', 'velvet.sqlite');
    for (const u of ['boss', 'alice', 'bob', 'carol']) {
      const r = await fetch(srv.baseUrl + '/api/v1/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: u, password: `pw-${u}` }),
      });
      tokens[u] = (await r.json()).token;
    }
    for (const u of ['alice', 'bob']) {
      assert.equal((await call('boss', 'POST', '/api/v1/admin/users/allow-radio-recording', { username: u, allow: true })).status, 200);
    }
    assert.equal((await call('boss', 'POST', '/api/v1/admin/users/allow-youtube-download', { username: 'alice', allow: true })).status, 200);
    for (const t0 = Date.now(); !fileRow('lib', 'Gone/z.mp3') || !fileRow('lib', 'DupB/y.mp3');) {
      if (Date.now() - t0 > 30_000) throw new Error('library scan did not finish');
      await sleep(250);
    }
  });

  after(async () => {
    await srv?.stop();
    for (const d of [root, recDir, outside]) if (d) fs.rmSync(d, { recursive: true, force: true });
  });

  it('Tag Workshop lists a child folder whose root vpath is configured with a trailing slash', async () => {
    const r = await call('boss', 'GET', '/api/v1/tagworkshop/folder?path=child');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.files.map(f => `${f.vpath}/${f.filepath}`).sort(), ['lib/Disco/1.mp3', 'lib/Disco/2.mp3', 'lib/Disco/3.mp3']);
  });

  it('the album-level Tag Workshop accept route is gone', async () => {
    assert.equal((await call('boss', 'POST', '/api/v1/tagworkshop/accept', { mb_release_id: 'x' })).status, 404);
  });

  it('Deezer search is admin-only like the other cover searches', async () => {
    assert.equal((await call('alice', 'GET', '/api/v1/deezer/search?q=x')).status, 403);
  });

  it('RG reset-failed re-queues a missing file instead of deleting its row', async () => {
    const db = new DatabaseSync(dbPath);
    try {
      db.prepare("UPDATE files SET rg_measured_ts = -1, rg_measurement_tool = 'file_not_found' WHERE vpath = 'lib' AND filepath IN ('Gone/z.mp3', 'Disco/1.mp3')").run();
    } finally { db.close(); }
    fs.renameSync(path.join(root, 'Gone', 'z.mp3'), path.join(outside, 'z.mp3'));
    const r = await call('boss', 'POST', '/api/v1/admin/rg/reset-failed');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.reset >= 1, JSON.stringify(r.body));
    assert.equal(r.body.purged, undefined);
    assert.ok(fileRow('lib', 'Gone/z.mp3'), 'row of the missing file is kept');
    assert.ok(fileRow('lib', 'Disco/1.mp3'));
  });

  it('Duplicate Workshop scans in the background, then deletes one copy', { timeout: 60_000 }, async () => {
    assert.equal((await call('alice', 'GET', '/api/v1/admin/dup-workshop/status')).status, 403);
    assert.equal((await call('boss', 'POST', '/api/v1/admin/dup-workshop/cancel')).status, 400);
    const start = await call('boss', 'POST', '/api/v1/admin/dup-workshop/scan', { threshold: 90 });
    assert.equal(start.status, 202);
    const t0 = Date.now();
    let status = (await call('boss', 'GET', '/api/v1/admin/dup-workshop/status')).body;
    while (status.state !== 'done') {
      if (Date.now() - t0 > 30_000) throw new Error('scan did not finish: ' + JSON.stringify(status));
      await sleep(100);
      status = (await call('boss', 'GET', '/api/v1/admin/dup-workshop/status')).body;
    }
    assert.equal(status.threshold, 90);
    const exact = (await call('boss', 'GET', '/api/v1/admin/dup-workshop/songs?match=exact')).body;
    assert.equal(exact.total, 2, JSON.stringify(exact));
    assert.deepEqual(exact.groups.map(g => g.paths.slice().sort()).sort(), [
      ['lib/DupA/x.mp3', 'lib/DupB/x.mp3'], ['lib/DupA/y.mp3', 'lib/DupB/y.mp3'],
    ]);
    const folders = (await call('boss', 'GET', '/api/v1/admin/dup-workshop/folders')).body;
    assert.equal(folders.total, 1, JSON.stringify(folders));
    assert.deepEqual(folders.groups[0].copies.map(c => c.dir).sort(), ['lib/DupA', 'lib/DupB']);
    assert.equal((await call('boss', 'GET', '/api/v1/admin/dup-workshop/songs?match=similar')).body.total, 2);
    assert.equal(status.summary.files, 4, 'one removable copy per exact and per similar group');

    const del = await call('boss', 'POST', '/api/v1/admin/dup-workshop/delete', { filepaths: ['lib/DupB/x.mp3', 'nowhere/x.mp3'] });
    assert.equal(del.status, 200);
    assert.deepEqual(del.body.deleted, ['lib/DupB/x.mp3']);
    assert.equal(del.body.failed.length, 1);
    assert.equal(fs.existsSync(path.join(root, 'DupB', 'x.mp3')), false);
    assert.equal(fileRow('lib', 'DupB/x.mp3'), undefined);
    assert.ok(fileRow('lib', 'DupA/x.mp3'));
    assert.equal((await call('boss', 'GET', '/api/v1/admin/dup-workshop/songs?match=exact')).body.total, 1);
  });

  it('yt-dlp is never handed a private-network URL', async () => {
    const meta = await call('alice', 'GET', '/api/v1/ytdl/metadata?url=' + encodeURIComponent('http://127.0.0.1:9/'));
    assert.equal(meta.status, 400);
    assert.equal(meta.body.error, 'That URL is not allowed');
    const dl = await call('alice', 'POST', '/api/v1/ytdl/', { url: 'http://localhost/x' });
    assert.equal(dl.status, 400);
    assert.equal(dl.body.error, 'That URL is not allowed');
    assert.equal((await call('bob', 'GET', '/api/v1/ytdl/metadata?url=x')).status, 403);
  });

  it('AI library notes: an edit without the optional fields reaches the lookup', async () => {
    const edit = await call('boss', 'POST', '/api/v1/admin/ai/library-notes/edit', { key: 'nope', kind: 'artist', note: 'x' });
    assert.equal(edit.status, 404, JSON.stringify(edit.body));
    const reset = await call('boss', 'POST', '/api/v1/admin/ai/library-notes/reset', {});
    assert.equal(reset.status, 200, JSON.stringify(reset.body));
    assert.equal(typeof reset.body.removed, 'number');
  });

  it('radio schedules: only the owner can delete a schedule', async () => {
    const body = { stationName: 'S', streamUrl: 'https://radio.example.com/live', vpath: 'rec', startTime: '03:00', startDate: '2099-01-01', durationMinutes: 5 };
    assert.equal((await call('alice', 'POST', '/api/v1/radio/schedules', { ...body, streamUrl: 'http://127.0.0.1/live' })).status, 403);
    const created = await call('alice', 'POST', '/api/v1/radio/schedules', body);
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const id = created.body.id;
    assert.equal((await call('bob', 'DELETE', `/api/v1/radio/schedules/${id}`)).status, 404);
    assert.deepEqual((await call('alice', 'GET', '/api/v1/radio/schedules')).body.map(s => s.id), [id]);
    assert.equal((await call('alice', 'DELETE', `/api/v1/radio/schedules/${id}`)).status, 200);
    assert.deepEqual((await call('alice', 'GET', '/api/v1/radio/schedules')).body, []);
    assert.equal((await call('boss', 'GET', '/api/v1/radio/schedules')).status, 403);
  });

  it('podcast routes answer for a user without feeds', async () => {
    const feeds = await call('alice', 'GET', '/api/v1/podcast/feeds');
    assert.equal(feeds.status, 200);
    assert.deepEqual(feeds.body, []);
    assert.equal((await call('alice', 'GET', '/api/v1/podcast/preview?url=' + encodeURIComponent('http://127.0.0.1/feed'))).status, 400);
    assert.equal((await call('alice', 'GET', '/api/v1/podcast/episode/999/progress')).status, 404);
    assert.equal((await call('alice', 'POST', '/api/v1/podcast/episode/progress', { episodeId: 1, feedId: 999, position: 3 })).status, 404);
  });

  it('Smart Playlist ML gives a child-folder-only user tracks from that folder', { timeout: 30_000 }, async () => {
    const db = new DatabaseSync(dbPath);
    try {
      db.prepare("INSERT INTO play_events (user_id, file_hash, started_at) VALUES ('carol', 'none', ?)").run(Date.now());
      const up = db.prepare('INSERT INTO sp_slot_profiles (user_id, slot, play_count, last_event_id, updated_at) VALUES (?, ?, 5, 1000000, 0)');
      for (const slot of ['morning', 'afternoon', 'evening', 'night']) up.run('carol', slot);
    } finally { db.close(); }
    assert.equal((await call('boss', 'POST', '/api/v1/admin/smartplaylist/generate')).status, 200);
    const t0 = Date.now();
    let gen = (await call('carol', 'GET', '/api/v1/smartplaylist/generated?slot=morning')).body;
    while (!gen.generated_at) {
      if (Date.now() - t0 > 20_000) throw new Error('no playlist generated: ' + JSON.stringify(gen));
      await sleep(200);
      gen = (await call('carol', 'GET', '/api/v1/smartplaylist/generated?slot=morning')).body;
    }
    assert.ok(gen.tracks.length > 0);
    for (const t of gen.tracks) assert.match(t, /^lib\/Disco\//);
  });

  it('BPM admin routes are admin-only and answer', async () => {
    assert.equal((await call('alice', 'GET', '/api/v1/admin/bpm/status')).status, 403);
    assert.equal((await call('boss', 'GET', '/api/v1/admin/bpm/status')).status, 200);
    const reset = await call('boss', 'POST', '/api/v1/admin/bpm/essentia/reset-failed');
    assert.equal(reset.status, 200, JSON.stringify(reset.body));
  });
});
