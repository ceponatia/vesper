import type { GarmentRegionEffectiveMechanics } from "../mechanics";
import type { GarmentAffordanceFrame } from "../frame";
import { garmentRegionVisibility } from "../frame";
import type { GarmentRegionStructuralProfile } from "../profile";
import { isIntimateBodyLocation } from "./bands";

/**
 * The joins every garment phenomenon needs: a region's structure beside its
 * current mechanics, the body location a read is about, and the intimate-focus
 * gate.
 *
 * Kept in one file so three phenomena cannot each grow their own slightly
 * different idea of "the region this observation is about".
 */

/** One worn region as a phenomenon sees it: structure + current mechanics. */
export interface GarmentRegionView {
  readonly profile: GarmentRegionStructuralProfile;
  readonly mechanics: GarmentRegionEffectiveMechanics;
}

/**
 * Pair each profile region with its mechanics, dropping regions the wardrobe
 * says are BURIED.
 *
 * Occlusion is wardrobe truth, not observer perception: whatever covers a region
 * covers it for every observer, so a buried camisole's wet surface is not a read
 * this layer withholds — it is a read that has nothing to be about. (The garment
 * cue block makes exactly the same call, dropping `hidden` parts before ranking.)
 * Observer-specific filtering still happens afterwards, in the core.
 */
export function visibleGarmentRegions(
  frame: Pick<GarmentAffordanceFrame, "profile" | "mechanics" | "regions">,
): GarmentRegionView[] {
  const mechanicsByRegion = new Map(frame.mechanics.regions.map((region) => [region.regionId, region]));
  return frame.profile.regions.flatMap((profile): GarmentRegionView[] => {
    if (garmentRegionVisibility(frame.regions, profile.regionId) === "hidden") return [];
    const mechanics = mechanicsByRegion.get(profile.regionId);
    return mechanics ? [{ profile, mechanics }] : [];
  });
}

/**
 * The body location a region's read is anchored at — the first covered location
 * in the wardrobe's own registry-ordered coverage list.
 *
 * Registry order runs head-down, so this lands on the most descriptively useful
 * region of a multi-location garment (a shirt reads at the shoulders, not the
 * waist) and, being the wardrobe's order rather than a sort of our own, it stays
 * stable across cuts.
 */
export function garmentAnchorLocation(profile: GarmentRegionStructuralProfile): string | undefined {
  return profile.coveredBodyLocations[0];
}

/**
 * Why (if at all) the shared narrative-focus policy blocks a read.
 *
 * ## Which locations a phenomenon hands in — a decision the specs left open
 *
 * The policy says an intimate cue needs a current action/contact/transition, with
 * exposure and consent as hard gates. It does not say which garment reads count
 * as intimate, and the two plausible readings differ a lot in practice: keyed on
 * "any covered location", every ordinary top is intimate (a shirt covers a
 * chest, which the registry hangs the breast sub-tree under) and the domain
 * would be permanently silent; keyed on nothing, a soaked-transparent top over a
 * chest sails through the gate the policy exists for.
 *
 * The split shipped here follows what each read is ABOUT:
 *
 * - **`garment.wet_surface_state` is about the FABRIC.** "Her shirt has gone
 *   dark with water" says nothing about the body, so it is checked against the
 *   read's ANCHOR location only. A garment that also covers ordinary anatomy
 *   anchors there and speaks; one whose coverage is entirely intimate (a bra at
 *   `chest`, underwear at `groin`) anchors on it and is gated.
 * - **`garment.effective_opacity` and `garment.wet_cling` are about the BODY
 *   through or under the fabric.** Those are checked against every location
 *   involved, so a top that has gone translucent over a chest is gated even
 *   though its anchor is a shoulder.
 *
 * Conservative where it matters: the reveal reads are gated broadly, the fabric
 * read narrowly, and a lane that asserts no focus at all (the chat lane today)
 * gets silence from all three.
 */
export function intimateFocusBlock(input: {
  locationIds: readonly string[];
  focus: GarmentAffordanceFrame["focus"];
}): "not_relevant" | "gated" | null {
  if (!input.locationIds.some(isIntimateBodyLocation)) return null;
  if (!input.focus.intimateAllowed) return "gated";
  if (!input.focus.intimateRelevant) return "not_relevant";
  return null;
}
