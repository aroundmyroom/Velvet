#!/usr/bin/env bash
# Velvet installer/updater — runs as root inside a fresh (or existing) Debian
# container (LXC via Proxmox, or an Incus container). Shared by both
# contrib/proxmox-lxc/ct/velvet.sh and contrib/incus/velvet-incus.sh so the
# install/update logic exists exactly once.
#
# Usage:
#   velvet-install.sh --mode install [--music-dir PATH] [--admin-user NAME --admin-pass PASS]
#                      [--enable-audiobooks[=NAME]] [--enable-recordings[=NAME]] [--enable-youtube[=NAME]]
#                      [--repo URL] [--ref TAG] [--install-dir PATH] [--service-user NAME]
#                      [--verbose] [--dry-run]
#   velvet-install.sh --mode update [--ref TAG] [--update-strategy auto|api|shell]
#                      [--install-dir PATH] [--service-user NAME] [--verbose] [--dry-run]
#
# See --help for the full flag list. Every mutating step is logged to
# $LOG_FILE and, with --verbose, also streamed live.

set -u

# ── defaults ─────────────────────────────────────────────────────────────
MODE=""
REPO="https://github.com/aroundmyroom/Velvet.git"
REF=""
INSTALL_DIR="/opt/velvet"
SERVICE_USER="velvet"
MUSIC_DIR=""
ADMIN_USER=""
ADMIN_PASS=""
ENABLE_AUDIOBOOKS=0
ENABLE_RECORDINGS=0
ENABLE_YOUTUBE=0
AUDIOBOOKS_SUBDIR=""
RECORDINGS_SUBDIR=""
YOUTUBE_SUBDIR=""
UPDATE_STRATEGY="auto"
VERBOSE=0
DRY_RUN=0
LOG_FILE="/var/log/velvet-installer.log"
RELEASES_API="https://api.github.com/repos/aroundmyroom/Velvet/releases/latest"
NODE_MAJOR_MIN=22
NODE_MAJOR_TARGET=24

# ── output helpers ───────────────────────────────────────────────────────
CL='\033[0m'; RD='\033[1;31m'; GN='\033[1;32m'; YW='\033[1;33m'; BL='\033[1;36m'
msg_info()  { printf "%b\n" "${BL}➜${CL} $1"; }
msg_ok()    { printf "%b\n" "${GN}✓${CL} $1"; }
msg_warn()  { printf "%b\n" "${YW}!${CL} $1"; }
msg_error() { printf "%b\n" "${RD}✗${CL} $1" >&2; }

usage() {
  cat <<'EOF'
Velvet installer/updater for LXC (Proxmox) and Incus containers.

  --mode install|update        (required)
  --repo URL                   git remote to install/update from (default: the official repo)
  --ref TAG                    release tag to install/update to (default: latest GitHub release)
  --install-dir PATH           where Velvet lives (default: /opt/velvet)
  --service-user NAME          system user Velvet runs as (default: velvet)
  --music-dir PATH             first-run only: path to the music library inside the container
  --admin-user NAME            first-run only: create this admin account
  --admin-pass PASS            first-run only: password for --admin-user
  --enable-audiobooks[=SUBDIR] first-run only: add an audiobooks folder (optional sub-folder name)
  --enable-recordings[=SUBDIR] first-run only: add a radio-recordings folder + enable radio
  --enable-youtube[=SUBDIR]    first-run only: add a YouTube-downloads folder
  --update-strategy auto|api|shell
                                update only. auto (default): try the running app's own
                                Admin → Updates API first, fall back to a direct git+npm
                                update if that isn't reachable. api/shell force one path.
  -v, --verbose                 stream every command's output instead of a one-line summary
  --dry-run                     print what would run/be written, change nothing
  -h, --help                    this text
EOF
}

