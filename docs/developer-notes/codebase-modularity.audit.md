# Codebase modularity audit — large-file splits & shared-code candidates

Status: reference (audit run 2026-08-06)

Eight parallel per-domain reviews of `src/` (excluding `src/test`, `src/server/test-support`, and all `*.test.ts` / `*.int.test.ts` files). Two questions per domain: which files are large enough to burn agent context on every read **and** have real seams for splitting, and where would shared code cut substantial LOC (bar: ~40+ lines saved or a structural pattern in 3+ places). All line numbers below were read, not inferred.

Companion to [codebase-efficiency.audit.md](codebase-efficiency.audit.md) (2026-07-30) — overlaps with its §C findings are marked `[known C#]`. That audit had no file-size analysis; the split section here is all new.

**Ownership, as of 2026-08-07: mostly none.** Three of the `[known C#]` tags
land on plans that already exist — C6/C7 on
[library-route-registry.plan.md](library-route-registry.plan.md) and C12 on
[resilience-closures.plan.md](resilience-closures.plan.md) — and the components
editor-shell cluster restates D1, owned by
[editor-scaffold.plan.md](editor-scaffold.plan.md). The `[known C8]` and
`[known C9]` tags name findings the earlier audit filed but assigned to no
batch, so they are unowned too. **Everything else here — all sixteen file
splits, the engine-sim and contracts and lib scaffolding clusters, and the nine
correctness-flavored findings — has no plan and no roadmap line.** Nothing in
this document is committed work until it does.

**Update 2026-08-13:** a first tranche shipped via
[monorepo-simulation-core.plan.md](monorepo-simulation-core.plan.md) slice 4
(PR #107): the four image-lifecycle splits (`identity-packs`,
`identity-pack-trial`, `image-lab`, `prompts` — note `identity-pack-trial`
had doubled to 3,139 lines since this audit), the §Engine-sim R4 leaf-module
extraction with the `body-store` and `household-store` splits, the R3
`compareStableText`/`sortedUnique` strays, and the
`meterViewOf`/`lastSleepEndedAtOf`/`collapseContextOf` dedups (the pure
kernels now live in `@vesper/simulation-core`, which the intervening
extraction created). One claim proved stale: the "3 import cycles" were
latent — madge was green before and after; what the leaf modules dissolved
was the duplication-forcing constraint. Still unowned: the `db/schema.ts`,
`chat-pipeline.ts`, `chat-state.ts`, `prompts/character-chat.ts`,
`chat-conversation.tsx`, `chat-contact-adapter.ts`, `sim-exchange.ts`,
`client/api.ts` and `character-forge.ts` splits, and the remaining dedup
clusters.

## Headline

- **16 files exceed 1,500 lines; every one has a concrete split proposal below.** The worst: `db/schema.ts` (3,980), `chat-pipeline.ts` (3,617 — one 2,122-line closure), `identity-packs.ts` (3,445), `chat-state.ts` (3,415).
- **Dedup total ≈ 5,000 LOC** across ~40 opportunities. The three big clusters are all *scaffolding around already-good abstractions*: engine simulation stores (~1,830), contracts command/event envelopes (~850), and the `packages/simulation-core/src/lib` kernels (~750). jscpd misses all of it — each clone is short or structurally-varied.
- **Several findings are correctness drift, not just LOC** — duplicated logic that has already diverged or is one edit away from it (see "Correctness-flavored findings").
- **Several suspected wins are already solved** — route wrappers, the client fetch helper, the image-store pipeline, `generateChecked`. Verified and listed so nobody re-proposes them.

### Top splits by context burned per read

| File                                          | Lines | Split into                                      | Risk                                                   |
| --------------------------------------------- | ----- | ----------------------------------------------- | ------------------------------------------------------ |
| `src/server/db/schema.ts`                     | 3,980 | 13-file `schema/` folder, cycle-safe            | low, but human must run `db:generate` empty-diff check |
| `src/server/engine/chat-pipeline.ts`          | 3,617 | 5–6 files; previews first, `settle` last        | medium (`settle` closes over ~30 vars)                 |
| `src/server/images/identity-pack-*.ts`         | 3,445 | 8 modules along its 16 existing banners         | low-medium (module-load side effect)                   |
| `src/server/engine/chat-state.ts`             | 3,415 | 6 files by state family                         | medium                                                 |
| `packages/simulation-core/src/lib/bodies.ts`                | 2,672 | 5 files (meter kernel is the reusable core)     | low                                                    |
| `src/server/engine/prompts/character-chat.ts` | 2,624 | 6 files; snapshot tests pin it                  | low                                                    |
| `src/components/chat/chat-conversation.tsx`   | 2,246 | 8 extractions → ~650                            | medium (`runStream`/`stickRef`)                        |
| `src/server/engine/chat-contact-adapter.ts`   | 2,207 | 4 files; pure, 15 banners pre-drawn             | low                                                    |
| `src/server/engine/sim-exchange.ts`           | 2,041 | 3 files                                         | low-medium                                             |
| `src/server/images/prompts-*.ts`                | 1,930 | 8 prompt-family files                           | low (cleanest split in repo)                           |
| `src/lib/client/api.ts`                       | 1,864 | layered split + re-export barrel (66 importers) | low with barrel                                        |
| `src/server/authoring/character-forge.ts`     | 1,569 | 5 files along its own banners                   | low                                                    |

