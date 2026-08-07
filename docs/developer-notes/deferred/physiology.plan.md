# Physiology simulation — triggered body responses as background processes

Status: **draft** — parked in [deferred.plan.md](../deferred.plan.md); not
committed work. Parked 2026-07-23, owner request; promote per
[CLAUDE.md](CLAUDE.md) before building.

Outcome (provisional): A player can watch a character's body respond
consistently to what is happening to her — blushing, shivering, arousal that
builds and fades on its own — so that the prose and the scene image stop
describing a different body from one turn to the next.

## What

Owner direction (2026-07-23): simulate character physiology **responding to
triggers** — e.g. rising arousal increases blood flow to the genitalia, which
increases swelling, lubrication, warmth — and not limited to the sexual case: a
wide range of realistic body responses (cold → shivering, goosebumps, hardened
nipples; embarrassment → blush; fear → trembling, pallor, racing pulse;
exertion → sweat, heavy breath, flushed skin; alcohol → warmth and loosened
coordination). These run as **background processes**: they never tie directly
into the narrator, but their *results* are visible to it — field values change,
reads change, behavior changes.

This is the generalization of an existing ruling, not a new direction. The
meter-economy spec's **ruling OQ2** ("arousal is a driver, not a talk-switch",
[../chat-meter-economy.spec.md](../chat-meter-economy.spec.md)) records the
owner's original intent verbatim — arousal "was supposed to increase wetness,
swelling, blood pressure, heart rate, etc. which could then be represented in
narration or trigger other processes" — and answers it for one driver
(`deriveArousalSigns`). This stub is that answer promoted to a **system**: many
drivers, many responses, one registry.

## What already exists (evidence 2026-07-23 — re-verify at promotion)

The pieces are unusually far along; most of this plan is composition, not
invention:

- **The substrate/read law** ([../chat-meter-economy.spec.md](../chat-meter-economy.spec.md))
  — substrate is stored body fact, the narrator sees only perception-gated
  reads. Physiology slots in as a *middle layer of substrate* between meters
  and reads; the law is untouched.
- **Per-character response tendencies are already authored data.** The
  2026-07-23 intimate-anatomy expansion added exactly the coefficients this
  simulation needs: `vulva.swelling` / `vulva.wetness` / `vulva.tightness` are
  explicitly described as "a response tendency, not live state (current
  arousal rides the arousal meter)"
  (`src/contracts/attributes/categories/intimate/vulva.ts:273-325`), and
  `breasts.sensitivity` / `penis.sensitivity` are input gains. **Tendency
  attribute = the character's transfer function; live level = f(driver,
  tendency).** Without this plan those fields stay narrator-interpreted
  vocabulary; with it they become simulation parameters.
- **Onset/decay math exists as a ruled shape.** The meter-economy proportional
  drift law (`exp(−elapsed/τ)`, exactly composable, clock-keyed — spec ruling
  OQ1) is the right form for response lag: fast rise / slow fall as two τ per
  response (blush arrives in moments and fades in minutes; engorgement decays
  slowly after arousal drops; a refractory period *is* a fall-τ).
- **Persistence machinery exists** — conditions
  ([../../contracts/conditions.md](../../contracts/conditions.md)): severity,
  self-expiry, `attributeEffects` overlays, `promptHint`. The lane already
  mints `flushed` and afterglow conditions from state.
- **Trigger-side precedents exist** — the event→mood table's impulse/standing
  split and `resolveTouchWelcomeness`
  ([../../contracts/meters.md](../../contracts/meters.md) §Mood): events apply
  one-time impulses, standing influences shift baselines. Physiology triggers
  are the same two shapes aimed at body responses instead of mood.
- **Modulation seams exist** — `personalizeMeters`,
  `conditionMoodBaselineShift`: how traits/conditions shift baselines without
  touching values. A future hormonal-phase driver composes here.
- **Consumers exist** — the chat state strip (`chatStateSnapshot`), the
  planned `deriveArousalSigns` read, the state-aware scene-image slice
  (chat state folded into image prompts), and the needs→initiative channel
  ([../chat-body-needs.plan.md](../chat-body-needs.plan.md) §4) for the
  behavior half.
