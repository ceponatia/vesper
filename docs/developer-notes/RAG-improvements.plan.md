# RAG improvements — plan

Status: **draft** — initial impressions on the seven RAG ideas in
[user-guidance/ideas.md](user-guidance/ideas.md) §RAG. Nothing here is settled;
this doc captures where each idea touches the code, whether I agree, rough size,
dependencies, and the open questions to resolve before any of it becomes a spec.

Source of truth for current behaviour: [memory.md](../memory.md). Code lives in
`src/server/memory/` (retrieval legs, lore gating, facts) and
`src/server/engine/pipeline.ts` (prompt assembly).

## Where the system actually is today

A grounding pass, because two of the seven ideas are framed slightly off from
the current code:

- **Retrieval is a single concatenated query.** `preTurnRetrieve`
  (`retrieval.ts:37`) joins `brief.memoryQueries + player input` with `\n` into
  one `queryText`, then fans out to three independent legs (episodes / facts /
  lore), each embedding that one string once. No per-query embedding, no fusion.
- **Facts have *no* relevance floor.** Episodes gate at 0.55 and lore at 0.72
  (`constants.ts`), but `retrieveFacts` returns the top 5 active facts
  *unconditionally* — there is no minimum score. So idea #1's "blunt universal
  threshold" is, for facts specifically, the opposite problem: there's no floor
  at all, which is exactly why "random semantic neighbors" leak in. The merger
  then squeezes facts + director `characterNotes` into a single deduped ≤8-item
  channel.
- **No presence/witness gating in retrieval.** `witnessedBy` and `canon` are
  written truthfully every turn but read by nobody — the knowledge-ledger
  consumer is phase 6 ([character-memory-spec.phase3.md](character-memory-spec.phase3.md)).
