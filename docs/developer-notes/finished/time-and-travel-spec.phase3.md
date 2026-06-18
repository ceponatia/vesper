# Time & travel — spec

Status: **draft for discussion**. Part of the multi-character split — see
[multi-character-overview.phase3.md](multi-character-overview.phase3.md); rationale in
the brainstorm §Time. Decisions 9–12 apply.

> **Implementation status (2026-06-12).** The core of this spec shipped
> with [multi-character-phase-1-plan.md](multi-character-phase-1-plan.md):
> `travelMinutes` on both link tables, `area` + `scale` on locations,
> the action-duration registry (`matchActions`, `meterEffects`),
> turn-time resolution as max(travel, registered action, clamped
> estimate) with a persisted cause, the chain-cap narrator directive,
> forge suggestions for the map fields, the clock-delta UI, the
> time-context helper (`weekdayIndex`, `dayIndex`, `daylightBand`), and
> the schedule day-mask + seeded jitter. Scheduled in
> [phase-2-plan.md](phase-2-plan.md) — treat as done when implementing
> here: the declared-rest mechanic (T7, `REST_CLAMP_MINUTES`,
> schedule-aware wake). Still later: mid-action interruptions,
> travel-speed modifiers, and the partial-traversal brief note (waits
> for multi-hop traversal, which arrives with the movement phase).

## Problem

A turn is one narrative beat, but the clock advances by an LLM estimate
(simulant `minutesAdvanced`, clamped 1–480). Crossing town and crossing a
kitchen cost the same; a 20-minute shower either gets narrated in tedium
or guessed at. Time should be **deterministic and authored for the
dominant cases**, with the estimate as fallback.

## Design

### Link travel minutes

`world_links` / `session_links` gain `travelMinutes` (int, default 1).
Same-area room transitions stay at 1; cross-town links carry real cost.
Travel is **one turn regardless** — the clock jumps, the narration covers
the transition.

### Areas

Locations gain an optional `area` tag (string, e.g. `"apartment-102"`,
`"downtown"`). Not a container — a label. Uses: default travel minutes
(intra-area 1, inter-area higher unless authored), prompt grouping,
future map UI, future sound-channel scope. Location `scale` (specced in
[proximity-spec.phase3.md](proximity-spec.phase3.md)) supplies a default *crossing* cost
for big single locations.

### Action-duration registry

New registry (`contracts/actions/` — vocabulary as data, no migrations):

```ts
{ id: "shower", minutes: 20, aliases: ["bathe", "wash up"],
  meterEffects?: [{ meterId: "hygiene", set: 0.9 }] }
{ id: "nap",  minutes: 90, meterEffects: [{ meterId: "energy", delta: +0.4 }] }
{ id: "meal", minutes: 30 }
```

`meterEffects` makes restoration deterministic instead of hoping the
simulant remembers. The world-tick and affordance system reuse the same
durations so off-screen time spends at the on-screen rate.

### Turn-time resolution (merge step 4 changes)

1. **Travel**: player moved ⇒ path cost from `travelMinutes`.
2. **Registered action**: intent detection or simulant `activityUpdates`
   matches a registry entry ⇒ its duration.
3. **Estimate**: otherwise, today's `minutesAdvanced` (clamped).
4. Multiple components ⇒ **max, not sum** (decision 9).

### Chain cap

