// Shared player helpers from webapp/app.js, evaluated against stubs.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadFns, makeApiStub, tick } from './helpers/fix-player-app.mjs';

const memStorage = () => {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), _m: m };
};

describe('queue sync payload (P012)', () => {
  const setup = (n, idx, extra = {}) => {
    const { api, calls } = makeApiStub();
    const ctx = loadFns(['_QUEUE_COMPACT_FIELDS', '_compactQueueSong', '_compactQueueList', '_QUEUE_SYNC_MAX', '_buildQueueSyncPayload', '_postQueueSync', '_syncQueueToDbNow'], {
      S: { token: 'x', username: 'u', queue: Array.from({ length: n }, (_, i) => ({ filepath: `m/${i}.mp3`, title: `t${i}`, junk: { big: true } })), idx },
      audioEl: { currentTime: 12, paused: true },
      _browserId: 'b1', _bootRestoring: false, _syncQueueTimer: null,
      api, localStorage: memStorage(), clearTimeout, ...extra,
    });
    return { ctx, calls };
  };

  it('caps at 5000 compact songs from 50 before the current track', () => {
    assert.equal(setup(6000, 100).ctx._buildQueueSyncPayload(false).queue.length, 5000);
    const { ctx } = setup(6000, 3000);
    const p = ctx._buildQueueSyncPayload(false);
    assert.equal(p.queue.length, 3050);
    assert.equal(p.idx, 50);
    assert.equal(p.queue[50].filepath, 'm/3000.mp3');
    assert.equal(p.currentFilepath, 'm/3000.mp3');
    assert.equal(p.queue[0].junk, undefined);
    assert.equal(p.playing, false);
    assert.equal(p.browserId, 'b1');
  });

  it('sends nothing during boot restore', () => {
    const { ctx, calls } = setup(10, 2, { _bootRestoring: true });
    ctx._syncQueueToDbNow(false);
    assert.equal(calls.length, 0);
  });

  it('posts the capped payload when not restoring', () => {
    const { ctx, calls } = setup(10, 2);
    ctx._syncQueueToDbNow(false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, 'api/v1/user/settings');
    assert.equal(calls[0].body.queue.queue.length, 10);
    assert.equal(calls[0].body.queue.playing, false);
  });
});

describe('album ↔ artist matching (P016)', () => {
  const ctx = loadFns(['_nameContainsArtist', '_matchSeriesIds', '_albumMatchesArtist'], {});
  const none = new Set();

  it('matches by artist tag when the folder sits under a genre folder', () => {
    assert.equal(ctx._albumMatchesArtist({ path: 'Music/Disco/Cerrone Discography/X', sourceVpath: 'Music', rawArtistTags: ['Cerrone'] }, ['Cerrone'], none), true);
  });

  it('uses a prefix-separator match on the first folder', () => {
    assert.equal(ctx._albumMatchesArtist({ path: 'Music/Cerrone - Love in C Minor', sourceVpath: 'Music' }, ['Cerrone'], none), true);
    assert.equal(ctx._albumMatchesArtist({ path: 'Music/Cerrone Discography/X', sourceVpath: 'Music' }, ['Cerrone'], none), false);
  });

  it('matches whole-word series names', () => {
    const ids = ctx._matchSeriesIds([{ id: 1, displayName: 'Cerrone Discography' }, { id: 2, displayName: 'Black Sabbath' }], ['Cerrone', 'ABBA']);
    assert.deepEqual(Array.from(ids).map(Number), [1]);
    assert.equal(ctx._albumMatchesArtist({ seriesId: 1, path: 'Music/x' }, ['Cerrone'], ids), true);
  });
});

function wrappedCtx(extra = {}) {
  const { api, calls } = makeApiStub(() => ({ eventId: 99 }));
  const traces = new Map([['a.mp3', { reason: 'dj' }]]);
  const ctx = loadFns(['_wrappedClose', '_reportTrackStart'], {
    api, audioEl: { currentTime: 30 },
    _wrappedEventId: null, _wrappedRadioEventId: null, _wrappedPodcastEventId: null,
    _wrappedRadioStartMs: Date.now() - 5000, _wrappedTrackStartOffset: 10, _wrappedEndedNaturally: true,
    _wrappedSessionId: 's1', _wrappedSource: () => 'autodj',
    _djTakeTrace: fp => { const tr = traces.get(fp); traces.delete(fp); return tr; },
    ...extra,
  });
  return { ctx, calls };
}

