// Player fixes P013–P054 (fix-147-plan.md): source checks and vm-evaluated helpers from webapp/app.js,
// plus the play-statistics wiring in the mobile and Tizen clients.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { appSrc, loadFns, makeApiStub, topLevelSource } from './helpers/fix-player-app.mjs';

const mobileSrc = fs.readFileSync(new URL('../webapp/mobile/app.js', import.meta.url), 'utf8');
const tizenSrc = fs.readFileSync(new URL('../webapp/tizen/app.js', import.meta.url), 'utf8');
const plain = v => JSON.parse(JSON.stringify(v));

describe('dead code removed (P014, P020)', () => {
  it('has no split-flap lyric board', () => {
    assert.doesNotMatch(appSrc, /_flip[A-Z]|flipboard|FLIP_ROWS/);
  });
  it('has no viewArtistAlbums / renderAlbumGrid', () => {
    assert.doesNotMatch(appSrc, /viewArtistAlbums|renderAlbumGrid/);
  });
});

describe('one artist page (P015)', () => {
  it('only opens viewArtistProfile2', () => {
    assert.doesNotMatch(appSrc, /viewArtistProfile\(/);
    assert.doesNotMatch(appSrc, /artists-albums-multi/);
  });
  it('shows Last.fm similar artists on the new page', () => {
    const v2 = topLevelSource('viewArtistProfile2');
    assert.match(v2, /id="artpro2-sim"/);
    assert.match(v2, /lastfm\/similar-artists/);
    assert.match(v2, /_renderSimilarArtistChips\(document\.getElementById\('artpro2-sim'\), document\.getElementById\('artpro2-sim-title'\), simData, goBack\)/);
    assert.match(topLevelSource('_renderSimilarArtistChips'), /viewArtistProfile2\(a\.toLowerCase\(\), a, variantMap\[a\] \|\| \[a\], backFn\)/);
  });
});

describe('logout (P025)', () => {
  it('reloads the page instead of calling showLogin()', () => {
    const start = appSrc.indexOf("document.getElementById('logout-btn').addEventListener('click'");
    const handler = appSrc.slice(start, appSrc.indexOf('\n});\n', start));
    assert.match(handler, /location\.reload\(\);$/);
    assert.doesNotMatch(handler, /showLogin\(\)/);
  });
});

describe('media session keys (P027)', () => {
  const block = topLevelSource('showApp').match(/navigator\.mediaSession\.setActionHandler\('play'[\s\S]*?setActionHandler\('pause'.*\n/)[0];
  const run = ({ room, paused }) => {
    const handlers = {};
    const calls = [];
    const audioEl = { paused, play: () => calls.push('audio.play'), pause: () => calls.push('audio.pause') };
    const ctx = loadFns(['_roomPlaying', '_isPlayingNow'], {
      _room: room, audioEl,
      navigator: { mediaSession: { setActionHandler: (n, fn) => { handlers[n] = fn; } } },
      VIZ: { initAudio() {} },
      Player: { toggle: () => calls.push('toggle') },
    });
    // eslint-disable-next-line sonarjs/code-eval
    new Function('navigator', 'VIZ', 'Player', '_isPlayingNow', block)(ctx.navigator, ctx.VIZ, ctx.Player, ctx._isPlayingNow);
    return { handlers, calls };
  };

  it('pauses a playing room through Player.toggle, never the local element', () => {
    const { handlers, calls } = run({ room: { state: 'playing' }, paused: true });
    handlers.pause();
    assert.deepEqual(calls, ['toggle']);
    handlers.play();
    assert.deepEqual(calls, ['toggle']);
  });

  it('plays a paused room through Player.toggle', () => {
    const { handlers, calls } = run({ room: { state: 'paused' }, paused: true });
    handlers.play();
    handlers.pause();
    assert.deepEqual(calls, ['toggle']);
  });

  it('uses the local element state without a room', () => {
    const { handlers, calls } = run({ room: null, paused: false });
    handlers.play();
    assert.deepEqual(calls, []);
    handlers.pause();
    assert.deepEqual(calls, ['toggle']);
  });
});

describe('sleep timer (P028)', () => {
  it('does not pre-start crossfade or gapless while end-of-song sleep is armed', () => {
    const ui = topLevelSource('_onAudioTimeupdateUI');
    assert.match(ui, /S\.crossfade > 0 && [^\n]*S\.sleepMins !== -1\) \{/);
    assert.match(ui, /if \(S\.gapless && [^\n]*S\.sleepMins !== -1 &&/);
  });

  const fadeCtx = (extra) => {
    const calls = [];
    const ctx = loadFns(['_roomPlaying', '_isPlayingNow', '_sleepStopped', '_sleepFadeOut'], {
      S: { sleepMins: 0, sleepEndsAt: 0, castingToSonos: false, castingToMpv: false },
      audioEl: { paused: false, volume: 1, pause: () => calls.push('audio.pause') },
      Player: { toggle: () => calls.push('toggle') },
      _room: null, t: k => k,
      _updateSleepLight() {}, _showInfoStrip() {},
      setInterval: (fn) => { queueMicrotask(() => { for (let i = 0; i < 40; i++) fn(); }); return 1; },
      clearInterval() {},
      ...extra,
    });
    return { ctx, calls };
  };

  it('stops a room through Player.toggle without fading the local element', () => {
    const { ctx, calls } = fadeCtx({ _room: { state: 'playing' } });
    ctx.audioEl.paused = true;
    ctx._sleepFadeOut();
    assert.deepEqual(calls, ['toggle']);
    assert.equal(ctx.audioEl.volume, 1);
  });

  it('pauses a Sonos cast through Player.toggle', () => {
    const { ctx, calls } = fadeCtx({});
    ctx.S.castingToSonos = true;
    ctx._sleepFadeOut();
    assert.deepEqual(calls, ['toggle']);
  });

  it('fades local playback then pauses through Player.toggle and restores volume', async () => {
    const { ctx, calls } = fadeCtx({});
    ctx._sleepFadeOut();
    await Promise.resolve();
    assert.deepEqual(calls, ['toggle']);
    assert.equal(ctx.audioEl.volume, 1);
  });

  it('logs play-end before stopping at end of song', () => {
    const { api, calls } = makeApiStub();
    const ctx = loadFns(['_sleepStopped', '_onAudioEnded'], {
      S: { sleepMins: -1, sleepEndsAt: -1, queue: [{ filepath: 'Music/a.mp3' }], idx: 0 },
      audioEl: { duration: 200 },
      api, Player: { next: () => calls.push({ path: 'next' }) }, t: k => k,
      _xfadeFired: false, _wrappedEventId: 7, _wrappedTrackStartOffset: 0, _wrappedPodcastEventId: null, _podcastSong: null,
      _stopWaveformRaf() {}, _isAudioBookSong: () => false, _syncQueueToDbNow() {},
      _updateSleepLight() {}, _showInfoStrip() {},
    });
    ctx._onAudioEnded();
    assert.deepEqual(calls.map(c => c.path), ['api/v1/wrapped/play-end']);
    assert.equal(calls[0].body.playedMs, 200000);
    assert.equal(ctx.S.sleepMins, 0);
  });

  it('pauses a room on its track change when end-of-song sleep is armed', () => {
    const room = topLevelSource('_roomApply');
    assert.match(room, /S\.sleepMins === -1 && _room\.filepath && st\.current\?\.filepath && st\.current\.filepath !== _room\.filepath[^\n]*\n\s+_roomCmd\('pause'\)/);
  });
});

describe('Auto-DJ child collections (P013)', () => {
  const meta = {
    Music: { parentVpath: null },
    A: { parentVpath: 'Music', filepathPrefix: 'A/' },
    B: { parentVpath: 'Music', filepathPrefix: 'B/' },
    Other: { parentVpath: null },
    Third: { parentVpath: null },
  };
  const scope = (djVpaths) => loadFns(['_djScopeBody'], {
    S: { djVpaths, vpaths: ['Music', 'A', 'B', 'Other', 'Third'], vpathMeta: meta, djMinRating: 0 },
    _audioBookExclusions: () => ({ ignoreVPaths: [], excludeFilepathPrefixes: [] }),
  })._djScopeBody();

  it('keeps the single-child prefix filter', () => {
    const s = scope(['A']);
    assert.equal(s.filepathPrefix, 'A/');
    assert.deepEqual(plain(s.ignoreVPaths), ['Other', 'Third']);
    assert.equal(s.includeFilepathPrefixes, undefined);
  });

  it('whitelists every selected child of the same parent', () => {
    const s = scope(['A', 'B']);
    assert.deepEqual(plain(s.includeFilepathPrefixes), [{ vpath: 'Music', prefix: 'A/' }, { vpath: 'Music', prefix: 'B/' }]);
    assert.deepEqual(plain(s.ignoreVPaths), ['Other', 'Third']);
    assert.equal(s.filepathPrefix, undefined);
  });

  it('keeps the parent of a child selected next to another root', () => {
    const s = scope(['A', 'Other']);
    assert.deepEqual(plain(s.includeFilepathPrefixes), [{ vpath: 'Music', prefix: 'A/' }]);
    assert.deepEqual(plain(s.ignoreVPaths), ['Third']);
  });

  it('drops child prefixes when their root is selected too', () => {
    const s = scope(['Music', 'A']);
    assert.equal(s.includeFilepathPrefixes, undefined);
    assert.equal(s.filepathPrefix, undefined);
    assert.deepEqual(plain(s.ignoreVPaths), ['Other', 'Third']);
  });
});

describe('Subsonic self-service (P018/P032)', () => {
  it('saves through the user routes without a username', () => {
    const v = topLevelSource('viewSubsonic');
    assert.doesNotMatch(v, /api\/v1\/admin\//);
    assert.match(v, /api\('POST', 'api\/v1\/user\/subsonic-password', \{ password: pw \}\)/);
    assert.match(v, /api\('POST', 'api\/v1\/user\/subsonic-scrobble', \{ \[key\]: value \}\)/);
    assert.doesNotMatch(v, /'Saving…'|textContent = 'Save'/);
  });
});

describe('radio recording restore (P021)', () => {
  it('restores the first active recording with its elapsed time', async () => {
    const { api, calls } = makeApiStub(() => [{ id: 'r1', stationName: 'Radio X', vpath: 'Recordings', startedAt: Date.now() - 65_000 }]);
    let updated = 0;
    const ctx = loadFns(['_setActiveRecording', '_restoreActiveRecording'], {
      S: { allowRadioRecording: true, recordingActive: false, _recordingTimer: null },
      api, setInterval: () => 42, clearInterval() {}, document: { getElementById: () => null }, fmt: String,
      _updateRecordBtn: () => { updated++; },
    });
    await ctx._restoreActiveRecording();
    assert.equal(calls[0].path, 'api/v1/radio/record/active');
    assert.equal(ctx.S.recordingActive, true);
    assert.equal(ctx.S.recordingId, 'r1');
    assert.ok(ctx.S.recordingElapsedSec >= 64 && ctx.S.recordingElapsedSec <= 66);
    assert.deepEqual(plain(ctx.S.recordingMeta), { vpath: 'Recordings', art: null, title: 'Radio X', startedHere: false });
    assert.equal(ctx.S._recordingTimer, 42);
    assert.equal(updated, 1);
  });

  it('does nothing without permission or with no recording', async () => {
    const { api, calls } = makeApiStub(() => []);
    const ctx = loadFns(['_setActiveRecording', '_restoreActiveRecording'], {
      S: { allowRadioRecording: false, recordingActive: false }, api,
    });
    await ctx._restoreActiveRecording();
    assert.equal(calls.length, 0);
    ctx.S.allowRadioRecording = true;
    await ctx._restoreActiveRecording();
    assert.equal(ctx.S.recordingActive, false);
  });

  it('is called once the permission is known', () => {
    assert.match(topLevelSource('showApp'), /S\.allowRadioRecording = d\.allowRadioRecording === true;\n\s+_updateRecordBtn\(\);\n\s+_restoreActiveRecording\(\);/);
  });
});

describe('YouTube download play path (P022)', () => {
  it('prefers the server DB path and resolves through db/metadata', () => {
    const v = topLevelSource('viewYoutube');
    assert.match(v, /filepath: job\.filepath \|\| \(job\.vpath \+ '\/' \+ job\.filePath\)/);
    assert.match(v, /api\('POST', 'api\/v1\/db\/metadata', \{ filepath: fallbackSong\.filepath \}\)/);
    assert.match(v, /norm\(meta\)/);
  });
});

describe('podcast resume (P038)', () => {
  const load = (handler) => {
    const { api, calls } = makeApiStub(handler);
    const ctx = loadFns(['_podcastSong', '_podcastSavedAt', '_podcastPositions', '_savePodcastProgress', '_podcastResumeAt'], {
      api, audioEl: { currentTime: 61.5 },
    });
    return { ctx, calls };
  };

  it('posts the episode position in seconds', () => {
    const { ctx, calls } = load();
    ctx.$._podcastSong = { _episodeId: 5, _feedId: 2 };
    ctx._savePodcastProgress();
    assert.deepEqual(plain(calls[0]), { method: 'POST', path: 'api/v1/podcast/episode/progress', body: { episodeId: 5, feedId: 2, position: 61.5 } });
    ctx._savePodcastProgress(true);
    assert.deepEqual(plain(calls[1].body), { episodeId: 5, feedId: 2, position: 0, played: true });
  });

  it('resumes from the saved position unless played or near the end', () => {
    const { ctx } = load();
    assert.equal(ctx._podcastResumeAt({ id: 1, play_position: 90, duration_secs: 3600 }), 90);
    assert.equal(ctx._podcastResumeAt({ id: 1, play_position: 3590, duration_secs: 3600 }), 0);
    assert.equal(ctx._podcastResumeAt({ id: 1, play_position: 90, played: 1 }), 0);
    assert.equal(ctx._podcastResumeAt({ id: 1, play_position: 1 }), 0);
  });

  it('prefers a position saved in this session over a stale episode list', () => {
    const { ctx } = load();
    ctx.$._podcastSong = { _episodeId: 9, _feedId: 2 };
    ctx._savePodcastProgress();
    assert.equal(ctx._podcastResumeAt({ id: 9, play_position: 0 }), 61.5);
  });

  it('saves on pause, every 15 s, at track change and on end', () => {
    assert.match(topLevelSource('_onAudioPause'), /_savePodcastProgress\(\)/);
    assert.match(topLevelSource('_onAudioTimeupdatePersist'), /Date\.now\(\) - _podcastSavedAt >= 15000\) _savePodcastProgress\(\)/);
    assert.match(topLevelSource('_onAudioEnded'), /_savePodcastProgress\(true\)/);
    assert.match(topLevelSource('Player'), /if \(_podcastSong && !audioEl\.ended\) _savePodcastProgress\(\);\n\s+_podcastSong = null;/);
  });
});

describe('play statistics on mobile and Tizen (P054)', () => {
  it('mobile sends Wrapped play-start / pause / end / skip', () => {
    for (const r of ['wrapped/play-start', 'wrapped/play-end', 'wrapped/play-skip', 'wrapped/pause']) assert.ok(mobileSrc.includes(r), r);
    assert.match(mobileSrc, /PLAYSTATS\.close\(\);\n\s+S\.queueIdx = idx;\n\s+const t = S\.queue\[idx\];\n(?:.*\n){0,3}\s+this\.el\.src/);
    assert.match(mobileSrc, /_onEnded\(\) \{ PLAYSTATS\.close\(true\); this\.skipNext\(\); \}/);
  });

  it('Tizen logs plays and Wrapped events for every track', () => {
    for (const r of ['db/stats/log-play', 'wrapped/play-start', 'wrapped/play-end', 'wrapped/play-skip', 'wrapped/pause']) assert.ok(tizenSrc.includes(r), r);
    assert.match(tizenSrc, /function _loadAndPlay\(track\) \{\n\s+_statsStart\(track\);/);
    assert.match(tizenSrc, /function _onTrackEnd\(\) \{\n\s+_statsClose\(true\);/);
  });
});

