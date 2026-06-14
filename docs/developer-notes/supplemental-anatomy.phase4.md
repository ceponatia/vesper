# Supplemental anatomy — the full aionchat field catalog & port plan

Status: **catalog complete, port pending** (drafted 2026-06-14). Supplemental to
the body-model spec
[intimate-anatomy-sensory-and-species-spec.phase4.md](intimate-anatomy-sensory-and-species-spec.phase4.md)
and the [phase-4-plan.md](phase-4-plan.md). Nests under that plan.

## Why this doc exists

Phase 4 (T1) ported only the **intimate** anatomy attributes (`breasts`, `vulva`,
`penis`, `testicles`) from aionchat, plus kept Vesper's pre-existing everyday
groups. It deliberately **skipped the rest of aionchat's anatomy vocabulary** —
the spec's field-preservation audit was scoped to "the data we're actually
porting (the body locations and the anatomy attributes)" for the intimate set,
not the whole aionchat anatomy package.

In play, that gap shows: aionchat has descriptive attributes for **buttocks,
groin, abdomen, nose, cheeks, chin, throat** and many more that Vesper has no
group for, plus richer value sets on groups Vesper *does* have. This doc is the
**complete 1:1 catalog** of aionchat's anatomy schema and the **port plan** for
closing the gap. Nothing aionchat ships is dropped here; where Vesper's coarser
convention means a field should *fold* into an existing group rather than spawn a
new one, that's called out per region (not silently omitted).

Source of truth read for this catalog:
`~/projects/aionchat/packages/contracts/src/attributes/anatomy/*.ts` and
`.../body-locations/humanoid/*.ts`.

> **Companion fixes shipped alongside this catalog** (the three play defects that
> prompted it) are recorded in [followups.phase4.md](followups.phase4.md) §5–7:
> anus made universal, the body-config toggle feedback, and the Chest/Pelvis
> attribute nesting. This doc is the *data* deliverable; those are the *code*
> deliverable.

---

## Porting principles (decide once, apply to every region)

aionchat and Vesper disagree on three axes. Resolve them here so the port is
mechanical, not a per-region debate.

### P1 — Granularity: fold segments, add genuinely-new regions

aionchat models ~45 fine categories with **explicit left/right body-location
nodes** (`arms.upper_arms.left`, `legs.feet.right.toes`, …). Vesper deliberately
uses ~25 **coarse** groups and folds segments (Vesper `arms` ≈ aionchat
arms+upper_arms+forearms+elbows+wrists; Vesper `legs` ≈ thighs+calves+shins+
knees+ankles; Vesper `face` ≈ face+cheeks+chin+forehead+nose).

Porting aionchat's fine categories *wholesale* would create ~25 new top-level
attribute groups — fighting the coarse convention **and** the Chest/Pelvis
nesting we just shipped. So the rule:

- **New group** only for a region that is a *distinct, describable body part with
  no coarse home* — **buttocks, groin, abdomen/stomach, nose, throat** (and the
  intimate `vagina` simulation group). These get first-class groups (and, for the
  pelvic ones, nest under the **Pelvis** area).
- **Fold as added attributes** into the existing coarse group for true *segments*
  of a larger region — `upper_arms.build` / `forearms.build` / `elbows.prominence`
  / `wrists.size` → extra attributes on **`arms`**; thighs/calves/shins/knees/
  ankles → **`legs`**; cheeks/chin/forehead → **`face`**. One attribute per useful
  distinction, not a new group per joint.
- **Skip** only the trivially-granular (`fingernails` vs `toenails` length when
  Vesper already has a combined `hands.nails` / `feet.nails`) — noted inline as
  "covered."

Each region below is tagged **[NEW GROUP]**, **[FOLD → group]**, or **[COVERED]**.

> **Open question (granularity).** P1 is the recommended split. If you'd rather
> match aionchat **1:1** with a group per region (the "everything 1:1" reading),
> every [FOLD] below becomes a [NEW GROUP] instead — the field data is identical,
> only the `category` and file layout change. Flagged here, not silently chosen.
> See the plan's [Open questions](phase-4-plan.md#open-questions).

