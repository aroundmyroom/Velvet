# JSON config

By default, Velvet will generate a config at `save/conf/default.json`. You can set another config file with the `-j` (`--json`) flag.

```
velvet -j /path/to/config.json
```

# Example Config

All config params have default values. A newly generated config starts as an empty JSON object; on first boot
Velvet adds a random `secret` and an `instanceId` to it:

```
{ }
```

A heavily edited config would look like: 

```json
{
  "port": 3000,
  "secret": "<your-random-secret-here>",
  "writeLogs": true,
  "noUpload": false,
  "scanOptions": {
    "skipImg": true,
    "scanInterval": 1.5,
    "pause": 50,
    "bootScanDelay": 15,
    "allowId3Edit": false
  },
  "storage": {
    "albumArtDirectory": "/media/album-art",
    "waveformDirectory": "/media/waveform-cache",
    "dbDirectory": "/media/db",
    "logsDirectory": "/media/logs"
  },
  "folders": {
    "rock": { "root": "/media/music/rock"},
    "blues": { "root": "/media/music/blues"}
  },
  "users": {
    "paul": {
      "password": "<pbkdf2-hash>",
      "salt": "<base64-salt>",
      "vpaths": ["blues", "rock"]
    },
    "james": {
      "password": "<pbkdf2-hash>",
      "salt": "<base64-salt>",
      "vpaths": ["rock"],
      "lastfm-user": "username",
      "lastfm-session": "<session-key-set-via-admin-ui>"
    }
  },
  "transcode": {
    "enabled": true,
    "ffmpegDirectory": "/path/to/ffmpeg-dir",
    "defaultCodec": "opus",
    "defaultBitrate": "128k"
  },
  "ssl": {
    "key": "/path/to/key.pem",
    "cert": "/path/to/cert.pem"
  },
  "telemetry": false
}
```

## Port

Defaults to 3000 if not set

## Folders

Folders are set by key value pairs.  The key is used later to give access to folders on a per user basis.  (more info in the users section)

```json
  "folders": {
    "blues": { "root": "/media/music/blues" },
    "rock": { "root": "/media/music/rock"}
  }
```

If this is not set, there are no folders until you add one in the admin panel. Every `root` must exist when Velvet
starts (folders of type `recordings` and `youtube` are created if missing), or Velvet refuses to boot.

### Folder types

Each folder entry supports an optional `type` key:

| Value | Description |
|-------|-------------|
| `music` | *(default)* Standard music library — included in all scans |
| `audio-books` | Audio-books / podcasts — included in scans |
| `recordings` | Radio recordings destination — **excluded from library scans**. Files recorded from radio streams land here. |
| `youtube` | YouTube download destination |
| `excluded` | Never scanned |

Other folder keys (all set from Admin → Directories):

- `allowRecordDelete` — see below.
- `albumsOnly` (default `false`) — marks the folder as album content for the Album Library, see [albums-only.md](albums-only.md).
- `artistsOn` (default `true`) — `false` leaves the folder's tracks out of the Artist Library.
- `dlnaEnabled` — `true` shares the folder over DLNA/UPnP (music and audio-books folders only), see [dlna.md](dlna.md).

### Allow users to delete recordings

When a folder is of type `recordings`, an optional `allowRecordDelete` flag controls whether users may delete their own recordings:

```json
{
  "folders": {
    "recordings": {
      "root": "/media/radio-recordings",
      "type": "recordings",
      "allowRecordDelete": true
    }
  }
}
```

When enabled, a red **Delete** (trash) button appears next to each file in the recordings folder browser, and a **Delete Recording** item appears in the song context menu. A confirmation prompt is always shown before deletion. The flag is set from the Admin panel (Directories → **Del: On / Off** toggle) without needing to remove and re-add the folder.

> **Note:** If you toggle this setting in the admin panel, users must refresh the player page before the button becomes visible — the flag is loaded from `/api/v1/ping` at login time.

## Users

If there is no users object, the login system will not be enabled and anyone will be able to access the server.  All folders will be accessible (and the admin panel too, unless `lockAdmin` is set).

