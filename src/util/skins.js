// Skins: a folder holding a skin.css, loaded by the web player after style.css.
// Built-in skins ship in webapp/skins/; the admin's own go in storage.skinsDirectory
// (save/skins by default) and win when a name exists in both.

import fs from 'node:fs';
import path from 'node:path';
import * as config from '../state/config.js';

export const SKIN_NAME = /^[a-z0-9_-]{1,40}$/;

export function listSkins() {
  const found = new Map();
  for (const dir of [path.join(config.program.webAppDirectory, 'skins'), config.program.storage.skinsDirectory]) {
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!SKIN_NAME.test(name)) continue;
      try {
        const st = fs.statSync(path.join(dir, name, 'skin.css'));
        if (st.isFile()) found.set(name, { id: name, v: Math.round(st.mtimeMs).toString(36) });
      } catch { /* folder without a skin.css */ }
    }
  }
  return [...found.values()].sort((a, b) => a.id.localeCompare(b.id));
}
