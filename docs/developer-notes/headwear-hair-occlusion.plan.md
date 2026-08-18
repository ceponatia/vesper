# Headwear that actually covers hair

Status: draft (planned 2026-08-18)

Outcome: A player can put a character in a hijab and get an image with no hair
showing, while a baseball cap on the same character still leaves her hair
visible.

## Why

Dress a character in a headscarf and the picture comes back with her hair
flowing out from under it. The sheet says the hair is auburn and waist-length,
the image prompt repeats that faithfully, and nothing anywhere says the
headscarf is supposed to hide it. The result contradicts the outfit the player
chose, and it contradicts it hardest for the garments where covering hair is the
entire point of the garment.

The wardrobe does record that headwear sits over hair — that is how a hat is
drawn on top of a hairpin rather than under it. What it cannot record is *how
much* of the hair survives underneath. A tiara, a baseball cap and a hijab are
stored identically: all three "cover hair". Any rule built on that fact alone
either leaves every headwear showing hair (today's behavior) or strips hair from
characters in sun visors.

So the missing information is not coverage. It is **enclosure** — whether a piece
of headwear rests in the hair, sits over the crown of it, or wraps it away
entirely. Nothing in the item model captures that today.

## What the owner gets

- **Headwear that hides hair when it should.** A headscarf, wimple, turban or
  helmet renders with the hair genuinely gone — not merely unmentioned, but
  positively stated as covered, because an image model left to guess paints hair
  by default.
- **Headwear that does not hide hair when it shouldn't.** Caps, hats, beanies and
  hoods keep the hair the player authored: colour, length and texture still read,
  because they still show below the brim. Headbands, hairpins, ribbons, tiaras
  and visors change nothing at all.
- **A choice when the garment is unusual.** Most items need no decision — the
  garment noun already implies the answer. When it doesn't, the item's editor
  carries an explicit setting, so a headscarf deliberately worn with a fringe
  showing can say so.

## Boundaries

### In scope

- An enclosure setting on headwear, defaulted from the garment noun and
  overridable per item.
- The avatar and scene image prompts honouring it, including the positive
  statement of concealment that makes an image model comply.
- The reference-anchored render path no longer insisting on hair it cannot see.
- The item editor surfacing the setting, and the forge filling it from what it
  wrote in the garment's description.

### Non-goals

- **Hair that changes state under headwear** — flattened, hat-creased, pulled
  through a cap. That is appearance simulation, not concealment;
  [deferred.plan.md](deferred.plan.md) is where it goes if it is ever wanted.
- **Hood up versus hood down.** A hood occludes only when raised, which makes
  this a garment *presentation* question, and presentation belongs to
  [clothing-state-graph.plan.md](clothing-state-graph.plan.md). This plan leaves
  the seam for it (see the spec's resolver input) and assumes worn-as-described.
- **Face covering.** Veils, niqabs and masks conceal face rather than hair, and
  the face is a different body location with different consequences for identity
  packs. Not touched here.
- **Prose.** The narrator already describes what a character is wearing from the
  item's own name and description. This plan changes image prompts only.

## Slices

- **Slice 1 — the wardrobe knows the difference.** Status: next. Headwear
  carries an enclosure band, defaulted from the garment noun, with a pure
  resolver that answers "how concealed is this character's hair right now". The
  missing garment nouns a player would reach for — visor among them — join the
  vocabulary. Nothing changes on screen yet.
- **Slice 2 — images stop showing hair that is covered.** Status: queued. The
  avatar and scene prompts drop hair description for fully enclosed hair and
  state the concealment positively. This is the slice that fixes the reported
  problem.
- **Slice 3 — the reference render stops fighting it.** Status: queued. The
  identity-anchor phrase and the face-turned-away fallback both currently insist
  on preserving hair from the reference image; both learn to fall back to
  features that are still visible when the hair is covered.
- **Slice 4 — authors can override it.** Status: queued. The item editor shows
  the setting for headwear, and the forge sets it from the garment it just
  described.

## Where the work stands

- **[headwear-hair-occlusion.spec.md](headwear-hair-occlusion.spec.md)** — not
  started.

## Success criteria

Judged on rendered images, not on code:

- The same character, rendered twice from the same sheet, shows **no hair** in
  the seeded black hijab and **her authored hair** in a baseball cap.
- A character in a headband, tiara or visor renders exactly as they do today —
  this work is invisible for every non-enclosing piece.
- A scene render that identity-locks to a bare-headed reference portrait still
  hides the hair when the scene's outfit encloses it, and still holds the
  character's face.

The first two are a paired bench run the owner triggers on the deploy; record the
verdict in `headwear-hair-occlusion.trial.md` when it runs, since an image-quality
claim needs observed evidence rather than a passing test.

## Open questions

- **Does full enclosure mean no hair at all, or a deliberate fringe?** Many
  headscarf styles show hair at the front on purpose. The proposal is that full
  means none, and a fringe is authored as the partial band with the detail in the
  description — but that decides how the default reads for every hijab in the
  library ([detail](headwear-hair-occlusion.spec.md)).
- **Which band does a visor take?** It has no crown at all, so it hides less than
  a cap, yet it does sit across the fringe
  ([detail](headwear-hair-occlusion.spec.md)).
- **Is a positive concealment sentence enough, or does this need negative-prompt
  steering too?** Negative support is per-model and is being worked in
  [image-render-quality.plan.md](image-render-quality.plan.md); leaning on it
  would couple the two plans ([detail](headwear-hair-occlusion.spec.md)).

## Technical companion

[headwear-hair-occlusion.spec.md](headwear-hair-occlusion.spec.md) — contracts,
the band table, the resolver, and the prompt-path changes.
