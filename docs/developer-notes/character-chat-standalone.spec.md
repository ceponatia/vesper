# Character chat — the standalone experience — spec

Status: **draft** — mirrors [character-chat-standalone.plan.md](character-chat-standalone.plan.md)
(read it first for the product framing; its **## Open questions** gate several sections
here). This spec is the technical design: data model, file touch-points, migration shape,
and the refactor analysis. Nothing here is built.

## 0. Architecture today (orientation, not design)

The current lane, post the primary-feature arc (2026-07-01) and review batch 1 (2026-07-02):

- **Orchestration** lives in the route: `app/api/characters/[id]/chat/route.ts` (~408
  lines) owns validation, rate limit, the per-chat keyed lock (`engine/keyed-lock.ts`,
  409 `chat_busy`), user-line insert, summary + verbatim-window load
  (`engine/chat-summary.ts`), persona resolution, `driftChatState`, RAG recall
  (`engine/chat-memory.ts` `retrieveChatMemory`), prompt build
  (`engine/prompts/character-chat.ts`), streaming (`engine/character-chat.ts` →
  `stripNarratorArtifactStream`), then the finalizer: `persistAssistantReply` +
  `finalizeChatState` (`engine/chat-state.ts` — pulse ‖ archivist via `Promise.all`,
  fenced `writeChatMemory`, guarded `saveChatState`).
- **Keying**: everything is `(ownerId, characterId)` — `character_chat_messages`,
  `character_chat_summaries` (PK), `character_chat_state` (PK), and the chat variant of
  `MemoryScope` on `facts`/`episodes` (`memory/scope.ts`; `*_scope_exactly_one` CHECK).
- **Models**: narrator = `resolveChatModelId(characters.chatModel)` from the UI (default
  GLM 5.2); pulse/archivist = `agentModelId()`; summary fold = `stateModelId()`.
- **UI**: one 842-line `components/characters/character-chat.tsx` mounted as an editor
  tab, plus `chat-state-tools.tsx`, `chat-scenario-modal.tsx`, `AvatarPanel`.

