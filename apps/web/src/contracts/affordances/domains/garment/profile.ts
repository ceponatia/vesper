import { z } from "zod";
import { diag, type Diagnostic } from "../../../diagnostics";
import {
  garmentMaterialProfile,
  isGarmentMaterialProfileId,
  GARMENT_MATERIAL_UNKNOWN,
  type GarmentMaterialProfile,
  type GarmentMaterialProfileId,
} from "../../../items/garment-material";
import {
  addUnits,
  affordanceEvidence,
  complementUnit,
  multiplyUnits,
  toUnitInterval,
  type AffordanceEvidence,
  type DomainProfileResult,
  type UnitInterval,
} from "../../core";

/**
 * Stage 1 — the stable garment structure this domain reasons over.
 *
 * ## The wardrobe owns every number here
 *
 * `GarmentMaterialClass` IS `contracts/items/garment-material.ts`'s registry —
 * the seven material families plus its conservative `unknown` — and every
 * material-derived field below is a NORMALIZATION of that registry's existing
 * coefficients, never a second calibration of the same idea. The owner ruling is
 * explicit: "This spec MUST NOT create another material vocabulary or a parallel
 * coefficient set." So this file contains no material table at all; it contains
 * the mapping from the wardrobe's units into affordance units and nothing else.
 *
 * ## Why the profile is subject-scoped, not garment-scoped
 *
 * The spec sketches `GarmentStructuralProfile { garmentId, regions }` — one
 * garment. One affordance read is about one SUBJECT, and a subject wears several
 * garments whose regions occlude and layer over each other, so the shipped
 * profile is a flat collection of regions across everything worn, each carrying
 * its own `garmentId`/`partId`. That is the shared "regional collections"
 * pattern: one typed region profile instantiated per real region, never a
 * separate implementation per garment.
 *
 * ## What is deliberately NOT here
 *
 * Saturation, displacement, damage, fastened state, and occlusion are live
 * wardrobe state, not structure. They arrive in the frame.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * The material vocabulary — an ALIAS, not a copy. Adding a family to the
 * wardrobe registry adds it here with no edit, which is the whole point of the
 * ruling.
 */
export type GarmentMaterialClass = GarmentMaterialProfileId;

/**
 * How closely a garment region sits against the body.
 *
 * The spec's four values plus `unknown`, mirroring `GARMENT_MATERIAL_UNKNOWN`
 * exactly: the wardrobe has no fit owner yet (no item, blueprint, or instance
 * field records it), and the honest way to say "the wardrobe cannot answer" in
 * this codebase is a conservative registry member, not a guessed neighbour.
 *
 * `unknown` is conservative in the direction that matters. Contact establishment
 * (frame.ts §`garmentContactsFromFit`) accepts only `fitted` and `tight`, so an
 * unknown fit can never claim the body/garment contact wet cling requires — it
 * falls through to the pose/pressure path no lane can supply yet, and stays
 * silent. Its conformance coefficient sits mid-scale so a wet-opacity read is
 * neither exaggerated nor annihilated by the gap.
 */
export const garmentFitClasses = ["loose", "fitted", "tight", "structured", "unknown"] as const;
export const garmentFitClassSchema = z.enum(garmentFitClasses);
export type GarmentFitClass = z.infer<typeof garmentFitClassSchema>;

/** The conservative fallback: an unrecorded fit, which establishes no contact. */
export const GARMENT_FIT_UNKNOWN: GarmentFitClass = "unknown";

/** `${garmentId}:${partId}` — unique across everything one subject wears. */
export type GarmentRegionId = string;

