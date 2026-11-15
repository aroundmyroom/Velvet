import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { startServer } from './helpers/server.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEBAPP = path.join(REPO, 'webapp');

const PAGES = ['remote/index.html', 'server-remote/index.html', 'qr/index.html'];

function scriptTags(html) {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].map(m => ({ attrs: m[1], body: m[2] }));
}

function assertCspSafe(html) {
  for (const s of scriptTags(html)) {
    const external = /\ssrc=/.test(s.attrs);
    const data = /\stype="application\/json"/.test(s.attrs);
    assert.ok(external || data, `inline executable script: <script${s.attrs}>${s.body.slice(0, 60)}`);
    if (external) assert.equal(s.body.trim(), '', 'external script must not carry inline code');
  }
  const handler = html.match(/<[a-z][^>]*\son[a-z]+\s*=/i);
  assert.equal(handler, null, `inline event handler: ${handler?.[0]}`);
}

function localScripts(pageRel, html) {
  return scriptTags(html)
    .map(s => s.attrs.match(/\ssrc="([^"]+)"/)?.[1])
    .filter(Boolean)
    .map(src => src.startsWith('/')
      ? path.join(WEBAPP, src)
      : path.resolve(path.dirname(path.join(WEBAPP, pageRel)), src));
}

describe('client pages work under script-src self', () => {
  for (const rel of PAGES) {
    it(`${rel} is well-formed and has no inline JS`, () => {
      const html = fs.readFileSync(path.join(WEBAPP, rel), 'utf8');
      assert.match(html, /<\/head>\s*<body>/);
      assert.match(html, /<\/body>\s*<\/html>\s*$/);
      assertCspSafe(html);
    });

    it(`${rel} references local scripts that exist and parse`, () => {
      const html = fs.readFileSync(path.join(WEBAPP, rel), 'utf8');
      const files = localScripts(rel, html);
      assert.ok(files.length > 0);
      for (const f of files) {
        assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }), f);
      }
    });

    it(`${rel} gives every element wired by id a matching element`, () => {
      const html = fs.readFileSync(path.join(WEBAPP, rel), 'utf8');
      const own = localScripts(rel, html).filter(f => !f.includes(`${path.sep}lib${path.sep}`));
      for (const f of own) {
        const src = fs.readFileSync(f, 'utf8');
        for (const [, id] of src.matchAll(/getElementById\('([^']+)'\)\.addEventListener/g)) {
          assert.match(html, new RegExp(`\\sid="${id}"`), `${path.basename(f)} wires missing #${id}`);
        }
      }
    });
  }

  it('server-remote keeps the bits-per-second kbps conversion', () => {
    const js = fs.readFileSync(path.join(WEBAPP, 'server-remote/app.js'), 'utf8');
    assert.match(js, /m\.bitrate>=20000\?m\.bitrate\/1000:m\.bitrate/);
  });
});

describe('/remote/:code hands the session over in a JSON data block', () => {
  let srv;
  before(async () => { srv = await startServer({ waitForScan: false }); });
  after(async () => { await srv.stop(); });

  it('injects code and token for a live jukebox session', async () => {
    const ws = new WebSocket(srv.baseUrl.replace(/^http/, 'ws') + '/');
    const hello = await new Promise((resolve, reject) => {
      ws.once('message', m => resolve(JSON.parse(String(m))));
      ws.once('error', reject);
    });
    try {
      assert.ok(hello.code);
      const r = await fetch(`${srv.baseUrl}/remote/${hello.code}`);
      assert.equal(r.status, 200);
      const html = await r.text();
      const m = html.match(/<script type="application\/json" id="remote-data">([\s\S]*?)<\/script>/);
      assert.ok(m, 'remote-data block present');
      const data = JSON.parse(m[1]);
      assert.equal(data.code, hello.code);
      assert.equal(data.error, false);
      assert.equal(data.token, hello.token);
      assertCspSafe(html);
      assert.match(html, /<script src="\/remote\/remote\.js"><\/script>/);
    } finally {
      ws.close();
    }
  });

  it('marks an unknown code as an error', async () => {
    const html = await (await fetch(`${srv.baseUrl}/remote/nope1234`)).text();
    const m = html.match(/id="remote-data">([\s\S]*?)<\/script>/);
    assert.deepEqual(JSON.parse(m[1]), { error: true });
  });

  it('serves the remote and qr scripts as JavaScript', async () => {
    for (const p of ['/remote/remote.js', '/server-remote/app.js', '/qr/qr-page.js']) {
      const r = await fetch(srv.baseUrl + p);
      assert.equal(r.status, 200, p);
      assert.match(r.headers.get('content-type'), /javascript/, p);
    }
  });
});

