# Auto-DJ — soft-scoring architecture

Auto-DJ picks the next song by fetching a broad batch of candidates and
scoring every one of them — nothing except collections/paths, minimum
rating, and the keyword filter can outright exclude a song. This replaced an
earlier "hard filter + escalating fallback tier" design (tier 1 → BPM-only
fallback → free pick) that had to keep growing every time a combination of
hard filters (BPM + key + genre + similar-artist) proved too restrictive for
a real library.

## Philosophy

Every signal is "nice to have" — if a candidate matches, it earns more
points; if not, it just scores lower, it is never removed from the pool.
Only three things are true hard filters:

1. **Collections / paths** — the selected Auto-DJ vpath scope.
2. **Minimum rating** — songs below the floor are never candidates.
3. **Keyword filter** — explicitly excludes certain songs/artists/albums by
   substring match (this one stays exclusionary on purpose).

Everything else — similar-artist mode, genre filter, BPM continuity,
harmonic (Camelot) mixing — is additive scoring only:

| Signal | Weight (when similar-artist data exists) | Notes |
|---|---|---|
| Similar-artist (Last.fm) | 35% | Redistributed into BPM/genre/harmonic when Last.fm has no data for the current artist, or Similar Artists mode is off |
| BPM continuity | 25% (up to ~46% when artist weight is redistributed) | Blended reference: 60% current-song BPM + 40% session base/anchor |
| Genre | 13% (up to ~24%) | Blends the user's explicit whitelist/blacklist (soft, not a hard gate) with a genre-compatibility matrix |
| Harmonic (Camelot) mixing | 7% (up to ~13%) | Uses the *currently playing* song's key directly — no separate locked "anchor" key to track |
| Year/era continuity | 10% (fixed) | Blended reference: 60% current-song year + 40% rolling anchor |
| Artist diversity (cooldown) | 10% (fixed) | Penalises artists played very recently |

On top of the scoring above, `_djPickSong()` also applies one **hard**
artist-repeat floor (`DJ_ARTIST_HARD_FLOOR = 3`): candidates whose artist
matches one of the last 3 played artists are excluded outright, regardless of
score. This exists because `_batchRandomSongs()` can legitimately drop the
server-side cooldown list entirely when the similar-artist pool is too narrow
to satisfy both filters at once — without this backstop, the 10% diversity
scoring bonus alone wasn't always enough to outweigh a strong similar-artist/
BPM/genre match for a just-played artist. Falls back to the unfiltered
candidate list if the floor would empty the pool, so Auto-DJ never stalls.

## Candidate flow

1. **Fetch a batch.** `POST /api/v1/db/random-songs` with `returnAll: true`
   returns a candidate pool (see `_batchRandomSongs()` in
   [src/api/db.js](../src/api/db.js)) scoped only to the hard filters above
   (collections, rating, similar-artist list when active, cooldown list).
   No BPM/key/genre params are sent — those are scored client-side.
   **When a similar-artist list is active, the pool is balanced per artist**
   (up to `PER_ARTIST_SAMPLE_CAP=10` songs sampled from EACH similar artist,
   capped overall at `RANDOM_SONGS_BATCH_CAP=500`) — otherwise an artist with
   a much larger catalogue in the library statistically crowds out thinly
   represented artists, so a well-tagged song from a smaller artist might
   never even reach the scoring stage.
2. **Drop keyword-blocked and just-played songs** (`_djSongBlocked()`, last
   ~30 queue entries).
3. **Score every remaining candidate** (`_djScoreSong()`) and take the
   highest score (`_djPickSong()` in [webapp/app.js](../webapp/app.js)).
   Ties are broken randomly.
4. Repeat from scratch for every new "current song" — there is no
   persistent per-session lock on BPM/key; the reference is always derived
   from the currently playing track (blended with a rolling anchor for
   smooth drift), so a change in similar-artist results, BPM, or key on the
   next pick is free to move independently.

## Why similar-artist mode gets its own escape hatch

If Last.fm returns no similar artists for the current track (or the artist
lookup fails), the 35% similar-artist weight is redistributed proportionally
into BPM/genre/harmonic instead of being wasted — those signals become the
primary basis for the pick, matching the intent that when one "nice to have"
signal has nothing to offer, the others should matter more, not less.

## Backward compatibility

`returnAll` is opt-in. `webapp/tizen/app.js` (Samsung TV) and
`webapp/server-remote/index.html` (remote control) do not send it and
continue to use the original single-song-per-request endpoint behaviour
(`_leanRandomPick` / `_fullLoadFallbackChain` / `_qualityTierFilter` /
`_selectRandom` in `src/api/db.js`), unchanged.
