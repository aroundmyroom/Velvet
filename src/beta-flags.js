/**
 * Beta feature flags
 * Set to true to enable a feature that is not yet production-ready.
 */

// ML-based Smart Playlist generation (slot profiles + cosine similarity).
// Requires at least a few completed plays to build profiles.
// When false, all /api/v1/smartplaylist/* user routes return HTTP 501.
export const BETA_SMART_PLAYLIST = true;
