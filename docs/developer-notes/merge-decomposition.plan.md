# Merge reducer decomposition — plan

Status: **shipped — 2026-06-27** (all 5 slices). Slices 1–3 (`merge/` folder + `WorkingState`
ADT + encapsulation lint gate + `grounding.ts`) landed first; Slices 4–5 (the phase split +
the `plan.ts`/`apply.ts` move + barrel narrowing) completed the same day. The 2655-line
`merge/index.ts` is now a 16-line public barrel over `types.ts` + `plan.ts` + `apply.ts` +
16 `phases/*.ts` files (largest ~250 lines); `planTurnEffects` is an ordered `PHASES` list
run over a `PhaseContext` (see the §3.3 refinement note in the spec). A behavior-preserving
refactor — no feature payoff, pure maintainability. Produced by the Code Complete "complete
review" pass (`docs/prompts/complete-review.md`) over the old `merge.ts`, the codebase's
largest file and the highest-confusion area in the turn engine. Every slice landed green per
`pnpm verify`; the merge suite (189 pure tests) + Postgres-backed `engine.int.test.ts`
(13 tests) were the behavior gate.

Spec (full checklist scoring, target design, test strategy):
[merge-decomposition.spec.md](merge-decomposition.spec.md). System doc:
[turn-engine.md](../turn-engine.md) §"Merge reducer".

## Why this exists

`engine/merge.ts` is **2655 lines** — roughly the size of the next two largest engine
files combined, in a codebase whose median file is ~150 lines. It holds four unrelated
responsibilities in one file, and its core function `planTurnEffects` is an **830-line
procedure** (1611–2344) that threads ~15 mutable locals across ~10 inline phases.

The Code Complete review scored the module against the "class as abstract data type"
checklist (full table in the spec §2). The load-bearing findings:

- **There is no ADT for the working state.** The central data structure of the whole
  reducer — the mutable per-turn copy of participants and items — is bare arrays
  (`WorkingParticipant[]`, `WorkingItem[]`) mutated by direct field assignment at ~12
  sites (`participant.locationId = target.id`, `item.state.open = …`). This is the
  textbook ADT-begging-to-exist.
- **Dirty-tracking is manual and unguarded.** Every mutation must be paired by hand with
  `touchedParticipantIds.add(id)` / `touchedItemIds.add(id)`; a single missed `.add()`
  silently drops a DB write in `applyTurnResults`. This is the single highest-risk
  correctness surface.
- **The orchestrator is not a black box.** `planTurnEffects`'s phases (movement, items,
  clock+meters, reactions, conditions, attributes, schedule tick, facts, threads, witness,
  affinity, comms, brief) share local state and have load-bearing ordering invariants
  ("drift before reaction mood-nudge", "reaction edges before affinity combine") enforced
  only by line order and prose comments. No phase can be read or tested in isolation.
- **The barrel surface is flat.** ~40 exports span four altitudes (top-level applicator,
  plan function, per-subsystem planners, one-line pure utilities). Most exist only so unit
  tests can reach them; nothing marks public vs. exported-for-test.

What's _good_ and must be preserved: the **external** interface is tiny and stable
(`applyTurnResults` is the only production caller, from `pipeline.ts:910,962`), and the
module has ~3700 lines of tests across 7 files. The refactor rides that safety net.

## Goal

Introduce the `WorkingState` ADT the checklist asks for and decompose the orchestrator
into an explicit phase pipeline over it — **behavior-preserving**, output-identical,
verified by the existing suite. Promote `merge.ts` → a `merge/` folder. No change to
`applyTurnResults`'s signature, the `MergePlan` shape, or any DB write.

## Slices

Each slice ends `pnpm verify`-green (lint + typecheck + test + jscpd) and is independently
revertible. Ordering is by safety: the ADT and the pure toolkit first (lowest risk), the
phase split last (highest churn).

### Slice 1 — Characterization safety net (do before touching code) — _not done as a separate pass_

**Status:** the existing 189-test merge suite was used as the behavior gate (green after
every change); no new characterization tests were backfilled. If Slice 4 (the phase split)
finds a phase with only helper-level coverage, add the end-to-end assertion there before
extracting it.


