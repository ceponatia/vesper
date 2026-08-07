# Romantic contact affordances — scene and body relations

Status: technical companion to
[romantic-contact-affordances.plan.md](romantic-contact-affordances.plan.md)
(slice 3A — the minimal scene/body-relations owner; contracts built 2026-07-31,
fixture-driven, not lane-wired. Correction pass **3A.1**, 2026-07-31: the
version law, the ordering law and support-set provenance, the boundary
contradiction-drop law, and scene/contact referential integrity.)

## Why this exists

The [truth-source audit](romantic-contact-affordances.audit.md) records pose,
reach, support, and proximity as having **no owner in either lane**. The
contact core was built around that hole on purpose: its resolver takes
`geometry` and `sourceSupport` as `AdapterRead`s and answers `unresolved` when
nobody can speak, which is honest but means no contact can ever commit.

An affectionate-contact proof cannot be run against that. It needs somebody to
answer, authoritatively, *can this hand reach that shoulder from where these two
bodies actually are* — and the plan forbids the one thing that could answer it
today, because **narrator prose is not physical authority**. This module is the
owner. It is deliberately the smallest thing that can answer the question.

`src/contracts/affordances/scene/` — a **sibling** of
`affordances/contact/` and a consumer of it. The dependency runs one way only:
`scene/` imports `contact/`, never the reverse, so a lane with no scene model
still gets a contact core that says `unresolved` rather than one that will not
compile.

## What it owns

| Fact                      | Shape                                                       | Notes                                                                    |
| ------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------ |
| Participant posture       | `SceneFact<ScenePosture>` per participant                   | Five configurations. Absent ⇒ `unresolved`.                              |
| Coarse facing             | `SceneFacingRelation` per **ordered** pair                  | Directional: she may have her back to him while he faces her.            |
| Coarse proximity          | `SceneProximityRelation` per **unordered** pair             | Symmetric, stored once, so a pair cannot hold two distances.             |
| Support roles             | **one** `SceneFact<SceneSupportRelation[]>` per participant | The whole set is one fact, so a clearing keeps a timestamp.              |
| Support surfaces          | `SceneSupportSurface` per surface                           | Kind plus a height rung.                                                 |
| Surface-height relations  | derived                                                     | Posture × zone offset, plus the base rung of whatever the body rests on. |
| Active-contact projection | `ContactLifecycleState`, **housed**                         | The contact core's own type, carried verbatim.                           |
| Movement intents          | `SceneMovementIntent`                                       | Typed changes only; there is no prose case.                              |
| NPC movement authority    | `SCENE_CONTROL_ORIGINS`                                     | The owner's actor-control ruling, as data.                               |
| Retake / snapshot state   | `SceneState` + `parseSceneState`                            | Versioned, serializable, replayable.                                     |
| Provenance                | `SceneProvenance` on every fact                             | Five sources, none of which is narration.                                |

## Vocabularies

Every vocabulary is a const array plus a `z.enum` built from it, in
`vocabulary.ts`. Growing one is a data edit there plus a row in each table
keyed on it — never a schema migration. None of them carries an `unknown`
member: an unstated fact is an **absent** fact, and the difference between
"absent" and "unknown-as-a-value" is the difference between a read that falls
silent and a read that travels.

| Vocabulary               | Members                                                                        |
| ------------------------ | ------------------------------------------------------------------------------ |
| `scenePostures`          | `standing` · `sitting` · `kneeling` · `crouching` · `lying`                    |
| `sceneFacings`           | `toward` · `side_on` · `away`                                                  |
| `sceneProximityBands`    | `touching` · `close` · `near` · `distant`                                      |
| `sceneHeightRungs`       | `ground` · `knee` · `hip` · `chest` · `head` · `overhead` (ordered, index 0–5) |
| `sceneBodyZones`         | `head` · `torso` · `arms` · `pelvis` · `legs`                                  |
| `sceneSupportRoles`      | `borne_by` · `leaning_on` · `held_by` · `bearing`                              |
| `sceneSupportKinds`      | `ground` · `seat` · `bed` · `table` · `wall` · `prop`                          |
| `sceneControlModes`      | `player_controlled` · `npc_controlled`                                         |
| `sceneIntentOrigins`     | `player` · `npc` · `simulation`                                                |
| `sceneProvenanceSources` | `authored` · `player_intent` · `npc_decision` · `simulation` · `scene_default` |

