// "Hot Stuff (12" Version)", "Hot Stuff - 2004 Remaster", "I Feel Love (Radio Edit"
// → "hot stuff" / "i feel love": one key for every version of a song. A " - "
// suffix only counts as a version when it says so ("Artist - Title" tags stay whole).
export function titleKey(title) {
  return String(title || '').toLowerCase()
    .normalize('NFD').replaceAll(/[\u0300-\u036f]/g, '')
    .replace(/\s*[([].*$/, '')
    .replace(/\s+-\s+(?:.*\s)?(?:remaster(?:ed)?|mix|remix|edit|version|live|radio|extended|single|mono|stereo|demo)\b.*$/, '')
    .replaceAll(/[^a-z0-9]+/g, ' ')
    .trim();
}
