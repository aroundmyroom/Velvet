/**
 * Library notes (src/util/ai-library-notes.js): the digest the model reads
 * per folder, and the notes as the AI DJ reads them back.
 *
 * Run with:
 *   node --test test/ai-library-notes.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { digestLine, folderDigest, noteAliases, notesText } from '../src/util/ai-library-notes.js';

function rows() {
  const out = [];
  for (let y = 1983; y <= 1992; y++) {
    for (let v = 0; v < 3; v++) out.push({ vpath: 'Music', filepath: `Grandmix/${['538 versies', 'mastertapes', 'blgm'][v]}/Ben Liebrand - Grandmix ${y}.wav`, artist: 'Ben Liebrand', album: null, genre: null, year: y, duration: 3500 });
  }
  for (let i = 1; i <= 60; i++) out.push({ vpath: 'Music', filepath: `Disco/Cerrone Discography/1977 - Supernature/${i} track.flac`, artist: 'Cerrone', album: 'Supernature', genre: 'disco', year: 1977, duration: 300 });
  for (let i = 1; i <= 8; i++) out.push({ vpath: 'Music', filepath: `Small/${i}.mp3`, artist: 'X', album: null, genre: 'pop', year: null, duration: 200 });
  return out;
}

describe('folder digest', () => {
  it('describes each folder from its files, skipping the small ones', () => {
    const d = folderDigest(rows());
    const keys = d.map(x => x.key);
    assert.ok(keys.includes('Music/Grandmix'));
    assert.ok(keys.includes('Music/Disco/Cerrone Discography/1977 - Supernature'), keys.join(', '));
    assert.ok(!keys.includes('Music/Small'), 'eight files do not earn a note');
    assert.ok(!keys.includes('Music/Grandmix/538 versies'), 'ten files at depth two do not earn a note');
    const gm = d.find(x => x.key === 'Music/Grandmix');
    assert.deepEqual([gm.n, gm.children, gm.yearFrom, gm.yearTo, gm.minutesMedian], [30, 3, 1983, 1992, 58]);
    assert.equal(gm.topArtists[0][0], 'Ben Liebrand');
    const line = digestLine(gm);
    assert.ok(line.startsWith('Music/Grandmix | 30 files, 3 sub-folders | years 1983–1992'), line);
    assert.ok(line.includes('median 58 min'));
    assert.ok(line.includes('Grandmix 19'), 'file names travel along: ' + line);
  });
});

describe('notes as the DJ reads them', () => {
  const notes = [
    { key: 'Music/Grandmix', folder: 'Grandmix', name: 'Grandmix', depth: 1, n: 149, kind: 'series', note: "Ben Liebrand's yearly megamix on Dutch radio.", aliases: ['GM', 'Grandmix'] },
    { key: 'Music/Disco', folder: 'Disco', name: 'Disco', depth: 1, n: 5000, kind: 'genre', note: 'Disco, funk and boogie.', aliases: [] },
    { key: 'Music/Disco/Cerrone Discography', folder: 'Disco/Cerrone Discography', name: 'Cerrone Discography', depth: 2, n: 570, kind: 'artist', note: 'Every Cerrone album 1976–2022.', aliases: [] },
  ];
  it('lists the broad folders first within a budget and says what was left out', () => {
    const all = notesText(notes);
    assert.ok(all.text.startsWith('Library notes'));
    assert.equal(all.included.size, 3);
    assert.ok(all.text.indexOf('Music/Disco [genre]') < all.text.indexOf('Music/Grandmix [series]'), 'bigger first at the same depth');
    assert.ok(all.text.includes('(also: GM, Grandmix)'));
    const tight = notesText(notes, { maxChars: 60 });
    assert.equal(tight.included.size, 1);
    assert.ok(!tight.included.has('Music/Disco/Cerrone Discography'));
  });
  it('turns the aliases into reader shorthand, never the folder\'s own name', () => {
    const a = noteAliases(notes);
    assert.equal(a.get('gm'), 'Grandmix');
    assert.equal(a.has('grandmix'), false);
  });
});
