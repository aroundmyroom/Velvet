/**
 * AI DJ (preview): a listener's request becomes a queue. Claude is replaced
 * by a stub file (VELVET_AI_STUB), so nothing here reaches the network or
 * needs a key. Checks that the feature is invisible until the admin switches
 * it on, that a set never exceeds the cap or the library, that the brief is
 * validated, that an unusable model answer falls back to the rule reader, and
 * that the rate limit holds.
 *
 * Run with:
 *   node --test test/integration/ai-queue.test.cjs
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const FFMPEG = ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg'].find(p => fs.existsSync(p)) ?? 'ffmpeg';

function makeTrack(root, rel, tags) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const args = ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=22050:cl=mono', '-t', '0.3'];
  for (const [k, v] of Object.entries(tags)) args.push('-metadata', `${k}=${v}`);
  args.push('-c:a', 'libmp3lame', '-b:a', '32k', p);
  execFileSync(FFMPEG, args);
}

function buildLibrary() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'velvet-aidj-'));
  for (let i = 1; i <= 16; i++) {
    makeTrack(root, `Disco/${i} Disco.mp3`, { artist: `Disco Act ${i % 5}`, title: `Disco ${i}`, genre: 'disco', date: String(1976 + (i % 8)) });
    makeTrack(root, `House/${i} House.mp3`, { artist: `House Act ${i % 6}`, title: `House ${i}`, genre: 'house', date: String(1990 + (i % 8)) });
  }
  // a band usually written as an acronym, with one long 12-inch and short singles
  makeTrack(root, 'FGTH/Relax (Extended Sex Mix).mp3', { artist: 'Frankie Goes To Hollywood', title: 'Relax (Extended Sex Mix)', genre: 'synth-pop', date: '1983' });
  makeTrack(root, 'FGTH/Relax (7 inch).mp3', { artist: 'Frankie Goes To Hollywood', title: 'Relax (7 inch)', genre: 'synth-pop', date: '1983' });
  makeTrack(root, 'FGTH/Two Tribes (Radio Edit).mp3', { artist: 'Frankie Goes To Hollywood', title: 'Two Tribes (Radio Edit)', genre: 'synth-pop', date: '1984' });
  // one artist, three albums in different years plus a remix compilation
  const albums = [['Where Are You Now', 1983], ['Brigade Mondaine', 1980], ['Cerrone 9', 1985], ['The Remixes', 2009]];
  for (const [album, year] of albums) {
    for (let t = 1; t <= 6; t++) makeTrack(root, `Cerrone/${album}/${t} ${album} ${t}.mp3`, { artist: 'Cerrone', album_artist: 'Cerrone', album, title: `${album} track ${t}`, track: String(t), genre: 'disco', date: String(year) });
  }
  // a chart: the position is in the file name, split over hundred-folders, with
  // a "new entries" folder re-using position 3 and genre tags all over the place
  for (let p = 1; p <= 40; p++) {
    makeTrack(root, `House Top 1000/${p <= 20 ? '001-020' : '021-040'}/${String(p).padStart(3, '0')} - Chart Act ${p} - Chart ${p}.mp3`, { artist: `Chart Act ${p}`, title: `Chart ${p}`, genre: p % 3 ? 'techno' : 'trance', date: String(1990 + (p % 10)) });
  }
  makeTrack(root, 'House Top 1000/2021 - NW/003 - New Entry - Chart 3 (2021).mp3', { artist: 'New Entry', title: 'Chart 3 (2021)', genre: 'techno', date: '2021' });
  // a yearly mix series: "name + year" is a title, with several versions of a year
  for (const y of [1983, 1984, 1985, 1986]) makeTrack(root, `Grandmix/Grandmix ${y}.mp3`, { artist: 'Ben Liebrand', title: `Grandmix ${y}`, genre: 'megamix', date: String(y) });
  makeTrack(root, 'Grandmix/Mastertapes/Grandmix 1983 (Mastertape).mp3', { artist: 'Ben Liebrand', title: 'Grandmix 1983 (Mastertape)', genre: 'megamix', date: '2009' });
  makeTrack(root, 'Grandmix/538/Ben Liebrand - Grandmix 1983 (Radio 538 FM Recording).mp3', { title: 'Ben Liebrand - Grandmix 1983 (Radio 538 FM Recording)', genre: 'megamix' });
  return root;
}

const BRIEF = {
  title: 'Disco classics', summary: 'Late-seventies disco.', songs: 50, minutes: null, genres: ['Disco'], excludeGenres: [], families: [],
  yearFrom: 1976, yearTo: 1983, bpmFrom: null, bpmTo: null, energy: 'build', artists: [], artistMode: 'feature', excludeArtists: [],
  folders: [], keywords: [], favourites: false, discovery: false, minRating: null, clarification: null,
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

describe('AI DJ queue builder', async () => {
  const { startServer } = await import('../helpers/server.mjs');
  let srv, root, stubPath;
  const post = (p, body) => fetch(srv.baseUrl + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const get = p => fetch(srv.baseUrl + p);
  const setStub = obj => fs.writeFileSync(stubPath, JSON.stringify(obj));

  before(async () => {
    root = buildLibrary();
    stubPath = path.join(root, 'stub.json');
    setStub({ 'queue-brief': BRIEF });
    process.env.VELVET_AI_STUB = stubPath;
    srv = await startServer({ extraFolders: { lib: root }, extraConfig: { aiAssist: { enabled: true, queueBuilder: true, maxQueueSongs: 10 } }, waitForScan: true });
  });
  after(async () => {
    delete process.env.VELVET_AI_STUB;
    await srv.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reports the switch and the cap to the player', async () => {
    const r = await get('/api/v1/ai/status');
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { enabled: true, maxSongs: 10, families: ['electronic', 'disco', 'soft', 'ambient', 'hard', 'other'] });
  });

  it('turns a request into a brief and a brief into a capped, in-scope set', async () => {
    const b = await post('/api/v1/ai/queue/brief', { text: 'late seventies disco, fifty songs', ignoreVPaths: ['testlib'] });
    assert.equal(b.status, 200);
    const { brief, source } = await b.json();
    assert.equal(source, 'claude');
    assert.equal(brief.title, 'Disco classics');
    assert.equal(brief.songs, 50);

    const r = await post('/api/v1/ai/queue/build', { brief, ignoreVPaths: ['testlib'] });
    assert.equal(r.status, 200);
    const out = await r.json();
    assert.equal(out.songs.length, 10, 'capped by the admin setting');
    assert.ok(out.notes.some(n => n.code === 'cappedByAdmin'));
    assert.ok(out.songs.every(s => String(s.metadata.genre).toLowerCase() === 'disco'), 'only the asked genre');
    assert.ok(out.songs.every(s => s.metadata.year >= 1976 && s.metadata.year <= 1983), 'only the asked era');
    assert.deepEqual(out.resolved.genres, ['Disco']);
    assert.equal(new Set(out.songs.map(s => s.filepath)).size, 10, 'no duplicates');
    for (let i = 1; i < out.songs.length; i++) assert.notEqual(out.songs[i].metadata.artist, out.songs[i - 1].metadata.artist, 'no artist back-to-back');
  });

  it('never returns more than the library holds and says what it relaxed', async () => {
    await sleep(1100);
    const r = await post('/api/v1/ai/queue/build', { brief: { ...BRIEF, songs: 9, genres: ['House'], yearFrom: 1990, yearTo: 1991 }, ignoreVPaths: ['testlib'] });
    assert.equal(r.status, 200);
    const out = await r.json();
    assert.ok(out.songs.length <= 9);
    assert.ok(out.songs.length >= 8, `got ${out.songs.length}`);
    assert.ok(out.songs.every(s => s.filepath.includes('/House/')), 'genre kept while only the years were relaxed');
    assert.ok(out.notes.some(n => n.code === 'yearsWidened' || n.code === 'unknownYearIncluded'));
  });

  it('reports what it could not find and rejects what is not a brief', async () => {
    await sleep(1100);
    const r = await post('/api/v1/ai/queue/build', { brief: { ...BRIEF, songs: 5, genres: ['Zouk'], artists: ['Nobody Here'] }, ignoreVPaths: ['testlib'] });
    assert.equal(r.status, 200);
    const out = await r.json();
    assert.ok(out.notes.some(n => n.code === 'genreUnknown' && n.name === 'Zouk'));
    assert.ok(out.notes.some(n => n.code === 'artistUnknown' && n.name === 'Nobody Here'));
    assert.equal(out.songs.length, 5, 'still a set, from the whole scope');

    await sleep(1100);
    const bad = await post('/api/v1/ai/queue/build', { brief: { ...BRIEF, energy: 'explode' }, ignoreVPaths: ['testlib'] });
    assert.equal(bad.status, 400);
  });

  it('reads the request with rules when the model answer is unusable', async () => {
    setStub({ 'queue-brief': { energy: 'explode' } });
    await sleep(3100);
    const b = await post('/api/v1/ai/queue/brief', { text: 'house from the early 90s, 6 songs, no Disco Act 1', ignoreVPaths: ['testlib'] });
    assert.equal(b.status, 200);
    const { brief, source } = await b.json();
    assert.equal(source, 'rules');
    assert.deepEqual(brief.genres, ['House']);
    assert.deepEqual([brief.yearFrom, brief.yearTo], [1990, 1993]);
    assert.equal(brief.songs, 6);
    setStub({ 'queue-brief': BRIEF });
  });

  it('plays one album as the album: only its tracks, in order', async () => {
    await sleep(1100);
    const r = await post('/api/v1/ai/queue/build', { brief: { ...BRIEF, songs: null, genres: [], yearFrom: 1984, yearTo: 1986, artists: ['Cerrone'], artistMode: 'only', albumMode: 'oneAlbum' }, ignoreVPaths: ['testlib'] });
    assert.equal(r.status, 200);
    const out = await r.json();
    assert.equal(out.songs.length, 6);
    assert.ok(out.songs.every(s => s.metadata.album === 'Cerrone 9'), out.songs.map(s => s.metadata.album).join(','));
    assert.deepEqual(out.songs.map(s => s.metadata.track), [1, 2, 3, 4, 5, 6], 'track order, not DJ order');
    const note = out.notes.find(n => n.code === 'albumPicked');
    assert.equal(note.album, 'Cerrone 9');
    assert.equal(note.year, 1985);
    assert.equal(note.candidates, 4);
    assert.deepEqual(out.resolved.albums, ['Cerrone — Cerrone 9 (1985)']);
  });

  it('another take means another album, and a named album is played whole', async () => {
    await sleep(1100);
    let r = await post('/api/v1/ai/queue/build', { brief: { ...BRIEF, songs: null, genres: [], yearFrom: 1984, yearTo: 1986, artists: ['Cerrone'], albumMode: 'oneAlbum', excludeAlbums: ['Cerrone 9'] }, ignoreVPaths: ['testlib'] });
    let out = await r.json();
    assert.equal(out.notes.find(n => n.code === 'albumPicked').album, 'Where Are You Now', 'closest in years after the excluded one; the remix compilation stays behind');
    await sleep(1100);
    r = await post('/api/v1/ai/queue/build', { brief: { ...BRIEF, songs: null, genres: [], artists: ['Cerrone'], albums: ['brigade mondaine'], albumMode: 'wholeAlbums' }, ignoreVPaths: ['testlib'] });
    out = await r.json();
    assert.equal(out.songs.length, 6);
    assert.ok(out.songs.every(s => s.metadata.album === 'Brigade Mondaine'));
  });

  it('resolves an acronym, a named title, a version wish and a song-length wish', async () => {
    await sleep(1100);
    // the scanner cannot know a 0.3 s test file is long, so the length wish is checked on the brief, the rest on the set
    let r = await post('/api/v1/ai/queue/build', { brief: { ...BRIEF, songs: 1, genres: [], yearFrom: null, yearTo: null, artists: ['FGTH'], artistMode: 'only', release: '12inch' }, ignoreVPaths: ['testlib'] });
    assert.equal(r.status, 200);
    let out = await r.json();
    assert.deepEqual(out.resolved.artists, ['FGTH']);
    assert.equal(out.songs.length, 1);
    assert.equal(out.songs[0]?.metadata.title, 'Relax (Extended Sex Mix)', 'the only extended version of that band: ' + JSON.stringify({ n: out.songs.length, titles: out.songs.map(s => s.metadata.title), notes: out.notes, stats: out.stats }));
    assert.ok(!out.notes.some(n => n.code === 'artistUnknown'));

    await sleep(1100);
    r = await post('/api/v1/ai/queue/build', { brief: { ...BRIEF, songs: 1, genres: [], yearFrom: null, yearTo: null, artists: ['Frankie Goes To Hollywood'], artistMode: 'only', titles: ['two tribes'] }, ignoreVPaths: ['testlib'] });
    out = await r.json();
    assert.equal(out.songs[0].metadata.title, 'Two Tribes (Radio Edit)');

    await sleep(1100);
    r = await post('/api/v1/ai/queue/build', { brief: { ...BRIEF, songs: 1, genres: [], yearFrom: null, yearTo: null, artists: ['Frankie Goes To Hollywood'], artistMode: 'only', minSeconds: 600 }, ignoreVPaths: ['testlib'] });
    out = await r.json();
    assert.equal(out.songs.length, 0, 'nothing that long exists: the length wish is never relaxed');
    assert.ok(out.notes.some(n => n.code === 'emptyInSelection'), 'a collection is switched off in this scope: ' + JSON.stringify(out.notes));
  });

  it('"the most played disco song" is the most played disco song, from the statistics', async () => {
    // play two disco songs a few times, one of them most
    const all = await (await post('/api/v1/db/random-songs', { returnAll: true, ignoreVPaths: ['testlib'] })).json();
    const disco = all.songs.filter(s => s.filepath.includes('/Disco/')).slice(0, 2);
    for (let i = 0; i < 3; i++) await post('/api/v1/db/stats/log-play', { filePath: disco[0].filepath });
    await post('/api/v1/db/stats/log-play', { filePath: disco[1].filepath });
    await sleep(1100);
    let r = await post('/api/v1/ai/queue/build', { brief: { ...BRIEF, songs: 1, genres: ['Disco'], yearFrom: null, yearTo: null, ranking: 'mostPlayed' }, ignoreVPaths: ['testlib'] });
    assert.equal(r.status, 200);
    let out = await r.json();
    assert.equal(out.songs.length, 1);
    assert.equal(out.songs[0].filepath, disco[0].filepath, 'the one played three times');
    assert.equal(out.songs[0].metadata['play-count'], 3);
    await sleep(1100);
    r = await post('/api/v1/ai/queue/build', { brief: { ...BRIEF, songs: 10, genres: [], yearFrom: null, yearTo: null, ranking: 'mostPlayed' }, ignoreVPaths: ['testlib'] });
    out = await r.json();
    assert.deepEqual(out.songs.map(s => s.filepath), [disco[0].filepath, disco[1].filepath], 'only songs that were ever played, most played first');
    assert.ok(out.notes.some(n => n.code === 'cappedByLibrary'));
    await sleep(1100);
    r = await post('/api/v1/ai/queue/build', { brief: { ...BRIEF, songs: 3, genres: ['House'], yearFrom: null, yearTo: null, ranking: 'mostPlayed' }, ignoreVPaths: ['testlib'] });
    out = await r.json();
    assert.equal(out.songs.length, 0, 'no house was ever played: nothing is invented');
    assert.ok(out.notes.some(n => n.code === 'rankingEmpty'));
  });

  it('plays from a playlist, respects never-played / played-before, and one version per song', async () => {
    const all = await (await post('/api/v1/db/random-songs', { returnAll: true, ignoreVPaths: ['testlib'] })).json();
    const house = all.songs.filter(s => s.filepath.includes('/House/')).slice(0, 4);
    let r = await post('/api/v1/playlist/save', { title: 'Sunday', songs: house.map(s => s.filepath) });
    assert.equal(r.status, 200, await r.text());
    await sleep(1100);
    r = await post('/api/v1/ai/queue/build', { brief: { ...BRIEF, songs: 10, genres: [], yearFrom: null, yearTo: null, playlists: ['sunday'] }, ignoreVPaths: ['testlib'] });
    let out = await r.json();
    assert.equal(out.songs.length, 4);
    assert.deepEqual(new Set(out.songs.map(s => s.filepath)), new Set(house.map(s => s.filepath)));
    assert.ok(out.notes.some(n => n.code === 'playlistUsed' && n.name === 'Sunday' && n.songs === 4));
    assert.deepEqual(out.resolved.playlists, ['Sunday']);

    await sleep(1100);
    r = await post('/api/v1/ai/queue/build', { brief: { ...BRIEF, songs: 50, genres: ['Disco'], yearFrom: null, yearTo: null, played: 'played' }, ignoreVPaths: ['testlib'] });
    out = await r.json();
    assert.equal(out.songs.length, 2, 'exactly the two disco songs logged earlier');
    await sleep(1100);
    r = await post('/api/v1/ai/queue/build', { brief: { ...BRIEF, songs: 3, genres: ['Disco'], yearFrom: null, yearTo: null, played: 'never' }, ignoreVPaths: ['testlib'] });
    out = await r.json();
    assert.ok(out.songs.every(s => !s.metadata['play-count']));

    await sleep(1100);
    r = await post('/api/v1/ai/queue/build', { brief: { ...BRIEF, songs: 5, genres: [], yearFrom: null, yearTo: null, artists: ['Frankie Goes To Hollywood'], artistMode: 'only' }, ignoreVPaths: ['testlib'] });
    out = await r.json();
    assert.equal(out.songs.length, 2, 'Relax once (not the 7-inch and the extended), plus Two Tribes: ' + out.songs.map(s => s.metadata.title).join(' / '));
    await sleep(1100);
    r = await post('/api/v1/ai/queue/build', { brief: { ...BRIEF, songs: 5, genres: [], yearFrom: null, yearTo: null, artists: ['Frankie Goes To Hollywood'], artistMode: 'only', allVersions: true }, ignoreVPaths: ['testlib'] });
    out = await r.json();
    assert.equal(out.songs.length, 3, 'every version when asked');
  });

  it('"the top 10 of the House Top 1000" is positions 1–10 of that chart, from the file names', async () => {
    await sleep(1100);
    let r = await post('/api/v1/ai/queue/build', { brief: { ...BRIEF, songs: null, genres: ['Disco'], yearFrom: 1976, yearTo: 1979, chart: 'House Top 1000', chartFrom: 1, chartTo: 10 }, ignoreVPaths: ['testlib'] });
    assert.equal(r.status, 200);
    let out = await r.json();
    assert.deepEqual(out.songs.map(s => s.metadata.title), Array.from({ length: 10 }, (_, i) => `Chart ${i + 1}`), 'chart order, genre and era of the request ignored, position 3 once (from the numbered range)');
    assert.ok(out.songs.every(s => !s.filepath.includes('/2021 - NW/')));
    assert.ok(out.notes.some(n => n.code === 'chartPicked' && n.from === 1 && n.to === 10 && n.found === 10));
    assert.equal(out.resolved.chart, 'lib/House Top 1000');

    await sleep(1100);
    r = await post('/api/v1/ai/queue/build', { brief: { ...BRIEF, songs: null, genres: [], yearFrom: null, yearTo: null, chart: 'lib/House Top 1000', chartFrom: 36, chartTo: 40, order: 'countdown' }, ignoreVPaths: ['testlib'] });
    out = await r.json();
    assert.deepEqual(out.songs.map(s => s.metadata.title), ['Chart 40', 'Chart 39', 'Chart 38', 'Chart 37', 'Chart 36']);

    await sleep(1100);
    r = await post('/api/v1/ai/queue/build', { brief: { ...BRIEF, songs: null, genres: [], yearFrom: null, yearTo: null, chart: 'lib/House Top 1000', chartFrom: null, chartTo: null }, ignoreVPaths: ['testlib'] });
    out = await r.json();
    assert.equal(out.songs.length, 10, 'the whole chart, capped by the admin limit');
    assert.ok(out.notes.some(n => n.code === 'cappedByAdmin'));

    await sleep(1100);
    r = await post('/api/v1/ai/queue/build', { brief: { ...BRIEF, songs: 5, genres: [], yearFrom: null, yearTo: null, chart: 'Billboard Hot 100' }, ignoreVPaths: ['testlib'] });
    out = await r.json();
    assert.ok(out.notes.some(n => n.code === 'chartUnknown' && n.name === 'Billboard Hot 100'));
    assert.equal(out.songs.length, 5, 'an unknown chart falls back to a normal set');

    // the rule-based reader knows the chart too
    await sleep(3100);
    setStub({ 'queue-brief': { energy: 'explode' } });
    r = await post('/api/v1/ai/queue/brief', { text: 'geef me de top 10 van de house top 1000', ignoreVPaths: ['testlib'] });
    out = await r.json();
    assert.equal(out.source, 'rules');
    assert.equal(out.brief.chart, 'lib/House Top 1000');
    assert.deepEqual([out.brief.chartFrom, out.brief.chartTo], [1, 10]);
    assert.deepEqual(out.brief.genres, []);
    setStub({ 'queue-brief': BRIEF });
  });

  it('a set in phases plays each phase in turn, nothing twice, under one cap', async () => {
    await sleep(1100);
    const segments = [
      { name: 'disco first', songs: 6, genres: ['Disco'], families: [], bpmFrom: null, bpmTo: null, energy: 'steady' },
      { name: 'then house', songs: 6, genres: ['House'], families: [], bpmFrom: null, bpmTo: null, energy: 'build' },
    ];
    const r = await post('/api/v1/ai/queue/build', { brief: { ...BRIEF, songs: null, genres: [], yearFrom: null, yearTo: null, energy: 'steady', segments }, ignoreVPaths: ['testlib'] });
    assert.equal(r.status, 200);
    const out = await r.json();
    const genres = out.songs.map(s => String(s.metadata.genre).toLowerCase());
    assert.deepEqual(genres, [...Array(6).fill('disco'), ...Array(4).fill('house')], 'disco, then house, capped at 10 in all');
    assert.equal(new Set(out.songs.map(s => s.filepath)).size, 10);
    assert.ok(out.notes.some(n => n.code === 'cappedByAdmin' && n.max === 10));
    assert.equal(out.resolved.segments.length, 2);
    assert.deepEqual(out.resolved.segments.map(s => [s.name, s.songs, s.genres]), [['disco first', 6, ['Disco']], ['then house', 4, ['House']]]);
    assert.deepEqual(out.resolved.genres, ['Disco', 'House']);
    assert.equal(out.stats.picked, 10);
  });

  it('"the grandmix 1983 and 1986" is those two mixes, one each — not the folder over 1983–1986', async () => {
    await sleep(1100);
    // the model read the years as an era and the series as a folder: the brief is corrected and two titles mean two songs
    let r = await post('/api/v1/ai/queue/build', { brief: { ...BRIEF, songs: null, genres: [], yearFrom: 1983, yearTo: 1986, folders: ['lib/Grandmix'], titles: ['Grandmix 1983', 'Grandmix 1986'] }, ignoreVPaths: ['testlib'] });
    assert.equal(r.status, 200);
    let out = await r.json();
    assert.deepEqual(out.songs.map(s => s.metadata.title).sort(), ['Grandmix 1983', 'Grandmix 1986'], out.songs.map(s => s.metadata.title).join(' / '));

    // the Grandmix folder switched off: the DJ says where the mix is instead of "not found"
    await sleep(1100);
    r = await post('/api/v1/ai/queue/build', { brief: { ...BRIEF, songs: null, genres: [], yearFrom: null, yearTo: null, titles: ['Grandmix 1986'] }, ignoreVPaths: ['testlib'], excludeFilepathPrefixes: [{ vpath: 'lib', prefix: 'Grandmix/' }] });
    out = await r.json();
    assert.equal(out.songs.length, 0);
    const outside = out.notes.find(n => n.code === 'titleOutsideScope');
    assert.ok(outside, JSON.stringify(out.notes));
    assert.equal(outside.name, 'Grandmix 1986');
    assert.equal(outside.where, 'lib/Grandmix');
    assert.ok(outside.count >= 1);
    assert.ok(out.notes.some(n => n.code === 'emptyInSelection'));
    assert.ok(!out.notes.some(n => n.code === 'titleUnknown'));

    // the rule-based reader knows the series from the library's own titles
    await sleep(3100);
    setStub({ 'queue-brief': { energy: 'explode' } });
    r = await post('/api/v1/ai/queue/brief', { text: 'give me the grandmix 1983 and 1986', ignoreVPaths: ['testlib'] });
    out = await r.json();
    assert.equal(out.source, 'rules');
    assert.deepEqual(out.brief.titles, ['grandmix 1983', 'grandmix 1986']);
    assert.deepEqual([out.brief.yearFrom, out.brief.yearTo], [null, null]);
    setStub({ 'queue-brief': BRIEF });
    await sleep(1100);
    r = await post('/api/v1/ai/queue/build', { brief: out.brief, ignoreVPaths: ['testlib'] });
    out = await r.json();
    assert.equal(out.songs.length, 2);
  });

  it('throttles back-to-back requests', async () => {
    await sleep(3100);
    const first = await post('/api/v1/ai/queue/brief', { text: 'disco', ignoreVPaths: ['testlib'] });
    assert.equal(first.status, 200);
    const second = await post('/api/v1/ai/queue/brief', { text: 'disco again', ignoreVPaths: ['testlib'] });
    assert.equal(second.status, 429);
  });
});

describe('AI DJ stays hidden until switched on', async () => {
  const { startServer } = await import('../helpers/server.mjs');
  let srv;
  before(async () => { srv = await startServer({ extraConfig: { aiAssist: { enabled: true } }, waitForScan: true }); });
  after(async () => { await srv.stop(); });

  it('answers 404 to every queue endpoint and false on status', async () => {
    const st = await (await fetch(srv.baseUrl + '/api/v1/ai/status')).json();
    assert.equal(st.enabled, false);
    const r = await fetch(srv.baseUrl + '/api/v1/ai/queue/brief', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'disco' }) });
    assert.equal(r.status, 404);
    const b = await fetch(srv.baseUrl + '/api/v1/ai/queue/build', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ brief: {} }) });
    assert.equal(b.status, 404);
  });
});

describe('AI DJ per user', async () => {
  const { startServer } = await import('../helpers/server.mjs');
  let srv, adminToken, bobToken;
  const login = async (username, password) => (await (await fetch(srv.baseUrl + '/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) })).json()).token;
  const status = async token => (await (await fetch(srv.baseUrl + '/api/v1/ai/status', { headers: { 'x-access-token': token } })).json()).enabled;
  before(async () => {
    srv = await startServer({ users: [{ username: 'boss', password: 'boss-pw', admin: true }, { username: 'bob', password: 'bob-pw', admin: false }], extraConfig: { aiAssist: { enabled: true, queueBuilder: true } }, waitForScan: true });
    adminToken = await login('boss', 'boss-pw');
    bobToken = await login('bob', 'bob-pw');
  });
  after(async () => { await srv.stop(); });

  it('is on for every user by default and off per user when the admin says so', async () => {
    assert.equal(await status(adminToken), true);
    assert.equal(await status(bobToken), true);
    const r = await fetch(srv.baseUrl + '/api/v1/admin/users/allow-ai-dj', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-access-token': adminToken }, body: JSON.stringify({ username: 'bob', allow: false }) });
    assert.equal(r.status, 200);
    assert.equal(await status(bobToken), false);
    assert.equal(await status(adminToken), true);
    const b = await fetch(srv.baseUrl + '/api/v1/ai/queue/build', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-access-token': bobToken }, body: JSON.stringify({ brief: BRIEF }) });
    assert.equal(b.status, 404);
    const denied = await fetch(srv.baseUrl + '/api/v1/admin/users/allow-ai-dj', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-access-token': bobToken }, body: JSON.stringify({ username: 'boss', allow: false }) });
    assert.equal(denied.status, 403);
  });
});
