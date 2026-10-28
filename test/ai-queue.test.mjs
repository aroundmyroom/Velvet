/**
 * AI DJ planner (src/util/ai-queue.js): the part that never sees the model.
 * A brief is validated and clamped, the count never exceeds the cap or the
 * pool, named artists are heard, one artist never dominates, and the energy
 * arc shapes the order.
 *
 * Run with:
 *   node --test test/ai-queue.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { artistKey, baseTitle, planQueue, targetCount, toCamelot, validateBrief, versionKey, DEFAULT_SONGS, MAX_SONGS } from '../src/util/ai-queue.js';
import { keywordFamily } from '../src/util/genre-family.js';

function row(i, over = {}) {
  return {
    id: i, vpath: 'Music', filepath: `x/${i}.mp3`, title: `Song ${i}`, artist: `Artist ${i % 20}`, album: `Album ${i % 7}`,
    // tempos cluster the way one scene's records do (118–133 BPM), so a DJ corridor is feasible
    year: 1980 + (i % 30), genre: ['house', 'disco', 'pop', 'trance'][i % 4], bpm: 118 + (i % 16), musical_key: ['C major', 'A minor', 'G major'][i % 3],
    duration: 240, rating: null, pc: 0, hash: `h${i}`, ...over,
  };
}
const pool = (n, over) => Array.from({ length: n }, (_, i) => row(i, typeof over === 'function' ? over(i) : over));
const ctx = (over = {}) => ({
  seedArtists: new Set(), similarRank: new Map(), genreRaw: new Set(), genreFamilies: new Set(),
  familyOf: r => keywordFamily(r.genre), keywords: [], ...over,
});
const brief = (over = {}) => validateBrief({ title: 'Test', ...over });

describe('brief validation', () => {
  it('fills defaults and clamps what the model may exaggerate', () => {
    const b = validateBrief({ songs: 50000, minutes: 99999, yearFrom: 1999, yearTo: 1980, bpmFrom: 130, bpmTo: 120, genres: [' House ', 'house', ''], keywords: ['Love', 'a'] });
    assert.equal(b.songs, MAX_SONGS);
    assert.equal(b.minutes, 24 * 60);
    assert.deepEqual([b.yearFrom, b.yearTo], [1980, 1999]);
    assert.deepEqual([b.bpmFrom, b.bpmTo], [120, 130]);
    assert.deepEqual(b.genres, ['House', 'house']);
    assert.deepEqual(b.keywords, ['love']);
    assert.equal(b.energy, 'steady');
    assert.equal(b.artistMode, 'feature');
    assert.equal(b.clarification, null);
  });

  it('rejects what is not a brief', () => {
    assert.throws(() => validateBrief({ energy: 'explode' }));
    assert.throws(() => validateBrief({ families: ['jazz'] }));
    assert.throws(() => validateBrief({ artists: Array.from({ length: 40 }, (_, i) => `a${i}`) }));
  });
});

describe('keys and the new wishes', () => {
  it('turns key names and Camelot codes into codes, and keeps lengths in order', () => {
    const b = validateBrief({ keys: ['A minor', '8a', 'F# major', 'nonsense', 'Bb minor'], minSeconds: 900, maxSeconds: 600, release: '12inch', titles: ['Relax', 'relax', ''] });
    assert.deepEqual(b.keys, ['8A', '2B', '3A']);
    assert.deepEqual([b.minSeconds, b.maxSeconds], [600, 900]);
    assert.equal(b.release, '12inch');
    assert.deepEqual(b.titles, ['Relax', 'relax']);
    assert.throws(() => validateBrief({ release: 'cassette' }));
  });
});

describe('one song is one song', () => {
  it('sees through version suffixes and featured credits', () => {
    assert.equal(baseTitle('Two Tribes (Keep The Peace Mix)'), 'two tribes');
    assert.equal(baseTitle('Two Tribes - Radio Edit'), 'two tribes');
    assert.equal(baseTitle('Relax [12" Sex Mix]'), 'relax');
    assert.equal(baseTitle('Love In C Minor'), 'love in c minor');
    assert.equal(baseTitle('Rock Me Amadeus - The American Edit'), 'rock me amadeus');
    assert.equal(baseTitle('Angie - Rolling Stones Cover'), 'angie rolling stones cover', 'a dash without a version word stays');
    assert.equal(versionKey({ artist: 'Cerrone feat. Jocelyn Brown', title: 'Supernature (Club Mix)' }), versionKey({ artist: 'Cerrone', title: 'Supernature' }));
  });

  it('plays one version of a song unless every version was asked for', () => {
    const p = pool(60, i => ({ artist: 'FGTH', title: `Relax (${['Sex Mix', '7 inch', 'Radio Edit', 'Instrumental', 'Live', 'Extended'][i % 6]})`, album: `Comp ${i % 10}`, bpm: 118 + (i % 5) }));
    const one = planQueue({ brief: brief({ songs: 10 }), pool: p, maxSongs: 500, ctx: ctx() });
    assert.equal(one.songs.length, 1, 'only one song exists here, in many versions');
    const all = planQueue({ brief: brief({ songs: 10, allVersions: true }), pool: p, maxSongs: 500, ctx: ctx() });
    assert.equal(all.songs.length, 6, 'six distinct versions exist; the copies on other compilations are not versions');
    const every = planQueue({ brief: brief({ allVersions: true, titles: ['relax'] }), pool: p, maxSongs: 500, ctx: ctx({ titles: ['relax'] }) });
    assert.equal(every.songs.length, 6, '"all versions of Relax" plays each version once');
  });

  it('lays the set out as asked: chronological, newest first, alphabetical', () => {
    const p = pool(40, i => ({ artist: `Artist ${i}`, year: 1970 + ((i * 7) % 40), title: `Song ${String.fromCharCode(65 + (i % 26))}` }));
    const chrono = planQueue({ brief: brief({ songs: 20, order: 'chronological' }), pool: p, maxSongs: 500, ctx: ctx() }).songs.map(s => s.year);
    assert.deepEqual(chrono, [...chrono].sort((a, b) => a - b));
    const newest = planQueue({ brief: brief({ songs: 20, order: 'newestFirst' }), pool: p, maxSongs: 500, ctx: ctx() }).songs.map(s => s.year);
    assert.deepEqual(newest, [...newest].sort((a, b) => b - a));
    const alpha = planQueue({ brief: brief({ songs: 20, order: 'alphabetical' }), pool: p, maxSongs: 500, ctx: ctx() }).songs.map(s => `${s.artist} ${s.title}`.toLowerCase());
    assert.deepEqual(alpha, [...alpha].sort((a, b) => a.localeCompare(b)));
  });
});

describe('duplicates and preferences', () => {
  it('plays the same recording once even when three compilations hold it', () => {
    const p = pool(60, i => ({ artist: 'FGTH', title: i < 30 ? 'Relax (Sex Mix)' : `Song ${i}`, album: `Comp ${i % 10}` }));
    const plan = planQueue({ brief: brief({ songs: 20 }), pool: p, maxSongs: 500, ctx: ctx() });
    assert.equal(plan.songs.filter(s => s.title === 'Relax (Sex Mix)').length, 1);
    assert.equal(plan.songs.length, 20);
  });

  it('"the longest version" picks the longest, "the newest" the newest', () => {
    const p = pool(30, i => ({ artist: 'FGTH', title: `Two Tribes (mix ${i})`, duration: 180 + i * 20, year: 1984 + i }));
    const longest = planQueue({ brief: brief({ songs: 1, prefer: 'longest' }), pool: p, maxSongs: 500, ctx: ctx() });
    assert.equal(longest.songs[0].duration, 180 + 29 * 20);
    const newest = planQueue({ brief: brief({ songs: 1, prefer: 'newest' }), pool: p, maxSongs: 500, ctx: ctx() });
    assert.equal(newest.songs[0].year, 1984 + 29);
    const oldest = planQueue({ brief: brief({ songs: 1, prefer: 'oldest' }), pool: p, maxSongs: 500, ctx: ctx() });
    assert.equal(oldest.songs[0].year, 1984);
  });
});

describe('target count', () => {
  it('uses the requested songs, else minutes, else the default, and never exceeds cap or pool', () => {
    assert.equal(targetCount(brief({ songs: 40 }), { avgDuration: 240, maxSongs: 500, poolSize: 1000 }).n, 40);
    assert.equal(targetCount(brief({ minutes: 60 }), { avgDuration: 240, maxSongs: 500, poolSize: 1000 }).n, 15);
    assert.equal(targetCount(brief(), { avgDuration: 240, maxSongs: 500, poolSize: 1000 }).n, DEFAULT_SONGS);
    const capped = targetCount(brief({ songs: 900 }), { avgDuration: 240, maxSongs: 500, poolSize: 1000 });
    assert.equal(capped.n, 500);
    assert.equal(capped.notes[0].code, 'cappedByAdmin');
    const small = targetCount(brief({ songs: 900 }), { avgDuration: 240, maxSongs: 9999, poolSize: 12 });
    assert.equal(small.n, 12);
    assert.equal(small.notes[0].code, 'cappedByLibrary');
  });
});

describe('harmonic mixing', () => {
  it('walks the Camelot wheel: neighbours are in the same, an adjacent or the relative key, still in small tempo steps', () => {
    const keys = ['A minor', 'E minor', 'D minor', 'C major', 'G major', 'F major', 'B minor', 'Bb major'];
    const p = pool(500, i => ({ artist: `Artist ${i % 60}`, genre: 'house', musical_key: keys[i % keys.length] }));
    let ok = 0, total = 0, maxStep = 0;
    for (let t = 0; t < 5; t++) {
      const plan = planQueue({ brief: brief({ songs: 40, energy: 'build' }), pool: p, maxSongs: 500, ctx: ctx() });
      assert.equal(plan.songs.length, 40);
      ok += plan.stats.harmonic; total += plan.stats.transitions;
      maxStep = Math.max(maxStep, plan.stats.maxStep);
      for (let i = 1; i < plan.songs.length; i++) assert.notEqual(artistKey(plan.songs[i].artist), artistKey(plan.songs[i - 1].artist));
    }
    assert.ok(total >= 5 * 39 * 0.9, 'keys are known for nearly every transition');
    assert.ok(ok / total >= 0.8, `harmonic transitions ${ok}/${total}`);
    assert.ok(maxStep <= 3, 'tempo steps stay small while keys are matched: ' + maxStep);
  });
});

describe('songs that match each other', () => {
  it('"3 songs that match tempo, key and genre" come from one tempo, compatible keys and one genre', () => {
    const p = [];
    let i = 0;
    for (const [genre, bpm, keys] of [['house', 125, ['A minor', 'E minor', 'C major']], ['disco', 112, ['F major', 'D minor']], ['trance', 138, ['A minor', 'B minor']]]) {
      for (let k = 0; k < 15; k++) p.push(row(i++, { genre, bpm: bpm + (k % 5), musical_key: keys[k % keys.length], artist: `${genre} act ${k}` }));
    }
    for (let t = 0; t < 10; t++) {
      const b = brief({ songs: 3, cohesive: true, order: 'random' });
      const plan = planQueue({ brief: b, pool: p, maxSongs: 500, ctx: ctx() });
      assert.equal(plan.songs.length, 3);
      const bpms = plan.songs.map(s => s.bpm), genres = new Set(plan.songs.map(s => s.genre));
      assert.equal(genres.size, 1, 'one genre: ' + [...genres].join(','));
      assert.ok(Math.max(...bpms) - Math.min(...bpms) <= Math.min(...bpms) * 0.06, 'close tempos: ' + bpms.join(','));
      assert.ok(bpms.slice(1).every((v, i) => Math.abs(v - bpms[i]) <= 4), 'laid out as a mix even when the choice was random: ' + bpms.join(','));
      const keys = plan.songs.map(s => toCamelot(s.musical_key));
      assert.ok(keys.every(k => k === keys[0] || Math.abs(Number.parseInt(k, 10) - Number.parseInt(keys[0], 10)) % 12 <= 1 || Math.abs(Number.parseInt(k, 10) - Number.parseInt(keys[0], 10)) === 11), 'compatible keys: ' + keys.join(','));
      assert.ok(plan.notes.some(n => n.code === 'cohesionSeed'));
    }
    const sparse = planQueue({ brief: brief({ songs: 3, cohesive: true }), pool: pool(6, i => ({ bpm: 100 + i * 20, genre: 'pop' })), maxSongs: 500, ctx: ctx() });
    assert.ok(sparse.notes.some(n => n.code === 'cohesionPartial' || n.code === 'cohesionKeyDropped'), JSON.stringify(sparse.notes));
  });
});

describe('named titles', () => {
  it('"the Grandmix 1983 and 1986" is two songs, one per title, whatever else is in the pool', () => {
    const p = [
      row(1, { title: 'Grandmix 1983', artist: 'Ben Liebrand', year: 1983 }),
      row(2, { title: 'Grandmix 1983 (Mastertape)', artist: 'Ben Liebrand', year: 2009 }),
      row(3, { title: 'Ben Liebrand - Grandmix 1983 (Radio 538 FM Recording)', artist: null, year: null }),
      row(4, { title: 'Grandmix 1986', artist: 'Ben Liebrand', year: 1986 }),
      row(5, { title: 'Grandmix 1985', artist: 'Ben Liebrand', year: 1985 }),
      row(6, { title: 'Grandmix 1984', artist: 'Ben Liebrand', year: 1984 }),
    ];
    const b = brief({ titles: ['Grandmix 1983', 'Grandmix 1986'], yearFrom: 1983, yearTo: 1986 });
    assert.deepEqual([b.yearFrom, b.yearTo], [null, null], 'the years belong to the titles');
    assert.equal(targetCount(b, { avgDuration: 240, maxSongs: 500, poolSize: 6 }).n, 2);
    const plan = planQueue({ brief: b, pool: p, maxSongs: 500, ctx: ctx({ titles: ['grandmix 1983', 'grandmix 1986'] }) });
    assert.deepEqual(plan.songs.map(s => s.title).sort(), ['Grandmix 1983', 'Grandmix 1986']);
  });
});

describe('planning', () => {
  it('returns exactly the asked number of distinct songs, in bounds', () => {
    const plan = planQueue({ brief: brief({ songs: 60 }), pool: pool(400), maxSongs: 500, ctx: ctx() });
    assert.equal(plan.songs.length, 60);
    assert.equal(new Set(plan.songs.map(s => s.id)).size, 60);
    assert.equal(plan.stats.picked, 60);
    assert.equal(plan.stats.minutes, 240);
  });

  it('never exceeds the admin cap, however big the ask', () => {
    const plan = planQueue({ brief: brief({ songs: 9999 }), pool: pool(3000), maxSongs: 100, ctx: ctx() });
    assert.equal(plan.songs.length, 100);
    assert.ok(plan.notes.some(n => n.code === 'cappedByAdmin'));
  });

  it('handles an empty pool without throwing', () => {
    const plan = planQueue({ brief: brief(), pool: [], maxSongs: 500, ctx: ctx() });
    assert.deepEqual(plan.songs, []);
    assert.equal(plan.notes[0].code, 'empty');
  });

  it('spreads the set over artists instead of letting one dominate', () => {
    const big = pool(600, i => ({ artist: i < 300 ? 'Cerrone' : `Act ${i}`, rating: i < 300 ? 10 : null }));
    const plan = planQueue({ brief: brief({ songs: 50 }), pool: big, maxSongs: 500, ctx: ctx() });
    const cerrone = plan.songs.filter(s => s.artist === 'Cerrone').length;
    assert.ok(cerrone <= 8, `Cerrone got ${cerrone} of 50 slots`);
    for (let i = 1; i < plan.songs.length; i++) assert.notEqual(artistKey(plan.songs[i].artist), artistKey(plan.songs[i - 1].artist), 'back-to-back artist');
  });

  it('plays every named artist and prefers their similar artists', () => {
    const similar = new Map(Array.from({ length: 12 }, (_, k) => [`sim ${k}`, k + 1]));
    const c = ctx({ seedArtists: new Set(['donna summer']), similarRank: similar });
    const p = pool(400, i => ({ artist: i === 7 ? 'Donna Summer' : i % 2 ? `Sim ${Math.floor(i / 2) % 12}` : `Other ${i}` }));
    const plan = planQueue({ brief: brief({ songs: 30, artists: ['Donna Summer'] }), pool: p, maxSongs: 500, ctx: c });
    assert.ok(plan.songs.some(s => s.artist === 'Donna Summer'), 'the seed artist is heard');
    const others = plan.songs.filter(s => s.artist.startsWith('Other')).length;
    assert.ok(others < 6, `${others} unrelated picks`);
  });

  it('prefers the asked genre and era', () => {
    const c = ctx({ genreRaw: new Set(['disco']), genreFamilies: new Set(['disco']) });
    const p = pool(800, i => ({ artist: `Artist ${i % 37}`, year: 1970 + (i % 20) }));
    const plan = planQueue({ brief: brief({ songs: 40, genres: ['Disco'], yearFrom: 1976, yearTo: 1984 }), pool: p, maxSongs: 500, ctx: c });
    const disco = plan.songs.filter(s => s.genre === 'disco').length;
    const inEra = plan.songs.filter(s => s.year >= 1976 && s.year <= 1984).length;
    assert.ok(disco >= 34, `${disco}/40 disco`);
    assert.ok(inEra >= 34, `${inEra}/40 in era`);
  });

  it('shapes the tempo: build rises, cooldown falls, peak rises then falls', () => {
    const bpms = plan => plan.songs.map(s => s.bpm);
    const rising = a => a.every((v, i) => i === 0 || v >= a[i - 1]);
    // Plenty of artists, so the arc is tested on its own; artist spacing has its own test above.
    const p = pool(400, i => ({ artist: `Artist ${i % 97}` }));
    const build = planQueue({ brief: brief({ songs: 40, energy: 'build' }), pool: p, maxSongs: 500, ctx: ctx() });
    const cool = planQueue({ brief: brief({ songs: 40, energy: 'cooldown' }), pool: p, maxSongs: 500, ctx: ctx() });
    const peak = planQueue({ brief: brief({ songs: 40, energy: 'peak' }), pool: p, maxSongs: 500, ctx: ctx() });
    const trend = a => a.slice(-5).reduce((s, v) => s + v, 0) / 5 - a.slice(0, 5).reduce((s, v) => s + v, 0) / 5;
    // the pool spans 118–133; a corridor that starts a little above its floor still climbs most of it
    assert.ok(trend(bpms(build)) > 8, 'build ends faster than it starts: ' + bpms(build).join(','));
    assert.ok(trend(bpms(cool)) < -8, 'cooldown ends slower than it starts: ' + bpms(cool).join(','));
    // a mix climbs in small steps: no neighbour more than about 2.5% (3 BPM) apart
    const steps = a => a.slice(1).map((v, i) => Math.abs(v - a[i]));
    assert.ok(Math.max(...steps(bpms(build))) <= 3, 'build steps: ' + bpms(build).join(','));
    assert.ok(Math.max(...steps(bpms(cool))) <= 3, 'cooldown steps: ' + bpms(cool).join(','));
    assert.equal(build.stats.maxStep, Math.max(...steps(bpms(build))));
    const pb = bpms(peak);
    const top = pb.indexOf(Math.max(...pb));
    assert.ok(top > pb.length * 0.35 && top < pb.length * 0.95, `peak at ${top}/${pb.length}`);
    assert.ok(!rising(pb), 'peak is not a plain ramp');
  });

  it('keeps unknown-tempo songs spread through the set rather than dumped at the end', () => {
    const p = pool(200, i => ({ bpm: i % 2 ? null : 120 + (i % 20) }));
    const plan = planQueue({ brief: brief({ songs: 40, energy: 'build' }), pool: p, maxSongs: 500, ctx: ctx() });
    const idx = plan.songs.map((s, i) => (s.bpm ? -1 : i)).filter(i => i >= 0);
    assert.ok(idx.length > 5 && idx[0] < 10 && idx.at(-1) > 30, `unknown-bpm positions ${idx.join(',')}`);
  });

  it('favourites lean on rating and plays; discovery on the unplayed', () => {
    const p = pool(400, i => ({ rating: i < 100 ? 10 : null, pc: i < 100 ? 30 : 0 }));
    const fav = planQueue({ brief: brief({ songs: 30, favourites: true }), pool: p, maxSongs: 500, ctx: ctx() });
    const disc = planQueue({ brief: brief({ songs: 30, discovery: true }), pool: p, maxSongs: 500, ctx: ctx() });
    assert.ok(fav.songs.filter(s => s.rating === 10).length >= 25);
    assert.ok(disc.songs.filter(s => s.pc === 0).length >= 28);
  });

  it('knows the Camelot wheel', () => {
    assert.equal(toCamelot('A minor'), '8A');
    assert.equal(toCamelot('Gb major'), '2B');
    assert.equal(toCamelot(null), null);
  });
});
