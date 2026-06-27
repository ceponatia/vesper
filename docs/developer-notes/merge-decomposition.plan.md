# Merge reducer decomposition — plan

Status: **draft** (proposal, awaiting go-ahead). A behavior-preserving refactor —
no feature payoff, pure maintainability. Produced by the Code Complete "complete
review" pass (`docs/prompts/complete-review.md`) over `src/server/engine/merge.ts`,
the codebase's largest file and the highest-confusion area in the turn engine.

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

### Slice 1 — Characterization safety net (do before touching code)

Confirm the existing suite pins **observable orchestration output**, not just helpers.
For each phase, assert at the `planTurnEffects` boundary: its `droppedEvents`, its dirty
sets (`touchedItemIds` / participant writes), and its `runtime`/`brief` deltas. Fill gaps
where a subsystem has helper-level coverage (e.g. `planAffinityDecay` unit tests) but no
end-to-end assertion that `planTurnEffects` wired it. This slice adds **tests only**.

### Slice 2 — `merge/working-state.ts`: the `WorkingState` ADT

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
so any regression localizes to the ADT.

### Slice 3 — `merge/grounding.ts`: extract the pure resolution toolkit

Move the stateless name→row helpers (`findParticipant`, `groundParticipants`,
`resolveSessionLocation`, `resolveItemByName`, `scoreItemCandidate`, `isAdjacent`,
`findLink`, `linkTravelMinutes`, `stagedLocationAnchor`) into their own file. They are
already pure and well-tested; this is a file move + import update. Unrelated info leaves
the reducer (checklist 7).

### Slice 4 — `merge/phases/*.ts`: one file per phase

Extract each inline phase of `planTurnEffects` into `(state: WorkingState, ctx) => void`
(or returning a typed plan-fragment). One file per phase: `movements`, `item-events`,
`clock-and-meters`, `reactions`, `conditions`, `attributes`, `activities`,
`schedule-tick`, `facts-episode`, `threads`, `witness`, `affinity`, `comms`, `brief`.
Extract **one phase per commit**, verify between each. `planTurnEffects` shrinks to a
~60-line orchestrator whose body is the explicit, ordered phase list — the load-bearing
ordering becomes visible in one place (checklist 5 & 8). Most per-subsystem planners
(`plan*`/`apply*`) already exist; the phase file is just the glue that lives inline today.

### Slice 5 — `merge/apply.ts` + barrel tightening

Isolate `applyTurnResults` (the DB-write layer) into its own file; optionally split its
three transaction write-loops (participants, affinity edges+events, items) into small
private writers. Then `merge/index.ts` re-exports only the **public** surface
(`applyTurnResults`, `planTurnEffects`, and the `MergePlan` / `PlanInput` / `MergeTurn` /
`WorkingParticipant` / `WorkingItem` / `WorkingState` types). Phase + grounding helpers
are imported by their tests via relative sibling paths inside the folder — legal, because
the ESLint boundary rule restricts only cross-module `@/server/*/*` deep imports, not
relative intra-module ones. The public/internal boundary is restored (checklist 3 & 4).

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

Still open:

- Should Slice 4 stop short of the full 14-phase split if the orchestrator is already
  legible after, say, extracting only the 3 largest phases (schedule-tick, clock-and-meters,
  witness)? Decide after Slice 3 lands and the function is re-measured. **Metric for the
  call:** the goal is that `plan.ts` reads as one clean ordered phase list — extract a phase
  when it's large _or_ carries a non-obvious ordering dependency; a trivial phase with no
  ordering significance may stay inline or share a file with a sibling. Optimize for the
  legibility of the orchestrator, not file symmetry.
