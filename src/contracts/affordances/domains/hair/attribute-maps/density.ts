import { defineAttributeAxis, toUnitInterval, type UnitInterval } from "../../../core";
import { unitFieldIssue } from "./contribution";

/**
 * `hair.density` → bulk density (how MUCH hair there is).
 *
 * Orthogonal to `hair.strand_thickness` (how heavy each strand is) on purpose:
 * sparse coarse hair and dense fine hair are different materials, and collapsing
 * them into one "thickness" is exactly the entanglement the Slice 0 vocabulary
 * split removed.
 */

export const hairDensityValues = ["sparse", "medium", "dense"] as const;
export type HairDensityValue = (typeof hairDensityValues)[number];

export interface HairDensityContribution {
  readonly bulkDensity: UnitInterval;
}

/** Law: bulk rises with the ladder; nothing here is zero — even sparse hair is hair. */
const DENSITY_VALUES: Readonly<Record<HairDensityValue, HairDensityContribution>> = {
  sparse: { bulkDensity: toUnitInterval(3_000) },
  medium: { bulkDensity: toUnitInterval(6_000) },
  dense: { bulkDensity: toUnitInterval(9_000) },
};

export const hairDensityAxis = defineAttributeAxis<HairDensityValue, HairDensityContribution>(
  { attributeId: "hair.density", version: 1, ownedPaths: ["hair.bulkDensity"], values: DENSITY_VALUES },
  (contribution) => unitFieldIssue({ bulkDensity: contribution.bulkDensity }),
);