describe('yt-dlp download uses the shared bootstrap downloader', () => {
  let tmp, server, port;

  before(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'velvet-fix-clients-'));
    execFileSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
      '-keyout', path.join(tmp, 'key.pem'), '-out', path.join(tmp, 'cert.pem')], { stdio: 'ignore' });
    server = https.createServer({
      key: fs.readFileSync(path.join(tmp, 'key.pem')),
      cert: fs.readFileSync(path.join(tmp, 'cert.pem')),
    }, (req, res) => {
      if (req.url === '/file') { res.end('binary'); return; }
      res.writeHead(302, { location: '/loop' });
      res.end();
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
    https.globalAgent.options.rejectUnauthorized = false;
  });

  after(async () => {
    https.globalAgent.options.rejectUnauthorized = true;
    await new Promise(r => server.close(r));
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  it('ytdl.js has no private downloader left', () => {
    const src = fs.readFileSync(path.join(REPO, 'src/api/ytdl.js'), 'utf8');
    assert.doesNotMatch(src, /_downloadFile/);
    assert.match(src, /downloadToFile\(url, BUNDLED_YTDLP, 'velvet-ytdlp-installer'\)/);
  });

  it('downloadToFile stops a redirect loop', async () => {
    const { downloadToFile } = await import('../src/util/bootstrap-helpers.js');
    await assert.rejects(
      downloadToFile(`https://127.0.0.1:${port}/loop`, path.join(tmp, 'out'), 'test'),
      /Too many redirects/,
    );
    assert.equal(fs.existsSync(path.join(tmp, 'out')), false);
  });

  it('downloadToFile still fetches a normal file', async () => {
    const { downloadToFile } = await import('../src/util/bootstrap-helpers.js');
    await downloadToFile(`https://127.0.0.1:${port}/file`, path.join(tmp, 'ok'), 'test');
    assert.equal(fs.readFileSync(path.join(tmp, 'ok'), 'utf8'), 'binary');
  });
});

describe('discogsHeaders', () => {
  it('builds key/secret auth and tags the user agent', async () => {
    const { discogsHeaders } = await import('../src/util/discogs-headers.js');
    const h = discogsHeaders({ apiKey: 'k', apiSecret: 's', userAgentTag: 'home' });
    assert.equal(h.Authorization, 'Discogs key=k, secret=s');
    assert.match(h['User-Agent'], /^Velvet\/dev\/home \+https:\/\//);
  });

  it('uses the plain user agent without a tag', async () => {
    const { discogsHeaders, DISCOGS_USER_AGENT } = await import('../src/util/discogs-headers.js');
    assert.equal(discogsHeaders({ apiKey: 'k', apiSecret: 's' })['User-Agent'], DISCOGS_USER_AGENT);
  });

  it('returns null without credentials', async () => {
    const { discogsHeaders } = await import('../src/util/discogs-headers.js');
    assert.equal(discogsHeaders({ apiKey: 'k' }), null);
    assert.equal(discogsHeaders({}), null);
    assert.equal(discogsHeaders(undefined), null);
  });
});

describe('radio recording stop goes through one finish path', () => {
  let tmp, stream, port;

  before(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'velvet-fix-clients-rec-'));
    stream = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'audio/mpeg' });
      const t = setInterval(() => res.write(Buffer.alloc(1024, 1)), 20);
      res.on('close', () => clearInterval(t));
    });
    await new Promise(r => stream.listen(0, '127.0.0.1', r));
    port = stream.address().port;
  });

  after(async () => {
    stream.closeAllConnections();
    await new Promise(r => stream.close(r));
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  it('stopStreamRecording finishes the file and forgets the recording', async () => {
    const { startStreamRecording, stopStreamRecording } = await import('../src/api/radio-recorder.js');
    const started = await startStreamRecording({
      username: 'u', url: `http://127.0.0.1:${port}/stream`, vpath: 'Rec', recordDir: tmp,
      stationName: 'Test FM', durationMinutes: 1,
    });
    await new Promise(r => setTimeout(r, 150));
    const done = await stopStreamRecording(started.id);
    assert.ok(done);
    assert.equal(path.basename(done.filePath), started.filename);
    assert.ok(fs.statSync(done.filePath).size > 0);
    assert.ok(done.bytesWritten > 0);
    assert.equal(await stopStreamRecording(started.id), null);
  });
});
