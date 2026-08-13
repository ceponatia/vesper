import { defineAttributeAxis, toUnitInterval, type UnitInterval } from "../../../core";
import { unitFieldIssue } from "./contribution";

/**
 * `hair.strand_thickness` → per-strand mass band.
 *
 * The registry deliberately gives this attribute no "fine hair"/"thick hair"
 * aliases, because colloquially those mean DENSITY. The same discipline holds
 * here: this axis owns strand mass and never touches bulk.
 */

export const hairStrandThicknessValues = ["fine", "medium", "thick"] as const;
export type HairStrandThicknessValue = (typeof hairStrandThicknessValues)[number];

export interface HairStrandThicknessContribution {
  readonly strandThickness: UnitInterval;
}

/** Law: strand mass rises with the ladder. */
const STRAND_THICKNESS_VALUES: Readonly<Record<HairStrandThicknessValue, HairStrandThicknessContribution>> = {
  fine: { strandThickness: toUnitInterval(2_500) },
  medium: { strandThickness: toUnitInterval(5_000) },
  thick: { strandThickness: toUnitInterval(8_000) },
};

export const hairStrandThicknessAxis = defineAttributeAxis<
  HairStrandThicknessValue,
  HairStrandThicknessContribution
>(
  {
    attributeId: "hair.strand_thickness",
    version: 1,
    ownedPaths: ["hair.strandThickness"],
    values: STRAND_THICKNESS_VALUES,
  },
  (contribution) => unitFieldIssue({ strandThickness: contribution.strandThickness }),
);
