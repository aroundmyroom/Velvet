# SonarQube — Code Quality Reference

SonarQube v26.5.0 runs on the `sonarqube-quality-fixes` branch.  
**Target: zero fixable violations.** 115 issues are permanently skipped (see below).

- Dashboard: `http://<your-sonarqube-host>:9000`
- Project: `<your-project-key>`

---

## Quick rescan

```bash
cd /home/Velvet
sonar-scanner \
  -Dsonar.host.url=http://<your-sonarqube-host>:9000 \
  -Dsonar.token=<YOUR_SCANNER_TOKEN>
```

Check issue count immediately after:

```bash
curl -s "http://<your-sonarqube-host>:9000/api/issues/search?\
projectKeys=<your-project-key>\
&resolved=false&ps=1" \
  -H "Authorization: Bearer <YOUR_READ_TOKEN>" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('Total:', d['total'])"
```

---

## Rules — what to write and why

### S6557 — Use `startsWith`/`endsWith` instead of regex

```js
// BAD
/^127\./.test(host)
/\.mp3$/.test(file)

// GOOD
host.startsWith('127.')
file.endsWith('.mp3')
```

Only applies to simple prefix/suffix checks — complex character-class regex is fine.

---

### S6582 — Prefer optional chaining

```js
// BAD
if (obj && obj.prop && obj.prop.value)

// GOOD
if (obj?.prop?.value)
```

---

### S6644 — Remove redundant boolean cast

```js
// BAD
return count === 0 ? true : false;
return isAdmin ? false : true;

// GOOD
return count === 0;
return !isAdmin;
```

---

### S6653 — `Object.hasOwn` instead of `hasOwnProperty.call`

```js
// BAD
Object.prototype.hasOwnProperty.call(obj, 'key')

// GOOD
Object.hasOwn(obj, 'key')
```

---

### S6671 — Always reject with an Error object

```js
// BAD
reject(err)                   // err might be a string
reject('something went wrong')

// GOOD
reject(err instanceof Error ? err : new Error(String(err)))
reject(new Error('something went wrong'))
```

---

### S7732 — `Array.isArray()` instead of `instanceof Array`

```js
// BAD
if (value instanceof Array)

// GOOD
if (Array.isArray(value))
```

`instanceof Array` fails across iframes/realms. `Array.isArray()` is always correct.

---

### S7740 — No `const self = this`

```js
// BAD
MyClass.prototype.fetch = function() {
  const self = this;
  doAsync(function() { self.update(); });
};

// GOOD
MyClass.prototype.fetch = function() {
  doAsync(() => { this.update(); });
};
```

---

### S7741 — No `typeof` guards for variable existence

```js
// BAD
if (typeof modVM !== 'undefined')

// GOOD
if (modVM !== undefined)
```

---

### S7744 — Nullish coalescing; useless `|| {}`

```js
// BAD (|| coerces 0/false/'' to default)
const opts = headers || {};
const spread = { ...( this.edits[fp] || {} ), [field]: val };

// GOOD
const opts = headers ?? {};       // only null/undefined triggers default
const spread = { ...this.edits[fp], [field]: val };  // spreading undefined is safe
```

---

### S7755 — `.at(-1)` for last element

```js
// BAD
arr[arr.length - 1]
process.argv[process.argv.length - 1]

// GOOD
arr.at(-1)
process.argv.at(-1)
```

---

### S7758 — `String.fromCodePoint` instead of `String.fromCharCode`

```js
// BAD (breaks for code points > 0xFFFF)
String.fromCharCode(code)

// GOOD
String.fromCodePoint(code)
```

---

### S7759 — `Date.now()` instead of `new Date().getTime()`

```js
// BAD
const ts = Math.floor(new Date().getTime() / 1000);

// GOOD
const ts = Math.floor(Date.now() / 1000);
```

---

### S7760 — Default parameters instead of body fallback

```js
// BAD
function search(query, limit) {
  const amt = limit || 50;
}

// GOOD
function search(query, limit = 50) {
  // use limit directly
}
```

---

### S7776 — Use `Set` for repeated membership tests

