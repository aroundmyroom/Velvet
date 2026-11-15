const REPO_URL = 'https://github.com/aroundmyroom/Velvet';

export const DISCOGS_USER_AGENT = `Velvet/dev +${REPO_URL}`;

export function discogsHeaders(discogsCfg) {
  const { apiKey, apiSecret, userAgentTag } = discogsCfg || {};
  if (!apiKey || !apiSecret) return null;
  return {
    'User-Agent': userAgentTag ? `Velvet/dev/${userAgentTag} +${REPO_URL}` : DISCOGS_USER_AGENT,
    'Authorization': `Discogs key=${apiKey}, secret=${apiSecret}`,
  };
}
