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

# ── Velvet-specific inputs ──────────────────────────────────────────────────
# Not part of the generic CT wizard above, so plain prompts (same convention
# other apps in this ecosystem use for app-specific values). All optional —
# press Enter to skip; everything can be set up later from the admin UI
# instead. /dev/tty because stdin is the curl|bash pipe, not the keyboard.
# NOTE: these run even on a re-run that turns out to be an update (the engine
# decides create-vs-update inside `start`, after this point) — harmless, the
# answers are only used in the create path below, but worth knowing before
# relying on this for an unattended update.
echo
echo "Velvet setup — press Enter to skip any of these (configure later in the admin UI instead):"
read -rp "  Music library path on THIS HOST to bind-mount in read-write [skip]: " MUSIC_DIR_HOST </dev/tty
read -rp "  Create an admin account — username [skip = open mode, no login required]: " VELVET_ADMIN_USER </dev/tty
VELVET_ADMIN_PASS=""
if [ -n "$VELVET_ADMIN_USER" ]; then
  read -rsp "  Password for ${VELVET_ADMIN_USER}: " VELVET_ADMIN_PASS </dev/tty
  echo
fi
read -rp "  Add a Radio-Recordings folder too? [y/N]: " _ans </dev/tty
VELVET_ENABLE_RECORDINGS=0; [[ "$_ans" =~ ^[Yy]$ ]] && VELVET_ENABLE_RECORDINGS=1
read -rp "  Add a YouTube-downloads folder too? [y/N]: " _ans </dev/tty
VELVET_ENABLE_YOUTUBE=0; [[ "$_ans" =~ ^[Yy]$ ]] && VELVET_ENABLE_YOUTUBE=1
read -rp "  Add an Audiobooks folder too? [y/N]: " _ans </dev/tty
VELVET_ENABLE_AUDIOBOOKS=0; [[ "$_ans" =~ ^[Yy]$ ]] && VELVET_ENABLE_AUDIOBOOKS=1
unset _ans

start
build_container
description

# ── apply the Velvet-specific inputs ────────────────────────────────────────
# Deliberately NOT passed through to install/velvet-install.sh as environment
# variables: PVE's lxc-attach happens to inherit this script's whole
# environment, but Incus's install-env builder only forwards a fixed
# allow-list (read straight out of incus/backend.func) that does not include
# app-specific variables — relying on that difference would work by accident
# on one backend and silently drop admin credentials on the other. Writing
# /etc/velvet.env ourselves right here, after the container exists, works
# identically on both backends because we do it with our own explicit
# pct/incus calls instead of depending on what either exec path forwards.
msg_info "Applying Velvet-specific configuration"
VELVET_ENV_FILE="$(mktemp)"
{
  [ -n "$MUSIC_DIR_HOST" ] && echo "VELVET_MUSIC_DIR=/music"
  if [ -n "$VELVET_ADMIN_USER" ]; then
    echo "VELVET_ADMIN_USER=${VELVET_ADMIN_USER}"
    echo "VELVET_ADMIN_PASS=${VELVET_ADMIN_PASS}"
  fi
  [ "$VELVET_ENABLE_RECORDINGS" = "1" ] && echo "VELVET_ENABLE_RECORDINGS=true"
  [ "$VELVET_ENABLE_YOUTUBE" = "1" ] && echo "VELVET_ENABLE_YOUTUBE=true"
  [ "$VELVET_ENABLE_AUDIOBOOKS" = "1" ] && echo "VELVET_ENABLE_AUDIOBOOKS=true"
} >"$VELVET_ENV_FILE"

if is_incus_lxc_backend; then
  if [ -n "$MUSIC_DIR_HOST" ]; then
    incus config device add "$CT_NAME" music disk source="$MUSIC_DIR_HOST" path=/music
  fi
  if [ -s "$VELVET_ENV_FILE" ]; then
    incus file push "$VELVET_ENV_FILE" "${CT_NAME}/etc/velvet.env"
    incus exec "$CT_NAME" -- chmod 600 /etc/velvet.env
    incus exec "$CT_NAME" -- systemctl restart velvet
  fi
  VELVET_IP="${IP:-$(incus exec "$CT_NAME" -- hostname -I 2>/dev/null | awk '{print $1}')}"
else
  if [ -n "$MUSIC_DIR_HOST" ]; then
    pct set "$CTID" -mp0 "${MUSIC_DIR_HOST},mp=/music"
  fi
  if [ -s "$VELVET_ENV_FILE" ]; then
    pct push "$CTID" "$VELVET_ENV_FILE" /etc/velvet.env
    pct exec "$CTID" -- chmod 600 /etc/velvet.env
    pct exec "$CTID" -- systemctl restart velvet
  fi
  VELVET_IP="${IP:-$(pct exec "$CTID" -- hostname -I 2>/dev/null | awk '{print $1}')}"
fi
rm -f "$VELVET_ENV_FILE"
msg_ok "Applied Velvet-specific configuration"

if [ -n "$MUSIC_DIR_HOST" ]; then
  echo -e "${INFO}${YW}If Velvet can't read/write your library: this container is $([ "${var_unprivileged}" = "1" ] && echo unprivileged || echo privileged).${CL}"
  echo -e "${INFO}${YW}Unprivileged containers remap UIDs — see docs/lxc-incus.md#music-library-permissions.${CL}"
fi

msg_ok "Completed Successfully!\n"
echo -e "${CREATING}${GN}${APP} setup has been successfully initialized!${CL}"
echo -e "${INFO}${YW}Access it using the following URL:${CL}"
echo -e "${GATEWAY}${BGN}http://${VELVET_IP}:3000${CL}"
