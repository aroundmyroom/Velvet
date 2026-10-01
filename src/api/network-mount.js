import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import Joi from 'joi';
import winston from 'winston';
import * as config from '../state/config.js';
import { joiValidate } from '../util/validation.js';
import { getDirname } from '../util/esm-helpers.js';
import {
  SLUG_RE, isValidServer, isValidOptions, defaultNfsOptions, defaultCifsOptions,
  buildFstabBlock, removeFstabBlock, fstabHasMountPoint, classifyMountError,
} from '../util/network-mount.js';

// Admin → Folders → "Network share": mount an NFS/SMB share directly from
// inside Velvet itself, no shell access to the host needed.
//
// Exists specifically so contrib/lxc/ct/velvet.sh's eventual upstream
// submission to community-scripts doesn't need to do this with hand-written
// pct/incus/mount commands at container-creation time — their own
// contribution guidelines explicitly rule that out ("no hand-written host
// commands in a platform-neutral CT script"), confirmed by reading
// https://community-scripts.org/docs/contribution/code-audit directly. The
// LXC wizard still does its own host-side mount for THIS repo's own
// one-liner (that's a documented, deliberate difference, not an oversight —
// see docs/network-shares.md); a slimmed-down variant prepared specifically
// for upstream would point at this feature instead.
//
// Needs Velvet's own process to be running as root: mounting a filesystem
// is a privileged kernel operation no matter which user asks for it, and
// nothing here escalates Velvet's own privilege to get it — if the process
// isn't root, every attempt fails immediately with that exact, specific
// explanation rather than a vague one. On an unprivileged LXC/Incus
// container this also always fails even as root, a confirmed kernel
// limitation (docs/lxc-incus.md): neither NFS nor CIFS can be mounted
// directly inside one at all. That failure gets its own specific message
// too — classifyMountError() is what tells the two apart.

const ROOT = path.resolve(getDirname(import.meta.url), '../..');
const MOUNTS_DIR = path.join(ROOT, 'save', 'network-mounts');
const CRED_DIR = path.join(ROOT, 'save', 'conf', 'network-mounts');
const FSTAB = '/etc/fstab';
const RUN_TIMEOUT_MS = 20_000;

const nfsSchema = Joi.object({
  name: Joi.string().pattern(SLUG_RE).required(),
  type: Joi.valid('nfs').required(),
  server: Joi.string().max(255).required(),
  options: Joi.string().max(300).allow('').optional(),
});
const cifsSchema = Joi.object({
  name: Joi.string().pattern(SLUG_RE).required(),
  type: Joi.valid('cifs').required(),
  server: Joi.string().max(255).required(),
  username: Joi.string().max(128).allow('').optional(),
  password: Joi.string().max(256).allow('').optional(),
  domain: Joi.string().max(128).allow('').optional(),
  options: Joi.string().max(300).allow('').optional(),
});

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: RUN_TIMEOUT_MS, ...opts }, (err, stdout, stderr) => {
      if (err) { err.stdout = stdout; err.stderr = stderr; reject(err); return; }
      resolve({ stdout, stderr });
    });
  });
}