Known rot to clean regardless of scope (from the 2026-07-02 survey): stale headers in
`engine/character-chat.ts` (L6–13: "no post-turn pipeline… no RAG"), `prompts/character-chat.ts`
(L26–27: "drops … meters, exposure, RAG"), the `chat/route.ts` header ("No session,
pipeline, or RAG"), and the `schema.ts` `character_chat_state` doc comment still describing
the retired three-mode reset.

## 1. The conversation model (plan area 2 · Option B) — the load-bearing migration

Gated on plan Q2/Q3. Introduces a first-class conversation row and re-keys the lane.

### 1.1 New table: `character_chats`

```
character_chats
  id             text PK (nanoid)
  owner_id       text NOT NULL → users.id (cascade)
  character_id   text NOT NULL → characters.id (cascade)
  title          text NOT NULL DEFAULT ''        -- user-editable; '' renders as auto-title
  memory_group_id text NOT NULL                  -- see §1.3
  created_at / last_message_at timestamps
  archived_at    timestamp NULL                  -- §1.4
  index (owner_id, last_message_at)              -- the Chats page query
  index (owner_id, character_id)
```

### 1.2 Re-keying the chat tables

`character_chat_messages`, `character_chat_summaries`, `character_chat_state` each gain
`chat_id → character_chats.id (cascade)` and drop `(ownerId, characterId)` as their key
(summaries/state PK becomes `chat_id`; messages index `(chat_id, created_at)`).
Ownership checks resolve the chat row first (one indexed lookup) instead of carrying
denormalized owner columns — the route already does a `loadOwnedCharacter` lookup today,
so this swaps one probe for another rather than adding one. The keyed lock key becomes
`chat_exchange:${chatId}`.

`characters.chatModel` (the narrator pick) **stays per character** — it is a voice-tuning
property of the character, not of a conversation. (Flag if a per-chat override is wanted.)

### 1.3 Memory groups — the Q2 mechanism

Recommended design for "continue our shared history vs fresh start":

- `facts`/`episodes`: replace the chat keying columns (`owner_id`, `character_id`) with a
  single nullable **`chat_memory_group_id`**; the CHECK becomes
  `session_id IS NOT NULL XOR chat_memory_group_id IS NOT NULL`. `MemoryScope` chat
  variant becomes `{ kind: "chat"; groupId: string }` — `memoryScopeWhere`/`Values`,
  `chatScope`, and `engine/chat-memory.ts` update mechanically; session call-sites are
  untouched.
- Every `character_chats` row carries `memory_group_id`. "Continue our shared history"
  copies the group id of the character's existing conversations (first chat mints it);
  "fresh start" mints a new one. Multiple continuations can share one group; every AU is
  its own island.
- **Consequences to design around**: (a) episode ordinals (`turn_number` =
  `latestEpisodeNumber(scope)+1`) are per **group**, which stays correct since retrieval
  and recency both operate per group; (b) the rolling summary and state stay **per chat**
  — only durable facts/episodes are group-level; (c) archiving a chat does *not* retract
  its group memories (the relationship remembers); hard-deleting a chat deletes only
  memories provenanced to its messages (§4.3).

### 1.4 Lifecycle: archive replaces Clear as the everyday action

- **Archive** (`PATCH` sets `archived_at`): read-only transcript, excluded from the
  active Chats list default filter, restorable. No data deleted.
- **Delete** (danger): today's transactional Clear generalized — transcript + summary +
  state + scene-prompt scrub + `deleteChatMemory` narrowed to rows provenanced to this
  chat (§4.3) + the chat row itself. When the last chat in a memory group is deleted, the
  group's remaining rows are purged.
- "Clear chat" as a concept disappears; "start a fresh conversation" replaces its main
  use (the D4 ruling's spirit — one obvious action — is preserved; there is still exactly
  one destructive verb).

### 1.5 Scenario presets

Small dedicated table (graduate to a shareable `LibraryKind` later if wanted — schema kept
forward-compatible per the library pattern):

```
chat_scenario_presets
  id, owner_id, name,
  premise text, outfit text, outfit_exposed bool,
  social_cards jsonb, starting_stage text,
  created_at
```

New-conversation flow: pick preset (or blank) → seeds `character_chat_state` exactly the
way `chat-scenario-modal.tsx` writes those fields today.

### 1.6 Migration path

Dev-stage data, no legacy preservation required (CLAUDE.md): one migration (a) creates
`character_chats` + backfills one row per distinct `(ownerId, characterId)` found across
messages/state/summaries (minting `memory_group_id` per pair), (b) adds + backfills
`chat_id` on the three chat tables, then drops the old key columns, (c) adds
`chat_memory_group_id` to facts/episodes, backfills from `(owner_id, character_id)` →
that pair's group id, drops the two columns, and swaps the CHECK. Standard workflow:
`schema.ts` → `pnpm db:generate` → review → `pnpm db:migrate`. **Expect the
create-vs-rename prompt** on the facts/episodes column swap — per CLAUDE.md, hand the
`db:generate` step to the owner rather than automating past it.

## 2. Routes, pages, components (plan area 1)

### 2.1 API moves to chat-id addressing

Replace `/api/characters/[id]/chat*` outright (no compat shims):

```
GET    /api/chats                     -- list (active|archived filter), Chats-page shape
POST   /api/chats                     -- create {characterId, title?, presetId?, memory: "shared"|"fresh"}
GET    /api/chats/[chatId]            -- transcript (cursor-paged)
POST   /api/chats/[chatId]            -- send / opening beat / go-on (§4)
PATCH  /api/chats/[chatId]            -- title, archive/restore
DELETE /api/chats/[chatId]            -- hard delete (§1.4)
POST   /api/chats/[chatId]/stop       -- §4.2
GET/PATCH/POST /api/chats/[chatId]/state    -- as today's state route
GET/POST       /api/chats/[chatId]/scene    -- as today's scene route
PATCH/DELETE   /api/chats/[chatId]/messages/[messageId]
GET    /api/chats/[chatId]/memory     -- §5 panel; DELETE/PATCH per-fact live under it
GET    /api/chats/[chatId]/export     -- §6.4
POST   /api/chats/[chatId]/summary/rebuild  -- §6.3
```

### 2.2 Pages

- `/chat` — the Chats hub: conversation cards (portrait, name, title, last-line snippet,
  `MoodChip` + stage chip, "has something to say" marker §7.3), "New conversation" (picks
  character → preset), archived filter.
- `/chat/[chatId]` — full-screen conversation: mobile-first single column; portrait/scene
  in a collapsible header panel; scenario/state-tools/model/export in a header menu
  (`Sheet` on mobile). The bottom tab bar gains a **Chats** entry; the play-screen
  suppression rule applies here too (composer owns the bottom edge).
- Character editor: the Chat tab collapses to a summary card + "Open chat" links (per
  conversation) — authoring stays, playing moves out.
- Entry points: `entity-library.tsx` character card action, character page header,
  dashboard "Continue talking to…" card (most recent `last_message_at`), public-gallery
  characters (clone-on-use, then create chat).

### 2.3 Component split (absorbs review §E-U5 and friends)

`character-chat.tsx` (842 lines) splits: `chat/chat-conversation.tsx` (stream + transcript
orchestration), `chat/chat-message.tsx` (bubble + hover actions + variants UI §4.1),
`chat/chat-composer.tsx`, `chat/chat-scene-strip.tsx`, `chat/chats-page.tsx`. While
splitting, adopt the shared primitives the review flagged: `usePollWhile` (E-U2, replacing
the hand-rolled 2500 ms scene poll), one `ModelSelect` (E-U3), `draft-seed.ts` (E-U4), and
`findOwned` on the chat/scene routes (E-S1).

## 3. Engine consolidation (plan area 8 · absorbs review §D)

Sequenced **first** (plan build-order slice 1) so the §1 migration lands in clean code.

- **D1 — `engine/chat-pipeline.ts`**: `submitChatMessage(deps, input)` extracted from the
  route POST — owns lock, window/summary/persona/drift/RAG/prompt/stream/finalize; the
  route thins to parse → auth → stream plumbing, like the session lane's
  `sessions/[id]/turns` → `submitTurn`. The opening-beat and (new) go-on branches are
  flags on the same entry point, not forks.
- **D2 — de-fork three helpers**: (1) the §6 reaction sequence — one pure
  `evaluateActReaction` in `contracts/personality`, consumed by `merge/phases/reactions.ts`
  and `chat-state.ts` `applyChatPulse` (restores the drifted touch-welcomeness fallback +
  reaction-beat parity); (2) `withGenerateTimeout` moves to `server/ai` beside
  `generateChecked` (also replaces `intake.ts`'s private copy); (3) one drain-despite-
  disconnect SSE/stream wrapper shared by `chat` and `sessions/_shared/sse.ts`.
- **D4 — job hygiene**: chat scene generation gets its own `chat_scene_image` job type on
  the heartbeat/poison-cap runner (or the api-side `startJob` path gains a detached-row
  recovery sweep) so a process death can't pin a row `running` forever.
- **Stale comments**: the four headers listed in §0.
- **`docs/character-chat.md`** (review D3): new system doc mirroring `turn-engine.md` —
  exchange lifecycle, state row, memory scope + groups, prompt-assembly pointer, jobs,
  API surface, the diagnostics-code table (`chat_state.*`, `chat_archivist.*`,
  `chat_memory.*`, `chat_summary.*`, `chat_busy`). `docs/README.md` gains its row.
  Engine headers repoint at it instead of archived plan docs.

## 4. Message affordances (plan area 3)

### 4.1 Another take (regenerate with variants)

- Storage: `variants` jsonb on `character_chat_messages` (assistant rows):
  `{ takes: [{id, content, createdAt}], activeId }`, cap 4 (oldest non-active evicted).
  The row's `content` mirrors the active take, so transcript reads/window assembly/export
  are untouched. Switching takes = update `content` + `activeId`.
- **Side-effect correctness — the real design problem.** `finalizeChatState` (pulse ‖
  archivist) already ran against take 1: state moved, an episode + facts were written.
  Regeneration must not double-apply. Design:
  - `character_chat_state.pre_exchange_state` jsonb: snapshot of the state row taken at
    exchange start (one column, overwritten each exchange). Regenerate restores it before
    re-running the finalizer against the new take.
  - Memory rollback needs provenance — §4.3. The exchange's episode is deleted by ordinal
    (`deleteEpisodeForExchange(scope, ordinal)`, the chat analogue of
    `deleteEpisodeForTurn`); its facts retract via `source_message_id`.
  - The same machinery makes today's **Rerun** side-effect-safe (it currently re-runs the
    pulse on top of already-applied state — a pre-existing double-apply this fixes).
- Rejected alternative: deferring `finalizeChatState` until the *next* submit (zero
  rollback needed) — rejected because the status strip / stage toast / inspector all read
  the post-exchange state immediately, and a browser that never returns would leave the
  exchange permanently unprocessed.

### 4.2 Go on + Stop

- **Go on**: generalize the opening beat — `POST /api/chats/[chatId]` with
  `{ kind: "continue" }` mid-conversation: no user row; prompt gets a "continue naturally
  from your last line; do not repeat yourself; one beat" instruction; the finalizer runs
  as a normal exchange. Rate-limited like sends.
- **Stop**: inference can't be interrupted upstream, but the *reply* can be truncated
  honestly: the in-flight exchange registers an `AbortController` in its keyed-lock entry;
  `POST …/stop` aborts the model stream server-side; the accumulated prefix persists as
  the reply (marked `meta.stopped = true`, rendered with a subtle "stopped" chip) and the
  finalizer runs over the truncated text. This replaces today's client-only abort (which
  the server deliberately out-drains and persists in full).

