# AI DJ — a set from a sentence

The AI DJ is a page in the player where you tell the DJ what you want to
hear, in your own words, and get a set back: to play, to add to the queue, or
to save as a playlist. It is off by default; the admin switches it on under
**Admin → External Services → AI-assist → AI DJ for listeners** (see
[ai-assist.md](ai-assist.md)). Once on, it is on for every listener, and the
admin can switch it off per user on the *Users* page.

The model never picks a song. It reads your request and writes a *brief* —
genres, artists, era, tempo, flow, length, what to leave out — spelled the
way your library spells it. Velvet then does the DJ work itself from the
database: it chooses the songs, mixes them in small tempo steps and
compatible keys, and tells you what it did and why. A set only ever holds
songs from your library and never exceeds the admin's cap.

## Opening it

**Now Playing → AI DJ**. The page has one text box, the collection selector
(the same scope pills as elsewhere: switch collections off, pick one folder)
and the result below. Type in any language; English and Dutch are read even
without the model.

## How to ask

Ask the way you would ask a DJ you know. Some shapes the DJ understands,
with examples:

| You want | Say, for example |
|---|---|
| A set | *two hours of 80s italo and hi-nrg that slowly builds up, no Modern Talking* · *een uur house dat opbouwt* · *twee uur disco, rustig afbouwen* |
| Songs that must match each other | *create a mix of 3 songs which match tempo, key and genre* · *nummers die bij elkaar passen* — one tempo, harmonic keys, the same genre, different artists |
| One song, or a few | *play Relax by FGTH* · *a 12-inch of Frankie Goes To Hollywood of +10 minutes* · *the longest version of Two Tribes* · *all versions of Relax* |
| Named titles | *give me the Grandmix 1983 and 1986* · *speel de jaarmix van 1991* — one song per title |
| An album | *one album of Cerrone from around 1985* · *play Cerrone 9* (the DJ knows that is *Cerrone IX – Your Love Survived*) · *the whole of Brigade Mondaine* — played in track order, nothing from any other album |
| A chart | *de top 10 van de house top 1000* · *nummer 1 van de top 40 van 1983* · *positions 50 to 60 of the disco top 700* · *the Kink top 500 as a countdown* — exactly those positions, in chart order |
| Your own statistics | *the most played disco song* · *my top 20 house* · *recently added* · *what I played last* · *never played lossless disco* |
| Your playlists | *from my playlist Extra Long 12-inches* · *the Best Remixes list, shuffled* |
| A scene, label, producer or service | *Chicago house* · *the SAW years* · *Ben Liebrand remixes* · *a DMC remix of Level 42* · *an hour of Disconet medleys* · *een Disconet versie van Donna Summer* |
| Flow and layout | *builds up* · *peak-time* · *winding down* · *two peaks* · *chronological* · *newest first* · *A–Z* · *shuffled* |
| Format and history | *lossless only* · *mp3 only* · *hi-res* · *starred* · *rated* · *played more than 5 times* · *added this month* · *not played in a year* |
| Leaving things out | *no remixes* · *no live versions* · *geen Modern Talking* · *zonder disco* |

A few rules of thumb:

- **Numbers in names are names.** *Grandmix 1983*, *Jaarmix 1991*, *Cerrone
  9*, *Top 40 van 1983* are titles, albums and charts, not eras. "The 80s",
  "from 1984", "around 1985", "late 90s" are eras.
- **Shorthand is understood** — FGTH, MJ, GNR, RHCP, SAW, GM, DMC — from the
  model's own knowledge, from the names your admin wrote in the house notes,
  and from the aliases the library notes carry.
- **"Top 10" has three meanings**, and the DJ keeps them apart: *the top 10
  of the House Top 1000* is a chart, *my top 10* is your play counts, *10
  songs from the House Top 1000* is a mixed set from that folder.
- **One song is one song.** A set never holds the same song twice — not from
  two compilations, and not as the 7-inch, the 12-inch and the remix — unless
  you ask for every version.

## What the result page shows

- **Title and summary** — the model's one-line reading of your request, in
  your language. When nothing could be played, the summary is replaced by
  "Nothing could be played from what is available to you right now", and the
  notes say why.
- **Chips** — the brief as Velvet resolved it against your library: the
  genres and artists it found, the era and tempo, the flow, named titles
  (♪), albums (💿), folders (📁), charts (🏆), playlists (≡), collections (🗂),
  version kind, key, history and format wishes, "songs that match each
  other", and "no …" for everything excluded.
