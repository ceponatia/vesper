import { bodyLocationRegistry } from "../../../../body/locations";
import { defineAttributeAxis, toUnitInterval, type UnitInterval } from "../../../core";
import { unitFieldIssue } from "./contribution";

/**
 * `hair.length` → length scale + nominal anatomical reach.
 *
 * This axis owns geometry and nothing else. It does NOT write a combined
 * "mass": that is `dryBulkLoad`, derived once in hair mechanics from length,
 * bulk, and strand thickness together.
 *
 * **Reach licenses contact; it never invents it.** `nominalReach` answers only
 * "could hair of this length physically arrive here" — an asserted contact is
 * still required before any adhesion read resolves.
 */

/** The `hair.length` vocabulary, shortest → longest. The ORDER is the calibration ladder. */
export const hairLengthValues = [
  "shaved",
  "buzzed",
  "short",
  "chin_length",
  "shoulder_length",
  "mid_back",
  "waist_length",
  "feet_length",
] as const;

export type HairLengthValue = (typeof hairLengthValues)[number];

export interface HairLengthContribution {
  readonly lengthScale: UnitInterval;
  /** Real body-location ids (`contracts/body/locations`), validated at definition time. */
  readonly nominalReach: ReadonlySet<string>;
}

/**
 * Law: reach is CUMULATIVE down the ladder — each rung adds the locations that
 * rung newly reaches, so a longer length can only ever reach a superset. Nesting
 * is what makes "greater length never shrinks reach" structural rather than a
 * property of eight hand-written sets that could drift apart.
 */
const REACH_STEPS: Readonly<Record<HairLengthValue, readonly string[]>> = {
  shaved: [],
  buzzed: ["head"],
  short: ["ears"],
  chin_length: ["face", "neck"],
  shoulder_length: ["shoulders"],
  mid_back: ["upper_arms", "chest", "back"],
  waist_length: ["waist", "forearms"],
  feet_length: ["hips", "buttocks", "thighs", "calves"],
};

function cumulativeReach(upTo: HairLengthValue): ReadonlySet<string> {
  const reach = new Set<string>();
  for (const value of hairLengthValues) {
    for (const locationId of REACH_STEPS[value]) reach.add(locationId);
    if (value === upTo) break;
  }
  return reach;
}

/** Law: `lengthScale` rises monotonically with the ladder; shaved hair has no geometry at all. */
const LENGTH_VALUES: Readonly<Record<HairLengthValue, HairLengthContribution>> = {
  shaved: { lengthScale: toUnitInterval(0), nominalReach: cumulativeReach("shaved") },
  buzzed: { lengthScale: toUnitInterval(500), nominalReach: cumulativeReach("buzzed") },
  short: { lengthScale: toUnitInterval(1_500), nominalReach: cumulativeReach("short") },
  chin_length: { lengthScale: toUnitInterval(3_000), nominalReach: cumulativeReach("chin_length") },
  shoulder_length: { lengthScale: toUnitInterval(4_500), nominalReach: cumulativeReach("shoulder_length") },
  mid_back: { lengthScale: toUnitInterval(6_500), nominalReach: cumulativeReach("mid_back") },
  waist_length: { lengthScale: toUnitInterval(8_000), nominalReach: cumulativeReach("waist_length") },
  feet_length: { lengthScale: toUnitInterval(10_000), nominalReach: cumulativeReach("feet_length") },
};

export const hairLengthAxis = defineAttributeAxis<HairLengthValue, HairLengthContribution>(
  {
    attributeId: "hair.length",
    version: 1,
    ownedPaths: ["hair.lengthScale", "hair.nominalReach"],
    values: LENGTH_VALUES,
  },
  (contribution) => {
    const bounds = unitFieldIssue({ lengthScale: contribution.lengthScale });
    if (bounds !== null) return bounds;
    for (const locationId of contribution.nominalReach) {
      if (!bodyLocationRegistry.byId(locationId)) return `nominalReach names unknown body location "${locationId}"`;
    }
    return null;
  },
);
