/**
 * Generates a small set of silent MP3 test fixtures for integration tests.
 *
 * Fixtures are written to a persistent directory under the system temp folder
 * (not in the repo), so they survive between test runs without being committed.
 *
 * Call ensureFixtures() once per test run; it returns the path to the music
 * root directory. Subsequent calls are fast (files already exist).
 *
 * Fixture layout:
 *   <tmproot>/mstream-fixtures/
 *     Artist A/
 *       Album X/
 *         01 - Track One.mp3
 *         02 - Track Two.mp3
 *     Artist B/
 *       Album Y/
 *         01 - Track Three.mp3
 *     Artist A/
 *       Album Z/                (different album, same artist)
 *         01 - Track Four.mp3
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

const FIXTURES_ROOT = path.join(os.tmpdir(), 'mstream-fixtures');

const TRACKS = [
  { dir: 'Artist A/Album X', file: '01 - Track One.mp3',   artist: 'Artist A', album: 'Album X', title: 'Track One',   track: 1 },
  { dir: 'Artist A/Album X', file: '02 - Track Two.mp3',   artist: 'Artist A', album: 'Album X', title: 'Track Two',   track: 2 },
  { dir: 'Artist B/Album Y', file: '01 - Track Three.mp3', artist: 'Artist B', album: 'Album Y', title: 'Track Three', track: 1 },
  { dir: 'Artist A/Album Z', file: '01 - Track Four.mp3',  artist: 'Artist A', album: 'Album Z', title: 'Track Four',  track: 1 },
];

async function generateTrack(destPath, { artist, album, title, track }) {
  // anullsrc → 1-second stereo silent 48kHz signal, encoded as CBR 128k MP3
  // with ID3v2 tags written by ffmpeg's metadata muxer.
  await execFileP('ffmpeg', [
    '-y',
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
    '-t', '1',
    '-codec:a', 'libmp3lame',
    '-b:a', '128k',
    '-id3v2_version', '3',
    '-metadata', `artist=${artist}`,
    '-metadata', `album=${album}`,
    '-metadata', `title=${title}`,
    '-metadata', `track=${track}`,
    destPath,
  ]);
}

let _ensured = null;

export async function ensureFixtures() {
  if (_ensured) { return _ensured; }

  await fs.mkdir(FIXTURES_ROOT, { recursive: true });

  for (const t of TRACKS) {
    const dir  = path.join(FIXTURES_ROOT, t.dir);
    const dest = path.join(dir, t.file);
    await fs.mkdir(dir, { recursive: true });
    try {
      await fs.access(dest);
    } catch {
      await generateTrack(dest, t);
    }
  }

  _ensured = FIXTURES_ROOT;
  return FIXTURES_ROOT;
}

/** Return all expected track file paths relative to FIXTURES_ROOT. */
export function fixtureRelPaths() {
  return TRACKS.map(t => path.join(t.dir, t.file));
}

/** Return the full fixture track list metadata (for assertion helpers). */
export function fixtureTrackList() {
  return TRACKS.map(t => ({ ...t, fullPath: path.join(FIXTURES_ROOT, t.dir, t.file) }));
}
