# Merge reducer decomposition — spec

Status: **shipped — 2026-06-27** (implemented; see the §3.3 refinement note for the one
deviation from this proposal). The design + evidence behind
[merge-decomposition.plan.md](merge-decomposition.plan.md). Subject: the former
`src/server/engine/merge.ts` (2655 lines), now the `merge/` folder. Produced by the Code
Complete "complete review" framework (`docs/prompts/complete-review.md`). System doc:
`turn-engine.md` §"Merge reducer".

---

## 1. Design inventory (what the file actually is)

`merge.ts` presents as one module ("the deterministic merge reducer") but holds **four
unrelated responsibilities**:

| # | Responsibility | Lines (approx.) | Character |
| --- | --- | --- | --- |
| A | **Pure resolution toolkit** — name→row grounding, clock math, item placement | 237–660 | stateless, pure, well-tested |
| B | **Per-subsystem planners** — meters, conditions, affinity (×4), comms, threads, brief | 660–1570 | mostly pure, focused, tested |
| C | **The orchestrator** — `planTurnEffects` builds the working state and runs ~10 phases | 1611–2344 | one 830-line procedure |
| D | **The DB applicator** — `applyTurnResults`: plan + one write transaction | 2452–2655 | IO, the only production entry |

The **central data structure** the whole reducer turns on is the per-turn *working state*:
`WorkingParticipant[]` and `WorkingItem[]` (defined at `merge.ts:104` / `:115`) — mutable
copies of the bundle's participants and items that the phases progressively mutate. It is
represented as **bare arrays plus free functions**, with no encapsulating type.

External surface: **one** production caller — `pipeline.ts` imports `applyTurnResults`
(and `stagedLocationAnchor`) at lines 910 and 962. Everything else exported from `merge.ts`
(~40 symbols) is consumed only by its own 7 test files. Tests deep-import `./merge`
directly today.

Test coverage (the safety net the refactor rides):

| File | Lines | Focus |
| --- | --- | --- |
| `merge.test.ts` | 1538 | end-to-end `planTurnEffects` / `applyTurnResults` |
| `merge.witness.test.ts` | 374 | witness-set perception |
| `merge.time.test.ts` | 280 | clock / rest / travel |
| `merge.affinity.test.ts` | 272 | affinity updates + decay |
| `merge.interactions.test.ts` | 243 | targeted-interaction set |
| `merge.reaction.test.ts` | 154 | social-reaction affinity + mood |
| `merge.atmosphere.test.ts` | 34 | atmosphere baseline shift |
| `engine.int.test.ts` | 811 | full turn against Postgres |

---

## 2. Checklist scoring (class as abstract data type)

Scoring the module as a single "class." Legend: ✓ pass · ◐ partial · ✗ fail.

| # | Checklist item | Score | Evidence |
| --- | --- | :---: | --- |
| 0 | **Thought of as an ADT, interface evaluated as one?** | ✗ | No ADT exists. The working state — the reducer's core structure — is bare arrays + free functions + inline field mutation. |
| 1 | **Central purpose?** | ✗ | Four responsibilities (A–D table above) share one file by history, not cohesion. |
| 2 | **Well named; name describes purpose?** | ◐ | "merge" fits the *whole* loosely, but the file is plan **+** apply **+** a grounding toolkit **+** per-subsystem planners. No single name fits because no single purpose is enforced. |
| 3 | **Interface presents a consistent abstraction?** | ✗ | ~40 exports span four altitudes: applicator (`applyTurnResults`), plan fn (`planTurnEffects`), subsystem planners (`planAffinityDecay`), one-line utilities (`clampMinutes`, `findLink`). Flattened into one barrel. |
| 4 | **Interface makes obvious how to use it?** | ✗ | Real entry points: `applyTurnResults` (prod), `planTurnEffects` (tests). The other ~38 exports exist to let unit tests reach internals; nothing marks public vs. test-only. |
| 5 | **Abstract enough to treat as a black box?** | ✗ | `planTurnEffects` exposes its whole intermediate state as ~15 locals (`parts`, `items`, `touchedParticipantIds`, `droppedEvents`, `arrivals`, `departures`, `firedComms`, `stagedDirectives`, `moodAtTurnStart`, `hintsBefore`, …) threaded across ~10 phases. No phase is readable or testable alone. |
| 6 | **Services complete enough that callers don't meddle with internals?** | ✗ | Working state is mutated by direct field assignment everywhere (`participant.locationId = target.id`, `item.state.open = planned.open`, `t.state.meters = {…}`), each paired by hand with `touchedX.add(id)`. No `moveParticipant`-style method owns the mutation + the dirty mark. |
| 7 | **Unrelated information moved out?** | ✗ | The DB transaction (D) and the pure grounding toolkit (A) are unrelated to each other and to orchestration; co-located only by history. |
| 8 | **Subdivided into components as far as possible?** | ✗ | One of the few >2000-line files; `planTurnEffects` one of the few >800-line functions, in a ~150-line-median codebase. No subdivision. |
| 9 | **Interface integrity preserved under modification?** | ◐ | The *external* interface (`applyTurnResults`) is small and stable — good. But internally there is no interface to preserve: phases reach into shared locals, so each change risks an ordering / dirty-tracking regression caught only by tests. |