- **No tick needed.** Meters already advance lazily on read
  (`metersAtMinutes` catch-up); physiology levels advance the same way.
  "Background process" here means *narrator-independent*, not a worker or
  cron — the derived-world thesis holds.

## Why it matters

This is the romance lane's core fidelity jump: bodies that respond honestly to
what is happening, instead of a narrator improvising physiology per turn (and
contradicting itself across turns). It cashes out the OQ2 ruling's "trigger
other processes" half, gives the just-authored tendency attributes their
runtime meaning, and gives narration and image prompts *consistent,
witness-perceivable body facts* — the same swelling the prose described is the
swelling the scene image renders two turns later.

## Sketch

Three layers, respecting the substrate/read law throughout:

- **Drivers** — things that move responses: meters (arousal, stress,
  intoxication, energy), conditions, events (touch, a scare, a compliment —
  impulse-shaped), and environment (cold, heat — standing-shaped, once a
  temperature input exists). Drivers are *existing* state; this layer adds no
  new driver storage.
- **Responses** — a **physiology registry** (project rule: vocabulary changes
  are data edits, never migrations). Each response is one row, roughly:
  `{ id, bodyLocationId, drivers (with weights/curves), tendencyAttributeId
  (per-character gain), sensitivityAttributeId (input gain), riseTau, fallTau,
  couplings, expression }`. Seed set spanning the range: genital
  vasocongestion (swelling/erection), lubrication, nipple erection, flush,
  sweat, goosebumps, trembling, breath, pulse. Adding "pupils dilate" later is
  a row, not a schema change.
