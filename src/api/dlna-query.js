const SORT_PROP_MAP = {
  'dc:title':                 'f.title COLLATE NOCASE',
  'dc:creator':               'f.artist COLLATE NOCASE',
  'upnp:artist':              'f.artist COLLATE NOCASE',
  'upnp:album':               'f.album COLLATE NOCASE',
  'upnp:genre':               'f.genre COLLATE NOCASE',
  'upnp:originalTrackNumber': 'f.track',
  'dc:date':                  'f.year',
  'upnp:originalYear':        'f.year',
  'res@duration':             'f.duration',
};

const SEARCH_PROP_MAP = {
  'dc:title':                 "COALESCE(f.title, '')",
  'dc:creator':               "COALESCE(f.artist, '')",
  'upnp:artist':              "COALESCE(f.artist, '')",
  'upnp:album':               "COALESCE(f.album, '')",
  'upnp:genre':               "COALESCE(f.genre, '')",
  'upnp:originalTrackNumber': 'f.track',
};

export function buildOrderBy(sortTerms, defaultOrder) {
  if (!sortTerms?.length) return defaultOrder;
  const clauses = sortTerms.map(term => {
    const column = SORT_PROP_MAP[term.prop];
    if (!column) return null;
    return `${column} ${term.dir === '-' ? 'DESC' : 'ASC'}`;
  }).filter(Boolean);
  return clauses.length ? clauses.join(', ') : defaultOrder;
}

export function tokenizeSearch(input) {
  const tokens = [];
  const re = /"(?:[^"\\]|\\.)*"|!=|<=|>=|[()=!<>]|[\w:.]+/g;
  for (const match of (input || '').matchAll(re)) tokens.push(match[0]);
  return tokens;
}

class SearchParser {
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

export function searchNodeToSql(node, params) {
  if (!node) return '1=1';
  if (node.op === 'and') return `(${searchNodeToSql(node.left, params)} AND ${searchNodeToSql(node.right, params)})`;
  if (node.op === 'or') return `(${searchNodeToSql(node.left, params)} OR ${searchNodeToSql(node.right, params)})`;
  if (node.op === 'rel') {
    const { property, relOp, value } = node;
    if (property === 'upnp:class') {
      if (relOp === 'exists') return value === 'true' ? '1=1' : '1=0';
      if (relOp === '=' || relOp === 'derivedfrom') return (value.includes('audioItem') || value === '*') ? '1=1' : '1=0';
      return '1=1';
    }
    const column = SEARCH_PROP_MAP[property];
    if (!column) return '1=1';
    const escaped = value.replaceAll('\\', String.raw`\\`).replaceAll('%', String.raw`\%`).replaceAll('_', String.raw`\_`);
    switch (relOp) {
      case '=': params.push(value); return `${column} = ?`;
      case '!=': params.push(value); return `${column} != ?`;
      case 'contains': params.push(`%${escaped}%`); return String.raw`${column} LIKE ? ESCAPE '\'`;
      case 'doesnotcontain': params.push(`%${escaped}%`); return String.raw`(${column} NOT LIKE ? ESCAPE '\')`;
      case 'startswith': params.push(`${escaped}%`); return String.raw`${column} LIKE ? ESCAPE '\'`;
      case 'exists': return value === 'true' ? `${column} IS NOT NULL` : `${column} IS NULL`;
      default: return '1=1';
    }
  }
  return '1=1';
}
