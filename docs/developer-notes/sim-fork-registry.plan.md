# Fork registry & snapshot ruling — making "add a domain to a fork" a data edit

Status: draft (unscheduled — derived from [codebase-efficiency.audit.md](codebase-efficiency.audit.md); no roadmap line yet)

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

- Full gate green, run as separate sequential commands: `pnpm lint` →
  `pnpm lint:cycles` → `pnpm typecheck` → `pnpm test` → `pnpm jscpd`.
- **The gate3/4/5/6 corpus integration suites are green before AND after.** Fork
  parity is the engine's correctness spine, so the before-run is not a formality —
  it is the baseline that makes the after-run mean something.
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
- **Roadmap hygiene (F3b).** Both the shell migration and this registry currently
  exist only as code comments with no roadmap line, which the house rules count
  as a bug. This plan needs its roadmap line added when it is scheduled.
- **D19 overlap.** A future branch/fork UX build inherits the registry; keep the
  retained primitives working rather than trimming them to the current callers.
- **Migrations.** None expected for slices 1–3. A "yes" on A16 may need one, which
  is part of what makes it a separate decision.

## Open questions

1. **(Owner) Should checkpoint coverage extend past materials?** A16. Faster forks
   on long-lived worlds, paid for by weakening the from-zero rebuild that
   currently catches a bad checkpoint (`snapshot-store.ts` §10.4). Recommended
   default: keep materials-only until measured fork cost on a real long world
   says otherwise — the registry means saying yes later is cheap.
2. If yes, which domains go first, and does the from-zero rebuild stay as a
   periodic audit rather than the default path?
3. Is a hard ceiling on fork-chain depth the right and only guard, or should a
   fork also warn or refuse above some recorded-history size?
4. Should registry completeness be enforced by a test, by the type system, or
   both?
