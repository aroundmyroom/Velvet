import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import mime from 'mime-types';
import sharp from 'sharp';
import { resolvePathWithinRoot } from './path-security.js';

const THUMBS = [['zl-', 256], ['zs-', 92], ['zm-', 512]];

// format is either a MIME type (embedded art) or a file extension (folder image), as in the scanner.
export function artFileName(buf, format) {
  const md5 = crypto.createHash('md5').update(buf).digest('hex'); // NOSONAR: MD5 used as album-art cache filename, not for security
  let ext = format;
  if (String(format).includes('/')) {
    const raw = mime.extension(format);
    ext = raw === 'jpeg' ? 'jpg' : (raw || 'jpg');
  }
  return `${md5}.${ext}`;
}

export async function writeArtWithThumbs(artDir, buf, aaFile, { compress = true } = {}) {
  await fs.mkdir(artDir, { recursive: true });
  const original = resolvePathWithinRoot(artDir, aaFile);
  if (!fsSync.existsSync(original)) await fs.writeFile(original, buf);
  // Tiny buffers are skipped as a guard against malformed images (file-type CVE workaround).
  if (!compress || buf.length < 100) return true;
  try {
    for (const [prefix, size] of THUMBS) {
      const out = resolvePathWithinRoot(artDir, prefix + aaFile);
      if (!fsSync.existsSync(out)) await sharp(buf).resize(size, size, { fit: 'inside', withoutEnlargement: true }).toFile(out);
    }
  } catch {
    // sharp cannot decode a corrupt image; the original still displays as zl/zs.
    for (const prefix of ['zl-', 'zs-']) {
      const out = resolvePathWithinRoot(artDir, prefix + aaFile);
      if (!fsSync.existsSync(out)) await fs.writeFile(out, buf);
    }
    return false;
  }
  return true;
}