A basic user example.  

`password` and `salt` are both required: `password` is the PBKDF2 hash, not the plain password. Create users in the
admin panel to get them. Hashes are PBKDF2-HMAC-SHA512 with 210,000 iterations; the count is stored in the salt
(`pbkdf2-210000$<salt>`). A salt without that prefix is an older hash made with 15,000 iterations: it still works, and
the next successful login rewrites it with the current count. Users may also carry a `tokenVersion` (set by Velvet);
raising it logs that user out everywhere.

```json
{
  "folders": {
    "media": {"root":"/media/music"}
  },
  "users": {
    "paul": {
      "password": "<pbkdf2-hash>",
      "salt": "<base64-salt>",
      "vpaths": ["media"]
    }
  }
}
```

A user with multiple folders

```json
{
  "folders": {
    "music": { "root":"/media/music" },
    "audiobooks": { "root":"/media/books/audio" }
  },
  "users": {
    "paul": {
      "password": "<pbkdf2-hash>",
      "salt": "<base64-salt>",
      "vpaths": ["music", "audiobooks"]
    }
  }
}
```

Multiple users with multiple directories

```json
{
  "folders": {
    "jake-music": {"root":"/media/jake/music"},
    "finn-music": {"root":"/media/finn/music"},
    "audiobooks": {"root":"/media/books/audio"}
  },
  "users": {
    "jake": {
      "password": "<pbkdf2-hash>",
      "salt": "<base64-salt>",
      "vpaths": ["jake-music", "audiobooks"]
    },
    "finn": {
      "password": "<pbkdf2-hash>",
      "salt": "<base64-salt>",
      "vpaths": ["finn-music", "audiobooks"]
    }
  }
}
```

### Child vpath access

A user's `vpaths` list may contain **child vpaths** — folders that are sub-directories
of a root vpath. For example, if `12-inches` is configured with `root: /media/music/12 inches A-Z`
and `Music` has `root: /media/music`, then `12-inches` is a child of `Music`.

Giving a user only `"vpaths": ["12-inches"]` restricts them to that sub-folder:
they see only artists, albums, genres and decades from files in that directory.
They cannot access any other content from the parent `Music` root.
The server enforces this on every library list (search, recent, rated, most played,
random songs, similar songs, Auto-DJ, Rooms, Smart Playlists, Subsonic), whatever the
client asks for, and a path with `..` cannot step out of the sub-folder.

```json
{
  "folders": {
    "Music":      { "root": "/media/music" },
    "12-inches":  { "root": "/media/music/12 inches A-Z" }
  },
  "users": {
    "alice": {
      "password": "<hash>",
      "salt": "<salt>",
      "vpaths": ["12-inches"]
    }
  }
}
```

## Transcoding

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `false` | Enable on-the-fly transcoding |
| `ffmpegDirectory` | `bin/ffmpeg/` | Path to the directory containing the ffmpeg binary |
| `algorithm` | `stream` | Transcoding algorithm. Valid values: `stream`, `buffer` |
| `defaultCodec` | `opus` | Codec used when the client does not request a specific one. Valid values: `aac`, `mp3`, `opus` |
| `defaultBitrate` | `96k` | Bitrate used when the client does not request a specific one. Valid values: `64k`, `96k`, `128k`, `192k`, `256k`, `320k` |

```json
{
  "transcode": {
    "enabled": true,
    "ffmpegDirectory": "/path/to/ffmpeg-dir",
    "defaultCodec": "opus",
    "defaultBitrate": "128k"
  }
}
```

Note: Velvet's bundled ffmpeg bootstrap downloader follows only bounded HTTPS redirects and uses request timeouts. It downloads ffmpeg when `bin/ffmpeg/` has none or one older than v6, and replaces the binary only after a successful download, so a failed attempt does not remove a working ffmpeg.

## Secret 

