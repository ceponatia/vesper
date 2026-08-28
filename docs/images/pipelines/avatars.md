# Avatar generation

The canonical portrait, text → image. The prompt is assembled from the **visual image
digest** as semantic prompt segments (`buildAvatarSegments`, `server/images/avatar-segments.ts`):

- one standalone visual-state snapshot of the character sheet (scope `standalone_character` —
  resolved attributes plus the realized body, projecting species feature groups and cataloged
  distinctive marks);
- a **read token** minted from the character row's `updatedAt` plus every wardrobe row read
  for the render (`standaloneCharacterReadToken` — an edit to either mints a different token;
  it stands in for a committed cut as the snapshot's cut id and the provenance's
  committed-cut name);
- **one coverage-aware selection pass** bound to the fixed `portrait_studio` camera (facing
  the viewer at medium distance — the `waist_up` framing band); and
- a digest realized from that exact selection, never a re-select.

`buildVisualSubjectSegments` (`contracts/images/visual-segments.ts`) turns the subject's
digest slice into ordered segments under the avatar policy — **age stated, waist-up frame,
intimate never** — phrased by the lane-neutral clause table
(`server/images/visual-fact-clauses.ts`, shared with the chat scene lane).

Everything the visual-state projection does not yet carry stays **route-owned**, emitted as
segments beside the builder's output with the established avatar wording: the subject line,
the apparent-age anchor, the residual attribute sheet, the authoritative wardrobe line, and
the framing/style/quality sentences. As the projection grows owners for more of the sheet,
facts move from the residual segment into the digest.

The ordered segments ride `intent.promptSegments` — authoritative in the render kernel — and
their compiled join is the stored row `prompt` (every seeded model's prompt budget resolves
empty, so the kernel's own compile is that same string). An **ineligible digest fails the row
before provider spend** with `images.avatar.visual_digest_ineligible`: the assembly failed, or
a required digest fact resolved no clause. Production never falls back to the legacy prose
builder (`buildAvatarPrompt` still exists but is production-uncalled). The digest's
`meta.visualState` provenance merges into the row's meta at reserve time, beside
`style`/`model`, so it survives a failed render.

## What the digest owns, and what the route owns

The digest carries the species feature-group **morphology** — the anchors an image model
"corrects" away, the "human wearing fake wings" failure — and the cataloged recognition
marks. Identity attributes (hair, eyes, skin, gender, heritage) are still phrased from the
attribute sheet as route-owned segments.

A cataloged distinctive mark (a crooked nose, prominent freckling) is stated **exactly once**:
the shared catalog-derived residue set (`RECOGNITION_RESIDUE_ATTRIBUTE_IDS`,
`visual-fact-clauses.ts`) makes the digest clause omit it, so the residual sheet keeps the
only statement — an omission recorded as lane policy in the suppressions, never as
degradation.

Identity (gender, plus **ethnicity** from `identity.heritage` appended after a comma) folds
into the **subject line** as one phrase (`Subject: <name> — a female succubus, Latina`);
apparent age is its own segment.

The residual sheet keeps the grouped **label-free caption clauses**
(`orderedAppearanceClauses` — skin, build, hair, eyes, face, style buckets). SDXL-family
models front-load attention and parse grouped caption/tag phrasing far better than a flat
`Label: value` metadata wall, and dropping the per-field label nouns (`Eye color: violet; Eye
shape: almond` → `Eyes: violet, almond`) keeps the tags coherent — minus the feature-group
categories, whose facts arrive through the digest's morphology segments (stating them in the
sheet too would read as emphasis and spend the budget twice).

## Apparent age

Apparent age is stated on the two portrait lanes. The avatar carries it as its own mandatory
`age` segment, and portrait variants carry it as one too, ordered **directly after the
identity lock** (the digest's morphology anchors, when the character has any, sit between
them) — `apparentAgeAnchor`, a name-bound sentence ("Kristin is in her late twenties; her
skin, hands and legs read smooth and youthful", the youthful-skin tail gated on young bands
with authored `skin.texture: smooth`).

Placement matters on the edit route: adjacent to the lock's "preserve apparent age" clause it
reads as qualifying it (A/B'd at ~15–20 apparent years,
`scripts/eval/scene-images/phantom-limb-ab.ts`); parked later in the prompt it measurably
diluted.

