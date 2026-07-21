# Successor engine — migration and rollout

Status: **active** (queued 2026-07-21 by owner instruction — the same ruling
that resequenced Gate 7 behind this work: _"schedule the migration and rollout,
with Gate 7 as an optional todo after migration and rollout is completed and
tested."_ — and started the same day once the owner resolved all four opening
questions; see §Resolved rulings).

Companion to [engine.plan.md](engine.plan.md) (whose §"Migration and rollout"
this plan turns into scheduled, sliced work) and successor to the closed
foundation gates 0–6 ([engine.gate6.dual-lod.md](engine.gate6.dual-lod.md)
closed 2026-07-21). Normative contracts stay in the
[engine.spec.md](engine.spec.md) §-index; this plan owns delivery sequence only.

## Why this plan exists

The foundation is complete but **dormant**: as of 2026-07-21 zero files outside
`src/server/engine/simulation` and its tests consume the sim stores. There is no
API surface submitting sim commands, no authoring UI, no live narrator call —
every seam (§19.3 deliberator, §22–23 narrator boundary) is built and
stub-exercised with zero model calls by design. "Functional" today means the
suites prove the physics; nobody can play in it. This plan closes that gap: the
engine becomes the world authority under the live product, per the
chat-as-test-bed direction (`CLAUDE.md`) — chat leads, lanes stay separate until
unification is proven, and the deprecated world/session model is ultimately
replaced rather than preserved.

## Ground rules (carried from engine.plan.md, unchanged)

- Authority is assigned **per world or branch by feature flag**, never per row:
  `legacy_chat` · `successor_shadow` · `successor_authoritative` ·
  `successor_narrative_view` · `successor_rag_eligibility`.
- Rollback selects the previous authority flag or branch; events stay immutable;
  rebuildable projections/embeddings may be dropped and regenerated.
- Rerender = new prose from the same committed cut; retake = fork; no in-place
  rewind leaves later state behind.
- One narrator call per turn, zero routine state-agent calls, at most one
  deliberator call — the §"Latency and model-call budget" holds in production
  exactly as in the corpus.
