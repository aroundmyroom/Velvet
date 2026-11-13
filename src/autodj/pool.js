// Auto-DJ candidate pool: the hard scope (collections, rating, duration, the
// similar-artist list, the artist cooldown) and nothing else — BPM, key and
// genre are scored, never filtered. Shared by POST /api/v1/db/random-songs
// (returnAll, the browser Auto-DJ) and the server-side radio (src/autodj/radio.js).

// Bounds the payload / scoring cost on very large similar-artist pools; not a
// quality filter.
export const RANDOM_SONGS_BATCH_CAP = 500;
// Sampled per similar artist first, so an artist with 80 tracks in the library
// cannot crowd thinly represented similar artists out of the scored pool.
export const PER_ARTIST_SAMPLE_CAP = 10;

export function sampleUpTo(arr, n, rng = Math.random) {
  if (arr.length <= n) return arr;
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

/**
 * fetchRows(opts) returns the rows matching the scope: baseOpts plus
 * `artists` (similar-artist variants) and/or `ignoreArtists` (cooldown list).
 * Falls back progressively (drop the cooldown, then the artist scope) so a
 * small similar-artist pool is never abandoned and an empty one still yields
 * a same-scope pool to score by BPM/genre/harmonic. Returns null only when
 * the scope has no songs at all.
 */
export function batchCandidatePool(fetchRows, body, rng = Math.random) {
  const hasArtistFilter = Array.isArray(body.artists) && body.artists.length > 0;
  const baseOpts = {
    ignoreVPaths: body.ignoreVPaths,
    minRating: body.minRating,
    filepathPrefix: body.filepathPrefix || null,
    excludeFilepathPrefixes: body.excludeFilepathPrefixes,
    minDuration: body.minDuration,
    maxDuration: body.maxDuration,
    allowUnknownDuration: !!body.allowUnknownDuration,
  };
  const ignoreArtists = Array.isArray(body.ignoreArtists) ? body.ignoreArtists : undefined;

  let batch = fetchRows({
    ...baseOpts,
    artists: hasArtistFilter ? body.artists : undefined,
    ignoreArtists,
  });
  let balanceByArtist = hasArtistFilter;
  // One line for the server log: which scope the pool came from and which
  // fallback widened it.
  const note = [hasArtistFilter ? `similar filter: ${body.artists.length} artists` : 'no similar filter'];
  if (hasArtistFilter && batch.length === 0 && ignoreArtists?.length > 0) {
    batch = fetchRows({ ...baseOpts, artists: body.artists });
    note.push(`cooldown list (${ignoreArtists.length}) dropped — every similar artist was in it`);
  }
  if (hasArtistFilter && batch.length === 0) {
    batch = fetchRows({ ...baseOpts, ignoreArtists });
    balanceByArtist = false;
    note.push('similar filter dropped — none of those artists in the Auto-DJ scope');
  }
  if (batch.length === 0) return null;
  const inScope = batch.length;

  if (balanceByArtist) {
    const byArtist = new Map();
    for (const row of batch) {
      const key = (row.artist || '').toLowerCase();
      if (!byArtist.has(key)) byArtist.set(key, []);
      byArtist.get(key).push(row);
    }
    batch = [...byArtist.values()].flatMap(songs => sampleUpTo(songs, PER_ARTIST_SAMPLE_CAP, rng));
  }

  const songs = batch.length > RANDOM_SONGS_BATCH_CAP ? sampleUpTo(batch, RANDOM_SONGS_BATCH_CAP, rng) : batch;
  note.push(`${inScope} in scope${balanceByArtist ? `, ${batch.length} after per-artist sampling` : ''}${songs.length < batch.length ? `, capped at ${songs.length}` : ''}`);
  return { songs, note: note.join('; ') };
}
