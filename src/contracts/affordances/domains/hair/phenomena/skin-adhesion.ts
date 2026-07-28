import {
  complementUnit,
  defineAffordancePhenomenon,
  multiplyUnits,
  type AffordanceIntensityBand,
  type AffordanceResolution,
} from "../../../core";
import { HAIR_LOCATION_ID, type HairAffordanceFrame, type HairBodyContact } from "../frame";
import {
  hairIntensityBand,
  hairSuppressed,
  HAIR_BELOW_RESPONSE_THRESHOLD,
  HAIR_BOUND,
  HAIR_INSUFFICIENT_WETNESS,
  HAIR_NO_ASSERTED_CONTACT,
  HAIR_TARGET_OUT_OF_REACH,
  type HairBandThresholds,
} from "./bands";

/**
 * `hair.strands_adhere_to_skin` — damp strands clinging where they actually
 * touch (hair spec §"Phenomena").
 *
 * The four hard requirements, in the order failure is most informative:
 *
 * 1. a current hair ↔ target contact is ASSERTED by the lane;
 * 2. nominal reach includes that target — reach licenses contact, never invents it;
 * 3. enough wetness/clumping exists to make strands stick;
 * 4. enough LOOSE hair exists.
 *
 * Step 4 reads `(1−bound) × (1−pinned)` and deliberately NOT the mechanics'
 * `freeMovingFraction`, because that term also carries coverage — and coverage
 * does not prevent adhesion, it only hides it. Physical resolution here is
 * observer-independent; the core's perception filter is what drops a read taken
 * under a closed hood, so the contact stays true even when nobody can see it.
 *
 * This phenomenon has one resolution to give, so with several asserted contacts
 * it reports the alphabetically first reachable target — a deterministic pick,
 * independent of the order the lane listed them in.
 */

export const HAIR_SKIN_ADHESION_ID = "hair.strands_adhere_to_skin";

/** Clump strength below which strands slide off rather than cling. */
const ADHESION_CLUMP_MIN = 1_200;

/** Loose (unbound, unpinned) fraction below which there are no free strands to cling. */
const ADHESION_LOOSE_MIN = 3_000;

/** Law: bands read clump strength scaled by how much hair is free to lie against skin. */
const ADHESION_BANDS: HairBandThresholds = { subtle: 600, clear: 1_500, strong: 3_500 };

const ADHESION_TAGS: Readonly<Record<AffordanceIntensityBand, readonly string[]>> = {
  subtle: ["damp", "a_few_strands"],
  clear: ["damp", "clumped", "several_strands"],
  strong: ["damp", "clumped", "many_strands"],
};

type SkinAdhesionInput = Pick<HairAffordanceFrame, "profile" | "mechanics" | "presentation" | "actualContacts">;

function hairContacts(contacts: readonly HairBodyContact[]): readonly HairBodyContact[] {
  return contacts.filter((contact) => contact.sourceLocationId === HAIR_LOCATION_ID);
}

export const hairStrandsAdhereToSkin = defineAffordancePhenomenon<HairAffordanceFrame, SkinAdhesionInput>({
  id: HAIR_SKIN_ADHESION_ID,
  // `contacts` is REQUIRED, not optional: a lane with no contact owner must
  // suppress this phenomenon in the core rather than hand the resolver an empty
  // list that reads identically to "nothing is touching".
  dependencies: [{ key: "wetness" }, { key: "contacts" }],
  selectInput: (frame) => ({
    profile: frame.profile,
    mechanics: frame.mechanics,
    presentation: frame.presentation,
    actualContacts: frame.actualContacts,
  }),
  resolve: (input): AffordanceResolution => {
    const asserted = hairContacts(input.actualContacts);
    if (asserted.length === 0) return hairSuppressed(HAIR_SKIN_ADHESION_ID, HAIR_NO_ASSERTED_CONTACT);

    const reachable = asserted
      .map((contact) => contact.targetLocationId)
      .filter((targetLocationId) => input.profile.nominalReach.has(targetLocationId))
      .sort((left, right) => left.localeCompare(right));
    const target = reachable[0];
    if (target === undefined) return hairSuppressed(HAIR_SKIN_ADHESION_ID, HAIR_TARGET_OUT_OF_REACH);

    if (input.mechanics.clumpStrength < ADHESION_CLUMP_MIN) {
      return hairSuppressed(HAIR_SKIN_ADHESION_ID, HAIR_INSUFFICIENT_WETNESS);
    }
    const looseFraction = multiplyUnits(
      complementUnit(input.presentation.boundFraction),
      complementUnit(input.presentation.pinnedFraction),
    );
    if (looseFraction < ADHESION_LOOSE_MIN) return hairSuppressed(HAIR_SKIN_ADHESION_ID, HAIR_BOUND);

    const band = hairIntensityBand(multiplyUnits(input.mechanics.clumpStrength, looseFraction), ADHESION_BANDS);
    if (band === null) return hairSuppressed(HAIR_SKIN_ADHESION_ID, HAIR_BELOW_RESPONSE_THRESHOLD);

    return {
      kind: "observation",
      id: HAIR_SKIN_ADHESION_ID,
      sourceLocationId: HAIR_LOCATION_ID,
      targetLocationId: target,
      intensityBand: band,
      semanticTags: [...ADHESION_TAGS[band]],
      repeatKey: `hair:adhesion:${target}`,
    };
  },
});
