// Manual end-to-end check against the reference player (not part of npm test).
//   client-initiated:  node test/manual/sendspin-spike.mjs
//                      sendspin daemon --url ws://127.0.0.1:8927/sendspin --unpaired-access true ...
//   server-initiated:  sendspin daemon --port 8930 --unpaired-access true ...
//                      node test/manual/sendspin-spike.mjs --connect ws://127.0.0.1:8930/sendspin
//   mDNS:              same daemon, node test/manual/sendspin-spike.mjs --discover
import { spawnSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SendspinServer } from '../../src/sendspin/server.js';
import { nowUs } from '../../src/sendspin/connection.js';
import { openTrack } from '../../src/sendspin/audio.js';

const FFMPEG = process.env.FFMPEG || new URL('../../bin/ffmpeg/ffmpeg', import.meta.url).pathname;
const args = process.argv.slice(2);
const connectUrl = args.includes('--connect') ? args[args.indexOf('--connect') + 1] : null;
const discover = args.includes('--discover');
const codec = args.includes('--codec') ? args[args.indexOf('--codec') + 1] : 'pcm';
const seconds = Number(args.includes('--seconds') ? args[args.indexOf('--seconds') + 1] : 10);
const t0 = Date.now();
const stamp = () => `+${((Date.now() - t0) / 1000).toFixed(3)}s`;
const logger = Object.fromEntries(['debug', 'info', 'warn', 'error'].map((l) => [l, (m) => console.log(`${stamp()} ${l.padEnd(5)} ${m}`)]));
const log = (m) => logger.info(`[spike] ${m}`);

const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sendspin-spike-'));
const server = new SendspinServer({ dataDir: dir, host: discover ? '0.0.0.0' : '127.0.0.1', port: 8927, discovery: discover, name: 'Velvet Spike', languages: ['nl', 'en'], logger });

const MAX_AHEAD_US = BigInt(process.env.MAX_AHEAD_MS ?? 3000) * 1000n;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let times = 0;
server.on('time', () => { times++; });
server.on('state', (conn, s) => log(`client/state available=${s.available} player=${JSON.stringify(s.player)}`));
server.on('goodbye', (conn, reason) => log(`client/goodbye ${reason}`));
server.on('client-removed', (conn, info) => log(`closed code=${info.code} goodbye=${info.goodbye}`));

function pickFormat(conn) {
  const pref = conn.state.player.format;
  const ok = (f) => (f.codec === 'pcm' || f.codec === 'flac') && [16, 24].includes(f.bit_depth) && [44100, 48000].includes(f.sample_rate);
  if (pref && ok(pref) && pref.codec === codec) return pref;
  return conn.info.player.supportedFormats.find((f) => f.codec === codec && ok(f)) ?? conn.info.player.supportedFormats.find(ok);
}

function makeSine(sampleRate) {
  const file = path.join(dir, `sine-${sampleRate}.wav`);
  const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=${sampleRate}:duration=${seconds}`, '-ac', '2', file]);
  if (r.status !== 0) throw new Error(`ffmpeg sine failed: ${r.stderr}`);
  return file;
}

async function waitForRoom(conn, outstanding, size, startUs) {
  const capacity = conn.info.player.bufferCapacity;
  for (;;) {
    const now = nowUs();
    const delayUs = BigInt(conn.state.player.outputDelayMs) * 1000n;
    while (outstanding.list.length && outstanding.list[0].endUs - delayUs <= now) outstanding.used -= outstanding.list.shift().size;
    if (outstanding.used + size <= capacity && startUs - now <= MAX_AHEAD_US) return;
    await sleep(5);
  }
}

async function pace(conn, encoder) {
  const outstanding = { list: [], used: 0 };
  let sent = 0;
  let bytes = 0;
  let minAhead = Infinity;
  for await (const chunk of encoder) {
    const size = 13 + chunk.frame.length;
    const startUs = BigInt(chunk.startUs);
    await waitForRoom(conn, outstanding, size, startUs);
    if (!conn.isOpen) break;
    minAhead = Math.min(minAhead, Number(startUs - nowUs()) / 1000);
    conn.sendAudioChunk(startUs, chunk.frame);
    outstanding.list.push({ endUs: startUs + BigInt(chunk.durationUs), size });
    outstanding.used += size;
    sent++;
    bytes += size;
  }
  return { sent, bytes, minAhead };
}

async function play(conn) {
  const id = conn.clientId;
  await server.approve(id);
  while (!conn.playerStateReceived || !conn.state.available) {
    if (!conn.isOpen) return;
    await sleep(50);
  }
  const p = conn.state.player;
  const format = pickFormat(conn);
  log(`player state ok; buffer_capacity=${conn.info.player.bufferCapacity}; format=${JSON.stringify(format)}`);
  server.setPlayback(id, true);
  conn.groupUpdate({ playbackState: 'playing', groupId: Buffer.alloc(32, 7).toString('base64url'), groupName: 'Spike room' });
  const leadMs = Math.max(p.minBufferMs + p.outputDelayMs, p.requiredLeadTimeMs) + 250;
  const baseUs = Number(nowUs()) + leadMs * 1000;
  const file = makeSine(format.sample_rate);
  const encoder = openTrack({ file, format, chunkMs: 25, baseUs, ffmpeg: FFMPEG });
  const player = { codec: format.codec, sample_rate: format.sample_rate, channels: format.channels, bit_depth: format.bit_depth };
  if (encoder.codecHeader) player.codec_header = encoder.codecHeader;
  conn.streamStart({ player });
  log(`stream/start sent; first chunk at +${leadMs} ms`);
  const { sent, bytes, minAhead } = await pace(conn, encoder);
  log(`sent ${sent} chunks, ${bytes} bytes; min send-ahead ${minAhead.toFixed(1)} ms; time exchanges so far ${times}`);
  while (nowUs() < encoder.endUs && conn.isOpen) await sleep(50);
  conn.streamEnd();
  server.setPlayback(id, false);
  conn.groupUpdate({ playbackState: 'stopped', groupId: Buffer.alloc(32, 7).toString('base64url'), groupName: 'Spike room' });
  log(`stream/end sent, activities []; time exchanges ${times}`);
  await sleep(1500);
  log(`done; connection still open: ${conn.isOpen}`);
  await server.stop();
  await fsp.rm(dir, { recursive: true, force: true });
  process.exit(0);
}

server.on('client', (conn, info) => {
  log(`client "${info.name}" ${conn.direction} suite=${conn.suite} psk=${conn.pskCategory} roles=${JSON.stringify(info.supportedRoles)} formats=${JSON.stringify(info.player?.supportedFormats)}`);
  play(conn).catch((err) => {
    log(`play failed: ${err.stack}`);
    process.exit(1);
  });
});

await server.start();
if (connectUrl) server.connectTo(connectUrl);
server.on('discovered', (svc) => log(`mDNS found "${svc.name}" at ${svc.url}`));
log(connectUrl ? `dialing ${connectUrl}` : 'waiting for a client on ws://127.0.0.1:8927/sendspin');
setTimeout(() => {
  log('timeout');
  process.exit(2);
}, 90_000).unref();
