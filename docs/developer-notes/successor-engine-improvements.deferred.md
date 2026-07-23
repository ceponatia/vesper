# Successor-engine improvements — reviewed backlog (2026-07-23)

Detail file under [deferred.plan.md](deferred.plan.md) §"Successor-engine
improvement backlog". Found by a three-lens review (correctness · simulation
fidelity · resilience/perf/testability) run the day the world-UI slices 0–5
shipped; every finding was verified against the code at that revision, with the
cited files/lines as evidence.

**Process (owner, 2026-07-23): we flesh these out ONE BY ONE as we discuss —
each item graduates to its own `<topic>.plan.md` (+ `<topic>.spec.md` where
design detail warrants) and a roadmap line, then gets a "graduated →" tombstone
here. Nothing below is committed work until it graduates.**

Severity/size tags are the reviewers' estimates at review time; re-verify on
graduation (code moves).

## A. Bugs worth fixing first

1. **Composed sim-commands: idempotency + per-chat lock.** Every POST mints
   fresh envelope ids server-side (`sim-shared.ts:56-67`, fresh `newId()` per
   composed step), so the command-runner's dedup fast-path can never fire, and
   the sim-command route takes no per-chat lock (the send path's
   `chat_exchange` keyed lock has no analog here). Double-tapping a skip chip
   advances time twice and writes two beats; same class for `travel` /
   `do_activity` / `travel_together`. Fix: client-minted idempotency key
   threaded with per-step suffixes + the keyed lock. (HIGH · S/M)
2. **Send racing a clock advance kills the turn.** `prepareEngagementTurn`
   targets `staleClock + 60s` (`arbiter-store.ts:181-188`); a concurrent drain
   past that trips the "story time cannot move backwards" guard
   (`scheduler-store.ts:703`) and the co-present path doesn't catch it
   (`sim-exchange.ts:940` — the solo path does). Player gets a dead turn. Fix:
   target `max(from+span, live clock)` or catch + re-read. (HIGH · S)
3. **Regenerate never works on solo replies.** A solo cut persists with no
   `cutId`; `runSimRetake` (`sim-exchange.ts:1768-1803`) 409s on "no standing
   scene" before its fallback — broken exactly while the primary is away. Fix:
   a solo branch that re-renders via the solo renderer. (MED · S/M)
4. **`travel_together` crash window strands the couple.** Scene-end, player
   move, and NPC move are three transactions (`sim-exchange.ts:1309-1383`); a
   process death after the player's move leaves her at the origin and a retry
   refuses (`not_copresent`). Fix: one branch-locked `move_together` command,
   or resumable idempotent steps (ties into A1). (MED · M)
5. **Drain endpoints 500 after committed writes + unbounded in-request
   drains.** `drain_diverged` returns 500 from `travel`/`do_activity`/
   `advance_time` after the writes committed (the exchange path warns and
   continues — two paths disagree), and a 30-day `advance_time` drains
   synchronously in-request (route cap `43200` minutes; can outlive the proxy
   while time advances anyway). Fix: never 500 after a committed write (return
   `drainedShort: true` + diagnostic); chunk large skips. (MED · S–M)
6. **A retrying trigger can get leapt by the drain.** Transient error →
   backoff hides the trigger from `nextDueStorySecond`, `drainBranchTo`
   re-loops immediately, clock jumps to target, deferred event lands
   mis-stamped — breaking §12.4 partition invariance
   (`scheduler-store.ts:718-733`, `sim-exchange.ts:222-233`). Fix: treat
   `time_budget` catch-ups as stop-and-settle-later. (MED · S)
7. **Latent arrival mismatch.** Travel drains to `earliestArrivalAt`
   (`sim-exchange.ts:240-248`) but the §17 arrival trigger is due at
   `expectedArrivalAt` (`space.ts:414`). Equal today (zero uncertainty); the
   first `journey_delayed` or nonzero uncertainty strands players in transit.
   Fix: drain to `expectedArrivalAt`. (LOW/MED · S)

## B. Making the world actually alive (product cluster)

The review's headline: **the world does not move without the player.** The
primary defaults to `exact` LOD where the routine controller never arms
(`lib/simulation/routine.ts:334-336`, `lib/simulation/lod.ts:313-325`); no
commitments, meal items, extra zones/actions, or lore memories are seeded
(`starter-world.ts`), so the ruling-21 vignette collapses to "she is at home
and stays there," `eat_meal` is always illegal, and RAG recalls nothing on
turn 1. Most machinery is **built but unseeded**.

