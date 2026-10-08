const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

// contrib/shared/velvet-install.sh is plain bash with no app-code dependency,
// so it is exercised here the same way a person would from a terminal:
// spawn it and read stdout/exit code. --dry-run makes every mutating step a
// no-op (no apt/git/npm/systemctl/file writes), so this is safe to run as
// part of the normal test suite on any machine, including this one.
const SCRIPT = path.join(__dirname, '../../contrib/shared/velvet-install.sh');

function run(args, opts = {}) {
  try {
    const stdout = execFileSync('/bin/bash', [SCRIPT, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...opts,
    });
    return { stdout, status: 0 };
  } catch (err) {
    return { stdout: (err.stdout || '') + (err.stderr || ''), status: err.status };
  }
}

describe('contrib/shared/velvet-install.sh — the LXC/Incus installer', () => {
  it('prints usage and exits 0 for --help', () => {
    const { stdout, status } = run(['--help']);
    assert.equal(status, 0);
    assert.match(stdout, /--mode install\|update/);
    assert.match(stdout, /--dry-run/);
  });

  it('rejects a missing --mode', () => {
    const { stdout, status } = run([]);
    assert.equal(status, 2);
    assert.match(stdout, /--mode install\|update is required/);
  });

  it('rejects an unknown mode', () => {
    const { status } = run(['--mode', 'bogus']);
    assert.equal(status, 2);
  });

  it('rejects --admin-user without --admin-pass', () => {
    const { stdout, status } = run(['--mode', 'install', '--admin-user', 'bob', '--dry-run']);
    assert.equal(status, 2);
    assert.match(stdout, /--admin-user and --admin-pass must be given together/);
  });

  it('rejects --admin-pass without --admin-user', () => {
    const { status } = run(['--mode', 'install', '--admin-pass', 'hunter2', '--dry-run']);
    assert.equal(status, 2);
  });

  it('rejects an unknown --update-strategy', () => {
    const { status } = run(['--mode', 'update', '--update-strategy', 'bogus', '--dry-run']);
    assert.equal(status, 2);
  });

  it('rejects an unknown flag', () => {
    const { status } = run(['--mode', 'install', '--not-a-real-flag', '--dry-run']);
    assert.equal(status, 2);
  });

  it('dry-run install walks every phase without mutating anything, in order', () => {
    const { stdout, status } = run([
      '--mode', 'install',
      '--dry-run',
      '--verbose',
      '--ref', 'v9.9.9',
      '--install-dir', '/opt/velvet-test-does-not-exist',
      '--music-dir', '/music',
      '--admin-user', 'admin',
      '--admin-pass', 'hunter2',
      '--enable-recordings=Recordings',
      '--enable-youtube',
      '--enable-audiobooks',
    ]);
    assert.equal(status, 0);
    assert.match(stdout, /DRY RUN/);
    const steps = [
      'Updating package lists',
      'Installing base packages',
      'Creating system user velvet',
      'Cloning Velvet v9.9.9',
      'Installing Node dependencies',
      'Creating data directories',
      'Setting ownership',
      'Would write /etc/velvet.env',
      'Would write /etc/systemd/system/velvet.service',
      'Reloading systemd',
      'Verifying the entry point parses',
      'Enabling and starting Velvet',
    ];
    let lastIndex = -1;
    for (const step of steps) {
      const idx = stdout.indexOf(step);
      assert.notEqual(idx, -1, `expected to see step "${step}" in output`);
      assert.ok(idx > lastIndex, `expected "${step}" to appear after the previous step`);
      lastIndex = idx;
    }
    // The env file content carries every first-run option through to
    // cli-boot-wrapper.js's existing VELVET_* bootstrap, unchanged.
    assert.match(stdout, /VELVET_MUSIC_DIR=\/music/);
    assert.match(stdout, /VELVET_ADMIN_USER=admin/);
    assert.match(stdout, /VELVET_ADMIN_PASS=hunter2/);
    assert.match(stdout, /VELVET_ENABLE_RECORDINGS=true/);
    assert.match(stdout, /VELVET_RECORDINGS_SUBDIR=Recordings/);
    assert.match(stdout, /VELVET_ENABLE_YOUTUBE=true/);
    assert.match(stdout, /VELVET_ENABLE_AUDIOBOOKS=true/);
    // The systemd unit matches docs/install.md's own documented shape.
    assert.match(stdout, /User=velvet/);
    assert.match(stdout, /WorkingDirectory=\/opt\/velvet-test-does-not-exist/);
    assert.match(stdout, /EnvironmentFile=-\/etc\/velvet\.env/);
    assert.match(stdout, /Restart=on-failure/);
  });

  it('dry-run install with no first-run options still succeeds and warns instead of writing an env file', () => {
    const { stdout, status } = run(['--mode', 'install', '--dry-run', '--ref', 'v9.9.9']);
    assert.equal(status, 0);
    assert.match(stdout, /No first-run options given/);
    assert.doesNotMatch(stdout, /Would write \/etc\/velvet\.env/);
  });

  it('--no-start enables Velvet without starting it, so the caller controls the one real boot', () => {
    const { stdout, status } = run(['--mode', 'install', '--dry-run', '--no-start', '--ref', 'v9.9.9']);
    assert.equal(status, 0);
    assert.match(stdout, /systemctl enable velvet/);
    assert.doesNotMatch(stdout, /systemctl enable --now velvet/);
    assert.match(stdout, /not started yet/);
  });

  it('without --no-start, install still enables and starts Velvet immediately (standalone use is unaffected)', () => {
    const { stdout, status } = run(['--mode', 'install', '--dry-run', '--ref', 'v9.9.9']);
    assert.equal(status, 0);
    assert.match(stdout, /systemctl enable --now velvet/);
  });

  it('the system user gets an explicit, already-existing home directory, not the useradd default', () => {
    // Regression test: useradd --no-create-home without --home-dir still
    // records /home/<user> in /etc/passwd, a directory that then never
    // exists — the admin UI's file-browser defaulting an empty path to the
    // OS home directory hit a real ENOENT from this on a live install.
    const { stdout, status } = run(['--mode', 'install', '--dry-run', '--ref', 'v9.9.9']);
    assert.equal(status, 0);
    assert.match(stdout, /useradd --system --no-create-home --home-dir \/opt\/velvet/);
    assert.doesNotMatch(stdout, /useradd --system --no-create-home --shell/);
  });

  it('dry-run update on a non-existent install fails clearly instead of touching the host', () => {
    const { stdout, status } = run([
      '--mode', 'update',
      '--dry-run',
      '--ref', 'v9.9.9',
      '--install-dir', '/opt/velvet-test-does-not-exist',
      '--update-strategy', 'shell',
    ]);
    assert.notEqual(status, 0);
    assert.match(stdout, /has no git checkout/);
  });
});