### P2 — `kind` taxonomy

aionchat uses `physical | biological | condition`. Vesper uses
`physical | biological | presentation | cultural | sensory`
([contracts.md](../contracts.md) §Attribute system). Mapping:

| aionchat `kind` | Vesper home | note |
| --- | --- | --- |
| `physical` | `physical` | direct |
| `biological` | `biological` | direct — already in Vesper's enum (`groin.sensitivity`, `vagina.elasticity`) |
| `condition` (temporary skin/nail/eye states) | **a `condition`-kind attribute**, or model via the **conditions registry** | Vesper already routes transient states (sweaty/soaked) through `conditions/`; prefer that for `skin.conditions`, `eyes.condition`, `*nails.condition`. Per-attribute `kind: "condition"` exists in the type but is for *static* condition descriptors — pick per field, don't auto-port. |

### P3 — `mutability` and the live-state ban

aionchat adds a `runtime` mutability tier for live simulation (`penis.state:
flaccid|erect`, `vagina.lubrication: dry|lubricated`). **Vesper does not port
`runtime`** — Decision 2 routes live arousal state through the `arousal` meter +
conditions. So any aionchat attribute with `mutability: "runtime"` is **dropped**
(its information is meter/condition-driven), and the rest map
`inherent|mutable|temporary` 1:1.

### P4 — Collections stay out (for now)

aionchat's `skin.scarring` / `skin.tattoos` are `collection`-typed with
`AppliedScar` / `TattooDetail` item schemas (+ a scar-definition registry). Vesper
flattens these to single `skin.markings` tokens. The collection sub-system is a
**separate future additive change** (spec field table, "not ported"); this doc
captures the value vocabulary but does **not** port the collection machinery.

### P5 — Fantasy palettes

aionchat's skin/eye/hair palettes carry fantastical tones (green/blue/violet
skin, glowing/arcane eyes, pastel/vibrant hair). Vesper's palettes are realistic.
These are **gated to the species work** — port them when the first non-human cast
needs them (see
[non-human-races-and-features.deferred.md](non-human-races-and-features.deferred.md)),
not as part of this everyday-anatomy pass. Listed below for completeness, tagged
**[FANTASY — defer to species]**.

---

## Part 1 — Missing attribute categories (no Vesper group today)

Full field lists, `allowedValues` verbatim. `mut.` = mutability.

### buttocks  **[NEW GROUP → nest under Pelvis]**
| id | label | kind | mut. | allowedValues |
| --- | --- | --- | --- | --- |
| `buttocks.shape` | Buttocks shape | physical | mutable | `flat, rounded, full, muscular` |
| `buttocks.projection` | Buttocks projection | physical | mutable | `subtle, moderate, pronounced` |

### groin  **[NEW GROUP → nest under Pelvis]**
Pubic-hair coverage is the missing piece followups §2 flagged (shared by vulva-
and penis-havers). `groin` is universal (everyone has one), so a `groin.coverage`
here cleanly solves the "vulva OR penis" gating problem from followups §2.
| id | label | kind | mut. | allowedValues |
| --- | --- | --- | --- | --- |
| `groin.coverage` | Groin hair coverage | physical | mutable | `minimal, sparse, moderate, dense` |
| `groin.sensitivity` | Groin sensitivity | biological | inherent | `low, typical, high` (simulation, not routine narration) |

### abdomen  **[NEW GROUP]** (+ stomach folded in)
Vesper has **no** abdomen/stomach body location either — add the location
(`abdomen` under `torso`, between `chest`/`waist`) when porting.
| id | label | kind | mut. | allowedValues |
| --- | --- | --- | --- | --- |
| `abdomen.shape` | Abdomen shape | physical | mutable | `flat, soft, defined, rounded` |
| `abdomen.definition` | Abdomen definition | physical | mutable | `smooth, toned, muscular, thick` |
| `abdomen.contour` (aionchat `stomach.contour`) | Stomach contour | physical | mutable | `flat, soft, rounded, defined` |

