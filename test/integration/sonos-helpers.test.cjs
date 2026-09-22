const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');

describe('Sonos DIDL / transport helpers', async () => {
  // sonos.js -> util/admin.js -> server.js pulls in the whole ~40-module API
  // bootstrap chain, which leaves an open handle somewhere and would hang the
  // runner otherwise. None of that chain runs here — only the pure helpers below
  // are exercised — so a forced exit once these tests finish is safe.
  after(() => process.exit(0));

  const sonos = await import('../../src/api/sonos.js');

  describe('mimeForPath — protocolInfo told Sonos everything was MP3', () => {
    it('maps lossless and lossy containers to their real MIME type', () => {
      assert.equal(sonos.mimeForPath('a/b/song.flac'), 'audio/flac');
      assert.equal(sonos.mimeForPath('a/b/song.wav'),  'audio/wav');
      assert.equal(sonos.mimeForPath('a/b/song.mp3'),  'audio/mpeg');
      assert.equal(sonos.mimeForPath('a/b/song.m4a'),  'audio/mp4');
      assert.equal(sonos.mimeForPath('a/b/song.opus'), 'audio/ogg');
    });
    it('is case-insensitive and falls back to audio/mpeg for unknown suffixes', () => {
      assert.equal(sonos.mimeForPath('X/Y/SONG.FLAC'), 'audio/flac');
      assert.equal(sonos.mimeForPath('no-extension'),  'audio/mpeg');
      assert.equal(sonos.mimeForPath(''),              'audio/mpeg');
      assert.equal(sonos.mimeForPath(null),            'audio/mpeg');
    });
  });

  describe('_streamUriToFp — exact track identity from the URI the device reports', () => {
    const base = 'http://10.1.1.101:3001';

    it('recovers the filepath from a direct /media stream', () => {
      const fp = 'Music/Albums/Artist/01 - Track.flac';
      const url = `${base}/media/${fp.split('/').map(encodeURIComponent).join('/')}?token=abc.def.ghi`;
      assert.equal(sonos._streamUriToFp(url), fp);
    });

    it('survives apostrophes, ampersands and en-dashes XML-escaped by the device', () => {
      const fp = "Music/12 inches/Booker T & The MG's – Melting Pot/01 - Booker T. & the MG's.flac";
      const url = `${base}/media/${fp.split('/').map(encodeURIComponent).join('/')}?token=t`;
      // the SOAP envelope escapes the URI before it reaches us
      const escaped = url.replace(/&/g, '&amp;').replace(/'/g, '&apos;');
      assert.equal(sonos._streamUriToFp(escaped), fp);
    });

    it('recovers the filepath from a transcode-stream URL', () => {
      const fp = 'Music/HiRes/Artist/02 - Track.flac';
      const url = `${base}/api/v1/sonos/transcode-stream?token=t&fp=${encodeURIComponent(fp)}&start=30`;
      assert.equal(sonos._streamUriToFp(url), fp);
    });

    it('returns null for content that is not ours, so it cannot be mistaken for a queue row', () => {
      assert.equal(sonos._streamUriToFp('x-sonosapi-stream:s12345?sid=254'), null);
      assert.equal(sonos._streamUriToFp('x-rincon-queue:RINCON_1234#0'), null);
      assert.equal(sonos._streamUriToFp('https://example.com/other.mp3'), null);
      assert.equal(sonos._streamUriToFp(''), null);
      assert.equal(sonos._streamUriToFp(null), null);
    });

    it('distinguishes two different tracks that share title and artist tags', () => {
      const a = `${base}/media/Music/X/disc1%2Ftrack.flac?token=t`;
      const b = `${base}/media/Music/X/disc2%2Ftrack.flac?token=t`;
      assert.notEqual(sonos._streamUriToFp(a), sonos._streamUriToFp(b));
    });
  });

  describe('secsToTime / timeToSecs', () => {
    it('round-trips whole seconds', () => {
      for (const s of [0, 1, 59, 60, 61, 3599, 3600, 3661, 12345]) {
        assert.equal(sonos.timeToSecs(sonos.secsToTime(s)), s);
      }
    });
    it('formats as HH:MM:SS', () => {
      assert.equal(sonos.secsToTime(0), '00:00:00');
      assert.equal(sonos.secsToTime(61), '00:01:01');
      assert.equal(sonos.secsToTime(3661), '01:01:01');
    });
    it('treats NOT_IMPLEMENTED and junk as zero', () => {
      assert.equal(sonos.timeToSecs('NOT_IMPLEMENTED'), 0);
      assert.equal(sonos.timeToSecs(''), 0);
      assert.equal(sonos.timeToSecs(null), 0);
    });
  });

  describe('_parseLastChange — the pushed GENA event', () => {
    const wrap = inner =>
      `<e:propertyset><e:property><LastChange>${inner
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
      }</LastChange></e:property></e:propertyset>`;

    it('extracts state, track number, queue length and track identity', () => {
      const fp = 'Music/A/b.flac';
      const uri = `http://10.1.1.101:3001/media/${fp.split('/').map(encodeURIComponent).join('/')}?token=t`;
      const ev = wrap(`<Event><InstanceID val="0">
        <TransportState val="PLAYING"/><CurrentTrack val="3"/>
        <NumberOfTracks val="7"/><CurrentTrackURI val="${uri}"/>
      </InstanceID></Event>`);
      const p = sonos._parseLastChange(ev);
      assert.equal(p.state, 'PLAYING');
      assert.equal(p.playing, true);
      assert.equal(p.paused, false);
      assert.equal(p.track, 3);
      assert.equal(p.nrTracks, 7);
      assert.equal(p.trackFp, fp);
    });

    it('flags a pause, which the web player has to mirror', () => {
      const p = sonos._parseLastChange(wrap('<Event><InstanceID val="0"><TransportState val="PAUSED_PLAYBACK"/></InstanceID></Event>'));
      assert.equal(p.paused, true);
      assert.equal(p.playing, false);
    });

    it('reports TRANSITIONING as neither playing nor paused so it can be ignored', () => {
      const p = sonos._parseLastChange(wrap('<Event><InstanceID val="0"><TransportState val="TRANSITIONING"/></InstanceID></Event>'));
      assert.equal(p.state, 'TRANSITIONING');
      assert.equal(p.playing, false);
      assert.equal(p.paused, false);
      assert.equal(p.stopped, false);
    });

    it('returns null when there is no transport state to act on', () => {
      assert.equal(sonos._parseLastChange('<e:propertyset></e:propertyset>'), null);
      assert.equal(sonos._parseLastChange(''), null);
    });
  });
});
