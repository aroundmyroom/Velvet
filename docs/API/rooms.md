# Velvet Rooms API

Velvet Rooms plays a server-side queue on speakers that implement the Sendspin
protocol ("works with Sendspin speakers"). This page is the contract between
`src/api/sendspin.js` and the UI (`webapp/admin/index.js`, `webapp/app.js`).
Design background: `docs/dev/sendspin-plan.md` ("Phase 1 design").

All routes need a valid token (`x-access-token` header or `?token=`). JSON in,
JSON out. Field names below are exact.

## Conventions

### Availability

| Situation | Admin routes | Player routes |
|---|---|---|
| Feature disabled in config (`sendspin.enabled: false`) | work (`status` returns `enabled: false`, `devices: []`) | `GET /api/v1/rooms` answers `200 { enabled: false, allowed, rooms: [], sources: [] }`; every other player route `409 { error, code: "rooms_disabled" }` |
| User lacks `allow-mpv-cast` (and is not admin) | `403` (admin routes are admin-only anyway) | `GET /api/v1/rooms` answers `200 { enabled: true, allowed: false, rooms: [], sources: [] }`; every other player route `403 { error, code: "forbidden" }` |
| Server enabled but listener failed to start | `status.running: false`, `status.error` set | `503 { error, code: "not_running" }` |

The player uses `GET /api/v1/rooms` as its capability check: `enabled: false`
or `allowed: false` means "hide Rooms". A feature that is switched off is not
an error, so this call never answers 404 for it. Admins may call every player route even without `allow-mpv-cast`
(the admin page edits rooms through them).

### Errors

`{ "error": "<human readable, English>", "code": "<machine code>", ...extra }`

| Status | `code` | When |
|---|---|---|
| 400 | `invalid_body` | Body fails validation (types, limits below). |
| 403 | `forbidden` | Missing permission. |
| 409 | `rooms_disabled` | Player route (other than the room list) while the feature is off. |
| 404 | `not_found` | Unknown `clientId` or room `id`. |
| 400 | `bad_address` | `devices/add`: not an IP address on Velvet's own network, or a bad port or path. |
| 409 | `not_connected` | Action needs a live connection (pair-code start, connect to a device that is not discoverable). |
| 409 | `pairing_in_progress` | A pairing attempt already runs for this device. |
| 409 | `no_pairing` | `pair-code/submit` or `cancel` without an attempt. |
| 409 | `not_playable` | `play` on a room whose members are all offline / unknown / mismatched / in use elsewhere. |
| 409 | `solo_room` | `DELETE` on a room with one member. |
| 409 | `empty_queue` | `resume`/`next`/`jump` on a room with no queue and no history. |
| 409 | `queue_changed` | `remove`/`move`/`reorder`/`add` sent a `queueVersion` that is no longer current; adds `queueVersion` (the current one). Refetch `GET …/queue` and retry. |
| 422 | `malformed_token` / `unsupported_token_version` / `wrong_client` | Pairing token rejected (nothing was sent to the device). `wrong_client` adds `tokenClientId`. |
| 422 | `invalid_code` | Code is not 6 / 8 digits after stripping spaces and hyphens. |
| 409 | `not_seekable` | `seek` while `canSeek` is false. |
| 429 | `cooldown` | Code submitted during the device's back-off; adds `retryAfterMs`. |
| 429 | `rate_limited` | Too many pairing calls (20 / min per admin for token/start/submit/cancel, 180 / min for status polls); adds `retryAfterMs`. |
| 503 | `not_running` | Sendspin listener not running. |

Error messages are never shown verbatim as markup; the UI maps `code` to a
translated string and falls back to `error` as plain text.

### Limits

- `name` (server, device, room): string, trimmed, 1–63 characters, no control
  characters.
- `clientId`: the device's `client_id` (43-char base64url key id, or the
  device-chosen id for unpaired clients); string ≤ 128.
- `songs`: array of 1–10 000 strings, each ≤ 4 096 characters, in the
  **player-queue form `<root vpath>/<relative path>`** (the DB parent vpath,
  never a child-vpath name). The server resolves every entry through the
  requesting user's vpaths (same rules as Server Audio); entries the user cannot
  access or that do not exist are dropped and counted in `skipped`.
- `index`: integer ≥ 0. `positionMs`: integer ≥ 0. `volume`: integer 0–100.
- `indexes` (`remove`) / `order` (`reorder`): arrays of 1–10 000 distinct integers ≥ 0, each a
  current queue index; `order` must list every index exactly once. `from`/`to` (`move`): queue
  indexes. `queueVersion`: integer ≥ 0, optional on every queue edit.
- `pairingToken`: string ≤ 256. `code`: string ≤ 32.

## Shared objects

### Device

