# Playing Now

The Playing Now view (left nav → Now Playing → Playing Now) shows the current song large: cover, title, artist,
album, rating, technical details, artist information, similar artists and track info.

## Lyrics and Visualizer

Under the cover sit two buttons, **Lyrics** and **Visualizer**. Nothing extra shows until you press one: a panel
then opens under the technical details (format, bitrate, BPM). Press the same button again, or the × in the panel,
to close it; press the other button to switch. The panel closes when you leave Playing Now, and stays open from song
to song while you stay.

- **Lyrics** come from Velvet's lyrics lookup (`GET /api/v1/lyrics`, the same as the visualizer's lyric mode).
  Synced lyrics scroll with the song, with the current line large and lit; unsynced lyrics show as a list you can
  scroll.
- **Visualizer** is Velvet's own visualizer moved into the panel: Milkdrop, Spectrum, AudioMotion or VoltViz, with
  its usual controls on hover. Esc closes it, as it does elsewhere.

Each panel has a **full screen** button. Full screen fills the screen (the browser's fullscreen when it allows it)
with the song in the bottom corner; lyrics are shown large over the blurred cover. Esc or the same button brings you
back to the panel. Full screen stays on across song changes.

## The record behind the cover

A vinyl record, a CD or a cassette sits behind the cover. While audio plays it slides out to the right and turns
(vinyl at 33⅓ rpm). On pause it stops and slides back in. When the song changes it goes into the sleeve and comes
out again with the new cover as its label. With reduced motion turned on in the operating system, nothing moves.

The cover is used as the label: the centre label of the record, the print on the CD, or the sticker on the tape.

Live radio, podcasts and audiobooks keep the plain cover. The small cover in the player bar never gets a record.

### Choosing the type

User Settings → Playing Now → **Record**:

| Choice | Result |
|---|---|
| Auto (default) | Velvet picks per song, see below |
| Vinyl | Always a record |
| CD | Always a CD |
| Tape | Always a cassette |
| Cover only | No record, just the cover |

You can also click the cover in Playing Now (or press Enter on it) to step through Auto → Vinyl → CD → Tape →
Cover only. A short message shows the new choice, and it is saved like the setting.

The choice is saved with your other user settings and follows you to other browsers (pref `record`, see
[localstorage.md](localstorage.md)).

### How Auto decides

Auto runs in the player and uses what it already knows about each song: the folder path, the year, the length and
the type of library. Nothing is stored or scanned. The first rule that matches wins:

1. **Tape** for a song in a library of type Recordings or YouTube.
2. **CD** for a CD single: `CDM` or `CDS` in a folder name or the album tag, written any way: `(CDM)`,
   `[CDM]`, `_CDM_`, `CDM-1995`. This wins over a 12-inch folder and over a mix word in the folder name.
   A catalogue number such as `CDS 2334` or `CDS-2229` does not count.
3. **Tape** when a folder name says it holds mixes: `Megamixes`, `Mixed by`, `Mix Club`, `Mixen`, `Jaarmix`,
   `Mastermix`, `In the Mix`, `DJ Mix`, `Continuous Mix`, `Full Set`, `Live Set`, `Radio Show`, `The Tapes`,
   or the album tag says `Mixed by`, `Mix Cut`, `Continuous Mix` or `DJ Mix`.
4. **Tape** for anything of 30 minutes or longer (a mix or a live set), and for a file of 10 minutes or longer
   called a megamix, DJ mix or full set. "Radio Mix" or "Club Mix" in a song title is a version of a track, not
   a mix, and does not count.
5. **Vinyl** when a folder name says the music was ripped from vinyl: `VinylRip`, `[Vinyl]`, `Vinyl FLAC`,
   `from vinyl`, `LP`, `45 rpm`. The word "vinyl" inside a name ("Three Drives On A Vinyl") does not count.
6. **CD** when a folder name names a CD: `CD1`, `CD 2`, `2CD`, `(CD)`, `CD-FLAC`, `on CD`, `Disc 2`.
7. **Vinyl** for a 12", 10" or 7" folder (`12 inch`, `12''`), a maxi single, or a file numbered like a record
   side (`A1`, `B2`).
8. **Vinyl** for songs from before 1988, **CD** from 1988 on. The song's year is used, or a year in the folder
   name (`Complete Top 40 Van 1965`), whichever is older.
9. **CD** when nothing else is known.

The library name in front of the path is skipped, so a library called "Vinyl" does not make everything vinyl.
