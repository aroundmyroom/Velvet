/**
 * Hash Migration Tests
 * Verifies that when a file is re-indexed with a new hash (e.g. external tag editor
 * rewrites bytes and mtime changes), user_metadata and play_events rows are migrated
 * to the new hash — preserving play counts, ratings, stars, and play history.
 * Runs the real migrateHash() from src/db/sqlite-backend.js against the real schema.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const fs = require('fs');

let backend, workDir;

before(async () => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hash-migration-'));
  backend = await import('../../src/db/sqlite-backend.js');
  backend.init(workDir);
});

after(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

function createTestDb() {
  const db = backend.getDB();
  db.exec('DELETE FROM user_metadata; DELETE FROM play_events; DELETE FROM files;');
  return db;
}

// ---------------------------------------------------------------------------
describe('Hash Migration', () => {
  // -------------------------------------------------------------------------
  describe('migrateHash – no-op guards', () => {
    it('should do nothing when oldHash is null', () => {
      const db = createTestDb();
      db.prepare("INSERT INTO user_metadata (hash, user, pc) VALUES ('abc', 'user1', 5)").run();
      backend.migrateHash(null, 'xyz');
      const row = db.prepare("SELECT pc FROM user_metadata WHERE hash = 'abc'").get();
      assert.strictEqual(row.pc, 5, 'row untouched when oldHash is null');
    });

    it('should do nothing when newHash is null', () => {
      const db = createTestDb();
      db.prepare("INSERT INTO user_metadata (hash, user, pc) VALUES ('abc', 'user1', 5)").run();
      backend.migrateHash('abc', null);
      const row = db.prepare("SELECT pc FROM user_metadata WHERE hash = 'abc'").get();
      assert.strictEqual(row.pc, 5, 'row untouched when newHash is null');
    });

    it('should do nothing when oldHash === newHash', () => {
      const db = createTestDb();
      db.prepare("INSERT INTO user_metadata (hash, user, pc) VALUES ('abc', 'user1', 5)").run();
      backend.migrateHash('abc', 'abc');
      const row = db.prepare("SELECT pc FROM user_metadata WHERE hash = 'abc'").get();
      assert.strictEqual(row.pc, 5, 'row untouched when hashes are equal');
    });
  });

  // -------------------------------------------------------------------------
  describe('user_metadata migration', () => {
    it('should migrate play count, rating, star to new hash', () => {
      const db = createTestDb();
      const oldHash = 'oldhash_' + crypto.randomBytes(4).toString('hex');
      const newHash = 'newhash_' + crypto.randomBytes(4).toString('hex');

      db.prepare('INSERT INTO user_metadata (hash, user, rating, pc, starred) VALUES (?, ?, ?, ?, ?)')
        .run(oldHash, 'alice', 4, 12, 1);

      backend.migrateHash(oldHash, newHash);

      const gone = db.prepare('SELECT * FROM user_metadata WHERE hash = ?').get(oldHash);
      const moved = db.prepare('SELECT * FROM user_metadata WHERE hash = ?').get(newHash);

      assert.strictEqual(gone, undefined, 'old hash row must be gone');
      assert.ok(moved, 'new hash row must exist');
      assert.strictEqual(moved.rating, 4);
      assert.strictEqual(moved.pc, 12);
      assert.strictEqual(moved.starred, 1);
    });

    it('should migrate multiple users for the same file', () => {
      const db = createTestDb();
      const oldHash = 'oldhash_multi_' + crypto.randomBytes(4).toString('hex');
      const newHash = 'newhash_multi_' + crypto.randomBytes(4).toString('hex');

      db.prepare('INSERT INTO user_metadata (hash, user, pc) VALUES (?, ?, ?)').run(oldHash, 'alice', 3);
      db.prepare('INSERT INTO user_metadata (hash, user, pc) VALUES (?, ?, ?)').run(oldHash, 'bob', 7);

      backend.migrateHash(oldHash, newHash);

      const aliceRow = db.prepare("SELECT pc FROM user_metadata WHERE hash = ? AND user = 'alice'").get(newHash);
      const bobRow   = db.prepare("SELECT pc FROM user_metadata WHERE hash = ? AND user = 'bob'").get(newHash);

      assert.strictEqual(aliceRow.pc, 3, "alice's play count preserved");
      assert.strictEqual(bobRow.pc, 7, "bob's play count preserved");
    });

    it('should leave unrelated rows untouched', () => {
      const db = createTestDb();
      const oldHash  = 'old_' + crypto.randomBytes(4).toString('hex');
      const newHash  = 'new_' + crypto.randomBytes(4).toString('hex');
      const otherHash = 'other_' + crypto.randomBytes(4).toString('hex');

      db.prepare('INSERT INTO user_metadata (hash, user, pc) VALUES (?, ?, ?)').run(oldHash, 'alice', 5);
      db.prepare('INSERT INTO user_metadata (hash, user, pc) VALUES (?, ?, ?)').run(otherHash, 'alice', 99);

      backend.migrateHash(oldHash, newHash);

      const otherRow = db.prepare('SELECT pc FROM user_metadata WHERE hash = ?').get(otherHash);
      assert.strictEqual(otherRow.pc, 99, 'unrelated row must not be changed');
    });
  });

  // -------------------------------------------------------------------------
  describe('play_events migration', () => {
    it('should migrate all play history events to new hash', () => {
      const db = createTestDb();
      const oldHash = 'oldhash_pe_' + crypto.randomBytes(4).toString('hex');
      const newHash = 'newhash_pe_' + crypto.randomBytes(4).toString('hex');

      db.prepare('INSERT INTO play_events (user_id, file_hash, started_at) VALUES (?, ?, ?)').run('alice', oldHash, 1000);
      db.prepare('INSERT INTO play_events (user_id, file_hash, started_at) VALUES (?, ?, ?)').run('alice', oldHash, 2000);
      db.prepare('INSERT INTO play_events (user_id, file_hash, started_at) VALUES (?, ?, ?)').run('alice', oldHash, 3000);

      backend.migrateHash(oldHash, newHash);

      const oldEvents = db.prepare('SELECT COUNT(*) AS n FROM play_events WHERE file_hash = ?').get(oldHash);
      const newEvents = db.prepare('SELECT COUNT(*) AS n FROM play_events WHERE file_hash = ?').get(newHash);

      assert.strictEqual(oldEvents.n, 0, 'no events should remain under old hash');
      assert.strictEqual(newEvents.n, 3, 'all 3 events must be under new hash');
    });

    it('should leave play_events for other files untouched', () => {
      const db = createTestDb();
      const oldHash   = 'old_' + crypto.randomBytes(4).toString('hex');
      const newHash   = 'new_' + crypto.randomBytes(4).toString('hex');
      const otherHash = 'other_' + crypto.randomBytes(4).toString('hex');

      db.prepare('INSERT INTO play_events (user_id, file_hash, started_at) VALUES (?, ?, ?)').run('alice', oldHash, 1000);
      db.prepare('INSERT INTO play_events (user_id, file_hash, started_at) VALUES (?, ?, ?)').run('alice', otherHash, 9000);

      backend.migrateHash(oldHash, newHash);

      const otherCount = db.prepare('SELECT COUNT(*) AS n FROM play_events WHERE file_hash = ?').get(otherHash);
      assert.strictEqual(otherCount.n, 1, 'unrelated play events must not be changed');
    });
  });

  // -------------------------------------------------------------------------
  describe('real-world scenario: external tag editor rewrites file', () => {
    it('should preserve stats after MusicBrainz Picard rewrites tags', () => {
      const db = createTestDb();

      // File as originally scanned
      const oldHash = crypto.createHash('md5').update('original file bytes chunk').digest('hex');
      backend.insertFile({ filepath: 'Rock/Queen/Bohemian Rhapsody.mp3', vpath: 'Music', hash: oldHash, title: 'Bohemian Rhapsody', artist: 'Queen', album: 'A Night at the Opera' });

      // User has played it 42 times and rated it 5 stars
      db.prepare('INSERT INTO user_metadata (hash, user, rating, pc, starred) VALUES (?, ?, ?, ?, ?)').run(oldHash, 'admin', 5, 42, 1);
      for (let i = 0; i < 5; i++) {
        db.prepare('INSERT INTO play_events (user_id, file_hash, started_at) VALUES (?, ?, ?)').run('admin', oldHash, Date.now() + i * 1000);
      }

      // MusicBrainz Picard rewrites tags → mtime changes → scanner re-parses
      // File bytes change slightly (tag frame lengths differ) → new MD5
      const newHash = crypto.createHash('md5').update('rewritten file bytes chunk').digest('hex');
      assert.notStrictEqual(oldHash, newHash);

      // Scanner calls migrateHash
      backend.migrateHash(oldHash, newHash);

      // Update files table with new hash (simulates scanner add-file)
      db.prepare('UPDATE files SET hash = ? WHERE filepath = ? AND vpath = ?')
        .run(newHash, 'Rock/Queen/Bohemian Rhapsody.mp3', 'Music');

      // Verify everything is intact under new hash
      const meta = db.prepare('SELECT rating, pc, starred FROM user_metadata WHERE hash = ? AND user = ?').get(newHash, 'admin');
      assert.ok(meta, 'user_metadata must exist under new hash');
      assert.strictEqual(meta.rating, 5, 'rating preserved');
      assert.strictEqual(meta.pc, 42, 'play count preserved');
      assert.strictEqual(meta.starred, 1, 'starred preserved');

      const historyCount = db.prepare('SELECT COUNT(*) AS n FROM play_events WHERE file_hash = ?').get(newHash);
      assert.strictEqual(historyCount.n, 5, 'all 5 play history events preserved');

      const orphans = db.prepare('SELECT COUNT(*) AS n FROM user_metadata WHERE hash = ?').get(oldHash);
      assert.strictEqual(orphans.n, 0, 'no orphan metadata under old hash');
    });
  });
});