The anchor is deliberately **text-authoritative**. Qwen edits re-synthesize skin with a
texture-amplifying prior, and "preserve apparent age" preserves the model's own
**over-estimate** of an age-ambiguous reference (sunglasses hide the eyes; tan + toned reads
older), compounding a step older per edit generation with nothing ever pulling it back —
unlike the identity anchors, where the reference wins.

The **image age floor** and the narrative/visual age split are owned by
[../../contracts/attributes.md](../../contracts/attributes.md) §Starter vocabulary. Their
consequence here: `imageAgeWord` emits explicit adult wording from the `eighteen` band up and
no age text at all below it, every scene lane stays silent about age (a scene render inherits
visible age from its identity reference), and `age-context-separation.test.ts` tripwires
production scene assembly against both age fields.

## Species, style, and what never reaches an image prompt

For **non-human** characters the species **label** is the subject line's noun, via
`speciesLabelPhrase`. The authored generic `appearance` description is deliberately
**omitted** — the feature attributes already carry the morphology, and that text goes to the
character forge instead — and `human` adds nothing. Ethnicity stays a comma-appended
descriptor, distinct from the species noun, so "Latina succubus" reads right.

Style (`realistic`/`stylized`) picks the framing and quality sentences. The **bio is omitted**
(no visual signal). Non-visual attributes (`kind: "sensory"` — voice, scent/taste) never reach
an image prompt.

The image prompt also **omits the registry `promptHints`**: those are narrator/inference
guidance ("state apparent age as an impression…"), and an image model reads a hint's concrete
example ("late thirties") as literal subject detail, anchoring every face to it. `promptHints`
feed the narrator only (`engine/scene.ts`).

## Garments and the wardrobe segment

Each outfit garment is phrased by its **description + sensory appearance, untruncated** — the
name is only a fallback when a garment has no description — and an accessory's **subtype label
leads the phrase** (`nose ring: thin gold hoop`, `formatGarment`; skipped when the text
already names the type). Jewelry names alone gave the model nothing to place the piece
([../../contracts/items/README.md](../../contracts/items/README.md) §Clothing subtypes); the same phrasing
feeds scene wardrobe lines and the narrator's Visible-wardrobe block.

The wardrobe segment is marked authoritative ("depict exactly this clothing") — without it the
image model invents clothing that contradicts the saved wardrobe. An outfit lookup failure
degrades to the attributes-only prompt with a warn diagnostic,
`images.avatar.outfit_load_failed`.

**A failed or unreadable wardrobe is unknown state, never a bare body**
([../../resilience.md](../../resilience.md)). A thrown load (`wardrobeUnavailable`) or a
loaded row whose `coverage` column would not parse (`coverageUnreliable`, warn
`images.avatar.coverage_unreadable`) degrades BOTH halves of the read from one flag: the
exposure readout falls to fully covered (the prompt stays silent about exposure,
coverage-gated reveals stay shut), and the camera's perception reads a fully-covering stand-in
wardrobe so optional facts at covered locations (a chest tattoo under the saved outfit) go
unstated rather than asserted onto a body nobody could see. Identity and morphology stay
resolvable because the mandatory selection lane never consults perception. A genuinely empty
wardrobe — a successful load with zero rows — still states its bare regions.

The outfit is **occlusion-filtered** first (`visibleAvatarOutfit`, the shared
`resolveWardrobeVisibility` rule owned by
[../../contracts/items/visibility.md](../../contracts/items/visibility.md)): layers fully hidden under
opaque outer layers are omitted — mentioning the t-shirt under a closed abaya makes the model
paint the abaya open — sheer-covered items become a vague hint, and coverage-less items
(jewelry) stay.

## The waist-up cut

A garment whose coverage is entirely below the waist (pants, skirts, shoes —
`belowWaistLocationIds` = `pelvis` + `legs`) is dropped: handing the model trousers or
footwear tempts a full-body shot against the "waist-up portrait" instruction. A garment that
also covers the torso (dress, coat, abaya) stays. Scene images never apply this filter, so
they keep full-body garments.

The same cut applies to appearance attributes, not just garments. The residual sheet and the
digest's frame policy both drop every attribute whose `bodyLocationId` is below the waistline
(`isBelowWaist` — feet, legs, hips, and all pelvic intimate anatomy), with **signature feature
morphology exempt** (a `tail` roots at the pelvis but sweeps up into frame —
`isFeatureAttributeCategory`).

