#!/usr/bin/env node
// Velvet Sendspin server adapter for the Sendspin conformance harness
// (github.com/Sendspin/conformance, adapters/README.md). It drives Velvet's own
// SendspinServer + RoomManager; all evidence comes from trace.mjs.
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installTracer, ConnectionTrace, sha256, nowUs } from './trace.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SPEC_REVISION = '8c9577ea8719ad082d051ec13cc73ef15ed68948';
const ERROR_MARGIN_MS = 10_000;
const SETTLE_MS = 500;
const ALL_ROLES = ['player@v1', 'controller@v1', 'metadata@v1', 'artwork@v1', 'color@v1'];

const PLAYER_SCENARIOS = new Set([
  'client-initiated-pcm', 'server-initiated-pcm', 'server-initiated-pcm-24bit', 'server-initiated-flac',
  'client-initiated-state-format-pcm', 'client-initiated-state-format-flac',
  'server-initiated-audio-chunk-framing', 'server-initiated-protocol-baseline-v1', 'server-initiated-opus',
]);
const FORMAT_PREFERENCE_SCENARIOS = new Set(['client-initiated-state-format-pcm', 'client-initiated-state-format-flac']);
const METADATA_SCENARIOS = new Set(['client-initiated-metadata', 'server-initiated-metadata']);
const CONTROLLER_SCENARIOS = new Set(['client-initiated-controller', 'server-initiated-controller']);
const ARTWORK_SCENARIOS = new Set(['client-initiated-artwork', 'server-initiated-artwork']);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i]?.startsWith('--') || argv[i + 1] === undefined) throw new Error(`invalid argument near ${argv[i]}`);
    out[argv[i].slice(2).replaceAll('-', '_')] = argv[i + 1];
  }
  return out;
}

const DEFAULTS = {
  scenario_id: 'server-initiated-pcm', initiator_role: 'server', preferred_codec: 'pcm', timeout_seconds: '40',
  port: '8927', server_id: 'velvet-server', server_name: 'Velvet', client_id: 'conformance-client-id',
  clip_seconds: '5', metadata_title: 'Almost Silent', metadata_artist: 'Sendspin Conformance',
  metadata_album_artist: 'Sendspin', metadata_album: 'Protocol Fixtures',
  metadata_artwork_url: 'https://example.invalid/almost-silent.jpg', metadata_year: '2026', metadata_track: '1',
  metadata_track_progress: '12000', metadata_track_duration: '180000', metadata_playback_speed: '1000',
  controller_command: 'next', controller_repeat: 'all', controller_shuffle: 'false',
  artwork_format: 'jpeg', artwork_width: '256', artwork_height: '256',
};

function velvetSource() {
  if (process.env.VELVET_SENDSPIN_SRC) return path.resolve(process.env.VELVET_SENDSPIN_SRC);
  if (process.env.CONFORMANCE_REPO_VELVET) return path.join(process.env.CONFORMANCE_REPO_VELVET, 'src', 'sendspin');
  for (const guess of [path.resolve(HERE, '../../../src/sendspin'), path.resolve(HERE, '../../repos/velvet/src/sendspin')]) {
    if (fs.existsSync(path.join(guess, 'server.js'))) return guess;
  }
  throw new Error('set VELVET_SENDSPIN_SRC (or CONFORMANCE_REPO_VELVET) to Velvet\'s src/sendspin');
}

