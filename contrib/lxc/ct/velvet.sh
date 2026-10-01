#!/usr/bin/env bash

# Copyright (c) 2021-2026 aroundmyroom
# License: MIT | https://github.com/aroundmyroom/Velvet/raw/main/LICENSE
# Source: https://github.com/aroundmyroom/Velvet
#
# Creates an LXC (Proxmox VE) or Incus container and installs Velvet into it,
# using the community-scripts/core engine (community-scripts.org) for the
# interactive container wizard — CT ID/name, hostname, disk, CPU, RAM,
# storage, network, default-vs-advanced settings, and a verbose toggle — on
# BOTH Proxmox VE and Incus hosts; the engine auto-detects which one it is
# running on (is_incus_lxc_backend) and dispatches accordingly.
#
# One-liner (Proxmox VE shell, or an Incus host with the `incus` CLI ready):
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/aroundmyroom/Velvet/main/contrib/lxc/ct/velvet.sh)"
#
# Re-running the SAME line against an existing container updates it instead
# of creating a new one (update_script() below) — see docs/lxc-incus.md.
#
# COMMUNITY_SCRIPTS_URL is set explicitly, not left to the engine's default,
# because a script fetched by curl (no local git checkout) cannot otherwise
# tell the engine which repo it came from, and the engine's own fallback
# points at community-scripts' OWN catalog, not ours (confirmed by reading
# core/build.func — this is the documented fix for exactly this situation).
export COMMUNITY_SCRIPTS_URL="${COMMUNITY_SCRIPTS_URL:-https://raw.githubusercontent.com/aroundmyroom/Velvet/main/contrib/lxc}"
# shellcheck disable=SC1090  # remote engine, fetched fresh every run by design
source <(curl -fsSL "${COMMUNITY_SCRIPTS_CORE_URL:-https://raw.githubusercontent.com/community-scripts/core/main}/core/build.func")

APP="Velvet"
var_tags="${var_tags:-music}"
var_cpu="${var_cpu:-2}"
var_ram="${var_ram:-2048}"
var_disk="${var_disk:-8}"
var_os="${var_os:-debian}"
var_version="${var_version:-13}"
var_unprivileged="${var_unprivileged:-1}"
# shellcheck disable=SC2034  # read by the sourced community-scripts engine, not by this file
var_install="velvet-install"

# The installer URL is also what update_script() below uses directly (it
# never goes through install/velvet-install.sh — that adapter only runs on
# first creation). Override for testing against a fork: VELVET_INSTALLER_URL=...
VELVET_INSTALLER_URL="${VELVET_INSTALLER_URL:-https://raw.githubusercontent.com/aroundmyroom/Velvet/main/contrib/shared/velvet-install.sh}"

header_info "$APP"
variables
color
catch_errors

# ── update path ──────────────────────────────────────────────────────────────
# This function always runs INSIDE the target container, never on the host —
# confirmed by reading the engine's own convention, not assumed: every real
# app's update_script() (e.g. community-scripts/ProxmoxVE's navidrome.sh)
# calls systemctl/etc. with no pct/incus prefix at all, and the install.func
# step that runs `customize` (which our own install/velvet-install.sh calls)
# auto-writes /usr/bin/update inside the container pointing back at this same
# ct/velvet.sh. Running `update` from inside the container, or re-running the
# host one-liner against an existing container, both end with THIS function
# executing locally in the container the engine has already placed it in — an
# earlier version of this function wrapped everything in `pct exec`/`incus
# exec`, which would have tried to run pct/incus from inside the container
# itself, where neither binary exists, and failed outright.
function update_script() {
  header_info
  check_container_storage
  check_container_resources

  if [[ ! -d /opt/velvet/.git ]]; then
    msg_error "No ${APP} installation found in this container (expected a git checkout at /opt/velvet)"
    exit
  fi
  local verbose_flag=()
  [ "${VERBOSE:-no}" = "yes" ] && verbose_flag=(--verbose)

  msg_info "Updating ${APP}"
  curl -fsSL "${VELVET_INSTALLER_URL}" -o /tmp/velvet-install.sh
  chmod +x /tmp/velvet-install.sh
  /tmp/velvet-install.sh --mode update "${verbose_flag[@]}"
  msg_ok "Updated ${APP}"
  exit
}

