import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { serverNow } from '../../src/sendspin/scheduler.js';

const execFileP = promisify(execFile);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BUNDLED = path.join(ROOT, 'bin/ffmpeg/ffmpeg');
export const FFMPEG = process.env.FFMPEG || (fs.existsSync(BUNDLED) ? BUNDLED : 'ffmpeg');

export async function tone(file, { freq = 440, rate = 48000, seconds = 1, channels = 2 } = {}) {
  await execFileP(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `sine=f=${freq}:r=${rate}:d=${seconds}`,
    '-ac', String(channels), '-c:a', 'pcm_s16le', file,
  ]);
  return file;
}

export function decodeArtworkMessage(buf) {
  const channel = buf[0] - 8;
  const flags = buf[1];
  if (flags & 2) return { kind: 'announce', channel, timestampUs: Number(buf.readBigInt64BE(2)), totalSize: buf.readUInt32BE(10) };
  if (flags & 1) return { kind: 'cancel', channel };
  return { kind: 'part', channel, data: buf.subarray(2) };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function until(cond, { timeoutMs = 4000, stepMs = 5 } = {}) {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await sleep(stepMs);
  }
}

export const PCM48 = { codec: 'pcm', sample_rate: 48000, channels: 2, bit_depth: 16 };
export const FLAC44 = { codec: 'flac', sample_rate: 44100, channels: 2, bit_depth: 16 };

let seq = 0;

export class FakeMember extends EventEmitter {
  #streams = new Set();

  constructor({
    name, roles = ['player', 'controller', 'metadata'], formats = [PCM48, FLAC44], capacity = 4 * 1024 * 1024,
    player = {}, available = true, now = serverNow, artwork = null, clientId = null,
  } = {}) {
    super();
    seq++;
    this.clientId = clientId ?? Buffer.alloc(32, seq).toString('base64url');
    this.now = now;
    this.roles = roles;
    this.info = {
      name: name ?? `Speaker ${seq}`,
      player: roles.includes('player') ? { supportedFormats: formats, bufferCapacity: capacity } : null,
    };
    this.state = {
      available,
      player: roles.includes('player') ? {
        volume: 50, muted: false, outputDelayMs: 0, minBufferMs: 100, requiredLeadTimeMs: 0,
        supportedCommands: ['volume', 'mute'], format: null, ...player,
      } : null,
      roles: artwork ? { artwork } : {},
    };
    this.activities = [];
    this.isOpen = true;
    this.playerStateReceived = roles.includes('player');
    this.calls = [];
    this.chunks = [];
    this.binary = [];
    this.failAfterChunks = Infinity;
  }

  get activeStreams() {
    return [...this.#streams];
  }

  get activeRoles() {
    return this.roles.map((r) => `${r}@v1`);
  }

  hasRole(family) {
    return this.roles.includes(family);
  }

  #rec(type, payload) {
    const c = { type, at: this.now(), payload };
    this.calls.push(c);
    return c;
  }

  activate({ activities }) {
    for (const s of [...this.#streams]) {
      if (s !== 'artwork' && !activities.includes('playback')) {
        this.#rec('stream/end', { roles: [s], implicit: true });
        this.#streams.delete(s);
      }
    }
    this.activities = [...activities];
    this.#rec('server/activate', { activities });
    this.emit('activated', { activities, roles: this.activeRoles, first: false });
    return true;
  }

  streamStart(payload) {
    if (!this.state.available) throw new Error('stream/start needs available');
    if (payload.player && !this.activities.includes('playback')) throw new Error('player stream needs playback');
    this.#rec('stream/start', payload);
    for (const r of ['player', 'artwork']) if (payload[r]) this.#streams.add(r);
    return true;
  }

  streamClear({ roles } = {}) {
    const targets = roles ?? ['player'];
    if (!targets.every((r) => this.#streams.has(r))) throw new Error('stream/clear on an inactive stream');
    this.#rec('stream/clear', { roles });
    return true;
  }

  streamEnd(roles) {
    const targets = roles ?? [...this.#streams];
    if (!targets.length || !targets.every((r) => this.#streams.has(r))) throw new Error('stream/end on an inactive stream');
    this.#rec('stream/end', { roles });
    for (const r of targets) this.#streams.delete(r);
    return true;
  }

  sendAudioChunk(ts, frame) {
    if (!this.#streams.has('player') || !this.activities.includes('playback')) throw new Error('audio outside a player stream');
    if (this.chunks.length >= this.failAfterChunks) throw new Error('socket gone');
    const c = this.#rec('chunk', null);
    c.ts = Number(ts);
    c.frame = frame;
    c.size = 13 + frame.length;
    this.chunks.push(c);
    return c.size;
  }

  sendBinary(buf) {
    const c = this.#rec('binary', decodeArtworkMessage(buf));
    this.binary.push(c);
    return true;
  }

  serverState(state) {
    this.#rec('server/state', state);
    return true;
  }

  serverCommand(cmd) {
    this.#rec('server/command', cmd);
    return true;
  }

  groupUpdate(g) {
    this.#rec('group/update', g);
    return true;
  }

  of(type) {
    return this.calls.filter((c) => c.type === type);
  }

  setState(patch) {
    const prev = this.state;
    this.state = { ...prev, ...patch, player: patch.player ? { ...prev.player, ...patch.player } : prev.player };
    this.emit('state', this.state, prev);
  }

  close() {
    this.isOpen = false;
    this.#streams.clear();
    this.emit('close', { code: 1006 });
  }
}

export function pcmDurationUs(c, format) {
  const samples = c.frame.length / (format.bit_depth / 8 * format.channels);
  return Math.round(samples * 1_000_000 / format.sample_rate);
}
