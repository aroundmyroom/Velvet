/**
 * Version words (src/util/version-words.js): a kind of version the listener
 * leaves out is every spelling the library uses — "geen acapella's" also
 * catches "a cappella", "Accapella Version" and "Percapella" — while an
 * unknown word is matched as written, and the band Cappella stays in.
 *
 * Run with:
 *   node --test test/version-words.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_VERSION_WORDS, VERSION_WORDS_SCHEMA, expandVersionWords, familyOf, versionFamilies } from '../src/util/version-words.js';

const hits = (patterns, text) => patterns.some(p => text.toLowerCase().includes(p));

describe('version words', () => {
  it('knows a family by its name, a way of saying it, or a spelling inside the word', () => {
    for (const w of ['acapella', "acapella's", 'Acapellas', 'a cappella', 'accapella', 'percapella', 'A CAPPELLA', 'acapella’s']) assert.equal(familyOf(w)?.name, 'acapella', w);
    assert.equal(familyOf('instrumentals')?.name, 'instrumental');
    assert.equal(familyOf('live versions')?.name, 'live');
    assert.equal(familyOf('remixes')?.name, 'remix');
    assert.equal(familyOf('italo'), null);
    assert.equal(familyOf(''), null);
  });

  it('expands an acapella exclusion to every spelling, and leaves Cappella and other words alone', () => {
    const p = expandVersionWords(["acapella's", 'italo']);
    for (const t of ['New Dimension (Accapella Version)', 'Chica Cubana (a cappella)', 'Cold Hearted (Percapella)', 'Monkey (Acappella)', 'Turn On The Music (S-Man’s Acappela)', 'Dance Out Of My Head (Dubcapella)', 'Show Me Love (Acapella)']) {
      assert.ok(hits(p, t.replaceAll('’', "'")), t);
    }
    assert.ok(!hits(p, 'Music/90s/Cappella - U Got 2 Know.flac'), 'the band Cappella');
    assert.ok(p.includes('italo'), 'an unknown word is matched as written');
  });

  it('live, remix and dub catch versions, not words that merely contain them', () => {
    const live = expandVersionWords(['live']);
    assert.ok(hits(live, 'Brick House (Live)') && hits(live, 'Can You Feel It (Live Version)'));
    assert.ok(!hits(live, 'Stayin Alive') && !hits(live, 'Live It Up (12 Inch Version)'));
    const remix = expandVersionWords(['remixes']);
    assert.ok(hits(remix, 'Free (Ramon Tapia Rmx)') && hits(remix, 'Relax (Remix)'));
    assert.ok(!hits(remix, 'z_YRMX2024/Yearmix 2024.mp3') && !hits(remix, 'Italo RMXD Contest.mp3'));
    const dub = expandVersionWords(['dub']);
    assert.ok(hits(dub, 'Angel Eyes (Dub Mix)') && hits(dub, 'Something (Club Dub)'));
    assert.ok(!hits(dub, 'Dublin Calling'));
  });

  it('uses the admin\'s own list when there is one, the defaults otherwise', () => {
    assert.equal(versionFamilies(null), DEFAULT_VERSION_WORDS);
    assert.equal(versionFamilies([]), DEFAULT_VERSION_WORDS);
    const own = [{ name: 'acapella', says: ['acapella'], match: ['acapel', 'annecapella'] }];
    assert.equal(versionFamilies(own), own);
    assert.deepEqual(expandVersionWords(['acapella'], own), ['acapel', 'annecapella']);
    // a family the admin removed is a plain word again
    assert.deepEqual(expandVersionWords(['live'], own), ['live']);
  });

  it('validates an edited list', () => {
    assert.equal(VERSION_WORDS_SCHEMA.validate(DEFAULT_VERSION_WORDS).error, undefined, 'the defaults are a valid list');
    const { value } = VERSION_WORDS_SCHEMA.validate([{ name: ' Acapella ', match: [' ACAPEL '] }]);
    assert.deepEqual(value, [{ name: 'acapella', says: [], match: ['acapel'] }]);
    assert.ok(VERSION_WORDS_SCHEMA.validate([{ name: 'x', match: [] }]).error);
    assert.ok(VERSION_WORDS_SCHEMA.validate([{ name: 'acapella', match: ['a'] }]).error);
  });
});
