/**
 * Artist pages for a library organised as Artist/songs and Artist/(Year) Album/songs.
 * Regression for a v0.7.0 report: ABBA's page listed four Black Sabbath albums,
 * the page showed no songs, and a 6-song artist was counted as 5.
 *
 * Run with:
 *   node --test test/artist-pages.test.mjs
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import { startServer } from './helpers/server.mjs';

const FFMPEG = ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg'].find(p => fs.existsSync(p)) ?? 'ffmpeg';

function makeTrack(root, rel, tags) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const args = ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1'];
  for (const [k, v] of Object.entries(tags)) args.push('-metadata', `${k}=${v}`);
  args.push(...(p.endsWith('.mp3') ? ['-c:a', 'libmp3lame', '-b:a', '64k'] : ['-c:a', 'flac']), p);
  execFileSync(FFMPEG, args);
}

function buildLibrary() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'velvet-artists-'));
  ['Dancing Queen', 'Waterloo', 'SOS', 'Mamma Mia', 'Fernando'].forEach((t, i) =>
    makeTrack(root, `Abba/0${i + 1} ${t}.mp3`, { artist: 'ABBA', album: 'Gold', title: t, track: i + 1 }));
  for (const [dir, album] of [['(1970) Paranoid', 'Paranoid'], ['(2007) The Dio Years', 'The Dio Years'], ['(2013) 13', '13'], ['(2016) The Ultimate Collection', 'The Ultimate Collection']])
    makeTrack(root, `Black Sabbath/${dir}/01 Track.flac`, { artist: 'Black Sabbath', album, title: `${album} 1`, track: 1 });
  for (let i = 1; i <= 6; i++)
    makeTrack(root, `Afrojack/0${i} Song ${i}.mp3`, { artist: i === 6 ? 'Afrojack feat. Eva Simons' : 'Afrojack', album: 'Singles', title: `Song ${i}`, track: i });
  return root;
}

describe('Artist pages for an Artist/songs library layout', () => {
  let srv, root;
  const get = async p => (await fetch(srv.baseUrl + p)).json();

  before(async () => {
    root = buildLibrary();
    srv = await startServer({ extraFolders: { Library: root }, waitForScan: true });
    // The artist index is rebuilt in a worker after the scan finishes
    for (let i = 0; i < 40; i++) {
      const p = await get('/api/v1/artists/profile?key=afrojack');
      if (!p.error) break;
      await new Promise(r => setTimeout(r, 250));
    }
  });
  after(async () => {
    await srv.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('lists songs that sit directly in the artist folder', async () => {
    const p = await get('/api/v1/artists/profile?key=abba');
    const tracks = p.releaseCategories.flatMap(c => c.releases.flatMap(r => r.tracks));
    assert.equal(tracks.length, 5);
  });

  it("does not put another artist's albums on ABBA's page", async () => {
    const p = await get('/api/v1/artists/profile?key=abba');
    const artists = new Set(p.releaseCategories.flatMap(c => c.releases.flatMap(r => r.tracks.map(t => t.artist))));
    assert.deepEqual([...artists], ['ABBA']);
  });

  it('counts a "feat." credit as a song of the lead artist', async () => {
    const p = await get('/api/v1/artists/profile?key=afrojack');
    const tracks = p.releaseCategories.flatMap(c => c.releases.flatMap(r => r.tracks));
    assert.equal(tracks.length, 6);
    const missing = await get('/api/v1/artists/profile?key=' + encodeURIComponent('afrojack feat. eva simons'));
    assert.ok(missing.error, 'the feat. credit must not be a separate artist');
  });

  it('keeps album-folder artists working', async () => {
    const p = await get('/api/v1/artists/profile?key=' + encodeURIComponent('black sabbath'));
    const releases = p.releaseCategories.flatMap(c => c.releases.map(r => r.folder));
    assert.deepEqual(releases.toSorted(), ['(1970) Paranoid', '(2007) The Dio Years', '(2013) 13', '(2016) The Ultimate Collection']);
  });
});

describe('Album Library series matching in the player (webapp/app.js)', () => {
  const src = fs.readFileSync(new URL('../webapp/app.js', import.meta.url), 'utf8');
  const fnSrc = src.match(/function _nameContainsArtist[\s\S]*?\n}\n/)[0];
  // app.js is a classic script, not a module: evaluate this one helper from our own source
  // eslint-disable-next-line sonarjs/code-eval
  const nameContainsArtist = vm.runInNewContext(`${fnSrc}_nameContainsArtist;`);

  it('does not match an artist inside another word', () => {
    assert.equal(nameContainsArtist('Black Sabbath', 'ABBA'), false);
    assert.equal(nameContainsArtist('Kabbala', 'Abba'), false);
    assert.equal(nameContainsArtist('Björkman', 'Björk'), false);
  });

  it('still matches an artist named as a whole word', () => {
    assert.equal(nameContainsArtist('Cerrone Discography', 'Cerrone'), true);
    assert.equal(nameContainsArtist('The Best of ABBA', 'Abba'), true);
    assert.equal(nameContainsArtist('Abba-Gold', 'ABBA'), true);
    assert.equal(nameContainsArtist('AC/DC Live', 'AC/DC'), true);
  });

  it('is not used with a substring check anywhere else', () => {
    assert.doesNotMatch(src, /displayName \|\| ''\)\.toLowerCase\(\)\.includes\(/);
  });
});
