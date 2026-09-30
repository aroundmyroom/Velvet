// Turns a credited artist string into the ordered list of names to try against
// Last.fm for similar-artist lookup: the exact credit first, then each
// collaboration part, then each half of a duo ("A & B"). The caller stops at
// the first name that returns results, so a real duo/group name ("Mel & Kim")
// is never split before it has been tried whole.
//
// A tag-writer's "featuring" shorthand that the split misses is not a cosmetic
// miss: the whole credit gets zero results, no part is ever tried, and Auto-DJ
// silently loses its similar-artist signal for that pick. "Fe." is the one
// seen live (Martin Solveig Fe. Roy Woods → nothing; 384 credits in the same
// library use it). "F." is deliberately not a separator — it is far more often
// an initial (George F. Zimmer).
const COLLAB_SEP = /\s+(?:feat\.?|ft\.?|fe\.?|featuring|vs\.?|pres\.?|presents?\b|\bx\b)\s+/i;
const DUO_SEP = /\s+(?:&|and)\s+/i;
// "05. Jax Jones Feat. Ina Wroldsen" — a track number leaked into the artist tag.
const TRACK_NO_PREFIX = /^\d{1,3}\.\s+/;

export function artistLookupCandidates(name) {
  const seen = new Set();
  const out = [];
  const add = v => {
    const s = String(v || '').trim();
    const key = s.toLowerCase();
    if (s && !seen.has(key)) { seen.add(key); out.push(s); }
  };
  const raw = String(name || '').trim();
  add(raw);
  const credit = raw.replace(TRACK_NO_PREFIX, '');
  add(credit);
  const collabParts = credit.split(COLLAB_SEP);
  if (collabParts.length > 1) for (const p of collabParts) add(p);
  for (const p of collabParts) {
    const duoParts = p.split(DUO_SEP);
    if (duoParts.length > 1) for (const d of duoParts) add(d);
  }
  return out;
}
