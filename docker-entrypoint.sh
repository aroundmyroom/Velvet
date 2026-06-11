#!/bin/sh
# docker-entrypoint.sh — startup bootstrap for Velvet
#
# Runs as root so it can fix ownership of data directories that may have been
# created by older versions of the container which ran as root. After fixing
# permissions it drops privileges and execs the process as the `node` user.
#
# If the container is already started as a non-root user (e.g. via
# `docker run --user`), the chown step is skipped and the process runs as-is.

set -e

check_writable_dirs() {
  for d in /app/save /app/save/db /app/save/logs /app/save/conf /app/image-cache /app/waveform-cache /app/bin; do
    mkdir -p "$d" 2>/dev/null || true
    if [ ! -w "$d" ]; then
      return 1
    fi
  done
  return 0
}

if [ "$(id -u)" = "0" ]; then
  echo "[entrypoint] Fixing ownership of data directories..."
  chown -R node:node /app/save /app/image-cache /app/waveform-cache /app/bin 2>/dev/null || true
  if gosu node sh -c 'for d in /app/save /app/save/db /app/save/logs /app/save/conf /app/image-cache /app/waveform-cache /app/bin; do mkdir -p "$d" 2>/dev/null || true; [ -w "$d" ] || exit 1; done'; then
    echo "[entrypoint] Dropping privileges to node user"
    exec gosu node "$@"
  fi

  echo "[entrypoint] Warning: mounted data directories are not writable by node after chown attempt."
  echo "[entrypoint] Running as root for compatibility."
  echo "[entrypoint] Recommended host fix: chown -R <uid>:<gid> /path/to/save /path/to/image-cache /path/to/waveform-cache"
  exec "$@"
else
  echo "[entrypoint] Running as non-root user (uid=$(id -u))"
  if ! check_writable_dirs; then
    echo "[entrypoint] Error: mounted data directories are not writable for uid=$(id -u)."
    echo "[entrypoint] Fix host ownership (chown -R <uid>:<gid> /path/to/save /path/to/image-cache /path/to/waveform-cache)"
    echo "[entrypoint] or remove the compose user override so entrypoint can repair ownership."
    exit 70
  fi
  exec "$@"
fi