Confirm the existing suite pins **observable orchestration output**, not just helpers.
For each phase, assert at the `planTurnEffects` boundary: its `droppedEvents`, its dirty
sets (`touchedItemIds` / participant writes), and its `runtime`/`brief` deltas. Fill gaps
where a subsystem has helper-level coverage (e.g. `planAffinityDecay` unit tests) but no
end-to-end assertion that `planTurnEffects` wired it. This slice adds **tests only**.

### Slice 2 — `merge/working-state.ts`: the `WorkingState` ADT — ✅ shipped 2026-06-27

A class, following the established mutable-accumulator precedent (`EventChannel` in
`pipeline.ts`, `DiagnosticCollector` in `contracts/diagnostics.ts`). It owns
`participants`, `items`, and the per-turn accumulators (`droppedEvents`, `arrivals`,
`departures`, `firedComms`, `stagedDirectives`, the two dirty sets), and exposes
intention-revealing methods that make **dirty-tracking internal and automatic** — the
fix for checklist items 5 & 6:

- `WorkingState.fromBundle(bundle)` — does the `structuredClone` the planner does inline.
- reads: `findParticipant(name)`, `player`, `coLocatedNpcs(loc)`, `findItem(...)`.
- mutators that mark the right dirty set: `moveParticipant(p, toLoc)`, `setActivity`,
  `placeItem(item, placement)`, `setMeters(p, meters)`, `adjustMood(p, delta)`, ….
- accumulators: `recordDrop(msg)`, `stageArrival/Departure/Directive(…)`, `fireComms(…)`.
- readonly getters used to assemble the plan: `touchedItemIds`, `touchedParticipantIds`,
  `droppedEvents`.

`planTurnEffects` keeps its current shape but calls these methods instead of mutating
fields and hand-maintaining sets. No phase split yet — this slice is the ADT swap alone,
so any regression localizes to the ADT. This slice also lands the **encapsulation gate**
(spec §5.5): once the mutators exist, add the grep / ESLint `no-restricted-syntax` rule that
forbids direct field assignment to participant/item state outside `working-state.ts`, so the
manual-dirty-tracking bug class can never return.

### Slice 3 — `merge/grounding.ts`: extract the pure resolution toolkit — ✅ shipped 2026-06-27

Move the stateless name→row helpers (`findParticipant`, `groundParticipants`,
`resolveSessionLocation`, `resolveItemByName`, `scoreItemCandidate`, `isAdjacent`,
`findLink`, `linkTravelMinutes`, `stagedLocationAnchor`) into their own file. They are
already pure and well-tested; this is a file move + import update. Unrelated info leaves
the reducer (checklist 7).

### Slice 4 — `merge/phases/*.ts`: one file per phase — ✅ shipped 2026-06-27

Each inline phase of `planTurnEffects` is now a named `(ctx, state) => void` step in its own
`phases/*.ts` file (`movement`, `items`, `meters`, `reactions`, `conditions`, `attributes`,
`activities`, `schedule`, `facts`, `threads`, `witness`, `comms`, `affinity`, `brief` + a
shared `caps.ts`), each co-locating its glue with the per-subsystem planner(s) it drives.
`planTurnEffects` (now in `plan.ts`) is a ~10-line orchestrator: build the `WorkingState` + a
`PhaseContext`, `for (const phase of PHASES) await phase(ctx, state)`, then
`buildMergePlan(ctx, state)`. The load-bearing ordering is the `PHASES` list (checklist 5 & 8).
Landed in two verified passes (in-file decomposition, then the physical file split) rather than
one-commit-per-phase — the test suite (189 + 13) was green after each.

**§3.3 refinement (recorded in the spec):** the spec's "every per-turn output accumulates on
`WorkingState`; `return state.toMergePlan()`" was implemented as **uniform `=> void` phases
(the binding Q3 constraint, honored) whose outputs + intermediate scratch accumulate on a
mutable `PhaseContext`, not on `WorkingState`.** `WorkingState` stayed exactly as Slice 2
shipped it (world copy + its narrative byproducts + the dirty-tracking invariant);
`buildMergePlan(ctx, state)` assembles the plan. Keeping the world-copy ADT focused rather than
growing it into a turn-result god-object serves checklist items 1/3/8 (one purpose per unit)
better than folding everything into it. See spec §3.3.

