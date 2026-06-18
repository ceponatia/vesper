# Multi-character systems — v1 defaults & provisional answers

Status: **implementation reference**. Every previously-open tuning value
and provisional policy, with a concrete v1 answer and a **revisit
trigger**. These are starting values chosen to be safe and observable —
each logs enough evidence to tune from. Nothing here is a decision of
principle (those live in the
[decisions doc](multi-character-presence-and-movement-decisions.phase3.md));
everything here may move with play data.

> **Implementation note (2026-06-12).** Shipped with the foundations
> phase: `DEFAULT_LINK_TRAVEL_MINUTES`, `MAX_CHAINED_ACTIONS`,
> `AFFINITY_DELTA_CLAMP`, `SCHEDULE_JITTER_MINUTES`, the stage
> boundaries, and stage-transition `events` logging
> (`DEFAULT_INTER_AREA_TRAVEL_MINUTES` was rehomed to
> `engine/constants.ts` by phase-2 T5). Landing via
> [phase-2-plan.md](phase-2-plan.md): seeding at stage midpoints and
> decay (T1/T2), `MAJOR_TIER_SOFT_CAP` (T6), `REST_CLAMP_MINUTES` and
> the declared-rest rules (T7). The rest-tick event cap, world-tick,
> LOD, witness-matrix, darkness, and memory-retrieval values wait for
> their systems.

## Constants (initial values for `engine/constants.ts`)

| Constant | v1 | Rationale / revisit trigger |
| --- | --- | --- |
| `DEFAULT_LINK_TRAVEL_MINUTES` | 1 | Adjacent rooms. |
| `DEFAULT_INTER_AREA_TRAVEL_MINUTES` | 10 | Unset cross-area links. Revisit per-world if maps feel small/large. |
| Scale crossing defaults (minutes) | intimate 1 · room 1 · hall 2 · open 5 · expanse 15 | Used when moving within one big location. |
| `MAX_CHAINED_ACTIONS` | 2 | Stop, don't compress (below). |
| `REST_CLAMP_MINUTES` | 960 (16 h) | Declared rest only; normal turns keep the 480 clamp. |
| Rest tick event cap | ceil(spanHours / 3), max 4 per character | A night ≈ 2–3 events each. |
| `WORLD_TICK_MINUTES` | 30 | Decision 1. |
| `ACTIVE_LOD_CAP` | 8 | Decision 2. |
| LOD demotion | after 6 consecutive ticks with no qualifying signal; companions never demote | Hysteresis: any single signal promotes; only sustained silence demotes. |
| `MAJOR_TIER_SOFT_CAP` | 6 | Decision 46. |
| `AFFINITY_DELTA_CLAMP` | ±5 per edge per turn | Story speed, not whiplash. |
| `PERSPECTIVE_MEMORY_SALIENCE_MIN` | 4 | Near-max single-event swing on a ±5 clamp ⇒ "significant moment". |
| `SCHEDULE_JITTER_MINUTES` | ±15, FNV-1a over `participantId::dayIndex` | Deterministic per character per day. |
| `APPROACH_THRESHOLD` | same value as `FOLLOW_THRESHOLD` at launch | Symmetric until evidence says otherwise. |

## Affinity stages (registry data, v1 boundaries)

```
hostile ≤ −50 · wary −49..−15 · stranger −14..14 · acquaintance 15..34
friendly 35..59 · close 60..84 · devoted ≥ 85
```

- New edges: no row = stranger (0). Authored relationships seed
  explicit values (forge suggests a stage; stage midpoint is the value).
- **Decay: 1 point per in-game week toward 0 — but decay alone can
  never cross a stage boundary** (it stops at the boundary). Stages are
  sticky; only events demote a relationship. Revisit if long sessions
  show relationships fossilizing.
- Stage *transitions* log an `events` row (the tuning evidence the spec
  requires).

## Witness matrix (attention × salience), v1

Perceived = ✓. `faces_away` is the attention hint from the object being
used (sink, desk-toward-wall); neutral objects don't apply it.

| Attention | visual obvious | visual subtle | audible loud | audible quiet |
| --- | --- | --- | --- | --- |
| `engaged_with(actor)` | ✓ | ✓ | ✓ | ✓ |
| `idle_alert` | ✓ | — | ✓ | ✓ |
| `engaged_with(other)` | ✓ | — | ✓ | — (conversation masks) |
| `absorbed` (neutral) | ✓ | — | ✓ | — |
| `absorbed` + `faces_away` | — | — | ✓ | — |
| `asleep_or_impaired` | — | — | ✓ | — |

