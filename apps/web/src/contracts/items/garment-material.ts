import { z } from "zod";
import { METER_FIXED_POINT_ONE, meterFixedPointSchema } from "@vesper/simulation-core/contracts/bodies";

/**
 * Garment material profiles (clothing-state-graph.plan.md §Material profiles;
 * slice-0 audit OQ1). A registry-owned bundle of MECHANICS — never prompt
 * adjectives. Narrator/image phrasing comes from derived semantic bands, so
 * nothing here is ever serialized into a prompt.
 *
 * The registry is the plan's 7 materially-distinct families plus a conservative
 * `unknown`. Deliberately NO "sheer" material: `baselineOpacity` is a material
 * default that the item definition's existing `opacity: "opaque" | "sheer"`
 * enum (item.ts) overrides, so sheer silk and sheer synthetic stay
 * distinguishable and the occlusion `hinted` rule is unchanged (OQ1).
 */

// --- Fixed point --------------------------------------------------------------

/**
 * The garment lane's fixed-point unit is the SAME 0–10_000 scale the successor
 * §25 meter kernel uses (`contracts/simulation/bodies.ts`) — one convention, not
 * two. `0` is the low/absent end of every channel, `10_000` the full end.
 */
export const garmentUnitSchema = meterFixedPointSchema;
export type GarmentUnit = z.infer<typeof garmentUnitSchema>;

/** `1.0` in garment fixed point (10_000) — re-exported so callers need one import. */
export const GARMENT_UNIT_ONE = METER_FIXED_POINT_ONE;

/**
 * The semantic degree vocabulary models and UI speak (the plan's `DegreeBand`).
 * Fixed-point values never reach an LLM; a band does.
 */
export const garmentDegreeBands = ["slight", "moderate", "substantial", "extreme"] as const;
export const garmentDegreeBandSchema = z.enum(garmentDegreeBands);
export type GarmentDegreeBand = z.infer<typeof garmentDegreeBandSchema>;

/** Canonical fixed-point value a band compiles to when an operation applies it. */
export const GARMENT_DEGREE_BAND_VALUES: Readonly<Record<GarmentDegreeBand, GarmentUnit>> = {
  slight: 2_500,
  moderate: 5_000,
  substantial: 7_500,
  extreme: GARMENT_UNIT_ONE,
};

/**
 * Lower boundary of each band (the midpoints between the canonical values
 * above). `garmentDegreeBandOf` reads a stored value back into a band; the
 * hysteresis the plan requires for *narration* bands is slice 4's job — these
 * boundaries are the structural thresholds the coverage law is stated in.
 */
export const GARMENT_DEGREE_BAND_FLOORS: Readonly<Record<GarmentDegreeBand, GarmentUnit>> = {
  slight: 1,
  moderate: 3_750,
  substantial: 6_250,
  extreme: 8_750,
};

/** Band a fixed-point degree falls in; `null` below the `slight` floor (i.e. absent). */
export function garmentDegreeBandOf(value: number): GarmentDegreeBand | null {
  if (value >= GARMENT_DEGREE_BAND_FLOORS.extreme) return "extreme";
  if (value >= GARMENT_DEGREE_BAND_FLOORS.substantial) return "substantial";
  if (value >= GARMENT_DEGREE_BAND_FLOORS.moderate) return "moderate";
  if (value >= GARMENT_DEGREE_BAND_FLOORS.slight) return "slight";
  return null;
}

// --- Profile registry ---------------------------------------------------------

export const garmentMaterialProfileIds = [
  "woven_cotton_linen",
  "knit",
  "silk_satin",
  "denim",
  "wool",
  "leather",
  "synthetic_shell",
  "unknown",
] as const;
export const garmentMaterialProfileIdSchema = z.enum(garmentMaterialProfileIds);
export type GarmentMaterialProfileId = z.infer<typeof garmentMaterialProfileIdSchema>;

/** The conservative fallback: mid absorbency, opaque, barely responsive when wet. */
export const GARMENT_MATERIAL_UNKNOWN: GarmentMaterialProfileId = "unknown";

export interface GarmentMaterialProfile {
  id: GarmentMaterialProfileId;
  /** How much water the fibre takes up per unit of wetting source. */
  absorbency: GarmentUnit;
  /** How fast it sheds that water with no live source (analytic drying rate). */
  dryingRate: GarmentUnit;
  /** How readily wear/pose turn into visible creases. */
  wrinkleAffinity: GarmentUnit;
  /** How stubbornly a deposit stays after ordinary cleaning. */
  stainRetention: GarmentUnit;
  /** Resistance to scuffs/tears — damping on `wear` and damage marks. */
  abrasionResistance: GarmentUnit;
  /** Dry opacity default; the item definition's `opacity` enum overrides it. */
  baselineOpacity: GarmentUnit;
  /** How much opacity FALLS as wetness rises (0 ⇒ wet looks the same). */
  wetOpacityResponse: GarmentUnit;
  /** Stiffness of fall — high stiffness holds a silhouette, low pools. */
  drapeStiffness: GarmentUnit;
  /** How eagerly it clings to skin when wet or pressed. */
  clingAffinity: GarmentUnit;
}

