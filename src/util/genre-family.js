// Genre families for Auto-DJ mixing compatibility. A family is what the DJ
// scoring compares (electronic ↔ disco is a 0.7 transition, disco ↔ hard 0.05);
// the raw genre tag is far too fine-grained for that (2000+ distinct tags in
// a large library, a quarter of the files untagged).
//
// Three layers, most specific first:
//   1. admin-approved rule per (merged) genre tag
//   2. admin-approved rule per library folder — collections are often sorted
//      by folder ("Disco/…", "Labels/Strictly Rhythm/…") even when tags are
//      missing or wrong
//   3. keyword match on the tag (identical to _djGenreCat() in webapp/app.js,
//      the player's own fallback, so nothing changes until an admin approves
//      a rule)
import { splitRaw, toKey } from './genre-merge.js';

export const FAMILIES = ['electronic', 'disco', 'soft', 'ambient', 'hard', 'other'];
// 'ignore' = this tag or folder says nothing about the family (chart names,
// labels, "Mix", "Various"); the next layer decides.
export const RULE_FAMILIES = [...FAMILIES, 'ignore'];

// Same matrix as DJ_GENRE_CAT_COMPAT in webapp/app.js: how well two families
// sit next to each other in a set.
const FAMILY_COMPAT = {
  'electronic→disco': 0.7, 'electronic→ambient': 0.35, 'electronic→soft': 0.25, 'electronic→hard': 0.05,
  'disco→ambient': 0.15, 'disco→soft': 0.45, 'disco→hard': 0.05,
  'ambient→soft': 0.25, 'ambient→hard': 0.0,
  'soft→hard': 0.15,
};
export function familyCompat(a, b) {
  if (!a || !b) return 0.5;
  if (a === b) return 0.9;
  return FAMILY_COMPAT[`${a}→${b}`] ?? FAMILY_COMPAT[`${b}→${a}`] ?? 0.5;
}

export function keywordFamily(genre) {
  const g = String(genre || '').toLowerCase();
  if (!g.trim()) return null;
  if (/ambient|chillout|downtempo|new age/.test(g)) return 'ambient';
  if (/disco|funk|soul|motown/.test(g)) return 'disco';
  if (/electronic|techno|house|trance|dance|edm|synth|electro/.test(g)) return 'electronic';
  if (/hardcore|hardstyle|gabber/.test(g)) return 'hard';
  if (/pop|rock|indie|alternative|country|folk|r&b|rnb|jazz/.test(g)) return 'soft';
  return 'other';
}

function majority(families) {
  const votes = new Map();
  for (const f of families) if (f) votes.set(f, (votes.get(f) || 0) + 1);
  let best = null;
  for (const [f, n] of votes) if (!best || n > best[1]) best = [f, n];
  return best ? best[0] : null;
}

// Family of a multi-value tag ("house, trance, chillout"), one vote per part;
// ties go to the first part, which tag writers use for the primary genre.
export function partsFamily(genre) {
  if (!genre) return null;
  return majority(splitRaw(String(genre)).map(keywordFamily));
}

export function folderKey(vpath, filepath, depth) {
  return `${vpath}/${filepath.split('/').slice(0, depth).join('/')}`;
}

// Per-folder tag statistics used to propose folder rules: how many files,
// how many carry a tag, and which family those tags point to.
// Per-folder statistics used to propose folder rules: how many files, how
// many carry a tag and which family those tags point to — plus what else the
// files say about the folder: the tempo of the analysed ones, the artists that
// fill it, and a few file names. Rows may carry bpm, artist and title.
export function folderStats(rows, { minFiles = 100, maxDepth = 2, samples = 4 } = {}) {
  const stats = new Map();
  for (const r of rows) {
    const parts = r.filepath.split('/');
    const fam = partsFamily(r.genre);
    for (let d = 1; d <= maxDepth && d < parts.length; d++) {
      const key = folderKey(r.vpath, r.filepath, d);
      let s = stats.get(key);
      if (!s) { s = { key, depth: d, n: 0, tagged: 0, families: {}, bpms: [], artists: new Map(), samples: [] }; stats.set(key, s); }
      s.n++;
      if (fam) { s.tagged++; s.families[fam] = (s.families[fam] || 0) + 1; }
      if (r.bpm > 0) s.bpms.push(Number(r.bpm));
      if (r.artist) s.artists.set(r.artist, (s.artists.get(r.artist) || 0) + 1);
      if (s.samples.length < samples * 8 && (s.n % 7 === 1)) s.samples.push(r.title || parts.at(-1).replace(/\.[^.]+$/, ''));
    }
  }
  return [...stats.values()].filter(s => s.n >= minFiles).map(s => {
    const ranked = Object.entries(s.families).filter(([f]) => f !== 'other').sort((a, b) => b[1] - a[1]);
    const top = ranked[0] || null;
    const share = top && s.tagged ? top[1] / s.tagged : 0;
    const sorted = s.bpms.sort((a, b) => a - b);
    const { bpms, artists, samples: all, ...rest } = s;
    return {
      ...rest, top: top ? top[0] : null, share: Math.round(share * 100) / 100, clear: !!top && s.tagged >= 30 && share >= 0.65,
      bpmMedian: sorted.length ? Math.round(sorted[Math.floor(sorted.length / 2)]) : null, bpmN: sorted.length,
      topArtists: [...artists.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([a]) => a),
      samples: all.slice(0, samples),
    };
  }).sort((a, b) => b.n - a.n);
}

// genreRules: Map<toKey(display genre), family>; folderRules: [{ key, family }]
// with key as produced by folderKey(); rawMap: display genre → Set of raw tag
// strings, from mergeGenreRows(), so a tiny tag folded into a bigger genre
// follows that genre's rule.
export function createFamilyResolver({ genreRules = new Map(), folderRules = [], rawMap = new Map() } = {}) {
  const rawToKeys = new Map();
  for (const [display, raws] of rawMap) {
    for (const raw of raws) {
      if (!rawToKeys.has(raw)) rawToKeys.set(raw, []);
      rawToKeys.get(raw).push(toKey(display));
    }
  }
  const folders = folderRules
    .map(r => ({ prefix: r.key.replace(/\/+$/, '') + '/', family: r.family }))
    .sort((a, b) => b.prefix.length - a.prefix.length);

  function fromTag(raw) {
    if (!raw) return null;
    const keys = [...new Set([...splitRaw(String(raw)).map(toKey), ...(rawToKeys.get(raw) || [])])];
    return majority(keys.map(k => genreRules.get(k)));
  }
  function fromFolder(vpath, filepath) {
    const full = `${vpath}/${filepath}`;
    return folders.find(r => full.startsWith(r.prefix))?.family ?? null;
  }
  function resolve(row) {
    const tag = fromTag(row.genre);
    if (tag && tag !== 'ignore') return { family: tag, source: 'genre' };
    const folder = fromFolder(row.vpath, row.filepath);
    if (folder && folder !== 'ignore') return { family: folder, source: 'folder' };
    const kw = keywordFamily(row.genre);
    return kw ? { family: kw, source: 'keyword' } : null;
  }
  return { active: genreRules.size > 0 || folders.length > 0, resolve, fromTag, fromFolder };
}
