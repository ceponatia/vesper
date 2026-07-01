# Character chat as a primary feature — plan

Status: **next** (settled — all five open questions resolved; high priority, no code yet).

Design/decisions: [character-chat-primary.spec.md](character-chat-primary.spec.md) — read
it first; it is the truth (the resolved decisions D1–D5, the load-bearing keying design, the
memory-scope union, the fan-out shape). This plan is the task list and build order. Builds on
everything the character-chat family already shipped — the sessionless 1-on-1
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

| Subsystem           | Session                                                                         | Chat today                        | This plan                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------- |
| RAG retrieval       | `preTurnRetrieve` (episodes+facts+lore) → 8-item facts channel                  | none                              | adopt `retrieveFacts` + `retrieveEpisodes` keyed on a chat identity; lore dropped (no world)              |
| Episodic memory     | `appendEpisode` per turn + cosine recall                                        | single rolling summary            | per-exchange episode write + recall                                                                       |
| Semantic facts      | archivist `FactDraft[]` → `addFacts` (+supersede)                               | `mindNote` only                   | archivist-style extraction → `addFacts`                                                                   |
| Mutable attributes  | simulant `attributeChanges` → `phaseAttributes` overlays (inherent-trait guard) | static `resolveAttributes(…, [])` | a chat attribute-overlay + change proposer reusing the overlay mechanism + `overlaySourceMayChange` guard |
| Pre-narrator intake | `runIntake` → `IntentBrief`                                                     | none                              | optional intake-lite for response shape / memory queries                                                  |
| Post-turn fan-out   | 4 agents                                                                        | 1 pulse                           | extend the pulse (or add a leg) to also emit facts + episode + memory queries                             |

## The load-bearing decision (resolved — D1)

`facts.sessionId` and `episodes.sessionId` were **`NOT NULL` FKs to `sessions`** (cascade
delete), while the `character_chat_*` tables are keyed `(ownerId, characterId)` — so chat
could not get archivist facts + episodic RAG until its memory keying was settled. **Resolved
(D1): widen** `facts`/`episodes` to a nullable `sessionId` + a `(ownerId, characterId)` chat
key, threaded through a `MemoryScope` union — the full design is [spec §1](character-chat-primary.spec.md).
Everything else was already structured for reuse: `addFacts` runs outside the turn pipeline
today (`engine/inner-note.ts` is the proof — it uses `sourceTurnId = null`), supersedence and
embedder-isolation are generic, and the attribute-overlay merge is a pure function over
`(snapshot, overlays)`.

## Build order

1. **Chat memory keying — the widening (D1, spec §1).** Make `facts.sessionId` /
   `episodes.sessionId` **nullable**, add nullable `(ownerId, characterId)` columns + a
   "exactly one keying" `CHECK`, and thread a `MemoryScope` discriminated union through the
   memory API (`memoryScopeWhere` helper) so `addFacts` / `appendEpisode` / `retrieveFacts` /
   `retrieveEpisodes` / `recentEpisodes` / `deleteEpisodeForTurn` / `preTurnRetrieve` take a
   scope, and the session call-sites wrap `session.id` in `{ kind: "session", … }`. Migration
   via `db:generate` → review → `db:migrate`. This is the precondition for slice 2.
2. **RAG long-term memory.** Write a per-exchange episode (`appendEpisode`) and extract
   durable facts (`addFacts`, `sourceTurnId = null` — the `inner-note.ts` template) from the
   finished exchange via an **archivist-lite** leg, and produce **memory queries** (mirroring
   the director's `memoryQueries`) — run as a **parallel fan-out beside the state pulse in
   `finalizeChatState`** (D2, spec §2: `Promise.all`, degrade any leg to a diagnostic, fall
   back to folding into the single pulse only if a leg can't be parallelized). Inject
   `retrieveFacts` + `retrieveEpisodes` hits as a new prompt block in
   `buildCharacterChatSystemPrompt`. The rolling summary stays as the short-term layer beneath
   RAG (D5), not a replacement.
3. **Mutable attribute + fuller state tracking.** Add a persisted attribute-overlay column on
   `character_chat_state` (`AttributeValue[]`, `source:"narrative"`) passed as the second arg
   to `resolveAttributes` (today `[]`), and an **attribute proposer** leg emitting the reused
   simulant `attributeChanges` schema (D3, spec §3) applied through the **inherent-trait guard**
   (`overlaySourceMayChange(def.mutability, "narrative")`) so eye colour / species / gender can
   never be rewritten. Converge the meters/affinity/conditions the light state already tracks
   into this one evolving picture. (Expect eval-driven tuning of the schema/prompt — D3.)
4. **(Optional) pre-narrator intake-lite.** A chat `IntentBrief`-lite to steer response shape
   and seed memory queries. The state-narration plan already shipped `engine/chat-intent.ts`
   (regex-first `detectChatCue`) — extend that shared classifier rather than adding a new one.
5. **Consolidate reset → a single "Clear Chat" (D4, spec §4).** Collapse the shipped
   Reset All / Reset Chat / Reset State into one **"Clear Chat"** that wipes messages +
   summary + state **+ the new chat facts/episodes** (add a `deleteChatMemory` beside
   `deleteChatState`). Drop the `ChatResetScope` type + scope plumbing (`api.ts`, the DELETE
   route, `character-chat.tsx`'s three-button modal). Supersedes the finished light-state
   spec's three-scope matrix.
6. **Expanded dev debug modal.** Grow `chat-state-tools.tsx` into a real chat inspector:
   retrieved facts/episodes for the turn, the last extraction (new facts + episode summary),
   the live attribute overlays, and the pulse/agent trace. Graduates the summary plan's parked
   "no dev-inspector surface for chat diagnostics."
7. **Docs + tests.** `../ui.md` (Chat tab grows a memory/inspector surface), `../prompts.md`
   (chat lane gains a retrieval block + intake), `../memory.md` (chat as a second memory
   client; embedder isolation still holds), `../database.md` (nullable `sessionId` + the
   `(ownerId, characterId)` key on facts/episodes). Integration tests for the widened keying +
   scoped retrieval; degradation tests (a failed retrieval/extraction leg degrades to the
   summary+window path with a diagnostic, never a failed reply).

## Decisions

All five original open questions are resolved — the rulings (D1–D5) live in the spec's
**## Decisions** section ([character-chat-primary.spec.md](character-chat-primary.spec.md)).
In brief: **widen** `facts`/`episodes` to a nullable session + `(ownerId, characterId)` key
rather than a synthetic session row (D1, the load-bearing choice — spec §1); run the post-turn
memory work as a **parallel fan-out** beside the state pulse, single-pulse fallback (D2, §2);
**reuse the simulant `attributeChanges` schema** for the proposer, expecting eval-driven tuning
(D3, §3); collapse the three resets into **one "Clear Chat"** that clears everything, incl. the
new facts/episodes (D4, §4 — supersedes the light-state spec's reset matrix); and **keep the
rolling summary** as the short-term layer beneath RAG (D5, §5). The spec also lists four adopted
second-order defaults — flag any to revisit.

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
