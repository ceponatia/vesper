import { attributeRegistry, type AttributeValue } from "@/contracts/attributes";
import { visualImageMorphologyOf, type VisualImageFact } from "@/contracts/images/visual-digest";
import type { VisualFactClause, VisualFactClauseResolver } from "@/contracts/images/visual-segments";
import { visualStateSpeciesFeatureGroupValueSchema } from "@/contracts/visual-state";
import type { RealizedBody } from "@/contracts/species";
import { capitalizeFirst, formatAttribute, formatAttributeValue, isNonVisualAttribute } from "./prompts-format";

/**
 * THE lane-neutral clause table for digest facts (image-lane-consolidation
 * Stage 3, spec.prompts.md §Segment mapping). One resolver, shared by every
 * character-bearing cutover: the avatar consumes it now, and the scene cutover
 * reuses this same module rather than growing a second wording table — the
 * reference-count ruling ("one segment builder") applied to phrasing.
 *
 * A digest fact arrives in one of two shapes (`subject-digest.ts` §"Where the
 * semantic value comes from"):
 *
 * - **Fingerprint-valued** — appearance facts adapted from `ProjectedFeatureTruth`
 *   carry their truth fingerprint as `value`, so the prose must come from the
 *   canonical owner. For an attribute-sourced fact that owner is the attribute
 *   registry plus the subject's resolved values, which is exactly what this
 *   module consults.
 * - **Structured** — a species feature group carries `{ group }`. Its clause is
 *   the group's authored descriptive attributes ("Horns: spiraled"), and when
 *   none are authored the group WORD itself: the fact asserts the appendage
 *   exists, and `undefined` here would refuse every sparsely authored non-human
 *   render over an anchor the profile genuinely holds.
 *
 * The three answers mean different things downstream (`visual-segments.ts`):
 * a string is the clause; `{ omit }` is a deliberate lane/registry cut recorded
 * as a suppression; `undefined` is degradation, which costs a REQUIRED fact its
 * render eligibility. Kinds with no arm here yet (wardrobe, current state, body
 * language, anatomy departures) resolve `undefined` on purpose — fail-closed
 * per the subject digest's own ruling — and gain arms as their lanes cut over.
 *
 * Pure: registry + passed-in values only.
 */

/** A lane's curated attribute cut — a design decision, never degradation. */
export const VISUAL_CLAUSE_OMIT_CURATED = "lane_curated";
/** The registry excludes this attribute from every generated prompt. */
export const VISUAL_CLAUSE_OMIT_REGISTRY = "registry_excluded";
/** `kind: "sensory"` — voice and scent have nothing visual for an image to state. */
export const VISUAL_CLAUSE_OMIT_NONVISUAL = "nonvisual";
/** A resolved `"none"` the prompt deliberately elides (`promptValueWithNoneElided`). */
export const VISUAL_CLAUSE_OMIT_ELIDED = "value_elided";
/** The realized body gates this attribute off — a stale value must not outlive the body. */
export const VISUAL_CLAUSE_OMIT_INAPPLICABLE = "body_inapplicable";

export interface VisualFactClauseSources {
  /** The subject's RESOLVED attribute values — the canonical owner attribute facts phrase from. */
  readonly attributes: readonly AttributeValue[];
  /** The subject's realized body; when present, inapplicable attributes are elided. */
  readonly realizedBody?: RealizedBody;
  /** Attribute ids this lane's curated policy withholds (the avatar's waist-up omit list). */
  readonly omitAttributeIds?: ReadonlySet<string>;
}

function attributeClause(attributeId: string, sources: VisualFactClauseSources): VisualFactClause {
  if (sources.omitAttributeIds?.has(attributeId)) return { omit: VISUAL_CLAUSE_OMIT_CURATED };
  const def = attributeRegistry.byId(attributeId);
  if (def === undefined) return undefined; // unknown vocabulary — degradation, never a raw id in a prompt
  if (def.excludeFromPrompts === true) return { omit: VISUAL_CLAUSE_OMIT_REGISTRY };
  if (isNonVisualAttribute(def)) return { omit: VISUAL_CLAUSE_OMIT_NONVISUAL };
  if (sources.realizedBody !== undefined && !sources.realizedBody.isAttributeApplicable(def)) {
    return { omit: VISUAL_CLAUSE_OMIT_INAPPLICABLE };
  }
  const value = sources.attributes.find((entry) => entry.id === attributeId)?.value;
  if (value === undefined) return undefined; // the owner holds no value — nothing honest to say
  const formatted = formatAttribute(def, value);
  return formatted.length > 0 ? formatted : { omit: VISUAL_CLAUSE_OMIT_ELIDED };
}

/**
 * The clause for one species feature group: its authored descriptive attributes
 * ("Horns: spiraled, ridged"), else the bare group word ("wings") — existence is
 * the fact, and a required morphology anchor must never unresolve merely
 * because nobody authored what the wings look like.
 */
function speciesGroupClause(fact: VisualImageFact, sources: VisualFactClauseSources): VisualFactClause {
  const parsed = visualStateSpeciesFeatureGroupValueSchema.safeParse(fact.value);
  if (!parsed.success) return undefined;
  const group = parsed.data.group;
  const tokens: string[] = [];
  for (const value of sources.attributes) {
    const def = attributeRegistry.byId(value.id);
    if (def === undefined || def.category !== group) continue;
    if (def.excludeFromPrompts === true || isNonVisualAttribute(def)) continue;
    if (sources.omitAttributeIds?.has(def.id)) continue;
    if (sources.realizedBody !== undefined && !sources.realizedBody.isAttributeApplicable(def)) continue;
    const token = formatAttributeValue(def, value.value);
    if (token) tokens.push(token);
  }
  return tokens.length > 0 ? `${capitalizeFirst(group)}: ${tokens.join(", ")}` : group;
}

/**
 * The shared resolver over one subject's canonical owners. Deterministic over
 * its inputs; consult it through `buildVisualSubjectSegments` only.
 */
export function visualFactClauseResolver(sources: VisualFactClauseSources): VisualFactClauseResolver {
  return (fact) => {
    if (visualImageMorphologyOf(fact.kindId) === "species_feature_group") {
      return speciesGroupClause(fact, sources);
    }
    if (fact.sourceRef.kind === "appearance" && fact.sourceRef.ref.kind === "attribute") {
      return attributeClause(fact.sourceRef.ref.attributeId, sources);
    }
    // No canonical phrasing arm yet (anatomy departures, located facts, and the
    // scene-owned kinds). Degradation by design: a required fact lands in
    // `missingRequired` and the route refuses before spend rather than painting
    // a fingerprint (spec.prompts.md §Failure behavior).
    return undefined;
  };
}
