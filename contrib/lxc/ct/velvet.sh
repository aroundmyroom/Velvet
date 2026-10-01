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
# Local-first, curl fallback — matches community-scripts' own contribution
# template exactly (their code-audit checklist checks for this pattern by
# name). A sibling `core` checkout next to this file's own directory is
# picked up automatically for fast local iteration without a push; the
# normal one-liner (no local checkout at all) falls straight through to the
# same curl this always did.
_cs_boot="${COMMUNITY_SCRIPTS_CORE_DIR:-$(dirname "${BASH_SOURCE[0]}")/../../core}/core/build.func"
# shellcheck disable=SC1090  # local dev checkout (present only when testing) or the remote engine
if ! source "$_cs_boot" 2>/dev/null; then
  source <(curl -fsSL "${COMMUNITY_SCRIPTS_CORE_URL:-https://raw.githubusercontent.com/community-scripts/core/main}/core/build.func")
fi

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

# ── override the engine's own description() ─────────────────────────────────
# Replaces it entirely rather than tweaking it: the real one (pve/backend.func)
# writes an "Open Script Page" badge to https://community-scripts.org/scripts/
# velvet, which 404s — Velvet isn't in that catalog — and a "Sponsoring &
# Donations" badge to community-scripts' own donate page, which has nothing to
# do with this project. Its GitHub/Discussions/Issues links also silently
# default to community-scripts' OWN ProxmoxVE repo unless $REPO_SLUG is set,
# which nothing here was setting — so even the one link that should have been
# correct wasn't. Reported directly: "you cannot use this in proxmox as we
# are not an official script" and "you can only show our github page." This
# replacement does exactly that: a link to this repo, nothing else. A bash
# function defined after the engine is sourced simply shadows its same-named
# one — the same mechanism already used for update_script() above.
function description() {
  if is_incus_lxc_backend; then
    IP="${IP:-$(incus exec "$CT_NAME" -- hostname -I 2>/dev/null | awk '{print $1}')}"
    incus config set "$CT_NAME" user.description \
      "Velvet LXC — github.com/aroundmyroom/Velvet (not an official community-scripts catalog entry)" \
      2>/dev/null || true
  else
    IP="${IP:-$(pct exec "$CTID" ip a s dev eth0 2>/dev/null | awk '/inet / {print $2}' | cut -d/ -f1)}"
    local desc
    desc=$(cat <<'EOF'
<div align='center'>
  <h2 style='font-size: 24px; margin: 20px 0;'>Velvet LXC</h2>
  <p style='margin: 8px 0 16px; font-size: 12px; color: #888;'>Not an official community-scripts catalog entry.</p>
  <p style='margin: 12px 0;'>
    <a href='https://github.com/aroundmyroom/Velvet' target='_blank' rel='noopener noreferrer' style='text-decoration: none; color: #00617f;'>
      github.com/aroundmyroom/Velvet
    </a>
  </p>
</div>
EOF
    )
    pct set "$CTID" -description "$desc" 2>/dev/null || true
  fi
  export IP
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
      read -rsp "  ${YW}${prompt}:${CL} " reply </dev/tty || true
      # To stderr, not stdout: this function's stdout is captured by the
      # caller via `$(...)` to get the typed value. A bare `echo` here (only
      # meant to move the cursor off the masked-input line) would otherwise
      # prepend a newline to every password captured this way — caught by
      # actually running this path with scripted input, not by reading it;
      # the exact same mistake as the one fixed above in
      # _velvet_ask_music_source, in a second place.
      echo >&2
    else
      read -rp "  ${YW}${prompt}${default:+ [$default]}:${CL} " reply </dev/tty || true
      reply="${reply:-$default}"
    fi
  fi
  printf '%s' "$reply"
}