### nose  **[NEW GROUP]** (a distinct face part; don't fold into `face`)
| id | label | kind | mut. | allowedValues |
| --- | --- | --- | --- | --- |
| `nose.shape` | Nose shape | physical | inherent | `straight, hooked, button, aquiline, snub, broad, narrow, upturned, roman, flat, crooked, bulbous` |
| `nose.size` | Nose size | physical | inherent | `small, average, large, prominent` |
| `nose.bridge` | Nose bridge | physical | inherent | `high, low, straight, curved, concave` |

### throat  **[NEW GROUP or FOLD → neck]**
Vesper already has `neck.throat_prominence` `[smooth, subtle, noticeable,
prominent]` (covers aionchat `throat.prominence`). Only `throat.length` is new.
| id | label | kind | mut. | allowedValues | status |
| --- | --- | --- | --- | --- | --- |
| `throat.prominence` | — | physical | mutable | `subtle, average, prominent` | **[COVERED]** by `neck.throat_prominence` |
| `throat.length` (→ `neck.throat_length`) | Throat length | physical | inherent | `short, average, long` | **[FOLD → neck]** |

### back  **[FOLD → existing `back` location, NEW GROUP `back`]**
Vesper has a `back` *body location* but no attributes.
| id | label | kind | mut. | allowedValues |
| --- | --- | --- | --- | --- |
| `back.width` | Back width | physical | inherent | `narrow, average, broad` |
| `back.definition` | Back definition | physical | mutable | `soft, average, toned, muscular` |

### ribs  **[NEW GROUP, optional]** (low-priority; fine descriptive detail)
| id | label | kind | mut. | allowedValues |
| --- | --- | --- | --- | --- |
| `ribs.visibility` | Rib visibility | physical | mutable | `subtle, average, visible` |
| `ribs.shape` | Ribcage shape | physical | inherent | `narrow, average, broad` |

### pelvis  **[FOLD → Pelvis area, optional]** (structural, low narration value)
| id | label | kind | mut. | allowedValues |
| --- | --- | --- | --- | --- |
| `pelvis.width` | Pelvis width | physical | inherent | `narrow, average, broad` |
| `pelvis.tilt` | Pelvis tilt | physical | mutable | `neutral, anterior, posterior` |

### mons_pubis  **[FOLD → vulva group]** (aionchat ties it to the vulva region)
| id | label | kind | mut. | allowedValues |
| --- | --- | --- | --- | --- |
| `vulva.mons_prominence` (aionchat `mons_pubis.prominence`) | Mons prominence | physical | inherent | `subtle, average, prominent` |

### vagina  **[NEW GROUP → gate on `vulva` region]**
Vesper has a `vagina` body location (realized by the `vulva` group) but **no
vagina attribute group**. `lubrication` is `runtime` → **dropped** (P3).
| id | label | kind | mut. | allowedValues | status |
| --- | --- | --- | --- | --- | --- |
| `vagina.length` | Vaginal canal length | physical | inherent | `short, average, long` | port (gate on `vulva`) |
| `vagina.elasticity` | Vaginal elasticity | biological | mutable | `low, typical, high` | port |
| `vagina.lubrication` | — | biological | runtime | `dry, typical, lubricated` | **DROP (P3 → arousal meter)** |

### facial_hair  **[NEW GROUP]** (Vesper has no facial-hair model at all)
Discriminated union: `style`/`length`/`grooming` are null when `presence=absent`.
| id | label | kind | mut. | allowedValues |
| --- | --- | --- | --- | --- |
| `facial_hair.presence` | Facial hair | physical | mutable | `absent, present` |
| `facial_hair.style` | Facial hair style | physical | mutable | `stubble, mustache, goatee, short_beard, full_beard, sideburns, mutton_chops, chin_strap, soul_patch` |
| `facial_hair.length` | Facial hair length | physical | mutable | `very_short, short, medium, long, very_long` |
| `facial_hair.grooming` | Facial hair grooming | physical | mutable | `neatly_trimmed, rough, unkempt, braided, waxed, decorated` |

