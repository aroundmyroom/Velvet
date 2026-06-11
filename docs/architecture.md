# Velvet — Architecture Diagrams

Paste any diagram block into [mermaid.live](https://mermaid.live) to view / export as SVG or PNG.

---

## 1. Playback Pipeline

How a song gets from storage to speaker — three output paths.

```mermaid
flowchart TD
    USER["👤 User click\n(viewAlbumDetail / viewSearch\n/ viewFiles / Auto-DJ)"]

    USER --> PLAYER["Player.setQueue(songs, idx)\nor Player.playAt(idx)"]

    PLAYER --> SRC["audioEl.src = /media/vpath/file\naudioEl.load()"]

    SRC --> MUTE{"Casting\nactive?"}

    MUTE -->|"Yes"| GAIN["_castMuteGain = 0\n(silence browser speaker)"]
    MUTE -->|"No"| BROWSER["🔊 Browser speaker\nHTML5 audio element"]
    GAIN --> BROWSER

    PLAYER --> CAST{"Cast\nmode?"}

    CAST -->|"S.castingToMpv"| MPV["POST /api/v1/server-playback/cast\n→ MPV process on server\n→ Server's audio output"]
    CAST -->|"S.castingToSonos"| SONOS["POST /api/v1/sonos/cast\n{ filepath, title, artist,\n  album, aaFile, seekTo }\n→ UPnP SOAP port 1400"]
    CAST -->|"none"| BROWSER

    SONOS --> SONOSDEV["📻 Sonos device\nstreams from Velvet URL"]
    MPV --> MPVDEV["🖥️ Server speaker\n(MPV process)"]

    subgraph "Position sync (3 s poll)"
        SONOSDEV -->|"GET transport-status"| DRIFT["Drift > 5 s?\naudioEl.currentTime = sonosPos"]
    end

    subgraph "CUE sheet seek"
        PLAYER -->|"_pendingCueSeek > 0"| CUESEEK["audioEl: canplay → seek\nSonos: seekTo param in cast call\nMPV: POST /server-playback/seek"]
    end

    subgraph "VU / Spectrum"
        BROWSER --> VIZ["AudioContext → AnalyserNode\nVU needle + spectrum bars"]
    end
```

---

## 2. Scan → Index → Play Data Flow

How files go from disk to the queue.

```mermaid
flowchart TD
    DISK["💾 Music files on disk\n(.flac / .mp3 / .ogg / .opus / .m4a)"]
    SIDECAR["📄 Sidecar files\n(.cue / cover.jpg / .nfo)"]

    DISK --> SCAN
    SIDECAR --> SCAN

    subgraph "Scan pipeline (src/db/scanner.mjs)"
        SCAN["Walk vpath root dir\nhash changed? → re-parse\nhash same? → update sID only"]
        SCAN --> PARSER["music-metadata library\nRead: title/artist/album/year\ntrack/BPM/key/duration\nembedded album-art\nCUE sheet → cuepoints[]"]
        PARSER --> DBWRITE["INSERT / UPDATE files table\nfields: title, artist, album,\nyear, track, bpm, musical_key,\nduration, hash, aaFile, cuepoints"]
    end

    DBWRITE --> SQLITE[("SQLite\nsave/db/velvet.sqlite\ntable: files")]

    subgraph "Post-scan enrichment"
        ACOUSTID["AcoustID fingerprint\n(fpcalc binary)\n→ MusicBrainz MBID lookup"]
        RG["ReplayGain analysis\n(rsgain binary)\n→ rg_album/track_gain_db"]
        DISCOGS["Discogs art picker\n→ embed JPEG into file\n→ sync DB mtime + update aaFile\n→ player reload with tolerant resume"]
        TAGWS["Tag Workshop\n(MusicBrainz enrichment)\n→ write ID3/Vorbis tags\n→ re-scan file"]
    end

    SQLITE --> ACOUSTID
    SQLITE --> RG
    SQLITE --> DISCOGS
    SQLITE --> TAGWS

    subgraph "Query layer (src/db/sqlite-backend.js)"
        SQLITE --> SEARCH["FTS5 full-text search\n(title / artist / album /\nfilepath / cross-field)"]
        SQLITE --> ALBLIB["Album library\n(src/api/albums-browse.js)\ngroup by folder → album objects\n+ disc/track/cuepoints"]
        SQLITE --> ARTAPI["Artists API\n(src/api/artists-browse.js)\nnormalized name index\nMBID / fanart / bio"]
        SQLITE --> RANDOM["Random / Auto-DJ\nBPM windows (±8 + octave)\nkey (Camelot wheel)\nrecency / rating / artist cooldown"]
    end

    SEARCH --> VSEARCH["viewSearch()\nAlbums → viewAlbumDetail()\nTracks → beforePlay() → viewAlbumDetail()\nArtists → viewArtistProfile()"]
    ALBLIB --> VALBDET["viewAlbumDetail()\nDisc tabs / CUE track rows\nPlay All / Add All\n'Album mode' info bar"]
    ARTAPI --> VART["viewArtists()\nviewArtistProfile()\nfanart hero + bio + similar artists"]
    RANDOM --> AUTODJ["Auto-DJ\n_djApiCall() → random-songs\napply BPM / key / artist filters"]

    VSEARCH --> QUEUE
    VALBDET --> QUEUE
    AUTODJ --> QUEUE

    QUEUE["S.queue[]\nPlayer.setQueue(songs, idx)\nPlayer.playAt(idx)"]
    QUEUE --> PLAY["▶ Playback\n(see diagram 1)"]
```

---

## 3. Feature Modules Map

All major subsystems and which API routes / frontend views they connect.

```mermaid
flowchart LR
    subgraph "Frontend (webapp/app.js)"
        direction TB
        NAV["Navigation bar\nHome / Albums / Artists\nSearch / Playlists / Files\nGenres / Decades / Radio\nAuto-DJ / Stats"]

        HOME["viewHome()\nDashboard + recently added"]
        ALBUMS["viewAlbumLibrary()\nviewAlbumSeries()\nviewAlbumDetail()"]
        ARTISTS["viewArtists()\nviewArtistProfile()\nviewArtistAlbums()"]
        SEARCH["viewSearch()\nFull-text multi-category"]
        FILES["viewFiles()\nFile explorer\n(recordings / YouTube)\nZIP download + select mode"]
        PLAYLISTS["viewPlaylists()\nviewSmartPlaylists()\nviewPlayingNow()"]
        GENRES["viewGenres()\nviewDecades()"]
        RADIO["Radio stations\nNow-playing ICY\nScheduled recording"]
        STATS["viewMostPlayed()\nviewRated()\nviewPlayed()\nviewRecent()"]
        ADMINUI["Admin panel\n(webapp/admin/index.js)\nConfig / Scan / Tags\nNormalisation / Integrations"]
    end

    subgraph "Core API (src/api/)"
        direction TB
        DBAPI["db.js\nmetadata / search\nalbum-songs / random\nhome-summary / cuepoints\nrate-song / stats"]
        PLAYAPI["playlist.js\nsmart-playlists.js\ndownload.js (ZIP)"]
        SCANAPI["scanner.js\nfile-explorer.js"]
        ALBUMSAPI["albums-browse.js\nartists-browse.js"]
        RADIOAPI["radio.js\nradio-recorder.js\nradio-scheduler.js"]
        YTAPI["ytdl.js\nYouTube download"]
        TRANSCODEAPI["transcode.js\non-demand format conversion"]
    end

    subgraph "Output"
        BROWSER2["🔊 Browser"]
        MPVOUT["🖥️ MPV (server-playback.js)"]
        SONOSOUT["📻 Sonos (sonos.js)"]
    end

    subgraph "External Services"
        LASTFM["Last.fm\nScrobble + similar artists\n(scrobbler.js / lastfm.js)"]
        LBZ["ListenBrainz\nScrobble + now-playing\n(scrobbler.js)"]
        MBID["MusicBrainz\nAcoustID fingerprint\nTag enrichment\n(acoustid.js / tagworkshop.js)"]
        DISCOGSEXT["Discogs\nAlbum art picker\n(discogs.js)"]
        SONOSEXT["Sonos UPnP\nSMAP discovery\n(sonos.js)"]
    end

    NAV --> HOME & ALBUMS & ARTISTS & SEARCH & FILES & PLAYLISTS & GENRES & RADIO & STATS & ADMINUI

    ALBUMS --> ALBUMSAPI --> DBAPI
    ARTISTS --> ALBUMSAPI --> DBAPI
    SEARCH --> DBAPI
    HOME --> DBAPI
    GENRES --> DBAPI
    STATS --> DBAPI
    PLAYLISTS --> PLAYAPI --> DBAPI
    FILES --> SCANAPI
    FILES --> PLAYAPI
    RADIO --> RADIOAPI
    ADMINUI --> SCANAPI
    ADMINUI --> YTAPI

    DBAPI --> SQLITE2[("SQLite DB")]
    SCANAPI --> SQLITE2

    ALBUMS & ARTISTS & SEARCH & PLAYLISTS & STATS --> PLAYER2["Player.setQueue()\nPlayer.playAt()"]

    PLAYER2 --> BROWSER2
    PLAYER2 --> MPVOUT
    PLAYER2 --> SONOSOUT

    PLAYER2 --> LASTFM
    PLAYER2 --> LBZ
    ADMINUI --> MBID & DISCOGSEXT
    SONOSOUT --> SONOSEXT
    MPVOUT --> MPVOUT
```

---

## 4. Auto-DJ System

How Auto-DJ selects, filters, and queues the next track.

```mermaid
flowchart TD
    SONGEND["🎵 Song ending\n(or DJ turned on\nwith empty queue)"]

    SONGEND --> PREFETCH["autoDJPrefetch()\nFires ~45 s before end\n(crossfade trigger point)"]
    SONGEND -->|"Prefetch wasn't ready"| FETCH["autoDJFetch()\nFires immediately on ended\nWaits up to 12 s for in-flight prefetch"]

    PREFETCH --> DJAPI
    FETCH --> DJAPI

    subgraph "Filters built in _djApiCall()"
        DJAPI["POST /api/v1/db/random-songs\n{ ignoreList, ignoreVPaths,\n  artists, ignoreArtists,\n  bpmRanges, musicalKeys,\n  minRating, ... }"]

        VPATHS["vpath scope\nS.djVpaths (user selection)\nor all music vpaths\nExcludes audio-books\nChild-vpath → filepathPrefix filter"]
        SIMILAR["Similar artists mode\nGET /api/v1/lastfm/similar-artists\nCache per artist (1 call/song)\nFallback: random if no library match"]
        BPM["BPM continuity\n_bpmAnchor locked on first DJ call\n(never drifts with current song)\nRanges: normal ±tol, half ±tol/2, double ±tol×2\nFree pick if no BPM context"]
        HARMONIC["Harmonic mixing\nCamelot wheel neighbours\n(±1 semitone + parallel keys)\nRequires musical_key in DB"]
        MINRATING["Min. rating filter\nS.djMinRating (1–10)"]
        IGNORELIST["Ignore list\nd.ignoreList from server\n(prevents immediate repeat)"]
    end

    DJAPI --> VPATHS & SIMILAR & BPM & HARMONIC & MINRATING & IGNORELIST

    DJAPI --> CANDIDATE["candidate song returned"]

    CANDIDATE --> BLOCK{"_djSongBlocked()?\nKeyword filter\n+ BPM range check\n+ Camelot check"}

    BLOCK -->|"Blocked (up to 3 retries)"| DJAPI
    BLOCK -->|"Passes"| ARTISTCOOL{"Same artist\nin last 15 songs?\n(DJ_ARTIST_COOLDOWN)"}

    ARTISTCOOL -->|"Yes → retry"| DJAPI
    ARTISTCOOL -->|"No"| PUSH["song._dj = true\nS.queue.push(song)\n_pruneQueue()\n(cap 500, keep 10 behind cursor)"]

    PUSH --> STRIP["_showDJStrip()\nInfo strip: 'Similar to [artist]'\nPills: other candidate artists"]
    PUSH --> PLAY2["Player.playAt(idx)\n(fetch path only)"]
    PUSH --> ANCHOR["Lock/update anchors\n_bpmAnchor\n_camelotAnchor\n_camelotAnchorNeighbours\nReset if manual pick (!song._dj)"]

    subgraph "State reset"
        MANPICK["User manually picks song\nPlayer.playAt → !s._dj\n→ reset all anchors\nArtist history cleared on setQueue"]
    end
```

---

## 5. vpath Hierarchy

How virtual paths are configured and how files are stored vs. queried.

```mermaid
flowchart TD
    DISK2["💾 /music/library/\n(physical disk)"]

    subgraph "Config (save/conf/default.json)"
        ROOT["ROOT vpath: Music\nroot: /music/library\ntype: music"]
        CHILD1["CHILD vpath: Albums Only\nparentVpath: Music\nfilepathPrefix: Albums/\nalbumsOnly: true"]
        CHILD2["CHILD vpath: Recordings\nparentVpath: Music\nfilepathPrefix: Recordings/\ntype: recordings\nallowRecordDelete: true"]
        ROOTYT["ROOT vpath: YouTube\nroot: /music/youtube\ntype: youtube"]
    end

    DISK2 --> ROOT
    ROOT --> CHILD1
    ROOT --> CHILD2
    DISK2 --> ROOTYT

    subgraph "SQLite (files table)"
        DB1["vpath='Music'\nfilepath='Albums/BW/track.flac'"]
        DB2["vpath='Music'\nfilepath='Recordings/show.opus'"]
        DB3["vpath='YouTube'\nfilepath='video.mp3'"]
    end

    ROOT --> DB1
    ROOT --> DB2
    ROOTYT --> DB3

    subgraph "Query rules"
        Q1["Albums Only query:\nWHERE vpath='Music'\nAND filepath LIKE 'Albums/%'"]
        Q2["Recordings query:\nWHERE vpath='Music'\nAND filepath LIKE 'Recordings/%'"]
        Q3["YouTube query:\nWHERE vpath='YouTube'"]
    end

    CHILD1 --> Q1
    CHILD2 --> Q2
    ROOTYT --> Q3

    subgraph "Playback URL"
        URL1["GET /media/Music/Albums/BW/track.flac\n(Express.static mount on ROOT vpath name)"]
    end

    DB1 --> URL1
```

### Media route authorization

- Raw media URLs are now authorized by vpath before static-file serving.
- Requests to unknown or unauthorized libraries return `404` (not `403`) so inaccessible library names are not disclosed.
- Authenticated users can only stream from vpaths in `req.user.vpaths`; no-user mode still allows all configured vpaths.

---

## Diagram 6 — Artist Enrichment Pipeline

How artist metadata and images are fetched from external services and stored.

```mermaid
flowchart TD
    CLIENT["viewArtistProfile()\nGET /api/v1/artists/profile?key="]

    subgraph "SQLite: artists table"
        DB_CACHE[("canonicalName, bio, imageFile\nfanartFile, mbid, imageSource\ngenre, country, formedYear\nenrichedAt / lastFetched")]
    end

    CLIENT --> DB_CACHE
    DB_CACHE -->|"imageFile already set"| RETURN
    DB_CACHE -->|"No imageFile\n(background hydration)"| MBID

    MBID["deriveArtistMbidFromFiles()\nJoin files table on normalised\nartist name → pick most common\nMBID from per-song AcoustID data"]

    MBID --> PARALLEL

    subgraph "Parallel enrichment  (Promise.all)"
        direction TB
        DISCOGS["Discogs API\ndatabase/search?type=artist\nBest-match scoring\n→ resource_url → images[]\n→ imageUrl"]
        TADB["TheAudioDB\nMBID-first: artist-mb.php?i=mbid\nFallback: search.php?s=name\n→ strArtistThumb (imageUrl)\n→ strArtistFanart/2/3 (fanartUrl)\n→ strBiographyEN (bio)\n→ strGenre / strCountry\n→ strMusicBrainzID"]
        LFM["Last.fm API\nartist.getInfo\n→ bio.summary (bio)\n→ largest non-placeholder image\n(imageUrl)"]
    end

    PARALLEL["Promise.all(...)"] --> DISCOGS & TADB & LFM

    DISCOGS & TADB & LFM --> MERGE

    MERGE["Merge results\nBio priority: Last.fm › TADB\nFanart: TADB only\nImage priority: TADB › Discogs › Last.fm\n(first download that passes MIN_ARTIST_IMG_BYTES check)"]

    MERGE --> FANART["saveFanartImage()\nDownload TADB fanart URL\nsharp → resize 1280×480 cover/top\nSave: image-cache/artists/<key>_fanart.jpg"]
    MERGE --> IMG["saveArtistImage()\nDownload winning image URL\nGuard: buf.length < 5000 → reject\nsharp → resize 400×400 cover/top\nSave: image-cache/artists/<key>.jpg"]

    FANART & IMG --> SAVEDB["saveArtistInfo()\nWrite to artists table:\nbio, imageFile, fanartFile,\nmbid, genre, country, formedYear,\nimageSource, enrichedAt"]

    SAVEDB --> RETURN["GET /api/v1/artists/profile?key=\n→ { canonicalName, bio, imageFile,\n    releaseCategories[], mbid }"]

    RETURN --> UI

    subgraph "viewArtistProfile() renders"
        UI["Fanart hero banner (1280×480)\nArtist thumbnail (400×400)\nBio chip\nSimilar artists list (Last.fm)\nAlbum grid (albums-browse.js)\nManual image override (admin)"]
    end

    subgraph "Background hydration queue"
        HQ["_imgHydrateQueue[]\nenqueued by home / letter / search\ngetArtistRow — skip if imageFile or\nlastFetched already set\nHYDRATE_COOLDOWN_MS = 12 h\nHYDRATE_QUEUE_LIMIT = 50 000\ndelay OK: 1.4 s / idle: 2.2 s / err: 4 s"]
    end

    DB_CACHE -.->|"Enqueue if no imageFile\n(home / letter browse)"| HQ
    HQ -.->|"_hydrateArtistImage()"| MBID
```

---

## Diagram 7 — Album Library + CUE Sheet Handling

How albums are built from the database and CUE-sheet tracks are expanded.

```mermaid
flowchart TD
    subgraph "Config: vpath declarations"
        VP1["albumsOnly: true\n(root vpath — all files)"]
        VP2["albumsOnly: true\n(child vpath — filepathPrefix='Albums/')"]
        VP3["fallback: any root with Albums/ subdir on disk"]
    end

    VP1 & VP2 & VP3 --> RESOLVE

    RESOLVE["resolveAlbumsSources()\nReturns source[] each with:\nvpathName, dbVpath, prefix,\nvpathRoot, artRoot\n(cached; invalidated on scan)"]

    RESOLVE --> DBQUERY

    DBQUERY["DB query per source\nWHERE vpath=dbVpath\n[AND filepath LIKE prefix+'%']\nReturns rows: filepath, title, artist,\nalbum, track, disk, year, duration,\naaFile, cover_file, cuepoints"]

    DBQUERY --> BUILDTREE

    subgraph "buildTreeFromDB(rows, source) — BOTTOM-UP"
        direction TB
        BUILDTREE["Strip source.prefix from filepath\nFor each file: look backwards from filename"]
        BUILDTREE --> DISCCHECK
        DISCCHECK{"Immediate parent\n= disc folder?\n(CD1, Disc 2, …)"}
        DISCCHECK -->|"Yes"| DISCALBUM["album = grandparent folder\ndisc = immediate parent\n(any depth — e.g. Genre/Artist/Album/CD1/track)"]
        DISCCHECK -->|"No"| FLATALBUM["album = immediate parent folder\n(any depth — e.g. Genre/Artist/Album/track)"]
        DISCALBUM & FLATALBUM --> ARTIST["artist = one folder above album\n(Genre/Artist → artist='Artist')\nEverything above is display context only"]
        ARTIST --> GROUPALBUM["Group by albumPath\nGroup by artistPath → series\n(multiple albums under same artist folder)"]
        GROUPALBUM --> ALBUM1["Single album under artist\n→ standalone album"]
        GROUPALBUM --> SERIES["Multiple albums under artist\n→ Series + per-album cards\nbuildAlbumFromData() × N"]
    end

    ALBUM1 & ALBUM2 & SERIES --> TRACKLIST

    subgraph "buildTrackListFromEntries()"
        TRACKLIST["Sort by track number → filename\nPer track:\n  filepath = dbVpath + '/' + row.filepath\n  title, artist, number, duration, aaFile\n  cuepoints: JSON.parse(row.cuepoints)\n  (only if length >= 2)"]
    end

    TRACKLIST --> ARTRESOLVE

    subgraph "resolveArt(albums, series)"
        ARTRESOLVE["Series art: first member with aaFile/artFile\n(zero FS calls)\nStandalone albums: parallel fsp.access()\ncheck ART_NAMES (cover.jpg, front.jpg, …)\nDisc sub-folder fallback if no root art"]
    end

    ARTRESOLVE --> CACHE["_cache (slim browse)\n_cacheFull Map<albumId, fullAlbum>\nTTL: 5 min"]

    CACHE --> BROWSE["GET /api/v1/albums/browse\n→ { albums[], series[] }\n(no disc detail — lazy)"]
    CACHE --> DETAIL["GET /api/v1/albums/detail?id=\n→ full album with discs[]\nEach disc has tracks[]\nEach track may have cuepoints[]"]

    DETAIL --> CLIENT["viewAlbumDetail() renders:\nAlbum art header\nDisc tabs (multi-disc)\nTrack rows\n  — if cuepoints ≥ 2: expand\n    each cuepoint as a sub-row\n    with title/timestamp\nPlay All / Add All buttons\n'Album mode' info bar"]

    subgraph "CUE sheet: scan time"
        CUE_SCAN["Scanner reads sidecar .cue or\nembedded CUESHEET vorbis tag\nvia music-metadata\n→ cuepoints[] stored as JSON\nin files.cuepoints column\n(NULL until scanned; [] = probed+empty)"]
    end

    subgraph "CUE sheet: play time"
        CUE_SELECT["Track selected in album view\n→ _cueSeek = cuepoint.timestamp (s)\nSeek bar: tick marks at each cuepoint\n(clickable — seeks + highlights row)"]
        CUE_WEB["🌐 Web browser\naudioEl: canplay event\n→ audioEl.currentTime = _cueSeek"]
        CUE_SONOS["📻 Sonos\nseekTo: Math.floor(_cueSeek)\npassed in POST /api/v1/sonos/cast\n→ UPnP SOAP SetAVTransportURI"]
        CUE_MPV["🖥️ MPV\nPOST /api/v1/server-playback/seek\n{ position: _cueSeek }"]
        CUE_SELECT --> CUE_WEB & CUE_SONOS & CUE_MPV
    end

    CUE_SCAN -.->|"cuepoints[] in DB"| TRACKLIST
    CLIENT -.->|"User selects CUE track"| CUE_SELECT
```
