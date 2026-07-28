import { defineAttributeAxis, toUnitInterval, type UnitInterval } from "../../../core";
import { unitFieldIssue } from "./contribution";

/**
 * `hair.condition` → surface friction + water absorption + clump affinity.
 *
 * All three are STRAND-SURFACE properties, which is why one attribute owns
 * them: a damaged cuticle is simultaneously rougher, more porous, and more
 * prone to sticking to itself. Splitting them across attributes would let two
 * files disagree about what "straw-like" means.
 */

export const hairConditionValues = [
  "silky",
  "smooth",
  "healthy",
  "dry",
  "frizzy",
  "brittle",
  "straw_like",
] as const;

export type HairConditionValue = (typeof hairConditionValues)[number];

export interface HairConditionContribution {
  readonly surfaceFriction: UnitInterval;
  readonly waterAbsorption: UnitInterval;
  readonly clumpAffinity: UnitInterval;
}

/**
 * Law: down the silky → straw_like ladder all three rise monotonically — a
 * rougher cuticle is more porous and clumps harder. No value is zero: even
 * silky hair wets and clumps when it is soaked enough.
 *
 * `waterAbsorption` starts at 4_000 rather than near nothing on purpose. The
 * cuticle difference is real but modest: wet hair of ANY condition carries
 * mostly surface water, and a table that let silky hair shrug water off would
 * make a soaked sleek head fly in a breeze — the exact contradiction this domain
 * exists to prevent (see the wind phenomenon's water-load gate).
 */
const CONDITION_VALUES: Readonly<Record<HairConditionValue, HairConditionContribution>> = {
  silky: { surfaceFriction: toUnitInterval(1_000), waterAbsorption: toUnitInterval(4_000), clumpAffinity: toUnitInterval(2_000) },
  smooth: { surfaceFriction: toUnitInterval(2_000), waterAbsorption: toUnitInterval(4_500), clumpAffinity: toUnitInterval(3_000) },
  healthy: { surfaceFriction: toUnitInterval(3_500), waterAbsorption: toUnitInterval(5_000), clumpAffinity: toUnitInterval(4_000) },
  dry: { surfaceFriction: toUnitInterval(6_000), waterAbsorption: toUnitInterval(6_500), clumpAffinity: toUnitInterval(5_500) },
  frizzy: { surfaceFriction: toUnitInterval(7_000), waterAbsorption: toUnitInterval(7_000), clumpAffinity: toUnitInterval(6_500) },
  brittle: { surfaceFriction: toUnitInterval(8_000), waterAbsorption: toUnitInterval(8_000), clumpAffinity: toUnitInterval(7_500) },
  straw_like: { surfaceFriction: toUnitInterval(9_000), waterAbsorption: toUnitInterval(9_000), clumpAffinity: toUnitInterval(8_500) },
};

export const hairConditionAxis = defineAttributeAxis<HairConditionValue, HairConditionContribution>(
  {
    attributeId: "hair.condition",
    version: 1,
    ownedPaths: ["hair.surfaceFriction", "hair.waterAbsorption", "hair.clumpAffinity"],
    values: CONDITION_VALUES,
  },
  (contribution) =>
    unitFieldIssue({
      surfaceFriction: contribution.surfaceFriction,
      waterAbsorption: contribution.waterAbsorption,
      clumpAffinity: contribution.clumpAffinity,
    }),
);
