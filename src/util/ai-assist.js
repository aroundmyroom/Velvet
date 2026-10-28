// Optional model access for library housekeeping and the AI DJ: Claude, or a
// self-hosted server with an OpenAI-compatible API (Ollama, LM Studio, …).
// Off unless aiAssist.enabled is set; every call is JSON-in/JSON-out, counted
// against a monthly budget, and only ever carries tag/folder names — never
// files, paths to the disk root, users or listening history.
import fs from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import * as config from '../state/config.js';
import * as db from '../db/manager.js';

export const DEFAULT_MODEL = 'claude-haiku-5-5';
// Absolute ceiling for one AI-built queue, whatever the admin configures.
export const MAX_QUEUE_SONGS = 9999;
// USD per million input / output tokens; prompts stay far below the 100K tier.
const PRICES = {
  'claude-haiku-5-5':  [0.10, 0.50],
  'claude-sonnet-5-5': [2.00, 10.00],
  'claude-opus-5-5':   [4.00, 20.00],
};

export class AiAssistError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

export function settings() {
  const a = config.program.aiAssist || {};
  return {
    enabled: !!a.enabled, apiKey: a.apiKey || '', model: a.model || DEFAULT_MODEL, monthlyBudgetUsd: a.monthlyBudgetUsd ?? 2,
    queueBuilder: !!a.queueBuilder, maxQueueSongs: Math.min(MAX_QUEUE_SONGS, Math.max(1, Number(a.maxQueueSongs) || 500)),
    provider: a.provider === 'openai' ? 'openai' : 'anthropic',
    localBaseUrl: (a.localBaseUrl || '').trim().replace(/\/+$/, ''), localModel: (a.localModel || '').trim(), localApiKey: a.localApiKey || '',
    djNotes: String(a.djNotes || '').slice(0, 4000),
  };
}

// House notes: free text for the model, plus "FGTH = Frankie Goes To Hollywood"
// lines that the rule-based reader can use as aliases too.
export function parseDjNotes(notes) {
  const aliases = new Map();
  const lines = String(notes || '').split('\n').map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    const m = line.match(/^(.{1,40}?)\s*(?:=|→|->|=>)\s*(.{1,80})$/);
    if (m) aliases.set(m[1].toLowerCase(), m[2].trim());
  }
  return { text: lines.join('\n'), aliases };
}
export function providerLabel() { return settings().provider === 'openai' ? 'local' : 'claude'; }
// What a job of this size would cost, before running it.
export const MODELS = Object.keys(PRICES);
export function estimateUsdFor(model, inputTokens, outputTokens) {
  const [pin, pout] = PRICES[model] || PRICES[DEFAULT_MODEL];
  return (inputTokens * pin + outputTokens * pout) / 1e6;
}
export function estimateUsd(inputTokens, outputTokens) {
  const s = settings();
  return s.provider === 'openai' ? 0 : estimateUsdFor(s.model, inputTokens, outputTokens);
}

// Where requests go, for the admin page.
export function endpointInfo() {
  const s = settings();
  return s.provider === 'openai'
    ? { provider: 'openai', model: s.localModel || '—', endpoint: s.localBaseUrl ? `${s.localBaseUrl}/chat/completions` : '—', auth: s.localApiKey ? 'Bearer key' : 'none', billing: 'none (self-hosted)' }
    : { provider: 'anthropic', model: s.model, endpoint: 'https://api.anthropic.com/v1/messages', auth: s.apiKey ? `x-api-key …${s.apiKey.slice(-4)}` : 'no key', billing: `$${(PRICES[s.model] || PRICES[DEFAULT_MODEL]).join(' / $')} per MTok in / out, budget $${s.monthlyBudgetUsd}/month` };
}

// The last calls, newest first — what was asked, how big, what it cost.
const RECENT = 60;
const _recent = [];
export function recentCalls() { return _recent.slice(); }
function record(entry) {
  _recent.unshift({ ts: Date.now(), ...entry });
  if (_recent.length > RECENT) _recent.length = RECENT;
}
export function queueBuilderEnabled() { const s = settings(); return s.enabled && s.queueBuilder; }
export function isEnabled() { return settings().enabled; }
export function month() { return new Date().toISOString().slice(0, 7); }
export function usage() { return db.getAiUsage(month()); }