export function garmentRegionId(garmentId: string, partId: string): GarmentRegionId {
  return `${garmentId}:${partId}`;
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

export interface GarmentRegionStructuralProfile {
  readonly regionId: GarmentRegionId;
  readonly garmentId: string;
  readonly partId: string;
  /** Body locations this region covers right now, in the wardrobe's own order. */
  readonly coveredBodyLocations: readonly string[];
  readonly materialClass: GarmentMaterialClass;
  readonly absorbency: UnitInterval;
  readonly clingAffinity: UnitInterval;
  readonly baselineOpacity: UnitInterval;
  readonly wetOpacityResponse: UnitInterval;
  readonly dryMass: UnitInterval;
  readonly dryDrapeStiffness: UnitInterval;
  readonly fit: GarmentFitClass;
}

export interface GarmentStructuralProfile {
  /** Every worn region, ordered by `regionId` so the profile is order-free. */
  readonly regions: readonly GarmentRegionStructuralProfile[];
}

/**
 * Dry mass, derived from the registry rather than authored.
 *
 * The wardrobe deliberately has no `weight` coefficient — the plan's registry is
 * about how a material RESPONDS, not how much it weighs. Stiffness of fall is
 * the closest honest proxy the registry offers (denim and leather are its stiff,
 * heavy families; silk and knit its light ones), damped toward the middle so a
 * derived term never pretends to the precision of an authored one.
 */
const DRY_MASS_BASE = toUnitInterval(3_000);

function dryMassOf(material: GarmentMaterialProfile): UnitInterval {
  return addUnits(DRY_MASS_BASE, multiplyUnits(toUnitInterval(material.drapeStiffness), complementUnit(DRY_MASS_BASE)));
}

/**
 * The wardrobe row this domain compiles one region from. The LANE builds it —
 * from garment instances, their blueprint snapshots, and presentation-aware
 * per-part coverage — so no affordance code reads a garment store.
 */
export const garmentRegionInputSchema = z
  .object({
    garmentId: z.string().trim().min(1).max(64),
    partId: z.string().trim().min(1).max(64),
    coveredBodyLocations: z.array(z.string().trim().min(1).max(64)).max(64).default([]),
    materialClass: z.string().trim().min(1).max(64),
    fit: z.string().trim().min(1).max(32).optional(),
    /**
     * The item definition's `opacity: "sheer"` override, which the wardrobe
     * already treats as beating the material default (garment-material.ts's OQ1
     * note). Absent ⇒ the material's own `baselineOpacity`.
     */
    sheer: z.boolean().optional(),
  })
  .strict();
export type GarmentRegionInput = z.infer<typeof garmentRegionInputSchema>;

/**
 * Baseline opacity of an authored-sheer garment. One value, low enough that a
 * sheer layer reads `hinted` rather than `opaque` before any wetting, which is
 * exactly what the wardrobe's own occlusion rule already says about sheer.
 */
export const GARMENT_SHEER_BASELINE_OPACITY = 3_500;

/** Diagnostic code: a lane row named a material the wardrobe registry does not know. */
export const GARMENT_UNKNOWN_MATERIAL = "affordance.garment.unknown_material";
/** Diagnostic code: a lane row named a fit outside the vocabulary. */
export const GARMENT_UNKNOWN_FIT = "affordance.garment.unknown_fit";

/**
 * Compile one subject's worn regions into structural profiles.
 *
 * Degradation is per FIELD, never per garment: a row naming a material the
 * registry has never heard of keeps its coverage and its fit and takes the
 * registry's own conservative `unknown` profile (opaque, mid-absorbency, barely
 * wet-responsive), because dropping the region would silently UNCOVER a body
 * location — the one direction this layer must never fail in.
 *
 * No regions at all ⇒ no profile ⇒ the core suppresses the whole domain. That is
 * right: a subject the lane could not read a wardrobe for is not a naked
 * subject, it is an unknown one.
 */
export function compileGarmentProfile(
  regions: readonly GarmentRegionInput[],
): DomainProfileResult<GarmentStructuralProfile> {
  const evidence: AffordanceEvidence[] = [];
  const diagnostics: Diagnostic[] = [];

  const compiled = regions.map((row): GarmentRegionStructuralProfile => {
    const regionId = garmentRegionId(row.garmentId, row.partId);
    const materialClass: GarmentMaterialClass = isGarmentMaterialProfileId(row.materialClass)
      ? row.materialClass
      : GARMENT_MATERIAL_UNKNOWN;
    if (materialClass !== row.materialClass) {
      diagnostics.push(
        diag("warn", GARMENT_UNKNOWN_MATERIAL, `garment region ${regionId}: unregistered material "${row.materialClass}"`, {
          path: regionId,
        }),
      );
    }
    const fitParsed = garmentFitClassSchema.safeParse(row.fit ?? GARMENT_FIT_UNKNOWN);
    if (!fitParsed.success) {
      diagnostics.push(
        diag("warn", GARMENT_UNKNOWN_FIT, `garment region ${regionId}: unmapped fit "${row.fit ?? ""}"`, {
          path: regionId,
        }),
      );
    }
    const material = garmentMaterialProfile(materialClass);
    evidence.push(affordanceEvidence("state", `garment:${regionId}`, materialClass));
    return {
      regionId,
      garmentId: row.garmentId,
      partId: row.partId,
      coveredBodyLocations: [...row.coveredBodyLocations],
      materialClass,
      absorbency: toUnitInterval(material.absorbency),
      clingAffinity: toUnitInterval(material.clingAffinity),
      baselineOpacity: toUnitInterval(row.sheer === true ? GARMENT_SHEER_BASELINE_OPACITY : material.baselineOpacity),
      wetOpacityResponse: toUnitInterval(material.wetOpacityResponse),
      dryMass: dryMassOf(material),
      dryDrapeStiffness: toUnitInterval(material.drapeStiffness),
      fit: fitParsed.success ? fitParsed.data : GARMENT_FIT_UNKNOWN,
    };
  });

  if (compiled.length === 0) return { evidence, diagnostics };
  return {
    profile: { regions: [...compiled].sort((left, right) => left.regionId.localeCompare(right.regionId)) },
    evidence,
    diagnostics,
  };
}

/**
 * Narrow an untyped lane payload's region list. `null` on a payload that is
 * present but unreadable — the caller reports `invalid`, never a default, since
 * a fabricated region list is a fabricated coverage read.
 */
export function parseGarmentRegions(raw: unknown): readonly GarmentRegionInput[] | null {
  const parsed = z.array(garmentRegionInputSchema).max(96).safeParse(raw);
  return parsed.success ? parsed.data : null;
}
