# Feishin queue / gapless playback — findings

_Investigation of the reported Feishin issue where a restored or replaced listening
queue plays the wrong "next" track. Summary you can share with the reporter._

## Reported symptoms

1. **Restored partial queue.** Play an album, stop mid-way (e.g. track 5), close
   Feishin, reopen. Press Play: track 5 plays, but at its end playback does not
   advance — it pauses. **Next** moves the highlight to track 6 without playing;
   at the end of track 6 the UI shows track 7 but track 6 plays again.
2. **Replaced queue.** Remove the current queue, add a different album and play it.
   At the end of the new album's first track, Feishin plays **the next track of the
   _previous_ queue** instead of the new album's track 2.

Both happen only with a queue that was **restored or replaced** — not with a queue
played straight through, and not when a fresh queue fully replaces the old one and
is then played from scratch.

## What the access logs show (verified)

- Across the captured logs (6,673 Subsonic requests, multiple days), Feishin made
  **zero** `savePlayQueue` / `getPlayQueue` calls. Feishin keeps its queue
  **entirely on the client**; it never stores or restores it on the server.
- After the server's exact-file id change, Feishin streams each track by its
  exact `<hash>@<rowid>` id, and a healthy in-order session advances cleanly
  (consecutive tracks, each scrobbled, no repeats).

## Diagnosis (verified reasoning)

This is a **Feishin client-side issue**, not a Velvet server issue:

- Velvet is **stateless about a client's queue**. It only streams the exact track
  whose id is requested. It has no concept of "the previous queue," so it cannot
  produce "the previous queue's next track" — that track id can only have come
  from Feishin's own (stale) gapless prefetch buffer.
- A server-side wrong-file (hash collision) would serve some _unrelated_ track that
  happens to share a content hash — never, deterministically, the _previous queue's
  positional next track_. The positional tie to the old queue rules the server out.
- The pattern across both symptoms is the same: Feishin's **gapless "next track"
  prefetch is not re-synchronised when the queue changes** (restored on reopen, or
  replaced), so the first transition plays a stale buffered source.

## What Velvet changed (and did not)

- **v0.2.1** hardened the server-side `savePlayQueue` / `getPlayQueue` path so the
  restored `current` id always matches a returned entry. This benefits clients that
  use server-side queues (DSub, play:Sub) but **does not affect Feishin**, which
  does not use those endpoints.
- An earlier change made every Subsonic song id carry an exact-file
  `<hash>@<rowid>` disambiguator, so the server never serves the wrong file for a
  shared content hash. This is in effect and is the right fix for "plays the wrong
  file," but it does not change which id Feishin chooses to prefetch.

No Velvet server change can fix the reported behaviour, because the wrong track is
selected inside Feishin before any request reaches the server.

## Recommendations (for the reporter)

1. **Confirm it is Feishin-specific.** Run the same two reproductions in another
   Subsonic client (Symfonium is a good, robust choice). It is expected **not** to
   reproduce, which isolates the issue to Feishin.
2. **Update Feishin.** Older Feishin 1.x builds had known gapless/queue-prefetch
   bugs; a newer release may already fix this.
3. **Workaround.** Disable gapless / crossfade in Feishin's playback settings — the
   stale-prefetch transition should stop.
4. If it still reproduces on the latest Feishin, it is worth filing upstream with
   Feishin (with the exact steps in "Reported symptoms"), as it is a client bug.
