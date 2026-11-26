import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startServer } from './helpers/server.mjs';

const ADMIN = { username: 'admin', password: 'admin123' };
const BOB   = { username: 'bob',   password: 'bob123', admin: false };
const LB_TOKEN = 'lb-user-token';
const DEFAULT_ALG = 'session_based_days_7500_session_300_contribution_3_threshold_10_limit_100_filter_True_skip_30';

// One stand-in for MusicBrainz, ListenBrainz (labs + API), TIDAL (auth + API) and Last.fm,
// each under its own path prefix, answering in the shape the real services use.
function fakeUpstream() {
  const calls = [];
  const state = { failLabs: false };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      calls.push({ path: u.pathname, query: Object.fromEntries(u.searchParams), auth: req.headers.authorization, body, ua: req.headers['user-agent'] });
      const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      const p = u.pathname;
      if (p === '/mb/ws/2/artist') {
        const name = /artist:"(.+)"/.exec(u.searchParams.get('query'))?.[1];
        const ids = { 'Artist A': 'mbid-a', 'Artist B': 'mbid-b' };
        return json(200, { artists: ids[name] ? [{ id: ids[name], name, 'sort-name': name, score: 100 }] : [] });
      }
      if (p === '/labs/similar-artists/json') {
        if (state.failLabs) return json(500, { error: 'labs down' });
        if (u.searchParams.get('artist_mbids') !== 'mbid-a') return json(200, []);
        return json(200, [
          { artist_mbid: 'mbid-b', name: 'Artist B', score: 200, reference_mbid: 'mbid-a' },
          { artist_mbid: 'mbid-x', name: 'Nobody Here', score: 100, reference_mbid: 'mbid-a' },
        ]);
      }
      if (p === '/lbapi/1/popularity/top-recordings-for-artist/mbid-a') {
        if (req.headers.authorization !== `Token ${LB_TOKEN}`) return json(401, { code: 401, error: 'token required' });
        return json(200, [
          { recording_name: 'Track Four', artist_name: 'Artist A', total_listen_count: 900 },
          { recording_name: 'Track Two', artist_name: 'Artist A', total_listen_count: 500 },
        ]);
      }
      if (p === '/tidal-auth') {
        if (req.headers.authorization !== `Basic ${Buffer.from('tid:tsecret').toString('base64')}` || body !== 'grant_type=client_credentials') return json(401, { error: 'invalid_client' });
        return json(200, { access_token: 'tidal-access', expires_in: 3600 });
      }
      if (p.startsWith('/tidal/')) {
        if (req.headers.authorization !== 'Bearer tidal-access') return json(401, { errors: [{ detail: 'no token' }] });
        if (p === '/tidal/searchResults/Artist%20A/relationships/artists') {
          return json(200, { data: [{ id: '7', type: 'artists' }, { id: '1', type: 'artists' }], included: [
            { id: '7', type: 'artists', attributes: { name: 'Artist Aa' } },
            { id: '1', type: 'artists', attributes: { name: 'Artist A' } },
          ] });
        }
        if (p === '/tidal/artists/1/relationships/similarArtists') {
          if (!u.searchParams.get('page[cursor]')) {
            return json(200, { data: [{ id: '2', type: 'artists' }], included: [{ id: '2', type: 'artists', attributes: { name: 'Artist B' } }],
              links: { self: '/artists/1/relationships/similarArtists', next: '/artists/1/relationships/similarArtists?countryCode=NL&include=similarArtists&page[cursor]=p2' } });
          }
          return json(200, { data: [{ id: '3', type: 'artists' }], included: [{ id: '3', type: 'artists', attributes: { name: 'Nobody Here' } }], links: { self: 'x' } });
        }
      }
      if (p === '/lastfm/2.0/') {
        if (u.searchParams.get('method') === 'artist.getSimilar') {
          return json(200, { similarartists: { artist: [{ name: 'Artist B', match: '0.8', mbid: '' }] } });
        }
      }
      json(404, { error: 'unknown' });
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    resolve({ server, calls, state, urls: { mb: `${base}/mb`, lbLabs: `${base}/labs`, lbApi: `${base}/lbapi`, tidalAuth: `${base}/tidal-auth`, tidalApi: `${base}/tidal`, lastfm: `${base}/lastfm` } });
  }));
}