### Slice 5 — `merge/apply.ts` + barrel tightening — ✅ shipped 2026-06-27

`applyTurnResults` (the DB-write layer) is isolated in `merge/apply.ts` (it imports
`planTurnEffects` from `plan.ts`, so no index↔plan cycle). `merge/index.ts` re-exports only the
**public** surface — `applyTurnResults`, `planTurnEffects`, `stagedLocationAnchor`,
`WorkingState`, and the `MergePlan` / `PlanInput` / `MergeTurn` / `MergeMode` / `GroundingDeps` /
`WorkingParticipant` / `WorkingItem` / `ItemPlacement` types. The ~30 per-subsystem planners +
phase glue that only the unit tests reach are no longer re-exported; the 7 merge test files
import them directly from their relative sibling modules (`./merge/phases/*`, `./merge/grounding`,
`./merge/types`) — legal, because the ESLint boundary rule restricts only cross-module
`@/server/*/*` deep imports, not relative intra-module ones. Verified zero production consumers
used any now-internal symbol. The public/internal boundary is restored (checklist 3 & 4).
(The transaction write-loops were left as one body — the optional private-writer split wasn't
needed for the boundary win.)

## Risks & sequencing

- **Hot path under active development.** This is the most load-bearing file in the engine
  and merge-adjacent code is in flight (the social-reaction-cards work touches
  `planCardBreachReactions`/`planReactionAffinity`). Sequence this for a **quiet window**
  between feature arcs to avoid rebase pain; do not interleave with a merge-touching
  feature.
- **No feature payoff.** Pure maintainability — justified by `merge.ts` being the place
  future engine work (world-simulation, the deferred phases) must keep extending. Worth it
  _because_ the file keeps growing, not despite it.
- **Behavior-preserving is the hard contract.** Every slice must leave `MergePlan` and the
  DB writes byte-identical. The merge suite (7 files, ~3700 lines) + `engine.int.test.ts`
  (811 lines) is the gate; jscpd must not regress (the split should _reduce_ duplication).

## Open questions

Resolved 2026-06-27 (rulings recorded in the spec):

- ~~**Class vs. opaque-module ADT for `WorkingState`.**~~ → **class** (spec §3.1). The
  deciding factor is the invariant, not taste: a missed dirty-mark must be made
  _structurally_ impossible, and only private fields enforce that — an opaque type relies
  on convention. Follows the `EventChannel`/`DiagnosticCollector` grain.
- ~~**Phase return-by-value vs. mutate-in-place.**~~ → **mutate-in-place, every phase
  returns `void`** (spec §3.3). All per-turn outputs (incl. `factDrafts`/`affinityUpdates`)
  accumulate on `WorkingState`; `plan.ts` becomes `for (p of PHASES) p(state, ctx); return
state.toMergePlan()`. `brief` is the lone exception (reads everything → final
  `state.toBrief()`).

- ~~Should Slice 4 stop short of the full 14-phase split?~~ → **split is binding at the
  function level, flexible at the file level** (resolved 2026-06-27, conditioned on the ADT
  checklist). Checklist item 3 (consistent abstraction) requires `plan.ts` to be a _uniform_
  ordered list of named `(state, ctx) => void` phase calls — a half-extracted / half-inline
  orchestrator is not a consistent abstraction — so "leave the small phases inline" is **off
  the table**; every phase becomes a named function (items 3, 4, 5, 8 all agree). What "stop
  short" still buys is _file_ granularity: trivial sibling phases may share one file (e.g.
  `phases/misc.ts` exporting two functions) rather than each getting its own, honoring item 8
  as subdivide-as-far-as-_useful_, not classomania. The orchestrator's shape is fixed
  regardless; only the file grouping waits on the post-Slice-3 re-measure.

The target design is re-scored against the full nine-item checklist in **spec §7** (symmetric
to §2, which scored the old code). Item 6 (no meddling with internal data) is promoted from a
review judgment to a **hard gate**: after Slice 2, zero direct field assignment to
participant/item state outside `working-state.ts`, enforced by grep / ESLint
`no-restricted-syntax` (added to Slice 2's `pnpm verify`). That keeps item 6 true under later
modification (item 9) — without it the ADT's black-box property erodes the first time someone
writes `participant.locationId = …` in a phase.
