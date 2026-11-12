# Home Assistant — control Velvet Rooms

The **Velvet** integration for Home Assistant turns every [Velvet Room](rooms.md)
into a Home Assistant media player and lets you play your Velvet library into
it: from the media browser, from automations and scripts, and with Assist
("play *Rooms* in the kitchen").

It is a custom integration that lives in the Velvet repository itself
(`custom_components/velvet/`), so it is versioned and released together with
Velvet. Install it through HACS or by copying a folder. It talks to Velvet's
normal REST API; Velvet needs no extra setting for it.

## Velvet Rooms or Music Assistant?

Home Assistant users have two ways to use Velvet:

| | Velvet integration (this page) | [Music Assistant](subsonic.md#music-assistant) |
|---|---|---|
| Who plays | **Velvet**: its own server-side queue on its Rooms (Sendspin speakers, plus the Sonos speakers that follow a room) | Music Assistant; Velvet serves the files over the Open Subsonic API |
| Speakers | Sendspin speakers in Velvet Rooms | Everything Music Assistant supports (Chromecast, AirPlay, Squeezelite, …) |
| Library | Velvet's library, playlists and smart playlists, browsed directly | Imported into Music Assistant's own library |

Use the Velvet integration when Velvet is your player and you want Home
Assistant to control it. Both can run side by side.

## Before you start

1. Turn on **Velvet Rooms** (admin page, *Velvet Rooms*) and allow or pair at
   least one speaker. See [rooms.md](rooms.md).
2. Pick the Velvet user Home Assistant acts as. It needs the **Cast**
   permission (admin page, *Users*); admins have it implicitly. A dedicated
   user is a good idea: Home Assistant sees that user's libraries, playlists
   and smart playlists.

## Installing

- **HACS:** *HACS, ⋮, Custom repositories*, add
  `https://github.com/aroundmyroom/Velvet` with category *Integration*,
  install **Velvet**, restart Home Assistant. HACS offers each Velvet release
  as an update; keep the integration on the same version as your Velvet
  server.
- **Manually:** copy the folder `custom_components/velvet` from the Velvet
  repository (or the source archive of a Velvet release) into Home
  Assistant's `custom_components` folder and restart.

Requires Home Assistant 2026.2 or newer.

### For developers

The integration's tests live in `test/home_assistant/` (pytest with
`pytest-homeassistant-custom-component`, Python 3.13):

```bash
python3.13 -m venv .venv-ha && .venv-ha/bin/pip install -r test/home_assistant/requirements_test.txt
cd test/home_assistant && ../../.venv-ha/bin/python -m pytest -q
```

`npm run sync-version` stamps the Velvet version into
`custom_components/velvet/manifest.json`.

## Adding Velvet

*Settings, Devices & services, Add integration, Velvet.*

1. Enter the address you open Velvet with (scheme and port included, for
   example `https://music.example.net:3000`). If Velvet uses a self-signed
   certificate, turn off *Verify the SSL certificate*.
2. Sign in, one of two ways:
   - **Approve a code in Velvet** (no password typed into Home Assistant).
     Home Assistant shows a 6-character code. Open Velvet as the chosen user,
     go to **User Settings → Pair a Device**, enter the code and approve it.
     Home Assistant continues by itself. This is Velvet's
     [cross-device login pairing](login-pairing.md): codes are single-use and
     expire after 5 minutes.
   - **Username and password**, used once to get a token. Home Assistant does
     not keep the password.

Home Assistant stores only the token. Velvet tokens do not expire; they stop
working when the user is deleted or the server secret changes. Home Assistant
then asks you to **re-authenticate** (same two choices). A Velvet server
without users (public mode) is added without signing in.

## What you get

### A media player per room

Each room is a device with one `media_player` entity, named after the room
(renaming the room in Velvet renames the device). Rooms you create later
appear by themselves; a room that disappears (its speakers moved into another
room) turns unavailable.

| Home Assistant | Velvet room |
|---|---|
| Play / pause / stop | Resume / pause / stop |
| Next / previous | Next / previous (previous restarts the track when more than 3 s in) |
| Seek | Seek (when the room can seek) |
| Volume / mute | The room's group volume and mute, Sonos followers included |
| Shuffle / repeat (off, all, one) | Shuffle / repeat |
| Clear playlist | Empties the room queue |

State: *playing*, *paused*, *buffering*, *idle* (stopped or nothing queued),
and *off* when none of the room's speakers can play (all offline).

Title, artist, album, duration, position and album art come from the room.
Home Assistant downloads the art itself and shows it through its own image
proxy, so browsers never get the Velvet address or token.

Extra attributes: `speakers` (each speaker and Sonos follower with its
connection, volume and mute), `queue_position`, `queue_length`, `upcoming`,
`line_in` (the source playing, if a line-in plays) and `velvet_room_id`.

### Browsing and playing the library

The media browser shows **Artists** (A–Z), **Albums** (A–Z), **Playlists**,
**Smart playlists** and **Recently added**. Artists, albums, playlists, smart
playlists, *Recently added* and single tracks can be played.

When you play something you choose what happens to the room's queue:

| Enqueue | Result |
|---|---|
| Replace (default) | The room plays the new items; the old queue is gone. |
| Play | Inserted after the current track and played now; the rest of the queue stays. |
| Next | Inserted after the current track. |
| Add | Appended to the queue (starts the room if it was idle). |

`media_player.play_media` also accepts a plain Velvet song path
(`Music/Artist/Album/01 Song.flac`, the root library name first) for
automations.

### Search and Assist

`media_player.search_media` searches albums, artists, tracks and playlists
(smart ones included), best match first. Assist uses it for "play *something*
in *room*": it plays the first match into the room you named.

## Limits

- Rooms play the **Velvet library only**; radio, text-to-speech or media from
  other Home Assistant sources cannot be sent to a room.
- **Auto-DJ** tops up a room only while a Velvet browser tab with that room
  active is open. A queue started from Home Assistant ends at its last track.
- Velvet's Server Audio output and Sonos as a separate output are not part of
  the integration (Sonos has its own Home Assistant integration).
- Speakers are grouped into rooms in Velvet, not with Home Assistant's
  join/unjoin.

## How it talks to Velvet

For the curious and for troubleshooting (all documented in [API.md](API.md)
and [API/rooms.md](API/rooms.md)):

- Sign-in: `POST /api/v1/auth/pair/start` and `GET /api/v1/auth/pair/status`
  (or `POST /api/v1/auth/login`); `GET /api/v1/ping/public` identifies the
  server (its `instanceId` is the integration's unique ID). The token is sent
  in the `x-access-token` header.
- Rooms: one `GET /api/v1/rooms` per poll covers every room, every 3 s while a
  room plays and every 15 s otherwise. Commands use the room routes
  (`play`, `add`, `remove`, `pause`, `resume`, `stop`, `next`, `previous`,
  `seek`, `volume`, `mute`, `shuffle`, `repeat`) and their answer updates Home
  Assistant at once. Queue edits send `queueVersion`; on `409 queue_changed`
  the integration reloads the room state and retries once.
- Library: `/api/v1/db/artists`, `/api/v1/db/albums`,
  `/api/v1/db/artists-albums-multi`, `/api/v1/db/album-songs`,
  `/api/v1/db/artist-folder-songs`, `/api/v1/playlist/getall` and `/load`,
  `/api/v1/smart-playlists` and `/run`, `/api/v1/db/recent/added`,
  `/api/v1/db/search`, and `/album-art/<file>` for art.

The integration's diagnostics download (device page, *Download diagnostics*)
contains the room states and the settings, with the token removed.
