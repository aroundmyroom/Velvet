# bin/yt-dlp

This directory holds the [yt-dlp](https://github.com/yt-dlp/yt-dlp) binary (`yt-dlp` on Linux/Mac, `yt-dlp.exe` on Windows).

The binary is excluded from git (listed in `.gitignore`) because it is a large platform-specific executable that is updated frequently.

See **[docs/youtube-download.md](../../docs/youtube-download.md)** for full documentation on the YouTube download feature including how automatic download and updating works.

## Quick reference: manual placement (air-gapped / offline servers)

### Linux x86_64
```
curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o bin/yt-dlp/yt-dlp
chmod +x bin/yt-dlp/yt-dlp
```

### Linux ARM64
```
curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux_aarch64 -o bin/yt-dlp/yt-dlp
chmod +x bin/yt-dlp/yt-dlp
```

### Windows
```
curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe -o bin/yt-dlp/yt-dlp.exe
```
