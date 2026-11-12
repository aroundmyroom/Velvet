# Velvet Rooms — play on Sendspin speakers

**Velvet Rooms** plays your library on speakers around the house, in sync.
Velvet implements the Sendspin protocol and acts as a Sendspin server: it finds
Sendspin speakers on your network, you allow or pair them in the admin page,
group them into rooms, and pick a room in the player. Velvet Rooms works with
Sendspin speakers; it is not a Sendspin product, and it is not certified by
the Open Home Foundation.

What you get:

- **Rooms.** Every speaker starts as a room of its own. Combine speakers into
  one room and they play the same music, sample-accurately in sync.
- **A queue on the server.** Once a room plays, the queue lives on the
  server. Close the browser, switch off the laptop — the room keeps playing.
- **The speaker's own controls work.** Play/pause, next, previous and volume
  buttons on the speaker control the room's queue. Speakers with a display
  show the title, artist, album and artwork; speakers that support it get a
  colour palette taken from the artwork.

The feature is off by default.

---

## What works with it

Anything that implements the Sendspin protocol as a player. Devices and
programs known to speak it:

| Device / program | Notes |
|---|---|
| **Home Assistant Voice Preview Edition** | ESPHome device. Found automatically on the network. |
| **Home Assistant Connect AUX-2** | ESPHome device. Found automatically on the network. |
| **Other ESPHome speakers** | Any ESPHome build with the Sendspin media player component. |
| **sendspin-cpp-cli** (github.com/Sendspin/sendspin-cpp-cli) | Reference player for Linux, Raspberry Pi, macOS and Windows; headless. |
| **sendspin-python-cli** (github.com/Sendspin/sendspin-python-cli) | Second reference player (`pip install sendspin`). |
| **Sendspin for Windows** (github.com/Sendspin/sendspin-windows) | Windows app. Connects to the server itself (finds it over mDNS or takes `host:8927` by hand) and pairs with a pairing token, see [Pairing with a token](#pairing-with-a-token-advanced). |

Which pairing method a device offers, whether it has buttons or a display,
and which audio formats it takes is up to the device. The admin page shows
what each one reports (manufacturer, model, software version) and only offers
what the device supports.

**Windows firewall.** Sendspin for Windows connects out to Velvet, so it needs
no inbound rule for playback. Finding the server automatically needs mDNS: when
Windows asks whether to allow the app on networks, allow it on private
networks. On a network Windows treats as *Public*, discovery is usually
blocked — enter the server address (`velvet-host:8927`) in the app instead.

Sonos speakers do not speak Sendspin. They keep using [Sonos cast](sonos.md).

---

## How it differs from Server Audio and Sonos cast

| | Velvet Rooms | [Server Audio](server-audio.md) | [Sonos cast](sonos.md) |
|---|---|---|---|
| Plays on | Sendspin speakers, any number, in sync | The server's own sound card | One Sonos room |
| Who owns the queue | **The server** (the room) | The browser | The browser |
| Browser closed | Keeps playing to the end of the queue | Stops advancing | Stops advancing |
| Speaker buttons | Control the room's queue | — | Sonos app/buttons, not the Velvet queue |
| Gapless | Yes (one continuous stream per speaker) | mpv | No (one track per cast) |

Server Audio and Sonos cast treat the output as a plain speaker: the browser
decides what plays next. A Sendspin speaker can press *next* itself, so the
queue has to live where the speaker can reach it — on the server. When you send
music to a room, the browser hands its queue over and becomes a remote for that
room.

---

## Enabling it

1. **Admin → Velvet Rooms.** Switch it on. The status shows *Running*; if it
   says *Enabled, not running*, the error below it says why (usually the port
   is in use).
2. **Server name** — the name speakers and their apps show for this server.
   Default `Velvet (<hostname>)`.
3. **Port** — TCP port speakers connect to, default **8927**. Changing it
   restarts the listener; rooms that are playing stop.
4. **Server ID** — the short form of this server's identity key. It is part of
   the backup; a new ID means every speaker has to pair again.

No Velvet restart is needed. The same settings live under `sendspin` in the
config file, see [json_config.md](json_config.md#velvet-rooms-sendspin)
(`enabled`, `name`, `port`, `bind`, `path`, `discovery`).

Who may play to rooms: admins, and users with the **Cast** permission
(*Admin → Users*) — the same permission as Server Speaker and Sonos.

---

## Network requirements

- **Same network.** Velvet and the speakers must be on the same LAN segment.
  Discovery is mDNS (multicast), which does not cross VLANs or routers unless
  you run an mDNS reflector.
- **TCP 8927** (or the port you set) inbound on the Velvet host, for speakers
  and apps that connect to the server.
- **UDP 5353** (mDNS) on the Velvet host, for discovery both ways: Velvet
  advertises itself as `_sendspin-server._tcp` and looks for speakers that
  advertise `_sendspin._tcp`. Velvet then connects to the speakers it finds.
- Discovery works over IPv4 and IPv6. Speakers that offer only IPv6 are
  reached on their global or ULA address (not link-local). For speakers to
  reach Velvet over IPv6, set the Rooms bind address to `::`.
- **Docker:** mDNS does not reach a container on the default bridge network.
  Use `network_mode: host` for discovery. Without host networking, publish
  port 8927 and point the speakers at the server by address — see
  [docker.md](docker.md#velvet-rooms-sendspin-speakers).

---

## Speakers: states and what to do

The **Speakers** card lists every speaker Velvet has seen. Each one shows its
name, manufacturer, model and software version, the first characters of its
ID, and the room it is in. If two speakers share a name, a warning says so —
compare model and ID before you allow one you do not recognise.

Every speaker has a state label. When the connection state differs from the
trust state, both are shown (for example *Offline* next to *Paired*).

| Label | Meaning | What you can do |
|---|---|---|
| **New** | Seen on the network, not trusted yet. Nothing plays on it. | **Allow this speaker** (if the speaker permits playing without pairing) or **Pair**. If it says *This speaker only plays after pairing*, pair it. |
| **Allowed** | Allowed to play without pairing. | Play to it. **Pair** to upgrade to a trusted connection, or **Revoke** to take the permission back. |
| **Paired** | Paired: the speaker and Velvet have a shared secret. | Play to it. **Unpair** when you no longer want it. |
| **Pairing…** | A pairing attempt is running. | Finish it in the pairing box, or **Show pairing** to reopen it, or **Cancel pairing**. |
| **Not recognised** | The speaker no longer accepts this server's pairing. Usually it was reset to factory settings, or it dropped the pairing to make room for another server. Nothing plays on it. | **Pair again**. Velvet never falls back silently to unpaired play. |
| **Playing from another server** | Available, but another Sendspin server is using it. Velvet does not take it back on its own. | **Connect** to take it back. |
| **In use elsewhere** | The speaker is busy with another source (for example a TV input). It waits in a room of its own. | Nothing; when it is free, move it back to its room (Rooms card, or the speaker's own switch button). Velvet never pulls it back automatically. |
| **Offline** | Not connected. *Last seen* tells you when it was. | Switch it on. **Connect** tries to reach it now. |

Every speaker also has **Rename** (never interrupts playback) and **Forget**.
*Forget* removes the pairing, the permission, its name and its place in rooms —
use it when you sell or give away a speaker. A forgotten speaker that is still
on the network shows up again as *New*.

When Velvet is not playing on a speaker, it releases it, so another server (a
Music Assistant install, a second Velvet) can use it in the meantime.

---

## Allow or pair?

Every connection between Velvet and a speaker is encrypted, paired or not.
The difference is who can prove who they are:

- **Allowed (not paired):** encrypted, but not authenticated. Neither side can
  be sure the other is the device it claims to be. Something else on your
  network could pose as the speaker, or as a server. Fine for a home network
  you trust; it is how most people use a plain speaker.
- **Paired:** encrypted *and* authenticated. During pairing the speaker and
  Velvet agree on a secret key that only the two of them hold. From then on,
  each proves itself to the other on every connection; a device without the
  key is refused.

Allowing is one click. Pairing needs a code or a token from the speaker.

### Pairing with a code

Click **Pair**. The speaker must be online. Velvet asks the speaker for a
code; depending on the device you get:

- a **six-digit code** the speaker shows or reads out (`123-456`), or
- an **eight-digit code** printed on the speaker or in its leaflet
  (`1234-5678`), usually entered while a pairing button is held or a pairing
  window is open.

Type the code in the boxes, one digit per box (pasting the whole code works
too), and press **Pair**. Some speakers first hold the pairing back and ask you
to do something — press a button, confirm on the device. Velvet shows their
message under *"<name> says:"* as plain text; follow it.

- *That code did not match* — enter it again. After repeated wrong codes the
  button waits a few seconds (*Try again in N s*); the wait grows each time.
- *Too many wrong codes* — the speaker stopped the attempt. Start pairing on
  the speaker again.
- *Another server is pairing with this speaker right now* — wait and try again.
- The attempt is cancelled if nothing happens for 6 minutes.

When it says *Paired. The speaker now trusts this server.*, you are done.

### Pairing with a token (advanced)

Some speakers and apps pair with a **pairing token** instead of a code. In
Sendspin for Windows it is **Show Pairing Token**. Clicking **Pair** on such a
speaker opens the token section; you can also open **Pairing token (advanced)**
under the speaker list yourself.

1. Pick the speaker, or leave *Use the speaker in the token*.
2. Paste the token as shown. Spaces and the `SP:` prefix are fine; letter case
   does not matter.
3. **Pair with token.**

If the speaker is connected, pairing starts right away. If it is not, Velvet
keeps the token and the speaker pairs the next time it connects (within 24
hours). A token for a different speaker than the one you picked is refused
before anything is sent. Treat a token like a password: anyone who has it can
pair as that speaker.

### "Not recognised" after a reset

A speaker that was reset to factory settings, or that dropped this server's
pairing (speakers keep a limited number of pairings and drop the oldest), no
longer has the shared key. Velvet shows *Not recognised* and plays nothing on
it until you pair again: **Pair again** (code) or a new token. Restoring a
Velvet backup with a different server key has the same effect on every
speaker, see [Backup](#backup).

---

## Rooms

The **Rooms** card (in *Admin → Velvet Rooms*) lists every room with its state
(*Idle*, *Playing*, *Paused*, *Stopped*, *Starting…*). Users with the Cast
permission edit rooms in the player too: the **pencil** next to *Velvet Rooms*
in the output picker opens *Edit rooms* with the same actions.

- **Every speaker starts in a room of its own**, named after the speaker.
- **Combine:** under *New room*, enter a name (e.g. *Downstairs*), tick the
  speakers and **Create room**. The speakers leave their old rooms; a room they
  leave keeps playing for the others.
- **Move a speaker:** *Move to…* next to the speaker — another room, or *Its
  own room*.
- **Rename:** edit the room name in place.
- **Split up:** on a room with more than one speaker. Playback in that room
  stops and every speaker goes back to a room of its own.

A speaker belongs to exactly one room. Renaming, moving and volume changes
never interrupt the music on the other speakers; a speaker that joins a playing
room starts in sync at the current position.

---

## Playing from the player

When at least one room exists and you have the Cast permission, the **output
button** in the player bar shows a **Velvet Rooms** section next to *Browser*,
*Server Speaker* and the Sonos rooms. Rooms with more than one speaker show the
count (*Living room (3 speakers)*). A green dot means the room can play now; a
room whose speakers are all offline, untrusted or busy is greyed out.

**Pick a room.** The browser hands its queue over — the current song, its
position, and whether it was playing — pauses its own audio and shows *Playing
in <room>* in the player bar and the queue panel. From now on the player is a
**remote** for that room:

| In the player | Effect on the room |
|---|---|
| Play/pause, next, previous | Sent to the room. *Previous* restarts the song when more than 3 s in. |
| Seek bar | Seeks in the room. |
| Volume slider, mute | Room volume (all speakers move together, keeping their balance). |
| Click a song in the queue | The room jumps to it. |
| Add to queue, play next | Added to the room's queue. |
| Remove songs (one, or a selection) | Removed from the room's queue. Removing the song that plays skips to the next one. |
| Drag to reorder, move a disc, *Shuffle queue*, *Flow*, *Undo* | The room's queue follows; the song that plays is not interrupted. |
| *Clear queue* | Everything but the playing song is removed (all of it when the room has stopped). |
| Play an album, playlist, AI DJ set | The new queue is sent to the room. |
| Auto-DJ on | When the room starts its last song, the browser picks the next one and adds it — see below. |

While a room is active the queue panel shows the room's queue. Changes made
elsewhere — a speaker's buttons, another browser — show up in the player within
a second or two. If someone else changed the queue at the moment you edited it,
the player shows *The room's queue was changed elsewhere* and loads the room's
queue again; repeat your edit on that.

**Auto-DJ in a room.** Auto-DJ keeps choosing songs in the browser, with all
its settings (similar artists, BPM, genres, …). When the room starts its last
song, the browser picks the next one and adds it to the room. Two open tabs
never add twice. This only works **while a browser with that room active is
open**: close it and the room plays the rest of its queue and stops.

Reload the page while a room plays and the player reconnects as its remote.

**Take it back:** **Play in this browser** (in the player bar or queue panel),
or pick *Browser* in the output picker. The room stops and the browser
continues at the same song and position. Picking *Server Speaker* or a Sonos
room does the same, then switches to that output.

Radio stations and other streamed URLs do not play in a room: they stay in the
browser (*Radio and podcast streams play in this browser*). If the queue
contains them, they are skipped when the queue is handed over. A room queue
holds at most 10 000 songs; a longer browser queue is sent as a 10 000-song
window around the current song.

---

## What speakers can do

What a speaker offers depends on the device. Velvet supports:

- **Buttons:** play/pause, stop, next, previous, volume and mute, repeat and
  shuffle. *Play* on an idle room resumes what that room last played, also
  after a Velvet restart.
- **Switch:** a speaker with a switch button cycles through the rooms that are
  playing and back to its own room. A speaker that was moved out because it was
  in use elsewhere goes back to its previous room with one press.
- **Now playing:** title, artist, album artist, album, year, track number,
  position and duration. The next song's details go out shortly before it
  starts, so displays change on time.
- **Artwork:** the album art from Velvet's art cache, scaled to what the
  display asks for (never cropped).
- **Colours:** a palette from the artwork, checked for readable contrast.
- **Volume:** a speaker that reports volume but cannot be set from outside is
  shown read-only.

Audio goes out as FLAC, PCM (up to 24-bit) or Opus, in the format the speaker
- **Visualizer:** light rings, LED strips and displays get the music as data,
  see [Lights and visualizers](#lights-and-visualizers).
prefers. Opus is sent only to a speaker that lists it, ahead of FLAC or PCM;
it is lossy (about 128 kbit/s stereo, 64 kbit/s mono) and suits speakers on a
weak Wi-Fi link. Opus is covered by third-party patents for products that are
sold; Velvet is free software and Opus stays optional, since every speaker
also takes FLAC and PCM. Tracks join without gaps.

---

### Lights and visualizers

A device with the Sendspin *visualizer* role (a speaker with a light ring, a
display, an LED controller, the visualizer in the sendspin-python-cli TUI)
gets the music as data instead of, or next to, the audio. An LED bridge such
as one for LedFx or WLED can use it once it implements that role. Velvet
analyses each room's audio once and sends every device only what it asked for:

| Data | What it is |
|---|---|
| `loudness` | Overall loudness, A-weighted (weighted like the ear), −60 to 0 dB |
| `spectrum` | Up to 1024 bars between the frequencies the device picks, on a mel, log or linear scale |
| `f_peak` | The loudest frequency and its level (often a harmonic, not the note being played) |
| `peak` | A hit: drums, a cymbal, any sharp attack, with a strength for the flash |
| `beat` | The musical beat |

The device chooses the frame rate (up to 60 per second). Every value is
stamped with the moment its audio is heard, on the same clock as the music, so
lights flash on the beat and not when the data arrives. A device that only
shows lights (no speaker) joins a room like any speaker; pause stops its data,
a seek or skip clears what it had buffered.

Beats come from a live beat tracker on the audio. When Velvet's BPM analysis
has a tempo for the song it is used as a guide, which settles whether a song
is felt at 70 or 140 BPM; without it the tracker picks the tempo itself.
Velvet does not mark the first beat of each bar (downbeats).

---

## Line-in (source devices)

Some Sendspin devices capture audio instead of (or next to) playing it: a
turntable preamp, a speaker with an AUX input, a Bluetooth receiver, a
microphone. Velvet can play such an input in any room, in sync on every
speaker there.

**Allow it first.** A source device needs its own, explicit approval: in
**Admin → Velvet Rooms**, a device that offers line-in shows *Allow as
source*. Allowing a speaker to play, or playing on it, never allows its input:
the input is only used after you press that button, and *Stop allowing as
source* takes it back at any time. Only a paired or allowed device can be
allowed as a source. A device whose unpaired access is off (microphones should
ship that way, since anyone on the network could otherwise listen in) has to
be paired first; the device row says so.

**Playing it.** In the player's room picker, a room offers *Play line-in
from Turntable* (the device's name) for every allowed source that is
connected. The room then plays the input instead of its queue: the player bar
shows *Line-in — Turntable* with a **Line-in** badge, and *Stop line-in* (or
pause/stop on the room or on a speaker's buttons) ends it. The queue stays
where it was, paused; resume it or play something new to leave the line-in.
One input plays in one room at a time.

**Auto-switch.** A device with line sense reports when audio is present (the
needle drops, the TV goes on). With *Start when signal appears* switched on for
that source (off by default), Velvet starts the line-in in the room it last
played in when the signal appears and stops it when the signal goes. Leave it
off for an input with hum on it, which reports a signal all day.

**What you hear.**

- Latency: about half a second for PCM inputs, up to about a second for FLAC
  inputs (the decoder's own buffering), plus each speaker's buffer. Live audio
  gets no extra start-up lead and cannot be seeked.
- The device's clock never matches Velvet's exactly. Velvet measures the input's
  real rate from the audio that arrives and resamples it by a few hundred ppm at
  most, inaudibly, so the delay stays the same for hours. It never cuts the audio
  at the device's timestamps; those only anchor the start and show gaps.
- After a network hiccup the room plays a moment of silence and continues at
  the normal delay; audio that arrives late in a burst is dropped, not played
  late.
- A device that is both source and speaker in the same room does not play its
  own input while it streams (it would echo it with the room's delay); it plays
  again when the line-in stops.
- Inputs in PCM (16/24/32-bit) and FLAC are accepted, any sample rate up to
  384 kHz and up to 8 channels (the first two are used). Opus input is not
  offered.



---

## ReplayGain

Rooms apply ReplayGain on the server, before the audio is sent: from Velvet's
own measurement when there is one, otherwise from the R128 or ReplayGain tags.
When you start a room or add songs from the player, your Loudness
Normalisation settings go along (on/off, track or album mode, preamp), the same
way Server Audio uses them. Gain that would push a song's peak above full scale
is capped, so a room never clips. See [replaygain-info.md](replaygain-info.md).

---

## Current limits

- **Visualizer beats come from live analysis.** Songs with a free tempo or
  without a clear pulse get few or no beats (`peak` still fires on every hit),
  and bar starts (downbeats) are not marked.
- **Auto-DJ tops up a room only while a browser with that room open is
  running.** Auto-DJ picks songs in the browser. Close the last tab (or switch
  off the laptop) and the room plays to the end of its queue and stops.
- **Browser-only audio settings do not apply:** the equaliser and crossfade
  stay in the browser.

---

## Troubleshooting

**No speakers found.**
- Is the speaker on and on the same network (same VLAN) as Velvet?
- Firewall on the Velvet host: allow TCP 8927 and UDP 5353.
- Docker: use `network_mode: host`, or connect the speakers by address
  (`ws://velvet-host:8927/sendspin`, or `velvet-host:8927` in apps that ask
  for host and port).
- *Enabled, not running* on the admin page: read the error. `EADDRINUSE`
  means another program uses the port — choose another one.

**The speaker plays from another server.** Another Sendspin server (for
example Music Assistant) took it. Velvet does not fight over it. Click
**Connect** to take it back. The other server can take it again the same way.

**In use elsewhere.** The speaker reported it is busy with another source. It
waits in a room of its own; move it back on the Rooms card or with its switch
button when it is free.

**Not recognised.** See ["Not recognised" after a reset](#not-recognised-after-a-reset).

**A room is greyed out in the player.** None of its speakers can play right
now: they are offline, *New* (not allowed or paired), *Not recognised*, or in
use elsewhere. Check the Speakers card.

**"N songs could not be sent to the room".** Those songs are outside your
folders or no longer exist on disk; the room plays the rest.

**The player says it lost contact with the room.** After several failed
status checks the player gives up being a remote and continues in the browser.
The room itself may still be playing; pick it again in the output picker to
reconnect.

---

## Backup

Velvet's backups include the Velvet Rooms state from `save/sendspin/`:

- `server-key.json` — this server's identity key,
- `trust-store.json` — pairings and allowed speakers,
- `rooms.json` — rooms, queues and what each room last played,
- `known-devices.json` — speakers seen before.

The key and the pairings only work together; a backup holds both or neither.
**If the server key is lost — a fresh install, a deleted `save/` folder — every
speaker has to be paired again**, because the speakers trust the old key.
Restoring a backup brings the key and the pairings back together. See
[backup.md](backup.md).

---

## Privacy

Velvet Rooms runs entirely on your network. Velvet talks only to the speakers
on your LAN: audio, metadata and artwork come from your own library and art
cache. A line-in device's audio goes only to the room you start it in, and only
after you allowed that device as a source. Nothing is sent to the Open Home Foundation, Home Assistant or any other
outside service, and no account is needed.

---

## Credits and legal

Sendspin is an open protocol by the [Open Home Foundation](https://www.openhomefoundation.org/).
Velvet implements the Sendspin protocol (protocol version 1) from the
specification at github.com/Sendspin/spec, published under the Community
Specification License 1.0 — see `COMMUNITY-SPEC-LICENSE-1.0.md` and `NOTICE.md`
in the repository root.

"Sendspin" is a trademark of the Open Home Foundation. Velvet Rooms is not
affiliated with, endorsed by or certified by the Open Home Foundation.

Developer documentation: [API/rooms.md](API/rooms.md) (REST contract),
[dev/sendspin-plan.md](dev/sendspin-plan.md) (design).
