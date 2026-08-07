# Sim command-shell consolidation — one shell, one read, one fold

Status: draft (sequenced after the approved near-term latency tranche; promote by
domain-sized batches, not as one epic. Re-verified against `src/` 2026-08-07:
nothing here has landed — 46 `runSimulationCommand` call sites, three inlined
shells, five recorder reads, eleven replay folds, all unchanged)

Outcome: A developer can read one description of how a simulation command runs
instead of four, so that a fix to that path stops silently skipping the two space
commands and the scheduler command that never joined it.

## Why

The simulation engine was built gate by gate (E3 → E6, shipped 07-16 → 07-22),
and that pace rewarded copying a working pattern over extracting it. The pattern
is sound: every durable command — move an actor, open an engagement, arm a
trigger — runs through one shared transaction shell owning idempotency, the
branch write lock, the version check, and result persistence. What accreted
around it is roughly **1,600 lines of ceremony** on the engine's most
safety-critical surface: the single write path that serializes every command on a
world branch.

**Copies drift, and one already has.** The engagement row mapper was copied into
a second file with one field silently dropped (**A6**) — the exact masking bug
the original's own warning comment documents, re-introduced. Eight projection
files validate their headers with hand-written checks instead of the shared
branded ones (**A9**), accepting whitespace branch ids that every other boundary
rejects. Neither is doing damage today; both are only ever cheap to fix before
they are.

**The write lock is held longer than it needs to be.** Every accepted command
re-scans the same window of newly-appended events **five times**, four of them
re-parsing the same rows against the full event union, all under the branch write
lock (**A11**) — the best value-per-effort item in the whole audit.

**Three commands never joined the shell at all.** Two space commands and the
scheduler command keep inlined copies (**A2**). The shell runs five post-accept
recorders; the space copies run two, the scheduler copy runs none. That is benign
only by coincidence of which event types those recorders currently look at — and
fork replay re-folds *every* inherited event through all five, so the day a space
or scheduler event type joins a recorder's list, a live branch and a fork of it
disagree, surfacing only at fork time. Before this plan the cleanup existed
nowhere but two code comments, which by the roadmap rule is itself a bug
(**F3b**); this plan and its `roadmap.md` line are its materialization.

**None of it is visible to the duplication gate.** jscpd's global budget and
token floor let 46 near-identical call sites and eleven byte-identical fold loops
pass unremarked (**F1**, a separate tooling batch).

## Scope

Audit batch 2. Everything here is inside `src/server/engine/simulation`,
`src/lib/simulation`, and `src/contracts/simulation`.

- **Call-site ceremony** — A1 (46 sites, ~1,100 lines the shell can synthesize
  from the result schema plus one noun), A8 (13 identically-shaped option
  interfaces → one), A5 (three crash-injection copies → one shell hook).
- **Shared plumbing** — A4 (per-domain resolver boilerplate → one kit), A3
  (eleven byte-identical replay folds → one generic fold), A10 (seven readers
  repeating one branch-header read → one loader).
- **Correctness edges** — A9 (weak projection-header validators), A6 (drifted row
  mappers), A10's torn-read exposure.
- **Hot paths** — A11 (the five-scan window read), A12 (an N+1 on
  engagement-open), A13 (a max-order scan per armed trigger plus an N+1 inside
  the fork transaction), A14 (a whole-topology load to extract one zone id), A15
  (unbatched recorder upserts).
- **Shell migration** — A2, last and with the most care.

Net expectation: ~1,600 lines removed, five queries per accepted command
collapsed to one, and "the shell" becoming the only place a command transaction
is described.

## Non-goals

- **The fork-domain registry and snapshot ruling (A7, A16).** Those are batch 3
  ([sim-fork-registry.plan.md](sim-fork-registry.plan.md), when written) and
  build directly on this plan's A3 and A2. Deliberately separated by risk.
- **Dead-code removal in the simulation area** (A17 the uncalled body-modifier
  handler, A18, A19 the barrel split). Batch 10's mechanical sweep.
- **No behaviour change.** Every slice is meant to be observably inert to a player
  and to the corpus suites. Where a slice cannot be — A9's stricter validation,
  A2's added recorders — that is called out and proven, not assumed.
- **No schema migration, no new command types, no new domains.** (A13's
  per-branch sequence counter is the one item that might want one — see Open
  questions.)

Implementation detail — the kit's shape, the generic fold's signature, the
recorder filter lists, diagnostic codes — belongs in a future
`sim-command-shell.spec.md`, written when the first slice is picked up.

## Review rulings and scope adjustments — 2026-07-30

- Pull **A11's one-window recorder read** into the approved cheap hot-path tranche;
  it should not wait for the full consolidation program.
- Split the 46-site / 16-file shell migration into small domain batches with a
  green corpus checkpoint between them. It remains one plan, but not one enormous
  mechanical commit.
- The final inlined-shell migration is **not behavior-neutral by inspection**.
  Adding recorders changes which code executes, and one observation recorder reads
  a broader window before filtering. The engine corpus suites and projection-row
  comparisons are the proof.
- For **A13**, batch the safe fork-loop work only. A counter/generated-column
  migration is deferred until measurements justify adding a schema change.
