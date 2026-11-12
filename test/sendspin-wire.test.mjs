import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  MSG, MAX_PLAINTEXT, MAX_PAYLOAD, WireError, Reassembler, fragment, frame, encodeJson, decodeJson,
  encodeAudioChunk, decodeAudioChunk, decodeSourceAudio, encodeArtworkAnnounce, encodeArtworkPart,
  encodeArtworkParts, encodeArtworkCancel, encodeVisLoudness, encodeVisBeat, encodeVisFPeak,
  encodeVisSpectrum, encodeVisPeak, SEND_AHEAD_MAX,
} from '../src/sendspin/wire.js';

function roundTrip(type, payload) {
  const frames = fragment(frame(type, payload));
  const r = new Reassembler();
  let out = null;
  frames.forEach((f, i) => {
    assert.ok(f.length <= MAX_PLAINTEXT);
    out = r.push(f);
    if (i < frames.length - 1) assert.equal(out, null);
  });
  assert.equal(r.inFlight, false);
  return { frames, out };
}

test('limits follow the spec arithmetic', () => {
  assert.equal(MAX_PLAINTEXT, 65519);
  assert.equal(MAX_PAYLOAD, 65518);
});

test('payload of exactly 65518 bytes is not fragmented', () => {
  const payload = crypto.randomBytes(MAX_PAYLOAD);
  const { frames, out } = roundTrip(MSG.AUDIO, payload);
  assert.equal(frames.length, 1);
  assert.equal(frames[0][0], MSG.AUDIO);
  assert.deepEqual(out, { type: MSG.AUDIO, payload });
});

test('payload of 65519 bytes is fragmented in two', () => {
  const payload = crypto.randomBytes(MAX_PAYLOAD + 1);
  const { frames, out } = roundTrip(MSG.JSON, payload);
  assert.equal(frames.length, 2);
  assert.deepEqual([...frames[0].subarray(0, 3)], [MSG.FRAGMENT, 0x02, MSG.JSON]);
  assert.equal(frames[0].length, MAX_PLAINTEXT);
  assert.deepEqual([...frames[1].subarray(0, 2)], [MSG.FRAGMENT, 0x01]);
  assert.equal(frames[1].length, 2 + (payload.length - (MAX_PLAINTEXT - 3)));
  assert.deepEqual(out.payload, payload);
});

test('1 MB payload fragments and reassembles', () => {
  const payload = crypto.randomBytes(1024 * 1024);
  const { frames, out } = roundTrip(MSG.AUDIO, payload);
  assert.equal(frames.length, Math.ceil((payload.length - (MAX_PLAINTEXT - 3)) / (MAX_PLAINTEXT - 2)) + 1);
  frames.slice(1, -1).forEach((f) => assert.deepEqual([...f.subarray(0, 2)], [MSG.FRAGMENT, 0]));
  assert.equal(out.type, MSG.AUDIO);
  assert.deepEqual(out.payload, payload);
});

test('encodeJson fragments only when needed', () => {
  const small = encodeJson({ type: 'server/time', payload: { a: 1 } });
  assert.equal(small.length, 1);
  assert.equal(small[0][0], MSG.JSON);
  assert.deepEqual(decodeJson(small[0].subarray(1)), { type: 'server/time', payload: { a: 1 } });
  const big = encodeJson({ type: 'server/state', payload: { blob: 'é'.repeat(40000) } });
  assert.equal(big.length, 2);
  const r = new Reassembler();
  assert.equal(r.push(big[0]), null);
  const out = r.push(big[1]);
  assert.equal(decodeJson(out.payload).payload.blob.length, 40000);
});

test('fragment refuses transport types as orig_type', () => {
  for (const t of [1, 2, 3]) assert.throws(() => fragment(frame(t, Buffer.alloc(MAX_PLAINTEXT))), WireError);
  assert.throws(() => fragment(Buffer.alloc(0)), WireError);
});

test('one fragmented message in flight at a time', () => {
  const frames = fragment(frame(MSG.AUDIO, Buffer.alloc(MAX_PLAINTEXT * 2)));
  assert.equal(frames.length, 3);
  let r = new Reassembler();
  r.push(frames[0]);
  assert.throws(() => r.push(frame(MSG.JSON, Buffer.from('{}'))), /non-fragment/);
  assert.equal(r.inFlight, false);
  r = new Reassembler();
  r.push(frames[0]);
  assert.throws(() => r.push(frames[0]), /first fragment while/);
  r = new Reassembler();
  assert.throws(() => r.push(frames[1]), /none in flight/);
  assert.throws(() => r.push(frames[2]), /none in flight/);
});

test('malformed fragments are rejected', () => {
  const r = new Reassembler();
  assert.throws(() => r.push(Buffer.alloc(0)), /empty/);
  assert.throws(() => r.push(Buffer.from([1])), /flags/);
  assert.throws(() => r.push(Buffer.from([1, 0x02])), /orig_type/);
  assert.throws(() => r.push(Buffer.from([1, 0x03, 1, 0])), /orig_type is 1/);
  assert.throws(() => r.push(Buffer.from([1, 0x06, 0])), /reserved/);
  assert.throws(() => r.push(Buffer.from([1, 0x82, 0])), /reserved/);
  assert.deepEqual(r.push(Buffer.from([1, 0x03, 4, 9])), { type: 4, payload: Buffer.from([9]) });
  assert.deepEqual(r.push(Buffer.from([1, 0x03, 0])), { type: 0, payload: Buffer.alloc(0) });
});

