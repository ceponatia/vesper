# Affordance spec draft — relative stature and body blocking

Status: companion to
[body-attribute-affordances.plan.md](body-attribute-affordances.plan.md)
(promoted with the plan 2026-07-28)

## Purpose

Provide deterministic **relative body geometry reads** that keep narrator
blocking consistent across scenes: who looks up or down, whether a kiss requires
a bend or tiptoe, and where two bodies align in an embrace.

This pair domain follows the shared
[architecture](body-attribute-affordances.spec.architecture.md), but it does not
need a generic material-mechanics object. It compiles stable stature profiles,
assembles a two-subject frame with current posture/presentation, and derives one
pair geometry read.

This is the narrator-relevant portion of stature physics. Generic shelf reach,
passage fit, lifting, carrying, and strength checks are future action-validation
consumers and should not be mixed into the ambient visual observation contract.

## Inputs

### Canonical attributes

- `build.height` — current legal values are `very_short`, `short`,
  `below_average`, `average`, `above_average`, `tall`, `very_tall`, and
  `towering`;
- `legs.length`, `neck.length`, and relevant posture attributes where they
  materially affect eye line;
- coarse frame/shoulder dimensions only for embrace alignment, not for invented
  exact measurements.

### Live inputs

- current posture and body orientation;
- footwear/effective stature modifier supplied by presentation state;
- current ground/surface level;
- asserted pair proximity and facing;
- action context such as kiss, embrace, conversation, or dance.

Without a pair and relevant interaction context, no kiss/embrace geometry cue is
produced.

## Structural profile and pair frame

Ordinal height values should map to calibrated semantic stature anchors. Exact
centimeters are not required unless later action validation needs them.

```ts
interface StatureStructuralProfile {
  statureAnchor: FixedPoint;
  eyeLineOffset: FixedPoint;
  shoulderLineOffset: FixedPoint;
}

interface RelativeGeometryFrame {
  subject: StatureStructuralProfile;
  other: StatureStructuralProfile;
  subjectPresentation: EffectiveStaturePresentationRead;
  otherPresentation: EffectiveStaturePresentationRead;
  subjectPose: PostureRead;
  otherPose: PostureRead;
  subjectSurface: SurfaceLevelRead;
  otherSurface: SurfaceLevelRead;
  proximity: PairProximityRead;
  orientation: PairOrientationRead;
  actionContext?: PairActionContext;
}

interface RelativeBodyGeometryRead {
  subjectId: CharacterId;
  otherId: CharacterId;
  eyeLine: "far_below" | "below" | "near_level" | "above" | "far_above";
  kissBlocking?: "tiptoe" | "slight_reach" | "level" | "other_bends" | "both_adjust";
  embraceAlignment?: "head_below_shoulder" | "head_at_shoulder" | "near_level" | "head_above_shoulder";
  evidence: readonly AffordanceEvidence[];
}
```

The mapping is semantic and deterministic. Do not present anchor values to the
narrator as numbers. Footwear and surface level are live frame inputs, never
structural-profile fields.

`RelativeBodyGeometryRead` is the domain's reusable pair calculation, not a
third narrator-output category. When current action context makes one relation
relevant, projection emits a normal structured visual observation such as
`relative_geometry.eye_line` or `relative_geometry.kiss_blocking`. The whole
pair object never enters the ambient cue queue.

## Phenomenon

### `relative_geometry.stature_blocking`

Requires two present characters plus current posture/orientation. It computes a
pairwise read that can be used to:

- ground eye-line description;
- constrain kiss and embrace blocking;
- prevent height relationships from flipping between turns;
- supply scene-image composition with the same relative geometry.

The read is actual current geometry, not an ambient cue that must always be
mentioned. It should surface only when the action makes relative stature
relevant.

Footwear modifies effective stature at read time. It never rewrites
`build.height`.

## Worked cases

### Short character with a very-tall partner, both standing level

The pair read may resolve:

- eye line: `far_above` from the shorter character's perspective;
- kiss blocking: `tiptoe` plus `other_bends` or `both_adjust`, depending on the
  calibrated differential;
- embrace alignment: head below or near the taller partner's shoulder/chest
  band.

### Same pair after the shorter character puts on heels

The presentation modifier narrows the differential by one calibrated amount.
The canonical height attributes remain unchanged.

### Same pair seated on different surfaces

Current ground/surface and posture inputs override the standing comparison. The
system must not reuse a cached standing read.

## Out-of-scope future queries

These may reuse the stature profile later but need separate contracts:

- reaching a shelf or ledge;
- clearing a doorway or narrow passage;
- carrying or lifting another character;
- strength and balance checks;
- jump reach.

They require authored object geometry, mass, capability, and action rules that
this visual-narration plan does not own.

## Acceptance tests

- the pair phenomenon never receives raw height/leg/neck enum values;
- structural profiles contain no footwear, surface, or posture state;
- all examples use legal `build.height` values;
- pair ordering is symmetric and perspective-correct;
- footwear changes effective stature without changing canonical height;
- posture/surface changes recompute the current pair read;
- no pair/action context means no kiss or embrace cue;
- the same pair and current state produce deterministic blocking;
- reach/strength/carry results never appear in the narrator cue list.

## Open questions

- Calibrated semantic anchors for the eight current height values.
- Whether leg/neck length contributes enough to justify v1 complexity.
- Exact posture/surface facts available before a richer pose model.
- Whether scene-image composition consumes this pair read in the first rollout
  or only after chat narration proves it.
