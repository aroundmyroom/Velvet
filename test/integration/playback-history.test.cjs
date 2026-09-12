const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function loadBackend() {
  const mod = await import('../../src/db/sqlite-backend.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'velvet-playback-'));
  mod.init(dir);
  return { mod, dir };
}

describe('playback history', () => {
  it('writes server-side play starts into the shared play_event ledger', async () => {
    const { mod } = await loadBackend();
    const db = mod.getDB();
    db.prepare('INSERT INTO files (filepath, vpath, hash, title, artist, album, duration) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('Album/Track.mp3', 'Music', 'hash-123', 'Test Song', 'Test Artist', 'Test Album', 240);
    const startedAt = 1_700_000_000_000;
    const eventId = mod.recordPlaybackStart({
      user_id: 'alice',
      file_hash: 'hash-123',
      started_at: startedAt,
      duration_ms: 240000,
      source: 'server-playback',
      session_id: 'server-playback:alice:1',
    });

    assert.ok(eventId > 0, 'a play event row should be created');

    const rows = mod.getHistoryEvents('alice', startedAt - 1000, startedAt + 5000);
    assert.strictEqual(rows.length, 1, 'the history should include the server-side play start');
    assert.strictEqual(rows[0].title, 'Test Song', 'the file metadata should be joined back into the history row');
    assert.strictEqual(rows[0].completed, 0, 'the started event is still active until it is completed');
  });
});