const writeJson = (file, obj) => fs.writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`);
const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const truthy = (s) => ['1', 'true', 'yes', 'on'].includes(String(s).trim().toLowerCase());

async function waitFor(what, predicate, deadline, pollMs = 20) {
  for (;;) {
    const v = predicate();
    if (v) return v;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(pollMs);
  }
}

function logger() {
  const line = (level) => (msg) => process.stderr.write(`${new Date().toISOString()} ${level} ${msg}\n`);
  return { error: line('error'), warn: line('warn'), info: line('info'), debug: line('debug') };
}

function seeded(label) {
  return crypto.createHash('sha256').update(label, 'utf8').digest();
}

function run(cmd, argv) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    let err = '';
    child.stdout.on('data', (b) => out.push(b));
    child.stderr.on('data', (b) => { err += b; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`${cmd} exited ${code}: ${err.slice(-400)}`))));
  });
}

async function probe(ffprobe, file) {
  const json = JSON.parse((await run(ffprobe, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=sample_rate,channels', '-of', 'json', file])).toString());
  const s = json.streams[0];
  return { sampleRate: Number(s.sample_rate), channels: Number(s.channels) };
}

function wavHeader(dataBytes, sampleRate, channels) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * channels * 2, 28);
  h.writeUInt16LE(channels * 2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

// The harness's source clip: the fixture as s16 (a plain >> 16 of the decoder's
// s32, as PyAV does), cut to int(rate * clip_seconds) frames, hashed as float32.
async function prepareClip({ ffmpeg, ffprobe, fixture, clipSeconds, dir }) {
  const { sampleRate, channels } = await probe(ffprobe, fixture);
  const pcm = await run(ffmpeg, ['-v', 'error', '-i', fixture, '-map', '0:a:0', '-f', 's16le', '-acodec', 'pcm_s16le', '-']);
  const frameCount = Math.min(Math.floor(sampleRate * clipSeconds), Math.floor(pcm.length / (2 * channels)));
  const data = pcm.subarray(0, frameCount * 2 * channels);
  const floats = new Float32Array(data.length / 2);
  for (let i = 0; i < floats.length; i++) floats[i] = data.readInt16LE(i * 2) / 32768;
  const file = path.join(dir, 'clip.wav');
  await fsp.writeFile(file, Buffer.concat([wavHeader(data.length, sampleRate, channels), data]));
  return {
    file, sampleRate, channels, frameCount, durationMs: Math.round((frameCount * 1000) / sampleRate),
    sourcePcmSha256: sha256(Buffer.from(floats.buffer)), sourceFlacSha256: sha256(await fsp.readFile(fixture)),
  };
}

function artworkSvg(width, height) {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 320 200">
<rect width="320" height="60" fill="#c9783b"/><rect y="60" width="320" height="70" fill="#935228"/>
<rect y="130" width="320" height="70" fill="#4b2f1b"/><circle cx="69" cy="67" r="45" fill="#f3e5cf" stroke="#4b2f1b" stroke-width="4"/>
<rect x="150" y="36" width="130" height="18" fill="#f3e5cf"/><rect x="150" y="140" width="146" height="26" fill="#d7a16d"/></svg>`);
}

function verdict(events, failure, passed) {
  return failure ? { status: 'failed', detail: failure, events } : { status: 'passed', detail: passed, events };
}

function eventOf(m, name) {
  return { event: name, direction: m.dir === 'in' ? 'inbound' : 'outbound', message_type: m.type ?? `binary:${m.msgType}`, frame: m.frame ?? 'binary' };
}

const HANDSHAKE_STEPS = [
  ['in', 'text', 'client/init'], ['out', 'text', 'server/init'], ['out', 'text', 'noise/handshake'],
  ['in', 'text', 'noise/handshake'], ['out', 'binary', 'server/hello'], ['in', 'binary', 'client/hello'],
  ['out', 'binary', 'server/activate'],
];
const HANDSHAKE_TYPES = new Set(['client/init', 'server/init', 'noise/handshake', 'server/hello', 'client/hello', 'client/goodbye']);
const SUPPORT_OBJECT_FAMILIES = new Set(['player', 'source', 'visualizer']);

function judgeHandshake(msgs) {
  const events = msgs.slice(0, HANDSHAKE_STEPS.length).map((m) => eventOf(m, 'handshake_message'));
  const bad = HANDSHAKE_STEPS.findIndex(([dir, frame, type], i) => !msgs[i] || msgs[i].dir !== dir || msgs[i].frame !== frame || msgs[i].type !== type);
  if (bad < 0) return verdict(events, null, 'the seven handshake messages in order; cleartext ones in text frames, encrypted ones in binary frames');
  const [dir, frame, type] = HANDSHAKE_STEPS[bad];
  const seen = msgs[bad] ? `${msgs[bad].dir} ${msgs[bad].type} in a ${msgs[bad].frame} frame` : 'missing';
  return verdict(events, `message ${bad + 1} was ${seen}; expected ${dir} ${type} in a ${frame} frame`);
}

function judgeNothingBeforeActivation(trace, msgs, act) {
  const events = (act < 0 ? msgs : msgs.slice(0, act + 1)).map((m) => eventOf(m, 'message_before_activation'));
  if (act < 0) return verdict(events, 'the server sent no server/activate');
  const early = msgs.slice(0, act).find((m) => !HANDSHAKE_TYPES.has(m.type));
  if (early) return verdict(events, `${early.dir} ${early.type} was exchanged before the first server/activate`);
  const frame = trace.entries.find((e) => e.kind === 'frame' && e.msgType !== 0 && e.seq < msgs[act].seq);
  if (frame) return verdict(events, `${frame.dir} binary message ${frame.msgType} preceded the first server/activate`);
  return verdict(events, null, 'only handshake messages preceded the first server/activate');
}

