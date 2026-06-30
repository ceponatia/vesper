# Character chat as a primary feature — plan

Status: **draft** (not settled — the memory-keying decision below gates the whole
arc; no code yet). High priority once that decision lands.

This plan is the task list and build order; the settled mechanics will be promoted to
`character-chat-primary.spec.md` once the load-bearing memory-keying question (Open
questions) is decided — until then design detail lives here. Builds on everything the
character-chat family already shipped — the sessionless 1-on-1
([finished/character-chat.plan.md](finished/character-chat.plan.md)), the rolling
summary ([finished/character-chat-summary.plan.md](finished/character-chat-summary.plan.md)),
the light state ([finished/character-chat-state.plan.md](finished/character-chat-state.plan.md)),
and the scenario setup ([finished/character-chat-scenario.plan.md](finished/character-chat-scenario.plan.md)).
Sibling: [character-chat-state-narration.plan.md](character-chat-state-narration.plan.md)
(the fast prompt-layer slice — it ships first and is partly a prerequisite for the
"state visibly drives behavior" payoff this arc completes).

## Goal

Character chat began as a voice-tuning testbed and has grown into an enjoyable light
experience in its own right. Promote it to a **primary feature** that functions much
like the session lane — but for a **single character, with no location entities**
(location conveyed **solely through narration**). Concretely it should gain:

- **RAG long-term memory** layered on top of its existing short-term memory (the
  ~40-turn verbatim window + rolling prose summary): an embedded fact/episode store so
  the character remembers across the summary horizon, retrieved into each turn.
- **Mutable attribute + fuller state tracking** — the character's attributes and state
  can actually evolve over a long chat (the session does this via the simulant →
  `phaseAttributes` overlay merge; chat today resolves attributes statically).
- An **expanded dev debug modal** covering these additions (the State-tools modal is
  the seed; chat has no memory/agent inspector today).

This is the natural graduation of two deliberate stopgaps: the rolling summary was
framed as "the non-RAG stopgap until episodes/RAG land" (summary plan), and the light
state was framed as the affinity/meter/condition slice of a fuller merge.

## Background — session has it, chat lacks it

The session turn pipeline (`engine/pipeline.ts`) is: a pre-narrator **intake** agent +
a parallel **retrieval** fan-out (episodes + facts + lore) → narrate → a post-turn
**agent fan-out** (simulant ‖ archivist ‖ continuity ‖ director) → a **merge**
transaction (`engine/merge/`). Memory lives in `src/server/memory/` — `episodes` (one
embedded summary per turn + cosine recall), `facts` (declarative `FactDraft[]` with
supersedence), `lore` (world-keyed) — all in one 1536-dim pgvector space filtered by
`currentEmbedder()`.

