const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

describe('rooms shared helpers (P043 / P116 / P120 / P122)', async () => {
  // api/sonos.js and api/db.js pull in the whole API bootstrap chain, which leaves an open handle (see sonos-helpers).
  after(() => { setTimeout(() => process.exit(process.exitCode ?? 0), 1500); });

  const sonosApi = await import('../../src/api/sonos.js');
  const sonosWire = await import('../../src/sendspin/sonos.js');
  const { rgGainDb } = await import('../../src/util/replaygain.js');
  const { sameFormat } = await import('../../src/sendspin/wire.js');
  const scheduler = await import('../../src/sendspin/scheduler.js');

  describe('rgGainDb', () => {
    const row = { rg_track_gain_db: 6, rg_true_peak_dbfs: -2, rg_album_gain_db: -3, rg_album_peak_dbfs: -1 };
    it('cuts gain above the peak headroom when clipping', () => {
      assert.equal(rgGainDb(row, { clip: true }), 2);
      assert.equal(rgGainDb(row, { clip: true, preamp: -5 }), 1);
    });
    it('leaves the gain alone with clip:false', () => {
      assert.equal(rgGainDb(row, { clip: false }), 6);
    });
    it('uses album gain in album mode', () => {
      assert.equal(rgGainDb(row, { mode: 'album' }), -3);
    });
    it('an unknown peak limits only when a fallback is given', () => {
      const tag = { replaygainTrackDb: 4 };
      assert.equal(rgGainDb(tag, { clip: true }), 4);
      assert.equal(rgGainDb(tag, { clip: true, peakFallback: 0 }), 0);
    });
    it('returns null without gain data', () => {
      assert.equal(rgGainDb({}, {}), null);
      assert.equal(rgGainDb(null, {}), null);
    });
  });

  describe('sameFormat', () => {
    it('is one function, shared by the scheduler', () => {
      assert.equal(scheduler.sameFormat, sameFormat);
    });
    it('is null-safe and ignores bit depth for opus only', () => {
      assert.equal(sameFormat(null, { codec: 'flac' }), false);
      assert.ok(sameFormat({ codec: 'opus', sample_rate: 48000, channels: 2, bit_depth: 24 }, { codec: 'opus', sample_rate: 48000, channels: 2 }));
      assert.ok(!sameFormat({ codec: 'flac', sample_rate: 44100, channels: 2, bit_depth: 24 }, { codec: 'flac', sample_rate: 44100, channels: 2, bit_depth: 16 }));
    });
  });

  describe('private LAN check', () => {
    it('assertPrivateIp is anchored', () => {
      assert.throws(() => sonosApi.assertPrivateIp('192.168.evil.example'), /not a private LAN/);
      assert.throws(() => sonosApi.assertPrivateIp('10.0.0.1.evil.example'), /not a private LAN/);
      assert.throws(() => sonosApi.assertPrivateIp('8.8.8.8'), /not a private LAN/);
      assert.doesNotThrow(() => sonosApi.assertPrivateIp('192.168.1.20'));
      assert.doesNotThrow(() => sonosApi.assertPrivateIp('172.16.0.5'));
    });
  });

  describe('sonosSoapRequest', () => {
    let server;
    const start = (handler) => new Promise((resolve) => {
      server = http.createServer(handler).listen(0, '127.0.0.1', () => resolve(server.address().port));
    });
    after(() => server?.close());
    const allowHost = (ip) => ip === '127.0.0.1';

    it('rejects a public host before connecting', async () => {
      await assert.rejects(sonosWire.sonosSoapRequest({ ip: '192.168.evil.example', path: '/', serviceType: 'x', action: 'Play' }), /not a private LAN/);
    });

    it('sets err.code to the UPnP error code', async () => {
      const port = await start((req, res) => { res.writeHead(500); res.end('<s:Fault><errorCode>701</errorCode></s:Fault>'); });
      await assert.rejects(
        sonosWire.sonosSoapRequest({ ip: '127.0.0.1', port, path: '/x', serviceType: 'urn:x', action: 'Play', allowHost }),
        (e) => e.code === '701' && /HTTP 500 code=701/.test(e.message),
      );
      server.close();
    });

    it('caps the response body at maxBytes and sends the envelope', async () => {
      let got = '';
      const port = await start((req, res) => {
        req.on('data', (c) => { got += c; });
        req.on('end', () => { res.writeHead(200); res.end('x'.repeat(100_000)); });
      });
      const body = await sonosWire.sonosSoapRequest({ ip: '127.0.0.1', port, path: '/x', serviceType: 'urn:svc:1', action: 'Browse', inner: '<A>1</A>', instanceId: false, maxBytes: 1000, allowHost });
      assert.equal(body.length, 1000);
      assert.match(got, /<u:Browse xmlns:u="urn:svc:1"><A>1<\/A><\/u:Browse>/);
      server.close();
    });
  });

  describe('_parseDidlItem', () => {
    it('decodes entities in titles and res', () => {
      const item = sonosApi._parseDidlItem('FV:2/1', '<dc:title>Rock &amp; Roll</dc:title><upnp:class>object.item</upnp:class><res>x-rincon:a?b=1&amp;c=2</res>', 'item');
      assert.equal(item.title, 'Rock & Roll');
      assert.equal(item.res, 'x-rincon:a?b=1&c=2');
      assert.equal(item.isContainer, false);
    });
  });
});
