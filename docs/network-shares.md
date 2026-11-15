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

On a **privileged** LXC container, or a bare-metal install running as
root (check with `systemctl show <yourservice> -p User` on a systemd
install), this works directly.

**The official Docker image is not meant for this.** Its entrypoint
normally drops from root to the `node` user before starting Velvet, so
attempts get the "not root" error; and even as root, a Docker container
cannot mount NFS/CIFS without extra privileges. Mount the share on the Docker host and pass it into
the container as a volume instead.

## What it does

1. Validates the input: the name must be lowercase letters, digits and
   hyphens (2–50 characters); the share address must be `server:/export`
   for NFS or `//server/share` for SMB/CIFS; custom mount options may only
   contain letters, digits and `= , . _ -`.
2. Refuses if a share with that name already exists, or if `/etc/fstab`
   already has a line for the same mount point.
3. Installs `nfs-common`/`cifs-utils` with `apt-get` if not already present
   (Debian/Ubuntu only — on other systems install it yourself).
4. Creates a mount point under `save/network-mounts/<name>` (inside the
   Velvet install folder).
5. For SMB/CIFS with a username, writes credentials to
   `save/conf/network-mounts/<name>-credentials` (mode 600) rather than
   ever putting them in a mount command or `/etc/fstab` directly.
6. Adds a tagged entry to `/etc/fstab` (`# velvet-network-mount:<name>`, so
   it can be found again later and *only* that entry is ever touched) and
   mounts it. Default options, used when you leave the options field empty:
   - NFS: `rw,vers=4,hard,rsize=131072,wsize=131072,timeo=600,retrans=2`,
     the same as `contrib/lxc/ct/velvet.sh` — confirmed necessary, not just
     cautious; see the "Offset is outside the bounds of the DataView" row
     under Troubleshooting in [`docs/lxc-incus.md`](lxc-incus.md#troubleshooting).
   - SMB/CIFS: `credentials=<file>,iocharset=utf8,vers=3.0`, or
     `guest,iocharset=utf8,vers=3.0` without a username.
7. If the mount fails, the `/etc/fstab` entry and the credentials file are
   rolled back automatically — nothing is left half-configured. The error
   says whether the cause was "Operation not permitted", an unreachable
   server, rejected credentials, or something else.
8. On success the share is saved under `networkMounts` in
   `save/conf/default.json`.

Once mounted, add it as a regular Velvet folder (Admin → Directories)
pointing at `save/network-mounts/<name>`, the same as any local path.

## Removing a share

Admin → Network Shares → Remove. Unmounts it, removes the `/etc/fstab`
entry, deletes the credentials file if one exists, and removes it from the
config. If the unmount fails, the entry is removed anyway (the failure is
logged). Any Velvet folder
still pointing at that path will simply find an empty directory until
something is mounted there again.

## API

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/v1/admin/network-mount` | Lists configured network mounts: an object keyed by name, each `{ type, server, mountPoint, options, hasCredentials }`. |
| `POST` | `/api/v1/admin/network-mount` | `{ name, type: 'nfs'\|'cifs', server, options? }`; CIFS also takes `username?, password?, domain?`. Mounts a new share and returns `{ name, type, server, mountPoint, options, hasCredentials }`. Returns `409 { error: 'not-root' }` when Velvet is not running as root. |
| `DELETE` | `/api/v1/admin/network-mount/:name` | Unmounts and removes a configured share; `404` if the name is unknown. |

All three are admin-only.