describe('Wrapped session close (P057)', () => {
  it('closes only the requested kinds', () => {
    const { ctx, calls } = wrappedCtx({ _wrappedEventId: 1, _wrappedRadioEventId: 2, _wrappedPodcastEventId: 3 });
    ctx._wrappedClose({ music: false });
    assert.deepEqual(calls.map(c => c.path), ['api/v1/wrapped/radio-stop', 'api/v1/wrapped/podcast-end']);
    assert.equal(ctx._wrappedEventId, 1);
    assert.equal(ctx._wrappedRadioEventId, null);
    assert.equal(ctx._wrappedPodcastEventId, null);
    assert.equal(calls[1].body.completed, false);
  });

  it('subtracts the resume offset for music', () => {
    const { ctx, calls } = wrappedCtx({ _wrappedEventId: 1 });
    ctx._wrappedClose();
    assert.equal(calls[0].body.playedMs, 20000);
  });
});

describe('track-start report (P023)', () => {
  it('sends the Auto-DJ trace with play-start', async () => {
    const { ctx, calls } = wrappedCtx();
    ctx._reportTrackStart({ filepath: 'a.mp3' });
    const start = calls.find(c => c.path === 'api/v1/wrapped/play-start');
    assert.deepEqual(start.body.dj, { reason: 'dj' });
    assert.ok(calls.some(c => c.path === 'api/v1/db/stats/log-play'));
    await tick();
    assert.equal(ctx._wrappedEventId, 99);
  });

  it('skips log-play when a room hands the song back', () => {
    const { ctx, calls } = wrappedCtx();
    ctx._reportTrackStart({ filepath: 'b.mp3' }, 1234);
    assert.ok(!calls.some(c => c.path === 'api/v1/db/stats/log-play'));
  });

  it('starts podcast tracking for podcast episodes', async () => {
    const { ctx, calls } = wrappedCtx({ _wrappedEventId: 1 });
    ctx._reportTrackStart({ filepath: 'p.mp3', isPodcast: true, _episodeId: 5, _feedId: 6 });
    assert.ok(calls.some(c => c.path === 'api/v1/wrapped/play-stop'));
    assert.deepEqual({ ...calls.find(c => c.path === 'api/v1/wrapped/podcast-start').body }, { episodeId: 5, feedId: 6, sessionId: 's1' });
    await tick();
    assert.equal(ctx._wrappedPodcastEventId, 99);
  });
});

describe('next index for crossfade / gapless / Next (P029)', () => {
  const mk = (s) => loadFns(['_djDrivesQueue', '_nextIndexAuto'], {
    S: { queue: Array.from({ length: 10 }, (_, i) => ({ filepath: `${i}.mp3` })), idx: 4, shuffle: false, repeat: 'none', autoDJ: false, ...s },
    _isMusicSong: x => !!x && !x.isRadio,
    Math,
  });
  it('ignores shuffle while Auto-DJ drives', () => assert.equal(mk({ shuffle: true, autoDJ: true })._nextIndexAuto(), 5));
  it('lets Auto-DJ beat repeat-all at the end', () => assert.equal(mk({ idx: 9, repeat: 'all', autoDJ: true })._nextIndexAuto(), -1));
  it('wraps on repeat-all without Auto-DJ', () => assert.equal(mk({ idx: 9, repeat: 'all' })._nextIndexAuto(), 0));
  it('repeats the same track on repeat-one', () => assert.equal(mk({ repeat: 'one' })._nextIndexAuto(), 4));
  it('stops at the end with nothing else on', () => assert.equal(mk({ idx: 9 })._nextIndexAuto(), -1));
});

describe('Auto-DJ memory reset (P056)', () => {
  it('clears the stored ignore list too', () => {
    const localStorage = memStorage();
    let synced = 0;
    const ctx = loadFns(['_djKey', '_resetDjMemory'], {
      S: { username: 'u', djIgnore: ['x'], djArtistHistory: ['y'] }, localStorage,
      _djGenreHistory: ['g'], _djFamilyHistory: ['f'], _syncPrefs: () => synced++,
    });
    for (const k of ['ignore', 'artist_history', 'genre_hist']) localStorage.setItem(ctx._djKey(k), '[1]');
    ctx._resetDjMemory();
    assert.equal(localStorage.getItem(ctx._djKey('ignore')), null);
    assert.equal(localStorage._m.size, 0);
    assert.deepEqual([ctx.S.djIgnore.length, ctx.S.djArtistHistory.length, ctx._djGenreHistory.length], [0, 0, 0]);
    assert.equal(synced, 1);
  });
});

