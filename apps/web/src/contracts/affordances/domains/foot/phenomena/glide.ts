import {
  defineAffordancePhenomenon,
  type AffordanceIntensityBand,
  type AffordanceResolution,
  type UnitInterval,
} from "../../../core";
import {
  footGlideResponseOf,
  FOOT_CATCH_CALLUS_MIN,
  FOOT_CATCH_FRICTION_MIN,
  type FootGlideResponse,
} from "../friction";
import type { FootAffordanceFrame } from "../frame";
import { footSurfaceMechanics, type FootSurfaceEffectiveMechanics } from "../mechanics";
import { footSurfaceProfile, type FootSurfaceStructuralProfile } from "../profile";
import type { FootLocusRef } from "../topology";
import {
  footLocusLocationId,
  footPathSurfaces,
  footRepeatKey,
  footSuppressed,
  FOOT_NO_COMMITTED_CONTACT,
  FOOT_NO_SLIDING_MOTION,
  FOOT_CROSSES_TAG_PREFIX,
  FOOT_SURFACE_UNPROFILED,
  FOOT_UNKNOWN_SURFACE_STATE,
} from "./bands";

/**
 * `foot.glide_response` — what a sliding contact actually does.
 *
 * ## The whole point is that there is no global rule
 *
 * Friction comes from `friction.ts`'s per-substance curves, where water, sweat,
 * oil, lotion, and a wet garment each have their own calibrated shape and small
 * amounts of some of them INCREASE drag. This phenomenon adds no physics of its
 * own; it turns the per-locus answer into the spec's six outcomes and picks the
 * one the path is actually about.
 *
 * ## Two hard gates
 *
 * - **unknown surface state suppresses.** If any locus on the path has no
 *   moisture answer, the read is silent. Falling back to the dry number would be
 *   the exact laundering the plan forbids: *"Unknown is not the same as dry,
 *   cool, clean, or unmarked."*
 * - **no lubricant source, no `slippery`.** Enforced in `footGlideResponseOf`,
 *   which floors an unlubricated surface at `smooth_glide` however low its skin
 *   friction runs.
 *
 * ## Which locus wins
 *
 * A palm sliding arch → heel gets ONE observation, and the rule is in two steps:
 *
 * 1. **A qualifying catch anywhere on the path wins**, whatever the rest of the
 *    movement did. Picking the grippiest locus first and only then asking
 *    whether it catches loses a real heel snag the moment something else
 *    out-frictions it — grit on an arch (4_500 + 3_000) beats a callused heel
 *    (7_000) and the snag vanishes from the read.
 * 2. **Otherwise the grippiest locus wins**, because a glide that ends in drag
 *    is a glide with drag in it, and reporting the easy part would describe the
 *    half of the movement nobody notices.
 *
 * Within each step ties break on path order, so the pick is a pure function of
 * the read and survives a retake.
 */

export const FOOT_GLIDE_RESPONSE_ID = "foot.glide_response";

/** How notable each outcome is. The ordinary middle of the scale is `subtle`. */
const GLIDE_INTENSITY: Readonly<Record<FootGlideResponse, AffordanceIntensityBand>> = {
  controlled_glide: "subtle",
  smooth_glide: "subtle",
  dragging: "clear",
  slippery: "clear",
  grip_breaks: "strong",
  rough_surface_catch: "strong",
};

interface GlideCandidate {
  readonly locus: FootLocusRef;
  readonly profile: FootSurfaceStructuralProfile;
  readonly mechanics: FootSurfaceEffectiveMechanics;
  /** Already narrowed: a candidate is only built once its friction is KNOWN. */
  readonly friction: UnitInterval;
}

/**
 * A surface rough enough, and gripping hard enough, to catch a sliding hand.
 *
 * BOTH conditions: a callused heel under a thick film of oil does not catch, and
 * a high-friction soft arch is drag rather than a catch. That is what keeps
 * `rough_surface_catch` a statement about a place instead of a synonym for
 * `dragging`.
 */