(Plus `body-store` 1,546 / `activity-store` 1,532 / `household-store` 1,465 / `material-store` 1,402 — mostly resolved by the leaf-module extraction in §Engine-sim R4 — and `identity-pack-trial.ts` 1,525, `lib/simulation/households.ts` 1,539.)

**Line-count re-check, 2026-08-07.** Every row still stands; three files grew and
none shrank. `db/schema.ts` 3,980 → **4,085**, `images/identity-pack-*.ts`
3,445 → **3,544**, `lib/client/api.ts` 1,864 → **1,877**. The other nine are
unchanged to the line. The two that moved most sit under the image-model registry
and capabilities work, so treat every number here as a floor and those two as
moving targets until that work settles.

### Top dedup clusters by net LOC

- **Engine simulation store scaffolding** — ~1,830, nine items in §Engine-sim.
  `branchResolverView` ×64, command preamble ×46, `rejectedResult` ×15, plus the
  copies import cycles forced.
- **Contracts envelope scaffolding** (R1+R2+R6) — 600–750. 49 command families,
  64 events and 12 projection headers, all hand-typed.
- **`packages/simulation-core/src/lib` kernel** (R1–R5) — 700–800. Event envelope ×37, replay
  fold ×10, `hash.ts` copies ×18, rejection/meta types ×29.
- **Components editor shell + primitives** — ~500. Five copied editor pages
  (~90 lines each) plus chip / segmented / list-editor.
- **Server-rest** (memory, api, ai) — ~475. Library kind dispatch
  `[known C6/C7]`, facts↔episodes retrieval, `errorText` ×10 `[known C9]`.
- **Engine root agent legs + ledgers** — ~460. Five hand-rolled agent-leg
  scaffolds, classifier twins, roster copies.
- **`src/app` route bodies** — ~290. Entity-kind route factories, library
  list/detail helpers, `withOwnedChat` adoption.
- **Images** — ~130. Attribute-phrase loops (the drift fix), upload merge.

### Correctness-flavored findings (drift already happened or is one edit away)

1. **`src/server/images/prompts-*.ts` attribute-filter loops have already diverged.** Six copies of filter→phrase; `intimateSceneAppearance` (1031–1040) checks neither `excludeFromPrompts` nor realized-body applicability, `sceneRevealAppearance` (1101–1117) skips `excludeFromPrompts` — the other four forbid exactly that, and nothing documents the omissions as intentional. A stale/prompt-excluded attribute can reach an image prompt on those two paths. **Partly resolved 2026-08-07:** both loops now check `excludeFromPrompts`, covered by a registry-driven sweep in `prompts.test.ts`. The realized-body applicability gap on `intimateSceneAppearance` stands — that function takes no profile, so closing it is a signature change, not a guard.
2. **Contracts projection headers split branded vs plain.** 8 of 12 `…ProjectionSchema`s validate `branchId` as `z.string().min(1)`; `materials.ts:154` and `space.ts:504` use the branded `identity.ts` schemas. `createProjectionSchema` closes the drift.
3. **Reply-evidence geometry written twice** — `npc-scene-evidence.ts:123–222` vs `romantic-permission-decision.ts:323–501` are the same sentence-walk + exactly-once quote-location algorithm (identical private `SENTENCE_BOUNDARY_RE`). A boundary fix must currently be made twice; divergence changes what counts as admissible evidence.
4. **Digest ref-assignment duplicated verbatim** (`buildNpcSceneDigest` 187–206 / `buildRomanticPermissionDigest` 141–160) while a comment *relies* on the two never disagreeing about `npc_N` assignment.
5. **Roster projections in `chat-pipeline.ts` copied 4×** feeding four *different* durable decision legs — one copy drifting changes which characters a leg can name. Plus 20 `presence === "present"` filter sites.
6. **The loose classifier transport schema + its 8-line "on purpose" rationale exists twice** (`chat-npc-scene-decision.ts:327–336`, `chat-permission-decision.ts`) — a rule that must not diverge.
7. **Serialized save-on-pick idiom ×3** (`chat-conversation.tsx:933/954`, `character-edit-page.tsx:233`) — one copy has a rollback the others lack.
8. **Stream hold-back scrubbers ×2** (`narrator-artifacts.ts:181`, `narrator-speaker-tags.ts:135`) — subtle delta-boundary logic where divergence is a user-visible streaming artifact.
9. **`sendChatMessage` sim-command methods** should mint `requestId: newId()` through one helper (idempotency invariant), and the `[chatId]/route.ts` sim fork hand-rolls a stream that duplicates `drainingStreamResponse` minus a heartbeat, including a verbatim 12-line `lastReplyFailure` write ×2 (L363–374 / L376–387).

