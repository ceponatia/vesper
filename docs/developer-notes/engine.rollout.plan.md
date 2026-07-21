# Successor engine — migration and rollout

Status: **next** (queued 2026-07-21 by owner instruction, the same ruling that
resequenced Gate 7 behind this work: *"schedule the migration and rollout, with
Gate 7 as an optional todo after migration and rollout is completed and tested."*)

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

1. **R0 — merge `engine` → `main`.** Housekeeping, not a feature: additive
   migrations 0056–0080 land on Neon and sit idle; the app is unchanged (zero
   product consumers). Merge `main` into `engine` first (the mobile-UX pass +
   docs; expected conflict: `roadmap.md` only), run the five gates, then PR to
   `main` and deploy so the schema ships ahead of any consumer. The long-lived
   `engine` branch retires here — later slices ride ordinary feature branches.
2. **R1 — authority flags and the internal test world.** The per-world flag
   column(s) (default `legacy_chat` — a no-op for every existing row), admission
   wiring so a command's lane is decided by the flag and nothing else, and one
   seeded internal test world (topology, rhythms, cohorts, action definitions,
   a small cast) provisioned end to end. Exit: flags flip per world with an
   audit trail, and the test world drains story-days on Fly exactly as the
   corpus does locally.
3. **R2 — the live narrator over the committed cut.** The first real model call
   in the successor lane: one narrator leg rendering a persisted NarrativeCut
   (presentation-only — `successor_narrative_view`), the §23.1 trust boundary
   and §23.2 structural auditor running against live output, ruling-8 hidden
   retry, `confirm_narrator_result` arming real effects, and the §19.3
   deliberator live behind its budget and deterministic fallback. The
   owner-gated paired eval rides here ([deferred.plan.md](deferred.plan.md)
   §Owner-gated live eval runs — the Gate 4/5/6 deferred quality checks become
   runnable against this leg on request). Exit: a full narrated turn against the
   internal test world within the latency/model-call budget, degradation paths
   observed live (a failed render withholds, never corrupts).
4. **R3 — the product surface.** Minimum playable seam, chat-lane-first per the
   test-bed direction: API routes that admit player commands into the successor
   (movement, activities, engagement open/close, item transfer), the play loop
   driving `prepareEngagementTurn` → narrator → confirm, and admin-grade
   authoring surfaces (reusing library patterns) for topology, cohorts, rhythms,
   and action definitions. Storyteller tools (relocate, promote-from-cohort,
   LOD dial) surface here too. Exit: a human plays a scene in the internal test
   world on Fly — moves, talks, sleeps, is witnessed — with world life
   continuing off-screen.
5. **R4 — shadow mode under chat.** `successor_shadow` on selected chat worlds:
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

## Open questions

1. **First player surface** — does R3 embed the successor play loop inside the
   existing chat UI (a flagged world type) or stand up a separate minimal play
   page first? (Chat-first is the default direction; the standalone page is the
   lower-risk spike.)
2. **Shadow comparison corpus** — which live chat worlds (if any) are safe to
   shadow in R4, versus synthetic fixtures only? The UX-test account's worlds
   are the obvious candidates.
3. **Domain order in R5** — the candidate order above is the author's; the
   owner may want wardrobe/items earlier given chat-wardrobe parity already
   shipped in the chat lane.
4. **Narrator model routing for R2** — which model/provider the successor
   narrator leg uses first (the chat lane's current default vs a cheaper draft
   model behind the same seam).
