# Library-kind registry + route factories — adding a kind should be a data edit

Status: draft (sequenced after the measured client tranche; sequential suggestion
writes are a settled invariant. Re-verified 2026-08-07: the kind→table map is
still written three times, the four clone routes are still four files, and
`withOwnedEntity` is still adopted by one detail route of five)

Outcome: A developer can teach the library about a sixth kind of authored thing
by adding one registry entry and re-exporting its routes, so that a fix to
cloning, publishing or image generation stops having to be typed out five times
and applied to only three.

## Why

The library holds five kinds of authored thing — characters, locations, items,
social cards and personas — and the app treats each as a separate hand-built copy
of the same feature. Browsing, publishing, cloning, list search, image generation
and the owner-only detail routes behave identically from a player's point of
view, but under the hood every kind has its own transcription of that behavior.
Two costs a product reader can feel:

- **Adding a sixth kind is a scavenger hunt, not a data edit.** The house rule
  (`CLAUDE.md`) is that registries are the extension point — vocabulary changes
  live in one file. The library is the clearest place that rule is not honored:
  per-kind branches run ~185 lines across three modules (**C6**), and the
  kind→table map is written out three times, two of them byte-identical (**C7**).
- **A fix applied to one kind silently misses the others.** The audit found four
  byte-identical clone routes, two identical batch-image routes and two
  single-image routes differing only in the words "item" and "location"
  (**D2**) — the last pair a real drift trap, since each carries its own
  privately-written ownership check. That shape has already cost us once: both
  batch routes carry a comment about an earlier fix where a malformed request
  widened the scope to "generate everything", and it had to be applied twice by
  hand.

Nothing here changes what the app does. This is a maintainability and
correctness-surface batch: fewer places for the same behavior to disagree, and a
library where "support a new kind of authored thing" is one registry row plus a
route re-export. It also closes two prior-art items re-verified as still open
across two review cycles — **E-S1** (a shared owned-entity lookup was built but
only one of five detail routes adopted it) and **E-S3** (the image route twins),
both from [finished/codebase-review.md](finished/codebase-review.md).

## Scope

Audit batch 5. Primary: **C6**, **C7**, **D2**, **D3**, **D4**. Three cheap
efficiency fixes ride along because they sit in the same files: **C13**, **C17**,
**C18**.

- **One library-kind registry** that the visibility gate, the clone path and
  library search all read, replacing the hand-written branch sets and the three
  copies of the kind→table map.
- **One owner-strict lookup** — "find this row if this account owns it" — adopted
  by all five detail routes instead of six hand-written copies of the same query.
  This is the half-finished work E-S1 named.
- **Three route factories** for clone, batch-image and single-image behavior; the
  eight route files become the two-line re-export idiom already used throughout
  `/api/admin/self`. Roughly 180 lines and eight hand-patch sites collapse to one
  each.
- **Shared list plumbing** for the boilerplate repeated across the five list
  endpoints: parameter parsing, order-preserving id reordering, create-and-index.
- **Batching while in there.** Alias lookup stops loading the whole character
  library into memory to compare names (**C13**); forge-suggested items and
  location-link reconciliation stop issuing one statement per row (**C17**,
  **C18**).

The five kinds are **not** uniform and the registry must say so rather than
flatten it: social cards carry no images, and personas are deliberately neither
shareable nor cloneable today. Modelling those as declared per-kind capabilities,
with headroom for a kind that gains them later, is part of the work.

## Non-goals

- **The library editor pages** — the five editor screens share ~140 lines of
  scaffolding each (**D1**, closing E-U1); a larger batch with its own UI risk.
- **Image pipeline internals** (**C1**–**C5**) — a different batch; this one only
  touches the route layer above it.
- **Row-level security** — still the security plan's open question; this batch
  works within the application-query ownership model as built.
- **Adding a new library kind.** The point is to make it cheap, not to do it.
- **Any change to request/response shapes or the 404-never-403 non-disclosure
  behavior.** No database migration is expected.

## Review rulings and scope adjustments — 2026-07-30

- **Preserve `materializeSuggestedItems` write order.** A later suggestion may
  reuse a row inserted for an earlier one. Parallelize or batch the independent
  lookup phase only; do not turn `include batching` into changed save semantics.
- Split the registry in two: contract-owned kind/capability vocabulary, and
  server-owned table bindings and handlers. Contracts remain free of database
  imports.
- A registry makes server dispatch and route coverage easier; it does **not** make
  a complete new library kind a one-file feature. Forms, schemas, persistence,
  authorization, and product behavior still need deliberate implementation.