Net: the module is healthy at its **outer** boundary (one stable entry, strong test net)
and unhealthy at every **inner** boundary (no ADT, manual dirty-tracking, an opaque
830-line orchestrator, a flat barrel).

---

## 3. Target design

### 3.1 `WorkingState` — the ADT (decided 2026-06-27: a class)

A mutable-accumulator class, matching the existing precedent — `EventChannel`
(`pipeline.ts:91`) and `DiagnosticCollector` (`contracts/diagnostics.ts:21`) are both
mutable accumulators with private fields and intention-revealing methods. A class here
follows the grain rather than fighting the codebase's functional bent, and it lets
dirty-tracking be **private and automatic** — the structural fix for checklist 5 & 6.

This is a class **because there is an ADT with an invariant to encapsulate** (every world
mutation must mark a dirty set), not a turn toward OO — it is exactly the Code Complete
test for when a class earns its keep. The deciding factor over an opaque-type + function
module is enforcement: with private fields a caller *cannot* mutate the world copy without
going through a mutator that marks the dirty set, so the highest-risk bug class (a dropped
DB write from a missed `.add()`) becomes structurally impossible. An opaque type would
rely on convention to keep the two in lockstep. The phases that operate on this state stay
**functions** (see §3.3) — the codebase's functional grain is preserved everywhere a pure
transformation lives; the class is introduced only where mutable state + an invariant do.

```
class WorkingState {
  static fromBundle(bundle: SessionBundle): WorkingState   // does the structuredClone

  // reads (the grounding toolkit, surfaced as methods or delegating to grounding.ts)
  get player(): WorkingParticipant | null
  findParticipant(name: string): WorkingParticipant | null
  coLocatedNpcs(locationId: string | null): WorkingParticipant[]
  findItem(name: string, action: ItemAction, actor): WorkingItem | null

  // mutators — each marks the right dirty set internally (no caller bookkeeping)
  moveParticipant(p, toLocationId): void
  setActivity(p, activity, posture?): void
  placeItem(item, placement: ItemPlacement, note?): void
  setMeters(p, meters): void
  adjustMood(p, delta): void
  setConditions(p, conditions): void
  setAttributeOverlay(p, overlay): void

  // accumulators — every per-turn output lands here, so phases return void (§3.3)
  recordDrop(message: string): void
  stageArrival(line): void; stageDeparture(line): void; stageDirective(line): void
  fireComms(pending: PendingComms): void
  recordFacts(drafts: FactDraft[]): void; setEpisodeSummary(s): void
  recordAffinity(updates: AffinityUpdate[]): void   // applies the reaction→combine order

  // readonly getters (used internally by toMergePlan; exposed for phase-level tests)
  get participants(): readonly WorkingParticipant[]
  get items(): readonly WorkingItem[]
  get touchedItemIds(): readonly string[]
  get touchedParticipantIds(): ReadonlySet<string>
  get droppedEvents(): readonly string[]
  get arrivals(): readonly string[]   // …departures, firedComms, stagedDirectives

  // final assembly — the orchestrator's only post-phase calls
  toBrief(): MergeBrief        // reads from everything; the lone non-accumulator output
  toMergePlan(): MergePlan     // packages participants/items/dirty sets/outputs + toBrief()
}
```

