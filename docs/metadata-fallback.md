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

The artist is extracted as everything **before the first ` - ` or ` – ` (en-dash)** in the immediate parent folder name.

The album is the cleaned parent folder name with catalogue suffixes (e.g. `SP5-1661`, `-cd-`) stripped from the end.

The title is the filename without extension, with leading track numbers removed (e.g. `01 `, `02.`).

---

## Important: DB only — audio files are not modified

> **This feature only writes to the Velvet SQLite database.**  
> The audio files on disk are **never modified**. ID3, Vorbis Comment, and other embedded tags remain untouched.

If you want the tags written into the files themselves (so other applications like Foobar2000, Plex, or Beets also see the values), you will need to use an external tagging tool.

---

## Rescan safety

Derived values survive normal rescans:

- **Unchanged files** — the scanner detects that the file content has not changed (same modification time and hash) and only updates the internal scan ID. All metadata columns, including the folder-derived values, are left untouched.
- **Modified files** — if a file's content changes (e.g. you re-tag it with an external tool), the scanner re-parses it. If embedded tags are now present, those take priority. If the file still has no embedded tags, the folder-name fallback runs again and produces the same result.

In short: **manually set embedded tags always win**. The fallback only activates when the file truly has no tags.

---

## Applying the fallback

### Automatic — on scan

From v6.5.0-velvet onward, the scanner applies the folder-name fallback automatically for any **new or modified file** it finds with no embedded tags. No action required.

### Backfill existing files — admin panel

For files already in the database that were scanned before the fallback was introduced (and thus still have `null` artist), use the **Fix Missing Metadata** button in the admin panel:

1. Open the admin panel → **Play Statistics** tab
2. Scroll to the **Fix Missing Metadata (DB only)** card
3. Click **Derive metadata from folder names**
4. A confirmation dialog shows; confirm to proceed
5. The result toast shows how many files were updated

The backfill also rebuilds the artist search index automatically so the artist browser and search are immediately up to date.

---

## Coverage

The fallback works for any folder following the `Artist - …` pattern. Folders that do not contain a ` - ` or ` – ` separator are skipped — their artist remains `null` (shown as "(Unknown)" in stats).
