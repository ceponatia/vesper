# E2.5 — forks, snapshots, and audit

Status: **shipped — 2026-07-17** — all deliverables landed in one slice: the pre-work outbox
reclaim fix, trigger creation behind a `trigger_scheduled` event (R1 prerequisite), ancestry
columns + the R4 bounded read, `forkBranch` with replay-recreated triggers, `sim_snapshots`
with capture/discard, rebuild-from-zero/from-snapshot hash comparison, and
`explainItemPlacement`. CI runs `test:engine-e2-5` after the E2.4 step. Leftovers: trigger
*cancellation* as an event effect is deferred until a cancellation surface exists (noted in
`docs/contracts/simulation.md` §Deliberate limits); chat-lane retake wiring stays Gate 3+;
E2.6 (Gate 2 soak and verdict) is next.

Depends on E2.4 at `04b7325` (PR #14, merged). The fifth Gate 2 target
([engine.plan.md](../../finished/engine/engine-foundation.plan.md) §"Gate 2 build order"). It adds branch ancestry, fork
boundaries, checksummed snapshots, projection comparison, and causal explanation queries
on top of the stable event store (E2.2–E2.4). It adds no movement, bodies, live-scene
arbitration, model call, or live-chat authority — those are Gate 3+.

The spec owns the normative contracts (§10.4 snapshots, §11 transaction protocol, §29
retakes/branches/replay). This plan owns sequence, scope, the owner rulings below, the
pre-work gap it closes, and exit criteria.

## Outcome

A branch can be **forked** at any past point into a causally isolated child timeline. The
child inherits everything true at the fork point and nothing the abandoned future created;
the parent is untouched and remains the record. A **snapshot** lets replay resume from a
checkpoint instead of sequence zero, and can be discarded and rebuilt without changing
truth. An operator can ask **why** a branch is in its current state and get a causal answer
from records, not prose.

This is the machinery behind the product's rewind: §29.1 defines a **retake** as a fork
from the pre-turn sequence, and a **reach-back edit** as always a fork. E2.5 builds the
fork; the chat lane wiring onto it is later.

## Rulings this plan makes

The owner settled four fork decisions on 2026-07-17. They are recorded here because they
shape the schema and the mechanism, and undoing one later is expensive.

### R1 — a fork rebuilds by replaying events, never by copying trigger rows

When a branch forks at sequence N, the child's state is produced by **replaying the parent's
events 1..N through the same projectors and effects that produced them live**. It is not
produced by copying the parent's current projection rows or its pending trigger rows.

This is the whole reason the fork stays correct. A scheduled future event (an "alarm" — a
`sim_triggers` row) is re-created only if the event that scheduled it falls at or before N
and therefore replays. An alarm the discarded future scheduled after N was set by an event
past the fork point, never replays, and so simply does not exist in the child. The engine
never has to reason about "which alarms belong to the abandoned timeline" — replay answers
it structurally.

Worked example. Mara's 4pm shift alarm was set at 10am story-time; the player rewinds to
2pm. 10am ≤ 2pm, so the setting event replays and the shift alarm returns. A 2:30pm alarm
created by the now-discarded conversation was set after 2pm, never replays, and is gone.

**Replay re-applies recorded events; it does not re-run NPC decisions.** "Mara scheduled a
6pm visit" is a committed fact with a fixed position in history. Replaying it re-produces
exactly that alarm every time — the fork is deterministic, not a reroll of her judgment.

### R2 — the world is player-independent, which already yields the owner's nuance

An NPC's private, not-yet-acted-on plan survives a rewind the player made for unrelated
reasons — the world's commitments are not contingent on the player's retries. Under R1 this
needs no separate rule and automatically produces the owner's stated nuance:

- Mara's 6pm visit **scheduled at 1pm**, player rewinds to 2pm → the 1pm setting event
  replays (1pm ≤ 2pm) → the visit **survives**.
- The same visit **scheduled at 3pm**, player rewinds to 2pm → the 3pm setting event is past
  the fork point, never replays → the visit is **gone**.

Deleting a plan that had not been made yet at the rewind point is not erasing Mara's agency;
it is respecting causality. A plan made at 3pm genuinely did not exist at 2pm.

### R3 — world creation keeps the direct seed; forking is a separate mechanism

Creating a brand-new world keeps the current `seedDurableItemTransferBranch` direct-setup
path. Forking ("copy an existing timeline from a past point") is its own mechanism built
here. They coexist:

- **create** — direct seed, one root branch with no parent. Accepted limitation: world
  creation is not itself an event stream, so rebuild-from-zero cannot validate the seed step
  (only everything after it).
- **fork** — replay parent events into a child, per R1.

Unifying the two behind a scripted setup-event stream was considered and declined: it widens
E2.5 and rewrites the seed path every existing test depends on. It stays a candidate for a
later target if rebuild-validating world creation ever earns its cost.

### R4 — a child references ancestor events by ancestry; it does not copy them

A forked child stores only its own post-fork events. Ancestor events 1..N are read through
the parent chain, bounded by the fork sequence — not duplicated into the child's rows. This
follows §29.3's "queries must include branch ancestry rules and sequence bounds," which
presumes reads walk ancestry rather than each child owning a full copy. It also keeps a fork
cheap regardless of how deep the parent's history is.

What R4 obliges:

- **Every branch-scoped read walks ancestry.** Loading a child's events, projections, or
  memory means: the child's own rows, then the parent's rows with `sequence ≤ forkSequence`,
  recursively up the chain. A read helper must encapsulate this so call sites cannot forget
  the bound and leak post-fork ancestor events (which belong to a sibling timeline).
- **Rebuild-from-zero for a child** replays ancestor events 1..N through the chain, then the
  child's own N+1.. — producing the same projection hash as the live child.
- **Isolation is by sequence bound, not by copy** (§29.3 "never shared by mutable reference").
  Ancestor events are immutable and read-only; the child never writes into an ancestor's rows,
  so sharing them by reference is safe.

The cost R4 accepts: reads are more complex than a flat single-branch query, and a
pathologically deep fork chain lengthens ancestry walks. Snapshots (below) blunt the latter —
a child's snapshot checksums its full logical range so replay need not always walk to the root.

## Prerequisite this ruling creates

R1 has a hard precondition that is **not** true in the code today, and it is the first real
work of E2.5:

**A trigger must be created as the effect of a committed event, not by a direct call.**

Today `scheduleDurableTrigger` inserts a `sim_triggers` row directly, outside any event. If
that stays, replay cannot re-create alarms and the only way to fork would be to copy trigger
rows — exactly the approach R1 rejects. So E2.5 makes trigger creation (and cancellation) an
event effect applied inside the command transaction. Spec §11.1 step 10 already places
"insert, update, or cancel scheduled triggers" inside that transaction, so this aligns the
implementation with the spec rather than extending it.

Concretely: an event that schedules future work carries that intent in its payload, and the
replay/apply path re-inserts the trigger when it re-applies the event. Direct
`scheduleDurableTrigger` calls become event-effect calls. The E2.4 store keeps its
claim/lease/resolve logic unchanged — only the *creation* path moves behind an event.

## Deliverables

Grounded in spec §10.4, §11, and §29.3.

### Branch ancestry (§29.3)

Add to `sim_branches` (or an adjacent table): parent branch ID, fork sequence, fork story
second, parent ruleset version, parent event-schema version, initiating principal, and fork
reason. A root branch has a null parent. `(parent_branch_id, fork_sequence)` is the fork
boundary.

### Fork operation

A `forkBranch(parentId, atSequence, principal, reason)` that:

1. records the ancestry row above and the inherited snapshot checksum;
2. establishes the child so that reads see ancestor events 1..N plus the child's own events;
3. re-creates the child's pending triggers by replaying the setting events ≤ N (R1);
4. never shares post-fork events by mutable reference (§29.3).

The child references ancestor events by ancestry rather than copying them (R4), so step 2 is
a read-path concern, not a bulk copy: the child's row set stays empty at fork time and grows
only as it resolves its own commands.

### Snapshots (§10.4)

A `sim_snapshots` table carrying branch, sequence, projection schema version, ruleset
version, deterministic checksum, and source event range. Snapshots accelerate replay and
**may be discarded at any time**. Reuse `simulationHash` (`src/lib/simulation`) for the
checksum so snapshot and live-projection hashes are directly comparable.

### Projection comparison and rebuild-from-zero

A tool that rebuilds a branch's projection from events (optionally from a snapshot) and
compares its hash to the live projection. §10.4 is normative that **tests MUST periodically
rebuild from zero** so a subtly-wrong snapshot cannot hide a replay defect by always being
loaded. E2.3's `rebuildItemTransferFeed` already returns a projection hash to compare
against; extend the pattern to the authoritative projection.

### Causal explanation queries

Read-only "why is this branch in this state" queries over the immutable records: given a
projection fact, walk back through the event(s) and command(s) that produced it, using the
existing `sim_events.command_id` / `derivation_version` provenance and (E2.4)
`sim_triggers.result_command_id`. No new mutation surface; the presentation auditor (spec
§ topology) may read it but never writes truth.

## Gap to close first (pre-E2.5, task #9)

**E2.3 outbox unbounded reclaim.** `outbox-store.ts` reclaims `processing` rows whose lease
expired without bounding `attempts`, and only its catch block writes terminal state — so a
consumer that dies by process crash (not an exception) is reclaimed forever and never
quarantines. This is the exact twin of the scheduler crash-loop E2.4 fixed. Carry E2.4's
claim-time quarantine across: a candidate already at `maxAttempts` is marked `failed` and
skipped at claim time. Add an integration test that fails without the fix.

It is small, independent, and does not strictly gate E2.5, but it is the same defect class
E2.5's replay/rebuild machinery relies on being absent, so it lands first.

(The second gap once filed — "no column recording when an alarm was set" — is **dissolved**
by R1. Under replay, the setting event's own position in history records when the alarm was
set; no column is needed. Do not build it.)

## Implementation order

1. This plan and its rulings.
2. Close the outbox reclaim gap (task #9).
3. Move trigger creation/cancellation behind an event effect (the R1 prerequisite); prove
   E2.4's scheduler suite still passes with creation flowing through events.
4. Add ancestry columns and the fork boundary; migration. Add the ancestry-bounded read
   helper (R4) and route existing branch reads through it before any fork can create a child
   that depends on it.
5. Implement `forkBranch`: record ancestry, and re-create the child's pending triggers by
   replaying setting events ≤ N. No bulk event copy — the child references ancestor history
   through the R4 read helper.
6. Add `sim_snapshots`, snapshot capture, and hash reuse.
7. Implement projection rebuild + comparison and the rebuild-from-zero test cadence.
8. Add causal explanation queries.
9. Export new surfaces from the simulation barrel; `pnpm test:engine-e2-5`; CI step after
   the E2.4 step.
10. Update `docs/database.md`, `docs/contracts/simulation.md`, and the roadmap; run
    from-zero CI.

## Required tests

Pure:

- fork ancestry math (fork sequence bounds, root vs child) validates;
- snapshot checksum equals the live-projection hash for the same event range.

PostgreSQL:

- a fork at N re-creates exactly the triggers whose setting event is ≤ N, and none after
  (R1 — the worked examples in R1/R2 become fixtures);
- forking does not mutate the parent branch, its events, or its triggers;
- post-fork events on the child are not visible on the parent and vice versa (§29.3);
- an ancestry-bounded read on the child returns ancestor events with `sequence ≤ forkSequence`
  and none after, so a sibling fork's post-fork events never leak in (R4);
- rebuild-from-zero equals the live projection by hash;
- rebuild-from-snapshot equals rebuild-from-zero (a snapshot cannot hide a replay defect);
- discarding a snapshot changes no truth;
- a causal explanation query returns the event/command chain that produced a projection fact;
- trigger creation via event replays correctly: replaying a branch re-inserts its pending
  triggers, and the scheduler then resolves them identically to the live run.

## Exit criteria

E2.5 advances when from-zero CI proves: a fork inherits exactly the pre-fork world including
its pending alarms and nothing after; parent and child are causally isolated; rebuild from
zero, from snapshot, and live projection all agree by hash; snapshots are discardable without
truth change; and causal explanation answers from records. A fork that leaks post-fork state
across branches, an alarm that survives a rewind past its own creation, or a snapshot that
diverges from a zero rebuild means revise rather than advance.

## Explicit deferrals

- **E2.6 — Gate 2 soak and verdict.** The synthetic-month, partition-invariance, retry,
  crash, and queue-growth proofs, and the owner's advance/revise/hold/stop ruling, are the
  next target after this one.
- **Unified event-sourced world creation** (R3's declined alternative) — a later target only
  if rebuild-validating the seed step earns its cost.
- **Chat-lane wiring of retake/reach-back onto forkBranch** — Gate 3+; E2.5 builds the fork,
  not its UI.
- **Movement, commitments, live-scene arbitration** — Gate 3.

## Open questions

None.

Resolved:

- *Copy vs reference for ancestor events* — reference-by-ancestry (owner ruling
  2026-07-17); see R4.
- *Snapshot cadence* — the suggested simple default shipped: `forkBranch` snapshots the
  fork point automatically and `captureBranchSnapshot` covers on-demand; tune with data
  later if a per-K-events cadence earns its cost.
