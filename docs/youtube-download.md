# YouTube Download

Velvet can download audio from YouTube URLs directly from the web interface, saving files to a dedicated YouTube downloads folder.

## How it works

1. Paste a YouTube URL into the YouTube view and click **Preview**
2. Velvet fetches metadata (title, artist, thumbnail, upload year) via yt-dlp — album field is left blank for you to fill in
3. Edit the tags if needed, choose a format (Opus or MP3), and click **Download**
4. The file is saved to your configured YouTube or recordings folder
5. **▶ Play now** and **+ Add to queue** buttons appear immediately after download

Files are tagged with the title, artist, album, and year from YouTube metadata (or whatever you edited before downloading).

## Permissions

YouTube download is an opt-in per-user permission. An admin must enable it for each user:

- Go to **Admin → Users**
- Click the **YouTube** toggle button next to the user
- The YouTube nav item will appear in the sidebar for that user

## Folder setup

Create a dedicated folder for YouTube downloads in **Admin → Add Folder**:

- Check **YouTube Downloads folder** when adding it
- This marks the folder as `type: youtube` — files are saved here, not scanned into the music library, but accessible from the Audio Content view and the file explorer
- If no `youtube` folder is configured, the server falls back to any `recordings` folder the user has access to

You can optionally check **Allow users to delete** to let users remove downloaded files.

## Supported formats

| Format | Description |
|--------|-------------|
| **Opus** | Native stream from YouTube — no re-encoding, best quality at smallest size |
| **MP3** | Re-encoded via ffmpeg — broadest device compatibility |

Filenames are saved as `Artist - Title.opus` (or `Title.opus` if no artist).

---

## yt-dlp binary management

Velvet uses [yt-dlp](https://github.com/yt-dlp/yt-dlp) under the hood. The binary lives at `bin/yt-dlp/yt-dlp` and is **not** committed to git.

### Automatic download on first run

**No setup is needed.** On every startup, Velvet:

1. Checks whether `bin/yt-dlp/yt-dlp` exists
2. If missing — downloads the correct build for your platform automatically from the GitHub releases page
3. Runs `yt-dlp --update` — yt-dlp compares its compiled-in version string against the latest GitHub release tag and self-updates in-place if a newer version is available

This means:
- Cloning the repo and starting the server is all that's required
- YouTube compatibility is maintained automatically — when YouTube changes their player and yt-dlp releases a fix, it is picked up on the next server restart
- The current/new version is visible in the Velvet logs: `yt-dlp update: Updated yt-dlp to 2025.03.27` or `yt-dlp is up to date (2025.03.15)`

### Docker

The `Dockerfile` downloads yt-dlp at **image build time** (architecture-aware: x86_64, ARM64, ARMv7). The runtime auto-download and update still runs on container startup.

### Air-gapped / offline servers

If the server has no outbound internet access, place the binary manually (see [bin/yt-dlp/README.md](https://github.com/aroundmyroom/Velvet/blob/main/bin/yt-dlp/README.md)). Once placed, `--update` will fail silently and the existing binary will be used as-is.

As a further fallback, if the binary is missing entirely and cannot be downloaded, Velvet will attempt to use a system-installed `yt-dlp` on `$PATH`.

---

## ffmpeg dependency

Tagging and format conversion are done by ffmpeg. Velvet includes a self-contained ffmpeg bootstrap: at startup it checks `bin/ffmpeg/ffmpeg`, downloads a static build from [BtbN's ffmpeg-builds](https://github.com/BtbN/FFmpeg-Builds) if missing or below v6, and uses that binary for all operations. No system ffmpeg is required.

---

## Album art embedding

The downloaded thumbnail (JPEG) is embedded in the output file using format-appropriate methods:

| Format | Method |
|--------|--------|
| **MP3** | ID3v2 attached picture frame — ffmpeg maps the JPEG as a video stream with `-c:v mjpeg -disposition:v:0 attached_pic` |
| **Opus / OGG** | Vorbis `METADATA_BLOCK_PICTURE` comment — binary-encoded per the FLAC/Vorbis picture block spec, base64-encoded, injected via `-metadata METADATA_BLOCK_PICTURE=<base64>`. No video stream mapping (Opus containers reject video streams). |

---

## Temp file isolation

All intermediate files (raw audio stream, thumbnail JPEG) are written to a **private temp directory** created under the OS temp folder (e.g. `/tmp/velvet-ytdl-XXXXXX/`). The directory is unconditionally deleted in a `finally` block after every download — the music folder is never touched until the final tagged file is moved into place.
