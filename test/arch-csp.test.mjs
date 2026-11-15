import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { walk, parse, visit, isHidden, ownWebappJs, maskedText, lineOf, rel, where, report } from './helpers/arch.mjs';

const HTML_FILES = walk('webapp', /\.html?$/);
const TAG = /<[a-zA-Z][^<>]*/g;
const HANDLER_ATTR = /\s(on[a-z]+)\s*=/g;

function handlerAttrs(text) {
  const out = [];
  for (const tag of text.matchAll(TAG)) {
    for (const a of tag[0].matchAll(HANDLER_ATTR)) out.push({ index: tag.index + a.index + 1, name: a[1] });
  }
  return out;
}
const SCRIPT_TAG = /<script\b([^>]*)>/gi;
const DATA_SCRIPT = /\btype\s*=\s*["']?(application\/(ld\+)?json|text\/template|importmap)/i;

describe('architecture: CSP-safe markup', () => {
  it('no inline on*= handler attributes in webapp HTML', () => {
    const hits = [];
    for (const file of HTML_FILES) {
      const text = maskedText(file);
      for (const a of handlerAttrs(text)) hits.push(`${rel(file)}:${lineOf(text, a.index)} (${a.name}=)`);
    }
    assert.equal(hits.length, 0, report('Inline event handler attributes in HTML (blocked by the CSP)', hits,
      'remove the on*= attribute and bind the handler with addEventListener in the page script.'));
  });

  it('no inline <script> blocks in webapp HTML', () => {
    const hits = [];
    for (const file of HTML_FILES) {
      const text = maskedText(file);
      for (const m of text.matchAll(SCRIPT_TAG)) {
        if (/\bsrc\s*=/.test(m[1]) || DATA_SCRIPT.test(m[1])) continue;
        hits.push(`${rel(file)}:${lineOf(text, m.index)}`);
      }
    }
    assert.equal(hits.length, 0, report('Inline <script> without src (blocked by the CSP)', hits,
      'move the code into a .js file next to the page and load it with <script src="…">.'));
  });

  it('no inline on*= handlers in HTML built by webapp JavaScript', () => {
    const hits = [];
    for (const file of ownWebappJs()) {
      visit(parse(file), (n) => {
        if (isHidden(file, n.start)) return false;
        let text = null;
        if (n.type === 'Literal' && typeof n.value === 'string') text = n.value;
        else if (n.type === 'TemplateLiteral') text = n.quasis.map((q) => q.value.raw).join('${}');
        else if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && n.callee.property.name === 'setAttribute'
          && n.arguments[0]?.type === 'Literal' && /^on[a-z]+$/i.test(n.arguments[0].value)) {
          hits.push(where(file, n));
          return;
        }
        if (!text || !text.includes('<')) return;
        for (const a of handlerAttrs(text)) hits.push(`${rel(file)}:${n.loc.start.line + lineOf(text, a.index) - 1} (${a.name}=)`);
      });
    }
    assert.equal(hits.length, 0, report('Inline event handlers in markup strings (blocked by the CSP)', hits,
      'drop the on*= attribute; attach the listener after inserting the HTML (or use a delegated listener on the container).'));
  });
});
