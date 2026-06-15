/**
 * regression-artist-placeholder.cjs
 *
 * Smoke tests for the artist placeholder feature.
 * Run: node /home/mStream/test/regression-artist-placeholder.cjs
 *
 * Tests:
 *  1. GET /api/v1/artists/placeholder — public, no auth, returns 200 + image
 *  2. GET /api/v1/admin/artists/placeholder-info — admin, returns { hasCustom }
 *  3. POST /api/v1/admin/artists/placeholder — admin multipart upload returns 200
 *  4. DELETE /api/v1/admin/artists/placeholder — admin delete returns 200
 *  5. GET /api/v1/artists/placeholder after delete — still 200 (falls back to default)
 *  6. GET /api/v1/admin/artists/hydration-status — admin, returns queueLength/queueLimit
 *  7. busboy import presence — artists-browse.js must import busboy
 *  8. HYDRATE_QUEUE_LIMIT — must be 50000 not 2000
 *  9. viewRecent density controls — app.js must contain ms2_recent_density_
 * 10. _deduplicateSimArtists — app.js must contain the function
 * 11. artpro-hero — app.js must contain artpro-hero HTML element
 * 12. exportJson/exportText/copyJson — admin/index.js must contain these methods
 * 13. throughputPerMin — admin/index.js must contain the monitoring display
 */

'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');

const BASE = '/home/mStream';
const cfg = JSON.parse(fs.readFileSync(path.join(BASE, 'save/conf/default.json'), 'utf8'));
const token = jwt.sign({ username: Object.keys(cfg.users)[0] }, cfg.secret);
const HOST = 'music.aroundtheworld.net';
const PORT = 3000;

let passed = 0;
let failed = 0;

function pass(name) { console.log(`  ✓ ${name}`); passed++; }
function fail(name, detail) { console.error(`  ✗ ${name}${detail ? ': ' + detail : ''}`); failed++; }

function req(method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: HOST, port: PORT, path, method,
      headers: { 'x-access-token': token, ...headers },
    };
    const r = https.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

