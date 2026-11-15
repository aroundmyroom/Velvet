# YouTube Download

Velvet can download audio from YouTube URLs directly from the web interface, saving files to a dedicated YouTube downloads folder.

## How it works

1. Paste a YouTube URL into the YouTube view and click **Preview**
2. Velvet fetches metadata (title, artist, thumbnail, year) via yt-dlp — an `Artist - Title` video title is split into artist and title, and suffixes like `(Official Video)`, `(Lyrics)`, `[HD]` and `feat. …` are stripped. The year comes from the release year/date, else the upload date. The album field is left blank for you to fill in
3. Edit the tags if needed, choose a format, and click **Download**
4. The download runs as a background job; the file is saved to your configured YouTube or recordings folder
5. **▶ Play now** and **+ Add to queue** buttons appear when the job is done

Files are tagged with the title, artist, album, and year you confirmed before downloading.

If the server runs with `noUpload`, YouTube download is disabled for everyone.

## Permissions

YouTube download is an opt-in per-user permission. An admin must enable it for each user:

- Go to **Admin → Users**
- Click the **YouTube** toggle button next to the user (stored as `allow-youtube-download` on the user)
- Users without the permission see a "not enabled" notice in the YouTube view

## Folder setup

Create a dedicated folder for YouTube downloads in **Admin → Directories**:

- Check **YouTube Downloads folder** when adding it
- This marks the folder as `type: youtube` — files are saved here; it is reachable from the Audio Content view and the file explorer
- A `youtube` folder is never scanned on its own: full scans, scheduled scans and per-folder scans all skip it (the same goes for `recordings` and `excluded` folders). If the folder sits inside a music folder, the parent's scan does index its files, under the parent folder
- The user must have access to the folder. If none of the user's folders is of type `youtube`, the server falls back to a `recordings` folder the user has access to; with neither, the download is refused

## Supported formats

| Format | Description |
|--------|-------------|
| **Opus** (default) | Original YouTube audio — best quality at smallest size |
| **MP3** | Re-encoded — broadest device compatibility |
| **M4A** | AAC |
| **OGG** | Vorbis |

yt-dlp extracts the audio in the chosen format (`-x --audio-format`); the tagging step afterwards copies the audio without re-encoding.

Filenames are saved as `Artist - Title.opus` (or `Title.opus` if no artist), max 200 characters, with `/ \ ? % * : | " < >` replaced by `_`. An existing file is never overwritten — `_1`, `_2`, … is appended.

## API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/ytdl/metadata?url=` | Preview: `{ title, artist, album: '', year, thumbnail }` |
| `POST` | `/api/v1/ytdl/` | `{ url, outputCodec: opus\|mp3\|m4a\|ogg, metadata: { title, artist, album, year } }` → `{ jobId }` |
| `GET` | `/api/v1/ytdl/downloads` | The caller's running and recent jobs (admins see every user's; finished jobs are kept 10 minutes), keyed by job id |

Only `http`/`https` URLs are accepted, and a URL whose host resolves to a private or loopback address is refused (`400`, "That URL is not allowed").

---

## yt-dlp binary management

Velvet uses [yt-dlp](https://github.com/yt-dlp/yt-dlp) under the hood. The binary lives at `bin/yt-dlp/yt-dlp` and is **not** committed to git.

### Automatic download on first run

**No setup is needed.** On every startup, Velvet:

1. Checks whether `bin/yt-dlp/yt-dlp` exists, is executable and not empty
2. If missing or empty — downloads the correct build for your platform automatically from the GitHub releases page
3. Runs `yt-dlp --update` — yt-dlp self-updates in place if a newer release exists (skipped when `NODE_ENV=test`)

This means:
- Cloning the repo and starting the server is all that's required
- YouTube compatibility is maintained automatically — when YouTube changes their player and yt-dlp releases a fix, it is picked up on the next server restart
- The current/new version is visible in the Velvet logs: `yt-dlp update: Updated yt-dlp to 2025.03.27` or `yt-dlp is up to date (2025.03.15)`

### Docker

The `Dockerfile` downloads yt-dlp at **image build time** (architecture-aware: x86_64, ARM64, ARMv7). The runtime auto-download and update still runs on container startup.

### Air-gapped / offline servers

If the server has no outbound internet access, place the binary manually (see [bin/yt-dlp/README.md](../bin/yt-dlp/README.md)). Once placed, a failing `--update` only logs a warning and the existing binary is used as-is.

As a further fallback, if the binary is missing entirely and cannot be downloaded, Velvet will attempt to use a system-installed `yt-dlp` on `$PATH`.

---

## ffmpeg dependency

Tagging and format conversion are done by ffmpeg. Velvet includes a self-contained ffmpeg bootstrap: at startup it checks `bin/ffmpeg/ffmpeg`, downloads a static build from [BtbN's ffmpeg-builds](https://github.com/BtbN/FFmpeg-Builds) if missing or below v6, and uses that binary for all operations. No system ffmpeg is required.

---

## Album art embedding

The downloaded thumbnail (converted to JPEG by yt-dlp) is embedded through `embedCover()` in `src/util/ffmpeg-tags.js`:

| Format | Method |
|--------|--------|
| **MP3** | ID3v2.3 attached picture — ffmpeg maps the JPEG as a video stream with `-c:v mjpeg -disposition:v:0 attached_pic` |
| **M4A** | Attached picture stream (`-disposition:v:0 attached_pic`) |
| **Opus / OGG** | Vorbis `METADATA_BLOCK_PICTURE` comment — binary picture block, base64-encoded, passed in through an ffmetadata file (it can be too long for a command-line argument). No video stream mapping (Opus containers reject video streams). |

If there is no thumbnail, the file is only tagged (`writeAudioWithTags`). If the ffmpeg binary is missing, the untagged file is moved into place as-is.

---

## Temp file isolation

The raw audio and thumbnail are written to a **private temp directory** under the OS temp folder (`/tmp/velvet-ytdl-XXXXXX/`), which is deleted after every download. The tagged output is written by ffmpeg to a hidden temp file in the target folder and then renamed into place in one step; on failure the partial output is removed.
