**Get Metadata From DB**
----
  Retrieves the stored metadata for one song.

* **URL**

  `/api/v1/db/metadata`

* **Method:**

  `POST`

* **JSON Params**

   **Required:**

   `filepath` - player filepath of the song, starting with the vpath (e.g. `Music/Artist/song.mp3`). A child vpath name may be used; the song is then looked up in the parent vpath.

* **JSON Example**

  ```json
  {
    "filepath": "Music/Artist/song.mp3"
  }
  ```

* **Success Response:**

  * **Code:** 200 <br />
    **Content:**

    ```json
    {
      "filepath": "Music/Artist/song.mp3",
      "metadata": {
        "artist": "Artist",
        "album-artist": null,
        "hash": "md5 hash",
        "album": "Album",
        "track": 3,
        "track-of": 12,
        "disk": null,
        "title": "Song Title",
        "year": 1990,
        "album-art": "hash.jpg",
        "rating": null,
        "play-count": null,
        "last-played": null,
        "genre": "Pop",
        "replaygain-track-db": null,
        "duration": 237.431,
        "bitrate": 320000,
        "sample-rate": 44100,
        "channels": 2,
        "bit-depth": null,
        "album-version": null,
        "bpm": 120,
        "musical-key": "8A"
      },
      "rg": { "trackGain": -7.2, "truePeak": -0.3, "albumGain": null, "albumPeak": null, "src": "tag" }
    }
    ```

    - When the song is found through the parent vpath, `filepath` is rewritten to the parent path (use that path for playback).
    - When the song is not in the DB, `metadata` is `null`.
    - `rg` is `null` when no ReplayGain value is known. `rg.src` is `measured` (Velvet's own analysis), `r128` (R128 tag, +5 dB) or `tag` (ReplayGain tag).

---

**Batch:** `POST /api/v1/db/metadata/batch` takes a JSON array of filepaths and returns an object keyed by each filepath, with the same `{ filepath, metadata, rg }` value per entry (`metadata: null` for unknown or inaccessible paths).
