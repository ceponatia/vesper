# Proximity — spec

Status: **draft for discussion**. Part of the multi-character split — see
[multi-character-overview.phase3.md](multi-character-overview.phase3.md); rationale in
the brainstorm §Proximity. Decisions 15–18 apply.

> **Implementation status (2026-06-12).** Groundwork only: the location
> `scale` field is authored (forge + editor), stored, and spawn-copied,
> and the action registry carries the reserved `requiredTier?` field.
> Scheduled in [phase-2-plan.md](phase-2-plan.md) — treat as done when
> implementing here: the narrator framing line for `scale` (T10, the
> prose half of decision 18; the mechanical half — entry defaults,
> conversation gating — belongs to this spec's phase and reads the same
> value). The T10 line is strictly physical size, no staging language —
> prose must not assert tier state before the entry-default table below
> (`intimate`/`room` ⇒ `apart`) exists to back it. Not started: tiers,
> engagement, `proximityEvents`, the movement lock, contested checks,
> the staging surface.

## Problem

The engine resolves *which location* and (with perception) *who noticed*,
but not *how close* — which gates intimacy staging, whispering, reach,
and the class of bug where a character whose foot is in the player's
hands strolls across the room mid-scene.

## Design

### Tiers (fixed in engine, decision 17)

`distant → apart → near → close → contact → entwined`

Pairwise, **scene-volatile** (resets when either party changes location —
decision 15), stored as a sparse map in session runtime (only non-default
pairs recorded; default derives from location scale).

### Location scale (decision 18)

`scale: intimate | room | hall | open | expanse` on locations (forge
suggests, `room` default). Modulates: conversation gating per tier,
whether `distant` exists (only at `open`/`expanse`), default pair
proximity on entry, default crossing cost (feeds time-and-travel). The
narrator gets scale as **one framing line** so prose and rulings read the
same value. Distinct from `area` (groups several locations; scale sizes
one). Never a sub-location system — narratively distinct spots are
separate locations.

### Engagement (the granular end)

