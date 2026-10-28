/**
 * Genre families for Auto-DJ (src/util/genre-family.js): the keyword fallback
 * must match the player's own _djGenreCat(), admin rules win over keywords,
 * tag rules win over folder rules, and folder statistics find the folders
 * whose tags agree.
 *
 * Run with:
 *   node --test test/genre-family.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createFamilyResolver, folderStats, keywordFamily, partsFamily, FAMILIES, RULE_FAMILIES } from '../src/util/genre-family.js';
import { mergeGenreRows, toKey } from '../src/util/genre-merge.js';

describe('keyword fallback', () => {
  it('is the same function as _djGenreCat() in webapp/app.js', () => {
    const src = fs.readFileSync(new URL('../webapp/app.js', import.meta.url), 'utf8');
    const fnSrc = src.match(/function _djGenreCat[\s\S]*?\n}\n/)[0];
    // app.js is a classic script, not a module: evaluate this one helper from our own source
    // eslint-disable-next-line sonarjs/code-eval
    const djGenreCat = vm.runInNewContext(`${fnSrc}_djGenreCat;`);
    const tags = ['house', 'Italo-Disco', 'top 40', 'blues', 'house, trance, chillout', 'Hardstyle', 'Pop Rock', 'new wave', 'r&b', 'Electro; Dance', 'hi-nrg'];
    // eslint-disable-next-line sonarjs/code-eval
    const fromPlayer = tags.map(tag => djGenreCat(tag));
    tags.forEach((tag, i) => assert.equal(keywordFamily(tag), fromPlayer[i], tag));
  });

  it('knows nothing about an untagged song', () => {
    assert.equal(keywordFamily(null), null);
    assert.equal(keywordFamily(''), null);
  });

  it('lets every part of a multi-value tag vote, first part breaking ties', () => {
    assert.equal(keywordFamily('house, trance, chillout'), 'ambient');
    assert.equal(partsFamily('house, trance, chillout'), 'electronic');
    assert.equal(partsFamily('disco; funk; house'), 'disco');
    assert.equal(partsFamily('pop/house'), 'soft');
  });
});

describe('family resolver', () => {
  const rawMap = mergeGenreRows([{ genre: 'blues', cnt: 900 }, { genre: 'Chicago Blues', cnt: 3 }, { genre: 'top 40', cnt: 100 }]).rawMap;
  const r = createFamilyResolver({
    genreRules: new Map([[toKey('Blues'), 'disco'], [toKey('Top 40'), 'ignore']]),
    folderRules: [{ key: 'Music/Disco', family: 'disco' }, { key: 'Music/Disco/Ambient Edits', family: 'ambient' }, { key: 'Music/TOP40', family: 'ignore' }],
    rawMap,
  });

  it('is active once a rule exists, inactive without', () => {
    assert.equal(r.active, true);
    assert.equal(createFamilyResolver().active, false);
  });

  it('an approved tag rule wins over the keyword match', () => {
    assert.deepEqual(r.resolve({ vpath: 'Music', filepath: 'Disconet/x.mp3', genre: 'blues' }), { family: 'disco', source: 'genre' });
  });

  it('a tiny tag folded into a bigger genre follows that genre', () => {
    assert.equal(r.resolve({ vpath: 'Music', filepath: 'x/y.mp3', genre: 'Chicago Blues' }).family, 'disco');
  });

  it('an ignored tag falls through to the folder, then to the keyword match', () => {
    assert.deepEqual(r.resolve({ vpath: 'Music', filepath: 'Disco/a/b.mp3', genre: 'top 40' }), { family: 'disco', source: 'folder' });
    assert.deepEqual(r.resolve({ vpath: 'Music', filepath: 'TOP40/1999/x.mp3', genre: 'top 40' }), { family: 'other', source: 'keyword' });
  });

  it('the most specific folder rule wins', () => {
    assert.equal(r.resolve({ vpath: 'Music', filepath: 'Disco/Ambient Edits/x.mp3', genre: null }).family, 'ambient');
    assert.equal(r.resolve({ vpath: 'Music', filepath: 'Discography/x.mp3', genre: null }), null);
  });

  it('a tag the admin has not ruled on still uses the keyword match', () => {
    assert.deepEqual(r.resolve({ vpath: 'Music', filepath: 'Labels/x.mp3', genre: 'house' }), { family: 'electronic', source: 'keyword' });
  });
});

describe('folder statistics', () => {
  const rows = [];
  for (let i = 0; i < 40; i++) rows.push({ vpath: 'M', filepath: `Disco/Cerrone/${i}.mp3`, genre: i < 34 ? 'disco' : 'house' });
  for (let i = 0; i < 40; i++) rows.push({ vpath: 'M', filepath: `In the Mix/2005/${i}.mp3`, genre: i < 5 ? 'disco' : null });
  for (let i = 0; i < 40; i++) rows.push({ vpath: 'M', filepath: `12 inches/${'ABCD'[i % 4]}/${i}.mp3`, genre: ['house', 'disco', 'pop', 'trance'][i % 4] });
  const stats = folderStats(rows, { minFiles: 10, maxDepth: 2 });
  const byKey = Object.fromEntries(stats.map(s => [s.key, s]));

  it('counts files and tags per folder and sub-folder', () => {
    assert.equal(byKey['M/Disco'].n, 40);
    assert.equal(byKey['M/Disco/Cerrone'].depth, 2);
    assert.equal(byKey['M/In the Mix'].tagged, 5);
    assert.equal(byKey['M/12 inches/A'].n, 10);
  });

  it('calls a folder clear when enough tags agree', () => {
    assert.equal(byKey['M/Disco'].clear, true);
    assert.equal(byKey['M/Disco'].top, 'disco');
    assert.equal(byKey['M/In the Mix'].clear, false, 'too few tags to be sure');
    assert.equal(byKey['M/12 inches'].clear, false, 'mixed families');
  });

  it('skips folders below the file minimum', () => {
    assert.equal(folderStats(rows, { minFiles: 41 }).length, 0);
  });

  it('reports tempo, leading artists and a few file names per folder', () => {
    const rich = [];
    for (let i = 0; i < 40; i++) rich.push({ vpath: 'M', filepath: `Labels/Strictly Rhythm/${i} Track.mp3`, genre: null, bpm: 120 + (i % 9), artist: i % 3 ? 'Todd Terry' : 'Hardrive', title: `Deep Inside ${i}` });
    const [f] = folderStats(rich, { minFiles: 10, maxDepth: 2 }).filter(s => s.depth === 2);
    assert.equal(f.bpmMedian, 124);
    assert.equal(f.bpmN, 40);
    assert.deepEqual(f.topArtists, ['Todd Terry', 'Hardrive']);
    assert.equal(f.samples.length, 4);
    assert.match(f.samples[0], /^Deep Inside/);
    const [plain] = folderStats(rows, { minFiles: 10 });
    assert.equal(plain.bpmMedian, null);
    assert.deepEqual(plain.topArtists, []);
  });
});

describe('family lists', () => {
  it('rules may also say ignore', () => {
    assert.deepEqual(RULE_FAMILIES, [...FAMILIES, 'ignore']);
  });
});
