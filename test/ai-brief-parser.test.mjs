/**
 * Rule-based brief reader (src/util/ai-brief-parser.js): the AI DJ's fallback
 * when Claude cannot be asked. Reads length, era, tempo, flow, genres,
 * artists and exclusions from plain text against the library's own names.
 *
 * Run with:
 *   node --test test/ai-brief-parser.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseBriefLocally } from '../src/util/ai-brief-parser.js';
import { validateBrief } from '../src/util/ai-queue.js';

const profile = {
  genres: [{ genre: 'House' }, { genre: 'Italo-Disco' }, { genre: 'Disco' }, { genre: 'Hi-NRG' }, { genre: 'Pop' }, { genre: 'Top 40' }],
  artists: [{ artist: 'Modern Talking' }, { artist: 'Donna Summer' }, { artist: 'Cerrone' }, { artist: 'Chic' }],
  folders: [{ folder: 'Disconet' }, { folder: 'Labels' }],
};

describe('rule-based brief', () => {
  it('reads the example request', () => {
    const b = parseBriefLocally('two hours of 80s italo-disco and hi-nrg that slowly builds up, no Modern Talking', profile);
    assert.equal(b.minutes, 120);
    assert.deepEqual([b.yearFrom, b.yearTo], [1980, 1989]);
    assert.deepEqual(b.genres, ['Italo-Disco', 'Hi-NRG']);
    assert.equal(b.energy, 'build');
    assert.deepEqual(b.excludeArtists, ['Modern Talking']);
    assert.deepEqual(b.artists, []);
    assert.equal(validateBrief(b).title.length > 0, true);
  });

  it('reads Dutch too', () => {
    const b = parseBriefLocally('50 nummers disco uit de late jaren 70 met Donna Summer en Chic, rustig afbouwen', profile);
    assert.equal(b.songs, 50);
    assert.deepEqual([b.yearFrom, b.yearTo], [1976, 1979]);
    assert.deepEqual(b.genres, ['Disco']);
    assert.deepEqual(b.artists, ['Donna Summer', 'Chic']);
    assert.equal(b.energy, 'cooldown');
  });

  it('reads tempo, rating, favourites and an artist-only set', () => {
    const b = parseBriefLocally('only Cerrone, 120-126 bpm, 4 stars, my favourites, an hour', profile);
    assert.deepEqual(b.artists, ['Cerrone']);
    assert.equal(b.artistMode, 'only');
    assert.deepEqual([b.bpmFrom, b.bpmTo], [120, 126]);
    assert.equal(b.minRating, 8);
    assert.equal(b.favourites, true);
    assert.equal(b.minutes, 60);
  });

  it('falls back to families and theme words when no genre name matches', () => {
    const b = parseBriefLocally('something electronic for a summer night, songs I never played', profile);
    assert.deepEqual(b.families, ['electronic']);
    assert.deepEqual(b.keywords, ['summer', 'night']);
    assert.equal(b.discovery, true);
    assert.equal(b.genres.length, 0);
  });

  it('hears the difference between an album and a set', () => {
    const one = parseBriefLocally('play one album of Cerrone from around 1985', profile);
    assert.equal(one.albumMode, 'oneAlbum');
    assert.deepEqual(one.artists, ['Cerrone']);
    assert.deepEqual([one.yearFrom, one.yearTo], [1985, 1985]);
    assert.equal(parseBriefLocally('een plaat van Cerrone', profile).albumMode, 'oneAlbum');
    assert.equal(parseBriefLocally('complete albums of Chic in order', profile).albumMode, 'wholeAlbums');
    assert.equal(parseBriefLocally('two hours of disco', profile).albumMode, 'songs');
  });

  it('knows the DJ shorthand: aliases, one song, song length, versions, keys, quoted titles', () => {
    const prof = { ...profile, artists: [...profile.artists, { artist: 'Frankie Goes To Hollywood' }] };
    const b = parseBriefLocally('play a 12-inch of FGTH from +10 minutes', prof);
    assert.deepEqual(b.artists, ['Frankie Goes To Hollywood']);
    assert.equal(b.songs, 1);
    assert.equal(b.minSeconds, 600);
    assert.equal(b.release, '12inch');
    const c = parseBriefLocally('instrumentals of Cerrone in A minor, shorter than 5 minutes, "Supernature"', prof);
    assert.equal(c.release, 'instrumental');
    assert.deepEqual(c.keys, ['A minor']);
    assert.equal(c.maxSeconds, 300);
    assert.deepEqual(c.titles, ['supernature']);
    assert.equal(validateBrief(c).keys[0], '8A');
    const d = parseBriefLocally('a plaatje van DS', prof, { aliases: new Map([['ds', 'Donna Summer']]) });
    assert.deepEqual(d.artists, ['Donna Summer'], 'house-note alias beats the built-in one');
    assert.equal(d.songs, 1);
    const m = parseBriefLocally('Play the most played disco song', prof);
    assert.equal(m.ranking, 'mostPlayed');
    assert.equal(m.songs, 1);
    assert.deepEqual(m.genres, ['Disco']);
    assert.equal(parseBriefLocally('my top 20 house tracks', prof).songs, 20);
    assert.equal(parseBriefLocally('de laatst toegevoegde nummers', prof).ranking, 'recentlyAdded');
    const e = parseBriefLocally('play Two Tribes by Frankie Goes To Hollywood, the longest version you have', prof);
    assert.equal(e.prefer, 'longest');
    assert.equal(e.songs, 1);
    assert.equal(e.minutes, null);
  });

  it('reads the rest of what the library views can filter on', () => {
    const prof = { ...profile, collections: ['Music', '12 inches'] };
    const a = parseBriefLocally('starred disco I never played, lossless, no remixes, chronological', prof);
    assert.equal(a.starred, true);
    assert.equal(a.played, 'never');
    assert.equal(a.lossless, true);
    assert.deepEqual(a.excludeKeywords, ['remix']);
    assert.equal(a.order, 'chronological');
    const b = parseBriefLocally('songs added in the last 2 weeks that I played more than 3 times, from playlist Best Remixes, only from the 12 inches', prof);
    assert.equal(b.addedWithinDays, 14);
    assert.equal(b.minPlays, 4);
    assert.deepEqual(b.playlists, ['best remixes']);
    assert.deepEqual(b.collections, ['12 inches']);
    const c = parseBriefLocally('house not played in the last year, all versions of Relax, hi-res', prof);
    assert.equal(c.notPlayedWithinDays, 365);
    assert.equal(c.allVersions, true);
    assert.equal(c.hiRes, true);
    assert.equal(parseBriefLocally('nummers die ik al meer dan 5 keer gedraaid heb', prof).minPlays, 6);
  });

  it('reads "the top 10 of the House Top 1000" as chart positions, not as a count of house', () => {
    const prof = { ...profile, charts: [
      { label: 'Music/Housetop1000', folder: 'Housetop1000', name: 'Housetop1000', from: 1, to: 1000, n: 1136 },
      { label: 'Music/TOP40/Complete Top 40 Van 1983', folder: 'TOP40/Complete Top 40 Van 1983', name: 'Complete Top 40 Van 1983', from: 1, to: 364, n: 364 },
    ] };
    const b = parseBriefLocally('geef me de top 10 van de house top 1000', prof);
    assert.equal(b.chart, 'Music/Housetop1000');
    assert.deepEqual([b.chartFrom, b.chartTo], [1, 10]);
    assert.equal(b.ranking, 'none');
    assert.equal(b.songs, null);
    assert.deepEqual(b.genres, []);
    const c = parseBriefLocally('nummer 1 van de top 40 van 1983, als countdown', prof);
    assert.equal(c.chart, 'Music/TOP40/Complete Top 40 Van 1983');
    assert.deepEqual([c.chartFrom, c.chartTo], [1, 1]);
    assert.deepEqual([c.yearFrom, c.yearTo], [null, null]);
    assert.equal(c.order, 'countdown');
    const v = validateBrief(c);
    assert.equal(v.chart, 'Music/TOP40/Complete Top 40 Van 1983');
    assert.equal(parseBriefLocally('my top 20 house tracks', prof).chart, null);
  });

  it('reads "the grandmix 1983 and 1986" as two titles of a series, not an era', () => {
    const prof = { ...profile, folders: [...profile.folders, { folder: 'Grandmix' }], series: [{ name: 'Grandmix', from: 1982, to: 2016, editions: 30, n: 149 }] };
    const b = parseBriefLocally('give me the grandmix 1983 and 1986', prof);
    assert.deepEqual(b.titles, ['grandmix 1983', 'grandmix 1986']);
    assert.deepEqual([b.yearFrom, b.yearTo], [null, null]);
    assert.deepEqual(b.folders, []);
    const v = validateBrief(b);
    assert.equal(v.songs, null, 'the planner plays one per title');
    const guard = validateBrief({ ...b, yearFrom: 1983, yearTo: 1986 });
    assert.deepEqual([guard.yearFrom, guard.yearTo], [null, null], 'a year that is part of a title is not an era');
    assert.deepEqual(parseBriefLocally('disco from 1983 and 1986', prof).titles, []);
  });

  it('"songs which match tempo, key, genre" means the songs must match each other', () => {
    const b = parseBriefLocally('create a mix of 3 songs which match tempo, key, genre. Random. Songs never played.', profile);
    assert.equal(b.cohesive, true);
    assert.equal(b.songs, 3);
    assert.equal(b.order, 'random');
    assert.equal(b.played, 'never');
    assert.deepEqual([b.bpmFrom, b.bpmTo, b.keys], [null, null, []]);
    assert.equal(parseBriefLocally('nummers die bij elkaar passen, een uur', profile).cohesive, true);
    assert.equal(parseBriefLocally('two hours of disco', profile).cohesive, false);
  });

  it('does not match a genre inside another word', () => {
    const b = parseBriefLocally('popular hits from 1995 to 1999 from the Disconet folder', profile);
    assert.deepEqual(b.genres, []);
    assert.deepEqual([b.yearFrom, b.yearTo], [1995, 1999]);
    assert.deepEqual(b.folders, ['Disconet']);
  });
});
