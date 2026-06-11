# DLNA / UPnP Media Server

> **Introduced in v6.12.0-velvet** — *"Going Back to My Roots"*

Velvet can act as a **UPnP ContentDirectory MediaServer (DMS-1.50)** that advertises your
music library on the local network.  Smart TVs, AV receivers, NAS players, VLC, BubbleUPnP, and
any DLNA-certified device can discover and stream your music without installing a special app,
without an Velvet account, and without touching HTTPS or JWT tokens.

---

## A Brief History — Why DLNA Matters

In the early 2000s home NAS devices shipped with **Twonky**, **TwonkyVision**, and later **Serviio**
— dedicated DLNA servers that let any TV or AV receiver on the home network browse and play music
stored on the NAS.  The killer feature was **zero configuration on the playback device**: the TV
simply listed available servers and you pressed play.

Modern setups moved to web-based players and apps, but DLNA never died — every Samsung, LG, Sony,
and Panasonic smart TV still supports it out of the box.  AV receivers from Denon, Marantz, Yamaha,
and Pioneer all include a DLNA renderer.  The protocol (UPnP ContentDirectory 1.0 with SOAP browse
and SSDP discovery) is 20+ years old, intentionally simple, and universally understood.

Velvet v6.12.0 brings that experience back: **enable one toggle in the admin panel**, and
within seconds your music collection appears on every screen in the house.

---

## How It Works

```
┌─────────────────────────────────────────────────────────────┐
│             Velvet server                           │
│                                                             │
│  ┌──────────────────────────────────────────────────┐      │
│  │  Main HTTPS server  (port 3000)                  │      │
│  │  JWT auth · streaming · admin API                │      │
│  └──────────────────────────────────────────────────┘      │
│                                                             │
│  ┌──────────────────────────────────────────────────┐      │
│  │  DLNA HTTP server  (port 10293, plain HTTP)      │      │
│  │  SSDP advertisement · UPnP device XML            │      │
│  │  ContentDirectory SOAP control                   │      │
│  │  Static media serving per vpath (no auth)        │      │
│  └──────────────────────────────────────────────────┘      │
└─────────────────────────────────────────────────────────────┘

        multicast ssdp:alive
        ─────────────────────────────────►  Smart TV / AV receiver / VLC
        ◄─────────────────────────────────
        GET /dlna/description.xml

        POST /dlna/cd/control  (SOAP Browse)
        ◄─────────────────────────────────
        DIDL-Lite XML  (albums / songs)

        GET /media/Music/Albums/Top%20700/Ring%20My%20Bell.flac
        ──────────────────────────────────────────────────────►  stream
```

1. **SSDP multicast** — on startup the DLNA server sends `ssdp:alive` on `239.255.255.250:1900` so
   devices auto-discover Velvet.  No need to type an IP address on the TV.
2. **Device description** — devices fetch `/dlna/description.xml` to learn what services are
   offered (MediaServer:1 / ContentDirectory:1 / DMS-1.50).
3. **ContentDirectory SOAP control** — devices send `Browse` SOAP requests to `/dlna/cd/control`
   and receive DIDL-Lite XML describing the folder hierarchy.
4. **Media streaming** — the device fetches each audio file directly from `/media/<vpath>/<path>`.
   Files are served in their original format — no transcoding.  All common audio formats are
   served with correct `Content-Type` headers.
5. **Album art** — served from `/album-art/<filename>`, sourced from the Velvet art cache.

The DLNA server runs **completely independently** from the main Velvet HTTPS server.  Plain HTTP
is required because DLNA devices cannot handle HTTPS or JWT authentication.

---

## Enabling DLNA

1. Open **Admin panel → DLNA / UPnP** (sidebar).
2. Toggle **Enable**.
3. Status badge changes to **● Running** within one second.
4. On your TV / AV receiver, open the media-source or network-audio list and look for
   **Velvet** (or whatever name you set).