# ── argument parsing ─────────────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    --mode) MODE="$2"; shift 2 ;;
    --mode=*) MODE="${1#*=}"; shift ;;
    --repo) REPO="$2"; shift 2 ;;
    --repo=*) REPO="${1#*=}"; shift ;;
    --ref) REF="$2"; shift 2 ;;
    --ref=*) REF="${1#*=}"; shift ;;
    --install-dir) INSTALL_DIR="$2"; shift 2 ;;
    --install-dir=*) INSTALL_DIR="${1#*=}"; shift ;;
    --service-user) SERVICE_USER="$2"; shift 2 ;;
    --service-user=*) SERVICE_USER="${1#*=}"; shift ;;
    --music-dir) MUSIC_DIR="$2"; shift 2 ;;
    --music-dir=*) MUSIC_DIR="${1#*=}"; shift ;;
    --admin-user) ADMIN_USER="$2"; shift 2 ;;
    --admin-user=*) ADMIN_USER="${1#*=}"; shift ;;
    --admin-pass) ADMIN_PASS="$2"; shift 2 ;;
    --admin-pass=*) ADMIN_PASS="${1#*=}"; shift ;;
    --enable-audiobooks) ENABLE_AUDIOBOOKS=1; shift ;;
    --enable-audiobooks=*) ENABLE_AUDIOBOOKS=1; AUDIOBOOKS_SUBDIR="${1#*=}"; shift ;;
    --enable-recordings) ENABLE_RECORDINGS=1; shift ;;
    --enable-recordings=*) ENABLE_RECORDINGS=1; RECORDINGS_SUBDIR="${1#*=}"; shift ;;
    --enable-youtube) ENABLE_YOUTUBE=1; shift ;;
    --enable-youtube=*) ENABLE_YOUTUBE=1; YOUTUBE_SUBDIR="${1#*=}"; shift ;;
    --update-strategy) UPDATE_STRATEGY="$2"; shift 2 ;;
    --update-strategy=*) UPDATE_STRATEGY="${1#*=}"; shift ;;
    -v|--verbose) VERBOSE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) msg_error "Unknown argument: $1"; usage; exit 2 ;;
  esac
done

case "$MODE" in
  install|update) ;;
  *) msg_error "--mode install|update is required"; usage; exit 2 ;;
esac
if { [ -n "$ADMIN_USER" ] && [ -z "$ADMIN_PASS" ]; } || { [ -z "$ADMIN_USER" ] && [ -n "$ADMIN_PASS" ]; }; then
  msg_error "--admin-user and --admin-pass must be given together"
  exit 2
fi
case "$UPDATE_STRATEGY" in auto|api|shell) ;; *) msg_error "--update-strategy must be auto, api or shell"; exit 2 ;; esac
if [ "$DRY_RUN" != "1" ] && [ "$(id -u)" != "0" ]; then
  msg_error "Must run as root (this installs system packages and a systemd unit)"
  exit 1
fi
if [ "$DRY_RUN" != "1" ]; then
  mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || LOG_FILE="/tmp/velvet-installer.log"
  : > "$LOG_FILE" 2>/dev/null || LOG_FILE="/tmp/velvet-installer.log"
fi

# ── step runners ─────────────────────────────────────────────────────────
# try_step: logs + runs, returns non-zero on failure (caller decides what to do).
# run_step: same, but exits the whole script on failure — used wherever a
#           partial failure should just stop, matching install.md's own
#           "if a step fails, stop and look" expectation.
try_step() {
  local desc="$1"; shift
  msg_info "$desc"
  if [ "$DRY_RUN" = "1" ]; then
    printf '  [dry-run] %s\n' "$(printf '%q ' "$@")"
    msg_ok "$desc (dry-run)"
    return 0
  fi
  local rc
  if [ "$VERBOSE" = "1" ]; then
    "$@" 2>&1 | tee -a "$LOG_FILE"
    rc=${PIPESTATUS[0]}
  else
    "$@" >>"$LOG_FILE" 2>&1
    rc=$?
  fi
  if [ "$rc" -ne 0 ]; then
    msg_error "$desc failed (exit $rc) — see $LOG_FILE"
    return 1
  fi
  msg_ok "$desc"
  return 0
}
run_step() { try_step "$@" || exit 1; }

write_file() {
  local path="$1" content="$2" mode="${3:-644}"
  if [ "$DRY_RUN" = "1" ]; then
    msg_info "Would write $path (mode $mode)"
    printf '  ---\n%s\n  ---\n' "$content"
    return 0
  fi
  printf '%s\n' "$content" > "$path"
  chmod "$mode" "$path"
  msg_ok "Wrote $path"
}

sha256_file() { [ -f "$1" ] && sha256sum "$1" 2>/dev/null | awk '{print $1}' || echo "missing"; }

resolve_latest_ref() {
  if [ -n "$REF" ]; then return 0; fi
  msg_info "Resolving the latest Velvet release from GitHub"
  if [ "$DRY_RUN" = "1" ]; then
    REF="(latest, resolved at run time)"
    msg_ok "Would resolve latest release here"
    return 0
  fi
  REF=$(curl -fsSL "$RELEASES_API" | grep -m1 '"tag_name"' | sed -E 's/.*"tag_name":[[:space:]]*"([^"]+)".*/\1/')
  if [ -z "$REF" ]; then
    msg_error "Could not resolve the latest release tag from $RELEASES_API"
    exit 1
  fi
  msg_ok "Latest release is $REF"
}