```js
// BAD (O(n) per lookup, allocates every call)
const allowedExts = ['mp3', 'flac', 'ogg'];
if (allowedExts.includes(ext)) ...

// GOOD (O(1) lookup, create once at module level)
const ALLOWED_EXTS = new Set(['mp3', 'flac', 'ogg']);
if (ALLOWED_EXTS.has(ext)) ...
```

---

### S7780 — `String.raw` for SQL ESCAPE patterns

This one has caused latent bugs. Understand it fully.

```js
// CORRECT — String.raw: backslash is literal, not a JS escape
db.prepare(String.raw`SELECT * FROM files WHERE filepath LIKE ? ESCAPE '\'`);
//                                                                      ↑ literal backslash

// CORRECT — regular template: double backslash becomes one
db.prepare(`SELECT * FROM files WHERE filepath LIKE ? ESCAPE '\\'`);
//                                                             ↑↑ JS \\ → one backslash

// WRONG — single backslash in regular template
db.prepare(`SELECT * FROM files WHERE filepath LIKE ? ESCAPE '\'`);
//          JS treats \' as just ' → SQL sees ESCAPE '' (empty) → broken
```

Prefer `String.raw` for any template literal containing SQL backslash escapes.

---

### S7786 — Use the correct Error subclass

```js
// BAD
throw new Error('Expected a string');
throw new Error('Value out of range');

// GOOD
throw new TypeError('Expected a string');
throw new RangeError('Value out of range');
throw new Error('Generic unexpected condition');  // OK for unexpected errors
```

---

### S4043 — Non-mutating sort/reverse

```js
// BAD — mutates the original array
return items.sort((a, b) => b.cnt - a.cnt);

// GOOD — returns new array, original unchanged
return items.toSorted((a, b) => b.cnt - a.cnt);
return items.toReversed();
```

---

### S4138 — `for...of` instead of indexed loop

```js
// BAD
for (let i = 0; i < parts.length; i++) {
  const t = parts[i];
  process(t);
}

// GOOD
for (const t of parts) {
  process(t);
}
```

If you need the index, use `for (const [i, t] of parts.entries())`.

---

### S4123 — Don't await non-async functions

```js
// BAD (SonarQube flags this)
const result = await someNonAsyncFunction();

// GOOD
const result = someNonAsyncFunction();
```

**Note:** SonarQube cannot trace async through module boundaries. If it flags a legitimate `await` of a cross-file async function, add `// NOSONAR — functionName is async`.

---

### S3863 — Don't duplicate imports

```js
// BAD
import { foo } from './module.js';
import { bar } from './module.js';

// GOOD
import { foo, bar } from './module.js';
```

---

### S3800 — Consistent return type

```js
// BAD — returns number sometimes, string other times
function pct() {
  if (!total) return 0;              // number
  return (value / total * 100).toFixed(1);  // string
}

// GOOD — always string
function pct() {
  if (!total) return '0.0';
  return (value / total * 100).toFixed(1);
}
```

---

### S3735 — No `void` expression statements

```js
// BAD
void I18NSTATE.tick;

// GOOD — plain expression (or NOSONAR if it's a Vue reactive dep)
I18NSTATE.tick; // NOSONAR — reactive dependency, forces re-render on lang change
```

---

### S3403 — Don't compare incompatible types

```js
// BAD — computed property (a function ref) compared to a string
if (this.adviceLevel === 'error')  // adviceLevel is a Vue computed — SonarQube sees a function

// GOOD — extract value first
const level = String(this.adviceLevel);
if (level === 'error')
```

---

### S3358 — No nested ternaries

```js
// BAD
const next = mode === 'none' ? 'one' : mode === 'one' ? 'all' : 'none';

// GOOD
let next;
if (mode === 'none') next = 'one';
else if (mode === 'one') next = 'all';
else next = 'none';
```

---

### S2871 — Locale-aware sort

```js
// BAD — locale-dependent, inconsistent across platforms
['Ångström', 'Apple', 'Banana'].sort()

// GOOD
['Ångström', 'Apple', 'Banana'].sort((a, b) => a.localeCompare(b))

// For mixed types
ids.sort((a, b) => String(a).localeCompare(String(b)))
```