/**
 * v1 profiles. Values are deliberately coarse (quarter-scale steps) — they exist
 * to make materials *diverge* under the same source, not to be physically exact.
 * The load-bearing contrasts: cotton/knit soak and go see-through; leather and
 * synthetic shell barely absorb and never sheer out; denim is heavy, stiff and
 * slow to dry; wool resists creasing; silk stains and clings.
 */
const unknownProfile: GarmentMaterialProfile = {
  id: "unknown",
  absorbency: 5_000,
  dryingRate: 5_000,
  wrinkleAffinity: 5_000,
  stainRetention: 5_000,
  abrasionResistance: 5_000,
  // Conservative: an unidentified fabric is opaque and stays opaque when wet, so
  // a degraded material can never invent exposure.
  baselineOpacity: 9_000,
  wetOpacityResponse: 3_000,
  drapeStiffness: 5_000,
  clingAffinity: 3_000,
};

export const garmentMaterialProfiles: readonly GarmentMaterialProfile[] = [
  {
    id: "woven_cotton_linen",
    absorbency: 7_500,
    dryingRate: 4_000,
    wrinkleAffinity: 8_000,
    stainRetention: 6_000,
    abrasionResistance: 5_000,
    baselineOpacity: 8_500,
    wetOpacityResponse: 7_000,
    drapeStiffness: 4_500,
    clingAffinity: 6_500,
  },
  {
    id: "knit",
    absorbency: 7_000,
    dryingRate: 4_500,
    wrinkleAffinity: 3_000,
    stainRetention: 5_500,
    abrasionResistance: 4_000,
    baselineOpacity: 8_000,
    wetOpacityResponse: 6_000,
    drapeStiffness: 2_500,
    clingAffinity: 7_500,
  },
  {
    id: "silk_satin",
    absorbency: 4_500,
    dryingRate: 6_000,
    wrinkleAffinity: 6_500,
    stainRetention: 7_500,
    abrasionResistance: 2_500,
    baselineOpacity: 8_000,
    wetOpacityResponse: 8_000,
    drapeStiffness: 1_500,
    clingAffinity: 9_000,
  },
  {
    id: "denim",
    absorbency: 8_000,
    dryingRate: 1_500,
    wrinkleAffinity: 4_500,
    stainRetention: 6_500,
    abrasionResistance: 8_500,
    baselineOpacity: 9_800,
    wetOpacityResponse: 2_000,
    drapeStiffness: 8_000,
    clingAffinity: 3_000,
  },
  {
    id: "wool",
    absorbency: 6_000,
    dryingRate: 2_000,
    wrinkleAffinity: 2_000,
    stainRetention: 5_000,
    abrasionResistance: 6_500,
    baselineOpacity: 9_500,
    wetOpacityResponse: 2_500,
    drapeStiffness: 6_000,
    clingAffinity: 2_500,
  },
  {
    id: "leather",
    absorbency: 1_200,
    dryingRate: 2_500,
    wrinkleAffinity: 1_500,
    stainRetention: 3_000,
    abrasionResistance: 9_000,
    baselineOpacity: GARMENT_UNIT_ONE,
    wetOpacityResponse: 500,
    drapeStiffness: 8_500,
    clingAffinity: 1_000,
  },
  {
    id: "synthetic_shell",
    absorbency: 800,
    dryingRate: 9_000,
    wrinkleAffinity: 1_000,
    stainRetention: 2_000,
    abrasionResistance: 7_500,
    baselineOpacity: 9_500,
    wetOpacityResponse: 800,
    drapeStiffness: 7_000,
    clingAffinity: 1_500,
  },
  unknownProfile,
];

const profilesById = new Map<string, GarmentMaterialProfile>(
  garmentMaterialProfiles.map((profile) => [profile.id, profile]),
);

/** True when `id` names a registered material profile. */
export function isGarmentMaterialProfileId(id: string): id is GarmentMaterialProfileId {
  return profilesById.has(id);
}

/**
 * Registry lookup that never misses: an unknown/absent id degrades to the
 * conservative `unknown` profile (docs/resilience.md — a default, not a throw).
 */
export function garmentMaterialProfile(id: string | undefined | null): GarmentMaterialProfile {
  const found = id ? profilesById.get(id.trim()) : undefined;
  return found ?? unknownProfile;
}
