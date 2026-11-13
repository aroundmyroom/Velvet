// Ranks an artist's songs for Subsonic getTopSongs: plays in Velvet (all
// users — a household's shared popularity, the per-user counts are too sparse
// to rank by) blended with Last.fm's top tracks for the artist, plus a small
// bonus for what the requesting user starred or rated highly.

import { titleKey } from './title-key.js';

export { titleKey };

const W_PLAYS = 0.55;
const W_LASTFM = 0.35;
const W_USER = 0.10;
const LASTFM_DEPTH = 50;

function userScore(row) {
  if (row.starred) return 1;
  return row.rating ? Math.min(1, row.rating / 10) : 0;
}

/**
 * rows: getArtistSongsWithPlays rows; lastfm: [{ title, rank }].
 * One song per title (the most played copy, then the one the user rated
 * higher), best first. Without any plays or Last.fm data the
 * user's ratings and then album order decide.
 */
export function rankTopSongs(rows, lastfm, count) {
  const lfmRank = new Map();
  for (const t of lastfm || []) {
    const k = titleKey(t.title);
    if (k && !lfmRank.has(k)) lfmRank.set(k, t.rank);
  }
  const byTitle = new Map();
  for (const row of rows) {
    const k = titleKey(row.title) || `#${row.id}`;
    const prev = byTitle.get(k);
    if (!prev || (row.totalPlays || 0) > (prev.totalPlays || 0) ||
        ((row.totalPlays || 0) === (prev.totalPlays || 0) && userScore(row) > userScore(prev))) {
      byTitle.set(k, row);
    }
  }
  const maxPlays = Math.max(0, ...[...byTitle.values()].map(r => r.totalPlays || 0));
  const scored = [...byTitle.entries()].map(([k, row]) => {
    const rank = lfmRank.get(k);
    const lfm = rank == null ? 0 : Math.max(0, 1 - (rank - 1) / LASTFM_DEPTH);
    const plays = maxPlays > 0 ? (row.totalPlays || 0) / maxPlays : 0;
    return { row, score: W_PLAYS * plays + W_LASTFM * lfm + W_USER * userScore(row) };
  });
  scored.sort((a, b) =>
    b.score - a.score ||
    (b.row.totalPlays || 0) - (a.row.totalPlays || 0) ||
    (a.row.year || 9999) - (b.row.year || 9999) ||
    String(a.row.album || '').localeCompare(String(b.row.album || '')) ||
    (a.row.disk || 0) - (b.row.disk || 0) ||
    (a.row.track || 0) - (b.row.track || 0) ||
    a.row.id - b.row.id);
  return scored.slice(0, count).map(s => s.row);
}
