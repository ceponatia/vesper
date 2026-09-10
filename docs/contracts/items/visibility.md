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

## A worn garment nothing lets through

The visual-state wardrobe projection tags a worn garment `wardrobe.concealed`
when **every** body location it covers sits under a worn piece on a strictly
higher layer whose own cover there reads `opaque` in the captured
effective-coverage read.

- **All of the coverage, not a share.** A bra whose band reaches below a cropped
  sweater is a visible bra, so the fraction an occlusion edge reports is exactly
  the wrong thing to threshold — 90% covered is still a garment somebody can see.
- **Layer is strict.** Equal layers do not stack (two base pieces sit side by
  side), and an absent layer on either piece takes that piece out of the
  comparison, which is why a wardrobe nobody layered conceals nothing.
- **Attaching accessories never conceal.** A necklace over a blouse hides no
  blouse; jewelry and eyewear attach rather than cover.
- **Every degraded path leaves the garment stated.** An unknown layer, an
  unreadable opacity, no captured evidence for the upper piece at that location,
  and a garment that covers nothing at all are each untagged. A visible garment
  a prompt omits is a wardrobe error a player cannot miss; a concealed garment a
  prompt mentions is a wasted clause.

**The tag is the whole interface, and it changes no wardrobe truth.** The garment
keeps its value, its coverage, its `covers` and `occludes` edges and its
continuity prior, because a bra under a sweater is still what she is wearing and
the next turn may take the sweater off. A consumer that describes a PICTURE reads
the tag and withholds the garment
([../../images/character-prompts.md](../../images/character-prompts.md) §The
character projection); a consumer that reasons about state ignores it and reads
on.
