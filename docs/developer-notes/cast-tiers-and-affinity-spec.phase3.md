# Cast tiers & affinity — spec

Status: **draft for discussion**. Part of the multi-character split — see
[multi-character-overview.phase3.md](multi-character-overview.phase3.md); rationale in
the brainstorm §Affinity / §Character tiers. Decisions 5–7 apply.

> **Implementation status (2026-06-12).** Foundations shipped with
> [multi-character-phase-1-plan.md](multi-character-phase-1-plan.md):
> `tier` on `world_cast` + `session_participants` (library-character
> tier not yet); the `participant_relationships` table; the stage
> registry (`stageForValue`, `clampAffinity`, `stageMidpoint`); simulant
> `affinityAdjustments` + merge upsert with the ±5 clamp and the
> decision-41 perceived flip; stage transitions logged as `events` rows;
> stages surfaced in follow scores (gated below acquaintance), the
> present-NPC context block, and the read-only relationships panel;
> starting-locations authoring (forge suggestions, cast editor field,
> world player-start picker). Scheduled in
> [phase-2-plan.md](phase-2-plan.md) — treat as done when implementing
> here: authored relationships + spawn seeding at stage midpoints (T1),
> decay (T2), the major-tier soft cap diagnostic (T6). Not started:
> first impressions (presence phase), norm-stance → affinity wiring,
> factions, tier drift, template-instanced extras, promotion/demotion —
> and nothing branches on tier at runtime yet (it is stored and
> displayed only). Phase-2 details that bind this spec: decay
> implements the defaults doc's concrete rule (toward 0, stopping at
> the stage boundary — the concrete form of "drift toward a per-stage
> baseline" below); an authored A→B edge also seeds B→A unless that
> direction is authored explicitly; an existing row at first
> encounter suppresses the future first-impression seed, so no
> provenance field is needed; and player-edge `perceived` seeds are
> text-informed (mutual-knowledge bonds mirror the feeling midpoint;
> first-meeting phrasing ⇒ no row; indeterminate ⇒ mirror — ruled
> 2026-06-12, phase-2-plan T1).

## Problem

`role: companion | npc` is an authoring/POV distinction, not a simulation
one — a monster and a central companion get the same machinery. And
relationships are inferred from fact-counting: warmth can only grow,
can't go negative, and can't distinguish friend from well-documented
enemy.

## Design: tiers

A `tier` enum orthogonal to `role`, authored on the library character
(forge suggests one), overridable per world-cast entry and per session
participant (decision 7):

| Tier | Gets | Doesn't get |
| --- | --- | --- |
| `major` | full forge, wardrobe, meters, per-character memory, active-LOD eligibility, perspective memories, full glance blocks | — |
| `minor` | sketch forge, schedule, affinity, facts, background LOD | wardrobe detail, meters, perspective memories |
| `extra` | stat-line snapshot (look, manner, threat), conditions, position | wardrobe, meters, schedule, memory, forge |

Tier is a **ceiling, not a cage**: promotion uses the emergent-cast
enrichment pipeline (a session promotes its own copy; the library is
untouched). Demotion only lowers simulation depth — never deletes data.

