// Charts in the library: a folder whose file names start with the position
// ("001 - Jaydee - Plastic Dreams", "12. The O'Jays - I Love Music"). "The top
// 10 of the House Top 1000" is those positions in chart order — a fact read
// from the file names, never a taste.
const POSITION = /^(\d{1,4})\^?(?:[\s.\-–—_)]|$)/;
// "Top 700", "Hitlijst", "Billboard": a compilation with 40 numbered tracks
// and a year in its name is not a chart
const NAME_HINT = /\b(top ?\d*|charts?|hitlijst|jaarlijst|lijst|countdown|hitparade|billboard|hot ?100)\b/i;
const STOP = new Set(['the', 'de', 'het', 'van', 'of', 'on', 'complete', 'all', 'time', 'cd', 'youtube', 'a', 'een', 'en', 'and', 'from', 'uit', 'in', 'der', 'die', 'das', 'la', 'le', 'les']);

export function chartPosition(filepath) {
  const fp = String(filepath || '');
  const m = fp.slice(fp.lastIndexOf('/') + 1).match(POSITION);
  return m ? Number(m[1]) : null;
}

// rows: { vpath, filepath }. A folder is a chart when nearly all of its files
// are numbered, the numbers are dense and start near 1, and its name says so
// (or it is big). The shallowest qualifying folder wins over its sub-folders,
// so "Housetop1000" is one chart, not eleven.
export function detectCharts(rows, { minFiles = 30, maxDepth = 3, max = 150 } = {}) {
  const stats = new Map();
  for (const r of rows) {
    const parts = String(r.filepath).split('/');
    const pos = chartPosition(r.filepath);
    for (let d = 1; d <= maxDepth && d < parts.length; d++) {
      const folder = parts.slice(0, d).join('/');
      const key = `${r.vpath}/${folder}`;
      let s = stats.get(key);
      if (!s) {
        s = { key, vpath: r.vpath, folder, name: parts[d - 1], depth: d, n: 0, numbered: 0, positions: new Set(), min: Infinity, max: 0 };
        stats.set(key, s);
      }
      s.n++;
      if (pos == null) continue;
      s.numbered++;
      s.positions.add(pos);
      s.min = Math.min(s.min, pos);
      s.max = Math.max(s.max, pos);
    }
  }
  const ok = [...stats.values()]
    .filter(s => s.n >= minFiles && s.numbered >= s.n * 0.8 && s.positions.size >= s.numbered * 0.75 && s.min <= 5 && s.max >= 20
      && s.positions.size >= s.max * 0.5 && (NAME_HINT.test(s.name) || s.n >= 150))
    .sort((a, b) => a.depth - b.depth);
  // a folder that is only the container of one chart ("Disco/-= Top 700 =-"
  // is all the numbered files of "Disco") is not the chart itself
  const container = s => ok.some(d => d.key.startsWith(s.key + '/') && d.numbered >= s.numbered * 0.9);
  const kept = [];
  for (const s of ok) if (!container(s) && !kept.some(k => s.key.startsWith(k.key + '/'))) kept.push(s);
  return kept
    .map(s => ({ vpath: s.vpath, folder: s.folder, name: s.name, label: s.key, from: s.min, to: s.max, n: s.n, positions: s.positions.size }))
    .sort((a, b) => b.n - a.n)
    .slice(0, max);
}