test('reassembly limit is enforced', () => {
  const r = new Reassembler({ maxBytes: 100000 });
  const frames = fragment(frame(MSG.AUDIO, Buffer.alloc(200000)));
  r.push(frames[0]);
  assert.throws(() => r.push(frames[1]), /limit/);
  assert.equal(r.inFlight, false);
});

test('decodeJson enforces envelope shape', () => {
  for (const bad of ['[]', 'null', '{"type":1,"payload":{}}', '{"type":"x"}', '{"type":"x","payload":[]}', '{']) {
    assert.throws(() => decodeJson(Buffer.from(bad)), WireError, bad);
  }
  assert.throws(() => decodeJson(Buffer.from([0xc3, 0x28])), WireError);
});

test('audio chunk header layout', () => {
  const data = Buffer.from([0xaa, 0xbb]);
  const buf = encodeAudioChunk(0x0102030405060708n, 0x0a0b0c0dn, data);
  assert.equal(buf.length, 15);
  assert.deepEqual([...buf], [4, 1, 2, 3, 4, 5, 6, 7, 8, 0x0a, 0x0b, 0x0c, 0x0d, 0xaa, 0xbb]);
  assert.deepEqual(decodeAudioChunk(buf), { timestampUs: 0x0102030405060708n, sendAheadUs: 0x0a0b0c0d, frame: data });
  const neg = encodeAudioChunk(-5n, 10n, Buffer.alloc(0));
  assert.equal(neg.length, 13);
  assert.equal(neg.readBigInt64BE(1), -5n);
  assert.equal(encodeAudioChunk(1000, 250, Buffer.alloc(0)).readBigInt64BE(1), 1000n);
  assert.throws(() => decodeAudioChunk(Buffer.alloc(12, 4)), WireError);
});

test('send_ahead saturates', () => {
  const sa = (v) => encodeAudioChunk(1n, v, Buffer.alloc(0)).readUInt32BE(9);
  assert.equal(sa(0n), 0);
  assert.equal(sa(-1n), 0);
  assert.equal(sa(-(2n ** 40n)), 0);
  assert.equal(sa(1n), 1);
  assert.equal(sa(SEND_AHEAD_MAX - 1n), 4294967294);
  assert.equal(sa(SEND_AHEAD_MAX), 4294967295);
  assert.equal(sa(SEND_AHEAD_MAX + 1n), 4294967295);
  assert.equal(sa(2n ** 62n), 4294967295);
});

test('source audio decode', () => {
  const buf = Buffer.concat([Buffer.from([12]), Buffer.alloc(8), Buffer.from([7])]);
  buf.writeBigInt64BE(99n, 1);
  assert.deepEqual(decodeSourceAudio(buf), { timestampUs: 99n, frame: Buffer.from([7]) });
  assert.throws(() => decodeSourceAudio(Buffer.alloc(8, 12)), WireError);
});

test('artwork messages', () => {
  const ann = encodeArtworkAnnounce(2, 0x1122334455667788n, 70000);
  assert.equal(ann.length, 14);
  assert.deepEqual([...ann.subarray(0, 2)], [10, 0x02]);
  assert.equal(ann.readBigInt64BE(2), 0x1122334455667788n);
  assert.equal(ann.readUInt32BE(10), 70000);
  assert.deepEqual([...encodeArtworkCancel(3)], [11, 0x01]);
  assert.deepEqual([...encodeArtworkPart(0, Buffer.from([5, 6]))], [8, 0, 5, 6]);
  assert.throws(() => encodeArtworkPart(0, Buffer.alloc(MAX_PLAINTEXT - 1)), WireError);
  assert.equal(encodeArtworkPart(0, Buffer.alloc(MAX_PLAINTEXT - 2)).length, MAX_PLAINTEXT);
  const image = crypto.randomBytes(150000);
  const parts = encodeArtworkParts(1, image);
  assert.equal(parts.length, 3);
  parts.forEach((p) => {
    assert.ok(p.length <= MAX_PLAINTEXT);
    assert.deepEqual([...p.subarray(0, 2)], [9, 0]);
    assert.deepEqual(fragment(p), [p]);
  });
  assert.deepEqual(Buffer.concat(parts.map((p) => p.subarray(2))), image);
  assert.equal(encodeArtworkParts(0, Buffer.alloc(0)).length, 0);
  assert.throws(() => encodeArtworkAnnounce(4, 0n, 1), WireError);
  assert.throws(() => encodeArtworkAnnounce(-1, 0n, 1), WireError);
  assert.throws(() => encodeArtworkAnnounce(0, 0n, 2 ** 32), WireError);
});

test('visualizer messages', () => {
  const ts = 123456789n;
  const check = (buf, type, data) => {
    assert.equal(buf[0], type);
    assert.equal(buf.readBigInt64BE(1), ts);
    assert.deepEqual([...buf.subarray(9)], data);
  };
  check(encodeVisLoudness(ts, 0x1234), 16, [0x12, 0x34]);
  check(encodeVisBeat(ts, true), 17, [1]);
  check(encodeVisBeat(ts), 17, [0]);
  check(encodeVisFPeak(ts, 440, 0xffff), 18, [0x01, 0xb8, 0xff, 0xff]);
  check(encodeVisSpectrum(ts, [1, 0x0203]), 19, [0, 1, 2, 3]);
  check(encodeVisPeak(ts, 200), 20, [200]);
  assert.throws(() => encodeVisLoudness(ts, 65536), WireError);
  assert.throws(() => encodeVisFPeak(ts, 0, 5), WireError);
  assert.throws(() => encodeVisPeak(ts, 256), WireError);
  assert.throws(() => encodeVisSpectrum(ts, [1.5]), WireError);
});
