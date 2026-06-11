# JSON config

By default, Velvet will generate a config at `save/conf/default.conf`. You can set the config file for velvet the the `-j` flag.

```
velvet -j /path/to/config.json
```

# Example Config

All config params have default values. A newly generated config will be empty json object:

```
{ }
```

A heavily edited config would look like: 

```json
{
  "port": 3000,
  "webAppDirectory": "public",
  "secret": "<your-random-secret-here>",
  "writeLogs": true,
  "noUpload": false,
  "scanOptions": {
    "skipImg": true,
    "scanInterval": 1.5,
    "pause": 50,
    "saveInterval": 500,
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
      "vpaths": "rock",
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

If this is not set, the cwd will be used

### Folder types

Each folder entry supports an optional `type` key:

| Value | Description |
|-------|-------------|
| `music` | *(default)* Standard music library — included in all scans |
| `audio-books` | Audio-books / podcasts save target — included in scans |
| `recordings` | Radio recordings destination — **excluded from library scans**. Files recorded from radio streams land here. |

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

If there is no users object, the login system will not be enabled and anyone will be abe to access the server.  All folders will be accessible

A basic user example.  

Note that the hashed password and salt can be generated automatically by creating a new user via the admin ui.

```json
{
  "folders": {
    "media": {"root":"/media/music"}
  },
  "users": {
    "paul": {
      "password": "<pbkdf2-hash>",
      "salt": "<base64-salt>",
      "vpaths": "media"
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
      "password":"p@ssword",
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
      "password":"p@ssword",
      "vpaths": ["jake-music", "audiobooks"]
    },
    "finn": {
      "password":"p@ssword",
      "vpaths": ["finn-music", "audiobooks"]
    }
  }
}
```

## Transcoding

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `false` | Enable on-the-fly transcoding |
| `ffmpegDirectory` | `bin/ffmpeg/` | Path to the directory containing the ffmpeg binary |
| `algorithm` | `stream` | Transcoding algorithm. Valid values: `stream` |
| `defaultCodec` | `opus` | Codec used when the client does not request a specific one. Valid values: `aac`, `mp3`, `opus` |
| `defaultBitrate` | `96k` | Bitrate used when the client does not request a specific one. Valid values: `192k`, `128k`, `96k`, `64k` |

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

Note: Velvet's bundled ffmpeg bootstrap downloader follows only bounded HTTPS redirects and uses request timeouts. Automatic update checks replace binaries only after a successful download/verification cycle, so a failed refresh does not remove an already working ffmpeg install.

## Secret 

Sets the secret key used for the login system.  If this is not set, Velvet will generate a different secret key on each boot and all previous login sessions will be voided

## Scan Options

| Key | Default | Description |
|-----|---------|-------------|
| `skipImg` | `false` | Skip album art during scan — speeds up scanning and saves disk space |
| `bootScanDelay` | `3` | Seconds to wait after server boot before the first scan begins |
| `scanInterval` | `24` | Hours between automatic rescans. Set to `0` to disable automatic scanning |
| `saveInterval` | `250` | How often (in files processed) to flush changes to the database during a scan. Increase for large collections to reduce CPU pressure |
| `pause` | `0` | Milliseconds of pause injected between each file during scanning. Prevents Velvet from monopolising CPU on low-power hardware |
| `maxConcurrentTasks` | `1` | Number of files processed in parallel during a scan. Increasing this speeds up scanning on multi-core machines but raises CPU usage |
| `compressImage` | `true` | Compress album art images when caching them. Reduces storage at the cost of a small amount of CPU during initial scan |
| `scanErrorRetentionHours` | `48` | How long (hours) scan errors are retained in the log. Valid values: `12`, `24`, `48`, `72`, `168`, `336`, `720` |
| `allowId3Edit` | `false` | When `true`, admin users see a **✏ Edit Tags** button in the Now Playing modal to rewrite ID3/Vorbis/MP4 tags directly on disk. See [API/admin_id3-tags.md](API/admin_id3-tags.md) |
| `maxRecordingMinutes` | `180` | Maximum duration (minutes) of a radio recording before it is automatically stopped. Set via Admin → DB Scan Settings. |
| `maxZipMb` | `500` | Maximum total size (MB) of a ZIP download. Requests that would exceed this limit are rejected. Set via Admin → DB Scan Settings. |

```json
{
  "scanOptions": {
    "skipImg": false,
    "scanInterval": 24,
    "pause": 0,
    "saveInterval": 250,
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

## Disable Uploading

```
  "noUpload": true
```

## LastFM Scrobbling

Each user can link their own Last.fm account in two ways:

**Recommended — via the GUIv2 interface (Tools → Last.fm)**  
The user enters their Last.fm username and password once. Velvet authenticates against Last.fm, receives a session key, and stores only the session key. The password is never written to disk.

**Config file reference** (managed automatically — do not edit by hand):

```json
{
  "folders": {
    "jake-music": "/media/jake/music"
  },
  "users": {
    "jake": {
      "password": "<bcrypt hash>",
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
| `listenbrainz-token` | ListenBrainz user token. Set automatically when the user links their account via Admin → ListenBrainz. |
| `allow-radio-recording` | When `true`, this user can record live radio streams to a Recordings folder. Granted per-user via Admin → Users. |
| `subsonic-password` | Separate plain-text password used by Subsonic API clients. Set via Admin → Users → Subsonic password. |

**Admin API key override**  
The server ships with built-in Last.fm API credentials. An admin can override them without restarting via Admin panel → Last.fm, or via `POST /api/v1/admin/lastfm/config`.

See [API/lastfm.md](API/lastfm.md) for the full API reference.

## Storage

Velvet will write logs, DB files, album art and waveform data to the filesystem.  By default these will be written in the Velvet project folder in the `save`, `image-cache` and `waveform-cache` folders.  Use the `storage` object to choose where to save these files.

| Key | Default | Description |
|-----|---------|-------------|
| `albumArtDirectory` | `image-cache/` | Album art images. Publicly served by Velvet. |
| `waveformDirectory` | `waveform-cache/` | Waveform JSON files generated by the scrubber. Safe to delete — regenerated on demand when FFmpeg is enabled. |
| `dbDirectory` | `save/db/` | SQLite / LokiJS database files. |
| `logsDirectory` | `save/logs/` | Server log files. |
| `syncConfigDirectory` | `save/sync/` | Directory used by the Syncthing integration for its config and state files. |

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

Folder that contains the frontend for Velvet.  Defaults to `public` if not set

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

When `true`, the admin panel is only accessible from `localhost`. Requests from any other IP receive a 403. Defaults to `false`.

```json
{
  "lockAdmin": true
}
```

## Max Request Size

Maximum body size for upload requests. Defaults to `1MB`. Accepts a string in the format `{number}KB` or `{number}MB`.

```json
{
  "maxRequestSize": "10MB"
}
```

## Database

Controls the shared-playlist database engine and housekeeping interval.

| Key | Default | Description |
|-----|---------|-------------|
| `engine` | `loki` | Database backend. Valid values: `loki` (in-memory, fast), `sqlite` (persistent, recommended for production) |
| `clearSharedInterval` | `24` | Hours between automatic purges of expired shared playlist tokens. Set to `0` to disable |

```json
{
  "db": {
    "engine": "sqlite",
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
| `apiKey` | *(built-in)* | Override the default Last.fm API key. Only needed if the built-in key reaches rate limits |
| `apiSecret` | *(built-in)* | Override the default Last.fm API secret |

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

## Federation

> **Advanced / experimental.** Allows multiple Velvet servers to share libraries.

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `false` | Enable federation |
| `folder` | *(none)* | Path to the folder used for federated content |
| `federateUsersMode` | `false` | When `true`, users are federated across servers |

```json
{
  "federation": {
    "enabled": false,
    "folder": "/media/federated",
    "federateUsersMode": false
  }
}
```

## Remote Proxy Network (RPN)

Configures the Velvet RPN tunnel service that allows external access without port forwarding. Managed via Admin panel → RPN or `velvet.io`.

| Key | Default | Description |
|-----|---------|-------------|
| `apiUrl` | `https://api.velvet.io` | RPN API endpoint |
| `iniFile` | `bin/rpn/frps.ini` | Path to the frps config file |
| `email` | `""` | velvet.io account email |
| `password` | `""` | velvet.io account password |
| `token` | *(none)* | Auth token (set automatically after login) |
| `url` | *(none)* | Assigned tunnel URL (set automatically after connection) |

```json
{
  "rpn": {
    "apiUrl": "https://api.velvet.io",
    "email": "you@example.com",
    "password": "your-password"
  }
}
```

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