### Verified already-solved (do not re-propose)

- **Route scaffold**: `withUser`/`withRoute`/`readBody`/`jsonOk` + `authz.ts` wrappers are fully adopted — 123 routes, zero raw error envelopes, zero direct `getCurrentUser`. Residual 3–5 lines/route is the floor.
- **Client fetch**: `request<T>` + verb helpers in `lib/client/api.ts:141–192`; every endpoint is already 1–3 lines.
- **Image generate→store**: `runImagePipeline` (`assets.ts:294`) already consolidated the six lanes; the per-lane `onSettled`/`onThrown` asymmetry is a documented ruling.
- **Trial harness**: `identity-pack-trial.ts` *calls* the pack service; it does not duplicate it.
- **LLM resilience**: `generateChecked`, `withGenerateTimeout`, `agent-failures`, `agentReasoningPlan`, `ledger-verify`, `parseOr`. (Missing timeout/telemetry on 6 non-engine `generateChecked` sites is known C12, owned by `resilience-closures.plan.md`.)
- **Sim world/fixture seeding**: soak-harness / starter-world / rollout-world already share the public seeders; their differences are genuine.

---

## src/app (9,232 lines, 161 files)

**Splits** — only three files exceed 500 lines; all three earn it:

- **`api/chats/[chatId]/sim-command/route.ts` (652)** — a 337-line 8-arm switch (`resolveCommand`, L162–520) stacked with wire contract (L45–160), idempotency shell (L522–616), and the `POST` wrapper. Split into `sim-command/contract.ts`, `commands.ts` (arms take an explicit `CommandContext`), `idempotency.ts`, thin `route.ts`. Risk: arms currently close over `sim`/`chatId`/`userId` implicitly.
- **`api/chats/[chatId]/route.ts` (515)** — schemas / GET transcript+roster envelope / POST with a hand-rolled sim streaming fork (L301–414) / PATCH+DELETE. Best move: promote the 8s heartbeat into `src/server/api/stream.ts` as a `heartbeatMs` option on `drainingStreamResponse`, collapsing the fork to ~40 lines; keep the `releaseSimLock`-in-`finally` lifecycle in one unit.
- **`api/successor-chats/route.ts` (533)** — provisioning-record layer (54–218) / `runProvisioning` (220–466, keep its compensating-cleanup contract intact) / POST+GET. GET shares zero code with POST.

**Reuse:**

- **Entity-kind route factories, ~145 LOC.** 4 clone routes, 2 single-entity image routes (line-for-line identical 53-line files), 2 batch image routes — differ only by kind string/table/label. `cloneRoute(kind, label)` / `entityImageRoutes(kind)` / `entityImageBatchRoute(kind)` in `src/server/api/entity-routes.ts`; the table-from-kind overload technique already exists in `visibility.ts`.
- **Library list/detail helpers, ~100 LOC — helpers, emphatically not a CRUD factory.** `parseLibraryListParams` (verbatim scope-narrowing ×4), `ownedOrPublicIn`, `hydrateInSearchOrder` (×5), `findOwnedRow` (five 7-line private finders — also lets `authz-matrix.int.test.ts` drive one query for all kinds), `pickDefined`. Per-kind SELECT maps, DELETE cascades, and personas' no-visibility column are real divergences a factory would fight.
- **`withOwnedChat` adoption, ~45 LOC + `lint:authz` conformance.** Wrapper exists (`authz.ts:67`) but 23 files hand-roll the 2-line lookup (29 occurrences).
- **`admin/self` shim inversion (23 files).** Implementations under `/api/admin/**` always 404 (the `withOwnerAdmin` pathname gate); the serving files are one-line re-exports. Move each implementation into its `admin/self/**` twin, delete the phantom path. Own change, low risk.

## src/components (25,365 lines, 132 files)

**Splits:**

