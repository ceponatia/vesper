# Headwear hair occlusion — technical spec

Status: companion to [headwear-hair-occlusion.plan.md](headwear-hair-occlusion.plan.md)

The implementation contract for coding agents. Product scope and open questions
live in the plan; this document is how its decisions get built.

## Scope

This spec governs one new garment property — how completely a piece of headwear
encloses hair — its default table, the pure resolver over a worn set, and the
three image-prompt paths that read it. It deliberately leaves alone: the wardrobe
visibility resolver (`contracts/items/visibility.ts`), which keeps answering the
layering question exactly as it does now; the narrator prompt paths, which
describe garments from authored text; and garment presentation, which owns
hood-up/hood-down.

## Implementation status

| Slice                              | State                                          |
| ---------------------------------- | ---------------------------------------------- |
| 1 — enclosure band + resolver      | not started                                    |
| 2 — image prompts honour it        | not started                                    |
| 2b — negative block                | not started; blocked on render-quality slice 3 |
| 3 — reference-anchored paths       | not started                                    |
| 4 — editor override + forge        | not started                                    |

### Owner rulings (2026-08-18)

- **Full enclosure means no hair at all.** A hijab is worn covering every strand
  for modesty; rendering a stray fringe misrepresents the garment. `full`
  therefore emits no `hair.*` value and no hair-adjacent phrasing. A style that
  deliberately shows hair at the front is a different garment as far as this
  model is concerned, and is authored as `partial`.
- **A visor shows hair.** It takes `none`, not `partial`: it has no crown, so
  nothing about the hair mass is hidden. Sitting across the fringe does not
  count as enclosing.
