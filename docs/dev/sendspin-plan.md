# Velvet Rooms — Sendspin server: plan and progress log

Branch `feat/sendspin`, worktree `/home/velvet-work/sendspin`. Never merged to
`main` before the owner has validated it. Production (`/home/velvet`) is not
touched.

## Goal

Velvet acts as a **Sendspin server** (spec RC1, protocol version 1): it finds
Sendspin speakers on the LAN, lets the admin approve or pair them, groups them
into rooms, and plays a server-side queue to a room in sample-accurate sync.
Speakers with buttons control the queue; displays get metadata, artwork and
colours. Product name: **Velvet Rooms** ("works with Sendspin speakers" — the
trademark rules forbid "Sendspin" as our own product name).

## References (local, read these, not the web)

- Spec: `/home/velvet-work/sendspin-ref/spec/` — `README.md` (core),
  `connection.md`, `messaging.md`, `pairing.md`, `roles/<role>/v1.md`.
- Reference server + client (Python, Apache-2.0):
  `/home/velvet-work/sendspin-ref/aiosendspin/aiosendspin/` — `noise/`,
  `server/`, `client/`.
- Clock filter: `/home/velvet-work/sendspin-ref/time-filter/`.
- Implementation guide (non-normative, read before UI or server-policy work):
  `/home/velvet-work/sendspin-ref/website/src/build/guide/` — `server/index.md`
  (server step by step), `server/ux.md` (device states and flows),
  `pairing-and-encryption.md`, `testing.md`, `concepts.md`.
- Conformance harness: `/home/velvet-work/sendspin-ref/conformance/`
  (`adapters/README.md` describes the server-adapter contract).
- Test tools: venv `/home/velvet-work/sendspin-venv` (Python 3.13) with
  `aiosendspin` (editable) and the `sendspin` CLI. A headless test speaker:
  `sendspin daemon --name T1 --port 8930 --settings-dir /tmp/ss-T1 --unpaired-access true`
  (advertises `_sendspin._tcp`; add `--url ws://127.0.0.1:8927/sendspin` for
  client-initiated mode).

## Architecture

All new server code lives in `src/sendspin/` (ESM, Node 24, no new native
deps). REST glue in `src/api/sendspin.js`. Config under
`config.program.sendspin`. Persistent state under `save/sendspin/`
(server static key, trust store / pairing records, device names, rooms).

| Module | Responsibility | Phase |
|---|---|---|
| `src/sendspin/noise.js` | Noise `KKpsk2`, both suites (`25519_ChaChaPoly_SHA256`, `25519_AESGCM_SHA256`), server = initiator; transport CipherStates; re-handshake | 0 |
| `src/sendspin/wire.js` | App framing inside Noise: byte 0 = message type; JSON (0); fragmentation (1) + reassembly; binary builders for audio (4), artwork (8–11), visualizer (16–20) | 0 |
| `src/sendspin/keys.js` | Server static key (generate once, persist), `client_id`/`server_id` encoding, `psk_id`, Sentinel PSK, trust store | 0 / 3 |
| `src/sendspin/connection.js` | One connection: `client/init` → `server/init` → handshake → `server/hello` / `client/hello` → `server/activate`; dispatch; `server/time` replies; ping/pong; goodbye; timeouts | 0 |
| `src/sendspin/discovery.js` | mDNS: advertise `_sendspin-server._tcp` (8927, TXT `path=/sendspin`, `name`); browse `_sendspin._tcp` and connect out | 1 |
| `src/sendspin/server.js` | Registry of clients, inbound WS listener (8927 `/sendspin`), outbound dialer, admission rules, unpaired-access approval list | 0 / 1 |
| `src/sendspin/audio.js` | Stream engine: ffmpeg decode → PCM; chunker (15–150 ms); FLAC frame encoder; per-format outputs; monotonic µs timeline; gapless track joins; seek | 0 / 1 |
| `src/sendspin/scheduler.js` | Per-group pacing: common send-ahead, `buffer_capacity` accounting, late join, `stream/start` / `clear` / `end` | 1 / 2 |
| `src/sendspin/rooms.js` | Groups (rooms), server-side queue (Server Audio model), group volume/mute algorithm, `switch`, controller commands, metadata, artwork (`sharp`), colour | 1 / 2 |
| `src/sendspin/visualizer.js` | `visualizer@v1`: one analysis per room on the master PCM (FFT, A-weighting, bands, onset curve, beat tracker), per-member types/rate/spectrum, buffer accounting, stream/start/clear/end | 4 |
| `src/sendspin/pairing.js` | CPace (`CPACE-X25519-SHA512`) + the three pairing methods | 3 |
| `src/api/sendspin.js` | REST for admin (devices, approve, pair, rooms) and player (room picker, queue control) | 1 |

Clock: the server is the time base. `now()` = `process.hrtime.bigint() / 1000n`
(monotonic µs). Clients do the filtering; the server only answers
`client/time` with `server_received` / `server_transmitted` and stamps audio.
Stamps (`server_transmitted`, `send_ahead`) are taken as late as possible —
right before encryption.

### Interfaces agreed between modules

