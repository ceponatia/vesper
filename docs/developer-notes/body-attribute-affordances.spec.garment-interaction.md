# Affordance spec draft — garment interaction

Status: companion to
[body-attribute-affordances.plan.md](body-attribute-affordances.plan.md)
(promoted with the plan 2026-07-28)

## Purpose

Compose wardrobe-owned garment properties with body state, environment, pose,
and motion to derive current visual garment effects:

- wet cling;
- opacity/translucency change;
- surface beading or saturation;
- wind or body-motion response;
- pose-dependent drape.

Garments are not body attributes. This spec is an integration consumer of the
same [domain architecture](body-attribute-affordances.spec.architecture.md)
because body-adjacent visual narration needs clothing and body state to agree.
The upstream [clothing state graph](clothing-state-graph.plan.md) owns the
blueprint, stable instance/locus, presentation operations, condition gradients,
and localized marks this domain reads; this domain must not duplicate them.

## Ownership boundary

The wardrobe/item system owns:

- material identity and layered construction;
- weight, stiffness, absorbency, and baseline opacity;
- fit and garment-region coverage;
- support function;
- worn location and current fastened state;
- persistent garment wetness, dirt, damage, displacement, and riding-up state.

## Structural profile

The affordance layer receives a normalized structural profile from wardrobe. It
must not create a second garment catalog or mutate worn state.

```ts
interface GarmentStructuralProfile {
  garmentId: ItemId;
  regions: readonly GarmentRegionStructuralProfile[];
}

interface GarmentRegionStructuralProfile {
  regionId: GarmentRegionId;
  coveredBodyLocations: readonly BodyLocationId[];
  materialClass: GarmentMaterialClass;
  absorbency: UnitInterval;
  clingAffinity: UnitInterval;
  baselineOpacity: UnitInterval;
  wetOpacityResponse: UnitInterval;
  dryMass: UnitInterval;
  dryDrapeStiffness: UnitInterval;
  fit: "loose" | "fitted" | "tight" | "structured";
}
```

Base color/lightness metadata may affect visible wet-opacity change, but it
belongs to the garment read, not to body attributes.

Saturation, persistent displacement, damage, and fastened state remain live
wardrobe/presentation state. They are not structural profile fields.

## Effective mechanics

Each garment region compiles once per cut:

```ts
interface GarmentRegionEffectiveMechanics {
  regionId: GarmentRegionId;
  saturation: UnitInterval;
  waterLoad: UnitInterval;
  effectiveFlutterLoad: UnitInterval;
  effectiveDrapeStiffness: UnitInterval;
  contourConformance: UnitInterval;
  effectiveOpacity: UnitInterval;
}
```

These are named because several phenomena share them:

- water load affects surface state, motion, and drape;
- effective flutter load affects wind and body-motion response;
- contour conformance affects wet cling and pose drape;
- effective opacity feeds both the garment observation and final coverage read.

Actual cling still requires current garment/body contact. High contour
conformance is capacity, not proof that cling is occurring.

## Domain frame

```ts
interface GarmentAffordanceFrame {
  subjectId: CharacterId;
  storyTime: StoryTimestamp;
  profile: GarmentStructuralProfile;
  mechanics: readonly GarmentRegionEffectiveMechanics[];
  currentState: GarmentPresentationRead;
  actualContacts: readonly GarmentBodyContactRead[];
  pose: PostureRead;
  wind?: WindRead;
  motion?: MotionRead;
  recentEvents: readonly AffordanceCausalEvent[];
}
```

Phenomena consume narrowed region views instead of the entire wardrobe.

## Resolution order

Do not build a general cyclic phenomenon graph. Use an explicit staged pipeline:

1. wardrobe supplies structural profiles and authoritative current state;
2. garment mechanics derive saturation-dependent regional terms once;
3. garment phenomena derive current surface, cling, motion, drape, and opacity
   observations;
4. effective opacity plus authored coverage produce final
   `EffectiveCoverageRead`;
5. body-surface perception uses that final read;
6. narrator ranking happens after garment and body observations exist.

