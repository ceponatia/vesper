# Affordance spec draft — stature and reach

Status: draft (companion to
[body-attribute-affordances.plan.md](body-attribute-affordances.plan.md);
promote with the plan)

## What this covers

Interaction geometry from body scale: height differentials between
characters, reach envelopes, passage fit, and strength-capability bands.
Unlike the other domains this is less "visible state" and more "what is
physically possible right now" — the same registry and candidate contract,
consumed as much by future interaction validation as by the narrator.

The payoff is consistency. Height relationships are exactly the kind of fact
LLMs drift on across turns: a character who tiptoed to kiss her partner in
scene three must still need to in scene twelve. A deterministic pairwise read
pins it.

## Contributing attributes

- `build.height`, `build.frame`, `build.musculature`
- `legs.length`, `neck.length`, `shoulders.width`
- `hands.size`, `feet.size` — minor contributions (grip span, balance)
- `wings.span` — cross-ref appendages spec for clearance overlap

## Physical profile sketch

- `statureBand` — resolved overall height band from `build.height` (ordinal
  enum today; promotion decides whether bands suffice or a calibrated
  centimeter anchor per band is needed for pairwise math).
- `reachEnvelope` — standing/stretching/jumping reach bands.
- `passageProfile` — shoulder width + frame vs gap bands.
- `strengthBand` — musculature + frame → carry/lift capability.

## Phenomena

- **height-differential** — a *pairwise* read between two present characters:
  eye-line band (looks up at / level with / looks down at), kiss geometry
  (tiptoe needed / slight tilt / partner must bend), embrace geometry (cheek
  against chest vs shoulder vs level). Cached per character pair until either
  effective height input changes (heels are a presentation input!). This is
  the single highest-value phenomenon in this spec for a romance product.
- **reach-envelope** — can the subject reach a named object/surface band
  (top shelf, hanging lantern) given posture. Fail closed: without a coarse
  height fact for the target, no claim either way. Depends on environment
  authoring for object heights (cross-ref
  [location-authoring.plan.md](location-authoring.plan.md)).
- **passage-and-fit** — broad frame vs narrow gap, tight squeeze bands;
  combines with wings/tail clearance from the appendages spec.
- **strength-capability** — offered-action affordances: can sweep this
  partner up, carry them upstairs, give a piggyback, move that crate.
  Pairwise (carrier strength vs carried mass band from build attributes).
  Never emitted as ambient narration — only surfaced when action-relevant.

## Worked example

A petite character (`build.height: petite`, say) with a very tall partner:
height-differential resolves eye-line `looks_up_at`, kiss geometry
`tiptoe + partner bends`, embrace `cheek_at_sternum`. She puts on heeled
boots (presentation change dirties the pair read): kiss geometry relaxes one
band. The narrator never has to guess, and a scene-image prompt can consume
the same read.

## Open questions

- Do ordinal height bands support pairwise math, or does each band need a
  calibrated anchor value (fixed-point centimeters) in the physics profile?
- Where do heels/footwear feed in — presentation constraint or an effective
  stature modifier in profile composition?
- Is carried-character mass derivable from `build.*` alone for
  strength-capability, or is that overreach for v1?
- Does interaction validation (a future engine consumer) get candidates or a
  dedicated query API over the same resolver?
