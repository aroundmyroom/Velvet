# AI-assist — the admin guide (off by default)

AI-assist lets a language model help with two things: **genre families for
Auto-DJ** (the model proposes, you approve) and the **AI DJ** for listeners
(a set from a sentence — see [ai-dj.md](ai-dj.md)). The model works from a
description of your library, never from your files, and nothing it does
changes playback until you say so.

Everything is hidden until `aiAssist.enabled` is set in
`save/conf/default.json`. Without that flag the admin nav item stays hidden,
every endpoint answers `404`, and Auto-DJ behaves exactly as before.

```json
"aiAssist": {
  "enabled": true,
  "apiKey": "sk-ant-…",
  "model": "claude-haiku-5-5",
  "monthlyBudgetUsd": 2,
  "queueBuilder": false,
  "maxQueueSongs": 500
}
```

After a restart, **Admin → External Services → AI-assist** appears. Every
setting below can be changed there; the config file is only needed for the
first flag.

## The admin page, card by card

### Settings

- **Enabled**, **API key**, **Model** (`claude-haiku-5-5` by default;
  `claude-sonnet-5-5` and `claude-opus-5-5` know more music history at
  roughly twenty and forty times the price per request), **Monthly budget**
  in dollars — once spent, Velvet stops asking until next month.
- **AI DJ for listeners** switches the listener page on for everyone;
  **Max songs per AI set** (1–9999, default 500) caps one set.
