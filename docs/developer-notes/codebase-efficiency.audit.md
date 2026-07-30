# Codebase efficiency audit — shared abstractions, dead code, hot paths

**Date:** 2026-07-30 · **Findings record, not a plan.** Plans and specs will be
derived from this doc (likely several — see §Proposed batches at the end); when
one is created it gets its own `<topic>.plan.md` + roadmap line and should cite
finding ids from here. Eleven draft plans now exist; the reviewed near-term tranche is queued in `roadmap.md`, while the larger consolidations remain selective drafts.

**Method.** Six parallel read-only analysis agents (prior-art sweep + one per
area: chat-lane engine, simulation engine, contracts, UI/app, server infra +
scripts), plus tooling passes: `jscpd` (276 clones, ~1.9% of lines — healthy
globally, concentrated locally), `madge --orphans`, env-flag inventory. Every
zero-importer claim below was grep-verified by the reporting agent; "cleared"
sections record what was checked and found healthy so future sweeps don't
re-derive it.

**Context caveats.**
- The **narrator-physical-guidance build is active** over
  `src/contracts/affordances/**` and `src/server/engine/chat-affordance*` /
  `chat-physical-guidance*` — findings tagged **[WIP]** sit in that churn;
  coordinate before touching, and expect line refs there to have moved.
- The two product lanes (legacy chat, successor engine) are deliberate; nothing
  here proposes merging them.
- Prior art: the 2026-07-02 review ([finished/codebase-review.md](finished/codebase-review.md))
  and the parked 2026-07-23/24 stubs ([deferred/CLAUDE.md](deferred/CLAUDE.md)).
  Where a finding extends a known item it says so (`[= E-S3]` etc.). §G lists
  prior-art items this audit re-verified as still open.