- **Surfaces** — where results become visible, all existing channels:
  - **Reads** for the narrator — `deriveArousalSigns` becomes the first
    customer of the general `derivePhysiologySigns`, gated on exposure
    (coverage-computed), frame, and contact; never a directive.
  - **State strip / pips** from the same reads.
  - **Image prompts** — the state-aware scene-image path consumes the same
    levels, so prose and pictures agree.
  - **Behavior** only through existing channels: the re-scoped disinhibition
    seam (arousal → `intimate.inhibition` only) and the needs/initiative
    want channel (shivering → wants warmth). No new behavior path.
  - **Couplings** feed other substrate, declared per-row and kept shallow
    (depth-1, acyclic): sweating drains hygiene faster; elevated pulse drains
    hydration faster (the spec's "arousal → heart rate → hydration" note).
    This is a cascade *vocabulary*, not a general ODE solver.

Live level per response is a small clock-keyed value advanced lazily toward
its driver-derived target at the row's rise/fall τ — the proportional law
pointed at a moving target. Fast responses (breath, pulse) may need no storage
at all (memoryless: derive from current drivers); slow ones (engorgement,
sweat-until-washed, refractory) need the stored level or a condition. Where
the line falls is design work at promotion.

**Math correction (2026-07-23 GPT review, adopted):** "the proportional law
pointed at a moving target" understates the work. The meter-economy
exponential composes because its target is FIXED (a baseline); chasing a
target that itself moves continuously is a different integral, and a coupling
that drains another meter (sweat → hydration) requires integrating the
response over time — even depth-1 couplings drift toward an ODE unless
expressed as discrete events or analytically solvable pieces. The tractable
shape: treat drivers as **piecewise-constant between events** (they already
are — meters change at drains/sources), integrate the response analytically
within each piece, and represent coupling effects as **discrete
body-source/modifier events** at piece boundaries (the successor bodies
model's existing shape) rather than continuous flows. **v1 therefore
prohibits causal couplings outright** — perception-only responses derived
from existing meters; coupling lands later through the event mechanism, per
response, with its integral written down first.

**Lane:** chat proves it (product direction: new state patterns land in the
chat lane first); the successor engine's bodies cluster
([../engine.spec.bodies-materials.md](../engine.spec.bodies-materials.md))
inherits the contracts when it graduates, as E5.1 already does for meters.
Sharpened by the review: the derivation itself is **pure and shared from day
one** (`contracts/`), so "chat first" means chat is the first *consumer* —
never a second physiology store built lane-side and ported later. For
successor chats the substrate authority is the sim bodies system
(`lib/simulation/bodies.ts` §25.1 integration), which chat-lane code reads
through the surfaces, not around them.

**Adopted from the 2026-07-23 GPT review** (each verified same-day):

- **Enum tendencies need a versioned mapping to curve parameters.** The
  tendency attributes are words (`slight`/`puffy`/`heavy`…), not numbers;
  the registry carries an explicit `word → gain/τ parameters` table with a
  **derivation version**, so tuning is data and replays don't silently
  change.
- **Tendency vs live level is a hard write barrier.** Several tendency
  attributes are `mutability: "mutable"` (they can drift with life events),
  which invites confusion: the derived live level is NEVER written back
  into the attribute. Attributes hold the authored/slow tendency; live
  state lives in the physiology layer only.
- ~~**Prerequisite seam fix**: `readSimChatMeters` returns stored fixed-point
  rows without calling `integrateMeterValue` at the branch clock
  (`sim-surfaces.ts:273-289`) — the state strip shows last-event values,
  not now.~~ *(Resolved — shipped with C14's sim-read hardening 2026-07-24
  (`eac4b34`): `sim-surfaces.ts` now integrates meters at the branch clock on
  read. Physiology reads can compose on top directly — verified 2026-08-02.)*
- **Capture with the cut.** Physiology facts a committed cut rendered
  against are recorded in that cut's presentation context, so a retake
  re-renders the SAME body state — recomputing from the later live clock
  would let regenerate describe a different body than the turn it replaces.
- **Test list** (beyond the meter-economy suites): hidden-state leakage
  (nothing unperceivable reaches the prompt), partition invariance
  (advance-in-parts ≡ advance-at-once for stored levels), response bounds
  (levels clamped under extreme driver histories), cut/retake stability,
  and narration repetition (the anti-tedium cap actually caps).

**Sequencing:** hard-depends on
[../chat-meter-economy.plan.md](../chat-meter-economy.plan.md) (clock-keyed
drift, proportional law, the read seam, `deriveArousalSigns` — building
physiology first would re-invent all four); pairs naturally with
[../chat-body-needs.plan.md](../chat-body-needs.plan.md) (its meters are
drivers and coupling targets; its needs channel is the behavior surface).

## Open questions

- **Stored vs derived, per response.** Memoryless derivation is free and
  replayable; stored levels handle hysteresis honestly. One stored
  `physiology` map on chat state (bounded by registry size), or conditions as
  the only persistence (severity as a coarse level), or a per-class split?
- **Expression mechanism.** Read-time composition only (never stored into
  attributes), or condition `attributeEffects` overlays so levels surface
  everywhere attributes render? Overlays are tempting for images but risk
  double-authoring the vocabulary the reads already own.
- **Which intermediate variables earn their keep.** Heart rate, breath, core
  temperature, adrenaline are physiologically real — but the taxonomy bar is
  "substrate something else reads". Model only what a witness or a coupling
  consumes; the rest is simulation theater.
- **Male-side live state.** Erection is the obvious first penis-side response
  (the attributes carry size/shape but no live state); does it need its own
  tendency attribute row first (parallel to `vulva.swelling`)?
- **Anti-tedium cap.** The body-needs plan's rule (one need surfaces at a
  time, most-urgent-wins) needs a physiology sibling — a character who
  narrates her own pulse every exchange is the failure mode.
- **Hormonal phase.** The taxonomy's only phase meter modulates gains and
  baselines here as well as in body-needs — which plan owns it, and is it
  wanted at all (real product-judgment call, per the body-needs ranking)?
- **Trigger vocabulary for events.** Touch already resolves welcomeness; a
  scare, a compliment, sudden cold water — do impulse triggers ride the
  event→mood table's shape, the pulse's intent read, or both?

## Slices

_(Defined at promotion. Direction fixed by the review adoption above: slice 1
is the **read-only derivation** — pulse, breath, flush, visible tension:
memoryless or analytically derived from existing meters, perception-gated,
captured in the cut's presentation context, no persistence, no couplings.
Stored levels, condition bridges, and event-mediated couplings come after
that slice proves the read.)_
