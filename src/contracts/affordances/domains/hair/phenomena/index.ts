import type { RegisteredAffordancePhenomenon } from "../../../core";
import type { HairAffordanceFrame } from "../frame";
import { hairWetClumping } from "./wet-clumping";
import { hairWindOrMotionResponse } from "./wind-motion";
import { hairBulkRestraintPhenomenon } from "./bulk-restraint";
import { hairStrandsAdhereToSkin } from "./skin-adhesion";
import { hairShedsDroplets } from "./droplet-shedding";

export * from "./bands";
export * from "./restraint";
export * from "./wet-clumping";
export * from "./wind-motion";
export * from "./bulk-restraint";
export * from "./skin-adhesion";
export * from "./droplet-shedding";

/**
 * The hair corpus, in resolution order. Order is stable and meaningful: cue
 * ranking's tie-break is `Array#sort`'s stability, so two `clear` reads from the
 * same cut always compete in this order.
 *
 * `hair.bulk_restraint` sits immediately after the wind/motion read it shares its
 * gate with (`restraint.ts`), which keeps the pair adjacent for a reader: one says
 * whether the hair is moving, the other what is stopping it. It emits a CONSTRAINT
 * rather than an observation, so it never competes for a cue slot.
 */
export const hairPhenomena: readonly RegisteredAffordancePhenomenon<HairAffordanceFrame>[] = [
  hairWetClumping,
  hairWindOrMotionResponse,
  hairBulkRestraintPhenomenon,
  hairStrandsAdhereToSkin,
  hairShedsDroplets,
];
