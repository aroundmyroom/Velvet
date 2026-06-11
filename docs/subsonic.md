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

Subsonic uses a **separate password** from your Velvet login. This is necessary because Velvet stores passwords as PBKDF2-SHA512 hashes, which are incompatible with Subsonic's MD5 token scheme.

### Setting your Subsonic password

**As admin (for any user):**
- Admin UI → Users → Password button → "New Subsonic Password" field

**As a regular user:**
- Player → "Subsonic API" nav item → enter new password → Save

### MD5 token auth (recommended)

```
?u=<username>&t=<MD5(password+salt)>&s=<salt>&v=1.16.1&c=<client-name>
```

Example (salt = `abc123`, password = `sesame`):
```
t = MD5("sesameabc123")
```

### Plaintext auth

```
?u=<username>&p=<password>&v=1.16.1&c=<client-name>
```

Hex-encoded plaintext is also accepted:
```
?p=enc:<hex-encoded-password>
```

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
  "serverVersion": "5.16.18-velvet"
}
```

Supported extensions returned by `getOpenSubsonicExtensions`:
- `formPost` — auth parameters may be sent via HTTP POST body
- `noAuth` — server accepts requests with no authentication when no users are configured
- `albumArtist` — `albumArtist` field on song/album objects

Extensions **not** advertised (not implemented): `transcoding`, `songLyrics`, `indexBasedQueue`.

---

## Implemented Endpoints

### System
| Endpoint | Status | Notes |
|---|---|---|
| `ping` | ✅ | Always returns `status: ok` |
| `getLicense` | ✅ | Returns `valid: true`, expires 2099 |
| `getScanStatus` | ✅ | Returns `scanning` bool and `count` |
| `getOpenSubsonicExtensions` | ✅ | Lists `formPost`, `noAuth`, `albumArtist` |

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
| `getNowPlaying` | ✅ | Always empty (no server-side playback tracking) |

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
| `stream` | ✅ | Serves original file via `res.sendFile`; CUE virtual tracks (`cue:<hash>:<index>`) are sliced with ffmpeg into a **temp file** then streamed — writing to a file (not a pipe) allows ffmpeg to patch `STREAMINFO.total_samples` correctly, so Feishin and Symfonium both show accurate per-track duration; re-encoded at `-compression_level 0` (~350× realtime) for minimal latency |
| `download` | ✅ | Same as stream |
| `getCoverArt` | ✅ | Serves from albumArtDirectory; resolves folder IDs (`d:…`, vpath integers) to real art; bare album/song hashes via `getAaFileById`; **artist IDs** (`ar-<artist_id>`) resolve to portrait from `image-cache/artists/`; SVG folder icon fallback |
| `getLyrics` | ✅ | Returns lyrics from file tags if present |
| `scrobble` | ✅ | Updates `playCount` and `lastPlayed` in user_metadata; supports multiple `id` params in one call (batch scrobble per OpenSubsonic spec); forwards to Last.fm / ListenBrainz if enabled |
| `setRating` | ✅ | Stores 1–5 rating in user_metadata; returns error for out-of-range values |

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
| `getSimilarSongs` | ⚠️ | Returns empty list |
| `getSimilarSongs2` | ⚠️ | Returns empty list |
| `getTopSongs` | ⚠️ | Returns empty list |

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
