import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';

/**
 * ssrf-check.js
 *
 * Shared SSRF guard used by radio.js, radio-recorder.js, radio-scheduler.js,
 * and podcasts.js.  Returns true if the hostname resolves to a private /
 * loopback / link-local address that must be blocked.
 *
 * Covers:
 *   IPv4  loopback      127.x.x.x
 *   IPv4  private       10.x, 172.16-31.x, 192.168.x
 *   IPv4  link-local    169.254.x.x  (AWS metadata, APIPA)
 *   IPv6  loopback      ::1
 *   IPv6  unspecified   ::
 *   IPv6  ULA           fc00::/7  (fc and fd prefixes)
 *   IPv6  link-local    fe80::/10 (fe8x–febx)
 *   IPv4-mapped IPv6    ::ffff:a.b.c.d  (recurses to IPv4 check)
 */
export function isPrivateHost(hostname) {
  // URL.hostname keeps the brackets around IPv6 literals ("[::1]")
  const h = String(hostname).toLowerCase().replace(/^\[(.*)\]$/, '$1');
  // IPv4 private ranges + loopback ("this network" 0.0.0.0/8 reaches localhost on Linux)
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h.startsWith('0.')) return true;
  if (h.startsWith('127.') || h.startsWith('10.')) return true;
  if (h.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  // IPv4 link-local / APIPA (169.254.x.x) — includes AWS/GCP cloud metadata endpoint
  if (h.startsWith('169.254.')) return true;
  // IPv6 loopback + unspecified
  if (h === '::1' || h === '::') return true;
  // IPv6 ULA (fc00::/7 — fc and fd prefixes)
  if (h.startsWith('fc') || h.startsWith('fd')) return true;
  // IPv6 link-local (fe80::/10 — second hex digit is 8, 9, a, or b)
  if (/^fe[89ab]/.test(h)) return true;
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) — recurse with the v4 portion
  const v4mapped = h.match(/^::ffff:((\d+\.\d+\.\d+\.\d+))$/);
  if (v4mapped) return isPrivateHost(v4mapped[1]);
  return false;
}

/**
 * dns.lookup replacement for http(s).request: resolves every address and fails
 * if any of them is private, so the socket connects to exactly the address that
 * was checked (no DNS-rebinding window between check and connect).
 */
export function safeLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const blocked = addresses.find(a => isPrivateHost(a.address));
    if (blocked) return callback(Object.assign(new Error(`${hostname} resolves to a private address`), { code: 'ESSRF' }));
    if (options?.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
}

export async function resolvesToPrivate(hostname) {
  if (isPrivateHost(hostname)) return true;
  try {
    const addresses = await dns.promises.lookup(String(hostname).replace(/^\[(.*)\]$/, '$1'), { all: true });
    return addresses.some(a => isPrivateHost(a.address));
  } catch {
    return false;
  }
}

/**
 * fetch() that refuses private destinations on every redirect hop. Same return
 * value as fetch(); redirects are followed manually (max 5).
 */
export async function safeFetch(url, options = {}) {
  let current = String(url);
  for (let hop = 0; hop <= 5; hop++) {
    const parsed = new URL(current);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('URL must be http or https');
    if (await resolvesToPrivate(parsed.hostname)) throw new Error('URL resolves to a private address');
    const r = await fetch(current, { ...options, redirect: 'manual' });
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
      current = new URL(r.headers.get('location'), current).toString();
      await r.body?.cancel().catch(() => {});
      continue;
    }
    return r;
  }
  throw new Error('Too many redirects');
}

function _requestBufferOnce(targetUrl, options = {}) {
  const {
    headers = {},
    timeout = 20000,
    maxContentLength = 20 * 1024 * 1024,
  } = options;

  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch {
      reject(new Error('Invalid URL'));
      return;
    }

    const useLib = parsed.protocol === 'https:' ? https : http;
    const req = useLib.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers,
      lookup: safeLookup,
    }, res => {
      const chunks = [];
      let total = 0;

      res.on('data', chunk => {
        total += chunk.length;
        if (total > maxContentLength) {
          req.destroy(new Error('Response exceeds maximum allowed size'));
          return;
        }
        chunks.push(chunk);
      });

      res.on('end', () => {
        resolve({
          status: res.statusCode || 0,
          headers: res.headers || {},
          data: Buffer.concat(chunks),
        });
      });

      res.on('error', reject);
    });

    req.setTimeout(timeout, () => {
      req.destroy(new Error(`Timeout after ${timeout}ms`));
    });
    req.on('error', reject);
    req.end();
  });
}

export async function fetchPublicUrlBuffer(url, options = {}) {
  const {
    headers = {},
    timeout = 20000,
    maxContentLength = 20 * 1024 * 1024,
    maxRedirects = 5,
    allowedHosts = null,
  } = options;

  let currentUrl = String(url || '');
  for (let hop = 0; hop <= maxRedirects; hop++) {
    let parsedUrl;
    try {
      parsedUrl = new URL(currentUrl);
    } catch {
      throw new Error('Invalid URL');
    }
    if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
      throw new Error('URL must be http or https');
    }
    if (allowedHosts && !allowedHosts.has(parsedUrl.hostname.toLowerCase())) {
      throw new Error('URL host not allowed');
    }
    if (isPrivateHost(parsedUrl.hostname)) {
      throw new Error('URL resolves to a private address');
    }

    const resp = await _requestBufferOnce(currentUrl, {
      headers,
      timeout,
      maxContentLength,
    });

    if (resp.status >= 300 && resp.status < 400 && resp.headers.location) {
      currentUrl = new URL(resp.headers.location, currentUrl).toString();
      continue;
    }

    if (resp.status !== 200) {
      const err = new Error(`HTTP ${resp.status}`);
      err.httpStatus = resp.status;
      throw err;
    }
    return resp.data;
  }

  throw new Error('Too many redirects');
}

export async function fetchPublicJson(url, options = {}) {
  const buf = await fetchPublicUrlBuffer(url, options);
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new Error('Invalid JSON response');
  }
}
