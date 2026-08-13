# Contracts hygiene sweep — retire the R6 leftovers, speed up the hot lookups

Status: draft (E13/E14 approved for the early hot-path tranche; the broad hygiene
sweep stays late. Re-verified 2026-08-07: nothing has landed — `puppet.ts`,
`authored.ts`, `rules/index.ts` and `mood/atmosphere.ts` are all still present,
`bodyLocationRegistry.expand` still recurses on every call, and `forCategory` /
`forBodyLocation` still linear-scan the definition list)

Outcome: A developer can open `src/contracts` and find nothing that describes a
system the app already deleted, so that adding a vocabulary item stays the
one-file data edit it is advertised as instead of a hunt through dead seams.

## Why

`src/contracts` is the pure heart of the domain: the registries and validation
rules everything else checks itself against. Its promise is that **adding a
vocabulary item is a one-file data edit**, so it has to stay legible — a reader
should be able to tell at a glance what is live.

The 2026-07-30 efficiency audit (§E, batch 9) found that promise mostly intact —
`world/` and `turns/` are the *busiest* folders here, not R6 leftovers as assumed
— but it also found three things worth a deliberate pass:

- **Leftovers from the retired world model still ship, and are still documented
  as if live** (E1, E2, E4, E6, E7, plus 51 exports referenced nowhere at all,
  E5). Each one costs a reader time and invites someone to build on a dead seam.
- **Two tiny lookups redo the same work on every turn.** The body-location
  registry rebuilds an immutable 48-node subtree on every expansion (E13 — 12
  call sites, one on the per-turn wardrobe-visibility path), and two registries
  answer "what belongs to this body location / category?" by scanning all 144
  attribute definitions each time (E14) — worst case ~1,400 comparisons per
  attribute resolution, per prompt build. Both fixes are small, local, already
  test-covered; E13 is the audit's best value-for-effort item in contracts.
- **A validation idiom repeated ~60 times has a helper nobody can reach.** The
  lenient-parsing pattern contracts uses to satisfy
  [resilience.md](../resilience.md) already has a tidy helper — it is just
  private to one file (E10). Promoting it gives new code an obvious landing spot
  instead of another copy.

No player-visible behavior changes. The payoff: the extension promise stays true,
the per-turn path gets cheaper, and contracts stops describing deleted systems.

## Scope

Grouped by kind; ids are §E findings in the audit.

- **Delete what R6 orphaned** — E1 (the puppet judge), E2 (authored cast edges,
  including the dead type import in the database schema), E6 (a dead barrel), and
  E4 (the bond classifier and the stage-behavior half of the relationship profile
  — session-lane concepts with only their own tests; the escalation tiers in that
  same file are **live** and stay).
- **Rule on the mood sub-module** — E7: the atmosphere module and the
  condition/atmosphere baseline-shift half of the mood events module have no
  consumers. This interacts with prior-art **E-K1** (fold the condition
  vocabulary into the catalog — [finished/codebase-review.md](finished/codebase-review.md)):
  deleting may make E-K1 moot, so it gets a decision slice, not a quiet
  deletion. **E-K2** (concept sets copied outside the concept registry) sits in
  the same folder — decide in passing whether it rides along.
- **Unify duplicated vocabulary and one duplicated loop** — E11 (the
  left/right/center side list declared three times → one owner in the body
  location package) and E12 (the multimap index-building loop copy-pasted
  between the attribute and trait registries → one helper in the registry spine).
- **Index the hot lookups** — E13 and E14. Prior-art **E-K5** flagged the same
  registries for structural tidying — read together, don't rediscover.
- **Promote the lenient-parsing helpers** — E10: a small public module, migrated
  incrementally starting with the three densest files.
- **One mechanical de-export pass** — E5's 51 unreferenced exports.
- **Coordinated with the active affordance build** (separate, gated slice) — E8
  (about 850 lines of test fixtures shipping through the public contracts barrel
  into 73 client files) and E9 (four byte-identical helper bodies duplicated
  across the two affordance domains, whose own comments admit the copy).

Docs updated in the same change: [../contracts/relationships.md](../contracts/relationships.md),
which today documents the bond classifier, authored edges, and puppet guardrail
as live; plus a note into [npc-puppeting.deferred.md](npc-puppeting.deferred.md)
recording that the v1 judge is gone and what a future version would rebuild.

## Non-goals

- **The garment-blueprint validation gap (E3) is not in this batch.** It is the
  one §E finding with a real correctness dimension — part-graph invariants never
  enforced at the trust boundary — and belongs to the resilience closures plan.
  Wiring it in and deleting it are opposite decisions; that argument needs a home
  of its own.
- **The one-element body-plan registry stays as-is** — documented
  forward-compat, not accidental generality.
- **The proposal-trace unification in `turns/` stays deferred** until its stated
  trigger (the surface trace being persisted) fires.
- **No new vocabulary, no behavior change, no migrations.** Every fix here is a
  deletion, a move, an alias, or a cache.

## Review rulings and scope adjustments — 2026-07-30

