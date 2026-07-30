# Sim command-shell consolidation — one shell, one read, one fold

Status: draft (unscheduled — derived from [codebase-efficiency.audit.md](codebase-efficiency.audit.md); no roadmap line yet)

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
disagree, surfacing only at fork time. This cleanup exists **nowhere but two code
comments**, which by the roadmap rule is itself a bug (**F3b**); this plan is its
materialization.

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

- **Every slice** passes the standard gate, run as **separate commands, one at a
  time** (never `pnpm verify`): `pnpm lint` → `pnpm lint:cycles` → `pnpm
  typecheck` → `pnpm test` → `pnpm jscpd`. Note that jscpd will *not* certify
  this work — F1 is why these clones survived the gate in the first place.
- **Every slice** also passes `pnpm test:engine` (needs a local Postgres), which
  covers the simulation store suites plus the successor route and narrator
  integration tests.
- **Slice 6 additionally** requires the four gate corpus suites green **before
  and after** the change, run individually: `pnpm test:engine-e3-5`,
  `pnpm test:engine-e4-5`, `pnpm test:engine-e5-6`, `pnpm test:engine-e6-5`.
  Fork parity is the engine's correctness spine; a corpus regression here is a
  stop-work, not a follow-up.
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

- **OQ1 — one refusal sentence, or per-domain phrasing?** The unavailable-branch
  message appears 95 times identically. Slice 4 assumes one shared sentence,
  templated on a noun, is right everywhere — confirm no domain needs its own
  wording, and that the deliberately not-found-shaped refusal keeps that shape.
- **OQ2 — what is the intended isolation level for durable reads?** Two of the
  seven readers wrap in repeatable-read/read-only; five can see torn state. Slice
  2 needs a ruling, recorded in the engine spec's operations cluster.
- **OQ3 — does the pressure resolver need more than the origin zone id?** A14
  loads the whole branch topology for one field. If the zone id is all it uses, an
  indexed two-column lookup replaces the load; if not, the slice becomes a
  narrower projection. Answer before editing.
- **OQ4 — should crash injection be gated?** Hoisting the three copies into a
  shell hook (A5) makes crash points reachable from all 46 sites. Unconditional,
  or behind the existing test-mode seam?
- **OQ5 — does A13 want a schema change?** Replacing the per-trigger max-order
  scan with a per-branch counter or generated column would be this batch's only
  migration, which Non-goals currently forbid. Either ship the fork-loop batching
  alone and defer the counter, or lift that constraint deliberately.