```js
// noise.js  (Node crypto only; errors are NoiseError)
export const SUITES = ['25519_ChaChaPoly_SHA256', '25519_AESGCM_SHA256'];
export function generateStaticKeyPair(); // { publicKey: Buffer(32), privateKey: Buffer(32) }
export function publicKeyFromPrivate(privateKey); // -> Buffer(32)
export class NoiseInitiator {
  constructor({ suite, staticKeyPair, remoteStaticPublicKey, prologue /*Buffer*/, psk /*Buffer(32)*/, ephemeralKeyPair? /*tests only*/ });
  writeMessage1(payload /*Buffer*/); // -> Buffer (32-byte e || AEAD(payload))
  readMessage2(message, psk = ctorPsk); // -> payload Buffer; throws NoiseError. A failed read can be
                                        //    retried with SENTINEL_PSK (Sentinel fallback); the PSK that
                                        //    succeeded is then `initiator.psk`.
  handshakeHash;                      // Buffer(32) h, after completion (= prologue of a re-handshake)
  split();                            // -> { send: CipherState, recv: CipherState }
}
export class NoiseResponder {          // client side; tests and future use
  constructor({ suite, staticKeyPair, remoteStaticPublicKey, prologue, ephemeralKeyPair? });
  readMessage1(message);              // -> payload
  writeMessage2(payload, psk);        // -> Buffer
  handshakeHash; split();             // split -> { send, recv }
}
// CipherState: encrypt(plaintext) -> Buffer, decrypt(ciphertext) -> Buffer (throws NoiseError,
//   nonce not advanced on failure), nonce (Number). Max Noise message 65535 enforced both ways.
export function encodeMsg1Payload(pskId, pskCategory); // -> Buffer '{"psk_id":"…","psk_category":"sn"}'
export function parseMsg1Payload(buf);  // -> { pskId, pskCategory } | throws
export const MSG2_PAYLOAD;               // Buffer '{}'
export function parseMsg2Payload(buf);  // -> { canonical } | throws (any JSON object accepted)
export function packHandshake(noiseMsg); // -> '{"payload":{"data":"<b64url>"},"type":"noise/handshake"}'
export function unpackHandshake(text);   // -> Buffer | throws
// keys.js
export function encodeKeyId(publicKey); // base64url, 43 chars, no padding
export function decodeKeyId(id);        // -> Buffer(32), throws TypeError on non-canonical input
export function isKeyId(id);            // -> boolean
export function pskId(psk);             // base64url(SHA-256("sendspin-psk-id-v1" || psk))
export const SENTINEL_PSK, SENTINEL_PSK_ID; // SHA-256("sendspin-sentinel-psk-v1"), its psk_id
export const PSK_CATEGORY = { LONG_TERM: 'lt', PAIRING: 'pr', SENTINEL: 'sn' };
export function generatePsk();          // -> Buffer(32)
export async function loadOrCreateServerKey(dir); // -> { publicKey, privateKey, serverId }; <dir>/server-key.json, 0600
// wire.js  (errors are WireError; µs timestamps are BigInt, Numbers are coerced)
export const MSG = { JSON: 0, FRAGMENT: 1, AUDIO: 4, ARTWORK0..3: 8..11, SOURCE_AUDIO: 12,
                     VIS_LOUDNESS: 16, VIS_BEAT: 17, VIS_F_PEAK: 18, VIS_SPECTRUM: 19, VIS_PEAK: 20 };
export const MAX_PLAINTEXT /*65519*/, MAX_PAYLOAD /*65518*/;
export function frame(type, payload);                      // -> Buffer [type][payload]
export function fragment(plaintext);                       // -> [Buffer] (one entry if it fits); encrypt
                                                           //    and send ALL entries back to back before any
                                                           //    other binary message (one-in-flight rule)
export function encodeJson(obj);                           // -> [Buffer] (fragmented if needed)
export function decodeJson(payload);                       // -> object with type string + payload object | throws
export function encodeAudioChunk(timestampUs, sendAheadUs, frame); // -> Buffer (13-byte header; NOT fragmented,
                                                           //    pass through fragment()); sendAhead <0 -> 0, >2^32-1 -> 2^32-1
export function decodeAudioChunk(buf), decodeSourceAudio(buf);
export function encodeArtworkAnnounce(channel, timestampUs, totalSize), encodeArtworkPart(channel, data),
                encodeArtworkParts(channel, image, partSize?) /* -> [Buffer], each <= 65519 */, encodeArtworkCancel(channel);
export function encodeVisLoudness(ts, v), encodeVisBeat(ts, downbeat), encodeVisFPeak(ts, hz, amp),
                encodeVisSpectrum(ts, bins), encodeVisPeak(ts, strength);
export class Reassembler { constructor({ maxBytes = 64 MiB }); push(plaintext) /* -> { type, payload } | null; throws WireError -> close */; inFlight }
// audio.js  (decode once to a "master" PCM = s32le interleaved at the group's master rate/channels,
//            then one encoder per distinct player format; every function takes ffmpeg? = ffmpegBin())
// format = { codec: 'pcm'|'flac', sample_rate, channels, bit_depth: 16|24 }
//        | { codec: 'opus', sample_rate: 8000|12000|16000|24000|48000, channels: 1|2 }  (bit_depth ignored; stream/start sends 16)
// chunk  = { frame: Buffer, samples, startUs, durationUs }   startUs = baseUs + exact µs of the chunk's first
//          sample on the encoder's own sample counter; consecutive chunks are contiguous (no drift, no gaps)
export const MASTER_BYTES_PER_SAMPLE /*4*/, MIN_CHUNK_MS /*15*/, MAX_CHUNK_MS /*150*/, DEFAULT_CHUNK_MS /*{pcm:25,flac:50,opus:20}*/,
             OPUS_SAMPLE_RATES, OPUS_FRAME_MS /*[20,40,60]: largest <= chunkMs*/;
export function samplesToUs(samples, sampleRate);       // exact integer floor, safe for days of audio
export class Timeline { constructor(sampleRate, baseUs = 0); usAt(sample); nowUs; sample; advance(n) /* -> { startUs, durationUs } */ }
export function createDecoder({ file, startMs = 0, sampleRate, channels, signal, ffmpeg });
//  -> { pid, exited /*Promise*/, close(), [Symbol.asyncIterator] }  yields master PCM Buffers (whole frames);
//     pull-based (backpressure = stop iterating); throws 'ffmpeg decode failed (…): <stderr>'; abort/close kills ffmpeg
export async function* decodeQueue(tracks /*(async) iterable of { file, startMs? }*/, { sampleRate, channels, signal, ffmpeg });
//  -> yields { track, pcm, sample /*master index of pcm[0]*/, trackStart /*first buffer of a track*/ } — gapless join
export function createEncoder({ format, inputRate, inputChannels, chunkMs?, baseUs = 0, signal, ffmpeg });
//  -> Encoder { format, chunkSamples, codecHeader /*base64|null, sync*/, samples, endUs, pid? exited?,
//               write(masterPcm) /*Promise, backpressure*/, end(), close(reason?), read() /*-> chunk|null*/, [asyncIterator] }
//     pcm at master rate/channels = in-process repack (no process); otherwise one ffmpeg per encoder
//     (resample + bit depth + FLAC). Output is read eagerly into an in-memory queue, so write() never deadlocks.
export async function pump(pcmSource, encoders);        // feeds a decoder/decodeQueue into N encoders, end()s them; errors close them
export function openTrack({ file, startMs, format, chunkMs, baseUs, signal, ffmpeg }); // -> Encoder (decode at format rate)
export class FlacFramer { push(buf) /* -> [{ frame, samples }] */; end(); }   // splits an ffmpeg `-f flac` stream
export function parseFlacFrameHeader(buf, pos);          // -> { length, blockSize, number, variable } | null | undefined
export function flacCodecHeader({ sampleRate, channels, bitDepth, blockSize }); // -> Buffer 'fLaC' + STREAMINFO (last-block flag)
export function oggCrc(buf);                             // RFC 3533 CRC-32 (poly 0x04c11db7, init 0, unreflected)
export class OggPacketReader { push(buf) /* -> [Buffer packet] */; end(); }  // one logical stream; packets across pages,
//     any byte split; throws on capture pattern/CRC/sequence/continuation/serial/BOS errors, packets > 64 KiB, truncation
export function opusPacketSamples(packet);               // 48 kHz samples from the TOC byte (RFC 6716 §3.1) | null
export function parseOpusHead(packet);                   // -> { channels, preSkip, inputRate } | null
export class OpusDemuxer { head; push(buf) /* -> [{ packet, samples (48 kHz) }] */; end(); }  // drops OpusHead + OpusTags
//  opus encoder: ffmpeg libopus (64k/channel VBR, -application audio, -frame_duration 20) -> -f ogg (-page_duration 20 ms)
//  -> OpusDemuxer -> one raw packet per chunk, codecHeader null. chunk.samples at the format rate. As aiosendspin: the
//  player gets no OpusHead and plays the pre-skip, so the timeline starts at baseUs - preSkip (first chunk startUs < baseUs)
//  and input sample n plays at baseUs + n exactly. createEncoder({ preRoll }) for a cut (splice after stream/clear
//  from_timestamp, format change): the scheduler feeds opusPreRoll(rate) samples of the audio before the cut first
//  (preRoll + pre-skip = one frame), the packet before the cut is dropped, the first kept one starts at the cut exactly
//  (never earlier, spec MUST); the encoder is warm, so only the player's decoder hand-over (2.5 ms CELT overlap) remains.
// pairing.js  (Node crypto only; CPace = CPACE-X25519-SHA512, draft-21, byte-exact with cpace-py)
export const METHODS /*{PAIRING_PSK,DYNAMIC,STATIC}*/, FORMATS /*{DIGITS,QR_CODE}*/, ABORT_REASONS, ROUND_LIMIT /*20*/,
             PAIRING_MESSAGE_TYPES /*Set of client/pair-* + pair/abort*/, TIMEOUTS /*{firstMessageMs 60s, gestureMs 360s, attemptMs 180s}*/,
             COOLDOWN /*{initialMs 2s, maxMs 120s}, doubles per failed round*/, PENDING_MESSAGE_MAX_BYTES /*200*/;
export class PairingProtocolError;   // -> close the WebSocket silently, persist nothing (spec "protocol error")
export class PairingInputError;      // operator input; .code: malformed_token | unsupported_token_version | wrong_client |
                                     //   invalid_code | cooldown (.retryAfterMs) | not_ready. Nothing was sent.
export function decodePskToken(text);        // lenient (trim, upper, optional SP:, 9->2) -> { clientId, clientKey, pairingPsk, pskId }
export function assertTokenForClient(token, clientId); // throws PairingInputError('wrong_client')
export function encodePskToken(clientIdOrKey, psk), encodeCodeToken(code24), decodeCodeToken(text) /* -> Buffer(24) */;
export function parseDigitsCode(input, 6|8), formatCode(code) /* '123-456' / '1234-5678' */;
export function parseSupportedPairMethods(clientHello.supported_pair_methods); // -> { methods: { pairing_psk?: {locations},
                                     //   static_pairing_code?: {locations}, dynamic_pairing_code?: {formats, outChannels} }, ignored: [] }
export function chooseCodeMethod(methods, { canScanQr = false }); // -> { method, format? } | null (dynamic preferred)
export function pairingActivation({ method, format, playback = false, activeRoles }); // server/activate payload
export class Cooldown { constructor({ initialMs, maxMs, now }); fail(); remainingMs(); reset(); failures }
export function createPairingAttempt({ method, format?, suite, handshakeHash /*code methods*/, pairingIndex, clientId,
                                       pairingPsk /*pairing_psk: the matched pairing PSK*/, cooldown?, random?, now? });
//  -> PairingAttempt { state, round, deadline /*ms epoch|null*/, pendingMessage, active, method, format, pairingIndex,
//       activation({ playback, activeRoles }), onMessage(type, payload), submitCode(text), persisted(), cancel(), expire(now?) }
//  Every call returns a step { send: [{ type, payload }], event } (cancel/expire: step | null). event.kind:
//    ignored | pending {message} | started | need_code {round} | code_queued | code_sent {round} |
//    wrong_code {round, retryAfterMs} | confirmed | persist {record: {clientId, psk, pskId, method}} | paired |
//    aborted {reason, by: 'client'|'server'}   (reason 'timeout' = server's own timeout, nothing sent)
//  onMessage throws PairingProtocolError; submitCode throws PairingInputError. Never logs codes or PSKs.
// trust-store.js  (single owner of pairing records, approvals, staged pairing PSKs; <dir>/trust-store.json, 0600, atomic)
export class TrustStore {
  static async open(dir, { file?, now? });
  record(clientId) /* {clientId, psk, pskId, pairMethods, createdAt, updatedAt, name, mismatchAt} | null */; recordByPskId(id);
  listRecords() /* no psk */; isPaired(id); async storePairing({ clientId, psk, method, name? }) /* drops approval + staged */;
  async unpair(id); async markCredentialMismatch(id); async clearCredentialMismatch(id); hasCredentialMismatch(id);
  isApproved(id); approval(id); listApprovals(); async approve(id, { name, roles }) /* false if paired */; async revokeApproval(id);
  stagedPairingPsk(id) /* 24 h */; async stagePairingPsk(id, psk); async unstagePairingPsk(id);
  pskForClient(id) /* -> { psk, pskId, category: 'lt' | 'pr' (staged) | 'sn' } = msg1 PSK selection */;
  trustState(id) /* 'paired' | 'mismatch' | 'approved' | 'unknown' */; async rename(id, name); async flush();
}
// connection.js  (one WebSocket, inbound or outbound; EventEmitter; protocol errors close silently)
export const PROTOCOL_VERSION /*1*/, MAX_WS_PAYLOAD /*65535*/, MAX_CLIENT_HELLO_BYTES /*16384*/, IMPLEMENTED_ROLES, GOODBYE_REASONS;
export class SendspinError;                    // caller broke a spec rule (thrown synchronously, nothing sent)
export function nowUs();                       // BigInt monotonic µs = process.hrtime.bigint() / 1000n
export function negotiateRoles(supportedRoles, helloPayload, implemented?); // first implemented version per family,
                                               //   support object required for player@v1/visualizer@v1; player, controller first
export function unimplementedRoles(supportedRoles, implemented?), parseClientHello(payload), parsePlayerState(obj, player),
                sameFormat(a, b), cleanText(peerString, max?) /* for logs */;
export class SendspinConnection {
  constructor({ ws, identity /*loadOrCreateServerKey()*/, name, languages, direction: 'inbound'|'outbound', url?, remoteAddress?,
                resolvePsk(clientId) /*-> {psk, category}*/, hasPairingRecord(clientId), implementedRoles?, logger?, timeouts? });
  // timeouts: { handshakeMs 30s (per message), helloMs 30s, activateFallbackMs 20s (idle activate if nobody decided), pingMs 30s, pongMs 15s }
  clientId, suite, pskCategory /*'lt'|'pr'|'sn'*/, credentialMismatch, handshakeHash, info /*parseClientHello*/, negotiatedRoles,
  unimplementedRoles, activities, activeRoles, state /*{ available, player: {outputDelayMs, minBufferMs, requiredLeadTimeMs,
  supportedCommands, volume, muted, format}|null, roles }*/, goodbyeReason, direction, url, closed /*Promise*/;
  isActivated, isOpen, isPaired, playbackAllowed, playerStateReceived, activeStreams, bufferedAmount, hasRole(family);
  events: 'hello'(info) -> caller MUST activate() promptly | 'activated'({activities, roles, first}) | 'state'(state, prev) |
          'time'({clientTransmitted, serverReceived, serverTransmitted}) | 'command'({controller}) | 'leave' | 'goodbye'(reason) |
          'message'(type, payload) /* every other JSON type incl. client/pair-*, pair/abort */ | 'close'({code, goodbye,
          handshakeCompleted, activated, activities, durationMs});
  activate({ activities?, roles?, pairing? /*{method, format?}*/ }); // checks the allowed-set table (lt: no pairing; sn/pr:
          //   playback/roles only with unpaired access, never on credential mismatch), pairing method offered + pairing_psk iff 'pr';
          //   sends stream/end first for streams the activation removes; omits active_roles when roles is not passed
  sendJson(type, payload), sendBinary(plaintext) /* -> false while a re-handshake runs */;
  groupUpdate({ playbackState, groupId /*43 b64url*/, groupName }), serverState(obj), serverCommand({ player?, ...app });
  streamStart({ player?, artwork?, visualizer?, ...app }), streamClear({ roles?, fromTimestamp? }), streamEnd(roles?);
          // server_transmitted is stamped immediately before encryption; guards: available, playback, player state, format listed
  sendAudioChunk(timestampUs, frame) /* -> bytes counted for buffer accounting (13 + frame); send_ahead stamped right before
          encryption, saturating; all fragments encrypted+sent synchronously (one fragmented message in flight) */;
  rehandshake({ psk, category, activation, beforeActivate? }) /* -> Promise; activation validated against the new category and
          required stream/end sent BEFORE msg1; msg1/msg2 as encrypted noise/handshake, old-key app messages dropped, keys swapped
          after msg2, pairingIndex reset, beforeActivate() (creates the attempt on the new h), then activate(activation) */;
  pskId, offeredCategory /*msg1 category before a Sentinel fallback*/, pairingIndex, nextPairingIndex(), rehandshaking;
  close(code?, reason?);
}
// server.js
export const DEFAULT_PORT /*8927*/, DEFAULT_PATH /*'/sendspin'*/;
export function reconnectDecision(closeInfo) /* -> 'now' | 'later' | 'never' | 'backoff' */;
export class SendspinServer {          // EventEmitter
  constructor({ dataDir, name, languages, host = '0.0.0.0', port = 8927, path = '/sendspin', roles = ['player@v1'] /*roles we
                activate when allowed*/, logger, maxClients = 64, maxPending = 32, reconnect: { minMs, maxMs, concurrentMs, stableMs },
                timeouts, discovery = false | SendspinDiscovery, allowLoopback = false, cooldown? /*{initialMs, maxMs}, tests*/,
                maxUntrusted = 16, maxPendingPerAddress = 4 /*pre-hello, checked at the HTTP upgrade (503); not applied to
                addresses of paired/approved devices*/, maxUntrustedPerAddress = 4, initTimeoutMs = 5000 /*no client/init → close*/ });
  // host '::' (or any IPv6 bind) also advertises AAAA records for the host's global/ULA addresses
  async start(); async stop();        // stop: stream/end, close 1001 all (1.5 s grace, then terminate), goodbye mDNS,
                                      //   closeAllConnections (half-open sockets), flush the store
  destroy();                          // sync last resort: terminate every socket, no waiting
  serverId, port, name, clients /*Map copy*/, getClient(id), trustStore;
  connectTo(wsUrl, { source }) /* ws:// + path-absolute only; redial per reconnectDecision with exponential back-off */;
  disconnectFrom(wsUrl);
  isApproved(id), approvals, async approve(id, name?) /* TrustStore.approve, activates roles live */, async revoke(id);
  canPlay(id), setPlayback(id, on) /* adds/drops 'playback' (stream/end first) */;
  // pairing (errors are PairingInputError, .code: malformed_token | unsupported_token_version | wrong_client |
  //   method_not_supported | pairing_in_progress | not_connected | no_pairing | invalid_code | cooldown (.retryAfterMs) | not_ready)
  async pairWithToken(token, clientId?) /* -> { result: 'pairing'|'staged', clientId, status } — live: re-handshake to 'pr'
          unless already keyed by that PSK; offline: TrustStore.stagePairingPsk, used at the next handshake */;
  startCodePairing(id, { format = 'digits' | 'qr_code' }) /* -> PairStatus; re-handshakes lt/pr -> Sentinel first */;
  submitPairingCode(id, code) /* -> PairStatus */; cancelPairing(id) /* pair/abort user_cancelled + leave; idempotent */;
  getPairingStatus(id) /* -> PairStatus | null (terminal states readable 60 s) */;
  // PairStatus = { status: 'waiting'|'pending'|'need_code'|'wrong_code'|'paired'|'aborted', method, format, digits /*6|8|null*/,
  //   round, retryAfterMs, message /*device text, plain*/, reason /*pair/abort reason | timeout | disconnected |
  //   token_rejected | protocol_error | storage_failed*/, deadline /*ms epoch|null*/ }   (field names = docs/API/rooms.md)
  async unpair(id) /* server/unpair if lt-connected, then store.unpair */; async forget(id) /* + revoke, unstage, drop cache */;
  devices() /* -> Device[] */; device(id) /* -> Device */;
  // Device = { clientId, name, deviceInfo: {productName, manufacturer, softwareVersion}, trust /*TrustStore.trustState*/,
  //   connection: 'online'|'offline'|'other-server'|'in-use-elsewhere'|'pairing', unpairedAccess, pairMethods, roles,
  //   address, url /*dial URL if any*/, lastSeen, pairing /*PairStatus|null*/ }  — known-but-offline devices persist in
  //   <dataDir>/known-devices.json (name, deviceInfo, pairMethods, unpairedAccess, address, url, lastSeen, lastGoodbye)
  events: 'client'(conn, info) after the initial activate | 'client-removed'(conn, closeInfo) |
          'credential-mismatch'(conn) | 'state'|'time'|'command'|'leave'|'goodbye'|'message'(conn, ...) /* pairing messages
          are consumed, not re-emitted */ | 'pairing'(id, PairStatus) | 'paired'(id, { method }) | 'unpaired'(id) |
          'discovered'(svc) | 'discovery-lost'(svc);
}
// discovery.js  (own mDNS on node:dgram, no dependency; IPv4 + optional IPv6 multicast (ff02::fb per interface,
//   udp6 failure or no IPv6 → IPv4 only); bounded parser)
export const CLIENT_SERVICE, SERVER_SERVICE, TYPE, MDNS_ADDRESS, MDNS_ADDRESS6, MDNS_PORT;
export function localAddresses(), localAddresses6() /* global/ULA only, no link-local */, ipv6Interfaces();
export function encodePacket({ response, questions, answers, additionals }), decodePacket(buf), parseTxt(strings) /* Map */;
export function isValidPath(p) /* RFC 3986 path-absolute, <= 256 */, isUsableAddress(addr, { allowLoopback }), buildUrl(addr, port, path);
export class SendspinDiscovery {     // EventEmitter
  constructor({ browse = CLIENT_SERVICE | null, transport? /*tests*/, logger, allowLoopback = false, addresses?, subnets?,
                addresses6?, interfaces6? });
  async start(); advertise({ instance, port, path, name, service = SERVER_SERVICE, ipv6 = false /*AAAA records*/ });
  query(); handlePacket(buf, rinfo); async stop();
  // dials IPv4 when offered, else an on-link global/ULA IPv6 as ws://[addr]:port/path; link-local IPv6 never dialed
  instances; events: 'found'(svc, prevUrl) /* svc = { instance, fqdn, name, url, path, port } */ | 'lost'(svc);
}
// scheduler.js  (server clock = serverNow(): Number µs = process.hrtime.bigint() / 1000n; BigInt only at sendAudioChunk)
export function serverNow();
export function producible(format);      // pcm|flac, 16|24 bit, 1|2 ch, 8–192 kHz
export function negotiateFormat(member); // state.player.format if producible and listed, else the first producible
                                         //   supported_formats entry, else null (member cannot join)
export function memberLeadUs(member);    // (max(min_buffer, min(required_lead, 10 s), 50 ms) + output_delay) * 1000
export class GroupStream extends EventEmitter {
  constructor({ now = serverNow, ffmpeg, logger, masterRate?, chunkMs?, readAheadMs = 15000, lowWaterMs = 2000,
                safetyMs = 50, joinMarginMs = 150 });
  addMember(member);           // -> false when no producible format; while playing = late joiner (stream/start, future only)
  removeMember(clientId, { end = true });  // stream/end player for that member only
  memberChanged(clientId);     // call on every client/state: new format -> in-place stream/start, contiguous timeline
  play(tracks);                // (async) iterable of { file, startMs?, gainDb?, ...own fields }, pulled one track ahead;
                               //   while playing it is a seek/jump: stream/clear + new timeline
  replaceUpcoming(makeTail);   // queue edit while playing: makeTail(anchorTrack, atUs|null) -> new tracks after anchor,
                               //   called synchronously. Cut = first decoded boundary >= now + sendAhead + 200 ms: history
                               //   truncated there, each member re-encoded from its first sent chunk reaching the cut
                               //   (stream/clear from_timestamp = that chunk's ts, only if such a chunk was sent), decode
                               //   restarts at the cut on the same timeline. No decoded boundary yet -> the swap happens at
                               //   the next track start of the running decode (no stream command). -> false if nothing decoded
  stop();                      // stream/end player for all; -> position() taken just before
  close();
  position();                  // { track, positionMs, atUs, audibleAtUs } | null
  playing; t0; masterRate; sendAheadUs; has(id); formatOf(id); stats();
  // events: 'track' { track, timestampUs /*audible*/, first }, 'ended', 'error' (err; already stopped),
  //         'member-error' (clientId, err; that member dropped, the others play on)
}
// rooms.js
export class RoomError;               // .code: 'not_found' | 'invalid' | 'empty'  (REST: 404 / 400 / 409)
export function groupVolumes(volumes, target); // spec delta/clamp/redistribute loop -> rounded per-player volumes
export class RoomManager extends EventEmitter {
  static async open(dir, { ffmpeg, logger, now, setPlayback(member, on) /* -> true when activated */,
                           artworkFor(item, channelSpec) /* -> Buffer|null sized+encoded for the channel; may be async */,
                           colorFor(item) /* -> { primary?, accent?, background_dark?, ... } | null; may be async */,
  // master PCM tap (visualizer): 'epoch' { rate } (play: new timeline at sample 0), 'pcm' (item { track, pcm, sample,
  //   trackStart } — every master sample once, before any member is fed), 'cut' (sample; replaceUpcoming truncated there),
  //   'pcm-end' (decode done), 'stop'. Audible time of master sample s = t0 + samplesToUs(s, masterRate).
                           idleGraceMs = 10000, initialUnavailableGraceMs = 5000, random, streamOptions });
// visualizer.js  (no deps; FFT in plain JS)
export const VIS_TYPES, RATE_MAX_CAP /*60*/, MAX_DISP_BINS /*1024*/, LEAD_MS /*500*/;
export function streamConfig(clientStateVisualizer); // stream/start object: subset of types, rate_max capped, tracks_downbeats:
                                                     //   false iff beat, spectrum echoed (omitted when > 1024 bins or f_max <= f_min)
export function canVisualize(member);  // available, visualizer role, client/state visualizer object, hello buffer_capacity
export function trackBpm(track);       // track.bpm ?? item.bpm ?? item.meta.bpm (30–300) -> tempo prior, else null
export class FFT, BeatTracker, Analyser; export function bandEdges(n, scale, fMin, fMax), aWeightDb(f), dbScale(ratio);
export class RoomVisualizer {          // one per GroupStream (RoomManager creates it with the stream)
  constructor(stream, { now, logger, leadMs = 500, tickMs = 20, joinMarginMs = 50 });
  addMember(member) /* idempotent; playing -> stream/start + frames from now + 50 ms */; removeMember(id, { end = true });
  memberChanged(id) /* new request -> in-place stream/start */; has(id); stats(); close();
}
// Member additions: info.visualizer = { bufferCapacity } (hello), state.roles.visualizer = parseVisualizerState(),
//   sendBinary(visualizer frame) only while activeStreams has 'visualizer'.
                           // <dir>/rooms.json (0600, atomic, debounced 250 ms)
  attach(member) /* -> roomId */; detach(clientId); roomOf(clientId); listRooms(); getRoom(id);
  createRoom(name, clientIds) /* -> id */; renameRoom(id, name); setMembers(id, clientIds); deleteRoom(id);
  play(id, { items?, index = 0, positionMs = 0, paused = false }) /* no items = resume / last played; paused: load queue
          + position, stream/end if it was playing, never stream/start */;
  add(id, items, { next = false }) /* next: insert after the current track (array + shuffle order); while playing the
          read-ahead tail is replaced via GroupStream.replaceUpcoming, the current track is never cleared */;
  jump(id, index) /* play entry from 0 ms: stream/clear + new timeline, shuffle order kept, no queue change */;
  forget(clientId) /* drop its client record, its empty solo room(s) and its seat in named rooms; still connected ->
          re-attached to a fresh solo room */;
  pause(id); resume(id); stop(id); next(id); previous(id) /* restart when >= 3 s in */; seek(id, ms); seekRelative(id, ms);
  setVolume(id, v) /* -> { clientId: volume } */; setMemberVolume(id, clientId, v); mute(id, bool);
  setMemberMute(id, clientId, bool); setRepeat(id, 'off'|'one'|'all'); setShuffle(id, bool); flush(); close();
  // events: 'change' (roomId), 'ended' (roomId), 'error' (err with .roomId), 'member-error' (roomId, clientId, err)
}
// item = { filepath, file /*absolute, already resolved*/, meta: { title, artist, album_artist, album, year, track,
//          durationMs, artworkUrl? }, gainDb? }   (resolving paths, metadata and gain is the REST layer's job)
// getRoom(id) -> { id, name, named, state, repeat, shuffle, index, positionMs, durationMs, current: { filepath, meta },
//   queueLength, queue: [{ filepath, meta }], order, volume, muted, supportedCommands, lastPlayedAt, queueVersion /*play with
//   items, add, shuffle; persisted*/,
//   members: [{ clientId, name, connected, available, player, volume, muted, volumeSettable, muteSettable, format,
//               streaming, parked }] }   listRooms() = the same without queue/order; solo rooms only while occupied
```