The setting is saved in `save/conf/default.json` under the `dlna` key.

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
| **HTTP Port** | `10293` | Port the plain-HTTP DLNA server listens on.  After changing the port, toggle off → on to apply. |
| **Server Name** | `Velvet` | Friendly name shown on the TV's source list and in device scanners |

### config file representation

```json
"dlna": {
  "enabled": false,
  "port": 10293,
  "name": "Velvet"
}
```

---

## Browse Hierarchy

The DLNA server exposes a **full folder-tree** mirroring your filesystem — exactly as you would see it in a
classic NAS DLNA server.  Songs are **never** grouped by ID3 album tag; the folder name is the album.

```
Root  (id=0)
├── Albums  ←  one container per albumsOnly vpath
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
└── Disco   ←  second albumsOnly vpath (if configured)
    └── …
```

### Which folders appear?

Only folders from vpaths marked `albumsOnly: true` in the config are exposed.  This is the same
set used by the **Album Library** in the player UI — so whatever you see in the Albums screen is
exactly what DLNA devices see.  The 130,000+ random files in non-album folders are never visible.

To mark a folder as `albumsOnly`, set it in **Admin → Directory Flags** or edit `default.json`.

### Sub-folders (series / CD sets)

The browse is **unlimited depth** — a folder like `Disconet/Vol 3/Side A/` is browseable one
level at a time, just like a file manager.  DLNA clients that show a tree (BubbleUPnP, VLC) will
show the full hierarchy.

---

## Supported SOAP / UPnP Actions

| Action | Status | Notes |
|--------|--------|-------|
| `Browse BrowseDirectChildren` | ✅ Full | Pagination (`StartingIndex`, `RequestedCount`) respected |
| `Browse BrowseMetadata` | ✅ Full | Returns container or item metadata |
| `GetSystemUpdateID` | ✅ | Returns static `1` |
| `GetSearchCapabilities` | ✅ | Returns empty (no Search support) |
| `GetSortCapabilities` | ✅ | Returns empty |
| `SUBSCRIBE` / `UNSUBSCRIBE` | Stub | Accepted, not tracked (read-only server, no real eventing needed) |
| `Search` | ❌ | Not implemented |

---

## Comparison: Velvet DLNA vs Classic NAS DLNA Servers

| Feature | Velvet DLNA | Twonky (classic NAS) | Serviio | ReadyMedia (miniDLNA) |
|---------|-------------------|---------------------|---------|----------------------|
| Discovery | ✅ SSDP multicast | ✅ SSDP | ✅ SSDP | ✅ SSDP |
| Folder-tree browse | ✅ Real filesystem folders | ✅ | ✅ | ✅ |
| Transcoding | ❌ (original format only) | ✅ | ✅ | ❌ |
| Album art in browse | ✅ from art cache | ✅ | ✅ | Limited |
| albumsOnly filter | ✅ (no junk folders) | ❌ shows everything | ❌ | ❌ |
| Integrated with streaming server | ✅ shares DB & art | ❌ separate | ❌ separate | ❌ separate |
| Admin UI toggle | ✅ one click | Requires install | Requires install | Requires install |
| Auth required | ❌ LAN only (by design) | ❌ | ❌ | ❌ |
| Open-source | ✅ MIT | ❌ | ❌ | ✅ LGPL |
| Separate install | ❌ built in | Requires separate app | Requires separate app | Requires separate install |

---

## Supported Clients

| Client | Platform | Result |
|--------|----------|--------|
| **VLC** | Desktop (Windows/Linux/macOS) | ✅ SSDP discovery, full folder browse, gapless playback |
| **Samsung Smart TV** (Tizen) | TV | ✅ Discovers via SSDP, folder browse, plays FLAC/MP3/Opus |
| **LG Smart TV** (WebOS) | TV | ✅ SSDP discovery, folder browse |
| **BubbleUPnP** | Android | ✅ Full tree browse, album art, play |
| **Kodi** | All platforms | ✅ DLNA source, browse, play |
| **Windows Media Player** | Windows | ✅ Shows up as media server |
| **Foobar2000** (UPnP plugin) | Windows | ✅ Browse + stream |
| **Hi-Fi Cast** | Android | ✅ Discovers and browses |
| AV receivers (Denon / Marantz) | Hardware | ✅ Expected to work (UPnP standard) |

