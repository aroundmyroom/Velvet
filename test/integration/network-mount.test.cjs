const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('network-mount — Admin → Folders → "Network share"', async () => {
  const nm = await import('../../src/util/network-mount.js');

  describe('isValidSlug', () => {
    it('accepts plain lowercase, hyphenated names', () => {
      assert.equal(nm.isValidSlug('music-nas'), true);
      assert.equal(nm.isValidSlug('a1'), true);
    });
    it('rejects anything that could escape the mount-point directory', () => {
      assert.equal(nm.isValidSlug('../etc'), false);
      assert.equal(nm.isValidSlug('a/b'), false);
      assert.equal(nm.isValidSlug('.'), false);
      assert.equal(nm.isValidSlug('..'), false);
    });
    it('rejects uppercase, spaces, leading/trailing hyphens, and empty', () => {
      assert.equal(nm.isValidSlug('Music'), false);
      assert.equal(nm.isValidSlug('my nas'), false);
      assert.equal(nm.isValidSlug('-nas'), false);
      assert.equal(nm.isValidSlug('nas-'), false);
      assert.equal(nm.isValidSlug(''), false);
      assert.equal(nm.isValidSlug(undefined), false);
    });
    it('rejects an unreasonably long name', () => {
      assert.equal(nm.isValidSlug('a'.repeat(60)), false);
    });
  });

  describe('isValidServer', () => {
    it('accepts a well-formed NFS server:/export', () => {
      assert.equal(nm.isValidServer('nfs', '192.168.1.10:/mnt/music'), true);
    });
    it('accepts a well-formed CIFS //server/share', () => {
      assert.equal(nm.isValidServer('cifs', '//192.168.1.10/Music'), true);
    });
    it('rejects the wrong shape for the type (confusing nfs and cifs input)', () => {
      assert.equal(nm.isValidServer('nfs', '//192.168.1.10/Music'), false);
      assert.equal(nm.isValidServer('cifs', '192.168.1.10:/mnt/music'), false);
    });
    it('rejects whitespace or quotes — this string ends up inside an fstab line', () => {
      assert.equal(nm.isValidServer('nfs', '192.168.1.10:/mnt/my music'), false);
      assert.equal(nm.isValidServer('nfs', '192.168.1.10:/mnt/"music'), false);
    });
    it('rejects empty and oversized input', () => {
      assert.equal(nm.isValidServer('nfs', ''), false);
      assert.equal(nm.isValidServer('nfs', '1'.repeat(300)), false);
    });
  });

  describe('isValidOptions', () => {
    it('accepts a realistic options string', () => {
      assert.equal(nm.isValidOptions('rw,vers=4,hard,rsize=131072'), true);
      assert.equal(nm.isValidOptions(''), true);
    });
    it('rejects whitespace, shell metacharacters, and path separators', () => {
      assert.equal(nm.isValidOptions('rw; rm -rf /'), false);
      assert.equal(nm.isValidOptions('rw,$(whoami)'), false);
      assert.equal(nm.isValidOptions('rw,/etc/passwd'), false);
    });
  });

  describe('defaultNfsOptions / defaultCifsOptions', () => {
    it('matches the LXC installer\'s own hardened default exactly', () => {
      assert.equal(nm.defaultNfsOptions(), 'rw,vers=4,hard,rsize=131072,wsize=131072,timeo=600,retrans=2');
    });
    it('cifs options differ based on whether credentials are present', () => {
      assert.match(nm.defaultCifsOptions(true), /^credentials=__CRED_FILE__,/);
      assert.match(nm.defaultCifsOptions(false), /^guest,/);
    });
  });

  describe('fstab block build / remove — round trip', () => {
    const args = { name: 'music-nas', type: 'nfs', server: '192.168.1.10:/mnt/music', mountPoint: '/opt/velvet/save/network-mounts/music-nas', options: 'rw,vers=4' };

    it('builds a two-line tagged block', () => {
      const block = nm.buildFstabBlock(args);
      const lines = block.trim().split('\n');
      assert.equal(lines.length, 2);
      assert.equal(lines[0], '# velvet-network-mount:music-nas');
      assert.equal(lines[1], '192.168.1.10:/mnt/music /opt/velvet/save/network-mounts/music-nas nfs rw,vers=4 0 0');
    });

    it('removing the block leaves everything else in the file untouched', () => {
      const fstab = [
        '# /etc/fstab: static file system information.',
        'UUID=abc / ext4 defaults 0 1',
        nm.buildFstabBlock(args).trimEnd(),
        '/dev/sdb1 /backup ext4 defaults 0 2',
        '',
      ].join('\n');
      const after = nm.removeFstabBlock(fstab, 'music-nas');
      assert.doesNotMatch(after, /velvet-network-mount:music-nas/);
      assert.doesNotMatch(after, /mnt\/music/);
      assert.match(after, /UUID=abc \/ ext4/);
      assert.match(after, /\/dev\/sdb1 \/backup/);
    });

    it('removing a slug that is not present leaves the file unchanged', () => {
      const fstab = 'UUID=abc / ext4 defaults 0 1\n';
      assert.equal(nm.removeFstabBlock(fstab, 'does-not-exist'), fstab);
    });

    it('removing one entry does not touch a different entry with a similar name', () => {
      const a = nm.buildFstabBlock({ ...args, name: 'nas' });
      const b = nm.buildFstabBlock({ ...args, name: 'nas-2', mountPoint: '/opt/velvet/save/network-mounts/nas-2' });
      const fstab = a + b;
      const after = nm.removeFstabBlock(fstab, 'nas');
      assert.doesNotMatch(after, /velvet-network-mount:nas\n/);
      assert.match(after, /velvet-network-mount:nas-2/);
    });
  });

  describe('fstabHasMountPoint', () => {
    it('detects an existing mount point regardless of who put it there', () => {
      const fstab = '/dev/sdb1 /opt/velvet/save/network-mounts/x ext4 defaults 0 2\n';
      assert.equal(nm.fstabHasMountPoint(fstab, '/opt/velvet/save/network-mounts/x'), true);
    });
    it('ignores comments and blank lines', () => {
      const fstab = '# /opt/velvet/save/network-mounts/x was here once\n\n';
      assert.equal(nm.fstabHasMountPoint(fstab, '/opt/velvet/save/network-mounts/x'), false);
    });
    it('does not false-positive on a different path', () => {
      const fstab = '/dev/sdb1 /opt/velvet/save/network-mounts/x-2 ext4 defaults 0 2\n';
      assert.equal(nm.fstabHasMountPoint(fstab, '/opt/velvet/save/network-mounts/x'), false);
    });
  });

  describe('classifyMountError', () => {
    it('recognises the unprivileged-container signature', () => {
      assert.equal(nm.classifyMountError('mount.nfs: access denied by server while mounting x'), 'auth');
      assert.equal(nm.classifyMountError('Operation not permitted'), 'not-permitted');
      assert.equal(nm.classifyMountError('mount: /music: permission denied.'), 'auth');
    });
    it('recognises an unreachable server', () => {
      assert.equal(nm.classifyMountError('mount.nfs: Connection timed out'), 'unreachable');
      assert.equal(nm.classifyMountError('No route to host'), 'unreachable');
    });
    it('recognises an authentication failure', () => {
      assert.equal(nm.classifyMountError('mount error(13): Permission denied'), 'auth');
      assert.equal(nm.classifyMountError('Logon failure: unknown user name or bad password.'), 'auth');
    });
    it('falls back to generic for anything unrecognised', () => {
      assert.equal(nm.classifyMountError('mount: unknown filesystem type \'nfs\''), 'generic');
      assert.equal(nm.classifyMountError(''), 'generic');
      assert.equal(nm.classifyMountError(undefined), 'generic');
    });
  });
});