- Keep the owner-lookup tripwire and exact-key route tests as the acceptance spine,
  not just line-count reduction.

## Delivery slices

Ordered so the security-sensitive slice lands with the ownership census fresh in
view, and so each slice is independently verifiable.

1. **The registry (C6, C7).** Introduce the one per-kind table; repoint the
   visibility, clone and search modules at it; delete the duplicate maps.
   Behavior-neutral by construction — branch bodies become registry rows.
2. **Owner-strict lookup + detail-route adoption (D4, closes E-S1).** Add the
   generic lookup, register it with the ownership tripwire's sanctioned-helper
   list **before** migrating anything, then move all five detail routes onto the
   existing owned-entity wrapper. The two-user authorization matrix is this
   slice's acceptance signal.
3. **Route factories (D2, closes E-S3).** Clone ×4 first (byte-identical, lowest
   risk), then batch-image ×2, then single-image ×2 — the pair whose per-kind
   ownership checks must be reconciled deliberately, not diffed away.
4. **List/create helpers (D3).** Fold the five list endpoints onto the shared
   helpers while preserving each kind's distinct facet filters.
5. **Batching (C13, C17, C18).** Alias matching becomes a database-side existence
   query; link reconciliation and suggested-item materialization batch their
   writes, subject to OQ4.

## Success criteria

- **The registry test:** a hypothetical sixth kind can be added by editing the
  registry plus route re-exports — demonstrated, not asserted.
- **The security gates stay green with no scanner changes beyond sanctioned-helper
  registration:** the ownership tripwire and the two-user authorization matrix
  both pass, and the tripwire's census buckets stay populated (no mutation site
  silently leaves the scan).
- **Behavior-neutral at the boundary:** no change to request or response shapes,
  status codes, rate-limit classes or quota checks; a non-owner still gets 404,
  never 403 and never a confirmation the row exists.
- **Measured reduction** roughly matching the audit — ~185 lines of branch
  dispatch, ~180 of route duplication, three duplicate maps gone.
- **Bounded queries:** alias resolution no longer scales with library size; a
  character save with many forge suggestions issues a bounded statement count.
- **The ready PR's applicable CodeBuild jobs and aggregate `verify` check are green,**
  including the route-authorization check inside the CI `static checks` job.
  `.github/workflows/ci.yml` is the repository gate; there is no local pre-push
  gate or `pnpm verify` alias.

## Risks & coordination

**Hard constraint — the 2026-07-26 security hardening is a permanent gate, and
this batch is directly in tension with it.** That work installed a
**route-mutation ownership tripwire** (`src/server/api/ownership-guardrail.test.ts`)
that statically scans every API route for writes and requires each to carry
ownership evidence in the right position — a census of **31 mutation sites**
across 18 route files at baseline, every unscoped one explicitly allow-listed with
a written reason — plus a **two-user authorization matrix**
(`src/server/api/authz-matrix.int.test.ts`) that answers the semantic question the
scanner cannot: whether the predicate is actually *correct*.

The tripwire is also where the **sanctioned helper models are named** — the list
of owner-asserting lookups and the list of approved route wrappers (the latter
shared with `pnpm lint:authz`). A new shared helper is invisible to the scanner
until registered there, and only counts once it genuinely re-reads its row with
an owner predicate and the route branches on the result before writing. So:

- **Every helper this batch introduces gets registered and re-verified**, with a
  comment recording what was read. Registration is part of the slice.
- **Do not trade 31 legible per-route predicates for one invisible one.** If a
  factory would move a write out of the scanner's reach, the factory is wrong.
- Census assertions are shape-based, so properly-scoped consolidation passes
  without editing numbers. **Needing to loosen the scanner is a signal to stop and
  re-think the slice**, not a step in it.

Also: **non-disclosure is behavioral** — a factory returning a generic error, or
leaking which kind was requested, regresses a product decision. **Per-kind
asymmetry is real** (images, shareability); forcing uniformity would either grant
personas a clone path nobody asked for or bake today's gaps in as permanent. And
**the duplication gate will not confirm this work** — these clones already pass
under its global budget (**F1**), so the evidence is hand-counted lines and the
registry test, not a tool reading.

## Open questions

- **OQ1 — do personas join the shareable/cloneable set?** If not, the capability
  registry must state that exclusion explicitly.
- **OQ2 — exact registry boundary.** Settle the contract capability shape and the
  server binding shape before slice 1.
- **OQ3 — per-kind prose.** Decide where route-specific behavior/history remains
  documented when the route files become thin re-exports.
