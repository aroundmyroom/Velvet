#!/usr/bin/env bash

# Copyright (c) 2021-2026 aroundmyroom
# License: MIT | https://github.com/aroundmyroom/Velvet/raw/main/LICENSE
# Source: https://github.com/aroundmyroom/Velvet
#
# This file is fetched and executed INSIDE the new container by the
# community-scripts/core engine (community-scripts.org) — see ../ct/velvet.sh
# for how it gets here. It follows that engine's own install-script
# convention (FUNCTIONS_FILE_PATH / $STD / msg_info / motd_ssh / etc.) but
# does none of the actual Velvet install logic itself: it hands off to
# contrib/shared/velvet-install.sh, the same script a user can also run by
# hand on any plain Debian box, so there is exactly one place that logic
# lives and is tested.
#
# Deliberately NOT passed here: --music-dir / --admin-user / --admin-pass.
# Custom app inputs are not guaranteed to reach this script the same way on
# every backend this engine supports (confirmed by reading pve/backend.func
# vs incus/backend.func: PVE's lxc-attach inherits the caller's whole
# environment, Incus's install-env builder forwards only a fixed allow-list
# that does not include app-specific variables). ../ct/velvet.sh instead
# writes /etc/velvet.env directly into the container with `pct push` /
# `incus file push` right after this install finishes.
#
# --no-start, always: Velvet must not boot here, before that env file and
# any library mount exist. Reported from a real install: without this, the
# first boot happens right here with no folders configured at all, then
# ../ct/velvet.sh's later restart was relying on a *second* boot's
# first-run bootstrap to pick up the folder — one more moving part than
# necessary, and the one place it was seen not to produce a configured
# library. ../ct/velvet.sh does the one real `systemctl start velvet` once
# everything is actually in place, so first-run bootstrap only ever has to
# work once, the same as it does for a Docker container that never starts
# without its environment already set.

source /dev/stdin <<<"$FUNCTIONS_FILE_PATH"
color
verb_ip6
catch_errors
setting_up_container
network_check
update_os

VELVET_INSTALLER_URL="${VELVET_INSTALLER_URL:-https://raw.githubusercontent.com/aroundmyroom/Velvet/main/contrib/shared/velvet-install.sh}"

msg_info "Installing prerequisites"
$STD apt-get install -y --no-install-recommends git curl ca-certificates gnupg jq
msg_ok "Installed prerequisites"

msg_info "Fetching the Velvet installer"
curl -fsSL "$VELVET_INSTALLER_URL" -o /tmp/velvet-install.sh
chmod +x /tmp/velvet-install.sh
msg_ok "Fetched the Velvet installer"

VELVET_VERBOSE_FLAG=()
[ "${VERBOSE:-no}" = "yes" ] && VELVET_VERBOSE_FLAG=(--verbose)

msg_info "Installing Velvet (this runs git clone + npm ci — it can take a few minutes)"
/tmp/velvet-install.sh --mode install --no-start "${VELVET_VERBOSE_FLAG[@]}"
msg_ok "Installed Velvet (not started yet — the wizard starts it once your library is attached)"

motd_ssh
customize
cleanup_lxc
