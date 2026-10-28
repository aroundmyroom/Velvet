/**
 * ai-assist.js — admin-only, hidden until aiAssist.enabled is set in config.
 *
 * Genre families for Auto-DJ: Claude proposes a family per genre tag and per
 * library folder; the admin approves. Only approved rules reach playback
 * (see util/genre-family-cache.js). Endpoints:
 *   GET  /api/v1/admin/ai/config
 *   POST /api/v1/admin/ai/config                   body: { enabled, apiKey, model, monthlyBudgetUsd }
 *   GET  /api/v1/admin/ai/genre-families
 *   POST /api/v1/admin/ai/genre-families/propose   body: { kind: 'genre'|'folder' }
 *   POST /api/v1/admin/ai/genre-families/apply     body: { items: [{ kind, key, family }] }
 *   POST /api/v1/admin/ai/genre-families/reset     body: { kind?, status?, profile? }
 *   POST /api/v1/admin/ai/genre-families/analyse   body: { profile? }   — genres + folders in the background
 *   GET  /api/v1/admin/ai/analysis
 *   GET  /api/v1/admin/ai/activity   — endpoint in use, usage, the last calls
 *   GET  /api/v1/admin/ai/context    — the exact texts each task sends
 *   GET  /api/v1/admin/ai/overview   — the library as one profile's families see it
 *   GET  /api/v1/admin/ai/profiles                 POST …/profiles { name, copyFrom? }, …/activate { id }, …/rename { id, name }, …/delete { id }
 * Rules live in profiles (Profile 1, 2, …); Auto-DJ uses the active one.
 */
import Joi from 'joi';
import * as config from '../state/config.js';
import * as admin from '../util/admin.js';
import * as db from '../db/manager.js';
import { joiValidate } from '../util/validation.js';
import { mergeGenreRows } from '../util/genre-merge.js';
import { FAMILIES, RULE_FAMILIES, createFamilyResolver, folderStats, keywordFamily } from '../util/genre-family.js';
import { allVpaths, genreRuleKey, invalidateGenreFamilyResolver } from '../util/genre-family-cache.js';
import * as ai from '../util/ai-assist.js';
import { NOTES_SCHEMA, NOTES_SYSTEM, NOTE_KINDS, digestLine, folderDigest } from '../util/ai-library-notes.js';
import { aiDjContext, invalidateLibraryNotes } from './ai-queue.js';

const FAMILY_GUIDE = `Families, chosen for DJ mixing compatibility:
- electronic: house, techno, trance, dance, eurodance, electro, synth-pop, new beat, freestyle, drum & bass, breaks, EDM
- disco: disco, funk, soul, boogie, Hi-NRG, italo disco, Motown, Philly, discotheque / disconet style re-edits
- soft: pop, rock, indie, R&B, hip-hop, jazz, blues, folk, country, reggae, schlager, Dutch-language pop
- ambient: ambient, chill-out, downtempo, lounge, new age
- hard: hardcore, hardstyle, gabber
- other: anything else that is a real genre (classical, soundtrack, spoken word)
- ignore: not a genre at all — chart names (Top 40), labels, years, decades, "Mix", "Various", languages, file formats
Tempo is a strong hint when given: disco/funk/soul 95–130 BPM, house 118–130, trance/eurodance 130–145, hardcore/hardstyle 150+, ambient/chill under 100, pop/rock anywhere. File names and artist names tell you the scene a folder belongs to.`;

const GENRE_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          tag: { type: 'string' },
          family: { type: 'string', enum: RULE_FAMILIES },
          confidence: { type: 'number' },
        },
        required: ['tag', 'family', 'confidence'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
};

const FOLDER_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          folder: { type: 'string' },
          family: { type: 'string', enum: RULE_FAMILIES },
          confidence: { type: 'number' },
          reason: { type: 'string' },
        },
        required: ['folder', 'family', 'confidence', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
};

const PROPOSE_BATCH = 200;

