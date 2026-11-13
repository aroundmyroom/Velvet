/**
 * The browser Auto-DJ (webapp/app.js) and the server-side radio
 * (src/autodj/scoring.js) score candidates with two copies of the same code.
 * These tests evaluate the browser functions from the app source in a vm
 * sandbox and run both on the same fixtures, so a change on one side that is
 * not made on the other fails here.
 *
 * Run with:
 *   node --test test/autodj-parity.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as server from '../src/autodj/scoring.js';

const src = fs.readFileSync(new URL('../webapp/app.js', import.meta.url), 'utf8');
const slice = (from, to) => {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `app.js no longer contains ${from} … ${to}`);
  return src.slice(a, b);
};

function loadClient() {
  const ctx = { S: {}, console: { log() {}, debug() {} } };
  vm.createContext(ctx);
  const code = [
    slice('const _CAMELOT = {', '// Track bitrate arrives'),
    slice('function toCamelot(', '// Camelot wheel reference popup'),
    slice('function _expandDjGenres(', 'function _showInfoStrip('),
    slice('function _djGenreCat(', '// Keyword filter — the ONLY hard block'),
    slice('const DJ_ARTIST_HARD_FLOOR', 'async function _djPickSong('),
    'const DJ_ARTIST_COOLDOWN = ' + /const DJ_ARTIST_COOLDOWN = (\d+)/.exec(src)[1] + ';',
    `var _djSimilarArtists = [], _djVariantRankMap = {}, _currentBpm = null, _currentCamelot = null,
       _currentNeighbours = null, _bpmAnchor = null, _djLastPickFree = false, _yearAnchor = null,
       _djSeedFamily = null, _djFamilyHistory = [], _djGenreGroupsCache = null;
     this.score = _djScoreSong; this.anchor = _djGenreAnchor; this.keys = _djArtistKeys;
     this.overlap = _djArtistsOverlap; this.toCamelot = toCamelot; this.neighbours = camelotNeighbours;
     this.genreCat = _djGenreCat;
     this.set = o => { _djSimilarArtists = o.similarArtists; _djVariantRankMap = o.rankMap;
       _currentBpm = o.currentBpm; _currentCamelot = o.currentCamelot; _currentNeighbours = o.currentNeighbours;
       _bpmAnchor = o.bpmAnchor; _djLastPickFree = o.lastPickFree; _yearAnchor = o.yearAnchor;
       _djSeedFamily = o.seedFamily; _djFamilyHistory = o.familyHistory; };`,
  ].join('\n');
  // app.js is a classic browser script, not a module: evaluate the Auto-DJ helpers from our own source
  // eslint-disable-next-line sonarjs/code-eval
  vm.runInContext(code, ctx);
  return ctx;
}

// Deterministic PRNG so a failure is reproducible.
function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KEYS = ['C major', 'A minor', 'G major', 'E minor', 'F# minor', 'Bb major', 'Db major', 'Ab minor', 'B major', 'not a key', null];
const GENRES = ['Disco', 'House', 'Deep House', 'Pop', 'Rock', 'Ambient', 'Hardstyle', 'Funk, Soul', 'Trance', 'Jazz', 'Country', 'Folk', 'R&B', 'Indie', 'Gabber', 'Chillout', 'Motown', 'Synthpop', 'Schlager', null];
const FAMILIES = [null, null, null, 'disco', 'electronic', 'soft'];
const ARTISTS = ['Chic', 'Sister Sledge', 'Donna Summer', 'Cerrone', 'Eric Prydz', 'Eric Prydz & Steve Angello',
  'Mel & Kim', 'Mel & Kim vs. Frantique', 'Clean Bandit Fe. Mabel', '04. Clean Bandit', 'Daft Punk x Pharrell',
  'Tiësto', 'The Weather Girls', 'Earth, Wind & Fire', 'A1. Donna Summer', '02.Donna Summer', null];

function pick(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }
function maybe(rng, v, p = 0.8) { return rng() < p ? v : null; }

function randomSong(rng) {
  return {
    artist: pick(rng, ARTISTS),
    genre: pick(rng, GENRES),
    genreFamily: pick(rng, FAMILIES),
    musical_key: pick(rng, KEYS),
    bpm: maybe(rng, 70 + Math.round(rng() * 110)),
    year: maybe(rng, 1965 + Math.round(rng() * 60)),
  };
}

function randomContext(rng) {
  const current = randomSong(rng);
  const similar = rng() < 0.6;
  const rankMap = {};
  if (similar && rng() < 0.85) for (const a of ARTISTS.filter(Boolean)) if (rng() < 0.5) rankMap[a] = 1 + Math.floor(rng() * 50);
  const currentCamelot = server.toCamelot(current.musical_key);
  const history = Array.from({ length: Math.floor(rng() * 20) }, () => pick(rng, ARTISTS)).filter(Boolean);
  const familyHistory = Array.from({ length: Math.floor(rng() * 10) }, () => pick(rng, ['disco', 'electronic', 'soft', 'ambient']));
  const seedFamily = pick(rng, [null, 'disco', 'electronic', 'soft']);
  return {
    current,
    similarArtists: similar ? ['x'] : [],
    rankMap,
    currentBpm: current.bpm ?? null,
    currentCamelot,
    currentNeighbours: server.camelotNeighbours(currentCamelot),
    bpmAnchor: maybe(rng, 90 + Math.round(rng() * 60), 0.6),
    yearAnchor: maybe(rng, 1970 + Math.round(rng() * 50), 0.6),
    lastPickFree: rng() < 0.2,
    bpmTolerance: pick(rng, [4, 8, 12]),
    seedFamily,
    familyHistory,
    artistHistory: history,
  };
}

function clientScore(client, c, song) {
  client.S.djSimilar = true;
  client.S.queue = [c.current];
  client.S.idx = 0;
  client.S.djBpmBase = null;
  client.S.djBpmTolerance = c.bpmTolerance;
  client.S.djArtistHistory = c.artistHistory;
  client.S.djGenreEnabled = false;
  client.S.djGenres = [];
  client.set(c);
  return client.score(song);
}

function serverScore(c, song) {
  return server.scoreSong(song, {
    similarActive: c.similarArtists.length > 0,
    rankMap: c.rankMap,
    current: c.current,
    currentBpm: c.currentBpm,
    currentCamelot: c.currentCamelot,
    currentNeighbours: c.currentNeighbours,
    bpmBase: null,
    bpmAnchor: c.bpmAnchor,
    yearAnchor: c.yearAnchor,
    lastPickFree: c.lastPickFree,
    bpmTolerance: c.bpmTolerance,
    genreAnchor: server.genreAnchor(c.seedFamily, c.familyHistory),
    genreFilter: null,
    artistHistory: c.artistHistory,
  });
}

describe('Auto-DJ scoring: browser and server agree', () => {
  const client = loadClient();

  it('scores 3000 random candidate/context pairs identically', () => {
    const rng = mulberry32(20261112);
    for (let i = 0; i < 300; i++) {
      const c = randomContext(rng);
      for (let j = 0; j < 10; j++) {
        const song = randomSong(rng);
        const a = clientScore(client, c, song);
        const b = serverScore(c, song);
        assert.equal(b, a, `context ${i} song ${j}: ${JSON.stringify({ c, song })}`);
      }
    }
  });

  it('picks the same winner from a pool', () => {
    const rng = mulberry32(7);
    for (let i = 0; i < 50; i++) {
      const c = randomContext(rng);
      const pool = Array.from({ length: 40 }, () => randomSong(rng));
      const best = scorer => pool.reduce((bi, s, k) => (scorer(s) > scorer(pool[bi]) ? k : bi), 0);
      assert.equal(best(s => serverScore(c, s)), best(s => clientScore(client, c, s)));
    }
  });

  it('applies the user genre whitelist/blacklist the same way', () => {
    const rng = mulberry32(99);
    for (const mode of ['whitelist', 'blacklist']) {
      for (let i = 0; i < 100; i++) {
        const c = randomContext(rng);
        const song = randomSong(rng);
        client.S.djGenreEnabled = true;
        client.S.djGenreMode = mode;
        client.S.djGenres = ['Disco', 'House'];
        client.S.djSimilar = true;
        client.S.queue = [c.current];
        client.S.idx = 0;
        client.S.djBpmBase = null;
        client.S.djBpmTolerance = c.bpmTolerance;
        client.S.djArtistHistory = c.artistHistory;
        client.set(c);
        const a = client.score(song);
        const b = server.scoreSong(song, {
          similarActive: c.similarArtists.length > 0, rankMap: c.rankMap, current: c.current, currentBpm: c.currentBpm,
          currentCamelot: c.currentCamelot, currentNeighbours: c.currentNeighbours, bpmBase: null,
          bpmAnchor: c.bpmAnchor, yearAnchor: c.yearAnchor, lastPickFree: c.lastPickFree,
          bpmTolerance: c.bpmTolerance, genreAnchor: server.genreAnchor(c.seedFamily, c.familyHistory),
          genreFilter: { mode, genres: ['Disco', 'House'] }, artistHistory: c.artistHistory,
        });
        assert.equal(b, a);
      }
    }
  });

  it('has the same genre anchor, genre families, Camelot wheel and artist keys', () => {
    const rng = mulberry32(3);
    for (let i = 0; i < 200; i++) {
      const c = randomContext(rng);
      client.set(c);
      assert.equal(server.genreAnchor(c.seedFamily, c.familyHistory), client.anchor());
    }
    for (const g of GENRES) assert.equal(server.genreCat(g), client.genreCat(g));
    for (const k of KEYS) {
      assert.equal(server.toCamelot(k), client.toCamelot(k));
      assert.deepEqual([...(server.camelotNeighbours(server.toCamelot(k)) || [])], [...(client.neighbours(client.toCamelot(k)) || [])]);
    }
    for (const a of ARTISTS) assert.deepEqual([...server.artistKeys(a)], [...client.keys(a)]);
    assert.ok(server.artistsOverlap(server.artistKeys('Clean Bandit Fe. Mabel'), server.artistKeys('04. Clean Bandit')));
    assert.ok(server.artistsOverlap(server.artistKeys('A1. Donna Summer'), server.artistKeys('02.Donna Summer')));
  });
});
