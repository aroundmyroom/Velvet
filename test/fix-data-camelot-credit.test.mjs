import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CAMELOT, CAMELOT_TO_KEYS, camelotCompat, toCamelot } from '../src/util/camelot.js';
import * as scoring from '../src/autodj/scoring.js';
import * as aiq from '../src/util/ai-queue.js';
import { primaryArtist } from '../src/util/artist-credit.js';

describe('shared Camelot table', () => {
  it('Auto-DJ and AI DJ resolve every key the same way', () => {
    for (const k of Object.keys(CAMELOT)) {
      assert.equal(scoring.toCamelot(k), CAMELOT[k]);
      assert.equal(aiq.toCamelot(k), CAMELOT[k]);
    }
  });

  it('reverse table lists every spelling', () => {
    assert.deepEqual(CAMELOT_TO_KEYS['3B'].sort(), ['C# major', 'Db major']);
    assert.deepEqual(CAMELOT_TO_KEYS['8A'], ['A minor']);
    assert.equal(Object.keys(CAMELOT_TO_KEYS).length, 24);
  });

  it('similar-songs compatibility wraps 12 to 1 and knows enharmonics', () => {
    assert.ok(camelotCompat('C# minor', 'G# minor'));
    assert.ok(camelotCompat('E major', 'B major'));
    assert.ok(camelotCompat('Eb minor', 'Ab minor'));
    assert.ok(camelotCompat('Db major', 'C# major'));
    assert.ok(camelotCompat('A minor', 'C major'));
    assert.ok(!camelotCompat('A minor', 'G major'), 'no diagonal moves');
    assert.ok(!camelotCompat('C# minor', 'D minor'));
    assert.ok(camelotCompat('weird', 'weird'));
    assert.ok(!camelotCompat('weird', 'A minor'));
    assert.equal(toCamelot(null), null);
  });
});

describe('AI DJ artist identity', () => {
  it('folds accents but keeps non-Latin names apart', () => {
    assert.equal(aiq.artistKey('Beyoncé'), aiq.artistKey('Beyonce'));
    assert.equal(aiq.artistKey('Tiësto'), 'tiesto');
    assert.notEqual(aiq.artistKey('Кино'), '');
    assert.notEqual(aiq.artistKey('Кино'), aiq.artistKey('Ария'));
  });

  it('splits "Fe." credits and leaked track numbers', () => {
    assert.deepEqual(aiq.creditParts('A Fe. B'), ['a', 'b']);
    assert.deepEqual(aiq.creditParts('04. Clean Bandit Fe. Mabel'), ['clean bandit', 'mabel']);
    assert.deepEqual(aiq.creditParts('Earth, Wind & Fire'), ['earth', 'wind', 'fire']);
    assert.deepEqual(aiq.creditParts('X feat. Y; Z'), ['x', 'y', 'z']);
  });

  it('primaryArtist returns the main credit', () => {
    assert.equal(primaryArtist('04. Clean Bandit Fe. Mabel'), 'Clean Bandit');
    assert.equal(primaryArtist('Martin Solveig feat. Dragonette'), 'Martin Solveig');
    assert.equal(primaryArtist('Daft Punk vs. Queen'), 'Daft Punk');
    assert.equal(primaryArtist('Earth, Wind & Fire'), 'Earth, Wind & Fire');
    assert.equal(primaryArtist(null), '');
  });
});

describe('getSimilarSongs key matching', () => {
  let dir, backend;
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'velvet-similar-'));
    backend = await import('../src/db/sqlite-backend.js');
    backend.init(dir);
    const add = (hash, key) => backend.insertFile({ vpath: 'v', filepath: `A/${hash}.mp3`, format: 'mp3', hash, bpm: 120, musical_key: key, title: hash });
    add('e12b', 'E major');
    add('b1b', 'B major');
    add('db3b', 'Db major');
    add('cs3b', 'C# major');
    add('f7b', 'F major');
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const scoreOf = (list, hash) => list.find(r => r.hash === hash)?._score;

  it('12B and 1B are neighbours', () => {
    const list = backend.getSimilarSongs('e12b');
    assert.equal(scoreOf(list, 'b1b'), 2, 'bpm 1 + key 1');
    assert.equal(scoreOf(list, 'f7b'), 1, 'bpm only');
  });

  it('an enharmonic spelling counts as the same key', () => {
    const list = backend.getSimilarSongs('db3b');
    assert.equal(scoreOf(list, 'cs3b'), 3, 'bpm 1 + same key 2');
  });
});