const GENRE_SYSTEM = `You sort music genre tags from a DJ's library into families.\n${FAMILY_GUIDE}\nEach line: tag | files | average BPM of the analysed files, when any. Answer for every tag, in the order given. Confidence is 0 to 1.`;
const FOLDER_SYSTEM = `You judge library folders of a DJ's music collection. Each line: folder path (collection name, series, label or artist) | files | what the files' own genre tags say | median BPM of the analysed files | the artists with most files | a few file names.\n${FAMILY_GUIDE}\nPick the family the whole folder belongs to. Use ignore when a folder mixes families (an alphabetical or yearly folder, a chart) or you cannot tell. Answer for every folder, in the order given. Confidence is 0 to 1. Reason: at most twelve words.`;

function genreLine(g) {
  return `${g.genre} | ${g.cnt} files${g.bpmN ? ` | ~${g.bpmAvg} BPM (${g.bpmN} analysed)` : ''}`;
}
function folderLine(f) {
  const parts = [f.key, `${f.n} files`, f.tagged ? `tags: ${describeFamilies(f.families, f.tagged)} of ${f.tagged} tagged` : 'no tags'];
  if (f.bpmN) parts.push(`median ${f.bpmMedian} BPM (${f.bpmN} analysed)`);
  if (f.topArtists?.length) parts.push(`artists: ${f.topArtists.join(', ')}`);
  if (f.samples?.length) parts.push(`files: ${f.samples.map(x => `"${x}"`).join(', ')}`);
  return parts.join(' | ');
}

function gate(req, res) {
  if (req.user.admin !== true) { res.status(403).json({ error: 'Admin only' }); return false; }
  if (!ai.isEnabled()) { res.status(404).json({ error: 'Not found' }); return false; }
  return true;
}

function folderMinFiles(total) {
  return Math.max(10, Math.min(100, Math.floor(total / 500)));
}

// Tempo per merged genre name, from the raw tags folded into it.
function genreTempo(rawMap) {
  const raw = new Map(db.getGenreBpm(allVpaths()).map(r => [r.genre, r]));
  const out = new Map();
  for (const [display, raws] of rawMap) {
    let sum = 0, n = 0;
    for (const r of raws) { const b = raw.get(r); if (b) { sum += b.bpmAvg * b.bpmN; n += b.bpmN; } }
    if (n) out.set(display, { bpmAvg: Math.round(sum / n), bpmN: n });
  }
  return out;
}

function listGenres(profile) {
  const { genres, rawMap } = mergeGenreRows(db.getGenres(allVpaths()));
  const tempo = genreTempo(rawMap);
  const rules = new Map(db.getGenreFamilyRules(null, profile).filter(r => r.kind === 'genre').map(r => [r.key, r]));
  return genres.map(g => {
    const r = rules.get(genreRuleKey(g.genre));
    const t = tempo.get(g.genre);
    return {
      key: genreRuleKey(g.genre), genre: g.genre, cnt: g.cnt, keyword: keywordFamily(g.genre), bpmAvg: t?.bpmAvg ?? null, bpmN: t?.bpmN ?? 0,
      family: r?.family ?? null, status: r?.status ?? 'none', proposed: r?.proposed_family ?? null,
      confidence: r?.confidence ?? null, note: r?.note ?? null, source: r?.source ?? null,
    };
  });
}

function listFolders(profile) {
  const rows = db.getFolderGenreRows(allVpaths());
  const stats = folderStats(rows, { minFiles: folderMinFiles(rows.length), maxDepth: 2 });
  const rules = new Map(db.getGenreFamilyRules(null, profile).filter(r => r.kind === 'folder').map(r => [r.key, r]));
  return stats.map(s => {
    const r = rules.get(s.key);
    return {
      key: s.key, depth: s.depth, n: s.n, tagged: s.tagged, families: s.families, top: s.top, share: s.share, clear: s.clear,
      bpmMedian: s.bpmMedian, bpmN: s.bpmN, topArtists: s.topArtists, samples: s.samples,
      family: r?.family ?? null, status: r?.status ?? 'none', proposed: r?.proposed_family ?? null,
      confidence: r?.confidence ?? null, note: r?.note ?? null, source: r?.source ?? null,
    };
  });
}