### Face segments — cheeks · chin · forehead  **[FOLD → `face`]**
| id | label | kind | mut. | allowedValues |
| --- | --- | --- | --- | --- |
| `face.cheek_structure` (aionchat `cheeks.structure`) | Cheek structure | physical | inherent | `high, prominent, sunken, flat, rounded, angular` |
| `face.cheek_fullness` (aionchat `cheeks.fullness`) | Cheek fullness | physical | mutable | `hollow, lean, average, soft, full, chubby` |
| `face.chin_shape` (aionchat `chin.shape`) | Chin shape | physical | inherent | `pointed, round, square, cleft, receding, prominent, double` |
| `face.chin_prominence` (aionchat `chin.prominence`) | Chin prominence | physical | inherent | `receded, average, forward, strong` |
| `face.forehead_shape` (aionchat `forehead.shape`) | Forehead shape | physical | inherent | `flat, rounded, sloped, domed, angular, broad, narrow` |
| `face.forehead_height` (aionchat `forehead.height`) | Forehead height | physical | inherent | `short, average, tall, receding` |

### Arm segments — upper_arms · forearms · elbows · wrists  **[FOLD → `arms`]**
| id | label | kind | mut. | allowedValues | status |
| --- | --- | --- | --- | --- | --- |
| `arms.upper_build` (aionchat `upper_arms.build`) | Upper-arm build | physical | mutable | `slender, average, toned, muscular, heavy` | fold (or rely on `arms.build`) |
| `arms.forearm_build` (aionchat `forearms.build`) | Forearm build | physical | mutable | `slender, average, toned, muscular, heavy` | fold |
| `arms.length` | Arm length | physical | inherent | `short, average, long` | **new on `arms`** (Vesper lacks arm length) |
| `arms.elbow_prominence` (aionchat `elbows.prominence`) | Elbow prominence | physical | mutable | `subtle, average, prominent` | fold (optional) |
| `arms.wrist_size` (aionchat `wrists.size`) | Wrist size | physical | inherent | `slender, average, thick` | fold (Vesper has a `wrists` location, no attr) |

### Hand detail — fingers · fingernails  **[FOLD → `hands`]**
| id | label | kind | mut. | allowedValues | status |
| --- | --- | --- | --- | --- | --- |
| `hands.finger_length` (aionchat `fingers.length`) | Finger length | physical | inherent | `short, average, long` | fold |
| `hands.finger_shape` (aionchat `fingers.shape`) | Finger shape | physical | mutable | `slender, average, broad, knobby` | fold |
| `fingernails.length` / `fingernails.condition` | — | physical / condition | mutable / temporary | length `short, average, long`; condition `clean, dirty, bitten, painted, clawed` | **[COVERED]** by `hands.nails` `[bitten, short, neatly_trimmed, manicured, long, pointed, painted, chipped]` — port only if length-vs-condition split is wanted |

### Leg segments — thighs · calves · shins · knees · ankles  **[FOLD → `legs`]**
| id | label | kind | mut. | allowedValues | status |
| --- | --- | --- | --- | --- | --- |
| `legs.thigh_build` (aionchat `thighs.build`) | Thigh build | physical | mutable | `slim, average, full, muscular, thick` | fold |
| `legs.thigh_length` (aionchat `thighs.length`) | Thigh length | physical | inherent | `short, average, long` | fold (or rely on `legs.length`) |
| `legs.calf_shape` (aionchat `calves.shape`) | Calf shape | physical | mutable | `slim, average, defined, full, muscular` | fold |
| `legs.shin_contour` (aionchat `shins.contour`) | Shin contour | physical | mutable | `smooth, average, prominent` | fold (optional) |
| `legs.knee_prominence` (aionchat `knees.prominence`) | Knee prominence | physical | mutable | `subtle, average, defined, prominent` | fold (optional) |
| `legs.ankle_thickness` (aionchat `ankles.thickness`) | Ankle thickness | physical | inherent | `delicate, slender, average, thick` | fold (Vesper has an `ankles` location, no attr) |

