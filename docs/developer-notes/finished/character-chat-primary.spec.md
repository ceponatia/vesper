# Character chat as a primary feature — spec (settled mechanics)

Status: **shipped — 2026-07-01** (all seven build slices; `pnpm verify` green). This is the
truth for the arc (the resolved decisions + the load-bearing keying design + a Completion
note at the foot recording two refinements taken during the build). The task list and build
order live in [character-chat-primary.plan.md](character-chat-primary.plan.md). All five of
the plan's original open questions are resolved — the rulings are **## Decisions** (D1–D5) below.

Builds on the shipped character-chat family — the sessionless 1-on-1, the rolling
summary, the light state, the scenario setup (all under `finished/`) and the just-shipped
[character-chat-state-narration](character-chat-state-narration.plan.md) (the prompt-layer
enactment slice). This arc adds the *memory + evolving-state* half.

## Decisions (the resolved open questions)

**D1 — chat memory keying: widen `facts`/`episodes` (the longer-term option).** Rather
than mint a synthetic per-`(owner, character)` `sessions` row, make `facts.sessionId` and
`episodes.sessionId` **nullable** and add a chat key — `(ownerId, characterId)`, mirroring
`character_chat_state`'s composite PK — with a "exactly one keying present" invariant.
The owner picked the cleaner long-term model over the zero-migration first cut; §1 is the
full design. _Rationale:_ the memory schema is the load-bearing shared asset — a real
second client keyed honestly beats a fake session that leaks `sessions`-shaped assumptions
(turn rows, cascade, edit-reconciliation) into a lane that has none.

**D2 — post-turn shape: parallel fan-out, single-pulse fallback.** Run the memory work
as a **parallel fan-out** (facts+episode extraction ‖ memory-query production ‖ attribute
proposer ‖ the existing state pulse), not one serial call — but **only** to the extent the
legs can run concurrently; if a leg can't be parallelized cleanly, fold it back into the
pulse. Because the whole fan-out runs **after the reply stream flushes** (`finalizeChatState`,
which only delays `controller.close()`), even the fallback is off the perceived hot path —
parallelizing just bounds the *background* wall-clock. See §2. _Note:_ the plan's earlier
"one call is cheaper, latency is hidden anyway" reasoning still holds as the fallback; the
owner's call is to prefer the higher-quality fan-out when parallelism is free.

**D3 — attribute change source: reuse the simulant `attributeChanges` schema.** The chat
attribute proposer emits the **same** shape the session simulant does
(`contracts/turns/agent-results.ts` L85–94: `{ participantName, attributeId, value, note? }[]`)
and applies it through the **same** inherent-trait guard
(`overlaySourceMayChange(def.mutability, "narrative")`, `merge/phases/attributes.ts` L45),
so there is **one** mutability contract across both lanes. §3. _Owner note (verbatim):_
"start with the existing schema for now… we plan to test this to determine if improvements
are needed" — so treat the schema/prompt reuse as v1, expect eval-driven tuning.

**D4 — memory lifecycle: one "Clear Chat" clears everything.** Collapse the shipped
three-scope reset (**Reset All / Reset Chat / Reset State**) into a **single "Clear Chat"**
button that wipes messages + summary + state **+ the new chat facts/episodes** (+ the scene
scrub). _Owner note (verbatim):_ "In testing, there's no benefit to clearing just chat or
just state." This **supersedes** the reset matrix in
[finished/character-chat-state.spec.md](finished/character-chat-state.spec.md) §5/§7 (a
deliberate simplification, not a regression). §4.

**D5 — rolling summary stays as the short-term reinforcement layer.** With RAG landing,
the rolling prose summary is **not** removed and **not** folded into episodes — it remains
the cheap short-term layer beneath RAG (verbatim window → rolling summary → RAG recall).
_Owner note:_ "Keep it… for now and we will test." Revisit only if evals show it is
redundant with episodic recall. §5.

## 1. Memory keying — the widening (D1)

### 1.1 Schema change

`facts` and `episodes` today are `NOT NULL` FKs to `sessions` with `ON DELETE CASCADE`
(`schema.ts` L720, L740). The change:

