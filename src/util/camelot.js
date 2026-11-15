export const CAMELOT = {
  'Ab minor': '1A', 'G# minor': '1A', 'B major': '1B',
  'Eb minor': '2A', 'D# minor': '2A', 'F# major': '2B', 'Gb major': '2B',
  'Bb minor': '3A', 'A# minor': '3A', 'Db major': '3B', 'C# major': '3B',
  'F minor': '4A', 'Ab major': '4B', 'G# major': '4B',
  'C minor': '5A', 'Eb major': '5B', 'D# major': '5B',
  'G minor': '6A', 'Bb major': '6B', 'A# major': '6B',
  'D minor': '7A', 'F major': '7B',
  'A minor': '8A', 'C major': '8B',
  'E minor': '9A', 'G major': '9B',
  'B minor': '10A', 'D major': '10B',
  'F# minor': '11A', 'A major': '11B',
  'C# minor': '12A', 'E major': '12B',
};

export const CAMELOT_TO_KEYS = {};
for (const [key, code] of Object.entries(CAMELOT)) {
  if (!CAMELOT_TO_KEYS[code]) CAMELOT_TO_KEYS[code] = [];
  CAMELOT_TO_KEYS[code].push(key);
}

export function toCamelot(musicalKey) {
  if (!musicalKey) return null;
  return CAMELOT[musicalKey] ?? null;
}

// Same letter one step round the wheel (12 wraps to 1), or same number with the
// other letter. No diagonal moves, unlike camelotNeighbours in autodj/scoring.js.
export function camelotCompat(k1, k2) {
  const c1 = toCamelot(k1), c2 = toCamelot(k2);
  if (!c1 || !c2) return k1 === k2;
  if (c1 === c2) return true;
  const n1 = Number.parseInt(c1, 10), n2 = Number.parseInt(c2, 10);
  const t1 = c1.slice(-1), t2 = c2.slice(-1);
  const d = Math.abs(n1 - n2);
  return (t1 === t2 && (d <= 1 || d === 11)) || (n1 === n2 && t1 !== t2);
}
