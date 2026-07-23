# Turn vs clock-advance race — "story time cannot move backwards"

Status: draft (stub — successor-engine backlog item A2, parked 2026-07-23;
promote per [CLAUDE.md](CLAUDE.md) before building)

## What

`prepareEngagementTurn` targets `staleClock + 60s` from a pre-read
(`arbiter-store.ts:181-188`); if a concurrent travel/skip drain advanced the
branch clock past that, the backwards-time guard (`scheduler-store.ts:703`)
throws, and the co-present turn path doesn't catch it (`sim-exchange.ts:940`
— the solo path does). The player gets a dead turn recorded as
`lastReplyFailure: "successor turn crashed: Story time cannot move
backwards"`. Reachable by typing a message while a skip/travel drain is still
running. (HIGH · S)

## Why it matters

A failed turn with no reply is the worst successor-lane failure mode, and this
one needs only ordinary impatience to trigger.

## Sketch

Target `max(fromStorySecond + span, live clock)` inside
`prepareEngagementTurn`, or catch the backwards-guard in `runCoPresentTurn`
and re-read. A per-chat lock (item A1) also narrows the window.

## Open questions

_(To be fleshed out in discussion at promotion.)_

## Slices

_(Defined at promotion.)_
