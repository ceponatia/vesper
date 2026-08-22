# Fork registry & snapshot ruling — making "add a domain to a fork" a data edit

Status: draft (sequenced after sim-command-shell; snapshot expansion ruled out
until measured. Re-verified 2026-08-07: `forkBranch` is still one 633-line
function and `branch-store.ts` is still 1,035 lines — the target is unchanged)

Outcome: A developer can enrol a simulated domain in fork rebuilding with a
one-line data edit and see a test fail if they forget one, so that a forked
world stops being able to come back quietly missing part of itself.

## Why

Forking is the successor engine's honest answer to "what if this had gone
differently". The ground rule is that a retake is a fork: rather than rewriting
a past moment in place and leaving the rest of the world out of step, the engine
starts a new timeline from that moment and rebuilds the child world by re-running
its recorded history. That rebuild is the correctness spine of the whole engine —
if a fork produces a world that disagrees with the one it came from, every
promise the simulation makes is void.

Today that rebuild works, but it is written out by hand ten times over. Fork is a
single 633-line function (`branch-store.ts:403-1035`) repeating the same five-step
recipe once per simulated domain — bodies, households, spaces, activities,
commitments, engagements, item condition, knowledge, cohorts and the rest. Every
gate that added a domain added another copy. The consequence is a maintenance trap
with a delayed alarm: whoever adds the eleventh domain must remember to hand-write
its pass, and if they forget, nothing fails — the forked world is simply missing
that part of itself, and nobody finds out until someone forks. Audit finding
**A7** replaces the ten copies with one table of domains plus one shared pass, so
"this domain takes part in forking" becomes a one-line data edit that cannot be
half-done.

The second half is a cost question. Only one domain (materials) keeps
checkpoints; every other domain rebuilds from the very beginning of the world's
recorded history on every fork, with the only guard being a hard ceiling on how
deep a chain of forks may go. That gets slower the longer a world is played.
Extending checkpoints further is not a free optimization — the deliberate
from-zero rebuild is what catches a bad checkpoint (`snapshot-store.ts` §10.4) —
so audit finding **A16** is a product decision about trading rebuild honesty for
fork speed, not a cleanup. This plan makes that decision askable by putting the
measurements and the registry in place first.

## Scope

- **A7 — the fork domain registry.** One data table describing each domain's
  participation in a fork, one shared "when was this row last touched" pass, and
  removal of 13 redundant re-sorts of lists the database already returned in
  order. Fork behavior is unchanged; the function drops to roughly 180 lines.
- **A completeness guarantee.** A registered domain that is missing from the fork
  path should fail a test, not a playthrough.
- **Fork cost, measured.** Time and query count for forking a long-history branch,
  recorded so the A16 conversation has numbers instead of intuition.
- **A16 — the snapshot ruling.** Frame the options and their correctness cost, get
  the owner's decision, and record it. Building an extension is out of scope here.

## Non-goals

- **No player-facing fork feature.** Branch switching, "fork the story from here",
  and "what changed this turn" are D19
  ([deferred/sim-branch-ux.plan.md](deferred/sim-branch-ux.plan.md)) and stay
  parked.
- **Do not delete the unwired fork and replay primitives.** They have no
  production callers today and that is intentional — D19 is the plan that will
  wire them, and it gets easier once the registry exists. This work refactors
  them; it does not prune them.
- **No change to what a fork means.** Which state a child inherits, and the rule
  that a child is rebuilt from recorded history rather than copied from current
  rows, are both unchanged.
- Not the command-shell consolidation (that is batch 2, below).

## Review rulings and scope adjustments — 2026-07-30

- **Keep snapshot coverage materials-only.** Measure real long-world fork cost
  after the registry lands; expand only if that evidence shows a meaningful
  problem. Rebuild-from-zero remains the routine honesty check.
- "Adding a domain is a data edit" means registering an already-implemented
  projection domain. The registry does not implement a new domain's projector,
  storage, replay semantics, or tests.
- The registry must support a composite last-touch answer: temporal-pressure rows
  can be affected by more than one event family.
- The command-shell migration and generic replay fold remain hard prerequisites;
  do not work around either dependency inside this plan.

## Delivery slices

**Ordering, stated plainly: this plan starts after
[sim-command-shell.plan.md](sim-command-shell.plan.md) lands** — specifically its
generic replay helper (**A3**, which collapses eleven near-identical history-fold
loops the fork path calls into) and its command-shell migration (**A2**, which
closes a fork-parity hazard where two older code paths skip post-command
recorders). Doing this plan first would mean refactoring against eleven separate
fold implementations and inheriting a known divergence, and any fork mismatch A2
causes would be misread as a regression from this work.

1. **Baseline and measurement.** Green corpus run recorded as the before-picture;
   fork timing and query counts captured on a long-history branch.
2. **The registry (A7).** Convert the ten hand-written passes to registry entries
   and one shared last-touch pass, and drop the redundant re-sorts. One domain at
   a time, corpus green between each. A wrinkle confirmed in the code: at least
   one domain's rows take their last-touch moment from two different event
   families, so the registry has to allow a composite answer — the spec pins the
   shape.
3. **Completeness test.** A test that fails if a registered domain is not carried
   through a fork, plus adding one domain purely as a data edit to prove the
   payoff.
4. **The snapshot ruling (A16).** Options, costs, and the honesty trade written up
   against the measurements from slice 1; owner decision recorded.

## Success criteria

- **The ready PR's aggregate `verify` check and `engine integration` job are green.**
  This plan touches simulation/database surfaces, so `.github/workflows/ci.yml`
  must select the Postgres-backed job that applies migrations, runs
  `pnpm test:engine`, and executes the Gate 1 benchmark. There is no local
  pre-push gate; if an applicable change does not select engine integration, fix
  the classifier rather than substituting a retired wrapper command.
- **The gate3/4/5/6 corpus integration suites are green before AND after.** Fork
  parity is the engine's correctness spine, so the before-run is not a formality —
  it is the baseline that makes the after-run mean something. Use the pre-change
  `main` CI result as the baseline and the ready PR's engine-integration result as
  the post-change proof; focused local corpus runs may diagnose failures but are
  not the repository gate.
- Forking the same branch produces an identical child world before and after the
  change, compared by projection checksum rather than by eye.
- Fork wall time and query count no worse than the baseline; the removed re-sorts
  and batched inserts should make it better.
- Adding a domain to fork replay is a single reviewable data edit, and omitting
  one fails a test.
- A16 has a recorded ruling, whichever way it goes.

## Risks & coordination

- **The audit's highest-risk mechanical change** (large effort, medium risk),
  precisely because a mistake is quiet. Mitigations: one domain per commit,
  checksum comparison, and the corpus suites as the gate.
- **Sequencing with batch 2** is the main coordination cost — see the ordering
  note above. If the shell migration slips, this plan waits rather than working
  around it.
- **Roadmap hygiene (F3b) — closed.** The shell migration and this registry once
  existed only as code comments with no roadmap line, which the house rules count
  as a bug. Both are now named in `roadmap.md`'s later-consolidation entry. The
  rule still binds any future domain this plan adds.
- **D19 overlap.** A future branch/fork UX build inherits the registry; keep the
  retained primitives working rather than trimming them to the current callers.
- **Migrations.** None expected for slices 1–3. A "yes" on A16 may need one, which
  is part of what makes it a separate decision.

## Open questions

1. Should a fork warn or refuse above a measured history-size threshold in
   addition to the existing fork-chain-depth ceiling?
2. Should registry completeness be enforced by a generated type relationship as
   well as the required corpus/checksum test?
