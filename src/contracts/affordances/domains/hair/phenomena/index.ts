import type { RegisteredAffordancePhenomenon } from "../../../core";
import type { HairAffordanceFrame } from "../frame";
import { hairWetClumping } from "./wet-clumping";
import { hairWindOrMotionResponse } from "./wind-motion";
import { hairStrandsAdhereToSkin } from "./skin-adhesion";
import { hairShedsDroplets } from "./droplet-shedding";

export * from "./bands";
export * from "./wet-clumping";
export * from "./wind-motion";
export * from "./skin-adhesion";
export * from "./droplet-shedding";

/**
 * The first hair corpus, in resolution order. Order is stable and meaningful:
 * cue ranking's tie-break is `Array#sort`'s stability, so two `clear` reads from
 * the same cut always compete in this order.
 */
export const hairPhenomena: readonly RegisteredAffordancePhenomenon<HairAffordanceFrame>[] = [
  hairWetClumping,
  hairWindOrMotionResponse,
  hairStrandsAdhereToSkin,
  hairShedsDroplets,
];