### Member interface (scheduler.js / rooms.js ↔ connection.js)

`SendspinConnection` satisfies it as-is (no adapter); the tests use a fake with
the same shape (`test/helpers/sendspin-fake-member.mjs`). What the core reads/calls:

- Read: `clientId`, `info.name`, `info.player = { supportedFormats, bufferCapacity }`,
  `state = { available, player: { volume, muted, outputDelayMs, minBufferMs,
  requiredLeadTimeMs, supportedCommands, format }, roles: { artwork } }`,
  `activities`, `activeRoles`, `activeStreams`, `isOpen`, `playerStateReceived`,
  `hasRole(family)`.
- Call: `activate({ activities })` only through the injected `setPlayback` (wire
  `(m, on) => server.setPlayback(m.clientId, on)`), `streamStart({ player } | { artwork })`,
  `streamClear({ roles })`, `streamEnd(roles)`, `sendAudioChunk(tsBigInt, frame)`,
  `sendBinary(buf)` (artwork), `serverState(obj)`, `serverCommand({ player })`,
  `groupUpdate({ playbackState, groupId, groupName })`. A throw drops only that member.
- Listen: `state(next, prev)`, `command({ controller })`, `leave`, `activated`
  (a change of `activeRoles`, e.g. approval, re-sends all role state), `close` (detach).

