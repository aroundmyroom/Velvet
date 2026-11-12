import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { MSG, fragment, frame } from '../../src/sendspin/wire.js';
import { FlacFramer } from '../../src/sendspin/audio.js';
import { TestClient, helloPayload } from './sendspin-test-client.mjs';

const execFileP = promisify(execFile);

export function sourceHello(over = {}) {
  return helloPayload({
    name: 'Turntable',
    supported_roles: ['source@v1'],
    'player@v1_support': undefined,
    ...over,
  });
}

// A Sendspin source written from the spec (roles/source/v1.md): answers server/command start with
// client-stream/start, sends type-12 chunks stamped on its own (optionally drifting) capture clock.
export class SourceClient extends TestClient {
  state(available = true, signal = 'present') {
    this.send('client/state', signal === null ? { available, source: {} } : { available, source: { signal } });
  }

  streamStart(source) {
    this.send('client-stream/start', { source });
  }

  streamEnd() {
    this.send('client-stream/end', { roles: ['source'] });
  }

  sendAudio(timestampUs, data) {
    const header = Buffer.alloc(8);
    header.writeBigInt64BE(BigInt(Math.round(timestampUs)));
    for (const part of fragment(frame(MSG.SOURCE_AUDIO, Buffer.concat([header, data])))) {
      this.ws.send(this.tx.encrypt(part), { binary: true });
    }
  }

  commands() {
    return this.inbox.filter((m) => m.type === 'server/command' && m.payload.source).map((m) => m.payload.source.command);
  }
}

export function sinePcm16(frames, { rate = 48000, freq = 1000, channels = 2, offset = 0, amp = 0.5 } = {}) {
  const buf = Buffer.alloc(frames * channels * 2);
  for (let i = 0; i < frames; i++) {
    const v = Math.round(Math.sin(2 * Math.PI * freq * (offset + i) / rate) * amp * 32767);
    for (let c = 0; c < channels; c++) buf.writeInt16LE(v, (i * channels + c) * 2);
  }
  return buf;
}

// FLAC test material: the codec header (fLaC + STREAMINFO) and whole frames of blockSize samples.
export async function flacFrames(ffmpeg, { rate = 48000, seconds = 2, blockSize = 960, freq = 1000 } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sendspin-src-'));
  const file = path.join(dir, 't.flac');
  try {
    await execFileP(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `sine=f=${freq}:r=${rate}:d=${seconds}`, '-ac', '2',
      '-c:a', 'flac', '-sample_fmt', 's16', '-frame_size', String(blockSize), '-f', 'flac', file,
    ]);
    const data = await fsp.readFile(file);
    const header = Buffer.from(data.subarray(0, 42));
    header[4] |= 0x80;
    const framer = new FlacFramer();
    const frames = [...framer.push(data), ...framer.end()];
    return { header, frames };
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}