async function proposeGenres(profile) {
  const todo = listGenres(profile).filter(g => g.status !== 'approved');
  const byTag = new Map(todo.map(g => [g.genre.toLowerCase(), g]));
  const proposals = [];
  for (let i = 0; i < todo.length; i += PROPOSE_BATCH) {
    const batch = todo.slice(i, i + PROPOSE_BATCH);
    const out = await ai.askJson({
      task: 'genre-families',
      system: GENRE_SYSTEM,
      prompt: batch.map(genreLine).join('\n'),
      schema: GENRE_SCHEMA,
    });
    for (const it of out.items || []) {
      const g = byTag.get(String(it.tag).toLowerCase());
      if (g && RULE_FAMILIES.includes(it.family)) {
        proposals.push({ kind: 'genre', key: g.key, label: g.genre, family: it.family, confidence: Math.max(0, Math.min(1, Number(it.confidence) || 0)), source: 'ai', note: null });
      }
    }
  }
  return db.proposeGenreFamilyRules(proposals, profile);
}

function describeFamilies(families, tagged) {
  return Object.entries(families).sort((a, b) => b[1] - a[1]).map(([f, n]) => `${f} ${Math.round(100 * n / tagged)}%`).join(', ');
}

async function proposeFolders(profile) {
  const folders = listFolders(profile).filter(f => f.status !== 'approved');
  const proposals = [];
  const unclear = [];
  for (const f of folders) {
    if (f.clear) {
      proposals.push({ kind: 'folder', key: f.key, label: f.key, family: f.top, confidence: f.share, source: 'stats', note: `tags: ${describeFamilies(f.families, f.tagged)} of ${f.tagged}` });
    } else {
      unclear.push(f);
    }
  }
  for (let i = 0; i < unclear.length; i += PROPOSE_BATCH) {
    const batch = unclear.slice(i, i + PROPOSE_BATCH);
    const byKey = new Map(batch.map(f => [f.key, f]));
    const out = await ai.askJson({
      task: 'folder-families',
      system: FOLDER_SYSTEM,
      prompt: batch.map(folderLine).join('\n'),
      schema: FOLDER_SCHEMA,
    });
    for (const it of out.items || []) {
      const f = byKey.get(String(it.folder));
      if (f && RULE_FAMILIES.includes(it.family)) {
        proposals.push({ kind: 'folder', key: f.key, label: f.key, family: it.family, confidence: Math.max(0, Math.min(1, Number(it.confidence) || 0)), source: 'ai', note: String(it.reason || '').slice(0, 200) });
      }
    }
  }
  return db.proposeGenreFamilyRules(proposals, profile);
}

// ── Library notes: what each folder is ─────────────────────────────────────
// The model reads a digest of every folder (sizes, years, lengths, artists,
// genres, albums, file names) and writes what it is in music-history terms.
// Stored, shown to the admin, editable; the AI DJ reads them on every request.
const NOTES_BATCH = 12;
const NOTES_PLAN_TTL_MS = 60 * 1000;
const notesAnalysis = { running: false, startedAt: null, finishedAt: null, error: null, folders: 0, todo: 0, done: 0, usd: 0 };
let _plan = null;
function notesPlan({ force = false } = {}) {
  if (!force && _plan && Date.now() - _plan.at < NOTES_PLAN_TTL_MS) return _plan.value;
  const digest = folderDigest(db.getFolderDigestRows(allVpaths()));
  const have = new Map(db.getLibraryNotes().map(x => [x.key, x]));
  // new folders, and folders that grew or shrank by a fifth since their note
  const todo = digest.filter(d => {
    const x = have.get(d.key);
    if (!x) return true;
    if (x.source === 'edited') return false;
    return force || Math.abs(x.n - d.n) > Math.max(5, d.n * 0.2);
  });
  const perFolder = { input: 110, output: 70 };
  const value = {
    digest, todo, noted: have.size,
    estimateUsd: ai.estimateUsd(todo.length * perFolder.input + Math.ceil(todo.length / NOTES_BATCH) * 700, todo.length * perFolder.output),
  };
  _plan = { at: Date.now(), value };
  return value;
}
export function invalidateNotesPlan() { _plan = null; }