**`leaning` is not a posture.** It is a statement about what carries the
weight, and a body can lean in any of the five configurations; folding it in
would make "standing, leaning on the wall" unrepresentable without a posture
that means two things at once.

**Zones are roots of the shared body tree.** `sceneBodyZoneOf` walks a
`bodyLocationRegistry` id upward until an ancestor is a zone member, so
`foot_arch → sole → feet → legs` and `shoulders → torso` without this module
naming an arch or a shoulder. Splitting `feet` out of `legs` later is a data
edit: add the id, add its rung row and its span, and every location under it
re-homes itself. A location with no zone ancestor answers `unresolved` — there
is no catch-all zone, because a catch-all zone is a guessed height.

### Height tables

Rungs are **relative to the surface the body is on**, so elevation composes:
a woman sitting on a table gets the table's rung added to every entry in the
`sitting` row. Sums clamp at `overhead` (5).

| posture   | legs | pelvis | torso | arms | head |
| --------- | ---- | ------ | ----- | ---- | ---- |
| standing  | 1    | 2      | 3     | 2    | 4    |
| sitting   | 0    | 0      | 1     | 0    | 2    |
| kneeling  | 0    | 1      | 2     | 1    | 3    |
| crouching | 0    | 1      | 1     | 1    | 2    |
| lying     | 0    | 0      | 0     | 0    | 0    |

Reach span — how many rungs a zone crosses on its own, without the body
changing posture: `arms` 2 · `legs` 1 · `head` 1 · `torso` 0 · `pelvis` 0.

## Provenance law

**Every authoritative fact carries where it came from, and every read hands
back the provenance of every fact it consulted** — including the reads that
give up, which report what they got as far as.

```ts
interface SceneProvenance {
  source: SceneProvenanceSource;   // authored | player_intent | npc_decision | simulation | scene_default
  ref: SceneEventRef;              // the lane's own id for the event behind the fact
  storyTime: AffordanceStoryTime;
  evidence: readonly AffordanceEvidence[];
}
interface SceneFact<T> { value: T; provenance: SceneProvenance }
```

A fact is `value + provenance`, never a bare value. The wrapper is
unavoidable on purpose: an optional provenance field would be omitted under
deadline exactly once, and after that the scene would carry claims nobody can
trace.

**There is no prose source, and there will not be one.** A sentence describing
a movement is evidence that a movement was *described*; whether it happened is
a decision for the side that owns the body. A `narration` member here would be
a hole straight through the actor-control law, so the law is enforced by the
vocabulary rather than by a check somebody could forget. A test asserts that no
provenance source and no intent origin matches `/narrat|prose|text|message|reply/`.

`scene_default` is a **stated** default — a scene template declaring that
everyone starts standing on the floor. It is a weaker label, not a licence to
invent: this module never mints one, and no intent can produce one
(`SCENE_ORIGIN_PROVENANCE` maps the three origins onto the three intent-side
sources only).

## Actor-control law

Owner ruling, 2026-07-30
([audit §"Owner decisions needed" 2](romantic-contact-affordances.audit.md)):
player input commits only player-controlled movement; NPC movement originates
NPC/narrator/simulation-side; narrator mode does **not** bypass target agency
or consent.

As implemented, it is one data table:

```ts
SCENE_CONTROL_ORIGINS = {
  player_controlled: ["player"],
  npc_controlled: ["npc", "simulation"],
};
```

`commitSceneIntent` checks structure, then control, then writes:

`commitSceneIntent` checks structure, then control, then **ordering**, then writes.
Ordering runs last because it is the only check that consults the fact being
replaced: an intent nobody was allowed to make is refused on that ground whether
it was late or not.

