# Character chat — the standalone experience — spec

Status: **draft** — mirrors [character-chat-standalone.plan.md](character-chat-standalone.plan.md)
(read it first for the product framing). Two PM review rounds (2026-07-02) are folded in:
the rulings live in **## Decisions** below. Only the plan's two narrowed open questions
remain (OQ1 time-skip v1 semantics → §8.1; OQ2 "remember this" → §6.4) — both sections
carry the proposed default. Nothing here is built.

## Decisions (rulings to date — 2026-07-02 PM reviews)

- **D1 — depth of rebuild: Option B.** Re-key the lane around a first-class conversation
  record (§1). Chat is **its own feature with its own style choices** — it shares elements
  with the session lane where honest, but is never a toned-down copy. Option C (full
  unification) is rejected; the analysis is kept in §10 for the record.
- **D2 — memory/state surfaces are dev-facing.** No player-facing memory browser: the
  product goal is memory/state tuned well enough that players never think about them. The
  dev tooling instead expands to full visibility + editability of everything stored (§6).
  The lightweight player-side "remember this" is still open (plan Q6).
- **D3 — in-game time only.** Real-world elapsed time never passes in the fiction: a
  player away for a week returns to a scene where no time passed. In-game time is what
  drives behavior. §8 redesigns the time system around player-controlled skips; the exact
  disposition of the existing wall-clock drift is plan Q2.
- **D4 — proactivity experiment approved.** The pull-based "has something to say" marker
  ships as an experiment (no notifications; computed at read time; keyed to open loops /
  milestones in the fiction, never the wall clock). Push-shaped messaging stays out.
- **D5 — mood-reactive avatar stays parked.** The idea remains good and will be
  re-addressed with a fresh design later (the rolled-back implementation felt bad); not in
  this plan.
- **D6 — chat is the current product focus.** The session lane is blocked on NPC
  location/navigation usability; chat bypasses locations by design and serves as the
  proving ground whose systems feed back into sessions later. The roadmap top-of-Next
  placement stands.
- **D7 — memory across conversations: the player's choice at creation.** A new
  conversation is either a truly _vanilla_ fresh start (clean memory island) or continues
  the shared history. PM note: the value of a shared-history _new_ chat over continuing
  the old one wasn't obvious — recorded rationale: it's "same relationship, new scene"
  (fresh premise/outfit/setting and a tidy transcript without losing what the character
  knows of you), pairing with archiving and time skips. §1.3.
- **D8 — the wall-clock drift is removed outright.** Player-chosen time skips are the
  only between-scene time mechanism (no hidden second clock). What a skip does to state
  is v1-scoped in §8.1 (plan OQ1): narrative flavor + condition expiry, meters untouched,
  the full time-effects system scaffolded but not wired.
- **D9 — group chat = the lightweight library pickup.** The future multi-character chat
  is "grab 2+ characters from the library into a shared chat" — minutes, not worlds'
  heavy setup. Known design problem recorded for that future plan: characters carry
  world-flavored lore (bio/background), and cross-world lore must not collide in a shared
  room — candidate shapes are a per-character "chat lore" field vs chat-level lore. §1.1
  reserves the schema headroom only.
- **D10 — measurement steers, it does not gate.** The §5 eval baseline runs in parallel
  with the feature slices and feeds tuning as it learns.
- **D11 — relationship hard gates confirmed.** Stage floors gate intimate escalation
  (in-character deflection, premise-overridable); in dev the gate is bypassed by directly
  editing the relationship state in the inspector — no separate override switch needed.
  §7.1.
- **D12 — the dashboard leads with conversations** ("Continue talking to…") once the
  Chats page exists — "for now", revisitable. §2.2.
- **D13 — voice stays parked.** No current plans; noted as potentially useful once the
  rest is nailed down. No spec section.

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

## 1. The conversation model (plan area 2 · D1) — the load-bearing migration

