# Velvet server adapter for the Sendspin conformance harness

A server adapter for [Sendspin/conformance](https://github.com/Sendspin/conformance)
that runs Velvet's own `src/sendspin` code (`SendspinServer` + `RoomManager`)
as the server row of the matrix. It follows the harness's adapter contract
(`adapters/README.md` there).

- `server.mjs` — the CLI the harness launches (`node adapters/velvet/server.mjs --summary … --scenario-id …`).
  It starts `SendspinServer` on `127.0.0.1:<--port>/sendspin` with mDNS off,
  registers its URL in the harness registry (client-initiated) or dials the
  client's registered listener (server-initiated), attaches the client to a
  room, and drives the scenario through `RoomManager`:
  player scenarios play the first `--clip-seconds` of the fixture (written as a
  16-bit WAV, cut exactly as the harness cuts it) and wait for the room's
  `ended`; metadata plays the fixture from `--metadata-track-progress`;
  controller sets repeat/shuffle and waits for the client's command; artwork
  queues the track so the room sends its image on the client's channel.
- `trace.mjs` — the evidence. Velvet has no trace hook, so it wraps
  `CipherState.encrypt`/`decrypt` and the `ws` `WebSocket.send`/`emit` from
  outside: every message is recorded as plaintext (outbound right before
  encryption, inbound right after decryption), cleartext handshake messages as
  text frames, and each outbound write once `ws` reports it flushed. All
  summary fields (`activation`, `group_updates`, `availability_trace`,
  `time_exchange`, `stream`, sent audio hashes, `sent_chunk_frames`,
  `metadata.first_state_sent`, controller state, artwork bytes, the
  CORE-001…PLAYER-001 protocol evidence) are read back from that trace, never
  from adapter arguments.

Identity: the server key and a long-term pairing record for the harness
client are derived from `--server-id`/`--client-id` exactly as the harness's
aiosendspin adapters derive theirs, so pre-paired clients take the `lt` path.
Clients with their own identity connect with the Sentinel PSK; the adapter
approves every client for unpaired access (the same policy as the aiosendspin
server adapter's pairing store) and as a source. It offers every role Velvet
implements (player, controller, metadata, artwork, color, visualizer, source);
the harness has no visualizer or source scenario yet. All harness peers are
loopback, so the per-address admission caps are raised to 32 (as in the hostile
tests). Opus is offered (`supports_opus=True`):
raw packets from `audio.js`'s Ogg demuxer.

## Running it

Prerequisites: a checkout of the harness with its Python environment
(`scripts/setup_workspace.py`, Python ≥ 3.12), Node 24, and this worktree with
`node_modules` and `bin/ffmpeg/{ffmpeg,ffprobe}`.

1. Link the adapter into the harness and register it:

   ```sh
   ln -s /path/to/velvet/test/conformance/velvet-adapter conformance/adapters/velvet
   ```

   and add a `"velvet"` entry to `IMPLEMENTATIONS` in
   `conformance/src/conformance/implementations.py`: client unsupported
   (placeholder), server `adapter_kind="node"`,
   `entrypoint="adapters/velvet/server.mjs"`, server- and client-initiated,
   `supports_flac=True`, `supports_opus=True`, role families
   player/metadata/controller/artwork.

2. Run (from the harness root, its venv active):

   ```sh
   export CONFORMANCE_REPO_VELVET=/path/to/velvet          # the adapter loads $CONFORMANCE_REPO_VELVET/src/sendspin
   export CONFORMANCE_REPO_SENDSPIN_CLI=/path/to/sendspin-cli   # holds tests/fixtures/almost_silent.flac
   conformance run --from velvet --to aiosendspin,sendspin-cpp,sendspin-js --results-dir results-velvet --jobs 2
   conformance report --results-dir results-velvet
   ```

   `VELVET_SENDSPIN_SRC` overrides the source directory (e.g. to test a
   patched copy), `VELVET_FFMPEG`/`VELVET_FFPROBE` the ffmpeg binaries, and
   `VELVET_ADAPTER_KEEP=1` keeps the temporary data dir. Each case also writes
   `server-trace.json` (the decoded connection trace) next to its summary.
