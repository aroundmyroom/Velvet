/**
 * Child Vpath Exclusions — Unit Tests
 * Tests computeChildExclusions from src/api/db.js.
 *
 * The real function reads config.program.folders from module scope.
 * This inline version accepts allFolders as a parameter for testability
 * while preserving the exact same logic.
 *
 * Purpose: when a user has access to a parent vpath (e.g. "Music") but NOT
 * to a child vpath that lives under it (e.g. "12-inches" whose root is
 * /music/12 inches A-Z/), we must exclude that prefix from whole-library
 * queries so they don't see songs they shouldn't.
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// ── Inline mirror of computeChildExclusions from src/api/db.js ───────────────
// Parametrized with allFolders instead of reading config.program.folders.
function computeChildExclusions(userVpaths, allFolders) {
  const userSet = new Set(userVpaths);
  const exclusions = [];
  for (const [name, cfg] of Object.entries(allFolders)) {
    if (userSet.has(name)) continue; // user has access — nothing to exclude
    const childRoot = cfg.root.replace(/\/?$/, '/');
    // Find the user-accessible parent whose root is a strict prefix of this child
    const parentName = userVpaths.find(p => {
      const pr = (allFolders[p]?.root || '').replace(/\/?$/, '/');
      return pr.length > 0 && childRoot.startsWith(pr) && childRoot !== pr;
    });
    if (!parentName) continue;
    const prefix = childRoot.slice(allFolders[parentName].root.replace(/\/?$/, '/').length);
    if (prefix) exclusions.push({ vpath: parentName, prefix });
  }
  return exclusions;
}
// ─────────────────────────────────────────────────────────────────────────────

// Folders matching our real server setup
const REAL_FOLDERS = {
  'Music':                  { root: '/music' },
  '12-inches':              { root: '/music/12 inches A-Z' },
  'Unidisc 12-inch classics': { root: '/music/12 inches A-Z/12 Inch Classics on CD' },
  'Albums':                 { root: '/music/Albums' },
  'Recordings':             { root: '/music/Recordings', type: 'recordings' },
  'AudioBooks-Podcasts':    { root: '/podcasts', type: 'audio-books' },
};

describe('Child Vpath Exclusions', () => {

  describe('no exclusions needed', () => {
    it('returns empty array when user has all vpaths', () => {
      const result = computeChildExclusions(
        Object.keys(REAL_FOLDERS),  // all six vpaths
        REAL_FOLDERS
      );
      assert.deepEqual(result, []);
    });

    it('returns empty array when user has no vpaths', () => {
      const result = computeChildExclusions([], REAL_FOLDERS);
      assert.deepEqual(result, []);
    });

    it('returns empty array when vpaths are unrelated (different roots)', () => {
      const folders = {
        'Music':   { root: '/music' },
        'Podcasts': { root: '/podcasts' },
      };
      const result = computeChildExclusions(['Music'], folders);
      assert.deepEqual(result, []);
    });
  });

  describe('single child exclusion', () => {
    it('excludes 12-inches prefix when user has Music but not 12-inches', () => {
      const folders = {
        'Music':    { root: '/music' },
        '12-inches': { root: '/music/12 inches A-Z' },
      };
      const result = computeChildExclusions(['Music'], folders);
      assert.equal(result.length, 1);
      assert.equal(result[0].vpath, 'Music');
      assert.equal(result[0].prefix, '12 inches A-Z/');
    });

    it('excludes Albums prefix when user has Music but not Albums', () => {
      const folders = {
        'Music':  { root: '/music' },
        'Albums': { root: '/music/Albums' },
      };
      const result = computeChildExclusions(['Music'], folders);
      assert.equal(result.length, 1);
      assert.equal(result[0].vpath, 'Music');
      assert.equal(result[0].prefix, 'Albums/');
    });

    it('trailing slash on parent root is handled correctly', () => {
      const folders = {
        'Music':    { root: '/music/' },  // trailing slash variant
        '12-inches': { root: '/music/12 inches A-Z' },
      };
      const result = computeChildExclusions(['Music'], folders);
      assert.equal(result.length, 1);
      assert.equal(result[0].prefix, '12 inches A-Z/');
    });
  });

  describe('multiple child exclusions', () => {
    it('excludes multiple children when user lacks both', () => {
      const folders = {
        'Music':    { root: '/music' },
        '12-inches': { root: '/music/12 inches A-Z' },
        'Albums':    { root: '/music/Albums' },
      };
      const result = computeChildExclusions(['Music'], folders);
      assert.equal(result.length, 2);
      const prefixes = result.map(e => e.prefix).sort();
      assert.deepEqual(prefixes, ['12 inches A-Z/', 'Albums/']);
    });

    it('excludes only missing children when user has some', () => {
      const result = computeChildExclusions(
        ['Music', '12-inches'],  // has 12-inches, missing Albums and Recordings
        REAL_FOLDERS
      );
      const prefixes = result.map(e => e.prefix).sort();
      assert.ok(prefixes.includes('Albums/'));
      assert.ok(prefixes.includes('Recordings/'));
      assert.ok(!prefixes.includes('12 inches A-Z/'));
    });
  });

  describe('deeply nested child vpaths', () => {
    it('excludes grandchild prefix from correct parent', () => {
      const folders = {
        'Music':      { root: '/music' },
        '12-inches':  { root: '/music/12 inches A-Z' },
        'Unidisc':    { root: '/music/12 inches A-Z/Unidisc' },
      };
      // User has Music but not 12-inches or Unidisc
      const result = computeChildExclusions(['Music'], folders);
      assert.equal(result.length, 2);
      const prefixes = result.map(e => e.prefix).sort();
      // Both excluded from parent Music
      assert.deepEqual(prefixes, ['12 inches A-Z/', '12 inches A-Z/Unidisc/']);
    });

    it('reports grandchild exclusion against first matching parent (find semantics)', () => {
      const folders = {
        'Music':      { root: '/music' },
        '12-inches':  { root: '/music/12 inches A-Z' },
        'Unidisc':    { root: '/music/12 inches A-Z/Unidisc' },
      };
      // User has Music + 12-inches but not Unidisc.
      // computeChildExclusions uses Array.find() so it picks the FIRST matching
      // parent in userVpaths order — Music wins over 12-inches.
      const result = computeChildExclusions(['Music', '12-inches'], folders);
      assert.equal(result.length, 1);
      assert.equal(result[0].vpath, 'Music');          // first-match semantics
      assert.equal(result[0].prefix, '12 inches A-Z/Unidisc/');
    });
  });

  describe('vpaths with no parent relationship', () => {
    it('ignores vpaths whose root is not under any user vpath', () => {
      const folders = {
        'Music':   { root: '/music' },
        'Podcasts': { root: '/podcasts' },  // different root — not a child of Music
      };
      // User has Music — Podcasts is separate, should not produce an exclusion
      const result = computeChildExclusions(['Music'], folders);
      assert.deepEqual(result, []);
    });
  });

  describe('real server scenario', () => {
    it('Dennis WITH 12-inches: no exclusion for that child', () => {
      const result = computeChildExclusions(
        ['Music', '12-inches', 'Albums', 'Recordings'],
        REAL_FOLDERS
      );
      const vpaths = result.map(e => e.vpath);
      assert.ok(!vpaths.includes('12-inches'));
    });

    it('Dennis WITHOUT 12-inches: Music gets 12-inches prefix excluded', () => {
      const result = computeChildExclusions(
        ['Music', 'Albums', 'Recordings'],
        REAL_FOLDERS
      );
      const match = result.find(e => e.prefix === '12 inches A-Z/');
      assert.ok(match, 'should exclude 12 inches A-Z/');
      assert.equal(match.vpath, 'Music');
    });
  });

});