- **House notes for the DJ** (shown once the AI DJ is on): free lines
  appended to every AI DJ briefing — shorthand ("FGTH = Frankie Goes To
  Hollywood"), where things live ("our 12-inches are in '12 inches A-Z'"),
  house meanings ("'Top 40' is the Dutch chart folder, not a genre"), taste.
  Lines of the form `A = B` also work as aliases for the rule-based reader.
  Up to 4000 characters.
- **What reading your library costs.** Saving a key reads nothing. This box
  shows what one full pass over your library would cost at the configured
  model, from your own database: genre tags to sort, folders to sort
  (folders whose tags already agree are free), folders to describe, the
  total, the same total on the other models, the price per 1,000 songs, the
  price of one AI DJ request afterwards, and what you have spent this month.
  It states what travels to the model (tag names, folder names, counts,
  years, a few file names per folder — never files, users or history). Tick
  **Read my library after saving** and the button becomes *Save and read the
  library*; without the tick, the key is saved and nothing runs.
  Measured on a 141,000-song library on Haiku: 4 cents for 523 genre and
  folder rules, 9 cents for 662 folder notes — about $0.0009 per 1,000 songs.
- **Advanced — your own model instead of Claude.** The provider can be
  switched to a self-hosted server with an OpenAI-compatible chat-completions
  API:

  | Server | URL to enter | Model name |
  |---|---|---|
  | [Ollama](https://ollama.com) | `http://localhost:11434/v1` | as in `ollama list`, e.g. `llama3.1:8b`, `qwen2.5:14b` |
  | [LM Studio](https://lmstudio.ai) | `http://localhost:1234/v1` | the loaded model's identifier |
  | llama.cpp (`llama-server`) | `http://localhost:8080/v1` | any name (the server has one model) |
  | [vLLM](https://docs.vllm.ai) | `http://localhost:8000/v1` | the served model id |
  | [LocalAI](https://localai.io) | `http://localhost:8080/v1` | as configured |
  | [Jan](https://jan.ai) | `http://localhost:1337/v1` | the loaded model's id |

  Settings: `provider: "openai"`, `localBaseUrl`, `localModel`, optional
  `localApiKey` (sent as `Authorization: Bearer …`). *Test connection* sends
  one tiny structured request and shows the answer time. Velvet asks for
  `response_format: json_schema` first, falls back to `json_object`, then to
  plain text with the schema in the prompt, and tolerates answers in markdown
  fences. Timeouts are three minutes per request. Nothing leaves your
  network, the budget does not apply (tokens are still counted), and the
  Anthropic key is ignored. A model of 8B parameters or more with JSON
  support writes usable briefs; smaller ones get the genre lists wrong more
  often, and the rule-based reader still catches a bad answer. The
  genre-family analysis sends 200 tags per request, which small context
  windows may not manage — run it on Claude once and keep the local model
  for the AI DJ if that happens.

### What the AI sees and does

The provider, model and endpoint in use (the key's last characters, or
"Bearer key" for a local server), this month's usage, and **every call since
the server started**: task, size, tokens in and out, cache hits (⚡), cost,
duration, result or error — with the first words of what was sent. Four
buttons show the exact texts: the **AI DJ** system prompt with the library
summary and the library notes it carries, the **genre-tag** batch, the
**folder** batch, and the **library-notes** historian's instructions with a
sample of the folder digest it reads. When a set looks wrong, this card is
where to look first: an AI DJ request shows the lookups the library
answered for its words, and a failed call shows the error the model
returned.

### What the AI knows about your library

Once, after reading the collection, the model writes what each folder *is*
— in music-history terms: a remix service, a yearly megamix series, a chart,
a label, an artist's discography — with the names people use for it and an
example request it answers. It reads a digest built from the database per
folder, three levels deep: size, sub-folders, years, median length, main
artists, genres, albums and a few file names. Examples from a real
collection: *"Grandmix: Ben Liebrand's yearly megamix on Dutch radio since
1983, with masters from Veronica and Radio 538. Hour-long megamixes are not
for a mixed set" (aliases GM)*; *"Disco Mix Club Series: the Disco Mix
Club's DJ-only remix series; many files are tagged Various Artists, so
search by title and remixer" (DMC)*; *"Bootleg: unofficial megamixes and
medleys — imitations, not the original recordings"*.

The notes are stored and listed here with a filter. **Edit** any note; an
edited note is marked as yours and never overwritten by a later pass.
**Delete** one (a later pass writes it again). **Describe new folders**
runs the pass for folders that have no note or whose size changed by a
fifth — the button shows how many and the estimate. **Describe everything
again** redoes all of them (edited notes kept). **Clear AI notes** removes
the model's notes. The pass also runs at the end of the genre analysis when
you asked for the full pass on save.

The AI DJ reads these notes on every request: the broad folders in its
cached system prompt, deeper ones travelling with a request whose words land
in that folder. Aliases from the notes also reach the rule-based reader.

### Genre families for Auto-DJ

**What they are — and are not.** A family is a *mixing* category Auto-DJ
uses to judge whether the next song sits well after the current one (House
after Italo-Disco: fine; Hardstyle after a Soul ballad: not). The AI DJ also
uses families when a listener asks for a broad style that is not a genre name
in the library. Families never filter: they do not remove songs from anything
and do not replace genre tags. Someone who wants *only* Top 40 or *only* R&B
keeps using the Auto-DJ genre whitelist, a smart playlist, the Genres view or
the AI DJ ("only R&B"). "Electronic" being broad is the point — it says
"these mix", not "these are the same".

Auto-DJ scores how well two songs mix by **genre family** — electronic,
disco, soft (pop/rock/urban), ambient, hard — with a compatibility matrix
(see [autodj-scoring.md](autodj-scoring.md)). The family used to come from a
keyword match on the genre tag alone, which fails in three ways a DJ library
shows all the time:

| Problem | Example from a 141k-file library |
|---|---|
| Tag is not a genre | `top 40` on 13,511 files, `other`, `mix`, `various`, `genre` |
| Tag is wrong | the Disconet remix series tagged `blues` (937 files) |
| No tag at all | 25,541 files (18%), mostly in mix and compilation folders |

Folders usually know better: `Disco/…`, `Labels/Strictly Rhythm/…`,
`!Disco Funk VinylRip Collection/1979/…` say what the tags do not. So a family
is resolved in three layers, most specific first:

1. **Approved tag rule** — per merged genre name (the same merged names the
   Genres view shows: `House`, `Italo-Disco`, `Blues`). `Ignore` means "this
   tag says nothing", e.g. `Top 40`.
2. **Approved folder rule** — per `vpath/folder` or `vpath/folder/subfolder`.
   The most specific rule wins. `Ignore` means the folder mixes families (an
   alphabetical or chart folder).
3. **Keyword match** on the tag — identical to the player's own fallback.

Only approved rules are used. The server attaches `genre-family` to every
Auto-DJ candidate (`POST /api/v1/db/random-songs` with `returnAll`) once at
least one rule is approved; the player prefers that over its keyword match.

**How the AI reads your library.** The card opens with what the active
profile's rules do to every song right now: songs per family, how each was
decided (tag rule, folder rule, keyword guess), the biggest genres in each
family, and how many songs are unknown (no tag, no folder rule — neutral for
Auto-DJ). `GET /api/v1/admin/ai/overview`.

**Analysis, proposals, profiles.** *Analyse library with AI* proposes every
genre tag and every folder in one background pass (the page shows progress
and refreshes as proposals land); the full pass on key save does the same.
Then, per row: **Approve** saves the family shown in the select — pick
another one first to modify the proposal before saving; **Undo** puts an
approved rule back to its proposal; **Remove** drops the rule; **Approve all
proposals** / **Clear proposals** act on the whole tab. Proposals never
overwrite an approved rule.

Rules live in **profiles** (Profile 1, 2, 3 …). Create one empty or as a
copy of the current rules, work on it as a draft, and *Use this profile*
when it should drive Auto-DJ; switching back is one click. The active
profile cannot be deleted.

**What a proposal is based on.** Genre tags go to the model in batches of
200 with their file count and the average BPM of the analysed files, which
separates a 128-BPM "Dance" from a 105-BPM "Pop". For folders (two levels
deep, at least 10–100 files depending on library size) Velvet first computes
what the files' own tags say: a folder whose tags agree (≥ 30 tagged, ≥ 65%
one family) is proposed from those statistics without asking the model. The
rest — untagged or mixed folders — go to the model with the folder name, the
tag statistics, the median BPM, the three artists with most files and a few
file names, so "Labels/Strictly Rhythm | median 124 BPM | Todd Terry,
Hardrive | 'Deep Inside (Original Mix)'" is read as house even without a
single tag. Each row shows that evidence.

### Users — AI DJ per user

On the **Users** page every user has an **AI DJ** switch. It is on for
everyone once the queue builder is on; switch it off for a user and the page
disappears for them and the endpoints answer `404`. Stored as
`allow-ai-dj: false` on the user.

## What is sent to the model, and what it costs

Genre tag names, library folder names (relative to the collection), file
counts and tag statistics, years, a few file names per folder, the names of
the listener's playlists, and — for the AI DJ — the listener's sentence.
Never files, absolute paths, user names, play history, the songs that were
chosen, or anything that identifies a person. Every call is counted and
shown on the activity card; once the monthly budget is spent Velvet stops
asking until next month.

| What | On claude-haiku-5-5, 141,000 songs |
|---|---|
| Genre and folder proposals (one pass) | about 4 cents |
| Library notes, 662 folders (once; later only new folders) | about 9 cents |
| One AI DJ request, prompt cached | about a tenth of a cent |

## Where it lives

| Part | File |
|---|---|
| Family resolver, folder statistics | `src/util/genre-family.js` |
| Shared resolver cache (built from approved rules) | `src/util/genre-family-cache.js` |
| Claude / OpenAI-compatible client, budget, cost estimate, test stub | `src/util/ai-assist.js` |
| Admin endpoints, analysis passes, library notes | `src/api/ai-assist.js` |
| Library notes digest and prompt | `src/util/ai-library-notes.js` |
| AI DJ endpoints, library summary, grounding, pool and relaxation | `src/api/ai-queue.js` |
| AI DJ planner (brief schema, corridor, scoring, ladder, keys) | `src/util/ai-queue.js` |
| Charts and series | `src/util/ai-charts.js` |
| Rule-based brief reader (fallback without a model) | `src/util/ai-brief-parser.js` |
| Library profile, candidate, chart and notes queries | `src/db/sqlite-backend.js` |
| Tables `genre_family_profiles`, `genre_family_rules`, `ai_library_notes`, `ai_usage` | `src/db/sqlite-backend.js` |
| AI DJ page | `webapp/app.js` (`viewAiDj`) |
| Admin page | `webapp/admin/index.js` (`ai-assist-view`) |
| Player scoring | `webapp/app.js` (`_djGenreFamilyOf`, `_djGenreAnchor`) |

Endpoints: [API.md](API.md#ai-assist--admin-velvet); calling the AI DJ from
your own scripts: [API/ai-queue.md](API/ai-queue.md).

Tests run against a stub (`VELVET_AI_STUB=<json file>`), never the API:
`test/genre-family.test.mjs`, `test/ai-queue.test.mjs`,
`test/ai-brief-parser.test.mjs`, `test/ai-charts.test.mjs`,
`test/ai-library-notes.test.mjs`, `test/integration/ai-assist.test.cjs`,
`test/integration/ai-queue.test.cjs`, `test/integration/ai-local-provider.test.cjs`.