describe('add to playlist (P058)', () => {
  it('reports partial failure with a retry for the failed songs only', async () => {
    let n = 0;
    const { api, calls } = makeApiStub(() => {
      n++;
      if (n === 2) throw new Error('nope');
      return {};
    });
    const toasts = [], errors = [];
    const ctx = loadFns(['_addSongsToPlaylist'], {
      api, t: (k, p) => `${k}${p ? JSON.stringify(p) : ''}`,
      toast: m => toasts.push(m), toastError: (m, o) => errors.push({ m, o }),
    });
    await ctx._addSongsToPlaylist([{ filepath: 'a' }, { filepath: 'b' }, { filepath: 'c' }], 'Mix');
    assert.deepEqual(calls.map(c => c.body.song), ['a', 'b', 'c']);
    assert.equal(toasts.length, 0);
    assert.equal(errors.length, 1);
    assert.match(errors[0].m, /addedSomeToPlaylist.*"added":2,"total":3/);
    await errors[0].o.action.onClick();
    assert.equal(calls.at(-1).body.song, 'b');
    assert.match(toasts[0], /addedToPlaylist/);
  });
});

describe('metadata helpers (P060) and time format (P071)', () => {
  const ctx = loadFns(['fmt', '_fmtDuration', '_fmtRg', '_metaValueHtml'], { S: { rgPreamp: 0 }, esc: s => s });
  it('formats ReplayGain', () => {
    assert.equal(ctx._fmtRg({ replaygain: -6.5 }), '-6.50 dB');
    assert.equal(ctx._fmtRg({ rg: { trackGain: 1.234 } }), '+1.23 dB');
    assert.equal(ctx._fmtRg({}), null);
  });
  it('renders a dim dash for missing values', () => {
    assert.equal(ctx._metaValueHtml(null, 'np-meta-v'), '<span class="np-meta-v dim">—</span>');
  });
  it('formats durations', () => {
    assert.equal(ctx.fmt(3725), '1:02:05');
    assert.equal(ctx.fmt(65), '1:05');
    assert.equal(ctx._fmtDuration(0), '');
    assert.equal(ctx._fmtDuration(4500), '1:15:00');
  });
});

describe('smart-playlist builder reset (P069)', () => {
  it('uses the full defaults', () => {
    const ctx = loadFns(['_splDefaultFilters', '_splResetBuilder'], { _splEditId: 4, _splEditName: 'x', _splFilters: {}, _splSort: 'title', _splLimit: 5 });
    ctx._splResetBuilder();
    assert.deepEqual(JSON.parse(JSON.stringify(ctx._splFilters)), JSON.parse(JSON.stringify(ctx._splDefaultFilters())));
    assert.deepEqual([ctx._splEditId, ctx._splEditName, ctx._splSort, ctx._splLimit], [null, null, 'random', 100]);
  });
});

describe('seek preview (P075)', () => {
  it('uses the room track length in room mode', () => {
    const el = () => {
      const listeners = {};
      return {
        listeners, style: {}, children: [], textContent: '',
        classList: { set: new Set(), add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); }, toggle() {} },
        addEventListener(ev, fn) { listeners[ev] = fn; },
        appendChild(c) { this.children.push(c); },
        getBoundingClientRect: () => ({ left: 0, width: 200 }),
      };
    };
    const container = el();
    const track = { ...el(), closest: () => container };
    const ctx = loadFns(['fmt', '_playerDurSec', '_roomDurSec', '_initSeekPreview'], {
      S: { queue: [{}], idx: 0 }, _room: { durationMs: 200000 },
      audioEl: { duration: NaN },
      document: { getElementById: () => track, createElement: () => el(), addEventListener() {} },
    });
    ctx._initSeekPreview('prog-track', '.player-progress');
    container.listeners.mousemove({ clientX: 100, target: { closest: () => null } });
    const bubble = container.children[1];
    assert.equal(bubble.textContent, '1:40');
  });
});

