# DLNA / UPnP Media Server

Velvet can act as a **UPnP ContentDirectory MediaServer (DMS-1.50)** that advertises your
music library on the local network.  Smart TVs, AV receivers, NAS players, VLC, BubbleUPnP, and
any DLNA-certified device can discover and stream your music without installing a special app,
without a Velvet account, and without touching HTTPS or JWT tokens.

---

## A Brief History — Why DLNA Matters

In the early 2000s home NAS devices shipped with **Twonky**, **TwonkyVision**, and later **Serviio**
— dedicated DLNA servers that let any TV or AV receiver on the home network browse and play music
stored on the NAS.  The killer feature was **zero configuration on the playback device**: the TV
simply listed available servers and you pressed play.

Modern setups moved to web-based players and apps, but DLNA never died — most smart TVs and
network AV receivers still support it out of the box.  The protocol (UPnP ContentDirectory 1.0
with SOAP browse and SSDP discovery) is 20+ years old, intentionally simple, and widely understood.

Velvet brings that experience back: **enable one toggle in the admin panel**, pick which folders
to share, and your music appears on every screen in the house.

---

## How It Works

```
┌─────────────────────────────────────────────────────────────┐
│             Velvet server                                   │
│                                                             │
│  ┌──────────────────────────────────────────────────┐      │
│  │  Main HTTPS server  (port 3000)                  │      │
│  │  JWT auth · streaming · admin API                │      │
│  └──────────────────────────────────────────────────┘      │
│                                                             │
│  ┌──────────────────────────────────────────────────┐      │
│  │  DLNA HTTP server  (port 10293, plain HTTP)      │      │
│  │  SSDP advertisement · UPnP device XML            │      │
│  │  ContentDirectory + ConnectionManager SOAP       │      │
│  │  Media serving per vpath (no auth)               │      │
│  └──────────────────────────────────────────────────┘      │
└─────────────────────────────────────────────────────────────┘

        multicast ssdp:alive
        ─────────────────────────────────►  Smart TV / AV receiver / VLC
        ◄─────────────────────────────────
        GET /dlna/description.xml

        POST /dlna/control/content-directory  (SOAP Browse / Search)
        ◄─────────────────────────────────
        DIDL-Lite XML  (folders / songs)

        GET /media/Music/Albums/Top%20700/Ring%20My%20Bell.flac
        ──────────────────────────────────────────────────────►  stream
```

1. **SSDP multicast** — when the DLNA server starts it advertises itself on `239.255.255.250:1900`
   (via the `@lvcabral/node-ssdp` package) as `upnp:rootdevice`, `MediaServer:1`,
   `ContentDirectory:1` and `ConnectionManager:1`, so devices auto-discover Velvet.
2. **Device description** — devices fetch `/dlna/description.xml` to learn what services are
   offered (MediaServer:1 with ContentDirectory:1 and ConnectionManager:1, DMS-1.50).
3. **ContentDirectory SOAP control** — devices send `Browse` / `Search` SOAP requests to
   `/dlna/control/content-directory` and receive DIDL-Lite XML describing the folder hierarchy.
4. **Media streaming** — the device fetches each audio file directly from `/media/<vpath>/<path>`.
   Files are served in their original format.  Supported `Content-Type`s: mp3, flac, wav, m4a/m4b,
   aac, ogg, opus, wma (anything else is sent as `audio/mpeg`).
5. **Time-seek** — if a renderer sends a `TimeSeekRange.dlna.org: npt=…` header, Velvet starts the
   stream at that position with ffmpeg: MP3 files are copied without re-encoding, every other
   format is transcoded to MP3 at 192 kbit/s.  `HEAD` requests with that header return only the
   headers, so renderers can check seek support first.
6. **Album art** — served from `/album-art/<filename>`, sourced from the Velvet art cache
   (`storage.albumArtDirectory`).

The DLNA server runs on its own plain-HTTP listener, separate from the main Velvet HTTPS server,
because DLNA devices cannot handle HTTPS or JWT authentication.  The base URL in all DIDL and
device XML is `http://<first non-loopback IPv4 address>:<port>`.

---

## Enabling DLNA