| Situation                                                                                                                                 | Outcome                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| origin `player`, participant `npc_controlled`                                                                                             | **rejected** `npc_movement_requires_npc_authority`                         |
| origin `npc`/`simulation`, participant `player_controlled`                                                                                | **rejected** `player_movement_requires_player_authority`                   |
| no control fact on the participant                                                                                                        | **unresolved** `control_unresolved` + `scene.control_unavailable` (`warn`) |
| participant not in the scene                                                                                                              | **unresolved** `participant_absent` + `scene.intent_invalid` (`error`)     |
| unusable intent (blank id, negative story time, facing itself, unknown target, two `borne_by`, load-less relation, self-anchored support) | **unresolved** `intent_invalid` + `scene.intent_invalid` (`error`)         |
| older than the fact it targets                                                                                                            | **superseded** `newer_fact_present` + `scene.intent_stale` (`warn`)        |
| restates the fact it targets                                                                                                              | **superseded** `already_asserted`, no diagnostic                           |
| origin permitted, nothing newer in the way                                                                                                | **committed**, fact stamped `SCENE_ORIGIN_PROVENANCE[origin]`              |

There is no narrator origin to check for, which is the restrictive reading the
owner chose. **Only the `committed` branch of `SceneIntentOutcome` carries a
`state`** — the contact core's attempt/commitment boundary in its cheapest
form: a refused, stale, or unreadable intent has no new scene to pick up by
mistake.

A rejection files **no diagnostic**: "the player does not control that body" is
an answer, and logging answers turns the diagnostics channel into a transcript
of the fiction.

`applySceneIntents` folds a sequence; a refused intent leaves the state
untouched and the fold continues, returning every outcome in order so a replay
can prove it reproduced the same refusals, not just the same scene.

## Ordering law

Added in 3A.1. A scene fact records **when it became true**, so an intent is
weighed against the fact it would replace rather than landing on top of it.
`SceneIntentOutcome` gained a fourth branch, `superseded`, which carries the
provenance of the fact that stands (`standing`) and — like every non-committed
branch — no `state`.

| The intent                                    | Rule                       | Outcome                                     |
| --------------------------------------------- | -------------------------- | ------------------------------------------- |
| restates the standing fact, at any story time | never writes               | `already_asserted`, silent                  |
| older than the standing fact                  | never overwrites           | `newer_fact_present` + `scene.intent_stale` |
| same story time, different value              | writes                     | `committed`                                 |
| newer, different value                        | writes                     | `committed`                                 |
| targets a fact the scene does not hold yet    | nothing to be late against | `committed`                                 |

**Restatement never writes**, because only the provenance would change, and
re-stamping an unchanged fact is how a scene where nothing happened produces a
new snapshot every turn — the churn the contact core's `contentKey` exists to
prevent. It also means folding the same intent list twice is byte-identical, and
that provenance keeps answering "when did this become true" rather than "when
was it last mentioned".

**Equal story time writes** when the value differs. Two movements inside one
story minute are ordinary, and within an instant the fold's delivery order is
the only ordering that exists — real causal information, unlike the array order
of a stored blob, which is why the boundary may never make the same choice.

The **slot** is the unit of ordering: a posture intent is weighed against that
participant's posture, a facing intent against that ordered pair's orientation,
a proximity intent against that unordered pair's distance, a support intent
against the whole support set. An unrelated movement can never make a legal one
look late.

### Support-set provenance

`SceneParticipant.support` is **one optional fact whose value is the relation
list**, not a list of per-relation facts:

```ts
support?: SceneFact<readonly SceneSupportRelation[]>
```

`set_support` replaces the whole set, so the set is what has to carry a
provenance — including when it is **empty**. A bare array lost its timestamp the
moment it was cleared, and a clearing with no timestamp cannot be ordered
against anything, so an older intent could silently un-clear it. Now "she let go
of the wall at minute 110" is a fact about minute 110, and an intent from minute
105 is told it is late.

