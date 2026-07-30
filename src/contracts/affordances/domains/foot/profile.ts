import { diag, type Diagnostic } from "../../../diagnostics";
import {
  affordanceEvidence,
  axisContributionFor,
  complementUnit,
  multiplyUnits,
  toUnitInterval,
  AFFORDANCE_INPUT_INVALID,
  AFFORDANCE_INPUT_UNAVAILABLE,
  AFFORDANCE_UNIT_ZERO,
  type AffordanceEvidence,
  type AttributeAxisDefinition,
  type DomainProfileResult,
  type ResolvedAttributeSnapshot,
  type UnitInterval,
} from "../../core";
import {
  footArchAxis,
  footAxisDiagnostics,
  footNailAxis,
  footToeAxis,
  type FootArchContribution,
  type FootNailContribution,
  type FootToeContribution,
} from "./attribute-maps";
import {
  footSurfaceCoverageLocationId,
  footSurfaceSubtree,
  footSurfaceTopology,
  type FootStructureKind,
  type FootSurfaceId,
} from "./topology";

/**
 * Stage 1 — the stable regional structure of one character's feet
 * (romantic-contact-affordances.spec.foot.md §"Profile compilation").
 *
 * ## Sparse parent, calibrated child
 *
 * Three seeds (plantar, dorsal, toes) plus the ankle carry a full profile;
 * every other surface inherits its parent and applies a small signed modifier.
 * That is the spec's own shape and it exists so an author never has to fill in a
 * heel and an arch separately: the difference between them is physics, and
 * physics belongs in a calibration table, not on a character sheet.
 *
 * The toenail is the one surface that does NOT inherit — keratin is not skin,
 * and letting it take the toes' softness would make a nail as yielding as a toe
 * pad with a modifier large enough to be a second seed in disguise.
 *
 * ## The one law the shape guarantees
 *
 * `softness = baseSoftness × (1 − callus)`. Callus is therefore never able to
 * raise softness at the same locus, whatever the tables say — the spec's test
 * property holds structurally rather than by inspection of the numbers.
 *
 * Nothing current lives here: no moisture, no footwear, no contact, no pose. A
 * profile is a pure function of the resolved attribute snapshot.
 */

export const footTextureBands = ["smooth", "fine", "firm", "coarse", "hard"] as const;
export type FootTextureBand = (typeof footTextureBands)[number];

export interface FootSurfaceStructuralProfile {
  readonly surfaceId: FootSurfaceId;
  readonly parentSurfaceId?: FootSurfaceId;
  /** The exact registry locus; `coverageLocationId` is what an observation reports. */
  readonly bodyLocationId: string;
  readonly coverageLocationId: string;
  readonly structureKind: FootStructureKind;
  readonly softness: UnitInterval;
  readonly compliance: UnitInterval;
  readonly drySurfaceFriction: UnitInterval;
  readonly callusBand: UnitInterval;
  readonly moistureRetention: UnitInterval;
  readonly airflowExposure: UnitInterval;
  /** How much load this surface ordinarily takes — the ball's is the highest. */
  readonly pressureExposure: UnitInterval;
  readonly tactileTextureBand: FootTextureBand;
  /** Free nail edge; `0` on every skin surface. */
  readonly nailEdgeProminence: UnitInterval;
}

export interface FootStructuralProfile {
  /** One entry per topology surface, in topology order. */
  readonly surfaces: readonly FootSurfaceStructuralProfile[];
}

export function footSurfaceProfile(
  profile: FootStructuralProfile,
  surfaceId: FootSurfaceId,
): FootSurfaceStructuralProfile | undefined {
  return profile.surfaces.find((surface) => surface.surfaceId === surfaceId);
}

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------

/** The mutable terms a seed states and a modifier shifts. */
interface FootSurfaceTerms {
  readonly baseSoftness: number;
  readonly compliance: number;
  readonly drySurfaceFriction: number;
  readonly callusBand: number;
  readonly moistureRetention: number;
  readonly airflowExposure: number;
  readonly pressureExposure: number;
}

