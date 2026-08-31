import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import Joi from 'joi';
import jwt from 'jsonwebtoken';
import * as config from '../state/config.js';
import * as db from '../db/sqlite-backend.js';

// In-memory challenge store with TTL of 5 minutes.
// Keys are "reg:<username>" or "auth:<username>" (for auth without username)
// or "auth-anon:<sessionId>" for unidentified authentication challenges.
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const _challenges = new Map();

function _storeChallenge(key, challenge) {
  _challenges.set(key, { challenge, expiresAt: Date.now() + CHALLENGE_TTL_MS });
}

function _consumeChallenge(key) {
  const entry = _challenges.get(key);
  if (!entry) return null;
  _challenges.delete(key);
  if (Date.now() > entry.expiresAt) return null;
  return entry.challenge;
}

// Periodically sweep expired challenges
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _challenges) {
    if (now > v.expiresAt) _challenges.delete(k);
  }
}, 60_000);

function _rpId(req) {
  // Use configured rpId if set, otherwise derive from request host.
  return config.program.passkeys?.rpId || req.hostname;
}

function _rpName() {
  return config.program.passkeys?.rpName || 'Velvet';
}

function _origin(req) {
  // May be an array for multi-origin setups (e.g. localhost + live URL)
  const configured = config.program.passkeys?.origin;
  if (configured) return configured;
  const proto = req.secure || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  return `${proto}://${req.headers.host}`;
}

export function setupPublic(velvet) {
  // ── Authentication (public — no token required) ───────────────────────────
  // POST /api/v1/auth/passkey/auth/options
  velvet.post('/api/v1/auth/passkey/auth/options', async (req, res) => {
    // Optional: client may send a username hint (for non-discoverable credentials)
    const usernameHint = req.body?.username?.trim() || null;

    let allowCredentials;
    if (usernameHint && config.program.users[usernameHint]) {
      const passkeys = db.getPasskeysByUsername(usernameHint);
      // Omit transports so the browser offers ALL authenticator types (USB,
      // platform biometrics, and cross-device QR/phone via hybrid transport).
      allowCredentials = passkeys.map(pk => ({ id: pk.credential_id }));
    }

    const options = await generateAuthenticationOptions({
      rpID: _rpId(req),
      userVerification: 'preferred',
      allowCredentials,
    });

    // WebAuthn Level 3 hints — tells the browser to show ALL authenticator
    // types: platform (Touch ID / Windows Hello), security key (USB/NFC),
    // and hybrid (cross-device QR-code flow for phone/tablet).
    options.hints = ['client-device', 'hybrid', 'security-key'];

    // Store challenge keyed by the challenge itself (client sends it back)
    _storeChallenge(`auth:${options.challenge}`, options.challenge);
    res.json(options);
  });

  // POST /api/v1/auth/passkey/auth/verify
  velvet.post('/api/v1/auth/passkey/auth/verify', async (req, res) => {
    const schema = Joi.object({
      credential: Joi.object().required(),
      challenge: Joi.string().required(),
    });
    const { error, value } = schema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });

    const expectedChallenge = _consumeChallenge(`auth:${value.challenge}`);
    if (!expectedChallenge) return res.status(400).json({ error: 'Challenge expired or not found' });

    const credentialId = value.credential.id;
    const passkeyRow = db.getPasskeyByCredentialId(credentialId);
    if (!passkeyRow) return res.status(401).json({ error: 'Unknown credential' });

    const username = passkeyRow.username;
    if (!config.program.users[username]) {
      return res.status(401).json({ error: 'User account not found' });
    }

    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: value.credential,
        expectedChallenge,
        expectedOrigin: _origin(req),
        expectedRPID: _rpId(req),
        requireUserVerification: false,
        credential: {
          id: passkeyRow.credential_id,
          publicKey: Buffer.from(passkeyRow.public_key, 'base64url'),
          counter: passkeyRow.counter,
          transports: passkeyRow.transports ? JSON.parse(passkeyRow.transports) : [],
        },
      });
    } catch (e) {
      return res.status(401).json({ error: `Authentication failed: ${e.message}` });
    }

    if (!verification.verified) return res.status(401).json({ error: 'Authentication not verified' });

    db.updatePasskeyCounter(credentialId, verification.authenticationInfo.newCounter);

    const token = jwt.sign({ username }, config.program.secret);
    res.cookie('x-access-token', token, {
      maxAge: 30 * 24 * 60 * 60 * 1000,
      sameSite: 'Strict',
      secure: req.secure || req.headers['x-forwarded-proto'] === 'https',
    });

    res.json({
      token,
      vpaths: config.program.users[username].vpaths,
      username,
    });
  });
}