- **Lore gating is duplicated.** `lore.ts` owns the canonical helpers
  (`isChunkUnlocked`, `selectSceneChunks`, `eligibleRetrievalChunks`,
  `matchesScene`), but `pipeline.ts:732-744` carries its own local `isUnlocked`
  and `sceneChunkMatches` for prompt assembly — a real drift risk (idea #3).

## Idea-by-idea impressions

### 1. Measured fact-relevance policy (floor OR present OR query-named) — agree, reframe

The right shape: a fact is included if **any** of —
- similarity ≥ a configurable floor (new — facts have none today), **or**
- its `subjectId` is in the present roster / addressed this turn, **or**
- a memory query explicitly names the subject.

This is the highest-leverage cheap win: a floor stops the unconditional top-5
from injecting noise, while the present/named escape hatches stop a floor from
silently dropping the facts that matter most (the person you're talking to).
The present-roster signal is already in scope at prompt-assembly time (the
pipeline knows `present` — see `sceneChunkMatches`), and `subjectId` grounding
already exists on the fact row, so "is this fact's subject present" is a cheap
join, no new embedding.

The user's sub-note — `isPresent` should drive *many* prompt injections, and
non-present NPCs act via a **separate async, non-turn-blocking pipeline** —
belongs with [pre-narrator-agents.spec.md](pre-narrator-agents.spec.md)
and [offscreen-simulation-spec.phase3.md](offscreen-simulation-spec.phase3.md),
not the retrieval layer. Keep this idea scoped to "presence as a retrieval/inclusion
signal"; the offscreen-agent pipeline is its own track.

- **Size:** small–medium. **Depends on:** #6 (to tune the floor without vibes).
- **Open question:** does "subject present" override the floor entirely, or just
  lower it? Hard override risks pulling stale facts about a present NPC.

### 2. Per-query embedding + fusion + provenance logging — strong agree

Embed each query separately, retrieve per query, fuse with RRF (or max-score),
and **log which source query produced each hit**. This is textbook and directly
attacks the "one query dominates everything" failure of the concatenated blob.

Cost worry is smaller than it looks: `embedMany` batches all queries into **one
API call** regardless of count (`embeddings.ts`), so the only added cost is N
vector searches per leg instead of one — cheap at our k. RRF is the safer fusion
choice (scale-free across legs; max-score needs comparable distributions).

The provenance log feeds straight into the Turn Inspector (`events` rows already
carry query/candidates/scores) and is what makes #6 tractable. The "end goal"
clause — facts carrying *who created them / who they pertain to* — is really
idea #5 (witnessedBy + subjectId surfaced to retrieval), tracked there.

- **Size:** medium, self-contained. **Pairs with:** #1, measured by #6.
- **Open question:** RRF `k` constant, and whether fusion is per-leg or across
  legs (I lean per-leg — episodes/facts/lore stay separate channels downstream).

### 3. Centralize lore gating — agree, do first

Pure drift-removal. `pipeline.ts:732-744` reimplements `isUnlocked` /
`sceneChunkMatches`; `lore.ts` already exports the canonical versions. This is
exactly the "don't recreate utilities" rule (CLAUDE.md / jscpd) caught after the
fact. The one wrinkle: the pipeline helper keys on `(activeLocationName, present
roster)` while `lore.ts:matchesScene` keys on a `SceneContext` — so it's not a
literal copy-paste; centralizing means giving `lore.ts` one helper that both
call sites can feed, or adapting the pipeline's inputs into a `SceneContext`.

- **Size:** small. **Risk:** low. **Do early** — clears the deck for #1/#2 which
  also touch scene/presence gating.

### 4. Prefer `subjectId` over `subjectName` in supersedence — agree

`supersedes()` (`facts.ts:38`) gates on normalized name + score. The insert
already stores both `subjectId` and `subjectName`. Fix: when **both** draft and
candidate are grounded, require `subjectId` equality and skip the name check;
fall back to normalized-name only when a subject is unresolved. Correct, and it
defuses the alias / rename / duplicate-name fragility the idea calls out.

- **Size:** medium (touches `supersedes()` and ideally the candidate SQL — prefer
  filtering candidates by `subjectId` when present). **Independent** of the rest.
- **Open questions:** asymmetry when one side is grounded and the other isn't
  (treat as name-only?); and does a rename event need to *re-ground* historical
  facts, or only affect facts going forward? The latter is simpler; the former
  is a migration.

### 5. Consume the richer metadata (witness-gating + canon channel) — agree, but it's phase 6

This is the biggest semantic leap *and* it already has a home:
[character-memory-spec.phase3.md](character-memory-spec.phase3.md) → phase 6
(knowledge ledger / `fact_knowers`, per-character episodes). Two retrieval-layer
hooks to keep in view so #1/#2 don't paint us into a corner:
- **Witness-gated retrieval:** an NPC should not retrieve facts it never
  witnessed — i.e. filter the facts leg by `witnessedBy ∋ perceiver`.
- **Canon channel separation:** `canon = false` (belief/lie) facts must stay out
  of the narrator's *truth* channel unless the mode asks for them.

I'd **not** re-plan the ledger here — just note that #2's provenance logging and
#1's presence signal are the natural on-ramps, and defer the consumer to phase 6.

### 6. Retrieval evaluation harness — strong agree, arguably do first

Without this, every threshold/fusion change in #1, #2, #4 is "vibes in a trench
coat" (the idea's own phrase, and it's right). Golden scenarios: "episode 3 must
rank top-2 for query X", "secret lore absent until unlock", "irrelevant fact
below floor", "aliased subject supersedes". Track precision@k / recall@k / score
distributions.

The one real design problem: **determinism.** The demo `pseudo` embedder is a
hash — it gives no meaningful semantic ranking, so golden tests can't use it.
The clean answer is to **snapshot real embedding vectors** for a small curated
corpus + query set as frozen fixtures, then run the ranking math offline (no API
call in CI). That keeps tests deterministic and fast. Caveat from embedder
isolation: fixtures are bound to one `EMBEDDING_MODEL` and must be re-snapshotted
when it changes — acceptable, and the snapshot job is small.

- **Size:** medium–high (fixture tooling + the math), highest leverage.
- **Open question:** corpus size and where fixtures live — `*.fixture.json` next
  to `memory.int.test.ts`, gated like other integration assets.

### 7. RAG as a replacement for flat history/summarization — north star, with a hard constraint

The vision: stop sending "last n turns" flat; procedurally compose history
scoped to who's present, the situation, and location/adjacent locations. Agree
with the direction, but flag the binding constraint up front:

> **No LLM call before narration today** — the pre-turn agent was considered and
> deliberately passed over (followups.phase2 #15/16; see the turn-pipeline memo).

So "procedurally *create* conversation history" must mean **cheap non-LLM
assembly** — filtering/ranking/scoping the episode summaries we already have by
presence + location adjacency — *not* generating a synthesized digest with a
model, unless we revisit that decision explicitly. Concrete first steps that
respect the constraint:
1. Scope the episode-recall leg by present roster and location adjacency (reuse
   the proximity graph) instead of pure global similarity.
2. Per-character episode windows (a phase-6 dependency — overlaps #5).
3. Only *then* consider a synthesized "scene digest", and only if we accept a
   pre-narration model hop.

- **Size:** large, multi-phase. **Treat as research direction**, not near-term.
  Steps 1 is a tractable extension of #1's presence work; the rest waits on
  phase 6 and a pipeline-shape decision.

## Suggested sequencing

| Order | Idea | Why here |
| --- | --- | --- |
| 1 | **#3** centralize lore gating | cheap, removes drift, clears scene/presence code before #1/#2 touch it |
| 2 | **#6** eval harness | foundation — makes #1/#2/#4 measurable instead of vibes; can build in parallel |
| 3 | **#2** per-query + RRF + provenance | high value, self-contained, validated by #6 |
| 4 | **#1** measured fact relevance (+ presence) | floor + present/named escape hatches; tuned via #6 |
| 5 | **#4** subjectId supersedence | independent correctness fix |
| 6 | **#5** witness-gating + canon channel | retrieval hooks only; consumer owned by phase 6 |
| 7 | **#7** RAG-as-history | north star; step 1 rides on #1, rest gated on phase 6 + pipeline-shape call |

## Cross-references / where things already live

- [memory.md](../memory.md) — current behaviour and all tuning thresholds.
- [character-memory-spec.phase3.md](character-memory-spec.phase3.md) — knowledge
  ledger / per-character memory (owns idea #5's consumer, phase 6).
- [pre-narrator-agents.spec.md](pre-narrator-agents.spec.md) and
  [offscreen-simulation-spec.phase3.md](offscreen-simulation-spec.phase3.md) —
  the async non-present-NPC pipeline from idea #1's sub-note.
- [perception.md](../perception.md) — how `witnessedBy` (attention × salience) is
  computed; the gate idea #5 would consume.

## Open questions (restated for scanning)

- **#1** — does "subject present" hard-override the floor, or just lower it?
- **#2** — RRF `k`; fusion per-leg vs across legs.
- **#4** — grounded/unresolved asymmetry; do renames re-ground historical facts?
- **#6** — frozen real-vector fixtures: corpus size and location; re-snapshot on
  `EMBEDDING_MODEL` change.
- **#7** — do we revisit the "no pre-narration LLM" decision to allow a
  synthesized scene digest, or stay strictly non-LLM assembly?