function catchesHere(candidate: GlideCandidate): boolean {
  return candidate.profile.callusBand >= FOOT_CATCH_CALLUS_MIN && candidate.friction >= FOOT_CATCH_FRICTION_MIN;
}

/** The higher-friction of two candidates; ties keep the earlier one on the path. */
function grippier(left: GlideCandidate | undefined, right: GlideCandidate): GlideCandidate {
  return left === undefined || right.friction > left.friction ? right : left;
}

type GlideInput = Pick<FootAffordanceFrame, "profile" | "mechanics" | "contact">;

export const footGlideResponse = defineAffordancePhenomenon<FootAffordanceFrame, GlideInput>({
  id: FOOT_GLIDE_RESPONSE_ID,
  dependencies: [{ key: "contact" }, { key: "condition" }],
  selectInput: (frame) => ({
    profile: frame.profile,
    mechanics: frame.mechanics,
    ...(frame.contact === undefined ? {} : { contact: frame.contact }),
  }),
  resolve: (input): AffordanceResolution => {
    const contact = input.contact;
    if (contact === undefined) return footSuppressed(FOOT_GLIDE_RESPONSE_ID, FOOT_NO_COMMITTED_CONTACT);
    if (contact.motion !== "sliding") return footSuppressed(FOOT_GLIDE_RESPONSE_ID, FOOT_NO_SLIDING_MOTION);

    const path = footPathSurfaces(contact);
    const candidates: GlideCandidate[] = [];
    for (const locus of path) {
      const profile = footSurfaceProfile(input.profile, locus.surfaceId);
      const mechanics = footSurfaceMechanics(input.mechanics, locus.surfaceId, locus.side);
      if (profile === undefined || mechanics === undefined) {
        return footSuppressed(FOOT_GLIDE_RESPONSE_ID, FOOT_SURFACE_UNPROFILED, locus.surfaceId);
      }
      if (mechanics.effectiveFriction === undefined) {
        return footSuppressed(FOOT_GLIDE_RESPONSE_ID, FOOT_UNKNOWN_SURFACE_STATE, locus.surfaceId);
      }
      candidates.push({ locus, profile, mechanics, friction: mechanics.effectiveFriction });
    }

    // A catch ANYWHERE on the path wins the observation, whatever the rest of the
    // movement did. The alternative — pick the grippiest locus first, then ask
    // whether that one catches — loses a real heel snag the moment some other
    // locus out-frictions it (grit on an arch beats a callused heel), and the
    // snag is the thing a reader notices. Among several catches, and among
    // several non-catches, the grippiest wins; ties keep path order, so the pick
    // is a pure function of the read.
    const caught = candidates.filter((candidate) => catchesHere(candidate)).reduce<GlideCandidate | undefined>(grippier, undefined);
    const decisive = caught ?? candidates.reduce<GlideCandidate | undefined>(grippier, undefined);
    if (decisive === undefined) return footSuppressed(FOOT_GLIDE_RESPONSE_ID, FOOT_NO_COMMITTED_CONTACT);

    const response: FootGlideResponse =
      caught === undefined
        ? footGlideResponseOf({ friction: decisive.friction, lubricating: decisive.mechanics.lubricating })
        : "rough_surface_catch";

    return {
      kind: "observation",
      id: FOOT_GLIDE_RESPONSE_ID,
      sourceLocationId: footLocusLocationId(decisive.locus),
      intensityBand: GLIDE_INTENSITY[response],
      semanticTags: [
        response,
        decisive.locus.surfaceId,
        // The substance is named only when one is actually present AT THE
        // DECISIVE LOCUS, so a catch on a dry heel never borrows the lotion that
        // made the arch easy.
        ...(decisive.mechanics.dominantSubstance === undefined
          ? []
          : [`via_${decisive.mechanics.dominantSubstance.kind}`]),
        // The rest of the path, so an observation about a catch still records
        // that the movement crossed somewhere else first.
        ...(path.length > 1 ? path.map((locus) => `${FOOT_CROSSES_TAG_PREFIX}${locus.surfaceId}`) : []),
      ],
      repeatKey: footRepeatKey({ phenomenon: "glide", contact, locus: decisive.locus }),
    };
  },
});
