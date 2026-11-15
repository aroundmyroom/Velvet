import crypto from 'node:crypto';

const HASH_BYTES = 32;
const SALT_BYTES = 16;
// OWASP guidance for PBKDF2-HMAC-SHA512. The count travels in the stored salt
// ('pbkdf2-<n>$<salt>'); a salt without that prefix is from before, made with 15,000.
const ITERATIONS = 210000;
const LEGACY_ITERATIONS = 15000;
const ENCODING = 'base64';
const ALGORITHM = 'sha512';

function parseSalt(stored) {
  const m = /^pbkdf2-(\d+)\$(.*)$/s.exec(String(stored));
  return m ? { iterations: Number(m[1]), salt: m[2] } : { iterations: LEGACY_ITERATIONS, salt: String(stored) };
}

export function needsRehash(storedSalt) {
  return parseSalt(storedSalt).iterations !== ITERATIONS;
}

export function hashPassword(password) {
  return new Promise((resolve, reject) => {
    crypto.randomBytes(SALT_BYTES, (err, salt) => {
      if (err) { return reject(new Error('Failed to hash password')); }
      crypto.pbkdf2(password, salt.toString(ENCODING), ITERATIONS, HASH_BYTES, ALGORITHM, (err, hash) => {
        if (err) { return reject(new Error('Failed to hash password')); }
        resolve({ salt: `pbkdf2-${ITERATIONS}$${salt.toString(ENCODING)}`, hashPassword: hash.toString(ENCODING) });
      });
    });
  });
}

export function authenticateUser(password, storedSalt, givenPassword) {
  const { iterations, salt } = parseSalt(storedSalt);
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(givenPassword, salt, iterations, HASH_BYTES, ALGORITHM, (err, verifyHash) => {
      if (err) { return reject(new Error('Unknown Authentication Error')); }
      const expected = Buffer.from(password, ENCODING);
      if (verifyHash.length !== expected.length || !crypto.timingSafeEqual(verifyHash, expected)) {
        return reject(new Error('Authentication Error: Passwords do not match'));
      }
      resolve();
    });
  });
}
