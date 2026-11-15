import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { abs, parse, visit, isHidden, rel, report } from './helpers/arch.mjs';

// Ratchet: hardcoded English found by the heuristic below. These numbers may only go down.
// When you remove some, lower the number here to the new count printed by the test.
const MAX = {
  'webapp/app.js': 0,
  'webapp/admin/index.js': 0,
  'webapp/shared/app.js': 0,
  'webapp/mobile/app.js': 0,
  'webapp/tizen/app.js': 0,
};

// Text that is not translatable: brand, product, format or tag-frame names. Matched against the
// whitespace-collapsed finding text.
const ALLOW = [
  { file: 'webapp/app.js', text: 'Opus / OGG', reason: 'codec/container names' },
  { file: 'webapp/admin/index.js', text: '&#x1F4BF; MusicBrainz', reason: 'brand name after an emoji entity' },
  { file: 'webapp/admin/index.js', text: '&nbsp;&#x1F4BF; MusicBrainz', reason: 'brand name after an emoji entity' },
  { file: 'webapp/admin/index.js', text: 'Claude Haiku 5.5 —', reason: 'model product name' },
  { file: 'webapp/admin/index.js', text: 'Claude Sonnet 5.5', reason: 'model product name' },
  { file: 'webapp/admin/index.js', text: 'Claude Opus 5.5', reason: 'model product name' },
  { file: 'webapp/admin/index.js', text: '· LM Studio —', reason: 'local AI server product name' },
  { file: 'webapp/admin/index.js', text: '· llama.cpp (llama-server) —', reason: 'local AI server product name' },
  { file: 'webapp/admin/index.js', text: 'SMB / CIFS', reason: 'network protocol names' },
  { file: 'webapp/admin/index.js', text: 'TXXX : EDITION = Deluxe Edition ↑ ↑', reason: 'ID3 tag-frame syntax example' },
  { file: 'webapp/admin/index.js', text: 'TXXX → EDITION', reason: 'ID3 tag-frame name' },
  { file: 'webapp/admin/index.js', text: 'TXXX → VERSION', reason: 'ID3 tag-frame name' },
  { file: 'webapp/admin/index.js', text: 'TXXX → QUALITY', reason: 'ID3 tag-frame name' },
  { file: 'webapp/admin/index.js', text: 'TXXX → REMASTER', reason: 'ID3 tag-frame name' },
  { file: 'webapp/admin/index.js', text: 'Deluxe Edition', reason: 'example tag value, like the 2016 Remaster examples next to it' },
  { file: 'webapp/admin/index.js', text: 'GNU General Public License v3.0', reason: 'licence name, linked to its official text' },
];
const allowEntry = (file, text) => ALLOW.find((a) => a.file === file && a.text === text.replace(/\s+/g, ' ').trim());

const HOLE = '\u0000';
const ATTR = /(?<![\w:@.-])(title|placeholder|aria-label|alt)=(["'])(.*?)\2/g;
const TEXT_NODE = />([^<>]+)</g;
const SKIP_CALLEES = new Set(['t', 'console.log', 'console.warn', 'console.error', 'console.info', 'console.debug']);

function englishWords(text) {
  const plain = text.split(HOLE).join(' ').replace(/&[a-z]+;|&#\d+;/g, '');
  return plain.split(/\s+/).filter((w) => /[A-Za-z]{2,}/.test(w)).length;
}

function calleeName(c) {
  if (c.type === 'Identifier') return c.name;
  if (c.type === 'MemberExpression' && !c.computed && c.property.type === 'Identifier') {
    return c.object.type === 'Identifier' ? `${c.object.name}.${c.property.name}` : c.property.name;
  }
  return null;
}

function stringText(n) {
  if (n.type === 'Literal' && typeof n.value === 'string') return n.value;
  if (n.type === 'TemplateLiteral') return n.quasis.map((q) => q.value.cooked ?? q.value.raw).join(HOLE);
  return null;
}

function findings(file) {
  const out = [];
  visit(parse(file), (n, ancestors) => {
    if (isHidden(file, n.start)) return false;
    if (n.type === 'CallExpression') {
      const name = calleeName(n.callee);
      if (SKIP_CALLEES.has(name) || name === 'this.t') return false;
      if (name === 'toast' || name?.endsWith('.toast')) {
        const text = n.arguments[0] && stringText(n.arguments[0]);
        if (text != null && !text.includes('<') && englishWords(text) >= 2) out.push({ line: n.loc.start.line, text: `toast: ${text}` });
      }
      return;
    }
    if (n.type === 'NewExpression' && n.callee.name === 'Error') return false;
    const raw = stringText(n);
    if (raw == null || ancestors.at(-1)?.type === 'TemplateLiteral' || !raw.includes('<')) return;
    const blank = (s) => s.replace(/[^\n]/g, ' ');
    const text = raw
      .replace(/<(style|script)\b[\s\S]*?<\/\1>/gi, blank)
      .replace(/\{\{[\s\S]*?\}\}/g, blank)
      .replace(/\s(?:[:@#]|v-)[\w:.-]*=("[^"]*"|'[^']*')/g, blank);
    const lineAt = (i) => n.loc.start.line + (text.slice(0, i).match(/\n/g) || []).length;
    for (const m of text.matchAll(TEXT_NODE)) {
      if (englishWords(m[1]) >= 2) out.push({ line: lineAt(m.index), text: m[1].trim() });
    }
    for (const m of text.matchAll(ATTR)) {
      if (!m[3].includes(HOLE) && !m[3].includes('{{') && englishWords(m[3]) >= 2) out.push({ line: lineAt(m.index), text: `${m[1]}="${m[3]}"` });
    }
  });
  return out;
}

describe('architecture: hardcoded user-visible English (ratchet)', () => {
  const used = new Set();
  for (const [file, max] of Object.entries(MAX)) {
    it(`${file} has at most ${max} hardcoded English strings`, (t) => {
      const found = findings(abs(file)).filter((f) => {
        const entry = allowEntry(file, f.text);
        if (entry) used.add(entry);
        return !entry;
      });
      if (found.length < max) t.diagnostic(`${file}: ${found.length} found, lower MAX['${file}'] in ${rel(abs('test/arch-hardcoded-text.test.mjs'))} to ${found.length}`);
      assert.ok(found.length <= max, report(`Hardcoded English in ${file}: ${found.length} found, ratchet allows ${max}`,
        found.map((f) => `${file}:${f.line} ${f.text.replace(/\s+/g, ' ').slice(0, 100)}`),
        "wrap the text in t('player.…') / this.t('admin.…') and add the key to all 12 locales. Never raise MAX."));
    });
  }

  it('every ALLOW entry still matches a finding', () => {
    const stale = ALLOW.filter((a) => !used.has(a)).map((a) => `${a.file}: ${a.text}`);
    assert.equal(stale.length, 0, report('Stale ALLOW entries in test/arch-hardcoded-text.test.mjs', stale, 'remove them.'));
  });
});
