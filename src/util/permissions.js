import * as config from '../state/config.js';

export function canCastToServer(user) {
  return user?.admin === true || user?.['allow-mpv-cast'] === true;
}

export function canUseServerRemote(user) {
  return user?.admin === true || (config.program.serverAudio?.enabled === true && user?.['allow-server-remote'] !== false);
}