function judgeActivatedRoles(hello, msgs, act) {
  const roles = act < 0 ? null : msgs[act].payload?.active_roles;
  const events = [{
    event: 'server_activate_checked_against_client_hello', active_roles: roles ?? null, supported_roles: hello?.supported_roles ?? null,
    support_objects: Object.keys(hello ?? {}).filter((k) => k.endsWith('_support')),
  }];
  if (!hello) return verdict(events, 'no client/hello was observed');
  if (act < 0) return verdict(events, 'the server sent no server/activate');
  if (!Array.isArray(roles)) return verdict(events, 'the first server/activate carried no active_roles list');
  const missingSupport = (r) => SUPPORT_OBJECT_FAMILIES.has(r.split('@')[0]) && (typeof hello[`${r}_support`] !== 'object' || hello[`${r}_support`] === null);
  const offending = roles.find((r) => !hello.supported_roles?.includes(r) || missingSupport(r));
  if (offending) return verdict(events, `the server activated ${offending}, which client/hello does not offer with its support object`);
  return verdict(events, null, 'every active role was advertised, with the support object its role requires');
}

function judgeInitialState(trace, msgs, act) {
  if (act < 0) return verdict([], 'the server sent no server/activate');
  const at = msgs[act].seq;
  const state = msgs.find((m) => m.seq > at && m.dir === 'in' && m.type === 'client/state');
  const binary = trace.entries.find((e) => e.kind === 'frame' && e.dir === 'out' && e.seq > at && e.msgType >= 4);
  const events = [eventOf(msgs[act], 'server_activate')];
  if (state) events.push(eventOf(state, 'initial_client_state'));
  if (binary) events.push(eventOf(binary, 'first_role_binary_data'));
  if (!state) return verdict(events, 'no client/state followed the first server/activate');
  if (!binary) return verdict(events, 'the server sent no role binary data, so the ordering was not exercised');
  if (binary.seq < state.seq) return verdict(events, 'the server sent role binary data before the client\'s initial client/state');
  return verdict(events, null, 'the initial client/state preceded the first role binary data');
}

function judgePlayerStream(trace, hello) {
  const advertised = hello?.['player@v1_support']?.supported_formats ?? [];
  const start = trace.playerStreamStarts[0]?.payload.player ?? null;
  const negotiated = start ? { codec: start.codec, sample_rate: start.sample_rate, channels: start.channels, bit_depth: start.bit_depth } : null;
  const events = [{ event: 'stream_start_observed', negotiated_format: negotiated, advertised_formats: advertised }];
  if (!negotiated) return verdict(events, 'no stream/start with a player object was observed');
  const listed = advertised.some((f) => f.codec === negotiated.codec && f.sample_rate === negotiated.sample_rate
    && f.channels === negotiated.channels && (f.codec === 'opus' || f.bit_depth === negotiated.bit_depth));
  if (!listed) return verdict(events, 'the stream/start format is not one client/hello lists');
  const ts = trace.chunkTimestamps();
  if (!ts.length) return verdict(events, 'no audio chunks were observed after stream/start');
  events.push({ event: 'audio_chunks_observed', chunk_count: ts.length, first_timestamp_us: ts[0], last_timestamp_us: ts.at(-1) });
  const back = ts.findIndex((t, i) => i > 0 && t < ts[i - 1]);
  if (back > 0) return verdict(events, `audio chunk ${back + 1} is timestamped before the chunk ahead of it`);
  return verdict(events, null, `selected an advertised format and sent ${ts.length} audio chunks in timestamp order`);
}

function protocolEvidence(trace) {
  const msgs = trace.messages;
  const act = msgs.findIndex((m) => m.dir === 'out' && m.type === 'server/activate');
  const hello = trace.clientHello?.payload ?? null;
  return {
    spec_revision: SPEC_REVISION,
    assertions: {
      'CORE-001': judgeHandshake(msgs),
      'CORE-002': judgeNothingBeforeActivation(trace, msgs, act),
      'CORE-003': judgeActivatedRoles(hello, msgs, act),
      'CORE-004': judgeInitialState(trace, msgs, act),
      'PLAYER-001': judgePlayerStream(trace, hello),
    },
  };
}