- **Notes** — what happened on the way, in plain words. The honest ones
  matter most:
  - *"Grandmix 1986" is in your library (4 songs, in Music/Grandmix) but
    outside your current selection — switch that collection or folder on* —
    the DJ never plays outside your selection; it tells you where the music
    is.
  - *Years widened to 1978–1992 (too few matches)*, *Songs without a year
    included*, *Tempo filter dropped* — a soft wish gave way because the pool
    was too small. Explicit wishes (a key, a folder, a version, a genre) only
    give way when nothing at all matched; "only these artists" never does.
  - *Mixed like a DJ set: all songs picked from one tempo corridor,
    118–137 BPM* — see below.
  - *Built around Corporation of One — The Real Life (122 BPM, 5B, house)* —
    the seed of a "songs that match each other" set.
  - *Album: Cerrone — IX (1982), 9 tracks in order; 69 albums considered* —
    which album was chosen for an album request.
  - *Chart "Housetop1000": positions 1–10 as numbered in the file names — 10
    of 10 found*.
  - *Built without AI (Claude could not be reached) — read with simple
    rules* — the model was unavailable; the rule-based reader wrote the
    brief. You still get a set.
- **Stats** — songs, minutes, artists, the BPM range, the **largest tempo
  step** between two neighbours, **harmonic transitions** (how many
  neighbouring pairs are in mixable keys, out of the pairs where both keys are
  known) and how many songs have no key yet.
- **Buttons** — *Play now* replaces the queue, *Add to queue* appends,
  *Another take* rebuilds from the same brief without asking the model again
  (for an album request it picks the next album), *Save as playlist* saves
  the set under the name in the box.

## How the DJ mixes

The DJ behaves like a mix DJ, not like a shuffle. For a set in DJ order:

1. **Pool.** A hard-filtered sample from your library: the collections you
   have switched on, the genres, era, tempo, named artists and folders of the
   brief, the history and format wishes. Named artists are expanded with
   their Last.fm similar artists.
2. **Corridor.** One song is the seed, and the set is picked only from songs
   a DJ could mix into it: within a few BPM (a steady set stays within ±6%,
   a build climbs up to +14%, a cooldown comes down), in a compatible key, of
   the same genre family. The corridor is used only when it costs nothing: it
   must hold enough different songs and artists, and its best picks must
   score as well as the best of the whole pool. Otherwise it is dropped.
3. **Score and select.** Genre, named and similar artists, era, tempo, taste
   (rating and play count, or the opposite for "never played"), title words;
   caps per artist and per album so one catalogue never dominates; every
   named artist and every named title gets a slot.
4. **Ladder.** The songs are laid on the energy arc by tempo. **No two
   neighbours are more than about 2.5% apart** (3 BPM at 125): the widest gap
   is filled from the corridor, and artist spacing may only move a song
   within that step.
5. **Keys.** Walking the ladder, the next song is one the current key mixes
   into on the Camelot wheel — the same key, one step round the wheel
   (8A → 7A or 9A) or the relative major/minor (8A ↔ 8B). A transition that
   still does not mix is repaired from the corridor by a song at the same
   tempo whose key does, scoring as well, by another artist.
6. **Length.** The asked number of songs, or minutes converted through the
   median song length (hour-long megamixes stay out of a timed set), never
   more than the admin's cap, never more than the library holds.

Songs without an analysed tempo are spread through the set but cannot be
judged; songs without a key cannot be matched harmonically. The analysis
queue in the admin fills both in over time.

Album requests, chart requests, named titles and rankings skip the corridor:
an album plays in track order, a chart in chart order, a ranking in the order
of your statistics, and a named title is the song itself.

## What the DJ knows about your library

The model is briefed, not asked to remember:

- A **summary** of your library: genres with their average tempo, the
  biggest artists, folders and sub-folders, charts (numbered folders) with
  their position range, series (names that recur with different years, like
  Grandmix 1982–2022), your collections and the names of your playlists.
- **Library notes**, written once by the model after reading the collection
  and corrected by the admin where needed: what each folder *is* — "Disconet
  is the New York DJ remix service", "Grandmix is Ben Liebrand's yearly
  megamix", "Bootleg holds imitations, not the originals" — with the names
  people use for it.
- The admin's **house notes**: shorthand and taste only the owner knows.
- For every request, **what the library holds for its words**: each phrase
  is looked up first, and the model is told whether it is a title, an
  artist or a folder here, so "grandmix 1983" becomes a title and "cerrone"
  an artist instead of a guess.

## Limits, cost and privacy

- One request every 3 seconds, 200 per day per listener. Identical requests
  within 15 minutes are served from cache. *Another take* costs nothing.
- A request costs about a tenth of a cent on Claude Haiku once the library
  summary is cached, counted against the admin's monthly budget. With a
  self-hosted model nothing leaves your network.
- What leaves the server when Claude is used: your sentence, the library
  summary (tag names, folder names, counts, years, a few file names per
  folder, the names of your playlists) and the library notes. Never your
  files, your user name, your play history or the songs that were chosen.
- The set can be rebuilt from the brief without the model, and the brief is
  plain JSON you can edit and post yourself — see
  [API/ai-queue.md](API/ai-queue.md).

## When the model is not there

No key, budget spent, network down, a refused or unusable answer: a
rule-based reader writes the brief from your text instead — length, eras,
tempo, flow, genres, artists, folders, charts, series, playlists, history and
format words, "no …" exclusions — in English and Dutch, using the same
library names, the house-note shorthand and the library-note aliases. The
page says the set was built without AI. You always get a set.