// What one full pass over this library would cost, shown before the admin
// lets the model read it. Tokens per item measured on a 141,000-song library
// (2026-10-28, Haiku): $0.015 for 523 genre and folder rules, $0.085 for 662
// folder notes; one AI DJ request about $0.001 with its prompt cached.
const TOKENS = { genre: [60, 40], folder: [150, 60], note: [200, 200], brief: [4500, 300] };
const ESTIMATE_TTL_MS = 60 * 1000;
let _estimate = null;
function analysisEstimate(profile) {
  if (_estimate && Date.now() - _estimate.at < ESTIMATE_TTL_MS && _estimate.profile === profile) return _estimate.value;
  const s = ai.settings();
  const songs = db.getLibraryProfile(allVpaths())?.total || 0;
  const genres = listGenres(profile).filter(g => g.status !== 'approved').length;
  const folders = listFolders(profile).filter(f => f.status !== 'approved' && !f.clear).length;
  const plan = notesPlan();
  const items = { genres, folders, notes: plan.todo.length, notesAll: plan.digest.length };
  const cost = model => {
    if (s.provider === 'openai') return { genres: 0, folders: 0, notes: 0, total: 0, brief: 0 };
    const part = (n, [tin, tout]) => ai.estimateUsdFor(model, n * tin, n * tout);
    const c = { genres: part(genres, TOKENS.genre), folders: part(folders, TOKENS.folder), notes: part(items.notes, TOKENS.note), brief: part(1, TOKENS.brief) };
    return { ...c, total: c.genres + c.folders + c.notes };
  };
  const usd = cost(s.model);
  const value = {
    songs, items, model: s.provider === 'openai' ? s.localModel : s.model, provider: s.provider, usd,
    perThousandSongs: songs ? usd.total / songs * 1000 : 0,
    models: Object.fromEntries(ai.MODELS.map(m => [m, cost(m).total])),
  };
  _estimate = { at: Date.now(), profile, value };
  return value;
}

// One batch of folders described; an answer that ran out of room is retried
// as two halves rather than lost.
async function describeFolders(batch) {
  const byKey = new Map(batch.map(d => [d.key, d]));
  let out;
  try {
    out = await ai.askJson({
      task: 'library-notes',
      system: [{ type: 'text', text: NOTES_SYSTEM, cache_control: { type: 'ephemeral' } }],
      prompt: batch.map(digestLine).join('\n'),
      schema: NOTES_SCHEMA,
      maxTokens: 12000,
    });
  } catch (e) {
    if (e.code === 'truncated' && batch.length > 1) {
      const half = Math.ceil(batch.length / 2);
      return (await describeFolders(batch.slice(0, half))) + (await describeFolders(batch.slice(half)));
    }
    throw e;
  }
  const items = [];
  for (const it of out.items || []) {
    const d = byKey.get(String(it.folder));
    if (!d) continue;
    items.push({
      key: d.key, vpath: d.vpath, folder: d.folder, depth: d.depth, n: d.n,
      kind: NOTE_KINDS.includes(it.kind) ? it.kind : 'other',
      note: String(it.note || '').trim().slice(0, 600),
      aliases: (Array.isArray(it.aliases) ? it.aliases : []).map(a => String(a).trim()).filter(a => a && a.length <= 40).slice(0, 4),
      ask: String(it.ask || '').trim().slice(0, 200),
    });
  }
  db.putLibraryNotes(items);
  invalidateLibraryNotes();
  return items.length;
}

async function runNotes({ force = false } = {}) {
  const { digest, todo } = notesPlan({ force });
  const usdBefore = ai.usage().usd;
  Object.assign(notesAnalysis, { running: true, startedAt: Date.now(), finishedAt: null, error: null, folders: digest.length, todo: todo.length, done: 0, usd: 0 });
  try {
    for (let i = 0; i < todo.length; i += NOTES_BATCH) {
      const batch = todo.slice(i, i + NOTES_BATCH);
      await describeFolders(batch);
      notesAnalysis.done += batch.length;
      notesAnalysis.usd = ai.usage().usd - usdBefore;
    }
    console.log(`[ai-assist] library notes: ${notesAnalysis.done} folders described, $${notesAnalysis.usd.toFixed(3)}`);
  } catch (e) {
    notesAnalysis.error = e.message;
    console.warn(`[ai-assist] library notes failed: ${e.message}`);
  } finally {
    notesAnalysis.running = false;
    notesAnalysis.finishedAt = Date.now();
    _plan = null;
  }
}
export function startNotesAnalysis(opts) {
  if (notesAnalysis.running || analysis.running) return false;
  runNotes(opts);
  return true;
}

