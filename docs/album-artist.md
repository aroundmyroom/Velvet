# ALBUMARTIST / album_artist

Velvet correctly handles the distinction between *track artist* (ID3 `TPE1` / `ARTIST`) and *album artist* (ID3 `TPE2` / `ALBUMARTIST`) across all surfaces: the player frontend, the Album Library, search, MusicBrainz enrichment, the Tag Workshop, and Subsonic/OpenSubsonic clients.

---

## Background

Many music files — especially compilation albums and CUE-ripped discs — have:

| Field | Tag | Example |
|---|---|---|
| Track artist | `TPE1` / `ARTIST` | `Jones & Stephenson` |
| Album artist | `TPE2` / `ALBUMARTIST` | `Various` |

Before this feature, tracks with a blank `ARTIST` tag showed no artist anywhere in the UI. Velvet now uses `ALBUMARTIST` as a transparent fallback.

---

## Database columns

| Column | Source | Notes |
|---|---|---|
| `files.album_artist` | ID3 `TPE2` / Vorbis `ALBUMARTIST` | Populated by the scanner |
| `files.mb_album_artist` | MusicBrainz release `artist-credit` | Set by the MB enrichment worker |

Both columns are present after the first server start (automatic `ALTER TABLE` migrations with silent `try/catch`).

---

## Artist display — context-aware rules

The `artist` and `album_artist` fields serve different purposes depending on context:

| Context | Rule | Rationale |
|---|---|---|
| **Album detail track list** (albums-browse) | `album_artist \|\| artist` | Keeps VA compilations under one artist; all tracks show the album owner |
| **Queue / player bar — default** | `artist \|\| album_artist` | Shows the performer ("Wham!"), not the album grouping label |
| **Queue / player bar — toggle ON** | `album_artist \|\| artist` *(albumsOnly vpaths only)* | User-configured; see [Queue Artist Display toggle](#queue-artist-display-toggle) below |
| **Subsonic album card** (buildAlbum) | `album_artist \|\| artist` | Album-level grouping, same as iTunes/MediaMonkey |
| **Subsonic song object** | track `artist` + separate `albumArtist` field | Clients handle both per the OpenSubsonic spec |

### Examples (default — toggle off)

| Scenario | artist tag | album_artist tag | Album view | Queue |
|---|---|---|---|---|
| CUE rip, no track artist | `null` | `Donna Summer` | **Donna Summer** | **Donna Summer** |
| VA compilation track | `Wham!` | `Various Artists` | **Various Artists** | **Wham!** |
| Feat. track | `Prodigy feat. Maxim` | `Prodigy` | **Prodigy** | **Prodigy feat. Maxim** |
| Normal album | `Michael Jackson` | `Michael Jackson` | **Michael Jackson** | **Michael Jackson** |

### Examples (toggle ON, albumsOnly vpath)

| Scenario | artist tag | album_artist tag | Album view | Queue |
|---|---|---|---|---|
| CUE rip, no track artist | `null` | `Donna Summer` | **Donna Summer** | **Donna Summer** |
| VA compilation track | `Wham!` | `Various Artists` | **Various Artists** | **Various Artists** |
| Feat. track | `Prodigy feat. Maxim` | `Prodigy` | **Prodigy** | **Prodigy** |
| Normal album | `Michael Jackson` | `Michael Jackson` | **Michael Jackson** | **Michael Jackson** |

---

## Queue Artist Display toggle

**Location:** Settings → Queue Artist Display → *Use Album Artist in queue*

### What it does

When enabled, tracks from **albumsOnly vpaths** show `album_artist` (with `artist` as fallback) in:
- The **player bar** artist line
- The **queue panel** artist line per track
- The **Now Playing** modal artist line

Tracks from non-albumsOnly vpaths (recordings, YouTube downloads, audio-books, etc.) are **never affected** by this toggle.

### When to use it

Turn this on if your Album Library tracks have correct `ALBUMARTIST` / `TPE2` tags and you want the queue to reflect the album owner rather than individual track performers. Typical use cases:

- Single-artist albums where every track has `ARTIST = "Artist feat. X"` but `ALBUMARTIST = "Artist"` — the queue stays clean
- Classical albums where you want to see the conductor/orchestra in the queue, not the individual soloists
- Compilations where `Various Artists` is more informative than individual track artists in the queue

### What it does NOT affect

| Area | Behaviour |
|---|---|
| Auto-DJ similar-artists | Always uses `song.artist` (track artist) for similarity lookups |
| Scrobbling (Last.fm / ListenBrainz) | Always uses `song.artist` |
| Subsonic song/album objects | Governed by separate `buildSong()` / `buildAlbum()` rules |
| Non-albumsOnly vpaths | Always `artist \|\| album_artist` regardless of toggle |

### Storage

`localStorage` key: `ms2_queue_aa_artist_<username>` — per-browser, per-user. Default: **off**.

---

## Album artist in the Album Library

`getAllAlbumIds()` uses `MAX(album_artist)` in the GROUP BY query so each album row carries its album artist. This feeds:
- **Subsonic `buildAlbum()`** — uses `albumRow.album_artist || albumRow.artist` as the displayed artist for the album, so Symfonium/Feishin/Sonixd correctly group compilations under "Various Artists"
- **Subsonic `getAlbumList2`** — passes `album_artist` through from the rows

---

## MusicBrainz enrichment

The MB enrichment worker (`src/util/mb-enrich-worker.mjs`) now extracts two artist fields from the API response:

| Variable | Source | Stored in |
|---|---|---|
| `mbArtist` | `apiData['artist-credit'][0].artist.name` | `files.mb_artist` |
| `mbAlbumArtist` | `best['artist-credit']` (release-level) | `files.mb_album_artist` |

`mbAlbumArtist` is built by joining all `artist-credit` entries from the *selected release* (not the recording), preserving join phrases (`" & "`, `" feat. "`, etc.).

---

## Tag Workshop

When the Tag Workshop writes accepted MusicBrainz tags back to a file, it writes `ALBUMARTIST` using the priority chain:

```
mb_album_artist  →  album_artist  →  null
```

The `_tagsHaveDiff()` check includes `album_artist` so files are only re-written when the value actually changes.

---

## Full-text search (FTS)

`fts_files` now indexes six columns:

```
title, artist, album_artist, album, album_version, filepath
```

On first server start after upgrading, the FTS table is automatically rebuilt (the migration probe now checks for both `album_version` AND `album_artist`). This may cause a brief delay on first start for large libraries.

---

## Subsonic / OpenSubsonic

### `getSong` / `getMusicDirectory`

`albumArtist` is included in song objects when it differs from `artist`. When they are the same, it is omitted (per OpenSubsonic spec to avoid redundancy).

### `getAlbum`

The `album_artist` value from the first track is passed into `buildAlbum()` so the album-level artist display uses the album artist.

### `getAlbumList` / `getAlbumList2`

All list types pass `album_artist` through to `buildAlbum()`.

### `getOpenSubsonicExtensions`

Returns `{ name: 'albumArtist', versions: [1] }` so clients can detect the feature.

---

## API response shape

### `renderMetadataObj` response (`/api/v1/db/metadata`, rated songs, recently-added, etc.)

```json
{
  "filepath": "Music/Albums/Various/track.flac",
  "metadata": {
    "artist": "Jones & Stephenson",
    "album-artist": "Various",
    ...
  }
}
```

When `artist` is null, `"artist"` falls back to `"album-artist"` value automatically.

### Subsonic `getSong` response (when artist ≠ album artist)

```json
{
  "id": "...",
  "title": "The Eve Of The War",
  "artist": "Jeff Wayne",
  "albumArtist": "Various Artists",
  ...
}
```

---

## Scope

All ALBUMARTIST improvements are active for **all vpaths** — the artist fallback (`artist || album_artist`) applies everywhere, not just albumsOnly sources. The albumsOnly context is where it matters most (VA compilations in the Album Library), but the fallback is universally safe.

The **Queue Artist Display toggle** additionally lets users choose to show `album_artist` *primary* in the queue, but this is scoped to albumsOnly vpaths only — see the [toggle section](#queue-artist-display-toggle) above.