```json
{
  "clientId": "q1w2…43 chars",
  "name": "Kitchen",
  "deviceInfo": { "productName": "Sendspin Speaker", "manufacturer": "Acme", "softwareVersion": "1.2.0" },
  "trust": "unknown",
  "connection": "online",
  "unpairedAccess": true,
  "pairMethods": ["pairing_psk", "dynamic_pairing_code"],
  "roles": ["player@v1", "metadata@v1"],
  "roomId": "r_kitchen",
  "volume": 40,
  "muted": false,
  "canSetVolume": true,
  "canMute": true,
  "address": "192.168.1.40:8928",
  "otherServer": null,
  "lastSeen": 1763000000000,
  "pairing": null,
  "source": null
}
```

| Field | Type | Notes |
|---|---|---|
| `clientId` | string | Stable key for every device action. |
| `name` | string | Operator name if renamed, else the name from `client/hello`. |
| `deviceInfo` | object | From `client/hello` `device_info`; each field `string \| null`. |
| `trust` | `'unknown' \| 'approved' \| 'paired' \| 'mismatch'` | `TrustStore.trustState()`. |
| `connection` | `'online' \| 'offline' \| 'other-server' \| 'in-use-elsewhere' \| 'pairing'` | `other-server`: last goodbye was `another_server` or refused with `concurrent_attempt`. `in-use-elsewhere`: reported `available: false` / `client/leave` (parked in a solo room). `pairing`: an attempt is running. |
| `unpairedAccess` | boolean | The device admits unpaired access (approval possible). |
| `pairMethods` | string[] | Subset of `pairing_psk`, `dynamic_pairing_code`, `static_pairing_code` the device listed. |
| `roles` | string[] | Active roles (`player@v1`, `controller@v1`, `metadata@v1`, `artwork@v1`, …). |
| `roomId` | `string \| null` | The room the device belongs to (always set for a known device). |
| `volume` | `number \| null` | 0–100; `null` if the device reports none. |
| `muted` | `boolean \| null` | |
| `canSetVolume` / `canMute` | boolean | `false` → UI shows the value read-only. |
| `address` | `string \| null` | Last known `host:port`. |
| `otherServer` | `{ name: string \| null } \| null` | Set when `connection === 'other-server'` and the other server is known. |
| `lastSeen` | `number \| null` | ms epoch of the last message. |
| `pairing` | `PairStatus \| null` | Live attempt, see below. |
| `source` | `SourceState \| null` | Line-in; `null` for a device that does not offer `source@v1` and was never allowed as one. |

