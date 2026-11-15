# Velvet Subsonic API

Velvet implements the **Subsonic REST API 1.16.1** plus the **Open Subsonic** extensions, making it compatible with the large ecosystem of Subsonic-compatible clients.

> The upstream project removed its Subsonic API in September 2026. Velvet's implementation is its own code and is maintained independently — Subsonic client support is here to stay.

### Tested clients (confirmed working)

| Client | Platform | Notes |
|---|---|---|
| **Music Assistant** | Server (Home Assistant) | Verified against MA's provider stack (py-opensonic 10.4.1) — radio by Velvet's Auto-DJ, loudness, smart playlists, synced lyrics. See [Music Assistant](#music-assistant) below |
| **Symfonium** | Android | Full library sync verified (v6.10.0+) |
| **DSub** | Android | ✅ |
| **Substreamer** | iOS | ✅ |
| **Ultrasonic** | Android | ✅ |
| **Feishin** | Desktop | ✅ |
| **KSub** (Astiga) | Android / iOS | Endpoint audit verified — all 14 endpoints it calls are implemented, including `enc:` hex password auth and `.view` suffixes. Requires a per-user Subsonic password (no token/apiKey auth in the client) |
| Clementine / Strawberry | Desktop | ✅ |
| Nautiline | iOS | ✅ |
| Any Subsonic 1.16.1 client | — | Should work |


## Music Assistant

[Music Assistant](https://www.music-assistant.io/) (the Open Home Foundation's music library manager, tightly integrated with Home Assistant) can use Velvet as an **Open Subsonic** music source. MA then plays your Velvet library on everything it streams to — Chromecast, AirPlay, Squeezelite, Sendspin, Sonos, DLNA players — with Home Assistant automations and voice control.

The split is simple: **MA does the playing, Velvet does the thinking.** Velvet answers MA's Subsonic calls with its own brain instead of plain lookups:

| What MA shows | What Velvet answers with |
|---|---|
| **Radio / "Don't stop the music"** (`getSimilarSongs`) | A chain picked by Velvet's **Auto-DJ**, server-side: every next track is chosen against the one before it — Last.fm similar artists of the *current* artist, BPM corridor, Camelot key, genre family, era, artist cooldown — exactly the scoring the web player's Auto-DJ uses ([autodj-scoring.md](autodj-scoring.md)). No seed, no repeats (not even another version of the same song), audiobooks and radio recordings never included. Works without a Last.fm key too (then BPM/key/genre/era decide). Honours the user's Auto-DJ minimum rating and keyword filter. |
| **Top tracks** of an artist (`getTopSongs`) | Velvet's own play counts (all users of the server — a household's shared taste; one user's counts are too sparse to rank by) blended with Last.fm's top tracks for the artist when a Last.fm key is set, one version per song. |
| **Loudness normalisation** (`replayGain`) | Velvet's rsgain / EBU R128 measurements as OpenSubsonic `replayGain` (`trackGain`, `albumGain`, `trackPeak`, `albumPeak`, gains against −18 LUFS, peaks linear). MA stores them as the track's integrated loudness (−18 − gain) and normalises from the first play on. |
| **Playlists** | Your playlists, plus your **smart playlists** as read-only playlists (`smart:<id>`), evaluated fresh each time MA opens them. |
| **Lyrics** (`getLyricsBySongId`) | Synced lyrics first: a sidecar `.lrc` next to the file, lyrics embedded in the file (SYLT / USLT / Vorbis `LYRICS`, LRC text counts as synced), then lyrics the Velvet web player already fetched from LRCLIB. No network lookups here — MA asks for lyrics of every track it syncs. |
| **Recommendations** (`getAlbumList2`) | Album-level lists: *newest* (by the album's latest addition), *frequent*/*recent*/*highest* (your plays and ratings), *byYear* (sorted by year), *byGenre*. |
| **Track details** | BPM, genre list, MusicBrainz recording id, sample rate / bit depth / channels / bitrate (MA shows the real audio format), artist biography and MusicBrainz artist id from Velvet's artist enrichment. |

### Setup

1. In Velvet: create a Subsonic API key — **Admin → Users → Password button → Subsonic API Keys**
2. In Music Assistant: **Settings → Music Sources → Add → Open Subsonic** and fill in:
   - **Base URL** — `https://<your-server>` (no port here)
   - **Port** — your Velvet port (default `3000`)
   - **API Token** — the key from step 1 (leave username/password empty)
3. Recommended settings:
   - **Enable Podcasts: off** — Velvet serves podcasts through its own player, not the Subsonic podcast endpoints
   - Leave **Enable Legacy Auth** off — Velvet supports modern token and API-key auth
4. Optional: a Last.fm API key in Velvet's config (`lastFM.apiKey`) gives the radio its similar-artist signal and adds Last.fm to top tracks.

### Notes

- **Radio speed.** A 25-track radio takes well under a second once Velvet has the Last.fm similar-artist lists it needs (they are cached for hours, and the artists of every radio are looked up in the background for the next one). The first radio for an artist Velvet has never looked up can take 1–3 s; Last.fm time per request is capped, after which the chain keeps the last similar-artist list, as the web Auto-DJ does.
- **Play counts.** MA's Open Subsonic provider never sends `scrobble` or `reportPlayback` for music (only podcast bookmarks), so tracks played through MA do not appear in Velvet's play history, statistics or Velvet's Last.fm/ListenBrainz forwarding. Use MA's own Last.fm / ListenBrainz scrobble plugins for those services.
- **Sendspin speakers.** A Sendspin speaker plays for one server at a time. If both MA and Velvet Rooms ([rooms.md](rooms.md)) know the same speaker, whichever starts playing takes it over from the other.
- MA cannot play some **opus/m4a/VBR** files over a Subsonic connection (a known MA limitation). Workaround: enable Velvet transcoding (`transcode.enabled: true`) so MA can request a compatible format.
- Verified against MA's exact client stack (py-opensonic 10.4.1, MA's own `parsers.py`): library sync, streaming, cover art, synced lyrics, radio, top tracks, album lists, smart playlists, loudness, star/unstar.


## Base URL

```
https://<your-server>:<port>/rest/
```
All endpoints are available both with and without the `.view` extension, e.g.:

```
/rest/ping
/rest/ping.view     ← same thing
```

---

## Authentication

Velvet supports three authentication methods for Subsonic clients.

### Method 1 — API Key (recommended, OpenSubsonic `apiKeyAuth` extension)

Generate a key in Admin UI → Users → Password button → "Subsonic API Keys" section.

```
?apiKey=<key>&v=1.16.1&c=<client-name>
```

- No `u` (username) parameter needed — the key encodes the identity.
- Passing `u`, `p`, `t` or `s` together with `apiKey` is a protocol error and returns error 43.
- Keys do not expire; they can be revoked individually from the admin UI.
- Supported by Feishin ≥ 0.12, Symfonium ≥ 7, and other modern clients.

### Method 2 — MD5 token auth

Requires a **Subsonic password** (separate from Velvet login — set in Admin UI, or by the user in the player, see below).

```
?u=<username>&t=<MD5(password+salt)>&s=<salt>&v=1.16.1&c=<client-name>
```

Example (salt = `abc123`, password = `sesame`):
```
t = MD5("sesameabc123")
```

### Method 3 — Plaintext

```
?u=<username>&p=<password>&v=1.16.1&c=<client-name>
```

Hex-encoded plaintext is also accepted: `?p=enc:<hex-encoded-password>`

### Auth error codes

| Code | Meaning |
|---|---|
| 40 | Wrong username or password, unknown API key, or the user has no Subsonic password set |
| 43 | Conflicting auth parameters — use exactly one method |

If no users are configured at all, every request is accepted (`noAuth`); use `velvet-user` as the username.

### Other error codes

| Code | Meaning |
|---|---|
| 0 | Generic error |
| 10 | Required parameter missing |
| 50 | Not allowed (e.g. `startScan` as non-admin, changing a smart playlist, user management) |
| 70 | Not found — also returned for an unknown method name |

---

## Response Formats

Append `&f=json` for JSON (default: XML):

```
?f=json    → JSON
?f=xml     → XML  (default)
?f=jsonp&callback=myFn  → JSONP
```

---

## Open Subsonic

Every response includes:

```json
{
  "openSubsonic": true,
  "type": "velvet",
  "serverVersion": "<version from package.json>"
}
```

Supported extensions returned by `getOpenSubsonicExtensions`:
- `formPost` — auth parameters may be sent via HTTP POST body
- `noAuth` — server accepts requests with no authentication when no users are configured
- `albumArtist` — `albumArtist` field on song/album objects
- `apiKeyAuth` — API key authentication via `?apiKey=` parameter
- `songLyrics` — structured lyrics via `getLyricsBySongId` (sidecar file, embedded tags, LRCLIB cache)
- `transcodeOffset` — `stream` accepts `timeOffset` (seconds) when transcoding

Extensions **not** advertised: `playbackReport` (some clients prefer it over
classic `scrobble` while setting `ignoreScrobble=true`, suppressing play counts
and Last.fm/ListenBrainz forwarding), `transcoding` (clients that only half
implement it fall back to `format=raw`; `stream` handles `format`/`maxBitRate`
natively), `indexBasedQueue`. The `reportPlayback`, `getTranscodeDecision` and
`getTranscodeStream` endpoints still work for clients that call them directly.

---

## Implemented Endpoints

### System
| Endpoint | Status | Notes |
|---|---|---|
| `ping` | ✅ | Always returns `status: ok` |
| `getLicense` | ✅ | Returns `valid: true`, expires 2099-12-31 |
| `getScanStatus` | ✅ | Live data from task queue — real `scanning` bool and scanned `count` |
| `startScan` | ✅ | Admin only — triggers a full library rescan |
| `getOpenSubsonicExtensions` | ✅ | Lists `formPost`, `noAuth`, `albumArtist`, `apiKeyAuth`, `songLyrics`, `transcodeOffset` |
| `tokenInfo` | ✅ | Returns `{ username, authMethod }` for the current session |

### Library — Folder browsing
| Endpoint | Status | Notes |
|---|---|---|
| `getMusicFolders` | ✅ | Returns all vpaths the user can access; ID = 1-based index |
| `getIndexes` | ✅ | No `musicFolderId` → lists vpaths A-Z; with `musicFolderId` → lists first-level FS directories of that vpath A-Z |
| `getMusicDirectory` | ✅ | Integer id → vpath root; `d:…` id → sub-directory; album_id string → album fallback for legacy clients |

### Library — ID3/tag browsing
| Endpoint | Status | Notes |
|---|---|---|
| `getArtists` | ✅ | Alphabetical artist index grouped by letter |
| `getArtist` | ✅ | Artist + album list; `musicBrainzId` when known |
| `getAlbum` | ✅ | Album + song list; single-FLAC CUE-sheet albums expand into virtual per-track entries |
| `getSong` | ✅ | Single song by hash ID |

### Search
| Endpoint | Status | Notes |
|---|---|---|
| `search` | ✅ | Legacy v1 — delegates to search2 logic |
| `search2` | ✅ | Folder-based; returns artists, albums, songs |
| `search3` | ✅ | ID3-based (same data, different wrapper) |

Song results in `search2`/`search3` match the query against **title, artist, or album** (FTS5 column set on `fts_files`). Searching an artist or album name therefore surfaces that artist's songs — behaviour expected by Symfonium, DSub, and substreamer. The **album** category remains album-name-only; the **artist** category remains artist-name-only.

### Album lists
| Endpoint | Status | Notes |
|---|---|---|
| `getAlbumList` | ✅ | `size` default 10, max 500. `newest`, `recent`, `frequent`, `highest`, `random`, `alphabeticalByName`, `alphabeticalByArtist`, `byGenre`, `byYear`, `starred`. `newest`/`recent`/`frequent`/`highest`/`byYear`/`byGenre` are album-level queries (paged with `size`/`offset`); `byYear` is sorted by year, descending when `fromYear` > `toYear` |
| `getAlbumList2` | ✅ | Same sort modes, ID3 mode |
| `getRandomSongs` | ✅ | Optional genre/year/folder/size filter |
| `getSongsByGenre` | ✅ | Filtered by exact genre string; `count` max 500 |
| `getGenres` | ✅ | All genres with song and album counts |
| `getNowPlaying` | ✅ | Updated by `scrobble` (submission=false) and `reportPlayback` |

### Starred
| Endpoint | Status | Notes |
|---|---|---|
| `getStarred` | ✅ | Folder-based starred songs and albums |
| `getStarred2` | ✅ | ID3-based starred items |
| `star` | ✅ | Stars a song, album, or artist by ID |
| `unstar` | ✅ | Removes star |

### Playback
| Endpoint | Status | Notes |
|---|---|---|
| `stream` | ✅ | Serves original file, or transcodes (see [Known Limitations](#known-limitations)); CUE tracks sliced via ffmpeg with correct STREAMINFO |
| `download` | ✅ | Same as stream |
| `getTranscodeDecision` | ✅ | OpenSubsonic transcoding v1 (not advertised): returns `canDirectPlay`, `canTranscode`, source/target stream info and a `transcodeParams` token. Songs only |
| `getTranscodeStream` | ✅ | Streams the transcode described by `transcodeParams` (needs `mediaId`; optional `offset`); requires `transcode.enabled` |
| `getCoverArt` | ✅ | Serves from albumArtDirectory; `?size=` makes a thumbnail (≤160 → 92 px, ≤320 → 256 px, larger → rounded up to a multiple of 32, max 1200 px; made in the background, the full image is served until it exists); artist IDs (`ar-<id>`); SVG folder icon fallback |
| `getLyrics` | ✅ | Legacy v1: finds the song by `artist` + `title` and returns its lyrics as plain text |
| `getLyricsBySongId` | ✅ | OpenSubsonic `songLyrics` extension — sidecar `.lrc`/`.txt`, then lyrics embedded in the file (SYLT, USLT, Vorbis `LYRICS`; LRC text is returned synced), then the web player's LRCLIB cache. Synced first; cached per content hash |
| `scrobble` | ✅ | Updates play count + last played (stored in milliseconds, like plays from the web player, so Subsonic plays sort correctly in Recently Played) and records a play event for Your Stats; forwards to Last.fm / ListenBrainz |
| `reportPlayback` | ✅ | Available to explicit callers but not advertised; updates timeline state and honours `ignoreScrobble`. Clients use classic `scrobble` for reliable play counts and Last.fm/ListenBrainz forwarding. |
| `setRating` | ✅ | 1–5 stars, stored as Velvet's 2–10 rating in user_metadata; `0` removes the rating |
| `getAvatar` | ✅ | Returns 404 (no avatar storage) |

### Queue persistence
| Endpoint | Status | Notes |
|---|---|---|
| `savePlayQueue` | ✅ | Saves authenticated user's queue server-side (`id[]`, `current`, `position`) so queue survives client restarts |
| `getPlayQueue` | ✅ | Returns authenticated user's saved queue, current track ID, and playback position (ms) |

### Playlists
| Endpoint | Status | Notes |
|---|---|---|
| `getPlaylists` | ✅ | All playlists visible to the current user, plus the user's smart playlists as read-only entries (`id` `smart:<n>`, `readonly: true`); includes `created`/`changed` timestamps (required by spec — verified against py-opensonic strict parsing) |
| `getPlaylist` | ✅ | Full playlist with song list; a `smart:<n>` id runs the smart playlist |
| `createPlaylist` | ✅ | Create new or replace existing |
| `updatePlaylist` | ✅ | Rename (`name` param), append songs (`songIdToAdd`), remove by index (`songIndexToRemove`); error 50 for smart playlists |
| `deletePlaylist` | ✅ | Delete by ID; error 50 for smart playlists |

### Bookmarks
| Endpoint | Status | Notes |
|---|---|---|
| `getBookmarks` | ✅ | All bookmarks for the user (with full nested song entry) |
| `createBookmark` | ✅ | Upsert bookmark at position (ms), optional `comment`; `id` required (the Subsonic spec name) |
| `saveBookmark` | ✅ | Same as `createBookmark`, kept for clients that use this name |
| `deleteBookmark` | ✅ | Delete bookmark for a song ID |

### Artist/Album info
| Endpoint | Status | Notes |
|---|---|---|
| `getArtistInfo` | ✅ | `biography` and `musicBrainzId` from Velvet's artist enrichment (empty biography when none); `smallImageUrl`/`mediumImageUrl`/`largeImageUrl` pointing to `getCoverArt?id=ar-<artist_id>` when an artist portrait exists in `image-cache/artists/` |
| `getArtistInfo2` | ✅ | Same |
| `getAlbumInfo` | ⚠️ | Returns empty `notes` |
| `getAlbumInfo2` | ⚠️ | Same |
| `getSimilarSongs` | ✅ | Radio chain by Velvet's Auto-DJ (`src/autodj/`), `count` tracks (default 50, max 100), seed excluded; `id` may be a song, album or artist id. Last.fm `track.getSimilar` is only the fallback when the chain finds nothing |
| `getSimilarSongs2` | ✅ | Same |
| `getTopSongs` | ✅ | `count` default 50, max 200. The artist's songs ranked by Velvet play counts (all users) blended with Last.fm `artist.getTopTracks` when a key is set; one version per song |

### Users
| Endpoint | Status | Notes |
|---|---|---|
| `getUser` | ✅ | Non-admin can only see own record |
| `getUsers` | ✅ | Admin only |
| `createUser` | ❌ | Not supported — returns error 50; use Velvet admin panel |
| `updateUser` | ❌ | Not supported — returns error 50; use Velvet admin panel |
| `deleteUser` | ❌ | Not supported — returns error 50; use Velvet admin panel |
| `changePassword` | ✅ | Sets the **Subsonic** password; admin can change any user, a user can change their own; `enc:` hex accepted |

### Internet radio stations
| Endpoint | Status | Notes |
|---|---|---|
| `getInternetRadioStations` | ✅ | Returns the authenticated user's stations that have a stream URL; `streamUrl` = `link_a`; `coverArt` set to the local image filename when available (served via `getCoverArt`) |
| `createInternetRadioStation` | ✅ | Creates a new station for the user; `streamUrl` stored as `link_a`; `streamUrl` and `name` required |
| `updateInternetRadioStation` | ✅ | Updates `name` and `streamUrl` (`id`, `streamUrl`, `name` all required); all other fields (art, genre, country, link_b/c) are preserved |
| `deleteInternetRadioStation` | ✅ | Deletes station owned by the user; error 70 if not found |

### Stubs
| Endpoint | Notes |
|---|---|
| `getPodcasts`, `getNewestPodcasts` | Return an empty list |
| `getAvatar` | HTTP 404 |

Any other method name returns error 70 (`Subsonic method "<name>" not found`).

---

## Directory / Folder Navigation

### How IDs work

| ID format | Meaning |
|---|---|
| `"1"`, `"2"`, … `"N"` | Vpath root — index into `getMusicFolders` list |
| `"d:<base64url>"` | Encoded sub-directory: `{v: "<vpath>", p: "<relPath>"}` |
| `"<16-char hex>"` | album_id or artist_id (MD5 slug) |
| `"<32-char hex>[@<rowid>]"` | song: file hash (MD5 of the first 512 KB), plus the DB row id to tell duplicate files apart |
| `"cue:<hash>[@<rowid>]:<index>"` | virtual CUE track |
| `"ar-<artist_id>"` | artist image (for `getCoverArt`) |
| `"smart:<n>"` | smart playlist |
| `"<filename>.jpg"` etc. | Direct album art filename in albumArtDirectory |

### Folder art logic

`getCoverArt` for a folder ID:
1. Decode the `d:…` ID or resolve vpath integer → `(dbVpath, dirRelPath)`
2. `getAaFileForDir(vpath, relPath)` — returns `MAX(aaFile)` from any file under that directory (cached in memory)
3. If an art file is found on disk → serve it with `Cache-Control: public, max-age=86400`
4. Otherwise → serve inline SVG folder icon

### `getIndexes` behaviour

| Request | Response |
|---|---|
| `GET getIndexes` (no musicFolderId) | Returns vpaths as artist entries, A-Z grouped |
| `GET getIndexes?musicFolderId=2` | Returns first-level subdirs of vpath 2, A-Z grouped |

Clients then navigate deeper using `getMusicDirectory?id=<dirId>`.

---

## Song Object Fields

| Field | Value |
|---|---|
| `id` | File hash plus `@<rowid>` (see [How IDs work](#how-ids-work)) |
| `title`, `artist`, `album` | From file tags |
| `track`, `discNumber`, `year`, `genre` | From file tags |
| `duration` | Seconds (integer) |
| `suffix`, `contentType` | e.g. `mp3`, `audio/mpeg` |
| `coverArt` | `aaFile` filename if present |
| `parent` | `album_id` (or `artist_id`, or `root`) |
| `artistId`, `albumId` | 16-char hex MD5 slugs |
| `starred` | ISO date string if starred, omitted otherwise |
| `userRating` | 1–5 (Velvet rating ÷ 2) or omitted |
| `playCount`, `played` | From user_metadata |
| `replayGain` | `trackGain`/`albumGain` (dB, −18 LUFS reference: rsgain measurement → R128 tag → ReplayGain tag) and `trackPeak`/`albumPeak` (linear) |
| `bpm`, `genres`, `musicBrainzId` | BPM (rounded), genre tag split into `[{ name }]`, MusicBrainz recording id |
| `samplingRate`, `bitDepth`, `channelCount`, `bitRate` | From the scan (bitRate in kbps; a format estimate when unknown) |
| `displayArtist`, `artists`, `displayAlbumArtist` | Track artist with its id; album artist when it differs |
| `mediaType` | Always `"song"` |
| `isDir` | Always `false` |
| `isVideo` | Always `false` |
| `path` | `<vpath>/<filepath>` |
| `type` | Always `"music"` |

---

## Client Setup

1. **Server URL**: `https://your-server:3000`
2. **Username**: your Velvet username
3. **Password**: your **Subsonic password** (set separately via Admin UI or the Subsonic API page in the player), or use an API key if the client supports it
4. **Use HTTPS**: yes
5. **API version**: leave at default (1.16.1 or auto-detect)

### Your own password and scrobble switches

A user does not need an admin for this. On the Subsonic API page in the player, a user sets their own Subsonic password and turns forwarding of Subsonic plays to Last.fm and ListenBrainz on or off. The player uses `POST /api/v1/user/subsonic-password` (`{ password }`) and `POST /api/v1/user/subsonic-scrobble` (`{ scrobbleLastfm?, scrobbleLb? }`). An admin can still set any user's Subsonic password (and manage their API keys) under Admin → Users; the scrobble switches are only set by the user.

---

## Known Limitations

| Area | Status |
|---|---|
| Transcoding | ✅ Supported — `stream` transcodes when `format` is `mp3`/`opus`/`aac` or `maxBitRate` is set (missing values fall back to `transcode.defaultCodec` / `transcode.defaultBitrate`); `format=raw` always sends the original; `timeOffset` starts mid-track. Requires `transcode.enabled: true` in config. When transcoding is enabled, songs in a lossless format (FLAC, WAV, AIFF, APE, WavPack, DSF/DFF, WMA, ALAC) carry `transcodedSuffix` (`transcode.defaultCodec`, default `opus`) and `transcodedContentType` so clients show the output format; other songs carry neither. |
| `ifModifiedSince` on `getIndexes` | Honoured — returns an empty index when nothing was scanned since that time |
| Album notes | `getAlbumInfo` returns empty notes |
| `enc:` hex-encoded password | Accepted for auth and `changePassword` |


---