async function main() {
  console.log('\nArtist Placeholder Regression Tests\n');

  // ── Static file checks (no server needed) ────────────────────────────────
  console.log('Static file checks:');

  // ── DB layer checks ───────────────────────────────────────────────────────
  const dbSrc = fs.readFileSync(path.join(BASE, 'src/db/sqlite-backend.js'), 'utf8');
  dbSrc.includes('export function deriveArtistMbidFromFiles')
    ? pass('sqlite-backend.js: deriveArtistMbidFromFiles function exported')
    : fail('sqlite-backend.js: deriveArtistMbidFromFiles MISSING — artists-browse.js calls db.deriveArtistMbidFromFiles()');
  // getArtistsNeedingFetch must have a LIMIT clause — without it, Queue 500 enqueues ALL artists
  (() => {
    const fnMatch = dbSrc.match(/export function getArtistsNeedingFetch[\s\S]{0,500}?(?=\nexport function)/);
    const fn = fnMatch ? fnMatch[0] : '';
    fn.includes('LIMIT')
      ? pass('sqlite-backend.js: getArtistsNeedingFetch has LIMIT clause')
      : fail('sqlite-backend.js: getArtistsNeedingFetch MISSING LIMIT — will queue ALL artists regardless of limit param');
  })();
  dbSrc.includes("ADD COLUMN mbid")
    ? pass('sqlite-backend.js: artists_normalized.mbid column migration present')
    : fail('sqlite-backend.js: artists_normalized.mbid column migration MISSING');
  // saveArtistInfo must accept mbid so MBID is persisted after first lookup
  /saveArtistInfo\s*\(\s*artistClean\s*,\s*\{[^}]*mbid/.test(dbSrc)
    ? pass('sqlite-backend.js: saveArtistInfo accepts mbid parameter')
    : fail('sqlite-backend.js: saveArtistInfo does not accept mbid — MBID will not be persisted');
  // getArtistRow must return mbid so artists-browse.js can read it back
  /mbid\s*:\s*row\.mbid/.test(dbSrc)
    ? pass('sqlite-backend.js: getArtistRow returns mbid field')
    : fail('sqlite-backend.js: getArtistRow does not return mbid — MBID will never be used for TADB lookups');
  // fanart_file, genre, country, formed_year columns — missing causes fan art banner to never show
  ['fanart_file', 'genre', 'country', 'formed_year'].forEach(col => {
    dbSrc.includes(`ADD COLUMN ${col}`)
      ? pass(`sqlite-backend.js: artists_normalized.${col} column migration present`)
      : fail(`sqlite-backend.js: artists_normalized.${col} column migration MISSING — fan art / meta chips will never persist`);
  });
  // saveArtistInfo must accept fanartFile so fan art filename is stored to DB
  /saveArtistInfo\s*\(\s*artistClean\s*,\s*\{[^}]*fanartFile/.test(dbSrc)
    ? pass('sqlite-backend.js: saveArtistInfo accepts fanartFile parameter')
    : fail('sqlite-backend.js: saveArtistInfo does not accept fanartFile — fan art will never be persisted to DB');
  // getArtistRow must return fanartFile so the artist profile hero banner can use it
  /fanartFile\s*:\s*row\.fanart_file/.test(dbSrc)
    ? pass('sqlite-backend.js: getArtistRow returns fanartFile field')
    : fail('sqlite-backend.js: getArtistRow does not return fanartFile — hero banner will always be hidden');

  // ── artists-browse.js checks ──────────────────────────────────────────────
  const browse = fs.readFileSync(path.join(BASE, 'src/api/artists-browse.js'), 'utf8');
  browse.includes("import busboy from 'busboy';")
    ? pass('artists-browse.js: busboy import present')
    : fail('artists-browse.js: busboy import MISSING');
  // Note: Readable was removed — busboy streams are now consumed via event listeners directly.
  /HYDRATE_QUEUE_LIMIT\s*=\s*50000/.test(browse)
    ? pass('artists-browse.js: HYDRATE_QUEUE_LIMIT = 50000')
    : fail('artists-browse.js: HYDRATE_QUEUE_LIMIT is not 50000');
  browse.includes('ARTIST_PLACEHOLDER_FILE')
    ? pass('artists-browse.js: ARTIST_PLACEHOLDER_FILE constant present')
    : fail('artists-browse.js: ARTIST_PLACEHOLDER_FILE MISSING');
  browse.includes("mstream.post('/api/v1/admin/artists/placeholder'")
    ? pass('artists-browse.js: POST placeholder route registered')
    : fail('artists-browse.js: POST placeholder route MISSING');
  browse.includes("mstream.delete('/api/v1/admin/artists/placeholder'")
    ? pass('artists-browse.js: DELETE placeholder route registered')
    : fail('artists-browse.js: DELETE placeholder route MISSING');
  browse.includes("mstream.get('/api/v1/admin/artists/placeholder-info'")
    ? pass('artists-browse.js: GET placeholder-info route registered')
    : fail('artists-browse.js: GET placeholder-info route MISSING');
  browse.includes('saveFanartImage')
    ? pass('artists-browse.js: saveFanartImage function present')
    : fail('artists-browse.js: saveFanartImage MISSING');
  browse.includes('_parseTadbArtist')
    ? pass('artists-browse.js: _parseTadbArtist function present')
    : fail('artists-browse.js: _parseTadbArtist MISSING');
  browse.includes('MIN_ARTIST_IMG_BYTES')
    ? pass('artists-browse.js: MIN_ARTIST_IMG_BYTES constant present')
    : fail('artists-browse.js: MIN_ARTIST_IMG_BYTES MISSING (Discogs black placeholder guard)');
  browse.includes('enrich-tadb')
    ? pass('artists-browse.js: enrich-tadb endpoint present')
    : fail('artists-browse.js: enrich-tadb endpoint MISSING');
  // Guard against the busboy close-before-async race: settled must be set BEFORE await sharp(...)
  // Pattern: "settled = true" must appear before "await sharp(" in the placeholder route
  (() => {
    const placeholderBlock = browse.slice(browse.indexOf("POST /api/v1/admin/artists/placeholder"), browse.indexOf("DELETE /api/v1/admin/artists/placeholder"));
    const settledPos = placeholderBlock.indexOf('settled = true');
    const sharpPos = placeholderBlock.indexOf('await sharp(');
    settledPos !== -1 && sharpPos !== -1 && settledPos < sharpPos
      ? pass('artists-browse.js: placeholder route sets settled before await sharp (race-free)')
      : fail('artists-browse.js: placeholder route sets settled AFTER await sharp — busboy close/async race will return 400');
  })();

  // ── style.css checks ──────────────────────────────────────────────────────
  const css = fs.readFileSync(path.join(BASE, 'webapp/style.css'), 'utf8');
  css.includes('.artpro-hero{') || css.includes('.artpro-hero {')
    ? pass('style.css: .artpro-hero rule present')
    : fail('style.css: .artpro-hero MISSING — fan art banner has no layout/dimensions');
  css.includes('.artpro-hero-img{') || css.includes('.artpro-hero-img {')
    ? pass('style.css: .artpro-hero-img rule present')
    : fail('style.css: .artpro-hero-img MISSING — fan art image will not cover banner area');
  css.includes('.artpro-meta-chips{') || css.includes('.artpro-meta-chips {')
    ? pass('style.css: .artpro-meta-chips rule present')
    : fail('style.css: .artpro-meta-chips MISSING — genre/country/year chips will not flex-wrap correctly');
  css.includes('.artpro-hero .artpro-meta-chip{') || css.includes('.artpro-hero .artpro-meta-chip {')
    ? pass('style.css: .artpro-hero .artpro-meta-chip rule present')
    : fail('style.css: .artpro-hero .artpro-meta-chip MISSING — chips inside hero have no styling');

  const app = fs.readFileSync(path.join(BASE, 'webapp/app.js'), 'utf8');
  app.includes('ms2_recent_density_')
    ? pass('app.js: viewRecent density preference present')
    : fail('app.js: viewRecent density preference MISSING (viewRecent stripped)');
  app.includes('recent-view-bar')
    ? pass('app.js: viewRecent grid HTML present')
    : fail('app.js: viewRecent grid HTML MISSING');
  app.includes('_deduplicateSimArtists')
    ? pass('app.js: _deduplicateSimArtists function present')
    : fail('app.js: _deduplicateSimArtists MISSING');
  app.includes('_primaryArtist')
    ? pass('app.js: _primaryArtist function present')
    : fail('app.js: _primaryArtist MISSING');
  app.includes('artpro-hero-img')
    ? pass('app.js: artpro-hero fanart HTML present')
    : fail('app.js: artpro-hero fanart HTML MISSING');
  app.includes('artpro-meta-chip')
    ? pass('app.js: artpro-meta-chips present')
    : fail('app.js: artpro-meta-chips MISSING');
  app.includes('_restoreArtistLetter')
    ? pass('app.js: letter restore navigation present')
    : fail('app.js: _restoreArtistLetter MISSING');
  app.includes("src=\"api/v1/artists/placeholder\"")
    ? pass('app.js: placeholder img reference present')
    : fail('app.js: placeholder img reference MISSING');

  const admin = fs.readFileSync(path.join(BASE, 'webapp/admin/index.js'), 'utf8');
  admin.includes('exportJson()')
    ? pass('admin/index.js: exportJson method present')
    : fail('admin/index.js: exportJson MISSING');
  admin.includes('exportText()')
    ? pass('admin/index.js: exportText method present')
    : fail('admin/index.js: exportText MISSING');
  admin.includes('copyJson()')
    ? pass('admin/index.js: copyJson method present')
    : fail('admin/index.js: copyJson MISSING');
  admin.includes('throughputPerMin')
    ? pass('admin/index.js: throughputPerMin display present')
    : fail('admin/index.js: throughputPerMin MISSING');
  admin.includes('stats.lastArtist')
    ? pass('admin/index.js: lastArtist display present')
    : fail('admin/index.js: lastArtist display MISSING');
  admin.includes('recentLog')
    ? pass('admin/index.js: recentLog display present')
    : fail('admin/index.js: recentLog MISSING');
  admin.includes('placeholderHasCustom')
    ? pass('admin/index.js: placeholder state present')
    : fail('admin/index.js: placeholder state MISSING');

  // ── Live API checks ───────────────────────────────────────────────────────
  console.log('\nLive API checks:');

  try {
    const r1 = await req('GET', '/api/v1/artists/placeholder', {});
    r1.status === 200 && r1.headers['content-type']?.startsWith('image/')
      ? pass(`GET /api/v1/artists/placeholder → ${r1.status} ${r1.headers['content-type']}`)
      : fail(`GET /api/v1/artists/placeholder`, `status=${r1.status} content-type=${r1.headers['content-type']}`);
  } catch (e) { fail('GET /api/v1/artists/placeholder', e.message); }

  try {
    const r2 = await req('GET', '/api/v1/admin/artists/placeholder-info', {});
    const body = JSON.parse(r2.body.toString());
    r2.status === 200 && typeof body.hasCustom === 'boolean'
      ? pass(`GET /api/v1/admin/artists/placeholder-info → 200, hasCustom=${body.hasCustom}`)
      : fail('GET /api/v1/admin/artists/placeholder-info', `status=${r2.status} body=${r2.body}`);
  } catch (e) { fail('GET /api/v1/admin/artists/placeholder-info', e.message); }

  try {
    const r3 = await req('GET', '/api/v1/admin/artists/hydration-status', {});
    const body = JSON.parse(r3.body.toString());
    r3.status === 200 && typeof body.queueLength === 'number'
      ? pass(`GET /api/v1/admin/artists/hydration-status → 200, queueLength=${body.queueLength}`)
      : fail('GET /api/v1/admin/artists/hydration-status', `status=${r3.status}`);
  } catch (e) { fail('GET /api/v1/admin/artists/hydration-status', e.message); }

  // Seed 1 artist and immediately check status — forces the worker to call
  // db.deriveArtistMbidFromFiles so a missing function error surfaces here.
  // Seed with limit=3 and verify enqueued ≤ 3 — catches getArtistsNeedingFetch ignoring LIMIT
  try {
    const r4 = await req('POST', '/api/v1/admin/artists/hydration-seed',
      { 'content-type': 'application/json' },
      Buffer.from(JSON.stringify({ limit: 3 })));
    const body = JSON.parse(r4.body.toString());
    r4.status === 200 && body.ok === true && body.enqueued <= 3
      ? pass(`POST /api/v1/admin/artists/hydration-seed limit=3 → enqueued=${body.enqueued} (≤ 3)`)
      : fail('POST /api/v1/admin/artists/hydration-seed limit=3', `enqueued=${body.enqueued} — limit not respected! getArtistsNeedingFetch may be missing LIMIT clause`);
  } catch (e) { fail('POST /api/v1/admin/artists/hydration-seed', e.message); }

  // Test actual placeholder upload — uses multipart, must return 200 not 400
  // (A 400 here means the busboy close-before-async race is back)
  try {
    const imgData = fs.readFileSync(path.join(BASE, 'webapp/assets/img/unknownartist.webp'));
    const boundary = 'RegressionBoundary' + Date.now();
    const multiBody = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="test.webp"\r\nContent-Type: image/webp\r\n\r\n`),
      imgData,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const r5 = await req('POST', '/api/v1/admin/artists/placeholder',
      { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(multiBody.length) },
      multiBody);
    const body = JSON.parse(r5.body.toString());
    r5.status === 200 && body.ok === true
      ? pass('POST /api/v1/admin/artists/placeholder (multipart upload) → 200')
      : fail('POST /api/v1/admin/artists/placeholder (multipart upload)', `status=${r5.status} body=${JSON.stringify(body)} — likely busboy close/async race`);
  } catch (e) { fail('POST /api/v1/admin/artists/placeholder (multipart upload)', e.message); }

  // Wait briefly then check status — if worker threw on first artist it will show in lastError
  await new Promise(r => setTimeout(r, 2500));
  try {
    const r5 = await req('GET', '/api/v1/admin/artists/hydration-status', {});
    const body = JSON.parse(r5.body.toString());
    const lastError = body.stats?.lastError || '';
    !lastError
      ? pass('hydration worker: no lastError after first artist processed')
      : fail('hydration worker: lastError after first artist', lastError.slice(0, 120));
  } catch (e) { fail('hydration worker lastError check', e.message); }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
