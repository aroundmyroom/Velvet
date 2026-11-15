# Folder-Name Metadata Fallback

Velvet can automatically derive **artist**, **album**, and **title** values from the file system path for audio files that have no embedded tags. This is useful for large libraries where many files are untagged but follow a consistent folder naming convention.

---

## How it works

### Naming convention expected

```
Artist - Release title extra info/trackfile.wav
```

Examples this handles correctly:

| Folder name | Derived artist |
|---|---|
| `Frankie Avalon - Venus (Disco Version) - SP5-1715` | `Frankie Avalon` |
| `Al Hudson – You Can Do It - Music - SP5-1661` | `Al Hudson` |
| `Lime - Mega Mix Re-Lime-D & Wake Dream - SP5-1225` | `Lime` |

The artist is extracted as everything **before the first ` - ` or ` – ` (en-dash)** in the immediate parent folder name. It is only derived when the file has neither an artist nor an album-artist tag.

The album is the parent folder name with a catalogue suffix (e.g. `- SP5-1661`, `- ABC-123`, `-cd-`, `- 2`) and everything after it cut off. It is only derived when the album tag is empty.

The title is the filename without extension, with leading digits, spaces, dots, underscores and dashes removed (e.g. `01 `, `02.`). It is only derived when the title tag is empty.

Each field is filled independently, so a file with a title tag but no artist tag keeps its title.

---

## Important: DB only — audio files are not modified

> **This feature only writes to the Velvet SQLite database.**  
> The audio files on disk are **never modified**. ID3, Vorbis Comment, and other embedded tags remain untouched.

If you want the tags written into the files themselves (so other applications like Foobar2000, Plex, or Beets also see the values), you will need to use an external tagging tool.

---

## Rescan safety

Derived values survive normal rescans:

- **Unchanged files** — the scanner detects that the file has not changed (same modification time, hash present) and only updates the internal scan ID. All metadata columns, including the folder-derived values, are left untouched.
- **Modified files** — if a file's modification time changes (e.g. you re-tag it with an external tool), the scanner re-parses it. If embedded tags are now present, those take priority. If a field is still empty, the folder-name fallback runs again for that field and produces the same result.

In short: **embedded tags always win**. The fallback only fills fields the file does not have.

---

## Applying the fallback

### Automatic — on scan

The scanner applies the folder-name fallback automatically for any **new or modified file** with empty artist, album or title tags. No action required.

### Backfill existing files — admin panel

For files already in the database that still have an empty artist, use the **Fix Missing Metadata** card in the admin panel:

1. Open the admin panel → **Play Stats**
2. Scroll to the **Fix Missing Metadata (DB only)** card — it shows a preview: files missing artist, how many can be derived, how many are skipped, and up to 8 examples
3. Click **Derive metadata from folder names**
4. A confirmation dialog shows; confirm to proceed
5. The result toast shows how many files were updated

The backfill only touches rows with an empty artist; it sets the artist and fills album/title only where those are empty. It also updates the search index and rebuilds the artist index, so the artist browser and search are up to date.

API: `GET /api/v1/admin/wrapped/backfill-folder-metadata/preview` and `POST /api/v1/admin/wrapped/backfill-folder-metadata`.

---

## Coverage

The fallback works for any folder following the `Artist - …` pattern. Folders that do not contain a ` - ` or ` – ` separator are skipped — their artist remains `null`.
