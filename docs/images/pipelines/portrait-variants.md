# Portrait variants

Pose / outfit / expression / setting / `nsfw test` variants of the canonical avatar, rendered
as reference edits through **the New Variant picker's model** (the registry filtered to
`canEdit`; default `qwen/qwen-image-edit-2511`, shared with scene images). The identity
reference(s) come from the identity-pack service
([../identity-packs.md](../identity-packs.md) — provenance on `meta.identityReferences`, a
blocked pack refuses the render). The prompt is the **compiled prompt program** over the
character's standalone cut (`buildVariantCut` → the lane's program, `server/images/variants.ts`),
the lane's only prompt path ([../character-prompts.md](../character-prompts.md)).

## The cut

`buildVariantCut` runs the same standalone assembly the avatar lane uses
(`standalone-subject-visual.ts` — one snapshot of the character sheet, one selection pass, one
digest realized from that selection) under the edit's fixed viewpoint, `VARIANT_EDIT_CAMERA`:
facing the viewer at **full-figure** distance, camera id `variant_edit`. A pose, setting or
bench restage is not a waist-up portrait, and below-waist morphology — a tail, digitigrade
legs — is exactly the anchor the edit must not lose, so a waist-up frame would cut it. The
digest's consent gate stays shut (`intimateAllowed: false`).

The lane **loads the character's default wardrobe** for one reason: the camera's per-location
perception and the exposure readout must come from the saved outfit, not from an assumed-bare
body. No garment **name** reaches this prompt — the reference image shows the clothes. A
failed or unreadable coverage load degrades to fully covered, never to a bare body
([avatars.md](avatars.md) §The wardrobe). A cut that throws **fails the row before provider
spend** with `images.variant.visual_cut_failed`.

## The program

Once the final resolved profile and the final identity references are known, the lane compiles
through the character seam as lane `variant`, task `variant`: a cast of one, every reference
bound to the subject (each one is the subject's own identity pack, so each names the one person
the variant is of), the operation `variantChangeOperation(kind, instruction)`, and
`refuseOnMissingRequired: true` — an identity-critical lane refuses on a lost anchor rather than
rendering a stranger.

Resolution runs on the **final** resolved profile and is keyed on the model slug as well as the
profile key. Every variant profile the picker offers shares the key `variant-standard` — Qwen
Edit 2511, Seedream 4.5, Seedream 5 Lite, Wan 2.7, SDXL PuLID — and each resolves its own
model's dialect; a binding keyed on the profile alone would hand one endpoint's packs to the
other four. The compiled prompt describes its references and picks its identity-lock wording by
their count, so it cannot be built before the final send list is known.

What reaches the provider is `characterPromptTransport(compiled)`: the compiled positive text —
also the row's stored `prompt` — plus the compiled exclusions on the normalized
`controls.negativePrompt`, so they reach a provider only through the version's own probed
field. Profile, references, target, LoRA decisions and every other control are the lane's own.

A render with nothing to compile — demo mode, no resolved model, a cut that would not
assemble, a failed bench route, a refused pack — compiles no program; each of those fails or
draws its own way. A compiled render records `meta.promptProgram` and `meta.worldState` beside
the `meta.visualState` provenance the cut recorded at reserve time.

| Answer     | What the lane does                                                                                                    |
| ---------- | --------------------------------------------------------------------------------------------------------------------- |
| `compiled` | sends exactly the compiled prompt and the references it planned                                                       |
| `refused`  | fails the row before provider spend with the program's own refusal                                                    |
| `unbound`  | fails the row before spend — `images.variant.program_unbound` (warn) — naming the model, task and profile key to bind |

A program that resolves a binding and then cannot compile never falls back to anything: a
bound lane that quietly rendered something else would hide a configuration fault behind an
acceptable-looking picture.

## What the digest adds is deliberately narrow

Owner ruling 2026-08-25: the digest contributes the body-shape anchors — species feature groups
and anatomy departures, the horns/wings/tail an edit model "corrects" away — and the cataloged
distinctive marks, and nothing else.

Hair, eye and skin color stay **unstated**: they come off the identity reference,
pixel-perfect, and a text anchor beside the picture only competes with it. The subject named
by the required identity reference carries the seam's synthesized **identity anchor** instead,
and the bound endpoint's dialect words the lock
([../character-prompts.md](../character-prompts.md) §Identity on a reference-anchored render).
The apparent-age claim is the adapter's, required and text-authoritative
([avatars.md](avatars.md) §Apparent age).

## The change contract

The requested change reaches the program as the operation's **change contract**
(`characterChangeContract`), never as prose the lane wrote: the admin's instruction is its
value, and the kind's concept (`VARIANT_CHANGE_CONCEPTS` — `pose` → `subject.pose`, `outfit` →
`subject.wardrobe`, `expression` → `subject.expression`, `setting` → `location.identity`,
`nsfw_test` → `subject.pose`) is the sole input to the **preserve set**: every required anchor
whose concept the change does not name is preserved, so an `outfit` variant releases the
wardrobe and a pose variant keeps it. The concept never reaches the prompt text; it rides as
claim metadata into the program fingerprint.

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

`nsfw test` (`NSFW_TEST_VARIANT_KIND`) is the studio's anatomy bench, and the only variant kind
that chooses its own model. It pairs the picked variant profile with the LoRA-capable wrapper
`qwen/qwen-image-edit-plus-lora` and the same builtin `image_loras` row the chat scene lane
uses, at that row's curated scale (`server/images/nsfw-lora.ts` assembles the pairing for both
lanes; the row's `allowedTasks` covers `scene` and `variant`). The swap is decided **before**
the row is reserved, so the row records the model it runs on, and binding resolution runs on
the wrapper — which carries a binding and a delta-edit dialect of its own rather than borrowing
2511's row.

Unlike the chat lane it **fails rather than degrades**: a missing wrapper row, LoRA row or
Civitai credential fails the image row with the leg's own message, because a tame render
silently substituted for an explicit one is exactly what the bench is testing against. A
failed bench route compiles no program either — the fallback profile is not the model the
render would have run on. The row records the wrapper slug and the resolved LoRA id in `meta`.
