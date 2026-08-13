import {
  defineAffordancePhenomenon,
  multiplyUnits,
  type AffordanceIntensityBand,
  type AffordanceResolution,
} from "../../../core";
import type { GarmentAffordanceFrame, GarmentBodyContactRead } from "../frame";
import {
  garmentIntensityBand,
  garmentSuppressed,
  strongestGarmentCandidate,
  GARMENT_BELOW_RESPONSE_THRESHOLD,
  GARMENT_INSUFFICIENT_SATURATION,
  GARMENT_NO_ASSERTED_CONTACT,
  GARMENT_NO_WORN_REGION,
  type GarmentBandThresholds,
} from "./bands";
import { intimateFocusBlock, visibleGarmentRegions, type GarmentRegionView } from "./shared";
import { garmentIntimateSuppression, garmentTag, GARMENT_REGION_TAG_PREFIX } from "./tags";

/**
 * `garment.wet_cling` — wet fabric actually lying against the body
 * (spec.garment-interaction.md §Phenomena).
 *
 * ## Capacity is not proof
 *
 * `contourConformance` is a shared mechanic and it is a CAPACITY: it says this
 * fabric, at this saturation, in this fit, would follow a body it is touching.
 * It is not evidence that it is touching one. So this phenomenon consumes
 * ASSERTED contacts and nothing else, and `contacts` is a REQUIRED dependency —
 * a lane with no contact owner is suppressed by the core with
 * `affordance.input.unavailable` before this resolver runs, exactly like
 * `hair.strands_adhere_to_skin`.
 *
 * ## The establishment law, and where it lives
 *
 * A `fitted` or `tight` worn garment establishes ordinary contact from wardrobe
 * truth alone; `loose`, `structured`, and unrecorded fits need pose, pressure,
 * or another asserted relation. That law is a property of the WARDROBE READ, so
 * it lives in `frame.ts` (`garmentContactsFromFit`) where a lane adapter calls
 * it — not here. This phenomenon only ever asks whether the lane asserted a
 * contact and how firm it was.
 *
 * Today no lane owns pose or pressure, so in production only the fit-established
 * path can ever fire, and a chat lane with no fit signal supplies no contacts at
 * all. That silence is correct and diagnosable, not a gap being papered over.
 *
 * ## What the observation does NOT say
 *
 * It carries the affected garment region and body location and a contour band.
 * It never claims uncovered anatomy: the exposure question belongs to the
 * effective-coverage read, and the intimate-focus policy gates it on top.
 */

export const GARMENT_WET_CLING_ID = "garment.wet_cling";

/** Saturation below which fabric is damp rather than clinging. */
const CLING_SATURATION_MIN = 3_000;

/** Conformance below which the fabric follows its own drape rather than the body. */
const CLING_CONFORMANCE_MIN = 1_200;

/** Law: bands read conformance scaled by how firmly the contact actually presses. */
const CLING_BANDS: GarmentBandThresholds = { subtle: 800, clear: 2_000, strong: 4_000 };

const CLING_TAGS: Readonly<Record<AffordanceIntensityBand, readonly string[]>> = {
  subtle: ["clinging", "traced_faintly"],
  clear: ["clinging", "contour_followed"],
  strong: ["clinging", "contour_followed", "moulded"],
};

type WetClingInput = Pick<GarmentAffordanceFrame, "profile" | "mechanics" | "regions" | "actualContacts" | "focus">;

interface ClingCandidate {
  readonly regionId: string;
  readonly band: AffordanceIntensityBand;
  readonly response: number;
  readonly view: GarmentRegionView;
  readonly contact: GarmentBodyContactRead;
}

export const garmentWetCling = defineAffordancePhenomenon<GarmentAffordanceFrame, WetClingInput>({
  id: GARMENT_WET_CLING_ID,
  // `contacts` is REQUIRED, not optional: a lane with no way to establish contact
  // must be suppressed in the core rather than handed an empty list that reads
  // identically to "nothing is touching".
  dependencies: [{ key: "regions" }, { key: "contacts" }],
  selectInput: (frame) => ({
    profile: frame.profile,
    mechanics: frame.mechanics,
    regions: frame.regions,
    actualContacts: frame.actualContacts,
    focus: frame.focus,
  }),
  resolve: (input): AffordanceResolution => {
    const views = visibleGarmentRegions(input);
    if (views.length === 0) return garmentSuppressed(GARMENT_WET_CLING_ID, GARMENT_NO_WORN_REGION);
    if (input.actualContacts.length === 0) {
      return garmentSuppressed(GARMENT_WET_CLING_ID, GARMENT_NO_ASSERTED_CONTACT);
    }

    const byRegion = new Map(views.map((view) => [view.profile.regionId, view]));
    const touching = input.actualContacts.flatMap((contact) => {
      const view = byRegion.get(contact.regionId);
      return view ? [{ view, contact }] : [];
    });
    if (touching.length === 0) return garmentSuppressed(GARMENT_WET_CLING_ID, GARMENT_NO_ASSERTED_CONTACT);

    const wet = touching.filter(({ view }) => view.mechanics.saturation >= CLING_SATURATION_MIN);
    if (wet.length === 0) return garmentSuppressed(GARMENT_WET_CLING_ID, GARMENT_INSUFFICIENT_SATURATION);

    const candidates = wet.flatMap(({ view, contact }): ClingCandidate[] => {
      if (view.mechanics.contourConformance < CLING_CONFORMANCE_MIN) return [];
      const response = multiplyUnits(view.mechanics.contourConformance, contact.strength);
      const band = garmentIntensityBand(response, CLING_BANDS);
      return band === null ? [] : [{ regionId: view.profile.regionId, band, response, view, contact }];
    });
    const best = strongestGarmentCandidate(candidates);
    if (best === undefined) return garmentSuppressed(GARMENT_WET_CLING_ID, GARMENT_BELOW_RESPONSE_THRESHOLD);

    // A BODY read: the contact's own location decides.
    const blocked = intimateFocusBlock({ locationIds: [best.contact.bodyLocationId], focus: input.focus });
    if (blocked !== null) {
      return garmentIntimateSuppression(GARMENT_WET_CLING_ID, blocked, best.contact.bodyLocationId);
    }

    return {
      kind: "observation",
      id: GARMENT_WET_CLING_ID,
      sourceLocationId: best.contact.bodyLocationId,
      intensityBand: best.band,
      semanticTags: [
        garmentTag(best.view.profile),
        `${GARMENT_REGION_TAG_PREFIX}${best.view.profile.partId}`,
        ...CLING_TAGS[best.band],
        // The contact's own provenance, so a debug read (and a cue that wants to
        // stay honest) can tell fit-established contact from a pressed one.
        `contact_${best.contact.mode}`,
      ],
      repeatKey: `garment:cling:${best.regionId}:${best.contact.bodyLocationId}`,
    };
  },
});