Soft cap of ~2 registered-duration actions per player turn ("go home and
shower" is a beat; "…then cook dinner" stops after the shower). Only
registry-matched events count — ordinary verbs never trip it. Surfaced as
a narrator directive ("end the scene after the shower"), not an input
rejection. Explicitly flagged tune-in-play; may be dropped if it never
matters.

### Constants

`DEFAULT_LINK_TRAVEL_MINUTES = 1`, `MAX_CHAINED_ACTIONS = 2`, scale
crossing defaults — all in `engine/constants.ts`.

## Forge & editor

The world forge suggests `travelMinutes`, `area`, and `scale` from
descriptions (decision 10); everything editable in the map editor; safe
defaults where unset. Degraded default: a link without `travelMinutes`
behaves exactly like today.

## Gaps & opportunities

> **Rulings 2026-06-11** (decisions 33, 38–40 in the
> [decisions doc](multi-character-presence-and-movement-decisions.phase3.md)):
> full declared-rest mechanic in v1 (schedule-aware endpoints, its own
> clamp, drift across the span — world-tick batching specced in
> offscreen-simulation); mid-action events resolve at turn end in v1;
> schedule entries gain a day-of-week mask (+ seeded jitter, specced in
> npc-movement); estimate-vs-registered resolves as **max(registered,
> clamped estimate)**; clock-delta UI ships with the system (decision
> 48). Still open below: travel-speed modifiers (deferred hook),
> partial-traversal brief note, the exposed time-context shape.

- **Waiting and sleeping are unmodeled.** "I wait until evening" / "I
  sleep" are the biggest time jumps in play and nothing defines them: the
  480-minute clamp blocks a night's sleep, and no rule says what the
  world does across an 8-hour span (one big world-tick? several?). Needs
  a declared-rest mechanic: an explicit fast-forward action type with its
  own clamp, schedule-aware wake time ("until morning"), and a batching
  rule for off-screen simulation across the span.
- **Mid-action interruptions.** If a scheduled event (Mara's 18:00
  arrival) lands inside a 20-minute shower turn, v1 silently resolves it
  at turn end — she's just *there* afterwards. Acceptable, but the
  interesting version is an interruption rule: urgent events can split a
  long action ("you're mid-shower when the doorbell rings"). Pairs with
  the director-only urgency decision.
- **Schedules have no calendar.** Entries are minute-of-day only — no
  weekday/weekend, no days off, no dates. `style.calendarStart` exists,
  so a day-of-week mask on schedule entries is cheap and stops the
  shopkeep working seven identical days forever.
- **Estimate vs registered-action conflict.** Resolution order *replaces*
  the estimate when an action matches — but if the narration clearly
  spans more (an hour-long heart-to-heart *during* the meal), the
  registered 30 undercounts. Likely fix: take max(registered, clamped
  estimate) rather than short-circuiting. Decide before implementation.
- **No travel-speed modifiers.** Running, vehicles, mounts, injuries —
  `travelMinutes` is fixed per link. A character-level multiplier hook is
  cheap to leave room for; don't build it yet.
- **Player feedback on clock jumps.** A 15-minute jump the player didn't
  consciously choose (implied travel) should be visible in the UI ("+15m,
  walked to the office") or time will feel arbitrary. Session header
  shows the clock; it doesn't show *deltas* or why.
- **Partial traversal.** If multi-hop travel is interrupted (player
  changes plan next turn), position is whatever node they reached —
  consistent with nodes-only traversal, but narration should know the
  journey was abandoned midway. Brief-level note, cheap.
- **Time-of-day as an input elsewhere.** Darkness should affect the sight
  channel; curfews should be a movement drive modifier; meal times feed
  needs. None of that is this spec's job, but this spec owns the clock —
  expose a clean "time context" (hour band, daylight) so consumers don't
  each re-derive it.

## Verification & final resolutions (2026-06-11, pre-implementation)

- **Time context shape** (resolved): one helper exposes
  `{ minuteOfDay, dayOfWeek, daylightBand: "dawn"|"day"|"dusk"|"night" }`
  derived from the clock + `style.calendarStart`; location light level =
  daylight band × the location's `ambient.light` (the ambient field
  already exists — verified in spawn/location contracts). Consumers
  (perception darkness, drive curfews, schedules) read this, never
  re-derive.
- **Partial traversal** (resolved): an abandoned multi-hop journey
  leaves the player at the node reached; a one-line note rides the next
  brief (same channel as dropped events) so the narration acknowledges
  the change of plan.
- **Schedule schema confirmed**: entries are
  `{ startMinute, endMinute, locationName, activity }` — the
  day-of-week mask is an additive optional field (`days?: number[]`),
  old entries parse unchanged.

## Testing

Pure: resolution order (travel beats action beats estimate; max
composition); chain-cap counting (registry matches only); area-default
travel minutes; meterEffects application. Integration: multi-hop player
move advances clock by path sum; degraded default (no fields set) matches
today's behavior exactly.

## Docs to update when implementing

`turn-engine.md` (merge step 4, constants), `contracts.md` (action
registry, link fields), `database.md` (link columns), `authoring.md`
(forge map-field suggestions), `ui.md` (clock delta display).