Three states, and the difference between the first two is bookkeeping only:

| `support`          | Means                              | Reads answer                            |
| ------------------ | ---------------------------------- | --------------------------------------- |
| absent             | nobody ever said                   | `support_unknown` / `elevation_unknown` |
| present, `[]`      | somebody said "nothing", at time T | `support_unknown` / `elevation_unknown` |
| present, relations | the stated set, at time T          | the support and reach rules             |

A stated-empty set is a **clearing, not a claim**: reading it as "every limb is
free" would turn a bookkeeping fact into a physical one. Restoration preserves
the distinction — a set that loses every relation to referential integrity keeps
its fact, and its timestamp, rather than reverting to "nobody said".

## Reach rule

```text
proximity ceiling  →  height cost  →  orientation cost  →  ContactReach
```

1. **Ceiling** by proximity band: `touching → in_contact`, `close →
   within_reach`, `near → within_reach_after_adjustment`, `distant →
   out_of_reach`. `near` maps onto the adjustment rung because the contact
   resolver already knows what to do with it — it demands a visible reposition
   unless a minimal adjustment was proposed, which is exactly what "one small
   movement away" should cost.
2. **Height cost.** `delta = |sourceZoneRung − targetZoneRung|`, `span =
   SCENE_ZONE_REACH_SPAN[sourceZone]`. `delta ≤ span` costs nothing;
   `delta ≤ span + 1` costs one step down the ladder; anything further is
   `out_of_reach` outright.
3. **Orientation cost.** A source facing `away` costs one further step — but
   facing is consulted **only when the pair is not already `touching`**, because
   back-to-chest is contact and demanding an orientation there would
   manufacture `unresolved` out of irrelevance.

Degradation only ever walks *down* the ladder `in_contact → within_reach →
within_reach_after_adjustment → out_of_reach`. No fact this module holds can
make a contact easier than the distance between the bodies already allows.

**A read consults exactly the facts that could change its answer.** Two bodies
in different parts of the room are `out_of_reach` whatever they are doing, so
that answer is returned without demanding either posture. This is the rule that
keeps "unknown is not a default" from degenerating into "everything is
unresolved".

**Support enters reach through elevation only** — how high the surface a body
rests on puts its zones. Whether the acting limb is *free to move* is a
different question with a different answer (`sceneSupportOf`), and the contact
resolver consults both; penalizing a weight-bearing limb in both places would
double-count it.

**Object targets** resolve only when the source body is anchored to that object
(resting on the bed, braced against the wall), in which case proximity is
`in_contact` by construction and only the height cost applies. The scene does
not model where furniture is relative to a body that is not touching it, and
`object_surface_unanchored` says so rather than inventing a plausible distance.

Worked cases from the fixtures (both bodies standing on the floor, `close`,
facing each other):

| Attempt                                         | Rungs                   | Answer                          |
| ----------------------------------------------- | ----------------------- | ------------------------------- |
| hand → shoulder                                 | 2 → 3, span 2           | `within_reach`                  |
| hand → head, target standing on a table (`hip`) | 2 → 5 (clamped), span 2 | `within_reach_after_adjustment` |
| foot → shoulder                                 | 1 → 3, span 1           | `within_reach_after_adjustment` |
| foot → head                                     | 1 → 4, span 1           | `out_of_reach`                  |
| hand → shoulder, source facing away             | 2 → 3                   | `within_reach_after_adjustment` |
| foot → the floor it stands on                   | 1 → 0, span 1           | `in_contact`                    |

## Support rule

`sceneSupportOf` maps the scene's declared load zones onto the contact core's
own `ContactSupportMobility` / `ContactSupportRole` vocabulary rather than a
second one:

| Zone appears in                            | mobility                         | supportRole      |
| ------------------------------------------ | -------------------------------- | ---------------- |
| a `borne_by` or `bearing` relation         | `fixed`                          | `weight_bearing` |
| a `leaning_on` or `held_by` relation       | `limited`                        | `partial`        |
| no relation, but the set states others     | `free`                           | `free`           |
| no support fact, or a stated-**empty** set | `unresolved` (`support_unknown`) | —                |