1. Open **Admin panel → DLNA / UPnP** (sidebar).
2. Click **Enable**.
3. The status badge shows **● Running** once the server has started.
4. Open **Admin → Directories** and click **DLNA/UPnP: Off** on each folder you want to share
   (it turns into **DLNA/UPnP: On**).  See [Which folders appear?](#which-folders-appear) below.
5. On your TV / AV receiver, open the media-source or network-audio list and look for
   **Velvet** (or whatever name you set).

The settings are saved in `save/conf/default.json` under the `dlna` key.  If DLNA is enabled when
Velvet boots, the server starts automatically (with one retry after 5 seconds if the port is still
busy from the previous process).

### Firewall note

If your server has a firewall (`ufw`, `iptables`, `firewalld`), make sure:

- Port **10293** (TCP) is **open on the LAN interface** — the media-streaming port.
- Port **1900** (UDP multicast) is **not blocked** — the SSDP discovery port.
- **Never expose port 10293 to the internet.** See [Security](#security) below.

---

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| **Enabled** | `false` | Toggle the DLNA server on/off live |
| **HTTP Port** | `10293` | Port the plain-HTTP DLNA server listens on (1024–65535).  After changing the port, toggle off → on to apply. |
| **Server Name** | `Velvet` | Friendly name shown on the TV's source list and in device scanners (max 64 characters) |

### config file representation

```json
"dlna": {
  "enabled": false,
  "port": 10293,
  "name": "Velvet"
}
```

There is no browse-mode setting: the tree is always the folder tree described below. An old
`browse` key left in the config file is ignored.

---

## Browse Hierarchy

The DLNA server exposes a **folder tree** mirroring your filesystem — exactly as you would see it in a
classic NAS DLNA server.  Songs are **never** grouped by ID3 album tag; the folder name is the album.

```
Root  (id=0)
├── Albums  ←  one container per DLNA-enabled vpath
│   ├── -= Top 700 =-          ←  real folder name, not an ID3 tag
│   │   ├── Ring My Bell.flac
│   │   ├── 9 to 5.flac
│   │   └── …  (everything in that folder)
│   ├── Bolero Mix 1 tm16 (Flac)
│   │   ├── Bolero Mix 1.flac
│   │   └── …
│   ├── Disconet
│   │   ├── Vol 1
│   │   │   ├── 01 Ring My Bell.flac
│   │   │   └── …
│   │   ├── Vol 2
│   │   │   └── …
│   │   └── …
│   └── …
└── Disco   ←  second DLNA-enabled vpath (if configured)
    └── …
```

Folders are sorted by name (case-insensitive).  Each folder uses the album art of the first file
inside it that has art.  Folders in an `audio-books` vpath are marked as audio books.

### Which folders appear?

Each vpath has its own **DLNA/UPnP** flag (`dlnaEnabled` in the folder config), set with the
**DLNA/UPnP: On / Off** button in **Admin → Directories**.  Only vpaths with `dlnaEnabled: true` appear
at the root.  Folders of type `recordings`, `youtube` and `excluded` can never be shared.

**Fallback:** if no folder has a `dlnaEnabled` key at all (older configs), Velvet uses the vpaths
marked `albumsOnly: true` instead.

A child vpath (one whose root is inside another vpath) is shown with its own name, but its files are
read from the parent vpath in the database, filtered by the child's sub-folder.

Folder listings are cached in memory for 5 minutes; the cache is cleared after each scan.

### Sub-folders (series / CD sets)

The browse has **unlimited depth** — a folder like `Disconet/Vol 3/Side A/` is browseable one
level at a time, just like a file manager.  DLNA clients that show a tree (BubbleUPnP, VLC) will
show the full hierarchy.

---

## Supported SOAP / UPnP Actions

### ContentDirectory

| Action | Status | Notes |
|--------|--------|-------|
| `Browse` `BrowseDirectChildren` | ✅ | Pagination (`StartingIndex`, `RequestedCount`) respected; max 5000 items per response (`RequestedCount=0` means 5000) |
| `Browse` `BrowseMetadata` | ✅ | Returns container or item metadata |
| `Search` | ✅ | See [Search](#search) |
| `GetSystemUpdateID` | ✅ | Starts at `1` and goes up by one after every finished scan |
| `GetSearchCapabilities` | ✅ | `dc:title,dc:creator,upnp:artist,upnp:album,upnp:genre,upnp:class,upnp:originalTrackNumber` |
| `GetSortCapabilities` | ✅ | `±dc:title`, `±dc:creator`, `±upnp:artist`, `±upnp:album`, `±upnp:genre`, `±upnp:originalTrackNumber`, `±dc:date` |
| `X_GetFeatureList` | ✅ | Samsung `BASICVIEW` feature list |

### ConnectionManager

| Action | Notes |
|--------|-------|
| `GetProtocolInfo` | Lists the source formats (MP3, FLAC, AAC, OGG, Opus, WAV); sink is empty |
| `GetCurrentConnectionIDs` | Always `0` |
| `GetCurrentConnectionInfo` | Static answer (`Direction=Output`, `Status=OK`) |

### Eventing (GENA)

`SUBSCRIBE` / `UNSUBSCRIBE` on `/dlna/events/content-directory` are real subscriptions: each subscriber
gets an SID, a timeout (default and maximum 1800 s, renewable), an initial event, and a `NOTIFY` with the new
`SystemUpdateID` after every scan.  At most 256 subscribers are kept (the oldest is dropped).
The callback URL must be `http://` on the subscribing device's own IP address; any other callback is
refused with `412`, so events never go to a host the subscriber picked.
The ConnectionManager event URL accepts `SUBSCRIBE` but never sends events.

### Search

`Search` filters tracks in memory.  Supported properties: `dc:title`, `dc:creator`, `upnp:artist`,
`upnp:album`, `upnp:genre`, `upnp:originalTrackNumber`, `upnp:class`.  Supported operators: `=`, `!=`,
`contains`, `doesNotContain`, `startsWith`, `exists`, `derivedfrom`, combined with `and` / `or`.
`SearchCriteria="*"` returns everything.  `SortCriteria` is applied; the default sort is by title.

Search only covers the DLNA-enabled folders: the whole tree for `ContainerID=0`, one folder for a
`src_…` or `dir_…` container. `BrowseMetadata` on a track outside those folders answers
`701 No Such Object`.

---

## Comparison: Velvet DLNA vs Classic NAS DLNA Servers

| Feature | Velvet DLNA | Twonky (classic NAS) | Serviio | ReadyMedia (miniDLNA) |
|---------|-------------------|---------------------|---------|----------------------|
| Discovery | ✅ SSDP multicast | ✅ SSDP | ✅ SSDP | ✅ SSDP |
| Folder-tree browse | ✅ Real filesystem folders | ✅ | ✅ | ✅ |
| Transcoding | Only for time-seek (to MP3) | ✅ | ✅ | ❌ |
| Album art in browse | ✅ from art cache | ✅ | ✅ | Limited |
| Per-folder sharing | ✅ DLNA flag per vpath | — | — | — |
| Integrated with streaming server | ✅ shares DB & art | ❌ separate | ❌ separate | ❌ separate |
| Admin UI toggle | ✅ one click | Requires install | Requires install | Requires install |
| Auth required | ❌ LAN only (by design) | ❌ | ❌ | ❌ |
| Open-source | ✅ GPL-3.0 | ❌ | ❌ | ✅ GPL |
| Separate install | ❌ built in | Requires separate app | Requires separate app | Requires separate install |

---

## Supported Clients

Any client that speaks UPnP ContentDirectory should work: for example VLC, Kodi, BubbleUPnP,
Foobar2000 (UPnP plugin), Windows Media Player, smart TVs (Samsung, LG) and network AV receivers.
The device XML includes Samsung-specific fields (`sec:X_ProductCap`, `X_GetFeatureList`) for
Samsung TVs.

---

## Security

> **⚠ The DLNA port is intentionally unauthenticated.**

DLNA devices have no concept of user accounts, JWT tokens, or HTTPS.  This is a fundamental
property of the UPnP/DLNA specification — not a limitation of Velvet's implementation.

Anyone who can reach port 10293 can, without any login:

- browse and search the DLNA-enabled folders,
- **download any file in those folders** at `/media/<vpath>/<path>` if they know or guess the path.
  Paths are checked to stay inside the vpath root, and a file outside the DLNA-enabled folders
  answers `404`.
- fetch cached covers under `/album-art/`.

### What to do

- Only enable DLNA if you are on a **trusted private LAN** (home network).
- **Never port-forward port 10293** (or your custom port) to the internet.
- If you run Velvet on a VPS or a machine with a public IP, **do not enable DLNA**.
- Firewall rule to allow LAN only (example `ufw`):
  ```shell
  ufw allow from 192.168.0.0/16 to any port 10293
  ufw deny 10293
  ```

---

## Admin API

### `GET /api/v1/admin/dlna/config`

Returns current DLNA configuration and running state.  Requires an admin JWT (403 otherwise).

**Response:**
```json
{
  "enabled": true,
  "port": 10293,
  "name": "Velvet",
  "running": true
}
```

| Field | Type | Description |
|-------|------|-------------|
| `enabled` | boolean | Whether DLNA is configured to start |
| `port` | number | HTTP port the DLNA server listens on |
| `name` | string | Friendly name shown on TV source lists |
| `running` | boolean | Whether the DLNA server is currently active |

---

### `POST /api/v1/admin/dlna/config`

Update one or more settings (at least one field is required).  Requires an admin JWT.
The values are saved to the config file right away.  Passing `enabled: true` starts the server;
`enabled: false` stops it.  A new `port` or `name` takes effect the next time the server starts
(toggle off → on).

**Request body** (any subset):
```json
{ "enabled": true }
{ "port": 10293, "name": "Living Room Music" }
{ "enabled": false }
```

| Field | Type | Rules |
|-------|------|-------|
| `enabled` | boolean | |
| `port` | integer | 1024–65535 |
| `name` | string | max 64 characters, may be empty |

Any other field (such as the old `browse`) answers `400`.

**Response:**
```json
{ "running": true }
```

### Per-folder flag

`PATCH /api/v1/admin/directory/flags` (admin) with `{ "vpath": "Music", "dlnaEnabled": true }` turns DLNA on or
off for one folder (see [admin_directory-flags](API/admin_directory-flags.md)).

---

## DLNA HTTP Server Endpoints

These endpoints are served on the dedicated DLNA HTTP port (default 10293) with **no authentication**.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/dlna/description.xml` | UPnP root device descriptor (fetched by devices on discovery) |
| `GET` | `/dlna/scpd/content-directory.xml` | ContentDirectory:1 service descriptor |
| `GET` | `/dlna/scpd/connection-manager.xml` | ConnectionManager:1 service descriptor |
| `POST` | `/dlna/control/content-directory` | ContentDirectory SOAP control — `Browse`, `Search`, `GetSystemUpdateID`, `GetSearchCapabilities`, `GetSortCapabilities`, `X_GetFeatureList` |
| `POST` | `/dlna/control/connection-manager` | ConnectionManager SOAP control — `GetProtocolInfo`, `GetCurrentConnectionIDs`, `GetCurrentConnectionInfo` |
| `SUBSCRIBE` / `UNSUBSCRIBE` | `/dlna/events/content-directory` | GENA event subscription |
| `SUBSCRIBE` | `/dlna/events/connection-manager` | GENA stub (no events) |
| `GET` / `HEAD` | `/media/<vpath>/<path>` | Audio file streaming (with time-seek support); only files in DLNA-enabled folders, `404` otherwise |
| `GET` | `/album-art/<filename>` | Album art from the Velvet art cache directory |

SOAP bodies are limited to 512 KB.

### Object-ID scheme

DLNA object IDs are opaque base64url strings:

| Prefix | Represents | Example decoded |
|--------|-----------|----------------|
| `0` | Root container | — |
| `src_<b64>` | DLNA-enabled source (vpath name) | `src_QWxidW1z` → `Albums` |
| `dir_<b64>` | Sub-directory | `dir_...` → `Music\x00Albums/Top 700` |
| `track-<b64>` | Audio track item | `track-...` → `Music\x00Albums/Top 700/Ring My Bell.flac` |

---

## VLANs and network segmentation

DLNA/UPnP relies on **IP multicast** for discovery, which does **not cross VLAN boundaries** by default.
If your server and your playback devices (TV, phone running VLC, AV receiver) are on different VLANs,
you will hit two problems:

1. **Discovery fails silently** — the `ssdp:alive` multicast (`239.255.255.250:1900`) is sent on the
   server's VLAN and never arrives on the client's VLAN.  The device sees no Velvet in its source list.
2. **Browse or playback fails** — even if you manually point a client at the server IP, media streams
   on port 10293 must be reachable from the client's VLAN.

### Solutions

| Option | How |
|--------|-----|
| **Put server and clients on the same VLAN** | Simplest fix — no special network config required |
| **Inter-VLAN routing** | Enable routing between VLANs on your router/firewall and add a firewall rule allowing TCP 10293 and UDP 1900 from the client VLAN to the server VLAN |
| **IGMP proxy / multicast routing** | Configure your router to proxy SSDP multicast between VLANs (supported by pfSense, OPNsense, UniFi) — allows discovery without full inter-VLAN routing |
| **Manual server entry** | Some clients let you enter `http://<server-ip>:10293/dlna/description.xml` directly, bypassing discovery |

### UniFi / pfSense / OPNsense

Enable **IGMP snooping** and add a multicast firewall rule to forward `239.255.255.250/32` between
the relevant VLANs.  On OPNsense install the `igmpproxy` package and configure both VLANs as
upstream/downstream interfaces.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| TV doesn't find the server | SSDP port 1900 UDP blocked, or different VLAN | Open UDP 1900 in firewall; check VLAN routing (see above); or manually enter the server IP on the TV |
| Server found but no folders | DLNA port TCP blocked, or no folder has DLNA turned on | Open port 10293 in firewall; turn on **DLNA/UPnP** for a folder in Admin → Directories |
| Folders show but songs don't play | Media port blocked, wrong IP, or VLAN routing missing | Check firewall; check the `[DLNA] started → http://<ip>:<port>/…` line in the server log shows the right LAN IP; check VLAN routes |
| Client on different VLAN, discovery works but stream fails | Multicast proxied but unicast TCP blocked | Allow TCP 10293 from client VLAN to server VLAN in firewall |
| Wrong folders shown | DLNA flag set on the wrong vpaths | Change the **DLNA/UPnP** buttons in Admin → Directories |
| Art doesn't show | Art cache not populated | Run a scan so embedded/folder art is cached |
