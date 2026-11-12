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
// audio.js
export function openTrack({ file, startMs, format /*{codec,sample_rate,channels,bit_depth}*/ });
//  -> async iterator of { frame: Buffer, durationUs, samples } + codecHeader (FLAC)
```

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