Sets the secret key used to sign login tokens. If it is not set, Velvet generates a random one at boot and saves it to the config file, so sessions survive restarts. Changing the secret logs every user out. To log out one user everywhere, use **Admin → Users → Password button → Sessions → Log out everywhere** instead (it raises that user's `tokenVersion`).

## Config file writes

Every change Velvet makes to the config file (admin settings, user changes, Last.fm/ListenBrainz links, Sonos, DLNA, network mounts) goes through one serialised writer: the file is read, changed, written to a temp file, flushed and renamed into place, keeping its file mode. Two changes at the same moment can no longer overwrite each other, and a crash mid-write cannot leave a half-written file.

## Scan Options

| Key | Default | Description |
|-----|---------|-------------|
| `skipImg` | `false` | Skip album art during scan — speeds up scanning and saves disk space |
| `bootScanDelay` | `3` | Seconds to wait after server boot before the scan schedule starts |
| `bootScanEnabled` | `false` | Always scan at boot. When `false`, a boot scan runs only if the last scan is older than `scanInterval` |
| `scanInterval` | `24` | Hours between automatic rescans. Set to `0` to disable automatic scanning |
| `scanStartTime` | `null` | `"HH:MM"`: scan once a day at this time instead of every `scanInterval` hours |
| `pause` | `0` | Milliseconds of pause injected between each file during scanning. Prevents Velvet from monopolising CPU on low-power hardware |
| `maxConcurrentTasks` | `1` | Number of folder scans (one per vpath) that run at the same time. More speeds up scanning several folders on multi-core machines but raises CPU usage |
| `compressImage` | `true` | Compress album art images when caching them. Reduces storage at the cost of a small amount of CPU during initial scan |
| `scanErrorRetentionHours` | `48` | How long (hours) scan errors are retained in the log. Valid values: `12`, `24`, `48`, `72`, `168`, `336`, `720` |
| `allowId3Edit` | *(absent = off)* | Not in the schema; set from the admin panel. When `true`, admin users see a **✏ Edit Tags** button in the Now Playing modal to rewrite ID3/Vorbis/MP4 tags directly on disk. See [API/admin_id3-tags.md](API/admin_id3-tags.md) |
| `maxRecordingMinutes` | `180` | Maximum duration (minutes) of a radio recording before it is automatically stopped. Set via Admin → DB Scan Settings. |
| `maxZipMb` | `500` | Maximum total size (MB) of a ZIP download. Requests that would exceed this limit are rejected. Set via Admin → DB Scan Settings. |

```json
{
  "scanOptions": {
    "skipImg": false,
    "scanInterval": 24,
    "pause": 0,
    "bootScanDelay": 3,
    "maxConcurrentTasks": 1,
    "compressImage": true,
    "scanErrorRetentionHours": 48,
    "allowId3Edit": false,
    "maxRecordingMinutes": 180,
    "maxZipMb": 500
  }
}
```

## SSL

Velvet comes with SSL support built in.  Just add your key and cert and the server will take care of the rest

The admin SSL form only accepts existing certificate files from trusted certificate locations (for example your config directory or standard system cert paths).

```json
  "ssl": {
    "key": "/path/to/key.pem",
    "cert": "/path/to/cert.pem"
  }
```

## Local HTTP port

When Velvet runs with SSL, `localHttpPort` (1024–65535, default `null` = off) opens an extra plain-HTTP listener on
the same address, for LAN devices such as Sonos that cannot use HTTPS.

## Disable Uploading

```
  "noUpload": true
```

Blocks file uploads in the file explorer and YouTube downloads for everyone. Per user, `allow-upload: false` blocks
uploads for that user only.

## LastFM Scrobbling

Each user can link their own Last.fm account in two ways:

**Recommended — via the player's Last.fm page**  
The user enters their Last.fm username and password once. Velvet authenticates against Last.fm, receives a session key, and stores only the session key. The password is never written to disk.

**Config file reference** (managed automatically — do not edit by hand):

```json
{
  "folders": {
    "jake-music": { "root": "/media/jake/music" }
  },
  "users": {
    "jake": {
      "password": "<pbkdf2-hash>",
      "salt": "<salt>",
      "vpaths": ["jake-music"],
      "lastfm-user":    "jakeslastfm",
      "lastfm-session": "<session key obtained via connect endpoint>"
    }
  }
}
```

| Field | Description |
|-------|-------------|
| `lastfm-user` | The Last.fm username |
| `lastfm-session` | Session key obtained from Last.fm on connect — replaces password |
| `lastfm-password` | Legacy field. Stored in old configs before the session-key flow was introduced. Still functional but replaced on next connect. |
| `listenbrainz-token` | ListenBrainz user token. Set automatically when the user links their account on the player's ListenBrainz page. |
| `admin` | `true` gives the user admin rights (default `false`). |
| `allow-radio-recording` | When `true`, this user can record live radio streams to a Recordings folder. Granted per-user via Admin → Users. |
| `allow-youtube-download` | When `true`, this user can use YouTube downloads. |
| `allow-upload` | `false` blocks file uploads for this user. |
| `allow-ai-dj` | `false` hides the AI DJ for this user. |
| `discord-webhook-enabled`, `discord-webhook-nick` | Per-user Discord now-playing posts (with the server-level `discordWebhook` below). |
| `subsonic-password` | Separate plain-text password used by Subsonic API clients. Set via Admin → Users → Subsonic password, or by the user on the player's Subsonic API page. |

**Admin API key**  
There are no built-in Last.fm credentials: `lastFM.apiKey` and `apiSecret` default to empty, and without a key
scrobbling and similar artists do nothing. An admin sets them without restarting via Admin panel → Last.fm, or via `POST /api/v1/admin/lastfm/config`.

See [API/lastfm.md](API/lastfm.md) for the full API reference.

## Storage

Velvet will write logs, DB files, album art and waveform data to the filesystem.  By default these will be written in the Velvet project folder in the `save`, `image-cache` and `waveform-cache` folders.  Use the `storage` object to choose where to save these files.

| Key | Default | Description |
|-----|---------|-------------|
| `albumArtDirectory` | `image-cache/` | Album art images. Publicly served by Velvet. |
| `waveformDirectory` | `waveform-cache/` | Waveform JSON files generated by the scrubber. Safe to delete — regenerated on demand when FFmpeg is enabled. |
| `dbDirectory` | `save/db/` | SQLite database file. |
| `logsDirectory` | `save/logs/` | Server log files. |
| `skinsDirectory` | `save/skins/` | Your own skins, one folder per skin. Served at `/skins/`. See [skins.md](skins.md). |

```json
{
  "storage": {
    "albumArtDirectory": "/media/album-art",
    "waveformDirectory": "/media/waveform-cache",
    "dbDirectory": "/media/db",
    "logsDirectory": "/media/logs"
  }
}
```

## Logs

Set `writeLogs` to `true` to enable writing logs to the filesystem.

Use `logRetention` to control how long log files are kept. Valid values: `"1d"`, `"3d"`, `"7d"`, `"14d"` (default), `"30d"`.
Older files are removed automatically on each log rotation. You can also trigger immediate cleanup via Admin → Logging → **Delete old logs now**.

```json
{
  "writeLogs": true,
  "logRetention": "7d"
}
```

## UI

`webAppDirectory` is the folder that contains the frontend for Velvet. Defaults to the bundled `webapp` folder if not set.

The theme is set with `ui`: `"velvet"` (default), `"velvet-dark"` or `"velvet-light"`.

The default skin is set with `skin`: the name of a skin folder (for example `"goud"`), or `""` (default) for none. Users
can pick their own skin under User Settings. See [skins.md](skins.md).

## Supported Files

```json
{
  "supportedAudioFiles": {
    "mp3": true,
    "m3u": false,
  }
}
```

The object key is the file extension and the value is true/false.

If true, the file will be scanned and saved the db as an audio file. If false, the file will not be scanned but still be viewable in the file explorer

## Address

The IP address Velvet binds to. Defaults to `::` (all interfaces, IPv4 + IPv6). Set to `127.0.0.1` to restrict to localhost only.

```json
{
  "address": "127.0.0.1"
}
```

## Lock Admin

When `true`, the admin API is switched off: every `/api/v1/admin/*` request answers `405`, and the `/admin` page shows "Admin Page Disabled". Defaults to `false`.

```json
{
  "lockAdmin": true
}
```

## Max Request Size

Maximum body size for upload requests. Defaults to `10MB`. Accepts a string in the format `{number}KB` or `{number}MB`.

```json
{
  "maxRequestSize": "10MB"
}
```

## Database

Velvet always uses SQLite (`velvet.sqlite` in `storage.dbDirectory`). The `db` object only sets housekeeping.

| Key | Default | Description |
|-----|---------|-------------|
| `clearSharedInterval` | `24` | Hours between automatic purges of expired shared playlist tokens. Set to `0` to disable |

```json
{
  "db": {
    "clearSharedInterval": 24
  }
}
```

## Last.fm (server-level)

Controls the Last.fm integration for **all users**. This covers both scrobbling and the Similar Artists feature used by Auto-DJ.

> **Opt-out behaviour:** `lastFM.enabled` defaults to `true`. Last.fm is active unless you explicitly set `"enabled": false`. This is different from `radio`, which is opt-in.

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `true` | Enable Last.fm for all users (scrobbling + similar artists in Auto-DJ). Set to `false` to disable globally |
| `apiKey` | `""` | Your Last.fm API key. Needed for scrobbling and similar artists |
| `apiSecret` | `""` | Your Last.fm API secret |

```json
{
  "lastFM": {
    "enabled": true,
    "apiKey": "your-api-key",
    "apiSecret": "your-api-secret"
  }
}
```

The admin API key can also be changed at runtime without a restart via Admin panel → Last.fm or `POST /api/v1/admin/lastfm/config`.

Per-user Last.fm credentials (`lastfm-user`, `lastfm-session`) live inside the `users` object — see the [LastFM Scrobbling](#lastfm-scrobbling) section above.

## ListenBrainz (server-level)

Controls whether users can link their ListenBrainz accounts for scrobbling and Now-Playing updates.

> **Opt-in behaviour:** `listenBrainz.enabled` defaults to `false`. Must be explicitly enabled before users can connect their accounts.

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `false` | Enable ListenBrainz server-wide. When `false`, the ListenBrainz nav page is hidden for all users. |

```json
{
  "listenBrainz": {
    "enabled": true
  }
}
```

Users link their own token via Admin → ListenBrainz. The token is stored per-user as `listenbrainz-token` in the `users` object.

## Lyrics

Controls whether the lyrics feature is available in the player.

> **Opt-out behaviour:** lyrics are **enabled by default**. Set `"lyrics": { "enabled": false }` to disable.

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `true` | When `false`, the lyrics button and all lyrics API endpoints are disabled. |

```json
{
  "lyrics": {
    "enabled": false
  }
}
```

## Discogs

Controls the Discogs integration used for artist images and metadata enrichment.

> **Opt-in behaviour:** `discogs.enabled` defaults to `false`. You must explicitly enable it and supply API credentials.

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `false` | Enable Discogs lookups |
| `allowArtUpdate` | `false` | Allow Discogs to overwrite locally stored artist images |
| `apiKey` | `""` | Your Discogs OAuth consumer key |
| `apiSecret` | `""` | Your Discogs OAuth consumer secret |
| `userAgentTag` | `""` | A short alphanumeric tag (max 4 chars) appended to the User-Agent string sent to Discogs |
| `itunesEnabled` | `true` | Use iTunes as an album-art source |
| `deezerEnabled` | `true` | Use Deezer as an album-art source |

```json
{
  "discogs": {
    "enabled": true,
    "allowArtUpdate": false,
    "apiKey": "your-consumer-key",
    "apiSecret": "your-consumer-secret",
    "userAgentTag": "msv1"
  }
}
```

Credentials and the enable toggle can also be managed at runtime via Admin panel → Discogs or `POST /api/v1/admin/discogs/config`.

## AI-assist (`aiAssist`)

Off by default; the whole feature (admin page and endpoints) is hidden until
`enabled` is set here once. Every other field can then be changed on the
admin page. Full guide: [ai-assist.md](ai-assist.md); listener page:
[ai-dj.md](ai-dj.md).

```json
"aiAssist": {
  "enabled": true,
  "apiKey": "sk-ant-…",
  "model": "claude-haiku-5-5",
  "monthlyBudgetUsd": 2,
  "queueBuilder": false,
  "maxQueueSongs": 500,
  "provider": "anthropic",
  "localBaseUrl": "",
  "localModel": "",
  "localApiKey": "",
  "djNotes": ""
}
```

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Shows the admin page and enables the endpoints. |
| `apiKey` | — | Anthropic API key. Never leaves the server; shown only by its last characters. |
| `model` | `claude-haiku-5-5` | `claude-haiku-5-5`, `claude-sonnet-5-5` or `claude-opus-5-5`. |
| `monthlyBudgetUsd` | `2` | Spending cap per calendar month; Velvet stops asking once it is reached. |
| `queueBuilder` | `false` | Shows the AI DJ page to listeners (per user: `allow-ai-dj: false` on the user). |
| `maxQueueSongs` | `500` | Cap for one AI-built set, 1–9999. |
| `provider` | `anthropic` | `openai` for a self-hosted server with an OpenAI-compatible API. |
| `localBaseUrl`, `localModel`, `localApiKey` | `""` | The self-hosted server (`…/v1`), its model name and an optional bearer key. |
| `djNotes` | `""` | House notes for the DJ, up to 4000 characters; `A = B` lines also act as aliases. |
| `versionWords` | *(absent)* | The admin's own version-word families, `[{ "name", "says": [], "match": [] }]`, written by Admin → AI-assist → *Version words*. Absent means the built-in list, which a Velvet update may improve; once present, it is used as it is and never overwritten. Remove the key (or press *Back to built-in list*) to return to the built-in one. |

Saving a key reads nothing; the admin page shows the cost of a full pass and
asks before running it.

## Radio Streams

Enables the internet radio station feature in the player.

> **Opt-in behaviour:** `radio.enabled` must be explicitly `true`. Unlike `lastFM`, radio is **not** part of the Joi validation schema — omitting the `radio` key entirely is treated as disabled. The admin UI sets this key when you toggle the feature on.

```json
{
  "radio": {
    "enabled": true
  }
}
```

Radio station data (URLs, names, logos, sort order) is stored in the database, not in the config file. Use Admin panel → Radio Streams or the [radio API](API/radio.md) to manage stations.

## Velvet Rooms (`sendspin`)

Velvet Rooms plays a server-side queue on speakers that implement the Sendspin
protocol ("works with Sendspin speakers"). Off by default; the admin page
*Velvet Rooms* toggles it, renames the server and changes the port without a
Velvet restart.

```json
{
  "sendspin": {
    "enabled": false,
    "name": "Velvet (myhost)",
    "port": 8927,
    "bind": "0.0.0.0",
    "path": "/sendspin",
    "discovery": true
  }
}
```

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Start the Sendspin listener (plain WebSocket, encrypted per connection by the protocol). |
| `name` | `Velvet (<hostname>)` | Name speakers show for this server; 1–63 characters, no control characters. |
| `port` | `8927` | Listener port (1024–65535). Speakers that connect to the server use it. |
| `bind` | `0.0.0.0` | Address the listener binds to. |
| `path` | `/sendspin` | WebSocket path, also advertised over mDNS. |
| `discovery` | `true` | Advertise `_sendspin-server._tcp` and find speakers (`_sendspin._tcp`) over mDNS. Needs host networking in Docker. |

State lives in `save/sendspin/` (next to `save/db/`): `server-key.json` (the
server identity), `trust-store.json` (pairings and approvals), `rooms.json`
(rooms, queues) and `known-devices.json`. The key and the trust store belong
together: Velvet's backups include all of them, and restoring one without the
other means every speaker must pair again. A listener that cannot start (port
in use) never stops Velvet from booting; the admin page shows the error.

## Other integrations

All of these are set from the admin panel; the keys are listed so you know what you see in the file.

| Object | Keys (default) |
|---|---|
| `albumArt` | `autoApprove` (`false`), `autoSuggestNewContent` (`false`), `coverArtArchive` (`true`) — see [album-art-workshop.md](album-art-workshop.md) |
| `acoustid` | `enabled` (`false`), `apiKey` (`""`), `autostart` (`false`) |
| `dlna` | `enabled` (`false`), `port` (`10293`), `name` (`"Velvet"`) — see [dlna.md](dlna.md). There is no `browse` key; an old one is ignored. |
| `serverAudio` | `enabled` (`false`), `mpvBin` (`"mpv"`), `autoUnmute` (`true`) — see [server-audio.md](server-audio.md) |
| `sonos` | `enabled` (`true`), `transcodeOpus` (`false`), `sleepEnabled` (`false`), `hiddenFavorites` (`[]`), `knownIps` (`[]`), `defaultRoom` (`null`, or `{ name, ip, uuid }`) — see [sonos.md](sonos.md). An old `pauseSleepMinutes` key is ignored. |
| `extAuth` | `enabled` (`false`), `headerName` (`"Remote-User"`), `trustedProxies` (`[]`), `secretHeaderName` (`"X-Velvet-ExtAuth-Secret"`), `secretValue` (`""`), `autoCreateUsers` (`false`) — see [auth-reverse-proxy.md](auth-reverse-proxy.md) |
| `discordWebhook` | `enabled` (`false`), `url` (`""`) |
| `networkMounts` | One entry per share added in Admin → Network shares: `{ type, server, mountPoint, options, hasCredentials }` — see [network-shares.md](network-shares.md) |

`instanceId` is a random UUID Velvet writes on first boot.

## Background workers (`workerAutostart`)

Velvet sets this itself when an admin presses Start or Stop on a background worker; you rarely edit it by hand.

```json
"workerAutostart": { "rg-analysis": false, "genre-enricher": true }
```

Names: `rg-analysis`, `bpm-ab`, `bpm-essentia`, `genre-enricher`, `tagworkshop-enrich`, `tagworkshop-text-search`. A missing entry means the worker may start on its own after a scan; `false` keeps it stopped until an admin starts it. AcoustID keeps its own `acoustid.autostart` flag, and now only starts after a scan when that flag is `true`.

## Opt-in vs Opt-out: How Feature Defaults Work

Some features in Velvet are **opt-out** (enabled by default, set to `false` to turn off) while others are **opt-in** (disabled by default, must be explicitly enabled). This is a deliberate design distinction:

| Feature | Default state | Mechanism | Why |
|---------|--------------|-----------|-----|
| Last.fm | **On** | `lastFM.enabled` defaults to `true` in schema | Core feature, expected to be available |
| Discogs | **Off** | `discogs.enabled` defaults to `false` in schema | Requires external API credentials to be useful |
| Radio | **Off** | Not in schema — checked as `=== true` | Opt-in feature; absent config key = disabled |

This means:
- You can **disable Last.fm** by adding `"lastFM": { "enabled": false }` to your config.
- Discogs is **off until you explicitly enable it** with your API credentials.
- Radio is **off until the admin enables it** via the UI or by setting `"radio": { "enabled": true }` in the config.

## Removed options

The `rpn` (Remote Proxy Network) key is gone. An old config that still has it boots fine; Velvet ignores the key. You can delete it.

## Telemetry

Velvet sends a small anonymous ping on boot and every 24 hours to count active installations. See [docs/telemetry.md](telemetry.md) for a full description of what is sent.

> **Opt-out behaviour:** telemetry is **enabled by default**. Set `"telemetry": false` to disable it.

| Key | Default | Description |
|-----|---------|-------------|
| `telemetry` | `true` | Set to `false` to disable all pings |

```json
{
  "telemetry": false
}
```