/**
 * The three root surfaces plus the ankle boundary.
 *
 * The plantar seed is the reference: an ordinary sole, moderately callused,
 * moderately grippy, taking most of the load. The dorsal seed is its opposite on
 * every axis — thin skin, almost no callus, fully exposed to air — which is what
 * makes "the sole is damp while the top of the foot has dried" fall out of the
 * distribution rule instead of being asserted.
 */
const FOOT_SEEDS: Readonly<Record<string, FootSurfaceTerms>> = {
  plantar_surface: {
    baseSoftness: 5_000,
    compliance: 5_000,
    drySurfaceFriction: 5_500,
    callusBand: 4_000,
    moistureRetention: 4_000,
    airflowExposure: 5_000,
    pressureExposure: 6_000,
  },
  dorsal_surface: {
    baseSoftness: 6_500,
    compliance: 4_000,
    drySurfaceFriction: 3_000,
    callusBand: 500,
    moistureRetention: 2_000,
    airflowExposure: 9_000,
    pressureExposure: 1_500,
  },
  toes: {
    baseSoftness: 6_000,
    compliance: 5_500,
    drySurfaceFriction: 4_500,
    callusBand: 2_000,
    moistureRetention: 5_000,
    airflowExposure: 6_000,
    pressureExposure: 4_000,
  },
  ankle_boundary: {
    baseSoftness: 5_500,
    compliance: 4_500,
    drySurfaceFriction: 3_500,
    callusBand: 500,
    moistureRetention: 2_500,
    airflowExposure: 8_500,
    pressureExposure: 1_000,
  },
};

/** Signed shifts a child applies to what it inherited. Sparse by design. */
type FootSurfaceModifier = Partial<FootSurfaceTerms>;

const FOOT_MODIFIERS: Readonly<Partial<Record<FootSurfaceId, FootSurfaceModifier>>> = {
  // Firmer, more callused, less compliant — the spec's heel, verbatim.
  heel_pad: { callusBand: 3_000, compliance: -2_000, drySurfaceFriction: 1_500, pressureExposure: 2_000 },
  // Softer and more compliant, and it takes far less load than the ball.
  arch: { callusBand: -2_500, compliance: 2_000, drySurfaceFriction: -1_000, pressureExposure: -3_000 },
  medial_arch: { callusBand: -500, compliance: 500 },
  lateral_arch: { callusBand: 500, compliance: -500 },
  ball: { callusBand: 2_000, compliance: -1_000, drySurfaceFriction: 1_000, pressureExposure: 3_500 },
  inner_edge: { callusBand: -500, pressureExposure: -1_500 },
  outer_edge: { callusBand: 1_000, pressureExposure: 500 },
  toe_tops: { callusBand: -1_000, airflowExposure: 2_000, moistureRetention: -1_500 },
  toe_pads: { callusBand: 1_000, compliance: -500, pressureExposure: 1_500 },
  // The one surface where retention and airflow move in opposite directions.
  interdigital_spaces: { moistureRetention: 3_500, airflowExposure: -4_000, callusBand: -1_500, compliance: 1_000 },
};

/** How far `feet.arch` can push the arch surfaces toward the loaded end. */
const ARCH_GROUND_CALLUS_SPAN = 3_000;
const ARCH_GROUND_PRESSURE_SPAN = 4_000;

/** How far `feet.toes` can deepen the interdigital spaces. */
const TOE_DEPTH_RETENTION_SPAN = 2_500;
const TOE_DEPTH_AIRFLOW_SPAN = 2_500;

/** The nail plate's own structure. Not inherited: keratin is not skin. */
const NAIL_COMPLIANCE = 300;
const NAIL_MOISTURE_RETENTION = 500;
const NAIL_AIRFLOW_EXPOSURE = 8_000;
const NAIL_PRESSURE_EXPOSURE = 2_000;
/** Dry friction of a nail plate at zero smoothness; a polished plate slides. */
const NAIL_ROUGH_FRICTION = 6_000;

