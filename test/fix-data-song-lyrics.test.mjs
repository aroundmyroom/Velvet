import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { parseLrc, lyricsCacheKey, lyricsCacheDir } from '../src/util/song-lyrics.js';

describe('shared LRC parser and lyrics cache key', () => {
  it('a line with several timestamps yields one entry per stamp', () => {
    const p = parseLrc('[00:10.00][00:30.50]Chorus\n[00:20.00]Verse');
    assert.deepEqual(p.line, [
      { start: 10000, value: 'Chorus' },
      { start: 20000, value: 'Verse' },
      { start: 30500, value: 'Chorus' },
    ]);
  });

  it('[offset:] shifts the start times', () => {
    const p = parseLrc('[offset:+500]\n[00:10.00]Hi');
    assert.equal(p.line[0].start, 9500);
  });

  it('cache key matches the formula already used for files on disk', () => {
    const old = crypto.createHash('sha256').update('Chic||Le Freak||327').digest('hex');
    assert.equal(lyricsCacheKey('Chic', 'Le Freak', 327.4), old);
    assert.equal(lyricsCacheKey(' Chic ', 'Le Freak ', '327'), old);
    assert.equal(lyricsCacheKey('', 'T', 0), crypto.createHash('sha256').update('||T||0').digest('hex'));
  });

  it('cache dir sits next to the db directory', () => {
    assert.equal(lyricsCacheDir('/srv/save/db'), path.join('/srv/save/db', '..', 'lyrics'));
  });
});
