/**
 * Core API regression test — tests routes that have historically broken
 * after SonarQube / refactoring changes.
 *
 * Tests:
 *  1. GET  /api/v1/ping/public            — server health
 *  2. POST /api/v1/db/search              — FTS search (ambiguous column bug fixed)
 *  3. POST /api/v1/db/random-songs        — random songs
 *  4. POST /api/v1/db/artist-folder-songs — artist songs (ESCAPE SQL bug fixed)
 *  5. GET  /api/v1/playlist/getall        — playlists + vpath meta
 *
 * Run from: /home/mStream
 *   node test/regression-api-core.cjs
 */

'use strict';
const jwt   = require('jsonwebtoken');
const https = require('https');
const fs    = require('fs');

const cfg   = JSON.parse(fs.readFileSync('/home/mStream/save/conf/default.json', 'utf8'));
const token = jwt.sign({ username: Object.keys(cfg.users)[0] }, cfg.secret);
const HOST  = 'music.aroundtheworld.net';
const PORT  = 3000;

let passed = 0;
let failed = 0;

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: HOST, port: PORT, path, method,
      headers: {
        'x-access-token': token,
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
      rejectUnauthorized: false,
    };
    const r = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.error(`  ✗ ${name}${detail ? ': ' + detail : ''}`);
    failed++;
  }
}

async function run() {
  console.log('\n=== Core API Regression Test ===\n');

  // 1. Ping
  {
    const r = await req('GET', '/api/v1/ping/public', null);
    check('Ping returns 200', r.status === 200, `got ${r.status}`);
    check('Ping body has status:ok', r.body?.status === 'ok', JSON.stringify(r.body));
  }

  // 2. Search — historically broke with "ambiguous column name: filepath"
  {
    const r = await req('POST', '/api/v1/db/search', { search: 'a' });
    check('Search returns 200', r.status === 200, `got ${r.status} ${JSON.stringify(r.body).slice(0,100)}`);
    check('Search body has files array', Array.isArray(r.body?.files), JSON.stringify(r.body).slice(0,100));
  }

  // 3. Random songs
  {
    const vpaths = Object.keys(cfg.folders);
    const r = await req('POST', '/api/v1/db/random-songs', { count: 3, vpaths });
    check('Random songs returns 200', r.status === 200, `got ${r.status}`);
    check('Random songs returns songs array', Array.isArray(r.body?.songs), JSON.stringify(r.body).slice(0,100));
  }

  // 4. Artist folder songs — historically broke with "unrecognized token" in ESCAPE clause
  {
    // Use a known artist from the DB
    const r = await req('POST', '/api/v1/db/search', { search: 'a', noFiles: true, noAlbums: true });
    const artist = r.body?.artists?.[0];
    if (artist) {
      const vpaths = Object.keys(cfg.folders);
      const r2 = await req('POST', '/api/v1/db/artist-folder-songs', {
        artists: [artist],
        vpaths,
        excludeFilepathPrefixes: [],
      });
      check('Artist folder songs returns 200', r2.status === 200, `got ${r2.status} ${JSON.stringify(r2.body).slice(0,100)}`);
      check('Artist folder songs returns array', Array.isArray(r2.body), JSON.stringify(r2.body).slice(0,100));
    } else {
      check('Artist folder songs (skipped — no artist found)', true);
      check('Artist folder songs (skipped)', true);
    }
  }

  // 5. Ping (authenticated) — returns vpathMetaData
  {
    const r = await req('GET', '/api/v1/ping', null);
    check('Ping (auth) returns 200', r.status === 200, `got ${r.status}`);
    check('Ping (auth) has vpathMetaData', typeof r.body?.vpathMetaData === 'object', JSON.stringify(r.body).slice(0,100));
  }

  // 6. Playlist getall — returns array of playlists
  {
    const r = await req('GET', '/api/v1/playlist/getall', null);
    check('Playlist getall returns 200', r.status === 200, `got ${r.status}`);
    check('Playlist getall returns array', Array.isArray(r.body), JSON.stringify(r.body).slice(0,100));
  }

  // Summary
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  if (failed > 0) process.exit(1);
}

run().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
