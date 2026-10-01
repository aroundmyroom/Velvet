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

After the generic container questions, it asks a few Velvet-specific ones
(press Enter to skip any of them — everything here can also be set up later
from the admin UI instead):

- **Music library path on the host**, bind-mounted read-write into the
  container at `/music`.
- **Admin username/password** — leave blank to start in open mode (no login
  required for anyone who can reach the container).
- Whether to also add a **Radio Recordings**, **YouTube downloads**, or
  **Audiobooks** folder.

When it finishes it prints the URL: `http://<container-ip>:3000`.

### Updating

Run the **exact same command again**, pointed at the same container. The
engine detects the existing container and offers to update instead of
creating a new one. Updating fetches the latest Velvet release, checks it out,
runs `npm install` only if dependencies changed, and restarts the service —
it prefers doing this through Velvet's own [Admin → Updates](updates.md) API
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

LXC and Incus containers bind-mount a host directory directly — there is no
separate "volume" step the way Docker has one. The one thing to get right:
**unprivileged containers** (the default) remap UIDs, so root inside the
container is a high, unrelated UID on the host (via `/etc/subuid`), and the
`velvet` user inside the container will not simply see your host file
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

If Velvet can't read or write your library after install, this is almost
always why — check which kind of container you created.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Could not fetch install/velvet-install.sh` | The engine's `COMMUNITY_SCRIPTS_URL` didn't resolve to this repo. If you forked/copied `ct/velvet.sh`, make sure the `export COMMUNITY_SCRIPTS_URL=...` line near the top still points at a repo that has `contrib/lxc/ct/` and `contrib/lxc/install/`. |
| Update says "No Velvet installation found" | It's looking for a git checkout at `/opt/velvet` inside the container. If you installed to a different `--install-dir`, update by hand instead: `pct exec <CTID> -- /tmp/velvet-install.sh --mode update --install-dir <path>` (or `incus exec`). |
| Velvet can't see/write the music folder | See **Music library permissions** above — almost always the unprivileged UID remap. |
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
```

Then re-run the installer, or just destroy the container (`pct destroy
<CTID>` / `incus delete <name>`) and start over with the wizard.
