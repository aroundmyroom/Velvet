import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { appSrc, indexHtml, loadFns } from './helpers/fix-player-app.mjs';

const oldLogBin = (i, bars, binCount, sampleRate) => {
  const freq = Math.pow(2, Math.log2(40) + (Math.log2(20000) - Math.log2(40)) * i / bars);
  return Math.min(Math.floor(freq / (sampleRate / 2) * binCount), binCount - 1);
};

describe('meter helpers (P061, P062)', () => {
  const ctx = loadFns(['_logBin', '_lampIntensity', '_hsl2rgb', '_fftBuf'], {});

  it('_logBin matches the old inline bodies', () => {
    for (const [bars, n] of [[32, 1024], [80, 1024], [32, 128]]) {
      for (const i of [0, 1, bars / 2, bars - 1]) assert.equal(ctx._logBin(i, bars, n, 44100), oldLogBin(i, bars, n, 44100));
    }
  });

  it('_lampIntensity holds then fades', () => {
    assert.equal(ctx._lampIntensity(1000, null, 100, 200), 0);
    assert.equal(ctx._lampIntensity(1050, 1000, 100, 200), 1);
    assert.equal(ctx._lampIntensity(1200, 1000, 100, 200), 0.5);
    assert.equal(ctx._lampIntensity(2000, 1000, 100, 200), 0);
  });

  it('_hsl2rgb(0, 1, 0.5) is pure red', () => {
    assert.deepEqual([...ctx._hsl2rgb(0, 1, 0.5)], [255, 0, 0]);
  });

  it('_fftBuf reuses and zeroes a buffer of the same size', () => {
    const a = ctx._fftBuf(null, { frequencyBinCount: 16 });
    a[3] = 9;
    const b = ctx._fftBuf(a, { frequencyBinCount: 16 });
    assert.equal(a, b);
    assert.equal(b[3], 0);
    assert.notEqual(ctx._fftBuf(b, { frequencyBinCount: 32 }), b);
    assert.equal(ctx._fftBuf(null, null).length, 128);
  });

  it('no per-frame logBin / lamp helpers or per-column hsl2rgb remain', () => {
    assert.doesNotMatch(appSrc, /function logBin\(/);
    assert.doesNotMatch(appSrc, /function (lampI|ppmLampI)\(/);
    assert.doesNotMatch(appSrc, /function hsl2rgb\(/);
    assert.match(appSrc, /waterfallRows\.width!==W \|\| waterfallRows\.height!==H/);
  });
});

describe('view routes (P065, P073)', () => {
  const routeSrc = appSrc.slice(appSrc.indexOf('const VIEW_ROUTES = {'), appSrc.indexOf('// Launches the user\'s pinned start view'));
  const ids = [...routeSrc.matchAll(/^\s+'?([a-z-]+)'?:\s+\{/gm)].map(m => m[1]);

  it('every data-view in index.html has a VIEW_ROUTES entry with open()', () => {
    const views = [...new Set([...indexHtml.matchAll(/data-view="([^"]+)"/g)].map(m => m[1]))];
    assert.ok(views.length > 20);
    for (const v of views) {
      assert.ok(ids.includes(v), `missing route for ${v}`);
      assert.match(routeSrc, new RegExp(`'?${v}'?:\\s+\\{ open:`), `${v} has no open()`);
    }
  });

  it('pages that were missing from the language re-render are routed', () => {
    for (const v of ['playing-now', 'webhooks', 'sonos-radio']) assert.ok(ids.includes(v), v);
  });

  it('nav, language re-render and pinned launcher all use VIEW_ROUTES', () => {
    assert.match(appSrc, /VIEW_ROUTES\[v\]\?\.open\?\.\(\)/);
    assert.match(appSrc, /route\?\.rerender \|\| route\?\.open/);
    assert.match(appSrc, /const route = VIEW_ROUTES\[S\.pinnedView\];/);
    assert.doesNotMatch(appSrc, /else if \(v === 'ml-playlist'\)/);
    assert.doesNotMatch(appSrc, /case 'podcast-episodes':/);
  });

  it('pinnable views are the former PINNABLE_VIEWS set', () => {
    const routes = loadFns(['VIEW_ROUTES'], {}).$.VIEW_ROUTES;
    const pinnable = Object.keys(routes).filter(v => routes[v].pinnable).sort();
    assert.deepEqual(pinnable, ['album-library', 'artists', 'files', 'home', 'playing-now', 'rated', 'search', 'shortcuts']);
  });

  it('files and smart-playlists keep their state on a language re-render', () => {
    const calls = [];
    const S = { feDir: 'Music/A', feDirStack: [1], feFilter: 'x' };
    const routes = loadFns(['VIEW_ROUTES'], {
      S,
      viewFiles: (d, push) => calls.push(['files', d, push]),
      viewSmartPlaylists: () => calls.push(['spl']),
      _splResetBuilder: () => calls.push(['reset']),
    }).$.VIEW_ROUTES;
    routes.files.rerender();
    routes['smart-playlists'].rerender();
    assert.deepEqual(calls, [['files', 'Music/A', false], ['spl']]);
    calls.length = 0;
    routes.files.open();
    routes['smart-playlists'].open();
    assert.deepEqual(calls, [['files', '', false], ['reset'], ['spl']]);
    assert.equal(S.feDirStack.length, 0);
    assert.equal(S.feFilter, '');
  });
});

describe('dead code and fallbacks (P055, P059, P067, P074, P126)', () => {
  it('normalizeArtist and renderSongRowsWithPath are gone', () => {
    assert.doesNotMatch(appSrc, /function normalizeArtist\(/);
    assert.doesNotMatch(appSrc, /function renderSongRowsWithPath\(/);
    assert.match(appSrc, /function cleanArtistDisplay\(/);
  });

  it('jukebox addSong never queues the raw remote path', () => {
    assert.doesNotMatch(appSrc, /Player\.addSong\(\{ filepath: msg\.file/);
    assert.match(appSrc, /player\.toast\.jukeboxAddFailed/);
  });

  it('go-artist returns to the current Artists page', () => {
    assert.doesNotMatch(appSrc, /viewArtists_old\(/);
  });

  it('no room "buffering" state checks', () => {
    assert.doesNotMatch(appSrc, /'buffering'/);
  });
});

describe('i18n literals (P063, P068, P072)', () => {
  const en = JSON.parse(fs.readFileSync(new URL('../webapp/locales/en.json', import.meta.url), 'utf8'));

  it('every literal t() key used by app.js exists in en.json', () => {
    const keys = [...new Set([...appSrc.matchAll(/\bt\(\s*'(player\.[\w.]+\w)'/g)].map(m => m[1]))];
    const missing = keys.filter(k => !(k in en));
    assert.deepEqual(missing, []);
  });

  it('fixed literals are gone', () => {
    for (const s of ['>No songs found<', 'Loading lyrics…', '>No lyrics found<', 'Destination: ${', "'Create another'",
      '>Error: ${esc(e.message)}', "'Save Smart Playlist'", "'Connecting…'", "'Saving…'", "'Signing in…'",
      'Login failed. Check credentials.', "'end of song'", 'Sleep — playback stopped', "'Repeat: One'",
      'Generating waveform…', 'Radio: trying fallback link', 'Please enter a valid https:// URL',
      'Could not load image from that URL', 'Recording failed: ', '>Username: <strong>']) {
      assert.ok(!appSrc.includes(s), `still hard-coded: ${s}`);
    }
  });

  it('all 12 locales carry the same keys', () => {
    const enKeys = Object.keys(en);
    for (const lang of ['nl', 'de', 'fr', 'es', 'it', 'pt', 'pl', 'ru', 'zh', 'ja', 'ko']) {
      const d = JSON.parse(fs.readFileSync(new URL(`../webapp/locales/${lang}.json`, import.meta.url), 'utf8'));
      assert.deepEqual(enKeys.filter(k => !(k in d)), [], lang);
    }
  });
});