### 4.3 Memory provenance (correctness fix, prerequisite for 4.1)

`facts` gains nullable `source_message_id` (chat lane sets it to the exchange's assistant
message id; session rows keep `source_turn_id` — the two are the same idea per lane).
Episodes already carry the exchange ordinal. Then:

- Message **Delete/Edit** retracts/re-extracts the memories sourced from that exchange —
  closing today's gap where the recovery levers clean the window but leave the poisoned
  memory in RAG.
- Regenerate (§4.1) and hard-delete (§1.4) get exact targets.

## 5. Memory surface (plan area 4)

### 5.1 The player-facing panel

`GET /api/chats/[chatId]/memory` returns the chat's memory-group facts (active, newest
first, plain `content` — the drafts are already written as readable sentences) and a
capped episode list. Framed diegetically in the UI ("What ‹name› remembers"). Actions:

- **Forget**: `DELETE …/memory/facts/[factId]` → `status: "retracted"` (the existing
  audit-trail state; never a row delete).
- **Pin**: `PATCH …/memory/facts/[factId] {pinned: true}` — new `pinned` boolean on
  `facts` (shared table; session lane can adopt later). Retrieval change in
  `memory/facts.ts`: pinned facts are always included ahead of the top-k, exempt from any
  relevance floor.
- **Remember this**: `POST …/memory/facts {content}` → `addFacts` with confidence 1.0,
  `kind: "knowledge"`, `source_message_id: null` — the chat analogue of the session
  inner-note (same fencing rules; it is authored data, not instructions).

