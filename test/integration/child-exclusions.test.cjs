/**
 * Child Vpath Exclusions — Integration Tests
 * Exercises the private computeChildExclusions() in src/api/db.js through
 * POST /api/v1/db/artist-folder-songs on a real server.
 *
 * Purpose: when a user has access to a parent vpath (e.g. "Music") but NOT
 * to a child vpath that lives under it (e.g. "12-inches" whose root is
 * /music/12 inches A-Z/), whole-library queries must skip that prefix.
 */

'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const ALL = ['Music', '12-inches', 'Unidisc', 'Albums', 'Podcasts'];
const USERS = {
  admin:       ALL,
  musicOnly:   ['Music'],
  with12:      ['Music', '12-inches'],
  without12:   ['Music', 'Albums', 'Podcasts'],
  podcastOnly: ['Podcasts'],
};
const FILES = {
  root:   'Music/root.mp3',
  twelve: 'Music/12 inches A-Z/twelve.mp3',
  uni:    'Music/12 inches A-Z/Unidisc/uni.mp3',
  album:  'Music/Albums/album.mp3',
  other:  'Podcasts/other.mp3',
};

describe('Child Vpath Exclusions (artist-folder-songs)', () => {
  let srv, workDir;
  const tokens = {};

  const songsFor = async (user) => {
    const r = await fetch(`${srv.baseUrl}/api/v1/db/artist-folder-songs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-access-token': tokens[user] },
      body: JSON.stringify({ artists: ['Artist A'] }),
    });
    assert.equal(r.status, 200);
    const fps = (await r.json()).map(s => s.filepath).filter(fp => !fp.startsWith('testlib/'));
    return fps.sort();
  };
  const expect = (...keys) => keys.map(k => FILES[k]).sort();

  before(async () => {
    const { ensureFixtures } = await import('../helpers/fixtures.mjs');
    const { startServer } = await import('../helpers/server.mjs');
    const track = path.join(await ensureFixtures(), 'Artist A', 'Album X', '01 - Track One.mp3');

    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'child-excl-'));
    const music = path.join(workDir, 'music');
    const podcasts = path.join(workDir, 'podcasts');
    for (const fp of Object.values(FILES)) {
      const dest = fp.startsWith('Music/') ? path.join(music, fp.slice(6)) : path.join(podcasts, fp.slice(9));
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(track, dest);
    }

    srv = await startServer({
      waitForScan: false,
      users: Object.entries(USERS).map(([username, vpaths]) => ({
        username, password: `${username}-pw`, admin: username === 'admin', vpaths: username === 'admin' ? [...vpaths, 'testlib'] : vpaths,
      })),
      extraFolders: {
        Music: music,
        '12-inches': path.join(music, '12 inches A-Z'),
        Unidisc: path.join(music, '12 inches A-Z', 'Unidisc'),
        Albums: path.join(music, 'Albums'),
        Podcasts: podcasts,
      },
    });
    for (const username of Object.keys(USERS)) {
      const r = await fetch(`${srv.baseUrl}/api/v1/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password: `${username}-pw` }),
      });
      tokens[username] = (await r.json()).token;
    }

    const deadline = Date.now() + 30_000;
    for (;;) {
      const st = await (await fetch(`${srv.baseUrl}/api/v1/db/status`, { headers: { 'x-access-token': tokens.admin } })).json();
      if (!st.locked && (await songsFor('admin')).length === Object.keys(FILES).length) break;
      if (Date.now() > deadline) throw new Error('scan did not finish');
      await new Promise(r => setTimeout(r, 250));
    }
  });

  after(async () => {
    await srv?.stop();
    await fs.rm(workDir, { recursive: true, force: true });
  });

  it('excludes nothing when the user has every vpath', async () => {
    assert.deepEqual(await songsFor('admin'), expect('root', 'twelve', 'uni', 'album', 'other'));
  });

  it('excludes every child (and grandchild) the user lacks', async () => {
    assert.deepEqual(await songsFor('musicOnly'), expect('root'));
  });

  it('keeps a child the user has, but still excludes its grandchild and siblings', async () => {
    assert.deepEqual(await songsFor('with12'), expect('root', 'twelve'));
  });

  it('excludes only the missing child subtree', async () => {
    assert.deepEqual(await songsFor('without12'), expect('root', 'album', 'other'));
  });

  it('does not touch vpaths that are not under any user vpath', async () => {
    assert.deepEqual(await songsFor('podcastOnly'), expect('other'));
  });
});
