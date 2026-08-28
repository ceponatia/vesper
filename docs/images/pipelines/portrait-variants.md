# Portrait variants

Pose / outfit / expression / setting / `nsfw test` variants of the canonical avatar, rendered
as reference edits through **the New Variant picker's model** (the registry filtered to
`canEdit`; default `qwen/qwen-image-edit-2511`, shared with scene images). The identity
reference(s) come from the identity-pack service
([../identity-packs.md](../identity-packs.md) — provenance on `meta.identityReferences`, a
blocked pack refuses the render), and the instruction is prefixed with the **identity lock**
block: preserve face, hair, age, build, the `PORTRAIT_IDENTITY_LOCK` wording.

## The prompt is segments over the visual digest

`buildVariantSegments` (`server/images/variant-segments.ts`) runs the same standalone assembly
the avatar lane uses (`standalone-subject-visual.ts` — one snapshot of the character sheet, one
selection pass bound to this lane's fixed full-figure viewpoint, one digest realized from that
selection) under the variant policy: **age stated, full-figure frame, intimate never, exposure
omitted**.

The lane sets BOTH `prompt` and `intent.promptSegments`, which is safe here and only here
because the variant profiles run `instruction_edit`, the strategy that passes a base prompt
through unchanged. The lane also **derives its own age anchor** from the sheet rather than
being handed one, and **loads the character's default wardrobe** — not to name garments (the
reference image shows them) but because coverage drives the camera's per-location perception
and the exposure gate. A failed or unreadable coverage load degrades to fully covered, never to
a bare body. A digest the lane cannot build **refuses before provider spend** rather than
falling back to the legacy prose builder.

## What the digest adds is deliberately narrow

Owner ruling 2026-08-25: the digest contributes the body-shape anchors — species feature groups
and anatomy departures, the horns/wings/tail an edit model "corrects" away — and the cataloged
distinctive marks, and nothing else.

Hair, eye and skin color stay **unstated**: they come off the identity reference,
pixel-perfect, and a text anchor beside the picture only competes with it. Consequently this
lane carries **no route-owned residual attribute sheet** — unlike the avatar and scene lanes,
which describe a body from scratch — so the digest's mark clause is the only statement of a
mark and the clause resolver runs with an empty omit set.

The route still owns the identity lock (byte-identical to the constant the Qwen dialect
matches), the age anchor, the requested change as the `operation` segment, the "keep the same
outfit" line, and the quality tail. The row records the digest's `meta.visualState` provenance
at reserve time.

## Promotion

Variants accumulate in the character's portrait studio, and any variant can be promoted to
canonical avatar. **Promotion is owner-strict inside the service**
(`promoteVariant(characterId, imageId, ownerId)`): the route's `findOwnedCharacter` gate stays
as defense in depth, but the service re-matches BOTH the character row and the image row on
`ownerId` in the same query as the id before writing, and only then checks the
`entity_kind`/`entity_id` link and `status: ready`.

Ownership is never inferred from the polymorphic entity linkage — repointing an owned image at
someone else's public character buys nothing, the same trust boundary as the file-serving gate
in [../asset-registry.md](../asset-registry.md). Rejections return `{ ok: false, error }` with a
foreign row reported as a plain "not found" (no not-yours signal) and a `log.warn` diagnostic
(`images.promote.*`).

Variants are single-reference edits only: re-roll from the canonical portrait rather than
chaining edits, because drift compounds.

## The `nsfw test` anatomy bench

`nsfw test` is the studio's anatomy bench, and the only variant kind that chooses its own
model. It pairs the picked variant profile with the LoRA-capable wrapper
`qwen/qwen-image-edit-plus-lora` and the same builtin `image_loras` row the chat scene lane
uses, at that row's curated scale (`server/images/nsfw-lora.ts` assembles the pairing for both
lanes; the row's `allowedTasks` covers `scene` and `variant`).

Its prompt keeps the identity lock and the apparent-age anchor, adds the character sheet's
**intimate attributes stated exposure-free** as a route-owned `morphology` segment — the bench
exists to state the sheet's anatomy with no coverage state at all, so routing it through the
digest's coverage gate would delete it the moment the character owns a wardrobe — and omits the
"keep the same outfit" clause, because there (as for the `outfit` kind) the wardrobe IS the
operation's target.

Unlike the chat lane it **fails rather than degrades**: a missing wrapper row, LoRA row or
Civitai credential fails the image row with the leg's own message, because a tame render
silently substituted for an explicit one is exactly what the bench is testing against. The row
records the wrapper slug and the resolved LoRA id in `meta`.
