# Network shares — Admin → Network Shares

Mount an NFS or SMB/CIFS share directly from inside Velvet, with no shell
access to the server needed. Admin-only.

## Why this exists

Two reasons, one for most users and one specifically about the Proxmox
LXC / Incus installer ([`docs/lxc-incus.md`](lxc-incus.md)):

1. **General usefulness.** Any Velvet install, Docker, bare-metal, or LXC,
   can attach a network share to its library without editing config files
   or a host's `/etc/fstab` by hand.
2. **community-scripts contribution compliance.** Checked
   [their contribution guidelines](https://community-scripts.org/docs/contribution/readme)
   directly against `contrib/lxc/ct/velvet.sh`: their review checklist
   states plainly that a platform-neutral CT script must have "no
   hand-written host commands." Our LXC wizard's NFS/SMB mounting does
   exactly that — `pct`/`incus` calls, writing the host's own `/etc/fstab`
   — which would not pass their review as-is. This feature is the fix: a
   version of `ct/velvet.sh` prepared for upstream submission can skip all
   of that and tell the admin to use this instead, after the container
   exists. **This repo's own one-liner keeps its existing automatic
   mounting** — that's a deliberate difference for our own users' quickest
   path, not an oversight: the wizard's host-side NFS/SMB mounting and this
   admin feature are independent, and either can be used on its own.

## Requirements — read this before expecting it to work

**Velvet's own process must be running as root.** Mounting a filesystem is
a privileged kernel operation no matter which user asks for it — this
isn't a permission Velvet can request or escalate to on its own behalf.
If Velvet is running as a non-root user (the default for this repo's own
LXC/Incus installer, which deliberately creates an unprivileged system
user), every attempt fails immediately with that exact explanation.

**On an unprivileged LXC or Incus container, this will never work, even as
root.** Confirmed (see [`docs/lxc-incus.md`](lxc-incus.md#music-library-permissions)):
neither NFS nor CIFS can be mounted directly inside an unprivileged
container at all — a kernel-level limitation independent of which user or
how much privilege is asking. The feature detects this exact failure
("Operation not permitted") and reports it with its own specific message
rather than a generic one, so it reads as "this container can't do this"
rather than "something went wrong."

On a **privileged** container, or a normal Docker/bare-metal install
running as root (which is common — check with `systemctl show
<yourservice> -p User` on a systemd install), this works directly.

## What it does

1. Validates the share address: `server:/export` for NFS, `//server/share`
   for SMB/CIFS.
2. Installs `nfs-common`/`cifs-utils` if not already present.
3. Creates a mount point under `save/network-mounts/<name>`.
4. For SMB/CIFS with a username, writes credentials to
   `save/conf/network-mounts/<name>-credentials` (mode 600) rather than
   ever putting them in a mount command or `/etc/fstab` directly.
5. Adds a tagged entry to `/etc/fstab` (`# velvet-network-mount:<name>`, so
   it can be found again later and *only* that entry is ever touched) and
   mounts it. NFS uses the same hardened default options
   `contrib/lxc/ct/velvet.sh` uses — `rw,vers=4,hard,rsize=131072,
   wsize=131072,timeo=600,retrans=2` — confirmed necessary, not just
   cautious; see the NFS troubleshooting note in `docs/lxc-incus.md`.
6. If the mount fails, the attempted `/etc/fstab` entry is rolled back
   automatically — nothing is left half-configured.

Once mounted, add it as a regular Velvet folder (Admin → Directories)
pointing at `save/network-mounts/<name>`, the same as any local path.

## Removing a share

Admin → Network Shares → Remove. Unmounts it, removes the `/etc/fstab`
entry, and deletes the credentials file if one exists. Any Velvet folder
still pointing at that path will simply find an empty directory until
something is mounted there again.

## API

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/v1/admin/network-mount` | Lists configured network mounts. |
| `POST` | `/api/v1/admin/network-mount` | `{ name, type: 'nfs'\|'cifs', server, username?, password?, domain?, options? }` — mounts a new share. |
| `DELETE` | `/api/v1/admin/network-mount/:name` | Unmounts and removes a configured share. |

All three are admin-only.