**UI state** (one of the guide's eight), first match wins:
`connection === 'pairing'` or `pairing` set → *pairing in progress*;
`trust === 'mismatch'` → *credential mismatch*;
`connection === 'other-server'` → *playing from another server*;
`connection === 'in-use-elsewhere'` → *in use elsewhere*;
`connection === 'offline'` → *offline*;
otherwise `trust` → *paired* / *approved* / *unknown*. The trust badge stays
visible next to the connection state in every case.

### PairStatus

```json
{ "status": "need_code", "method": "dynamic_pairing_code", "digits": 6, "round": 1,
  "retryAfterMs": 0, "message": null, "reason": null, "deadline": 1763000360000 }
```

| `status` | Meaning | Extra fields |
|---|---|---|
| `waiting` | Attempt started; waiting for the device. | — |
| `pending` | Device holds the attempt back (`client/pair-pending`). | `message`: `string \| null`, ≤ 200 bytes, **plain text from an unauthenticated peer** |
| `need_code` | Ask the operator for the code. | `round` |
| `wrong_code` | Last code did not match; ask again. Stays `wrong_code` (with the new `round`) until the next code is submitted, so the UI keeps showing "did not match". | `round`, `retryAfterMs` |
| `paired` | Record persisted, device paired. | — |
| `aborted` | Attempt ended. | `reason`: `user_cancelled \| timeout \| concurrent_attempt \| too_many_attempts \| rejected \| …` (spec `pair/abort` reasons, plus `timeout`) |

`method`: `pairing_psk \| dynamic_pairing_code \| static_pairing_code`.
`digits`: 6 (dynamic, shown `123-456`) or 8 (static, shown `1234-5678`).
`deadline`: ms epoch of the server's own timeout, or `null`. Terminal
states (`paired`, `aborted`) stay readable for 60 s after they occur.

### SourceState

```json
{ "supported": true, "allowed": true, "canAllow": true, "needsPairing": false, "roleActive": true, "available": true,
  "signal": "present", "streaming": true, "roomId": "r_8f2c", "autoSwitch": false, "autoRoomId": "r_8f2c", "lastError": null,
  "stats": { "format": { "codec": "flac", "sampleRate": 48000, "channels": 2, "bitDepth": 16 }, "bufferMs": 152, "ppm": 186,
             "underruns": 0, "chunks": 4210, "rejected": 0, "stale": 0, "ahead": 0, "jumps": 1, "gaps": 0, "backlog": 0, "delayMs": 9 } }
```

| Field | Type | Notes |
|---|---|---|
| `supported` | boolean | The connected device lists `source@v1` in `client/hello`. |
| `allowed` | boolean | Explicit source approval (separate from playback approval; survives pairing, dropped on revoke/unpair/forget). |
| `canAllow` | boolean | Paired or approved: only then can it be allowed as a source. |
| `needsPairing` | boolean | Not trusted and unpaired access is off (microphones should ship like this): pair it first. |
| `roleActive` | boolean | `source@v1` is in its `active_roles` (paired, or approved **and** allowed as a source). |
| `available` | boolean | Last `client/state` `available`. |
| `signal` | `'present' \| 'absent' \| null` | Line sense from `client/state`. |
| `streaming` | boolean | An input stream is open (`client-stream/start` received). |
| `roomId` | `string \| null` | The room playing this line-in now. |
| `autoSwitch` / `autoRoomId` | boolean / `string \| null` | Auto-switch policy (off by default): start `autoRoomId` (the room the line-in last played in) on signal `present`, stop on `absent`. |
| `lastError` | `'declined' \| 'overloaded' \| null` | `declined`: the device declined the last start. `overloaded`: its decoder stayed more than 3 s behind, so the line-in was stopped. |
| `stats` | object \| null | Ingest diagnostics: jitter buffer (`bufferMs`), clock correction (`ppm`), rejected/stale/over-pace chunks, chunks dropped while the decoder was behind (`backlog`), timestamp `jumps`/`gaps`, last input delay. |

### Room

```json
{
  "id": "r_8f2c",
  "name": "Living room",
  "members": [
    { "clientId": "…", "name": "Left", "connection": "online", "volume": 40, "muted": false, "canSetVolume": true, "canMute": true }
  ],
  "state": "playing",
  "current": { "filepath": "Music/A/B/01.flac", "title": "Song", "artist": "Artist", "album": "Album",
               "aaFile": "3f2a….jpg", "artUrl": "/album-art/3f2a….jpg", "durationMs": 245000 },
  "positionMs": 61234,
  "positionAt": 1763000000123,
  "index": 3,
  "queueLength": 25,
  "upcoming": 21,
  "queueVersion": 7,
  "volume": 40,
  "muted": false,
  "repeat": "off",
  "shuffle": false,
  "canSeek": true,
  "playable": true,
  "lineIn": null,
  "sonos": [],
  "eq": { "enabled": true, "gains": [0, 0, 0, 0, 0, 0, 0, 0], "preset": null },
  "autoDj": false,
  "scrobble": { "lastfm": "pending", "listenbrainz": "off" }
}
```

| Field | Type | Notes |
|---|---|---|
| `id` | string | Opaque, URL-safe (`[A-Za-z0-9_-]{1,64}`). |
| `name` | string | Solo rooms default to the device name. |
| `members` | object[] | Subset of Device (fields shown above). |
| `state` | `'idle' \| 'playing' \| 'paused' \| 'stopped' \| 'buffering'` | `idle` = never played / queue empty. |
| `current` | object \| null | Track at `index`. `filepath` in player-queue form. `aaFile`/`artUrl` `null` without art; `artUrl` has no token, the client appends `?token=`. `durationMs` `null` if unknown. |
| `positionMs` | number | Position in `current` at time `positionAt`. |
| `positionAt` | number | Server ms epoch when `positionMs` was sampled; while `playing` the client may interpolate `positionMs + (now - positionAt)`. |
| `index` | number | Index of `current` in the room queue (−1 when idle). |
| `queueLength` | number | |
| `upcoming` | number | Entries still to play after `current` in play order (shuffle order when `shuffle` is on), not counting a `repeat` wrap. `0` on the last entry and when idle. |
| `queueVersion` | number | Increments on every queue change (play, add, remove, move, reorder, shuffle, any controller command that edits the queue). Remotes refetch `/queue` when it changes. A request that changes nothing (a move onto itself, an identity `reorder`) keeps it. |
| `volume` / `muted` | number / boolean | Group values (spec group-volume algorithm). |
| `repeat` | `'off' \| 'all' \| 'one'` | |
| `shuffle` | boolean | |
| `canSeek` | boolean | |
| `playable` | boolean | At least one member can play now (online, trusted for playback). |
| `lineIn` | `{ clientId, name } \| null` | The room plays a source device's input instead of its queue. Then `state` is `playing`, `current` is `{ filepath: null, title: "Line-in — <name>", durationMs: null, … }`, `canSeek` is false and the queue (with `index`/`positionMs`) waits underneath, paused. |

| `sonos` | object[] | Sonos speakers following the room: `{ id: "sonos:<uuid>", uuid, name, trimMs, leadMs, volume, muted, state, error }`. `trimMs`: the fine-tune set by hand (−1000 to 1000). `leadMs`: the lead Velvet measured from the Sonos's position, `null` until the first measurement. `state`: `idle` (room not playing), `starting` (Velvet is telling the Sonos to play), `waiting` (told, not listening right now), `streaming` (pulling the stream), `error` (the Sonos did not answer; `error` says why). `volume`/`muted` `null` until read. Use `id` as `clientId` for the per-speaker volume/mute routes. A Sonos counts as `playable` while Sonos is enabled in Velvet; while it is off the entries stay but are dormant (not driven, no added delay, not `playable`). |
| `eq` | `RoomEq` | The room's equalizer (see [Room EQ](#room-eq)). Default `{ enabled: true, gains: [0×8], preset: null }`. |
| `autoDj` | boolean | The room's own Auto-DJ: when its last song starts, Velvet picks and adds the next one on the server, exactly like the web player's Auto-DJ (its settings and DJ state are handed over). Queue entries it added carry `dj: true`. |
| `scrobble` | `{ lastfm, listenbrainz } \| null` | Scrobble state of `current`, each `'pending' \| 'ok' \| 'err' \| 'off'` (same meaning as the web player's Playing Now badges: `off` = not enabled on the server or not linked by the listener). `null` when the room does not scrobble this song: idle, line-in, no listener, or a song taken over past the 30 s mark (see [Listening](#listening-scrobbles-play-counts-statistics)). |

### Listening (scrobbles, play counts, statistics)

A room does on the server what the web player does around its own playback, with the same functions, server switches and per-user settings as the web player's routes (`src/api/room-listen.js`), so no browser has to be open:

- **Listener**: the user who last used one of the room's control routes (`play`, `add`, `jump`, `remove`, `move`, `reorder`, `pause`, `resume`, `next`, `previous`, `stop`, `seek`, `repeat`, `shuffle`, `autodj`, `line-in`, `line-in/stop`). Kept in `rooms.json` (`listener`). A room nobody controlled from Velvet listens for its Auto-DJ user; without either nothing is recorded.
- **Song starts** (it becomes audible): play count + last played (as `POST /api/v1/db/stats/log-play`; skipped for a song taken over mid-way, which was counted where it started), Wrapped `play-start` (source `autodj` / `shuffle` / `manual`), ListenBrainz `playing_now`.
- **30 s later** (the web player's timer: a pause does not hold it back, a song change or stop cancels it): Last.fm scrobble plus play count (as `scrobble-by-filepath`), ListenBrainz listen, Discord webhook, custom webhooks. A song taken over at position *p* (from the browser, or resumed after a restart) waits 30 s − *p*; past 30 s it is not scrobbled again.
- **Song ends**: Wrapped `play-end` when it played to its end, `play-skip` on next/previous/jump/a new queue, `play-stop` on stop, line-in, deleting the room or a server shutdown; `pause` on pause. Played time is the room position, like the browser's audio time. Resuming or seeking the same song continues the same listen.
- Line-in is not recorded. The browser records nothing while a room is its output; handing a song to a room ends the browser's own listen, taking it back continues from the room's (no second play count or scrobble).

### QueueEntry

`{ "filepath": string, "title": string|null, "artist": string|null, "album": string|null, "year": number|null, "aaFile": string|null, "durationMs": number|null }`

## Admin routes (admin only)

| Method | Endpoint | Body | Response |
|---|---|---|---|
| `GET` | `/api/v1/admin/sendspin/status` | — | `{ enabled, running, name, port, serverId, serverIdShort, error, devices: Device[], rooms: Room[] }` |
| `POST` | `/api/v1/admin/sendspin/settings` | `{ enabled?: boolean, name?: string, port?: integer 1024–65535 }` | Same as `status`. Starting/stopping/restarting the listener is the server's job; `port` change restarts it (playing rooms stop). |
| `POST` | `/api/v1/admin/sendspin/devices/approve` | `{ clientId }` | `{ ok: true, device: Device }`. 409 `not_playable` if `unpairedAccess` is false. |
| `POST` | `/api/v1/admin/sendspin/devices/revoke` | `{ clientId }` | `{ ok: true, device }` — drops approval; stops playback on the device. |
| `POST` | `/api/v1/admin/sendspin/devices/rename` | `{ clientId, name }` | `{ ok: true, device }` — never interrupts playback. |
| `POST` | `/api/v1/admin/sendspin/devices/forget` | `{ clientId }` | `{ ok: true }` — unpairs (sends `server/unpair` if connected), revokes, removes from its room, forgets name. |
| `POST` | `/api/v1/admin/sendspin/devices/connect` | `{ clientId }` | `{ ok: true, device }` — dial now (also takes a device back from another server). 409 `not_connected` if no address is known. |
| `POST` | `/api/v1/admin/sendspin/devices/add` | `{ address }` | `{ ok: true, url }` — dial a speaker that mDNS does not find. `address` is an IP literal on one of Velvet's own subnets: `10.1.1.5`, `10.1.1.5:8928`, `[fd00::5]:8928`, `fd00::5` or `ws://10.1.1.5:8928/sendspin` (port defaults to 8928, path to `/sendspin`; no host names, no credentials, no query). 400 `bad_address` otherwise. The speaker appears in `devices` once it answers; after its first connection the address is kept (device field `manual: true`) and dialed on every start until the device is forgotten. Rate-limited like the pairing routes. |
| `POST` | `/api/v1/admin/sendspin/devices/unpair` | `{ clientId }` | `{ ok: true, device }` — `server/unpair` + delete record. |
| `POST` | `/api/v1/admin/sendspin/devices/pair-token` | `{ pairingToken, clientId? }` | `{ ok: true, result: 'pairing' \| 'staged', clientId, device: Device \| null }`. Token decoded leniently (trim, uppercase, optional `SP:`, `9`→`2`). If `clientId` is given and the token's client key differs → 422 `wrong_client`. Connected → `pairing` (attempt runs, poll `pair-code/status`); not connected → `staged` (used on the device's next connection, 24 h). Token/PSK never logged or echoed. The field is `pairingToken`, not `token`: Velvet's auth reads a body `token` as the session JWT. |
| `POST` | `/api/v1/admin/sendspin/devices/pair-code/start` | `{ clientId }` | `PairStatus` (usually `waiting`). Picks the code method with `chooseCodeMethod` (dynamic preferred; digits only). 409 `pairing_in_progress` / `not_connected`. |
| `GET` | `/api/v1/admin/sendspin/devices/pair-code/status?clientId=` | — | `PairStatus`. Poll ~1 s while the dialog is open. 409 `no_pairing` if none (also after the 60 s terminal window). |
| `POST` | `/api/v1/admin/sendspin/devices/pair-code/submit` | `{ clientId, code }` | `PairStatus` after queuing the code (`waiting` until the device answers). 422 `invalid_code`, 429 `cooldown`. |
| `POST` | `/api/v1/admin/sendspin/devices/pair-code/cancel` | `{ clientId }` | `PairStatus` (`aborted`, `reason: 'user_cancelled'`). Idempotent once terminal. |
| `POST` | `/api/v1/admin/sendspin/devices/source` | `{ clientId, allowed: boolean }` | `{ ok: true, device }`. Explicit "Allow as source" (never implied by playback approval or by playing on the device). `allowed: true` needs a paired or approved device: 409 `pairing_required` (unpaired access off — e.g. a microphone) or `not_approved`. `false` stops a running line-in and removes `source@v1` from the device's roles (unless paired). |
| `POST` | `/api/v1/admin/sendspin/devices/source-auto` | `{ clientId, autoSwitch: boolean, roomId? }` | `{ ok: true, device }`. Auto-switch on line sense; `roomId` overrides the room it starts (default: where it last played). 409 `not_allowed` if the device is not allowed as a source. |

`serverIdShort`: first 8 characters of `serverId` (base64url) for display.
`error`: `string | null` — last listener start error (e.g. `EADDRINUSE`).

## Player routes (`allow-mpv-cast` or admin)

Only **trusted** speakers (paired, or allowed by the admin) take part in rooms:
a speaker that is neither never appears in `GET /api/v1/rooms`, and naming it
in `members` answers `404 not_found`, the same as an unknown id. A speaker
whose approval is revoked or that is unpaired leaves its room.

| Method | Endpoint | Body | Response |
|---|---|---|---|
| `GET` | `/api/v1/rooms` | — | `{ enabled: true, allowed: true, rooms: Room[], sources: Source[] }`, or `{ enabled: false \| true, allowed, rooms: [], sources: [] }` while the feature is off or the user may not use it (rooms with at least one trusted member; sorted by name). `Source = { clientId, name, available, signal, streaming, roomId }`: devices allowed as a source and connected with the role active. |
| `POST` | `/api/v1/rooms` | `{ name, members: string[] (clientIds, 1–32) }` | `201 Room`. Members leave their current rooms (a solo room left empty disappears; playback in the room they leave continues for the others). |
| `PATCH` | `/api/v1/rooms/:id` | `{ name?, members? }` | `Room`. `members` is the full new list. A speaker belongs to exactly one room: listing it here moves it out of its old room; a speaker dropped from the list returns to a solo room named after it. An empty `members` → 400. |
| `DELETE` | `/api/v1/rooms/:id` | — | `{ ok: true }`. Stops the room; every member returns to its own solo room. 409 `solo_room` for a one-member room. |
| `GET` | `/api/v1/rooms/:id/state` | — | `Room`. **Remote UI polls this ~1 s** while a room is active and the page is visible; back off to ≥ 5 s when hidden or idle. Cheap: no DB access beyond the cached current entry. |
| `GET` | `/api/v1/rooms/:id/queue` | — | `{ queueVersion, index, songs: QueueEntry[] }` |
| `POST` | `/api/v1/rooms/:id/play` | `{ songs: string[], index?: integer = 0, positionMs?: integer = 0, paused?: boolean = false, rgEnabled?, rgMode?, rgPreamp?, rgClip? }` | `Room` + `skipped: number`. Replaces the room queue (server-side queue from now on), starts at `index`/`positionMs`. 400 if no entry survives resolution. 409 `not_playable`. |
| `POST` | `/api/v1/rooms/:id/add` | `{ songs: string[], next?: boolean = false, queueVersion?, rgEnabled?, rgMode?, rgPreamp?, rgClip? }` | `{ ok: true, queueLength, queueVersion, skipped }`. `next: true` inserts after the current track. Starts playback if the room was idle (not while a line-in plays: then it only appends). With `queueVersion`, 409 `queue_changed` when the queue changed meanwhile (checked after the songs are resolved) — Auto-DJ uses this so two tabs never both top up. |
| `POST` | `/api/v1/rooms/:id/jump` | `{ index }` | `Room`. Play the queue entry at `index` from 0 ms. |
| `POST` | `/api/v1/rooms/:id/remove` | `{ indexes: integer[], queueVersion? }` | `Room`. Removes the entries at `indexes` (queue order). Removing **upcoming** entries while playing never interrupts the current track (the read-ahead is re-spliced as for `add … next`, gapless). Removing the **current** entry behaves like `next` (next surviving entry in play order, from 0 ms; nothing left → `stopped`; on a paused room the cursor moves and it stays paused). Removing every entry → `idle`. The shuffle order of the entries that stay is kept. While a line-in plays, `remove`/`move`/`reorder` only edit the queue underneath (removing its paused entry moves the cursor); the line-in keeps playing. |
| `POST` | `/api/v1/rooms/:id/move` | `{ from, to, queueVersion? }` | `Room`. Moves the entry at `from` so it ends up at index `to` (`splice` semantics). Entries keep their identity: moving the current entry, or anything else, never interrupts playback; `index` follows the current entry. Without shuffle the new queue order is the play order; with shuffle the play order is kept. |
| `POST` | `/api/v1/rooms/:id/reorder` | `{ order: integer[], queueVersion? }` | `Room`. `order[p]` is the current index of the entry that goes to position `p` (a permutation of all indexes). Same playback rules as `move`. For bulk changes (shuffle the queue, flow, block moves). |
| `POST` | `/api/v1/rooms/:id/pause` | — | `Room` (`paused`; position kept). |
| `POST` | `/api/v1/rooms/:id/resume` | — | `Room`. On an idle room resumes what it last played (survives restarts). |
| `POST` | `/api/v1/rooms/:id/next` | — | `Room`. Honours `repeat`/`shuffle`; at the end with `repeat: 'off'` → `stopped`. |
| `POST` | `/api/v1/rooms/:id/previous` | — | `Room`. More than 3 s into the track → restart it; otherwise previous entry. |
| `POST` | `/api/v1/rooms/:id/seek` | `{ positionMs }` | `Room`. Clamped to `durationMs`. 409 if `canSeek` is false. |
| `POST` | `/api/v1/rooms/:id/volume` | `{ volume, clientId? }` | `Room`. Without `clientId`: group volume (spec redistribution algorithm). With: one member. |
| `POST` | `/api/v1/rooms/:id/mute` | `{ muted, clientId? }` | `Room`. |
| `POST` | `/api/v1/rooms/:id/stop` | — | `Room` + `stoppedAt: { index, positionMs }` (where playback was when it stopped — used to take playback back to the browser). The queue is kept and `current` still names the track it stopped on. |
| `POST` | `/api/v1/rooms/:id/repeat` | `{ repeat: 'off' \| 'all' \| 'one' }` | `Room`. |
| `POST` | `/api/v1/rooms/:id/line-in` | `{ clientId }` | `Room` with `lineIn`. Plays the source's input in the room (the queue pauses underneath). 404 when `clientId` is not in `sources`; 409 `not_connected` / `unavailable` / `not_allowed`. The server declares `playback` on the source and sends `server/command` `source: start` (once its `client/state` with the source object arrived). A source that is also a member of the room is left out as a player while its own input plays (no echo). Live timing: each player's lead is `min_buffer_ms + output_delay_ms` (no extension toward `required_lead_time_ms`), no seek. |
| `POST` | `/api/v1/rooms/:id/line-in/stop` | — | `Room`. Sends `source: stop`, drops `playback` on the source, the room returns to its paused queue (or `stopped`). Pause/stop on the room or a speaker's controller do the same; `play`/`jump` with a queue replaces the line-in. |
| `POST` | `/api/v1/rooms/:id/shuffle` | `{ shuffle: boolean }` | `Room`. |
| `GET` / `PUT` | `/api/v1/rooms/:id/eq` | `RoomEq` | See [Room EQ](#room-eq). |
| `GET` | `/api/v1/rooms/:id/autodj` | — | `{ on, state }`: whether the room's Auto-DJ is on and its DJ state (see below), for a player taking playback back. |
| `PUT` | `/api/v1/rooms/:id/autodj` | `{ on: boolean, settings?, state?, rgEnabled?, rgMode?, rgPreamp? }` | `Room`. Switches the room's Auto-DJ, picking with the calling user's folders. `settings` = the web player's Auto-DJ settings: `{ similar, bpmContinuity, bpmBase, bpmTolerance, filterWords[], genreFilter: { mode: whitelist\|blacklist, genres[] (expanded) } \| null, scope: { ignoreVPaths[], filepathPrefix, excludeFilepathPrefixes[{vpath,prefix}], minRating, minDuration, maxDuration, allowUnknownDuration } }` (the same scope as `POST /api/v1/db/random-songs`). `state` = the DJ state to continue from: `{ artistHistory[], bpmHistory[], yearHistory[], genreHistory[], familyHistory[], seedFamily, lastPickFree, similarFor, similarArtists[], rankMap, similarSource }`; without `state` the room keeps its own. Kept in `rooms.json`. 400 on a missing `on` or a malformed setting; 404 unknown room. |

### Sonos followers

A Sonos cannot speak Sendspin; it follows a room through a live MP3 stream of
the room's timeline, sent ahead by a lead Velvet measures from the Sonos's reported position, plus the `trimMs` fine-tune (see [rooms.md](../rooms.md#sonos-speakers-in-a-room)).
All routes need the player permission; adding needs Sonos enabled in Velvet (`config.sonos.enabled !== false`).

| Method | Endpoint | Body | Response |
|---|---|---|---|
| `GET` | `/api/v1/rooms/sonos` | — | `{ enabled, maxTrimMs, devices: [{ uuid, name, model, roomId }] }` from Sonos discovery (rescans when older than 5 min). `{ enabled: false, devices: [] }` while Sonos is off. |
| `POST` | `/api/v1/rooms/:id/sonos` | `{ uuid, trimMs?: -1000–1000 }` | `Room`. The Sonos follows this room (moved out of another room, keeping its fine-tune). Starts it at once if the room plays. 404 unknown room or Sonos (not in discovery); 409 `sonos_disabled`; 400 bad `trimMs` or more than 8 Sonos in the room. |
| `PATCH` | `/api/v1/rooms/:id/sonos/:uuid` | `{ trimMs: -1000–1000 }` | `Room`. The fine-tune; takes effect immediately on a running stream. |
| `DELETE` | `/api/v1/rooms/:id/sonos/:uuid` | — | `Room`. Ends the stream; the Sonos gets `Stop` only if it still plays this room. |
| `GET` | `/api/v1/rooms/sonos-stream/:token.mp3` | — | **No login** (registered before auth). The stream the Sonos pulls: `audio/mpeg`, endless, paced in real time; ICY titles when asked (`Icy-MetaData: 1`). `token` = 32 random URL-safe chars, valid only while that Sonos is a member with a running session. 404 otherwise; 403 for peers outside private IPv4 (loopback included: only the test suite, `NODE_ENV=test`, may fetch from loopback). |

Group `volume`/`mute` include the Sonos speakers (UPnP RenderingControl).

### Room EQ

One 8-band EQ per room (not per speaker), the same bands as the web player's EQ
panel. Stored in `rooms.json` (only when not the default) and applied in the
server's decode, so every speaker in the room and every Sonos following it hears
it, whichever browser set it. A line-in is not equalised.

`RoomEq`: `{ "enabled": boolean, "gains": number[8], "preset": string|null }`

| Band | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|---|---|---|---|---|---|---|---|---|
| Frequency | 60 Hz | 100 Hz | 200 Hz | 500 Hz | 1 kHz | 3 kHz | 10 kHz | 14 kHz |
| Filter | low shelf | peaking Q 1.8 | peaking Q 1.4 | peaking Q 1.8 | peaking Q 1.4 | peaking Q 1.4 | peaking Q 1.4 | high shelf |

| Method | Endpoint | Body | Response |
|---|---|---|---|
| `GET` | `/api/v1/rooms/:id/eq` | — | `RoomEq`. 404 unknown room. |
| `PUT` | `/api/v1/rooms/:id/eq` | `{ enabled: boolean, gains: number[8] (−12…12 dB), preset?: string (≤ 32 chars) \| null }` | `Room` (with the new `eq`). Gains are rounded to 0.1 dB. `preset` is a label for the UI (the browser's preset name), never interpreted. 400 `invalid_body` on a missing field, a wrong count or a gain out of range; 404 unknown room. |

- **Filters.** Web Audio biquads (Audio EQ Cookbook) mapped to ffmpeg's
  cookbook filters: `lowshelf`/`highshelf` at slope 1, `equalizer` with the
  band's Q. Disabled, or all gains 0, adds no filter at all.
- **Never clips.** The decode is lowered by the peak of the whole EQ curve
  (neighbouring boosts add up, so this can exceed the largest band), on top of
  the ReplayGain gain below; a look-ahead limiter at −0.1 dBFS after the bands
  catches filter overshoot on full-scale material and leaves everything else
  bit-exact. A boosting EQ therefore plays quieter overall, like a preamp.
- **Live change.** While the room plays, a `PUT` takes effect within about a
  second without stopping the song: the room re-decodes from the earliest point
  its speakers can still take back, withdraws audio already sent past it with
  `stream/clear` + `from_timestamp` (no chunk after it starts earlier than
  `from_timestamp`), and plays on at the same position — the same mechanism as
  a queue edit. With a Sonos following, the change lands after the Sonos delay.
  Paused/stopped rooms just store it for the next play.

### ReplayGain

`play` and `add` accept Server Audio's optional ReplayGain fields (the player
sends the listener's Loudness Normalisation settings, as `_mpvLoadSong` does for
Server Audio). Each one is optional; when absent the server default applies.

| Field | Type | Server default |
|---|---|---|
| `rgEnabled` | boolean | `true` |
| `rgMode` | `'track' \| 'album'` | `'track'` |
| `rgPreamp` | number, dB, −15…15 | `0` |
| `rgClip` | boolean | `true` |

The gain comes from the DB (`resolveTrackGain`: measured → R128 → tag) and is
applied in the server's decode. Without a limiter in that path, positive gain is
always capped so the stored peak stays ≤ 0 dBFS (no peak known → never above
0 dB); `rgClip` is accepted for symmetry but clipping protection is always on.

## Client behaviour (what the UI does)

- **Admin page** polls `GET …/status` every 3 s while visible; every 1 s
  `GET …/pair-code/status` while a pairing dialog is open. It applies its own
  6-minute timeout to `waiting`/`pending` (the server also expires).
- **Player** probes `GET /api/v1/rooms` at boot and whenever the output
  picker opens. Choosing a room: `POST …/play` with the browser queue (`songs`
  = `S.queue[].filepath`, unchanged), `index = S.idx`,
  `positionMs = audio.currentTime * 1000`; then pauses the local `<audio>` and
  becomes a remote. A queue row click sends `jump` when the browser queue matches the
  room queue (same entries as at the last known `queueVersion`), otherwise
  `play` with the whole queue. Adding songs sends `add`. `play` and `add` carry the
  listener's `rgEnabled`/`rgMode`/`rgPreamp`/`rgClip`. The repeat and
  shuffle buttons send `repeat`/`shuffle` and show the room's `repeat`/`shuffle`
  from the polled state; the browser's own values come back on leaving the
  room. Take back: `stop` → `stoppedAt` → play locally from that index/position.
- **EQ.** While a room is active the player's EQ panel shows and edits the
  room's `eq` (debounced `PUT …/eq`, about 300 ms); the polled state keeps two
  browsers on the same room in sync. The browser's own EQ is left untouched and
  applies again after *Play in this browser*.
- **Scrobbles.** While a room is active the player sends no play count,
  scrobble or Wrapped call of its own; entering a room ends its own Wrapped
  play (`play-stop`) and cancels its 30 s scrobble timer. The *Playing now*
  badges show the polled `scrobble` (`null` for a new song shows them off).
  Taking a song back at position *p* skips `log-play` and scrobbles after
  30 s − *p* (not at all past 30 s).
- Remotes treat `queueVersion` changes they did not cause as "someone else
  changed the queue" and refetch `GET …/queue`.
- **Queue edits.** While a room is active the browser queue mirrors the room
  queue (after a hand-over that dropped entries — radio, unresolvable songs,
  over 10 000 — it refetches `GET …/queue`). Every local edit of the queue
  panel (remove, multi-select remove, drag-reorder, disc-block move, clear,
  shuffle queue, flow and its undo, deleting a recording, jukebox remove) is
  diffed against that mirror by song identity and sent as `remove` and/or
  `move` (one entry) / `reorder` (anything else), each with the
  `queueVersion` it was computed from. Requests run one at a time. A
  `409 queue_changed` refetches the room queue and shows it. *Clear* keeps the
  room's current entry unless the room has stopped.
- **Auto-DJ.** With Auto-DJ on, the browser watches the polled state: when the
  room plays its last entry (`upcoming === 0`, `repeat` not `one`) it picks
  the next song exactly as for local playback and sends `add` with the
  `queueVersion` it saw, once per `queueVersion`. Auto-DJ logic stays in the
  browser: a room only keeps being topped up while a tab with that room active
  is open.
- **Room editing.** The player's output picker has an edit button next to
  *Velvet Rooms*: rename (any room), move a speaker to another room or to its
  own room (`PATCH` with the full member list), split up (`DELETE`), and create
  a room from picked speakers (`POST`).
- Room `index` counts the room queue. The browser drops radio/podcast URL
  entries before handing a queue over, so it maps room → browser position by
  `current.filepath`, never by `index` alone. The server must therefore return
  `current.filepath` exactly as it was sent in `songs`.
