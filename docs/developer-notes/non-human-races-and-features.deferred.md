# Non-human races & additive body features (wings · horns · tail) — design

Status: **draft / brainstorm, partially implemented 2026-06-15**. The first
succubus slice landed: `featureGroup`, `bodyFeatures`, feature locations
(`wings`/`horns`/`tail`), starter morphology attributes, the `succubus` species
record, `faerie`/`elf`/`dwarf`/`gnome`/`orc`/`goblin` registry records, editor
species/feature controls, contract tests, and contract/authoring docs. The
character forge now deterministically infers registry species from prompt text
with exact aliases plus conservative fuzzy fallback, seeds species-default body
features, and unlocks realized feature morphology attributes. Remaining work:
image prompting, richer species rules, and wardrobe accommodation.

Forward-looking design for the body-model work **deferred out of
[phase 4](phase-4-plan.md)** — that phase built the species *scaffolding* (the
gating engine, the `species/` registry, the allow/disallow + attribute-rule
seams) and shipped **`human` only**, explicitly leaving "novel body plans
(tails/wings/gills)" and real non-human species records to a later phase
([spec §Out of scope](intimate-anatomy-sensory-and-species-spec.phase4.md#section-c--non-human-species-idea-5-scaffolding-only)).
This is that later phase's design. Parked under [deferred.plan.md](deferred.plan.md)
§"Non-human races & additive body features" until it graduates into a numbered
phase. Plain-language first, with an _"under the hood"_ note per section.

---

## The big idea (one paragraph)

A faerie has wings; a succubus has wings, horns, and a tail. None of that is a
**new body plan** — they are still bipedal humanoids who happen to carry a few
extra parts. So the cheap, correct move is to treat wings/horns/tail as
**additive features on the existing humanoid plan**, gated by _exactly the same
mechanism phase 4 already shipped for intimate anatomy_: a body location tagged as
"not present by default," switched on by a short per-character list. Intimate
anatomy uses the tag `intimateGroup` + the list `intimateRegions` (defaulted from
**gender**). Features use a parallel tag `featureGroup` + a list `bodyFeatures`
(defaulted from **species**). Same engine, second list. That keeps the default
safe (a human never sprouts wings by accident), keeps the override (the phase-4
principle — the author can always toggle), and turns "succubus" into mostly a data
entry. The genuinely new cost is **image generation**, because — unlike intimate
anatomy — wings/horns/tail are _visible and non-explicit_, so they must surface in
the always-visible appearance prompt on **both** image routes, not behind the
exposure mask or the uncensored-only fence.

---

## First, a scoping line that matters: additive features ≠ novel body plans

The word "tail" hides two very different jobs:

- **Additive feature** — a succubus tail _plus_ normal legs, a faerie's wings
  _on top of_ an ordinary back. The humanoid silhouette is intact; we're bolting
  parts on. **This is what we're doing.** It's tractable now because the body
  tree, wardrobe, and image pipeline all still assume a humanoid.
- **Structural body plan** — a naga whose tail _replaces_ the legs, a mermaid, a
  centaur, a digitigrade satyr. These rewrite the location tree, break every
  wardrobe-coverage assumption (what does "pants" even mean on a naga?), and need
  image work from the first line. **Still deferred** — aionchat hasn't built these
  either (its `insectoid`/`avian`/`aquatic`/`quadruped`/`serpentine` body-plan ids
  are declared but unbuilt). Out of scope here.

Phase 4 lumped "tails/wings/gills" under "novel body plans (out of scope)." This
doc splits that bucket: **additive wings/horns/tail on the humanoid plan is the
tractable middle ground** and is what we design here; true non-humanoid plans stay
parked.

---

## What already exists (the substrate — most of this is built)

Phase 4 left us standing on almost everything we need:

- **The realize filter.** `species/realize.ts` `realizeBody({ bodyPlanId,
  speciesId, intimateRegions, bodyFeatures })` is the single gating engine: body
  plan (superset of locations) → species (allow/disallow + forbidden/default
  feature rules) → per-character body-config. It answers `isLocationPresent`,
  `hasIntimateRegion`, `hasFeature`, `isAttributeApplicable`, and is consumed by
  the attribute picker, forge attribute vocabulary, narrator impression block,
  and image prompt assembly. **We extend this one function, not the consumers.**
- **The default-absent tag pattern.** `BodyLocation.intimateGroup` + the
  per-character `intimateRegions` list is the exact shape features need —
  proven, tested, and understood. We mirror it.
- **`back` already exists.** `everyday.ts` has `{ id: "back", parentId: "torso" }`
  (it's a wardrobe-coverage slot today). Wings parent straight to it — _no new
  `back` element is required_ (the brief assumed one was missing; it isn't).
- **Species scaffolding is live.** `SpeciesDefinition` (id, label, aliases,
  bodyPlanId, allow/disallow location lists, `attributeRules`) + the
  `rules/attribute-rule.ts`
  primitive (`required | optional | forbidden` + default/allowed/disallowed) are
  built and consumed by realize. The first non-human data records now include
  `succubus`, `faerie`, `elf`, `dwarf`, `gnome`, `orc`, and `goblin`; additional
  humanoid species should stay data-only once their needed feature vocabulary
  exists.
- **aionchat reserves the vocabulary.** aionchat's attribute-category enum already
  lists `horns`, `tail`, `wings` (and `claws`, `scales`, `fur`, `feathers`) — but
  ships **no** body locations or attribute groups for them. They're reserved
  names, nothing more. So even the template only gives us the words; the wiring is
  ours to build. (Its `species/types.ts` comment literally cites "succubi sharing
  the same humanoid body plan while disabling locations" — the intended use is
  exactly ours.)

---

## The mechanism — mirror the intimate model, add a second list

### Per-character feature list, defaulted from species

Add one field to the profile, parallel to `intimateRegions`:

```ts
// CharacterProfile (rides the profile JSONB — no migration, like intimateRegions)
bodyFeatures: string[];   // present feature groups, e.g. ["wings","horns","tail"]
```

Where intimate regions default from **gender**, features default from
**species**. Declare the default on the species record itself:

```ts
// SpeciesDefinition gains:
defaultFeatureGroups?: readonly string[];   // succubus → ["wings","horns","tail"]
```

Forge seeds `bodyFeatures` from the chosen species' `defaultFeatureGroups`
(mirroring how it seeds `intimateRegions` from `identity.gender`). The stored list
is authoritative thereafter — **fully overridable** (a wingless succubus, a horned
human cultist) exactly like the intimate toggles. Species is a _default source_,
not a hard gate.

_Why a per-character list and not pure species gating:_ a whitelist on the species
(`allowedBodyLocationIds`) can only **narrow** the plan, never **add** to it, and
putting features in the base humanoid plan would force every mundane species to
remember to disallow every fantasy part (O(species × features), and `human` would
inherit wings unless it opts out — a dangerous default). The default-absent tag +
opt-in list inverts that: nothing has features unless switched on. Safe default,
clean override, one proven pattern.

### The body-location tag

```ts
// BodyLocation (types.ts) gains, parallel to intimateGroup:
featureGroup?: string;   // one of FEATURE_GROUPS; absent ⇒ baseline anatomy
```

### The realize change (small)

Today realize gates one tag:

```ts
const group = bodyLocationRegistry.byId(id)?.intimateGroup;
if (group && !intimateRegions.has(group)) continue;
```

Generalize to gate **both** tags against their respective lists (keep them
separate — intimate stays its own moderation-fenced concept; see Image
generation):

```ts
const loc = bodyLocationRegistry.byId(id);
if (loc?.intimateGroup && !intimateRegions.has(loc.intimateGroup)) continue;
if (loc?.featureGroup && !features.has(loc.featureGroup)) continue;
```

Add `hasFeature(group)` to `RealizedBody`, and feed `bodyFeatures` into
`RealizeBodyInput`. **That is the whole engine change.**

### Attribute gating falls out for free

realize already drops any attribute whose `bodyLocationId` isn't realized:

```ts
if (def.bodyLocationId && !locationIds.has(def.bodyLocationId)) return false;
```

So if every feature attribute binds its feature location (`horns.shape` →
`bodyLocationId: "horns"`), it is gated automatically once the location is gated —
**no per-category gate needed.** (Intimate anatomy needed an extra
`INTIMATE_ATTRIBUTE_CATEGORIES` check because not every intimate attribute binds
1:1; features map cleanly, so binding suffices.) A `FEATURE_ATTRIBUTE_CATEGORIES`
list is still worth adding as defense-in-depth + a registry-test target, but it's
belt-and-suspenders, not load-bearing.

---

## The three locations (and three premise corrections)

```
head
 └─ horns           ← NEW · featureGroup "horns" · sibling of hair/face/ears
torso
 └─ back            ← ALREADY EXISTS
     └─ wings        ← NEW · featureGroup "wings"
pelvis
 └─ tail            ← NEW · featureGroup "tail"
```

Against the brief's three guesses:

- **Wings → `back`.** Correct intent, but `back` already exists — no new element.
  Wings parent to it. (Optionally split `wing_left` / `wing_right` later using the
  existing `side` enum for image symmetry; single `wings` is enough for v1.)
- **Horns → dedicated location under `head`, _not_ "in hair."** Recommend a
  dedicated `horns` location (sibling of `hair`), because horns aren't hair: they
  want their own attributes (material, curvature) and their own coverage semantics
  (a hood over `hair` must not imply horns are covered). Matches aionchat's
  reserved `horns` category. Putting them under hair would entangle two unrelated
  things.
- **Tail → dedicated location under `pelvis`, _not_ "part of buttocks."**
  Recommend a dedicated `tail` parented to `pelvis` (not `buttocks`), because
  parenting under `buttocks` makes "cover buttocks → covers tail" via
  `registry.expand`, which is wrong (a tail comes _out_; pants don't swallow it).
  Even under `pelvis`, `expand` will notionally mark a pants-covered tail as
  "covered" — **harmless in v1** (nothing queries tail coverage; feature surfacing
  isn't exposure-gated), but it's the seam the deferred wardrobe nuance
  (tail-holes) lives in. Flagged, not solved.

All three are `coverageRelevant: false` for v1 (same call intimate anatomy made):
they aren't garment slots and don't show in the wardrobe editor. Garment
interaction is deferred (see Wardrobe).

_Under the hood:_ new rows in a `body/locations/features.ts` file (parallel to
`intimate.ts`), exporting `FEATURE_GROUPS = ["wings","horns","tail"] as const` and
folded into the registry by `locations/index.ts`. The humanoid plan's
`bodyLocationIds` (derived from `humanoidBodyLocations`) picks them up
automatically. No migration.

---

## Attributes (the new descriptive vocabulary)

Add `wings`, `horns`, `tail` to the closed `attributeCategories` enum (the same
three names aionchat reserves), with attribute groups in a new fenced subfolder
`attributes/groups/morphology/` (parallel to `intimate/` — fenced for tidy file
tree and easy bulk-gating, but **not** moderation-sensitive). Tight starter
vocabulary, clinical values + evocative `promptHints` (Decision 4 tone), each
bound to its feature location:

- `wings.type` (feathered · membranous · insectoid · gossamer), `wings.span`,
  `wings.color`, `wings.condition` (mutable: folded · spread · injured).
- `horns.shape` (curved · straight · spiraled · swept-back), `horns.length`,
  `horns.material` (keratin · bone · obsidian-like), `horns.color`.
- `tail.type` (spaded/demonic · feline · reptilian · prehensile), `tail.length`,
  `tail.color`, `tail.tuft`.

These are **physical/presentation kind, SFW** — so they go to _every_ image route,
unlike the `intimate/` set. (aionchat's `magical` / `prosthetic` attribute kinds
would let us mark, say, _conjured_ wings vs innate ones — nice later, not needed
for v1; see Coordination.)

---

## The first real non-human species records

This is where we deliberately cross phase 4's "human only" line — that's the
payoff the scaffolding was built for. The first slice ships two feature-bearing
humanoid species plus baseline records for common fantasy humanoids:

- **`faerie`** — `bodyPlanId: "humanoid"`, `defaultFeatureGroups: ["wings"]`
  (gossamer/insectoid by authoring convention). Richer trait rules like pointed
  ears or petite-frame leanings remain deferred; `species_presentation` free text
  carries the visual flavor (Decision 8 keeps structural id and flavor text
  separate).
- **`succubus`** — `bodyPlanId: "humanoid"`,
  `defaultFeatureGroups: ["wings","horns","tail"]` (bat-like wings, horns, spaded
  tail), optional rules nudging horn/tail/wing styling.
- **`elf` / `dwarf` / `gnome` / `orc` / `goblin`** — baseline humanoid species
  records for structural selection and forge inference. Specific traits remain
  authored through ordinary attributes until species rules are expanded.

**Honest scoping note.** Phase 4's success test was "adding a second _humanoid_
species should be a single data file, zero engine changes." That holds for an
**attribute-only** species like `elf` (pointed ears via `attributeRules` — buildable
today, zero engine change). It does **not** hold for a **feature-bearing** species
like `succubus`: it needs the `featureGroup` tag + `bodyFeatures` list + realize
generalization above. That engine work is small and one-time, and once it lands,
_every further_ feature-bearing species is again pure data. So the doc's real
deliverable is: build the feature mechanism once, then faerie/succubus (and any
horned/tailed/winged race) are data.

---

## Image generation — the real cost (as phase 4 warned)

Features differ from intimate anatomy in two ways that change the image story:

1. **Visible, not exposure-gated.** A succubus's horns show whether or not she's
   clothed. So feature description belongs in the **always-visible appearance
   block** (alongside hair/eyes/skin), _not_ behind the `ExposureMask` the way
   `intimateSceneAppearance` is.
2. **SFW, not Flux-excluded.** Wings/horns/tail are fantasy-safe — Flux won't
   reject them. So they go to **both** routes (Flux portrait _and_ Qwen
   scene/variant), unlike the intimate set that's withheld from Flux. (Flux may
   render them less convincingly; that's a model-quality limitation, not a safety
   gate — still include them.)

_Under the hood:_ a new pure helper `visibleFeatureAppearance(realizedBody,
attributes)` building a phrase like _"large membranous wings folded at her back,
short swept-back horns, a slender spaded tail."_ Injected into the base appearance
assembly used by `avatar.ts`, `scene.ts`, and `variants.ts` — on **all** routes,
gated only by `realizedBody.hasFeature(...)`, never by `allowIntimate` or the
exposure mask. One caveat to wire: a **waist-up** portrait
(`belowWaistRootIds`/`isBelowWaist`) omits below-waist content, so a `tail`
(parented under `pelvis` → below waist) is correctly dropped from a head-and-
shoulders shot while wings (`back` → torso) and horns (`head`) still show. That's
the right behavior and falls out of the existing belowWaist helper; just confirm
the feature phrase is assembled per-region, not as one blob.

---

## Wardrobe interaction — deferred, with the seam named

v1: features are `coverageRelevant: false`, nothing reads their coverage, a
succubus wears a normal dress and the narrator/image handle "wings out of a
backless gown" implicitly. Good enough to ship.

Deferred nuance (its own later pass): **garments that accommodate features** —
tail-holes in trousers, wing-slits in tops, horn-cutout hoods. This is the
"new wardrobe-coverage logic" phase 4 flagged. The seam is the `expand`/coverage
question raised under the `tail` location above; solving it means either excluding
`featureGroup` locations from coverage `expand`, or modeling per-garment
"accommodates feature X" flags. Not now.

---

## UI & forge

- **A species/race picker — a genuinely new seam.** Today `speciesId`/`bodyPlanId`
  are read from the profile (always `human`/`humanoid`) and _there is no UI to
  change them_ (`character-editor.tsx` passes them through; `attribute-picker.tsx`
  only toggles `intimateRegions`). Features make species meaningful, so the editor
  needs a species select that, on change, seeds `bodyFeatures` from
  `defaultFeatureGroups` (and may re-seed intimate defaults). Small, but new.
- **A "Body features" toggle section** in the attribute picker, parallel to the
  existing `BodyConfigSection` — toggles wings/horns/tail, unlocking the
  `morphology/` attribute groups exactly as intimate toggles unlock `intimate/`.
- **Forge.** The character forge infers registry species from prompt names and
  aliases ("a succubus bartender", "one of the succubi", "an elven ranger") with
  exact matching first and conservative fuzzy token matching for longer terms
  ("sucubus", "gobln"). It sets `speciesId`, seeds `bodyFeatures`, and gives the
  attribute agent only the feature attributes realized by that
  species/body-config. This remains registry-based, not open-ended LLM
  classification; broader fantasy taxonomy can add aliases/species records as
  data.

---

## Coordination with the aionchat field-port

A separate effort is porting aionchat's many missing contract fields. This feature
**depends on / benefits from** a specific subset — flag the overlap so the two
don't collide or duplicate:

- **Needed:** the attribute categories `wings`, `horns`, `tail`. If the field-port
  adds them to the category enum, this work consumes them; if not, this work adds
  them. Coordinate so they're added once.
- **Useful but optional:** `magical` / `prosthetic` attribute **kinds** (innate vs
  conjured vs strapped-on wings); `requiresAttributes` / `conflictsWithAttributes`
  (an alternative way to express "horns require a horned species" — we instead use
  the feature list, but the port may bring these and they could express edge
  rules); the extra **body-plan ids** (`avian` etc. — irrelevant to additive
  features, relevant to the still-deferred _structural_ plans).
- **Not needed here:** `claws` / `scales` / `fur` / `feathers` categories, the
  `runtime` mutability tier, `itemSchema` / `collection`. Reserve if the port adds
  them; don't build on them.

---

## Field mapping (aionchat → Vesper) for the novel-anatomy bits

| aionchat | Vesper home | Note |
| --- | --- | --- |
| category `horns` / `tail` / `wings` | same — add to `attributeCategories` | matches reserved names |
| (no aionchat body locations for these) | new `body/locations/features.ts` rows | template never built them |
| species `disallowedBodyLocationIds` "succubi… disabling locations" | inverted: default-absent `featureGroup` + opt-in `bodyFeatures` | safe default; species _adds_, doesn't _disable_ |
| species `attributeRules` (elf pointed ears) | same — already built | feature-free species are zero-engine today |
| `magical` / `prosthetic` kinds | not v1 (reserve) | innate vs conjured features, later |
| `claws`/`scales`/`fur`/`feathers` | not v1 (reserve) | next exotic tier |
| body-plan ids `avian`/`serpentine`/… | not here | structural plans, separate deferred phase |

---

## Rough build order / status

Dependency-forced, mirroring phase 4's shape:

1. **F0 — feature mechanism (landed 2026-06-15).** `featureGroup` tag +
   `FEATURE_GROUPS`; `bodyFeatures` on the profile (parseOr, default `[]`);
   `defaultFeatureGroups` on `SpeciesDefinition`; realize generalization +
   `hasFeature`. Degradation tests: empty `bodyFeatures` = today's body; unknown
   group ignored; unknown species → human.
2. **F1 — the three locations + `morphology/` attribute groups (landed
   2026-06-15).** wings→back, horns→head, tail→pelvis, all
   `coverageRelevant: false`; the descriptive attributes bound to each.
3. **F2 — first species records (partially landed 2026-06-15).** `succubus` and
   `faerie` ship with `defaultFeatureGroups`; `elf`, `dwarf`, `gnome`, `orc`,
   and `goblin` ship as baseline humanoid species. Richer attribute nudges remain
   deferred.
4. **F3 — image generation (deferred; the real cost).** `visibleFeatureAppearance`, injected
   into the base appearance prompt on **all** routes; the waist-up/tail belowWaist
   check.
5. **F4 — forge + editor (landed for first humanoid species 2026-06-15).**
   Species picker, "Body features" toggles, deterministic character-forge species
   inference with aliases/fuzzy fallback, species-default feature seeding, and
   species-aware feature attribute vocabulary ship. Open-ended species
   classification remains deferred.
6. **F5 — tests + docs (partially landed 2026-06-15).** `docs/contracts.md`,
   `docs/authoring.md`, and registry invariants ship; `docs/images.md` belongs
   with F3 when visible feature prompting lands.

Deferred beyond this: wardrobe accommodation (tail-holes/wing-slits), the exotic
tier (claws/scales/fur), and **true structural body plans** (mermaid/naga/
quadruped/digitigrade) — those keep their own future phase, "with image gen in the
room from day one."

---

## Open questions

- **Field name.** `bodyFeatures` vs `morphology` vs `features` for the
  per-character list. `bodyFeatures` reads clearest parallel to `intimateRegions`;
  noting alternatives.
- **Required vs default features.** Should `succubus` _require_ horns (can't be
  toggled off) or merely default them? Leaning **default-only** for consistency
  with the "always overridable" principle — but a species may want a few
  non-negotiable markers (a hornless succubus may break flavor). Could express
  hard requirements via an `attributeRule`/feature-required flag if play wants it.
- **Left/right wing & horn splitting.** Single `wings`/`horns` locations for v1,
  or split with the existing `side` enum from the start for image symmetry? Lean
  single now, split when image quality asks for it.
- **Tail under `pelvis` and `expand`.** Accept the harmless-in-v1 "covered tail"
  notion (recommended), or exclude `featureGroup` locations from coverage `expand`
  immediately to keep the model honest before wardrobe work?
- **Does this become its own numbered phase, or fold into a "non-human v1" phase**
  alongside the exotic tier? Likely its own, given image cost.
