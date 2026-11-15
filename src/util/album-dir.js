// Single rule for "which folder is the album": the Album Library, the Subsonic
// album_id, the Tag Workshop grouping and ReplayGain album gain all use it.
//   DISC_RE         — starts with keyword: "CD 1", "Disc 2", "CD-3"  ("Disconet" does NOT match)
//   DISC_SUFFIX_RE  — ends with keyword:   "Album Title CD - 1", "Foo Disc 2"
//   NUMERIC_DISC_RE — bare number:         "1", "02"
const DISC_RE         = /^(cd|disc)\s*[-–]?\s*\d/i;
const DISC_SUFFIX_RE  = /\b(cd|disc)\s*[-–]?\s*\d+\s*$/i;
const NUMERIC_DISC_RE = /^\d{1,2}$/;

export function isDiscFolder(name) {
  return DISC_RE.test(name) || DISC_SUFFIX_RE.test(name) || NUMERIC_DISC_RE.test(name);
}

// Vpath-relative album directory, with a trailing disc folder collapsed into the
// album above it. Null for a file directly in the vpath root.
export function albumFolderPath(filepath) {
  const parts = String(filepath || '').split('/');
  if (parts.length < 2) return null;
  const albumDepth = (parts.length >= 3 && isDiscFolder(parts[parts.length - 2]))
    ? parts.length - 3
    : parts.length - 2;
  return parts.slice(0, albumDepth + 1).join('/');
}
