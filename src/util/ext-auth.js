import crypto from 'node:crypto';
import winston from 'winston';
import * as config from '../state/config.js';
// util/admin.js transitively imports server.js (the whole app entry point), so
// it's dynamically imported only inside the rarely-used auto-create branch
// below — an eager import here would drag the full server bootstrap into
// every module that imports ext-auth.js, including isolated unit tests.

// Reverse-proxy trusted-header authentication (Navidrome's ExtAuth/UserHeader
// equivalent). A trusted proxy (Nginx Proxy Manager, Traefik, Caddy — anything
// that can forward a header, optionally chained behind Authelia/Authentik/
// tinyauth) asserts a header naming the logged-in user; Velvet trusts it only
// from a configured IP/CIDR allowlist plus an optional shared secret.

function _ipv4ToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let int = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n < 0 || n > 255) return null;
    int = (int << 8) | n;
  }
  return int >>> 0;
}

// Strips the IPv4-mapped IPv6 prefix Node reports on dual-stack sockets
// (::ffff:172.18.0.5 -> 172.18.0.5) so plain IPv4 entries in config still match.
function _normalizeIp(ip) {
  if (!ip) return ip;
  const m = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  return m ? m[1] : ip;
}

function _matchesEntry(ip, entry) {
  const [rangeIp, prefixStr] = entry.split('/');
  if (prefixStr === undefined) return ip === rangeIp;

  const prefix = Number(prefixStr);
  const ipInt = _ipv4ToInt(ip);
  const rangeInt = _ipv4ToInt(rangeIp);
  if (ipInt === null || rangeInt === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;

  const mask = prefix === 0 ? 0 : (0xFFFFFFFF << (32 - prefix)) >>> 0;
  return (ipInt & mask) === (rangeInt & mask);
}

export function isTrustedProxy(remoteAddress, trustedProxies) {
  if (!remoteAddress || !trustedProxies?.length) return false;
  const ip = _normalizeIp(remoteAddress);
  return trustedProxies.some(entry => _matchesEntry(ip, entry));
}

function _defaultVpaths() {
  const folders = config.program?.folders || {};
  return Object.keys(folders).filter(name => folders[name].type !== 'excluded');
}

// Resolves the username a trusted proxy asserts for this request, or null.
// Deliberately reads req.socket.remoteAddress (the immediate TCP peer) rather
// than X-Forwarded-For — Velvet never sets Express "trust proxy", so the socket
// peer is always the real connecting host and cannot be spoofed by a client.
//
// `deps` defaults to live config/adminUtil in production; tests inject fakes
// so the full decision (trust, secret, auto-create race) is exercised without
// booting a real config file.
export async function resolveExtAuthUser(req, deps = {}) {
  const cfg = deps.cfg !== undefined ? deps.cfg : config.program?.extAuth;
  if (!cfg?.enabled) return null;

  if (!isTrustedProxy(req.socket?.remoteAddress, cfg.trustedProxies)) return null;

  if (cfg.secretHeaderName && cfg.secretValue) {
    const gotSecret = req.headers[cfg.secretHeaderName.toLowerCase()];
    if (gotSecret !== cfg.secretValue) return null;
  }

  if (!cfg.headerName) return null;
  const username = req.headers[cfg.headerName.toLowerCase()];
  if (!username) return null;

  const users = deps.users !== undefined ? deps.users : config.program.users;

  if (users[username]) return username;
  if (!cfg.autoCreateUsers) return null;

  const addUser = deps.addUser || (await import('./admin.js')).addUser;

  try {
    await addUser(username, crypto.randomUUID(), false, _defaultVpaths());
    winston.info(`[ext-auth] Auto-created user "${username}" from trusted-proxy header`);
  } catch {
    // Another concurrent request for the same first-seen user already created it.
    if (!users[username]) return null;
  }
  return username;
}