Fully ruled (D1 shape, D7 memory choice, D9 headroom). Designed with **multi-character
headroom** from day one: a conversation _may_ later hold more than one character, so
participants are a list and per-character rows key on `(chat, character)` — v1 enforces
exactly one participant in the app layer.

### 1.1 New tables

```
character_chats
  id             text PK (nanoid)
  owner_id       text NOT NULL → users.id (cascade)
  title          text NOT NULL DEFAULT ''        -- user-editable; '' renders as auto-title
  created_at / last_message_at timestamps
  archived_at    timestamp NULL                  -- §1.4
  index (owner_id, last_message_at)              -- the Chats page query

chat_participants
  chat_id        text → character_chats.id (cascade)
  character_id   text → characters.id (cascade)
  memory_group_id text NOT NULL                  -- §1.3 — per participant, so a future
                                                 -- group chat keeps each character's
                                                 -- memory their own
  sort           int NOT NULL DEFAULT 0
  PK (chat_id, character_id)
  index (character_id)                           -- "chats with this character"
```

v1 rule (app-enforced, no DB CHECK yet): exactly one participant per chat. Turn-taking,
prompt shape, and image composition for >1 participant are **out of scope** — a future
group-chat spec; this schema just avoids re-keying when it comes. That future's ruled
shape (D9): a lightweight library pickup (2+ characters into a shared chat, shared
premise, per-participant memory groups). One design problem is recorded for it now, since
it may back-propagate a character field: **lore scoping** — character bios/backgrounds
are world-flavored, and a shared room must not mix conflicting world lore; candidates are
a per-character "chat lore" variant of the profile vs chat-level lore that overrides the
authored background. Nothing built here.

### 1.2 Re-keying the chat tables

- `character_chat_messages`: `chat_id` + `(chat_id, created_at)` index; assistant rows
  gain `speaker_character_id` (v1: always the lone participant — headroom, cheap now).
- `character_chat_summaries`: PK `chat_id` (the conversation summary is shared, not
  per-character).
- `character_chat_state`: PK **`(chat_id, character_id)`** — per-participant state from
  day one (meters/affinity/conditions are properties of a character in a conversation).
- Ownership checks resolve the chat row first (one indexed lookup — the route already does
  a `loadOwnedCharacter` probe today, so this swaps a probe, not adds one). The keyed lock
  key becomes `chat_exchange:${chatId}`.
- `characters.chatModel` (the narrator pick) **stays per character** — a voice-tuning
  property of the character, not of a conversation. (Flag if a per-chat override is wanted.)

### 1.3 Memory groups (ruled — D7)

The mechanism behind the player's create-time choice — "continue our shared history" vs
a vanilla "fresh start". The new-conversation flow asks only when the character has prior
chats; the two options carry the plan's plain-language framing (same relationship, new
scene vs. clean slate).

- `facts`/`episodes`: replace the chat keying columns (`owner_id`, `character_id`) with a
  single nullable **`chat_memory_group_id`**; the CHECK becomes
  `session_id IS NOT NULL XOR chat_memory_group_id IS NOT NULL`. `MemoryScope` chat
  variant becomes `{ kind: "chat"; groupId: string }` — `memoryScopeWhere`/`Values`,
  `chatScope`, and `engine/chat-memory.ts` update mechanically; session call-sites are
  untouched.
- The group id lives on **`chat_participants.memory_group_id`** (§1.1): "continue our
  shared history" reuses the character's existing group; "fresh start / AU" mints a new
  one. Multiple continuations share one group; every AU is its own island; in a future
  group chat each participant retrieves from (and writes to) their own group.
- **Consequences to design around**: (a) episode ordinals (`turn_number` =
  `latestEpisodeNumber(scope)+1`) are per **group** — correct, since retrieval and recency
  both operate per group; (b) the rolling summary and state stay per chat / per
  participant — only durable facts/episodes are group-level; (c) archiving a chat does
  _not_ retract its group memories (the relationship remembers); hard-deleting a chat
  deletes only memories provenanced to its messages (§4.3); when a group's last referencing
  participant row is deleted, the group's remaining rows are purged.