describe('feature flags after login (P024)', () => {
  const fixtures = {
    'api/v1/lastfm/status': { serverEnabled: true, hasApiKey: true, linkedUser: 'me' },
    'api/v1/listenbrainz/status': { serverEnabled: true, linked: true },
    'api/v1/discord-webhook/status': { serverEnabled: true, webhookEnabled: true },
    'api/v1/custom-webhooks/status': { webhooks: [{ serverEnabled: true, userEnabled: false }, { serverEnabled: false }] },
    'api/v1/radio/enabled': { enabled: true },
  };
  const run = async (opts, S = {}) => {
    const { api } = makeApiStub((m, p) => { if (p.startsWith('api/v1/admin/')) { const e = new Error('Forbidden'); e.status = 403; throw e; } return fixtures[p]; });
    const ctx = loadFns(['_FEATURE_STATUS_ROUTES', '_uKey', '_loadFeatureFlags'], { api, S: { username: 'u', djSimilar: false, ...S }, localStorage: memStorage() });
    await ctx._loadFeatureFlags(opts);
    return JSON.parse(JSON.stringify(ctx.S));
  };

  it('sets every flag from the status calls', async () => {
    const S = await run();
    assert.equal(S.isAdmin, false);
    assert.equal(S.discogsEnabled, false);
    assert.equal(S.lastfmLinked, true);
    assert.equal(S.listenbrainzLinked, true);
    assert.equal(S.discordWebhookEnabled, true);
    assert.deepEqual([...S.customWebhooksEnabled], [false, false]);
    assert.equal(S.customWebhooksServerEnabled, true);
    assert.equal(S.radioEnabled, true);
    assert.equal(S.feedsEnabled, true);
  });

  it('keeps flags on a failed status call during a background refresh', async () => {
    const { api } = makeApiStub(() => { throw new Error('offline'); });
    const ctx = loadFns(['_FEATURE_STATUS_ROUTES', '_uKey', '_loadFeatureFlags'], { api, S: { username: 'u', isAdmin: false, radioEnabled: true, lastfmHasApiKey: false, djSimilar: true }, localStorage: memStorage() });
    await ctx._loadFeatureFlags({ probeAdmin: false, keepOnError: true });
    assert.equal(ctx.S.radioEnabled, true);
    assert.equal(ctx.S.djSimilar, true);
  });
});

describe('Now Playing cover embed (P030)', () => {
  const run = async (body, result) => {
    const reloads = [];
    const audioEl = { paused: false, currentTime: 90, pause() { this.paused = true; }, play() { this.paused = false; return Promise.resolve(); } };
    const { api, calls } = makeApiStub(() => result);
    const ctx = loadFns(['_npEmbedArt'], {
      S: { queue: [{ filepath: 'Music/a.flac' }], idx: 0 }, audioEl, api,
      document: { getElementById: () => null },
      t: k => k, esc: s => s, toast() {}, clearTimeout, _netRecoveryTimer: null,
      _embedProgressHtml: () => '', _syncQueueToDb() {}, renderNPModal() {}, _npOfferFolderCover() {}, refreshQueueUI() {},
      Player: { updateBar() {} },
      _reloadCurrentSongAfterArtEmbed: (...a) => reloads.push(a),
    });
    await ctx._npEmbedArt('Music/a.flac', body, {});
    return { reloads, calls, audioEl };
  };

  for (const body of [{ coverUrl: 'https://x/y.jpg' }, { releaseId: 7 }]) {
    it(`resumes at the same position (${Object.keys(body)[0]})`, async () => {
      const { reloads, calls } = await run(body, { ok: true, aaFile: 'n.jpg', cacheOnly: false });
      assert.deepEqual({ ...calls[0].body }, { filepath: 'Music/a.flac', ...body });
      assert.deepEqual(reloads, [['Music/a.flac', true, 90]]);
    });
  }

  it('does not reload a cache-only file', async () => {
    const { reloads, audioEl } = await run({ coverUrl: 'https://x/y.jpg' }, { ok: true, cacheOnly: true });
    assert.equal(reloads.length, 0);
    assert.equal(audioEl.paused, false);
  });
});