- Remove obsolete adapters and superseded legacy code as domains migrate — no
  indefinite compatibility layers (repo rule: delete, don't deprecate).

## Build order

The IDs describe order, not PR numbers; each slice stays reviewable on its own.
R0–R2 are prerequisites for everything after; R3–R5 are the rollout proper; R6
is the cleanup that makes the migration real.

1. **R0 — merge `engine` → `main`.** Status: **shipped — 2026-07-21.** `main`
   merged into `engine` (one `roadmap.md` conflict, resolved), five gates green
   on the merged tree (3 111 pure + 467 int), `main` fast-forwarded to the
   merge commit (engine contained main, so no second merge), and Fly deployed
   at machine version 93 — migrations 0056–0080 live on Neon, app unchanged.
   The long-lived `engine` branch retires here — later slices ride ordinary
   feature branches off `main`.
2. **R1 — authority flags and the internal test world.** Status: **shipped —
   2026-07-21.** `contracts/simulation/authority.ts` (the four ordered lanes +
   orthogonal RAG flag, `consultsSuccessor`/`successorIsAuthoritative`
   helpers); three columns on `character_chats` (migration 0081, additive:
   `engine_authority` default `legacy_chat`, `successor_rag_eligibility`,
   `sim_branch_id` FK SET NULL); the one read/flip seam
   (`server/engine/chat-authority.ts` — parseOr fail-closed reads, flips
   atomic with an `engine_authority_changed` audit row in the app `events`
   table, no-op flips audit nothing); the audited admin dial
   (`GET|PATCH /api/admin/engine-authority/[chatId]`, 404-hidden for
   non-admins, owner-scoped). The standing internal test world
   (`rollout-world.ts`, FIXED ids `rollout-test-world`/`rollout-test-branch`,
   idempotent — found, never re-seeded): two zones + link, four-actor cast at
   mixed LODs (Ana event+meals, Ben event, Riven dormant, Mara default-exact),
   a 200-person cohort, bread for the meal routine; `pnpm sim:seed` /
   `pnpm sim:advance -- --days N` wrap it locally and over Fly SSH (the drain
   loops the bounded seam to convergence). Verified locally: seed → 8 pending
   alarms; one story-day → 5 triggers drained, 3 routine decisions
   (eat_meal + 2× begin_sleep). The action catalog deliberately waits for R3.
   3 new int cases (`test:rollout-r1`, in CI); 3 111 pure + 470 int green.
   **Fly-side exit verified 2026-07-21** (machine v94): `pnpm sim:seed` over
   SSH provisioned the world on Neon (8 pending alarms), and
   `pnpm sim:advance -- --days 3` drained three story-days — 19 triggers
   fired, 9 routine decisions, one converged call, zero model calls — the
   corpus behavior running on production infrastructure. Admission wiring
   beyond the seam deliberately trails into R2/R4 — nothing consults the
   flag until a successor leg exists to route to. Next: **R2**.
3. **R2 — the live narrator over the committed cut.** Status: **shipped —
   2026-07-21** (leftover below). `renderCommittedCut`
   (`server/engine/sim-narrator.ts`): load the persisted, hash-verified cut →
   `buildCutRenderPrompt` (pure §22-boundary serializer in
   lib/simulation/presentation.ts) → ONE model call (Aion 3.0 default via
   `resolveChatModelId`; injectable seam so tests run zero live calls; demo
   mode degrades to a deterministic compliant render) → §23.1
   `parseNarratorResult` → §23.2 `auditPresentation` → ruling-8 hidden retry
   from the SAME cut → withhold cleanly after the retry (nothing presented,
   nothing reverted) → on ≥1 enacted effect/proposal,
   `confirm_narrator_result` (system principal, hash-derived idempotent
   command id — rerenders replay it, one speech act ever). Int-proven
   (`test:rollout-r2`, in CI): accept + confirm (a real
   `speech_act_delivered`), hidden retry, clean withhold with row-count
   invariance, rerender-creates-nothing, deterministic bridging.
   **Live exit verified 2026-07-21**: `pnpm sim:render-turn` ran one full
   narrated turn on the internal test world — Aion 3.0 via AionLabs, ONE
   narrator call, audit verdict `accept`, zero diagnostics, ~32s model
   latency (Aion 3.0 reasoning; worth watching against the p95 budget).
   Leftover: the live §19.3 deliberator factory (`PrepareTurnDeliberation`
   remains stub-only; the deterministic fallback governs departures) trails
   into R3, where the play loop first needs it. The first real model call
   in the successor lane: one narrator leg rendering a persisted NarrativeCut
   (presentation-only — `successor_narrative_view`), the §23.1 trust boundary
   and §23.2 structural auditor running against live output, ruling-8 hidden
   retry, `confirm_narrator_result` arming real effects, and the §19.3
   deliberator live behind its budget and deterministic fallback. Model
   routing per ruling 4: Aion 3.0 default, resolved through the shared
   `NARRATIVE_MODELS` picker. The
   owner-gated paired eval rides here ([deferred.plan.md](deferred.plan.md)
   §Owner-gated live eval runs — the Gate 4/5/6 deferred quality checks become
   runnable against this leg on request). Exit: a full narrated turn against the
   internal test world within the latency/model-call budget, degradation paths
   observed live (a failed render withholds, never corrupts).
4. **R3 — the product surface.** Status: **active — slice design recorded
   2026-07-21** (survey done; build next). Slice 1, *the successor turn
   route*: chat's exchange machine (`submitChatMessage`, ~2 000 lines of
   streaming pipeline) stays untouched — the lanes-separate rule applied to
   code. Instead a parallel, non-streaming route
   (`POST /api/chats/[chatId]/sim-turn`) serves chats whose authority is
   `successor_narrative_view` with a linked `simBranchId`: player text in →
   `prepareEngagementTurn` (span per ruling 1, viewpoint = the player's
   mapped actor, live deliberation joins here — the R2 leftover) →
   `renderCommittedCut` → the prose persisted into the ordinary transcript
   (reuse `persistAssistantReply`) and returned. v1 actor mapping is two
   fields on the admin authority dial (player actor id + primary character
   actor id; the rollout world's Mara/Ana). Slice 2, *player commands*:
   move / start-stop activity / open-close engagement / transfer as typed
   admissions on the same route family. Slice 3, *authoring + storyteller
   tools*: topology/cohort/rhythm/action-definition CRUD plus relocate,
   promote-from-cohort, and the LOD dial as admin routes. Exit unchanged:
   a human plays a scene in the internal test world on Fly. Minimum playable seam **inside the existing
   character chat UI at `/chat/`** (ruling 1 — no standalone play page): API
   routes that admit player commands into the successor
   (movement, activities, engagement open/close, item transfer), the play loop
   driving `prepareEngagementTurn` → narrator → confirm, and admin-grade
   authoring surfaces (reusing library patterns) for topology, cohorts, rhythms,
   and action definitions. Storyteller tools (relocate, promote-from-cohort,
   LOD dial) surface here too. Exit: a human plays a scene in the internal test
   world on Fly — moves, talks, sleeps, is witnessed — with world life
   continuing off-screen.
5. **R4 — shadow mode under chat.** `successor_shadow` on the UX-test
   account's worlds (ruling 2 — never a player-owned world):
   successor calculations run alongside the chat lane with **no effects**,
   compared against fixed fixtures and live chat outcomes (events, projections,
   presence, meter reads). Divergences are diagnostics, not failures — this
   slice exists to find contract gaps before authority moves. Exit: an agreed
   shadow-parity report over a fixed comparison corpus; every divergence either
   fixed or ruled intentional.
6. **R5 — domain-by-domain authority migration.** `successor_authoritative` one
   domain at a time (candidate order: time/clock → space/presence → bodies &
   meters → items/wardrobe → knowledge/memory → relationships), each with dual
   writes through its invariant window, fixture comparison, and a rollback
   window before the next domain starts. `successor_rag_eligibility` flips when
   the knowledge domain lands. The chat lane's meter-economy/body-needs plans
   (roadmap Next) port through the Gate 5 contracts here rather than being
   built twice. Exit per domain: dual writes stopped, legacy write path
   removed, invariants green for the declared window.
7. **R6 — cleanup and legacy retirement.** Delete the migrated adapters, the
   dual-write shims, and the superseded world/session-model code paths the
   migration obsoletes (the long-anticipated deprecation — remove, don't wrap).
   Exit: one authority per world, no dead lanes, docs/README system map updated.

**Completed and tested** means: R0–R6 exited, the five repo gates green
throughout, the shadow-parity report accepted, at least one owner-run live eval
recorded, and the internal test world + one migrated chat world stable on Fly.

## After completion — Gate 7 (optional, owner ruling 2026-07-21)

[Gate 7 — institutions and macro simulation](engine.gate7.institutions.md)
is explicitly sequenced **after** this plan completes and is tested, and stays
**optional**: admit a package (employers, markets, weather, law, factions…)
only when a world type and scenario corpus justify it, per that doc's
declaration checklist. Nothing in R0–R6 depends on Gate 7; nothing in Gate 7
may begin before R6 exits without a new owner ruling.

## Resolved rulings (owner, 2026-07-21)

All four opening questions were answered the day the plan was queued:

1. **First player surface — the existing character chat system at `/chat/`.**
   R3 builds no standalone play page: chat IS the surface, per the test-bed
   direction. The successor play loop lands under the chat UI for flagged
   worlds.
2. **Shadow comparison corpus — the UX-test account's worlds** (the dedicated
   `uxtest-main@vesper.local` worlds, e.g. Tsukikage Onsen). No player-owned
   world is shadowed.
3. **R5 domain order — author's call, sequenced by dependency.** The owner
   expects fast iteration; the order in R5 stands unless a dependency proves
   otherwise mid-build.
4. **Narrator model — Aion 3.0 (`aion-labs/aion-3.0`) first**, keeping the
   curated `NARRATIVE_MODELS` picker (`src/lib/narrative-models.ts`) so any
   accepted model can be chosen — the successor narrator leg resolves through
   the same list chat uses. Side ask landed with this ruling: **Grok 4.5
   (`x-ai/grok-4.5`) added to the accepted list.**