- Keep the riskiest shell migration last, after the generic replay and helper
  extractions have made the comparison surface smaller.

## Delivery slices

Ordered so each lands on its own, and so the riskiest change goes last onto a
surface the earlier slices have already simplified.

**1 · Read the event window once (A11).** Shell-only change: read and parse the
newly-appended events once, hand the array to the five recorders, each of which
already knows which types it cares about. Five queries become one and the lock
hold shortens on the path every command shares. Touches no call site, so it
lands first and its win is measurable immediately.

**2 · Close the three consistency gaps (A9, A6, A10).** Give the projection
files the shared branded header validation; delete the drifted row-mapper copies
in favour of imports (one needs a leaf module to avoid a genuine import cycle,
the others are straight deletions); replace the repeated branch-header read with
one loader that also settles the isolation level. Expect real typecheck errors
from A9 — that is the validation gap becoming visible, and each one is a finding
to read rather than noise to silence.

**3 · The shared kit (A4, A3).** One resolver kit for the per-domain rejection,
privilege, branch-guard and event-envelope-base boilerplate; one generic
projection replay replacing eleven copies, which also stops the sequence-gap
invariant from living in eleven places. Pure code, no database, and the point
where batch 3's fork registry gets the fold it needs — design the fold's shape
with that consumer in mind so it is written once.

**4 · The shell synthesizes the ceremony (A1, A8, A5).** The largest slice by
line count and the one that touches the most files (16). The shell derives its
result factories from the result schema plus one noun, offers an accepted-result
helper for the 49 identical return blocks, takes one options type instead of 13,
and owns crash injection behind a single hook. Roughly 1,100 lines become 60.
Mechanical, wide, and best done as one sweep rather than trickled per domain.

**5 · The remaining hot paths (A12, A13, A14, A15).** Four independent batching
and lookup fixes, each small. A14 starts with a question rather than an edit (see
Open questions). Splittable further if any one proves awkward.

**6 · Shell migration (A2).** Move the two space commands and the scheduler
command onto the shell and delete their inlined copies. This is the slice that
closes the fork-parity hazard, and the only one where the corpus suites are the
gate rather than a formality: green before, green after, and the diff read for
what the three newly-run recorders now touch.

## Success criteria

- **Every slice reaches a green `verify` check on its own pull request.**
  Validation is CI-only (root `CLAUDE.md`) — never invoke a gate locally. Because
  every slice touches the engine and database surfaces, CI's classifier will also
  run the engine test job against Postgres, which covers the simulation store
  suites plus the successor route and narrator integration tests. Note that jscpd
  will *not* certify this work — F1 is why these clones survived the gate in the
  first place.
- **Slice 6 additionally** requires the four gate corpus suites green **before
  and after** the change. Fork parity is the engine's correctness spine, so the
  before-run is the baseline that makes the after-run mean something; a corpus
  regression here is a stop-work, not a follow-up. Run them by pushing the
  pre-change tree and the post-change tree as separate CI runs rather than
  locally.
- **Slice 1** shows one event-window query per accepted command instead of five,
  recorder outputs unchanged on a corpus run. **Slice 2** leaves no hand-written
  projection header validator and no duplicated row mapper. **Slice 6** leaves
  exactly one description of a command transaction in the codebase, with the
  stale "until a dedicated cleanup migrates them" comments deleted, not reworded.
- Net line count down by ~1,600; no new table, column, or command type.

## Risks & coordination

- **Fork parity is the spine.** Fork replay re-folds all inherited events, so any
  change to what a recorder sees, or to the order recorders run in, can make a
  forked branch differ from the branch it forked. The corpus suites are the only
  cheap detector; slices 1 and 6 both touch this, so run the corpora on both.
- **Slice 6 is not provably inert by inspection.** It adds three recorders to the
  space commands and five to the scheduler command. Today's recorder type filters
  are expected to exclude those event types — but one recorder reads the window
  unfiltered and leans on a downstream unobservable-type set, so "expected" needs
  the corpus suites and a read of the resulting rows, not an argument.
- **Batch 3 builds on this plan.** The fork-domain registry
  ([sim-fork-registry.plan.md](sim-fork-registry.plan.md), A7) wants slice 3's
  generic replay fold and a migrated shell; sequence it after slice 6, and let its
  needs shape the fold signature in slice 3 so that fold is written once.
- **Slice 4 is a wide mechanical diff** across 16 files on the write path — its
  own commit, unmixed with behavioural work, so a bisect over it means something.
- **The audit is the citation source**, not a second copy of the findings. When a
  line reference there has moved, trust the ids and re-grep.

## Open questions

- **OQ1 — one refusal sentence, or per-domain phrasing?** Confirm whether any
  command domain needs wording different from the shared not-found-shaped refusal.
- **OQ2 — durable-read isolation.** Decide whether all seven readers require the
  repeatable-read/read-only shape, and record the ruling in the engine operations
  spec before slice 2.
- **OQ3 — pressure lookup scope.** Confirm whether the resolver needs only the
  origin zone id or a larger topology projection.
- **OQ4 — crash injection.** Decide whether the shared shell hook is reachable
  only through the existing test-mode seam.