---

## Security

> **⚠ The DLNA port is intentionally unauthenticated.**

DLNA devices have no concept of user accounts, JWT tokens, or HTTPS.  This is a fundamental
property of the UPnP/DLNA specification — not a limitation of Velvet's implementation.

**All audio files in `albumsOnly` vpaths are accessible without any login** to anyone who can
reach port 10293.

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

Returns current DLNA configuration and running state.  Requires admin JWT.

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

Update one or more settings.  Changes take effect **immediately** — no restart needed.
Passing `enabled: true` starts the server; `enabled: false` stops it.

**Request body** (any subset):
```json
{ "enabled": true }
{ "port": 10293, "name": "Living Room Music" }
{ "enabled": false }
```

**Response:**
```json
{ "running": true }
```

---

## DLNA HTTP Server Endpoints

These endpoints are served on the dedicated DLNA HTTP port (default 10293) with **no authentication**.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/dlna/description.xml` | UPnP root device descriptor (required by all DLNA devices on discovery) |
| `GET` | `/dlna/cd.xml` | ContentDirectory:1 service descriptor — lists supported SOAP actions |
| `ALL` | `/dlna/cd/events` | SSDP event subscription stub (SUBSCRIBE accepted, not tracked) |
| `POST` | `/dlna/cd/control` | ContentDirectory SOAP control endpoint — handles `Browse`, `GetSystemUpdateID`, `GetSearchCapabilities`, `GetSortCapabilities` |
| `GET` | `/media/:vpath/*` | Audio file streaming — served via `express.static` from the vpath root |
| `GET` | `/album-art/:filename` | Album art served from the Velvet art cache directory |

### Object-ID scheme

DLNA object IDs are opaque base64url strings:

| Prefix | Represents | Example decoded |
|--------|-----------|----------------|
| `0` | Root container | — |
| `src_<b64>` | albumsOnly source (vpath name) | `src_QWxidW1z` → `Albums` |
| `dir_<b64>` | Sub-directory | `dir_...` → `Music\x00Albums/Top 700` |
| `itm_<b64>` | Audio track item | `itm_...` → `Music\x00Albums/Top 700/Ring My Bell.flac` |

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
| **Manual server entry** | Some clients (VLC: *Media → Open Network Stream*; BubbleUPnP: *Add renderer by IP*) let you enter `http://<server-ip>:10293/dlna/description.xml` directly, bypassing discovery |

### UniFi / pfSense / OPNsense

Enable **IGMP snooping** and add a multicast firewall rule to forward `239.255.255.250/32` between
the relevant VLANs.  On OPNsense install the `igmpproxy` package and configure both VLANs as
upstream/downstream interfaces.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| TV doesn't find the server | SSDP port 1900 UDP blocked, or different VLAN | Open UDP 1900 in firewall; check VLAN routing (see above); or manually enter the server IP on the TV |
| Server found but no folders | DLNA port TCP blocked | Open port 10293 in firewall |
| Folders show but songs don't play | Media port blocked, wrong IP, or VLAN routing missing | Check firewall; verify LAN IP auto-detected correctly in server logs; check VLAN routes |
| Client on different VLAN, discovery works but stream fails | Multicast proxied but unicast TCP blocked | Allow TCP 10293 from client VLAN to server VLAN in firewall |
| Only 1 album folder shown | `albumsOnly` not configured | Set `albumsOnly: true` on the desired vpaths in Admin → Directory Flags |
| Art doesn't show | Art cache not populated | Run a full scan with Discogs/embedded art enabled |