The `structuredClone` of participant/item state moves into `fromBundle`; the ~12 inline
`touchedX.add` calls vanish into the mutators. A missed dirty-mark becomes structurally
impossible, killing the highest-risk bug class.

### 3.2 Folder layout

Promote `merge.ts` → `merge/`:

```
engine/merge/
  index.ts            # public surface ONLY: applyTurnResults, planTurnEffects, the plan/state types
  working-state.ts    # the WorkingState ADT (§3.1)
  grounding.ts        # pure name→row toolkit (A): findParticipant, resolveItemByName, …
  plan.ts             # planTurnEffects — a ~60-line orchestrator over the phase list
  apply.ts            # applyTurnResults — the DB-write transaction (D)
  phases/
    movements.ts  item-events.ts  clock-and-meters.ts  reactions.ts
    conditions.ts  attributes.ts  activities.ts  schedule-tick.ts
    facts-episode.ts  threads.ts  witness.ts  affinity.ts  comms.ts  brief.ts
```

Per-subsystem planners (B) move next to the phase that owns them (e.g. `planAffinityDecay`
→ `phases/affinity.ts`) or into a shared `phases/_shared.ts` when two phases use them.

`engine/index.ts` keeps re-exporting `./merge` (now the folder's `index.ts`) — sibling
engine files (`pipeline.ts` etc.) and the `from "./merge"` import in `pipeline.ts:33`
resolve unchanged. The merge tests repoint to the relative sibling they exercise
(`./merge/grounding`, `./merge/phases/witness`, …); legal because the ESLint boundary
rule (`eslint.config.mjs`, the `src/server/**` block) restricts only **cross-module**
`@/server/*/*` deep imports, never relative intra-module ones.

### 3.3 Phase signature (decided 2026-06-27: mutate `WorkingState`, every phase returns `void`)

```
type Phase = (state: WorkingState, ctx: PhaseContext) => void
```

`ctx` carries the read-only inputs every phase shares (`bundle`, `turn`, `results`,
`reconcile` flag, resolved `clockMinutes`/`minutes`, `defs`, `moodAtTurnStart`, `sink`).

Mutate-in-place beats pure return-by-value: a pure phase would have to invent a command /
diff representation and re-apply it, which splits the mutation+dirty-tracking logic right
back out of the ADT §3.1 exists to consolidate. So phases mutate `state` — and they mutate
it *only* through the ADT's mutators, which is what keeps each phase independently
constructible-and-testable (build a `WorkingState`, run the phase, assert on its getters).

We go one step past a hybrid `PhaseOutput | void`: **every** per-turn output accumulates on
`WorkingState`, so the signature is uniformly `=> void`. The state already carries the
narrative byproducts (`droppedEvents`, `arrivals`, `departures`, `firedComms`,
`stagedDirectives`); the plan-data outputs (`factDrafts`, `affinityUpdates`,
`episodeSummary`) join them as accumulators rather than being returned and merged by the
orchestrator. This removes the `PhaseOutput` union and its merge logic, and the load-bearing
ordering invariants (drift → reaction mood-nudge; reaction edges → affinity combine;
staged-intent tick → schedule tick) reduce to the order of `void`-returning calls. The one
exception is `brief`, which reads from everything else — it is not an accumulator but a
final `state.toBrief()` assembly step.

Cost of this choice: `WorkingState`'s surface grows with outputs that aren't strictly "the
world copy." That line was already crossed (the byproducts above live on state today in the
target design), so consistency favors crossing it fully; the alternative three-tier split
(world mutations / byproducts / plan-data) buys a conceptual boundary at the price of a
non-uniform phase signature. We take uniformity.

`plan.ts` becomes legible end to end — its body is literally the **explicit ordered phase
list** followed by `return state.toMergePlan()`:

```
for (const phase of PHASES) phase(state, ctx);
return state.toMergePlan();   // brief assembled here via state.toBrief()
```

— so the ordering that was smeared across 830 lines and prose comments is stated in one
readable place.

### 3.3a — As-built refinement (2026-06-27): outputs accumulate on `PhaseContext`, not `WorkingState`

The shipped code keeps the **binding** part of §3.3 — every phase is a uniform
`(ctx, state) => void`, and `plan.ts` is the explicit ordered `PHASES` list — but routes the
per-turn *outputs and intermediate scratch* through a mutable **`PhaseContext`** (`ctx`) rather
than folding them all onto `WorkingState`:

```
const state = WorkingState.fromBundle(input.bundle);
const ctx = createPhaseContext(input, state);
for (const phase of PHASES) await phase(ctx, state);
return buildMergePlan(ctx, state);
```

`ctx` carries the read-only inputs (`bundle`/`turn`/`results`/`sink`/`deps` + the resolved
`defs`/`turnStartMinute` and the name→row resolver closures) **and** the mutable cross-phase
state one phase produces for a later one (clock outputs, turn-start mood, the reaction/breach
folds, the runtime-building pieces, `factDrafts`/`affinityUpdates`/`episodeSummary`).
`WorkingState` stayed **exactly** as Slice 2 shipped it — the world copy + its narrative
byproducts (`droppedEvents`/`arrivals`/`departures`/`stagedDirectives`/`firedComms`) + the
private dirty-tracking invariant — and `buildMergePlan(ctx, state)` (a free function in `plan.ts`)
does the final assembly instead of a `state.toMergePlan()` method.

Why this beats the literal "everything on `WorkingState`": §3.3 itself already routed
`clockMinutes`/`minutes`/`defs`/`moodAtTurnStart` through `ctx`, so the plan-data outputs join
their natural siblings there. Folding the whole `MergePlan` (clock scalars, runtime, witnessedBy,
commsChanges, affinityDecay, brief, …) onto `WorkingState` would have turned the world-copy ADT
into a turn-result god-object — directly against checklist items **1/3/8** (one purpose per unit).
Keeping `WorkingState` focused on its single invariant (world mutation ⇒ dirty-mark) and giving
the turn's scratch+outputs their own `PhaseContext` honors those items *better*, at no cost to the
black-box property (item 5/6 are still structural + lint-gated). The §7 re-scoring stands.

---

## 4. Highest-risk / highest-confusion areas (ranked)

1. **Manual dirty-tracking** (`touchedParticipantIds` / `touchedItemIds`, hand-maintained
   at ~12 mutation sites). Highest **risk**: a forgotten `.add()` silently drops a DB write
   in `applyTurnResults`. Fixed structurally by §3.1.
2. **`planTurnEffects` (830 lines)**. Highest **confusion**: phase boundaries are comments,
   ordering invariants are prose, intermediate state is shared locals. Fixed by §3.2/§3.3.
3. **Flat 40-export barrel**. Medium: no public/internal boundary, so any future edit can
   couple to an internal helper. Fixed by §3.2's `index.ts`.
4. **DB layer co-located with pure planning**. Low (it works) but it blocks reading the
   reducer as pure logic. Fixed by `apply.ts`.

---

## 5. Test & safeguard strategy (required before refactoring)

The refactor is **behavior-preserving**; the contract is that `MergePlan` and every DB
write stay byte-identical. Safeguards, in order:

1. **Characterize first (plan Slice 1).** The existing 7-file, ~3700-line suite already
   pins most observable output; before moving code, confirm each phase has an assertion at
   the `planTurnEffects`/`applyTurnResults` boundary (dropped events, dirty sets / row
   writes, `runtime` + `brief` deltas), and backfill any phase that only has helper-level
   coverage. New tests in this slice are **additive** — they must pass against today's code.
2. **`engine.int.test.ts` (811 lines) is the end-to-end gate** — a full turn against
   Postgres, exercising the real `applyTurnResults` transaction.
3. **`pnpm verify` green after every slice** (lint + typecheck + test + jscpd). jscpd must
   not regress: decomposition should *reduce* duplication, so a rise means a helper was
   copied instead of shared.
