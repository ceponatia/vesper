# Worlds page → operational dashboard

Status: **draft** — parked in [deferred.plan.md](../deferred.plan.md); not
committed work. Successor-engine backlog item G24, parked 2026-07-24 from the
successor engine & chat-UI product review; promote per [CLAUDE.md](CLAUDE.md)
before building.

Outcome (provisional): A player can open the Worlds page and tell at a glance
which worlds are playable, where each one left off, and which are broken, so
that the front door stops mixing dead links in with live stories.

## What

The `/worlds` page (`components/worlds/successor-worlds-page.tsx`) is a create
form + plain link cards showing only title, primary character, clock tag, and
authority tag. The listing API still selects every non-legacy authority, so its
raw response includes `successor_shadow` Engine Comparison chats. **As of
2026-08-22 the Worlds UI filters those rows out**: comparison sessions now have
their own admin-only [Engine Comparison](../../engine-comparison/README.md)
launcher/review surface and must not appear as playable successor worlds. The
API query itself remains broader than the product surface and can be narrowed
when this dashboard work is promoted. A chat with `simBranchId: null`
(orphan/unlinked) can still reach that raw listing with no readiness / degraded /
catching-up / orphaned signal; there is still no search (API hard-limits 100,
no `q`). (LOW-MED · M)

*(Partial overlap history: E20, 2026-07-27, shipped the delete control + confirm
dialog and changed the quota to count only playable worlds. Engine Comparison
session provisioning, 2026-08-22, gave shadow experiments their own lifecycle
and removed them from the Worlds UI. Still open: narrow the listing API itself,
search, orphan/readiness warnings, and per-row location / cast / last-activity /
catch-up-health.)*

## Why it matters

The Worlds page is the successor lane's front door and its only fleet view.
As worlds accumulate — including E20's orphans — the page needs to show what's
actually playable and healthy, or it reads as a broken list of dead links.
Engine Comparison is no longer part of that fleet view; it is an admin testing
surface with its own mirror-world lifecycle.

## Sketch

- Narrow the API list to playable `successor_narrative_view` /
  `successor_authoritative` worlds. The client already applies that filter as a
  safety/product-boundary check; the server should eventually make its response
  match.
- Add per-row: location, present cast, last activity, catch-up health (the
  time-job state already exists server-side — drain-hardening A5), and
  provisioning status once E20's record exists; flag unlinked/orphaned rows.
- Archive/delete controls (semantics from E20's ruling), search, and "clone
  as a new world" (a D19 fork wearing a product face). The faceted-browse
  pattern from finished/library-ux.plan.md is the reuse target.

## Open questions

- Is "clone as a new world" a fork (shares history) or a re-provision from
  the same character (fresh seed)? Both are defensible products.
- Does catch-up health poll per row or ride one batched read?

## Slices

_(Defined at promotion.)_
