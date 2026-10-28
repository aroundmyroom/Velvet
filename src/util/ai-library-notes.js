// Library notes: what each folder of the collection *is*, written once by the
// model after reading the collection (a music historian's catalogue: "Disconet
// is the New York DJ remix service 1977–1989", "Grandmix is Ben Liebrand's
// yearly megamix"), stored, shown to the admin, editable, and read by the AI DJ
// on every request. The digest the model reads is built from the database:
// folder sizes, years, lengths, main artists, genres, albums and file names.
export const NOTE_KINDS = ['artist', 'album', 'series', 'chart', 'label', 'compilation', 'remix-service', 'radio', 'mixes', 'bootleg', 'genre', 'era', 'scene', 'unsorted', 'other'];

export const NOTES_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          folder: { type: 'string' },
          kind: { type: 'string', enum: NOTE_KINDS },
          note: { type: 'string' },
          aliases: { type: 'array', items: { type: 'string' } },
          ask: { type: 'string' },
        },
        required: ['folder', 'kind', 'note', 'aliases', 'ask'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
};

export const NOTES_SYSTEM = `You are a music historian cataloguing one private music collection, folder by folder, so that a DJ assistant can later answer requests from it. Each line gives a folder: its path, size, sub-folders, years, median length, main artists, genres, albums and a few file names. Answer one item per folder, repeating the path exactly as given.
- kind: one of ${NOTE_KINDS.join(', ')}.
- note: at most two sentences, in English, saying what this folder is and holds. Name the real thing when you recognise it: Disconet is the New York DJ remix service (1977–1989) with yearly Top Tune Medleys; Grandmix is Ben Liebrand's yearly megamix on Dutch radio since 1983; DMC is the Disco Mix Club's DJ-only remix series; a "Complete Top 40 van 1983" is the Dutch Top 40 year list; Kink Top 500 and House Top 1000 are radio charts; Mastermix, Ultimix, Hot Tracks are DJ remix services; "Mastertape", "Veronica master", "Radio 538 FM recording" tell the source and quality of a recording. Give the era and style, and what a DJ must know to use the folder: hour-long megamixes are not for a mixed set; a numbered folder is a chart; a bootleg or imitation is not the original; a container of sub-folders is described as such. Never invent facts: when the names tell you nothing certain, describe what the data shows.
- aliases: up to 4 short names people use for it (abbreviations, nicknames, initials — "GM" for Grandmix, "FGTH"), else [].
- ask: one example of what a listener would say to a DJ to get music from this folder — a request to play something ("speel de Grandmix 1986", "an hour of Disconet medleys"), never a question about the folder — in the language the file names suggest (Dutch names → Dutch).`;

const basename = fp => fp.slice(fp.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');

function top(map, k) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, k);
}
function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// rows: { vpath, filepath, artist, album, genre, year, duration }. One digest
// per folder down to three levels; deeper levels need more files to count, so
// a 140,000-song collection stays at a few thousand lines.
export function folderDigest(rows, { minFiles = [10, 20, 40], maxDepth = 3, samples = 4 } = {}) {
  const stats = new Map();
  for (const r of rows) {
    const parts = String(r.filepath).split('/');
    for (let d = 1; d <= maxDepth && d < parts.length; d++) {
      const folder = parts.slice(0, d).join('/');
      const key = `${r.vpath}/${folder}`;
      let s = stats.get(key);
      if (!s) {
        s = { key, vpath: r.vpath, folder, name: parts[d - 1], depth: d, n: 0, years: [], durations: [], artists: new Map(), genres: new Map(), albums: new Map(), children: new Set(), samples: [] };
        stats.set(key, s);
      }
      s.n++;
      if (r.year > 1900 && r.year < 2100) s.years.push(Number(r.year));
      if (r.duration > 0) s.durations.push(Number(r.duration));
      if (r.artist) s.artists.set(r.artist, (s.artists.get(r.artist) || 0) + 1);
      if (r.genre) s.genres.set(r.genre, (s.genres.get(r.genre) || 0) + 1);
      if (r.album) s.albums.set(r.album, (s.albums.get(r.album) || 0) + 1);
      if (d < parts.length - 1) s.children.add(parts[d]);
      if (s.samples.length < samples * 8 && s.n % 13 === 1) s.samples.push(basename(r.filepath));
    }
  }
  const need = d => (Array.isArray(minFiles) ? minFiles[Math.min(d, minFiles.length) - 1] : minFiles);
  return [...stats.values()].filter(s => s.n >= need(s.depth)).map(s => ({
    key: s.key, vpath: s.vpath, folder: s.folder, name: s.name, depth: s.depth, n: s.n, children: s.children.size,
    yearFrom: s.years.length ? Math.min(...s.years) : null, yearTo: s.years.length ? Math.max(...s.years) : null, yearMedian: median(s.years), withYear: s.years.length,
    minutesMedian: s.durations.length ? Math.round(median(s.durations) / 60) : null,
    topArtists: top(s.artists, 3), topGenres: top(s.genres, 2).map(([g]) => g), topAlbums: top(s.albums, 2).map(([a]) => a),
    samples: s.samples.slice(0, samples),
  })).sort((a, b) => a.depth - b.depth || b.n - a.n);
}

export function digestLine(d) {
  const parts = [`${d.n} files${d.children ? `, ${d.children} sub-folders` : ''}`];
  if (d.yearFrom) parts.push(`years ${d.yearFrom}–${d.yearTo} (median ${d.yearMedian}, ${Math.round(100 * d.withYear / d.n)}% tagged)`);
  else parts.push('no years');
  if (d.minutesMedian != null) parts.push(`median ${d.minutesMedian} min`);
  if (d.topArtists.length) parts.push(`artists: ${d.topArtists.map(([a, n]) => `${a} (${n})`).join(', ')}`);
  if (d.topGenres.length) parts.push(`genres: ${d.topGenres.join(', ')}`);
  if (d.topAlbums.length) parts.push(`albums: ${d.topAlbums.join(' / ')}`);
  if (d.samples.length) parts.push(`files: ${d.samples.join(' · ')}`);
  return `${d.key} | ${parts.join(' | ')}`;
}

// The notes as the AI DJ reads them: the broad folders first, within a budget
// of characters; `included` says which keys made it, so a request about a
// deeper folder can bring its own note along.
export function notesText(notes, { maxChars = 14000 } = {}) {
  const sorted = [...notes].sort((a, b) => a.depth - b.depth || b.n - a.n);
  const lines = [];
  const included = new Set();
  let chars = 0;
  for (const x of sorted) {
    const line = noteLine(x);
    if (chars + line.length > maxChars) continue;
    lines.push(line);
    included.add(x.key);
    chars += line.length + 1;
  }
  if (!lines.length) return { text: '', included };
  return { text: `Library notes — what each folder is, written by a music historian after reading this collection (folder [kind]: note; also = other names for it):\n${lines.join('\n')}`, included };
}

export function noteLine(x) {
  const aliases = (x.aliases || []).filter(Boolean);
  return `${x.key} [${x.kind}]: ${x.note}${aliases.length ? ` (also: ${aliases.join(', ')})` : ''}`;
}

// Aliases from the notes, for the rule-based reader: "gm" → "Grandmix".
export function noteAliases(notes) {
  const out = new Map();
  for (const x of notes) {
    for (const a of x.aliases || []) {
      const k = String(a).trim().toLowerCase();
      if (k.length >= 2 && k !== x.name.toLowerCase() && !out.has(k)) out.set(k, x.name);
    }
  }
  return out;
}