# ── Velvet-specific input: where does the music library live? ───────────────
# This is the one question genuinely worth asking here, not deferred to the
# admin UI: it decides what gets attached to the container at creation time
# (a bind mount, or a mount-syscall allowance for a network share), which
# can't be undone from inside the app afterward. Checked against several
# real community-scripts apps (n8n, PiHole, Immich, WG-Easy) first — none of
# them prompt for app config in ct/<app>.sh at all, which is why the admin
# account and extra-folder questions a previous version of this script asked
# here were dropped: Velvet already starts in open mode with no folders and
# everything configurable from its own admin UI afterward (the same
# experience `docker run` with no env vars gives), so there was nothing here
# that actually needed asking before the container exists, and no established
# precedent for doing so anyway. whiptail is used when available, matching
# the rest of this wizard's look; a coloured plain-text fallback covers hosts
# without it (some Incus installs don't ship whiptail by default).
_velvet_has_whiptail() { command -v whiptail >/dev/null 2>&1; }

# $1 title  $2 prompt  $3 default  $4 "yes" to mask input (password)
_velvet_ask() {
  local title="$1" prompt="$2" default="${3:-}" hidden="${4:-no}" reply=""
  if _velvet_has_whiptail; then
    if [ "$hidden" = "yes" ]; then
      reply=$(whiptail --backtitle "Velvet" --title "$title" --passwordbox "$prompt" 10 70 3>&1 1>&2 2>&3) || reply=""
    else
      reply=$(whiptail --backtitle "Velvet" --title "$title" --inputbox "$prompt" 10 70 "$default" 3>&1 1>&2 2>&3) || reply=""
    fi
  else
    if [ "$hidden" = "yes" ]; then
      read -rsp "  ${YW}${prompt}:${CL} " reply </dev/tty
      # To stderr, not stdout: this function's stdout is captured by the
      # caller via `$(...)` to get the typed value. A bare `echo` here (only
      # meant to move the cursor off the masked-input line) would otherwise
      # prepend a newline to every password captured this way — caught by
      # actually running this path with scripted input, not by reading it;
      # the exact same mistake as the one fixed above in
      # _velvet_ask_music_source, in a second place.
      echo >&2
    else
      read -rp "  ${YW}${prompt}${default:+ [$default]}:${CL} " reply </dev/tty
      reply="${reply:-$default}"
    fi
  fi
  printf '%s' "$reply"
}

_velvet_ask_music_source() {
  if _velvet_has_whiptail; then
    whiptail --backtitle "Velvet" --title "Music library" --menu \
      "Velvet needs a music folder once it's running.\n\nPick how it will be provided, or skip and set it up later from the admin UI instead (Settings -> Folders)." \
      18 72 4 \
      local "A folder already on this host (bind mount)" \
      nfs "An NFS share (server:/export/path)" \
      cifs "An SMB/CIFS share (//server/share)" \
      skip "Skip for now" \
      3>&1 1>&2 2>&3
  else
    # Everything here except the final `echo local|nfs|cifs|skip` below must
    # go to stderr: the caller captures this function's stdout with
    # `$(...)` to get the chosen tag, and `read -p`'s own prompt already
    # goes to stderr by itself — a plain `echo` does not, and a stray one
    # here would silently end up concatenated into the caller's answer
    # instead of printing to the screen. Caught by actually running this
    # path end to end, not by reading it.
    echo >&2
    echo -e "${BL}── Music library ──${CL}" >&2
    echo -e "${YW}Velvet needs a music folder once it's running. Pick how it will be provided,${CL}" >&2
    echo -e "${YW}or skip and set it up later from the admin UI instead (Settings -> Folders).${CL}" >&2
    echo "  1) A folder already on this host (bind mount)" >&2
    echo "  2) An NFS share (server:/export/path)" >&2
    echo "  3) An SMB/CIFS share (//server/share)" >&2
    echo "  4) Skip for now" >&2
    local choice=""
    read -rp "Choice [1-4, default 4]: " choice </dev/tty
    case "$choice" in
      1) echo local ;;
      2) echo nfs ;;
      3) echo cifs ;;
      *) echo skip ;;
    esac
  fi
}

MUSIC_SOURCE_TYPE="$(_velvet_ask_music_source)"
[ -z "$MUSIC_SOURCE_TYPE" ] && MUSIC_SOURCE_TYPE="skip"  # Cancel/Esc in whiptail

MUSIC_DIR_HOST=""
NFS_SERVER=""; NFS_OPTS="rw,vers=4"
CIFS_SERVER=""; CIFS_USER=""; CIFS_PASS=""; CIFS_DOMAIN=""

