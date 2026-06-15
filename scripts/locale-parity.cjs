#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const LOCALES_DIR = path.join(__dirname, '..', 'webapp', 'locales');
const OTHER_LANGS = ['nl', 'de', 'fr', 'es', 'it', 'pt', 'pl', 'ru', 'zh', 'ja', 'ko'];

const en = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, 'en.json'), 'utf8'));
const enKeys = Object.keys(en);

let failed = false;
for (const lang of OTHER_LANGS) {
  const d = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, `${lang}.json`), 'utf8'));
  const missing = enKeys.filter(k => !(k in d));
  if (missing.length) {
    failed = true;
    console.error(`${lang}: MISSING ${missing.length} key(s): ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ' …' : ''}`);
  } else {
    console.log(`${lang}: OK (${Object.keys(d).length})`);
  }
}

if (failed) {
  console.error('\nLocale files are out of sync. Add the missing keys (English value as placeholder) — see CLAUDE.md "Quick sync command".');
  process.exit(1);
}
console.log(`\nAll ${OTHER_LANGS.length} locales in sync with en.json (${enKeys.length} keys).`);