- Pull **E13/E14** forward into the approved cheap hot-path tranche. They are small,
  behavior-preserving index/memo changes on live per-turn paths.
- Keep condition-driven mood shifts and fold their vocabulary into the condition
  catalog. Do not wire new behavior in this cleanup; activation waits for a feature
  with an authoritative consumer.
- Build the lenient-zod module and migrate the densest files incrementally. A
  repo-wide 60-site rewrite is not a success criterion.
- E8 waits until the active affordance file set is quiet. E9 stays before a third
  affordance domain, but must preserve the domain-neutrality tests.
- Move the mechanical E5 export census into the later dead-export pass so one
  review owns removal guardrails.

## Delivery slices

Each is independently shippable, on its own pull request with its own green
`pnpm verify` run.

1. **Orphan deletion** — E1, E2, E4, E6 plus the relationships doc. Smallest
   slice, biggest legibility gain. Two things survive and must not be caught in
   it: the live stage→band healing helper (a different file) and the escalation
   tiers (read by the contact law).
2. **The mood ruling** — decide fold-vs-delete for E7/E-K1 **once**, act, then
   record the ruling in the contracts doc that owns the vocabulary so no future
   sweep re-derives it. Not a code-first slice.
3. **The hot lookups** — E13, E14, E12 together (E12's helper is what E14's
   indexes are built with). Existing registry-invariant tests are the
   correctness check; add one assertion per fix that repeated calls agree.
4. **One owner for the side vocabulary** — E11, respecting the **frozen seam**
   in the appearance-features locus module: re-alias to the body-location owner,
   never rename or reshape the frozen exports.
5. **The lenient-zod module** — E10: create it, migrate the three densest files,
   leave the rest to opportunistic migration.
6. **Affordance coordination (gated)** — E8, E9, gated on the active
   [narrator-physical-guidance.plan.md](narrator-physical-guidance.plan.md)
   build reaching a quiet point, since it is churning these exact files. E9
   should land **before a third affordance domain arrives**; the existing
   domain-neutrality test keeps the hoisted helpers honest.
7. **The de-export pass** — E5, last, so a noisy mechanical diff does not bury
   the slices above.

## Success criteria

- Nothing in contracts describes machinery R6 deleted; the removed names appear
  only in historical plan docs.
- The extension promise holds: registry-invariant tests green, adding a
  vocabulary item still a single-file data edit, and the side vocabulary has
  exactly one declaration — with the frozen appearance-features exports still
  present under their original names.
- Repeated subtree expansions and registry lookups return identical data to
  today (the existing tests are the oracle) without re-deriving per call.
- The lenient helpers have one public home; the three densest files use it; the
  degradation tests still assert both the fallback and the diagnostic code.
- The public contracts surface no longer exports test fixtures, and the shared
  affordance helpers exist once, in the domain-neutral core.
- **A green `pnpm verify` run on each slice**, duplication no worse than before.
  Validation is the local gate (root `CLAUDE.md`) — `.husky/pre-push` runs it
  before the branch reaches GitHub.

## Risks & coordination

- **Two live builds own the affordance files** —
  [narrator-physical-guidance.plan.md](narrator-physical-guidance.plan.md)
  (slices 4–6 open) and
  [romantic-contact-affordances.plan.md](romantic-contact-affordances.plan.md)
  (item 4 built but dark, item 5 open) — so slice 6 coordinates with both rather
  than racing them: last-in-line and skippable.
- **"Only its own test uses it" is not always dead.** The audit's §C caveat
  applies: some helpers are built a slice ahead of their consumer. Check the git
  history and any queued plan first, and delete the test with the code rather
  than leaving an orphan test asserting nothing.
- **A cache is the one place a silent bug can hide here.** The memoized expansion
  is safe only because the tree is immutable, frozen registry data — key it to
  the registry itself, and never hand out a structure a caller can mutate.
- **The mood decision must not be taken twice.** Half-deleting E7 while E-K1
  stays open is the worst outcome: the condition vocabulary stays split *and*
  the thing that justified folding it is gone.
- **Every slice that removes a documented concept updates its contracts doc in
  the same change.** The batch is already carried on `roadmap.md`, in the
  correctness-and-measured-response tranche for E13/E14 and in the later
  consolidation sequence for the rest.
- **Do not absorb the simulation contracts.** The
  [modularity audit](codebase-modularity.audit.md) proposes a large
  `src/contracts/simulation` scaffolding pass (one command factory, one event
  envelope, one projection-schema factory). Its projection-schema item is the same
  branded-vs-plain drift the efficiency audit filed as **A9**, which
  [sim-command-shell.plan.md](sim-command-shell.plan.md) owns — this plan's §E
  scope stops at the non-simulation contracts, and that boundary is deliberate.

## Open questions

1. Does the E5 sweep adopt a standing rule for unused `z.infer` aliases, or
   continue to remove only aliases that obscure the public surface?
2. Does E8 remain a contracts-hygiene slice once the affordance work is quiet, or
   close out with that plan's fixture ownership?
3. Which dense files prove the lenient helper before the migration becomes a
   standing convention rather than a finite sweep?