"Nobody said what she is doing with her hands" is not "her hands are free", and
the contact resolver is built to fall silent on the difference.

`trapped` has no producer here — see the open questions.

## Housing the contact projection

`SceneState.contacts` is the contact core's `ContactLifecycleState`, carried
verbatim. This module never constructs, patches, or ends a contact; the one
door is `withSceneContacts`, and `parseSceneState` delegates the projection to
`parseContactLifecycleState` so contact rows heal under **their** owner's rules.
The owner ruled contact into the chat's retake snapshot; housing it here means
the projection travels with the placement facts that make it possible, instead
of being captured separately and drifting from them.

The two versions are independent: a contact projection this build cannot read
empties the projection without touching the scene, and vice versa.

The one thing the contact core cannot check for itself is whether the bodies its
contacts name are still in **this** scene — see the referential-integrity rule
under the snapshot law.

## Snapshot law

**The state is the snapshot.** It is plain readonly data in a canonical order
(participants by subject id, supports by support id, relations by pair key), so
capturing is storing the value and restoring is `parseSceneState` on the same
bytes. There is no second capture shape that could drift from the first.
Everything that builds a state routes through `sceneStateOf`, which sorts,
dedupes last-write-wins, bounds, and `deepFreeze`s — so a parsed state and a
folded state are byte-identical, and replaying the same intents from a restored
snapshot reproduces the identical scene.

Healing, on the contact core's model:

- a blob that is not a scene, or a `version` this build cannot read ⇒ the
  **empty scene** (`scene.state_invalid`, `warn`). Nobody placed claims nothing;
  a misread placement claims something false.
- an unreadable participant, support surface, or relation ⇒ **dropped**, counted,
  reported once (`scene.state_invalid`, `error`). An absent fact makes reads
  answer `unresolved`, which can never be spent — so a quarantine marker would
  only let unreadable data keep occupying a body.
- a **contradicted** key ⇒ every claimant dropped (`scene.state_contradictory`,
  `error`).
- **referential integrity**, including the housed contacts.
- nothing is ever repaired. A corrupt posture drops the participant rather than
  becoming a plausible one.

### Version law

`version` is read as `unknown` and must equal `SCENE_STATE_VERSION` **exactly**;
anything else — a string, a null, a fraction, a future number, a missing key —
degrades to the empty scene with a diagnostic. A `.catch(CURRENT)` (which 3A
shipped and 3A.1 removed) hands back the number this build happens to write, so
a blob nobody wrote for this release is then read as though somebody had, and
every placement in it is trusted. The version is the claim that the rest of the
bytes mean what this reader thinks they mean, and repairing it repairs the only
thing that could have said otherwise. The contact core made the same correction
on the same grounds; the two versions stay independent of each other.

### Contradiction law

At the **untrusted boundary**, a key claimed twice loses **every** claimant —
never the first, never the last. Two participants with one subject id, two
distances for one pair, two orientations for one ordered pair, two surfaces with
one support id, two support relations on one anchor, two `borne_by` relations:
each is a blob claiming a body is in two states at once, and keeping "the last
one" would be this module choosing which writer to believe on the strength of
array position, which is evidence of nothing. **An absent fact is honest; a
chosen one is invented.**

Proximity is keyed by the order-independent pair key, so `(a,b)` and `(b,a)` are
one contradiction, not two facts.

`sceneStateOf` keeps **last-write-wins**, deliberately: there the last entry is
the one the caller just wrote, which is how `withSceneParticipant` and its
siblings express replacement — real ordering information. The boundary is the
part that must never pick, so the drop happens in `parseSceneState` before
construction, and by the time the constructor runs there is nothing to pick
between.

Records that could never be true are refused rather than deduped: **self-facing,
self-proximity, and self-support** fail the boundary schemas (a self-supporting
body takes its whole participant record with it, exactly as a corrupt posture
does) and are dropped by `sceneStateOf` (which keeps the body and loses only the
impossible relation — the surrounding facts came from code, not from an
untrusted blob).