Wiring (orchestrator): `rooms.attach(conn)` on the server's `client` event (also for
unapproved clients: they get their room, roles follow on approval);
`rooms.detach(id)` on `client-removed`. The room manager owns `group_id` /
`group_name`; `server.js` no longer sends its own solo `group/update` at hello.
An initial `available: false` gets `initialUnavailableGraceMs` before the speaker
is parked, because the reference daemon reports unavailable until its clock syncs.

### Pairing integration contract (connection.js / server.js)

- **Store wiring (done in `server.js`).** `SendspinServer` opens `TrustStore` on
  its `dataDir` and passes `resolvePsk = store.pskForClient` and
  `hasPairingRecord = store.isPaired` to every connection; approvals live only
  in the store (`devices.json` was never shipped, no migration). A `lt`
  handshake → `clearCredentialMismatch`; a mismatch → `markCredentialMismatch`
  (the record is never deleted on that signal).
- **pairing_index.** Per connection: reset to 0 after every (re-)handshake;
  `++` right before sending each pairing `server/activate`; pass the new value
  to `createPairingAttempt`. One attempt per connection at a time.
- **Pairing PSK (token).** Admin enters a token → `decodePskToken`. If the
  client is connected: `assertTokenForClient(token, conn.clientId)`; if the
  matched PSK is not that pairing PSK, `conn.rehandshake({ psk, category: 'pr',
  activation: attempt.activation() })` first (the activation after a
  re-handshake is the pairing one). If not connected (Windows client dials in
  later): `store.stagePairingPsk(token.clientId, token.pairingPsk)`; the next
  handshake then uses it (`pskForClient` → `pr`) and the connection starts a
  `pairing_psk` attempt right after `client/hello` (no `client/pair-pending`
  in this method). Never put the token or PSK in logs.
