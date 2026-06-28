export function chooseEmbeddedAlbumArt(pictures = []) {
  const picType = p => String(p?.type ?? '').toLowerCase().trim();
  const isArtistType = p => {
    const t = picType(p);
    return t === 'artist' ||
      t === 'lead artist/lead performer/soloist' ||
      t === 'artist/performer' ||
      t === 'band/orchestra' ||
      t === 'band/artist logotype' ||
      t === 'artist/performer logotype';
  };

  const nonArtistPics = pictures.filter(p => p?.data && !isArtistType(p));
  return nonArtistPics.find(p => picType(p) === 'cover (front)') || nonArtistPics[0] || null;
}