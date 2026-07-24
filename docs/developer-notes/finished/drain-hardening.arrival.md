# Drain to expectedArrivalAt — latent arrival mismatch

Status: detail doc of [drain-hardening.plan.md](drain-hardening.plan.md)
(successor-engine backlog item A7; fleshed out and ruled 2026-07-23;
**promoted 2026-07-23** with A5 [honesty](drain-hardening.honesty.md), A6
[backoff](drain-hardening.backoff.md), and C15
[diagnostics](drain-hardening.diagnostics.md) — was
`deferred/arrival-target-mismatch.plan.md`. Ruling 4's parking was lifted by
the owner 2026-07-23 (the bundle promotes on its live defects, not A7's
latent trap); the tripwire survives as a **floor**: travel uncertainty /
mid-trip delays MUST NOT ship before this plan has.)

## What

Travel choreography fast-forwards the branch clock to the journey's
**earliest** arrival, but the arrival trigger is due at the **expected**
arrival. Verified chain (file:line evidence captured 2026-07-23 — re-verify on
promotion):

- `moveArrivalTarget` returns `journey?.earliestArrivalAt ?? after.storySecond`
  (`sim-exchange.ts:240-248`) and is the drain target for every travel path:
  the travel chip (`sim-command/route.ts:286-287`), the NL departure
  choreography (`sim-exchange.ts:1169-1170`), and walk-with-me, which takes the
  max of both actors' targets (`sim-exchange.ts:1364-1367`).
- The §17 arrival trigger is scheduled with `dueStorySecond: expectedArrivalAt`
  (`space.ts:414`), and `advanceBranchStoryTime` only fires triggers with
  `dueStorySecond <= target` (`scheduler-store.ts:645-661, 718`).
- The two are equal today only because `planRoute` hardcodes
  `uncertaintySeconds: 0`, making `expectedDurationSeconds ===
  minimumDurationSeconds` (`space.ts:204-211`). `journey_delayed` has a schema
  and a projector case that bumps `journey.expectedArrivalAt`
  (`space.ts:652-665`) but **no emitter yet** — the bug is fully latent.

Divergence day (first nonzero uncertainty or first `journey_delayed`): the
drain stops at `earliestArrivalAt`, the trigger is still due later, so the
traveller stays `in_transit`. The transcript beat says "You walk to X" but
`arrived` is false, the world card shows nobody anywhere, and any further move
is refused `actor_in_transit` ("They are already traveling."). The arrival only
settles when something else pushes the clock past `expectedArrivalAt` — a later
turn's +60 s advance or a time skip — i.e. the player is silently stranded for
an unbounded number of beats. (LOW/MED · S)

## Why it matters

A latent mismatch that is invisible now but will strand a traveller the moment
travel uncertainty becomes nonzero — a trap waiting on a future feature, armed
by design headroom the engine deliberately reserved (the
`expected`/`minimum`/`uncertainty` triple and the `journey_delayed` event).

## Owner rulings (2026-07-23 — copy into engine.spec §39 at promotion)

1. **Arrival timing follows authored world configuration.** Route durations are
   not an engine constant to pick between "best case" and "typical": distances
   and travel lengths between locations will be **authored at world setup** —
   bespoke first-party worlds we develop, plus player-built worlds (considerable
   effort on their part). The engine invariant this plan enforces is therefore
   semantics-neutral: **the drain target and the arrival trigger's due second
   must always be the same second** — today that shared second is
   `expectedArrivalAt`, whatever values the authoring system later writes into
   a route. The authoring system itself is parked separately:
   [deferred/travel-duration-authoring.plan.md](deferred/travel-duration-authoring.plan.md).
2. **Safety net: re-aim + post-drain arrival check.** Beyond retargeting the
   drain, every travel choreography verifies after the drain that the
   traveller's locus actually left `in_transit`; if not, log a stable
   diagnostic code and let the trip settle on a later beat — never a stuck
   character, never a dead turn (docs/resilience.md). The alternative — reading
   the scheduler row's actual `dueStorySecond` from chat-side code — was
   **rejected** (crosses the chat → scheduler-internals seam we keep clean).
3. **Bundling: graduates with A5 + A6** as one drain-hardening plan (same code
   seam, one shared test setup, one review-and-ship pass). _Extended
   2026-07-23: C15 [diagnostics](drain-hardening.diagnostics.md)
   joins the bundle._
4. **Timing: stays parked** until travel uncertainty or mid-trip delays are
   planned; that feature's planning MUST promote the drain-hardening bundle
   first. The trap physically cannot spring while every trip has an exact
   length and nothing emits `journey_delayed`.

## Sketch

- **Retarget (one line):** `moveArrivalTarget` returns
  `journey?.expectedArrivalAt ?? after.storySecond`
  (`sim-exchange.ts:247`). Update its doc comment and the three call-site
  comments that say "earliest arrival" (`sim-exchange.ts:235-239, 1166-1168,
  1362-1363`; `sim-command/route.ts` travel-case comment). Walk-with-me's
  max-of-targets composition needs no structural change — it maxes the two
  expected arrivals instead.
- **Post-drain check (ruling 2), upgraded to recovery (2026-07-23 GPT
  review, adopted):** a small shared helper beside `moveArrivalTarget`
  (e.g. `settleIfStillInTransit(branchId, actorIds, site)`) that re-reads
  loci after the drain — and when any actor is still `in_transit`,
  **escalates to an A5 durable time job** targeting the journey's current
  `expectedArrivalAt` (which resumes until arrival), records the C15 code,
  and warns. The review's point stands: a log line alone is observability,
  not recovery — "never a stuck character" is delivered by the job, not the
  warn. Call it from all three choreography sites; the route's travel case
  already re-reads `settled` and computes `arrived` — reuse that read.
- **Mid-drain retargeting (same review, adopted):** a `journey_delayed`
  firing while a drain is in flight bumps `expectedArrivalAt` past the
  drain's computed target — completing to that stale target re-creates this
  bug at runtime. The A5 job runner re-reads the journey's target between
  steps and extends; the bounded in-request drain doesn't need to (its
  shortfall is caught by the post-drain check above).
- **Out of scope, noted as the tripwire's second half:** when a delay feature
  finally emits `journey_delayed`, it must both bump
  `journey.expectedArrivalAt` (projector exists) **and** reschedule the durable
  trigger under `journeyArrivalUniquenessKey` (`space.ts:277-279`) — otherwise
  the alarm itself goes stale and ruling 2's check is what catches it.

## Slices

Sized for the bundled drain-hardening plan; alone this is one S slice.

1. **Retarget + pure coverage** — the one-line fix, comment updates, and a pure
   test asserting `moveArrivalTarget` picks `expectedArrivalAt` when the two
   bounds diverge.
2. **Arrival check + degradation coverage** — the post-drain helper wired into
   all three sites, plus a degradation test asserting the fallback **and** the
   diagnostic code (resilience law): seed a journey whose
   `expectedArrivalAt > earliestArrivalAt` via a synthetic `journey_planned`
   event (since `planRoute` cannot produce one yet), drain, assert the actor
   arrives; then a variant with a deliberately short drain asserting the warn
   fires and the next advance settles the arrival.

## Open questions

- Diagnostic code name/shape for the still-in-transit warn (pick at promotion;
  follow the existing `engine.sim.departure` / `engine.sim.accompany` warn
  patterns).
- Whether walk-with-me needs its own test at nonzero uncertainty (two journeys
  with different expected arrivals feeding the max) — decide inside the bundle.
