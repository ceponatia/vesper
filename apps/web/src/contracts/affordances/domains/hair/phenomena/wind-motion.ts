import {
  defineAffordancePhenomenon,
  multiplyUnits,
  type AffordanceIntensityBand,
  type AffordanceResolution,
  type UnitInterval,
} from "../../../core";
import { HAIR_LOCATION_ID, type HairAffordanceFrame } from "../frame";
import {
  hairIntensityBand,
  hairSuppressed,
  HAIR_BELOW_RESPONSE_THRESHOLD,
  HAIR_NO_CURRENT_FORCE,
  type HairBandThresholds,
} from "./bands";
import { hairBulkRestraint } from "./restraint";

/**
 * `hair.wind_or_motion_response` — hair actually moving, now.
 *
 * ```text
 * response = current force × mobilityCapacity × exposedFreeArea
 * ```
 *
 * Two reads, not one, and the difference is load-bearing:
 *
 * - the **whole-hair** read is what a narrator may describe as the style moving.
 *   It is gated shut by binding, pinning, coverage, or water load — a soaked or
 *   braided head does not fly free however hard the wind blows.
 * - the **ends-only** read exists because the fourth worked case is real: a
 *   strong gust may stir the loose ends below a hood while the constrained bulk
 *   stays put. It carries its own semantic tags and its own `repeatKey`, is
 *   capped at `subtle`, and requires a genuinely strong force — so it can never
 *   be mistaken downstream for the whole style flying free, and a light breeze
 *   on wet hair produces silence rather than a consolation cue.
 *
 * Wetness never increases mobility. It only grows the load in the denominator
 * and the clumping that damps the numerator.
 */

export const HAIR_WIND_OR_MOTION_ID = "hair.wind_or_motion_response";

/** Law: bands read the whole-hair response product. */
const WHOLE_HAIR_BANDS: HairBandThresholds = { subtle: 200, clear: 500, strong: 1_500 };

/** Only a genuinely strong gust reaches ends that the constrained bulk cannot follow. */
const ENDS_FORCE_MIN = 6_000;

/** Floor for the ends-only response — below it, nothing visible stirs. */
const ENDS_RESPONSE_MIN = 150;

/** The spec's whole-hair output bands. */
const WHOLE_HAIR_TAGS: Readonly<Record<AffordanceIntensityBand, readonly string[]>> = {
  subtle: ["whole_hair", "flyaways", "stirs"],
  clear: ["whole_hair", "loose_strands", "lifts"],
  strong: ["whole_hair", "unbound", "streams"],
};

type WindMotionInput = Pick<HairAffordanceFrame, "mechanics" | "presentation" | "wind" | "motion">;

/** The strongest current force acting on the hair. Absent reads are absent, not zero. */
function currentForce(input: WindMotionInput): UnitInterval {
  const forces = [input.wind?.force, input.motion?.force].filter((force): force is UnitInterval => force !== undefined);
  return forces.reduce<UnitInterval>((strongest, force) => (force > strongest ? force : strongest), 0 as UnitInterval);
}

export const hairWindOrMotionResponse = defineAffordancePhenomenon<HairAffordanceFrame, WindMotionInput>({
  id: HAIR_WIND_OR_MOTION_ID,
  // Both forces are OPTIONAL because either alone is a cause; the resolver
  // reports `no_current_force` when neither lane could answer. A required pair
  // would suppress a windy scene merely for having no body-motion owner.
  dependencies: [
    { key: "wind", optional: true },
    { key: "motion", optional: true },
  ],
  selectInput: (frame) => ({
    mechanics: frame.mechanics,
    presentation: frame.presentation,
    wind: frame.wind,
    motion: frame.motion,
  }),
  resolve: (input): AffordanceResolution => {
    const force = currentForce(input);
    if (force === 0) return hairSuppressed(HAIR_WIND_OR_MOTION_ID, HAIR_NO_CURRENT_FORCE);

    const response = multiplyUnits(force, input.mechanics.mobilityCapacity, input.mechanics.exposedFreeArea);
    // The SAME restraint question `hair.bulk_restraint` asks, answered once
    // (`restraint.ts`) — here it is a reason for silence, there a standing fence.
    const constraint = hairBulkRestraint(input);

    if (constraint === null) {
      const band = hairIntensityBand(response, WHOLE_HAIR_BANDS);
      if (band === null) return hairSuppressed(HAIR_WIND_OR_MOTION_ID, HAIR_BELOW_RESPONSE_THRESHOLD);
      return {
        kind: "observation",
        id: HAIR_WIND_OR_MOTION_ID,
        sourceLocationId: HAIR_LOCATION_ID,
        intensityBand: band,
        semanticTags: [...WHOLE_HAIR_TAGS[band]],
        repeatKey: "hair:motion",
      };
    }

    if (force < ENDS_FORCE_MIN || response < ENDS_RESPONSE_MIN) {
      return hairSuppressed(HAIR_WIND_OR_MOTION_ID, constraint);
    }
    const band = input.presentation.looseEndLengthBand;
    return {
      kind: "observation",
      id: HAIR_WIND_OR_MOTION_ID,
      sourceLocationId: HAIR_LOCATION_ID,
      intensityBand: "subtle",
      semanticTags: ["exposed_ends", "stirs", ...(band === undefined ? [] : [`ends_${band}`])],
      repeatKey: "hair:motion:ends",
    };
  },
});
