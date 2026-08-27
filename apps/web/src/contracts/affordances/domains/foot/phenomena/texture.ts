import {
  defineAffordancePhenomenon,
  type AffordanceIntensityBand,
  type AffordanceResolution,
} from "../../../core";
import type { FootAffordanceFrame } from "../frame";
import { footwearCovers, footwearFilterTagAt } from "../footwear";
import { footPoseClosureAt } from "../support";
import { footSurfaceMechanics } from "../mechanics";
import { footSurfaceProfile, type FootTextureBand } from "../profile";
import {
  footLocusLocationId,
  footRepeatKey,
  footSuppressed,
  FOOT_INTERDIGITAL_CLOSED,
  FOOT_MATERIAL_BLOCKS_TOUCH,
  FOOT_NO_COMMITTED_CONTACT,
  FOOT_NO_TACTILE_CHANNEL,
  FOOT_SURFACE_UNPROFILED,
} from "./bands";

/**
 * `foot.surface_texture_contact` — what one region feels like, through whatever
 * is between.
 *
 * Three gates, in the order failure is most informative:
 *
 * 1. a committed contact places the touch on a region;
 * 2. the lane positively asserts a TACTILE channel. The audit records that
 *    neither lane has one (*"tactile, olfactory and gustatory channels are
 *    absent in both lanes"*), so this phenomenon is fixture-only until one ships
 *    — recorded, not worked around;
 * 3. something actually reaches the skin. A material stack that transmits no
 *    touch at all is not a muted texture, it is no texture.
 *
 * Tags stay relative and semantic. No coefficient, no unit-interval value and no
 * band threshold reaches the output — a narrator sees `firmer_ball`, never a
 * number it could turn into false precision.
 */

export const FOOT_SURFACE_TEXTURE_ID = "foot.surface_texture_contact";

/**
 * How notable each texture band is on bare skin. `smooth` earns as much as
 * `firm` because a startlingly smooth surface is as much a thing to notice as a
 * firm one; only the two extremes of the roughness scale are `strong`.
 */
const TEXTURE_INTENSITY: Readonly<Record<FootTextureBand, AffordanceIntensityBand>> = {
  smooth: "clear",
  fine: "subtle",
  firm: "clear",
  coarse: "strong",
  hard: "strong",
};

/** The comparative a tag leads with, one per band. */
const TEXTURE_WORD: Readonly<Record<FootTextureBand, string>> = {
  smooth: "smooth",
  fine: "soft",
  firm: "firmer",
  coarse: "rougher",
  hard: "hard",
};

const INTENSITY_LADDER: readonly AffordanceIntensityBand[] = ["subtle", "clear", "strong"];

/** One step down the ladder — what a filtered texture is worth. */
function damped(band: AffordanceIntensityBand): AffordanceIntensityBand {
  const index = INTENSITY_LADDER.indexOf(band);
  return INTENSITY_LADDER[Math.max(0, index - 1)] ?? "subtle";
}

export const FOOT_FILTERED_TAG_SUFFIX = "_filtered";
export const FOOT_MOISTURE_SOFTENED_TAG = "moisture_softened";

type TextureInput = Pick<
  FootAffordanceFrame,
  "profile" | "mechanics" | "contact" | "footwear" | "tactile" | "articulations"
>;

export const footSurfaceTextureContact = defineAffordancePhenomenon<FootAffordanceFrame, TextureInput>({
  id: FOOT_SURFACE_TEXTURE_ID,
  dependencies: [
    { key: "contact" },
    { key: "tactile" },
    { key: "condition", optional: true },
    { key: "footwear", optional: true },
    { key: "articulation", optional: true },
  ],
  selectInput: (frame) => ({
    profile: frame.profile,
    mechanics: frame.mechanics,
    ...(frame.contact === undefined ? {} : { contact: frame.contact }),
    ...(frame.footwear === undefined ? {} : { footwear: frame.footwear }),
    tactile: frame.tactile,
    articulations: frame.articulations,
  }),
  resolve: (input): AffordanceResolution => {
    const contact = input.contact;
    if (contact === undefined) return footSuppressed(FOOT_SURFACE_TEXTURE_ID, FOOT_NO_COMMITTED_CONTACT);
    if (!input.tactile) return footSuppressed(FOOT_SURFACE_TEXTURE_ID, FOOT_NO_TACTILE_CHANNEL);
    if (contact.transmission.tactileTransmission <= 0) {
      return footSuppressed(FOOT_SURFACE_TEXTURE_ID, FOOT_MATERIAL_BLOCKS_TOUCH);
    }

    const locus = contact.primary;

    // The spec's fixture-matrix case: between-toe access blocked by the current
    // articulation. A foot whose toes are pressed together has no space between
    // them to feel, and the pose owner is the only thing that can say so — which
    // is why this is a suppression rather than a quieter texture.
    //
    // Which foot's pose that is comes from the domain's ONE rule
    // (`footPoseClosureAt`): the touched foot's where the locus names one, two
    // agreeing feet where it does not. This used to fall back to the FIRST pose
    // in the list, so a single curled left foot could silence an observation
    // about a space that may well have been the right one's — the same inference
    // the mechanics rule had already been corrected to refuse (owner review,
    // finding 6).
    if (locus.surfaceId === "interdigital_spaces") {
      const posed = footPoseClosureAt(input.articulations, locus.side);
      if (posed.closure > 0) {
        return footSuppressed(FOOT_SURFACE_TEXTURE_ID, FOOT_INTERDIGITAL_CLOSED, posed.toes);
      }
    }

    const profile = footSurfaceProfile(input.profile, locus.surfaceId);
    const mechanics = footSurfaceMechanics(input.mechanics, locus.surfaceId, locus.side);
    if (profile === undefined || mechanics === undefined) {
      return footSuppressed(FOOT_SURFACE_TEXTURE_ID, FOOT_SURFACE_UNPROFILED, locus.surfaceId);
    }

    // Two owners have to AGREE before a bare-skin claim is made. The contact's
    // material list is lane-authored and answers "what did the resolver find
    // between these surfaces"; the wardrobe answers "is this surface inside
    // something". A contact that asserts direct skin at a locus the wardrobe
    // says is covered is a contradiction, and the conservative half wins —
    // otherwise a shoe would be unable to stop a bare-skin texture read.
    const covered = input.footwear !== undefined && footwearCovers(input.footwear, locus.surfaceId);
    const direct = contact.transmission.directSkinContact && !covered;
    const filterTag =
      input.footwear === undefined ? undefined : footwearFilterTagAt(input.footwear, locus.surfaceId);

    return {
      kind: "observation",
      id: FOOT_SURFACE_TEXTURE_ID,
      sourceLocationId: footLocusLocationId(locus),
      intensityBand: direct ? TEXTURE_INTENSITY[mechanics.textureBand] : damped(TEXTURE_INTENSITY[mechanics.textureBand]),
      semanticTags: [
        `${TEXTURE_WORD[mechanics.textureBand]}_${locus.surfaceId}`,
        ...(mechanics.moistureSoftened ? [FOOT_MOISTURE_SOFTENED_TAG] : []),
        // The register the touch arrives through — only when something IS between.
        ...(direct || filterTag === undefined ? [] : [`${filterTag}${FOOT_FILTERED_TAG_SUFFIX}`]),
      ],
      repeatKey: footRepeatKey({ phenomenon: "texture", contact, locus }),
    };
  },
});
