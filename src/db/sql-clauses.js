function escapeLike(prefix) {
  return prefix.replaceAll(/[%_\\]/g, String.raw`\$&`) + '%';
}

export function inClause(column, values) {
  if (values.length === 0) { return { sql: '1=0', params: [] }; }
  const placeholders = values.map(() => '?').join(',');
  return { sql: `${column} IN (${placeholders})`, params: values };
}

// Generates NOT clauses to exclude filepath prefixes under specific vpaths.
export function excludePrefixClauses(excludeFilepathPrefixes, vpathCol = 'vpath', pathCol = 'filepath') {
  if (!Array.isArray(excludeFilepathPrefixes) || excludeFilepathPrefixes.length === 0) {
    return { sql: '', params: [] };
  }
  const parts = [];
  const params = [];
  for (const { vpath, prefix } of excludeFilepathPrefixes) {
    parts.push(String.raw`NOT (${vpathCol} = ? AND ${pathCol} LIKE ? ESCAPE '\')`);
    params.push(vpath, escapeLike(prefix));
  }
  return { sql: ' AND ' + parts.join(' AND '), params };
}

// Whitelists filepath prefixes per named vpath; vpaths not named pass through
// unrestricted: AND (vpath != 'parent' OR (filepath LIKE 'prefix1%' OR ...))
export function includePrefixClauses(includeFilepathPrefixes, vpathCol = 'vpath', pathCol = 'filepath') {
  if (!Array.isArray(includeFilepathPrefixes) || includeFilepathPrefixes.length === 0) {
    return { sql: '', params: [] };
  }
  const byVpath = {};
  for (const { vpath, prefix } of includeFilepathPrefixes) {
    if (!byVpath[vpath]) byVpath[vpath] = [];
    byVpath[vpath].push(prefix);
  }
  const parts = [];
  const params = [];
  for (const [vpath, prefixes] of Object.entries(byVpath)) {
    const orParts = prefixes.map(() => String.raw`${pathCol} LIKE ? ESCAPE '\'`);
    parts.push(`(${vpathCol} != ? OR (${orParts.join(' OR ')}))`);
    params.push(vpath, ...prefixes.map(escapeLike));
  }
  return { sql: ' AND ' + parts.join(' AND '), params };
}
