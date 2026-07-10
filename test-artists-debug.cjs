const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/home/velvet/save/db/velvet.sqlite');

// Check what _artistsInPrefixes would return for lemon
const vpath = 'Music';
const prefix = '12 inches A-Z/';
const escaped = prefix.replaceAll(/[%_\\]/g, '\\$&') + '%';
console.log('LIKE pattern:', escaped);

// How many distinct artists are in the 12-inches folder?
const direct = db.prepare(`SELECT COUNT(DISTINCT artist) as c FROM files WHERE vpath=? AND filepath LIKE ? ESCAPE '\\'`).get(vpath, escaped);
console.log('Direct distinct artists in 12-inches:', direct.c);

// What does the json_each join produce?
const joinCount = db.prepare(`
  SELECT COUNT(DISTINCT lower(an.artist_clean)) AS c
  FROM artists_normalized an, json_each(an.artist_raw_variants) AS je
  JOIN files f ON (f.artist = je.value OR f.album_artist = je.value)
  WHERE an.artist_clean != '' AND (f.vpath = ? AND f.filepath LIKE ? ESCAPE '\\')
`).get(vpath, escaped);
console.log('json_each join result count:', joinCount.c);

// Sample: what's in artist_raw_variants for a known 12-inches artist?
const sample12 = db.prepare(`SELECT DISTINCT artist FROM files WHERE vpath='Music' AND filepath LIKE '12 inches A-Z/%' LIMIT 5`).all();
console.log('Sample 12-inches artists from files:', sample12.map(r => r.artist));

for (const { artist } of sample12) {
  const an = db.prepare(`SELECT artist_clean, artist_raw_variants FROM artists_normalized WHERE artist_raw_variants LIKE ?`).get('%' + artist + '%');
  console.log('  in artists_normalized:', an ? `"${an.artist_clean}" variants: ${an.artist_raw_variants}` : 'NOT FOUND');
}

// Check if OR album_artist is the problem — how many distinct album_artists are in 12-inches?
const albumArtists = db.prepare(`SELECT COUNT(DISTINCT album_artist) as c FROM files WHERE vpath='Music' AND filepath LIKE '12 inches A-Z/%' AND album_artist IS NOT NULL`).get();
console.log('Distinct album_artists in 12-inches:', albumArtists.c);
