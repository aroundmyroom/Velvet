import { describe, it, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import * as config from '../src/state/config.js';
import Scribble from '../src/state/lastfm.js';

describe('v-B: config file writes (N024)', () => {
  let tmp, cfgFile, musicDir;
  before(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'velvet-vb-config-'));
    musicDir = path.join(tmp, 'music');
    await fs.mkdir(musicDir);
    cfgFile = path.join(tmp, 'config.json');
    await fs.writeFile(cfgFile, JSON.stringify({
      folders: { lib: { root: musicDir + '//' }, top: { root: '/' } },
      users: { bob: { password: 'h', salt: 's', vpaths: ['lib'] } },
      scanOptions: {},
      storage: { dbDirectory: path.join(tmp, 'db'), albumArtDirectory: path.join(tmp, 'img'), logsDirectory: path.join(tmp, 'logs') },
    }));
    await fs.chmod(cfgFile, 0o640);
    await config.setup(cfgFile);
  });
  after(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

  it('concurrent updates are serialised: none is lost', async () => {
    await Promise.all(Array.from({ length: 40 }, () => config.updateConfigFile(c => { c.counter = (c.counter || 0) + 1; })));
    assert.equal(JSON.parse(await fs.readFile(cfgFile, 'utf8')).counter, 40);
  });

  it('writes keep the file mode and leave no temp files behind', async () => {
    await config.updateConfigFile(c => { c.x = 1; });
    assert.equal((await fs.stat(cfgFile)).mode & 0o777, 0o640);
    assert.deepEqual((await fs.readdir(tmp)).filter(f => f.endsWith('.tmp')), []);
  });

  it('a throwing mutator writes nothing and later writers still run', async () => {
    const before = await fs.readFile(cfgFile, 'utf8');
    await assert.rejects(config.updateConfigFile(() => { throw new Error('nope'); }), /nope/);
    assert.equal(await fs.readFile(cfgFile, 'utf8'), before);
    assert.equal(await config.updateConfigFile(c => { c.y = 2; return 'ok'; }), 'ok');
  });

  it('a reader never sees a half-written file', async () => {
    const big = 'x'.repeat(200_000);
    let parsed = 0;
    const writes = Promise.all(Array.from({ length: 10 }, (_, i) => config.updateConfigFile(c => { c.big = big + i; })));
    for (let i = 0; i < 50; i++) { JSON.parse(await fs.readFile(cfgFile, 'utf8')); parsed++; }
    await writes;
    assert.equal(parsed, 50);
  });

  it('updateUserFields changes the file and the live config together', async () => {
    await config.updateUserFields('bob', { 'allow-upload': false });
    assert.equal(JSON.parse(await fs.readFile(cfgFile, 'utf8')).users.bob['allow-upload'], false);
    assert.equal(config.program.users.bob['allow-upload'], false);
  });

  it('folder roots lose trailing slashes on load (N054/P050); "/" stays', () => {
    assert.equal(config.program.folders.lib.root, musicDir);
    assert.equal(config.program.folders.top.root, '/');
    assert.equal(config.normaliseFolderRoot('/a/b/'), '/a/b');
    assert.equal(config.normaliseFolderRoot('C:\\'), 'C:\\');
  });

  it('scanOptions.saveInterval is no longer a setting (N143)', () => {
    assert.equal('saveInterval' in config.program.scanOptions, false);
  });
});

function fakeGet(body, thrown = []) {
  return mock.method(https, 'get', (opts, onRes) => {
    const res = new EventEmitter();
    const req = new EventEmitter();
    process.nextTick(() => {
      onRes(res);
      res.emit('data', body);
      try { res.emit('end'); } catch (e) { thrown.push(e); }
    });
    return req;
  });
}

describe('v-B: Last.fm client (N049, N142)', () => {
  it('a refused legacy password session ends the scrobble with null instead of throwing', async () => {
    const get = fakeGet('{"error":4,"message":"Authentication Failed"}');
    const post = mock.method(https, 'request', () => { throw new Error('must not post a scrobble without a session'); });
    try {
      const s = new Scribble();
      s.setKeys('k', 's');
      s.addUser('alice', 'pw');
      const result = await new Promise(resolve => s.Scrobble({ artist: 'a', track: 't' }, 'alice', resolve));
      assert.equal(result, null);
      assert.equal(s.users.alice.sessionKey, null);
      assert.equal(post.mock.callCount(), 0);
    } finally {
      get.mock.restore();
      post.mock.restore();
    }
  });

  it('a callback that throws is not called a second time', async () => {
    const thrown = [];
    const get = fakeGet('{"artist":{}}', thrown);
    try {
      const s = new Scribble();
      let calls = 0;
      s.GetArtistInfo('x', () => { calls++; throw new Error('boom'); });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(calls, 1);
      assert.equal(thrown.length, 1);
      assert.match(thrown[0].message, /boom/);
    } finally {
      get.mock.restore();
    }
  });

  it('only the methods Velvet calls remain', async () => {
    for (const dead of ['Love', 'NowPlaying', 'GetArtistEvents', 'GetArtistTopAlbums', 'GetTrackInfo', 'GetAlbumInfo']) {
      assert.equal(Scribble.prototype[dead], undefined, dead);
    }
    const src = await fs.readFile(new URL('../src/state/lastfm.js', import.meta.url), 'utf8');
    assert.equal(src.match(/prototype\.GetArtistInfo\s*=/g).length, 1);
  });
});

describe('v-B: admin page head script reads the admin theme key (N094)', () => {
  it('uses ms2_theme with the same default as applyTheme()', async () => {
    const head = await fs.readFile(new URL('../webapp/admin/admin-init-head.js', import.meta.url), 'utf8');
    assert.match(head, /localStorage\.getItem\('ms2_theme'\) \|\| 'velvet'/);
    assert.doesNotMatch(head, /ms2_theme_/);
  });
});