### Referential integrity

A relation is only as real as the things it relates. A proximity or facing entry
naming a participant that did not survive is dropped; a support relation whose
anchor is not in the scene is dropped while the participant keeps its other
facts, keeps its support fact and timestamp, and simply has an unknown
elevation.

The **housed contact projection** is held to the same rule. It heals under the
contact core's own parser, which knows nothing about who is in this scene, so a
contact can come back perfectly well-formed while the body it names was just
dropped as unreadable — an active touch on somebody who is not here. After
participants are restored, any contact whose **body** participants did not all
survive is dropped and counted in `context.orphanedContacts`. Which ends belong
to characters is asked of the contact core's own `contactParticipantIds`, never
re-derived here, so a contact on an **object** needs only its source body.

## Degraded behaviour

| Code                         | Severity       | Cause                                                                                                                                                |
| ---------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scene.intent_invalid`       | `error`        | A movement intent is unusable or names something absent.                                                                                             |
| `scene.control_unavailable`  | `warn`         | Nobody stated who controls the body an intent moves.                                                                                                 |
| `scene.intent_stale`         | `warn`         | An intent arrived older than the fact it would have overwritten.                                                                                     |
| `scene.relation_unavailable` | `warn`         | A relation read could not answer; the reason rides `context.reason`.                                                                                 |
| `scene.state_invalid`        | `error`/`warn` | Stored state was unreadable or dangling in part (`error`, with `dropped` / `dangling` / `orphanedContacts`) or unreadable in whole/version (`warn`). |
| `scene.state_contradictory`  | `error`        | Stored facts claimed one key twice; every claimant was dropped.                                                                                      |

`SceneUnresolvedReason` is the read-side vocabulary: `participant_absent`,
`zone_unknown`, `posture_unknown`, `elevation_unknown`, `elevation_ambiguous`,
`support_surface_absent`, `support_unknown`, `proximity_unknown`,
`facing_unknown`, `object_surface_unanchored`. Each names one specific missing
or contradictory fact, so the gap is nameable rather than a shrug.

## File map

| File              | Responsibility                                                                                                                                                                          |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vocabulary.ts`   | The closed vocabularies, the posture/zone rung table, the reach spans, and the actor-control table.                                                                                     |
| `provenance.ts`   | `SceneProvenance`, `SceneFact`, `SceneEventRef`, the support id (reused `ContactEntityId`), evidence projection.                                                                        |
| `state.ts`        | The five collections, canonical construction, keys, accessors, and the contact-projection door.                                                                                         |
| `intents.ts`      | `SceneMovementIntent`, the actor-control law, the ordering law, `commitSceneIntent`, `applySceneIntents`.                                                                               |
| `relations.ts`    | `sceneBodyZoneOf`, `sceneReach`, `sceneSupportOf`, and the `sceneGeometryRead` / `sceneSupportRead` projections.                                                                        |
| `snapshot.ts`     | Boundary schemas, the version and contradiction laws, referential integrity, `parseSceneState`.                                                                                         |
| `diagnostics.ts`  | The six codes this module emits.                                                                                                                                                        |
| `test-support.ts` | `probe*` fixture builders. Deliberately **not** in the barrel.                                                                                                                          |
| `scene.test.ts`   | 82 cases: vocabularies, zones, reach, absent facts, support, provenance, actor control, the ordering law, snapshot/replay, stored contradictions, housing, contact integration, purity. |

## Public API

