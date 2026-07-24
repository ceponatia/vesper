# Worlds page → operational dashboard

Status: draft (stub — successor-engine backlog item G24, parked 2026-07-24 from
the successor engine & chat-UI product review; promote per [CLAUDE.md](CLAUDE.md)
before building)

## What

The `/worlds` page (`components/worlds/successor-worlds-page.tsx`) is a create
form + plain link cards showing only title, primary character, clock tag, and
authority tag (`:129-136`). The listing API selects
`ne(engineAuthority, "legacy_chat")` (`app/api/successor-chats/route.ts:146`),
so `successor_shadow` chats are listed — and they link to `/chat/{id}`
(`successor-worlds-page.tsx:125`) even though `requireSimChat` rejects shadow
chats as unplayable (`sim-shared.ts:28-30`). A chat with `simBranchId: null`
(orphan/unlinked) renders with no clock and **no warning**
(`route.ts:173`). No readiness / degraded / catching-up / orphaned signal, no
archive/delete (despite the cap error telling users to "delete one first"),
no search (API hard-limits 100, no `q`). (LOW-MED · M)

## Why it matters

The Worlds page is the successor lane's front door and its only fleet view.
As worlds accumulate — including E20's orphans and shadow experiments — the
page needs to show what's actually playable and healthy, or it reads as a
broken list of dead links.

## Sketch

- Default the list to playable `successor_narrative_view` /
  `successor_authoritative` worlds; shadow chats move to an "experimental"
  section (or admin-only).
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