# Every retry loop below is capped (5 attempts for a format/existence check,
# 3 for the password confirmation) and always has a path to "skip" rather
# than looping forever. Needed in practice, not just in theory: an earlier
# version offered "/mnt/music" as BOTH the on-screen example AND the actual
# default passed to `_velvet_ask`, so leaving the prompt blank — the
# documented way to skip — silently got replaced with that default instead
# of staying blank, and when that default directory then also failed the
# `-d` existence check, the loop had no escape hatch and span forever.
# Caught by scripting the prompts and feeding them answers programmatically,
# not by reading the code. Fixed by keeping examples in the prompt text only
# and never as a substituted default for a field where blank must mean skip.
case "$MUSIC_SOURCE_TYPE" in
local)
  local_tries=0
  while :; do
    MUSIC_DIR_HOST="$(_velvet_ask "Music library — local folder" "Path on THIS HOST to bind-mount read-write into the container, e.g. /mnt/music")"
    [ -z "$MUSIC_DIR_HOST" ] && { MUSIC_SOURCE_TYPE="skip"; break; }
    [ -d "$MUSIC_DIR_HOST" ] && break
    local_tries=$((local_tries + 1))
    if [ "$local_tries" -ge 5 ]; then
      msg_error "No such directory on this host: $MUSIC_DIR_HOST — giving up, skipping the music library for now"
      MUSIC_SOURCE_TYPE="skip"
      break
    fi
    msg_error "No such directory on this host: $MUSIC_DIR_HOST — try again ($local_tries/5), or leave blank to skip"
  done
  unset local_tries
  ;;
nfs)
  local_tries=0
  while :; do
    NFS_SERVER="$(_velvet_ask "NFS share" "NFS server:/export, e.g. 192.168.1.10:/mnt/music" "")"
    [ -z "$NFS_SERVER" ] && { MUSIC_SOURCE_TYPE="skip"; break; }
    case "$NFS_SERVER" in
      *:/*) break ;;
    esac
    local_tries=$((local_tries + 1))
    if [ "$local_tries" -ge 5 ]; then
      msg_error "That still isn't server:/export — giving up, skipping the music library for now"
      MUSIC_SOURCE_TYPE="skip"
      break
    fi
    msg_error "Expected server:/export (e.g. 192.168.1.10:/mnt/music) — try again ($local_tries/5)"
  done
  unset local_tries
  [ "$MUSIC_SOURCE_TYPE" = "nfs" ] && NFS_OPTS="$(_velvet_ask "NFS mount options" "Mount options" "$NFS_OPTS")"
  [ -z "$NFS_OPTS" ] && NFS_OPTS="rw,vers=4"
  ;;
cifs)
  local_tries=0
  while :; do
    CIFS_SERVER="$(_velvet_ask "SMB/CIFS share" "Share, e.g. //192.168.1.10/Music" "")"
    [ -z "$CIFS_SERVER" ] && { MUSIC_SOURCE_TYPE="skip"; break; }
    case "$CIFS_SERVER" in
      //*/*) break ;;
    esac
    local_tries=$((local_tries + 1))
    if [ "$local_tries" -ge 5 ]; then
      msg_error "That still isn't //server/share — giving up, skipping the music library for now"
      MUSIC_SOURCE_TYPE="skip"
      break
    fi
    msg_error "Expected //server/share (e.g. //192.168.1.10/Music) — try again ($local_tries/5)"
  done
  unset local_tries
  if [ "$MUSIC_SOURCE_TYPE" = "cifs" ]; then
    CIFS_USER="$(_velvet_ask "SMB/CIFS share" "Username (leave blank for guest access)" "")"
    if [ -n "$CIFS_USER" ]; then
      # Confirmed by re-entry, not echoed back — the thing a previous version
      # of this script was missing entirely for its (now-removed) admin
      # password prompt. Retried up to 3 times rather than silently
      # continuing with a password that doesn't match what the user meant.
      local_tries=0
      while :; do
        CIFS_PASS="$(_velvet_ask "SMB/CIFS share" "Password for ${CIFS_USER}" "" yes)"
        CIFS_PASS_CONFIRM="$(_velvet_ask "SMB/CIFS share" "Confirm password" "" yes)"
        [ "$CIFS_PASS" = "$CIFS_PASS_CONFIRM" ] && break
        local_tries=$((local_tries + 1))
        if [ "$local_tries" -ge 3 ]; then
          msg_error "Passwords kept not matching — skipping the SMB/CIFS mount, set it up later instead"
          MUSIC_SOURCE_TYPE="skip"
          break
        fi
        msg_error "Passwords did not match — try again ($local_tries/3)"
      done
      unset CIFS_PASS_CONFIRM local_tries
    fi
    [ "$MUSIC_SOURCE_TYPE" = "cifs" ] && CIFS_DOMAIN="$(_velvet_ask "SMB/CIFS share" "Domain/workgroup (optional)" "")"
  fi
  ;;