### 1.4 Lifecycle: archive replaces Clear as the everyday action

- **Archive** (`PATCH` sets `archived_at`): read-only transcript, excluded from the
  active Chats list default filter, restorable. No data deleted.
- **Delete** (danger): today's transactional Clear generalized — transcript + summary +
  state + scene-prompt scrub + memory rows provenanced to this chat (§4.3) + the chat +
  participant rows (and orphaned memory groups per §1.3c).
- "Clear chat" as a concept disappears; "start a fresh conversation" replaces its main
  use. There is still exactly one destructive verb.

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

New-conversation flow: pick preset (or blank) → seeds the participant's
`character_chat_state` exactly the way `chat-scenario-modal.tsx` writes those fields today.

### 1.6 Migration path

Dev-stage data, no legacy preservation required (CLAUDE.md): one migration (a) creates
`character_chats` + `chat_participants`, backfilling one chat + one participant per
distinct `(ownerId, characterId)` found across messages/state/summaries (minting
`memory_group_id` per pair), (b) adds + backfills `chat_id` (and `speaker_character_id` /
the state PK swap) on the three chat tables, then drops the old key columns, (c) adds
`chat_memory_group_id` to facts/episodes, backfills from `(owner_id, character_id)` → that
pair's group id, drops the two columns, and swaps the CHECK. Standard workflow:
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
POST   /api/chats/[chatId]/time-skip  -- §8.1
GET/PATCH/POST /api/chats/[chatId]/state    -- as today's state route (per participant)
GET/POST       /api/chats/[chatId]/scene    -- as today's scene route
PATCH/DELETE   /api/chats/[chatId]/messages/[messageId]
GET    /api/chats/[chatId]/export     -- §7.4
POST   /api/chats/[chatId]/summary/rebuild  -- §7.3
GET/…  /api/dev/chat-inspector/…      -- §6.1 (dev-gated, 404 in production)
```

### 2.2 Pages

- `/chat` — the Chats hub: conversation cards (portrait, name, title, last-line snippet,
  `MoodChip` + stage chip, "has something to say" marker §8.4), "New conversation" (picks
  character → preset → shared/fresh memory §1.3), archived filter.
- `/chat/[chatId]` — full-screen conversation: mobile-first single column; portrait/scene
  in a collapsible header panel; scenario/state-tools/model/export in a header menu
  (`Sheet` on mobile). The bottom tab bar gains a **Chats** entry; the play-screen
  suppression rule applies here too (composer owns the bottom edge).
- Character editor: the Chat tab collapses to a summary card + "Open chat" links (per
  conversation) — authoring stays, playing moves out.
- Entry points: `entity-library.tsx` character card action, character page header,
  dashboard "Continue talking to…" card (most recent `last_message_at`), public-gallery
  characters (clone-on-use, then create chat). Ruled (D12): the dashboard leads with the
  "Continue talking to…" conversations hero for now.

### 2.3 Component split (absorbs review §E-U5 and friends)

`character-chat.tsx` (842 lines) splits: `chat/chat-conversation.tsx` (stream + transcript
orchestration), `chat/chat-message.tsx` (bubble + hover actions + takes UI §4.1),
`chat/chat-composer.tsx`, `chat/chat-scene-strip.tsx`, `chat/chats-page.tsx`. While
splitting, adopt the shared primitives the review flagged: `usePollWhile` (E-U2, replacing
the hand-rolled 2500 ms scene poll), one `ModelSelect` (E-U3), `draft-seed.ts` (E-U4), and
`findOwned` on the chat/scene routes (E-S1).

## 3. Engine consolidation (plan area 9 · absorbs review §D)

Sequenced **first** (plan build-order slice 1) so the §1 migration lands in clean code.

- **D1 (review) — `engine/chat-pipeline.ts`**: `submitChatMessage(deps, input)` extracted
  from the route POST — owns lock, window/summary/persona/drift/RAG/prompt/stream/finalize;
  the route thins to parse → auth → stream plumbing, like the session lane's
  `sessions/[id]/turns` → `submitTurn`. The opening-beat and (new) go-on branches are
  flags on the same entry point, not forks.
- **D2 (review) — de-fork three helpers**: (1) the §6 reaction sequence — one pure
  `evaluateActReaction` in `contracts/personality`, consumed by `merge/phases/reactions.ts`
  and `chat-state.ts` `applyChatPulse` (restores the drifted touch-welcomeness fallback +
  reaction-beat parity); (2) `withGenerateTimeout` moves to `server/ai` beside
  `generateChecked` (also replaces `intake.ts`'s private copy); (3) one drain-despite-
  disconnect SSE/stream wrapper shared by `chat` and `sessions/_shared/sse.ts`.
- **D4 (review) — job hygiene**: chat scene generation gets its own `chat_scene_image` job
  type on the heartbeat/poison-cap runner (or the api-side `startJob` path gains a
  detached-row recovery sweep) so a process death can't pin a row `running` forever.
- **Stale comments**: the four headers listed in §0.
- **`docs/character-chat.md`** (review D3): new system doc mirroring `turn-engine.md` —
  exchange lifecycle, conversation/participant model, state row, memory scope + groups,
  prompt-assembly pointer, jobs, API surface, the diagnostics-code table (`chat_state.*`,
  `chat_archivist.*`, `chat_memory.*`, `chat_summary.*`, `chat_busy`). `docs/README.md`
  gains its row. Engine headers repoint at it instead of archived plan docs.

## 4. Message affordances (plan area 4)

Session parity (edit / delete / rerun any of your lines) already exists; this section adds
the beyond-parity set the PM asked for.

### 4.1 Another take (regenerate with browsable takes)

- Storage: `takes` jsonb on assistant message rows:
  `{ takes: [{id, content, createdAt}], activeId }`, cap 4 (oldest non-active evicted).
  The row's `content` mirrors the active take, so transcript reads/window assembly/export
  are untouched. Switching takes = update `content` + `activeId`.
- **Side-effect correctness — the real design problem.** `finalizeChatState` (pulse ‖
  archivist) already ran against take 1: state moved, an episode + facts were written.
  Regeneration must not double-apply. Design:
  - `character_chat_state.pre_exchange_state` jsonb: snapshot of the state row taken at
    exchange start (one column per participant row, overwritten each exchange). Another-
    take restores it before re-running the finalizer against the new take.
  - Memory rollback needs provenance — §4.3. The exchange's episode is deleted by ordinal
    (`deleteEpisodeForExchange(scope, ordinal)`, the chat analogue of
    `deleteEpisodeForTurn`); its facts retract via `source_message_id`.
  - The same machinery makes today's **Rerun** side-effect-safe (it currently re-runs the
    pulse on top of already-applied state — a pre-existing double-apply this fixes).
- Rejected alternative: deferring `finalizeChatState` until the _next_ submit (zero
  rollback needed) — rejected because the status strip / stage toast / inspector all read
  the post-exchange state immediately, and a browser that never returns would leave the
  exchange permanently unprocessed.

### 4.2 Go on + Stop

- **Go on**: generalize the opening beat — `POST /api/chats/[chatId]` with
  `{ kind: "continue" }` mid-conversation: no user row; prompt gets a "continue naturally
  from your last line; do not repeat yourself; one beat" instruction; the finalizer runs
  as a normal exchange. Rate-limited like sends.
- **Stop**: inference can't be interrupted upstream, but the _reply_ can be truncated
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
- Another-take (§4.1), Rerun, and hard-delete (§1.4) get exact targets.

## 5. Measurement & tuning (plan area 3 — new)

The PM has not observed a noticeable behavioral effect from personality sliders or the
mood/energy/intimacy/intoxication state in testing. Before trusting (or extending) the
enactment stack, measure it — the harness already exists (`pnpm eval:narration`, never in
`verify`/CI).

- **Paired contrast fixtures** (`scripts/eval/narration/fixtures.ts`, chat lane, built
  through the real `buildCharacterChatSystemPrompt`): identical scenario + input with one
  axis flipped —
  (a) state on vs state stripped (no state section at all);
  (b) slider extremes (e.g. `social.warmth` cold vs warm; `intimate.inhibition` low/high);
  (c) relationship stage stranger vs lover (affinity seed);
  (d) intoxication 0 vs 0.8 (the disinhibition + meter-cue path);
  (e) memory on vs off (does recall visibly land?).
- **Blind pairwise judging**: reuse the LLM-judge rubric machinery — the judge sees both
  replies unlabeled and must identify which is the drunk / warm / lover variant, plus rate
  _how_ visible the difference is. Deterministic secondary metrics (per-axis lexical cue
  lists) guard against judge drift. Acceptance bar: correct blind identification on ≥80%
  of seeds per axis, or the axis is declared **not enacted** and its prompt wording (or
  mechanics) gets tuned and re-run.
- **Outcome routing**: fixes land in `buildStateSection` / disposition wording /
  `CHAT_RULES` (and §9's craft items); the fixtures stay as the permanent regression
  harness. Findings also decide plan Q4's sequencing question in practice.
- **Dev affordance**: extend the inspector with a raw "what reached the narrator" prompt
  view (admin-gated, like the lightbox generation-prompt panel) so live play can be
  compared against fixtures.

## 6. Memory: dev inspector + retrieval quality (plan area 5 · D2)

### 6.1 The complete dev inspector (replaces the player-facing panel idea)

Dev/admin-gated (the `useIsAdmin` gate + a `/api/dev/…` 404-in-production route family,
like impersonate). Full CRUD over everything stored for a character/chat:

- **Facts**: list (active + superseded + retracted), edit content (re-embed on save),
  retract, restore, hard-set `pinned` (force-include in retrieval — a testing lever),
  create ad-hoc.
- **Episodes**: list with ordinals + scores against an arbitrary test query; edit/delete.
- **State**: the existing state-tools editing, extended to every column (overlays,
  surfaced cues, open loops §6.2, memory queries, pre-exchange snapshot).
- **Summary**: view + edit + the rebuild lever (§7.3).
- Surfaced either as a grown `chat-state-tools.tsx` or a dedicated dev page under
  `/chat/[chatId]` — implementation's choice; the API family is the contract.

### 6.2 Open loops

`chatArchivistSchema` gains `openLoops: string[]` (cap 3, full-list-each-time so resolved
loops fall off naturally); persisted as a `character_chat_state.open_loops` jsonb;
rendered as an "Unfinished business" line in the prompt's state section (standing
coloring, same never-recite discipline), shown in the relationship panel (§7) and the
"has something to say" derivation (§8.4).

### 6.3 Retrieval quality (chat-first slice of RAG-improvements)

Implemented in shared `memory/`, observed through the dev inspector first: **#1** a
measured relevance floor for facts (with the pinned exemption above; in a 1-on-1 chat the
"subject present" escape hatch is trivially the partner, so the floor is safe), **#2**
per-query embedding + RRF fusion + per-source attribution in the trace, **#4** prefer
`subjectId` equality in supersedence. **#6** (the retrieval eval harness) is the
measurement precondition — build its chat fixtures alongside §5's. The session lane
inherits all four automatically.

### 6.4 "Remember this" (proposed default — plan OQ2)

Player-side and **write-only** (no browsing, per D2). The PM's three questions, answered
in the design:

- **Where it lives**: alongside other memories — a normal `facts` row via `addFacts`
  (`kind: "knowledge"`, confidence 1.0, `source_message_id: null`, the chat's memory
  group), so retrieval, supersedence, embedding and Clear/delete all just work. Two new
  columns distinguish it: `pinned: true` and `origin: "player"` (an `origin` text column
  on `facts` — `"extracted" | "player" | "dev"`, default `"extracted"` — honest provenance
  that the dev inspector also uses for its own edits).
- **Conflicts with previously stored memories**: the existing supersedence pass runs when
  the note lands — a sufficiently similar older fact about the same subject is
  automatically marked superseded and drops out of retrieval (the same "updated memory
  replaces old" machinery the archivist already uses). This is the "go back and clean up
  past memories" lever, and it's already built; conflicts too dissimilar for the
  automation (a subtle contradiction rather than a restatement) are cleaned in the dev
  inspector. A broader "consistency sweep" (re-checking the whole store against pinned
  facts at a lower threshold) is deferred until need is shown.
- **Precedence**: manual wins, structurally. Pinned facts are always retrieved ahead of
  the top-k and exempt from the relevance floor (§6.3), and the **asymmetric invariant**
  holds: archivist-extracted facts can never supersede or retract a pinned player fact —
  supersedence skips pinned targets unless the incoming fact is itself player/dev-
  authored. Only the player (or a dev in the inspector) can retire a player note.
- **UI**: a small composer affordance ("Remember this…") and/or a message hover action.
  Fenced like all authored text (data, never instructions).

## 7. A relationship that matters (plan area 6)

### 7.1 Consequential mechanics — the first stage consumers

- **`stageBehaviorProfile(stage)`** (new, in `contracts/relationships` beside the stage
  registry): per-stage behavioral bands — initiative (none → bold), openness/disclosure,
  address forms, and an **escalation acceptance floor** (what intimacy the character
  entertains at this stage). Rendered as a compact "Relationship law" block in the chat
  prompt (near Disposition; re-renders only on stage change, so it's cache-friendly).
- **Hard gate (ruled — D11)**: intimate escalation beyond the stage floor is
  _deflected in character_ — a directive in the style of the session lane's
  puppet-deflection (an in-voice "not yet", never a meta refusal) — **unless the scenario
  premise explicitly licenses it** (premise wins; an AU "we're married" scenario starts
  past the floor by construction). Dev override is simply editing the relationship state
  in the inspector (no separate switch). Two invariants: the disinhibition overlay
  (intoxication) may loosen tone but **never overrides the stage floor**, and authored
  social cards still trump everything (a taboo card deflects at any stage).
- **Soft coloring everywhere**: stage modulates the existing disposition render (a
  `stage → trait overlay` table mirroring `stateDispositionOverlays`, render-time only).
- Measured by §5's stage-contrast fixtures — this is the area most likely to need
  iteration, since today's warmth hint demonstrably doesn't land.

### 7.2 History & milestones

- `character_chat_state.relationship_history` jsonb — a capped ring buffer (≤200 samples
  of `{clockMinutes, at, affinity, stage}`), appended by the finalizer when affinity moved
  or the stage crossed. Powers the sparkline.
- `character_chat_state.milestones` jsonb (append-only, capped): first exchange, stage
  changes (both directions), strong card-driven reactions (the pulse already computes the
  tier), player-pinned moments (a "mark this moment" hover action on any message). Each
  `{at, kind, label, messageId?}`.

### 7.3 Story so far

Surface the rolling summary read-only in the relationship panel; add the long-parked
**rebuild-summary lever** (`POST …/summary/rebuild` re-folds from the full transcript —
the recovery for folded-then-deleted lines) and take the fold tuning leftovers (word
budget, recursive-vs-append drift check) as eval items here.

### 7.4 Export

`GET …/export?format=md|json` — title, scenario, participants, transcript, optional
memory appendix. (Graduates deferred #8 at chat scale.)

### UI

A **Relationship** panel/sheet on the conversation page: stage + sparkline + milestones +
story-so-far + open loops.

## 8. In-game time (plan area 7 · D3/D8)

Real time is out of the fiction entirely, and the wall-clock recovery drift is **removed
outright** (D8 — one time model, no hidden second clock). `lastInteractionAt` survives
only as Chats-list ordering.

### 8.1 Time skips (v1 semantics: proposed default — plan OQ1)

- `POST /api/chats/[chatId]/time-skip { amount: "moments" | "hours" | "overnight" | "days" }`
  — maps to in-game minutes and advances `clockMinutes`.
- **V1: time passage is narrative flavor.** The skip does exactly three things: advances
  the clock (which lets already-running timed conditions expire through the _existing_
  clock-keyed expiry — no new wiring), stamps a one-shot `pending_skip_note`, and records
  itself. **Meters do not change.** Rationale (PM, 2026-07-02): whether 12 skipped hours
  mean recovery or deterioration is circumstance (home vs. trapped in a desert) — a flat
  rule flattens the nuance, so the entire "what happens during time" system (self-care
  assumptions, schedules, circumstance-aware recovery) is deferred.
- **Scaffold, don't wire**: each skip appends `{at, clockMinutes, amount}` to a
  `character_chat_state.skip_history` jsonb ring (cap ~50), so the future time-effects
  system has its data and hooks without another migration. The explicit action chips
  (freshen / rest / drink) remain the levers that actually move meters.
- The next exchange's prompt renders the skip as a volatile one-turn line ("The next
  morning — acknowledge the gap naturally, once"), worded by stage band; the note clears
  after rendering. This is the welcome-back beat, keyed to fiction.
- **UI**: reopening a conversation shows a lightweight "Pick up: Continue · Later ·
  Next morning · Days later" strip above the composer (default **Continue** = no-op, no
  interruption — ruled); the same options live in the header menu mid-conversation. No
  modal, no forced choice.

### 8.2 A life meanwhile

Rides the same skip note: "you may weave in one line about what you were doing meanwhile,
consistent with the scenario and your personality" — prompt-only, no extra model call. If
evals show invention drifting off-premise, escalate to a tiny archivist question at skip
time (deferred until proven needed).

### 8.3 Drift, redefined

Within-visit decay (meters drifting toward personalized baselines per exchange tick) is
already in-game (`CHAT_TICK_MINUTES`) and stays. The between-visit **real-elapsed**
recovery in `driftChatState` is deleted (D8) — the seed path (fresh state = rested) is
unaffected.

### 8.4 "Has something to say" (D4 — approved experiment)

Pure derivation at Chats-list read time (no jobs, no push): `openLoops.length > 0 ||
unseen milestone`. Renders the marker; tapping sends `{kind: "continue"}` with the reason
threaded as the cue line, so the character opens _about the right thing_. Wall-clock
absence is deliberately **not** a trigger (D3).

## 9. Prompt intelligence — chat items (absorbs review §C chat-side)

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
  scenario → background → base disposition → relationship law §7.1 → attributes → sensory
  → rules) and a volatile tail (state section, memory block, disinhibition overlays, skip
  note, cue invite) — verified by a snapshot test asserting the prefix is byte-identical
  across consecutive turns with unchanged authored inputs.
- **Narrator-default inconsistency**: a headless `POST` without `model` falls back to
  `MODEL_DEFAULTS.narrative` (Aion) while the UI always sends the per-character pick
  (default GLM). Make the route default `resolveChatModelId(character.chatModel)` so both
  paths agree.
- **Intimacy-notes coordination**: if [intimacy-notes.plan.md](intimacy-notes.plan.md)
  ships, chat has no exposure mask to gate the new note — gate it on the chat side behind
  `detectChatCue` intimacy signals plus the §7.1 stage floor (or an explicit premise
  license), mirroring how intimate disposition bands are already framed ("when the moment
  turns intimate").

## 10. Option C analysis — full unification with the session engine (ruled out, D1; kept for the record)

What "chat as a micro-session" would require: minting session rows (a worldless variant
or a synthetic world), adopting `turns` (and its edit-reconciliation machinery), running
the merge reducer for a single participant, the segmenter for one speaker, and stubbing
presence/perception/exposure/wardrobe for a lane that deliberately has none. Wins: one
pipeline, free access to director-class agents and story threads. Costs: the
character-chat-primary D1 ruling already rejected fake sessions for exactly the
leaked-assumptions reason; the shared layers that matter are _already_ shared post that
arc (MemoryScope, contracts, §6 curve after §3's de-fork, narration shape, artifact
stripping, SSE/timeout helpers after §3); migration risk spans every chat table for zero
user-visible gain. **If chat ever needs a session-grade capability, port the agent, not
the lane** (e.g. a director-lite is one new leg in the existing fan-out, not a pipeline
swap). Revisit trigger: a third lane appearing, or chat needing ≥2 session-only
subsystems in one plan.

## 11. Testing & evals

- **Migration/integration**: §1 backfill (one chat + participant per legacy pair, group
  ids correct, CHECK swapped), archive vs delete semantics, memory-group isolation (a
  fresh-start chat retrieves nothing from the shared group), provenance retraction on
  delete/edit/another-take, stop-truncation persistence, pinned-supersedence asymmetry
  (an archivist fact never retires a `origin:"player"` pinned fact; a player fact does
  supersede a similar extracted one).
- **Pure**: takes eviction, pre-exchange snapshot restore, skip semantics (clock advances,
  timed conditions expire, **meters unchanged**, `skip_history` appended + capped),
  skip-note wording bands, milestone derivation, open-loops last-write, relevance floor +
  pinned exemption, stage-behavior profile rendering + the floor/premise/intoxication
  invariants (§7.1), prompt prefix-stability snapshot.
- **Degradation** (resilience rules): every new leg degrades with a diagnostic —
  inspector on retrieval failure, another-take when the snapshot column is empty (fall
  back to no-rollback + diagnostic), stop when no in-flight entry exists (404, not a
  crash), time-skip on a missing state row (seed + skip).
- **Evals** (`pnpm eval:narration`, spend, never in verify): the §5 paired-contrast suite
  (the centerpiece); skip-beat fires once and reads stage-appropriate; go-on doesn't
  repeat; dialogue/intimate craft rules move the judge rubric; takes actually differ
  (temperature sanity).

## Adopted defaults to flag (revisit on request)

- Participants are a join table from day one with app-enforced single membership (no DB
  CHECK until group chat ships); per-participant state rows; `speaker_character_id` on
  assistant messages.
- Memory groups live per participant (§1.3), not per chat.
- `characters.chatModel` stays per character (no per-chat override).
- Takes live in a jsonb on the message row (cap 4), not sibling rows.
- `pinned`, `origin`, and `source_message_id` land on the shared `facts` table (session
  lane adopts later, nothing breaks meanwhile).
- Scenario presets are a small owned table now, `LibraryKind` graduation later.
- Time-skip amounts are a fixed four-value enum mapped to minutes (no free-form
  durations); skips append to a capped `skip_history` ring (~50).
- "Has something to say" is computed at read time — no jobs, no schedules, no push.

## Open questions

Owned by the plan ([character-chat-standalone.plan.md](character-chat-standalone.plan.md)
§Open questions) — resolve there; rulings get recorded in **## Decisions** above. Two
remain, each with its proposed default already written in place: **OQ1** — time-skip v1
semantics (§8.1: flavor + condition expiry + scaffold, meters untouched; the alternative
is a flat recover-toward-rested on skip); **OQ2** — "remember this" (§6.4: pinned
`origin:"player"` fact with supersedence + the asymmetry invariant; the alternative is
keeping all memory interaction dev-only for v1).
