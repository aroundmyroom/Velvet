/**
 * AI-assist (preview): genre families for Auto-DJ. Claude is replaced by a
 * stub file (VELVET_AI_STUB), so this never reaches the network. Checks that
 * the feature is invisible until aiAssist.enabled is set, that proposals never
 * reach playback before an admin approves them, and that approved tag and
 * folder rules ride along on Auto-DJ candidates.
 *
 * Run with:
 *   node --test test/integration/ai-assist.test.cjs
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'velvet-ai-'));
  for (let i = 1; i <= 12; i++) {
    // A remix service whose files are all tagged "blues" — the folder says disco
    makeTrack(root, `Disconet/Vol 1/${i} Disconet.mp3`, { artist: `Disco Act ${i}`, title: `Disconet ${i}`, genre: 'blues' });
    // Yearly mixes without any genre tag
    makeTrack(root, `Mixes/2005/${i} Mix.mp3`, { artist: `DJ ${i}`, title: `Mix ${i}` });
    // Properly tagged singles
    makeTrack(root, `Singles/${i} Single.mp3`, { artist: `House Act ${i}`, title: `Single ${i}`, genre: 'house' });
  }
  return root;
}

const STUB = {
  'genre-families': { items: [
    { tag: 'Blues', family: 'disco', confidence: 0.9 },
    { tag: 'House', family: 'electronic', confidence: 0.95 },
  ] },
  'folder-families': { items: [
    { folder: 'lib/Mixes', family: 'electronic', confidence: 0.7, reason: 'yearly dance mixes' },
  ] },
  'library-notes': { items: [
    { folder: 'lib/Disconet', kind: 'remix-service', note: 'Disconet, the New York DJ remix service (1977–1989).', aliases: ['DN'], ask: 'play some Disconet medleys' },
    { folder: 'lib/Mixes', kind: 'mixes', note: 'Yearly DJ mixes, one folder per year.', aliases: [], ask: 'the 2005 mix' },
    { folder: 'lib/Singles', kind: 'genre', note: 'House singles.', aliases: [], ask: 'some house' },
  ] },
};

describe('AI-assist genre families', async () => {
  const { startServer } = await import('../helpers/server.mjs');
  let srv, root, stubPath;
  const post = (p, body) => fetch(srv.baseUrl + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const get = p => fetch(srv.baseUrl + p);
  const candidates = async () => {
    const r = await post('/api/v1/db/random-songs', { returnAll: true, ignoreVPaths: ['testlib'] });
    assert.equal(r.status, 200);
    return (await r.json()).songs;
  };
  const familyOf = (songs, dir) => songs.find(s => s.filepath.includes(`/${dir}/`))?.metadata['genre-family'] ?? null;

  before(async () => {
    root = buildLibrary();
    stubPath = path.join(root, 'stub.json');
    fs.writeFileSync(stubPath, JSON.stringify(STUB));
    process.env.VELVET_AI_STUB = stubPath;
    srv = await startServer({ extraFolders: { lib: root }, extraConfig: { aiAssist: { enabled: true } }, waitForScan: true });
  });
  after(async () => {
    delete process.env.VELVET_AI_STUB;
    await srv.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('shows the library through the admin endpoint', async () => {
    const r = await get('/api/v1/admin/ai/genre-families');
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.deepEqual(j.families, ['electronic', 'disco', 'soft', 'ambient', 'hard', 'other']);
    const blues = j.genres.find(g => g.genre === 'Blues');
    assert.equal(blues.cnt, 12);
    assert.equal(blues.status, 'none');
    assert.equal(blues.keyword, 'other');
    const mixes = j.folders.find(f => f.key === 'lib/Mixes');
    assert.equal(mixes.n, 12);
    assert.equal(mixes.tagged, 0);
    assert.equal(mixes.clear, false);
  });

  it('sends no family to Auto-DJ while no rule is approved', async () => {
    const songs = await candidates();
    assert.ok(songs.length >= 30);
    assert.ok(songs.every(s => !('genre-family' in s.metadata)));
  });

  it('stores proposals without touching playback', async () => {
    let r = await post('/api/v1/admin/ai/genre-families/propose', { kind: 'genre' });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).proposed, 2);
    r = await post('/api/v1/admin/ai/genre-families/propose', { kind: 'folder' });
    assert.equal((await r.json()).proposed, 1);
    const j = await (await get('/api/v1/admin/ai/genre-families')).json();
    assert.equal(j.genres.find(g => g.genre === 'Blues').status, 'proposed');
    assert.equal(j.genres.find(g => g.genre === 'Blues').proposed, 'disco');
    assert.equal(j.folders.find(f => f.key === 'lib/Mixes').proposed, 'electronic');
    assert.ok(j.usage.calls >= 2);
    assert.ok(j.usage.usd > 0);
    const songs = await candidates();
    assert.ok(songs.every(s => !('genre-family' in s.metadata)));
  });

  it('approved tag and folder rules reach Auto-DJ candidates', async () => {
    const j = await (await get('/api/v1/admin/ai/genre-families')).json();
    const blues = j.genres.find(g => g.genre === 'Blues');
    const r = await post('/api/v1/admin/ai/genre-families/apply', { items: [
      { kind: 'genre', key: blues.key, family: 'disco', label: 'Blues' },
      { kind: 'folder', key: 'lib/Mixes', family: 'electronic' },
    ] });
    assert.equal(r.status, 200);
    const songs = await candidates();
    assert.equal(familyOf(songs, 'Disconet'), 'disco', 'the approved tag rule beats the keyword match');
    assert.equal(familyOf(songs, 'Mixes'), 'electronic', 'untagged files take the folder rule');
    assert.equal(familyOf(songs, 'Singles'), 'electronic', 'an unruled tag still uses the keyword match');
  });

  it('stops asking when the monthly budget is spent', async () => {
    let r = await post('/api/v1/admin/ai/config', { enabled: true, apiKey: '', model: 'claude-haiku-5-5', monthlyBudgetUsd: 0 });
    assert.equal(r.status, 200);
    r = await post('/api/v1/admin/ai/genre-families/propose', { kind: 'genre' });
    assert.equal(r.status, 409);
    assert.equal((await r.json()).code, 'budget');
    await post('/api/v1/admin/ai/config', { enabled: true, apiKey: '', model: 'claude-haiku-5-5', monthlyBudgetUsd: 2 });
  });

  it('clearing proposals keeps approved rules', async () => {
    const r = await post('/api/v1/admin/ai/genre-families/reset', { kind: 'genre' });
    assert.equal((await r.json()).removed, 1);
    const j = await (await get('/api/v1/admin/ai/genre-families')).json();
    assert.equal(j.genres.find(g => g.genre === 'House').status, 'none');
    assert.equal(j.genres.find(g => g.genre === 'Blues').status, 'approved');
  });

  it('removing a rule takes the family away again', async () => {
    await post('/api/v1/admin/ai/genre-families/apply', { items: [{ kind: 'folder', key: 'lib/Mixes', family: 'none' }] });
    const songs = await candidates();
    assert.equal(familyOf(songs, 'Mixes'), null);
  });

  it('undo puts an approved rule back to its proposal', async () => {
    await post('/api/v1/admin/ai/genre-families/propose', { kind: 'genre' });
    let j = await (await get('/api/v1/admin/ai/genre-families')).json();
    const house = j.genres.find(g => g.genre === 'House');
    assert.equal(house.status, 'proposed');
    await post('/api/v1/admin/ai/genre-families/apply', { items: [{ kind: 'genre', key: house.key, family: 'disco' }] });
    j = await (await get('/api/v1/admin/ai/genre-families')).json();
    assert.equal(j.genres.find(g => g.genre === 'House').family, 'disco');
    await post('/api/v1/admin/ai/genre-families/apply', { items: [{ kind: 'genre', key: house.key, family: 'undo' }] });
    j = await (await get('/api/v1/admin/ai/genre-families')).json();
    const back = j.genres.find(g => g.genre === 'House');
    assert.equal(back.status, 'proposed');
    assert.equal(back.proposed, 'electronic');
    assert.equal(familyOf(await candidates(), 'Singles'), 'electronic', 'keyword match again, not the undone rule');
  });

  it('profiles keep their own rules and Auto-DJ follows the active one', async () => {
    let r = await post('/api/v1/admin/ai/profiles', { name: 'Profile 2', copyFrom: 1 });
    assert.equal(r.status, 200);
    const { id } = await r.json();
    assert.ok(id > 1);
    let j = await (await get(`/api/v1/admin/ai/genre-families?profile=${id}`)).json();
    assert.equal(j.profile, id);
    assert.equal(j.genres.find(g => g.genre === 'Blues').family, 'disco', 'copied along');
    const blues = j.genres.find(g => g.genre === 'Blues');
    await post('/api/v1/admin/ai/genre-families/apply', { profile: id, items: [{ kind: 'genre', key: blues.key, family: 'soft' }] });
    j = await (await get('/api/v1/admin/ai/genre-families')).json();
    assert.equal(j.genres.find(g => g.genre === 'Blues').family, 'disco', 'profile 1 untouched');
    assert.equal(familyOf(await candidates(), 'Disconet'), 'disco', 'Auto-DJ still on profile 1');

    r = await post('/api/v1/admin/ai/profiles/activate', { id });
    assert.equal(r.status, 200);
    assert.equal(familyOf(await candidates(), 'Disconet'), 'soft', 'Auto-DJ switched with the profile');
    const p = await (await get('/api/v1/admin/ai/profiles')).json();
    assert.equal(p.active, id);
    assert.equal(p.profiles.length, 2);

    r = await post('/api/v1/admin/ai/profiles/delete', { id });
    assert.equal(r.status, 409, 'the active profile cannot be deleted');
    await post('/api/v1/admin/ai/profiles/activate', { id: 1 });
    r = await post('/api/v1/admin/ai/profiles/delete', { id });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).profiles.length, 1);
    assert.equal(familyOf(await candidates(), 'Disconet'), 'disco');
  });

  it('shows the admin what is sent, where, and every call made', async () => {
    const a = await (await get('/api/v1/admin/ai/activity')).json();
    assert.equal(a.endpoint.provider, 'anthropic');
    assert.equal(a.endpoint.endpoint, 'https://api.anthropic.com/v1/messages');
    assert.ok(a.calls.length >= 3, 'the proposals above were logged');
    const call = a.calls.find(c => c.task === 'genre-families');
    assert.equal(call.ok, true);
    assert.equal(call.stub, true);
    assert.ok(call.promptChars > 0 && call.systemChars > 0);
    assert.match(call.preview, /files/);
    const c = await (await get('/api/v1/admin/ai/context')).json();
    assert.match(c.genres.system, /Tempo is a strong hint/);
    assert.match(c.genres.sample, /^Blues \| 12 files/m);
    assert.match(c.folders.sample, /lib\/Disconet \| 12 files \| tags: .*\| artists: Disco Act/);
    assert.match(c.folders.sample, /files: "Disconet/);
    assert.match(c.aidj.library, /Sub-folders \(songs\): lib\/Disconet\/Vol 1 12/);
    assert.ok(c.aidj.chars > 200);
    const j = await (await get('/api/v1/admin/ai/genre-families')).json();
    assert.deepEqual(j.folders.find(f => f.key === 'lib/Disconet').topArtists.length, 3);
  });

  it('shows the whole library as the active rules see it', async () => {
    // the fixture vpath (testlib) is in the count too, so the library totals are lower bounds
    const o = await (await get('/api/v1/admin/ai/overview')).json();
    assert.ok(o.library.songs >= 36);
    assert.ok(o.library.withoutGenre >= 12);
    assert.ok(o.library.folders >= 3);
    assert.equal(o.rules.tag, 1, 'Blues → disco is approved');
    assert.equal(o.families.disco.viaTag, 12);
    assert.equal(o.families.disco.genres[0].genre, 'Blues');
    assert.ok(o.families.electronic.viaKeyword >= 12, 'house by keyword guess');
    assert.ok(o.families.unknown.songs >= 12, 'untagged mixes, no folder rule any more');
    assert.equal(o.families.unknown.viaTag + o.families.unknown.viaFolder + o.families.unknown.viaKeyword, 0);
  });

  it('a saved key starts the library analysis in the background', async () => {
    await post('/api/v1/admin/ai/genre-families/reset', { kind: 'genre' });
    await post('/api/v1/admin/ai/genre-families/reset', { kind: 'folder' });
    // a saved key alone reads nothing; the admin sees the estimate and asks for the pass
    let r = await post('/api/v1/admin/ai/config', { enabled: true, apiKey: 'test-key-not-real', model: 'claude-haiku-5-5', monthlyBudgetUsd: 2 });
    assert.equal(r.status, 200);
    const c = await r.json();
    assert.equal(c.analysing, false);
    assert.ok(c.estimate.songs >= 36, 'the whole library counts, test vpath included');
    assert.ok(c.estimate.items.genres >= 1 && c.estimate.items.notes === 3, JSON.stringify(c.estimate.items));
    assert.ok(c.estimate.usd.total > 0 && c.estimate.usd.total < 0.01, 'a 36-song library costs well under a cent');
    assert.ok(c.estimate.models['claude-sonnet-5-5'] > c.estimate.models['claude-haiku-5-5']);
    assert.ok((await (await get('/api/v1/admin/ai/config')).json()).estimate.perThousandSongs > 0);
    r = await post('/api/v1/admin/ai/config', { enabled: true, apiKey: 'test-key-not-real', model: 'claude-haiku-5-5', monthlyBudgetUsd: 2, analyse: true });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).analysing, true);
    let a;
    for (let i = 0; i < 40; i++) {
      a = await (await get('/api/v1/admin/ai/analysis')).json();
      if (!a.running) break;
      await new Promise(res => setTimeout(res, 250));
    }
    assert.equal(a.running, false);
    assert.equal(a.error, null);
    assert.equal(a.genres, 1, 'House proposed again; Blues is approved and left alone');
    assert.equal(a.folders, 1);
    const j = await (await get('/api/v1/admin/ai/genre-families')).json();
    assert.equal(j.genres.find(g => g.genre === 'House').status, 'proposed');
    assert.equal(j.folders.find(f => f.key === 'lib/Mixes').status, 'proposed');
    await post('/api/v1/admin/ai/config', { enabled: true, apiKey: '', model: 'claude-haiku-5-5', monthlyBudgetUsd: 2 });
  });

  it('writes library notes the AI DJ reads, keeps the admin\'s edits, and shows the plan', async () => {
    await post('/api/v1/admin/ai/config', { enabled: true, apiKey: 'test-key-not-real', model: 'claude-haiku-5-5', monthlyBudgetUsd: 2 });
    let j = await (await get('/api/v1/admin/ai/library-notes')).json();
    assert.equal(j.plan.folders, 3, 'three folders of twelve files');
    const wait = async () => {
      for (let i = 0; i < 60; i++) {
        j = await (await get('/api/v1/admin/ai/library-notes')).json();
        if (!j.analysis.running) return j;
        await new Promise(res => setTimeout(res, 250));
      }
      return j;
    };
    j = await wait();
    if (!j.notes.length) {
      const r = await post('/api/v1/admin/ai/library-notes/analyse', { force: false });
      assert.equal(r.status, 200);
      j = await wait();
    }
    assert.equal(j.analysis.error, null);
    assert.equal(j.notes.length, 3, JSON.stringify(j.notes));
    const dn = j.notes.find(x => x.key === 'lib/Disconet');
    assert.equal(dn.kind, 'remix-service');
    assert.deepEqual(dn.aliases, ['DN']);
    assert.equal(j.plan.todo, 0, 'nothing left to describe');

    // the DJ reads the notes in its system prompt
    const ctx = await (await get('/api/v1/admin/ai/context')).json();
    assert.ok(ctx.aidj.notes.includes('lib/Disconet [remix-service]: Disconet, the New York DJ remix service'), ctx.aidj.notes);
    assert.equal(ctx.aidj.notesTotal, 3);
    assert.ok(ctx.notes.system.includes('music historian'));

    // an edit survives a forced re-description; a deleted note comes back
    let r = await post('/api/v1/admin/ai/library-notes/edit', { key: 'lib/Mixes', kind: 'series', note: 'My own yearly mixes.', aliases: ['jaarmix'], ask: '' });
    assert.equal(r.status, 200);
    r = await post('/api/v1/admin/ai/library-notes/delete', { key: 'lib/Singles' });
    assert.equal(r.status, 200);
    r = await post('/api/v1/admin/ai/library-notes/analyse', { force: true });
    assert.equal((await r.json()).started, true);
    j = await wait();
    const mixes = j.notes.find(x => x.key === 'lib/Mixes');
    assert.equal(mixes.note, 'My own yearly mixes.');
    assert.equal(mixes.source, 'edited');
    assert.ok(j.notes.find(x => x.key === 'lib/Singles'));
    const ctx2 = await (await get('/api/v1/admin/ai/context')).json();
    assert.ok(ctx2.aidj.notes.includes('My own yearly mixes. (also: jaarmix)'));

    r = await post('/api/v1/admin/ai/library-notes/reset', { keepEdited: true });
    assert.equal((await r.json()).removed, 2);
    j = await (await get('/api/v1/admin/ai/library-notes')).json();
    assert.equal(j.notes.length, 1);
    await post('/api/v1/admin/ai/config', { enabled: true, apiKey: '', model: 'claude-haiku-5-5', monthlyBudgetUsd: 2 });
  });
});

describe('AI-assist stays invisible by default', async () => {
  const { startServer } = await import('../helpers/server.mjs');
  let srv;
  before(async () => { srv = await startServer({ waitForScan: true }); });
  after(async () => { await srv.stop(); });

  it('reports disabled and hides its endpoints', async () => {
    const cfg = await (await fetch(srv.baseUrl + '/api/v1/admin/ai/config')).json();
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.apiKey, '');
    assert.equal((await fetch(srv.baseUrl + '/api/v1/admin/ai/genre-families')).status, 404);
    const r = await fetch(srv.baseUrl + '/api/v1/admin/ai/genre-families/propose', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"kind":"genre"}' });
    assert.equal(r.status, 404);
  });

  it('leaves Auto-DJ candidates exactly as before', async () => {
    const r = await fetch(srv.baseUrl + '/api/v1/db/random-songs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"returnAll":true}' });
    const { songs } = await r.json();
    assert.ok(songs.length > 0);
    assert.ok(songs.every(s => !('genre-family' in s.metadata)));
  });
});
