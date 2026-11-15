import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('config setup strips per-request user fields', () => {
  let dir, file, config;
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'velvet-artcfg-'));
    fs.mkdirSync(path.join(dir, 'music'));
    file = path.join(dir, 'default.json');
    fs.writeFileSync(file, JSON.stringify({
      secret: 'x'.repeat(20),
      instanceId: 'fixed-id',
      folders: { Music: { root: path.join(dir, 'music') } },
      users: {
        dennis: { password: 'p', salt: 's', admin: true, vpaths: ['Music'], username: 'dennis', dbVpaths: ['Music', 'Other'] },
        clean: { password: 'p', salt: 's', vpaths: ['Music'] },
      },
    }));
    config = await import('../src/state/config.js');
    await config.setup(file);
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('removes username and dbVpaths from the saved file', () => {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const u of Object.values(saved.users)) {
      assert.ok(!('username' in u));
      assert.ok(!('dbVpaths' in u));
    }
    assert.deepEqual(saved.users.dennis.vpaths, ['Music']);
    assert.equal(saved.users.dennis.password, 'p');
  });

  it('removes them from the loaded config too', () => {
    assert.ok(!('dbVpaths' in config.program.users.dennis));
    assert.ok(!('username' in config.program.users.dennis));
  });
});

// Former findParent/findRoot in getArtistFolderFilter, kept to prove the shared vpath helpers give the same result.
function oldFilter(folders) {
  const withSlash = p => String(p || '').replace(/\/?$/, '/');
  const entries = Object.entries(folders);
  const findParent = name => {
    const myRoot = withSlash(folders[name]?.root);
    let best = null; let bestLen = -1;
    for (const [other, folder] of entries) {
      if (other === name) continue;
      const otherRoot = withSlash(folder.root);
      if (myRoot === otherRoot || !myRoot.startsWith(otherRoot)) continue;
      if (otherRoot.length > bestLen) { best = other; bestLen = otherRoot.length; }
    }
    return best;
  };
  const findRoot = name => {
    let cur = name;
    for (let p = findParent(cur); p; p = findParent(cur)) { cur = p; }
    return cur;
  };
  const allowedRoots = new Set(); const includeFilepathPrefixes = []; const excludeFilepathPrefixes = [];
  for (const rootName of entries.map(([n]) => n).filter(n => !findParent(n))) {
    const rootFolder = folders[rootName] || {};
    if (rootFolder.type === 'excluded') continue;
    const rootEnabled = rootFolder.artistsOn !== false;
    const rootPath = withSlash(rootFolder.root);
    const descendants = entries.filter(([n, f]) => n !== rootName && (f.type || 'music') !== 'excluded' && findRoot(n) === rootName);
    const enabledPrefixes = [];
    for (const [, f] of descendants) {
      const prefix = withSlash(f.root).slice(rootPath.length);
      if (!prefix) continue;
      if (f.artistsOn === false) excludeFilepathPrefixes.push({ vpath: rootName, prefix });
      else if (!rootEnabled) enabledPrefixes.push(prefix);
    }
    if (rootEnabled) { allowedRoots.add(rootName); continue; }
    if (enabledPrefixes.length) { allowedRoots.add(rootName); for (const p of enabledPrefixes) includeFilepathPrefixes.push({ vpath: rootName, prefix: p }); }
  }
  return { vpaths: [...allowedRoots], includeFilepathPrefixes, excludeFilepathPrefixes };
}

describe('getArtistFolderFilter uses the shared vpath helpers', () => {
  let backend;
  before(async () => { backend = await import('../src/db/sqlite-backend.js'); });

  const CASES = {
    'two-level nesting, middle off': {
      Music: { root: '/m' }, Twelve: { root: '/m/12', artistsOn: false }, Uni: { root: '/m/12/uni/' }, Sib: { root: '/m/123' },
    },
    'root off, children on': {
      Music: { root: '/m/', artistsOn: false }, Albums: { root: '/m/Albums' }, Deep: { root: '/m/Albums/Deep' }, Rec: { root: '/m/Rec', type: 'excluded' },
    },
    'excluded root and separate roots': {
      Music: { root: '/m' }, Other: { root: '/o', type: 'excluded' }, Kid: { root: '/o/k' }, Pod: { root: '/p', artistsOn: false },
    },
    'same root twice': { A: { root: '/m' }, B: { root: '/m/' }, C: { root: '/m/c', artistsOn: false } },
  };
  for (const [name, folders] of Object.entries(CASES)) {
    it(name, () => assert.deepEqual(backend.getArtistFolderFilter(folders), oldFilter(folders)));
  }

  it('two-level nesting resolves to the ROOT vpath', () => {
    const r = backend.getArtistFolderFilter(CASES['root off, children on']);
    assert.deepEqual(r.vpaths, ['Music']);
    assert.deepEqual(r.includeFilepathPrefixes, [{ vpath: 'Music', prefix: 'Albums/' }, { vpath: 'Music', prefix: 'Albums/Deep/' }]);
  });
});

describe('subsonic lyrics cache dir', () => {
  it('uses lyricsCacheDir from song-lyrics.js', () => {
    const s = fs.readFileSync(new URL('../src/api/subsonic.js', import.meta.url), 'utf8');
    assert.ok(!s.includes('_lyricsCacheDir'));
    assert.ok(s.includes('lyricsCacheDir(config.program.storage.dbDirectory)'));
  });
});