_velvet_ask_music_source() {
  if _velvet_has_whiptail; then
    # `|| echo skip`, not left to the caller's own empty-check: whiptail
    # exits 1 on Cancel/Esc, and this engine runs under `set -Eeuo
    # pipefail` with an ERR trap — an unprotected nonzero exit here aborts
    # the whole script immediately, before the caller's fallback logic ever
    # runs. Confirmed live: a real Proxmox run crashed on exactly this,
    # cancelling the dialog, with "exit code 1 (General error)" pointing at
    # this line. `_velvet_ask()`'s whiptail calls already had the same
    # `||` guard; this menu didn't.
    whiptail --backtitle "Velvet" --title "Music library" --menu \
      "Velvet needs a music folder once it's running.\n\nPick how it will be provided, or skip and set it up later from the admin UI instead (Settings -> Folders)." \
      18 72 4 \
      local "A folder already on this host (bind mount)" \
      nfs "An NFS share (server:/export/path)" \
      cifs "An SMB/CIFS share (//server/share)" \
      skip "Skip for now" \
      3>&1 1>&2 2>&3 || echo skip
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
    read -rp "Choice [1-4, default 4]: " choice </dev/tty || true
    case "$choice" in
      1) echo local ;;
      2) echo nfs ;;
      3) echo cifs ;;
      *) echo skip ;;
    esac
  fi
}

# ── real mountability tests ──────────────────────────────────────────────────
# A format check (server:/export, //server/share) only catches typos, not an
# unreachable server, a locked-down export, or a wrong password — so each is
# followed by an actual tentative mount, on this host, right after the
# details are entered, rather than only finding out when the real mount
# happens inside the container much later. Needs nfs-common / cifs-utils on
# THIS host (the same client packages an NFS/CIFS-backed Proxmox storage
# pool would need); installed here if missing. Debian/Ubuntu only (`apt-get`)
# — on a non-Debian Incus host this fails closed with a clear message and
# the "proceed without verifying" choice below still gets you past it.
_velvet_ensure_host_pkg() {
  local bin="$1" pkg="$2"
  command -v "$bin" >/dev/null 2>&1 && return 0
  command -v apt-get >/dev/null 2>&1 || return 1
  msg_info "Installing $pkg on this host (needed to test the share)"
  apt-get update -qq >/dev/null 2>&1
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$pkg" >/dev/null 2>&1
  if command -v "$bin" >/dev/null 2>&1; then
    msg_ok "Installed $pkg on this host"
    return 0
  fi
  msg_error "Installing $pkg on this host did not succeed"
  return 1
}

# $1 = server:/export — prints msg_ok/msg_error itself, returns 0/1
_velvet_test_nfs() {
  local server="$1" tmp err rc=1
  _velvet_ensure_host_pkg mount.nfs nfs-common || return 1
  tmp="$(mktemp -d)"; err="$(mktemp)"
  if timeout 10 mount -t nfs -o ro "$server" "$tmp" >"$err" 2>&1; then
    msg_ok "NFS share mounted successfully (test mount, read-only)"
    umount "$tmp" 2>/dev/null
    rc=0
  else
    msg_error "Could not mount $server — $(tail -c 300 "$err" | tr -s ' \n' ' ')"
  fi
  rmdir "$tmp" 2>/dev/null; rm -f "$err"
  return "$rc"
}

# $1 = //server/share  $2 = credentials file, or "" for guest access
_velvet_test_cifs() {
  local server="$1" cred="$2" tmp err rc=1 opts
  _velvet_ensure_host_pkg mount.cifs cifs-utils || return 1
  tmp="$(mktemp -d)"; err="$(mktemp)"
  if [ -n "$cred" ]; then opts="ro,credentials=${cred},vers=3.0"; else opts="ro,guest,vers=3.0"; fi
  if timeout 10 mount -t cifs -o "$opts" "$server" "$tmp" >"$err" 2>&1; then
    msg_ok "SMB/CIFS share mounted successfully (test mount, read-only)"
    umount "$tmp" 2>/dev/null
    rc=0
  else
    msg_error "Could not mount $server — $(tail -c 300 "$err" | tr -s ' \n' ' ')"
  fi
  rmdir "$tmp" 2>/dev/null; rm -f "$err"
  return "$rc"
}

