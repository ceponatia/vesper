# Contracts

`src/contracts/` is the pure, IO-free heart of the domain: registries and zod schemas everything else validates against. The architecture follows `~/projects/aionchat/packages/contracts` (registry-driven, provenance-carrying, validator-heavy) with a smaller starter vocabulary, built to grow — adding an attribute, meter, or fact kind is a data change in one file, never a schema migration.

## Attribute system

### Ids and definitions

Attribute ids are `category.name` (e.g. `eyes.color`, `hair.length`, `build.height`). Categories are a closed enum in `attributes/categories.ts` — extend by adding to the array. Definitions:

```ts
type AttributeDefinition = {
  id: `${AttributeCategory}.${string}`;
  label: string;
  kind: "physical" | "biological" | "presentation" | "cultural" | "condition" | "sensory";
  valueType: "enum" | "enum_list" | "number" | "text" | "flag";
  description: string;
  mutability: "inherent" | "mutable" | "temporary";   // inherent: narrative can't change it
  allowedValues?: readonly string[];                   // enum/enum_list
  min?: number; max?: number; unit?: string;           // number
  bodyLocationId?: string;                             // links to the body tree
  appliesToBodyPlans?: readonly string[];              // default: all plans
  excludesBodyPlans?: readonly string[];
  appliesToEntityKinds?: readonly ("character" | "item" | "location")[];  // default: character
  aliases?: readonly string[];                         // NLP mention resolution ("ginger" → hair.color)
  promptHints?: readonly string[];                     // phrasing guidance for prompt builders
  coreVisual?: boolean;                                // always filled at character creation (forge inference,
                                                       // then seeded default from allowedValues; enum only)
  imageReveal?: "shape" | "skin";                      // full-body image reveal tier (docs/images.md §Scene images):
                                                       // "shape" reads through clothing (breast size, waist, hips, leg
                                                       // build) → always described; "skin" only when the region is
                                                       // bare/sheer (nipples, leg hair, toenails). Absent ⇒ not part of
                                                       // the scene subject's reveal line. Consumed by the scene render.
  identityAnchor?: boolean;                            // inferred first at forge time; conditions the plausible
                                                       // ranges for unset core visuals (docs/authoring.md §Character
                                                       // forge). Physical attributes only — never personality/voice/
                                                       // behavior/role. New anchors are one-line registry edits.
  autoDefaultExcludes?: readonly string[];             // enum members valid to pick but never chosen as an *automatic*
                                                       // default (forge fallback fill / picker add). e.g. minor apparent
                                                       // ages exist for background characters; no one defaults to one.
  activatesGroups?: Record<string,                     // creation-time body-config SEED keyed by enum value (never a lock):
    { intimateRegions?: readonly string[];             //   identity.gender "female" → seed intimate regions vulva+breasts.
      bodyFeatures?: readonly string[]; }>;            //   read by seedBodyConfigFromAttributes; editor stays authoritative.
};
```

### Groups and the central registry

