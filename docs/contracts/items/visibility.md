[← Items and wardrobe](README.md)

# Visibility and coverage

## The visibility rule

Per body location:

| State   | When                                                |
| ------- | --------------------------------------------------- |
| visible | The highest-layer item covering that location.      |
| hidden  | Any item beneath a covering one.                    |
| hinted  | A hidden item where *everything* above it is sheer. |

It is implemented once in `items/visibility.ts` — `resolveWardrobeVisibility` for the occlusion
rule, `exposedRegions` → `RegionExposure` for per-region bare/sheer/covered, plus the shared
`FULLY_COVERED` constant and the `intimateRegionsBare` predicate — and used by the chat prompt
builders, the chat state extraction, image prompts, and the UI.

## How the chat lane feeds it

The **character-chat lane** feeds it via `resolveChatWardrobe` (`server/engine/chat-wardrobe.ts`):
the chat's worn item ids run through `exposedRegions` for coverage-computed exposure and
`wardrobeOutfitText` for the rendered garment phrase
([../../character-chat/wardrobe.md](../../character-chat/wardrobe.md)).

The pure garment-phrase matcher and worn-list reducer that the chat archivist's add and remove
proposals fold through live in `items/chat-wardrobe.ts` (`matchGarment` /
`applyWornGarmentChanges`).

`matchGarment` is **identity-aware**: a phrase naming a garment in the noun registry
(`items/garment-nouns.ts`) only matches candidates of the same canonical identity — both sides fold
through `garmentIdentitiesIn`, so plurals, aliases and spaced compounds ("boot"/"boots",
"t-shirt"/"tee", "tank top") resolve, and shared material or color can never take off the wrong
garment type. Raw name and description token overlap then ranks the same-type candidates, and
remains the whole match for garments outside the registry.

Free text is wardrobe too: how prose resolves to coverage rows is
[garment-nouns.md](garment-nouns.md).

## Hair occlusion is not coverage

How much hair worn headwear hides is a separate band (`none` · `partial` · `full`), resolved
once per subject and carried with the wardrobe data rather than read from coverage — a cap and a
hijab both cover `hair`. [README.md](README.md) §Hair occlusion owns it; nothing in the
visibility rule or the effective-coverage read consults it.

## Effective coverage — the final read

The visibility rule answers "which garment does the eye reach here". A second, finer question —
"does that garment still **conceal** what is under it?" — is the **effective-coverage read**
(`items/effective-coverage-read.ts`): `opaque` · `hinted` · `exposed` per body location, with the
contributing garment regions as evidence.

The vocabulary and persisted shape live here because the wardrobe owns coverage; the
**derivation** is the affordance layer's, because it needs current saturation-dependent opacity
(`contracts/affordances/domains/garment`). One direction only: items never import affordances.

Two rules worth knowing:

- **Layers add cover; they never subtract it.** A location's band comes from the most-concealing
  region reaching it, so a soaked-transparent shirt over a dry camisole leaves the chest `opaque`.
- **It is captured, not recomputed.** The chat lane stores the read on the garment store
  (`ChatGarmentStore.coverage`, keyed by garment actor handle), so narration, body affordances,
  retakes, and images share one answer rather than each deriving their own from slightly different
  moments. A location no garment reaches has no entry — bare skin is `exposedRegions`' answer, not
  this read's.