`contact`/`entwined` may carry detail referencing the body-location
registry: `{ holderName, partnerName, part: bodyLocationId, how }`. Held
parts are occupied and imply posture. One engagement list per pair — not
a physics rig; its job is stopping impossible narration and sharpening
sensory context (proximity is the future scent channel's main input).

### Implicit transitions

"I take her left foot into my hands" just works: a small simulant field
`proximityEvents: [{ a, b, toTier, engagement? }]`, validated as
adjacent-tier steps (multi-step allowed when narration clearly spans it).
The player never narrates approach.

### Movement lock (decision 15, hardened)

`contact`/`entwined` pins both parties for the movement scorer;
contradictory simulant movements drop (`merge.movement.engaged`) unless
the turn broke contact. **`entwined` is a merge invariant**: a location
change while entwined is invalid — same class as a non-adjacent move —
unless the turn's events include the disengage. Testable like placement
exclusivity.

### Contested transitions (decisions: score-first; roll middle band only)

Proximity-advance attempts get a deterministic check — affinity stage,
current tier, target attention, meters, norms; later combat stats — and
land in clear-success / clear-failure / uncertain. Only the uncertain
band rolls, **seeded** (same situation ⇒ same outcome). Result surfaces
as pre-turn guidance with reasons; the simulant records what actually
happened. v1 factors are consensual-context only.

## Gaps & opportunities

> **Rulings 2026-06-11** (decisions 28–31 in the
> [decisions doc](multi-character-presence-and-movement-decisions.phase3.md)):
> action kinds declare required tiers with **auto-approach** (gating
> closes distance as part of the action; it intervenes only when the
> approach is contested or impossible); failed contested attempts get
> full consequence wiring (affinity + memory + norm check); triangle
> inconsistency accepted everywhere, diagnostic + clamp only at
> `open`/`expanse`; posture coupling is guidance + diagnostic.
> Multi-party engagement confirmed legal with composed locks. Still
> open below: NPC↔NPC proximityEvents coverage, item reach design,
> staging UI shape.

- **NPC↔NPC pairs are required, not optional.** Witness checks for an
  NPC whispering to another NPC, the movement lock for two NPCs
  embracing, and group staging all need NPC-pair tiers. The sparse map
  handles cost (only non-default pairs stored), but the simulant must
  emit proximityEvents for NPC pairs too — confirm the schema and prompt
  cover it, or NPC-only scenes silently lack staging.
- **Pairwise tiers can be mutually inconsistent.** A `close` to B, B
  `close` to C, A `distant` from C is geometrically impossible at room
  scale. Options: a cheap transitive sanity pass (clamp the worst edge,
  diagnostic), or accept that at small scales the tiers are loose enough
  for narration to smooth over. Recommend accept-with-diagnostic at
  `open`/`expanse` only, where the contradiction is visible. Needs a
  decision before group scenes get heavy use.
- **Actions have no required-proximity declarations.** Pickpocketing
  from `distant`, whispering from `apart`, handing an item across the
  beach — intent detection resolves *targets* but never asks "are you
  close enough?". The action/intent layer needs a required-tier concept
  (registry data on action kinds), with the implicit-transition machinery
  auto-closing the gap when uncontested — that's the "I take her foot"
  flow generalized. Without it, proximity gates narration but not
  mechanics.
- **Failed contested attempts have no wired consequences.** A rebuffed
  advance or failed grab should: hit affinity (sign and size by context),
  write a memory for the target (and witnesses), and possibly trigger a
  norm breach if observed. The check spec ends at success/failure; the
  consequence wiring belongs in the merge and is what makes failure
  *mean* something. High value, small surface.
- **Third-party witnessing of intimacy ↔ norms.** The continuity agent's
  `normBreaches` already models witnessed social violations. Witnessed
  intimacy at `contact`/`entwined` in public is exactly a norm question
  (world-dependent!). Wire proximity state into the norm agent's inputs
  — the systems compose for free and nobody has connected them.
- **Posture coupling is asserted, not enforced.** "A held foot implies
  sitting or lying" — is that narrator guidance or a validated
  constraint on `activityUpdates`? Recommend guidance + diagnostic
  (posture vocabulary is freeform; hard validation would fight the
  model constantly). Decide and document, or implementations will
  diverge.
- **Multi-party engagement is undefined.** Dancing, a pile of kids, two
  people supporting a third. The pair model allows A-entwined-B and
  A-entwined-C simultaneously — is that legal (probably yes) and do the
  movement locks compose (A pinned by both)? Trivial to define now,
  awkward to retrofit.
- **Items and reach.** Handing an object should require `near`+;
  throwing exists; weapon reach is the combat-era consumer. Don't build —
  but the required-tier concept above should be designed item-aware so
  reach slots in later.
- **No player-facing surface.** Proximity drives behavior invisibly; the
  session UI (or turn inspector at minimum) should show current staging
  (who's where, who's engaged) for trust and debugging. Cheap; do it
  with v1.

## Verification & final resolutions (2026-06-11, pre-implementation)

- **NPC↔NPC proximityEvents** (resolved): the same simulant field covers
  any pair — `a`/`b` are participant names, player included; the
  simulant prompt explicitly instructs staging NPC pairs ("Mara sits
  beside Tom"), not just player pairs. One field, one validation path.
- **Default-tier derivation**: with sparse storage, an untracked pair's
  tier derives from location scale (`intimate`/`room` ⇒ `apart`;
  `open`/`expanse` ⇒ `distant`); entering a location resets all pairs
  involving the mover to that default (scene-volatile rule, decision 15).
- **Required-tier data** (resolved): lives in the action-duration
  registry entries (one `requiredTier?` field) plus intent-detection
  defaults for the built-in intents (touch/whisper ⇒ `close`+,
  examine-detail ⇒ `near`+). Item-aware reach (weapons) slots into the
  same field later.

## Testing

Pure: tier-ladder validation (adjacent steps, multi-step with coverage);
scale → entry-default/conversation-gating tables; movement-lock
invariant (entwined move without disengage ⇒ dropped + diagnostic);
contested banding determinism (same inputs ⇒ same band; seeded middle
roll stable); engagement → posture guidance rendering. Degradation:
unknown tier in an event ⇒ dropped with diagnostic, state unchanged.

## Docs to update when implementing

`turn-engine.md` (proximityEvents, merge invariant, scorer inputs),
`contracts.md` (tier ladder, scale field, engagement schema),
`prompts.md` (framing line, staging guidance), `ui.md` (staging
surface).