export function chartTokens(text) {
  return String(text || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(t => t && !STOP.has(t));
}
const isYearish = t => /^(19|20)\d{2}$|^\d0s$|^'\d0$/.test(t);

// The chart a text names, by its tokens: every word and number of the chart's
// own folder name must appear ("top 40 van 1983" names "Complete Top 40 Van
// 1983"); a year or decade in the chart name is only required when the text
// mentions one at all, so "the Kink Top 500" finds "Kink Top 500 80s 2022"
// while "top 40 van 1983" does not find 1984. Run-together names match as
// one word ("house top 1000" ↔ "Housetop1000"). Ties stay unresolved.
export function matchChart(text, charts) {
  const tokens = chartTokens(text);
  if (!tokens.length || !charts?.length) return null;
  const set = new Set(tokens);
  const joined = tokens.join('');
  const textHasYear = tokens.some(isYearish);
  let best = null, bestScore = 0, tie = false;
  for (const c of charts) {
    const own = chartTokens(c.name);
    if (!own.length) continue;
    const required = own.filter(t => !isYearish(t)), years = own.filter(isYearish);
    const wordsHit = required.every(t => set.has(t)) || joined.includes(required.join(''));
    if (!wordsHit) continue;
    if (years.length && textHasYear && !years.some(y => set.has(y))) continue;
    const score = required.length + (years.some(y => set.has(y)) ? 1 : 0);
    if (score > bestScore) { best = c; bestScore = score; tie = false; }
    else if (score === bestScore) tie = true;
  }
  return tie ? null : best;
}

const escapeRe = s => s.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
const wordRe = w => new RegExp(String.raw`(?<![\p{L}\p{N}])${escapeRe(w)}(?![\p{L}\p{N}])`, 'gu');

// The chart's own words taken out of a request, so "house", "40" or "1983"
// in the chart's name are not read as a genre, a count or an era afterwards.
// A run-together name ("Housetop1000") also removes the words it is made of.
export function stripChartWords(lower, chart) {
  let out = lower;
  const own = chartTokens(chart.name);
  for (const tk of own) out = out.replaceAll(wordRe(tk), ' ');
  const target = own.filter(t => !isYearish(t)).join('');
  const words = chartTokens(out);
  for (let i = 0; i < words.length && target; i++) {
    let run = '';
    for (let j = i; j < words.length && run.length < target.length; j++) {
      run += words[j];
      if (run !== target) continue;
      const phrase = new RegExp(String.raw`(?<![\p{L}\p{N}])${words.slice(i, j + 1).map(escapeRe).join(String.raw`[^\p{L}\p{N}]+`)}(?![\p{L}\p{N}])`, 'u');
      return out.replace(phrase, ' ');
    }
  }
  return out;
}

const norm = s => String(s || '').toLowerCase().replaceAll(/[^\p{L}\p{N}]+/gu, '');

// The chart a brief names: exact label, folder or name first, then the
// token match above.
export function findChart(name, charts) {
  if (!name || !charts?.length) return null;
  const k = norm(name);
  return charts.find(c => norm(c.label) === k || norm(c.folder) === k || norm(c.name) === k)
    || charts.find(c => k.endsWith(norm(c.folder)) || norm(c.label).endsWith(k))
    || matchChart(name, charts);
}

// Positions the text asks for: "top 10" → 1–10, "number 1" → 1–1,
// "positions 50 to 60" → 50–60; nothing → the whole chart.
export function parseChartRange(lower) {
  let m = lower.match(/\b(?:positions?|posities?|plaats(?:en)?|plek(?:ken)?|nummers?|numbers?|places?)\s*(\d{1,4})\s*(?:-|–|to|tot|t\/m|through|until)\s*(\d{1,4})\b/)
    || lower.match(/\b(?:van|from)\s*(?:plaats|plek|positie|position|nummer|number)?\s*(\d{1,4})\s*(?:tot(?: en met)?|t\/m|to|through|until)\s*(?:plaats|plek|positie|position|nummer|number)?\s*(\d{1,4})\b/);
  if (m) return { from: Number(m[1]), to: Number(m[2]) };
  // "number 1 of the Top 40 of 1983": one position, before the chart's own "top 40"
  m = lower.match(/(?:\b(?:number|nummer|no\.?|nr\.?|plaats|plek|positie|position|place)|#)\s*(\d{1,4})\b/);
  if (m) return { from: Number(m[1]), to: Number(m[1]) };
  if (/\b(number one|nummer één|nummer een)\b/.test(lower)) return { from: 1, to: 1 };
  // "the top 10 of the House Top 1000": the smaller top is the one asked for
  const tops = [...lower.matchAll(/\btop\s*(\d{1,4})\b/g)].map(x => Number(x[1]));
  if (tops.length) return { from: 1, to: Math.min(...tops) };
  return { from: null, to: null };
}
