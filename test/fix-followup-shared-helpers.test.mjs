import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { albumFolderPath, isDiscFolder } from '../src/util/album-dir.js';
import { discogsHeaders } from '../src/util/discogs-headers.js';

const src = f => fs.readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');

const OLD_DISC_RE         = /^(cd|disc)\s*[-–]?\s*\d/i;
const OLD_DISC_SUFFIX_RE  = /\b(cd|disc)\s*[-–]?\s*\d+\s*$/i;
const OLD_NUMERIC_DISC_RE = /^\d{1,2}$/;
const oldAlbumsBrowseIsDisc = n => OLD_DISC_RE.test(n) || OLD_DISC_SUFFIX_RE.test(n) || OLD_NUMERIC_DISC_RE.test(n);

function oldMbNormalizeAlbumDir(filepath) {
  const lastSlash = filepath.lastIndexOf('/');
  const dir = lastSlash > 0 ? filepath.slice(0, lastSlash) : '';
  return dir.replace(/\/(CD|Disc|Disk|Side)\s*\d+\s*$/i, '');
}

const FOLDER_NAMES = [
  'CD1', 'CD 1', 'cd-2', 'CD – 3', 'Disc 2', 'disc1', 'Disk 1', 'Side 1', 'Disconet', 'CD Edition', 'CD Edition 2',
  'Album CD - 1', 'Foo Disc 2', '1CD', '1', '02', '123', 'Album', 'Greatest Hits Vol. 2', '2000', 'A Side', '',
];

describe('albums-browse disc rule parity', () => {
  for (const name of FOLDER_NAMES) {
    it(JSON.stringify(name), () => assert.equal(isDiscFolder(name), oldAlbumsBrowseIsDisc(name)));
  }
  it('albums-browse has no local disc regexes and imports the shared rule', () => {
    const s = src('api/albums-browse.js');
    assert.ok(!/const (DISC_RE|DISC_SUFFIX_RE|NUMERIC_DISC_RE)\b/.test(s));
    assert.ok(!/function isDiscFolder/.test(s));
    assert.match(s, /import \{ isDiscFolder \} from '..\/util\/album-dir.js'/);
  });
});

describe('mb-enrich-worker mb_album_dir uses albumFolderPath', () => {
  const CASES = [
    ['A/CD1/x.mp3', 'A', 'A'],
    ['A/Disc 2/x.mp3', 'A', 'A'],
    ['A/1/x.mp3', 'A', 'A/1'],
    ['A/02/x.mp3', 'A', 'A/02'],
    ['A/Album CD - 1/x.mp3', 'A', 'A/Album CD - 1'],
    ['A/Disk 1/x.mp3', 'A/Disk 1', 'A'],
    ['A/Side 1/x.mp3', 'A/Side 1', 'A'],
    ['A/Disconet/x.mp3', 'A/Disconet', 'A/Disconet'],
    ['A/x.mp3', 'A', 'A'],
    ['CD1/x.mp3', 'CD1', 'CD1'],
    ['x.mp3', '', ''],
  ];
  for (const [fp, want, old] of CASES) {
    it(fp, () => {
      assert.equal(albumFolderPath(fp) ?? '', want);
      assert.equal(oldMbNormalizeAlbumDir(fp), old);
    });
  }
  it('worker imports the shared rule', () => {
    const s = src('util/mb-enrich-worker.mjs');
    assert.ok(!s.includes('normalizeAlbumDir'));
    assert.match(s, /albumFolderPath\(row\.filepath\) \?\? ''/);
  });
});

describe('Discogs headers and SSRF-safe JSON fetch', () => {
  it('discogsHeaders builds auth and UA, null without credentials', () => {
    const h = discogsHeaders({ apiKey: 'k', apiSecret: 's', userAgentTag: 'me' });
    assert.equal(h.Authorization, 'Discogs key=k, secret=s');
    assert.match(h['User-Agent'], /^Velvet\/dev\/me \+/);
    assert.equal(discogsHeaders({ apiKey: 'k' }), null);
    assert.equal(discogsHeaders(undefined), null);
  });
  for (const f of ['api/artists-browse.js', 'util/genre-enricher-worker.mjs']) {
    it(`${f} uses the shared helpers`, () => {
      const s = src(f);
      assert.ok(!s.includes('downloadJson'));
      assert.ok(!s.includes('Discogs key='));
      assert.match(s, /import \{[^}]*\bfetchPublicJson\b[^}]*\} from '.*ssrf-check\.js'/);
      assert.match(s, /import \{ discogsHeaders \} from '.*discogs-headers\.js'/);
    });
  }
  it('artists-browse sends no Discogs auth when Discogs is disabled', () => {
    assert.match(src('api/artists-browse.js'), /return d\?\.enabled \? discogsHeaders\(d\) : null;/);
  });
  it('worker imports have no config side effects', () => {
    for (const f of ['util/ssrf-check.js', 'util/discogs-headers.js', 'util/album-dir.js']) {
      assert.ok(!/state\/config|db\/manager/.test(src(f)), f);
    }
  });
});
