/**
 * bootstrap-helpers.js
 *
 * Shared HTTP download and checksum helpers used by ffmpeg-bootstrap.js,
 * fpcalc-bootstrap.js, and rsgain-bootstrap.js.
 *
 * Each bootstrap file passes its own User-Agent tag so GitHub/CDNs can
 * identify the caller.
 */

import https from 'node:https';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';

const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 20_000;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 4;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function backoffMs(attempt) {
  // 1s, 2s, 4s (+ small jitter)
  const base = 1000 * (2 ** (attempt - 1));
  const jitter = Math.floor(Math.random() * 250);
  return base + jitter;
}

function resolveRedirect(fromUrl, location) {
  const next = new URL(location, fromUrl);
  if (next.protocol !== 'https:') {
    throw new Error(`Refusing insecure redirect to ${next.protocol}//`);
  }
  return next.toString();
}

/**
 * Download a URL to an in-memory Buffer (for small files like checksums/manifests).
 * Follows HTTP redirects automatically.
 * @param {string} url
 * @param {string} userAgent
 * @returns {Promise<Buffer>}
 */
export async function downloadToBuffer(url, userAgent) {
  const _attemptOnce = (requestUrl) => new Promise((resolve, reject) => {
    const follow = (u, redirects = 0) => {
      if (redirects > MAX_REDIRECTS) {
        return reject(new Error(`Too many redirects downloading ${url}`));
      }

      let req;
      try {
        req = https.get(u, { headers: { 'User-Agent': userAgent } }, res => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            let next;
            try {
              next = resolveRedirect(u, res.headers.location);
            } catch (e) {
              return reject(e);
            }
            return follow(next, redirects + 1);
          }
          if (res.statusCode !== 200) {
            res.resume();
            const err = new Error(`HTTP ${res.statusCode} downloading ${u}`);
            err.statusCode = res.statusCode;
            return reject(err);
          }
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks)));
          res.on('error', reject);
        });
      } catch (e) {
        return reject(e);
      }

      req.setTimeout(REQUEST_TIMEOUT_MS, () => {
        const err = new Error(`Timeout after ${REQUEST_TIMEOUT_MS}ms downloading ${u}`);
        err.code = 'ETIMEDOUT';
        req.destroy(err);
      });
      req.on('error', reject);
    };

    follow(requestUrl);
  });

  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await _attemptOnce(url);
    } catch (e) {
      lastErr = e;
      const code = e?.statusCode;
      const isRetryable = RETRYABLE_STATUS.has(code) || e?.code === 'ETIMEDOUT' || e?.code === 'ECONNRESET';
      if (!isRetryable || attempt === MAX_ATTEMPTS) throw e;
      await sleep(backoffMs(attempt));
    }
  }
  throw lastErr;
}

/**
 * Download a URL following HTTP redirects, writing the result to destPath.
 * Uses an atomic write (destPath.tmp → destPath) to avoid partial files.
 * @param {string} url
 * @param {string} destPath
 * @param {string} userAgent
 * @returns {Promise<void>}
 */
export async function downloadToFile(url, destPath, userAgent) {
  const _attemptOnce = (requestUrl) => new Promise((resolve, reject) => {
    const follow = (u, redirects = 0) => {
      if (redirects > MAX_REDIRECTS) {
        return reject(new Error(`Too many redirects downloading ${url}`));
      }

      let req;
      try {
        req = https.get(u, { headers: { 'User-Agent': userAgent } }, res => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            let next;
            try {
              next = resolveRedirect(u, res.headers.location);
            } catch (e) {
              return reject(e);
            }
            return follow(next, redirects + 1);
          }
          if (res.statusCode !== 200) {
            res.resume();
            const err = new Error(`HTTP ${res.statusCode} downloading ${u}`);
            err.statusCode = res.statusCode;
            return reject(err);
          }
          const tmp = destPath + '.tmp';
          const out = fs.createWriteStream(tmp);
          res.pipe(out);
          out.on('finish', async () => {
            try { await fsp.rename(tmp, destPath); resolve(); }
            catch (e) { fsp.unlink(tmp).catch(() => {}); reject(e); }
          });
          out.on('error', e => { fsp.unlink(tmp).catch(() => {}); reject(e); });
        });
      } catch (e) {
        return reject(e);
      }

      req.setTimeout(REQUEST_TIMEOUT_MS, () => {
        const err = new Error(`Timeout after ${REQUEST_TIMEOUT_MS}ms downloading ${u}`);
        err.code = 'ETIMEDOUT';
        req.destroy(err);
      });
      req.on('error', reject);
    };

    follow(requestUrl);
  });

  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await _attemptOnce(url);
      return;
    } catch (e) {
      lastErr = e;
      const code = e?.statusCode;
      const isRetryable = RETRYABLE_STATUS.has(code) || e?.code === 'ETIMEDOUT' || e?.code === 'ECONNRESET';
      if (!isRetryable || attempt === MAX_ATTEMPTS) throw e;
      await sleep(backoffMs(attempt));
    }
  }
  throw lastErr;
}

/**
 * Compute the SHA-256 hex digest of a local file.
 * @param {string} filePath
 * @returns {Promise<string>}
 */
export function computeFileChecksum(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', d => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}
