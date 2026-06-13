FROM node:24-slim

# Build tools needed for npm native modules on Debian slim
# hadolint ignore=DL3008
RUN apt-get update && apt-get install -y --no-install-recommends wget xz-utils gosu && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --chown=node:node package*.json ./
RUN npm ci --omit=dev

COPY --chown=node:node . .

# Pre-download yt-dlp so it's ready immediately on container start.
# The server also auto-downloads it at runtime if missing or empty.
RUN arch="$(uname -m)"; \
    case "$arch" in \
      x86_64)  url="https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux" ;; \
      aarch64) url="https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux_aarch64" ;; \
      armv7l)  url="https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux_armv7l" ;; \
      *)       url="" ;; \
    esac; \
    if [ -n "$url" ]; then \
      mkdir -p bin/yt-dlp && \
      if wget -q -O bin/yt-dlp/yt-dlp "$url" && [ -s bin/yt-dlp/yt-dlp ]; then \
        chmod +x bin/yt-dlp/yt-dlp && echo "yt-dlp pre-download OK"; \
      else \
        rm -f bin/yt-dlp/yt-dlp && echo "yt-dlp pre-download failed (will auto-download at runtime)"; \
      fi; \
    fi

# Pre-download fpcalc (Chromaprint) for AcoustID fingerprinting.
# Static binary, no system dependencies. Falls back gracefully if download fails.
RUN arch="$(uname -m)"; \
    case "$arch" in \
      x86_64)  url="https://github.com/acoustid/chromaprint/releases/download/v1.5.1/chromaprint-fpcalc-1.5.1-linux-x86_64.tar.gz" ;; \
      aarch64) url="https://github.com/acoustid/chromaprint/releases/download/v1.5.1/chromaprint-fpcalc-1.5.1-linux-aarch64.tar.gz" ;; \
      *)       url="" ;; \
    esac; \
    if [ -n "$url" ]; then \
      mkdir -p bin/fpcalc && \
      if wget -q -O /tmp/fpcalc.tar.gz "$url" && \
         tar -xzf /tmp/fpcalc.tar.gz -C bin/fpcalc --strip-components=1 --wildcards '*/fpcalc' && \
         chmod +x bin/fpcalc/fpcalc && \
         rm -f /tmp/fpcalc.tar.gz && \
         bin/fpcalc/fpcalc -version; then \
        echo "fpcalc pre-download OK"; \
      else \
        rm -rf bin/fpcalc && echo "fpcalc pre-download failed (will auto-download at runtime)"; \
      fi; \
    fi

# Pre-download ffmpeg + ffprobe (BtbN static GPL build) so CUE track slicing
# and transcoding are ready immediately on container start — no 1–5 min wait.
# Falls back gracefully: bootstrap.js re-downloads at runtime if this fails.
# hadolint ignore=DL4006
RUN arch="$(uname -m)"; \
    case "$arch" in \
      x86_64)  asset="ffmpeg-master-latest-linux64-gpl.tar.xz" ;; \
      aarch64) asset="ffmpeg-master-latest-linuxarm64-gpl.tar.xz" ;; \
      *)       asset="" ;; \
    esac; \
    if [ -n "$asset" ]; then \
      url="https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/${asset}"; \
      mkdir -p bin/ffmpeg && \
      if wget -q --show-progress -O /tmp/ffmpeg.tar.xz "$url" && [ -s /tmp/ffmpeg.tar.xz ]; then \
        prefix="$(basename "$asset" .tar.xz)"; \
        if tar -xJf /tmp/ffmpeg.tar.xz -C bin/ffmpeg --strip-components=2 \
             "${prefix}/bin/ffmpeg" "${prefix}/bin/ffprobe" && \
           chmod +x bin/ffmpeg/ffmpeg bin/ffmpeg/ffprobe && \
           rm -f /tmp/ffmpeg.tar.xz && \
           bin/ffmpeg/ffmpeg -version | head -1; then \
          echo "ffmpeg pre-download OK"; \
        else \
          rm -rf bin/ffmpeg /tmp/ffmpeg.tar.xz && echo "ffmpeg pre-download extract failed (will auto-download at runtime)"; \
        fi; \
      else \
        rm -f /tmp/ffmpeg.tar.xz && echo "ffmpeg pre-download failed (will auto-download at runtime)"; \
      fi; \
    else \
      echo "ffmpeg: arch ${arch} not supported for pre-download (will auto-download at runtime)"; \
    fi

# Pre-download rsgain (EBU R128 measurement, x86_64 only — no arm64 static build available).
# Falls back to ffmpeg-based measurement at runtime when rsgain is absent.
# hadolint ignore=DL4006
RUN arch="$(uname -m)"; \
    if [ "$arch" = "x86_64" ]; then \
      tag=$(wget -qO- "https://api.github.com/repos/complexlogic/rsgain/releases/latest" \
            | grep '"tag_name"' | head -1 | sed 's/.*"v\([^"]*\)".*/\1/') && \
      if [ -n "$tag" ]; then \
        mkdir -p bin/rsgain && \
        if wget -q -O /tmp/rsgain.tar.xz \
             "https://github.com/complexlogic/rsgain/releases/download/v${tag}/rsgain-${tag}-Linux.tar.xz" && \
           tar -xJf /tmp/rsgain.tar.xz -C bin/rsgain --strip-components=1 "rsgain-${tag}-Linux/rsgain" && \
           chmod +x bin/rsgain/rsgain && \
           rm -f /tmp/rsgain.tar.xz && \
           bin/rsgain/rsgain --version; then \
          echo "rsgain pre-download OK (v${tag})"; \
        else \
          rm -rf bin/rsgain && echo "rsgain pre-download failed (ffmpeg fallback will be used)"; \
        fi; \
      else \
        echo "rsgain: could not resolve latest tag (ffmpeg fallback will be used)"; \
      fi; \
    else \
      echo "rsgain: arch ${arch} not supported (ffmpeg fallback will be used)"; \
    fi

# Pre-create runtime directories so SQLite and the config writer
# can initialise even when no volume is mounted on first start.
RUN mkdir -p save/conf save/db save/logs save/sync image-cache waveform-cache && \
  chown -R node:node /app/save /app/image-cache /app/waveform-cache /app/bin

# Entrypoint script for startup bootstrap
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# First-run auto-config env vars - ALL OPTIONAL, see compose.yaml for full docs.
# These are a convenience for simple single-library setups only.
# For multiple volumes, child-vpaths, albumsOnly, or any advanced config,
# edit save/conf/default.json directly instead of using these variables.
# VELVET_MUSIC_DIR is the only trigger; empty here = bootstrap never runs.
ENV VELVET_MUSIC_DIR=""
ENV VELVET_ADMIN_USER=""
ENV VELVET_ADMIN_PASS=""
ENV VELVET_ENABLE_AUDIOBOOKS=""
ENV VELVET_ENABLE_RECORDINGS=""
ENV VELVET_ENABLE_YOUTUBE=""
ENV VELVET_AUDIOBOOKS_SUBDIR=""
ENV VELVET_RECORDINGS_SUBDIR=""
ENV VELVET_YOUTUBE_SUBDIR=""

EXPOSE 3000

# Default to root so the entrypoint can fix ownership of data directories
# that may have been created by older root-based deployments.
# The entrypoint drops to the `node` user before exec-ing the server.
# Override with --user if you want to skip the chown step.
# USER node  ← intentionally omitted; entrypoint handles privilege drop

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "cli-boot-wrapper.js"]