Each category lives in one file under `attributes/categories/` (`eyes.ts`, `hair.ts`, …) exporting its **definition bundle** via `defineAttributeGroup`. The closed list of category ids is `attributes/category-ids.ts`. ("Group" = a category's bundle of definitions, *not* a body section — anatomical sections are body **locations**, §Body model.) `attributes/registry.ts` derives everything — including each id's value schema — from the bundle list:

```ts
export const attributeRegistry = buildRegistry(attributeGroups);
// .definitions, .byId(id), .parseValue(id, raw) → typed value or issue list,
// .resolveAlias(text), .forCategory(cat), .forBodyLocation(loc)
```

**To add attributes: edit/create one file under `attributes/categories/` and add it to the `attributeGroups` array.** Types, validation, alias resolution, and prompt hints all follow. A registry test asserts ids are unique, every enum has ≥2 values, aliases don't collide.

The index + value-parser spine is **shared**: `contracts/registry` exposes a generic `buildRegistryCore({ definitions, valueSchemaFor, validate, idLabel })` (dup-id guard + per-id `parseValue`) that both the attribute registry and the personality **trait** registry (§Disposition) instantiate, layering their own lookups on top (attributes add category/body-location/alias; traits add band readout + lexicon). One spine, two registries — so traits inherit the same machinery without duplication.

Starter vocabulary (~50 attributes): identity (gender, apparent_age, heritage — free text, since real-world ethnicities and fantasy ancestries can't share a closed list; all three flagged `identityAnchor`; structural species is **not** an attribute — it is `CharacterProfile.speciesId`, §Body model), build (height, frame, musculature, weight_presentation), skin (tone, undertone, texture, markings), hair (color, length, texture, style), eyes (color, shape, pupil, luminosity), face (shape, freckles, expression_default), brows, lips, teeth (shape — even…sharp_canines/fanged/serrated — condition), ears, horns (shape, length, count, texture, color), neck, shoulders, chest, wings (type, span, color, carriage), waist, hips, tail (type, length, tip, color), arms, hands, legs, feet, voice (pitch, timbre, accent, cadence), presentation (style, grooming, scent_baseline), movement (gait, posture_default). Supernatural/non-human palettes are first-class: `skin.tone`, `eyes.color`, and `hair.color` carry unnatural options (ashen/grey/blue skin, gold/red/solid-black/glowing eyes, fae hair), and `eyes.pupil` (vertical-slit, goat) reads non-human — all flagged `autoDefaultExcludes` so a human is never auto-assigned one (the forge/editor may still pick them, or a species rule can require them). Expansion toward aionchat's per-anatomy granularity is expected; the group mechanism is the contract, the vocabulary is not.

### Values with provenance

A character never stores bare values — always:

```ts
type AttributeValue = {
  id: AttributeId;
  value: unknown;          // validated via registry.parseValue
  source: "base" | "creation" | "condition" | "injury" | "item" | "magic" | "environment" | "narrative" | "manual";
  sourceId?: string;       // e.g. condition id
  note?: string;
};
```

The source enum is extensible by design: add the value, slot it into the precedence list, update this doc. The sources + precedence + the last-write-wins resolver are the shared `contracts/registry` provenance spine (`provenanceSources`, `SOURCE_PRECEDENCE`, `resolveProvenance`); `resolveAttributes` and the traits' `resolveTraits` are thin aliases over it. Base values live in the character **profile**; runtime overlays (a haircut, a sunburn) live in participant **state** and shadow the base by id. `resolveAttributes(profile, state)` returns the effective view, last-write-wins by source precedence: `manual > condition/injury/item/magic/environment > narrative > creation > base`.

## Body model

`body/locations/` (region-split: `everyday.ts` · `features.ts` · `intimate.ts` · `index.ts`): a tree registry of body locations (`id, label, parentId?, side?, coverageRelevant?, intimateGroup?, featureGroup?, promptHints?`). Everyday humanoid tree: five roots — head (hair, face→eyes, ears), torso (neck, shoulders, chest, back, waist), arms (upper_arms, forearms, wrists, hands→fingers), pelvis (hips, groin, buttocks), legs (thighs, calves, ankles, feet→toes) — at coverage-useful granularity (~27 nodes). Additive feature locations are default-absent and tagged with `featureGroup`: horns under `head`, wings under `back` (which already exists under torso), and tail under `pelvis` (not groin; it is attached near the pelvis but not genital anatomy). The roots double as the coverage editor's column groups. Beware bare parent ids in coverage data: `arms` implies hands and fingers, `torso` implies the neck, `legs` implies feet — garments should use the specific parts (a t-shirt is torso-parts + upper_arms, never `arms`).
`body/plans.ts`: body plans (`humanoid` seeded) = a set of location ids + applicable attribute rules. Characters reference a `bodyPlanId`; non-humanoid plans are future data additions, not refactors.

Wardrobe coverage, exposure, and attribute targeting all reference body-location **ids** — never hardcoded strings elsewhere.

### Intimate anatomy, body-config & the realized body

Explicit anatomy (`intimate.ts`) hangs off the everyday tree under `groin` / `pelvis` / `chest` — vulva (+ labia, clitoris, vestibule, vagina, mons), penis, testicles, anus, breasts (+ nipples). These are `coverageRelevant: false` (a garment over `pelvis`/`chest` already covers them via `expand`; they aren't garment slots). The *configurable* ones each carry an `intimateGroup` (`INTIMATE_REGION_GROUPS = breasts · vulva · penis · testicles`) so the realized-body filter can include/omit the sub-tree per character. The **anus** is the exception: it carries **no** `intimateGroup`, so it is **universal** — present on every realized body (everyone has one), not a body-config toggle — while still living in the fenced intimate subfolder and being exposure-gated like any below-waist region. Their attributes live in `attributes/categories/intimate/` (a fenced subfolder — easy to find and to withhold from moderation-prone routes), in categories `INTIMATE_ATTRIBUTE_CATEGORIES = breasts · vulva · penis · testicles` (anus is a touchable region with no descriptive attributes yet). The full aionchat anatomy vocabulary T1 didn't port (buttocks, groin, abdomen, nose, …) is catalogued in `docs/developer-notes/supplemental-anatomy.phase4.md`.

Which intimate anatomy a character has is the **body-config**: `CharacterProfile.intimateRegions` (a list of present region groups, e.g. `["vulva","breasts"]`). It is **seeded declaratively** at forge time from the attribute values' `activatesGroups` (`seedBodyConfigFromAttributes` — e.g. `identity.gender = "female"` → `["vulva","breasts"]`; `identity.gender` is `coreVisual` so it is always present and the seed is reliable) and is fully overridable in the editor — a SEED, never a lock, so a "male" character can still be given a vulva. Empty `[]` = no intimate anatomy = the engine's pre-existing behavior; the body-config starts empty, so "deactivate X" is simply "no value activates X". Additive fantasy morphology uses the parallel `CharacterProfile.bodyFeatures` list (`["wings","horns","tail"]`); when that field is absent, the species' `defaultFeatureGroups` seed the realized body, and when present, even `[]` is an explicit per-character override. No migration: both ride the profile JSONB.

`species/realize.ts` `realizeBody({ bodyPlanId, speciesId, heritageId, intimateRegions, bodyFeatures })` is the single gating filter: body plan (superset of locations) → species (`allowedBodyLocationIds` / `disallowedBodyLocationIds` + `defaultFeatureGroups` + attribute rules) → **heritage** (an optional refinement within the species — adds feature groups, overrides attribute rules per `attributeId`, never touches the body plan or locations) → body-config (which intimate groups and additive features are present). It answers `isLocationPresent(id)`, `hasIntimateRegion(group)`, `hasFeature(group)`, and `isAttributeApplicable(def)`, plus the per-attribute **rule view** — `attributeRuleFor(id)`, `isAttributeRequired(def)`, `allowedValuesFor(def)` (def values intersected with the rule's `allowedValues`, minus `disallowedValues`), and `defaultValueFor(def)`. All three `AttributeRule` applicabilities are now live: `forbidden` drops the attribute, `required`/`optional` keep it (a `required` rule with a `defaultValue` is seeded at creation — e.g. elf `ears.shape` → "pointed"), and `allowedValues`/`disallowedValues` narrow the value set per species. Consumed by the attribute editor, narrator impression block (exposure-gated), image prompt assembly, and forge attribute vocabulary so stale/gated attribute values do not surface and species traits hold. Forge species inference uses registry id/label/alias matching plus conservative token-level fuzzy fallback (`inferSpeciesFromText`) before its parallel sections run; a feature-bearing match seeds `speciesId`, `bodyPlanId`, and species-default `bodyFeatures`, then unlocks realized feature attributes for the attribute agent. Species live **one file per species** under `species/catalog/` (parity with attribute categories: `defineSpecies(...)` per file, listed in `catalog/index.ts`; `registry.ts` derives `speciesById` / `isSpeciesId` / `inferSpeciesFromText` / `speciesAppearancePhrase` / `speciesLorePhrase` / `heritageFor` / `heritagesForSpecies` / `inferHeritageFromText` from that array — adding a species is a single new file). The catalog ships `human`, feature-bearing `succubus` (`wings`, `horns`, `tail` by default), feature-bearing `faerie` (`wings` by default), and baseline humanoid records for `elf`, `dwarf`, `gnome`, `orc`, and `goblin`. A further humanoid variant is a data add once its feature groups exist; true non-humanoid body plans stay future work. Each species carries two optional **model-facing** notes split by audience (both empty by default, both distinct from the internal `description`): **`appearance`** — a generic, image-safe description of the species' default morphology (pointed ears, a greenish skin cast, wings/horns/tail, broad stature), *not* any one character's specific attribute values — and **`lore`** — cultural/identity backstory (temperament, standing, relations). `speciesAppearancePhrase(speciesId)` resolves the label (+ `appearance` when authored) and feeds the **avatar/scene image prompts** (`images/prompts.ts`) and the **character forge** (`authoring/character-forge.ts`, which turns the generic look into concrete per-character attribute values); `speciesLorePhrase(speciesId)` resolves the label (+ `lore`) for the **narrator** canonical-facts block (`engine/scene.ts`) — the narrator's physical detail comes from per-character attributes (`buildGlanceImpressions`), so it gets culture here, not looks. Both surface only for **non-human** casts (label-only when the field is unauthored); the unmarked `human` default surfaces nothing. A species may also carry **`heritages`** — optional sub-groups within it (e.g. `dark_elf` inside `elf`; ships as the worked example). A heritage is a pure overlay: it adds feature groups, **overrides** the species attribute rule for any shared `attributeId` (last-wins), and carries its own `appearance` (**combined** with the species look) and `lore` (**replaces** the species culture note, falling back when absent). The character stores an optional `profile.heritageId`; `realizeBody`'s `heritageId` composes the overlay, the phrase helpers take it as a second arg, and the forge infers it (`inferHeritageFromText`, scoped to the resolved species; heritage names like "drow" also resolve the parent species). Heritage never changes the body plan — structural non-humanoids stay future work. `appliesToBodyPlans` / `excludesBodyPlans` on attributes (previously inert) are now consumed here.

### Colloquial body references

`species/targets.ts` resolves a player's colloquial body reference to the *set* of attributes it covers — "look at her **face**" means `face` + `eyes` + `brows` + `lips` here, not just `face.*`. It is **deterministic and pure** (not an attribute-fetch agent): a term resolves through the body-location tree (`expand` the subtree, then gather every attribute bound to those locations via `bodyLocationId`) or a category id, with a small synonym map for colloquialisms that match neither (`mouth` → lips, `figure`/`physique` → build). `resolveBodyTarget(term)` returns the structural expansion; `expandBodyTarget(term, isApplicable)` filters it through a character's realized body (pass `realizeBody(...).isAttributeApplicable`, so "chest" on a flat-chested character omits breast attributes); `detectBodyTargets(text)` scans free prose (whole-word, longest-phrase-first). The intended consumer is the look/touch attribute surfacing for the narrator; that wiring is pending (it lives in the turn pipeline / scene assembly).

### Clothing categories

`items/clothing-categories.ts`: authoring-time coverage templates (`top`, `outerwear`, `dress`, `pants`, `shorts`, `skirt`, `bra`, `underwear`, `socks`, `footwear`, `gloves`, `headwear`, `eyewear`, `jewelry`). Picking one pre-fills coverage + layer in the item editor, and the forges may emit one per garment to anchor coverage; everything stays editable after. The chosen id is stored as `ItemDefinition.category` for editor display only — **category names never enter gameplay prompts** (docs/prompts.md): the engine reads the resolved coverage set, so a "top" with arm coverage removed plays as a tank top. Templates deliberately avoid parent ids that over-imply (`top` lists torso-parts + `upper_arms`, never `arms`, which would cover hands; `pants` is `pelvis` + leg parts, not `legs`, which would cover feet; `headwear` is `hair`, not `head`). Expanding the set is a one-file data edit.

### Object subtypes

`items/object-subtypes.ts`: vocabulary for `kind: "object"` items (furniture, vehicle, weapon, tool, device, book, food, beverage, decoration, instrument), stored as optional `ItemDefinition.subtype`. The only capability so far is `holdable` — the item *can* be carried in a hand. Holdable is a capability, never a slot binding: where a holdable item currently sits (a hand, a container, a location) is session state, so holdables stay container-storable by construction. Subtype *behavior* (vehicles moving characters, weapons in combat) is future work — each behavior gets its own design doc before engine code; the planned first is hand-equippable items.

Coverage editing (`items/coverage.ts`) uses a select-all cascade: checking a location covers it plus all descendants, unchecking a descendant carves it out. Edited sets are stored **exploded** (every covered id explicit) so carve-outs keep their siblings — `registry.expand` is per-id, so exploded and minimal sets evaluate identically. Carving out a child also drops its ancestors' own ids (an ancestor would re-imply the child); carve-out precision is bounded by tree granularity — add child locations when a region needs finer holes (a ski mask is "head minus eyes"; "face minus eyes" needs face sub-parts to keep any face coverage).

## Meters

Continuous 0–1 state that drifts with time, defined as data (`meters/registry.ts`):

```ts
type MeterDefinition = {
  id: string;                       // "hygiene", "energy", "arousal", "stress", "intoxication", "mood"
  label: string;
  description: string;
  initial: number;
  perHour: number;                  // signed drift per game hour
  baseline?: number;                // resting target (absent ⇒ today's pole: perHour<0 ⇒ 0, else 1)
  recoveryPerHour?: number;         // rate toward baseline (absent ⇒ |perHour|)
  thresholds: Array<{ below?: number; above?: number; promptHint: string }>;
};
```

The engine applies drift on clock advance (`applyMeterDrift` — moves each value toward its baseline at `recoveryPerHour`, never overshooting, clamped [0,1]) and surfaces crossed-threshold `promptHint`s to the narrator. Worlds may override or disable meters in their style config. Drift is **per-character**: at drift time the merge resolves trait-shifted baseline/recovery via `personalizeMeters` (personality §Modulation) — the global value is the no-trait default. Absent `baseline`/`recoveryPerHour` ⇒ exactly the old pole-seeking drift.

Starter meters: `hygiene` (1→0, −0.04/h, thresholds prompt scent/grime hints), `energy` (1→0 waking drain, restored by sleep via simulant), `stress` (0-seeking), `arousal` (0-seeking), `intoxication` (0-seeking, fast decay), and **`mood`** — emotional valence (0 low / 0.5 even / 1 bright; baseline 0.5, returns to an even keel). Mood is surfaced not as raw threshold hints but as a **derived descriptor** (`deriveMoodDescriptor` blends valence × stress/energy → "low and on edge", "bright and playful", …), and it couples with affinity: the social-reaction curve reads mood as its `μ` factor (`moodMeterToFactor`) and a reaction nudges mood back (`moodNudge`). The old app's 7-vector hygiene model becomes `hygiene` + conditions (`sweaty`, `soaked`, `unwashed` with region notes) — same play feel, no bespoke code path. Region-level scent composition is deliberately replaced by: item `sensory` text + hygiene threshold hints + exposure gating ([prompts.md](prompts.md)).

## Registered actions

Common multi-minute activities pass authored game time instead of an LLM estimate (`actions/registry.ts`):

```ts
type ActionDefinition = {
  id: string;                          // "shower", "bathe", "nap", "meal", "snack", "workout", "groom"
  label: string;
  minutes: number;                     // turn clock advances max(this, travel, estimate)
  aliases: readonly string[];
  meterEffects: Array<{ meterId: string; delta?: number; set?: number }>;  // deterministic; agent deltas still win
  requiredTier?: ProximityTier;        // reserved for proximity gating, unused until that ships
};
```

`matchActions(text)` matches aliases whole-word, case-insensitive, longest-first, at most one match per definition; double-quoted spans are stripped so dialogue never matches ("I said I'd shower later").

## Link access

`world/access.ts`: who/when a location link admits — stored as jsonb on `world_links`/`session_links`, parsed once at the bundle boundary (malformed or absent ⇒ `public`, today's behavior):

```ts
type LinkAccess =
  | { kind: "public" }
  | { kind: "private"; ownerParticipantIds: string[] }   // discourages future NPC pathing; no player effect v1
  | { kind: "locked"; keyItemId?: string }               // keyItemId reserved — v1 blocks even a key-holder
  | { kind: "timeWindow"; start: number; end: number };  // minutes-of-day, [start, end), wraps past midnight
```

`checkLinkAccess({ access, minuteOfDay, moverParticipantId?, door? })` is the one traversal rule (passable / blocked-with-reason): the merge's player-movement validation uses it now, phase-4 NPC traversal reuses it. A bound door item instance (`session_links.door_item_id`) whose state is closed+locked seals the link regardless of kind (`ItemInstanceState.locked`, optional boolean). Blocked player moves drop with `merge.movement.access_denied` (see [turn-engine.md](turn-engine.md)).

## Relationship stages

`relationships/stages.ts`: readable labels over the −100..100 affinity scalar — eleven stages (hostile · wary · cool · stranger · acquaintance · friendly · warm · close · cherished · devoted · smitten; widened from the original seven in personality Slice 5 for finer, romance-leaning progression — `stranger` still straddles 0), boundaries as data. `stageForValue()` maps value → stage; `stageMidpoint()` seeds authored edges. **Stages, never raw numbers, go in prompts and gate behavior.**

`relationships/authored.ts`: the authored entry stored on `world_cast.relationships` — `{ toward, stage }` where `toward` is a cast display name or the literal `"player"` (resolved case-insensitively at spawn) and `stage` is a registry stage id (unknown ids self-heal to `stranger` = no seeded row; the jsonb list reads through `parseOr` with fallback `[]`).

`relationships/bond.ts`: `classifyBond(text)` — a deterministic keyword pass over a cast member's concept/bio text classifying the player bond as `mutual` (named kinds: family, sibling, partner, spouse, friend, coworker, …), `first-meeting` ("never met", "first meeting", "strangers" — beats mutual keywords), or `indeterminate`. Spawn seeds the NPC's `perceived` edge from it: mutual and indeterminate mirror the feeling midpoint, first-meeting seeds no row (`server/engine/relationship-seeds.ts`).

## Disposition (personality)

`contracts/personality/` — authored character disposition: **atomic traits** that parameterise dynamics + **social reactions** decided deterministically (docs/developer-notes/personality-and-state.spec.md §3/§6). Registries + pure resolvers, all IO-free:

- **Interaction concepts** (`interactions.ts`) — the controlled vocabulary the intake agent classifies a player's social act into (`compliment`, `gift`, `flirt`, `insult`, `jealousy_trigger`, …). Each carries a `verb` (for the reaction line), a `family` (a cluster a preference may target wholesale, e.g. `affection_display`), a `polarity` (`warm`/`hostile`/`neutral` — the act's affective direction, read by the puppet guardrail), classifier `triggers`, and an `intimate` flag. One stable classification target; the shared key space for preferences and (later) cards. Add a concept = one data edit + the registry test.
- **Disposition tags** (`tags.ts`) — a **dev-defined canonical registry** of reusable labels (`bratty`, `prudish`, `foot-fetish-positive`) that social-reaction **cards** key their overrides on. Each tag carries the first slice of machine-readable affect: a `warmth` lean (`cold`/`neutral`/`warm`) and a `wontInitiate` list of concept families the character would not spontaneously perform — the signal the **puppet guardrail** reads. The editor/forge autocomplete from it; free-form tags are tolerated but second-class (and, carrying no machine affect, invisible to the guardrail). `normalizeTag` / `canonicalTagId` map free text onto the canonical id. Tags remain inert to the **card** layer until cards ship (`social-reaction-cards.plan.md`).
- **Preferences** (`preference.ts`) — a character's bespoke `{ target, valence: like|dislike, intensity 1–10, hint? }`, where `target` is a concept id **or** a family id. Leaf fields `.catch` so one bad entry degrades, not the array.
- **Traits** (`traits/`) — a parallel registry on the shared spine (§Attribute system), deliberately separate from attributes so it can **never** reach an image prompt. Categories `temperament`/`social`/`intimate` (one starter set, ~11 traits); each definition is a numeric scalar (bipolar −100..100 or unipolar 0..100) with registry-defined **bands** (`{ max, label, promptHint }`, ascending, covering the axis max — store the number, surface the band), a `mutability` (`core`/`developable` — drift deferred), an `intimate?` flag, optional `modulates` metadata, and a scored **`lexicon`** (`{ term, value }`) mapping free-text words onto the axis (`resolveLexicon` — the forge-expansion mechanism). `traitRegistry.bandFor(id, value)` clamps + reads the band. Trait **values** (`TraitValue`) reuse the attribute provenance shape (`resolveTraits` over the shared resolver). Adding a trait is a one-entry data edit + the registry test.

**Modulation** (`modulation.ts`) — pure trait → coefficient functions (spec §5), kept deterministic in the merge, never agent-decided. `socialTraitScale(reaction, traits)` scales the reaction curve: agreeableness/composure soften (and their negative poles sharpen) a **dislike**, possessiveness amplifies a **jealousy_trigger**; clamped to `[0.4, 1.8]`. `personalizeMeters(defs, traits)` resolves per-character meter dynamics (§Meters): `optimism→mood.baseline`, `libido→arousal.baseline`+recovery, `composure→stress.recovery`. `scaleAffinityGain(rawDelta, traits)` (Slice 5) scales a **simulant** affinity delta pre-clamp — warmth/agreeableness amplify gains, guardedness damps them, composure damps losses (clamped to `[0.4, 1.8]×`). `affinityDecayRetention(traits)` (Slice 5) returns a `[0, 0.7]` retention from warmth + composure that lifts the decay floor toward the current value (a constant character holds its regard). Empty traits ⇒ unit/identity (today's behavior).

Both `tags: string[]` and `preferences: Preference[]` (and `traits: TraitValue[]`) ride `CharacterProfile` JSONB (default `[]` ⇒ a character with no disposition plays exactly as before). The resolver (`reactions.ts`): `resolveSocialReaction(act, { tags, preferences, cards })` applies **pure-override** precedence (bespoke preference → card tag-override → card default → null; v1 passes `cards: []`); `evaluateSocialReaction(reaction, currentAffinity, currentMood, traitScale)` is the **affinity-aware curve** — goodwill deadband, thin-ice amplification, capped/asymmetric likes (mood is a neutral stub, `traitScale` is 1 in v1). Curve constants live in `reactions.ts` (contracts is IO-free; the merge clamps the result to ±`AFFINITY_DELTA_CLAMP`). `matchPreference` (concept-then-family lookup) is shared with the guardrail.

**Puppet guardrail** (`puppet.ts`) — `checkPuppetContradiction(behavior, { tags, preferences })` decides whether a *player-authored NPC behaviour* (intake's `narratedNpcBehaviors`, classified to a concept) clashes with who the character is. Precedence mirrors the reaction resolver (most specific wins): a bespoke preference on the concept/family decides outright (a `dislike` ⇒ contradiction, an authored `like` ⇒ consent to puppet), else the tag affect (a `wontInitiate` family match, or a warm act onto a `cold` character / a hostile act onto a `warm` one), else the **warmth trait** band (same warm/cold logic on the scalar), else **honour**. An unclassifiable behaviour (no concept — plain dialogue) is always honoured. Pure; reads tags + preferences + the warmth trait — affinity + mood join once they exist.

## Conditions

Discrete temporary states (`conditions/condition.ts`), aionchat-style:

```ts
type ConditionEffect = { attributeId: AttributeId; value: unknown };   // no source — applied AS source "condition"

type ActiveCondition = {
  id: string;
  label: string;                    // "soaked", "exhausted", "sprained ankle"
  severity?: "minor" | "moderate" | "severe";
  startedAtMinutes: number;         // game clock
  durationMinutes?: number;         // engine expires it
  source?: { kind: "narrative" | "item" | "environment" | "manual"; id?: string };
  attributeEffects?: ConditionEffect[];  // overlaid while active with source: "condition", sourceId: condition id
  senseEffects?: { sight?: "reduced" | "blocked"; hearing?: "reduced" | "blocked" };  // perception impairment (see Perception §darkness)
  promptHint?: string;
};
```

## Perception

`contracts/perception/` — the pure rules answering "who is present" and "who perceived what" each turn; behavior and the engine seams that consume these live in [perception.md](perception.md). Shapes and extension points:

- **Presence channels** (`channels.ts`): every participant is classified relative to the player's scene into `sight` (co-located, full presence), `sound` (audibility-linked — reserved enum slot, the cross-location sound channel is phase 4), `comms` (active call/text link — may speak, not physically present), or `absent` (referenced/remembered only). `classifyPresenceChannels`, `buildPresenceRoster`.
- **Attention** (`attention.ts`): `deriveAttention({ activity, posture, hint? })` → `{ state, facesAway }` over states `engaged_with | absorbed | idle_alert | asleep_or_impaired` (`idle_alert` = neutral/degraded default). The optional hint comes from `ItemDefinition.attentionHint` (`absorbing | faces_away | outward`).
- **Salience** (`salience.ts`): every notable action carries `{ visual: obvious | subtle, audible: loud | quiet | silent }` (default obvious + quiet). A stealth marker lowers salience only when a **concealment target** exists ("quietly" to a lover is tone; the same with her unaware mother present is a sneak).
- **Witness matrix** (`witness.ts`): `perceives(observer, salience, mods?)` is the single arbiter — an observer perceives an action if attention admits its visual **or** audible channel. `mods` stack environmental/per-observer effects (`dark`, per-sense `reduced`/`blocked`, `proximityOverride`).
- **Darkness** (`darkness.ts`): `darknessVerdict(band, ambient.light)` — a v1 keyword heuristic over daylight `band` × authored `ambient.light`; dark downgrades visual `obvious`→`subtle`. Per-observer sense impairment derives from conditions (`senseModsFromConditions`, reading `ActiveCondition.senseEffects` or a known label map).
- **Proximity primitive** (`proximity.ts`): the tier ladder (`distant → apart → near → close → contact → entwined`) plus scale helpers `defaultEntryTier(scale)` and `distantExists(scale)`. Phase 3 uses only what `sight` needs (co-located ⇒ `sight`); per-pair tracking is phase 4.

## Items and wardrobe

```ts
type ItemDefinition = {
  kind: "clothing" | "object" | "container";   // embedded in item rows / instance snapshots, not self-identified
  name: string; description: string;
  coverage?: BodyLocationId[];      // clothing
  layer?: 0 | 1 | 2 | 3;            // 0 underwear … 3 outerwear
  opacity?: "opaque" | "sheer";
  sensory?: { appearance?: string; scent?: string; tactile?: string };
  attentionHint?: "absorbing" | "faces_away" | "outward";  // perception hint for deriveAttention (see Perception)
  fields?: Record<string, unknown>; // kind-specific extras (capacity, wearable container…)
  tags: string[];
};
```

Instance placement is exactly one of: worn by participant / held by participant / in location / in container instance. **Visibility rule** (replaces occlusion stack depths): per body location, the highest-layer covering item is *visible*; items beneath are *hidden*, or *hinted* when everything above them is sheer. Implemented once in `items/visibility.ts`, used by prompts, the simulant grounding, and the UI.

## Facts

`facts/taxonomy.ts` — a trimmed aionchat taxonomy: `factKindIds` (relationship, knowledge, commitment, attribute_revelation, item, location, event, preference, secret) as a closed enum, extendable by array edit. A fact:

```ts
type FactDraft = {
  kind: FactKind;
  verb?: FactVerb;                           // optional normalized verb (small registry, e.g. "promise",
                                             // "reveal_trait", "show_affection"); invalid → omitted + diagnostic
  subjectName: string;                       // resolver maps → participant/entity
  subjectKind: "character" | "player" | "location" | "item" | "world";
  text: string;                              // one declarative sentence
  tags: string[];                            // lowercase; exact-match keys for lore unlocks
  confidence: number;                        // 0–1
};
```

Lifecycle (`active | superseded | retracted`) and storage live in the db layer; see [memory.md](memory.md).

## Pinned state shapes

These are the **binding** schemas behind every JSONB column ([database.md](database.md)). They live in `contracts/state/` and `contracts/world/`; each exports an `empty*()` default used as the `parseOr` fallback.

```ts
type ParticipantState = {
  attributeOverlays: AttributeValue[];        // shadow profile base values by id
  meters: Record<string, number>;             // meterId → current value
  conditions: ActiveCondition[];
  activity: string;                           // "idle", "cooking dinner", …
  posture?: string;
  notes: string[];                            // short-lived mechanical notes for the narrator
};

type StoryThread = {
  id: string; title: string; summary: string;
  status: "open" | "cooling" | "resolved" | "archived";
  source: "anchor" | "emergent" | "player";
  openedAtTurn: number; lastTouchedTurn: number; touchCount: number;
};

type SessionRuntime = {
  storyThreads: StoryThread[];
  visitedLocationIds: string[];
  encounteredParticipantIds: string[];           // full (sight) encounters only — see perception.md first-impression fidelity
  unlockedLoreIds: string[];
  lastInteractedTurn: Record<string, number>;  // participantId → turn number of last targeted interaction
  commsLinks: Array<{ kind: "call" | "text"; withParticipantId: string; since: number }>;  // active call/text links (perception.md §Comms)
  pendingComms: Array<{ fromParticipantId: string; kind: "call" | "text"; gist: string; urgency: "low"|"normal"|"high" }>;  // NPC-initiated messages, surface-once; written by the movement system on a staged beat's arrival (turn-engine.md §Director-staged movement)
  stagedIntents: StagedIntent[];                 // director-staged off-screen NPC moves + on-arrival beats (phase-4 npc-movement minimal slice; turn-engine.md)
  flags: Record<string, boolean>;
};

type StagedIntent = {                            // a director story decision, executed by engine/movement.ts
  id: string;
  participantId: string;                         // the NPC being walked off-screen
  destinationLocationId: string;
  reason: string;                                // the verifiable reason (propose-and-audit)
  threadId?: string;                             // optional link to the narrative thread it serves
  onArrival: { comms?: { kind: "call" | "text"; gist: string; urgency: "low"|"normal"|"high" }; directive?: string };
  status: "active" | "resolved" | "cancelled";
  openedAtTurn: number;
  expiresInTurns: number;                        // give-up budget (STAGED_INTENT_DEFAULT_BUDGET)
};

type ExposureMask = {                          // per-sense narration proximity gate, set by the director
  appearance: "ambient" | "close" | "intimate";
  scent: "none" | "ambient" | "close" | "intimate";
  touch: "none" | "close" | "intimate";
  taste: "none" | "close" | "intimate";        // most-intimate sense; raised by a taste/kiss/lick intent (also raises touch)
};

type NextTurnBrief = {
  sceneSummary: string;
  storySoFar: string;
  characterNotes: string[];
  directives: string[];                       // includes ≤2 continuity "Correction: …" lines
  memoryQueries: string[];                    // consumed by the NEXT turn's pre-turn retrieval
  exposure: ExposureMask;
  droppedEvents: string[];                    // merge-dropped agent events, surfaced as gentle corrections
  arrivals: string[];                         // schedule-tick staging ("Mara arrived from the market.") —
  departures: string[];                       //   per-turn, never carried forward; default [] (old briefs parse unchanged)
};

type SceneGenState = {                        // no subject field: the composer picks the focal NPC
  interval: number;                           // every N turns; 0 = off
  lastGeneratedTurn?: number;                 //   from whoever is co-located with the player
  status: "idle" | "generating" | "failed";   //   (docs/images.md §Scene images)
};

type CharacterProfile = {
  bio: string; personality: string; voice?: string;
  speciesId: string; bodyPlanId: string;      // registry ids ("human" / "succubus" / "faerie" / …, "humanoid" seeded)
  intimateRegions: string[];                  // body-config: present intimate region groups (default []); see Body model §realized body
  bodyFeatures?: string[];                    // additive feature groups; absent ⇒ species defaults, [] ⇒ explicit none
  attributes: AttributeValue[];               // base/creation-sourced
  aliases: string[];
  defaultOutfit: string[];                    // item definition ids (owner's library)
  schedule?: Array<{ startMinute: number; endMinute: number; locationName: string; activity: string;
                     days?: number[] }>;   // weekday mask, 0 = Sunday; absent ⇒ every day
};

type WorldStyle = {
  directives: string[];                       // tone/era/pacing/content notes
  narratorGuidance?: string;
  calendarStart: { year: number; month: number; day: number; hour: number; minute: number };
  meterOverrides?: Record<string, Partial<MeterDefinition> | null>;  // null disables a meter
  norms: Array<{                              // generalized taboo/social-rule system
    rule: string;                             // "public nudity is scandalous"
    severity: "odd" | "disapproval" | "outrage";
    consequence: string;                      // hint for witness reactions
  }>;
};
```

## Game time

`src/lib/clock.ts` (pure) derives `GameTime` from `clock_minutes` + `style.calendarStart` — including `weekdayIndex`/`dayIndex` (schedule day masks, per-day deterministic seeds) — and a `daylightBand` helper (dawn 05–07 · day 07–18 · dusk 18–20 · night otherwise) so consumers never re-derive hours.

## Turn contracts

`turns/` defines the binding shapes between engine, agents, and UI: the four agent result schemas (`SimulantResult`, `ArchivistResult`, `ContinuityResult`, `DirectorResult`) — their field-level spec lives in [turn-engine.md](turn-engine.md) §Post-turn agents and the zod source is the single truth — plus the SSE chunk event:

```ts
type TurnChunkEvent = { segmentIndex: number; speaker: string | null; content: string };
// speaker matches a session_participants.display_name, or null for narrator prose
```

Rules:

- Agent schemas reference world entities **by display name**, never db ids — models are bad at ids; deterministic resolvers ground names to rows (with embedding-fuzzy fallback) and emit diagnostics for misses (`merge.<agent>.unresolved_*` codes).
- Every agent schema field is `.default()`ed; the schemas double as their own degraded fallbacks ([turn-engine.md](turn-engine.md) §Degraded defaults).
- Perception (phase 3, see [perception.md](perception.md)): `SimulantResult` item/activity events may carry optional `salience: { visual, audible }`, and the result has a top-level `commsEvents` (`open`/`close`, `call`/`text`, `withName` → `runtime.commsLinks`); each `ContinuityResult.violations[]` entry carries `kind: "general" | "narrated_absent_character" | "reacted_to_unperceived_event"`.

### Intent brief

`turns/intent-brief.ts` — the **pre-narration** intake agent's output (phase-4 pre-narrator, [turn-engine.md](turn-engine.md) §Intake agent), the one agent contract produced *before* the narration exists. Emitted on the **`tool` model** — which now has a second consumer (was: only the image scene composer). Like the post-turn agents it references entities **by display name** (present NPCs, items, locations), every field is `.default()`ed (so the empty brief is today's behavior), and it persists on the turn row (`turns.intent_brief` jsonb).

```ts
type IntentBrief = {
  actionType: "converse" | "move" | "observe" | "touch" | "manipulate_item"
            | "comms" | "rest" | "social_attempt" | "intimate" | "meta" | "other";  // default "other"
  // regex-SceneIntent mirror — sceneIntentFromBrief(brief) is lossless
  lookTarget?: string; touchTarget?: string; smellTarget?: string; tasteTarget?: string;  // NPC display names
  examineItem?: string;                                             // item name
  enterLocation?: string;                                           // location phrase
  addressedNpcs: string[];                                          // NPC display names
  // PERSISTED SEAMS — written in v1, not yet enforced:
  movement: { kind: "none" | "self" | "narrated_npc" | "co_travel_request" | "implied_subspace";
              destination?: string; coTravelTargets: string[] };   // movement-authority-spec consumes later
  appointment?: { withNpc?: string; location?: string; timePhrase?: string; reason: string };  // scheduled-arrivals-spec
  check?: { relevantAttributeIds: string[]; stakes: "low" | "med" | "high" };  // future attribute/skill-check resolution
  notes: string;                                                   // one-line rationale, diagnostics only
};
```

`sceneIntentFromBrief(brief)` adapts the mirror fields (`lookTarget`…`enterLocation`) back to the deterministic `SceneIntent` the prompt builders consume, and `intentBriefFromSceneIntent(detectIntent(input))` is the degraded fallback (movement/appointment/check seams empty) — both directions are lossless across the mirror fields. The three seam fields (`movement`, `appointment`, `check`) are recognized and stored now; their downstream resolvers (movement authority, scheduled arrivals, skill checks) are separate phase-4 specs.

## Extension checklist

Adding an attribute/meter/condition/fact-kind: edit the registry file → run `vitest contracts` (registry invariant tests) → done. If you also need it persisted distinctly (rare — most state rides in validated JSONB), see [database.md](database.md) for the migration workflow.
