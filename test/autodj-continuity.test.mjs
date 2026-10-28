/**
 * Auto-DJ keeps its direction when Last.fm has no similar artists (webapp/app.js):
 * the last good similar-artist list is kept mid-session, and a session genre
 * anchor keeps one off-genre or untagged pick from steering the rest.
 * The helpers are evaluated from the app source against a stubbed player.
 *
 * Run with:
 *   node --test test/autodj-continuity.test.mjs
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const src = fs.readFileSync(new URL('../webapp/app.js', import.meta.url), 'utf8');
const genreBlock = src.slice(src.indexOf('function _djGenreCat('), src.indexOf('// Explicit user genre whitelist/blacklist'));
const keepFn = src.match(/function _djNoSimilarFor[\s\S]*?\n}\n/)[0];

function makeDj() {
  const ctx = {
    S: { queue: [], idx: 0 },
    t: (k, p) => `${k}${p ? JSON.stringify(p) : ''}`,
    esc: s => s,
    strips: [],
    console: { log() {} },
    _djSimilarFor: '', _djSimilarSource: '', _djSimilarArtists: [], _djSimilarDisplayArtists: [], _djVariantRankMap: {},
    _djSeedFamily: null, _djFamilyHistory: [],
  };
  ctx._showInfoStrip = (badge, html) => ctx.strips.push(html);
  vm.createContext(ctx);
  // app.js is a classic script, not a module: evaluate the Auto-DJ helpers from our own source
  // eslint-disable-next-line sonarjs/code-eval
  vm.runInContext(`${genreBlock}\n${keepFn}\n` +
    'this.familyOf = _djGenreFamilyOf; this.anchor = _djGenreAnchor; this.cont = _djGenreContinuityScore; this.noSimilar = _djNoSimilarFor;' +
    'this.state = () => ({ for: _djSimilarFor, source: _djSimilarSource, artists: _djSimilarArtists, ranks: _djVariantRankMap });' +
    'this.set = o => { if ("seed" in o) _djSeedFamily = o.seed; if ("hist" in o) _djFamilyHistory = o.hist;' +
    ' if ("artists" in o) { _djSimilarArtists = o.artists; _djSimilarSource = o.source; _djVariantRankMap = o.ranks || {}; } };', ctx);
  return ctx;
}

const song = (genre, genreFamily) => ({ genre, genreFamily });

describe('Similar-artist list after a Last.fm miss', () => {
  let dj;
  beforeEach(() => {
    dj = makeDj();
    dj.set({ artists: ['Cerrone', 'Chic', 'Sister Sledge'], source: 'Donna Summer', ranks: { Chic: 1 } });
  });

  it('keeps the previous list while Auto-DJ is running', () => {
    dj.S.queue = [{ artist: 'Obscure Disco Act', _dj: true }];
    const filter = dj.noSimilar('Obscure Disco Act', false);
    assert.deepEqual([...filter], ['Cerrone', 'Chic', 'Sister Sledge']);
    assert.equal(dj.state().source, 'Donna Summer');
    assert.equal(dj.state().for, 'Obscure Disco Act');
    assert.equal(dj.state().ranks.Chic, 1);
    assert.match(dj.strips[0], /infoNoSimilarKeep.*Donna Summer/);
  });

  it('also keeps it when the Last.fm lookup itself failed', () => {
    dj.S.queue = [{ artist: 'X', _dj: true }];
    assert.equal(dj.noSimilar('X', true).length, 3);
  });

  it('starts fresh for a song the user picked', () => {
    dj.S.queue = [{ artist: 'Someone New' }];
    assert.equal(dj.noSimilar('Someone New', false), undefined);
    assert.equal(dj.state().artists.length, 0);
    assert.equal(dj.state().source, '');
    assert.match(dj.strips[0], /infoNoSimilar\{/);
  });

  it('has nothing to keep at the start of a session', () => {
    dj.set({ artists: [], source: '' });
    dj.S.queue = [{ artist: 'X', _dj: true }];
    assert.equal(dj.noSimilar('X', true), undefined);
    assert.match(dj.strips[0], /infoLookupFailed/);
  });
});

describe('Genre family of a song', () => {
  const dj = makeDj();
  it('prefers the family the server attached, then the keyword match on the tag', () => {
    assert.equal(dj.familyOf(song('blues', 'disco')), 'disco');
    assert.equal(dj.familyOf(song('blues')), 'other');
    assert.equal(dj.familyOf(song(null, 'electronic')), 'electronic');
    assert.equal(dj.familyOf(song(null)), null);
    assert.equal(dj.familyOf(null), null);
  });
});

describe('Session genre anchor', () => {
  let dj;
  beforeEach(() => { dj = makeDj(); });

  it('follows the song the session started with', () => {
    dj.set({ seed: 'disco', hist: ['electronic'] });
    assert.equal(dj.anchor(), 'disco');
  });

  it('moves with the picks once they agree', () => {
    dj.set({ seed: 'disco', hist: ['electronic', 'electronic', 'electronic', 'electronic'] });
    assert.equal(dj.anchor(), 'electronic');
  });

  it('is absent without any genre information', () => {
    assert.equal(dj.anchor(), null);
  });

  it('decides alone when nothing is known about the current song', () => {
    assert.ok(dj.cont(song(null), song('funk'), 'disco') > dj.cont(song(null), song('hardstyle'), 'disco'));
    assert.equal(dj.cont(song(null), song('funk'), null), 0.6);
  });

  it('pulls an off-genre current song back towards the session', () => {
    assert.ok(dj.cont(song('rock'), song('disco'), 'disco') > dj.cont(song('rock'), song('disco'), null));
  });

  it('keeps the old score for the same genre', () => {
    assert.equal(dj.cont(song('House'), song('house'), null), 1.0);
  });

  it('scores an untagged song by the family the server attached', () => {
    assert.equal(dj.cont(song(null, 'disco'), song('funk'), null), 0.9);
    assert.equal(dj.cont(song('house'), song(null, 'disco'), null), 0.7);
  });
});

describe('Auto-DJ wiring', () => {
  it('scores genre through the anchor', () => {
    assert.match(src, /_djGenreContinuityScore\(S\.queue\[S\.idx\], song, _djGenreAnchor\(\)\)/);
  });
  it('a manually started song seeds the anchor', () => {
    assert.match(src, /if \(!s\?\._dj\) \{\n\s+_djSeedFamily = _djGenreFamilyOf\(s\);/);
  });
  it('both Last.fm miss paths keep the list', () => {
    assert.match(src, /artistFilter = _djNoSimilarFor\(currentArtist, false\);/);
    assert.match(src, /artistFilter = _djNoSimilarFor\(currentArtist, true\);/);
  });
  it('the server-attached family survives norm()', () => {
    assert.match(src, /genreFamily:\s+m\['genre-family'\] \|\| null,/);
  });
});