8. **Seed the life the engine already supports** — the standout cheap win,
   pure data, zero engine code: 2–3 `create_commitment`s on the primary (a
   midday obligation at the square, a soft evening plan), a third zone + second
   link + second action definition, a consumable food item (un-breaks
   `eat_meal` at any LOD), and a handful of authored-lore memory documents
   (the keepsake's meaning, backstory beats) via the existing
   `authored_lore` projector. Instantly gives the vignette real MUSTs and
   `decideDepartures` something to act on. (S)
9. **The primary's LOD story — needs an owner ruling.** At `exact` she is
   mechanically inert forever (never sleeps/eats/moves); at `event` her
   rhythms fire but she's on the background tier built for non-co-stars.
   Options: stay `exact` + lean on B8's commitments; accept the `event`
   fidelity trade; or let routine boundaries arm at `exact` too (the real
   fix). (ruling + S–M)
10. **Text/voice when apart.** The engagement contract defines remote
    channels (`contracts/simulation/engagements.ts:28`); the lane only ever
    opens `co_present` (`sim-exchange.ts:121`). When separated the player gets
    a one-way audience vignette and cannot text her — the highest-value
    missing interaction for a romance product. Relates to deferred §"Comms
    expansions" (the legacy-lane texting ideas). (M–L)
11. **Successor NPC initiative.** The legacy lane's initiative cues
    (`chat-initiative.ts:77`) have no successor analog — `continue` just
    advances the span; the primary never reaches out first. Port the cue
    pattern grounded in her (B8-seeded) commitments. (M)
12. **Named daylight-band skips.** "Next morning" / "Later" / "Days later"
    computed from `storySecond` band thresholds as `advance_time` presets on
    the world card + composer — the R5 leftover
    (`finished/engine.rollout.plan.md` names it). (S)
13. **Autonomous NPC travel toward due commitments.** No code path ever moves
    an NPC between zones on its own: routines can't travel
    (`routine.ts:390-408` — `begin_sleep|eat_meal|hold` only) and departure
    policy only runs inside engagements (`arbiter-store.ts:241-245`). This is
    the difference between a narrated illusion and a world that actually
    relocated her while you were gone. (L)

Also parked from the world-UI plan's slice 5 (recorded there): the
§19.3-deliberator upgrade of the accompany acceptance seam, and the §14.2
remote-invite family (call her to come to you).

## C. Hardening & performance

14. **Four sim read-seams can 500 the whole state strip.**
    `readSimChatPresence/Meters/Outfit/Relationship` throw raw at the route
    boundary (`sim-surfaces.ts:92/273/316/360`) — one malformed JSONB row
    kills the entire state response with a generic 500, violating resilience
    §7. `readSimChatWorld` is the correct model (wraps, degrades to null +
    diagnostic); mirror it. (HIGH · S)
15. **Half-failures are invisible in production.** `engine.sim.departure` /
    `engine.sim.accompany` / `engine.sim.world_beat` are log-only;
    the solo diagnostics are collected but dropped before persistence
    (`persistAssistantReply` omits them). When choreography degrades live
    (`traveled_alone`, interrupt fallback), nothing queryable records it.
    Route through the existing agent-failure telemetry or persist onto reply
    meta. (HIGH · S/M)
16. **Turn-loop read redundancy + missing integration coverage.** A
    departure/accompany turn re-materializes the full space projection 3–4×
    (~18–30 queries; `readDurableSpaceBranch` call sites in
    `sim-exchange.ts:1076/1230/1364-1379`) and re-reads chat authority 3× —
    threading the loaded projection is the biggest latency win (M). The
    composed flows have zero integration tests (`sim-routes.int.test.ts`
    stops at R3 slices 1–2); extend it (self-skips without Postgres) and
    extract pure step-planners so the §8 fallback+diagnostic pairs become
    unit-testable (M). Related low-priority note: `sim_events` is append-only
    with no retention story — reads are O(state) not O(events), so this is
    storage bloat, not latency; document or add rollup later.

## Verified NOT broken (for confidence)

The correctness reviewer specifically audited the slice-5 `npc_policy`
accompany envelope (`principalId:"sim-accompany"`): authorization keys on
`controlledActorIds`, nothing assumes npc_policy envelopes originate only from
the arbiter, and knowledge/consent gates treat them identically. Safe. The
routine trigger re-arm uniqueness keys are sequence-versioned — no PK
collision. Projections are materialized table reads, so large event logs do
not slow the hot path.