- **Code methods.** Need a Sentinel-keyed session: on a `lt` (or `pr`)
  connection, re-handshake to `SENTINEL_PSK`/`sn` first (pairing is not an
  allowed activity under a long-term PSK; a paired connection stops playback
  first). Pick with `chooseCodeMethod(parseSupportedPairMethods(...).methods)`.
- **Activation.** `attempt.activation({ playback, activeRoles })`:
  `['pairing']` with `active_roles: []`, or `['playback','pairing']` keeping
  roles when the connection is playback-capable (unpaired access approved).
  `activate({ activities, roles, pairing })` accepts and validates the
  `pairing` object. Pairing messages arrive on the connection's `'message'`
  event (dropped before the initial activate).
- **Routing.** Every inbound JSON whose type is in `PAIRING_MESSAGE_TYPES` goes
  to `attempt.onMessage(type, payload)` while an attempt exists (also after it
  ended: it returns `ignored`); with no attempt since the handshake, drop it.
  Send `step.send` in order. Handle `step.event`:
  - `pending` → UI shows `message` as plain text attributed to the device.
  - `need_code` / `wrong_code` → UI asks for the code (`wrong_code`: "did not
    match", honour `retryAfterMs`); REST calls `attempt.submitCode(text)`.
  - `persist` → `await store.storePairing(record)` **then**
    `attempt.persisted()` → send `server/pair-finalize` → then
    `conn.rehandshake({ psk: record.psk, category: 'lt', activation })` with the
    post-pairing activities (playback only if wanted). If the store write
    fails: close the connection (nothing acked).
  - `aborted` → unless `reason === 'concurrent_attempt'` (client closes), send
    a leave `server/activate` without `pairing` (previous activities minus
    `pairing`). `cancel()` already put `pair/abort user_cancelled` in `send`.
  - `PairingProtocolError` thrown → close the WebSocket without any message.
- **Timers.** The connection arms one timer for `attempt.deadline` (re-read it
  after every step); on expiry call `attempt.expire()` and handle the
  `aborted` step (leave activate, no `pair/abort`). Keep one `Cooldown` per
  `client_id` in the server across attempts (static window failures).
- **Unpair.** `server/unpair` on the connection, then `store.unpair(id)`.

### Rules from the implementation guide (binding for this branch)

- **Discovery:** browse `_sendspin._tcp` and connect to every client found
  (server-initiated is the default), and advertise `_sendspin-server._tcp`
  on 8927 with TXT `path` for client-initiated devices and test tools.
- **Identity:** the server key pair is generated once; it is part of Velvet's
  backup/restore set (`src/api/backup.js`). A new key means every device must
  pair again.
- **Hello:** `server/hello` carries the operator's languages (Velvet's UI
  language). Count roles/versions a client offers that we do not implement.
- **Activities:** `playback` only while we play on that client, `pairing` only
  during an attempt, otherwise empty. Drop `playback` as soon as the music
  stops, so another server can use the device.
- **Streams:** encode per client. The whole queue is one continuous stream per
  client; a track change never ends the stream. Seek or jump = `stream/clear`,
  never `stream/end`. A client that changes its `format` preference mid-stream
  gets a new `stream/start` when the format changes.
- **Timing:** first chunk after start/clear at least `min_buffer_ms +
  output_delay_ms` ahead, extended toward `required_lead_time_ms` for library
  tracks. Group send-ahead = max over members, recomputed on join/leave/timing
  update; debounce client timing updates. Fill toward `buffer_capacity`.
- **Metadata/artwork/colour:** send current state on activation; send the
  current image on every channel when an artwork stream starts; next-track
  state goes out with a future timestamp, ≤ 20 s ahead (when the next track
  enters the stream). Pace artwork parts between audio chunks.
- **Controller:** `play` with nothing queued resumes what the group last
  played, and that history survives a restart. Group volume per the spec's
  delta-and-redistribute algorithm; a player that reports volume without the
  `volume` command is shown read-only.
- **Availability:** `available: false` or `client/leave` → remember the
  previous group, park the client in a stopped solo group, end its streams,
  send `group/update`. Never pull it back automatically.
- **Reconnect:** reconnect on `restart` and after a silent drop; never on
  `another_server`, `user_request`, `shutdown`, `unpaired`,
  `pairing_required`; retry later on `concurrent_attempt`; exponential
  back-off on repeated handshake failures.
- **UX states (admin device list):** unknown (approve / pair), approved
  (pair as upgrade, revoke), paired (unpair), pairing in progress (code entry
  one slot per digit `123-456` / `1234-5678`, waiting, wrong code, device
  message shown verbatim as plain text, own timeout, cancel → `pair/abort
  user_cancelled`), credential mismatch (warning + re-pair, never silent
  fallback), playing from another server, in use elsewhere (unavailable,
  parked), offline. Name + manufacturer/model from `device_info`; a new device
  with a familiar name must look different from the known one.
- **Never interrupt playback** for rename, regroup or volume — a regroup is a
  `group/update` + new stream, not a reconnect.
- **Pairing PSK / tokens:** API or advanced settings only, never in the
  code-entry screen; decode tokens leniently (trim, uppercase, optional `SP:`,
  read `9` as `2`) and check the token's client key against the connection.
