[← Contracts index](README.md)

# Items and wardrobe

Items cover clothing, objects, and containers. An `ItemDefinition` is the reusable template; placed copies (worn, held, on the floor, in a box) are *instances*.

```ts
type ItemDefinition = {
  kind: "clothing" | "object" | "container";
  name: string; description: string;
  coverage?: BodyLocationId[];                 // clothing
  category?: string;                           // clothing — editor template id (never in prompts)
  subtype?: string;                            // object — object subtype id (vocabulary)
  wearer?: string;                             // clothing — wearer-target id (feminine/masculine/unisex)
  color?: { family: string; shade?: string; accent?: string };  // color-family id + free-text shade
  layer?: 0 | 1 | 2 | 3;                        // 0 underwear … 3 outerwear
  opacity?: "opaque" | "sheer";
  sensory?: { appearance?: string; scent?: string; tactile?: string };
  attentionHint?: "absorbing" | "faces_away" | "outward";
  fields?: Record<string, unknown>;            // kind-specific extras
  tags: string[];
};
```

| Field | Meaning |
| --- | --- |
| `kind` | `clothing`, `object`, or `container`. Embedded in item rows / instance snapshots, not self-identified. |
| `name` / `description` | Display text. |
| `coverage` | Body-location ids the garment covers (clothing only). |
| `category` | Clothing only: the coverage-template id this item started from. **Editor display only** — never serialized into gameplay prompts (see [Clothing categories](#clothing-categories)). |
| `subtype` | Objects: the object-subtype id (see [Object subtypes](#object-subtypes)). Clothing: the accessory-type id for subtyped categories (see [Clothing subtypes](#clothing-subtypes)) — **prompt-bearing**, unlike `category`. |
| `wearer` | Clothing only: wearer-target id — `feminine`/`masculine`/`unisex` (see [Wearer](#wearer)). Absent = unspecified, matched as unisex. |
| `color` | Primary color: `family`/`accent` are color-family ids, `shade` is free text (see [Color](#color)). Any kind may carry one; clothing is the primary surface. |
| `layer` | `0` underwear → `3` outerwear. |
| `opacity` | `opaque` or `sheer`. |
| `sensory` | Optional `appearance` / `scent` / `tactile` notes. |
| `attentionHint` | `absorbing` / `faces_away` / `outward` — reserved perception hint (consumed by the retired session attention model). |
| `fields` | Kind-specific extras (capacity, wearable container, …). |
| `tags` | Free-form labels. |

## Visibility

An instance's placement is **exactly one of**: worn by a participant · held by a participant · in a location · in a container instance.

The **visibility rule** (which replaces the old occlusion stack depths) is per body location:

| State | When |
| --- | --- |
| visible | The highest-layer item covering that location. |
| hidden | Any item beneath a covering one. |
| hinted | A hidden item where *everything* above it is sheer. |

Implemented once in `items/visibility.ts` (`resolveWardrobeVisibility` for the occlusion rule;
`exposedRegions` → `RegionExposure` for per-region bare/sheer/covered, plus the shared
`FULLY_COVERED` constant and `intimateRegionsBare` predicate), and used by the chat prompt builders,
the chat state extraction, image prompts, and the UI. The **character-chat lane** feeds it via
`resolveChatWardrobe` (`server/engine/chat-wardrobe.ts`, chat-wardrobe-parity 2026-07-14): the
chat's worn item ids run through `exposedRegions` for coverage-computed exposure and
`wardrobeOutfitText` for the rendered garment phrase ([../character-chat/state.md](../character-chat/state.md)
§Wardrobe). The pure garment-phrase matcher + worn-list reducer the chat archivist's add/remove
proposals fold through live in `items/chat-wardrobe.ts` (`matchGarment` / `applyWornGarmentChanges`).
`matchGarment` is **identity-aware**: a phrase naming a garment in the noun registry
(`items/garment-nouns.ts`) only matches candidates of the same canonical identity — both sides fold
through `garmentIdentitiesIn`, so plurals, aliases and spaced compounds ("boot"/"boots",
"t-shirt"/"tee", "tank top") resolve, and shared material or color can never take off the wrong
garment type; raw name/description token overlap then ranks the same-type candidates, and remains
the whole match for garments outside the registry.

### Coverage from garment nouns

Free text is wardrobe too. `items/garment-noun-coverage.ts` maps each canonical
garment identity (`garment-nouns.ts`) to the coverage it contributes, so the chat
lane's free-text overlay — the character sheet's "Also / instead" field — stops
reading as nothing: `overlayWornInputs(text)` returns synthetic `WornItemInput`
rows (`overlay:<identity>`) that `resolveChatWardrobe` folds into
`exposedRegions`. Without it, a character in a thong plus an overlay reading "pale
lavender gown" computed `torso: "bare"` and the scene prompt drew chest anatomy
through the described gown.

- **Coverage ids come from the category templates** wherever one fits, so the
  lists live in one place; the handful that has no template (bikini, corset,
  hosiery, armor) is spelled out beside them. Bikini **separates** are compound
  identities in the noun registry (`bikini top` → `bikini_top`, `bikini bottoms`
  → `bikini_bottom`), so each claims only its own panel — the bare noun is still
  the pair.
- **Precision beats recall, harder than in the noun registry.** An unmapped noun
  contributes nothing — today's behavior, and safe. A wrong one suppresses or
  bares anatomy nobody asked for. So ambiguous-coverage garments (scarf, shawl,
  cape, poncho, cloak, garter, costume) are deliberately absent: a cloak may hang
  open over a bare chest.
- **Sheer is stated, never assumed.** A modifier from `sheerModifiers` (sheer,
  gauzy, mesh, lace, fishnet, …) in the segment a garment owns before it (see
  attachment, below) makes THIS garment sheer, and is spent there. Hyphenated
  compounds stay one token, so "a lace-trimmed cotton robe" is opaque — the trim
  is not the fabric.
- **Every qualifier attaches to ONE noun.** The tokens between two garment nouns
  are the first one's post-modifier ground and the second one's pre-modifier
  ground at the same time, so the span is apportioned at a hinge. Before it
  attaches BACKWARD, after it FORWARD, the hinge itself belongs to neither, and a
  hinge-less shared span goes wholly forward (English stacks bare adjectives ahead
  of the noun). Three hinge registries, in the order the scan tries them:
  `windowSplitters` — the layering prepositions (over, under, underneath, beneath,
  atop, above, below) plus the clause transitions (while, whilst, as) — hinge on
  first hit. A clause transition earns the unconditional treatment for the same
  reason a preposition does: it never premodifies the noun after it, so everything
  before it is finished business — without it, "a shirt hanging open while wearing
  jeans" attached whole and forward, displacing the JEANS while the open shirt kept
  covering. "as" is in for its transition reading ("a shirt hanging open as she
  wears jeans"), which is the one that costs a garment when missed; a LONE
  comparative "as" agrees, since nothing fenceable precedes one ("a robe soft as
  silk over a chemise" keeps both garments). The correlative `as … as` **span** is
  the exception, and `readComparatives` takes it out of the registry's hands —
  neither "as" hinges (see the compared-garment bullet below). **"as well as" is
  additive, not comparative** (`additiveAsInners`, keyed on the joined inner
  tokens): it is no span at all, so its first "as" hinges as ever and "a bra as
  well as a thong" dresses both. **Coordinators are conditional**
  (`coordinatorSplitters` — and, or, nor): one does NOT hinge when a
  `displacementMarkers` word stands between it and the next hinge candidate,
  because displacement markers are participial POSTmodifiers, so "shirt unbuttoned
  and hanging open with jeans" coordinates two descriptions of the SHIRT — hinging
  at that "and" opened the jeans and left the open shirt covering. `sheerModifiers`
  premodify the noun after them and so never defer the hinge ("a shirt unbuttoned
  and sheer stockings" still fences). **"with" is conditional too**
  (`conditionalSplitters`): it hinges only when a marker (`displacementMarkers` /
  `negationMarkers` / `sheerModifiers`) already stands before it in the span,
  because unmarked it introduces the PREVIOUS garment's postmodifier ("a shirt with
  buttons open and jeans" — the shirt is open, the jeans are on) or plain
  accompaniment ("a jacket with a tee"), and splitting there inverted both; marked,
  it is a layering hinge like the prepositions ("shirt unbuttoned with jeans"). A
  clause-final span is all post-modifier ("her shirt hanging open") — hinge or no
  hinge, since the displacement scan wants the whole tail and no negation reads it.
  A clause-INITIAL span is pre-modifier ground too, but it splits at the same hinge
  and keeps only the remainder: hinge-less it is all the noun's ("unbuttoned
  jacket"), while the tokens before a hinge qualify a garment the text never named,
  so nobody owns them ("wearing nothing under her dress" hands the dress just
  "her", and the dress keeps covering). Reading a shared span whole is what
  "a shirt under an open jacket" broke: `open` displaced the shirt as well as the
  jacket and a covered torso read BARE. No hinge but the coordinators may join
  `negationCarryWords` — the carry check reads its window UNSPLIT, which is exactly
  why "no shirt under her jacket" and "no shirt with jeans" leave the later garment
  covering, while "or" hinges AND carries so that "without a shirt or bra" is one
  denial.
- **Named is not worn.** A noun contributes NO row when the segment before it
  holds a `negationMarkers` word (no, without, sans, minus, lacking, missing) or a
  `negatedWearingLeads` word immediately followed by "wearing" (not, never, isn't,
  wasn't, stopped, quit …), or when either segment it owns holds a
  `displacementMarkers` word (open, unbuttoned, pooled, shoved, hanging, slipped,
  off, aside, …): "without a shirt", "jeans and not wearing a shirt", "her shirt
  hanging open", "gown pooled at her waist" all name clothing that is not covering
  anything. The "wearing" bigram is the whole rule — a standalone "not" is a hedge
  ("not the shirt she meant to wear") and never denies. An **exception word**
  (`negationExceptions` — but, except, save, besides, excluding, barring, than)
  ENDS a denial: the segment denies only when its last negation stands after its
  last exception, so "not wearing anything but a thong" wears the thong (pelvis
  covered, torso bare) while "but not wearing a shirt" still denies. Exceptions are
  deliberately NOT `negationCarryWords` — "without a shirt but jeans" has to keep
  the jeans. With **no negation anywhere to except from**, an exception flips the
  other way and becomes the denial itself ("jeans, excluding a bra", "everything
  except a bra" — which used to emit an opaque chest row over a bared one), and it
  carries like any other ("excluding a bra or panties" denies both). **"Anywhere"
  reaches back a noun**: a garment denied one step earlier is still something to
  except from, so "not wearing underwear except a bra" cancels that denial and
  wears the bra (a kept noun then ends the scope, which is how "…except a bra and
  panties" keeps both) — only a span with nothing denied in scope reads the
  exclusion as a denial, which the clause reset restores ("no shirt, jeans
  excluding a bra" leaves the bra off). **A clause OPENING with an exception word
  inherits instead of resetting**: "not wearing underwear, except a bra" is the
  same sentence with punctuation in it, and the reset made that lone "except" a
  standalone exclusion that stripped the one garment the prose puts on. The seed is
  the previous clause's closing verdict, and it reaches no further than that first
  segment's exclusion — the exception word that armed it sits in that same window
  and is not filler, so the conjunction carry can never pick it up. Only the
  `exclusionMarkers` subset (except, excluding, barring) flips: a standalone "but"
  is an ordinary coordinator, and "save"/"besides" read as verb and additive as
  readily as exceptive. That leaves "everything **but** a bra" out of reach on
  purpose — the coordinator reading is too common to promote on context this thin.
  `bareStateWords` (nothing, none) are what keep the flip honest: they state a bare
  BODY rather than deny a named garment, so they are negation hits in their own
  registry, which is what makes "nothing but a thong" a worn thong rather than a
  bare exclusion. The layering hinge is what stops that hit from stripping a
  garment that IS on — "wearing nothing under her dress" apportions everything up
  to `under` to a span no noun owns. Multiword exceptives ("apart from", "aside
  from") are out of scope: this scanner reads unigrams, so the denial stands and the garment simply
  contributes nothing — and "aside" is a displacement marker before it is anything
  else. A denial carries to the next noun only across pure filler
  (`negationCarryWords` — and/or/the/her/a…), so "without a shirt or bra" denies
  both while "no bra under her sweater" leaves the sweater covering; clause-scoped
  negation would have stripped that sweater. What carries is the segment's verdict,
  so an excepted noun carries its un-negated state on ("not wearing anything but a
  bra or panties" wears both). The failure directions are asymmetric on purpose:
  suppressing wrongly costs that garment's coverage, and on the free-text path
  (where the denial now speaks — see below) reports that region bare, while a
  MISSED displacement leaves bared anatomy reading as covered with nothing but the
  archivist's exposure flag to fight it. Both cost something now; the second is
  still the worse one, which is why the qualifier registries stay wide and the
  coverage table stays narrow.
  Hyphenated compounds stay one token here too, so "off-the-shoulder gown" still
  covers.
- **A compared garment is not a worn one.** An `as … as` span (`readComparatives`
  — an "as" and the next one at least two tokens on, so "as as" is nothing) is a
  simile, and it answers in both directions at once. Its inner words describe the
  garment BEFORE the span, so a `sheerModifiers` word there makes THAT garment
  see-through — a postmodifier of one naming rather than a second naming, which is
  why it is the single read exempt from opaque-wins. The noun the span's window
  ends at, reached across nothing but `negationCarryWords` filler, is the yardstick
  the comparison measures against and contributes to NEITHER output — no row and no
  denial, exactly like an unmapped noun (a substantive token in between cancels
  that: "a blouse as sheer as glass over a negligee" wears the negligee). Read as a
  hinge instead, "a blouse as sheer as a negligee" left the blouse opaque and put
  the negligee on the body — both halves of one sentence backwards. With no noun
  before the span there is nothing to upgrade and the object is still an object, so
  "as sheer as a negligee" alone claims nothing and the free-text caller keeps its
  covered default.
- **A denial is information, not the absence of it.** A suppressed noun leaves no
  row, and for the union path that is the whole story — but "not wearing a shirt"
  alone then produced ZERO rows, which is the same shape as prose naming no
  clothing, so the free-text caller's covered default dressed an explicitly bared
  chest. So the scan reports both sides: `overlayGarmentReads(text)` returns the
  `worn` rows **and** `deniedCoverage`, the deduped coverage ids the denied
  garments claimed (`overlayWornInputs` is a thin wrapper over the same scan, so
  the two can never disagree). **Displacement counts as denial** — "her shirt
  hanging open" makes the same claim "not wearing a shirt" does — while an
  UNMAPPED noun stays out of both halves: nobody knows what a cloak covers, so a
  denied one can no more bare a region than a worn one can dress it.
- **Worn beats denied, per region.** `resolveChatWardrobe`'s free-text read
  (`overlayTextExposure`) merges the two: worn rows reaching an intimate region
  answer alone, exactly as before (`exposedRegions` verbatim, so a described
  outfit naming no shoes still reads barefoot); otherwise a denial over torso or
  pelvis answers, with each region taken from the worn rows where they cover it (a
  hat or boots keeps its own), BARE where the denial reached
  (`exposureRegionsTouched` in `items/visibility.ts`, which answers the region
  question while keeping the four-region location table private), and covered
  everywhere else — a denial states what is MISSING and says nothing
  about the rest of the body. With neither, the read stays silent and the caller
  keeps its covered default. A bare-state word with no noun ("not wearing
  anything") names nothing to bare and lands there too; the archivist's exposure
  flag is that beat's channel.
- **These rows only ever reach `exposedRegions`** — never occlusion, garment
  cues, or the effective-coverage read. Nothing may mistake described prose for a
  garment the wardrobe owns. `deniedCoverage` is bounded the same way and reaches
  one place further in: only the free-text exposure read, never the structured
  union, where prose must never strip an item the wardrobe actually models.

### Effective coverage — the final read

The visibility rule above answers "which garment does the eye reach here". A
second, finer question — "does that garment still **conceal** what is under it?"
— is the **effective-coverage read** (`items/effective-coverage-read.ts`):
`opaque` · `hinted` · `exposed` per body location, with the contributing garment
regions as evidence.

The vocabulary and persisted shape live here because the wardrobe owns coverage;
the **derivation** is the affordance layer's, because it needs current
saturation-dependent opacity (`contracts/affordances/domains/garment` —
[body-attribute-affordances.spec.garment-interaction.md](../developer-notes/body-attribute-affordances.spec.garment-interaction.md)).
One direction only: items never import affordances.

Two rules worth knowing:

- **Layers add cover; they never subtract it.** A location's band comes from the
  most-concealing region reaching it, so a soaked-transparent shirt over a dry
  camisole leaves the chest `opaque`.
- **It is captured, not recomputed.** The chat lane stores the read on the
  garment store (`ChatGarmentStore.coverage`, keyed by garment actor handle), so
  narration, body affordances, retakes, and images share one answer rather than
  each deriving their own from slightly different moments. A location no garment
  reaches has no entry — bare skin is `exposedRegions`' answer, not this read's.

## Clothing categories

`items/clothing-categories.ts` holds authoring-time **coverage templates**:

> top · outerwear · dress · pants · shorts · skirt · bra · underwear · socks · footwear · gloves · headwear · eyewear · jewelry

Picking one pre-fills coverage + layer in the item editor, and the forges may emit one per garment to anchor coverage; everything stays editable afterward. The chosen id is stored as `ItemDefinition.category` for **editor display only** — **category names never enter gameplay prompts** ([../character-chat/prompts.md](../character-chat/prompts.md) §Style rules). The engine reads the resolved coverage set, so a "top" with arm coverage removed simply plays as a tank top.

Templates deliberately avoid parent ids that over-imply:

| Template | Uses | Avoids (and why) |
| --- | --- | --- |
| top | torso-parts + `upper_arms` | `arms` — would cover hands |
| pants | `pelvis` + leg parts | `legs` — would cover feet |
| headwear | `hair` | `head` |

Expanding the set is a one-file data edit.

## Clothing subtypes

`items/subtypes/` holds per-category **accessory vocabularies** — one data file per category (`jewelry.ts`, `headwear.ts`, `eyewear.ts`), aggregated by `subtypes/index.ts` (`clothingSubtypesForCategory`, `clothingSubtypeById`, `clothingSubtypeLabel`). They reuse the `ItemDefinition.subtype` field objects already carry; the item editor shows a **Type** select whenever the picked category has a vocabulary, and the classify backfill fills absent ones.

> jewelry: earring · nose ring · nose stud · septum ring · lip ring · lip stud · eyebrow ring · necklace · choker · bracelet · ring · anklet · belly ring · brooch
> headwear: hat · cap · beanie · hood · headband · hairpin · ribbon · tiara · crown · veil · headscarf · helmet
> eyewear: glasses · sunglasses · monocle · goggles · eyepatch · blindfold · masquerade mask

Two deliberate differences from categories:

- **Subtype labels ARE prompt-bearing.** Image prompts and the narrator's Visible-wardrobe block lead the garment phrase with the label ("nose ring: thin gold hoop") — a bare jewelry name gave the image model too little to place the piece (face-jewelry plan). The category HARD RULE (names never in prompts) is unchanged.
- **Subtypes may carry a coverage template** (a lip ring → `["lips"]`, a choker → `["neck"]`; a brooch has none — it pins to clothing). Picking one pre-fills coverage like a category template; the `lips`/`nose` body locations under `face` exist for exactly these anchors.

Extending a vocabulary is a one-line edit in that category's file; adding a vocabulary to another category is a new file + one map entry in `subtypes/index.ts`.

## Object subtypes

`items/object-subtypes.ts` is the vocabulary for `kind: "object"` items, stored as an optional `ItemDefinition.subtype`:

> furniture · vehicle · weapon · tool · device · book · food · beverage · decoration · instrument

The only capability so far is **`holdable`** — the item *can* be carried in a hand. Holdable is a capability, never a slot binding: where a holdable item currently sits (a hand, a container, a location) is runtime state, so holdables stay container-storable by construction.

Subtype *behavior* (vehicles moving characters, weapons in combat) is future work — each behavior gets its own design doc before any engine code, and the planned first is hand-equippable items.

## Wearer

`items/wearer.ts` is the vocabulary behind clothing's optional `wearer` field — who a garment is cut for:

> feminine (Women's) · masculine (Men's) · unisex (Unisex)

Filter semantics live with the registry so every surface agrees (`wearerMatchesFilter`): **absent = unspecified, treated as unisex** — a garment with no `wearer` matches every wearer filter, and `unisex` is additive (the "Women's" filter shows feminine + unisex + unspecified), never a third silo. This is what makes the facet work for gender-neutral characters out of the box. Extensible the usual way (add a row, e.g. a future per-species fit), never a migration.

## Color

`items/colors.ts` is the color-family vocabulary behind an item's optional `color` (`{ family, shade?, accent? }`). `family`/`accent` are family ids; `shade` is free text ("aqua", "olive") kept for display and image prompts:

> black · white · grey · cream · brown · red · orange · yellow · green · blue · purple · pink · gold · silver · multicolor

Families drive filtering, sorting, and swatch chips in the library UI (`colorFamilySortIndex` sets the sort order — neutrals first, then the hue wheel, metallics/multicolor last). Each family's `swatch` hex is **UI-only** — it never enters gameplay or image prompts (those read name/description/shade). Any item kind may carry a color (a red car sorts too); clothing is the primary surface.

## Coverage editing

Coverage editing (`items/coverage.ts`) uses a **select-all cascade**:

- Checking a location covers it **plus all its descendants**.
- Unchecking a descendant carves it out.

Edited sets are stored **exploded** (every covered id explicit) so carve-outs keep their siblings — `registry.expand` is per-id, so exploded and minimal sets evaluate identically. Carving out a child also drops its ancestors' own ids (otherwise an ancestor would re-imply the child).

Carve-out precision is bounded by tree granularity: add child locations when a region needs finer holes. A ski mask is "head minus eyes"; "face minus eyes" needs face sub-parts to keep any face coverage at all. Footwear works the same way — `feet` splits into `toes` · `top of foot` · `sole` · `heel`, so a peep-toe shoe is "feet minus toes" and a strapped sandal is "feet minus toes and top of foot" (keeping sole+heel); a bare `feet` shoe still covers all four via expand.
