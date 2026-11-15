/**
 * After a scan: the AI DJ sees new genres at once (P101) and the ReplayGain
 * "undo reset all" backup survives the post-scan auto-start (P110). Orphan
 * routes that were removed answer 404, the kept ones still answer (P076/P086/P107).
 *
 * Run with:
 *   node --test test/integration/fix-r-workers-routes.test.cjs
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

function makeTrack(root, rel, tags) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const args = ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=22050:cl=mono', '-t', '0.3'];
  for (const [k, v] of Object.entries(tags)) args.push('-metadata', `${k}=${v}`);
  args.push('-c:a', 'libmp3lame', '-b:a', '32k', p);
  execFileSync(FFMPEG, args);
}

const BRIEF = {
  title: 'Zouk', summary: 'Zouk.', songs: 3, minutes: null, genres: ['Zouk'], excludeGenres: [], families: [],
  yearFrom: null, yearTo: null, bpmFrom: null, bpmTo: null, energy: 'build', artists: [], artistMode: 'feature', excludeArtists: [],
  folders: [], keywords: [], favourites: false, discovery: false, minRating: null, clarification: null,
};

describe('r-workers: scan-end caches and orphan routes', async () => {
  const { startServer } = await import('../helpers/server.mjs');
  let srv, root, dbPath;
  const call = async (method, p, body) => {
    const r = await fetch(srv.baseUrl + p, {
      method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let json;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: r.status, body: json };
  };
  const build = () => call('POST', '/api/v1/ai/queue/build', { brief: BRIEF, ignoreVPaths: ['testlib'] });
  const zoukUnknown = out => out.notes.some(n => n.code === 'genreUnknown' && n.name === 'Zouk');

  before(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'velvet-fix-r-'));
    for (let i = 1; i <= 6; i++) makeTrack(root, `Disco/${i}.mp3`, { artist: `Act ${i}`, title: `Disco ${i}`, genre: 'disco', date: '1979' });
    srv = await startServer({ extraFolders: { lib: root }, extraConfig: { aiAssist: { enabled: true, queueBuilder: true, maxQueueSongs: 10 } }, waitForScan: true });
    dbPath = path.join(srv.tmpDir, 'db', 'velvet.sqlite');
  });
  after(async () => {
    await srv?.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('removed orphan routes answer 404', async () => {
    assert.equal((await call('GET', '/api/v1/admin/rg/tool')).status, 404);
    assert.equal((await call('GET', '/api/v1/tagworkshop/text-search/status')).status, 404);
    assert.equal((await call('POST', '/api/v1/artists/fetch-info', { artistKey: 'x' })).status, 404);
  });

  it('kept routes still answer', async () => {
    assert.equal((await call('GET', '/api/v1/admin/rg/status')).body.tool !== undefined, true);
    assert.equal((await call('POST', '/api/v1/artists/set-name', { artistKey: 'nobody-here', canonicalName: 'X' })).status, 404);
    const tadb = await call('POST', '/api/v1/admin/artists/enrich-tadb');
    assert.equal(tadb.status, 200, JSON.stringify(tadb.body));
    assert.equal(tadb.body.ok, true);
    const nf = await call('POST', '/api/v1/acoustid/reset-not-found');
    assert.equal(nf.status, 200, JSON.stringify(nf.body));
    assert.equal(nf.body.reset, 0);
  });

  it('a rescan refreshes the AI DJ library and keeps the RG undo backup', { timeout: 90_000 }, async () => {
    const first = await build();
    assert.equal(first.status, 200);
    assert.ok(zoukUnknown(first.body), 'no zouk yet');

    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA busy_timeout = 5000');
    const seeded = db.prepare(`UPDATE files SET rg_measured_ts = 1700000000, rg_measurement_tool = 'ffmpeg',
      rg_integrated_lufs = -9.5, rg_true_peak_dbfs = -0.5, rg_track_gain_db = -8.5 WHERE format IS NOT NULL`).run().changes;
    assert.ok(seeded > 0);
    const reset = await call('POST', '/api/v1/admin/rg/reset-all');
    assert.equal(reset.body.backedUp, seeded);

    // a genre needs 10 tracks before the AI DJ lists it (genre-merge MIN_CNT)
    for (let i = 12; i >= 1; i--) makeTrack(root, `Zouk/${i}.mp3`, { artist: `Kassav ${i}`, title: `Zouk ${i}`, genre: 'Zouk', date: '1984' });
    assert.equal((await call('POST', '/api/v1/admin/db/scan/all')).status, 200);
    for (let i = 0; i < 120; i++) {
      const st = (await call('GET', '/api/v1/db/status')).body;
      const n = db.prepare("SELECT COUNT(*) AS n FROM files WHERE filepath = 'Zouk/1.mp3'").get().n;
      if (n === 1 && !st.locked) break;
      await sleep(250);
    }

    await sleep(1100);
    const second = await build();
    assert.equal(second.status, 200);
    assert.ok(!zoukUnknown(second.body), 'the new genre is known right after the scan: ' + JSON.stringify(second.body.notes));
    assert.ok(second.body.songs.length > 0 && second.body.songs.every(s => s.filepath.includes('/Zouk/')), JSON.stringify(second.body.songs.map(s => s.filepath)));

    // RG is the 4th post-scan auto-start (5 s stagger); give it time to (not) start.
    for (let i = 0; i < 40; i++) {
      const st = (await call('GET', '/api/v1/admin/rg/status')).body;
      assert.equal(st.running, false, 'auto-start must not run while an undo backup exists');
      assert.equal(st.undo.available, true);
      await sleep(500);
    }
    const undo = await call('POST', '/api/v1/admin/rg/undo-reset-all');
    assert.equal(undo.status, 200);
    assert.equal(undo.body.restored, seeded);
    const back = db.prepare('SELECT COUNT(*) AS n FROM files WHERE rg_track_gain_db = -8.5').get().n;
    assert.equal(back, seeded);
    db.close();
  });
});
