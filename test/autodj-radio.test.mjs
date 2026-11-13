/**
 * Server-side Auto-DJ radio chain (src/autodj/radio.js) and the shared
 * candidate pool (src/autodj/pool.js), on in-memory libraries.
 *
 * Run with:
 *   node --test test/autodj-radio.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildRadio, songFromRow } from '../src/autodj/radio.js';
import { batchCandidatePool, PER_ARTIST_SAMPLE_CAP, RANDOM_SONGS_BATCH_CAP } from '../src/autodj/pool.js';

let nextId = 1;
function row(o) {
  const id = nextId++;
  return { id, hash: `h${id}`, vpath: 'Music', filepath: `${o.artist}/${o.title}.mp3`, genre: null, year: null, bpm: null, musical_key: null, ...o };
}

// Row source with the same contract as the DB one: artists = IN filter, ignoreArtists = cooldown.
function source(rows) {
  const norm = a => String(a || '').toLowerCase().replaceAll('.', '');
  return opts => rows.filter(r =>
    (!opts.artists || opts.artists.includes(r.artist)) &&
    (!opts.ignoreArtists || !opts.ignoreArtists.map(norm).includes(norm(r.artist))));
}

const noSimilar = async () => null;
const rng0 = () => 0.99;

describe('Radio chain', () => {
  it('picks each track against the previous one, not the seed', async () => {
    const seed = row({ artist: 'A', title: 'seed', bpm: 100 });
    const lib = [
      row({ artist: 'B', title: 'b', bpm: 130 }),
      row({ artist: 'C', title: 'close to b', bpm: 131 }),
      row({ artist: 'D', title: 'close to seed', bpm: 101 }),
    ];
    const similar = { A: ['B'], B: ['C', 'D'] };
    const similarFor = async artist => similar[artist]
      ? { artists: similar[artist], variantRankMap: Object.fromEntries(similar[artist].map(a => [a, 1])) }
      : null;
    const { songs } = await buildRadio({
      seed: songFromRow(seed), count: 2, fetchRows: source(lib), similarFor, toSong: r => songFromRow(r),
    });
    assert.deepEqual(songs.map(s => s.title), ['b', 'close to b']);
  });

  it('never returns the seed or the same song twice, and stops at count', async () => {
    const seed = row({ artist: 'X', title: 'Same Song', bpm: 120 });
    const lib = [
      row({ artist: 'X', title: 'Same Song (Extended Mix)', bpm: 120 }),
      { ...seed },
      row({ artist: 'Yazoo', title: 'Other', bpm: 121 }),
      row({ artist: 'Yazoo', title: 'Other', bpm: 121, hash: 'dup' }),
      row({ artist: 'The Yazoo', title: 'Other [Instrumental]', bpm: 121 }),
      row({ artist: 'Yazoo & Friends', title: 'Other (Club Mix)', bpm: 121 }),
      ...Array.from({ length: 30 }, (_, i) => row({ artist: `Z${i}`, title: `t${i}`, bpm: 100 + i })),
    ];
    const { songs } = await buildRadio({
      seed: songFromRow(seed), count: 10, fetchRows: source(lib), similarFor: noSimilar, toSong: r => songFromRow(r),
    });
    assert.equal(songs.length, 10);
    assert.ok(!songs.some(s => s.id === seed.id || s.title.startsWith('Same Song')));
    assert.equal(new Set(songs.map(s => s.id)).size, 10);
    assert.equal(songs.filter(s => s.title.startsWith('Other')).length, 1);
  });

  it('follows the similar artists of the current track and keeps the last list on a miss', async () => {
    const seed = row({ artist: 'Donna Summer', title: 'I Feel Love', bpm: 125 });
    const lib = [
      row({ artist: 'Obscure Act', title: 'o1', bpm: 125 }),
      row({ artist: 'Chic', title: 'c1', bpm: 124 }),
      row({ artist: 'Sister Sledge', title: 's1', bpm: 124 }),
      row({ artist: 'Unrelated', title: 'u1', bpm: 125 }),
      row({ artist: 'Unrelated 2', title: 'u2', bpm: 125 }),
    ];
    const asked = [];
    const similarFor = async artist => {
      asked.push(artist);
      if (artist === 'Donna Summer') return { artists: ['Obscure Act', 'Chic', 'Sister Sledge'], variantRankMap: { 'Obscure Act': 1, Chic: 2, 'Sister Sledge': 3 } };
      return null;
    };
    const { songs, trace } = await buildRadio({
      seed: songFromRow(seed), count: 3, fetchRows: source(lib), similarFor, toSong: r => songFromRow(r), rng: rng0,
    });
    assert.deepEqual(songs.map(s => s.artist), ['Obscure Act', 'Chic', 'Sister Sledge']);
    assert.deepEqual(asked, ['Donna Summer', 'Obscure Act', 'Chic']);
    assert.ok(trace.every(t => t.similarSource === 'Donna Summer'));
  });

  it('widens to the whole library once the similar artists are used up', async () => {
    const seed = row({ artist: 'A', title: 'seed', bpm: 120 });
    const lib = [row({ artist: 'B', title: 'b', bpm: 120 }), row({ artist: 'C', title: 'c', bpm: 120 }), row({ artist: 'D', title: 'd', bpm: 120 })];
    const similarFor = async () => ({ artists: ['B'], variantRankMap: { B: 1 } });
    const { songs } = await buildRadio({ seed: songFromRow(seed), count: 3, fetchRows: source(lib), similarFor, toSong: r => songFromRow(r) });
    assert.equal(songs[0].artist, 'B');
    assert.equal(songs.length, 3);
  });

  it('prefers tagged songs and honours the keyword filter', async () => {
    const seed = row({ artist: 'A', title: 'seed', bpm: 120 });
    const lib = [
      row({ artist: null, title: 'Track 01', bpm: 120 }),
      row({ artist: 'B', title: 'Acapella', bpm: 120 }),
      row({ artist: 'C', title: 'Real Song', bpm: 140 }),
    ];
    const { songs } = await buildRadio({
      seed: songFromRow(seed), count: 1, fetchRows: source(lib), similarFor: noSimilar,
      settings: { filterWords: ['acapella'] }, toSong: r => songFromRow(r),
    });
    assert.deepEqual(songs.map(s => s.title), ['Real Song']);
  });

  it('escapes a genre that keeps repeating', async () => {
    const seed = row({ artist: 'S', title: 'seed', bpm: 120, genre: 'House' });
    const lib = [
      ...Array.from({ length: 8 }, (_, i) => row({ artist: `H${i}`, title: `h${i}`, bpm: 120, genre: 'House' })),
      row({ artist: 'D', title: 'disco', bpm: 112, genre: 'Disco' }),
    ];
    const { songs, trace } = await buildRadio({ seed: songFromRow(seed), count: 5, fetchRows: source(lib), similarFor: noSimilar, toSong: r => songFromRow(r) });
    assert.ok(songs.some(s => s.genre === 'Disco'), 'after 3 House picks in a row the escape takes the Disco track');
    assert.ok(trace.some(t => t.escape === 'house'));
  });
});

describe('Auto-DJ candidate pool', () => {
  it('samples at most PER_ARTIST_SAMPLE_CAP songs per similar artist', () => {
    const rows = [
      ...Array.from({ length: 80 }, (_, i) => row({ artist: 'Big', title: `b${i}` })),
      ...Array.from({ length: 3 }, (_, i) => row({ artist: 'Small', title: `s${i}` })),
    ];
    const pool = batchCandidatePool(source(rows), { artists: ['Big', 'Small'] });
    assert.equal(pool.songs.filter(r => r.artist === 'Big').length, PER_ARTIST_SAMPLE_CAP);
    assert.equal(pool.songs.filter(r => r.artist === 'Small').length, 3);
  });

  it('drops the cooldown, then the similar filter, before giving up', () => {
    const rows = [row({ artist: 'A', title: 'a' }), row({ artist: 'B', title: 'b' })];
    let pool = batchCandidatePool(source(rows), { artists: ['A'], ignoreArtists: ['A'] });
    assert.deepEqual(pool.songs.map(r => r.artist), ['A']);
    assert.match(pool.note, /cooldown list \(1\) dropped/);
    pool = batchCandidatePool(source(rows), { artists: ['Nobody'], ignoreArtists: ['A'] });
    assert.deepEqual(pool.songs.map(r => r.artist), ['B']);
    assert.match(pool.note, /similar filter dropped/);
    assert.equal(batchCandidatePool(() => [], {}), null);
  });

  it('caps the pool', () => {
    const rows = Array.from({ length: 900 }, (_, i) => row({ artist: `A${i}`, title: `t${i}` }));
    assert.equal(batchCandidatePool(source(rows), {}).songs.length, RANDOM_SONGS_BATCH_CAP);
  });
});