async function driveScenario({ args, scenario, rooms, roomId, target, deadline, clip, trackItem, commands, tracer }) {
  if (PLAYER_SCENARIOS.has(scenario)) {
    await waitFor('the client to report available: true with its player state', () => target.state?.available && target.playerStateReceived, deadline);
    const ended = new Promise((resolve, reject) => {
      rooms.on('ended', (id) => id === roomId && resolve());
      rooms.on('error', (err) => err.roomId === roomId && reject(err));
    });
    rooms.play(roomId, { items: [{ filepath: 'clip.wav', file: clip.file, meta: { title: args.metadata_title, durationMs: clip.durationMs } }] });
    const deadlineLeft = deadline - Date.now();
    await Promise.race([ended, sleep(deadlineLeft).then(() => { throw new Error('the room did not reach the end of the clip before the deadline'); })]);
    await sleep(SETTLE_MS);
  } else if (METADATA_SCENARIOS.has(scenario)) {
    await waitFor('the client to report available: true', () => target.state?.available, deadline);
    rooms.play(roomId, { items: [trackItem], positionMs: Number(args.metadata_track_progress) });
    await sleep(1500);
  } else if (CONTROLLER_SCENARIOS.has(scenario)) {
    rooms.setRepeat(roomId, args.controller_repeat);
    rooms.setShuffle(roomId, truthy(args.controller_shuffle));
    await waitFor('a controller command', () => commands.length, deadline);
    await sleep(300);
  } else if (ARTWORK_SCENARIOS.has(scenario)) {
    const sid = () => tracer.socketFor(target.clientId);
    await waitFor('an album image written on artwork channel 0', () => new ConnectionTrace(tracer.log, sid()).artworkImages(0).some((i) => i.image.length && i.written), deadline);
    await sleep(SETTLE_MS);
  }
}

function scenarioEvidence({ args, scenario, trace, clip, commands, payloadSizes }) {
  const scenarioOut = {};
  if (PLAYER_SCENARIOS.has(scenario)) {
    const sent = trace.sentAudio();
    const stream = trace.stream;
    scenarioOut.stream = stream;
    scenarioOut.audio = {
      fixture: args.fixture, source_flac_sha256: clip.sourceFlacSha256, source_pcm_sha256: clip.sourcePcmSha256,
      sent_codec_header_sha256: stream?.codec_header_sha256 ?? null, sent_encoded_sha256: sent.sha256,
      sent_audio_chunk_count: sent.count, sent_encoded_byte_count: sent.bytes, clip_seconds: Number(args.clip_seconds),
      sample_rate: clip.sampleRate, channels: clip.channels, bit_depth: stream?.bit_depth ?? 16, frame_count: clip.frameCount,
      duration_seconds: clip.frameCount / clip.sampleRate, frame_alignment_samples: null, trimmed_source_frames: 0,
    };
    if (scenario === 'server-initiated-audio-chunk-framing') {
      scenarioOut.audio.sent_chunk_frames = trace.chunkFrames(payloadSizes);
      scenarioOut.audio.chunked_by = 'implementation';
      scenarioOut.audio.legacy_header_reason = null;
    }
    if (FORMAT_PREFERENCE_SCENARIOS.has(scenario)) scenarioOut.format_preference = { received: trace.lastFormatPreference };
    if (scenario === 'server-initiated-protocol-baseline-v1') scenarioOut.protocol = protocolEvidence(trace);
  } else if (METADATA_SCENARIOS.has(scenario)) {
    scenarioOut.metadata = {
      expected: {
        title: args.metadata_title, artist: args.metadata_artist, album_artist: args.metadata_album_artist, album: args.metadata_album,
        artwork_url: args.metadata_artwork_url, year: Number(args.metadata_year), track: Number(args.metadata_track),
        progress: {
          track_progress: Number(args.metadata_track_progress), track_duration: Number(args.metadata_track_duration),
          playback_speed: Number(args.metadata_playback_speed),
        },
      },
      first_state_sent: trace.firstMetadataStateSent(),
    };
  } else if (CONTROLLER_SCENARIOS.has(scenario)) {
    const ctl = trace.lastControllerState();
    if (!ctl) throw new Error('the server never sent a controller state');
    scenarioOut.controller = {
      expected_command: { command: args.controller_command }, received_command: commands[0] ?? null,
      supported_commands: [...ctl.supported_commands].sort(), volume: ctl.volume, muted: ctl.muted, repeat: ctl.repeat, shuffle: ctl.shuffle,
    };
  } else {
    const images = trace.artworkImages(0).filter((i) => i.image.length);
    const image = images.at(-1)?.image ?? null;
    scenarioOut.artwork = {
      channel: 0, source: 'album', format: args.artwork_format.toLowerCase(), width: Number(args.artwork_width), height: Number(args.artwork_height),
      encoded_sha256: image ? sha256(image) : null, byte_count: image?.length ?? 0, images_sent: images.length,
    };
  }
  return scenarioOut;
}