// One background pass over genres and folders — started when a key is saved,
// or on request. Proposals only; nothing changes for Auto-DJ until approved.
// The library notes follow in the same pass (new folders only).
const analysis = { running: false, profile: null, startedAt: null, finishedAt: null, error: null, genres: 0, folders: 0 };
export function startAnalysis(profile) {
  if (analysis.running || notesAnalysis.running) return false;
  Object.assign(analysis, { running: true, profile, startedAt: Date.now(), finishedAt: null, error: null, genres: 0, folders: 0 });
  (async () => {
    try {
      analysis.genres = await proposeGenres(profile);
      analysis.folders = await proposeFolders(profile);
      console.log(`[ai-assist] analysis done for profile ${profile}: ${analysis.genres} genre and ${analysis.folders} folder proposals`);
      await runNotes();
    } catch (e) {
      analysis.error = e.message;
      console.warn(`[ai-assist] analysis failed: ${e.message}`);
    } finally {
      analysis.running = false;
      analysis.finishedAt = Date.now();
    }
  })();
  return true;
}

// The whole library through the eyes of one profile: how many songs land in
// each family, by which layer (tag rule, folder rule, keyword guess), and the
// genres that fill each family. This is what the families would do to Auto-DJ.
const OVERVIEW_TTL_MS = 60 * 1000;
const _overview = new Map();
function libraryOverview(profile) {
  const rules = db.getGenreFamilyRules('approved', profile);
  const cacheKey = `${profile}:${rules.length}:${Math.max(0, ...rules.map(r => r.ts || 0))}`;
  const hit = _overview.get(cacheKey);
  if (hit && Date.now() - hit.at < OVERVIEW_TTL_MS) return hit.value;
  const rows = db.getFolderGenreRows(allVpaths());
  const { genres, rawMap } = mergeGenreRows(db.getGenres(allVpaths()));
  const display = new Map();
  for (const [d, raws] of rawMap) for (const r of raws) display.set(r, d);
  const resolver = createFamilyResolver({
    genreRules: new Map(rules.filter(r => r.kind === 'genre').map(r => [r.key, r.family])),
    folderRules: rules.filter(r => r.kind === 'folder').map(r => ({ key: r.key, family: r.family })),
    rawMap,
  });
  const fam = Object.fromEntries([...FAMILIES, 'unknown'].map(f => [f, { songs: 0, viaTag: 0, viaFolder: 0, viaKeyword: 0, genres: new Map() }]));
  let withBpm = 0, withKey = 0, withGenre = 0;
  const folders = new Set(), subfolders = new Set();
  for (const r of rows) {
    const res = resolver.resolve(r);
    const f = fam[res?.family || 'unknown'];
    f.songs++;
    if (res?.source === 'genre') f.viaTag++; else if (res?.source === 'folder') f.viaFolder++; else if (res) f.viaKeyword++;
    const tag = (r.genre || '').trim();
    if (tag) { withGenre++; const d = display.get(r.genre) || tag; f.genres.set(d, (f.genres.get(d) || 0) + 1); }
    if (r.bpm > 0) withBpm++;
    const i = r.filepath.indexOf('/');
    if (i > 0) { folders.add(`${r.vpath}/${r.filepath.slice(0, i)}`); const j = r.filepath.indexOf('/', i + 1); if (j > 0) subfolders.add(`${r.vpath}/${r.filepath.slice(0, j)}`); }
  }
  withKey = db.getLibraryProfile(allVpaths())?.withKey ?? 0;
  const value = {
    library: { songs: rows.length, withGenre, withoutGenre: rows.length - withGenre, genres: genres.length, withBpm, withKey, folders: folders.size, subfolders: subfolders.size },
    rules: { tag: rules.filter(r => r.kind === 'genre').length, folder: rules.filter(r => r.kind === 'folder').length },
    families: Object.fromEntries(Object.entries(fam).map(([k, v]) => [k, { songs: v.songs, viaTag: v.viaTag, viaFolder: v.viaFolder, viaKeyword: v.viaKeyword, genres: [...v.genres.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([genre, cnt]) => ({ genre, cnt })) }])),
  };
  _overview.set(cacheKey, { value, at: Date.now() });
  if (_overview.size > 20) _overview.delete(_overview.keys().next().value);
  return value;
}