4. **Slice granularity = revertibility.** ADT swap (S2), toolkit extract (S3), one phase
   per commit (S4), apply+barrel (S5) — each independently green and revertible, so a
   regression bisects to a small diff.
5. **Encapsulation gate (checklist item 6, enforced).** After Slice 2 there must be **zero
   direct field assignment to participant/item state outside `working-state.ts`** — every
   world mutation goes through a `WorkingState` mutator that owns the matching dirty-mark.
   Enforced mechanically (grep gate or ESLint `no-restricted-syntax` on
   `participant.locationId =`, `.state.meters =`, `.state.open =`, … assignment targets),
   added to `pnpm verify` so the ADT's black-box property (item 5) can't silently erode under
   later edits (item 9). This converts the single highest-risk bug class from "caught only by
   tests" to "structurally impossible, lint-enforced."

---

## 6. Non-goals

- No behavior change, no new diagnostics, no schema/migration, no signature change to
  `applyTurnResults` or the `MergePlan` shape.
- Not a rewrite of the per-subsystem planners (B) — they move, they don't change.
- Not a conversion of the whole engine to OO. The one new class is the `WorkingState`
  accumulator; phases stay functions.

---

## 7. Target design re-scored against the checklist

Symmetric to §2 (which scored the **old** code — net ✗ at every inner boundary). This scores
the **proposed** design, so the refactor's success criteria are explicit and checkable. The
class the checklist primarily scores is `WorkingState`; the phase modules are functions but
are held to the same abstraction discipline (noted per row). Legend: ✓ pass · ◐ partial.

| # | Checklist item | Target | How the design achieves it |
| --- | --- | :---: | --- |
| 0 | Thought of as an ADT? | ✓ | `WorkingState` (§3.1) *is* the ADT the working state was begging for — the mutable per-turn world copy + its dirty-tracking, behind an interface. |
| 1 | Central purpose? | ✓ | One purpose per unit: `WorkingState` = the per-turn world copy; `grounding.ts` = name→row resolution; each phase = one subsystem's effect; `apply.ts` = the DB write. |
| 2 | Well named; name describes purpose? | ✓ | `WorkingState`, `grounding`, `phases/movements`, `apply` — each name states its single purpose. |
| 3 | Consistent abstraction? | ✓ | `WorkingState`'s methods sit at one altitude (reads / mutators / accumulators / assembly). `plan.ts` is a *uniform* ordered list of `(state, ctx) => void` calls — the binding constraint behind the Q3 ruling (no half-inline orchestrator). |
| 4 | Obvious how to use? | ✓ | `WorkingState`: `fromBundle` → mutators → `toMergePlan`. Phases: one uniform signature. The barrel exports only the public surface (§3.2), so entry points are unambiguous. |
| 5 | Black box (abstract enough)? | ✓ | Dirty-tracking is private; callers never see `touchedX` maintained. A phase reads `ctx` + state getters and mutates via methods — never how the marks are kept. |
| 6 | Services complete; no meddling? | ✓ | Every mutation owns its dirty-mark inside `WorkingState`; **enforced** by the §5.5 encapsulation gate (zero external field assignment). |
| 7 | Unrelated information moved out? | ✓ | Grounding toolkit → `grounding.ts` (Slice 3); DB writes → `apply.ts` (Slice 5). The reducer reads as pure logic. |
| 8 | Subdivided as far as is useful? | ✓ | `merge/` splits into working-state / grounding / plan / apply / phases; every phase is its own named function. File grouping of *trivial* sibling phases stays flexible (Q3) — subdivide-as-far-as-useful, not classomania. |
| 9 | Interface integrity under modification? | ✓ | External interface (`applyTurnResults`, `MergePlan`) byte-identical (the behavior-preserving contract). Internally, items 5/6 are held by the lint gate, so future edits can't quietly re-flatten the abstraction. |

The two ◐/✗-prone items from §2 that depended on discipline rather than structure — **5**
(black box) and **6** (no meddling) — are the ones now backed by a mechanical gate, which is
what makes item **9** (integrity *preserved under later modification*) credible rather than
aspirational.
</content>