- **`chat/chat-conversation.tsx` (2,246 → ~650).** ~40 `useState`, 9 refs, ~25 async commands, 790 lines of JSX. Extract: `chat-conversation-menu.tsx` (~185), `chat-rename-dialog.tsx` (~50), `chat-composer.tsx` (~290, incl. OOC assist + `pickAttachments`), `chat-transcript.tsx` (~180), `chat-conversation-panels.tsx` (~230), `use-chat-stream.ts` (~250 — `runStream` L566–708 + command wrappers), icons → `ui/icons.tsx`. Hard parts: `runStream`'s ~15-option closure surface; `stickRef` shared with the transcript (needs `pinToBottom()` handle); moving composer state out of `PerChatState` requires removing its 5 keys from the exhaustive reset map **and** `key={chatId}` remount — a behavior decision, flag before doing.
- **`library/entity-library.tsx` (1,079 → ~300)** — types / 165-line pure config record / `Segmented`+`FilterChip` (promote to `ui/`) / sessionStorage persistence / toolbar hook / batch-job hook / pure facet math → `src/lib/library-facet-filter.ts` / `library-cards.tsx`.
- **`characters/attribute-picker.tsx` (747 → ~250)** — first collapse the structurally-identical `BodyFeaturesSection`/`BodyConfigSection` into one `ToggleGroupSection` (−60), then `attribute-control.tsx` (~185) + `attribute-sections.tsx` (~225).
- **`items/item-editor-page.tsx` (720 → ~370)** — `item-clothing-fields.tsx` (L525–720) + `src/lib/item-fill.ts` (the fill-empty-only merge, mirroring `character-fill.ts`).
- **`gallery/gallery-page.tsx` (560 → ~300)** — pure grouping (L49–113) → `src/lib/gallery-grouping.ts`; toolbar + tile components.
- **`characters/chat-state-tools.tsx` (583 → ~400)** — admin trace block L424–551 → `chat-state-traces.tsx`; collapse the modal/dialog prop restatement (−35).
- **`characters/identity-crop-dialog.tsx` (619 → ~430)** — drag/nudge hook, copy into tested `identity-pack-copy.ts`, notices subcomponent. Moderate priority (geometry already extracted).
- Not worth splitting: `character-editor.tsx` (tab dispatcher), `chat-message.tsx`, `chat-inspector-agent-health.tsx`, `portrait-studio.tsx`.

**Reuse:**

