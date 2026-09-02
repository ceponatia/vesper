import type { ImageWorldFact } from "@vesper/image-core";
import { attributeRegistry } from "../attributes";
import type { HairOcclusion } from "../items/hair-occlusion";
import { VISUAL_STATE_PRESENTATION_HAIRSTYLE_KIND_ID } from "../visual-state";
import type { VisualImageFact } from "./visual-digest";

/**
 * HAIR CONCEALMENT — what a character image prompt says about hair the worn
 * headwear fully hides (docs/images/character-prompts.md §Hair the headwear
 * conceals).
 *
 * The band itself is wardrobe state (`items/hair-occlusion.ts`); this module is
 * the image consequence of its strongest value, and nothing else. At `full` a
 * subject's authored hair facts are NOT visual truth for this render — a hijab
 * shows no auburn, no braid, no length — so the projection withholds them and
 * states one required fact in their place: the hair is fully covered, none is
 * visible. At `none` and `partial` some hair remains visible and the authored
 * facts stand exactly as they did.
 *
 * A LEAF: it names which visual facts are hair facts and builds the one
 * replacement fact. Where the rule is applied is the character adapter's join
 * (`character-adapter.ts`), the one place that holds both the selected facts
 * and the subject's resolved band.
 */

/** The body location every hair attribute and hair-worn presentation sits at. */
const HAIR_BODY_LOCATION_ID = "hair";

/** The projection owner of the concealment fact — this module, not a world owner. */
export const IMAGE_CHARACTER_HAIR_OWNER = "character.hair_occlusion";

/** The concealment fact's key suffix and source key. */
export const IMAGE_CHARACTER_HAIR_CONCEALMENT_MEMBER = "hair_concealment";

/**
 * The suppression reason an authored hair fact leaves under at `full`.
 *
 * A DESIGNED absence, like the age band withheld by ruling: the fact was
 * selected, valued and then deliberately not said, and provenance records that
 * rather than reporting a value nobody could resolve.
 */
export const IMAGE_CHARACTER_HAIR_CONCEALED = "character.hair.concealed";

/** The band at which the authored hair is withheld and the concealment fact stated. */
export function isHairConcealed(band: HairOcclusion): boolean {
  return band === "full";
}

/**
 * Whether one selected visual fact describes the subject's HAIR.
 *
 * Three structural tests, no value matching: a hair attribute (the registry's
 * `hair.*` group, every member of which sits at the `hair` body location), the
 * current hairstyle presentation, or any other fact whose body locus is the
 * hair — a located mark, wetness or a deposit on it, none of which a fully
 * enclosing headwear can show either.
 */
export function isHairVisualFact(fact: Pick<VisualImageFact, "kindId" | "locus" | "sourceRef">): boolean {
  if (fact.kindId === VISUAL_STATE_PRESENTATION_HAIRSTYLE_KIND_ID) return true;
  if (fact.locus.kind === "body" && fact.locus.locus.bodyLocationId === HAIR_BODY_LOCATION_ID) return true;
  const ref = fact.sourceRef;
  if (ref.kind === "appearance" && ref.ref.kind === "attribute") {
    return attributeRegistry.byId(ref.ref.attributeId)?.bodyLocationId === HAIR_BODY_LOCATION_ID;
  }
  return false;
}

/**
 * The one fact a subject at `full` states about their hair.
 *
 * Required, so no budget squeeze can drop it and re-expose hair the wardrobe
 * hides; its dialect wording is each endpoint's own, and the value is a neutral
 * descriptor for provenance. Priority just under the unit the garment facts
 * carry, so within the wardrobe band it FOLLOWS the headwear it explains.
 */
export function hairConcealmentFact(ref: string, subjectId: string): ImageWorldFact {
  return {
    key: `${ref}.${IMAGE_CHARACTER_HAIR_CONCEALMENT_MEMBER}`,
    concept: "subject.hair_concealment",
    value: "hair fully covered by the headwear; no hair visible",
    subjectRef: ref,
    semanticTags: ["hair_occlusion:full"],
    disposition: "required_visual",
    priority: 0.99,
    source: { owner: IMAGE_CHARACTER_HAIR_OWNER, key: IMAGE_CHARACTER_HAIR_CONCEALMENT_MEMBER, entityId: subjectId },
    truthFingerprint: "hair_occlusion:full",
  };
}
