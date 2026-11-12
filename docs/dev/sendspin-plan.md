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
// noise.js
export const SUITES = ['25519_ChaChaPoly_SHA256', '25519_AESGCM_SHA256'];
export function generateStaticKeyPair(); // { publicKey: Buffer(32), privateKey: Buffer(32) }
export class NoiseInitiator {
  constructor({ suite, staticKeyPair, remoteStaticPublicKey, prologue /*Buffer*/, psk /*Buffer(32)*/ });
  writeMessage1(payload /*Buffer*/); // -> Buffer
  readMessage2(message /*Buffer*/);   // -> payload Buffer; throws on auth failure
  split();                            // -> { send: CipherState, recv: CipherState }
}
// CipherState: encrypt(plaintext) -> Buffer, decrypt(ciphertext) -> Buffer (throws)
// keys.js
export function encodeKeyId(publicKey); // base64url, 43 chars, no padding
export function decodeKeyId(id);        // -> Buffer(32), throws on bad input
export function pskId(psk);             // base64url(SHA-256("sendspin-psk-id-v1" || psk))
export const SENTINEL_PSK;              // SHA-256("sendspin-sentinel-psk-v1")
// wire.js
export const MSG = { JSON: 0, FRAGMENT: 1, AUDIO: 4, ARTWORK0: 8, SOURCE_AUDIO: 12, VIS_LOUDNESS: 16 /* … */ };
export function encodeJson(obj);                           // -> [Buffer] (fragmented if needed)
export function encodeAudioChunk(timestampUs, sendAheadUs, frame); // -> Buffer (13-byte header)
export class Reassembler { push(buf) /* -> { type, payload } | null */ }
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
