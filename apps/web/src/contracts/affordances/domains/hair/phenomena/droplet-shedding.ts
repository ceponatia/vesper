import {
  defineAffordancePhenomenon,
  multiplyUnits,
  type AffordanceIntensityBand,
  type AffordanceResolution,
} from "../../../core";
import {
  hairImpulseEventKinds,
  isHairImpulseEvent,
  HAIR_LOCATION_ID,
  type HairAffordanceFrame,
  type HairCausalEvent,
  type HairEventKind,
} from "../frame";
import {
  hairIntensityBand,
  hairSuppressed,
  HAIR_BELOW_RESPONSE_THRESHOLD,
  HAIR_BOUND,
  HAIR_INSUFFICIENT_WETNESS,
  HAIR_NO_CURRENT_IMPULSE,
  type HairBandThresholds,
} from "./bands";

/**
 * `hair.sheds_droplets` — water actually leaving the hair
 * (hair spec §"Phenomena").
 *
 * Retained water is a standing condition; shedding is an EVENT. A shake, sudden
 * turn, run, impact, or gust must have been committed, or soaked hair would
 * appear to fling droplets every quiet exchange it stayed wet.
 *
 * The read describes what is visible and changes nothing: authoritative wetness
 * belongs to the state that owns it, and this resolver receives a deep-frozen
 * input precisely so a "helpful" decrement fails loudly instead of quietly
 * drying a character out through a read.
 */

export const HAIR_SHEDS_DROPLETS_ID = "hair.sheds_droplets";

/** Retained water below which there is nothing left to throw. */
const SHED_RETAINED_MIN = 400;

/** Free-moving fraction below which the hair cannot whip hard enough to release water. */
const SHED_FREE_MIN = 2_000;

/** Law: bands read retained water carried by the hair that is actually free to move. */
const SHED_BANDS: HairBandThresholds = { subtle: 150, clear: 500, strong: 1_500 };

const SHED_TAGS: Readonly<Record<AffordanceIntensityBand, readonly string[]>> = {
  subtle: ["droplets", "a_few_flick_loose"],
  clear: ["droplets", "scatters"],
  strong: ["droplets", "sprays"],
};

type DropletSheddingInput = Pick<HairAffordanceFrame, "mechanics" | "recentEvents">;

/**
 * The impulse this read cites: the most recent one, ties broken by the declared
 * kind order. Deterministic regardless of the order the lane listed events in.
 */
function committedImpulse(events: readonly HairCausalEvent[]): HairCausalEvent | undefined {
  const order: readonly HairEventKind[] = hairImpulseEventKinds;
  const rank = (event: HairCausalEvent): number => order.indexOf(event.kind);
  return events
    .filter(isHairImpulseEvent)
    .toSorted((left, right) => right.atStoryTime - left.atStoryTime || rank(left) - rank(right))[0];
}

export const hairShedsDroplets = defineAffordancePhenomenon<HairAffordanceFrame, DropletSheddingInput>({
  id: HAIR_SHEDS_DROPLETS_ID,
  // `events` is REQUIRED: with no committed-impulse owner the core suppresses
  // this phenomenon outright, so an empty list can never be read as "nothing
  // happened" by a lane that simply cannot answer.
  dependencies: [{ key: "wetness" }, { key: "events" }],
  selectInput: (frame) => ({ mechanics: frame.mechanics, recentEvents: frame.recentEvents }),
  resolve: (input): AffordanceResolution => {
    const impulse = committedImpulse(input.recentEvents);
    if (impulse === undefined) return hairSuppressed(HAIR_SHEDS_DROPLETS_ID, HAIR_NO_CURRENT_IMPULSE);
    if (input.mechanics.retainedWater < SHED_RETAINED_MIN) {
      return hairSuppressed(HAIR_SHEDS_DROPLETS_ID, HAIR_INSUFFICIENT_WETNESS);
    }
    if (input.mechanics.freeMovingFraction < SHED_FREE_MIN) {
      return hairSuppressed(HAIR_SHEDS_DROPLETS_ID, HAIR_BOUND);
    }

    const band = hairIntensityBand(
      multiplyUnits(input.mechanics.retainedWater, input.mechanics.freeMovingFraction),
      SHED_BANDS,
    );
    if (band === null) return hairSuppressed(HAIR_SHEDS_DROPLETS_ID, HAIR_BELOW_RESPONSE_THRESHOLD);

    return {
      kind: "observation",
      id: HAIR_SHEDS_DROPLETS_ID,
      sourceLocationId: HAIR_LOCATION_ID,
      intensityBand: band,
      semanticTags: [...SHED_TAGS[band], `caused_by_${impulse.kind}`],
      repeatKey: "hair:droplets",
    };
  },
});
