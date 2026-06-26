# Merge reducer decomposition — spec

Status: **draft** (proposal). The design + evidence behind
[merge-decomposition.plan.md](merge-decomposition.plan.md). Subject:
`src/server/engine/merge.ts` (2655 lines, as of 2026-06-26). Produced by the Code
Complete "complete review" framework (`docs/prompts/complete-review.md`). System doc:
[turn-engine.md](../turn-engine.md) §"Merge reducer".

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

### 3.1 `WorkingState` — the ADT (recommend: a class)

A mutable-accumulator class, matching the existing precedent — `EventChannel`
(`pipeline.ts:91`) and `DiagnosticCollector` (`contracts/diagnostics.ts:21`) are both
mutable accumulators with private fields and intention-revealing methods. A class here
follows the grain rather than fighting the codebase's functional bent, and it lets
dirty-tracking be **private and automatic** — the structural fix for checklist 5 & 6.

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

  // accumulators
  recordDrop(message: string): void
  stageArrival(line): void; stageDeparture(line): void; stageDirective(line): void
  fireComms(pending: PendingComms): void

  // readonly getters consumed when assembling the MergePlan
  get participants(): readonly WorkingParticipant[]
  get items(): readonly WorkingItem[]
  get touchedItemIds(): readonly string[]
  get touchedParticipantIds(): ReadonlySet<string>
  get droppedEvents(): readonly string[]
  get arrivals(): readonly string[]   // …departures, firedComms, stagedDirectives
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

### 3.3 Phase signature (recommend: mutate `WorkingState`, return only fragments)

```
type Phase = (state: WorkingState, ctx: PhaseContext) => PhaseOutput | void
```

`ctx` carries the read-only inputs every phase shares (`bundle`, `turn`, `results`,
`reconcile` flag, resolved `clockMinutes`/`minutes`, `defs`, `moodAtTurnStart`, `sink`).
Most phases mutate `state` and return `void`; the few that contribute non-state plan
fragments (e.g. `facts-episode` → `factDrafts` + `episodeSummary`; `affinity` →
`affinityUpdates`) return a typed `PhaseOutput` the orchestrator merges into the
`MergePlan`. This keeps the diff small (state still mutates as today) while making each
phase independently constructible-and-testable against a `WorkingState`.

`plan.ts` becomes legible end to end — its body is the **explicit ordered phase list**,
so the load-bearing ordering invariants (drift → reaction mood-nudge; reaction edges →
affinity combine; staged-intent tick → schedule tick) are stated in one readable place
instead of being smeared across 830 lines and prose comments.

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

---

## 6. Non-goals

- No behavior change, no new diagnostics, no schema/migration, no signature change to
  `applyTurnResults` or the `MergePlan` shape.
- Not a rewrite of the per-subsystem planners (B) — they move, they don't change.
- Not a conversion of the whole engine to OO. The one new class is the `WorkingState`
  accumulator; phases stay functions.
</content>