# After a FAILED test (not a format error — that's always just "try again"):
# retry with different details, proceed anyway without verifying (the host's
# network path may genuinely differ from the container's), or give up.
# Echoes retry|proceed|skip.
_velvet_ask_after_test_failure() {
  if _velvet_has_whiptail; then
    # Same fix as _velvet_ask_music_source above, same reason: Cancel/Esc
    # here must resolve to "skip", not crash the script under set -e.
    whiptail --backtitle "Velvet" --title "Mount test failed" --menu \
      "The test mount did not work (see the error above). What now?" 14 70 3 \
      retry "Try different details" \
      proceed "Use these details anyway, unverified" \
      skip "Skip the music library for now" \
      3>&1 1>&2 2>&3 || echo skip
  else
    echo "  r) try different details   p) use these details anyway   s) skip" >&2
    local choice=""
    read -rp "Choice [r/p/s, default r]: " choice </dev/tty || true
    case "$choice" in
      p|P) echo proceed ;;
      s|S) echo skip ;;
      *) echo retry ;;
    esac
  fi
}

# Shown once, right after NFS/SMB is chosen, before asking for any details —
# what actually happens differs by container type in a way worth knowing
# before typing a server address, not after. Confirmed by testing and
# research, not assumed: an unprivileged container (the default) cannot
# mount NFS/CIFS inside itself at all, a kernel limitation no feature flag
# changes — so this install mounts it on the host and shares it in instead,
# automatically; a privileged container mounts it inside itself directly.
_velvet_mount_consequences_notice() {
  local kind="$1" body
  body="How ${kind} gets attached depends on the container type:

- Privileged: mounted inside the container itself.
- Unprivileged (today's default): mounted on THIS host instead, then
  shared into the container the same way a local folder would be -
  automatic, nothing extra for you to do.

Either way, THIS host needs network access to the share - it's what the
next test mount checks."
  if [ "$kind" = "SMB/CIFS" ]; then
    body="${body}

The password is stored in a root-only file, never inside Velvet's own
config."
  fi
  body="${body}

Full detail: docs/lxc-incus.md#music-library-permissions"

  if _velvet_has_whiptail; then
    whiptail --backtitle "Velvet" --title "${kind} share — what to expect" --msgbox "$body" 16 72 3>&1 1>&2 2>&3 || true
  else
    echo >&2
    echo -e "${BL}── ${kind} share — what to expect ──${CL}" >&2
    echo -e "${YW}${body}${CL}" >&2
    echo >&2
  fi
}

MUSIC_SOURCE_TYPE="$(_velvet_ask_music_source)"
[ -z "$MUSIC_SOURCE_TYPE" ] && MUSIC_SOURCE_TYPE="skip"  # Cancel/Esc in whiptail

MUSIC_DIR_HOST=""
NFS_SERVER=""
# rsize/wsize/hard, not just rw,vers=4 — confirmed the hard way: identical
# Velvet version, identical music-metadata library, identical files (the
# same NFS export mounted on another server, zero scan errors there) still
# threw "Offset is outside the bounds of the DataView" on a thin mount with
# no explicit rsize/wsize. That error is the signature of a short NFS read
# handing a parser fewer bytes than it asked for, mid-way through a large
# embedded cover-art block — far more likely on a mount with no explicit
# read/write size than on one with it set, which is exactly what the
# working comparison server had. `vers=4` (not pinned to a minor version)
# so the client still auto-negotiates the highest version the NFS server
# actually offers, rather than hard-failing against an older NAS.
NFS_OPTS="rw,vers=4,hard,rsize=131072,wsize=131072,timeo=600,retrans=2"
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
  _velvet_mount_consequences_notice "NFS"
  local_tries=0
  while :; do
    NFS_SERVER="$(_velvet_ask "NFS share" "NFS server:/export, e.g. 192.168.1.10:/mnt/music" "")"
    [ -z "$NFS_SERVER" ] && { MUSIC_SOURCE_TYPE="skip"; break; }
    case "$NFS_SERVER" in
      *:/*) ;;
      *)
        local_tries=$((local_tries + 1))
        if [ "$local_tries" -ge 5 ]; then
          msg_error "That still isn't server:/export — giving up, skipping the music library for now"
          MUSIC_SOURCE_TYPE="skip"
          break
        fi
        msg_error "Expected server:/export (e.g. 192.168.1.10:/mnt/music) — try again ($local_tries/5)"
        continue
        ;;
    esac

    NFS_OPTS="$(_velvet_ask "NFS mount options" "Mount options" "$NFS_OPTS")"
    [ -z "$NFS_OPTS" ] && NFS_OPTS="rw,vers=4,hard,rsize=131072,wsize=131072,timeo=600,retrans=2"

    msg_info "Testing the NFS share (mounting it read-only, then unmounting)"
    _velvet_test_nfs "$NFS_SERVER" && break

    case "$(_velvet_ask_after_test_failure)" in
      proceed) msg_info "Proceeding without verifying — this will be attempted again when the container is created"; break ;;
      skip) MUSIC_SOURCE_TYPE="skip"; break ;;
      *) : ;;  # retry — loop again
    esac
  done
  unset local_tries
  ;;
cifs)
  _velvet_mount_consequences_notice "SMB/CIFS"
  local_tries=0
  while :; do
    CIFS_SERVER="$(_velvet_ask "SMB/CIFS share" "Share, e.g. //192.168.1.10/Music" "")"
    [ -z "$CIFS_SERVER" ] && { MUSIC_SOURCE_TYPE="skip"; break; }
    case "$CIFS_SERVER" in
      //*/*) ;;
      *)
        local_tries=$((local_tries + 1))
        if [ "$local_tries" -ge 5 ]; then
          msg_error "That still isn't //server/share — giving up, skipping the music library for now"
          MUSIC_SOURCE_TYPE="skip"
          break
        fi
        msg_error "Expected //server/share (e.g. //192.168.1.10/Music) — try again ($local_tries/5)"
        continue
        ;;
    esac

    CIFS_USER="$(_velvet_ask "SMB/CIFS share" "Username (leave blank for guest access)" "")"
    CIFS_TEST_CRED=""
    if [ -n "$CIFS_USER" ]; then
      # Confirmed by re-entry, not echoed back — the thing a previous version
      # of this script was missing entirely for its (now-removed) admin
      # password prompt. Retried up to 3 times rather than silently
      # continuing with a password that doesn't match what the user meant.
      # A separate counter from the outer loop's — reusing the same one would
      # have corrupted its count instead of this inner retry's own.
      pw_tries=0
      while :; do
        CIFS_PASS="$(_velvet_ask "SMB/CIFS share" "Password for ${CIFS_USER}" "" yes)"
        CIFS_PASS_CONFIRM="$(_velvet_ask "SMB/CIFS share" "Confirm password" "" yes)"
        [ "$CIFS_PASS" = "$CIFS_PASS_CONFIRM" ] && break
        pw_tries=$((pw_tries + 1))
        if [ "$pw_tries" -ge 3 ]; then
          msg_error "Passwords kept not matching — skipping the SMB/CIFS mount, set it up later instead"
          MUSIC_SOURCE_TYPE="skip"
          break
        fi
        msg_error "Passwords did not match — try again ($pw_tries/3)"
      done
      unset CIFS_PASS_CONFIRM pw_tries
      [ "$MUSIC_SOURCE_TYPE" != "cifs" ] && break

      CIFS_DOMAIN="$(_velvet_ask "SMB/CIFS share" "Domain/workgroup (optional)" "")"

      # Test-only credentials file — separate from, and always removed
      # before, the real one the post-creation section below writes into
      # the container; this one's only job is proving the share mounts.
      CIFS_TEST_CRED="$(mktemp)"
      chmod 600 "$CIFS_TEST_CRED"
      {
        echo "username=${CIFS_USER}"
        echo "password=${CIFS_PASS}"
        [ -n "$CIFS_DOMAIN" ] && echo "domain=${CIFS_DOMAIN}"
      } >"$CIFS_TEST_CRED"
    fi

    msg_info "Testing the SMB/CIFS share (mounting it read-only, then unmounting)"
    # `if CMD; then ...; else ...; fi`, not a bare `CMD; rc=$?` — a bare
    # failing command here would trip this engine's `set -Eeuo pipefail`
    # and abort the whole script before the next line ever captured the
    # exit code, same bug as the two whiptail calls fixed above.
    if _velvet_test_cifs "$CIFS_SERVER" "$CIFS_TEST_CRED"; then
      _velvet_test_rc=0
    else
      _velvet_test_rc=$?
    fi
    rm -f "$CIFS_TEST_CRED"
    [ "$_velvet_test_rc" -eq 0 ] && break

    case "$(_velvet_ask_after_test_failure)" in
      proceed) msg_info "Proceeding without verifying — this will be attempted again when the container is created"; break ;;
      skip) MUSIC_SOURCE_TYPE="skip"; break ;;
      *) : ;;  # retry — loop again
    esac
  done
  unset local_tries
  ;;
