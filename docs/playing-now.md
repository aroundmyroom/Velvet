# Playing Now

The Playing Now view (left nav → Now Playing → Playing Now) shows the current song large: cover, title, artist,
album, rating, technical details, artist information, similar artists and track info.

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
2. **Tape** for anything of 30 minutes or longer (a mix or a live set).
3. **Tape** when a folder name says it holds mixes: `Megamixes`, `Mixed by`, `Mix Club`, `Mixen`, `Jaarmix`,
   `Mastermix`, `In the Mix`, `DJ Mix`, `Continuous Mix`, `Full Set`, `Live Set`, `Radio Show`, `The Tapes`.
   An album tag that says `Mixed by`, `Mix Cut`, `Continuous Mix` or `DJ Mix` counts too, and so does a file of
   10 minutes or longer called a megamix, DJ mix or full set. "Radio Mix" or "Club Mix" in a song title is a
   version of a track, not a mix, and does not count.
4. **Vinyl** when a folder name says the music was ripped from vinyl: `Vinyl`, `VinylRip`, `LP`, `45 rpm`.
5. **CD** when a folder name names a CD: `CD1`, `CD 2`, `2CD`, `CDM`, `CDS`, `CD-FLAC`, `on CD`, `Disc 2`.
   A catalogue number such as `CDS-2229` does not count.
6. **Vinyl** for a 12", 10" or 7" folder (`12 inch`, `12''`), a maxi single, or a file numbered like a record
   side (`A1`, `B2`).
7. **Vinyl** for songs from before 1988, **CD** from 1988 on. The song's year is used, or a year in the folder
   name (`Complete Top 40 Van 1965`), whichever is older.
8. **CD** when nothing else is known.

The library name in front of the path is skipped, so a library called "Vinyl" does not make everything vinyl.
