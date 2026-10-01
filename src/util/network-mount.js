// Pure logic for Admin → Folders → "Network share" (mount an NFS/SMB share
// directly from inside Velvet, no shell access needed) — kept separate from
// src/api/network-mount.js's Express wiring and filesystem/process calls so
// every decision here (what's a valid name, what an fstab entry looks like,
// how a failed mount's stderr maps to a specific, honest explanation) has
// real unit-test coverage without ever touching a real /etc/fstab or running
// a real mount command. See docs/network-shares.md for the feature itself.

// Lowercase, hyphenated, 2-50 chars, no leading/trailing hyphen — used as
// both the config key and the mount-point directory name under
// save/network-mounts/, so it also has to be safe as a single path segment
// (enforced by rejecting anything containing a path separator or "..",
// which this pattern already does by construction: no '/', no '.').
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$/;

export function isValidSlug(name) {
  return typeof name === 'string' && SLUG_RE.test(name);
}

// A conservative allow-list for the free-text mount-options field: letters,
// digits, and the characters an fstab options list actually uses. Rejects
// anything that could inject a second fstab field (no whitespace) or a
// shell/path metacharacter, without trying to understand every real mount
// option by name.
const OPTIONS_RE = /^[A-Za-z0-9=,._-]*$/;

// Plain string checks rather than one regex per shape (server:/export,
// //server/share) on purpose: two adjacent variable-length segments over
// near-identical character classes, which is exactly the shape a linter
// flags for pathological backtracking on crafted input. indexOf-based
// structural checks give the same guarantee in linear time.
export function isValidServer(type, server) {
  if (typeof server !== 'string' || server.length === 0 || server.length > 255) return false;
  if (/[\s'"]/.test(server)) return false; // would break out of its fstab line either way
  if (type === 'nfs') {
    const i = server.indexOf(':/');
    return i > 0 && i < server.length - 2;
  }
  if (type === 'cifs') {
    if (!server.startsWith('//')) return false;
    const rest = server.slice(2);
    const i = rest.indexOf('/');
    return i > 0 && i < rest.length - 1;
  }
  return false;
}

export function isValidOptions(options) {
  return typeof options === 'string' && options.length <= 300 && OPTIONS_RE.test(options);
}

// Matches contrib/lxc/ct/velvet.sh's own hardened default — confirmed
// necessary the hard way (docs/lxc-incus.md): a thin `rw,vers=4` mount of
// the exact same file that a properly-tuned mount read without issue threw
// a metadata-parser error, the signature of a short NFS read with no
// explicit rsize/wsize.
export function defaultNfsOptions() {
  return 'rw,vers=4,hard,rsize=131072,wsize=131072,timeo=600,retrans=2';
}

export function defaultCifsOptions(hasCredentials) {
  const base = hasCredentials ? 'credentials=__CRED_FILE__' : 'guest';
  return `${base},iocharset=utf8,vers=3.0`;
}

const FSTAB_TAG_PREFIX = '# velvet-network-mount:';

export function fstabTag(name) {
  return `${FSTAB_TAG_PREFIX}${name}`;
}

// The two-line block this feature owns in /etc/fstab: a tag comment (so a
// later removal can find exactly this entry, and only this entry, again)
// followed by the real mount line. `type` is 'nfs' or 'cifs', matching the
// fstab fstype field directly.
export function buildFstabBlock({ name, type, server, mountPoint, options }) {
  return `${fstabTag(name)}\n${server} ${mountPoint} ${type} ${options} 0 0\n`;
}

// Given the full current contents of /etc/fstab and a slug, returns the
// content with that slug's tag line and the single line right after it
// removed — and nothing else touched, by construction: any line not
// immediately following this exact tag is left alone. Pure string
// transform, no filesystem access, so this is exactly what both "a mount
// attempt failed and the just-added entry needs rolling back" and "the
// admin removed a configured share" can share and both get tested.
export function removeFstabBlock(content, name) {
  const tag = fstabTag(name);
  const lines = String(content ?? '').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === tag) {
      i += 1; // also skip the mount line immediately after the tag
      continue;
    }
    out.push(lines[i]);
  }
  return out.join('\n');
}

// True if /etc/fstab already has a line whose second field (the mount
// point) is this exact path — independent of whether Velvet itself put it
// there. Checked before adding a new entry so this feature can never
// silently create a second, conflicting definition for the same path.
export function fstabHasMountPoint(content, mountPoint) {
  return String(content ?? '')
    .split('\n')
    .some(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return false;
      const fields = trimmed.split(/\s+/);
      return fields[1] === mountPoint;
    });
}

// Classifies a failed mount's stderr into one of three outcomes the API
// layer reports with a different, specific message for each — "it's a
// kernel-level permission wall" (the confirmed, unavoidable unprivileged-
// container limitation) reads very differently from "the server or
// credentials are wrong", and a vague shared error for both would send an
// admin down the wrong troubleshooting path for either one.
export function classifyMountError(stderrText) {
  const text = String(stderrText ?? '');
  if (/operation not permitted/i.test(text)) return 'not-permitted';
  if (/no route to host|connection refused|network is unreachable|timed out/i.test(text)) return 'unreachable';
  if (/permission denied|access denied|logon failure|auth/i.test(text)) return 'auth';
  return 'generic';
}
