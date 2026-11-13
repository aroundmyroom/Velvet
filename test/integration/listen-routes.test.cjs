/**
 * The web player's listen routes (play count, Last.fm / ListenBrainz, webhooks, Wrapped) after their bodies moved
 * into functions that Velvet Rooms calls as well (src/api/room-listen.js): same answers, same DB effects.
 *
 * Run with:
 *   node --test test/integration/listen-routes.test.cjs
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

describe('listen routes', async () => {
  const { startServer } = await import('../helpers/server.mjs');
  let srv;
  const FP = 'testlib/Artist A/Album X/01 - Track One.mp3';
  const post = async (p, body) => {
    const r = await fetch(srv.baseUrl + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const playCount = async (fp) => (await post('/api/v1/db/stats/most-played', { limit: 50 })).body.find((x) => x.filepath === fp)?.metadata['play-count'];
  const history = async () => (await (await fetch(`${srv.baseUrl}/api/v1/history`)).json()).events;

  before(async () => { srv = await startServer({ waitForScan: true }); });
  after(async () => { await srv.stop(); });

  it('log-play counts a play; a URL or an unknown song does not', async () => {
    const before = (await playCount(FP)) ?? 0;
    assert.deepEqual((await post('/api/v1/db/stats/log-play', { filePath: FP })).body, { ok: true });
    assert.equal(await playCount(FP), before + 1);
    assert.deepEqual((await post('/api/v1/db/stats/log-play', { filePath: 'https://example.com/a.mp3' })).body, { ok: false });
    assert.equal((await post('/api/v1/db/stats/log-play', {})).status, 400);
  });

  it('a play counts once: log-play raises the count, the Last.fm scrobble does not; unknown songs are refused', async () => {
    const before = (await playCount(FP)) ?? 0;
    assert.deepEqual((await post('/api/v1/db/stats/log-play', { filePath: FP })).body, { ok: true });
    assert.deepEqual((await post('/api/v1/lastfm/scrobble-by-filepath', { filePath: FP })).body, {});
    assert.equal(await playCount(FP), before + 1, 'start plus scrobble is one play');
    assert.deepEqual((await post('/api/v1/lastfm/scrobble-by-filepath', { filePath: 'testlib/nope.mp3' })).body, { scrobble: false });
  });

  it('ListenBrainz and webhooks answer "not sent" when not linked or switched off', async () => {
    assert.deepEqual((await post('/api/v1/listenbrainz/playing-now', { filePath: FP })).body, { sent: false });
    assert.deepEqual((await post('/api/v1/listenbrainz/scrobble-by-filepath', { filePath: FP })).body, { scrobble: false });
    assert.deepEqual((await post('/api/v1/discord-webhook/scrobble-by-filepath', { filePath: FP })).body, { sent: false });
    assert.deepEqual((await post('/api/v1/custom-webhooks/scrobble-by-filepath', { filePath: FP, slot: 0 })).body, { sent: false });
    assert.equal((await post('/api/v1/custom-webhooks/scrobble-by-filepath', { filePath: FP, slot: 9 })).status, 400);
  });

  it('Wrapped: start (reused while not completed), pause, skip, end and stop', async () => {
    const sessionId = 'listen-routes';
    const start = await post('/api/v1/wrapped/play-start', { filePath: FP, sessionId, source: 'manual' });
    assert.equal(start.body.ok, true);
    const { eventId } = start.body;
    assert.ok(eventId > 0);
    assert.equal((await post('/api/v1/wrapped/play-start', { filePath: FP, sessionId })).body.eventId, eventId, 'an interrupted play is resumed');
    assert.deepEqual((await post('/api/v1/wrapped/play-start', { filePath: 'testlib/nope.mp3', sessionId })).body, { ok: false });
    assert.deepEqual((await post('/api/v1/wrapped/pause', { eventId })).body, { ok: true });
    assert.deepEqual((await post('/api/v1/wrapped/play-skip', { eventId, playedMs: 200 })).body, { ok: true });
    let ev = (await history()).find((e) => e.id === eventId);
    assert.equal(ev.skipped, true);
    assert.equal(ev.played_ms, 200);
    assert.deepEqual((await post('/api/v1/wrapped/play-end', { eventId, playedMs: 1000 })).body, { ok: true });
    ev = (await history()).find((e) => e.id === eventId);
    assert.equal(ev.completed, true, '1 s of a 1 s song is played to the end');
    assert.equal(ev.skipped, false);

    const again = (await post('/api/v1/wrapped/play-start', { filePath: FP, sessionId })).body.eventId;
    assert.notEqual(again, eventId, 'a completed play is not resumed');
    assert.deepEqual((await post('/api/v1/wrapped/play-stop', { eventId: again, playedMs: 100 })).body, { ok: true });
    ev = (await history()).find((e) => e.id === again);
    assert.equal(ev.completed, false);
    assert.equal(ev.skipped, false);
    assert.equal(ev.played_ms, 100);
  });
});
