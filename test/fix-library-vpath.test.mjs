import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  normRoot, childPrefixWithin, parentVpathOf, rootVpathOf, expandDbVpaths, userOwnsChildPath, dbLocationCandidates,
} from '../src/util/vpath.js';
import { canAccessMediaVpath } from '../src/util/media-access.js';
import { computeFileHash, HASH_READ_LIMIT } from '../src/util/file-hash.js';
import { artFileName } from '../src/util/art-cache.js';

const F = {
  Music:  { root: '/m' },
  Twelve: { root: '/m/12/' },
  Uni:    { root: '/m/12/uni' },
  Sib:    { root: '/m/123' },
  Pods:   { root: '/p' },
  Same:   { root: '/p/' },
};

describe('vpath helpers', () => {
  it('normRoot adds exactly one trailing slash', () => {
    assert.equal(normRoot('/m'), '/m/');
    assert.equal(normRoot('/m/'), '/m/');
  });

  it('childPrefixWithin is strict and ignores look-alike siblings', () => {
    assert.equal(childPrefixWithin('Music', 'Uni', F), '12/uni/');
    assert.equal(childPrefixWithin('Twelve', 'Sib', F), null);
    assert.equal(childPrefixWithin('Music', 'Sib', F), '123/');
    assert.equal(childPrefixWithin('Pods', 'Same', F), null);
    assert.equal(childPrefixWithin('Music', 'Music', F), null);
    assert.equal(childPrefixWithin('Music', 'Nope', F), null);
  });

  it('parentVpathOf picks the nearest parent, rootVpathOf the outermost', () => {
    assert.equal(parentVpathOf('Uni', F), 'Twelve');
    assert.equal(parentVpathOf('Twelve', F), 'Music');
    assert.equal(parentVpathOf('Music', F), null);
    assert.equal(parentVpathOf('Same', F), null);
    assert.deepEqual(rootVpathOf('Uni', F), { vpath: 'Music', prefix: '12/uni/' });
    assert.deepEqual(rootVpathOf('Music', F), { vpath: 'Music', prefix: '' });
  });

  it('expandDbVpaths adds every ancestor root', () => {
    assert.deepEqual(expandDbVpaths(['Uni'], F).sort(), ['Music', 'Twelve', 'Uni']);
    assert.deepEqual(expandDbVpaths(['Pods'], F), ['Pods']);
  });

  it('userOwnsChildPath only allows paths inside an owned child', () => {
    const u = { vpaths: ['Uni'] };
    assert.equal(userOwnsChildPath(u, 'Music', '12/uni', F), true);
    assert.equal(userOwnsChildPath(u, 'Music', '12/uni/a.mp3', F), true);
    assert.equal(userOwnsChildPath(u, 'Music', '12/unix/a.mp3', F), false);
    assert.equal(userOwnsChildPath(u, 'Music', '12/a.mp3', F), false);
    assert.equal(canAccessMediaVpath('/Music/12/uni/a%20b.mp3', u, F), true);
    assert.equal(canAccessMediaVpath('/Music/123/a.mp3', u, F), false);
  });

  it('dbLocationCandidates: direct first, then parents ROOT first', () => {
    const info = { vpath: 'Uni', relativePath: 'a/b.mp3' };
    assert.deepEqual(dbLocationCandidates(info, null, F).map(c => [c.vpath, c.relPath]), [
      ['Uni', 'a/b.mp3'], ['Music', '12/uni/a/b.mp3'], ['Twelve', 'uni/a/b.mp3'],
    ]);
  });

  it('dbLocationCandidates: a child-only user still reaches the parent root', () => {
    const info = { vpath: 'Uni', relativePath: 'x.mp3' };
    const got = dbLocationCandidates(info, { vpaths: ['Uni'] }, F).map(c => c.vpath);
    assert.deepEqual(got, ['Uni', 'Music', 'Twelve']);
  });

  it('dbLocationCandidates: parents the user cannot see are left out', () => {
    const folders = { A: { root: '/a' }, B: { root: '/a/b' }, C: { root: '/c' } };
    const info = { vpath: 'A', relativePath: 'b/x.mp3' };
    assert.deepEqual(dbLocationCandidates(info, { vpaths: ['B'] }, folders).map(c => c.vpath), ['A']);
    assert.deepEqual(dbLocationCandidates({ vpath: 'C', relativePath: 'y' }, { vpaths: ['C'] }, folders).map(c => c.vpath), ['C']);
  });
});

describe('file hash + art names match the scanner', () => {
  it('computeFileHash is md5 of the first 512 KB', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fixlib-hash-'));
    const file = path.join(dir, 'a.bin');
    const buf = crypto.randomBytes(HASH_READ_LIMIT + 1000);
    await fs.writeFile(file, buf);
    const expected = crypto.createHash('md5').update(buf.subarray(0, HASH_READ_LIMIT)).digest('hex');
    assert.equal(await computeFileHash(file), expected);
    await fs.writeFile(file, '');
    await assert.rejects(computeFileHash(file), /0 bytes/);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('artFileName: md5 name, MIME jpeg becomes jpg, a file extension is kept as is', () => {
    const buf = Buffer.from('image-bytes');
    const md5 = crypto.createHash('md5').update(buf).digest('hex');
    assert.equal(artFileName(buf, 'image/jpeg'), `${md5}.jpg`);
    assert.equal(artFileName(buf, 'image/png'), `${md5}.png`);
    assert.equal(artFileName(buf, 'jpeg'), `${md5}.jpeg`);
  });
});