A garment phenomenon may change the **read** of coverage/opacity but cannot
silently rewrite the garment or body substrate.

## Phenomena

### `garment.wet_surface_state`

Current saturation plus material response yields observations such as:

- droplets bead and run;
- fabric darkens;
- fabric appears saturated;
- water sheds with little absorption.

A leather jacket and cotton shirt should not use the same response.

### `garment.wet_cling`

Requires sufficient saturation and cling affinity. Fit, stiffness, lining, and
body contact determine where cling occurs. It consumes the shared contour-
conformance mechanics and asserted regional contacts rather than recalculating
wet flexibility from raw material fields.

The observation carries affected garment/body regions and a contour-read band.
It does not invent uncovered anatomy; downstream exposure policy remains
binding.

### `garment.effective_opacity`

Projects the shared current `effectiveOpacity` into a semantic observation band
and the staged `EffectiveCoverageRead`.

Do not treat all white fabric as transparent when wet or all dark fabric as
unchanged. The authored garment/material profile decides the response.

### `garment.wind_or_motion_response`

Requires current wind, subject motion, or an impulse. Soaked fabric generally
loads and hangs more heavily; fit and construction constrain movement. The
phenomenon consumes `effectiveFlutterLoad` and current force rather than raw
absorbency/saturation.

Outputs describe actual current movement — a hem stirring, loose sleeve
fluttering, cape snapping — not generic capability.

### `garment.pose_drape`

A current pose transition may change drape or settle state. Persistent changes
such as a hem remaining caught or a strap remaining displaced belong to
wardrobe/presentation state, not affordance memory.

## Worked cases

### Fitted cotton shirt in rain

- saturation rises in garment state;
- wet-cling may resolve over regions currently contacting the body;
- effective opacity may decrease according to the garment profile;
- the final coverage read determines what underlying surface observations are
  perceptible.

### Leather jacket in the same rain

- low absorption produces beading/runoff;
- no fabric cling or opacity downgrade;
- the useful observation is surface droplets or darkened wet leather.

### Soaked loose skirt in wind

- water loading suppresses flutter compared with its dry state;
- a strong gust may still move an exposed hem;
- no persistent riding-up state is invented without a wardrobe event/state
  change.

## Narrative-focus and exposure policy

A physical/perception read can establish that contour or underlying detail is
observable. A separate shared product/narrative-focus policy decides whether it
belongs in the current narration. The same policy should govern intimate soft-
tissue observations and garment opacity changes.

This layer must preserve:

- authored exposure/coverage rules;
- observer angle and distance;
- current action relevance;
- strict repetition limits;
- the distinction between subtle contour, partial opacity change, and actual
  uncovered exposure.

## Acceptance tests

- wardrobe is the sole owner of garment material and persistent garment state;
- phenomena never receive raw item enum values or duplicate material
  calibration;
- each garment region derives shared effective mechanics once per cut;
- wet cotton and wet leather produce materially different observations;
- saturation cannot increase flutter for a fabric whose authored water loading
  should suppress it;
- wet cling requires current garment/body contact;
- opacity changes feed the staged effective-coverage read deterministically;
- no current force/motion means no garment-motion observation;
- persistent displacement requires authoritative wardrobe state;
- hidden/intimate detail never bypasses exposure and narrative-focus policy.

## Resolved (owner rulings, 2026-07-28)

### Material vocabulary — adopt, never re-create

`GarmentMaterialClass` resolves to the clothing system's existing registry in
`src/contracts/items/garment-material.ts`: its seven material families
(`woven_cotton_linen`, `knit`, `silk_satin`, `denim`, `wool`, `leather`,
`synthetic_shell`) plus `unknown`. Its existing coefficients — absorbency,
drying, opacity response, stiffness, cling affinity — are what
`GarmentRegionStructuralProfile`'s material-derived fields normalize. This spec
MUST NOT create another material vocabulary or a parallel coefficient set.

### `GarmentBodyContactRead`

A garment/body contact read identifies:

- garment and garment region;
- body location;
- contact mode — resting, fitted, or pressed;
- contact/pressure strength;
- whether the contact came from fit, pose, or an explicit event.

Establishment law: a **fitted or tight** worn garment can establish ordinary
contact from wardrobe truth alone. A **loose** garment requires pose, pressure,
or another asserted relation before cling is claimed. Pose- and event-sourced
contact links come from the shared scene/body-relations owner (architecture
spec §Scene/body-relations owner); unknown contact still means silence.

### First release scope

Ships: material-dependent `garment.wet_surface_state`; `garment.wet_cling`
restricted to regions with actual contact; `garment.effective_opacity` with the
final coverage read. Effective opacity ships **alongside** cling because it
decides what underlying details remain perceptible.

Deferred until the shared scene/body-relations owner exists:
`garment.wind_or_motion_response` and `garment.pose_drape`.

### Effective coverage is captured, not reconstructed

Capture the final `EffectiveCoverageRead` directly with the presentation cut:
opaque, hinted, or exposed by body location, with contributing garment
evidence. It remains a **derived result, not wardrobe truth** — capturing it
ensures narration, body affordances, retakes, and images all use the same
answer rather than each recomputing one.

### Shared narrative-focus policy

The intimate-cue policy is shared with soft tissue and stated in full in
[spec.soft-tissue.md](body-attribute-affordances.spec.soft-tissue.md#resolved-owner-rulings-2026-07-28).
Binding here: an intimate garment cue requires a current relevant action,
contact, motion, pose transition, or support transition; ordinary unchanged
visibility is insufficient; exposure and consent remain hard gates; **at most
one** intimate body-or-garment cue per exchange, under an aggressive cooldown
across the shared intimate cue family; and the cue must not displace dialogue
or the exchange's primary action.

## Resolved (Slice 6 implementation, 2026-07-28)

Shipped as `src/contracts/affordances/domains/garment/` (pure) plus the chat
adapter `src/server/engine/chat-garment-affordances.ts`. The registry is
`affordanceDomains = [hair, garment]`.

### What the code does that this spec's sketch did not say

- **The structural profile is SUBJECT-scoped, not garment-scoped.** The sketch
  shows `GarmentStructuralProfile { garmentId, regions }` — one garment. One
  affordance read is about one subject, and a subject wears several garments
  that layer over each other, so the shipped profile is a flat, `regionId`-sorted
  collection across everything worn, each region carrying its own
  `garmentId`/`partId`. That is the architecture spec's own "regional
  collections" pattern rather than a new one.
- **`GarmentFitClass` gained an `unknown` member**, mirroring
  `GARMENT_MATERIAL_UNKNOWN` exactly. Nothing in the clothing system records fit
  today (not the item definition, not the blueprint node, not the instance), and
  a conservative registry member is how this codebase already says "the wardrobe
  cannot answer". `unknown` establishes no contact, so wet cling cannot fire from
  it; its conformance coefficient sits mid-scale. **This is the single open gap
  in the ruled scope** — see "The fit gap" below.
- **`dryMass` is derived, not authored.** The wardrobe registry has no weight
  coefficient; `drapeStiffness` is the closest honest proxy (denim and leather
  are its heavy families, silk and knit its light ones), damped toward the middle
  so a derived term does not pretend to the precision of an authored one.
- **The intimate-focus gate is applied per phenomenon, by what the read is
  about.** The policy does not say which garment reads count as intimate, and
  the two obvious readings both fail: keyed on "any covered location", every
  ordinary top is intimate (the registry hangs breasts under `chest`) and the
  domain is permanently silent; keyed on nothing, a soaked-transparent top sails
  through the gate the policy exists for. Shipped split:
  `garment.wet_surface_state` is about the FABRIC and is checked against its
  anchor location only (so a bra at `chest` is gated and a shirt at `shoulders`
  is not); `garment.effective_opacity` and `garment.wet_cling` are about the BODY
  through or under the fabric and are checked against every location involved.
- **Occlusion is handled in the domain, not in perception.** A buried region
  produces no visual read for any observer, so the wardrobe's own
  `resolveWardrobeVisibility` verdict rides the frame's regional state and the
  phenomena drop `hidden` regions — the same call the garment cue block already
  makes. Observer-specific filtering still runs afterwards, in the core.
- **Garment identity rides a `garment:<id>` semantic tag.** The core
  observation carries a body location, a band, and tags; cue projection needs the
  garment's NAME. A prefixed tag is the declared channel for structured cue
  metadata, and it kept a domain noun out of the shared type.

### One domain-neutral core change

`AffordanceDomainDefinition.compileProfile` now takes the whole
`AffordanceDomainRequest` rather than the attribute snapshot. A body domain reads
`request.attributes`; a domain about something the character WEARS reads
`request.payload`, because garment structure belongs to the wardrobe. The core
still names no domain — `src/contracts/affordances/core/domain-neutrality.test.ts`
asserts that mechanically over the core's source.

`RegisteredAffordanceDomain` also gained `trace(request)`, which runs the same
stages `resolve` does and keeps the intermediates. It exists for the developer
preview and is debug-only.

### The fit gap

`garmentContactsFromFit` implements the ruled establishment law in full
(`fitted`/`tight` establish ordinary contact; everything else needs pose,
pressure, or an asserted relation). The chat adapter's `recordedFit()` seam
returns `undefined` for every garment because no wardrobe field exists, so:

- no contact is established;
- the adapter OMITS the `contacts` payload key entirely;
- the core suppresses `garment.wet_cling` with `affordance.input.unavailable`,
  exactly as it suppresses `hair.strands_adhere_to_skin`.

Cling is therefore fixture-proven and production-silent. The moment the wardrobe
records fit, that one function grows the lookup and cling starts firing with no
other change here or in the domain.

### Effective coverage: where the capture rides

`EffectiveCoverageRead` (bands + contributing garment evidence per body location)
lives in `src/contracts/items/effective-coverage-read.ts` — the wardrobe owns the
vocabulary and the persisted shape; the affordance domain owns the derivation
(`domains/garment/effective-coverage.ts`), which reads the same
`effectiveOpacity` the opacity phenomenon bands. Layers ADD cover: a location's
band comes from the most-concealing region reaching it, so a soaked-transparent
shirt over a dry camisole leaves the chest opaque.

The capture is persisted at `ChatGarmentStore.coverage[actorId]` — inside the
garment store, so it rides `pre_exchange_scenario` with the garments it describes
and a retake restores both or neither. No migration: the store is one JSONB
column.

### Narrator boundary with `CHAT_GARMENT_CUES`

`CHAT_GARMENT_CUES` owns garment STATE and its changes (closure, roll,
displacement, the condition band, deposits, damage). `CHAT_AFFORDANCE_CUES` owns
the current derived VISUAL EFFECT of that state (surface behavior, opacity,
cling). They overlap at exactly one place — garment wetness — so with both flags
on the pipeline passes the garment ids the wardrobe block already spoke about and
the affordance projection drops its surface line for them. Opacity and cling have
no counterpart there and always survive.

### Deferred, and the diagnostics that hold the silence

| Deferred                              | Why                                                      | Where the silence shows                                        |
| ------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------- |
| `garment.wind_or_motion_response`     | no wind/motion owner (shared scene/body-relations owner) | not registered at all — no permanently-suppressed row per read |
| `garment.pose_drape`                  | no pose owner                                            | not registered                                                 |
| `garment.wet_cling` **in production** | no fit and no pose ⇒ no contact                          | `affordance.input.unavailable` on the `contacts` dependency    |
| intimate garment cues                 | chat lane has no narrative-focus/consent owner           | `intimate_gated` (consent) / `not_narrative_focus` (relevance) |

`effectiveFlutterLoad` and `effectiveDrapeStiffness` are derived and
fixture-tested anyway: the spec names them as shared mechanics, stiffness feeds
`contourConformance` today, and the "saturation cannot increase flutter" law is
about the mechanics, not its consumer.
