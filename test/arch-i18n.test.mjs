import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { abs, rel, walk, maskedText, lineOf, report } from './helpers/arch.mjs';

const LOCALE_DIR = abs('webapp/locales');
const LOCALES = fs.readdirSync(LOCALE_DIR).filter((f) => f.endsWith('.json') && f !== 'languages.json').sort();
const load = (f) => JSON.parse(fs.readFileSync(path.join(LOCALE_DIR, f), 'utf8'));

const SOURCES = [
  abs('webapp/app.js'), abs('webapp/index.html'),
  ...walk('webapp/admin', /\.(js|html)$/), ...walk('webapp/shared', /\.(js|html)$/),
  ...walk('webapp/mobile', /\.(js|html)$/), ...walk('webapp/tizen', /\.(js|html)$/),
];

const KEY = String.raw`[A-Za-z][\w-]*(?:\.[\w-]+)+`;
const PATTERNS = [
  new RegExp(String.raw`(?<![\w$])t\(\s*(['"\x60])(${KEY})\1(?!\s*\+)`, 'g'),
  new RegExp(String.raw`data-i18n=(["'])(${KEY})\1`, 'g'),
];

function usedKeys() {
  const out = [];
  for (const file of SOURCES) {
    const text = maskedText(file);
    for (const re of PATTERNS) {
      for (const m of text.matchAll(re)) out.push({ key: m[2], at: `${rel(file)}:${lineOf(text, m.index)}` });
    }
  }
  return out;
}

describe('architecture: i18n', () => {
  it('every literal i18n key used in the web UIs exists in en.json', () => {
    const en = load('en.json');
    const missing = usedKeys().filter((u) => !(u.key in en)).map((u) => `${u.at} ${u.key}`);
    assert.equal(missing.length, 0, report('i18n keys used in code but missing from webapp/locales/en.json', missing,
      'add the key to en.json (English), nl.json (Dutch) and the other 10 locales (English placeholder), or fix the typo.'));
  });

  it(`all ${LOCALES.length} locale files have exactly the same key set as en.json`, () => {
    assert.equal(LOCALES.length, 12, `expected 12 locale files in webapp/locales, found ${LOCALES.length}: ${LOCALES.join(', ')}`);
    const enKeys = new Set(Object.keys(load('en.json')));
    const problems = [];
    for (const f of LOCALES) {
      if (f === 'en.json') continue;
      const keys = new Set(Object.keys(load(f)));
      const missing = [...enKeys].filter((k) => !keys.has(k));
      const extra = [...keys].filter((k) => !enKeys.has(k));
      if (missing.length) problems.push(`webapp/locales/${f} is missing ${missing.length}: ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ', …' : ''}`);
      if (extra.length) problems.push(`webapp/locales/${f} has ${extra.length} keys not in en.json: ${extra.slice(0, 10).join(', ')}${extra.length > 10 ? ', …' : ''}`);
    }
    assert.equal(problems.length, 0, report('Locale files out of sync with en.json', problems,
      'add missing keys (English placeholder is fine outside en/nl) and delete keys that were removed from en.json.'));
  });
});