function isRoot() {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

// No shell invocation for the check — just looks for the binary on the
// handful of paths Debian actually installs it to.
function hasBinary(bin) {
  return ['/usr/sbin', '/sbin', '/usr/bin', '/bin'].some(dir => {
    try { return fs.existsSync(path.join(dir, bin)); } catch { return false; }
  });
}

async function ensureClientPackage(bin, pkg) {
  if (hasBinary(bin)) return true;
  try {
    await run('apt-get', ['update', '-qq'], { timeout: 60_000 });
    await run('apt-get', ['install', '-y', '-qq', pkg], { timeout: 120_000 });
  } catch (err) {
    winston.warn(`[network-mount] could not install ${pkg}: ${err.message}`);
  }
  return hasBinary(bin);
}

async function readFstab() {
  try { return await fsp.readFile(FSTAB, 'utf8'); } catch { return ''; }
}

async function persistMounts() {
  const raw = JSON.parse(await fsp.readFile(config.configFile, 'utf8'));
  raw.networkMounts = config.program.networkMounts;
  await fsp.writeFile(config.configFile, JSON.stringify(raw, null, 2), 'utf8');
}

const adminOnly = (req, res) => {
  if (req.user?.admin !== true) { res.status(403).json({ error: 'Admin only' }); return false; }
  return true;
};

export function setup(velvet) {
  velvet.get('/api/v1/admin/network-mount', (req, res) => {
    if (!adminOnly(req, res)) return;
    res.json(config.program.networkMounts || {});
  });

  velvet.post('/api/v1/admin/network-mount', async (req, res) => {
    if (!adminOnly(req, res)) return;

    const type = req.body?.type;
    const schema = type === 'cifs' ? cifsSchema : nfsSchema;
    joiValidate(schema, req.body);
    const { name, server } = req.body;
    if (!isValidServer(type, server)) {
      throw new Error(type === 'nfs' ? 'Expected server:/export' : 'Expected //server/share');
    }
    if (req.body.options && !isValidOptions(req.body.options)) {
      throw new Error('Mount options contain a character that is not allowed');
    }

    if (!isRoot()) {
      return res.status(409).json({
        error: 'not-root',
        message: "Velvet isn't running as root, which mounting a filesystem requires at the kernel level regardless of which user asks for it — this isn't something Velvet can work around. See docs/network-shares.md.",
      });
    }
    if (config.program.networkMounts?.[name]) {
      return res.status(409).json({ error: `A network mount named "${name}" already exists` });
    }

    const mountPoint = path.join(MOUNTS_DIR, name);
    const existingFstab = await readFstab();
    if (fstabHasMountPoint(existingFstab, mountPoint)) {
      return res.status(409).json({ error: `${mountPoint} is already in /etc/fstab, from something other than this feature — resolve that first` });
    }

    const pkgOk = type === 'nfs'
      ? await ensureClientPackage('mount.nfs', 'nfs-common')
      : await ensureClientPackage('mount.cifs', 'cifs-utils');
    if (!pkgOk) {
      return res.status(500).json({ error: `Could not install the ${type === 'nfs' ? 'nfs-common' : 'cifs-utils'} package automatically — install it yourself and retry.` });
    }

    await fsp.mkdir(mountPoint, { recursive: true });

    let credFile = '';
    if (type === 'cifs' && req.body.username) {
      await fsp.mkdir(CRED_DIR, { recursive: true, mode: 0o700 });
      credFile = path.join(CRED_DIR, `${name}-credentials`);
      const lines = [`username=${req.body.username}`, `password=${req.body.password || ''}`];
      if (req.body.domain) lines.push(`domain=${req.body.domain}`);
      await fsp.writeFile(credFile, lines.join('\n') + '\n', { mode: 0o600 });
    }

    const opts = req.body.options || (
      type === 'nfs' ? defaultNfsOptions() : defaultCifsOptions(!!credFile).replace('__CRED_FILE__', credFile)
    );

    const block = buildFstabBlock({ name, type, server, mountPoint, options: opts });
    await fsp.appendFile(FSTAB, block);

    try {
      await run('mount', [mountPoint]);
    } catch (err) {
      await fsp.writeFile(FSTAB, removeFstabBlock(await readFstab(), name));
      if (credFile) await fsp.rm(credFile, { force: true });
      const kind = classifyMountError(err.stderr);
      const messages = {
        'not-permitted': 'The mount was refused with "Operation not permitted" — on an unprivileged LXC/Incus container this is a confirmed, unavoidable kernel limitation: neither NFS nor CIFS can be mounted directly inside one, no matter what. Mount it on the host instead and attach it as a bind-mounted folder — see docs/network-shares.md and docs/lxc-incus.md.',
        unreachable: `Could not reach ${server} from this host — check the address and that the share is actually exported to this host's network.`,
        auth: 'The share rejected the credentials — check the username, password, and domain.',
        generic: `Mount failed: ${String(err.stderr || err.message || '').slice(0, 300)}`,
      };
      return res.status(500).json({ error: kind, message: messages[kind] });
    }

    config.program.networkMounts = config.program.networkMounts || {};
    config.program.networkMounts[name] = { type, server, mountPoint, options: opts, hasCredentials: !!credFile };
    await persistMounts();

    res.json({ name, ...config.program.networkMounts[name] });
  });

  velvet.delete('/api/v1/admin/network-mount/:name', async (req, res) => {
    if (!adminOnly(req, res)) return;
    joiValidate(Joi.object({ name: Joi.string().pattern(SLUG_RE).required() }), req.params);
    const { name } = req.params;
    const record = config.program.networkMounts?.[name];
    if (!record) return res.status(404).json({ error: 'Not found' });

    try {
      await run('umount', [record.mountPoint]);
    } catch (err) {
      winston.warn(`[network-mount] umount ${name} failed, removing the config entry anyway: ${err.message}`);
    }
    await fsp.writeFile(FSTAB, removeFstabBlock(await readFstab(), name));
    if (record.hasCredentials) {
      await fsp.rm(path.join(CRED_DIR, `${name}-credentials`), { force: true });
    }

    delete config.program.networkMounts[name];
    await persistMounts();
    res.json({});
  });
}
