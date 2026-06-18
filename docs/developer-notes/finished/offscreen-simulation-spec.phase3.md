# Off-screen simulation — spec

Status: **draft for discussion**. Part of the multi-character split — see
[multi-character-overview.phase3.md](multi-character-overview.phase3.md); rationale in
the brainstorm §Off-screen life. Decisions 1–4 apply.

> **Surface note (2026-06-12, user request — see followups.phase2.md
> #9).** When the world-tick ships, each active-tier character's latest
> `offscreenEvents` summary should also land in their
> `ParticipantState.activity` (one brief line, e.g. "speaking to a
> patient") — the session cast card already renders that field live via
> the status payload, so the tick gets a zero-cost real-time surface
> beyond the Turn Inspector feed (decision 48). Gate it like the other
> off-screen state: dev/observer sessions see it; embodied production
> play must not (player omniscience — same class as the cast card's
> "Currently at …" line and hidden-clothing display, followups #7).
> Until then, off-screen activity comes only from authored schedule
> entries (the merge already writes `entry.activity` on schedule
> ticks); characters without a covering entry read as "idle".

## Problem

Absent characters do nothing: they snap to schedule slots, learn nothing,
change nothing. The goal — a world that visibly moved while the player
wasn't looking — must scale to a large cast without per-character LLM
calls per turn.

## Design: LOD tiers

| LOD | Who | Per turn |
| --- | --- | --- |
| live | present (any channel) | full pipeline, as today |
| active | off-screen + warm (companions, recent interaction, open-thread members); **cap 6–8** (decision 2) | batched world-tick |
| background | scheduled, unentangled | deterministic: drives/schedule movement, meter drift |
| dormant | extras, unencountered | nothing until encountered |

Promotion: targeted interaction, thread membership, companion role.
Demotion: N ticks without relevance. **Hysteresis required** — a
character on the boundary must not flap between tiers each tick (enter
high, exit low). Eviction when over cap: lowest-relevance first,
diagnostic logged.

## Design: the world-tick

Cadence (decision 1): player location change OR ≥30 game-minutes since
last tick. One batched `generateChecked` call, **slow lane** (session-less
job like `character_forge`) — never delays a turn; results merge at the
next turn boundary.

Input: active roster slices (location, activity, schedule, goals, top
meters, affinity edges, location affordances) + elapsed time + recent
player observations (see Gaps). Output:

```ts
{ offscreenEvents: [{
    participantName,
    kind: "action" | "social" | "move" | "commsIntent",
    summary,             // one sentence — becomes their memory
    toLocationName?,     // moves: validated like simulant moves
    withName?,           // social: the other party
    driveCited,          // must name a verifiable drive/affordance
}] }
```

Validation (merge-side, deterministic): moves cite drives
(npc-movement-spec); actions ground against the location's **affordance
list**; uncitable/ungrounded events drop with diagnostics. Degraded
default on agent failure: weighted-random affordance picks — the
austerity path (decision: affordances are both grounding vocabulary and
fallback), also the demo-mode behavior.

## Design: affordances (decision 4)

`affordances` on locations: forge-suggested + item-contributed (piano ⇒
"plays the piano") + filtered by character personality/preference tags;
all editable. Durations from the action registry so off-screen time
spends at the on-screen rate.

## Design: lazy backfill

Background/dormant characters aren't simulated; on encounter after a
gap, a catch-up step establishes "what they've been doing" from schedule
+ last-known state + elapsed time.

## Gaps & opportunities

> **Rulings 2026-06-11** (decisions 36–39 in the
> [decisions doc](multi-character-presence-and-movement-decisions.phase3.md)):
> tick events may name background characters — both parties get the
> shared memory + affinity update, only active-tier gets simulated;
> the item-effects field is reserved in the event schema now, bounded
> physical-trace powers build in v2; declared rest ships fully in v1
> (schedule-aware endpoints, one batched tick per rest, span-scaled
> per-character event caps); the Turn Inspector off-screen feed builds
> with the system (decision 48). Backfill canonization and the
> contradiction window below remain requirements to implement as
> written; token budget at cap remains a measure-early item.

- **Backfill must be canonized or it will contradict itself.** If
  "what has Mara been doing" is generated fresh each time the player
  probes, two probes yield two histories. Backfill output must be
  **persisted immediately** as her memory/facts (and deterministically
  seeded — participant + timespan — so a retry generates the same
  answer). This is a correctness requirement, not polish; the spec is
  incomplete without it.
- **The contradiction window.** A tick covering 14:00–14:30 doesn't know
  the player swung through the market at 14:10 and saw who was there.
  The tick's input must include recent player observations (last K
  episode summaries + current location occupancy as of the player's last
  sighting) with the instruction *do not contradict these*. Validation
  can also hard-drop events that conflict with player-witnessed
  locations. Without this, the system manufactures continuity errors the
  continuity agent then has to clean up — paying twice.
- **Physical traces are out of scope — and they're half the magic.**
  v1 world-tick output is activity + movement + memory; it cannot touch
  items. So the blacksmith "forged all afternoon" but no sword exists;
  the cook "made dinner" that isn't on any table. Finding *evidence* of
  off-screen life is the highest-payoff aliveness signal there is.
  V2 opportunity: a tightly bounded item power (create/move/state-note
  within the character's own location, capped per tick, affordance-
  grounded) — design the event schema so the field can be added without
  reshaping the pipeline.
- **Social events touching non-active characters.** "Argued with the
  cook" — but the cook is background-tier. Options: drop (limits social
  texture), allow-with-shared-memory-only (cook gets the memory but no
  tick of her own), or auto-promote (cap pressure). Recommend
  allow-with-memory: both parties get the shared-event memory, only
  active ones get simulated. Needs to be in the validation rules
  explicitly or implementations will guess.
- **Long spans (sleep, wait) are unspecified.** An 8-hour sleep at
  30-minute cadence is 16 ticks — obviously wrong. Rule needed: one tick
  per contiguous fast-forward, elapsed time passed in, **events-per-
  character cap** scaled to span (a night ≈ 2–3 events each, not 16).
  Depends on time-and-travel's declared-rest mechanic; coordinate.
- **Token budget at cap is unmeasured.** Eight roster slices + recent
  observations + affordance lists could be a heavy prompt; output quality
  degrades before token limits do. Measure early; the escape hatch
  (split into two ticks by area) is easy if designed for, awkward if
  not.
- **Observability.** Off-screen events are invisible by construction —
  which makes them undebuggable by construction. The Turn Inspector
  needs an off-screen feed view (events per tick, drops + diagnostics,
  tier transitions). Build it *with* the system, not after; every tuning
  question ("why did she leave?") lands here.
- **commsIntent generation lives here, mechanics live in presence-spec.**
  The tick emits intents; the queue/offer/urgency machinery is
  presence-and-perception's. Keep the boundary clean: the tick never
  decides urgency above "normal" (director-only escalation, decision 8).
- **No world-tick during pure conversation cadence is accepted — note
  it.** With scene-change-or-30-min cadence, a long static scene under
  30 game-minutes has a frozen world. That's the chosen trade (decision
  1); record it so nobody "fixes" it into every-turn cost later without
  noticing the decision.

## Testing

Pure: tier assignment + hysteresis + eviction order; event validation
(drive citation, affordance grounding, location-conflict drops);
affordance composition (location + items + personality filter);
austerity fallback determinism. Integration: tick fires on scene change
and on 30-min threshold but not both within one window; events merge at
turn boundary only; agent failure ⇒ affordance-pick events + diagnostic;
backfill persists and repeats identically on retry (once canonization
lands).

## Docs to update when implementing

`turn-engine.md` (job type, cadence, merge integration), `contracts.md`
(affordances, offscreenEvents schema), `memory.md` (tick events as
memory sources), `ui.md` (inspector feed).
