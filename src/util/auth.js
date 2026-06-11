import crypto from 'node:crypto';

const HASH_BYTES = 32;
const SALT_BYTES = 16;
const ITERATIONS = 15000;
const ENCODING = 'base64';
const ALGORITHM = 'sha512';

export function hashPassword(password) {
  return new Promise((resolve, reject) => {
    crypto.randomBytes(SALT_BYTES, (err, salt) => {
      if (err) { return reject(new Error('Failed to hash password')); }
      crypto.pbkdf2(password, salt.toString(ENCODING), ITERATIONS, HASH_BYTES, ALGORITHM, (err, hash) => {
        if (err) { return reject(new Error('Failed to hash password')); }
        resolve({ salt: salt.toString(ENCODING), hashPassword: hash.toString(ENCODING) });
      });
    });
  });
}

export function authenticateUser(password, salt, givenPassword) {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(givenPassword, salt, ITERATIONS, HASH_BYTES, ALGORITHM, (err, verifyHash) => {
      if (err) { return reject(new Error('Unknown Authentication Error')); }
      const expected = Buffer.from(password, ENCODING);
      if (verifyHash.length !== expected.length || !crypto.timingSafeEqual(verifyHash, expected)) {
        return reject(new Error('Authentication Error: Passwords do not match'));
      }
      resolve();
    });
  });
}