- `sessionId` → **nullable** (drop `.notNull()`; keep the FK + cascade for session rows).
- Add **`ownerId text → users.id`** and **`characterId text → characters.id` (ON DELETE
  CASCADE)**, both nullable, to each table — mirroring `character_chat_state`'s
  `(ownerId, characterId)` key so a shared character's chat memory is isolated per owner.
- **Invariant** (enforce with a DB `CHECK`, and assert in the write helpers): exactly one
  keying is set — `sessionId IS NOT NULL` **XOR** `characterId IS NOT NULL`.
- New composite indexes for the chat scope, paralleling the existing session ones
  (`facts_session_status_idx (sessionId,status)` L763, `episodes_session_idx
  (sessionId,turnNumber)` L731): `facts_chat_status_idx (ownerId, characterId, status)`
  and `episodes_chat_idx (ownerId, characterId, turnNumber)`.

Migration workflow per CLAUDE.md: edit `schema.ts` → `pnpm db:generate` (adding nullable
columns + indexes is an unambiguous ADD, so no rename prompt) → review SQL → `pnpm db:migrate`.

### 1.2 A memory-scope union threaded through the memory API

The query layer keys everything on a bare `sessionId: string` today. Replace that seam with
a discriminated union so both lanes share one code path:

```ts
type MemoryScope =
  | { kind: "session"; sessionId: string }
  | { kind: "chat"; ownerId: string; characterId: string };
```

Add a pure `memoryScopeWhere(table, scope)` helper (in `memory/`) returning the right filter
(`eq(t.sessionId, …)` vs. `and(eq(t.ownerId, …), eq(t.characterId, …))`) and change the
functions the Explore pass enumerated to take `MemoryScope` instead of `sessionId`:

- `memory/facts.ts`: `addFacts` (supersedence SELECT L136, INSERT L150 — set the scope
  columns), `retrieveFacts` (SELECT L220).
- `memory/episodes.ts`: `appendEpisode` (INSERT L59), `recentEpisodes` (L82),
  `retrieveEpisodes` (L124/L139), `deleteEpisodeForTurn` (L164).
- `memory/retrieval.ts`: `preTurnRetrieve` passes the caller's scope through (L45–46).

Session call-sites (`engine/merge/apply.ts` L62/L64/L66, `pipeline.ts` L577/L590,
`inner-note.ts` L178) just wrap their `session.id` in `{ kind: "session", … }` — a
mechanical change. Embedder isolation (`currentEmbedder()`, facts L222 / episodes L140)
and the `isNotNull(embedding)` RAG filter are orthogonal and unchanged.

### 1.3 Chat-lane specifics (consequences, not new decisions)

- **No turn rows.** Chat facts get `sourceTurnId = null` — exactly as `inner-note.ts` L178
  already does (`addFacts(scope, drafts, null, sink)`). Edit-reconciliation
  (`retractFactsFromTurn`, keyed on `sourceTurnId`) simply never matches chat facts; that's
  fine — chat has no turn rerun, and "Clear Chat" (D4) is the only lifecycle event.
- **Episode ordering.** `episodes.turnNumber` is `NOT NULL` and `recentEpisodes` orders by
  it. Chat keeps a **per-chat monotonic exchange ordinal** and writes it as `turnNumber`, so
  the existing ORDER BY works for both scopes (no query change beyond the scope filter).
- **Subject grounding + witness set.** Chat has no participant/location/item rows, so fact
  subjects resolve to the character by name or stay `subjectName`-only; `witnessedBy` is the
  character (and player) — the field is still write-only until the knowledge ledger ships,
  so this only needs to be *honest*, not consumed.

## 2. Post-turn fan-out (D2)

Today `finalizeChatState` (`chat-state.ts` L439) runs one `runChatPulse` (a single
`generateChecked` with a timeout + drift-only degradation, L346–376) after the reply
flushes. Extend it into a **parallel fan-out** launched from the same post-flush point:

- **State pulse** — unchanged (`runChatPulse`).
- **Archivist-lite** — one call over the finished exchange emitting **both** the episode
  summary (→ `appendEpisode`) and `FactDraft[]` (→ `addFacts`), mirroring the session
  archivist that already produces both together. This is the natural single leg, not two.
- **Memory-query producer** — 1–3 retrieval queries for *next* turn (mirrors the director's
  `memoryQueries`); can fold into the archivist-lite call if that keeps it to one model call.
- **Attribute proposer** (§3) — the simulant-lite leg.

Run them with `Promise.all` (each already owns its resilience ladder via `generateChecked`),
so wall-clock ≈ the slowest leg, not the sum. Any leg degrading (timeout/parse/model-down)
follows the existing pattern: skip its effect, push a diagnostic, never fail the turn — the
reply already streamed. If a leg genuinely can't be parallelized, fold it into the pulse
(the D2 fallback).

Retrieval injection (read side): add `retrieveFacts` + `retrieveEpisodes` (scoped to the
chat) as a **new prompt block** in `buildCharacterChatSystemPrompt`, parallel to the
existing summary recap — the rolling summary (D5) sits beneath it as short-term context.

## 3. Mutable attributes (D3)

Chat resolves `resolveAttributes(profile.attributes, [])` today (empty overlay list). Give
chat a persisted **attribute-overlay set** (a jsonb column on `character_chat_state`, an
`AttributeValue[]` with `source:"narrative"`), and pass it as the second arg so evolving
attributes reach the prompt. The **attribute proposer** leg (§2) emits simulant
`attributeChanges` (D3), applied through the same guard as `phaseAttributes`:

- `participantName` = the single chat character.
- Reject inherent traits via `overlaySourceMayChange(def.mutability, "narrative")`
  (`attributes.ts` L45) — eye colour / species / gender can never be rewritten; a rejected
  change drops with a diagnostic (no `droppedEvents` re-grounding needed in chat's simpler loop).
- Accepted changes merge into the overlay column (dedupe by `attributeId`, last-write-wins
  within the mutable set), and converge with the meters/affinity/conditions the light state
  already tracks into one evolving picture.

Note the state-narration lane already added `condition → attribute overlays`
(`conditions/overlays.ts`) resolved at render time; **this** overlay set is the *persisted,
evolving* layer. Both feed the same `resolveAttributes` call — order: authored base →
persisted narrative overlays (this) → transient condition overlays (state-narration).

## 4. Reset → a single "Clear Chat" (D4)

Consolidate the three shipped scopes into one action that clears everything. Touch points
(from the Explore pass):

- **Type/plumbing:** drop `ChatResetScope = "all" | "chat" | "state"` (`lib/client/api.ts`
  L304); `resetChat(id)` becomes scopeless (L752). The `DELETE …/chat` route
  (`route.ts` L264–293) drops the `scope` param and always runs the full clear.
- **What the full clear deletes:** messages + summaries (L271–276), the scene-prompt scrub
  (L277–287), the state row (`deleteChatState`, L289–291) — **plus, new:** the chat-scoped
  `facts` and `episodes` (`DELETE … WHERE ownerId AND characterId`). Add these two deletes
  to the route (or a `deleteChatMemory(ownerId, characterId)` helper beside `deleteChatState`).
- **UI:** replace the three-button reset modal (`character-chat.tsx` L453–474) with one
  **"Clear Chat"** (danger tone) → the scopeless reset; collapse `runReset`'s per-scope
  branching + toasts (L299–317) and the `resetting` state var (L89) to the single path.

This supersedes [finished/character-chat-state.spec.md](finished/character-chat-state.spec.md)
§5/§7 — leave that finished doc as-is (per CLAUDE.md, finished docs aren't repointed); this
spec is the current truth for chat reset.

## 5. Rolling summary retained (D5)

No change to the summary fold job or its `character_chat_summaries` row. Layering, top of
prompt to deepest: verbatim window (~40 turns) → rolling summary (short-term reinforcement)
→ RAG recall (`retrieveFacts` + `retrieveEpisodes`, §2). The summary plan's old anticipation
that it "becomes a column on state / gets folded into episodes" is **declined for now**;
re-evaluate once RAG recall is tuned and we can measure whether the summary still earns its
tokens.

## Adopted defaults to flag (revisit on request)

Second-order choices taken as sensible defaults so the build isn't blocked — flag any to revisit:

- The keying invariant is a DB `CHECK` (§1.1) rather than app-only assertion.
- `ownerId` is included alongside `characterId` on facts/episodes (§1.1) to isolate shared
  characters per owner; if chat characters are always owner-private, `characterId` alone would do.
- The archivist-lite emits episode + facts (+ optionally queries) in **one** call (§2) rather
  than a leg each — closest to the session archivist and fewest model calls.
- Chat episode ordering reuses `turnNumber` as a per-chat exchange ordinal (§1.3) rather than
  adding a chat-only ordering column.

## Not in scope

Same as the plan: location entities / presence / movement / items / wardrobe-as-state / world
lore / story threads are permanently out (chat is one character, location via narration only).
Pure state→narration enactment shipped separately
([character-chat-state-narration](character-chat-state-narration.plan.md)).

## Completion note (2026-07-01)

All seven slices shipped; `pnpm verify` green (1631 pure + 167 integration tests). What landed:

- **Keying (D1, §1):** `facts`/`episodes` `session_id` now nullable + `(owner_id, character_id)`
  columns, a `*_scope_exactly_one` CHECK, and chat indexes (migration `0018`). A `MemoryScope`
  union + `memoryScopeWhere` / `memoryScopeValues` / `sessionScope` / `chatScope` (`memory/scope.ts`)
  thread through `addFacts` / `appendEpisode` / `retrieve*` / `recentEpisodes` / `deleteEpisodeForTurn`
  / `preTurnRetrieve`; every session call-site wraps its id in `sessionScope(…)`. Added
  `latestEpisodeNumber` (the chat exchange-ordinal source) and `deleteFactsForScope` /
  `deleteEpisodesForScope` (the Clear-Chat purge).
- **RAG (§2):** `engine/chat-memory.ts` (`retrieveChatMemory` pre-turn, `runChatArchivist` +
  `writeChatMemory` post-turn) + the `chatArchivistSchema` contract + `prompts/chat-archivist.ts`.
  `finalizeChatState` runs the **pulse ‖ archivist** in parallel (`Promise.all`); the shared timeout
  race lives in `engine/chat-generate.ts` (`withGenerateTimeout`, reused by both legs). Retrieval
  injects a "Your memory" block in `buildCharacterChatSystemPrompt`; `memory_queries` persists on
  the state for next-turn recall (migration `0019`).
- **Refinement — attribute proposer folded into the archivist (§3):** rather than a **third**
  parallel model call, `attributeChanges` (the shared `attributeChangeSchema`, D3) rides on the
  archivist result and applies via `applyChatAttributeOverlays` (the `overlaySourceMayChange` guard)
  into a persisted `attribute_overlays` column (migration `0019`), resolved beneath the transient
  condition overlays. This is the §2 "fewest model calls" default extended to attribute changes —
  the fan-out is **two** legs, not three.
- **Refinement — slice 4 (intake-lite) folded, not built:** its two goals were already covered —
  memory-query seeding by the archivist's `memoryQueries`, response-shape steering by the shipped
  `detectChatCue`/`cueInvite` (state-narration lane). No separate pre-turn classifier was added.
- **Reset (D4, §4):** single **Clear Chat** — one scopeless `DELETE …/chat` wiping transcript +
  summary + state + `deleteChatMemory` (facts/episodes) + the scene-prompt scrub; `ChatResetScope`
  and the three-button modal removed.
- **Inspector (§5):** a `last_memory_trace` column (migration `0020`) + `chatMemoryTraceSchema`
  capture what was retrieved/extracted each turn; the State-tools modal grew a "Memory (last turn)"
  readout + a persisted-attribute-overlays line, and the snapshot now carries `attributeOverlays`.

**Adopted-default outcomes:** DB `CHECK` invariant kept; `ownerId` included; one-call archivist
(now also carrying attributeChanges); `turnNumber` reused as the chat exchange ordinal. None
revisited.