export function setup(velvet) {
  // ── Registration (requires existing session) ──────────────────────────────
  // POST /api/v1/auth/passkey/register/options
  velvet.post('/api/v1/auth/passkey/register/options', async (req, res) => {
    const username = req.user.username;
    const existing = db.getPasskeysByUsername(username);

    const options = await generateRegistrationOptions({
      rpName: _rpName(),
      rpID: _rpId(req),
      userID: new TextEncoder().encode(username),
      userName: username,
      attestationType: 'none',
      excludeCredentials: existing.map(pk => ({
        id: pk.credential_id,
        transports: pk.transports ? JSON.parse(pk.transports) : [],
      })),
      authenticatorSelection: {
        // 'preferred' allows both platform (phone/laptop biometrics)
        // and roaming (USB/NFC/BLE) authenticators.
        residentKey: 'preferred',
        userVerification: 'preferred',
        // No authenticatorAttachment restriction — allow platform AND
        // cross-platform (security keys, cross-device QR flow).
      },
    });

    // WebAuthn Level 3 hints — show all authenticator types in the browser UI.
    options.hints = ['client-device', 'hybrid', 'security-key'];

    _storeChallenge(`reg:${username}`, options.challenge);
    res.json(options);
  });

  // POST /api/v1/auth/passkey/register/verify
  velvet.post('/api/v1/auth/passkey/register/verify', async (req, res) => {
    const schema = Joi.object({
      credential: Joi.object().required(),
      friendlyName: Joi.string().max(64).allow('', null).optional(),
    });
    const { error, value } = schema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });

    const username = req.user.username;
    const expectedChallenge = _consumeChallenge(`reg:${username}`);
    if (!expectedChallenge) return res.status(400).json({ error: 'Challenge expired or not found' });

    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: value.credential,
        expectedChallenge,
        expectedOrigin: _origin(req),
        expectedRPID: _rpId(req),
        requireUserVerification: false,
      });
    } catch (e) {
      return res.status(400).json({ error: `Verification failed: ${e.message}` });
    }

    if (!verification.verified || !verification.registrationInfo) {
      return res.status(400).json({ error: 'Registration not verified' });
    }

    const { credential } = verification.registrationInfo;
    db.insertPasskey({
      username,
      credentialId: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString('base64url'),
      counter: credential.counter,
      transports: value.credential.response?.transports
        ? JSON.stringify(value.credential.response.transports)
        : null,
      deviceType: verification.registrationInfo.credentialDeviceType,
      backedUp: verification.registrationInfo.credentialBackedUp,
      friendlyName: value.friendlyName || null,
    });

    res.json({ verified: true });
  });

  // ── Credential management ─────────────────────────────────────────────────
  // GET /api/v1/auth/passkey/credentials[?username=x]
  velvet.get('/api/v1/auth/passkey/credentials', (req, res) => {
    const targetUser = (req.user.admin === true && req.query.username)
      ? req.query.username
      : req.user.username;
    const rows = db.getPasskeysByUsername(targetUser).map(pk => ({
      id:           pk.id,
      friendlyName: pk.friendly_name ?? '',
      deviceType:   pk.device_type ?? '',
      backedUp:     pk.backed_up === 1,
      createdAt:    new Date(pk.created_at).toISOString(),
      lastUsedAt:   pk.last_used_at ? new Date(pk.last_used_at).toISOString() : null,
    }));
    res.json({ credentials: rows });
  });

  // DELETE /api/v1/auth/passkey/credentials/:id[?username=x]
  velvet.delete('/api/v1/auth/passkey/credentials/:id', (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const targetUser = (req.user.admin === true && req.query.username)
      ? req.query.username
      : req.user.username;
    const deleted = db.deletePasskeyById(id, targetUser);
    if (!deleted) return res.status(404).json({ error: 'Credential not found' });
    res.json({});
  });
}