const CALLUS_COARSE_MIN = 6_500;
const CALLUS_FIRM_MIN = 4_000;
const SOFTNESS_SMOOTH_MIN = 6_000;

/** Total: every surface lands in exactly one band. */
export function footTextureBandOf(input: {
  structureKind: FootStructureKind;
  callusBand: UnitInterval;
  softness: UnitInterval;
}): FootTextureBand {
  if (input.structureKind === "keratin") return "hard";
  if (input.callusBand >= CALLUS_COARSE_MIN) return "coarse";
  if (input.callusBand >= CALLUS_FIRM_MIN) return "firm";
  return input.softness >= SOFTNESS_SMOOTH_MIN ? "smooth" : "fine";
}

/** Position on the ordered roughness scale — `0` for `smooth`, `4` for `hard`. */
export function footTextureBandRank(band: FootTextureBand): number {
  return footTextureBands.indexOf(band);
}

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

interface FootAxisRead<TContribution> {
  readonly contribution?: TContribution;
  readonly evidence?: AffordanceEvidence;
  readonly diagnostic?: Diagnostic;
}

/**
 * Map one axis, recording provenance on success and the RIGHT failure on
 * absence: an unauthored attribute is `unavailable`, a value the table does not
 * know is `invalid`. Neither substitutes a neighbouring value.
 */
function readFootAxis<TValue extends string, TContribution>(
  axis: AttributeAxisDefinition<TValue, TContribution>,
  attributes: ResolvedAttributeSnapshot,
): FootAxisRead<TContribution> {
  const hit = axisContributionFor(axis, attributes);
  if (hit !== undefined) {
    return {
      contribution: hit.contribution,
      evidence: affordanceEvidence("attribute", axis.attributeId, hit.value),
    };
  }
  const authored = attributes.byId(axis.attributeId)?.value !== undefined;
  return {
    diagnostic: diag(
      "warn",
      authored ? AFFORDANCE_INPUT_INVALID : AFFORDANCE_INPUT_UNAVAILABLE,
      `foot structure: ${axis.attributeId} ${authored ? "holds unmapped vocabulary" : "is unset"}`,
      { path: axis.attributeId },
    ),
  };
}

function shiftTerms(base: FootSurfaceTerms, modifier: FootSurfaceModifier | undefined): FootSurfaceTerms {
  if (modifier === undefined) return base;
  return {
    baseSoftness: base.baseSoftness + (modifier.baseSoftness ?? 0),
    compliance: base.compliance + (modifier.compliance ?? 0),
    drySurfaceFriction: base.drySurfaceFriction + (modifier.drySurfaceFriction ?? 0),
    callusBand: base.callusBand + (modifier.callusBand ?? 0),
    moistureRetention: base.moistureRetention + (modifier.moistureRetention ?? 0),
    airflowExposure: base.airflowExposure + (modifier.airflowExposure ?? 0),
    pressureExposure: base.pressureExposure + (modifier.pressureExposure ?? 0),
  };
}

/**
 * Each authored axis is applied at the ONE surface that owns it, never at a
 * descendant.
 *
 * A child inherits its parent's already-shifted terms, so an axis re-applied
 * down the tree compounds: the arch's ground bonus landed on `arch`, then again
 * on `medial_arch` and `lateral_arch`, doubling a 3_000 span into 6_000 and
 * pushing a flat foot's lateral arch past its own heel. Ownership is therefore
 * an exact surface-id match, and the inheritance walk carries the result.
 */
const ARCH_AXIS_SURFACE: FootSurfaceId = "arch";
const TOE_AXIS_SURFACE: FootSurfaceId = "interdigital_spaces";

