import { defineAttributeAxis, toUnitInterval, type UnitInterval } from "../../../core";
import { unitFieldIssue } from "./contribution";

/**
 * `hair.texture` → flexibility + curl retention.
 *
 * Two paths, not one, because they are consumed by different physics:
 * `flexibility` scales how much a force can move the hair (mechanics), while
 * `curlRetention` decides whether wet hair reads as defined curls rather than
 * flat strands (the wet-clumping phenomenon's own call).
 */

export const hairTextureValues = ["straight", "wavy", "curly", "coily", "kinky"] as const;
export type HairTextureValue = (typeof hairTextureValues)[number];

export interface HairTextureContribution {
  readonly flexibility: UnitInterval;
  readonly curlRetention: UnitInterval;
}

/** Law: down the straight → kinky ladder flexibility falls monotonically and curl retention rises. */
const TEXTURE_VALUES: Readonly<Record<HairTextureValue, HairTextureContribution>> = {
  straight: { flexibility: toUnitInterval(9_000), curlRetention: toUnitInterval(500) },
  wavy: { flexibility: toUnitInterval(7_500), curlRetention: toUnitInterval(3_000) },
  curly: { flexibility: toUnitInterval(6_000), curlRetention: toUnitInterval(6_000) },
  coily: { flexibility: toUnitInterval(4_500), curlRetention: toUnitInterval(8_000) },
  kinky: { flexibility: toUnitInterval(3_000), curlRetention: toUnitInterval(9_500) },
};

export const hairTextureAxis = defineAttributeAxis<HairTextureValue, HairTextureContribution>(
  {
    attributeId: "hair.texture",
    version: 1,
    ownedPaths: ["hair.flexibility", "hair.curlRetention"],
    values: TEXTURE_VALUES,
  },
  (contribution) =>
    unitFieldIssue({ flexibility: contribution.flexibility, curlRetention: contribution.curlRetention }),
);