### Foot detail — toes · toenails  **[FOLD → `feet`]**
| id | label | kind | mut. | allowedValues | status |
| --- | --- | --- | --- | --- | --- |
| `feet.toe_length` (aionchat `toes.length`) | Toe length | physical | inherent | `short, average, long` | fold (optional) |
| `feet.toe_shape` (aionchat `toes.shape`) | Toe shape | physical | inherent | `tapered, average, broad` | fold (optional) |
| `toenails.length` / `toenails.condition` | — | physical / condition | mutable / temporary | length `short, average, long`; condition `clean, dirty, trimmed, painted, clawed` | **[COVERED]** by `feet.nails` `[neglected, trimmed, neat, pedicured, painted, chipped]` |

---

## Part 2 — Partially-ported categories (Vesper has the group; values/attributes missing)

Only the **gaps** are listed (the attribute concept or value Vesper lacks).

### chest  — missing a definition/musculature attribute
| add | kind | mut. | allowedValues |
| --- | --- | --- | --- |
| `chest.definition` (aionchat `chest.definition`) | physical | mutable | `soft, average, defined, muscular` |

aionchat `chest.width` `[narrow, average, broad]` is breadth-only; Vesper's
`chest.size` conflates bust+breadth — **leave `chest.size` as is**, add only
`chest.definition`. (Vesper's `chest.hair` has no aionchat counterpart — keep.)

### waist  — missing a width axis
| add | kind | mut. | allowedValues |
| --- | --- | --- | --- |
| `waist.width` (aionchat `waist.width`) | physical | mutable | `narrow, average, broad, tapered` |

Vesper `waist.definition` covers aionchat `waist.definition`.

### hips  — missing a shape axis
| add | kind | mut. | allowedValues |
| --- | --- | --- | --- |
| `hips.shape` (aionchat `hips.shape`) | physical | mutable | `straight, rounded, curved, angular` |

### neck  — missing thickness as a distinct axis
Vesper folds length+thickness into one `neck.length` enum. aionchat splits:
| add | kind | mut. | allowedValues |
| --- | --- | --- | --- |
| `neck.thickness` (aionchat `neck.thickness`) | physical | mutable | `slender, average, thick, muscular, bulky` |
| (value gap) `neck.length` += `very_long` |  |  | append to existing enum |

### face  — missing symmetry + fullness
| add | kind | mut. | allowedValues |
| --- | --- | --- | --- |
| `face.symmetry` | physical | inherent | `balanced, slightly_asymmetrical, noticeably_asymmetrical` |
| `face.fullness` | physical | inherent | `gaunt, lean, average, soft, full, round` |

(value gap) `face.shape` += `pear` (Vesper's `oblong` ≈ aionchat `long`).

### eyes  — missing four attributes + value gaps
| add | kind | mut. | allowedValues | status |
| --- | --- | --- | --- | --- |
| `eyes.pupils_shape` | physical | inherent | `round, vertical_slit, horizontal_slit, cross, star, none_visible, multiple` | **[FANTASY — defer to species]** |
| `eyes.sclera_color` | physical | inherent | `white, off_white, yellowed, gray, black, red, blue, gold, none_visible` (`excludesBodyPlans: ["insectoid"]`) | **[FANTASY]** |
| `eyes.glow` | physical | inherent | `none, subtle, bright, pulsing, ember_like, moonlit, arcane` | **[FANTASY]** |
| `eyes.count` | physical | inherent | number, min 0 max 12 | **[FANTASY]** |
| `eyes.condition` | condition | temporary | `clear, clouded, scarred, blind, milky, bloodshot, watery, tired` | port via conditions (P2) |

(value gaps, realistic) `eyes.color` += `black`; `eyes.shape` += `slitted`
(slitted is fantasy-ish — defer).

### lips  — missing color
| add | kind | mut. | allowedValues |
| --- | --- | --- | --- |
| `lips.color` | physical | mutable | `pale_pink, rose, coral, red, berry, brown, natural, purple_tinted, bluish_tinted` |

### brows  — value reconciliation only
aionchat puts `bushy`/`sparse` under *shape*; Vesper puts them under *thickness*.
Optional value adds to `brows.thickness`: `very_thin, average, very_thick`. No new
attribute. **[COVERED — conceptually]**

### ears  — missing size as a distinct attribute
Vesper folds small/large into `ears.shape`. aionchat has a separate `ears.size`.
| add | kind | mut. | allowedValues |
| --- | --- | --- | --- |
| `ears.size` | physical | inherent | `small, average, large, oversized` |

(value gaps) `ears.shape` += `notched, drooping` (and `absent` — fantasy).
Port aionchat's `ears.*` promptHints (silhouette/jewelry/recognition; avoid
ancestry implication) — Vesper's ears group has none.

### shoulders  **[COVERED]** (Vesper `shoulders.width` ⊇ aionchat).
### hands  **[COVERED]** (Vesper `hands.size`+`hands.texture` ≈ aionchat `size`+`shape`; `delicate`/`broad` are texture-bucket gaps, optional).
### feet  **[COVERED]** for the foot proper (`feet.size`+`feet.arch`; Vesper adds `flat` arch).

### skin  — richer markings, fantasy colors, collections (mostly deferred)
| add | status |
| --- | --- |
| `skin.color` fantasy tones `green, blue, gray, red, ashen, violet` | **[FANTASY — defer to species]** |
| `skin.undertone` += `bluish, greenish` | **[FANTASY]** |
| `skin.markings` += `port_wine_stain, cafe_au_lait_spot, vitiligo_patch, hyperpigmentation_patch, hypopigmentation_patch, mottled_pigmentation, patchy_pigmentation, natural_spots, natural_stripes, natural_blotches, natural_speckles, symbolic_natural_pattern, iridescent_patch, scale_like_pigmentation, vein_like_markings, glowing_natural_marks, stretch_marks` | port the realistic ones; defer the fantasy (`iridescent`, `scale_like`, `glowing`) |
| `skin.scarring` (collection `AppliedScar`) | **DEFER (P4)** |
| `skin.tattoos` (collection `TattooDetail`) | **DEFER (P4)** |
| `skin.conditions` (temporary `healthy, sunburned, bruised, scratched, dirty, sweaty, pale_from_illness, flushed_from_exertion, rash, irritated, frostbitten, burned, bloodied`) | port via the **conditions registry**, not an attribute (P2) — several already exist as conditions |

### hair  — aionchat merges type/texture/style/bald into one `hair.type`
Vesper splits color/length/texture/style — **keep Vesper's split** (richer).
aionchat texture values Vesper's `hair.texture` `[straight, wavy, curly, coily]`
lacks: `kinky, frizzy, silky, coarse, fine, thick, thin` (Vesper expresses
volume/style separately). Optional value adds; **no structural change**. Fantasy
colors (pastel/vibrant) → **[FANTASY]**. **[COVERED — structurally]**.

---

## Part 3 — Intimate groups already ported (value/attribute gaps only)

These four shipped in T1; aionchat has finer detail worth back-filling.

### vulva  — Vesper has `labia` + `clitoris` (+ sensory scent/taste). aionchat is finer:
| add | kind | mut. | allowedValues |
| --- | --- | --- | --- |
| `vulva.size` | physical | inherent | `small, average, large` |
| `vulva.shape` | physical | inherent | `compact, average, prominent, asymmetrical` |
| `vulva.labia_majora_prominence` | physical | inherent | `subtle, average, prominent` |
| `vulva.labia_minora_visibility` | physical | inherent | `concealed, partially_visible, visible, prominent` |
| `vulva.vestibule_visibility` | physical | inherent | `concealed, partially_visible, visible` |

Vesper's single `vulva.labia` `[tucked, even, prominent, asymmetric]` overlaps
aionchat's separate majora/minora — **decide:** keep the one combined enum (tight)
or split into majora+minora (aionchat-faithful). Vesper's `clitoris` ≈ aionchat
`clitoris_prominence`. Vesper-only `vulva.scent`/`vulva.taste` (sensory) stay.

### penis  — Vesper has `size` + `girth` + `circumcised` (+ `scent`). Gaps:
| field | status |
| --- | --- |
| `penis.foreskin` `[present, absent, partial]` | aionchat's 3-state is richer than Vesper's boolean `circumcised` — **consider** swapping `circumcised: flag` → `penis.foreskin: enum` (captures `partial`) |
| `penis.state` `[flaccid, partially_erect, erect]` (runtime) | **DROP (P3 → arousal meter)** — intentionally absent |

Vesper-only `penis.girth` + `penis.scent` have no aionchat counterpart — keep.

### testicles  — missing position
| add | kind | mut. | allowedValues |
| --- | --- | --- | --- |
| `testicles.position` | physical | mutable | `high, average, low` |

### breasts  — value deltas only
aionchat `breasts.shape` values not in Vesper: `flat, rounded, full, pendulous`
(Vesper has `round, teardrop, soft, pert, wide_set`). Optional value reconcile.
Vesper-only `breasts.nipples` `[small, average, large, puffy, inverted]` — keep.
**[COVERED — structurally]**.

---

## Part 4 — Body-location gaps

aionchat's body tree has nodes Vesper lacks (Vesper folds, but a few describable
regions need a location so attributes can attach and coverage/exposure work):