To own the garment gate and the attribute gate from one coverage source, the lane takes the
**raw wardrobe** (`loadDefaultWardrobeWithRevisions`, coverage included — the same load whose
row revisions feed the read token) and derives the visible outfit *and* the canonical region
exposure itself, rather than receiving a pre-filtered outfit. Exposure is computed once over
the **full** wardrobe, before the waist-up garment cut (a covering garment still hides its
region even when it is dropped from the visible outfit), and is stated as the builder's
`exposure` segment.

## Low-value curation

Beyond the waist-up cut, `AVATAR_OMIT_ATTRIBUTE_IDS` (`avatar-segments.ts`) drops fields that
read poorly in a head-and-shoulders still and only dilute a limited-adherence SDXL model:

- `movement.*` — motion, invisible in a still;
- `build.height` — no reference to scale against;
- `skin.undertone`, `skin.texture`, `shoulders.slope`, `neck.*`, `brows.*` — sub-perceptible;
- `hands.*`, `arms.hair` — out of frame or tiny;
- `lips.shape`, `horns.texture`; and
- all `teeth.*` — "sharp canines" makes the model render a ridiculous mouth.

`ears.piercings` is deliberately kept, alongside the `nose.*` and `lips.piercings` attributes:
piercings are first-class visual detail. The list routes through the shared clause resolver as
a deliberate `{ omit }`, so a cut fact reads as lane policy in the suppressions, never as
degradation. It is **avatar-only** — scene images are full-body and keep the full set, every
present member through the digest plus the route's own residual sheet. A registry `imageValue`
tag is the better home if the list grows.

## Model switch

The portrait studio offers **two** pickers, both reading the registry
([../providers/README.md](../providers/README.md)) rather than a code-side key union: the
canonical-avatar picker lists models with `canGenerate` and the New Variant picker lists models
with `canEdit`, so an edit-only model such as `qwen/qwen-image-edit-2511` can never be asked to
invent a portrait from nothing. Defaults are `qwen/qwen-image-2512` for a new portrait and
`qwen/qwen-image-edit-2511` for variants and scenes (owner ruling 2026-08-05).

Both pickers send a model **id**. An id that no longer exists — a deleted row, or a legacy
pre-registry key — degrades to that task's default profile at render rather than failing
(`resolveImageProfileForTask`). `images.meta.model` records the winning `replicate/<slug>`.
"Uncensored" is the safety checker disabled, the codebase default, and is only ever sent to
models whose schema declares that input; a missing `REPLICATE_API_TOKEN` fails the row with
that message. Aspect is 3:4 for every portrait — negotiated per model, cropped when the model
has no exact 3:4 ([../providers/README.md](../providers/README.md)). Every image lane is
Replicate; OpenRouter stays for text only.

## Intimate-anatomy gating

The portrait studio is **intimate-free by rule**: the avatar segment policy is
`intimate: "never"` and the residual sheet drops every intimate-category attribute
unconditionally (the assembly takes no `allowIntimate` parameter), whatever the default outfit
exposes. The waist-up cut already removed everything pelvic; this closes the remaining seam
where a bare-chested default outfit put `breasts.*` detail into the avatar prompt.

Intimate anatomy is **scene-render-only** ([scene-subjects.md](scene-subjects.md)).
Non-intimate **`chest.hair`** stays exposure-gated in the avatar — stated only when the torso
reads bare or sheer, never under clothing. `characterAppearanceSummary` keeps
`allowIntimate: false` for the moderation-prone scene composer; any new intimate-image rule
belongs in `intimateAttrRendersExposed`, exercised by the `sceneRevealAppearance` tests.

## The job and the studio

The avatar runs as an `avatar` job. The pending image row is reserved **inside** the job (after
the queue route's 202), so `GET /api/characters/:id/portraits` returns the rows plus a
**`rendering`** flag — a live `avatar`/`portrait_variant` job for the character, via the
staleness-bounded jobs check (`hasLiveCharacterJob`). The studio polls while either a pending
row or the flag says work is in flight, showing a painting tile through the stretch before the
pending row exists, the same shape as the conversation page's scene polling.

Failed non-canonical avatar attempts stay in the Portrait history grid with
`images.meta.error` visible. The studio also shows the **canonical avatar's prompt** in a
read-only box between the generation controls and the variant form, sourced from
`images.prompt` and updated when a variant is promoted — null when there is no avatar or it is
an uploaded image (`meta.source: "upload"`, which carries no generation prompt).