function applyArchGround(surfaceId: FootSurfaceId, terms: FootSurfaceTerms, arch: FootArchContribution): FootSurfaceTerms {
  if (surfaceId !== ARCH_AXIS_SURFACE) return terms;
  const ground = arch.archGroundContact;
  return {
    ...terms,
    callusBand: terms.callusBand + multiplyUnits(ground, toUnitInterval(ARCH_GROUND_CALLUS_SPAN)),
    pressureExposure: terms.pressureExposure + multiplyUnits(ground, toUnitInterval(ARCH_GROUND_PRESSURE_SPAN)),
  };
}

function applyToeDepth(surfaceId: FootSurfaceId, terms: FootSurfaceTerms, toe: FootToeContribution): FootSurfaceTerms {
  if (surfaceId !== TOE_AXIS_SURFACE) return terms;
  const depth = toe.interdigitalDepth;
  return {
    ...terms,
    moistureRetention: terms.moistureRetention + multiplyUnits(depth, toUnitInterval(TOE_DEPTH_RETENTION_SPAN)),
    airflowExposure: terms.airflowExposure - multiplyUnits(depth, toUnitInterval(TOE_DEPTH_AIRFLOW_SPAN)),
  };
}

function skinProfile(input: {
  surfaceId: FootSurfaceId;
  parentSurfaceId?: FootSurfaceId;
  bodyLocationId: string;
  terms: FootSurfaceTerms;
}): FootSurfaceStructuralProfile {
  const callusBand = toUnitInterval(input.terms.callusBand);
  const softness = multiplyUnits(toUnitInterval(input.terms.baseSoftness), complementUnit(callusBand));
  return {
    surfaceId: input.surfaceId,
    ...(input.parentSurfaceId === undefined ? {} : { parentSurfaceId: input.parentSurfaceId }),
    bodyLocationId: input.bodyLocationId,
    coverageLocationId: footSurfaceCoverageLocationId(input.surfaceId),
    structureKind: "skin",
    softness,
    compliance: toUnitInterval(input.terms.compliance),
    drySurfaceFriction: toUnitInterval(input.terms.drySurfaceFriction),
    callusBand,
    moistureRetention: toUnitInterval(input.terms.moistureRetention),
    airflowExposure: toUnitInterval(input.terms.airflowExposure),
    pressureExposure: toUnitInterval(input.terms.pressureExposure),
    tactileTextureBand: footTextureBandOf({ structureKind: "skin", callusBand, softness }),
    nailEdgeProminence: AFFORDANCE_UNIT_ZERO,
  };
}

function nailProfile(input: {
  surfaceId: FootSurfaceId;
  parentSurfaceId?: FootSurfaceId;
  bodyLocationId: string;
  nail: FootNailContribution;
}): FootSurfaceStructuralProfile {
  return {
    surfaceId: input.surfaceId,
    ...(input.parentSurfaceId === undefined ? {} : { parentSurfaceId: input.parentSurfaceId }),
    bodyLocationId: input.bodyLocationId,
    coverageLocationId: footSurfaceCoverageLocationId(input.surfaceId),
    structureKind: "keratin",
    softness: AFFORDANCE_UNIT_ZERO,
    compliance: toUnitInterval(NAIL_COMPLIANCE),
    // A polished plate slides; a chipped one catches. One authored value, one term.
    drySurfaceFriction: multiplyUnits(
      complementUnit(input.nail.nailSurfaceSmoothness),
      toUnitInterval(NAIL_ROUGH_FRICTION),
    ),
    callusBand: AFFORDANCE_UNIT_ZERO,
    moistureRetention: toUnitInterval(NAIL_MOISTURE_RETENTION),
    airflowExposure: toUnitInterval(NAIL_AIRFLOW_EXPOSURE),
    pressureExposure: toUnitInterval(NAIL_PRESSURE_EXPOSURE),
    tactileTextureBand: "hard",
    nailEdgeProminence: input.nail.nailEdgeProminence,
  };
}

