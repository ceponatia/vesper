import type { RegisteredAffordancePhenomenon } from "../../../core";
import type { GarmentAffordanceFrame } from "../frame";
import { garmentWetSurfaceState } from "./wet-surface-state";
import { garmentWetCling } from "./wet-cling";
import { garmentEffectiveOpacity } from "./effective-opacity";

export * from "./bands";
export * from "./shared";
export * from "./tags";
export * from "./wet-surface-state";
export * from "./wet-cling";
export * from "./effective-opacity";

/**
 * The garment corpus's FIRST RELEASE, in resolution order (owner ruling
 * 2026-07-28, "First release scope").
 *
 * Order is stable and meaningful: cue ranking's tie-break is `Array#sort`'s
 * stability, so two `clear` reads from the same cut always compete in this
 * order. Wet surface leads because it is the read that grounds the other two —
 * you notice a garment is soaked before you notice what being soaked has done
 * to it.
 *
 * **Deliberately absent**: `garment.wind_or_motion_response` and
 * `garment.pose_drape`. Both need current wind, subject motion, or a pose
 * transition, and no lane owns any of them until the shared scene/body-relations
 * owner exists. Their shared mechanics (`effectiveFlutterLoad`,
 * `effectiveDrapeStiffness`) are already derived and fixture-tested; registering
 * the phenomena would only add two permanently-suppressed rows to every read.
 */
export const garmentPhenomena: readonly RegisteredAffordancePhenomenon<GarmentAffordanceFrame>[] = [
  garmentWetSurfaceState,
  garmentWetCling,
  garmentEffectiveOpacity,
];
