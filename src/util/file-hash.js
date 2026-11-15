import crypto from 'node:crypto';
import fs from 'node:fs';

// Only the head of the file is hashed so large files never hit the scan timeout.
export const HASH_READ_LIMIT = 524288;

export function computeFileHash(fullPath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5').setEncoding('hex'); // NOSONAR: MD5 used as file identity hash (DB primary key), not for security
    const stream = fs.createReadStream(fullPath, { start: 0, end: HASH_READ_LIMIT - 1 });
    let bytesRead = 0;
    stream.on('error', reject);
    stream.on('data', (chunk) => { bytesRead += chunk.length; });
    stream.on('end', () => {
      hash.end();
      stream.close();
      // MD5("") would be the same for every unreadable file, colliding unrelated tracks onto one id.
      if (bytesRead === 0) { reject(new Error(`computeFileHash: 0 bytes read from ${fullPath}`)); return; }
      resolve(hash.read());
    });
    stream.pipe(hash);
  });
}
