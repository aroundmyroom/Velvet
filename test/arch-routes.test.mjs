import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { collectRoutes, docRows, report } from './helpers/arch.mjs';

const undocumentedOk = (key) => /^\w+ \/rest\//.test(key)
  || /^ALL \/.+\/:p$/.test(key)
  || key === 'GET :p'
  || /\/index\.html$/.test(key);

// `ALL` code routes count as documented by a row for any concrete verb on the same path
// (e.g. the Sonos UPnP callback `ALL /api/v1/sonos/event` is documented as `NOTIFY`).
const ALL_VERBS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'NOTIFY'];

describe('architecture: routes', () => {
  const { routes, unresolved } = collectRoutes();

  it('every route path is statically resolvable', () => {
    assert.equal(unresolved.length, 0, report('Route registrations whose path is not a string literal or a template of module string constants', unresolved,
      'register routes with a literal path (or a template built from top-level `const X = \'...\'` strings) so docs/API.md can be checked against it.'));
  });

  it('every registered route has a row in docs/API.md', () => {
    const docs = new Set(docRows().map((r) => r.key));
    const missing = [];
    const seen = new Set();
    for (const r of routes) {
      if (seen.has(r.key) || undocumentedOk(r.key) || docs.has(r.key)) continue;
      seen.add(r.key);
      const p = r.key.slice(r.method.length + 1);
      if (r.method === 'ALL' && ALL_VERBS.some((m) => docs.has(`${m} ${p}`))) continue;
      missing.push(`${r.method} ${r.path}   (${r.at})`);
    }
    assert.equal(missing.length, 0, report('Routes registered in src/ but missing from docs/API.md', missing,
      'add a `| `METHOD` | `/path` | … |` row to the matching section of docs/API.md (Subsonic /rest/* goes in docs/subsonic.md instead).'));
  });

  it('every docs/API.md row has a registered route', () => {
    const code = new Set(routes.map((r) => r.key));
    const phantom = docRows()
      .filter((d) => !d.key.includes(' /rest/'))
      .filter((d) => !code.has(d.key) && !code.has(`ALL ${d.key.slice(d.method.length + 1)}`))
      .map((d) => `${d.method} ${d.path}   (${d.at})`);
    assert.equal(phantom.length, 0, report('docs/API.md rows with no matching route in src/', phantom,
      'remove the row (the route is gone) or fix its method/path to match the code.'));
  });

  it('no route is registered twice', () => {
    const first = new Map();
    const dupes = [];
    for (const r of routes) {
      const prev = first.get(r.key);
      if (!prev || prev.passThrough) first.set(r.key, r);
      else if (prev.site !== r.site) dupes.push(`${r.key}   first ${prev.at}, again ${r.at}`);
    }
    assert.equal(dupes.length, 0, report('Duplicate route registrations (same method and path; Express treats `/x` and `/x/` as one path)', dupes,
      'delete the shadowed copy; Express only runs the first handler that answers, so the second is dead. A gate that ends in `next()` is fine.'));
  });
});
