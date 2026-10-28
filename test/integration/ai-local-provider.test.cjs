/**
 * Self-hosted model provider: Velvet talks to any server with an OpenAI-compatible
 * chat-completions API (Ollama, LM Studio, llama.cpp, vLLM, LocalAI, Jan). A
 * fake server here plays that role, so this never needs a real model: it checks
 * the request Velvet sends, the json_schema → json_object fallback, the test
 * endpoint, and that a brief from the local model builds a set like one from
 * Claude. No VELVET_AI_STUB in this file — the provider must really be called.
 *
 * Run with:
 *   node --test test/integration/ai-local-provider.test.cjs
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const BRIEF = {
  title: 'Local disco', summary: 'From the little model.', songs: 5, minutes: null, genres: [], excludeGenres: [], families: ['disco'],
  yearFrom: null, yearTo: null, bpmFrom: null, bpmTo: null, energy: 'steady', artists: [], artistMode: 'feature', excludeArtists: [],
  folders: [], keywords: [], favourites: false, discovery: false, minRating: null, clarification: null,
};

// Pretends to be e.g. Ollama's /v1: rejects json_schema (like older servers do),
// accepts json_object, and wraps the answer in a markdown fence like chatty models do.
function fakeModelServer(log) {
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const j = JSON.parse(body || '{}');
      log.push({ url: req.url, auth: req.headers.authorization || null, format: j.response_format?.type || null, model: j.model, system: j.messages?.[0]?.content || '' });
      if (j.response_format?.type === 'json_schema') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'response_format json_schema is not supported' } }));
      }
      const answer = /ping|"ok"/.test(j.messages?.[1]?.content || '') ? { ok: true, model: 'fake-8b' } : BRIEF;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '```json\n' + JSON.stringify(answer) + '\n```' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1200, completion_tokens: 150 } }));
    });
  });
  return new Promise(resolve => srv.listen(0, '127.0.0.1', () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}/v1` })));
}

describe('self-hosted model provider', async () => {
  const { startServer } = await import('../helpers/server.mjs');
  let srv, fake;
  const log = [];
  const post = (p, body) => fetch(srv.baseUrl + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  before(async () => {
    fake = await fakeModelServer(log);
    srv = await startServer({ extraConfig: { aiAssist: { enabled: true, queueBuilder: true, provider: 'openai', localBaseUrl: fake.url, localModel: 'fake-8b', apiKey: '' } }, waitForScan: true });
  });
  after(async () => {
    await srv.stop();
    fake.srv.close();
  });

  it('answers the connection test through the local server, falling back from json_schema to json_object', async () => {
    const r = await post('/api/v1/admin/ai/test', {});
    const text = await r.text();
    assert.equal(r.status, 200, text);
    const j = JSON.parse(text);
    assert.equal(j.ok, true);
    assert.equal(j.model, 'fake-8b');
    assert.equal(j.provider, 'openai');
    assert.deepEqual(log.map(l => l.format), ['json_schema', 'json_object']);
    assert.equal(log[0].url, '/v1/chat/completions');
    assert.equal(log[0].auth, null, 'no Authorization header without a key');
    assert.equal(log[0].model, 'fake-8b');
    assert.match(log[1].system, /JSON schema/);
  });

  it('writes the AI DJ brief with the local model and builds a set from it, at no cost', async () => {
    const b = await post('/api/v1/ai/queue/brief', { text: 'some disco please' });
    const btext = await b.text();
    assert.equal(b.status, 200, btext);
    const { brief, source, usage } = JSON.parse(btext);
    assert.equal(source, 'local');
    assert.equal(brief.title, 'Local disco');
    assert.equal(usage.usd, 0);
    assert.ok(usage.calls >= 2);
    const r = await post('/api/v1/ai/queue/build', { brief });
    assert.equal(r.status, 200);
    const out = await r.json();
    assert.ok(out.songs.length > 0 && out.songs.length <= 5);
  });

  it('house notes reach the briefing and the fallback reader', async () => {
    let r = await post('/api/v1/admin/ai/config', { enabled: true, apiKey: '', model: 'claude-haiku-5-5', monthlyBudgetUsd: 2, queueBuilder: true, provider: 'openai', localBaseUrl: fake.url, localModel: 'fake-8b', djNotes: 'DS = Disco Act 1\nour mixes are in Disco' });
    assert.equal(r.status, 200, await r.text());
    const ctx = await (await fetch(srv.baseUrl + '/api/v1/admin/ai/context')).json();
    assert.match(ctx.aidj.system, /House notes from the library owner[\s\S]*DS = Disco Act 1/);
    await new Promise(res => setTimeout(res, 3100));
    const b = await post('/api/v1/ai/queue/brief', { text: 'a song of DS' });
    assert.equal(b.status, 200);
    const { brief } = await b.json();
    assert.equal(brief.title, 'Local disco', 'the fake model answered');
    assert.match(log.at(-1).system, /DS = Disco Act 1/, 'the notes were in the request to the model');
  });

  it('reports a server that is not there instead of hanging', async () => {
    let r = await post('/api/v1/admin/ai/config', { enabled: true, apiKey: '', model: 'claude-haiku-5-5', monthlyBudgetUsd: 2, queueBuilder: true, provider: 'openai', localBaseUrl: 'http://127.0.0.1:9', localModel: 'x' });
    assert.equal(r.status, 200, await r.text());
    r = await post('/api/v1/admin/ai/test', {});
    assert.equal(r.status, 409);
    const j = await r.json();
    assert.equal(j.ok, false);
    assert.equal(j.code, 'local');
    assert.match(j.error, /Cannot reach/);
    // and the AI DJ still produces a set via the rule reader
    await new Promise(res => setTimeout(res, 3100));
    const b = await post('/api/v1/ai/queue/brief', { text: 'disco, 4 songs' });
    assert.equal(b.status, 200);
    const { source, brief } = await b.json();
    assert.equal(source, 'rules');
    assert.equal(brief.songs, 4);
  });
});