async function login(baseUrl, { username, password }) {
  const r = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }),
  });
  return (await r.json()).token;
}

function call(baseUrl, method, route, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['x-access-token'] = token;
  return fetch(`${baseUrl}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

describe('similar-artist sources', () => {
  let up, srv, admin, bob;
  const get = (route, tok = admin) => call(srv.baseUrl, 'GET', route, tok).then(r => r.json());
  const post = (route, body, tok = admin) => call(srv.baseUrl, 'POST', route, tok, body);
  const similar = (artist, tok = bob) => get(`/api/v1/lastfm/similar-artists?artist=${encodeURIComponent(artist)}`, tok);

  before(async () => {
    up = await fakeUpstream();
    process.env.VELVET_SIMILAR_URLS = JSON.stringify(up.urls);
    srv = await startServer({ users: [ADMIN, BOB] });
    delete process.env.VELVET_SIMILAR_URLS;
    admin = await login(srv.baseUrl, ADMIN);
    bob = await login(srv.baseUrl, BOB);
  });
  after(async () => {
    await srv.stop();
    up.server.close();
  });

  it('ListenBrainz is the default and works without any Last.fm key', async () => {
    const cfg = await get('/api/v1/admin/similar-artists/config');
    assert.equal(cfg.source, 'listenbrainz');
    assert.equal(cfg.ready.listenbrainz, true);
    assert.equal(cfg.ready.lastfm, false);
    assert.equal(cfg.defaultAlgorithm, DEFAULT_ALG);
    const status = await get('/api/v1/lastfm/status', bob);
    assert.equal(status.hasApiKey, false);
    assert.equal(status.similarArtists, true);

    const r = await similar('Artist A');
    assert.deepEqual(r.displayArtists, ['Artist B']);
    assert.equal(r.variantRankMap['Artist B'], 1);
    assert.equal(r.source, 'ListenBrainz', 'every answer names the source it came from');
    const mb = up.calls.filter(c => c.path === '/mb/ws/2/artist');
    assert.equal(mb.length, 1, 'the name without an MBID in the files is looked up once at MusicBrainz');
    assert.match(mb[0].ua, /^Velvet\/\S+ \( https:\/\/github\.com\/aroundmyroom\/Velvet \)$/);
    const labs = up.calls.filter(c => c.path === '/labs/similar-artists/json');
    assert.equal(labs.length, 1);
    assert.deepEqual(labs[0].query, { artist_mbids: 'mbid-a', algorithm: DEFAULT_ALG });

    await similar('Artist A');
    assert.equal(up.calls.filter(c => c.path === '/labs/similar-artists/json').length, 1, 'a repeat is answered from storage');
  });

  it('the admin test scales scores, marks library artists and reports source errors', async () => {
    const t = await (await post('/api/v1/admin/similar-artists/test', { artist: 'Artist A' })).json();
    assert.equal(t.ok, true);
    assert.equal(t.source, 'listenbrainz');
    assert.deepEqual(t.artists.map(a => [a.name, a.score, a.inLibrary]), [['Artist B', 1, true], ['Nobody Here', 0.5, false]]);
    assert.equal(t.notFound, false);
    const unknown = await (await post('/api/v1/admin/similar-artists/test', { artist: 'Unknown Person' })).json();
    assert.deepEqual([unknown.ok, unknown.total, unknown.notFound], [true, 0, true]);

    up.state.failLabs = true;
    const bad = await (await post('/api/v1/admin/similar-artists/test', { artist: 'Artist A' })).json();
    up.state.failLabs = false;
    assert.equal(bad.ok, false);
    assert.match(bad.error, /^ListenBrainz answered 500: labs down/);

    assert.equal((await post('/api/v1/admin/similar-artists/test', { artist: 'Artist A' }, bob)).status, 403);
  });

  it('top songs for Subsonic come from ListenBrainz once a token is available', async () => {
    const sub = (action, extra = {}) => fetch(`${srv.subsonicBaseUrl}/rest/${action}?${new URLSearchParams({ u: 'bob', p: 'bob123', v: '1.16.1', c: 'velvet-test', f: 'json', ...extra })}`).then(r => r.json());
    let cfg = await get('/api/v1/admin/similar-artists/config');
    assert.equal(cfg.topTracksToken, null);
    assert.equal((await post('/api/v1/admin/similar-artists/config', { source: 'listenbrainz', lbToken: LB_TOKEN })).status, 200);
    cfg = await get('/api/v1/admin/similar-artists/config');
    assert.equal(cfg.topTracksToken, 'own');
    assert.equal(JSON.stringify(cfg).includes(LB_TOKEN), false);
    const top = (await sub('getTopSongs', { artist: 'Artist A', count: '3' }))['subsonic-response'].topSongs.song.map(s => s.title);
    assert.deepEqual(top.slice(0, 2), ['Track Four', 'Track Two']);
    assert.equal(up.calls.find(c => c.path.startsWith('/lbapi/')).auth, `Token ${LB_TOKEN}`);
  });

  it('TIDAL logs in with client credentials, picks the exact name and follows the pages', async () => {
    assert.equal((await post('/api/v1/admin/similar-artists/config', { source: 'tidal' })).status, 200);
    assert.equal((await get('/api/v1/lastfm/status', bob)).similarArtists, false, 'TIDAL without credentials cannot answer');
    assert.equal((await post('/api/v1/admin/similar-artists/config', { source: 'tidal', tidalClientId: 'tid', tidalSecret: 'tsecret', tidalCountry: 'nl' })).status, 200);
    const cfg = await get('/api/v1/admin/similar-artists/config');
    assert.deepEqual([cfg.ready.tidal, cfg.hasTidalSecret, cfg.tidalCountry, cfg.tidalClientId], [true, true, 'NL', 'tid']);
    assert.equal(JSON.stringify(cfg).includes('tsecret'), false);

    const r = await similar('Artist A');
    assert.deepEqual(r.displayArtists, ['Artist B'], 'switching source does not reuse the ListenBrainz answer');
    assert.equal(r.source, 'TIDAL');
    const t = await (await post('/api/v1/admin/similar-artists/test', { artist: 'Artist A' })).json();
    assert.deepEqual(t.artists.map(a => [a.name, a.score]), [['Artist B', 1], ['Nobody Here', 0.5]]);
    const pages = up.calls.filter(c => c.path === '/tidal/artists/1/relationships/similarArtists');
    assert.equal(pages[0].query.countryCode, 'NL');
    assert.equal(pages[1].query['page[cursor]'], 'p2');

    await post('/api/v1/admin/similar-artists/config', { source: 'tidal', tidalSecret: '' });
    assert.equal((await get('/api/v1/admin/similar-artists/config')).ready.tidal, false);
  });

  it('Last.fm needs its key, Off switches the feature off, and settings are validated', async () => {
    await post('/api/v1/admin/similar-artists/config', { source: 'lastfm' });
    assert.equal((await get('/api/v1/lastfm/status', bob)).similarArtists, false);
    const t = await (await post('/api/v1/admin/similar-artists/test', { artist: 'Artist A' })).json();
    assert.deepEqual([t.ok, t.error], [false, 'not-configured']);
    assert.equal((await post('/api/v1/admin/lastfm/config', { enabled: true, apiKey: 'k', apiSecret: 's' })).status, 200);
    assert.equal((await get('/api/v1/lastfm/status', bob)).similarArtists, true);
    const lfm = await similar('Artist A');
    assert.deepEqual([lfm.displayArtists, lfm.source], [['Artist B'], 'Last.fm']);

    await post('/api/v1/admin/similar-artists/config', { source: 'off' });
    assert.equal((await get('/api/v1/lastfm/status', bob)).similarArtists, false);
    assert.deepEqual((await similar('Artist A')).artists, []);

    assert.equal((await post('/api/v1/admin/similar-artists/config', { source: 'spotify' })).status, 400);
    assert.equal((await post('/api/v1/admin/similar-artists/config', { source: 'listenbrainz', listenbrainzAlgorithm: 'x&y=1' })).status, 400);
    assert.equal((await post('/api/v1/admin/similar-artists/config', { source: 'off' }, bob)).status, 403);

    const removed = (await (await post('/api/v1/admin/similar-artists/clear-cache', {})).json()).removed;
    assert.ok(removed > 0);
    const saved = JSON.parse(await fs.readFile(path.join(srv.tmpDir, 'config.json'), 'utf8')).similarArtists;
    assert.equal(saved.source, 'off');
    assert.equal(saved.listenbrainzToken, LB_TOKEN);
  });
});