- **★ Entity-editor shell, ~200–280 net.** Five editor pages (character/item/location/persona/social-card) share a verified identical skeleton: `useAsyncData` → draft/dirty/saving/confirmDelete/`editGenRef` → `decideDraftSeed` → `save({silent})` with edit-generation guard → `useAutosave` → `remove()` → loading/error branches → `SaveBar` + delete dialog (~85–100 lines each). `useEntityEditor<TDetail, TForm>` + `EntityEditorShell`. Divergences (persona's 409→field-error via `mapSaveError`, forge/staged pauses via `busy`/`autosaveEnabled`, tabs via slots) are all parameterizable. Do this **before** splitting item-editor/character-edit.
- **`PublicEntityPreview`, ~70** (4 near-identical read-only "someone else's public X" blocks; also fixes "Clone"/"Duplicate" copy drift).
- **`ui/filter-chip.tsx`, ~70** (exact active/inactive class pair hand-written in 7+ places; `ui/tag.tsx:12` already encodes it as the `ai` tone; add `tone: "danger"` for attribute-picker).
- **`ui/list-editor.tsx` + `src/lib/list-edit.ts`, ~55** (update/remove/add triple + identical chrome in 5 editors; `actions` slot for social-cards; 4 more server-saving surfaces adopt the chrome).
- **`InspectorSection`, ~45** (4–6 inspector panels share the identical h2/skeleton/error scaffold — the one place the skeleton really is uniform).
- **`ui/segmented.tsx` ~34** (3 copies; distinct from `ui/tabs.tsx` by design), **`BarList` ~25** (in-file twins), **`useSerializedSave` ~15** (correctness item #7).
- Rejected: `EntityImageStudio`/`PortraitStudio` merge, universal `<Async>` wrapper.

## src/contracts (58,497 lines, 316 files)

Placement rule verified: contracts↔lib are peers with bidirectional imports today — shared helpers land **inside `src/contracts`**. Splitting is cheap: flat `export *` barrels mean one added line per new file.

**Reuse (do R1+R2+R6 first — they shrink the split candidates):**

- **★ R1 `defineSimulationCommand`, ~380–450 LOC.** 49 command families across 18 `simulation/` files hand-type the same quadruple (envelope call, rejection array, `z.enum`, result call — 906 measured lines). All 49 rejection arrays open with the identical `"invalid_command"/"duplicate_command_id"/"branch_mismatch"` prefix (147 verbatim lines). Factory in `simulation/envelopes.ts` + `SIMULATION_COMMAND_BASE_REJECTION_CODES`; keep all public names via re-export (zero churn for ~200 external references). `z.infer` type aliases are irreducible — leave them.
- **R2 event-envelope one-lining, ~190–250.** 64 events × the same 5-line spread (no formatter enforces it — repo has no prettier). Single-line or `defineSimulationEvent`.
- **R6 `createProjectionSchema`, ~35 + closes drift** (correctness item #2).
- **R3 `turns/reply-evidence-geometry.ts`, ~60–90 + removes the parallel-maintenance hazard** (correctness item #3). The romantic version is a strict generalization (`kinds` parameter).
- **R4 `turns/classifier-output.ts`, ~45** — `closedRefSchema`, `boundedIssues`, JSON-preflight duplicated between the two decision files; leave the 3-state vs 2-state slot semantics per-file.
- **R5 `assignParticipantRefs` + pair-dedupe, ~35–45** (correctness item #4).
- **R7 `eventFamily()` helper, ~50** — the 6-line type-list/Set/predicate quintuplet ×13 in `branching.ts`.
- **R8 `singleDomainFixtureReader`, ~35** (hair/garment/foot affordance fixtures).
- Rejected: enum triplets (×156 — idiomatic zod, names are the API), bounded-text/`.catch().default()` primitives (zero LOC — consistency only).

**Splits:**

- **`affordances/contact/lifecycle.ts` (1,159)** — seven independent state-machine operations; keep state+reads+shared snapshot helpers (~290), extract `lifecycle-commit.ts` (426-line commit), `-modulate.ts`, `-end.ts` (end + authorization sweep), `-replay.ts`.
- **`items/garment-noun-coverage.ts` (1,268)** — **not** the cohesive-registry exception: data map (100–277) + 11 marker vocabularies (279–669) + a 600-line clause parser (671–1268). Three files.
- **`simulation/bodies.ts` (957)** and **`households.ts` (769)** — same recipe: keep vocabulary+registry+state; extract `-commands.ts` and `-events.ts`. This recipe then applies to the other 16 command-carrying simulation files as they grow.
- **`turns/romantic-permission-decision.ts` (946)** — digest / decision (schema+parse+trigger+grounding) / 444-line deterministic validation. Do with R3/R4.
- **`turns/npc-scene-evidence.ts` (876)** — extract `npc-scene-congruence.ts` (the four per-kind verifiers, 403–790).
- **`items/garment-condition.ts` (809)** — extract `garment-condition-ops.ts` (420–809).
- **`turns/chat-garment-ops.ts` (702)** — wire vocabulary / `-resolve.ts` (286–536) / `-fold.ts` (537–702).
- **`images/identity-pack.ts` (673)** — extract wire DTOs (475–673) per the file's own stated boundary.
- **`simulation/branching.ts` (794)** — move fork/snapshot/rebuild/explanation (623–794) out; the 207-line import block is irreducible; R7 shaves the rest.
- **`items/garment-instance.ts` (631)** — low priority; extract the operations vocabulary (459–631) consumed by two other files.
- Protect as-is: `identity.ts`, `attributes/categories/*`, `meters/registry.ts`, `species/registry.ts`, `affordances/core/types.ts`.

## src/lib (23,949 lines, 70 files)

**Reuse first — it shrinks every large file (~700–800 total):**

- **R3 (easiest): delete 18 byte-identical private copies of `compareStableText` (×11) / `sortedUnique` (×7)** — `simulation/hash.ts` already exports both; two strays in `images/identity-pack-trial-*.ts`. Zero risk.
- **R1 `simulationEventEnvelope`, ~250–300.** The 10-field envelope literal at ~37 sites plus four identical private `eventEnvelope` helpers (`bodies.ts:619`, `households.ts:311`, `material-condition.ts:215`, `social.ts:526`). All divergences (schemaVersion 2 ×5, 15 derivation-version constants, sequence arithmetic) verified parameterizable.
- **R4 `simulation/kernel.ts`, ~180.** 29 `*Rejection` interfaces + 29 constructor twins, 11 `*BranchMeta` (10 byte-identical), 5 `*EventCommandContext` → generic `SimulationRejection<TCode>` + `reject<TCode>` (5 modules already prove the generic).
- **R2 `foldProjectionHistory`, ~140.** Ten literal copies of the 18-line replay template (sort/contiguity-assert/commandId-count/fold/re-parse); `space.ts`'s pre+post invariant hook is the only divergence.
- **R5 `replaceById`/`assertTransition`, ~40**; **R6 `libraryResourceApi` client factory, ~45** (5 API objects × the same six methods; `clone` opt-in for personas); **R7 `simCommand` helper ~15** (correctness item #9); **R8 clamp fold ~10**.
- Ship R4+R1+R5 as one kernel change (they share `SimulationBranchMeta`); R3 standalone first.

**Splits:**

- **`simulation/bodies.ts` (2,672)** → `bodies/meters.ts` (the analytic integration kernel, 106–400 + 440–562 — already imported by `material-condition.ts`), `resolvers.ts` (~1,500), `collapse.ts` (2066–2404), `projection.ts` (2405–2672). Delete the `EXP2_SCALE` re-export shim at L87 (no-legacy rule).
- **`client/api.ts` (1,864)** — >50% response-schema declarations; split **by layer**: `http.ts`, `schema-helpers.ts`, `schemas/{library,chat,images}.ts`, `api/{library,chats,identity-packs,images,account}.ts`, `chat-stream.ts` (the one legitimate hand-rolled fetch), keep `api.ts` as a re-export barrel for the 66 importers.
- **`simulation/households.ts` (1,539)** → `lots.ts` (pure lot arithmetic 93–286) / resolvers / projection. **`material-condition.ts` (1,157)** → extract `worn-window.ts` + `use-deltas.ts` (consumed by sibling modules). **`space.ts` (996)** → extract `routing.ts` (graph search, 63–227). `activities.ts` / `materials.ts` / `commitments.ts` → resolvers/projection splits, lower priority.
- Cohesive, leave: `narrative.ts`, `social.ts`, `knowledge.ts`, `engagements.ts`, `routine.ts`, `perception.ts` (its 243-line switch is mostly load-bearing comments), all of `lib/images`.

## src/server/engine — root (27.6k lines, 51 files)

**Splits:**

- **`chat-pipeline.ts` (3,617).** `submitChatMessage` = one 2,122-line closure (`prepareExchange` 2,022; `settle` 565). Order: (1) `chat-pipeline-preview.ts` (~465, zero coupling — the free win), (2) `chat-pipeline-messages.ts` (~260, transcript IO already imported by `sim-exchange.ts`), (3) `prompt-slices.ts` (~85, pure, shared live+preview — the drift the file's own comment warns about), (4) `stream.ts` (~90), (5) `chat-pipeline-settle.ts` (~570) — requires minting an explicit ~35-field `SettleContext`, which is the point: today nothing stops edits reaching backwards into pre-stream state. Preserve literal await order (LAST-scene-writer rule L2436–2456; permission decision strictly after, L2528–2535). Optional: contact leg (~300, already a self-contained `try`).
- **`chat-state.ts` (3,415)** → `-types.ts` (~330; stops every type-consumer paying 3.4k lines), `-store.ts` (~500; makes the "one place the column list lives" invariant structural), `-outfit.ts` (~470), `-pulse.ts` (~420), `-edit.ts` (~330), `-finalize.ts` (~800; `finalizeChatState` is 795 lines with three extractable sub-blocks).
- **`chat-contact-adapter.ts` (2,207, pure)** → `-detect.ts` (~900 of regex detectors), `-material.ts` (~270, already independently imported), `-phrases.ts` (~220), core (~750).
- **`sim-exchange.ts` (2,041)** → `sim-engagement.ts` (~300: scene open/close, clock drain, in-transit settlement), `sim-exchange-context.ts` (~450: admission + loaders), runners+retake (~1,100).
- **`chat-npc-scene-decision.ts` (1,343)** → trigger (~130, pure) / admit+evaluate (~275, pure, the unit-tested part) / lifecycle (~700). **`chat-physical-guidance.ts` (953)** → premises (~575) / staging (~380).
- Cohesive, leave: `chat-npc-scene-execute.ts` (1,054), `chat-permission-events.ts` (802), `chat-npc-scene-envelope.ts` (785), `chat-memory.ts`, `chat-intent.ts`, `chat-affordances.ts`.

**Reuse:**

- **★ `runChatAgentLeg`, ~225.** Five agent legs (`runChatPulse`, meanwhile, scene-sketch, NPC classifier, permission classifier) each hand-roll the same ~45-line AbortController → reasoning-plan → telemetry → `generateChecked` → `withGenerateTimeout` scaffold that `chat-memory.ts`'s `runExtractorLeg` (L235–303) already proved generalizes. Build it as that function's promotion into `engine/agent-leg.ts`; vision/summary variants are optional fields.
- **`runLooseClassifierLeg`, ~45** (correctness item #6). **Ledger list/delete generics in `ledger-verify.ts`, ~65** (leave the insert pair — table identity is the whole body). **Roster projection helpers, ~45** (correctness item #5). **`fenced()` ~32** — only with an explicit `rethrow` flag; two of eight sites deliberately rethrow. **Sim persist tail ~35** (fold into the sim-exchange split).

## src/server/engine — simulation/ + prompts/ (25.3k lines, 56 files)

Baseline verified: `lib/simulation` = pure resolvers; `*-store.ts` = IO shells; `runSimulationCommand` exists and 16/19 stores use it (46 sites). A generic store *factory* is the wrong shape — the wins are the four gaps below. **Total ≈1,830 LOC.**

- **R1 `branchResolverView(branch, headSequence?)`, ~256.** The 5-field view literal ×64 sites; zero divergence beyond the optional headSequence.
- **R3 command-preamble factory + one `rejectedResult`, ~500.** 752 measured lines of `runSimulationCommand` argument preamble across 46 sites (the `branch_mismatch` pair is byte-identical at all 46); `rejectedResult` defined 15× (13 identical); `injectCrash` ×3. Factory must return the result (household/material wrap it).
- **R4 leaf modules (`body-rows.ts`, `item-condition-store.ts`, `material-rows.ts`), ~290 + dissolves 3 import cycles.** The copies the code apologizes for: `activity-store.ts` carries ~580 lines of body/material/item-condition duplicates because the cycle `material-store → body-store → activity-store` blocks the import. Also: `body-store.ts` `meterViewOf` (366–390) is a verbatim duplicate of `lib/simulation/bodies.ts` `buildMeterView` — straight delete; `lastSleepEndedAtOf`/`collapseContextOf` are pure → `lib/simulation/bodies`.
- **R2 migrate the 3 remaining inlined command shells** (`space-store.ts` move/arrival, `scheduler-store.ts` trigger), ~270 + ends a security-gate split-brain. ⚠ The inlined copies fold only 2 of the shared shell's 5 recorders — verify `knowledge-recorder.ts` filtering before merging; expect a possible engine-test diff.
- **R6 `acceptedResult`, ~150** (49 sites; extra domain fields spread over the base). **R7 `materializeReplayedRows`, ~120** (12 domains in `forkBranch`; keep an explicit `sequenceOverride`). **R5 `retirePendingTriggersByPrefix`, ~90** (7 sites; state-filter and prefix/exact divergences are parameters). **R9 `appendEventsWithTriggers`, ~40** (10 copies). **R8 `character-chat.ts` internal dedup, ~110** (attribute loop ×3, disinhibition diff ×2, transient-appearance ×2, `realizeBody` literal ×4) — do with the split below.

**Splits:**

- **`prompts/character-chat.ts` (2,624)** → `.types.ts` (~400 — the 320-line input interface alone is the biggest read-cost), `.sections.ts` (~600), `.appearance.ts` (~280, absorbs R8), `.rules.ts` (~95 prompt prose), `.ensemble.ts` (~470), core (~430). Snapshot tests pin behavior.
- **`branch-store.ts` (1,035)** — `forkBranch` is a single ~630-line function → ancestry / fork spine / `materialize.ts` (12 named per-domain functions; enables R7).
- **`body-store.ts` (1,546)** → `body-rows.ts` + `body-reads.ts` (the §25.1 layer-3 read surface at 1209–1360 is wedged between two command submits) + store (~1,100).
- **`activity-store.ts` (1,532 → ~950)**, **`material-store.ts` (1,402 → ~900)** — mostly via R4's leaf modules. **`household-store.ts` (1,465)** → rows / lots (4 lot-side submits) / core. **`space-store.ts` (1,067)** — adopt the shell first (R2) → ~800.
- In-file only: `arbiter-store.ts` (828; `prepareEngagementTurn` is 390 lines — name its 7 numbered steps; optionally move confirm to `narrative-cut-store.ts`). `prompts/chat-extractors.ts` (845) → data/assembly halves. `soak-harness.ts` (1,171) low priority.
- Leave: `scheduler-store.ts`, `commitment/social/engagement/memory-index` stores, `sim-render.ts`, `starter-world.ts`, `prompts/constants.ts` (the comments are the value).

**Order:** R1→R3→R6 (one mechanical `store-common.ts` PR, ~900 LOC) → R4 → character-chat split + R8 → R2 (after recorder verification) → R5/R9 → R7 + branch-store split.

## src/server/images (10,725 lines, 21 files)

**Splits:**

- **`identity-packs.ts` (3,445 — 36% prose)** → 8 modules along its 16 existing banners: `-store` (~450, leaf), `-ensure` (~600), `-promotion` (~265), `-derive` (~380), `-read` (~230), `-manual` (~435), `-preparation` (~535), `-maintenance` (~500). Acyclic with store as leaf. Risks: the `registerIdentityPackMaintenance` **module-load side effect** (L3430) must become an explicit import edge (today it's transitively load-bearing by accident); heavy cross-section doc comments need `{@link}`s; only 4 direct importers + the barrel, so route churn is nil.
- **`prompts.ts` (1,930)** → 8 files by prompt family (format kit as leaf; avatar / variant / scene-composer / appearance / scene-plan / scene-render / entity). Consumers already partition exactly along these lines. Lowest-risk split in the domain.
- **`identity-pack-trial.ts` (1,525)** → `-store` / `-plan` / `-execute` / `-review`. (Premise "trial duplicates pack machinery" verified false.)
- Leave: `assets.ts` (923 — `runImagePipeline` belongs beside the row lifecycle), everything under 400.

**Reuse:**

- **`collectAttributePhrases`, ~50 + the drift fix** (correctness item #1). Predicate-driven, not flag-driven; home: `src/lib/images/attribute-phrases.ts` — or `src/contracts/attributes` to also serve the same loop ×5 in `engine/prompts/character-chat.ts`.
- **Merge `uploadAvatar`/`uploadChatAttachment`, ~30** (near-identical 30-line bodies). Adopting `runImagePipeline` for the other hand-rolled sites (~55–70) only if it grows `sweep: false` + a `discardOnFailure` disposition — otherwise skip.

## src/server — ai / api / auth / authoring / db / memory / players (14,376 lines)

**Splits:**

- **`db/schema.ts` (3,980) — split.** 100% `pgTable`s (zero relations/`$inferSelect`/zod). Verified FK graph: the only identity↔simulation edges are `characterChats→simBranches` and `simCommandRequests`/`simShadowDivergences`→`characterChats`, and no sim table references another sim table except `simWorlds`/`simBranches` — so a `schema/simulation-core.ts` holding just those two makes a 13-file layout acyclic (`columns` / `simulation-core` / `auth` / `library` / `chat` 842 / `memory` / `images` 507 / `infra` / `simulation-{kernel 668, space 409, knowledge 330, bodies 239, society 352}`). Churn: zero consumer imports (all 3 direct `./schema` importers resolve via the folder index), one `drizzle.config.ts` line, 14 doc mentions. Safety: drizzle snapshots key on table names, so a correct move yields "No schema changes" from `pnpm db:generate` — **which a human must run** (interactive-prompt rule) and confirm empty before commit; a dropped table would surface as `DROP TABLE` in the diff.
- **`authoring/character-forge.ts` (1,569)** → `character-forge/` folder: `context.ts` (~195), `profile.ts` (~540), `attributes.ts` (~410), `outfit.ts` (~266), `demo.ts` (~157 of sample prose). Move `normalizeEnumToken` (L803) to context — it's used cross-section. Fold in the ~15-line `runForgeSection` micro-dedup.
- Leave: `memory/facts.ts` (592), `api/library.ts` (467 — defer any split to `library-route-registry.plan.md`), `ai/replicate.ts`, everything else.

**Reuse:**

- **Library per-kind table dispatch, ~185 `[known C6/C7 — owned by library-route-registry.plan.md, draft]`** — `cloneToLibrary`, `findViewable`, `searchTextFor` branch per kind; the kind→table map is written 3× (2 byte-identical). Preserve the character full-profile-clone ruling.
- **facts↔episodes retrieval pipeline, ~90–110 `[new]`** — fused retrieval, single-query retrieval, the 4× `logEvent("retrieval")` payload, scope purge. Shared skeleton + injected policy callbacks; the pinned-tier / recency-window / filter-timing differences are semantic and must survive.
- **`errorText` ×10 + `round` ×2 + `stringArraySchema` ×3, ~45 `[known C9]`** → `src/lib/errors.ts` (three agents independently found this; ~64 sites repo-wide incl. engine/images inline copies).
- **Abuse-signal emission ×6 + `storageQuotaRejection` collapse, ~50 `[new]`** — move `signalContext` into `client-ip.ts` (fixes the cycle-driven asymmetry in `route-limits.ts`); `tooManyRequests` already handles `retryAfterSeconds: 0`.
- **`readEventLog<T>` ~30 `[known C8]`**; **Replicate slug/fetch/base dedup ~40 `[new]`** (`parseReplicateSlug` backing both transport and probe is the correctness half; probe keeps fail-not-degrade); **`holdbackScrubber` ~25 `[new]`** (correctness item #8).
- Anti-targets, verified deliberate: `visibility.ts` `toPublic*` allow-lists (the redundancy is the test mechanism), `generateChecked` call sites, `admin/self` re-exports (see src/app for the real fix).

## Sequencing across domains

1. **Mechanical scaffolding passes first** — engine-sim `store-common.ts` (R1+R3+R6), contracts `envelopes.ts` (R1+R2+R6), lib kernel (R3 hash imports, then R4+R1+R5) — ≈2,300 LOC, all low-risk, and they shrink the very files queued for splitting.
2. **Cheap high-value splits** — `db/schema.ts` (human `db:generate` gate), images `prompts.ts`, engine-sim `character-chat.ts` (+R8), `chat-contact-adapter.ts`, contracts `lifecycle.ts`/`garment-noun-coverage.ts`.
3. **The two engine monsters** — `chat-pipeline.ts` (previews → messages → slices → stream → settle) and `chat-state.ts`; then `identity-packs.ts`.
4. **Components** — editor-shell dedup before the editor-page splits; then `chat-conversation.tsx`.
5. **Correctness items** (§above) can ride whichever change touches their files first; the images filter-drift and the evidence-geometry twins deserve early attention regardless.