function profileOf(req, res) {
  const raw = req.query.profile ?? req.body?.profile;
  const id = raw == null || raw === '' ? db.activeGenreFamilyProfile() : Number(raw);
  if (!Number.isInteger(id) || !db.getGenreFamilyProfiles().some(p => p.id === id)) { res.status(404).json({ error: 'No such profile' }); return null; }
  return id;
}

export function setup(velvet) {
  velvet.get('/api/v1/admin/ai/config', (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });
    const s = ai.settings();
    res.json({ ...s, usage: ai.usage(), families: FAMILIES, estimate: analysisEstimate(db.activeGenreFamilyProfile()) });
  });

  velvet.post('/api/v1/admin/ai/config', async (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });
    const schema = Joi.object({
      enabled:          Joi.boolean().required(),
      apiKey:           Joi.string().allow('').max(300).required(),
      model:            Joi.string().pattern(/^claude-[a-z0-9-]+$/).required(),
      monthlyBudgetUsd: Joi.number().min(0).max(1000).required(),
      queueBuilder:     Joi.boolean().default(false),
      maxQueueSongs:    Joi.number().integer().min(1).max(ai.MAX_QUEUE_SONGS).default(500),
      provider:         Joi.string().valid('anthropic', 'openai').default('anthropic'),
      localBaseUrl:     Joi.string().trim().allow('').max(300).pattern(/^(https?:\/\/.+)?$/).default(''),
      localModel:       Joi.string().trim().allow('').max(120).default(''),
      localApiKey:      Joi.string().allow('').max(300).default(''),
      djNotes:          Joi.string().allow('').max(4000).default(''),
      analyse:          Joi.boolean().default(false),
    });
    const { value: { analyse, ...value } } = joiValidate(schema, req.body);
    const loadConfig = await admin.loadFile(config.configFile);
    loadConfig.aiAssist = { ...(loadConfig.aiAssist || {}), ...value };
    await admin.saveFile(loadConfig, config.configFile);
    config.program.aiAssist = { ...(config.program.aiAssist || {}), ...value };
    _estimate = null;
    // The library is only read when the admin asked for it, having seen the estimate.
    const canAsk = value.enabled && (value.provider === 'openai' ? !!value.localBaseUrl : !!value.apiKey);
    const analysing = analyse && canAsk ? startAnalysis(db.activeGenreFamilyProfile()) : false;
    res.json({ analysing, estimate: analysisEstimate(db.activeGenreFamilyProfile()) });
  });

  // One tiny structured request to whichever provider is configured — the
  // admin's way to see that a self-hosted server answers before relying on it.
  velvet.post('/api/v1/admin/ai/test', async (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });
    if (!ai.isEnabled()) return res.status(409).json({ error: 'AI-assist is disabled', code: 'disabled' });
    const t0 = Date.now();
    try {
      const out = await ai.askJson({
        task: 'ping',
        system: 'You answer with JSON only.',
        prompt: 'Reply with {"ok": true, "model": "<your model name or family>"}.',
        schema: { type: 'object', properties: { ok: { type: 'boolean' }, model: { type: 'string' } }, required: ['ok', 'model'], additionalProperties: false },
        maxTokens: 200, timeoutMs: 60_000, maxRetries: 0,
      });
      res.json({ ok: out?.ok === true, model: String(out?.model || ''), ms: Date.now() - t0, provider: ai.settings().provider });
    } catch (e) {
      if (e instanceof ai.AiAssistError || e?.status) return res.status(409).json({ ok: false, error: e.message, code: e.code || 'error', ms: Date.now() - t0 });
      throw e;
    }
  });

  velvet.get('/api/v1/admin/ai/genre-families', (req, res) => {
    if (!gate(req, res)) return;
    const profile = profileOf(req, res);
    if (!profile) return;
    res.json({ families: FAMILIES, ruleFamilies: RULE_FAMILIES, profile, profiles: db.getGenreFamilyProfiles(), analysis, genres: listGenres(profile), folders: listFolders(profile), usage: ai.usage() });
  });

  velvet.get('/api/v1/admin/ai/analysis', (req, res) => {
    if (!gate(req, res)) return;
    res.json({ ...analysis, notes: notesAnalysis });
  });

  // What the admin can see: where requests go, what was sent, and the exact
  // texts the model reads for each task.
  velvet.get('/api/v1/admin/ai/activity', (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });
    res.json({ endpoint: ai.endpointInfo(), usage: ai.usage(), calls: ai.recentCalls(), analysis });
  });

  velvet.get('/api/v1/admin/ai/overview', (req, res) => {
    if (!gate(req, res)) return;
    const profile = profileOf(req, res);
    if (!profile) return;
    res.json({ profile, ...libraryOverview(profile) });
  });

  velvet.get('/api/v1/admin/ai/context', (req, res) => {
    if (!gate(req, res)) return;
    const profile = profileOf(req, res);
    if (!profile) return;
    const genres = listGenres(profile);
    const folders = listFolders(profile);
    res.json({
      genres: { system: GENRE_SYSTEM, sample: genres.slice(0, 12).map(genreLine).join('\n'), lines: genres.length, batch: PROPOSE_BATCH },
      folders: { system: FOLDER_SYSTEM, sample: folders.slice(0, 8).map(folderLine).join('\n'), lines: folders.length, fromStats: folders.filter(f => f.clear).length },
      aidj: aiDjContext(req.user),
      notes: { system: NOTES_SYSTEM, sample: notesPlan().digest.slice(0, 6).map(digestLine).join('\n'), lines: notesPlan().digest.length },
    });
  });

  velvet.post('/api/v1/admin/ai/genre-families/analyse', (req, res) => {
    if (!gate(req, res)) return;
    const profile = profileOf(req, res);
    if (!profile) return;
    if (!ai.settings().apiKey) return res.status(409).json({ error: 'No API key configured', code: 'nokey' });
    res.json({ started: startAnalysis(profile), analysis });
  });

  velvet.get('/api/v1/admin/ai/library-notes', (req, res) => {
    if (!gate(req, res)) return;
    const plan = notesPlan();
    res.json({
      notes: db.getLibraryNotes(), kinds: NOTE_KINDS, analysis: notesAnalysis,
      plan: { folders: plan.digest.length, todo: plan.todo.length, noted: plan.noted, estimateUsd: Math.round(plan.estimateUsd * 1000) / 1000, batches: Math.ceil(plan.todo.length / NOTES_BATCH) },
    });
  });

  velvet.post('/api/v1/admin/ai/library-notes/analyse', (req, res) => {
    if (!gate(req, res)) return;
    joiValidate(Joi.object({ force: Joi.boolean().default(false) }), req.body);
    if (ai.settings().provider !== 'openai' && !ai.settings().apiKey) return res.status(409).json({ error: 'No API key configured', code: 'nokey' });
    res.json({ started: startNotesAnalysis({ force: !!req.body.force }), analysis: notesAnalysis });
  });

  velvet.post('/api/v1/admin/ai/library-notes/edit', (req, res) => {
    if (!gate(req, res)) return;
    joiValidate(Joi.object({
      key: Joi.string().max(600).required(),
      kind: Joi.string().valid(...NOTE_KINDS).required(),
      note: Joi.string().trim().allow('').max(600).required(),
      aliases: Joi.array().items(Joi.string().trim().max(40)).max(6).default([]),
      ask: Joi.string().trim().allow('').max(200).default(''),
    }), req.body);
    const ok = db.editLibraryNote(req.body.key, { kind: req.body.kind, note: req.body.note, aliases: req.body.aliases.filter(Boolean), ask: req.body.ask });
    if (!ok) return res.status(404).json({ error: 'No such note' });
    invalidateLibraryNotes();
    res.json({ ok: true });
  });

  velvet.post('/api/v1/admin/ai/library-notes/delete', (req, res) => {
    if (!gate(req, res)) return;
    joiValidate(Joi.object({ key: Joi.string().max(600).required() }), req.body);
    if (!db.deleteLibraryNote(req.body.key)) return res.status(404).json({ error: 'No such note' });
    invalidateLibraryNotes(); _plan = null;
    res.json({ ok: true });
  });

  velvet.post('/api/v1/admin/ai/library-notes/reset', (req, res) => {
    if (!gate(req, res)) return;
    joiValidate(Joi.object({ keepEdited: Joi.boolean().default(true) }), req.body);
    const removed = db.clearLibraryNotes({ keepEdited: req.body.keepEdited !== false });
    invalidateLibraryNotes(); _plan = null;
    res.json({ removed });
  });

  velvet.get('/api/v1/admin/ai/profiles', (req, res) => {
    if (!gate(req, res)) return;
    res.json({ profiles: db.getGenreFamilyProfiles(), active: db.activeGenreFamilyProfile() });
  });

  velvet.post('/api/v1/admin/ai/profiles', (req, res) => {
    if (!gate(req, res)) return;
    joiValidate(Joi.object({ name: Joi.string().trim().min(1).max(60).required(), copyFrom: Joi.number().integer().optional() }), req.body);
    const id = db.createGenreFamilyProfile(req.body.name.trim(), req.body.copyFrom || null);
    res.json({ id, profiles: db.getGenreFamilyProfiles() });
  });

  velvet.post('/api/v1/admin/ai/profiles/activate', (req, res) => {
    if (!gate(req, res)) return;
    joiValidate(Joi.object({ id: Joi.number().integer().required() }), req.body);
    if (!db.getGenreFamilyProfiles().some(p => p.id === req.body.id)) return res.status(404).json({ error: 'No such profile' });
    db.activateGenreFamilyProfile(req.body.id);
    invalidateGenreFamilyResolver();
    res.json({ active: req.body.id, profiles: db.getGenreFamilyProfiles() });
  });

  velvet.post('/api/v1/admin/ai/profiles/rename', (req, res) => {
    if (!gate(req, res)) return;
    joiValidate(Joi.object({ id: Joi.number().integer().required(), name: Joi.string().trim().min(1).max(60).required() }), req.body);
    if (!db.renameGenreFamilyProfile(req.body.id, req.body.name.trim())) return res.status(404).json({ error: 'No such profile' });
    res.json({ profiles: db.getGenreFamilyProfiles() });
  });

  velvet.post('/api/v1/admin/ai/profiles/delete', (req, res) => {
    if (!gate(req, res)) return;
    joiValidate(Joi.object({ id: Joi.number().integer().required() }), req.body);
    if (req.body.id === db.activeGenreFamilyProfile()) return res.status(409).json({ error: 'The active profile cannot be deleted', code: 'active' });
    if (!db.deleteGenreFamilyProfile(req.body.id)) return res.status(404).json({ error: 'No such profile' });
    res.json({ profiles: db.getGenreFamilyProfiles() });
  });

  velvet.post('/api/v1/admin/ai/genre-families/propose', async (req, res) => {
    if (!gate(req, res)) return;
    joiValidate(Joi.object({ kind: Joi.string().valid('genre', 'folder').required(), profile: Joi.number().integer().optional() }), req.body);
    const profile = profileOf(req, res);
    if (!profile) return;
    try {
      const proposed = req.body.kind === 'genre' ? await proposeGenres(profile) : await proposeFolders(profile);
      res.json({ proposed, usage: ai.usage() });
    } catch (e) {
      if (e instanceof ai.AiAssistError) return res.status(409).json({ error: e.message, code: e.code });
      throw e;
    }
  });

  velvet.post('/api/v1/admin/ai/genre-families/apply', (req, res) => {
    if (!gate(req, res)) return;
    const schema = Joi.object({
      items: Joi.array().items(Joi.object({
        kind:   Joi.string().valid('genre', 'folder').required(),
        key:    Joi.string().max(500).required(),
        family: Joi.string().valid(...RULE_FAMILIES, 'none', 'undo').required(),
        label:  Joi.string().max(500).allow('').optional(),
      })).min(1).max(5000).required(),
      profile: Joi.number().integer().optional(),
    });
    joiValidate(schema, req.body);
    const profile = profileOf(req, res);
    if (!profile) return;
    db.approveGenreFamilyRules(req.body.items, profile);
    invalidateGenreFamilyResolver();
    res.json({ applied: req.body.items.length });
  });

  velvet.post('/api/v1/admin/ai/genre-families/reset', (req, res) => {
    if (!gate(req, res)) return;
    joiValidate(Joi.object({
      kind:   Joi.string().valid('genre', 'folder').optional(),
      status: Joi.string().valid('proposed', 'approved').default('proposed'),
      profile: Joi.number().integer().optional(),
    }), req.body);
    const profile = profileOf(req, res);
    if (!profile) return;
    const removed = db.deleteGenreFamilyRules({ kind: req.body.kind, status: req.body.status || 'proposed', profile });
    invalidateGenreFamilyResolver();
    res.json({ removed });
  });
}