esac

# Proxmox feature flag enabling the NFS/CIFS mount syscalls inside an
# unprivileged container — read straight out of pve/backend.func
# (ALLOW_MOUNT_FS -> `mount=nfs;cifs` added to the container's own Features
# at creation time). Harmless to export when not needed; Incus ignores it
# and gets the equivalent handled explicitly after creation below, since its
# backend has no matching pre-creation hook.
#
# var_mount_fs is set alongside it, not just ALLOW_MOUNT_FS — reported from
# a real install: the Advanced Settings wizard's own "Mount Filesystems"
# step (ui/advanced.func) seeds its prompt from var_mount_fs, not
# ALLOW_MOUNT_FS, and — regardless of whether the admin changes it —
# unconditionally overwrites ALLOW_MOUNT_FS with whatever that step ends
# up holding once the wizard finishes. Going through Advanced Settings
# with only ALLOW_MOUNT_FS set meant the prompt showed empty and silently
# discarded the mount feature this container actually needs. Setting both
# means the prompt now shows "nfs"/"cifs" already filled in — visible
# confirmation the admin can see for themselves — and survives either way,
# whether they accept it as shown or go through Default Settings and never
# see that screen at all.
# msg_info starts an animated spinner that only msg_ok/msg_error stops —
# confirmed from the engine's own core.func. A bare msg_info with no
# matching stop before the next call reaching for the real terminal (here,
# `start`'s whiptail dialog a few lines down) leaves that spinner running
# forever, fighting whiptail for the screen — reported live: the install
# froze right after this message, unresponsive to Ctrl-C, only killable
# with Ctrl-D. Every other msg_info in this file already has a matching
# msg_ok/msg_error; these two didn't.
case "$MUSIC_SOURCE_TYPE" in
  nfs)
    export ALLOW_MOUNT_FS="nfs" var_mount_fs="nfs"
    msg_info "Enabling NFS mount support on this container (mount=nfs)"
    msg_ok "NFS mount support enabled on this container (mount=nfs)"
    ;;
  cifs)
    export ALLOW_MOUNT_FS="cifs" var_mount_fs="cifs"
    msg_info "Enabling SMB/CIFS mount support on this container (mount=cifs)"
    msg_ok "SMB/CIFS mount support enabled on this container (mount=cifs)"
    ;;
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