`commitSceneIntent({ state, intent, sink? }) → SceneIntentOutcome` ·
`applySceneIntents(state, intents, sink?) → { state, outcomes }` ·
`sceneReach({ state, source, target, sink? }) → SceneReachAnswer` ·
`sceneSupportOf(state, surface) → SceneSupportAnswer` ·
`sceneGeometryRead(...) → AdapterRead<ContactGeometryRead>` ·
`sceneSupportRead(state, surface, sink?) → AdapterRead<ContactSupportRead>` ·
`sceneBodyZoneOf(locationId)` · `emptySceneState` / `sceneStateOf` /
`parseSceneState` · `withSceneParticipant` / `withSceneSupportSurface` /
`withSceneProximity` / `withSceneFacing` / `withSceneContacts` ·
`sceneParticipant` / `sceneSupportSurface` / `sceneProximityFact` /
`sceneFacingFact` / `sceneParticipantIds` · `sceneFact` / `sceneProvenance` /
`sceneProvenanceEvidence` · `scenePairKey` / `sceneFacingKey` /
`sceneSupportAnchorKey` / `sceneSupportSetsEqual`.

## Non-goals

- **No continuous coordinates.** No x/y/z, no metres, no angles, no left/right,
  no depth. Six height rungs and four distance bands, because the question is
  "can this surface meet that one", not "where is everybody".
- **No pathfinding, collision, gait, balance, cloth, or fluid.** Crossing a
  `distant` gap is `out_of_reach`; how a body would cross it is the scene's
  problem, not this module's.
- **No production wiring.** Nothing is registered in `domains/` or any registry,
  nothing is persisted, no schema changes. 3A is fixture-driven contracts; the
  lane adapter that fills a scene from chat or simulation state is later work.
- **No behaviour.** This module never decides that a character moves, only
  whether a stated movement may be committed and what the result lets them
  reach. Desire, willingness, and reaction remain elsewhere, exactly as the
  contact core's decisions do.
- **No second anatomy.** Zones are roots of `bodyLocationRegistry`; sub-surface
  detail stays domain-owned.
- **No LLM anything.**

## Open design questions

- **Should an NPC/simulation intent ever move a player-controlled body?** 3A
  rejects it (`player_movement_requires_player_authority`) as the mirror of the
  owner's ruling, so "she pulls him closer" cannot commit from the NPC side.
  That is the conservative reading; an explicit player-agency grant (a third
  column in `SCENE_CONTROL_ORIGINS`, or a per-intent grant carrying its own
  provenance) is the obvious extension if play shows the restriction bites.
- **Restraint and pinning are not modelled**, so `trapped` — a real member of
  the contact core's mobility vocabulary — has no producer. A pinned wrist and
  a limb caught under a sleeping body both currently read `free`. Adding them
  means a declared per-zone constraint fact, which is a new fact kind rather
  than a new value.

  **Owner ruling, 2026-07-31:** trapped mobility MAY remain unproduced for the
  affectionate proof, **provided the proof avoids restraint and pinning**. It
  becomes **mandatory before any feature that relies on immobilized limbs** — a
  scene that can hold somebody still may not be built on a model in which a
  pinned wrist reads `free`.
- **A carried or held body has no elevation.** `held_by` deliberately answers
  `elevation_unknown`: how high a carried body sits depends on how it is
  carried, and 3A has no vocabulary for that.
- **`feet` share the `legs` zone**, so a foot and a knee are at the same rung.
  The foot trial may want the split; it is a data edit (add `feet` to
  `sceneBodyZones`, give it a rung row and a span) rather than a redesign.
- **The arm span is generous at the bottom of the ladder.** A standing hand
  reads `in_contact` with the floor rather than requiring a bend, because one
  span serves both directions. A directional span (reach up ≠ reach down) is
  the fix if it matters.
- **Zone rungs are centres, not extents.** A standing person's `legs` span the
  floor to the hip and are recorded at the knee. Everything below that
  granularity is deliberately unavailable.
- **Nothing consumes `sceneSupportKind` yet.** It is carried for evidence and
  for a lane's own rendering; only `height` affects an answer. If it never earns
  its keep, it should go rather than become decoration.
- **Who fills a scene, and when?** The lane adapter is out of 3A's scope, but
  the shape of the question is already visible: a chat lane has no placement
  facts at all today, so its first scenes will be authored ones, and the
  provenance vocabulary's `authored` / `scene_default` split exists to keep that
  visible rather than letting seeded facts masquerade as observed ones.
