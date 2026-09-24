const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

// Uses the REAL errors the installed express/body-parser produce, so an upgrade that
// changes the markers isClientRefusal() relies on fails here instead of silently
// putting refused requests back into the error log.
describe('isClientRefusal — requests Express itself refuses', async () => {
  const { isClientRefusal } = await import('../../src/util/web-error.js');
  const { default: WebError } = await import('../../src/util/web-error.js');

  function capture(bodyLimit = '10b') {
    const app = express();
    app.disable('x-powered-by');
    app.use(express.json({ limit: bodyLimit }));
    app.get('/p/:x', (_req, res) => res.end('ok'));
    let seen = null;
    app.use((err, _req, res, _next) => { seen = err; res.status(err.status || 500).end(); });
    return { app, get: () => seen };
  }
  const call = (app, { method = 'GET', path = '/', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const srv = app.listen(0, () => {
      const req = http.request({ port: srv.address().port, method, path, headers }, res => {
        res.resume(); res.on('end', () => { srv.close(); resolve(res.statusCode); });
      });
      req.on('error', e => { srv.close(); reject(e); });
      if (body) req.write(body);
      req.end();
    });
  });

  it('flags a body that is not valid JSON', async () => {
    const c = capture('1mb');
    const code = await call(c.app, { method: 'POST', path: '/', headers: { 'content-type': 'application/json' }, body: '{"a": ' });
    assert.equal(code, 400);
    assert.equal(isClientRefusal(c.get(), c.get().status), true);
  });

  it('flags a body over the size limit', async () => {
    const c = capture('10b');
    const code = await call(c.app, { method: 'POST', path: '/', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ a: 'x'.repeat(200) }) });
    assert.equal(code, 413);
    assert.equal(isClientRefusal(c.get(), 413), true);
  });

  it('flags a URL whose percent-escapes do not decode', async () => {
    const c = capture();
    const code = await call(c.app, { path: '/p/%E0%A4%A' });
    assert.equal(code, 400);
    assert.equal(isClientRefusal(c.get(), 400), true);
  });

  it('does not flag a route failing, a WebError, or a bare status', () => {
    assert.equal(isClientRefusal(new Error('boom'), 500), false);
    assert.equal(isClientRefusal(new WebError('nope', 404), 404), false);
    assert.equal(isClientRefusal(Object.assign(new Error('x'), { status: 400 }), 400), false);
    assert.equal(isClientRefusal(Object.assign(new Error('x'), { type: 'entity.too.large', expose: true }), 500), false);
    assert.equal(isClientRefusal(null, 400), false);
  });
});