let _client = null;
function client(apiKey) {
  if (!_client || _client._key !== apiKey) {
    _client = new Anthropic({ apiKey, maxRetries: 2, timeout: 90_000 });
    _client._key = apiKey;
  }
  return _client;
}

// Tests point VELVET_AI_STUB at a JSON file { "<task>": <answer> } so the
// suite never reaches the network or spends money.
function stubbed(task) {
  if (!process.env.VELVET_AI_STUB) return null;
  const all = JSON.parse(fs.readFileSync(process.env.VELVET_AI_STUB, 'utf8'));
  if (!(task in all)) throw new AiAssistError(`stub has no answer for ${task}`, 'stub');
  return { output: all[task], inputTokens: 1000, outputTokens: 200 };
}

function systemText(system) {
  return Array.isArray(system) ? system.map(b => b.text || '').join('\n') : String(system || '');
}

function extractJson(text) {
  const t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) throw new AiAssistError('The model did not answer with JSON', 'invalid');
  return JSON.parse(t.slice(a, b + 1));
}

// Self-hosted models through the OpenAI chat-completions API. Structured
// output is asked for in the strongest form the server accepts: json_schema,
// then json_object, then plain text with the schema in the prompt.
async function askOpenAiCompatible(s, { task, system, prompt, schema, maxTokens, timeoutMs }) {
  if (!s.localBaseUrl || !/^https?:\/\//i.test(s.localBaseUrl)) throw new AiAssistError('No server URL configured for the self-hosted model', 'nokey');
  if (!s.localModel) throw new AiAssistError('No model name configured for the self-hosted model', 'nokey');
  const headers = { 'Content-Type': 'application/json' };
  if (s.localApiKey) headers.Authorization = `Bearer ${s.localApiKey}`;
  const messages = [
    { role: 'system', content: `${systemText(system)}\n\nAnswer with one JSON object only — no prose, no markdown — that matches this JSON schema:\n${JSON.stringify(schema)}` },
    { role: 'user', content: prompt },
  ];
  const formats = [
    { type: 'json_schema', json_schema: { name: task.replaceAll(/[^a-zA-Z0-9_-]/g, '_'), schema, strict: true } },
    { type: 'json_object' },
    null,
  ];
  let lastError = null;
  for (const response_format of formats) {
    const body = { model: s.localModel, messages, temperature: 0.2, max_tokens: maxTokens, ...(response_format ? { response_format } : {}) };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(`${s.localBaseUrl}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
    } catch (e) {
      throw new AiAssistError(`Cannot reach ${s.localBaseUrl}: ${e.name === 'AbortError' ? 'timeout' : e.message}`, 'local');
    } finally { clearTimeout(timer); }
    const text = await res.text();
    if (res.status === 400 && response_format) { lastError = text.slice(0, 200); continue; }
    if (!res.ok) throw new AiAssistError(`${s.localBaseUrl} answered ${res.status}: ${text.slice(0, 200)}`, 'local');
    let data;
    try { data = JSON.parse(text); } catch { throw new AiAssistError('The server did not answer with JSON', 'local'); }
    const content = data.choices?.[0]?.message?.content;
    if (data.choices?.[0]?.finish_reason === 'length') throw new AiAssistError('The answer was cut off; raise the model context or lower the batch', 'truncated');
    return { output: extractJson(content), inputTokens: data.usage?.prompt_tokens || 0, outputTokens: data.usage?.completion_tokens || 0, cacheRead: 0, cacheWrite: 0 };
  }
  throw new AiAssistError(`The server rejected every output format: ${lastError}`, 'local');
}

export async function askJson(opts) {
  const t0 = Date.now();
  const sys = systemText(opts.system);
  const base = { task: opts.task, provider: settings().provider, model: settings().provider === 'openai' ? settings().localModel : settings().model, systemChars: sys.length, promptChars: String(opts.prompt || '').length, preview: String(opts.prompt || '').replaceAll(/\s+/g, ' ').slice(0, 140) };
  try {
    const r = await _askJson(opts, base);
    return r;
  } catch (e) {
    record({ ...base, ms: Date.now() - t0, ok: false, error: `${e.code ? e.code + ': ' : ''}${String(e.message).slice(0, 200)}` });
    throw e;
  }
}

// Anthropic compiles a JSON schema into a grammar and refuses a big one as
// "too large" (the AI DJ brief has forty fields). Such calls ask for plain
// JSON with the schema in the prompt instead; the answer is validated after.
async function createMessage(s, { system, prompt, schema, maxTokens, strict }, { timeoutMs, maxRetries }) {
  const loose = () => client(s.apiKey).messages.create({
    model: s.model,
    max_tokens: maxTokens,
    system: [{ type: 'text', text: systemText(system) + '\n\nAnswer with one JSON object only — no prose, no markdown — that matches this JSON schema:\n' + JSON.stringify(schema), cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: prompt }],
    output_config: { effort: 'low' },
  }, { timeout: timeoutMs, maxRetries });
  if (!strict) return loose();
  try {
    return await client(s.apiKey).messages.create({
      model: s.model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: prompt }],
      output_config: { effort: 'low', format: { type: 'json_schema', schema } },
    }, { timeout: timeoutMs, maxRetries });
  } catch (e) {
    if (/grammar is too large/i.test(String(e?.message))) return loose();
    throw e;
  }
}

async function _askJson({ task, system, prompt, schema, maxTokens = 16000, timeoutMs = 90_000, maxRetries = 2, strict = true }, base) {
  const t0 = Date.now();
  const s = settings();
  if (!s.enabled) throw new AiAssistError('AI-assist is disabled', 'disabled');
  if (s.provider === 'anthropic' && usage().usd >= s.monthlyBudgetUsd) throw new AiAssistError(`Monthly budget of $${s.monthlyBudgetUsd} reached`, 'budget');
  let result = stubbed(task);
  if (!result && s.provider === 'openai') {
    result = await askOpenAiCompatible(s, { task, system, prompt, schema, maxTokens, timeoutMs: Math.max(timeoutMs, 180_000) });
  }
  if (!result) {
    if (!s.apiKey) throw new AiAssistError('No API key configured', 'nokey');
    const res = await createMessage(s, { system, prompt, schema, maxTokens, strict }, { timeoutMs, maxRetries });
    if (res.stop_reason === 'refusal') throw new AiAssistError('The model declined this request', 'refusal');
    if (res.stop_reason === 'max_tokens') throw new AiAssistError('The answer was cut off; try a smaller batch', 'truncated');
    const text = res.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const u = res.usage;
    const cacheRead = u.cache_read_input_tokens || 0, cacheWrite = u.cache_creation_input_tokens || 0;
    result = { output: extractJson(text), inputTokens: u.input_tokens + cacheRead + cacheWrite, outputTokens: u.output_tokens, cacheRead, cacheWrite };
  }
  const [pin, pout] = s.provider === 'openai' ? [0, 0] : (PRICES[s.model] || PRICES[DEFAULT_MODEL]);
  // Cached prompt reads cost a tenth, writes a quarter more (Anthropic prompt caching).
  const cacheRead = result.cacheRead || 0, cacheWrite = result.cacheWrite || 0;
  const usd = ((result.inputTokens - cacheRead - cacheWrite) * pin + cacheWrite * pin * 1.25 + cacheRead * pin * 0.1 + result.outputTokens * pout) / 1e6;
  db.addAiUsage(month(), { calls: 1, inputTokens: result.inputTokens, outputTokens: result.outputTokens, usd });
  record({ ...base, ms: Date.now() - t0, ok: true, inputTokens: result.inputTokens, outputTokens: result.outputTokens, cacheRead, cacheWrite, usd: Math.round(usd * 1e6) / 1e6, stub: !!process.env.VELVET_AI_STUB });
  return result.output;
}