- **Negative-prompt steering is wanted, not optional.** The positive concealment
  sentence is necessary but is the weaker half of the instruction. See
  [Negative steering](#negative-steering) for what this binds and what it waits
  on.

## Why coverage cannot carry this

Recorded here because it is the first thing a reader will propose, and the answer
is not obvious.

Every headwear subtype already declares `coverage: ["hair"]` — see
`contracts/items/subtypes/headwear.ts`. That is correct and must not change. It
is what places a hat *above* the hair in `resolveWardrobeVisibility`, and what
makes a hat occlude a hairpin worn beneath it. Coverage answers **"is this the
outermost garment at this location"**, which is a layering question.

Coverage does not answer **"how much of what is underneath still shows"**. For
the torso that second question already has its own axis — `RegionExposure`
(`covered` / `sheer` / `bare`) — computed alongside coverage rather than from it.
The head has no such axis: `RegionExposure` has exactly four regions
(torso, pelvis, legs, feet) and none of them is the head.

The torso axis is also the wrong *vocabulary* to copy. `RegionExposure` grades
opacity, and opacity is not the discriminator here: a baseball cap is fully
opaque yet leaves most hair visible, while a chiffon hijab is semi-sheer yet
conceals. The discriminator is **enclosure** — does the piece rest in the hair,
cap the crown of it, or wrap it away.

One more constraint shapes the default table. The registry comment on
`headwear` (`coverage: ["hair"]`, "hair, not head: a hat does not cover the
face") and its pinning test exist because `head` expands to face, eyes, nose and
lips. Nothing in this work may widen a headwear template to `head`; the new
property is orthogonal to coverage and changes no coverage value.

## Contracts

### The band

```ts
// contracts/items/hair-occlusion.ts — pure, no IO
export const hairOcclusionBands = ["none", "partial", "full"] as const;
export type HairOcclusion = (typeof hairOcclusionBands)[number];
```

| Band      | Means                                        | Hair in the image           |
| --------- | -------------------------------------------- | --------------------------- |
| `none`    | Rests in or on the hair                      | Fully visible               |
| `partial` | Caps the crown; sides and length still show  | Visible, crown hidden       |
| `full`    | Wraps the hair away                          | None visible                |

### Where it is declared

- `ClothingSubtype` (`contracts/items/subtypes/types.ts`) gains
  `hairOcclusion?: HairOcclusion` — the default for that garment noun. Absent on
  every non-headwear vocabulary.
- `ItemDefinition` (`contracts/items/item.ts`) gains
  `hairOcclusion?: HairOcclusion` — the per-item override. Absent means "take the
  subtype default".

Both are optional, so no existing stored row is invalid and no migration is
required to read one.

### Default table

Set on the existing entries in `contracts/items/subtypes/headwear.ts`. Coverage
values stay exactly as they are.

| Subtype                                           | Band      |
| ------------------------------------------------- | --------- |
| `headband`, `hairpin`, `ribbon`, `tiara`, `crown` | `none`    |
| `veil`                                            | `none`    |
| `hat`, `cap`, `beanie`, `hood`                    | `partial` |
| `headscarf`, `helmet`                             | `full`    |

`veil` takes `none` deliberately: a veil hangs over or behind rather than
enclosing, and the face-covering veil is out of scope (plan non-goal).

New subtypes joining the vocabulary, each with its coverage template:

| Subtype    | Coverage           | Band      |
| ---------- | ------------------ | --------- |
| `visor`    | `["hair"]`         | `none`    |
| `bandana`  | `["hair"]`         | `partial` |
| `turban`   | `["hair", "ears"]` | `full`    |
| `wimple`   | `["hair", "ears"]` | `full`    |
| `snood`    | `["hair"]`         | `full`    |
| `swim_cap` | `["hair", "ears"]` | `full`    |

## Ownership rules

- `contracts/items/hair-occlusion.ts` is the only module that defines the band
  vocabulary and the resolver. No consumer re-derives a band from a subtype id or
  from an item name.
- The subtype table is the only source of defaults. An item's `hairOcclusion` is
  an override and is authoritative when present.
- Coverage remains authoritative for layering and for `RegionExposure`. This
  property never feeds `resolveWardrobeVisibility` or `exposedRegions`, and those
  two never read it.
- Image prompt builders read the resolver's output. They never inspect a
  garment's subtype directly — that would reintroduce the coupling this module
  exists to remove.

## Algorithms

### Resolving a worn set

```ts
export function resolveHairOcclusion(
  worn: readonly HairOcclusionInput[],
): HairOcclusion
```

`HairOcclusionInput` carries `{ subtype?: string; hairOcclusion?: HairOcclusion }`
— deliberately the smallest shape that answers the question, so both the avatar
wardrobe row and the chat garment row can be mapped onto it without either
module importing the other.

1. Per garment: `item.hairOcclusion` if set, else the subtype's band, else
   `none`. An unrecognized subtype resolves `none` and emits a diagnostic.
2. Across garments: **the strongest band wins** (`full` > `partial` > `none`). A
   hijab worn under a sun hat is still `full`.
3. Empty input resolves `none`.

The function takes a worn *list*, not a character, so the presentation seam the
plan promises is a matter of what the caller passes: when
`clothing-state-graph` can say a hood is down, the caller filters or downgrades
that row before calling. No signature change will be needed.

### What each band does to the prompt

The band changes which `hair.*` attributes reach the prompt, and what is said in
their place. The attribute ids are `hair.color`, `hair.length`, `hair.texture`,
`hair.density`, `hair.strand_thickness`, `hair.condition`, `hair.arrangement`,
`hair.style`.

| Band      | Hair attributes emitted | Positive phrase                     | Negative block |
| --------- | ----------------------- | ----------------------------------- | -------------- |
| `none`    | All                     | None                                | None           |
| `partial` | All                     | None                                | None           |
| `full`    | None                    | An affirmative concealment sentence | `hair-covered` |

`partial` is deliberately identical to `none` in effect. It exists so that `full`
has something to contrast against, so the hood-up work has a band to land in, and
so a later slice can add crown-specific phrasing without inventing a vocabulary
then.

**The affirmative sentence is load-bearing.** Dropping the hair attributes is not
sufficient: an image model reads silence as "unspecified" and paints hair anyway.
At `full` the prompt states the concealment in the positive — the garment's own
noun, then the absence — for example `hair completely covered by the headscarf,
no hair visible`. It is built from the resolved garment's name so it never
hardcodes a garment noun.

### Negative steering

What exists today, since the shape of this work depends on it and the surface is
easy to misread in both directions:

- **The transport is complete.** Negative prompts have a per-model capability
  binding (`advancedCapabilities.controls.negativePrompt`), control mapping onto
  each model's own field name, override precedence in
  `compile-profile-plan.ts`, trial hashing, and honest reporting that counts a
  model row's `extraInput` constant as a real negative
  (`resolvedNegativePrompt`). None of that needs building.
- **The content is static, and mostly empty.** The only sources are an
  owner-typed string on a model profile (which defaults to `""`), a model row's
  `extraInput` constant, and identity-pack trial fixtures. The reviewed rows send
  `negative_prompt: ""` deliberately, to neutralize a wrapper's hidden
  boilerplate. Nothing anywhere composes a negative from what is actually in the
  picture.

So the gap is not support — it is that negatives are a static per-model setting
rather than a per-render consequence of the subject.

**This plan does not close that gap, and must not.** Compositional negative
steering is owned by
[image-render-quality.plan.md](image-render-quality.plan.md), whose slice 3
builds named context-composed blocks with conflict linting, and whose standing
rule is that the context-free render seam never invents negative content. A
bespoke hair negative bolted on here would be a second owner for the same
mechanism and would violate that rule on its way in.

What this spec contributes is one **named block**, on that plan's terms:

| Field       | Value                                                          |
| ----------- | -------------------------------------------------------------- |
| Block id    | `hair-covered`                                                 |
| Emitted when | `resolveHairOcclusion` returns `full`                          |
| Content     | Visible-hair terms — loose hair, strands, fringe, ponytail      |
| Suppressed when | The character has no hair to begin with (bald, non-haired species) |

The conflict linter is the reason this composes safely rather than by luck. A
`hair-covered` negative on a render whose positive prompt still described the
character's hair is exactly the positive/negative collision that linter exists to
reject. That rejection is a feature: it makes the two halves of slice 2
structurally inseparable, so the negative can never be added while the positive
still leaks hair.

### The reference-anchored paths

Two places currently assert hair against a reference image and will contradict a
`full` result. Both are in scope for slice 3.

- `identityAnchorSummary` (`server/images/prompts-appearance.ts`) whitelists
  `hair.color`, `hair.length` and `hair.style` into the identity-anchor phrase.
  At `full`, those three drop from the whitelist for that render; the remaining
  anchors (skin tone, eyes, lips, face shape) carry the identity.
- `server/images/prompts-scene-render.ts` falls back to "preserve the hair color
  and style, build and skin tone exactly from the reference" when the subject's
  face is turned away or out of shot. At `full` that sentence is preserving
  something the shot cannot show; it must fall back to build and skin tone plus
  the garment.

The interaction is the sharp edge of this whole plan: a character whose canonical
portrait is bare-headed, rendered into a scene wearing a hijab, has a reference
image that disagrees with the wardrobe. The wardrobe wins, and the reference is
still authoritative for the face.

## Persistence

No migration. `hairOcclusion` lives inside the existing `items.definition` JSONB
alongside the other facets that `composeItemDefinition` reads
(`category`, `subtype`, `wearer`, `color`, `layer`, `opacity`, …), and the field
is optional, so existing rows parse unchanged and resolve through their subtype.

Existing library rows need no backfill: the seeded headwear already carries
correct subtypes (`Black Hijab` is `headscarf`, `Pink Satin Headband` is
`headband`, `Ice Crystal Tiara` is `tiara`), which is precisely why the subtype
table is the right place for the default.

## Resilience

Per `docs/resilience.md`, every boundary parses with `parseOr` and every
degradation names its code.

| Situation                                | Degrades to | Diagnostic                          |
| ---------------------------------------- | ----------- | ----------------------------------- |
| Stored `hairOcclusion` not in the band list | Subtype default | `items.hair_occlusion.unknown_band` |
| Headwear item with an unknown subtype    | `none`      | `items.hair_occlusion.unknown_subtype` |
| Headwear item with no subtype at all     | `none`      | none — legitimate, not a failure    |

Every degraded path resolves toward showing hair. Wrongly showing hair is
today's behavior and is recoverable by the author; wrongly erasing it silently
destroys authored appearance in every image of that character.

## Code organization

- `contracts/items/hair-occlusion.ts` — new. Band vocabulary, default lookup,
  `resolveHairOcclusion`. Re-exported from the `contracts/items` barrel and
  through `contracts/index.ts` like its siblings.
- `contracts/items/subtypes/headwear.ts` — bands added to existing entries, new
  subtypes appended.
- `contracts/items/subtypes/types.ts`, `contracts/items/item.ts` — the two
  optional fields.
- `server/images/prompts-avatar.ts` — filter `hair.*` at `full` beside the
  existing `chest.hair` exposure rule, which is the precedent to follow.
- `server/images/prompts-appearance.ts` — same filter for the scene path, plus
  the identity-anchor whitelist change.
- `server/images/prompts-scene-render.ts` — the face-not-visible fallback.
- `components/library/` item editor — the override control, shown only for
  headwear.

## Fixtures and tests

Pure suite (`pnpm test`) unless noted:

- **Band resolution** — each subtype resolves its documented band; an item
  override beats its subtype; strongest-band-wins across a worn set; empty input
  is `none`.
- **The three degradations above** — each asserts the fallback **and** the
  diagnostic code, per the resilience rule.
- **Coverage is untouched** — a headwear item's coverage and its resolved
  wardrobe visibility are byte-identical before and after this work. This is the
  regression that would otherwise go unnoticed, since the two properties look
  related and are not.
- **Prompt shape** — a `full` character's avatar prompt contains no `hair.*`
  value and does contain the concealment phrase; a `partial` character's prompt
  is unchanged from today's output; the identity anchor omits hair terms at
  `full` and keeps them otherwise.
- **Negative block** (slice 2b) — `hair-covered` is emitted at `full` and at no
  other band, is suppressed for a character with no hair, and a render whose
  positive prompt still names hair is **rejected** by the conflict linter rather
  than sent. That last case is the one worth writing first: it is what keeps the
  two halves of the instruction from drifting apart.
- **Rendered evidence** — not a test. The paired bench run named in the plan's
  success criteria, recorded in `headwear-hair-occlusion.trial.md`.
