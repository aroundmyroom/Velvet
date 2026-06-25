# Velvet Subsonic API

Velvet implements the **Subsonic REST API 1.16.1** plus the **Open Subsonic** extensions, making it compatible with the large ecosystem of Subsonic-compatible clients.

### Tested clients (confirmed working)

| Client | Platform | Notes |
|---|---|---|
| **Symfonium** | Android | Full library sync verified (v6.10.0+) |
| **DSub** | Android | ✅ |
| **Substreamer** | iOS | ✅ |
| **Ultrasonic** | Android | ✅ |
| **Feishin** | Desktop | ✅ |
| Clementine / Strawberry | Desktop | ✅ |
| Nautiline | iOS | ✅ |
| Any Subsonic 1.16.1 client | — | Should work |


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
- Passing `u` together with `apiKey` is a protocol error and returns error 43.
- Keys do not expire; they can be revoked individually from the admin UI.
- Supported by Feishin ≥ 0.12, Symfonium ≥ 7, and other modern clients.

### Method 2 — MD5 token auth

Requires a **Subsonic password** (separate from Velvet login — set in Admin UI).

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
| 40 | Wrong username or password |
| 41 | Token auth not supported (LDAP placeholder) |
| 42 | Credentials not supported (future: API key only mode) |
| 43 | Conflicting auth parameters — use exactly one method |

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
  "serverVersion": "0.3.4"
}
```

Supported extensions returned by `getOpenSubsonicExtensions`:
- `formPost` — auth parameters may be sent via HTTP POST body
- `noAuth` — server accepts requests with no authentication when no users are configured
- `albumArtist` — `albumArtist` field on song/album objects
- `apiKeyAuth` — API key authentication via `?apiKey=` parameter
- `songLyrics` — structured lyrics via `getLyricsBySongId` (reads embedded file tags)
- `playbackReport` — `reportPlayback` endpoint for timeline state updates

Extensions **not** advertised: `transcoding` (future PR), `indexBasedQueue`.

---

## Implemented Endpoints

### System
| Endpoint | Status | Notes |
|---|---|---|
| `ping` | ✅ | Always returns `status: ok` |
| `getLicense` | ✅ | Returns `valid: true`, expires 2099 |
| `getScanStatus` | ✅ | Live data from task queue — real `scanning` bool and scanned `count` |
| `startScan` | ✅ | Admin only — triggers a full library rescan |
| `getOpenSubsonicExtensions` | ✅ | Lists `formPost`, `noAuth`, `albumArtist`, `apiKeyAuth`, `songLyrics`, `playbackReport` |
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
| `getArtist` | ✅ | Artist + album list |
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
| `getAlbumList` | ✅ | `newest`, `recent`, `random`, `alphabeticalByName`, `alphabeticalByArtist`, `byGenre`, `byYear`, `starred` |
| `getAlbumList2` | ✅ | Same sort modes, ID3 mode |
| `getRandomSongs` | ✅ | Optional genre/year/folder/size filter |
| `getSongsByGenre` | ✅ | Filtered by exact genre string |
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
| `stream` | ✅ | Serves original file; CUE tracks sliced via ffmpeg with correct STREAMINFO |
| `download` | ✅ | Same as stream |
| `getCoverArt` | ✅ | Serves from albumArtDirectory; supports arbitrary `?size=` parameter (snapped to cache-friendly tiers); artist IDs (`ar-<id>`); SVG folder icon fallback |
| `getLyrics` | ✅ | Legacy v1 stub (returns empty) |
| `getLyricsBySongId` | ✅ | OpenSubsonic `songLyrics` extension — reads embedded lyrics (USLT/plain) from file tags on demand via music-metadata; cached per content hash |
| `scrobble` | ✅ | Updates play count + last played; forwards to Last.fm / ListenBrainz |
| `reportPlayback` | ✅ | OpenSubsonic `playbackReport` extension — `state: started/playing/paused/completed`; updates now-playing; triggers scrobble on completion unless `ignoreScrobble=true` |
| `setRating` | ✅ | Stores 1–5 rating in user_metadata |
| `getAvatar` | ✅ | Returns 404 (no avatar storage) |

### Queue persistence
| Endpoint | Status | Notes |
|---|---|---|
| `savePlayQueue` | ✅ | Saves authenticated user's queue server-side (`id[]`, `current`, `position`) so queue survives client restarts |
| `getPlayQueue` | ✅ | Returns authenticated user's saved queue, current track ID, and playback position (ms) |

### Playlists
| Endpoint | Status | Notes |
|---|---|---|
| `getPlaylists` | ✅ | All playlists visible to the current user |
| `getPlaylist` | ✅ | Full playlist with song list |
| `createPlaylist` | ✅ | Create new or replace existing |
| `updatePlaylist` | ✅ | Rename (`name` param), append songs (`songIdToAdd`), remove by index (`songIndexToRemove`) |
| `deletePlaylist` | ✅ | Delete by ID |

### Bookmarks
| Endpoint | Status | Notes |
|---|---|---|
| `getBookmarks` | ✅ | All bookmarks for the user (with full nested song entry) |
| `saveBookmark` | ✅ | Upsert bookmark at position (ms); `id` required |
| `deleteBookmark` | ✅ | Delete bookmark for a song ID |

### Artist/Album info
| Endpoint | Status | Notes |
|---|---|---|
| `getArtistInfo` | ✅ | Returns `smallImageUrl`/`mediumImageUrl`/`largeImageUrl` pointing to `getCoverArt?id=ar-<artist_id>` when an artist portrait exists in `image-cache/artists/`; biography always empty (no external fetch) |
| `getArtistInfo2` | ✅ | Same |
| `getAlbumInfo` | ⚠️ | Returns empty notes/URL |
| `getAlbumInfo2` | ⚠️ | Same |
| `getSimilarSongs` | ✅ | Last.fm `track.getSimilar` → matched against local library; falls back to empty if no Last.fm API key |
| `getSimilarSongs2` | ✅ | Same |
| `getTopSongs` | ✅ | Last.fm `artist.getTopTracks` → matched against local library; falls back to empty |

### Users (admin only)
| Endpoint | Status | Notes |
|---|---|---|
| `getUser` | ✅ | Non-admin can only see own record |
| `getUsers` | ✅ | Admin only |
| `createUser` | ❌ | Not supported — returns error 50; use Velvet admin panel |
| `updateUser` | ❌ | Not supported — returns error 50; use Velvet admin panel |
| `deleteUser` | ❌ | Not supported — returns error 50; use Velvet admin panel |
| `changePassword` | ✅ | Admin can change any user; user can change own |

### Stubs (return empty/ok)
| Endpoint | Notes |
|---|---|

### Internet radio stations
| Endpoint | Status | Notes |
|---|---|---|
| `getInternetRadioStations` | ✅ | Returns all stations for the authenticated user; `streamUrl` = `link_a`; `coverArt` set to the local image filename when available (served via `getCoverArt`) |
| `createInternetRadioStation` | ✅ | Creates a new station for the user; `streamUrl` stored as `link_a`, `name` required |
| `updateInternetRadioStation` | ✅ | Updates `name` and `streamUrl`; all other fields (art, genre, country, link_b/c) are preserved |
| `deleteInternetRadioStation` | ✅ | Deletes station owned by the user; returns 404 if not found |

| `getPodcasts`, `getNewestPodcasts` | Returns empty list |

---

## Directory / Folder Navigation

### How IDs work

| ID format | Meaning |
|---|---|
| `"1"`, `"2"`, … `"N"` | Vpath root — index into `getMusicFolders` list |
| `"d:<base64url>"` | Encoded sub-directory: `{v: "<vpath>", p: "<relPath>"}` |
| `"<16-char hex>"` | album_id or artist_id (MD5 slug) |
| `"<64-char hex>"` | song hash (SHA256) |
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
| `id` | SHA256 hash of the filepath |
| `title`, `artist`, `album` | From file tags |
| `track`, `discNumber`, `year`, `genre` | From file tags |
| `duration` | Seconds (integer) |
| `suffix`, `contentType` | e.g. `mp3`, `audio/mpeg` |
| `coverArt` | `aaFile` filename if present |
| `parent` | `album_id` |
| `artistId`, `albumId` | 16-char hex MD5 slugs |
| `starred` | ISO date string if starred, omitted otherwise |
| `userRating` | 1–5 or omitted |
| `playCount`, `played` | From user_metadata |
| `replayGain.trackGain` | dB value from file tags (Open Subsonic) |
| `mediaType` | Always `"song"` |
| `isDir` | Always `false` |
| `isVideo` | Always `false` |
| `path` | `<vpath>/<filepath>` |
| `type` | Always `"music"` |

---

## Client Setup

1. **Server URL**: `https://your-server:3000`
2. **Username**: your Velvet username
3. **Password**: your **Subsonic password** (set separately via Admin UI or the Subsonic API nav page)
4. **Use HTTPS**: yes
5. **API version**: leave at default (1.16.1 or auto-detect)

---

## Known Limitations

| Area | Status |
|---|---|
| Transcoding | Not supported — `stream` always serves the original file; `maxBitRate` and `format` params are ignored |
| `getCoverArt` `size` param | Accepted but not used — full-size image always returned |
| `ifModifiedSince` on `getIndexes` | Accepted but ignored — always returns full response |
| Artist/album metadata (bio, similar) | External lookups (Last.fm, MusicBrainz) not wired up |
| `enc:` hex-encoded password | Accepted as auth but not extensively tested |


---
