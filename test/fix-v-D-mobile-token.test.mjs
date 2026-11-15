// N048: mobile media and art URLs carry ?token= so paired devices and restored sessions work without the cookie.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';

const src = fs.readFileSync(new URL('../webapp/mobile/app.js', import.meta.url), 'utf8');
const body = parse(src, { ecmaVersion: 'latest', sourceType: 'module' }).body;

function load(names, ctx) {
  const code = names.map(name => {
    const node = body.find(n => n.type === 'FunctionDeclaration' && n.id.name === name);
    if (!node) throw new Error(`not found: ${name}`);
    return src.slice(node.start, node.end);
  }).join('\n');
  vm.createContext(ctx);
  // eslint-disable-next-line sonarjs/code-eval
  vm.runInContext(code, ctx);
  return ctx;
}

const fns = ['tokenParam', 'artUrl', 'streamUrl', 'useTranscode', 'radioStreamUrl', 'stationArtUrl'];
const make = quality => load(fns, { S: { serverUrl: 'https://srv', token: 'a b&c', transcodeOk: true, quality }, URLSearchParams });
const tokenOf = url => new URL(url).searchParams.get('token');

describe('mobile URLs carry the session token (N048)', () => {
  it('direct /media stream', () => {
    const url = make('original').streamUrl('Music/A B/song #1.mp3');
    assert.ok(url.startsWith('https://srv/media/Music/A%20B/song%20%231.mp3?'));
    assert.equal(tokenOf(url), 'a b&c');
  });

  it('transcode stream', () => {
    assert.equal(tokenOf(make('opus-128').streamUrl('Music/x.flac', 5)), 'a b&c');
  });

  it('album art from the cache and from a folder file', () => {
    const ctx = make('original');
    assert.equal(tokenOf(ctx.artUrl({ aaFile: 'abc.jpg' })), 'a b&c');
    assert.equal(tokenOf(ctx.artUrl({ artFile: 'Music/a/cover.jpg' })), 'a b&c');
    assert.equal(ctx.artUrl({}), '');
  });

  it('radio stream and both kinds of station art', () => {
    const ctx = make('original');
    assert.equal(tokenOf(ctx.radioStreamUrl({ link_a: 'http://radio/x' })), 'a b&c');
    assert.equal(tokenOf(ctx.stationArtUrl({ img: 'logo.png' })), 'a b&c');
    assert.equal(tokenOf(ctx.stationArtUrl({ img: 'https://cdn/logo.png' })), 'a b&c');
  });
});