# ── install ──────────────────────────────────────────────────────────────
do_install() {
  if [ -d "$INSTALL_DIR/.git" ]; then
    msg_error "$INSTALL_DIR already contains a Velvet checkout — use --mode update instead"
    exit 1
  fi
  if [ -e "$INSTALL_DIR" ] && [ -n "$(ls -A "$INSTALL_DIR" 2>/dev/null)" ]; then
    msg_error "$INSTALL_DIR already exists and is not empty — refusing to overwrite"
    exit 1
  fi

  run_step "Updating package lists" apt-get update -y
  run_step "Installing base packages" apt-get install -y --no-install-recommends git curl ca-certificates gnupg jq

  local node_major=0
  if command -v node >/dev/null 2>&1; then
    node_major=$(node -e 'console.log(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)
  fi
  if [ "$node_major" -ge "$NODE_MAJOR_MIN" ] 2>/dev/null; then
    msg_ok "Node.js $(node -v 2>/dev/null) already satisfies >=${NODE_MAJOR_MIN} — not reinstalling"
  else
    run_step "Adding the NodeSource repository (Node ${NODE_MAJOR_TARGET}.x)" bash -c "curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR_TARGET}.x | bash -"
    run_step "Installing Node.js" apt-get install -y nodejs
  fi

  resolve_latest_ref

  if ! id "$SERVICE_USER" >/dev/null 2>&1; then
    run_step "Creating system user $SERVICE_USER" useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
  else
    msg_ok "System user $SERVICE_USER already exists"
  fi

  run_step "Cloning Velvet $REF" git clone --branch "$REF" --depth 1 "$REPO" "$INSTALL_DIR"
  run_step "Installing Node dependencies (npm ci --omit=dev)" env -C "$INSTALL_DIR" npm ci --omit=dev
  run_step "Creating data directories" bash -c "mkdir -p '$INSTALL_DIR'/save/conf '$INSTALL_DIR'/save/db '$INSTALL_DIR'/save/logs '$INSTALL_DIR'/save/sync '$INSTALL_DIR'/image-cache '$INSTALL_DIR'/waveform-cache"
  run_step "Setting ownership ($SERVICE_USER)" chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"

  # First-run env file consumed by cli-boot-wrapper.js's existing VELVET_*
  # bootstrap (the same mechanism compose.yaml's `environment:` block uses
  # for Docker) — no application code needed for this, it already exists.
  # Mode 600: this can contain an admin password in plaintext.
  local env_lines=""
  [ -n "$MUSIC_DIR" ]        && env_lines+="VELVET_MUSIC_DIR=${MUSIC_DIR}\n"
  [ -n "$ADMIN_USER" ]       && env_lines+="VELVET_ADMIN_USER=${ADMIN_USER}\n"
  [ -n "$ADMIN_PASS" ]       && env_lines+="VELVET_ADMIN_PASS=${ADMIN_PASS}\n"
  [ "$ENABLE_AUDIOBOOKS" = "1" ] && env_lines+="VELVET_ENABLE_AUDIOBOOKS=true\n"
  [ -n "$AUDIOBOOKS_SUBDIR" ]    && env_lines+="VELVET_AUDIOBOOKS_SUBDIR=${AUDIOBOOKS_SUBDIR}\n"
  [ "$ENABLE_RECORDINGS" = "1" ] && env_lines+="VELVET_ENABLE_RECORDINGS=true\n"
  [ -n "$RECORDINGS_SUBDIR" ]    && env_lines+="VELVET_RECORDINGS_SUBDIR=${RECORDINGS_SUBDIR}\n"
  [ "$ENABLE_YOUTUBE" = "1" ]    && env_lines+="VELVET_ENABLE_YOUTUBE=true\n"
  [ -n "$YOUTUBE_SUBDIR" ]       && env_lines+="VELVET_YOUTUBE_SUBDIR=${YOUTUBE_SUBDIR}\n"
  if [ -n "$env_lines" ]; then
    write_file /etc/velvet.env "$(printf '%b' "$env_lines")" 600
  else
    msg_warn "No first-run options given — Velvet will boot with no folders or users; set them up from the admin UI"
  fi

  local node_bin; node_bin="$(command -v node || echo /usr/bin/node)"
  write_file /etc/systemd/system/velvet.service "[Unit]
Description=Velvet
After=network.target

[Service]
Type=simple
User=${SERVICE_USER}
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=-/etc/velvet.env
ExecStart=${node_bin} ${INSTALL_DIR}/cli-boot-wrapper.js
Restart=on-failure

[Install]
WantedBy=multi-user.target" 644

  run_step "Reloading systemd" systemctl daemon-reload
  run_step "Verifying the entry point parses" env -C "$INSTALL_DIR" node --check cli-boot-wrapper.js
  run_step "Enabling and starting Velvet" systemctl enable --now velvet

  local ip; ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  msg_ok "Velvet is installed and running: http://${ip:-<container-ip>}:3000"
}

# ── update ───────────────────────────────────────────────────────────────
api_update() {
  if [ ! -f "$INSTALL_DIR/node_modules/jsonwebtoken/package.json" ]; then
    msg_warn "No node_modules/jsonwebtoken in $INSTALL_DIR — can't mint a token for the API path"
    return 1
  fi
  local conf="$INSTALL_DIR/save/conf/default.json"
  if [ ! -f "$conf" ]; then
    msg_warn "No $conf yet — can't use the API path before first boot"
    return 1
  fi
  local secret admin_user
  secret=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$conf','utf8')).secret||'')}catch{console.log('')}" 2>/dev/null)
  admin_user=$(node -e "try{const c=JSON.parse(require('fs').readFileSync('$conf','utf8'));const u=Object.entries(c.users||{}).find(([,v])=>v.admin);console.log(u?u[0]:'')}catch{console.log('')}" 2>/dev/null)
  if [ -z "$secret" ] || [ -z "$admin_user" ]; then
    msg_warn "No admin user found in $conf — can't use the API path (falling back)"
    return 1
  fi

  local tmp_cjs token
  tmp_cjs=$(mktemp --suffix=.cjs)
  cat > "$tmp_cjs" <<'JS'
const jwt = require(process.argv[2] + '/node_modules/jsonwebtoken');
process.stdout.write(jwt.sign({ username: process.argv[3] }, process.argv[4]));
JS
  token=$(node "$tmp_cjs" "$INSTALL_DIR" "$admin_user" "$secret" 2>>"$LOG_FILE")
  rm -f "$tmp_cjs"
  if [ -z "$token" ]; then
    msg_warn "Could not mint an admin token — falling back"
    return 1
  fi

  local base="http://127.0.0.1:3000"
  local check
  check=$(curl -fsSL -m 10 -H "x-access-token: $token" "$base/api/v1/admin/update/check?force=1" 2>>"$LOG_FILE")
  if [ -z "$check" ]; then
    msg_warn "Could not reach $base/api/v1/admin/update/check — is Velvet running? Falling back"
    return 1
  fi
  local current is_newer target
  current=$(printf '%s' "$check" | jq -r '.currentVersion // ""')
  is_newer=$(printf '%s' "$check" | jq -r '.isNewer // false')
  target=$(printf '%s' "$check" | jq -r '.latest.version // ""')
  if [ "$is_newer" != "true" ] || [ -z "$target" ]; then
    msg_ok "Already on the latest release (v${current}) — nothing to do"
    return 0
  fi

  msg_info "Updating v${current} → v${target} via Admin → Updates (same path as the admin UI)"
  if [ "$DRY_RUN" = "1" ]; then
    msg_ok "(dry-run) would POST $base/api/v1/admin/update/start {version: \"$target\"}"
    return 0
  fi

  local start_body="{\"version\":\"${target}\"}"
  if ! curl -fsSL -m 10 -X POST -H "x-access-token: $token" -H "Content-Type: application/json" -d "$start_body" "$base/api/v1/admin/update/start" >>"$LOG_FILE" 2>&1; then
    msg_warn "POST /api/v1/admin/update/start failed — falling back"
    return 1
  fi

  local phase2=0 status cur state phase percent err
  for _i in $(seq 1 300); do
    sleep 2
    status=$(curl -fsSL -m 5 -H "x-access-token: $token" "$base/api/v1/admin/update/status" 2>>"$LOG_FILE")
    if [ -z "$status" ]; then
      phase2=1
      printf '\r  restarting, waiting for the service to come back…        '
      continue
    fi
    cur=$(printf '%s' "$status" | jq -r '.currentVersion // ""')
    state=$(printf '%s' "$status" | jq -r '.job.state // "idle"')
    if [ "$cur" = "$target" ]; then
      echo
      msg_ok "Updated to v${target} and the service is back online"
      return 0
    fi
    if [ "$state" = "failed" ]; then
      err=$(printf '%s' "$status" | jq -r '.job.error // "unknown error"')
      echo
      msg_error "Update failed via the API: $err"
      return 1
    fi
    if [ "$state" = "restarting" ] || [ "$phase2" = "1" ]; then
      phase2=1
      printf '\r  restarting…                                               '
    else
      phase=$(printf '%s' "$status" | jq -r '.job.phase // ""')
      percent=$(printf '%s' "$status" | jq -r '.job.percent // 0')
      printf '\r  [%3s%%] %-12s                                       ' "$percent" "$phase"
    fi
  done
  echo
  msg_warn "Timed out waiting for the API update to finish — checking the service directly"
  return 1
}

shell_update() {
  if [ ! -d "$INSTALL_DIR/.git" ]; then
    msg_error "$INSTALL_DIR has no git checkout — use --mode install first"
    return 1
  fi
  resolve_latest_ref
  local old_head lock_before lock_after tag_commit new_version
  old_head=$(env -C "$INSTALL_DIR" git rev-parse HEAD 2>/dev/null || echo "")
  lock_before=$(sha256_file "$INSTALL_DIR/package-lock.json")

  try_step "Fetching tags" env -C "$INSTALL_DIR" git fetch --tags --prune origin || return 1

  if [ "$DRY_RUN" = "1" ]; then
    msg_ok "(dry-run) would verify tag $REF, check ancestry, checkout, npm ci if the lockfile changed, restart"
    return 0
  fi

  tag_commit=$(env -C "$INSTALL_DIR" git rev-parse -q --verify "refs/tags/${REF}^{commit}")
  if [ -z "$tag_commit" ]; then
    msg_error "Tag $REF does not exist on origin"
    return 1
  fi
  if ! env -C "$INSTALL_DIR" git merge-base --is-ancestor HEAD "$tag_commit"; then
    msg_error "$INSTALL_DIR has local commits not in $REF — refusing to fast-forward. Inspect it manually (git log/status)."
    return 1
  fi

  try_step "Stopping Velvet" systemctl stop velvet || return 1
  if ! try_step "Checking out $REF" env -C "$INSTALL_DIR" git checkout -q "$tag_commit"; then
    try_step "Restarting Velvet (checkout failed, nothing changed)" systemctl start velvet
    return 1
  fi

  lock_after=$(sha256_file "$INSTALL_DIR/package-lock.json")
  if [ "$lock_before" != "$lock_after" ]; then
    if ! try_step "Installing updated dependencies (npm ci --omit=dev)" env -C "$INSTALL_DIR" npm ci --omit=dev; then
      msg_error "npm ci failed — rolling back to the previous commit"
      env -C "$INSTALL_DIR" git reset --hard "$old_head" >>"$LOG_FILE" 2>&1
      try_step "Restarting Velvet on the previous version" systemctl start velvet
      return 1
    fi
  else
    msg_ok "package-lock.json unchanged — skipping npm ci"
  fi

  try_step "Fixing ownership" chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR" || true
  if ! try_step "Verifying the entry point parses" env -C "$INSTALL_DIR" node --check cli-boot-wrapper.js; then
    msg_error "Verification failed — rolling back to the previous commit"
    env -C "$INSTALL_DIR" git reset --hard "$old_head" >>"$LOG_FILE" 2>&1
    try_step "Restarting Velvet on the previous version" systemctl start velvet
    return 1
  fi
  try_step "Starting Velvet" systemctl start velvet || return 1

  new_version=$(node -e "console.log(require('$INSTALL_DIR/package.json').version)" 2>/dev/null)
  msg_ok "Updated to v${new_version:-$REF}"
  return 0
}

do_update() {
  case "$UPDATE_STRATEGY" in
    api)
      api_update || { msg_error "API update failed and --update-strategy=api forbids falling back"; exit 1; }
      ;;
    shell)
      shell_update || exit 1
      ;;
    auto)
      if ! api_update; then
        msg_info "Falling back to a direct git+npm update"
        shell_update || exit 1
      fi
      ;;
  esac
}

# ── main ─────────────────────────────────────────────────────────────────
[ "$DRY_RUN" = "1" ] && msg_warn "DRY RUN — no packages, files or services will actually change"
case "$MODE" in
  install) do_install ;;
  update)  do_update ;;
esac