### 5.2 Open loops

`chatArchivistSchema` gains `openLoops: string[]` (cap 3, full-list-each-time so resolved
loops fall off naturally); persisted as a `character_chat_state.open_loops` jsonb;
rendered as an "Unfinished business" line in the prompt's state section (standing
coloring, same never-recite discipline) and shown in the relationship panel (§6) and the
"has something to say" derivation (§7.3).

### 5.3 Retrieval quality (chat-first slice of RAG-improvements)

Implemented in shared `memory/`, observed through the chat inspector first: **#1** a
measured relevance floor for facts (with the pinned exemption above; in a 1-on-1 chat the
"subject present" escape hatch is trivially the partner, so the floor is safe), **#2**
per-query embedding + RRF fusion + per-source attribution in the trace, **#4** prefer
`subjectId` equality in supersedence. **#6** (the retrieval eval harness) is the
measurement precondition — build its chat fixtures alongside. The session lane inherits
all four automatically.

## 6. The living relationship (plan area 5)

- **6.1 History**: `character_chat_state.relationship_history` jsonb — a capped ring
  buffer (≤200 samples of `{clockMinutes, at, affinity, stage}`), appended by the
  finalizer when affinity moved or the stage crossed. Powers the sparkline.
- **6.2 Milestones**: `character_chat_state.milestones` jsonb (append-only, capped):
  derived events — first exchange, stage changes (both directions), strong card-driven
  reactions (the pulse already computes the reaction tier), player-pinned moments (a
  "mark this moment" hover action on any message). Each `{at, kind, label, messageId?}`.
