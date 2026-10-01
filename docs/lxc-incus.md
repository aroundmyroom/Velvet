# Running Velvet in an LXC (Proxmox VE) or Incus container

> **Status: new, needs real-hardware verification.** The install/update logic
> (`contrib/shared/velvet-install.sh`) has been exercised with `--dry-run`,
> shellchecked, and covered by an automated test. The container-creation
> wizard (`contrib/lxc/ct/velvet.sh`) has been shellchecked and read against
> the actual source of the engine it depends on, but **has not yet run
> against a real Proxmox VE or Incus host** — there is no `pct`/`incus`
> available to test it end-to-end before it reaches one. Please report back
> what happens on first real use.

Velvet can run directly inside an LXC container on Proxmox VE, or inside an
Incus container, without Docker. One command creates the container and
installs Velvet into it; the same command, re-run later, updates it.

## Quick start

On a Proxmox VE host shell, or on any host with the [`incus`
CLI](https://linuxcontainers.org/incus/docs/main/installing/) already set up
(`incus admin init` has been run once):

```shell
bash -c "$(curl -fsSL https://raw.githubusercontent.com/aroundmyroom/Velvet/main/contrib/lxc/ct/velvet.sh)"
```

This uses the [community-scripts](https://community-scripts.org) engine for
the interactive part — container ID/name, hostname, disk size, CPU, RAM,
storage pool, network/bridge, and a **default vs. advanced** settings screen
with a verbose/non-verbose toggle for the install log. It automatically
detects whether it's running on Proxmox VE or an Incus host and uses the
matching backend — the same command works on both.

After the generic container questions, it asks exactly one Velvet-specific
one — where the music library lives — since that's the only thing that has
to be decided before the container exists; everything else (admin account,
extra library folders) is already configurable from Velvet's own admin UI
after install, the same way a plain `docker run` with no options works, so
there's nothing to ask about those here. The one real question is a `whiptail`
menu matching the look of the rest of this wizard (falling back to a coloured
plain-text menu on hosts without `whiptail`):

1. **A folder already on this host** — bind-mounted read-write into the
   container at `/music`. The classic "passthrough" option.
2. **An NFS share** — `server:/export/path`, with a mount-options prompt
   (default `rw,vers=4`). Mounted *inside* the container itself, not on the
   host.
3. **An SMB/CIFS share** — `//server/share`, with a username/password
   prompt (blank username = guest access). The password is asked twice and
   must match before continuing, retried up to 3 times before falling back
   to skip; it's pushed into the container as a credentials file, never
   embedded in a command. Mounted inside the container, same as NFS.
4. **Skip for now** — leave `/music` unset; set the library up from the
   admin UI once Velvet is running.

**Options 2 and 3 are verified immediately, before the container is
created**: right after the details are entered, the wizard does a real
tentative mount — on this host, read-only, then unmounts it — not just a
format check. A format check only catches typos; this also catches an
unreachable server, an export that doesn't allow this host, or (CIFS) a
wrong password. Needs `nfs-common`/`cifs-utils` installed on *this host*
(the Proxmox/Incus machine, not the new container) — installed
automatically if missing, Debian/Ubuntu only (`apt-get`). If the test
fails, three choices: try different details, proceed anyway unverified (the
host's network path can genuinely differ from the container's — same
server, different VLAN, is a real case this covers), or skip for now.
Pressing Esc/Cancel on any of the wizard's dialogs is always treated the
same as explicitly choosing "skip" — it never aborts the installer.

Once verified (or you chose to proceed anyway), the real mount happens
inside the container after it's created: install `nfs-common`/`cifs-utils`
there too, write a standard `/etc/fstab` entry so the mount survives a
reboot, and mount it. On Proxmox this works by exporting `ALLOW_MOUNT_FS`
before the container is created, which is the engine's own mechanism for
adding the matching `mount=nfs`/`mount=cifs` container feature; on Incus
there's no equivalent pre-creation hook, so it's set directly
(`security.syscalls.intercept.mount*`) right after creation, which requires
one container restart to take effect — the wizard does this and waits for
the container to come back before mounting.

When it finishes it prints the URL: `http://<container-ip>:3000`. The admin
account and any extra library folders (Radio Recordings, YouTube downloads,
Audiobooks) are set up from there, in the admin UI, the same as any other
install method.

### Updating

Two equivalent ways, both end up running the same update inside the
container:

- **From the Proxmox/Incus host**: run the **exact same one-liner again**,
  pointed at the same container. The engine detects the existing container
  and updates it instead of creating a new one.
- **From inside the container**: the install leaves a standard
  community-scripts `update` command on the `PATH` (`/usr/bin/update`,
  written automatically by the engine during install, the same convention
  every community-scripts app container has). SSH or console in and run:
  ```shell
  update
  ```

Either way, updating fetches the latest Velvet release, checks it out, runs
`npm install` only if dependencies changed, and restarts the service — it
prefers doing this through Velvet's own [Admin → Updates](updates.md) API
(the same code path as clicking the button there) and falls back to a direct
`git`/`npm` update if the app isn't reachable yet.

## What it actually does

Two scripts, each independently useful:

- **`contrib/shared/velvet-install.sh`** — the real installer. Installs
  Node.js (via NodeSource, skipped if a compatible version is already
  present), clones Velvet at a release tag, runs `npm ci --omit=dev`, writes
  the `velvet` system user and a `systemd` unit matching the one
  [`docs/install.md`](install.md) documents for bare-metal, and enables the
  service. This script has **no dependency on Proxmox, Incus, or
  community-scripts at all** — it works on any plain Debian box, root shell,
  one command:
  ```shell
  curl -fsSL https://raw.githubusercontent.com/aroundmyroom/Velvet/main/contrib/shared/velvet-install.sh -o /tmp/velvet-install.sh
  chmod +x /tmp/velvet-install.sh
  /tmp/velvet-install.sh --mode install --music-dir /music --admin-user admin --admin-pass 'change-me'
  ```
  Run `/tmp/velvet-install.sh --help` for every flag, or add `--dry-run` to
  see exactly what it would do without changing anything. This is also the
  thing to run by hand if the container wizard's prompts don't fit your case,
  or if you just want to inspect/modify it before trusting it with root.

- **`contrib/lxc/ct/velvet.sh`** — the container-creation wizard described
  above. It creates the container via the community-scripts engine, then
  calls the script above *inside* the new container to do the actual install.
  For updates it skips straight to calling the installer's `--mode update`
  inside the existing container.

Nothing in Velvet's own application code changed for this — both scripts
reuse `cli-boot-wrapper.js`'s existing `VELVET_*` first-run bootstrap (the
same mechanism `compose.yaml` uses for Docker) and the update logic already
shipped in `src/util/self-update.js` for [Admin → Updates](updates.md).

## Music library permissions

This only applies to option 1, the local-folder bind mount — NFS and SMB/CIFS
shares are mounted by the container itself as its own user, so they don't
have this problem at all, which is one real reason to prefer a network share
over a bind mount when both are available.

A bind-mounted host directory has no separate "volume" step the way Docker
has one — the container sees the host path directly. The one thing to get
right: **unprivileged containers** (the default) remap UIDs, so root inside
the container is a high, unrelated UID on the host (via `/etc/subuid`), and
the `velvet` user inside the container will not simply see your host file
ownership the way it looks on the host.

Two supported options:

1. **Privileged container.** Simplest — no UID remapping, host ownership is
   what the container sees too. Choose "privileged" in the wizard's advanced
   settings (`var_unprivileged=0`). This is what the wizard's quick defaults
   assume.
2. **Unprivileged, with an explicit UID mapping.** More isolated, more setup:
   map the container's `velvet` UID to the host UID that owns your music
   folder (`pct set <CTID> --features ...` / Incus `raw.idmap`, see the
   [Proxmox LXC](https://pve.proxmox.com/wiki/Unprivileged_LXC_containers#Using_local_directory_bind_mount_points)
   / [Incus](https://linuxcontainers.org/incus/docs/main/userns-idmap/) docs),
   then `chown` the host folder to match once.

If Velvet can't read or write a bind-mounted library after install, this is
almost always why — check which kind of container you created, or switch to
an NFS/SMB share instead if one is available on your network.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Could not fetch install/velvet-install.sh` | The engine's `COMMUNITY_SCRIPTS_URL` didn't resolve to this repo. If you forked/copied `ct/velvet.sh`, make sure the `export COMMUNITY_SCRIPTS_URL=...` line near the top still points at a repo that has `contrib/lxc/ct/` and `contrib/lxc/install/`. |
| Update says "No Velvet installation found" | It's looking for a git checkout at `/opt/velvet` inside the container. If you installed to a different `--install-dir`, update by hand instead: `pct exec <CTID> -- /tmp/velvet-install.sh --mode update --install-dir <path>` (or `incus exec`). |
| Velvet can't see/write a bind-mounted music folder | See **Music library permissions** above — almost always the unprivileged UID remap. |
| The host-side share test fails but you know the share is fine | The host and the container can have a genuinely different network path to the same server (different VLAN, firewall rule scoped to container IPs, etc.) — choose "proceed anyway, unverified" when offered; the real mount still happens inside the container afterward. |
| The host-side test says it couldn't install `nfs-common`/`cifs-utils` | The host isn't Debian/Ubuntu (no `apt-get`) — install the matching client package yourself first, or choose "proceed anyway" to skip verification. |
| "Mounting the NFS/CIFS share failed" (inside the container, after creation) | Check `apt-get`/`mount` output printed above the error. Common causes: the NFS/CIFS service isn't reachable from the container's network, the export doesn't allow this container's IP, or (CIFS) the SMB version needs adjusting — the mount-options prompt (NFS) or a manual edit of `/etc/fstab` inside the container (CIFS, `vers=3.0` by default) covers that. |
| Node install step is skipped | `velvet-install.sh` only installs Node via NodeSource if nothing `>=22` is already present — this is intentional, not a bug, so it doesn't fight a container image that already ships a newer Node. |
| Everything else | Full log of every step is at `/var/log/velvet-installer.log` inside the container (install) or printed live with `--verbose`. |

## Manual cleanup / starting over

```shell
# inside the container
systemctl stop velvet
systemctl disable velvet
rm -f /etc/systemd/system/velvet.service /etc/velvet.env
systemctl daemon-reload
rm -rf /opt/velvet
userdel velvet

# only if you chose an NFS/SMB share
umount /music
sed -i '\#/music#d' /etc/fstab
rm -rf /etc/velvet
```

Then re-run the installer, or just destroy the container (`pct destroy
<CTID>` / `incus delete <name>`) and start over with the wizard.
