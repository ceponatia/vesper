import { diag, type Diagnostic } from "../../../diagnostics";
import {
  affordanceEvidence,
  axisContributionFor,
  AFFORDANCE_INPUT_INVALID,
  AFFORDANCE_INPUT_UNAVAILABLE,
  type AffordanceEvidence,
  type AttributeAxisDefinition,
  type DomainProfileResult,
  type ResolvedAttributeSnapshot,
  type UnitInterval,
} from "../../core";
import {
  hairAxisDiagnostics,
  hairConditionAxis,
  hairDensityAxis,
  hairLengthAxis,
  hairStrandThicknessAxis,
  hairTextureAxis,
} from "./attribute-maps";

/**
 * Stage 1 — the stable hair material and geometry compiled from resolved
 * canonical attributes.
 *
 * What is NOT here is the point: no wetness, no binding, no coverage, no
 * contact, no wind. The profile is a pure function of the attribute snapshot,
 * so identical attributes always give an identical profile and nothing about
 * "right now" can leak into a value that is supposed to be stable.
 *
 * It also carries no combined term. `hair.length` and `hair.density` do not
 * both write a vague final `mass` — `dryBulkLoad` is derived once, centrally,
 * in `mechanics.ts`.
 */
export interface HairStructuralProfile {
  readonly lengthScale: UnitInterval;
  /** Body locations this length could physically reach. Licenses contact; never asserts it. */
  readonly nominalReach: ReadonlySet<string>;
  readonly bulkDensity: UnitInterval;
  readonly strandThickness: UnitInterval;
  readonly flexibility: UnitInterval;
  readonly curlRetention: UnitInterval;
  readonly surfaceFriction: UnitInterval;
  readonly waterAbsorption: UnitInterval;
  readonly clumpAffinity: UnitInterval;
}

/**
 * Map one axis, recording provenance on success and the RIGHT failure on
 * absence: an unset attribute is `unavailable` (nobody authored it), a value the
 * table does not know is `invalid` (vocabulary drifted). Neither substitutes a
 * neighbouring value — the whole point of the partial map.
 */
function readAxis<TValue extends string, TContribution>(
  axis: AttributeAxisDefinition<TValue, TContribution>,
  attributes: ResolvedAttributeSnapshot,
  evidence: AffordanceEvidence[],
  diagnostics: Diagnostic[],
): TContribution | undefined {
  const hit = axisContributionFor(axis, attributes);
  if (hit !== undefined) {
    evidence.push(affordanceEvidence("attribute", axis.attributeId, hit.value));
    return hit.contribution;
  }
  const unset = attributes.byId(axis.attributeId)?.value === undefined;
  diagnostics.push(
    diag(
      "warn",
      unset ? AFFORDANCE_INPUT_UNAVAILABLE : AFFORDANCE_INPUT_INVALID,
      unset ? `hair structure: ${axis.attributeId} is unset` : `hair structure: ${axis.attributeId} holds unmapped vocabulary`,
      { path: axis.attributeId },
    ),
  );
  return undefined;
}

/**
 * Compile the structural profile, or none at all.
 *
 * All five axes are required structure: without length there is no geometry,
 * without density and strand thickness there is no load, and without texture
 * and condition there is no material. A blank axis therefore suppresses the
 * whole hair domain (the core's no-profile path) rather than being defaulted to
 * something convenient — an unauthored character simply has no hair read yet,
 * which is the conservative silence this layer is built around.
 *
 * Every missing axis is reported, not just the first, so one debug pass names
 * everything an author still has to fill in.
 */
export function compileHairProfile(attributes: ResolvedAttributeSnapshot): DomainProfileResult<HairStructuralProfile> {
  const evidence: AffordanceEvidence[] = [];
  const diagnostics: Diagnostic[] = [...hairAxisDiagnostics];

  const length = readAxis(hairLengthAxis, attributes, evidence, diagnostics);
  const density = readAxis(hairDensityAxis, attributes, evidence, diagnostics);
  const strand = readAxis(hairStrandThicknessAxis, attributes, evidence, diagnostics);
  const texture = readAxis(hairTextureAxis, attributes, evidence, diagnostics);
  const condition = readAxis(hairConditionAxis, attributes, evidence, diagnostics);

  if (
    length === undefined ||
    density === undefined ||
    strand === undefined ||
    texture === undefined ||
    condition === undefined
  ) {
    return { evidence, diagnostics };
  }

  return {
    profile: {
      lengthScale: length.lengthScale,
      nominalReach: length.nominalReach,
      bulkDensity: density.bulkDensity,
      strandThickness: strand.strandThickness,
      flexibility: texture.flexibility,
      curlRetention: texture.curlRetention,
      surfaceFriction: condition.surfaceFriction,
      waterAbsorption: condition.waterAbsorption,
      clumpAffinity: condition.clumpAffinity,
    },
    evidence,
    diagnostics,
  };
}
