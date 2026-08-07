# Named daylight-band skips

Status: **draft** — parked in [deferred.plan.md](../deferred.plan.md); not
committed work. Successor-engine backlog item B12, parked 2026-07-23; promote
per [CLAUDE.md](CLAUDE.md) before building.

Outcome (provisional): A player can jump to "next morning" or "later" with one
tap instead of entering a number of minutes, so that skipping ahead lands on
the time of day they pictured.

## What

"Next morning" / "Later" / "Days later" as named `advance_time` presets on the
world card and composer, each computed from `storySecond` daylight-band
thresholds rather than a raw minute count. This is the R5 leftover named in
[../finished/engine.rollout.plan.md](../finished/engine.rollout.plan.md). (S)

## Why it matters

Raw minute skips are clumsy; named bands ("next morning") match how a reader
thinks about time and make the common skips one tap.

## Sketch

Compute each preset's target from the current `storySecond` and the band
thresholds, then surface them as `advance_time` chips on the world card and
composer.

## Open questions

_(To be fleshed out in discussion at promotion.)_

## Slices

_(Defined at promotion.)_
