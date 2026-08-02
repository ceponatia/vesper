# Android species — technical spec

Status: companion to [android-species.plan.md](android-species.plan.md);
**shipped — 2026-08-02.**

## Representation

`android` is a normal `SpeciesDefinition` using the existing `humanoid`
body plan. Its two subtypes reuse the heritage overlay rather than adding a
parallel discriminated union:

| Stored id | UI label | Meaning |
| --- | --- | --- |
| `synthetic_android` | Synthetic Android | Purpose-built humanoid chassis |
| `organic_android` | Organic Android | Cloned human body with AI-support cybernetics |

`SpeciesDefinition.subtypeLabel = "Subtype"` changes only authoring language.
`defaultHeritageId = "synthetic_android"` makes an omitted or invalid subtype
degrade to Synthetic. Species without that field retain bare-species behavior.
The profile storage field remains `heritageId`; no JSONB migration is needed.

## Body and attribute law

Both subtypes realize the complete humanoid location set and use the ordinary
per-character `intimateRegions` and `bodyFeatures` switches. Android defines
no location allow/disallow lists and no new body plan, so every applicable Human
physical attribute remains applicable to Synthetic and Organic bodies.

The global attribute registry gains additive constructed-body enum members:

- scent: odorless, sterile, faint ozone, warm polymer, machine oil;
- taste: neutral, sterile, faintly metallic, synthetic sweet, coolant bitter;
- skin/intimate texture: seamless, silicone-smooth, supple polymer,
  porcelain-smooth skin, precision-ridged intimate surfaces;
- sensitivity: adaptive, tunable, feedback-amplified;
- voice timbre: synthetic-clear, harmonic, modulated, speaker-smooth.

Each value has narrator guidance and is excluded from automatic generic
defaults. Global registration is necessary so stored values parse without a
species-dependent trust-boundary schema. Availability is species-dependent:
`organicHumanoidSensoryRules` disallows these members for Human and every
existing biological humanoid. Organic Android applies that same overlay;
Synthetic Android inherits the expanded lists. Thus the forge/editor cannot
offer machine values to a biological body, while a synthetic body retains all
ordinary humanoid values plus the constructed choices.

## Resolution and authoring

`heritageFor(speciesId, heritageId)` resolves an explicit owned overlay first,
then the species default. Unknown ids follow the same degraded default. The
character/persona species-change helper persists the resolved default subtype;
the forge uses an explicit subtype phrase when present and otherwise the species
default. Android's authoring control omits “None” because its subtype is
defaulted; other species keep their existing optional Heritage control.

Inference examples:

- “android concierge” → Android / Synthetic Android;
- “humanoid synthetic” or “synth android” → Android / Synthetic Android;
- “organic android medic” or “bio-android” → Android / Organic Android.

## Verification obligations

Pure tests pin:

1. Android alias inference and default/explicit subtype resolution.
2. Every `defaultHeritageId` references an owned overlay.
3. Synthetic realizes the same physical locations and attribute applicability
   as Human for the same body config.
4. Organic Android has the same realized enum envelope as Human.
5. Synthetic sees constructed sensory members while Organic/Human do not.
6. Species changes, editor defaults, and forge drafts carry the subtype.
7. Every species/overlay rule targets a real attribute and never narrows an enum
   to empty.