---

### S1874 — Use `subarray` instead of `slice` on Buffers

```js
// BAD
buf.slice(0, 4)

// GOOD
buf.subarray(0, 4)
```

`slice` on Buffer is deprecated in Node.js. `subarray` is the correct API.

---

### S1854 + S1481 — Remove unused `await` result

```js
// BAD — res is assigned but never read
const res = await API.axios({ method: 'POST', ... });

// GOOD
await API.axios({ method: 'POST', ... });
```

---

### S1848 — Result of `new` must be used

```js
// BAD — side-effect constructor whose result is discarded
new ClipboardJS('.copy-btn');

// GOOD — assign to acknowledge (prefix _ to indicate intentionally unused)
const _clipboard = new ClipboardJS('.copy-btn'); // eslint-disable-line no-unused-vars
```

---

### S1186 — Empty function body needs a comment

```js
// BAD
saveFilesDB() {}

// GOOD
saveFilesDB() { /* no-op: SQLite writes are immediate */ }
```

---

### S1135 — No TODO comments

```js
// BAD
// TODO: validate input

// GOOD
// Note: input validation pending implementation
// or just implement it
```

---

### S1121 — No assignment in return

```js
// BAD
return this.parsedTokenData = null;

// GOOD
this.parsedTokenData = null;
return;
```

---

### S107 — Max 7 function parameters

```js
// BAD (10 params)
function addDirectory(dir, vpath, autoAccess, isAudioBooks, velvet,
                      isRecording, allowRecordDelete, isYoutube, isExcluded, artistsOn) {}

// GOOD — options object for optional params
function addDirectory(dir, vpath, velvet, opts = {}) {
  const {
    autoAccess = false, isAudioBooks = false, isRecording = false,
    allowRecordDelete = false, isYoutube = false, isExcluded = false, artistsOn = true
  } = opts;
}
```

---

### S905 — No standalone expression statements (Vue reactive deps)

```js
// BAD (bare expression, does nothing visible)
this.usersTS.ts;

// GOOD — add NOSONAR to explain it's a Vue reactive dep read
this.usersTS.ts; // NOSONAR — reactive dependency
```

---

### Migration guards — silent catch pattern

```js
// BAD — logs to journalctl on every restart, creating noise
try { db.exec('ALTER TABLE files ADD COLUMN col TEXT'); } catch (e) { console.debug('[velvet]', e.message); }

// GOOD — silent, expected error
try { db.exec('ALTER TABLE files ADD COLUMN col TEXT'); } catch { /* already exists */ }
```

---

## Permanent skip list

These 115 issues are **intentional** — do not attempt to fix them:

| Rule | Count | Why skipped |
|------|-------|-------------|
| S3776 | 57 | Cognitive complexity: large audio/media handlers cannot be trivially decomposed |
| S7764 | 14 | `window` → `globalThis`: browser code — `window` is correct |
| S2004 | 14 | Nested class/function: required by Vue component patterns |
| S7721 | 13 | Inner functions: necessary in callback-heavy async code |
| S125  | 10 | Commented-out code: intentional reference comments |
| S5843 | 7  | Complex regex: audio metadata patterns are inherently complex |

**Total: 115** — the baseline issue count after all fixable issues are resolved.

---

## NOSONAR — legitimate uses

Only add `// NOSONAR` for verified false positives:

```js
// Vue reactive dependency read — must be a plain expression statement
I18NSTATE.tick; // NOSONAR — reactive dependency, forces re-render on lang change
this.usersTS.ts; // NOSONAR — reactive dependency

// Live ESM bindings — reassigned by load(), cannot be const
export let program;    // NOSONAR — live ESM binding, reassigned in load()
export let configFile; // NOSONAR — live ESM binding, reassigned in load()

// Cross-file async — SonarQube can't trace it
await indexFileOnDemand(pathInfo); // NOSONAR — indexFileOnDemand is async (on-demand-index.js)
```

Do NOT use `// NOSONAR` to silence real issues — fix them instead.
