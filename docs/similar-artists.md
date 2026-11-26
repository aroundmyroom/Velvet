# Similar artists

Velvet asks an outside service which artists are similar to the one you are listening to. The answer drives:

- **Auto-DJ similar mode** (the *Similar Artists* switch in the Auto-DJ panel), in the browser, in Velvet Rooms and in the server remote.
- **Similar artists** chips on the artist page and in Playing Now (only artists with albums in your library).
- The **Because you listened to** shelves on the Home screen.
- The **AI DJ** when a request asks for artists like the ones named ("feature" mode).
- The radio chain behind Subsonic **getSimilarSongs** (Music Assistant's radio, "Don't stop the music" in Subsonic apps).

The admin picks exactly **one source** under **Admin panel → Similar artists**: ListenBrainz (the default), TIDAL, Last.fm, or Off.

## Why

Until now Velvet used Last.fm (`artist.getSimilar`) for this. From **1 December 2026 a Last.fm API key only works while its owner has Last.fm Pro** (€4.99 a month or €49.99 a year), see the [Last.fm announcement](https://support.last.fm/t/api-keys-will-require-pro-from-1st-december/121030). Without Pro, Auto-DJ's similar mode and the similar-artist lists would go quiet. ListenBrainz needs no account at all, and TIDAL needs a free developer account.

## Choosing a source

| | ListenBrainz | TIDAL | Last.fm |
|---|---|---|---|
| **What you need** | Nothing for similar artists. A ListenBrainz user token for top tracks. | A free TIDAL developer app (Client ID + Client Secret) | A Last.fm API key **with Last.fm Pro** from 1 December 2026 |
| **Cost** | Free | Free | €4.99/month or €49.99/year (Pro) |
| **Results per artist** | Up to 100 | Up to 100 (3 pages) | Up to 100 |
| **Score** | Yes, 0–1, scaled against the best match | No, rank order only | Yes, Last.fm's own 0–1 match |
| **How the artist is found** | MusicBrainz artist ID (from your tags, else one MusicBrainz search) | TIDAL name search | By name |
| **Matching to your library** | By name and by MusicBrainz ID | By name | By name, and by MusicBrainz ID when Last.fm gives one |
| **Top tracks (Subsonic getTopSongs)** | ListenBrainz, needs a token | ListenBrainz, needs a token | Last.fm |

What we found when testing:

- **ListenBrainz** is excellent for niche and electronic artists: Klinik gives Nitzer Ebb, Suicide Commando, Front Line Assembly and more. For very popular artists the list can drift towards general pop: Depeche Mode also brings Brian May and The Beatles. Velvet only uses the names you have in your library, so the effect is smaller than the raw list suggests.
- **TIDAL** gives a good list from a large catalogue, but in rank order only, without a score. Read the [TIDAL developer terms](https://developer.tidal.com/) before you use it; we could not find published rate limits.
- **Last.fm** works exactly as before, as long as the key's owner has Pro.

### Considered and rejected

| Service | Why not |
|---|---|
| Deezer | No key needed, but its terms of 27 October 2026 require an approved application, allow at most 20 related artists and give no score |
| Spotify | "Related artists" is closed to new apps |
| Apple Music | Needs the Apple Developer Program ($99 a year) |
| TasteDive | Results too weak |
| music-map | Only by scraping the website |
| MusicBrainz, Wikidata, Discogs, TheAudioDB | No similarity data |

## Setup

Go to **Admin panel → Similar artists**, choose a source, fill in what it needs and click **Save**. Then use the [Test](#testing) box to check it.

### ListenBrainz (default)

1. Choose **ListenBrainz**. Similar artists work right away; no account is needed.
2. Optional, for top tracks: paste a **ListenBrainz user token** (on [listenbrainz.org/settings](https://listenbrainz.org/settings/), under *User Token*). Without one Velvet borrows the token of a user who connected ListenBrainz for scrobbling, admins first. The page shows which one is used.
3. Optional: an **algorithm**. Leave it empty for Velvet's default. Only change it if you know the names of the ListenBrainz Labs similar-artists algorithms; it may contain letters, digits and underscores.
4. Click **Save**.

ListenBrainz works with MusicBrainz artist IDs, not names. Velvet finds the ID like this:

1. **From your library.** Files matched by the [AcoustID fingerprint worker or the MusicBrainz text search](acoustid.md) carry the artist's MusicBrainz ID. Velvet takes the most common ID among files of that artist.
2. **Otherwise one MusicBrainz search** for the name. Velvet sends at most one request per second, as MusicBrainz asks, and only accepts an artist whose name (or sort name) is exactly the same, ignoring case, accents and punctuation. The ID is stored for 90 days; a name MusicBrainz does not know is tried again after 7 days.

The first lookups for a large library are therefore a little slower; after that the stored IDs make it fast.

### TIDAL

1. Sign in at the [TIDAL developer dashboard](https://developer.tidal.com/dashboard) with a TIDAL account (a free account is enough) and create an app.
2. Copy its **Client ID** and **Client Secret**.
3. In Velvet choose **TIDAL** and paste both.
4. **Country**: the two-letter country code of the catalogue to search, for example `NL`. Default `US`.
5. Click **Save**, then run a test.

Velvet logs in with the client credentials (no user login), searches the artist by name, takes the result with exactly the same name, and reads up to 3 pages of its similar artists. The secret is never shown again after saving; leave the field empty to keep it.

### Last.fm

1. Set the API key under **Admin panel → Last.fm** (see [json_config.md](json_config.md#lastfm-server-level)).
2. Under **Similar artists** choose **Last.fm** and click **Save**.

From 1 December 2026 this only works while the owner of that key has Last.fm Pro. When Last.fm is the source, top tracks also come from Last.fm.

### Off

No similar-artist lookups at all. The Similar Artists switch in Auto-DJ is greyed out, artist pages show no similar artists and the Home shelves *Because you listened to* stay hidden. Auto-DJ still works on BPM, key, genre and era.

## Top tracks (Subsonic getTopSongs)

Subsonic apps and Music Assistant ask for an artist's top tracks. Velvet ranks the artist's songs in your library by its own play counts and blends in the artist's most played tracks from outside (see [subsonic.md](subsonic.md)):

- **Source Last.fm**: Last.fm `artist.getTopTracks`.
- **ListenBrainz or TIDAL**: ListenBrainz's popular recordings of the artist. ListenBrainz only answers this with a user token: the one on the Similar artists page, else the token of a user who connected ListenBrainz for scrobbling (admins first).
- **Off**, no token, or no Last.fm key when Last.fm is the source: top tracks use Velvet's own play counts only.

## How results are matched to your library

The source gives names, and from ListenBrainz (often also Last.fm) MusicBrainz IDs. Velvet keeps only artists that are in your library:

- **By name**, with or without accents and capitals ("Tiësto" and "Tiesto"), see [autodj-scoring.md](autodj-scoring.md).
- **By MusicBrainz ID**: when the source gives an ID that occurs in your files, every artist name under that ID counts, even if it is spelled differently.

A credit like "Artist A feat. Artist B" is tried as a whole first, then per part, as before.

## Storage and caching

Answers are kept so that a restart, or an outage at the source, does not empty Auto-DJ:

| What | Kept |
|---|---|
| A similar-artist list or a top-tracks list | 30 days in the database (table `similar_cache`) |
| An empty answer (the source knows no similar artists) | 7 days |
| A MusicBrainz or TIDAL artist ID | 90 days |
| The list in memory, per artist | 6 hours on top of the database |
| The list matched to your library | 30 minutes, so newly scanned artists show up |

When a stored answer is older than that, Velvet asks the source again. **When the source fails, the older stored answer is used.** Only when nothing is stored does Auto-DJ go on without a similar-artist signal for that song (it keeps the last list it had).

Each source has its own stored answers, so switching sources does not mix lists. ListenBrainz answers are also kept per algorithm and TIDAL answers per country.

**Clear stored answers** on the admin page empties the `similar_cache` table, including the stored IDs, and drops the in-memory layer. Saving the settings (for example switching source) drops the in-memory layer too, so the new source is used right away; its own stored answers are kept.

## Testing

The **Test** box on the admin page asks the source directly for one artist, skipping the stored answer (the new answer is stored). It shows:

- the top 25 similar artists, with their score and whether they are **in your library**;
- how many the source returned in total, and how long it took;
- the error message from the source when something is wrong.

You can test a source before choosing it, as long as it is set up (TIDAL credentials saved, or a Last.fm key).

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Test says the source is *not configured* | TIDAL: Client ID or Secret missing. Last.fm: no API key under Admin → Last.fm. |
| ListenBrainz test returns nothing for an artist | MusicBrainz has no artist with exactly that name, or ListenBrainz has too few listens for it. Fingerprint the artist's files with [AcoustID](acoustid.md) so the ID comes from your tags, or try TIDAL. |
| ListenBrainz gives the wrong artist (a namesake) | The MusicBrainz search found another artist with the same name. AcoustID matches in your library take priority; after fingerprinting, click **Clear stored answers**. |
| Very popular artists get general pop names | The way ListenBrainz's data works for big artists. Only names in your library are used. Try TIDAL if it bothers you. |
| `TIDAL login answered 401` | Wrong Client ID or Secret. Copy them again from the TIDAL developer dashboard. |
| TIDAL finds no artist | The name is spelled differently on TIDAL, or the artist is not in that country's catalogue. Try another country code. |
| `Last.fm answered …` with an error about the API key | Invalid key, or from 1 December 2026: the key's owner has no Last.fm Pro. |
| Subsonic top tracks show only your own play counts | No ListenBrainz token: set one on the Similar artists page, or connect ListenBrainz as a user. With Last.fm as the source: no Last.fm key. |
| Auto-DJ's Similar Artists switch is greyed out | The source is Off, or not set up (see the first row). |
| A changed source or cleared answers do not show in the player | The 6-hour in-memory layer. Restart Velvet. |

## What still needs Last.fm

Choosing another source here does not remove every Last.fm use. These still need a Last.fm API key, and therefore Last.fm Pro from 1 December 2026:

- **Scrobbling to Last.fm** (or use [ListenBrainz](listenbrainz.md) or [multi-scrobbler](multi-scrobbler.md)).
- **Artist biography** on the artist page (`artist.getInfo`). Without a key the bio comes from TheAudioDB when it has one.
- **Genre Enricher**: its Last.fm source, and starting a run ([genre-enricher.md](genre-enricher.md)).
- **Subsonic getSimilarSongs**, only its last fallback: Last.fm `track.getSimilar` when Velvet's own radio chain finds nothing.

## Configuration

Stored in `save/conf/default.json`. See [json_config.md](json_config.md#similar-artists-similarartists).

```json
{
  "similarArtists": {
    "source": "listenbrainz",
    "listenbrainzAlgorithm": "",
    "listenbrainzToken": "",
    "tidalClientId": "",
    "tidalClientSecret": "",
    "tidalCountry": "US"
  }
}
```

## API

All routes are admin only.

| Method | Path | Body → response |
|---|---|---|
| `GET` | `/api/v1/admin/similar-artists/config` | → `{ source, ready, listenbrainzAlgorithm, defaultAlgorithm, hasListenbrainzToken, topTracksToken, tidalClientId, hasTidalSecret, tidalCountry, hasLastfmKey }` |
| `POST` | `/api/v1/admin/similar-artists/config` | `{ source, listenbrainzAlgorithm?, lbToken?, tidalClientId?, tidalSecret?, tidalCountry? }` → `{}` |
| `POST` | `/api/v1/admin/similar-artists/test` | `{ artist, source? }` → `{ source, ok, ms, artists, total, error? }` |
| `POST` | `/api/v1/admin/similar-artists/clear-cache` | → `{ removed }` |

The player reads `similarArtists` (true when the chosen source can answer) from `GET /api/v1/lastfm/status`, and gets the list from `GET /api/v1/lastfm/similar-artists`. Details in [API.md](API.md#admin--similar-artists-velvet).

## Services Velvet calls

- ListenBrainz Labs: `GET https://labs.api.listenbrainz.org/similar-artists/json?artist_mbids=<id>&algorithm=<name>`
- ListenBrainz: `GET https://api.listenbrainz.org/1/popularity/top-recordings-for-artist/<id>` with `Authorization: Token <token>`
- MusicBrainz: `GET https://musicbrainz.org/ws/2/artist?query=artist:"<name>"` (1 request per second)
- TIDAL: `POST https://auth.tidal.com/v1/oauth2/token` (client credentials), then `searchResults/<name>/relationships/artists` and `artists/<id>/relationships/similarArtists` on `https://openapi.tidal.com/v2`
- Last.fm: `artist.getSimilar` and `artist.getTopTracks`

Every request times out after 8 seconds. Requests to ListenBrainz and MusicBrainz identify themselves as `Velvet/<version>`.
