import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

let dir, backend, raw;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'velvet-mdb-'));
  backend = await import('../src/db/sqlite-backend.js');
  backend.init(dir);
  raw = new DatabaseSync(path.join(dir, 'velvet.sqlite'));
});
after(() => { raw.close(); backend.close(); fs.rmSync(dir, { recursive: true, force: true }); });

describe('deleteAllUserData', () => {
  it('removes every per-user row and leaves other users alone', () => {
    const tables = [
      ['user_metadata', 'user'], ['playlists', 'user'], ['shared_playlists', 'user'], ['user_settings', 'username'],
      ['radio_stations', 'user'], ['radio_schedules', 'username'], ['smart_playlists', 'user'], ['bookmarks', 'username'],
      ['play_queues', 'username'], ['play_events', 'user_id'], ['listening_sessions', 'user_id'],
      ['radio_play_events', 'user_id'], ['podcast_play_events', 'user_id'], ['sp_slot_profiles', 'user_id'],
      ['sp_generated_playlists', 'user_id'], ['subsonic_api_keys', 'username'], ['passkeys', 'username'], ['podcast_feeds', 'user'],
    ];
    const userCount = (t, c, u) => raw.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE ${c} = ?`).get(u).n;
    const fill = (t, c, u) => {
      const cols = raw.prepare(`PRAGMA table_info(${t})`).all().filter(col => !(col.pk && col.type.toUpperCase() === 'INTEGER'));
      const vals = cols.map(col => {
        if (col.name === c) return u;
        return /INT|REAL/i.test(col.type) ? 1 : `${t}-${col.name}-${u}`;
      });
      raw.prepare(`INSERT INTO ${t} (${cols.map(col => col.name).join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...vals);
    };
    for (const [t, c] of tables) {
      fill(t, c, 'gone');
      fill(t, c, 'stays');
      assert.equal(userCount(t, c, 'gone'), 1, t);
    }
    const feedId = raw.prepare("SELECT id FROM podcast_feeds WHERE user = 'gone'").get().id;
    raw.prepare("INSERT INTO podcast_episodes (feed_id, guid, audio_url) VALUES (?, 'g', 'https://example.com/a.mp3')").run(feedId);

    backend.deleteAllUserData('gone');

    for (const [t, c] of tables) {
      assert.equal(userCount(t, c, 'gone'), 0, t);
      assert.equal(userCount(t, c, 'stays'), 1, t);
    }
    assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM podcast_episodes WHERE feed_id = ?').get(feedId).n, 0);
  });
});

describe('random-pick queries honour includeFilepathPrefixes', () => {
  it('count, offset pick and full load agree', () => {
    const ins = raw.prepare('INSERT INTO files (vpath, filepath, hash) VALUES (?, ?, ?)');
    for (const [v, f] of [['M', 'A/1.mp3'], ['M', 'B/2.mp3'], ['M', 'C/3.mp3'], ['O', 'x.mp3']]) ins.run(v, f, `${v}${f}`);
    const opts = { includeFilepathPrefixes: [{ vpath: 'M', prefix: 'A/' }, { vpath: 'M', prefix: 'B/' }] };
    const vp = ['M', 'O'];
    assert.equal(backend.countFilesForRandom(vp, 'u', opts), 3);
    const picked = [0, 1, 2].map(i => backend.pickFileAtOffset(vp, 'u', opts, i)).map(r => `${r.vpath}/${r.filepath}`).sort();
    assert.deepEqual(picked, ['M/A/1.mp3', 'M/B/2.mp3', 'O/x.mp3']);
    const all = backend.getAllFilesWithMetadata(vp, 'u', opts).map(r => `${r.vpath}/${r.filepath}`).sort();
    assert.deepEqual(all, picked);
  });

  it('the shared Auto-DJ pool (rooms and returnAll) passes the whitelist through', async () => {
    const { batchCandidatePool } = await import('../src/autodj/pool.js');
    const body = { includeFilepathPrefixes: [{ vpath: 'M', prefix: 'A/' }, { vpath: 'M', prefix: 'B/' }] };
    const pool = batchCandidatePool(opts => backend.getAllFilesWithMetadata(['M', 'O'], 'u', { ...opts, columns: 'autodj' }), body, () => 0);
    assert.deepEqual(pool.songs.map(r => `${r.vpath}/${r.filepath}`).sort(), ['M/A/1.mp3', 'M/B/2.mp3', 'O/x.mp3']);
  });
});
