# Plan: a native Velvet provider for Music Assistant

Status: research done 2026-11-14, parked. None of the provider and none of
the `/api/v1/ma/*` layer below is built (no `/ma/` routes in `src/`, no
`integrations/` folder). Some of the gains in section 2 now reach MA through
Velvet's OpenSubsonic API instead (v0.9.3, see section 2).

Today Music Assistant (MA) reaches Velvet through its built-in OpenSubsonic
provider. The idea is a `velvet` provider that talks to Velvet's own REST API,
so MA gets everything Velvet knows instead of what fits through Subsonic.

## 1. The hard limit: MA cannot install a provider from outside

This decides how the provider reaches users, so it comes first.

- MA 2.10.11 (current stable, Python 3.14) loads providers only from its own
  package folder `music_assistant/providers/<domain>/`. There is no upload
  button, no plugin folder and no setting for an extra path.
- MA is building a Community Catalog (PR #7641, not released). It installs only
  providers listed in a registry that the MA team approves, pinned to a checked
  commit of the author's GitHub repository. The design notes say plainly that it
  will not install "from a link or a folder".
- So "download the provider from Velvet and upload it into MA" is not possible,
  now or with the catalog.

What does work:

| Route | Who can use it | Notes |
|---|---|---|
| Bind-mount the folder into the MA container | Docker users | Path `/app/venv/lib/python3.14/site-packages/music_assistant/providers/velvet`. Not supported by MA; the path breaks when MA moves to a new Python version. Good for our own testing. |
| Own image `FROM ghcr.io/music-assistant/server` | Docker users | Sturdier than a mount, but rebuilt for every MA release. |
| Upstream PR to `music-assistant/server` | Everyone, including the Home Assistant add-on | The route MA asks for. A maintainer approves new providers; after that the codeowner can merge changes to their own folder. Starts at stage `experimental`. |
| Community Catalog | Everyone, later | Provider lives in Velvet's GitHub repo. Registry not public yet. |

Home Assistant add-on users cannot mount anything, so for them only the
upstream PR (or later the catalog) works.

**MA's AI policy** (Open Home Foundation): AI-written code is allowed, but the
person who opens the PR must have reviewed it, understand every line and answer
maintainer questions in their own words. Autonomous agents may not open PRs or
issues. So an upstream PR has to be opened and defended by Dennis, not by an
agent.

What Velvet's admin can still offer: a download of the provider folder (zip)
plus a ready `docker compose` snippet for the mount, clearly marked as a test
route until the provider is in MA.

## 2. What we gain over OpenSubsonic

Already available over OpenSubsonic since v0.9.3 (built in
`src/api/subsonic.js`): `getSimilarSongs`/`getSimilarSongs2` answer with
Velvet's server Auto-DJ chain (MA's radio); `getTopSongs` from Velvet's play
counts; smart playlists as read-only playlists; full `replayGain` (track and
album gain and peak), used by MA as loudness; synced lyrics from `.lrc`, tags
and the lyrics cache; BPM, genre list, MusicBrainz ids and real audio format
per song. A Subsonic `scrobble` call counts the play (and, per user setting,
sends it to Last.fm/ListenBrainz); whether MA sends it was not checked.

What a native provider would still add:

- Plays from MA count in Velvet like web-player plays: play count, Wrapped
  (with skip and stop), Last.fm and ListenBrainz per user.
- Velvet's own Auto-DJ radio as MA's "similar tracks", without the Subsonic
  wrapper.
- ReplayGain source, musical key, bit depth, album versions.
- Genre groups, decades, unplayed gems and "on this day" as MA
  recommendations.
- Velvet's radio stations, folder browsing with the child-vpath rules.
- A revocable key per MA instance instead of a Subsonic password.

## 3. Velvet side: a small `/api/v1/ma/*` layer

The native API is shaped for the web player: tracks are identified by
`vpath/filepath`, there are no paged full listings, no album or artist lookup
by ID, and the Auto-DJ radio is reachable only over Subsonic (and, for a
room, through `RoomManager.setAutoDj`; a native `POST /api/v1/autodj/next` is
being added for the TV and remote apps). Most of the logic
already exists in `src/api/subsonic.js` and `src/autodj/`; the new layer reuses
it and returns plain JSON.

**Auth**
- Accept the existing OpenSubsonic API keys in the native middleware
  (`x-api-key` header and `?apiKey=` query, resolved with
  `db.getUsernameByApiKey`). Today only `src/api/subsonic.js` reads API keys;
  the native middleware in `src/api/auth.js` accepts JWTs only. The admin issues one key per MA instance and can
  revoke it. Query support is needed because MA's ffmpeg fetches the stream URL
  itself.

