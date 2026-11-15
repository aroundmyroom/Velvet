/**
 * Dual-Hash Identity Tests
 * Scans real files with the shipped scanner (src/db/scanner.mjs) and checks the
 * audio_hash it stores: tag + duration based, so it survives transcoding while
 * the file hash changes. The Duplicate Workshop groups "audio duplicates" by it.
 */

'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { DatabaseSync } = require('node:sqlite');

const execFileP = promisify(execFile);

async function makeTrack(dest, { title, artist = 'Queen', album = 'A Night at the Opera', seconds = 1, flac = false }) {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const args = ['-nostdin', '-y', '-f', 'lavfi', '-t', String(seconds), '-i', 'anullsrc=r=44100:cl=stereo'];
  if (flac) args.push('-codec:a', 'flac');
  else args.push('-codec:a', 'libmp3lame', '-b:a', '128k', '-id3v2_version', '3');
  args.push('-metadata', `title=${title}`, '-metadata', `artist=${artist}`, '-metadata', `album=${album}`, dest);
  await execFileP('ffmpeg', args);
}

describe('Dual-Hash Identity (scanner audio_hash)', () => {
  let srv, workDir, rows;
  const row = name => rows.find(r => r.filepath === name);

  before(async () => {
    const { startServer } = await import('../helpers/server.mjs');
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dual-hash-'));
    const lib = path.join(workDir, 'lib');
    await makeTrack(path.join(lib, 'orig.mp3'), { title: 'Bohemian Rhapsody' });
    await makeTrack(path.join(lib, 'transcoded.flac'), { title: 'Bohemian Rhapsody', flac: true });
    await makeTrack(path.join(lib, 'shouting.mp3'), { title: 'BOHEMIAN RHAPSODY', artist: 'QUEEN', album: 'A NIGHT AT THE OPERA' });
    await makeTrack(path.join(lib, 'other-title.mp3'), { title: "Don't Stop Me Now" });
    await makeTrack(path.join(lib, 'longer.mp3'), { title: 'Bohemian Rhapsody', seconds: 3 });

    srv = await startServer({ waitForScan: false, extraFolders: { Dual: lib } });
    const dbPath = path.join(srv.tmpDir, 'db', 'velvet.sqlite');
    const deadline = Date.now() + 30_000;
    for (;;) {
      const st = await (await fetch(`${srv.baseUrl}/api/v1/db/status`)).json();
      if (!st.locked) {
        const db = new DatabaseSync(dbPath, { readOnly: true });
        rows = db.prepare("SELECT filepath, hash, audio_hash FROM files WHERE vpath = 'Dual'").all();
        db.close();
        if (rows.length === 5) break;
      }
      if (Date.now() > deadline) throw new Error('scan did not finish');
      await new Promise(r => setTimeout(r, 250));
    }
  });

  after(async () => {
    await srv?.stop();
    await fs.rm(workDir, { recursive: true, force: true });
  });

  it('stores a SHA-256 audio_hash next to the MD5 file hash', () => {
    assert.match(row('orig.mp3').audio_hash, /^[a-f0-9]{64}$/);
    assert.match(row('orig.mp3').hash, /^[a-f0-9]{32}$/);
  });

  it('keeps audio_hash across a transcode (MP3 -> FLAC) while the file hash differs', () => {
    assert.equal(row('transcoded.flac').audio_hash, row('orig.mp3').audio_hash);
    assert.notEqual(row('transcoded.flac').hash, row('orig.mp3').hash);
  });

  it('ignores tag case', () => {
    assert.equal(row('shouting.mp3').audio_hash, row('orig.mp3').audio_hash);
  });

  it('differs for a different song', () => {
    assert.notEqual(row('other-title.mp3').audio_hash, row('orig.mp3').audio_hash);
  });

  it('differs when the duration differs (different audio, same tags)', () => {
    assert.notEqual(row('longer.mp3').audio_hash, row('orig.mp3').audio_hash);
  });
});
