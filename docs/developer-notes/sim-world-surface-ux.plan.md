# World surface UX — degraded reads, unavailable actions, partial-op progress, mobile

Status: shipped — 2026-07-28 (promoted the same day from successor-engine
backlog item F22; all four slices complete)

## What

Four defects on the player-facing world surface (`ChatWorldCard` + its mounts):

**1. World-read failure makes the world disappear.** The world endpoint
deliberately 503s when the projection can't be read
(`world/route.ts:28`) — but the chat UI passes only `world.data` to the card
(`chat-conversation.tsx:1126, 1378`), the card returns `null` on absence
(`chat-world-card.tsx:66`), and `readSimChatWorld` itself collapses
lane-mismatch and engine failure to the same `null`
(`sim-surfaces.ts:156-166` vs `:266-271`). An engine failure is
pixel-identical to a legacy chat with no world — no panel, no retry, no
diagnostic. (MED · S)

**2. Unavailable actions vanish; alternatives are raw command ids.** The
envelope carries authored `unavailableReason` strings
(`lib/simulation/world-read.ts:213-225`), but the card filters unavailable
actions out entirely (`chat-world-card.tsx:85`). Refusal alternatives render
as `legalAlternatives.join(", ")` (`:294-298`) — and those are raw command
*type* identifiers (`sim-command/route.ts:88`), so players see "You could
instead: move_actor, end_engagement". Cast rows have no `actorId`
(`world-read.ts:34-41`) and are React-keyed by name (`chat-world-card.tsx:197`)
— duplicate names collide. (MED · S/M)

**3. Partial operations render as completed.** Travel returns
`arrived: false` + `drainShort` (`sim-command/route.ts:352`), activities
always return `"performed"` (`:445`) — but the client schemas drop
`drainShort` entirely (`lib/client/api.ts:992-999, 1037-1043`) and `arrived`
is parsed then never read (`chat-world-card.tsx:93-104`). The transcript beat
says "You walk to the town square." while the projection still has the player
`in_transit` (`world-beat.ts:78-80`; beat written unconditionally,
`sim-command/route.ts:344-351`). Server-side honesty shipped with
drain-hardening (durable jobs, `settleStrandedInTransit`, fallback codes on
beat meta) — the UI just never consumes it. Beat *wording* is the F23 half of
this item. (MED · M)

**4. Mobile has no world surface.** The card mounts twice: a desktop aside
hidden below `lg` 1024px (`chat-conversation.tsx:1361, 1376-1382`) — so
tablets lose it too — and a bottom sheet titled **"Roster"** reachable only
via the header overflow menu (`:1844`, `:1120-1131`). Location, travel,
inventory, activities, and catch-up state all live behind a people-labeled
menu item. (MED · M)

## Why it matters

This surface *is* the successor product for players. Engine failures reading
as "no world", disabled actions with authored reasons never shown, completed
prose over an in-transit world, and phones without a world surface all make
the sim feel less trustworthy than the legacy lane it's meant to replace.

## Sketch

- Persistent compact status panel distinguishing `not_applicable / loading /
  available / catching_up / degraded` — pass `world.error` through, render
  "World temporarily unavailable — your transcript is safe" + retry +
  diagnostic id.
- Render unavailable actions disabled with their authored reason; map refusal
  alternatives through the action-label table to real buttons; add `actorId`
  to cast rows and key on it; let another present character be the
  handoff/activity target instead of hardcoding the primary.
- Consume `arrived`/`drainShort`: show "Walking to …" / "Resting …" progress
  states driven by the catch-up poll instead of an unconditional completed
  look.
- Mobile: a sticky world strip under the chat header (location · clock ·
  catch-up state) opening a dedicated World sheet; Roster goes back to
  people.

## Open questions

- **Ruled for v1:** the compact world entry point absorbs location, clock, and
  catch-up state instead of adding another adjacent status chip.
- **Ruled for v1:** phone and tablet widths below `lg` use the same compact
  strip and dedicated World sheet. Desktop retains the persistent aside.

## Slices

1. **Truthful action surface.** Keep authored unavailable actions visible,
   explain their reason, humanize command alternatives, and consume
   partial-operation signals.
2. **Read-state honesty.** Distinguish not-applicable, loading, available,
   catching-up, and degraded world states; degraded copy guarantees transcript
   safety and offers retry.
3. **First-class responsive access.** Add a compact world strip below the chat
   header for widths below `lg`, opening a dedicated World sheet; keep Roster
   scoped to people.
4. **Projection identity follow-up.** Add stable actor identifiers to cast
   rows at the world-read boundary and use them for keys and command targets.

## Acceptance

- World projection failure is visibly different from a chat with no world.
- Unavailable actions remain discoverable and show their authored reason.
- Partial travel/activity does not appear completed while catch-up is pending.
- Location, time, inventory, activities, and world actions are reachable on
  a 390×844 viewport without going through a Roster-labelled control.

## Shipped

The world surface now retains unavailable actions with their authored reasons,
humanizes command alternatives, keys cast rows by stable actor identity, and
consumes `arrived`/`drainShort` so partial travel and activities read as work in
progress. Loading, catch-up, and degraded projection states remain visible with
safe-copy and retry. Below `lg`, a compact location/time/status strip opens a
dedicated World sheet containing the world clock and full controls; Roster is
people-only again. Completion-beat wording remains correctly owned by F23.
