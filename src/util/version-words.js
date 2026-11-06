// Version words: kinds of version a listener can leave out ("geen acapella's",
// "no live versions"), each with every spelling it goes by in titles and file
// names. "Acapella" alone misses "Accapella Version", "a cappella" and
// "Percapella"; the family catches them all. The admin can edit the list
// (AI-assist → Version words); an edited list is kept as it is — the defaults
// below apply only while nothing is stored.
import Joi from 'joi';

export const DEFAULT_VERSION_WORDS = Object.freeze([
  {
    name: 'acapella',
    says: ['acapella', 'acapellas', 'a capella', 'a cappella', 'acappella', 'accapella', 'vocals only', 'vocal only', 'acapella versions'],
    // never "cappel" alone: that is the band Cappella as well
    match: ['acapel', 'acappel', 'accapel', 'a capel', 'a cappel', 'percapel', 'percappel', 'dubcapel', 'vocals only', 'vocal only'],
  },
  {
    name: 'instrumental',
    says: ['instrumental', 'instrumentals', 'instrumentaal', 'instrumentale', 'instrumental versions'],
    match: ['instrumental', 'instrumentaal', '(instr', '[instr', 'instr.', '(inst)', '[inst]', 'inst.)'],
  },
  {
    name: 'karaoke',
    says: ['karaoke', 'backing tracks', 'backing track', 'playback'],
    match: ['karaoke', 'backing track', '(playback'],
  },
  {
    name: 'remix',
    says: ['remix', 'remixes', 'remixen', 'rmx', 're-mix'],
    // never "rmx" alone: "YRMX2024", "RMXD Contest"
    match: ['remix', 're-mix', '(rmx', '[rmx', 'rmx)', 'rmx]'],
  },
  {
    name: 'dub',
    says: ['dub', 'dubs', 'dub mixes', 'dub versions', 'dubversies'],
    match: ['(dub', '[dub', 'dub)', 'dub]', 'dub mix', 'dub version'],
  },
  {
    name: 'live',
    says: ['live', 'live versions', 'live versie', 'live versies', 'liveversies', 'live recordings', 'live opnames'],
    // never "live" alone: "Alive", "Deliver", "Live It Up"
    match: ['(live', '[live', '- live', 'live version', 'live recording', 'live at', 'in concert', 'unplugged'],
  },
  {
    name: 'radio edit',
    says: ['radio edit', 'radio edits', 'radio version', 'radio versions', 'radio versies', 'single versions', '7 inch', '7"', '7-inch'],
    match: ['radio edit', 'radio version', 'radio mix', 'single edit', 'single version', '7"', '7 inch', '7-inch'],
  },
  {
    name: 'megamix',
    says: ['megamix', 'megamixes', 'medley', 'medleys', 'mega mix'],
    match: ['megamix', 'mega mix', 'medley'],
  },
]);

const word = Joi.string().trim().lowercase().min(2).max(60);
export const VERSION_WORDS_SCHEMA = Joi.array().max(40).items(Joi.object({
  name: word.required(),
  says: Joi.array().items(word).max(40).default([]),
  match: Joi.array().items(word).min(1).max(40).required(),
}));

const norm = s => String(s || '').toLowerCase().replaceAll('’', "'").replaceAll(/\s+/g, ' ').trim();

// The stored list when the admin made one, else the defaults.
export function versionFamilies(stored) {
  return Array.isArray(stored) && stored.length ? stored : DEFAULT_VERSION_WORDS;
}

// The family a listener's word belongs to: its name, a way of saying it, or a
// word that holds one of its spellings ("acapella's" holds "acapel").
export function familyOf(text, families = DEFAULT_VERSION_WORDS) {
  const w = norm(text).replace(/'s$/, '');
  if (w.length < 2) return null;
  return families.find(f => f.name === w || f.says.includes(w))
    || families.find(f => f.match.some(m => m.length >= 4 && w.includes(m)))
    || null;
}

// Words as the library writes them: a family word becomes all its spellings;
// any other word stays as it is.
export function expandVersionWords(words, families = DEFAULT_VERSION_WORDS) {
  const out = new Set();
  for (const raw of words || []) {
    const f = familyOf(raw, families);
    if (f) for (const m of f.match) out.add(norm(m));
    else if (norm(raw).length >= 2) out.add(norm(raw));
  }
  return [...out];
}
