import crypto from 'node:crypto';
import Joi from 'joi';
import jwt from 'jsonwebtoken';
import winston from 'winston';
import * as config from '../state/config.js';
import { joiValidate } from '../util/validation.js';
import WebError from '../util/web-error.js';

// Cross-device login pairing ("Pair a device"): a device with an awkward
// keyboard (Samsung TV remote, kiosk, car head unit) shows a short code; the
// user approves it from an already-logged-in phone/browser. Complements the
// existing passkey (WebAuthn) support — passkeys need a platform authenticator
// or WebAuthn hybrid transport, which a TV browser typically doesn't have.

const PAIR_TTL_MS = 5 * 60 * 1000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I — avoids on-screen ambiguity
const CODE_LENGTH = 6;

// Keyed by pairId (opaque, held only by the requesting device); a second index
// by code lets the approving device (which only ever sees the short code) look
// up the same entry. Both maps are swept together.
const _pairings = new Map();
const _byCode = new Map();

function _generateCode() {
  let code;
  do {
    code = Array.from(crypto.randomBytes(CODE_LENGTH))
      .map(b => CODE_ALPHABET[b % CODE_ALPHABET.length])
      .join('');
  } while (_byCode.has(code));
  return code;
}

export function _sweepExpired(now = Date.now()) {
  for (const [pairId, entry] of _pairings) {
    if (now > entry.expiresAt) {
      _pairings.delete(pairId);
      _byCode.delete(entry.code);
    }
  }
}
// unref() so an isolated import (e.g. a unit test) doesn't hang on this timer —
// the real process is kept alive by the HTTP server regardless.
setInterval(_sweepExpired, 60_000).unref();

export function startPairing() {
  _sweepExpired();
  const pairId = crypto.randomUUID();
  const code = _generateCode();
  const entry = {
    code,
    approved: false,
    username: null,
    token: null,
    vpaths: null,
    expiresAt: Date.now() + PAIR_TTL_MS,
  };
  _pairings.set(pairId, entry);
  _byCode.set(code, entry);
  return { pairId, code, expiresInSec: PAIR_TTL_MS / 1000 };
}

export function getPairingStatus(pairId) {
  const entry = pairId && _pairings.get(pairId);
  if (!entry || Date.now() > entry.expiresAt) return { status: 'expired' };
  if (!entry.approved) return { status: 'pending' };

  // Single-use: once collected, the pairing is gone even if the TV polls again.
  _pairings.delete(pairId);
  _byCode.delete(entry.code);
  return { status: 'approved', token: entry.token, vpaths: entry.vpaths, username: entry.username };
}

// `deps` defaults to live config/jwt in production; tests inject fakes so the
// full decision (unknown/expired/already-approved code, successful approval)
// is exercised without booting a real config file.
export function approvePairing(rawCode, username, deps = {}) {
  const getUser = deps.getUser || (name => config.program.users[name]);
  const signToken = deps.signToken || (name => jwt.sign({ username: name }, config.program.secret));

  const code = rawCode.trim().toUpperCase();
  const entry = _byCode.get(code);
  if (!entry || Date.now() > entry.expiresAt || entry.approved) return { ok: false, reason: 'invalid-or-expired' };

  const user = getUser(username);
  if (!user) return { ok: false, reason: 'no-such-user' };

  entry.approved = true;
  entry.username = username;
  entry.vpaths = user.vpaths;
  entry.token = signToken(username);
  return { ok: true };
}

// Unauthenticated — registered before the main auth middleware, same as
// auth-passkey.js's setupPublic. The TV/kiosk device has nothing to sign in
// with yet; that's the entire point of pairing.
export function setupPublic(velvet) {
  velvet.post('/api/v1/auth/pair/start', (req, res) => {
    res.json(startPairing());
  });

  velvet.get('/api/v1/auth/pair/status', (req, res) => {
    res.json(getPairingStatus(req.query?.pairId));
  });
}

export function setup(velvet) {
  // Requires a normal, already-authenticated session — the whole point is that
  // the approving device is already signed in.
  velvet.post('/api/v1/auth/pair/approve', (req, res) => {
    const schema = Joi.object({ code: Joi.string().required() });
    const { value } = joiValidate(schema, req.body);

    if (!config.program.users[req.user.username]) { throw new WebError('Authentication Error', 401); }

    const result = approvePairing(value.code, req.user.username);
    if (!result.ok) {
      winston.warn(`Failed pairing approval attempt from ${req.ip}`);
      return new Promise(resolve => setTimeout(() => {
        res.status(400).json({ error: 'Invalid or expired code' });
        resolve();
      }, 800));
    }
    res.json({ ok: true });
  });
}