- **Before shipping:** conformance suite passes; tested against
  `sendspin-cpp-cli`, an ESPHome device and `sendspin-js` in a browser
  (the last two need the owner's hardware/browser).

### Licensing and naming (from sendspin-audio.com/licensing, spec LICENSE/TRADEMARKS/SCOPE)

- **Spec:** Community Specification License 1.0 — royalty-free copyright and
  patent licence for implementations. The patent grant only reaches
  licensees that *accept* it: for a source distribution, by including the
  licence text in the root of the source tree (CSL 2.1.3.1). Action: add
  `COMMUNITY-SPEC-LICENSE-1.0.md` (verbatim copy of `spec/LICENSE.md`) to the
  repo root before release. The alternative, a PR to the spec's
  `NOTICES.md`, is an outward action for the owner to decide.
  Implementations need no attribution (CSL 1.2).
- **Reference code** (aiosendspin, sendspin-js, sendspin-cpp,
  sendspin-server-cpp, python-cli) is Apache-2.0, which is compatible with
  Velvet's GPL-3.0. We implement from the spec; where code is ported from a
  reference implementation, keep its copyright/Apache notice in
  `NOTICE`/the file header. Generated test vectors are data, not ported code.
- **Name and logo** are trademarks of the Open Home Foundation. Allowed
  without permission: stating in plain text that Velvet "implements the
  Sendspin protocol" / "works with Sendspin speakers", naming the protocol in
  docs and code, the mDNS identifiers, and descriptive names like
  "Velvet Rooms — for Sendspin speakers". Not allowed: the Sendspin logo,
  "Sendspin" as our feature's own name, "certified" / "built-in" claims
  (the certification programme is not open yet). UI strings and docs follow
  this.
- **Opus** is outside the spec's patent scope and carries third-party
  patents for products that are sold. Velvet is free software and Opus stays
  optional; PCM and FLAC are mandatory anyway.
- **Out of scope of the spec** (ours to design): queue, content sourcing,
  beat/loudness/spectrum analysis, colour extraction, all UI.
- **Vendor roles:** custom features can be prototyped as `_velvet_…` roles
  (e.g. queue or lyrics) — phase 4 idea, never needed for compatibility.

### Test strategy (from the guide's testing chapter)

- Peers: `sendspin daemon` (python-cli, available here), `sendspin-cpp-cli`
  (reference player; build or installer, to add), aiosendspin's client
  scripted from Python for loops (connect, pair, regroup, disconnect),
  `sendspin-js` in a browser and an ESPHome device (owner).
- Owner's test peers: two Windows PCs with **Sendspin for Windows 3.0.0**
  (github.com/Sendspin/sendspin-windows, MIT, Sendspin 1.0). It connects
  client-initiated (browses `_sendspin-server._tcp` or manual `host:8927`)
  and pairs via **"Show Pairing Token"** → the pairing-PSK flow. So the
  pairing-PSK method (token entry in the admin, lenient decoding) moves
  forward to phase 1/2; CPace code pairing stays in phase 3.
- Multi-server: run `sendspin serve` (python-cli) as a second server on the
  LAN to exercise `another_server` hand-over and "pairing is never
  interrupted".
- Conformance: write a Velvet server adapter (`conformance/adapters/README.md`)
  and run `conformance run --from velvet --to aiosendspin` / `sendspin-cpp`.
- Sync: `sync-test` needs a USB sound card recording two players — owner
  hardware; we log offsets ourselves where possible.
- Pairing drills (phase 3): factory reset while paired (credential mismatch,
  no playback, offer re-pair), six-server eviction, network loss mid-pairing,
  five wrong static codes, server restore from backup keeps pairings, two
  servers fighting.
- Server keeps: identity key pair + pairing records (backed up together) +
  approvals.

## Phases

| # | Content | Done when |
|---|---|---|
| 0 | noise + wire + keys + connection + minimal PCM stream | `sendspin daemon` connects, handshakes with the Sentinel PSK and plays a file sent by Velvet |
| 1 | One room: discovery both ways, admin device list (approve/name/forget), PCM + FLAC, gapless, seek, volume/mute, metadata, artwork, room picker in the player, REST + docs + 12 locales | a queue plays end to end on a test speaker from the Velvet UI |
| 2 | Multi-room: groups UI, common send-ahead, late join, group volume/mute algorithm, `switch`, controller role → queue, colour role, AI DJ "play in room" | two test speakers play one queue in sync; controller commands work |
| 3 | Pairing (CPace, three methods), trust store, conformance adapter | conformance scenarios pass for the Velvet server row |
| 4 | Extras (after owner validation): visualizer (beat from BPM analysis), Opus, source role, Sonos as a room member | — |

Sonos does not speak Sendspin; the one Sonos device is used only to check that
the existing Sonos cast still works (regression).

## Phase 1 design (orchestrator decisions)

**Product model.** A *room* is a Sendspin group with a name and a
server-side queue. Every known speaker starts in its own room (solo group,
named after the device). Rooms with several speakers are created by the user.
Sending music to a room hands the queue over to the server (like Sonos / Music
Assistant): the room keeps playing when the browser closes, and the browser
becomes a remote for that room. This differs from Server Audio and Sonos cast,
where the browser queue stays authoritative — Sendspin needs a server-side
queue because speakers send `next`/`previous`/`play` themselves.

**Modules.**
- `src/sendspin/scheduler.js` — `GroupStream`: one master decode
  (`decodeQueue` over the room queue from index + position) at a fixed master
  rate per stream (48 kHz, or 44.1 kHz when every member prefers it), one
  encoder per member in the member's negotiated format, pacing loop that
  fills each member toward `buffer_capacity` (header + payload accounting per
  spec) with timestamps `T0 + chunk.startUs`, where `T0 = now + sendAhead`
  and `sendAhead` = max over members of `min_buffer_ms + output_delay_ms`,
  extended toward `required_lead_time_ms` (library content). Late joiner:
  encoder created at the current master position, future timestamps only.
  Seek / jump: `stream/clear` + new decode. Pause: stop + clear, keep
  position; resume = new timeline. Track boundaries emit events used for
  metadata/artwork scheduled updates (≤ 20 s ahead). Format preference change
  → new encoder + `stream/start` at the boundary (`baseUs = old.endUs`).
- `src/sendspin/rooms.js` — `RoomManager`: rooms (id, name, members,
  queue `[{ filepath, meta }]`, index, positionMs, state, repeat, shuffle),
  persisted in `save/sendspin/rooms.json` incl. "last played" so `play` on an
  idle room resumes after a restart; solo-group parking on
  `available:false` / `client/leave`; `switch` cycle; group volume/mute
  algorithm; controller state + commands; `group/update`; metadata/artwork/
  colour state. Activities: `playback` only on members of a playing room.
- `src/api/sendspin.js` — REST (all behind auth; player routes need
  `allow-mpv-cast`, admin routes need admin):
  - admin: `GET /api/v1/admin/sendspin/status` (enabled, server id, port,
    devices with state: unknown/approved/paired/pairing/mismatch/
    other-server/in-use-elsewhere/offline), `POST …/devices/approve|revoke|
    rename|forget|connect`, `POST …/devices/pair-token` (pairing PSK),
    later `…/pair-code`; `POST …/settings` (enable, name, port).
  - player: `GET /api/v1/rooms` (rooms + members + live state),
    `POST /api/v1/rooms` (create from speakers), `PATCH /api/v1/rooms/:id`
    (rename, members), `DELETE /api/v1/rooms/:id`,
    `POST /api/v1/rooms/:id/play` `{ songs: [filepath], index, positionMs }`,
    `…/add`, `…/pause`, `…/resume`, `…/next`, `…/previous`, `…/seek`,
    `…/volume` (group or per speaker), `…/mute`, `…/stop`, `…/repeat`,
    `…/shuffle`, `GET /api/v1/rooms/:id/state` (polled by the remote UI, ~1 s).
- Velvet glue: `config.program.sendspin` (`enabled` false by default, `name`,
  `port` 8927, `bind`), boot/stop in `src/server.js`, server key + trust store
  in the backup set (`src/api/backup.js`), file paths resolved through the
  user's vpaths (`src/util/vpath.js`, same rules as Server Audio — never a
  raw join), ReplayGain applied in the master decode (`resolveTrackGain`),
  metadata from the DB, artwork from the album-art cache resized with `sharp`
  (fit inside, black padding, never crop), colour from the artwork palette
  (WCAG 4.5:1 checked).
- UI: admin page **Velvet Rooms** (`webapp/admin/`) with the device list and
  its eight states, approve/pair/revoke/rename, rooms editor; player output
  picker gets **Rooms** next to This browser / Server speaker / Sonos; while
  a room is active the player bar and queue panel act as its remote. All
  strings i18n, 12 locales. Docs: `docs/rooms.md` (user), `docs/API.md`,
  `docs/json_config.md`, `docs/docker.md` (host networking for mDNS, port
  8927).

**Order.** (a) scheduler + rooms core with fake-client tests and a daemon e2e;
(b) Velvet glue + REST + backup; (c) admin + player UI; (d) docs, locales,
second test instance on another port for the owner.

## Rules for everyone working on this branch

- Work only in `/home/velvet-work/sendspin`. Never touch `/home/velvet`.
- Project rules from `CLAUDE.md` apply: no comments unless the WHY is
  non-obvious, i18n for every string (12 locales), new endpoints in
  `docs/API.md`, security preflight for inputs.
- Unit tests: `test/sendspin-*.test.mjs` (node:test). They must run without
  Python, network or sound card; cross-implementation vectors are generated
  once from `aiosendspin` and committed as JSON fixtures under
  `test/fixtures/sendspin/`.
- `npm test` and `npx eslint src/sendspin test` must stay green.
- Commit locally with Conventional Commits; never push.

## Progress log

- 2026-11-12 — branch, worktree, reference repos, Python 3.13 venv with
  `aiosendspin` + `sendspin` CLI set up. Plan written.