async function main() {
  const args = { ...DEFAULTS, ...parseArgs(process.argv.slice(2)) };
  for (const k of ['summary', 'ready', 'registry', 'fixture', 'client_name']) if (!args[k]) throw new Error(`--${k.replaceAll('_', '-')} is required`);
  const scenario = args.scenario_id;
  const log = logger();
  const timeoutMs = Number(args.timeout_seconds) * 1000;
  const started = Date.now();
  const deadline = started + timeoutMs - ERROR_MARGIN_MS;

  const fail = (reason) => {
    writeJson(args.summary, { status: 'error', implementation: 'velvet', role: 'server', scenario_id: scenario, reason });
    return 1;
  };
  const known = PLAYER_SCENARIOS.has(scenario) || METADATA_SCENARIOS.has(scenario) || CONTROLLER_SCENARIOS.has(scenario) || ARTWORK_SCENARIOS.has(scenario);
  if (!known) {
    writeJson(args.ready, { status: 'error' });
    return fail(`Harness gap, not a protocol result: the Velvet server adapter has no path for scenario ${scenario}`);
  }

  const src = velvetSource();
  const velvetRoot = path.resolve(src, '../..');
  const ffmpeg = process.env.VELVET_FFMPEG || path.join(velvetRoot, 'bin', 'ffmpeg', 'ffmpeg');
  const ffprobe = process.env.VELVET_FFPROBE || path.join(path.dirname(ffmpeg), 'ffprobe');
  const mod = (f) => import(pathToFileURL(path.join(src, f)).href);
  const [{ SendspinServer }, { RoomManager }, { CipherState, publicKeyFromPrivate }, { SendspinConnection }, wire, keys, { TrustStore }, { METHODS }] = await Promise.all([
    mod('server.js'), mod('rooms.js'), mod('noise.js'), mod('connection.js'), mod('wire.js'), mod('keys.js'), mod('trust-store.js'), mod('pairing.js'),
  ]);
  const require = createRequire(path.join(velvetRoot, 'package.json'));
  const { WebSocket } = require('ws');
  const sharp = require('sharp');

  const tracer = installTracer({ CipherState, WebSocket, Reassembler: wire.Reassembler, decodeJson: wire.decodeJson });
  const payloadSizes = new Map();
  const origSendAudio = SendspinConnection.prototype.sendAudioChunk;
  SendspinConnection.prototype.sendAudioChunk = function sendAudioChunk(ts, frame) {
    const key = BigInt(ts);
    payloadSizes.set(key, payloadSizes.has(key) ? null : frame.length);
    return origSendAudio.call(this, ts, frame);
  };

  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'velvet-conformance-'));
  // Same deterministic identity and long-term PSK the harness's aiosendspin
  // adapters derive from the shared ids, so a pre-paired client takes the lt path.
  const serverPriv = seeded(`sendspin-conformance-identity:server:${args.server_id}`);
  const serverPub = publicKeyFromPrivate(serverPriv);
  writeJson(path.join(dataDir, 'server-key.json'), { privateKey: keys.encodeKeyId(serverPriv), publicKey: keys.encodeKeyId(serverPub) });
  const clientKeyId = keys.encodeKeyId(publicKeyFromPrivate(seeded(`sendspin-conformance-identity:client:${args.client_id}`)));
  const seededStore = await TrustStore.open(dataDir);
  await seededStore.storePairing({ clientId: clientKeyId, psk: seeded(`sendspin-conformance-psk:${args.server_id}:${args.client_id}`), method: METHODS.PAIRING_PSK, name: args.client_name });
  await seededStore.flush();

  const server = new SendspinServer({
    dataDir, name: args.server_name, languages: ['en'], host: '127.0.0.1', port: Number(args.port), roles: ALL_ROLES,
    logger: log, discovery: false, allowLoopback: true,
  });
  let rooms = null;
  let target = null;
  let roomId = null;
  const commands = [];
  let clip = null;
  try {
    if (PLAYER_SCENARIOS.has(scenario)) clip = await prepareClip({ ffmpeg, ffprobe, fixture: args.fixture, clipSeconds: Number(args.clip_seconds), dir: dataDir });
    const trackItem = {
      filepath: 'almost_silent.flac', file: args.fixture,
      meta: {
        title: args.metadata_title, artist: args.metadata_artist, album_artist: args.metadata_album_artist, album: args.metadata_album,
        year: Number(args.metadata_year), track: Number(args.metadata_track), durationMs: Number(args.metadata_track_duration),
        artworkUrl: args.metadata_artwork_url,
      },
    };
    rooms = await RoomManager.open(dataDir, {
      ffmpeg, logger: log, setPlayback: (m, on) => server.setPlayback(m.clientId, on),
      artworkFor: (_item, spec) => sharp(artworkSvg(spec.width, spec.height)).resize(spec.width, spec.height, { fit: 'contain', background: '#000' })
        .toFormat(spec.format === 'jpeg' ? 'jpeg' : spec.format, spec.format === 'jpeg' ? { quality: 85 } : {}).toBuffer(),
    });
    server.on('client', (conn, info) => {
      if (!rooms) return;
      const id = rooms.attach(conn);
      if (info.name !== args.client_name || target) return;
      target = conn;
      roomId = id;
      conn.on('command', (cmd) => commands.push(cmd.controller));
      if (ARTWORK_SCENARIOS.has(scenario)) rooms.add(id, [trackItem]);
    });
    server.on('client-removed', (conn) => rooms?.detach(conn.clientId));
    await server.start();
    // Harness policy, as in the aiosendspin adapter's pairing store: every
    // connecting implementation is approved for unpaired access.
    server.trustStore.isApproved = () => true;

    const url = `ws://127.0.0.1:${server.port}/sendspin`;
    if (args.initiator_role === 'client') {
      const reg = readJson(args.registry) ?? {};
      reg[args.server_name] = { url };
      writeJson(args.registry, reg);
    }
    writeJson(args.ready, { status: 'ready', server_id: server.serverId, server_name: args.server_name, scenario_id: scenario, initiator_role: args.initiator_role, url });

    let discovery = 'registry_advertised';
    if (args.initiator_role === 'server') {
      const clientUrl = await waitFor('the client listener in the registry', () => readJson(args.registry)?.[args.client_name]?.url, deadline);
      server.connectTo(clientUrl, { source: 'registry' });
      discovery = 'registry_fallback';
    }
    await waitFor(`client ${args.client_name}`, () => target, deadline);

    await driveScenario({ args, scenario, rooms, roomId, target, deadline, clip, trackItem, commands, tracer });

    const clientId = target.clientId;
    await server.stop();
    await rooms.close();
    rooms = null;
    const trace = new ConnectionTrace(tracer.log, tracer.socketFor(clientId));
    writeJson(path.join(path.dirname(args.summary), 'server-trace.json'), trace.entries.map(({ data, ...e }) => (
      data ? { ...e, dataBytes: data.length } : e)));
    const hello = trace.clientHello;

    const scenarioOut = scenarioEvidence({ args, scenario, trace, clip, commands, payloadSizes });

    const summary = {
      status: 'ok', implementation: 'velvet', role: 'server', server_id: server.serverId, server_name: args.server_name,
      scenario_id: scenario, initiator_role: args.initiator_role, preferred_codec: args.preferred_codec, discovery_method: discovery,
      peer_hello: hello ? { type: 'client/hello', payload: hello.payload } : null,
      activation: trace.activation, group_updates: trace.groupUpdates, availability_trace: trace.availabilityTrace,
      time_exchange: trace.timeExchange,
      client: { client_id: clientId, name: hello?.payload?.name ?? null, supported_roles: hello?.payload?.supported_roles ?? [], active_roles: trace.activation?.payload?.active_roles ?? [] },
      elapsed_ms: Date.now() - started, clock_us: nowUs(),
      ...scenarioOut,
    };
    writeJson(args.summary, summary);
    process.stdout.write(fs.readFileSync(args.summary, 'utf8'));
    return 0;
  } catch (err) {
    log.error(err.stack ?? String(err));
    return fail(err.message);
  } finally {
    if (rooms) await rooms.close().catch(() => {});
    await server.stop().catch(() => {});
    if (!process.env.VELVET_ADAPTER_KEEP) await fsp.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().then((code) => process.exit(code), (err) => {
  process.stderr.write(`${err.stack ?? err}\n`);
  process.exit(1);
});