/**
 * Compile every surface an axis can vouch for; omit the ones it cannot.
 *
 * Each axis gates ONLY the surfaces its calibration owns:
 *
 * - `feet.arch` calibrates the arch subtree (`arch`, `medial_arch`,
 *   `lateral_arch`) — without it those three are omitted;
 * - `feet.nails` is the toenail's whole surface — without it the keratin node is
 *   omitted;
 * - `feet.toes` deepens the interdigital spaces — without it that one surface is
 *   omitted.
 *
 * Everything else — heel, ball, sole, edges, dorsal, toe tops and pads, ankle —
 * is seed-and-modifier calibration that no authored axis touches, so it compiles
 * regardless. A read at an omitted surface suppresses downstream
 * (`surface_unprofiled`), which keeps the failure exactly as wide as the gap: a
 * character with no toenail upkeep has no nail read, not no foot.
 *
 * A missing axis is still never DEFAULTED: an unset attribute omits its surfaces
 * with `unavailable`, a value the table does not know omits the same surfaces
 * with `invalid`, and neither substitutes a registry default or a neighbouring
 * value. Every missing axis is reported, not just the first.
 */
export function compileFootProfile(attributes: ResolvedAttributeSnapshot): DomainProfileResult<FootStructuralProfile> {
  const arch = readFootAxis(footArchAxis, attributes);
  const nail = readFootAxis(footNailAxis, attributes);
  const toe = readFootAxis(footToeAxis, attributes);
  const reads = [arch, nail, toe];

  const evidence: AffordanceEvidence[] = reads.flatMap((read) => (read.evidence === undefined ? [] : [read.evidence]));
  const diagnostics: Diagnostic[] = [
    ...footAxisDiagnostics,
    ...reads.flatMap((read) => (read.diagnostic === undefined ? [] : [read.diagnostic])),
  ];

  const archValue = arch.contribution;
  const nailValue = nail.contribution;
  const toeValue = toe.contribution;

  const omitted = new Set<FootSurfaceId>();
  if (archValue === undefined) for (const id of footSurfaceSubtree(ARCH_AXIS_SURFACE)) omitted.add(id);
  if (toeValue === undefined) omitted.add(TOE_AXIS_SURFACE);

  const termsBySurface = new Map<FootSurfaceId, FootSurfaceTerms>();
  const surfaces: FootSurfaceStructuralProfile[] = [];

  // Topology order is parents-before-children, so an inherited value is always
  // already resolved by the time a child asks for it.
  for (const node of footSurfaceTopology) {
    if (node.structureKind === "keratin") {
      if (nailValue === undefined) continue;
      surfaces.push(
        nailProfile({
          surfaceId: node.id,
          ...(node.parentId === undefined ? {} : { parentSurfaceId: node.parentId }),
          bodyLocationId: node.bodyLocationId,
          nail: nailValue,
        }),
      );
      continue;
    }
    if (omitted.has(node.id)) continue;
    const inherited = node.parentId === undefined ? FOOT_SEEDS[node.id] : termsBySurface.get(node.parentId);
    if (inherited === undefined) {
      throw new Error(`Foot surface ${node.id} has neither a seed nor a resolved parent`);
    }
    const base = shiftTerms(inherited, FOOT_MODIFIERS[node.id]);
    const archApplied = archValue === undefined ? base : applyArchGround(node.id, base, archValue);
    const shifted = toeValue === undefined ? archApplied : applyToeDepth(node.id, archApplied, toeValue);
    termsBySurface.set(node.id, shifted);
    surfaces.push(
      skinProfile({
        surfaceId: node.id,
        ...(node.parentId === undefined ? {} : { parentSurfaceId: node.parentId }),
        bodyLocationId: node.bodyLocationId,
        terms: shifted,
      }),
    );
  }

  return { profile: { surfaces }, evidence, diagnostics };
}