**The headline shape** is the same one the 2026-07-02 review named — "patterns
re-instantiated by copy instead of extracted" — but the center of mass has
moved: the gate-by-gate simulation build (shipped 07-16→07-22) accreted the
largest consolidation surface in the repo (§A), and the duplication gate never
saw it (`jscpd` runs with `minTokens: 70` + a **global** 3% threshold over
`src` only — local hot spots pass under the repo-wide budget, and `scripts/`
isn't scanned at all; see F1).

---

## §A — Simulation engine (`server/engine/simulation`, `lib/simulation`, `contracts/simulation`)

~78k LOC in scope. The single richest consolidation surface.

- **A1 · `runSimulationCommand` call-site boilerplate — 46 sites, ~1,100 lines.**
  M/low. The shell (`command-runner.ts:53-73`) demands 8 fields per site, 6 pure
  ceremony: `"That world branch is unavailable."` appears **95×** repo-wide;
  `status:"conflict"` blocks 49×; `rejectedResult<TCode>` has **15 verbatim
  local copies** (+2 renamed). `createCommandResultSchema`
  (`contracts/simulation/envelopes.ts:156`) already guarantees the 3-arm result
  union, so the shell can synthesize the factories from `resultSchema` + one
  noun, plus an `accepted()` helper for the 49 identical return blocks.
  ~1,100 → ~60 lines across 16 files.
- **A2 · Three inlined copies of the command shell — with a real divergence.**
  M/med. `space-store.ts:471-738` / `:745-980` and `scheduler-store.ts:199+`
  predate the shell (its own comment at `command-runner.ts:25` promises "a
  dedicated cleanup"). The shell runs **5 post-accept recorders**
  (`command-runner.ts:182-192`); the space copies run 2 of 5, scheduler 0 of 5.
  Benign today (recorder type-filters exclude their event types), but
  `forkBranch` refolds **all** inherited events (`branch-store.ts:981`) — the
  moment a space/scheduler event type joins a recorder list, live and forked
  rows silently disagree, surfacing only at fork time. **This cleanup exists
  nowhere on the roadmap** (only prose at `engine.plan.md:477` + 2 code
  comments) — per the house rule, that's itself a bug.
- **A3 · Eleven byte-identical `replayXHistory` fold loops.** S/low. `cohorts.ts:288`,
  `lod.ts:400`, `materials.ts:873`, `engagements.ts:574`, `commitments.ts:910`,
  `activities.ts:1067`, `space.ts:907`, `bodies.ts:2641`, `households.ts:1509`,
  `material-condition.ts:1125` (+ `replay.ts:135`). Differ only in
  schema/sort/apply/one word. One generic
  `replayProjectionHistory({label, seed, events, schema, sort, apply, assertInvariants?})`
  in `lib/simulation/replay.ts`; ~165 → ~25 lines and the sequence-gap
  invariant stops living in eleven places.
- **A4 · Lib-resolver plumbing duplicated per domain.** S/low. `rejection<TCode>`
  ×8 (`cohorts.ts:126` even labels its section "mirrors lod.ts"),
  `isPrivilegedPrincipal` ×4, the `branch_mismatch` guard ~29×, the
  event-envelope base spread at 37 sites / 15 files. Fix: one
  `lib/simulation/resolver-kit.ts` (`rejection`, `isPrivilegedPrincipal`,
  `guardBranch`, `eventEnvelopeBase`). Contracts got this factoring
  (`envelopes.ts`); lib never did.
- **A5 · `injectCrash` ×3 + subset crash-point unions** (`material-store.ts:136-156`,
  `household-store.ts:112-132`, `social-store.ts:82-95`) → hoist into
  `command-runner.ts` with a shell-level `crashAt` hook (already noted as
  missing at `material-store.ts:127-135`). S/low.
- **A6 · Row-mapper copies from cycle avoidance — one already drifted.** S/low.
  `branchEventFromRow` ×2 byte-identical (`observation-store.ts:35-55` /
  `branch-store.ts:175-195` — straight delete-and-import, no cycle);
  `locusFromRow` ×2 (real cycle → leaf `row-mappers.ts`); the engagement row
  mapper ×2 where the copy at `space-store.ts:1013-1023` **omits
  `acknowledgedPressureIds`** — the exact masking bug the original's warning
  comment (`engagement-store.ts:57-73`) documents, re-introduced. Currently
  harmless (read/write sites verified), fix before it isn't.
- **A7 · `forkBranch` — 10 copy-pasted last-touch passes + 13 redundant sorts.**
  L/med. `branch-store.ts:403-1035` (633-line function). Fix: a `FORK_DOMAINS`
  registry (`{emptySeed, replay, rowInsert, table, lastTouchKey}`) + one
  `buildLastTouchIndex` pass → ~180 lines; "add a domain to fork replay"
  becomes a data edit; removes 12 needless re-sorts of DB-ordered arrays.
  Fork parity is the engine's correctness spine — gate corpora
  (`gate3/4/5/6-corpus.int.test.ts`) green before **and** after.
- **A8 · 13 identically-shaped `{database?; admitAtLockedVersion?}` option
  interfaces** under 13 names → one `DurableCommandOptions`. S/low.
- **A9 · Projection headers: 8 files use weak inline validators, 2 use the
  branded schemas.** S/low, **real validation gap**: the weak copies accept
  whitespace `branchId` every other boundary rejects and produce unbranded
  strings that stores defensively re-parse (`commitment-store.ts:143`). Weak:
  `cohorts.ts:86`, `commitments.ts:442`, `engagements.ts:282`, `bodies.ts:915`,
  `activities.ts:498`, `households.ts:287`, `material-condition.ts:152`,
  `lod.ts:110` (+`knowledge.ts:270`, `soft-canon.ts:335` no header at all).
  Fix: `projectionHeaderFields` in `envelopes.ts` (mirroring
  `commandEnvelopeFields`/`eventEnvelopeFields`); typecheck fallout is the bug
  surfacing.
- **A10 · Seven `readDurable*` readers repeat the branch-header read** —
  `"Simulation branch not found"` at 14 sites / 9 files → `loadBranchHeader()`.
  Also fixes an isolation inconsistency: only 2 of 7 wrap in
  repeatable-read/read-only; the other five can read torn state. S/low.

**Efficiency (hot paths):**

- **A11 · Every accepted command re-scans the same event window 5× under the
  branch write lock.** S/low — **best value-per-effort in the whole audit.**
  `command-runner.ts:183-191`: five recorders each independently
  `SELECT … FROM sim_events WHERE branch_id AND sequence > ?`, four re-parsing
  the big event union on overlapping rows. Fix: shell reads+parses once, passes
  `readonly SimulationBranchEvent[]`; recorders filter in memory (their type
  lists are already exported consts). 5 queries → 1, shorter lock hold on the
  path that serializes every command on a branch.
- **A12 · `prepareDependencyWakes` N+1** on engagement-open under the lock
  (`lod-store.ts:358-404`; sparse table so the common case is N queries
  returning nothing) → one batched `inArray` read. S/low.
- **A13 · `MAX(stable_order)` scan per armed trigger** (`trigger-projector.ts:27-30`);
  genuine N+1 inside the fork transaction (`branch-store.ts:530-554`). Fix:
  per-branch sequence/`GENERATED`, and batch the fork loop. S/low.
- **A14 · `loadActorOriginSpace` loads the whole branch topology (5 full-table
  SELECTs + full projection parse) to extract one `originZoneId`**
  (`commitment-store.ts:214-234`), and `raise_pressure` is trigger-dispatched.
  Check whether `resolveRaisePressure` needs more than the zone id; if not,
  a 2-column indexed lookup replaces it. S/low.
- **A15 · Unbatched per-row upserts** in knowledge/soft-canon incremental
  recorders (`knowledge-recorder.ts:122-167`, `soft-canon-recorder.ts:123-136`)
  — the replayed paths already batch; mirror them. S/low.
- **A16 · Snapshots are materials-only** — every other domain replays from empty
  seed over the full inherited log per fork (`snapshot-store.ts`,
  `branch-store.ts:1006-1019`). A **design decision with a correctness cost**
  (§10.4's from-zero-rebuild rationale), not a free fix — needs its own roadmap
  conversation; A7's registry is the prerequisite. L/med.

**Dead / surface:**

- **A17 · `submitDurableApplyBodyModifier` — an entire durable command handler
  with zero callers and no test** (`body-store.ts:806-890`). An unexercised
  transactional write path touching `simBodyModifiers`/`simTriggers`/branch CAS
  will bit-rot silently. Wire+test or delete (the pure resolver stays). S/low.
- **A18 · `openCoPresentEngagementsForActor`** (`lib/simulation/engagements.ts:82-92`)
  — zero refs, superseded by the SQL predicate in `space-store.ts:999-1010`.
  Delete. S/low.
- **A19 · Simulation barrel over-export: 136 of 204 names (67%) have no consumer
  outside the simulation directory** — including 20+ `submitDurable*` handlers
  and all 5 recorders — and the whole barrel re-exports through
  `engine/index.ts`. These are int-test-exercised built-but-unwired successor
  API (overlaps deferred stub D19's intent), not rot — but they bury genuine
  dead code like A17. Split the barrel to the ~68 externally-used names; int
  tests import store modules directly (largely already do). M/low.

**Cleared:** `legacy-test-mode.ts` is live (`command-authz.ts:5`); gate1/gate2
eval scripts wired in package.json; no illegitimate test skips.

---

## §B — Chat-lane engine (`server/engine` excl. `simulation`)

32k LOC; largest files `chat-state.ts` 2,910 · `prompts/character-chat.ts`
2,596 · `chat-pipeline.ts` 2,473.

**Types:**

- **B1 · `ChatState` is hand-maintained in five parallel enumerations** —
  interface (`chat-state.ts:260-388`), zod schema (`:890-920`), select list
  (`:791-821`), row→state `parseOr` mapping (`:826-882`), `upsertChatState`
  insert + 30-line `col = excluded.col` block (`:2495-2553`) — plus the drizzle
  columns. **Adding one field is 6 coordinated edits.** Fix:
  `ChatState = z.infer<storedChatStateSchema> & {…}` with the schema moved to
  `contracts/turns/`, a single `{column, schema, fallback}` table driving
  select+mapping, and the update clause generated from a `COLS` array. ~120
  lines saved, kills the drift class. L/med — **worth its own plan**.
- **B2 · `character_chat_messages.meta` has 4 partial schemas + 2 raw casts and
  no contract.** M/low. `chat-summary.ts:101-105` and `:246-250` read the JSONB
  with a bare cast — **two `docs/resilience.md` §1 violations** — while a schema
  for that exact field sits one module away. Fix: one `chatMessageMetaSchema` +
  `emptyChatMessageMeta()` in `contracts/turns/`, consumed by all
  readers/writers (server + `lib/client/api.ts:332-348`).
- **B3 · `ResolvedChatWardrobe`/`ResolvedPlayerWardrobe`** near-duplicates
  (`chat-wardrobe.ts:151-186` / `:300-310`) → shared base in contracts. S/low.

**Abstractions:**

- **B4 · The cheap-agent-leg recipe is copy-pasted at 5 sites; 4 of them
  silently lose failure telemetry** (and `chat-summary.ts:256-265` has **no
  timeout at all** and silently uses the narrator model). M/low. Sites:
  `chat-memory.ts:234-292` ✓✓, `chat-state.ts:1432-1481` ✓✓,
  `chat-scene-sketch.ts:117-151`, `chat-meanwhile.ts:173-207`,
  `chat-vision.ts:71-90`, `chat-summary.ts`. `resilience.md` §8 already names
  the gap. Fix: `runAgentLeg({system, prompt, schema, fallback, timeoutMs,
  code, trace, sink})` in `src/server/ai` — telemetry by construction.
- **B5 · Degraded constructors hand-listed at 4 call sites**
  (`chat-memory.ts:440-526`) against resilience.md §1's "empty*() next to the
  schema" rule; the correct pattern exists one function over
  (`degradedChatPersonalNotes`, `contracts/turns/chat-archivist.ts:422`).
  Export the three missing constructors. S/low.
- **B6 · `foldOutfitProposal` / `foldPlayerOutfitProposal` structural twins**
  (`chat-state.ts:1542-1577` / `:1597-1631`; `settleEnsembleMember` `:2444` a
  third degenerate copy) → one core + two field adapters; also concentrates the
  B12 batching fix in one place. M/low.
- **B7 · The resolved-attribute → prompt-line filter loop appears 6× in
  `prompts/character-chat.ts`** (`:1003`, `:1401`, `:1657`, `:1947`, `:2428`,
  `:2494`) **+ 4× in `images/prompts.ts`** (`:289`, `:804`, `:856`, `:977`) —
  and the copies have **already drifted** (different guard sets). A missed
  guard leaks raw attribute ids into the narrator prompt. Fix:
  `promptableAttributes(resolved, realizedBody, {skipIds, extraSkip})` in
  `prompts/profile-sections.ts`; snapshot-covered. M/low-med.
- **B8 · Solo vs ensemble transient prompt blocks near-verbatim** (~50 lines,
  `:1905-1965` vs `:2456-2514`) → parameterize on `{subject}`. S/low.
- **B9 · `messageExistsGuard`** — the same 3-line SQL exists-guard at 5 sites
  (`chat-state.ts:702,744,939,2515`, `chat-pipeline.ts:2095`); it is the
  atomicity primitive for every guarded write. S/low.
- **B10 · The pre-turn "exchange cut" is assembled twice** — `loadChatPreviewCut`
  (`chat-pipeline.ts:2256-2292`) re-implements the live path's 8-step assembly
  (`:696-1035`), and its own doc comment names drift as the one thing a debug
  view must never do. Shared `loadExchangeCut()`. M/med.
- **B11 · [WIP] The second inspector-preview stack is a ~45% copy of the first**
  (`chat-affordance-preview.ts` vs `chat-physical-guidance-preview.ts`; routes
  byte-identical; panels share 112 lines incl. `Row`/`Stage`/frame). Factor
  `inspectorPreviewRoute()` + `<InspectorPreviewPanel>` **before a third
  arrives** — coordinate with the active plan. M/low.

**Efficiency (pre-reply latency is player-perceived):**

- **B12 · `character_chats` SELECTed 3–4× sequentially before the stream
  opens** — `chatOwnerId` (`chat-pipeline.ts:2005`), `loadChatScenario`
  (`chat-state.ts:657`), then `resolveChatPersona` re-selects `player_state`
  **already in hand** (`players/persona.ts:68-77`). Return `ownerId` from
  `loadChatScenario`, pass `personaId` in. Removes 2 round trips. S/low.
- **B13 · `items` SELECTed 5–11× per exchange, none batched** — incl. two
  *sequential independent* awaits at `chat-pipeline.ts:1021/:1029`. Cheap:
  `Promise.all` + one worn∪pool query per fold. S/low.
- **B14 · `finalizeChatState` ends in 4 sequential writes where 2 phases
  suffice** (`chat-state.ts:2267-2326`) — shortens the exchange-lock hold that
  makes fast re-sends 409. S/low.
- **B15 · `realizeBody`/`resolveAttributes` recomputed 2–3× per ensemble member
  per turn** (`character-chat.ts:2419/:2480/:2209`; `:2426/:2487/:2488`) —
  pure functions; hoist per member. S/low.

**Dead / surface / size:**

- **B16 · Zero-ref exports:** `chatGarmentStoreOf` (`chat-garments.ts:358`),
  `CHAT_PULSE_EVERY_N` (`constants.ts:64` — a knob nothing reads; the pulse
  runs unconditionally) `[= E-K4]`. **33 more exports referenced only in their
  own file**, all leaking through the engine barrel, several with stale
  "exported for tests" comments (e.g. `chat-scene-sketch.ts:82`). One
  mechanical de-export pass. S/low.
- **B17 · Deliberate, NOT dead (recorded so no future sweep rediscovers it):**
  `CHAT_AFFORDANCE_CUES` gates ~480 lines (`chat-affordance-cues.ts`,
  persistence at `chat-state.ts:2055/:2315`, preview) — parked OFF permanently
  by trial ruling, retained as validated-wording reference + live eval-harness
  arm (`prompts/constants.ts:130-165` documents this). `chat-affordances.ts`
  itself is live (3 consumers).
- **B18 · Size, mechanical-split candidates:** `submitChatMessage` ~1,335 lines
  in one function (`chat-pipeline.ts:460-1794`, ~25 mutable `let`s,
  comment-delimited stages); `finalizeChatState` 722 lines
  (`chat-state.ts:1642-2363`). Snapshot/test coverage is good. L/med each.
- **Cleared:** zero legacy world/session references in the engine scope — R6 is
  clean here.

---

## §C — Server infra (`server` excl. engine; `lib`; `scripts`)

- **C1 · The image-generation pipeline skeleton is written out 6×** —
  `createImageAsset → produce → saveImageBuffer / failImage → logEvent` at
  `avatar.ts:62-100`, `entity.ts:38-85`, `variants.ts:43-85`,
  `chat-look.ts:151-181` + `:206-224`, `scene.ts:200-249`. Fix:
  `runImagePipeline()` in `images/assets.ts`. **Highest-value dedup in this
  area.** M/low-med.
- **C2 · Venice result-unwrap ×5 in src, ×8 in scripts** → `unwrapVeniceImage()`
  in `server/ai/venice.ts`. S/low. **C3 ·** two byte-equivalent batch loops
  (`generateAvatarsBatch`/`generateEntityImagesBatch`) → `runInBatches()`.
  S/low. **C4 ·** "load image row then read bytes" ×4 + jsonb-meta narrowing ×3
  → `loadImageBytes()`/`imageMeta()`. S/low. **C5 ·** select-delete-unlink ×3
  outside `assets.ts` (+4 unlink-many copies inside it) → `purgeImagesWhere()`.
  S/low.
- **C6 · Per-kind table dispatch: 13 hand-written branches, ~185 lines** across
  `api/visibility.ts:32-67`, `api/clone.ts:27-119`,
  `memory/library-search.ts:141-195` → one `LIBRARY_TABLES` registry (exactly
  the CLAUDE.md registry shape). Pairs with **C7 ·** `TABLE_NAMES` declared 3×
  (two byte-identical). M/low-med.
- **C8 · Event-log read+tally ×3** (`agent-failure-log.ts` ×2,
  `composition-fallback-log.ts`) → `readEventLog<T>()`. S/low.
- **C9 · `errorText` ×9 identical, `round` ×4** `[= E-E2, now recounted]` →
  both to `src/lib/` (pure; scripts can import). S/low.
- **C10 · FNV-1a hand-rolled 5× in two constant spellings** (hex vs decimal) —
  two copies are load-bearing determinism seams (forge reproducibility,
  chat-look cache key) where silent divergence is invisible →
  `fnv1a32`/`fnv1aHex` in `src/lib/`. S/low.
- **C11 · `scripts/eval/*` runners share a harness that doesn't exist** —
  byte-identical `parseArgs` loops, 4 `EVAL_OUT` defaults (mixed `??`/`||`),
  7 exit-footer copies with **inconsistent pool cleanup** (present ×3, absent
  ×2), 5 venice-edit-save copies → `scripts/eval/harness.ts`. Also: `../../..`
  vs `@/` import drift; eval output written to `docs/scene-image-eval/`
  against the "never docs/" rule (`refsheet-variants.ts:24` + 4 siblings).
  M/low.
- **C12 · Resilience gap — no LLM call outside `src/server/engine` is
  time-boxed or telemetried.** M/low, **arguably the highest-severity single
  item**: `character-forge.ts:685/:988/:1341` (inside `POST /api/characters/forge`),
  `portrait-attributes.ts:127`, `api/item-classify.ts:284/:317`,
  `images/scene.ts:49` (runs on **every** scene render). A hung provider hangs
  the request to the socket limit; timeouts are never recorded (`grep
  maxDuration src` → zero). Degraded defaults already exist — wrapping in
  `withGenerateTimeout` is pure upside per resilience.md §3. Folds naturally
  into B4's `runAgentLeg`.

**Efficiency:** **C13 ·** `aliasMatch` full-library JS scan
(`library-search.ts:126-138`) → SQL jsonb exists-query. **C14 ·** `addFacts`
~30 sequential statements per post-turn archivist batch (`facts.ts:217-287`;
batching changes later-draft-supersedes-earlier semantics — needs a deliberate
call, M/med). **C15 ·** independent awaits sequential on the pre-reply path —
notably `embedText` before `maxTurnNumber` twice (`episodes.ts:176/:278`) →
`Promise.all`. **C16 ·** seed re-embeds ~45 rows one at a time
(`db-seed.ts:177-179`) while `embedTexts` batches natively. **C17 ·**
`materializeSuggestedItems` fully sequential per suggestion inside character
save (`api/library.ts:290-372`). **C18 ·** one-DELETE-per-link
(`api/library.ts:460-473`) and one-UPDATE-per-item (`item-classify.ts:328-336`)
→ batch. All S/low except C14.

**Dead:** **C19 ·** `location_links.travel_minutes` written only by its DB
default, read nowhere (R6 relic; drop-column needs a migration+deploy — or
`@deprecated` comment until library travel is planned; update
`docs/database.md:24`). **C20 ·** zero-ref exports: `composeItemDefinition`
(`api/library.ts:375`), `findCharactersByName` (`authoring/library.ts:34`),
`LORE_MIN_SCORE`/`LORE_RETRIEVAL_LIMIT` (a "lore channel" that doesn't exist),
`daylightBand` + const (`lib/clock.ts:62-85`), 4 test-support helpers (check
git-log first — sometimes built a slice ahead). **C21 ·** ~22 over-exported
internals (check sibling tests before narrowing). **C22 ·** stale one-off
scripts: `tmp-scene-diag.ts` (raw `pg.Client`, `rejectUnauthorized: false` —
delete), `backfill-image-references.ts` + its package script,
`delete-avatar-expression-frames.ts`. All S/low.

**Cleared:** no legacy-auth remnants; all 26 non-sim tables have live readers;
LLM scaffolding is *not* duplicated (`generateChecked` owns the ladder — the
problem is the C12 gap); singletons cached correctly; drizzle row types derive
from `$inferSelect` everywhere checked.

---

## §D — UI (`app`, `components`, `lib/client`)

- **D1 · Five library editor pages share ~140 lines of identical scaffolding
  each (≈685 total)** `[completes E-U1]` — state block, draft seed, generation-
  guarded `save()`, `clone()`, `remove()`, `useAutosave` call, loading/error
  branches, foreign-public preview, header row — interleaved with 2–5-line
  per-entity diffs, which is exactly why jscpd's token floor misses it. Fix:
  `useEntityEditor<TForm, TDetail>` + `<EntityEditorShell>`. L/med.
- **D2 · Route clones:** 4 byte-identical clone routes; 2 identical batch-image
  routes `[= E-S3]`; 2 near-identical single-image routes → three factories in
  `server/api/`, route files become 2-line re-exports (the existing
  `admin/self` idiom). ~180 lines, 8 hand-patch sites. S/low.
- **D3 · Library list GET/POST boilerplate ×5** (`characters|items|locations|
  social-cards|personas/route.ts`) → `parseLibraryListParams()` +
  `reorderByIds()` + `libraryCreate()`. M/low.
- **D4 · `withOwnedEntity` exists but 1 of 5 `[id]` routes uses it; the
  owner-strict lookup is hand-written 6×** `[extends E-S1]` → generic
  `findOwned(table, ownerId, id)`; keep the ownership-tripwire census green.
  S/low.
- **D5 · Confirm-dialog hand-rolled 11×** — and the 5 editor copies **fail to
  busy-guard Cancel/onClose** (dismissible mid-delete) while the other 6 guard
  correctly → `<ConfirmDialog>` fixes the inconsistency in one place. S/low.
- **D6 · `outfit-editor` ↔ `chat-wardrobe-editor` ~110 lines copied** (the doc
  comment claims reuse that isn't there) → `useClothingSlotPicker` +
  `<WornItemRow>`. M/low.
- **D7 · Async tri-state shell ×21, `ErrorState` ×25** → `<AsyncSection>`
  render-prop. S/low.
- **D8 · `useDebouncedValue` has zero importers while 3 components hand-roll
  debounce** — and `docs/ui.md:49` documents the hook as used where it isn't.
  Adopt at 3 sites or delete + fix doc. S/low.
- **D9 · Deleted-lane leftovers:** `app-shell.tsx:39` dead `/sessions/` branch;
  `app/layout.tsx:14` meta description still sells the deleted world model
  (ships on every page); `lib/client/api.ts:230` probes `"session"`/`"world"`
  envelope keys; `entity-library.tsx:88` stale comment. S/low.
- **D10 · Vocabulary hard-coded against the registry rule:** location scales
  ×5 (`db/schema.ts:810`, `server/api/schemas.ts:88`, `lib/client/api.ts:577`,
  `location-editor-page.tsx:28`, `library-facets.ts:62`), clothing-layer labels
  ×3 → contracts own them. S/low.
- **D11 · The client request path is untyped end-to-end** — 12 `body: unknown`
  API methods, 22 call sites passing local form interfaces. `server/api/schemas.ts`
  already imports only zod + contracts → move to `contracts/api/requests.ts`,
  type the client with `z.infer`. M/low.
- **D12 · Chat transcript re-parses every message on every streaming token.**
  M/med. `setLines` per token chunk re-renders the 100-row page;
  `MessageBubble` unmemoized; each line re-runs the full segmenter/markup
  pipeline (~700 lines of tokenizer) — 100 passes per token. Memoization is
  currently defeated by fresh-identity `rosterNames` (`:1041`),
  `[...lines].reverse().find` (`:1046`), unmemoized `sceneAnchors` (`:155`),
  and 8 inline-arrow props. Fix in that order, then `React.memo(MessageBubble)`
  + parse-memo on `[content, knownNames]`. (Component decomposition itself is
  parked as G25 — cite, don't duplicate.)
- **D13 · `@/contracts` barrel drags ~39.7k lines (incl. ~17.5k
  affordances+simulation never referenced by client) into 41+ client modules;
  no `sideEffects` field so nothing reliably tree-shakes.** Cheapest: add
  `"sideEffects": false`; alternative: drop `./affordances` + `./simulation`
  from the barrel (deep imports already precedented). Verify with
  bundle-analyzer. M/low. (Contracts fixture barrels compound this — E8.)
- **D14 · No-cache refetch of identical lists across pages** (3× character
  list, 2× chats; dashboard fetches full lists to render slices). docs/ui.md
  rules out react-query → tiny TTL map behind `apiGet`, opt-in; fold into D7.
  M/low. **D15 ·** `dashboard.tsx` imports `ChatSayMarker` from the whole
  chats-page module → move to its own file. S/low.

**Cleared:** page shells thin; `admin/self` shims deliberate;
`relationships-editor` vs `chat-relationships-editor` model different data;
zero-importer sweep otherwise clean; `character-chat.tsx` is the live editor
Chat tab.

---

## §E — Contracts (`src/contracts` excl. simulation)

**Correction:** `world/` and `turns/` are **not** R6 leftovers (26 / 34
external importer files — the busiest folders). The real orphans:

- **E1 · `personality/puppet.ts`** — whole file test-only; its documented
  caller (`engine/scene.ts`) and input (`turns/intent-brief.ts`) were deleted
  in R6. Delete + note in `npc-puppeting.deferred.md`. S/low.
- **E2 · `relationships/authored.ts`** — describes deleted `world_cast`
  machinery; only non-test ref is a **dead type import at `db/schema.ts:19`**.
  Delete both. (`stageToBandIds` in `bands.ts` is separate and live.) S/low.
- **E3 · `items/garment-blueprint-validation.ts` — 303 lines never called in
  production, and a live resilience gap.** M/med. The jsonb ingest path uses
  the shape-only schema (`garment-instance.ts:394` `.catch({})`), so the
  part-graph invariants (cycles, orphans, coverage) are **never enforced at the
  trust boundary**. Either wire `parseGarmentBlueprint` into the store schema
  (resilience-correct) or delete the module + test. The one contracts finding
  with a correctness dimension.
- **E4 · `relationships/bond.ts` + the stage-behavior half of `profile.ts`** —
  test-only session-lane concepts (`escalationTiers` is live via `law.ts` —
  keep). Delete the rest + update `docs/contracts/relationships.md`. S/low.
- **E5 · 51 exports referenced nowhere in src/scripts** (full per-file table in
  the audit worksheets; spot-verified). Several are `z.infer` aliases of live
  schemas — cheap to delete, harmless to keep. One mechanical pass. S/low.
- **E6 · `rules/index.ts`** — dead 1-line barrel (consumers deep-import
  `attribute-rule`); also the only madge orphan besides D8. Delete. S/low.
- **E7 · `mood/`: of 56 exports, exactly 4 reach outside contracts.** Dead:
  all of `atmosphere.ts` + the baseline-shift half of `events.ts`
  (`atmosphereMoodBaselineShift`, `CONDITION_MOOD_BASELINE_SHIFTS`, etc.).
  **Interacts with prior-art E-K1** (fold condition vocab into the catalog) —
  deleting may moot it; decide together. S/low.
- **E8 · ~850 lines of test fixtures ship in the public `@/contracts` surface**
  [WIP] — 4 `fixtures.ts` barrel re-exports (appearance-features, recognition,
  garment, hair) reaching 73 client barrel-importers. Drop the barrel lines;
  rename `*-test-fixtures.ts` (the `items/` convention). S/low.
- **E9 · [WIP] Verbatim duplication across the two affordance domains** — 4
  byte-identical helper bodies (`readInput`, band comparison, `*Suppressed`,
  payload-schema build) whose comments admit the copy ("second instance").
  Hoist into `affordances/core` (domain-agnostic; the neutrality test keeps it
  honest) **before the third domain lands**. S/low — coordinate with the
  active plan.
- **E10 · Lenient-zod idioms ~60 sites with no shared helper** — the helper
  exists but is **private** (`cappedText`, `drives.ts:35`). Promote to a
  `contracts/lenient.ts` (peer of `diagnostics.ts`): `cappedText`,
  `lenientString`, `lenientFlag`, `cappedArray`, `cappedRecord`,
  `lenientItems`. Migrate incrementally; densest files: `garment-instance.ts`
  (47 `.catch(`), `chat-archivist.ts` (40), `agent-failure.ts` (33). M/low.
- **E11 · `["left","right","center"]` ×3** — unify under `body/locations`;
  **respect the frozen seam** in `locus.ts:14-16` (re-alias, don't remove).
  S/low. **E12 ·** multimap-index build loop copy-pasted between attribute and
  trait registries → `buildMultiIndex` in the spine. S/low.
- **E13 · `bodyLocationRegistry.expand()` recomputes the subtree on every
  call** — immutable 48-node tree, 12 call sites, several triple-nested and on
  the per-turn wardrobe-visibility path. ~8-line memo + `isWithin()` descendant
  set. S/low — **best value/effort in contracts**.
- **E14 · `forBodyLocation`/`forCategory` linear-scan 144 defs per call**
  (`attributes/registry.ts:80-81`; alias lookup on the next line IS indexed).
  Worst site `species/targets.ts:121-124` compounds with E13 (~1,440
  comparisons per resolution, per prompt build); trait registry has the same
  linear `forCategory` inside a React render map. Map-index both. S/low.
- **B3-deferral note:** the `turns/` proposal-trace unification
  (`chat-surface-ops` ↔ `chat-garment-ops`) is deliberately deferred until the
  surface trace is persisted — the code comment names that trigger.

**Cleared:** drying math single-owner via `lib/fixed-point`; the 4-module
coverage layering is deliberate with stated boundaries; `editDistance` single
impl; hair attribute-maps already unified; `restraint.ts`/`bulk-restraint.ts`
correct as built; `bodyPlans` one-element registry is documented
forward-compat — don't collapse; `guidance/test-support.ts` correctly
barrel-excluded.

---

## §F — Tooling & process findings

- **F1 · The duplication gate has structural blind spots.** `.jscpd.json`:
  `minTokens: 70` + **global** 3% threshold + `path: ["src"]`. Consequences
  seen in this audit: the 11 replay loops and 46 command-boilerplate sites pass
  under the global budget; the 5-editor scaffold's interleaved diffs fall under
  the token floor; `scripts/` (the eval-harness duplication, C11) is invisible.
  Fix: add `scripts` to the path; consider per-folder thresholds or a lower
  minTokens for targeted paths. S/low.
- **F2 · `lint:authz` gate-list omission — closed 2026-07-30.** The audit found
  the root `CLAUDE.md` omitted a gate already present in `package.json`'s
  `verify` chain. Commit `66ecd3b` added it to the required sequential list.
- **F3 · Roadmap hygiene:** (a) the §Next line "Codebase-review follow-on
  batches (2 & 4)" is stale in substance — most §C/§E session-side targets were
  deleted by R6; what genuinely survives is C7's forge half (queued under
  `character-schema.plan.md`), C8's `STYLE_SUFFIX`, and the §E items
  re-verified in §G below — re-scope or replace that line when planning from
  this audit. (b) The sim command-shell migration (A2) and forkBranch registry
  (A7) exist only as code comments — they need roadmap lines when batched.
- **F4 · Doc drift found in passing:** `docs/ui.md:49` (D8),
  `docs/database.md:24` (C19), `unconsumed-character-prose.md` describes the
  deleted session lane, plus the doc-comment lies in D6/B16.

---

## §G — Prior-art items re-verified as still open (cite, don't re-discover)

From [finished/codebase-review.md](finished/codebase-review.md) §E unless
noted; deferred stubs in [deferred/CLAUDE.md](deferred/CLAUDE.md):

- **E-K1** condition vocab split (`mood/events.ts:120` vs `conditions/catalog.ts`) — interacts with E7.
- **E-K2** concept sets outside the registry (`TOUCH_CONCEPTS`, `SURPRISE_CONCEPTS`, `FLIRT_CONCEPTS`).
- **E-K3** `modulates` inert on 8+ trait definitions — wire-or-delete.
- **E-K4** still dead: `MoodEvent`, `dispositionTagIds`, `resolveLexicon` (test-only), `CHAT_PULSE_EVERY_N` (all re-confirmed in §B/§E). Now **live** (don't delete): `expandBodyTarget`, `conceptIdsInFamily`.
- **E-K5** species registry split / `AttributeParseResult` duplication.
- **E-S1** `findOwned` half-done → subsumed by D4. **E-S3** image route twins → subsumed by D2.
- **E-U1** editor scaffold (autosave half shipped) → subsumed by D1. **E-U3/U4** shared primitives + `arrayOf` ×3 → D5/D7 + C-area `arrayOf` consolidation (`api-shadow.ts:8`, `api-inspector.ts:13`, `lib/client/api.ts:180`).
- **E-E2** `errorText` → C9 (recounted at 9).
- **C7 (forge prompts)** / **C8 (`STYLE_SUFFIX`)** — queued under `character-schema.plan.md`; not new work.
- **Deferred stubs that overlap this audit** (intentionally retained, cite the stub): **D19** built-but-uncalled branch/fork/replay primitives (context for A19), **G25** `chat-conversation.tsx` decomposition (context for D12), **G27** inline memory-index drain (the known sim latency item alongside A11), **B8** starter-world seeds (cheap win, unrelated lane).

---

## Review disposition and owner rulings — 2026-07-30

The audit is accepted as a strong findings record, but the eleven plans are not
eleven equally valuable "efficiency" projects. Correctness, measured player
latency, fork parity, and extension safety outrank line count and theoretical
bundle reach.

### Settled rulings

- **Garment validation (E3): wire it.** Census existing rows first; new writes must
  enforce graph invariants and invalid historical rows degrade with diagnostics.
- **Snapshots (A16): materials-only.** Revisit only after real long-world fork
  measurements.
- **Suggested items (C17): preserve sequential insert visibility.** Optimize reads,
  not write ordering.
- **Travel duration (C19): retain `travel_minutes`.** It is reserved for the
  authored travel-duration plan; annotate rather than drop it.
- **Condition mood shifts (E7/E-K1): retain and consolidate the vocabulary.** Do
  not activate new behavior in a cleanup.
- **Client cache (D14): drop it.** No cache without a measured problem and
  invalidation contract.
- **Body-modifier command (A17): caller plus integration test, or delete the
  durable handler.** The pure resolver remains either way.
- **Non-chat telemetry:** use an app-wide run context with optional chat linkage.
- **Editor work:** ship `ConfirmDialog` first; reassess the full scaffold after the
  destructive-action defect is fixed.
- **Image consolidation:** preserve lane return types; standardized diagnostics are
  an intentional resilience improvement, not neutral cleanup.

### Scope corrections

| Plan | Reviewed boundary |
| --- | --- |
| Resilience closures | Harness only targeted non-streaming structured/background LLM legs; do not force streaming narration or image providers through it. |
| Sim command shell | Split the wide migration by domain; take A11 early; defer A13's counter/migration; corpus proof is mandatory. |
| Fork registry | Registering an implemented domain becomes data; implementing a domain does not. Composite last-touch keys are required. |
| Chat latency | Repeated baseline before changes; deterministic B14 persistence/rollback tests in addition to manual Fly checks. |
| Library registry | Registry simplifies dispatch and route coverage, not the whole product surface for a new kind. |
| Client safety | D10/D11/D12 approved. D13 begins with the Next 16 bundle analyzer; reachable LOC is not shipped bytes. |
| Contracts hygiene | E13/E14 move early; E10 migrates incrementally; E5 joins the dead-export pass. |
| Tooling | F2 already shipped; tighten clone detection by targeted path rather than a global token-floor drop. |

### Reviewed execution sequence

1. Finish the active narrator-physical-guidance work until its shared files are quiet.
2. Resilience closures, including garment validation.
3. Cheap hot-path tranche: A11, E13/E14, and the already-shipped F2 instruction fix.
4. Chat pre-reply latency, after a repeated timing baseline.
5. Sim command-shell consolidation, then the fork registry.
6. Image-pipeline consolidation.
7. Client D10/D11/D12; run the D13 measurement but make bundle changes only on evidence.
8. Library-kind registry and route factories, without write batching.
9. `ConfirmDialog`, then a separate go/no-go on the full editor scaffold.
10. Contracts, dead-export, eval-harness, and tooling hygiene last, except the
    explicitly safe early deletions named in their plans.

Only steps 2–4 are queued as the near-term cleanup tranche. Steps 5–10 record
dependency order and scope, not a promise to run a cleanup epic ahead of product
work.

## Original plan batches (plan-derivation record)

These are the eleven batches used to produce the draft plan files. Their original
severity-over-risk order is retained for provenance; the reviewed execution order
and settled scope above are authoritative.

1. **Resilience closures** — C12 (+B4 harness as its vehicle), B2, B5, E3.
   The only findings with correctness/severity weight. Mostly S/M effort.
2. **Sim command-shell consolidation** — A1, A3, A4, A5, A6, A8, A9, A10 +
   hot-path A11–A15, then A2 (shell migration; closes the fork-parity hazard).
   Biggest line-count payoff in the repo (~1,600+ lines) and the A11 lock-hold
   win. A2/A7 **must** get roadmap lines (F3b).
3. **forkBranch domain registry + snapshot ruling** — A7, then A16 (owner
   decision). Gated on the corpus suites; separate from batch 2 by risk.
4. **Chat pre-reply latency micro-batch** — B12, B13, B14, B15, C15. All
   S/low, all player-perceived.
5. **Library-kind registry + route factories** — C6, C7, D2, D3, D4 (+C13,
   C17, C18 batching while in there). Closes E-S1/E-S3.
6. **Image pipeline consolidation** — C1–C5, C10.
7. **UI editor scaffold + primitives** — D1, D5 (fixes a real dismiss-mid-
   delete inconsistency), D6, D7, D8 (+E-U3 primitives if wanted).
8. **Client type-safety + bundle** — D10, D11, D13, D15; D12 as its own
   perf item (coordinate with G25); D14 optional.
9. **Contracts hygiene sweep** — E1, E2, E4–E7, E11, E12 deletions/unifications
   + E13/E14 registry indexing + E10 lenient-zod module. E8/E9 coordinate with
   the active affordance WIP.
10. **De-export + dead-file sweep** — B16, C19–C22, A17–A19, E5 remainder, D9.
    One mechanical pass with the caveats noted (test-support git-log check,
    D19 intentional retention, barrel splits).
11. **Tooling/process** — F1, F2, F4 doc fixes, C11 eval harness; fold F3a
    (roadmap re-scope) into whichever batch is planned first.

**ChatState single-source (B1)** and **`submitChatMessage`/`finalizeChatState`
decomposition (B18)** are each large enough to be their own plan when wanted;
B1 pairs naturally with B2.
