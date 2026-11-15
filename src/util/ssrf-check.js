import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import { Readable, Transform, pipeline } from 'node:stream';

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
// Only IP literals are judged by their digits: a name such as fdroid.org or
// 10.example.com is public until its DNS answers say otherwise
// (resolvesToPrivate / safeLookup check those).
export function isPrivateHost(hostname) {
  // URL.hostname keeps the brackets around IPv6 literals ("[::1]")
  const h = String(hostname).toLowerCase().replace(/^\[(.*)\]$/, '$1');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  const kind = net.isIP(h);
  if (kind === 4) return _isPrivateV4(h);
  if (kind === 6) return _isPrivateV6(h);
  return false;
}

function _isPrivateV4(h) {
  // "this network" 0.0.0.0/8 reaches localhost on Linux
  if (h.startsWith('0.') || h.startsWith('127.') || h.startsWith('10.')) return true;
  if (h.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  // link-local / APIPA, includes the AWS/GCP cloud metadata endpoint
  return h.startsWith('169.254.');
}

function _isPrivateV6(raw) {
  // Canonical form: "0:0::1" → "::1", "::ffff:127.0.0.1" → "::ffff:7f00:1"
  const h = new URL(`http://[${raw}]/`).hostname.slice(1, -1);
  if (h === '::1' || h === '::') return true;
  const mapped = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mapped) {
    const hi = Number.parseInt(mapped[1], 16);
    const lo = Number.parseInt(mapped[2], 16);
    return _isPrivateV4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  const first = h.startsWith('::') ? 0 : Number.parseInt(h.split(':')[0], 16);
  // ULA fc00::/7 and link-local fe80::/10
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
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

// Redirect targets are checked here (callers check the first URL): safeLookup
// guards DNS names, but Node never calls lookup for an IP literal, so a
// redirect to http://127.0.0.1/ needs this explicit check.
export function resolveStreamUrl(location, base) {
  let parsed;
  try { parsed = new URL(location, base); } catch { throw new Error('Bad stream URL or redirect'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Stream URL must be http or https');
  if (base && isPrivateHost(parsed.hostname)) throw new Error('SSRF protection: private/loopback addresses not allowed');
  return parsed;
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

const NULL_BODY_STATUS = new Set([204, 205, 304]);

const SAFE_FETCH_MAX_BYTES = 20 * 1024 * 1024;
const SAFE_FETCH_TIMEOUT_MS = 30_000;

function _tooLarge(maxBytes) {
  return Object.assign(new Error(`Response is larger than ${maxBytes} bytes`), { code: 'ETOOLARGE' });
}

// One GET over node:http(s) with safeLookup, so the socket connects to exactly
// the address that was checked. Answers with a fetch() Response whose body
// errors once it passes maxBytes.
function _fetchOnce(url, { headers = {}, signal, maxBytes }) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(url, { method: 'GET', headers, signal, lookup: safeLookup }, res => {
      const h = new Headers();
      for (let i = 0; i < res.rawHeaders.length; i += 2) h.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
      const init = { status: res.statusCode, statusText: res.statusMessage, headers: h };
      if (NULL_BODY_STATUS.has(res.statusCode)) {
        res.resume();
        return resolve(new Response(null, init));
      }
      if (Number(res.headers['content-length']) > maxBytes) {
        req.destroy();
        return reject(_tooLarge(maxBytes));
      }
      let seen = 0;
      const counted = new Transform({
        transform(chunk, _enc, cb) {
          seen += chunk.length;
          cb(seen > maxBytes ? _tooLarge(maxBytes) : null, chunk);
        },
      });
      pipeline(res, counted, err => { if (err) req.destroy(); });
      resolve(new Response(Readable.toWeb(counted), init));
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * GET that refuses private destinations on every redirect hop, including
 * names whose DNS answer changes between check and connect. Returns a fetch()
 * Response; redirects are followed manually (max 5).
 * Options: headers, signal, maxBytes (body cap, enforced while streaming) and
 * timeoutMs (covers the whole exchange, body included; 0 = none).
 */
function _requestOptions({ headers, signal, maxBytes = SAFE_FETCH_MAX_BYTES, timeoutMs = SAFE_FETCH_TIMEOUT_MS }) {
  const signals = [signal, timeoutMs ? AbortSignal.timeout(timeoutMs) : null].filter(Boolean);
  return { headers, maxBytes, signal: signals.length ? AbortSignal.any(signals) : undefined };
}

export async function safeFetch(url, options = {}) {
  const reqOptions = _requestOptions(options);
  let current = String(url);
  for (let hop = 0; hop <= 5; hop++) {
    const parsed = new URL(current);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('URL must be http or https');
    if (isPrivateHost(parsed.hostname)) throw new Error('URL resolves to a private address');
    let r;
    try {
      r = await _fetchOnce(parsed, reqOptions);
    } catch (err) {
      if (err.code === 'ESSRF') throw new Error('URL resolves to a private address');
      throw err;
    }
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