**Endpoints** (all scoped to the key's user and vpaths)
- `GET /ma/info`: Velvet version, library version (last scan time) so MA can
  skip an unchanged sync (`NothingToSync`).
- `GET /ma/artists|albums|tracks?offset&limit`: paged full listings with
  `artist_id`, `album_id`, MBIDs, `added` time, audio format, rg, bpm, key,
  genres, cover file.
- `GET /ma/artist/:id`, `/ma/album/:id`, `/ma/track/:id`, plus album tracks,
  artist albums and artist top songs (reuse `rankTopSongs`).
- `GET /ma/search?q&types&limit`.
- `GET /ma/similar/:trackId?limit`: `radioForUser` from `src/autodj/library.js`,
  the same picks as Auto-DJ.
- `GET /ma/lyrics/:trackId`: `songLyrics` from `src/util/song-lyrics.js`.
- Playlists by ID: list, tracks, add, remove, move, create. Smart playlists as
  read-only playlists (run saved by ID).
- Favourites: star/unstar (DB support exists from Subsonic).
- `POST /ma/played {trackId, event: start|progress|end|skip|stop, playedMs}`:
  one call that does what `src/api/room-listen.js` does for rooms (log-play once,
  Wrapped events, scrobbles).
- `GET /ma/stream/:trackId`: the original file with Range support (seeking), or
  a transcode for formats MA cannot read. Always resolves to the root-vpath path
  (child-vpath rule).
- Covers: `/album-art/<file>` is already public; artist images via the existing
  routes.

**IDs**
- Albums and artists: the existing `album_id` / `artist_id` columns
  (deterministic, survive rescans).
- Tracks: open point. `vpath/filepath` changes on rename, the file hash changes
  when tags are rewritten. The Subsonic `hash@rowid` with fallback is the best
  candidate and would let an existing MA library carry over; check first that
  rowids survive a rescan. An unstable ID makes MA delete and re-add tracks.

**Admin**
- "Music Assistant" section: create or revoke the key, download the provider
  zip (`archiver` is already a dependency; stamp the Velvet version into the
  manifest), show the compose snippet. i18n keys in all 12 locales, endpoints in
  `docs/API.md`.

## 4. MA side: the `velvet` provider

Lives in this repo under `integrations/music-assistant/velvet/`, laid out
exactly like an in-tree MA provider so it can be sent upstream unchanged.

- Template: MA's `emby` provider (plain aiohttp, no extra Python packages, so
  `"requirements": []`).
- Files: `__init__.py`, `provider.py`, `parsers.py`, `constants.py`,
  `setup_flow.py` (Velvet URL, API key, verify SSL), `strings.json`,
  `manifest.json` (`type: music`, `domain: velvet`, `multi_instance: true`,
  `stage: experimental`), `icon.svg`, `icon_monochrome.svg`.
- `is_streaming_provider = False` (a self-hosted library).
- Features: library artists, albums, tracks, playlists (+ edit, create, move),
  radios, browse, search, recommendations, artist albums, artist top tracks,
  similar tracks, favourites edit, lyrics.
- Streams: `StreamType.HTTP`, key in the query, `can_seek` and `allow_seek`
  true, real content type and sample rate, `verify_ssl` from setup. The URL
  stays inside the stream details (MA rule).
- Loudness: hand Velvet's ReplayGain to MA as `-18 - gain` with
  `set_track_loudness`, so MA does not analyse the songs itself.
- Images: `remotely_accessible=False`, resolved through `resolve_image`.
- Plays: `on_played` (fires at the end, on stop or skip, and every 30 s) maps to
  `POST /ma/played`.
- Sync: paged generators, `report_skipped_sync_item` for bad rows (otherwise MA
  deletes them), raise on a malformed page (otherwise MA wipes the library).
- Tests in MA's layout (`tests/providers/velvet/`, JSON fixtures, syrupy
  snapshots) and MA's checks: ruff (all rules), mypy strict, manifest, icon,
  config-entry and method-order scripts.

## 5. Phases

1. **Velvet API layer + key auth** (Velvet tests, docs). Useful on its own.
2. **Provider, tested against MA in Docker** with the bind-mount. Library sync,
   playback with seek, Auto-DJ radio, play counting, lyrics.
3. **Admin page**: key, zip download, compose snippet.
4. **Upstream**: Dennis reviews the code, runs MA's pre-commit and tests in an
   MA checkout, opens the PR in person. After approval, maintenance of the
   `velvet` folder upstream (MA changes the provider base classes several times
   a month; in-tree providers get fixed by the core team).
5. **Later**: Community Catalog, if it suits us better than living in MA's repo.

The existing OpenSubsonic route stays; the provider is an addition.

## 6. Rough size

- Velvet layer: 600 to 900 lines of JS plus tests.
- Provider: 900 to 1300 lines of Python plus tests and fixtures (emby is about
  1100, opensubsonic about 1700).
- MA PRs above 1000 changed lines need extra maintainer review; a first PR with
  the core (library, search, stream, plays) and a second with the extras keeps
  it reviewable.

## 7. Test setup

- MA in Docker: `ghcr.io/music-assistant/server:2.10.11`, host networking, the
  provider folder mounted at the path in section 1.
- Point it at a second Velvet instance on a spare port, or at production with a
  dedicated key (reads plus play logging only).
- MA UI at `http://<host>:8095`.