`silent` audible is never perceived by hearing; `loud` also reaches
audibility-linked locations once the sound channel ships (player-side
line ships in v1 per decision 27). Proximity modifier: at `contact`/
`entwined`, the partner perceives everything the actor does **to them**
regardless of row.

## Darkness (v1 model)

- Daylight bands (style-overridable later): dawn 05–07 · day 07–18 ·
  dusk 18–20 · night 20–05, from the time-context helper.
- A location is **dark** when band = night AND `ambient.light` is empty
  or matches dark-leaning keywords; any lit-leaning `ambient.light`
  ("lamplit", "firelight", "bright") keeps it lit. Heuristic keyword
  lists live next to the helper; log misses.
- Effect when dark: visual `obvious` is treated as `subtle` beyond
  `near`; at `distant`, identification fails (presence/silhouette
  only). Hearing unaffected. Conditions (`senseEffects`) stack on top.
- Revisit trigger: first world with non-24h days or magical light —
  move bands into `style`.

## World-tick budget

- Prompt target ≤ ~4,000 tokens; per-character roster slice ≤ ~150
  tokens (location, activity, schedule window, top 2 meters, top 2
  affinity edges, 1-line goal).
- Log prompt+completion sizes as `events` rows (`type: "world_tick"`).
- If the target is exceeded at cap 8: trim slices (drop goals first,
  then affinity edges) before splitting; split-by-area is the designed
  escape hatch, built only when logging shows sustained overrun.

## Per-character memory retrieval (phase 6, decided now)

- One batched query per turn: `owner IN (present majors)`, K = 3 per
  owner, min score 0.55 (reuse the episodes threshold), embedder-
  isolated as everywhere.
- Only majors retrieve per-owner memories; minors rely on the shared
  facts channel.
- `salience` is **stored from day one, not used for ranking** in v1.
  Revisit: add a salience boost when recalled memories feel relevant
  but emotionally flat.

## Provisional policies

- **Chain cap behavior: hard stop, don't compress.** After the second
  registered action the narrator is directed to end the beat ("the
  shower runs long; evening settles in"). Compress-the-rest is the
  fallback if stopping feels abrupt in play.
- **Follow/approach constants unchanged at activation.** T8 turns on a
  recency term that has never fired — ship with current weights, log
  guidance-vs-outcome (`events` rows) for ~50 turns, then tune. Don't
  pre-tune a system with zero observations.
- **NPC↔NPC awareness lines: max 4 per turn**, only non-obvious
  blindspots (an `idle_alert` NPC in an ordinary room generates no
  line). Budget guard for ensemble scenes.
- **Comms v1 surface**: missed call ⇒ missed-call fact + optional
  follow-up text carrying the gist (if the caller plausibly texts). No
  voicemail audio content; no group calls/texts. Text history is
  per-pair, persistent, rendered by the messages UI (decision 48).
- **Staging surface v1: Turn Inspector only** (proximity pairs,
  engagements, attention states per turn). Player-facing staging UI
  waits until the model proves stable.
- **First-impression seed (phase 2 formula)**: seed = context-of-meeting
  (±15) + norm/style compatibility (±10) + appearance/manner read (±5),
  clamped to ±25 total, applied exactly once at first full encounter,
  every seed logged with its factor breakdown (the decision-43
  guardrail). Explicit authored/established relationships always
  override the seed entirely.
- **Affinity axis widening trigger**: revisit when play shows gates the
  scalar can't express — the expected first failure is trust≠warmth
  (betrayal arcs reading wrong). First axis added: `trust`. Until then,
  facts carry the nuance.
- **District abstraction trigger**: when a world exceeds ~60 locations
  or the location roster block exceeds ~1.5k tokens — then area-level
  rosters (the `area` tag is the seed). Not before.
- **ui.md composite pass**: at the end of each implementation phase,
  not as a separate project.

## Logging contract (what makes all of this tunable)

Every system above emits `events` rows: stage transitions, follow/
approach guidance vs outcome, world-tick sizes and drops, impression
seeds with factors, darkness misses, witness-check outcomes on
contested salience. The Turn Inspector renders them. **A constant
without telemetry is a guess that can never graduate** — if an
implementation task ships one of these values without its log line, it
isn't done.
