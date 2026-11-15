/**
 * Resolve the best available ReplayGain gain value for a DB row.
 * Priority (track mode): rg_track_gain_db → replaygainTrackDb → null
 * Priority (album mode): rg_album_gain_db → rg_track_gain_db → replaygainTrackDb → null
 * Returns { gain (dB), peak (dBTP or null), src } or null if no data.
 */
export function resolveTrackGain(row, mode) {
  if (!row) return null;
  if (mode === 'album' && row.rg_album_gain_db != null) {
    return { gain: row.rg_album_gain_db, peak: row.rg_album_peak_dbfs ?? null, src: 'measured_album' };
  }
  if (row.rg_track_gain_db != null) {
    return { gain: row.rg_track_gain_db, peak: row.rg_true_peak_dbfs ?? null, src: 'measured' };
  }
  if (row.replaygainTrackDb != null) {
    return { gain: row.replaygainTrackDb, peak: null, src: 'tag' };
  }
  return null;
}

export function rgGainDb(row, { mode = 'track', preamp = 0, clip = true, peakFallback = null } = {}) {
  const rg = resolveTrackGain(row, mode === 'album' ? 'album' : 'track');
  if (rg?.gain == null) return null;
  let gain = Number(rg.gain) + (Number(preamp) || 0);
  const peak = rg.peak ?? peakFallback;
  if (clip && peak != null) {
    const headroom = 0 - Number(peak);
    if (gain > headroom) gain = headroom;
  }
  return Number.isFinite(gain) ? gain : null;
}