| aionchat node | Vesper status | action |
| --- | --- | --- |
| `torso.abdomen`, `torso.stomach` | **missing** | add `abdomen` (child of `torso`, coverageRelevant) — needed for the new `abdomen` group |
| `torso.ribs` | missing | optional — only if `ribs` group is ported |
| `head.face.nose` | missing | add `nose` (child of `face`) for the new `nose` group |
| `head.face.cheeks`, `head.face.chin`, `head.face.forehead`, `head.face.jaw` | missing | optional — `face.*` folded attributes don't strictly need separate locations, but add if finer coverage (e.g. veils) ever needs them |
| `head.scalp` | missing | optional (Vesper uses `hair` for headwear coverage) |
| left/right pairs (eyes, ears, breasts, buttocks, hands, feet, …) | Vesper uses **single** nodes with `side?` available | **keep single nodes** — Vesper's coverage model doesn't need per-side splitting; `side` is there if a one-off (eyepatch) ever needs it |

aionchat's `BodyLocationDefinition` has **no** `coverageRelevant` or
`intimateGroup` — those are Vesper-only and must be set when adding nodes
(everyday → `coverageRelevant: true`; new pelvic intimates would carry their
`intimateGroup`).

---

## Part 5 — Suggested port batches (when this graduates to a phase)

Ordered by value to romance-core play, smallest-blast-radius first:

1. **Pelvic & torso describables** — `buttocks`, `groin` (solves followups §2
   pubic hair), `abdomen`(+stomach) [+ location], `vagina` group. Nest the pelvic
   ones under the **Pelvis** area shipped in followups §7.
2. **Face completeness** — `nose` group [+ location], fold cheeks/chin/forehead +
   `face.symmetry`/`face.fullness` into `face`, `facial_hair` group.
3. **Existing-group back-fill** — `chest.definition`, `waist.width`, `hips.shape`,
   `neck.thickness`, `ears.size`, `lips.color`, the finer `vulva.*` + `testicles.position`.
4. **Segment detail (optional)** — fold arm/leg segment attributes into `arms`/`legs`.
5. **Deferred** — collections (P4), fantasy palettes (P5 → species work), the
   `runtime`-tier live states (P3, permanently — arousal meter owns these).

Each batch is **additive registry edits, no DB migration** (the standing
contracts guarantee). Update `docs/contracts.md` starter-vocabulary list and run
the registry invariant tests (`vitest contracts`) per batch.
