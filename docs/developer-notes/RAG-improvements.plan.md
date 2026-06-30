# RAG improvements — plan

Status: **draft** — initial impressions on the seven RAG ideas in
[user-guidance/ideas.md](user-guidance/ideas.md) §RAG, **re-grounded against the
codebase 2026-06-19** (the code moved a lot after the first draft — see the
"What changed since first draft" callout). Nothing here is settled; this doc
captures where each idea touches the code, whether I agree, rough size,
dependencies, and the open questions to resolve before any of it becomes a spec.

Source of truth for current behaviour: [memory.md](../memory.md). Code lives in
`src/server/memory/` (retrieval legs, lore gating, facts),
`src/server/ai/embeddings.ts` (embedder + demo `pseudo` hash), and
`src/server/engine/pipeline.ts` (prompt assembly + history window).

## What changed since first draft (2026-06-19 re-grounding)

Five things the first draft got wrong or that the code has since overtaken — read
these before the idea-by-idea section, they reshape three of the seven ideas:

1. **Provenance logging already exists** (reshapes #2). All three legs already
   write a `"retrieval"` event carrying `query` + a full `candidates[]` list with
   per-candidate `score` (`episodes.ts:149`, `facts.ts:229`, `lore.ts:265`),
   consumed by the admin Turn Inspector (`inspect` route + `inspector-tab.tsx`).
   Idea #2 is no longer "add provenance from scratch" — it's "split the query,
   fuse, and switch the logged `query` from the concatenated blob to per-source
   attribution (+ surface `candidates[]` in the Inspector UI)."
2. **The "no LLM before narration" hard constraint is reversed** (reshapes #7). A
   pre-narrator intake agent (`intake.ts:runIntake`) shipped 2026-06-18 and runs a
   real model call in the pre-turn fan-out, *before* narration (`pipeline.ts`
   ~549-583), degrading to the regex `detectIntent` on timeout/demo/disable. The
   pass-over was reversed 2026-06-14 (followups.phase2 #15/16; the
   turn-pipeline memo). So #7 step 3's "if we accept a pre-narration model hop"
   gate is now **half-open** — a slot exists, latency-hidden.
3. **`canon` is never written `false`** (corrects #5). No fact-creation path sets
   `canon` — every fact inserts with the schema default `true` (`addFacts`,
   `facts.ts:147`). `witnessedBy` *is* written truthfully (the witness set), but
   `canon` is a dormant always-true column with **no producer of belief/lie facts
   to gate against** yet. The first draft's "written truthfully every turn" was
   only ever true of `witnessedBy`.
4. **The merge channel is three strands, not two** (refines #1). Facts +
   director `characterNotes` + **recalled episodes** (prefixed `Recalled: `) all
   dedupe into the ≤8 channel (`pipeline.ts:680-686`, `FACTS_CAP = 8`). A fact
   floor competes for those 8 slots against episodes too, and there's a second
   `FACTS_CAP` backstop at `narrative.ts:296`.
5. **Idea #3's fix is wider but cheaper than written.** The pipeline duplicates
   not just `isUnlocked`/`sceneChunkMatches` but also inlines the `always`/`scene`
   selectors — *however*, it already builds the exact `SceneContext` adapter the
   centralization needs (`pipeline.ts:567-575`), so the work is mostly delete +
   reuse.

## Where the system actually is today

A grounding pass, because several of the seven ideas are framed slightly off from
the current code:

- **Retrieval is a single concatenated query.** `preTurnRetrieve`
  (`retrieval.ts:37`) joins `queries + input` with `\n` into one `queryText`
  (`retrieval.ts:38-41`), then fans out to three independent legs (episodes /
  facts / lore) via `Promise.allSettled` (`retrieval.ts:44-48`), each embedding
  that one string once (`episodes.ts:111`, `facts.ts:198`, `lore.ts:234`). No
  per-query embedding, no fusion.
- **Facts have *no* relevance floor.** Episodes gate at `EPISODE_MIN_SCORE = 0.55`
  (`constants.ts:24`) and lore at `LORE_MIN_SCORE = 0.72` (`constants.ts:18`), but
  `retrieveFacts` (`facts.ts:187-235`) returns the top `FACT_RETRIEVAL_LIMIT = 5`
  active facts *unconditionally* — its own docstring says "no minimum score"
  (`facts.ts:182-185`). The only fact gate is write-side: `FACT_MIN_CONFIDENCE =
  0.4` (`constants.ts:52`) drops low-confidence drafts before embedding — a
  *confidence* floor at insert, **not** a retrieval similarity floor. So idea #1's
  "blunt universal threshold" is, for facts specifically, the opposite problem:
  there's no floor at all, which is exactly why "random semantic neighbors" leak
  in. The merger then squeezes facts + director `characterNotes` + recalled
  episodes into a single deduped ≤8-item channel (`pipeline.ts:680-686`,
  `FACTS_CAP = 8`).
- **No presence/witness gating in retrieval.** `witnessedBy` (`schema.ts:499`,
  written via `computeWitnessSet` in `merge.ts` and per-NPC in `inner-note.ts`)
  and `canon` (`schema.ts:497`, default `true`, never written `false`) are columns
  the retrieval `SELECT` never reads (`retrieveFacts` returns only
  `id/kind/subjectName/text/score`, `facts.ts:21-27`). The knowledge-ledger
  consumer is phase 6 ([character-memory-spec.phase3.md](finished/character-memory-spec.phase3.md)),
  which has **not started** and is not on the roadmap.
- **Lore gating is duplicated.** `lore.ts` owns the canonical helpers
  (`isChunkUnlocked` `:81`, `selectAlwaysChunks` `:86`, `selectSceneChunks` `:97`,
  `eligibleRetrievalChunks` `:112`, and the private `matchesScene` `:122`), but
  `pipeline.ts:825-837` carries its own local `isUnlocked` / `sceneChunkMatches`,
  and the prompt-assembly site (`pipeline.ts:664-678`) inlines the `always`/`scene`
  selection logic instead of calling the exports — a real drift risk (idea #3).
- **History is still a flat last-N window.** `recentTurnHistory(sessionId,
  NARRATIVE_HISTORY_TURNS)` (`pipeline.ts:579`, def `:851-864`, `NARRATIVE_HISTORY_TURNS
  = 6`) selects the last 6 ready turns by number with no presence/location scoping,
  pushed verbatim as alternating user/assistant messages (`pipeline.ts:813-817`).
  Episode recall (`retrieveEpisodes`) is pure global cosine with a recency-window
  exclusion (`EPISODE_WINDOW = 4`), not scoped by roster or location — the crux of
  idea #7.
- **A pre-narrator model hop now exists.** `runIntake` (`intake.ts:28-61`) makes a
  real `generateChecked<IntentBrief>` call in the pre-turn `Promise.all`
  (`pipeline.ts` ~549-583), concurrent with retrieval and before narration. It
  falls back to regex `detectIntent` on timeout/demo/disable (and in practice
  regex-falls-back on most turns today). The `IntentBrief` it emits
  (`src/contracts/turns/intent-brief.ts`) already carries action-type/sense
  targets — a natural input-side seam for idea #1's presence signal.

## Idea-by-idea impressions

### 1. Measured fact-relevance policy (floor OR present OR query-named) — agree, reframe

The right shape: a fact is included if **any** of —
- similarity ≥ a configurable floor (new — facts have none today), **or**
- its `subjectId` is in the present roster / addressed this turn, **or**
- a memory query explicitly names the subject.

This is the highest-leverage cheap win: a floor stops the unconditional top-5
from injecting noise, while the present/named escape hatches stop a floor from
silently dropping the facts that matter most (the person you're talking to).
The present-roster signal is already in scope — the pipeline computes `present`
and even builds a `SceneContext` with `presentCharacterIds` at
`pipeline.ts:567-575` — and `subjectId` grounding already exists on the fact row
(`schema.ts:490`, written at `facts.ts:154`), so "is this fact's subject present"
is a cheap join, no new embedding. **One wiring caveat surfaced by the
re-grounding:** `subjectId` is currently *write-only* — `retrieveFacts` neither
selects nor returns it (`FactHit` carries only `id/kind/subjectName/text/score`,
`facts.ts:21-27`), so surfacing `subjectId` out of retrieval is part of this
idea's work, not a freebie. Note also the inclusion channel is **three strands**
(facts + `characterNotes` + recalled episodes), so the floor logic must decide
how it interacts with the episode strand and the ≤8 cap, not just facts in
isolation.

The user's sub-note — `isPresent` should drive *many* prompt injections, and
non-present NPCs act via a **separate async, non-turn-blocking pipeline** —
belongs with [pre-narrator-agents.spec.md](pre-narrator-agents.spec.md)
and [offscreen-simulation-spec.phase3.md](finished/offscreen-simulation-spec.phase3.md),
not the retrieval layer. Keep this idea scoped to "presence as a retrieval/inclusion
signal"; the offscreen-agent pipeline is its own track.

- **Size:** small–medium. **Depends on:** #6 (to tune the floor without vibes).
- **Open question:** does "subject present" override the floor entirely, or just
  lower it? Hard override risks pulling stale facts about a present NPC.

### 2. Per-query embedding + fusion + provenance logging — strong agree, **re-scoped (plumbing exists)**

Embed each query separately, retrieve per query, fuse with RRF (or max-score),
and **log which source query produced each hit**. This is textbook and directly
attacks the "one query dominates everything" failure of the concatenated blob.

Cost worry is smaller than it looks: `embedTexts` batches the whole array into
**one** `embedMany` API call regardless of count (`src/server/ai/embeddings.ts:20-31`),
so per-query embedding is genuinely one API call for N queries — the only added
cost is N vector searches per leg instead of one, cheap at our k. RRF is the safer
fusion choice (scale-free across legs; max-score needs comparable distributions).

**Re-scope from the re-grounding:** the provenance substrate the first draft
called net-new is already built. Each leg already writes a `"retrieval"` event with
`query` + `candidates[{id, …, score}]` (`episodes.ts:149-156`, `facts.ts:229-233`,
`lore.ts:265-273`); the admin inspect route reads them in the turn window
(`src/app/api/sessions/[id]/turns/[turnId]/inspect/route.ts:39-69`) and the
Inspector tab renders a "Retrieval" section (`inspector-tab.tsx:295-315`). What
this idea actually still needs:
1. **Split the blob** into per-query embeds and retrieve per query.
2. **Fuse** with RRF across the per-query hit lists (per-leg — see open question).
3. **Per-source attribution** — change the logged `query` from the concatenated
   `slice(0,300)` blob to the individual source query per hit (today's logs can't
   answer "which query produced this hit").
4. **Surface `candidates[]` in the Inspector** — the backend already forwards the
   array, but `retrievalEventSchema` (`inspector-tab.tsx:31-51`) only parses a
   single scalar `score`, so per-candidate scores are persisted + shipped but not
   rendered.

The "end goal" clause — facts carrying *who created them / who they pertain to* —
is really idea #5 (witnessedBy + subjectId surfaced to retrieval), tracked there.

- **Size:** medium, self-contained (smaller now that logging exists). **Pairs
  with:** #1, measured by #6.
- **Open question:** RRF `k` constant, and whether fusion is per-leg or across
  legs (I lean per-leg — episodes/facts/lore stay separate channels downstream).

### 3. Centralize lore gating — agree, do first (wider surface, cheaper fix)

Pure drift-removal, **still real today**. `pipeline.ts:825-837` reimplements
`isUnlocked` / `sceneChunkMatches`, and the prompt-assembly site
(`pipeline.ts:664-678`) inlines the `always`/`scene` selection logic too —
`lore.ts` already exports the canonical versions (`isChunkUnlocked` `:81`,
`selectAlwaysChunks` `:86`, `selectSceneChunks` `:97`). This is exactly the "don't
recreate utilities" rule (CLAUDE.md / jscpd) caught after the fact. The drift
surface is **wider** than the first draft named (the inlined selectors, not just
the two helpers), but the fix is **cheaper**: the pipeline already constructs the
exact `SceneContext` (`{ locationTags, presentCharacterIds }`) at
`pipeline.ts:567-575` to feed `preTurnRetrieve` — so centralizing is "reuse that
same `sceneCtx` shape at the prompt-assembly site, call
`selectAlwaysChunks`/`selectSceneChunks`/`isChunkUnlocked` directly, and delete the
two local helpers." `retrieval.ts` (`retrieveLoreLeg`) already sets the precedent
by consuming `eligibleRetrievalChunks` with a real `SceneContext`.

- **Size:** small. **Risk:** low. **Do early** — clears the deck for #1/#2 which
  also touch scene/presence gating. (`matchesScene` is private to `lore.ts`; expose
  via the selectors, don't export it.)

### 4. Prefer `subjectId` over `subjectName` in supersedence — agree (unchanged)

`supersedes()` (`facts.ts:38-43`, unchanged location) gates on normalized name +
`score >= SUPERSEDE_MIN_SCORE` (0.86). The insert already stores both `subjectId`
(`facts.ts:154`) and `subjectName` (`facts.ts:155`); the supersedence candidate SQL
(`facts.ts:127-143`) selects `id/subjectName/score` and **ignores** `subjectId`.
Fix: when **both** draft and candidate are grounded, require `subjectId` equality
and skip the name check; fall back to normalized-name only when a subject is
unresolved. Correct, and it defuses the alias / rename / duplicate-name fragility
the idea calls out.

- **Size:** medium (touches `supersedes()` and ideally the candidate SQL — prefer
  filtering candidates by `subjectId` when present). **Independent** of the rest.
- **Open questions:** asymmetry when one side is grounded and the other isn't
  (treat as name-only?); and does a rename event need to *re-ground* historical
  facts, or only affect facts going forward? The latter is simpler; the former
  is a migration.

### 5. Consume the richer metadata (witness-gating + canon channel) — agree, but it's phase 6 (one correction)

This is the biggest semantic leap *and* it already has a home:
[character-memory-spec.phase3.md](finished/character-memory-spec.phase3.md) → phase 6
(knowledge ledger / `fact_knowers`, per-character episodes). The re-grounding
confirms phase 6 has **not started** — no `fact_knowers` / `character_episodes`
tables in `schema.ts` or any migration, and it's not on the roadmap. Two
retrieval-layer hooks to keep in view so #1/#2 don't paint us into a corner:
- **Witness-gated retrieval:** an NPC should not retrieve facts it never
  witnessed — i.e. filter the facts leg by `witnessedBy ∋ perceiver`. `witnessedBy`
  has live data today (it's written truthfully), so this hook has something to gate
  on.
- **Canon channel separation:** `canon = false` (belief/lie) facts must stay out
  of the narrator's *truth* channel unless the mode asks for them. **Correction
  from the re-grounding:** no fact-creation path writes `canon = false` yet — it's
  a dormant always-true column. So this hook has **no producer of belief/lie facts
  to gate against** until the write-side (told-lie / belief facts) lands, presumably
  with phase 6. Don't build the canon gate before there's canon-false data.

I'd **not** re-plan the ledger here — just note that #2's provenance logging and
#1's presence signal are the natural on-ramps, and defer the consumer to phase 6.

### 6. Retrieval evaluation harness — strong agree, arguably do first (still greenfield)

Without this, every threshold/fusion change in #1, #2, #4 is "vibes in a trench
coat" (the idea's own phrase, and it's right). The re-grounding confirms **no
retrieval eval harness exists** — no precision@k / recall@k, no score-distribution
code, no `*.fixture.json` anywhere (the `scripts/eval/`, `data/eval/`,
`docs/scene-image-eval/` dirs are scene-**image** eval, unrelated). Existing
memory tests cover *gating correctness* and *degradation* only: `retrieval.test.ts`
is orchestration with mocked legs (no ranking assertions); `memory.int.test.ts`
does real-pgvector recall but every "ranking" check is a trivial self-match (query
== stored text → `score > 0.99`), no multi-candidate ordering, no distractor
corpus, no recall measurement. So #6 is **additive**, not duplicative. Golden
scenarios: "episode 3 must rank top-2 for query X", "secret lore absent until
unlock", "irrelevant fact below floor", "aliased subject supersedes". Track
precision@k / recall@k / score distributions.

The one real design problem persists: **determinism.** The demo `pseudo` embedder
is still an FNV-1a hash (`src/server/ai/embeddings.ts:43-54`) — it gives no
meaningful semantic ranking (`facts.test.ts` only asserts identical→1, unrelated
`<0.3`, never related>unrelated), so golden tests can't use it. The clean answer
is to **snapshot real embedding vectors** for a small curated corpus + query set
as frozen fixtures, then run the ranking math offline (no API call in CI). That
keeps tests deterministic and fast. Caveat from embedder isolation: fixtures are
bound to one embedding model and must be re-snapshotted when it changes —
acceptable, and the snapshot job is small. The harness should also exercise the
adjacent knobs (`FACT_MIN_CONFIDENCE`, the `*_RETRIEVAL_LIMIT`s), not just the
score floors.

- **Size:** medium–high (fixture tooling + the math), highest leverage.
- **Open question:** corpus size and where fixtures live — `*.fixture.json` next
  to `memory.int.test.ts`, gated like other integration assets.

### 7. RAG as a replacement for flat history/summarization — north star; **the binding constraint dissolved**

The vision: stop sending "last n turns" flat (still exactly what
`recentTurnHistory` does, `pipeline.ts:579/851-864`, `NARRATIVE_HISTORY_TURNS = 6`);
procedurally compose history scoped to who's present, the situation, and
location/adjacent locations. Agree with the direction. **The first draft's binding
constraint is now stale:**

> ~~No LLM call before narration today~~ — **reversed 2026-06-14.** A pre-narrator
> intake agent (`intake.ts:runIntake`) shipped 2026-06-18 and runs a real model
> call in the pre-turn fan-out before narration (followups.phase2 #15/16;
> [pre-narrator-agents.followups.md](pre-narrator-agents.followups.md), status
> *implemented — 2026-06-18*).

So a pre-narration model hop **already exists** (latency-hidden, degrading to regex
on timeout). That doesn't mandate a synthesized digest, but it removes the hard
blocker the first draft hung step 3 on. Concrete first steps:
1. **Scope the episode-recall leg by present roster and location adjacency**
   (cheap, non-LLM). The proximity graph exists and is pure/reusable —
   `isAdjacent` (`merge.ts:357`), `passableNeighbors` BFS (`movement.ts:46-71`),
   and the adjacency set in `buildPresenceRoster` (`scene.ts:331-344`) — **but it
   lives in `engine/` and is not imported into `src/server/memory/`**, so step 1
   requires threading `location`/`links` into the retrieval call signature (today
   retrieval only receives `sceneCtx`, consumed by lore eligibility alone). Step 1
   is the tractable extension of #1's presence work.
2. **Per-character episode windows** (a phase-6 dependency — overlaps #5).
3. **A synthesized "scene digest"** — now *possible* via the existing pre-narrator
   slot rather than blocked, but still a deliberate cost/latency decision, and
   gated on the intake agent actually landing reliably (it regex-falls-back on most
   turns today).

- **Size:** large, multi-phase. **Treat as research direction**, not near-term.
  Step 1 rides on #1's presence work + threading the proximity graph into
  retrieval; the rest waits on phase 6 and the intake agent stabilizing.

## Suggested sequencing

| Order | Idea | Why here |
| --- | --- | --- |
| 1 | **#3** centralize lore gating | cheap, removes drift, clears scene/presence code before #1/#2 touch it; pipeline already builds the `SceneContext` |
| 2 | **#6** eval harness | foundation — makes #1/#2/#4 measurable instead of vibes; can build in parallel |
| 3 | **#2** per-query + RRF + provenance | high value, self-contained; provenance plumbing already exists, so re-scoped to split + fuse + per-query attribution |
| 4 | **#1** measured fact relevance (+ presence) | floor + present/named escape hatches; tuned via #6; surfacing `subjectId` from retrieval is part of the work |
| 5 | **#4** subjectId supersedence | independent correctness fix |
| 6 | **#5** witness-gating + canon channel | retrieval hooks only; consumer owned by phase 6 (not started); canon gate waits on a canon-false producer |
| 7 | **#7** RAG-as-history | north star; step 1 rides on #1 + threading the proximity graph into retrieval; rest gated on phase 6 |

## Cross-references / where things already live

- [memory.md](../memory.md) — current behaviour and all tuning thresholds.
- [character-memory-spec.phase3.md](finished/character-memory-spec.phase3.md) — knowledge
  ledger / per-character memory (owns idea #5's consumer, phase 6 — not started).
- [pre-narrator-agents.spec.md](pre-narrator-agents.spec.md) +
  [pre-narrator-agents.followups.md](pre-narrator-agents.followups.md) — the
  pre-narrator intake agent that shipped 2026-06-18 (dissolves #7's old
  constraint), and [offscreen-simulation-spec.phase3.md](finished/offscreen-simulation-spec.phase3.md) —
  the async non-present-NPC pipeline from idea #1's sub-note.
- [perception.md](../perception.md) — how `witnessedBy` (attention × salience) is
  computed; the gate idea #5 would consume.
- `src/contracts/turns/intent-brief.ts` — the `IntentBrief` the intake agent emits;
  an input-side seam for #1's presence signal and #7's scoping.

## Open questions (restated for scanning)

- **#1** — does "subject present" hard-override the floor, or just lower it? And
  how does the floor interact with the episode strand sharing the ≤8 channel?
- **#2** — RRF `k`; fusion per-leg vs across legs.
- **#4** — grounded/unresolved asymmetry; do renames re-ground historical facts?
- **#6** — frozen real-vector fixtures: corpus size and location; re-snapshot on
  embedding-model change.
- **#7** — ~~do we revisit the "no pre-narration LLM" decision~~ (answered — it was
  reversed and an intake agent shipped); the live question is now: do we spend the
  existing pre-narrator slot on a synthesized scene digest, or keep history
  assembly strictly non-LLM (filter/rank/scope existing episode summaries)?