- 2026-11-12 — phase 0 crypto/framing: `noise.js` (KKpsk2, both suites, Sentinel
  retry, re-handshake via prologue = prior `h`), `wire.js`, `keys.js`; byte-exact
  against aiosendspin vectors (`test/fixtures/sendspin/gen_vectors.py`).
- 2026-11-12 — `audio.js` stream engine: ffmpeg decode → s32le master PCM, per-format
  encoders (PCM 16/24 repack in-process, resample/FLAC via one ffmpeg each; FLAC split
  into whole frames by CRC-8 header + CRC-16 footer + frame-number check), exact µs
  timeline, gapless `decodeQueue`, seek, abort. Lossless round trip verified with ffmpeg
  and aiosendspin's client decoder. ~0.4 % of one core per 44.1k FLAC stream; first chunk
  ~25 ms after open. Opus TODO (phase 4: needs Ogg page parsing or a raw-packet path).
- 2026-11-12 — `pairing.js` (tokens, Pairing PSK flow, CPace `CPACE-X25519-SHA512` with
  Elligator2 on BigInt + OpenSSL X25519, dynamic/static code flows, wrapping, rounds,
  cooldown, timeouts as data) and `trust-store.js` (records, approvals, staged pairing PSKs,
  mismatch; atomic 0600 JSON). No new dependencies. Byte-exact against aiosendspin + cpace-py
  transcripts (`test/fixtures/sendspin/gen_pairing_vectors.py`); integration contract above.
- 2026-11-12 — `connection.js` (init/handshake/hello/activate state machine, Sentinel
  fallback + mismatch, time/state/goodbye/leave, ping/pong, re-handshake, stamping at
  encrypt time, all sends synchronous so fragments never interleave), `server.js`
  (listener, dialer + reconnect policy, registry with replace-on-duplicate, TrustStore
  approvals, solo `group/update`), `discovery.js` (own mDNS on `node:dgram`: `npm install`
  of `bonjour-service` was refused by the sandbox, and a ~550-line bounded codec keeps the
  dependency tree unchanged). 36 tests (`sendspin-connection`, `sendspin-discovery`).
  E2E (`test/manual/sendspin-spike.mjs`) against `sendspin daemon`: client-initiated,
  server-initiated and mDNS-discovered dial all handshake with the Sentinel PSK, the daemon
  accepts `stream/start` (PCM 48k/24 and FLAC 48k/24) and plays 400 × 25 ms chunks, stream
  ends cleanly. Our mDNS advert is seen by python-zeroconf, the daemon's advert by us.
- 2026-11-12 — UI contract-first: `docs/API/rooms.md` (admin `/api/v1/admin/sendspin/*`
  incl. token + code pairing, player `/api/v1/rooms*` incl. `jump`, `queue`, `queueVersion`,
  `stop → stoppedAt`) + "Velvet Rooms" rows in `docs/API.md`. Admin page `rooms-view`
  (settings, eight device states, allow/pair/revoke/unpair/rename/forget/connect, code entry
  one slot per digit, pairing-token field, rooms editor) and player Rooms output: hands the
  queue over, pauses local audio, bar + queue act as remote (1 s state poll), "Playing in …"
  with take-back. 141 i18n keys, 12 locales. Built against the contract, no backend yet.
- 2026-11-12 — `scheduler.js` (GroupStream: one master decode, per-member encoders, spec buffer
  accounting, late join from a master PCM history, seek/pause/format switch, track events) and
  `rooms.js` (RoomManager: rooms + persisted queue/position, group volume/mute, switch, parking,
  controller/metadata/artwork/colour, idle activity drop); `createDecoder` got `gainDb`
  (ReplayGain in the master decode). 28 fake-member tests. E2E
  (`test/manual/sendspin-room-e2e.mjs`) with two `sendspin daemon`s on the null sink: both
  negotiate FLAC 48k/24, no late/underrun logs, track change without stream events (gapless),
  seek = `stream/clear` + restart with 0.2 s buffered, `stream/end` at the queue end. A scratch
  aiosendspin-client run (pcm 48k + flac 44.1k) counted 0 late chunks, 0 gaps across the
  boundary, ~295 ms minimum lead, metadata current → scheduled in order.

- 2026-11-12 — pairing wired into `server.js`/`connection.js`: token (live re-handshake to `pr` or staged), dynamic/static
  codes (Sentinel re-handshake from `lt`/`pr`, abort returns to `lt`), per-client cooldown, deadline timer, protocol error ->
  silent close, persist-before-ack, `lt` re-handshake keeps a running stream; `unpair`/`forget`, `devices()` with a
  `known-devices.json` cache; solo `group/update` at hello removed (rooms own it). 13 tests
  (`sendspin-pairing-integration`, client helper `test/helpers/sendspin-test-client.mjs`). E2E against `sendspin daemon`:
  dynamic code (read from its log), live token and staged token all pair, a daemon restart reconnects under `lt`.
- 2026-11-12 — user docs: `docs/rooms.md` (Velvet Rooms guide), `docs/docker.md` (host networking / port 8927),
  `COMMUNITY-SPEC-LICENSE-1.0.md` (verbatim spec licence, CSL 2.1.3.1) + `NOTICE.md`, todo backlog "Velvet Rooms — extensions".

- 2026-11-12 — Velvet glue: `config.program.sendspin` (Joi: enabled/name/port/bind/path/discovery,
  `docs/json_config.md`), `src/sendspin/service.js` (RoomsService: SendspinServer + RoomManager
  lifecycle, restart on settings without a Velvet restart, start errors → `status.error`, Device/Room
  views per `docs/API/rooms.md`, queueVersion), `src/sendspin/artwork.js` (album-art cache → embedded
  → folder image; sharp fit-inside + black padding at exact size, LRU; palette with WCAG 4.5:1 checked
  per spec colour rule), `src/api/sendspin.js` (every contract route; queue resolution through the
  user's vpaths + `resolvePathWithinRoot` + DB row + stat, `..`/empty segments refused, gain capped at
  the stored peak; pairing routes rate-limited, tokens never logged/echoed), backup/migrate include
  `save/sendspin/` key + trust store (both or neither), `save/sendspin/` gitignored. Contract change:
  `pair-token` body field is `pairingToken` (Velvet's auth reads a body `token` as the JWT).
  `test/integration/sendspin-api.test.cjs` (11) + `test/sendspin-artwork.test.mjs` (2).
  E2E: second instance on 3100 + `sendspin daemon` (null sink, found over mDNS, approved via REST):
  FLAC 48k/24 stream, seek = one `stream/clear`, track 01 → 02 with no stream events (gapless),
  pause = `stream/end`, resume = new `stream/start`, `Server set player volume: 60%`, stop =
  `stream/end`; SIGTERM ends streams and exits in ~1 s.
  Adapters waiting for RoomManager: `jump(id, index)` (now: `play` with the cached/re-resolved
  queue, resets shuffle order), `add(id, items, { next })` (now: appends), `play(..., { paused })`
  (now: play then pause), `forget(clientId)` (now: the solo room stays in rooms.json, hidden
  because the device is unknown).

- 2026-11-12 — conformance harness: Velvet server adapter (`test/conformance/velvet-adapter/`, plaintext wire
  trace via CipherState + ws hooks). Row velvet vs aiosendspin / sendspin-cpp / sendspin-js (14 scenarios, Opus
  and legacy-unencrypted not offered): 8/14, 7/14, 4/14 pass. Every Velvet failure traces to two bugs:
  `audio.js` `createDecoder` upmixes mono to the stereo master with ffmpeg's −3 dB matrix (all mono PCM/FLAC
  hashes, every client), and `scheduler.js` `GroupStream` never anchors with no player member (`#ready` /
  `#needsMore`), so a display-only room "plays" with no track metadata (metadata scenarios). With both fixed in
  a scratch copy: 14/14 aiosendspin, 12/14 sendspin-cpp (its 2 = client cannot send `format`). sendspin-js
  failures are peer limits (48/44.1 kHz stereo only, no FLAC/artwork/24-bit/baseline, no raw frames).

