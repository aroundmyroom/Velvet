import fsp from 'node:fs/promises';
import winston from 'winston';

// Rooms keeps running unless the archive carries its files; the listener restarts even when the restore fails.
export async function restoreRoomsFromImport(sendspinSrc, { rooms, restore }) {
  const hasSendspin = await fsp.access(sendspinSrc).then(() => true, () => false);
  try {
    if (hasSendspin) {
      // Stop first: a running server would flush its old trust store over the restored one.
      await rooms.stop();
      await restore(sendspinSrc);
    }
  } catch (e) {
    winston.warn(`[migrate] Velvet Rooms restore failed: ${e.message}`);
  } finally {
    if (hasSendspin || rooms.settingsChanged()) {
      await rooms.applySettings().catch((e) => winston.warn(`[migrate] Velvet Rooms restart failed: ${e.message}`));
    }
  }
  return hasSendspin;
}