Character chat (`engine/character-chat.ts` + route `app/api/characters/[id]/chat/route.ts`)
is deliberately thin: a flat verbatim window, a rolling summary, and the light-state
row + post-exchange **pulse** (`chat-state.ts` `runChatPulse`, which already mirrors the
session's affinity/meter/condition slice and refreshes the `mindNote`). It has **no**
retrieval, no episodes, no semantic facts, no attribute overlays, and no pre-narrator
intake.

The parity gap to close (locations intentionally excluded):

| Subsystem | Session | Chat today | This plan |
| --- | --- | --- | --- |
| RAG retrieval | `preTurnRetrieve` (episodes+facts+lore) → 8-item facts channel | none | adopt `retrieveFacts` + `retrieveEpisodes` keyed on a chat identity; lore dropped (no world) |
| Episodic memory | `appendEpisode` per turn + cosine recall | single rolling summary | per-exchange episode write + recall |
| Semantic facts | archivist `FactDraft[]` → `addFacts` (+supersede) | `mindNote` only | archivist-style extraction → `addFacts` |
| Mutable attributes | simulant `attributeChanges` → `phaseAttributes` overlays (inherent-trait guard) | static `resolveAttributes(…, [])` | a chat attribute-overlay + change proposer reusing the overlay mechanism + `overlaySourceMayChange` guard |
| Pre-narrator intake | `runIntake` → `IntentBrief` | none | optional intake-lite for response shape / memory queries |
| Post-turn fan-out | 4 agents | 1 pulse | extend the pulse (or add a leg) to also emit facts + episode + memory queries |

## The load-bearing blocker

`facts.sessionId` and `episodes.sessionId` are **`NOT NULL` FKs to `sessions`** (cascade
delete). The `character_chat_*` tables are instead keyed `(ownerId, characterId)`. So
chat cannot get archivist facts + episodic RAG without resolving how its memory is keyed.
Everything else is already structured for reuse: `addFacts` runs outside the turn
pipeline today (`engine/inner-note.ts` is the proof — it only needs a `sessionId`),
supersedence and embedder-isolation are generic, and the attribute-overlay merge is a
pure function over `(snapshot, overlays)`.

## Build order (gated on the keying decision)

1. **Decide + implement chat memory keying** (Open question #1). Either mint a **synthetic
   per-(owner, character) `sessions` row** (zero schema change to `facts`/`episodes`; chat
   reuses the entire memory API as-is) or **widen `facts`/`episodes`** to a nullable session
   + `characterId` key (cleaner model, a migration + every retrieval/supersede query updated).
   This choice colors slices 2–3.
2. **RAG long-term memory.** Write a per-exchange episode (`appendEpisode`) and extract
   durable facts (`addFacts`) from the finished exchange — fold into the post-turn pulse
   (`finalizeChatState`, which already has the exchange + does structured extraction) or add
   a small archivist leg beside it. Produce **memory queries** (fold into the pulse, mirroring
   the director's `memoryQueries`) and inject `retrieveFacts` + `retrieveEpisodes` hits as a
   new prompt block in `buildCharacterChatSystemPrompt` (parallel to the existing summary
   recap). The rolling summary becomes the short-term layer beneath RAG, not a replacement.
3. **Mutable attribute + fuller state tracking.** Add a chat attribute-overlay (a column on
   `character_chat_state` or overlays derived from conditions) and a change proposer
   (extend the pulse, or a simulant-lite) that applies overlays via `resolveAttributes`
   with the **inherent-trait guard** (`overlaySourceMayChange(def.mutability, "narrative")`)
   so eye colour / species / gender can never be rewritten. Converge the meters/affinity/
   conditions the light state already tracks into this one evolving picture.
4. **(Optional) pre-narrator intake-lite.** A chat `IntentBrief`-lite to steer response shape
   and seed memory queries. Overlaps the state-narration plan's one-turn intent classifier —
   build once, shared.
5. **Expanded dev debug modal.** Grow `chat-state-tools.tsx` into a real chat inspector:
   retrieved facts/episodes for the turn, the last extraction (new facts + episode summary),
   the live attribute overlays, and the pulse/agent trace. Graduates the summary plan's parked
   "no dev-inspector surface for chat diagnostics."
6. **Docs + tests.** `../ui.md` (Chat tab grows a memory/inspector surface), `../prompts.md`
   (chat lane gains a retrieval block + intake), `../memory.md` (chat as a second memory
   client; embedder isolation still holds), `../database.md` (new columns/keys). Integration
   tests for the keying choice + retrieval; degradation tests (a failed retrieval/extraction
   leg degrades to the summary+window path with a diagnostic, never a failed reply).

## Open questions

- **#1 — chat memory keying (the blocker).** Synthetic `sessions` row per (owner, character)
  — *recommended* for a first cut: zero change to the battle-tested memory schema/queries, chat
  just supplies a stable session id — **vs.** widening `facts`/`episodes` to nullable-session +
  `characterId` (cleaner long-term, bigger migration + touches every retrieval/supersede filter).
  Settling this is the precondition for promoting a spec.
- **#2 — one post-turn agent or a fan-out?** Extend the single cheap pulse to also emit
  facts/episode/queries (cheaper, one call) vs. a real archivist/director-lite fan-out (closer
  to session quality, more latency/cost). The pulse runs *after* the reply flushes, so added
  latency is hidden — argues for keeping it one call initially.
- **#3 — attribute change source.** Reuse the simulant schema (`attributeChanges`) and prompt,
  or a chat-specific lighter proposer? Reuse keeps one mutability contract.
- **#4 — memory lifecycle vs. the Reset scopes.** Chat already has all/chat/state resets; RAG
  facts/episodes need a documented place in that matrix (which reset clears memory?).
- **#5 — does the rolling summary stay, fold into episodes, or both?** Summary plan anticipated
  it "becomes a column on state" when state landed; with RAG it may become redundant or remain
  the cheap short-term layer.

## Not in scope (this plan)

- **Location entities, presence, movement, items, wardrobe-as-state, world lore, story threads** —
  permanently out: chat is one character, location via narration only.
- The pure **state→narration enactment** (rendering the state the character already has) — that
  is [character-chat-state-narration.plan.md](character-chat-state-narration.plan.md), which
  ships first and independently.

## Related

- Prior shipped slices: [finished/character-chat.plan.md](finished/character-chat.plan.md),
  [finished/character-chat-summary.plan.md](finished/character-chat-summary.plan.md),
  [finished/character-chat-state.plan.md](finished/character-chat-state.plan.md) ·
  [character-chat-state.spec.md](finished/character-chat-state.spec.md),
  [finished/character-chat-scenario.plan.md](finished/character-chat-scenario.plan.md).
- Session-side references to adapt: `engine/pipeline.ts` (`assemblePreTurn`, post-turn job),
  `engine/agents.ts` (`runPostTurnAgents`), `src/server/memory/{retrieval,facts,episodes}.ts`,
  `engine/merge/phases/attributes.ts`, and `engine/inner-note.ts` (the template for running
  `addFacts` outside a turn). Memory system doc: [../memory.md](../memory.md).
- Sibling: [character-chat-state-narration.plan.md](character-chat-state-narration.plan.md).
- Cross-ref: [RAG-improvements.plan.md](RAG-improvements.plan.md) (retrieval-quality work that
  would benefit chat memory once it exists).
