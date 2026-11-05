# Flow the queue

Auto-DJ and the AI DJ mix the songs *they* pick: small tempo steps, keys that
mix on the Camelot wheel, no artist twice in a row. **Flow the queue** does the
same for the songs *you* queued — an album, a folder, a playlist, a handful of
songs added by hand — without changing which songs they are.

Lives in the queue panel, in the row of buttons next to **Up Next**, the wave
icon left of Shuffle.

---

## What it does

- The song that is playing stays where it is. Every song after it is
  re-ordered so each one flows into the next, taking off from the playing
  song's tempo.
- Songs already played stay where they are.
- Songs without an analysed tempo are spread through the list, not dumped at
  the end; songs without a key are placed by tempo only.
- The toast says how many songs were re-ordered, the largest tempo step and
  how many transitions are harmonic — the same numbers the AI DJ shows — and
  has **Undo**, which puts the old order back while the same song plays.
- Nothing plays, pauses or skips. The queue is saved as usual.

The ordering is the one described in [ai-dj.md](ai-dj.md) under *How the DJ
mixes*, steps 4 and 5: the tempo ladder (no neighbour more than about 2.5%
apart where the songs allow it), the Camelot pass (same key, one step round
the wheel, or the relative major/minor), and artist spacing. There is no
corridor and no selection: every song you queued is still there.

## Limits

- At least three songs from the playing one onwards (two to re-order).
- Up to 1000 songs are flowed in one go; anything past that keeps its order
  behind them.
- A song the server cannot find (removed from the library, or in a collection
  you have no access to) is kept at the end in its own order; the toast says
  how many.
- Auto-DJ keeps working: it adds songs after the flowed ones, as always.

## API

`POST /api/v1/queue/flow` — see [API.md](API.md#queue-velvet). No AI-assist
needed; it is the planner, not the model.

## Where the tempo and key come from

The same place Auto-DJ reads them: file tags, AcousticBrainz and the local
analysis queue — see [bpm-harmonic.md](bpm-harmonic.md). The more of your
library has a tempo and a key, the better the flow.
