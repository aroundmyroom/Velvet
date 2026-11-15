import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FFMPEG = path.join(ROOT, 'bin', 'ffmpeg', 'ffmpeg');

describe('v-C units', () => {
  let dir, config;

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'velvet-vc-units-'));
    const music = path.join(dir, 'music');
    fs.mkdirSync(path.join(music, 'Mid', 'Albums'), { recursive: true });
    const file = path.join(dir, 'default.json');
    fs.writeFileSync(file, JSON.stringify({
      secret: 'x'.repeat(20),
      folders: {
        Albums: { root: path.join(music, 'Mid', 'Albums'), albumsOnly: true },
        Mid: { root: path.join(music, 'Mid') },
        Music: { root: music },
      },
      storage: { dbDirectory: path.join(dir, 'db'), albumArtDirectory: path.join(dir, 'art'), logsDirectory: path.join(dir, 'logs') },
    }));
    config = await import('../src/state/config.js');
    await config.setup(file);
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('passwords hash with 210,000 PBKDF2 iterations and old 15,000-iteration hashes still verify', async () => {
    const auth = await import('../src/util/auth.js');
    const fresh = await auth.hashPassword('secret');
    assert.match(fresh.salt, /^pbkdf2-210000\$/);
    await auth.authenticateUser(fresh.hashPassword, fresh.salt, 'secret');
    await assert.rejects(auth.authenticateUser(fresh.hashPassword, fresh.salt, 'wrong'));

    const legacySalt = crypto.randomBytes(16).toString('base64');
    const legacyHash = crypto.pbkdf2Sync('old', legacySalt, 15000, 32, 'sha512').toString('base64');
    await auth.authenticateUser(legacyHash, legacySalt, 'old');
    await assert.rejects(auth.authenticateUser(legacyHash, legacySalt, 'wrong'));
  });

  it('util/replaygain.js owns resolveTrackGain and does not import the API layer', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/util/replaygain.js'), 'utf8');
    assert.doesNotMatch(src, /from '\.\.\/api\//);
    const { resolveTrackGain, rgGainDb } = await import('../src/util/replaygain.js');
    assert.deepEqual(resolveTrackGain({ rg_album_gain_db: -3, rg_track_gain_db: -5 }, 'album'), { gain: -3, peak: null, src: 'measured_album' });
    assert.deepEqual(resolveTrackGain({ replaygainTrackDb: -2 }, 'track'), { gain: -2, peak: null, src: 'tag' });
    assert.equal(rgGainDb({ rg_track_gain_db: 4, rg_true_peak_dbfs: -1 }), 1);
  });

  it('an albumsOnly grandchild is read from its ROOT vpath with the full prefix', async () => {
    const { resolveAlbumsSources, invalidateCache } = await import('../src/api/albums-browse.js');
    invalidateCache();
    const [source] = await resolveAlbumsSources();
    assert.equal(source.vpathName, 'Albums');
    assert.equal(source.dbVpath, 'Music');
    assert.equal(source.prefix, 'Mid/Albums/');
  });

  it('m3u entries with Windows separators are read as paths', async () => {
    const { readPlaylistSongs } = await import('../src/util/m3u.js');
    const list = path.join(dir, 'music', 'w.m3u');
    fs.writeFileSync(list, 'Sub\\Dir\\a.mp3\r\n#comment\r\nplain.mp3\r\n');
    assert.deepEqual(await readPlaylistSongs(list, path.join(dir, 'music')), ['Sub/Dir/a.mp3', 'plain.mp3']);
  });

  it('a transcode is killed when its client goes away', async () => {
    const wav = path.join(dir, 'long.wav');
    execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=d=900:sample_rate=8000', '-ac', '1', '-y', wav]);
    const { pipeTranscodeToRes } = await import('../src/api/transcode.js');
    const { default: express } = await import('express');
    let proc;
    const app = express();
    app.get('/', (req, res) => { proc = pipeTranscodeToRes(res, wav, 'mp3', '128k'); });
    const server = http.createServer(app);
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    try {
      await new Promise((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port: server.address().port, path: '/', agent: false }, res => {
          res.once('data', () => { req.destroy(); resolve(); });
        });
        req.on('error', e => (e.code === 'ECONNRESET' ? resolve() : reject(e)));
      });
      const exit = await Promise.race([
        new Promise(r => proc.once('exit', (code, signal) => r(signal ?? code))),
        new Promise(r => setTimeout(() => r('still running'), 5000)),
      ]);
      assert.equal(exit, 'SIGKILL');
    } finally {
      if (proc && proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
      server.close();
    }
  });
});
