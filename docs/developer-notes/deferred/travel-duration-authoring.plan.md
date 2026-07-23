# Travel distances & durations as authored world configuration

Status: draft (stub — parked 2026-07-23 from an owner ruling recorded during
[../drain-hardening.arrival.md](../drain-hardening.arrival.md)'s
flesh-out (then backlog item A7); promote per [CLAUDE.md](CLAUDE.md) before
building)

## What

Owner direction (2026-07-23): world setup needs a system to **define distances
and travel time lengths between locations** as part of configuring a world.
Worlds come from two sources — bespoke worlds we develop for players to use,
and worlds players build themselves (considerable effort on their part) — and
both author route durations through this system. Today durations are engine
seed data only: links carry `minimumDurationSeconds`, and `planRoute` hardcodes
`uncertaintySeconds: 0` at plan time (`space.ts:204-211`), so no world can yet
declare a duration range.

## Why it matters

Travel realism — and the uncertainty/delay features the engine reserved
headroom for (`expected`/`minimum`/`uncertainty`, `journey_delayed`) — is an
authoring problem before it is an engine problem: nothing can have a duration
range until a world can declare one. This is one facet of the larger
world-building surface (bespoke + player-built worlds), whose backbone is now
parked as [location-authoring.plan.md](location-authoring.plan.md) — travel
time to connected locations is one of that builder's authored fields, so the
two stubs may fold into one world-authoring plan at promotion.

## Sketch

Part of the world-configuration surface: per-link (or per-zone-pair)
distance/duration authoring feeding `minimumDurationSeconds` /
`expectedDurationSeconds` / `uncertaintySeconds`; bespoke worlds author these
in seed/config data now, a player world-builder edits them through whatever
authoring UI that lane grows later. **Tripwire:** this (or any
nonzero-uncertainty travel) MUST NOT ship before the drain-hardening plan has
— promoted 2026-07-23, see
[../drain-hardening.plan.md](../drain-hardening.plan.md) (§Tripwire) and
[../drain-hardening.arrival.md](../drain-hardening.arrival.md) ruling 4.

## Open questions

- Granularity: durations authored per link, or derived from authored distances
  plus travel-mode speeds?
- Where authoring lives first: seed/config data for bespoke worlds now, a
  world-builder UI later?

## Slices

_(Defined at promotion.)_