esac

# Proxmox feature flag enabling the NFS/CIFS mount syscalls inside an
# unprivileged container — read straight out of pve/backend.func
# (ALLOW_MOUNT_FS -> `mount=nfs;cifs` added to the container's own Features
# at creation time). Harmless to export when not needed; Incus ignores it
# and gets the equivalent handled explicitly after creation below, since its
# backend has no matching pre-creation hook.
case "$MUSIC_SOURCE_TYPE" in
  nfs) export ALLOW_MOUNT_FS="nfs" ;;
  cifs) export ALLOW_MOUNT_FS="cifs" ;;
esac

start
build_container
description

# ── apply the music-library choice ──────────────────────────────────────────
# Deliberately applied with our own explicit pct/incus calls after the
# container exists, rather than passed to install/velvet-install.sh as
# environment variables: PVE's lxc-attach happens to inherit this script's
# whole environment, but Incus's install-env builder only forwards a fixed
# allow-list (read straight out of incus/backend.func) that does not include
# app-specific variables — relying on that difference would work by accident
# on one backend and silently misbehave on the other.
if is_incus_lxc_backend; then
  _velvet_exec=(incus exec "$CT_NAME" --)
else
  _velvet_exec=(pct exec "$CTID" --)
fi

# Waits for the container to accept commands — needed after the Incus
# restart below (security.syscalls.intercept.* only takes effect on a
# (re)start), harmless elsewhere.
_velvet_wait_ready() {
  local tries=0
  until "${_velvet_exec[@]}" true >/dev/null 2>&1; do
    tries=$((tries + 1))
    [ "$tries" -ge 30 ] && return 1
    sleep 1
  done
}

msg_info "Applying the music-library configuration"
VELVET_ENV_FILE=""
VELVET_MOUNT_FILE=""

if [ "$MUSIC_SOURCE_TYPE" = "local" ]; then
  if is_incus_lxc_backend; then
    incus config device add "$CT_NAME" music disk source="$MUSIC_DIR_HOST" path=/music
  else
    pct set "$CTID" -mp0 "${MUSIC_DIR_HOST},mp=/music"
  fi
