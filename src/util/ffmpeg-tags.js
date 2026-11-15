import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ffmpegBin } from './ffmpeg-bootstrap.js';

const execFileAsync = promisify(execFile);

const STREAM_ART = new Set(['.mp3', '.m4a', '.m4b', '.mp4', '.flac']);
const VORBIS_ART = new Set(['.opus', '.ogg', '.oga']);

export function canEmbedCover(file) {
  const ext = path.extname(file).toLowerCase();
  return STREAM_ART.has(ext) || VORBIS_ART.has(ext);
}

function _imageMime(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
  return null;
}

// FLAC/Vorbis picture block, base64: how Ogg containers carry a cover.
function metadataBlockPicture(image) {
  const mime = Buffer.from(_imageMime(image) || 'image/jpeg', 'utf8');
  const head = Buffer.alloc(4 + 4 + mime.length + 4 + 16 + 4);
  let o = head.writeUInt32BE(3, 0);
  o = head.writeUInt32BE(mime.length, o);
  o += mime.copy(head, o);
  o = head.writeUInt32BE(0, o) + 16;
  head.writeUInt32BE(image.length, o);
  return Buffer.concat([head, image]).toString('base64');
}

// null/undefined leaves a tag alone, '' clears it. Ogg keeps its tags on the
// audio stream, so they are set there too.
function _metaArgs(metadata, ext) {
  const args = [];
  for (const [k, v] of Object.entries(metadata)) {
    if (v == null) continue;
    args.push('-metadata', `${k}=${v}`);
    if (VORBIS_ART.has(ext)) args.push('-metadata:s:a:0', `${k}=${v}`);
  }
  return args;
}

function _ffmpeg(args) {
  return execFileAsync(ffmpegBin(), ['-y', '-loglevel', 'error', ...args], { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
}

async function _tmpDir(fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'velvet-tags-'));
  try { return await fn(dir); } finally { await fsp.rm(dir, { recursive: true, force: true }); }
}

// ffmpeg writes a temp file next to `output`, then one atomic rename.
async function _toOutput(output, args) {
  const tmp = path.join(path.dirname(output), `.velvet-tag-${crypto.randomBytes(6).toString('hex')}${path.extname(output)}`);
  try {
    await _ffmpeg([...args, tmp]);
    await fsp.rename(tmp, output);
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    throw err;
  }
}

/**
 * Writes `input` with the cover in `artPath` (replacing any cover it had) to
 * `output` (default: in place). `metadata` adds or overrides tags. `fixPts`
 * re-encodes the cover at one frame per second, for files whose picture
 * stream broke the timestamps. Throws when the format cannot hold a cover or
 * ffmpeg fails; `output` is then left as it was.
 */
export async function embedCover({ input, output = input, artPath, metadata = {}, fixPts = false }) {
  const ext = path.extname(output).toLowerCase();
  if (!canEmbedCover(output)) throw new Error(`Cover art cannot be embedded in ${ext || 'this'} files`);
  const image = await fsp.readFile(artPath);

  if (VORBIS_ART.has(ext)) {
    // The picture block can be megabytes, too long for one command-line
    // argument, so it goes in through an ffmetadata file.
    return _tmpDir(async dir => {
      const picFile = path.join(dir, 'picture.txt');
      const value = metadataBlockPicture(image).replaceAll(/[=;#\\\n]/g, String.raw`\$&`);
      await fsp.writeFile(picFile, `;FFMETADATA1\nMETADATA_BLOCK_PICTURE=${value}\n`);
      await _toOutput(output, [
        '-i', input, '-f', 'ffmetadata', '-i', picFile,
        '-map', '0:a', '-c:a', 'copy', '-map_metadata:g', '1',
        ..._metaArgs(metadata, ext),
      ]);
    });
  }

  // MP3 needs a re-encoded JPEG; mp4/flac take a JPEG or PNG as is.
  const copy = !fixPts && ext !== '.mp3' && _imageMime(image) !== null;
  await _toOutput(output, [
    '-i', input, '-i', artPath,
    '-map', '0:a', '-map', '1:v',
    '-c:a', 'copy', '-c:v', copy ? 'copy' : 'mjpeg',
    ...(fixPts ? ['-r', '1'] : []),
    '-disposition:v:0', 'attached_pic',
    '-metadata:s:v', 'title=Cover (front)',
    '-metadata:s:v', 'comment=Cover (front)',
    ...(ext === '.mp3' ? ['-id3v2_version', '3'] : []),
    ..._metaArgs(metadata, ext),
  ]);
}

/** Copies the audio of `input` to `output` with `metadata` added; no cover. */
export function writeAudioWithTags({ input, output = input, metadata = {} }) {
  const ext = path.extname(output).toLowerCase();
  return _toOutput(output, [
    '-i', input, '-map', '0:a', '-c:a', 'copy',
    ...(ext === '.mp3' ? ['-id3v2_version', '3'] : []),
    ..._metaArgs(metadata, ext),
  ]);
}

/** The first embedded picture as a Buffer, or null. */
export function extractCover(input) {
  return _tmpDir(async dir => {
    const out = path.join(dir, 'cover.img');
    try {
      await _ffmpeg(['-i', input, '-map', '0:v:0', '-frames:v', '1', '-c:v', 'copy', '-f', 'image2', out]);
      const buf = await fsp.readFile(out);
      return buf.length > 100 ? buf : null;
    } catch {
      return null;
    }
  });
}

/**
 * Rewrites the tags of a file in place (stream copy; the original tags stay,
 * `metadata` overrides them) and keeps its embedded cover. WAV/AIFF hold no
 * cover; Ogg covers live in a tag that ffmpeg turns into a picture stream it
 * cannot write back, so Ogg files get their cover re-embedded.
 */
export async function writeTags(file, metadata) {
  const ext = path.extname(file).toLowerCase();
  if (VORBIS_ART.has(ext)) {
    const cover = await extractCover(file);
    if (cover) {
      return _tmpDir(async dir => {
        const artPath = path.join(dir, 'cover.img');
        await fsp.writeFile(artPath, cover);
        await embedCover({ input: file, artPath, metadata });
      });
    }
  }
  await _toOutput(file, [
    '-i', file,
    '-map', STREAM_ART.has(ext) ? '0' : '0:a',
    '-c', 'copy', '-map_metadata', '0',
    ...(ext === '.mp3' ? ['-id3v2_version', '3'] : []),
    ..._metaArgs(metadata, ext),
  ]);
}