- 2026-11-12 — RoomManager gaps closed, REST adapters removed: `jump` (no queue resend, shuffle order kept), `add … next`
  (insert after current; tracks follow queue entries by identity; while playing the read-ahead tail is cut at the first
  boundary past the send-ahead, members re-encoded from that point with `stream/clear from_timestamp`, gapless; if the decode
  has not reached the boundary the swap happens there with no stream command; also used for append/shuffle/repeat while
  playing), `play … paused` (no `stream/start`), `forget` (solo room + named seats out of `rooms.json`), `queueVersion`
  owned by RoomManager. Shutdown hang: `http.close()` in `SendspinServer.stop()` waited forever for any TCP connection that
  had not sent a full request (reproduced: idle/partial socket → stop never resolved, Velvet only exited via the signal
  handler's fallback timer); now `closeAllConnections()`, 1.5 s close grace + terminate, and `RoomsService` stop bounded at
  3 s with `server.destroy()`. Tests: rooms 23 (+6), REST 13 (+2), sendspin unit 188, `npm test` 699.

- 2026-11-12 — Conformance fixes landed: mono sources reach the stereo master via `pan=stereo|c0=c0|c1=c0` (input channels
  probed with ffprobe, or `track.channels`; stereo→mono encoders average), bit-exact on both sides; `GroupStream` anchors and
  paces a room with no audio feed in real time (track events, metadata, position, `ended`); a chunk also counts toward
  `buffer_capacity` while the socket's `bufferedAmount` holds it (max of both, 10 ms re-check). yt-dlp `--update` skipped
  under `NODE_ENV=test` (leaked ~43 MB `_MEI*` per boot). Matrix velvet → aiosendspin 14/14, sendspin-cpp 12/14 (client
  cannot send `format`), sendspin-js 4/14 (peer limits).
- 2026-11-12 — Security review fixed: no peer input can escape a socket handler or promise chain (every phase handled,
  catch-all → close 1011); peer JSON is never coerced (`cleanText`, pair-method locations) and `client/state`/`client/command`
  are reduced to strict spec shapes; only paired/approved speakers get rooms (attach on trust, detach on revoke/unpair,
  stale untrusted solo rooms pruned), untrusted clients have their own cap (16) and known devices an LRU cap (256, trusted
  never evicted); mDNS rejects mapped/compatible IPv6, link-local and off-subnet addresses and off-link QU queries; unpair
  idles + closes the lt session, unpair/revoke during a re-handshake are deferred; import restarts Rooms in `finally`.

- 2026-11-12 — Queue edits, Auto-DJ and room editing from the player: `RoomManager.remove/move/reorder` (entries by identity; upcoming
  edits go through `#editTail`/`replaceUpcoming`, so the current track plays on gapless; removing the current entry = next; a
  removed already-committed next track restarts at the next survivor; shuffle order kept), `upcoming` in the Room view, REST
  `POST …/remove|move|reorder` + optional `queueVersion` on edits and `add` (409 `queue_changed`), `meta.bpm` on resolved
  items. Player: browser queue mirrors the room (`_roomMirror`, identity diff → remove + move/reorder, one request at a time,
  refetch on conflict) for remove, drag, disc move, clear, shuffle queue, flow/undo, recording delete, jukebox remove; Auto-DJ
  tops up from the polled state (`upcoming === 0`, once per `queueVersion`, versioned `add`); *Edit rooms* modal from the
  output picker (rename, move, split up, create). 17 player keys × 12 locales. Tests: rooms +2, REST +1.
- 2026-11-12 — Network: per-address admission caps (4 pre-hello sockets per peer address, refused with 503 at the HTTP
  upgrade, so one LAN host can no longer use up `maxPending`; 4 untrusted clients per address; 5 s to send `client/init`;
  addresses of paired/approved devices exempt) and IPv6 mDNS (udp6 on `ff02::fb` per interface, AAAA advertised when bound to
  `::`, AAAA answers dialed when no IPv4 is offered, cache-flush per record type, link-local QU sources answered on the
  group; IPv4-only fallback). This host has IPv6 disabled: IPv6 verified with crafted packets only, IPv4 path live.
  Tests: `sendspin-admission.test.mjs` (6), discovery +5.
- 2026-11-12 — Opus: ffmpeg libopus → Ogg → own `OggPacketReader` (RFC 3533 CRC, packets across pages) + `OpusDemuxer`
  (drops OpusHead/OpusTags, TOC durations) → one raw packet per 20 ms chunk; timeline moved back by the OpusHead pre-skip
  as aiosendspin does, so decoded audio lands sample-exact (tone onset at 500.02 ms of 500 ms via ffmpeg and aiosendspin's
  `create_decoder`). Negotiation takes opus (8/12/16/24/48 kHz, 1–2 ch) only when listed, client order/preference
  respected, `bit_depth` ignored. ~1 % of one core per stereo stream (FLAC ~0.25 %). `test/sendspin-opus.test.mjs` (8).
  Conformance `server-initiated-opus`: sendspin-cpp passed (8 kHz mono, 251 packets); aiosendspin and sendspin-js client
  adapters do not offer Opus (harness fail-fast).

### Second test instance (owner)

Config, DB and Rooms state live outside git in `/home/velvet-work/sendspin-e2e/` (`conf/default.json`
is a copy of production's with port 3100, one small `Music` folder, scans/webhooks/DLNA/Server
Audio/AI/scrobbling off, `sendspin` on 8927 with discovery). Start / stop:

```sh
cd /home/velvet-work/sendspin && node cli-boot-wrapper.js -j /home/velvet-work/sendspin-e2e/conf/default.json \
  > /home/velvet-work/sendspin-e2e/logs/run.log 2>&1 &
kill <pid>     # SIGTERM: Rooms stop cleanly, then Velvet exits
```

Open `https://music.aroundtheworld.net:3100` (same users as production). Production
- 2026-11-12 — Visualizer (`visualizer@v1`, `visualizer.js`): GroupStream master-PCM tap (`epoch`/`pcm`/`cut`/`pcm-end`/`stop`);
  one lazy analysis per room (only requested types, at the highest requested rate ≤ 60): real FFT 2048 @ 48 kHz (Hann),
  A-weighting, `loudness`/`f_peak`/`spectrum` (mel/log/lin bands, power sum, ≤ 1024 bars), log-band spectral-flux onset
  curve (1024/256, 187.5 fps) → `peak` (adaptive threshold, 80 ms gap, strength vs. a decaying max) and `beat` (comb tempo
  over the onset ACF with a log-Gaussian prior — Velvet's `files.bpm` via `meta.bpm` (σ 0.05 oct) or 120 BPM (σ 0.7 oct)
  — comb phase, then PLL 0.8 with coasting; `tracks_downbeats: false`). Frames stamped `t0 + samplesToUs(sample)` (the
  audio's own timeline), sent ≤ send-ahead + 0.5 s ahead, non-decreasing, visualizer `buffer_capacity` accounting, late
  join from now + 50 ms, seek/jump = `stream/clear`, queue-edit cut = `stream/clear from_timestamp`, pause/stop =
  `stream/end`; visualizer-only devices get `playback` and join the room. Real music: tempo 108.3/108.9 BPM free vs DB
  108.3/108.5; DB 137.2 settles a free 68.8. CPU ~0.75 % of one core per room at 30 fps (all types; 1.25 % at 60 fps;
  loudness/spectrum alone 0.2 %). 16 tests (`sendspin-visualizer`); E2E with an aiosendspin visualizer-only client:
  stream/start echo, 30 fps per type, beats every 500 ms on a 120 BPM click track, clear on seek, end on pause.
(`/home/velvet`, port 3000, `music.service`) is never touched.

### Reference daemon notes (sendspin CLI + aiosendspin client, Nov 2026)

- Needs PortAudio; this host has none installed. Spike recipe: `apt-get download
  libportaudio2`, `dpkg -x` into a scratch dir, symlink `libportaudio.so`, run with
  `LIBRARY_PATH`/`LD_LIBRARY_PATH` pointing there. Never let it open the real card (Velvet's
  Server Audio uses it): give it a private `HOME` whose `.asoundrc` defines
  `pcm.velvetnull { type null; hint { show on } }` and pass `--audio-device velvetnull`
  (ALSA's own `null` is hidden from PortAudio). The null sink drains instantly, so its sync
  statistics are meaningless (initial error = our send-ahead window) — real sync needs real
  hardware.
- Server-initiated listener path is `/sendspin` (default port 8928); mDNS instance name
  is the `client_id`, TXT `path` + `name`, address = the host's LAN IP.
- It sends `client/state` with `available: false` immediately after activation, then
  `available: true` once its time filter has a sample (spec: the initial `client/state` of
  an active player should wait for sync). Servers must wait for `available: true` before
  `stream/start`.
- `client/time` is one message every 0.2 s (unsynced) to 3 s (error < 1 ms), not the
  spec's bursts of ≥ 8 — fine for us, we answer each.
- Lists FLAC first; with a real device it probes formats (32 incl. 24-bit/48k). Reports
  `min_buffer_ms` 250, `required_lead_time_ms` 250, `buffer_capacity` 32 000 000, volume
  25, commands volume/mute/set_output_delay. Starts output after 8 chunks (0.2 s).
- Its listener does not reject an `Origin` header (spec MUST); our dialer never sends one.
- Pairing: offers `pairing_psk` and `dynamic_pairing_code` (digits, `display`); static is superseded by dynamic. The
  dynamic code is only logged (`Pairing required: enter pairing code 314-213 on the server.`). It has no pairing PSK
  by default (`pairing_psk: null` in `<settings-dir>/pairing-store-daemon.json`) and no way to show a token; for the
  token flow seed `pairing_psk: { psk_id, psk }` in that file before start and build the token from it + the client id.
