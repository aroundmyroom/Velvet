export function tokenizeSearch(input) {
  const tokens = [];
  const re = /"(?:[^"\\]|\\.)*"|!=|<=|>=|[()=!<>]|[\w:.]+/g;
  for (const match of (input || '').matchAll(re)) tokens.push(match[0]);
  return tokens;
}

export class SearchParser {
  constructor(tokens) { this.tokens = tokens; this.pos = 0; }
  peek() { return this.tokens[this.pos]; }
  next() { return this.tokens[this.pos++]; }
  parse() { return this.tokens.length ? this.parseOr() : null; }
  parseOr() {
    let left = this.parseAnd();
    while (this.peek()?.toLowerCase() === 'or') { this.next(); left = { op: 'or', left, right: this.parseAnd() }; }
    return left;
  }
  parseAnd() {
    let left = this.parseRelational();
    while (this.peek()?.toLowerCase() === 'and') { this.next(); left = { op: 'and', left, right: this.parseRelational() }; }
    return left;
  }
  parseRelational() {
    if (this.peek() === '(') { this.next(); const node = this.parseOr(); if (this.peek() === ')') { this.next(); } return node; }
    const property = this.next();
    const relOp = this.next();
    let value = this.next() || '';
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    return { op: 'rel', property, relOp: relOp?.toLowerCase(), value };
  }
}