# Reported live: an unprivileged container (the default) refused the NFS
# mount with "Operation not permitted" even with mount=nfs enabled;
# privileged worked. Confirmed by research, not a guess: NFS and CIFS
# cannot be mounted directly inside an unprivileged container at all — the
# kernel's own client code for both has no user-namespace support, which is
# independent of AppArmor or the mount= feature flag. The feature flag only
# gets you past AppArmor; it was never going to be sufficient on its own.
# The correct fix, confirmed consistently across multiple independent
# sources: mount the share on the Proxmox/Incus HOST instead, then give the
# container the same kind of bind mount the "local folder" option already
# uses — which is exactly what this does, by mounting on the host and then
# falling through into that existing local-mount code path unchanged.
VELVET_PRIVILEGED=0
[ "${CT_TYPE:-${var_unprivileged:-1}}" = "0" ] && VELVET_PRIVILEGED=1

if { [ "$MUSIC_SOURCE_TYPE" = "nfs" ] || [ "$MUSIC_SOURCE_TYPE" = "cifs" ]; } && [ "$VELVET_PRIVILEGED" != "1" ]; then
  msg_info "Unprivileged container: mounting the ${MUSIC_SOURCE_TYPE^^} share on the host instead, then attaching it the same way a local folder would be"
  VELVET_HOST_ID="${CTID:-$CT_NAME}"
  if [ "$MUSIC_SOURCE_TYPE" = "nfs" ]; then
    _velvet_host_pkg_bin=mount.nfs; _velvet_host_pkg_name=nfs-common
  else
    _velvet_host_pkg_bin=mount.cifs; _velvet_host_pkg_name=cifs-utils
  fi
  if _velvet_ensure_host_pkg "$_velvet_host_pkg_bin" "$_velvet_host_pkg_name"; then
    VELVET_HOST_MOUNT_DIR="/mnt/velvet-${VELVET_HOST_ID}"
    mkdir -p "$VELVET_HOST_MOUNT_DIR"
    VELVET_HOST_CRED_FILE=""
    if [ "$MUSIC_SOURCE_TYPE" = "cifs" ] && [ -n "$CIFS_USER" ]; then
      VELVET_HOST_CRED_FILE="/etc/velvet/cifs-credentials-${VELVET_HOST_ID}"
      install -d -m 700 /etc/velvet
      {
        echo "username=${CIFS_USER}"
        echo "password=${CIFS_PASS}"
        [ -n "$CIFS_DOMAIN" ] && echo "domain=${CIFS_DOMAIN}"
      } >"$VELVET_HOST_CRED_FILE"
      chmod 600 "$VELVET_HOST_CRED_FILE"
    fi
    if [ "$MUSIC_SOURCE_TYPE" = "nfs" ]; then
      VELVET_FSTAB_LINE="${NFS_SERVER} ${VELVET_HOST_MOUNT_DIR} nfs ${NFS_OPTS} 0 0"
    else
      # uid/gid=100000: Proxmox's default base UID for the first unprivileged
      # container's user-namespace mapping, so files the container's own
      # `velvet` user (UID 0 inside, 100000 on the host) writes are owned by
      # that mapped UID rather than root. A container using a non-default
      # idmap needs this adjusted by hand — see docs/lxc-incus.md.
      if [ -n "$VELVET_HOST_CRED_FILE" ]; then
        VELVET_CIFS_OPTS="credentials=${VELVET_HOST_CRED_FILE},uid=100000,gid=100000,iocharset=utf8,vers=3.0"
      else
        VELVET_CIFS_OPTS="guest,uid=100000,gid=100000,iocharset=utf8,vers=3.0"
      fi
      VELVET_FSTAB_LINE="${CIFS_SERVER} ${VELVET_HOST_MOUNT_DIR} cifs ${VELVET_CIFS_OPTS} 0 0"
    fi
    grep -qF " ${VELVET_HOST_MOUNT_DIR} " /etc/fstab 2>/dev/null || echo "$VELVET_FSTAB_LINE" >>/etc/fstab

    VELVET_HOST_MOUNT_ERR="$(mktemp)"
    if mount "$VELVET_HOST_MOUNT_DIR" >"$VELVET_HOST_MOUNT_ERR" 2>&1; then
      msg_ok "Mounted the ${MUSIC_SOURCE_TYPE^^} share on the host at ${VELVET_HOST_MOUNT_DIR}"
      MUSIC_SOURCE_TYPE="local"
      MUSIC_DIR_HOST="$VELVET_HOST_MOUNT_DIR"
    else
      msg_error "Could not mount on the host — $(tail -c 300 "$VELVET_HOST_MOUNT_ERR" | tr -s ' \n' ' ')"
      MUSIC_SOURCE_TYPE="skip"
    fi
    rm -f "$VELVET_HOST_MOUNT_ERR"
  else
    msg_error "Could not install ${_velvet_host_pkg_name} on the host — can't set up ${MUSIC_SOURCE_TYPE^^} for an unprivileged container"
    MUSIC_SOURCE_TYPE="skip"
  fi
fi

if [ "$MUSIC_SOURCE_TYPE" = "local" ]; then
  if is_incus_lxc_backend; then
    incus config device add "$CT_NAME" music disk source="$MUSIC_DIR_HOST" path=/music
  else
    pct set "$CTID" -mp0 "${MUSIC_DIR_HOST},mp=/music"
  fi
elif [ "$MUSIC_SOURCE_TYPE" = "nfs" ] || [ "$MUSIC_SOURCE_TYPE" = "cifs" ]; then
  # Privileged only, by this point — unprivileged was redirected to the
  # host-mount path above. mount=nfs/cifs is reliable for a privileged
  # container, confirmed working live, so this mounts inside it directly.
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
fi

# The one and only time Velvet starts: install/velvet-install.sh installed it
# with --no-start specifically so this is it — the mount (if any) and
# /etc/velvet.env (if any) are already in place, so first-run bootstrap only
# ever has to work on this one boot, not race a second restart to catch up.
msg_info "Starting Velvet"
"${_velvet_exec[@]}" systemctl start velvet
msg_ok "Started Velvet"

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
