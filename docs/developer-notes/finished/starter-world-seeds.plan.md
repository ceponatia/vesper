# Seed the life the engine already supports

Status: **shipped — 2026-08-02** — promoted the same day from the deferred
backlog (B8, parked 2026-07-23) on the owner's build request during the docs
sweep, and built as the single slice below. The stub's sketch was already
discussion-complete.

Completion note. All four seed groups landed in
`src/server/engine/simulation/starter-world.ts`, whose authored content now
lives in a pure `starterWorldSeedPlan(input)` builder so the seed is
reviewable and testable without a database (`starter-world.test.ts`, pure
suite). Two deviations worth naming, both recorded in the code:

- **The meal item is seeded HELD by the primary, not resting in the home
  zone.** `seedDurableMaterialBranch` writes items before
  `seedDurableSpaceTopology` creates the zones, so a `zone` locus has no FK
  target at seed time (that seeder's own doc spells out the three-step order a
  zone-resting seed item would need). Actor-rooted is also the more robust
  choice: §26.5 selection prefers it, and it stays eligible if the noon window
  ever catches her out on an errand or mid-journey.
- **Two vocabulary rows outside `starter-world.ts`** were required for the new
  third zone to be addressable and nameable, both one-line data edits to
  existing registries: `market` in `ZONE_KIND_LABELS` (`sim-surfaces.ts` —
  otherwise the market renders as a humanized raw id) and a `market` entry in
  `ZONE_KIND_WORDS` (`input-admission.ts`), taking the word "market" back off
  `plaza` so "I walk to the market" stops admitting a move to the square.

Leftovers: none of this changes the primary's LOD, so the seeded routine still
only runs for `event`-LOD actors — that ruling stays parked in B9
(`deferred/primary-lod-ruling.plan.md`), exactly as the cross-link below says.

## What

The engine machinery is built but `starter-world.ts` seeds none of the data
that would exercise it: no commitments, no meal items, no extra zones/actions,
no lore memories. The ruling-21 vignette collapses to "she is at home and stays
there," `eat_meal` is always illegal (the routine's candidate set includes it,
but the world contains nothing edible), and RAG recalls nothing on turn 1. The
standout cheap win — pure data, zero engine code. (S)

## Why it matters

Most of the living-world machinery already exists and is simply unseeded;
seeding it instantly gives the vignette real MUSTs and `decideDepartures`
something to act on. A new world should demonstrate the living world on its
first day, not after the player authors one.

## Boundaries

- Successor lane only; pure seed data in `starter-world.ts` (and fixtures) —
  **no engine code, no schema changes, no migrations**.
- Applies to newly provisioned worlds; existing worlds keep their old seed
  (no backfill — they are experimental).
- The legacy chat lane is untouched.

## Slice 1 (the whole plan)

- A **consumable food item** in the home zone — un-breaks `eat_meal` at any
  LOD.
- **2–3 `create_commitment`s** on the primary: a midday obligation away from
  home (e.g. at the square), a soft evening plan — so the vignette has MUSTs
  and `decideDepartures` has real departures to decide.
- **A third zone + second link + a second action definition**, so movement
  and activity choice are non-degenerate.
- **A handful of authored-lore memory documents** via the existing
  `authored_lore` projector (the keepsake's meaning, backstory beats) — so
  recall has something to return on turn 1.

## Success criteria

- On a fresh starter world, `eat_meal` is legal during the meal window.
- The primary leaves home at least once on the seeded commitments without any
  player authoring.
- A turn-1 memory recall returns authored lore instead of nothing.
- No engine/contract code changed — the diff is seed data plus tests.

## Open questions

_None — the seed contents above were ruled by the owner's build request;
tuning specific items/zones is implementer's choice within the boundaries._

## Cross-links

- [deferred/primary-lod-ruling.plan.md](../deferred/primary-lod-ruling.plan.md)
  (B9) — seeds give the vignette MUSTs regardless of how the LOD ruling
  lands; still parked.
- [deferred/autonomous-npc-travel.plan.md](../deferred/autonomous-npc-travel.plan.md)
  (B13) — travel toward seeded commitments is that stub's scope, not this
  one's.