- **6.3 Story so far**: surface the rolling summary read-only in the relationship panel;
  add the long-parked **rebuild-summary lever** (`POST …/summary/rebuild` re-folds from
  the full transcript — the recovery for folded-then-deleted lines) and take the fold
  tuning leftovers (word budget, recursive-vs-append drift check) as eval items here.
- **6.4 Export**: `GET …/export?format=md|json` — title, scenario, participants, dated
  transcript, optional memory appendix. (Graduates deferred #8 at chat scale.)
- **UI**: a **Relationship** panel/sheet on the conversation page: stage + sparkline +
  milestones + story-so-far + open loops.

## 7. Time awareness (plan area 6)

- **7.1 Welcome-back**: `driftChatState` already computes `realElapsed`; when it exceeds
  a threshold (default 12 h) the drift result carries a `gapNote` ("It has been 3 days
  since you last spoke") that the prompt renders as a one-turn volatile line with an
  acknowledge-once instruction, worded by stage band. No new column — the first exchange
  after a gap is identifiable by the elapsed value itself.
- **7.2 A life meanwhile**: same line, extended: "you may weave in one line about what you
  were doing meanwhile, consistent with the scenario and your personality" — prompt-only,
  no extra model call. If evals show invention drifting off-premise, escalate to a tiny
  archivist question at return time (deferred until proven needed).
- **7.3 "Has something to say"**: pure derivation at Chats-list read time (no jobs, no
  push): `gap > N days || openLoops.length > 0 || unseen milestone`. Renders the marker;
  tapping sends `{kind: "continue"}` with the reason threaded as the cue line, so the
  character opens *about the right thing*. Ceiling per plan Q5.

## 8. Prompt intelligence — chat items (absorbs review §C chat-side)

- **C6**: `prompts/chat-archivist.ts` says "three fields", lists four — fix the count and
  add a worked `attributeChanges` micro-example (the haircut) so the proposer stops
  under-firing.
- **C8 chat bits**: chat-summary rule 5 ("addresses 'you' in a third-person summary");
  the pulse classifier gets a worked example (the only agent prompt without one).
- **C3/C4 (chat lane)**: one dialogue-craft rule in `CHAT_RULES` (speech-like dialogue,
  distinct rhythm, silence as an answer) and an intimate-craft block (escalation held to
  the player's pace, body/clothing continuity, concrete sensation, desire in the
  dialogue) — the session-lane ports stay in review batch 2.
- **Prompt-cache layout**: today the volatile disposition overlays sit mid-`system`,
  busting the prefix cache on any band change (C8, low urgency). Restructure
  `buildCharacterChatSystemPrompt` output into a stable prefix (identity → persona →
  scenario → background → base disposition → attributes → sensory → rules) and a volatile
  tail (state section, memory block, disinhibition overlays, cue invite) — verified by a
  snapshot test asserting the prefix is byte-identical across consecutive turns with
  unchanged authored inputs.
- **Narrator-default inconsistency**: a headless `POST` without `model` falls back to
  `MODEL_DEFAULTS.narrative` (Aion) while the UI always sends the per-character pick
  (default GLM). Make the route default `resolveChatModelId(character.chatModel)` so both
  paths agree.
- **Intimacy-notes coordination**: if [intimacy-notes.plan.md](intimacy-notes.plan.md)
  ships, chat has no exposure mask to gate the new note — gate it on the chat side behind
  `detectChatCue` intimacy signals plus a state floor (arousal band or stage ≥ the
  romantic tier, or a premise that declares intimacy), mirroring how intimate disposition
  bands are already framed ("when the moment turns intimate").

## 9. Option C analysis — full unification with the session engine (assessed, rejected)

What "chat as a micro-session" would require: minting session rows (a worldless variant
or a synthetic world), adopting `turns` (and its edit-reconciliation machinery), running
the merge reducer for a single participant, the segmenter for one speaker, and stubbing
presence/perception/exposure/wardrobe for a lane that deliberately has none. Wins: one
pipeline, free access to director-class agents and story threads. Costs: the D1 ruling
(character-chat-primary spec) already rejected fake sessions for exactly the
leaked-assumptions reason; the shared layers that matter are *already* shared post that
arc (MemoryScope, contracts, §6 curve after §3's de-fork, narration shape, artifact
stripping, SSE/timeout helpers after §3); migration risk spans every chat table for zero
user-visible gain. **Recommendation: keep two lanes; if chat ever needs a session-grade
capability, port the agent, not the lane** (e.g. a director-lite is one new leg in the
existing fan-out, not a pipeline swap). Revisit trigger: a third lane appearing, or chat
needing ≥2 session-only subsystems in one plan.

## 10. Testing & evals

- **Migration/integration**: §1 backfill (one chat per legacy pair, group ids correct,
  CHECK swapped), archive vs delete semantics, memory-group isolation (fresh-start chat
  retrieves nothing from the shared group), provenance retraction on delete/edit/
  regenerate, stop-truncation persistence.
- **Pure**: variants eviction, pre-exchange snapshot restore, gap-note thresholds/wording
  bands, milestone derivation, open-loops last-write, relevance floor + pinned exemption,
  prompt prefix-stability snapshot.
- **Degradation** (resilience rules): every new leg degrades with a diagnostic — memory
  panel on retrieval failure, regenerate when the snapshot column is empty (fall back to
  no-rollback + diagnostic), stop when no in-flight entry exists (404, not a crash).
- **Evals** (`pnpm eval:narration`, never in verify): welcome-back fires once and reads
  stage-appropriate; go-on doesn't repeat; dialogue/intimate craft rules move the judge
  rubric; variant takes actually differ (temperature sanity).

## Adopted defaults to flag (revisit on request)

- Chat tables key on `chat_id` alone; ownership resolves through the chat row (no
  denormalized owner columns).
- `characters.chatModel` stays per character (no per-chat override).
- Variants live in a jsonb on the message row (cap 4), not sibling rows.
- `pinned` + `source_message_id` land on the shared `facts` table (session lane adopts
  later, nothing breaks meanwhile).
- Scenario presets are a small owned table now, `LibraryKind` graduation later.
- "Has something to say" is computed at read time — no jobs, no schedules, no push.

## Open questions

Owned by the plan ([character-chat-standalone.plan.md](character-chat-standalone.plan.md)
§Open questions) — resolve there; record rulings here as **Decisions** when made. The
spec-level sensitivities: Q2 decides §1.3 (memory groups vs simple per-chat memory —
per-chat-only would delete §1.3 and simplify §1.6); Q3 decides whether §1 happens at all;
Q4 gates §5.1; Q5 gates §7.3; Q6 (group chat) would add a `participants` list to §1.1 now
rather than re-keying later.