elif [ "$MUSIC_SOURCE_TYPE" = "nfs" ] || [ "$MUSIC_SOURCE_TYPE" = "cifs" ]; then
  if is_incus_lxc_backend; then
    # PVE got this via ALLOW_MOUNT_FS at creation time above; Incus has no
    # equivalent pre-creation hook, so it's set directly here instead.
    incus config set "$CT_NAME" security.syscalls.intercept.mount=true
    incus config set "$CT_NAME" security.syscalls.intercept.mount.allowed="$MUSIC_SOURCE_TYPE"
    incus restart "$CT_NAME"
  fi
  _velvet_wait_ready || msg_error "Container did not come back up in time — mount it manually, see docs/lxc-incus.md"

  "${_velvet_exec[@]}" mkdir -p /music /etc/velvet

  # The CIFS password is pushed as a plain data file, never interpolated
  # into a shell script that gets executed — a value containing a quote or
  # `$(...)` would otherwise be read back as shell syntax inside the
  # container. The mount-setup script below only ever references this by
  # its fixed path, never by content.
  if [ "$MUSIC_SOURCE_TYPE" = "cifs" ] && [ -n "$CIFS_USER" ]; then
    VELVET_CRED_FILE="$(mktemp)"
    chmod 600 "$VELVET_CRED_FILE"
    {
      echo "username=${CIFS_USER}"
      echo "password=${CIFS_PASS}"
      [ -n "$CIFS_DOMAIN" ] && echo "domain=${CIFS_DOMAIN}"
    } >"$VELVET_CRED_FILE"
    if is_incus_lxc_backend; then
      incus file push "$VELVET_CRED_FILE" "${CT_NAME}/etc/velvet/cifs-credentials"
    else
      pct push "$CTID" "$VELVET_CRED_FILE" /etc/velvet/cifs-credentials
    fi
    rm -f "$VELVET_CRED_FILE"
    "${_velvet_exec[@]}" chmod 600 /etc/velvet/cifs-credentials
  fi

  # The server/share strings below went through a shape check earlier
  # (server:/export, //server/share) but are not hardened against shell
  # metacharacters beyond that — an acceptable residual here since this is
  # the operator's own input into their own container, not third-party data.
  VELVET_MOUNT_FILE="$(mktemp)"
  chmod 600 "$VELVET_MOUNT_FILE"
  {
    echo '#!/usr/bin/env bash'
    echo 'set -e'
    echo 'apt-get update -qq'
    if [ "$MUSIC_SOURCE_TYPE" = "nfs" ]; then
      echo 'DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nfs-common'
      printf 'grep -q "^%s " /etc/fstab || echo "%s /music nfs %s 0 0" >> /etc/fstab\n' "$NFS_SERVER" "$NFS_SERVER" "$NFS_OPTS"
    else
      echo 'DEBIAN_FRONTEND=noninteractive apt-get install -y -qq cifs-utils'
      if [ -n "$CIFS_USER" ]; then
        printf 'grep -q "^%s " /etc/fstab || echo "%s /music cifs credentials=/etc/velvet/cifs-credentials,iocharset=utf8,vers=3.0 0 0" >> /etc/fstab\n' "$CIFS_SERVER" "$CIFS_SERVER"
      else
        printf 'grep -q "^%s " /etc/fstab || echo "%s /music cifs guest,iocharset=utf8,vers=3.0 0 0" >> /etc/fstab\n' "$CIFS_SERVER" "$CIFS_SERVER"
      fi
    fi
    echo 'mount /music'
  } >"$VELVET_MOUNT_FILE"
  chmod +x "$VELVET_MOUNT_FILE"

  if is_incus_lxc_backend; then
    incus file push "$VELVET_MOUNT_FILE" "${CT_NAME}/root/velvet-mount-setup.sh"
  else
    pct push "$CTID" "$VELVET_MOUNT_FILE" /root/velvet-mount-setup.sh
  fi
  rm -f "$VELVET_MOUNT_FILE"
  if "${_velvet_exec[@]}" bash /root/velvet-mount-setup.sh; then
    msg_ok "Mounted the ${MUSIC_SOURCE_TYPE^^} share at /music"
  else
    msg_error "Mounting the ${MUSIC_SOURCE_TYPE^^} share failed — check the output above and docs/lxc-incus.md"
  fi
  "${_velvet_exec[@]}" rm -f /root/velvet-mount-setup.sh
fi

if [ "$MUSIC_SOURCE_TYPE" != "skip" ]; then
  VELVET_ENV_FILE="$(mktemp)"
  echo "VELVET_MUSIC_DIR=/music" >"$VELVET_ENV_FILE"
  if is_incus_lxc_backend; then
    incus file push "$VELVET_ENV_FILE" "${CT_NAME}/etc/velvet.env"
  else
    pct push "$CTID" "$VELVET_ENV_FILE" /etc/velvet.env
  fi
  rm -f "$VELVET_ENV_FILE"
  "${_velvet_exec[@]}" chmod 600 /etc/velvet.env
  "${_velvet_exec[@]}" systemctl restart velvet
fi

if is_incus_lxc_backend; then
  VELVET_IP="${IP:-$(incus exec "$CT_NAME" -- hostname -I 2>/dev/null | awk '{print $1}')}"
else
  VELVET_IP="${IP:-$(pct exec "$CTID" -- hostname -I 2>/dev/null | awk '{print $1}')}"
fi
msg_ok "Applied the music-library configuration"

if [ "$MUSIC_SOURCE_TYPE" = "local" ]; then
  echo -e "${INFO}${YW}If Velvet can't read/write your library: this container is $([ "${var_unprivileged}" = "1" ] && echo unprivileged || echo privileged).${CL}"
  echo -e "${INFO}${YW}Unprivileged containers remap UIDs — see docs/lxc-incus.md#music-library-permissions.${CL}"
fi

msg_ok "Completed Successfully!\n"
echo -e "${CREATING}${GN}${APP} setup has been successfully initialized!${CL}"
echo -e "${INFO}${YW}Access it using the following URL:${CL}"
echo -e "${GATEWAY}${BGN}http://${VELVET_IP}:3000${CL}"