Soft cap ~6 majors per session, warn-never-block (decision 46). Planned
later, not v1: **algorithmic tier drift** — a major untouched for ~50
turns decays toward minor; a heavily-engaged minor escalates. Tier
becomes story-responsive; the authored value is the starting point, not
a fixture. Design the tier field and promotion path assuming drift
arrives (e.g. track `lastEngagedTurn` per participant from day one —
it's one timestamp and the drift rule needs the history).

**Template-instanced extras**: an extra can be spawned N times ("wolf"
×3) — one participant row per instance (each holds position/conditions),
all pointing at a shared template snapshot instead of a forged one.

## Design: affinity

Per-edge relationship state, player↔NPC **and** NPC↔NPC from day one
(decision 6), seeded at session spawn from authored world-cast
relationships:

- **Directional, with the player-direction as perception** (decision
  41). NPC↔NPC: A→B is A's actual feeling toward B; two rows per pair.
  Edges involving the player are reframed: each NPC holds (a) their
  feeling toward the player and (b) their **perceived affinity from the
  player** — what they believe the player feels about them, inferred
  from the player's written behavior. The player's actual feelings are
  unknowable and irrelevant; what drives Mara's behavior is that *she
  thinks Brian likes her*. Both values are NPC-owned and
  evidence-updated; gates compose them (approaching someone you believe
  dislikes you is scary even if you adore them).
- **Value**: one scalar per direction, −100..100 (decision 5 — richer
  axes are a later widening; nothing may assume the scalar is forever).
- **First impressions** (decision 43 — chosen ambitious): the opening
  edge value at first encounter seeds from appearance, manner, world
  norms, and context-of-meeting — not a flat neutral. Guardrails mirror
  the identity-range rules: explicit established relationships always
  override; weak signals seed near-neutral; the seed is set once and
  never re-applied. This is a known tuning minefield — log every seed
  with its factors so bad patterns are visible early.
- **Stage**: derived label from a registry —
  `hostile / wary / stranger / acquaintance / friendly / close / devoted`
  — registry data edit, per-world overridable. **Stages, not numbers, go
  in prompts and gate behavior** (follow/approach thresholds, contested
  checks, comms plausibility).
- **Updates**: a small simulant field, `affinityAdjustments: [{ a, b,
  delta, reason }]`, delta clamped tiny per turn (relationships move at
  story speed). NPC↔NPC edges update when both share an event (on-screen
  or world-tick).
- **Decay**: very slow drift toward a per-stage baseline; facts carry the
  qualitative texture, affinity is the cheap scalar.
- **Storage**: a `participant_relationships` table (session-scoped pair
  rows) — queryable, doesn't bloat `ParticipantState` O(cast²).

## Norm stances (decision 45)

Norm breaches adjust witness affinity — **modulated per character**: a
stance on specific norms (`approves | tolerant | default | opposed |
vehement`) so the partner thief shrugs at your theft while the priest
triples the penalty. Stance lives on the character profile
(registry-flavored vocabulary keyed by the world's norm rules), defaults
to the world's norm severity, and the forge can suggest stances from
personality. Feeds: the affinity delta's sign/size, the suggested
witness reaction, and — once factions exist — whether a breach even
counts as one inside the in-group.

## Starting locations (decision 47)

**Verified** (`spawn.ts:284–322`): `startWorldLocationId` IS honored
when set; unset cast falls back to the first location, and the player
spawns wherever the companion (or first cast member) is. So the
machinery works — the gap is purely authoring surface: nothing ever
*sets* the field. Work: forge suggests start locations from character
descriptions (the innkeeper starts at the inn); the cast editor exposes
the field; add an explicit player-start location on the world (today's
follow-the-companion fallback stays as the default when unset).

## Gaps & opportunities

> **Rulings 2026-06-11** (decisions 41–48 in the
> [decisions doc](multi-character-presence-and-movement-decisions.phase3.md)):
> directional edges with the perceived-affinity reframe (design above);
> full first-impression model in v1 with guardrails (design above);
> extras spawn via authored encounter hints + director signal,
> hint-validated, no hints ⇒ no spawns; factions: tag data now
> (forge-suggested), propagation builds post-ledger and flows through
> *learning* of events; norm stances adopted (section above); emergent
> characters seed relationship edges from their conceptNote; soft cap
> ~6 majors with future tier drift (design above); starting locations
> (section above); relationships panel ships with the system.

- **Directional or symmetric edges — undecided and load-bearing.** A
  symmetric edge cannot represent unrequited affection, one-sided grudges,
  or a con artist's feigned warmth — which are half of fiction. Directional
  (A→B and B→A as separate rows) doubles the rows and means the simulant
  adjusts each side separately. Recommend **directional**, but this must
  be decided before the table exists; converting later is a migration and
  a data-backfill headache.
- **First impressions are unmodeled.** Two strangers always start at the
  same value. Real first encounters are biased — by appearance, manner,
  norms, context of meeting (rescued-by vs caught-stealing-from). A cheap
  seed heuristic at first encounter (style/norm compatibility, the
  introducing event's tone) would make cold opens feel less uniform.
  Opportunity, not v1.
- **No faction/group layer.** Punch one guard, the *squad* should care —
  today every edge is individual, so consequences don't propagate through
  allegiance. Worlds have no faction concept at all. A faction tag +
  propagation rule (fraction of a delta applies to same-faction members
  who *learn of it* — note the knowledge-ledger dependency) is the
  natural design; without it, large casts behave like unacquainted
  individuals.
- **Norm breaches don't touch affinity.** The continuity agent already
  detects witnessed norm violations (`normBreaches`) and suggests
  reactions — but nothing wires a breach into the witnesses' affinity
  toward the breacher. One merge rule closes the loop and makes the norms
  system *matter* mechanically, not just narratively.
- **Emergent characters' seeds.** A provisionally-introduced character
  starts as a stranger — but the introducing narration may establish a
  relationship ("your sister Nessa"). The emergent-cast conceptNote
  should be allowed to seed an edge value/stage, else the forge enriches
  a "sister" who mechanically treats the player as a stranger.
- **Stage thresholds need observation before tuning.** Where −100..100
  maps to stages is pure guesswork until play data exists. Put the
  boundaries in the registry (data, not code) and log stage transitions
  as events so tuning has evidence.
- **Major-tier count is uncapped.** Every major in a session costs prompt
  space (canonical blocks), memory rows, and active-LOD pressure. A
  session with 15 majors will degrade quietly. Add a soft cap + a
  diagnostic, and let the session UI show tier distribution.
- **Player visibility.** Should the player *see* stages (a relationships
  panel)? Recommend yes — hidden numbers but visible stages; it converts
  affinity from invisible bookkeeping into a game the player can play.
  Needs a UI decision; nothing else depends on it.
- **Extras lack a spawn/despawn authority.** Who decides three wolves
  appear on the forest road — the director? An authored encounter table
  per location? Random extras are exactly where an LLM will overreach if
  ungoverned. Needs an owner before extras are implemented; suggest
  authored encounter hints per location + director signal, mirroring
  castSignals.

## Testing

Pure: stage derivation boundaries; delta clamping; decay; seeding from
authored relationships; template-instance spawn (N rows, shared
snapshot). Integration: promotion preserves data and upgrades LOD
eligibility; demotion deletes nothing; emergent character with
relationship-bearing conceptNote seeds a non-stranger edge (once that
gap closes).

## Docs to update when implementing

`contracts.md` (tier enum, stage registry), `database.md`
(`participant_relationships`, tier columns), `turn-engine.md`
(affinityAdjustments in simulant schema + merge), `authoring.md` (forge
tier suggestion), `ui.md` (relationships panel if adopted).
