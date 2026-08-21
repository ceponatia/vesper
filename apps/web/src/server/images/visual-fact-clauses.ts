import { appearanceAttributeRecognitionCatalog } from "@/contracts";
import { attributeRegistry, type AttributeValue } from "@/contracts/attributes";
import { bodyLocationRegistry } from "@/contracts/body/locations";
import { visualImageMorphologyOf, type VisualImageFact } from "@/contracts/images/visual-digest";
import type { VisualFactClause, VisualFactClauseResolver } from "@/contracts/images/visual-segments";
import {
  visualStateActiveConditionValueSchema,
  visualStateBodySurfaceWetnessValueSchema,
  visualStateSpeciesFeatureGroupValueSchema,
  VISUAL_STATE_BODY_LANGUAGE_FACING_KIND_ID,
  VISUAL_STATE_BODY_LANGUAGE_HAND_OCCUPATION_KIND_ID,
  VISUAL_STATE_BODY_LANGUAGE_MOTION_KIND_ID,
  VISUAL_STATE_BODY_LANGUAGE_POSTURE_KIND_ID,
  VISUAL_STATE_BODY_LANGUAGE_SUPPORT_KIND_ID,
  VISUAL_STATE_BODY_SURFACE_WETNESS_KIND_ID,
  VISUAL_STATE_CONDITION_ACTIVE_KIND_ID,
  VISUAL_STATE_GARMENT_CONDITION_KIND_ID,
  VISUAL_STATE_GARMENT_DAMAGE_KIND_ID,
  VISUAL_STATE_GARMENT_DEPOSIT_KIND_ID,
  VISUAL_STATE_GARMENT_MATERIAL_EFFECT_KIND_ID,
  VISUAL_STATE_GARMENT_PRESENTATION_KIND_ID,
  VISUAL_STATE_WARDROBE_GARMENT_KIND_ID,
  VISUAL_STATE_WARDROBE_ITEM_KIND_ID,
} from "@/contracts/visual-state";
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
 * render eligibility. The scene cutover (WP-C) added the wardrobe,
 * garment-state, body-language, condition and body-surface arms below; kinds
 * still without one (anatomy departures, located facts, presentation choices,
 * affordance observations) resolve `undefined` on purpose — fail-closed per the
 * subject digest's own ruling — and gain arms as their lanes cut over.
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
/**
 * A garment identity fact deliberately routed to the lane's own authoritative
 * wardrobe line (the scene queue's resolved outfit text; the avatar's occlusion-
 * filtered "Wearing" segment). One garment, one statement: until Stage 5 unifies
 * transport, the route-owned line is richer than the digest's `{ name, locus }`
 * value — and a REQUIRED worn-garment fact must resolve deliberately here, or
 * every chat with a garment store refuses its renders over a fact the prompt
 * states anyway.
 */
export const VISUAL_CLAUSE_OMIT_WARDROBE_ROUTE = "route_wardrobe_authoritative";
/**
 * A garment CURRENT-STATE fact (wet, open, rolled, stained) deliberately routed
 * to the chat lane's garment narration (`buildChatGarmentNarration` scene notes,
 * possessive-labelled per actor). Phrasing it here too would state the same
 * arrangement twice in one prompt — the duplication failure mode the lane
 * characterization freezes against.
 */
export const VISUAL_CLAUSE_OMIT_GARMENT_NOTES = "route_garment_notes";
/**
 * A body-language fact (posture, facing, support, contact) deliberately left to
 * the scene plan: committed scene facts already reach the shot through the
 * composer's authoritative context, the resolved camera, and the staging
 * registry — the pose policy this consolidation explicitly does not redesign
 * (image-lane-consolidation.plan.md §Boundaries). A digest clause beside the
 * staged sentence would put the same body in two poses in one prompt.
 */
export const VISUAL_CLAUSE_OMIT_SCENE_PLAN = "scene_plan_owned";

/**
 * Attribute ids whose facts CAN reach the digest (the appearance recognition
 * catalog's entries, projected only for distinctive values) but whose phrasing
 * each lane's route-owned residue still owns — the residual attribute sheets
 * and the scene anchor whitelist state the whole attribute vocabulary,
 * distinctive values included, so a digest clause for one would state the fact
 * twice (the duplication failure the lane characterization pins). ONE derived
 * set for every consuming lane: resolved as `{ omit }` (lane policy, never
 * degradation), and it retires with the residues when the projection grows
 * real attribute owners.
 */
export const RECOGNITION_RESIDUE_ATTRIBUTE_IDS: ReadonlySet<string> = new Set(
  appearanceAttributeRecognitionCatalog.map((entry) => entry.attributeId),
);

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
 * Wardrobe identity — the garment/item facts — resolves as a deliberate
 * omission everywhere: every consuming lane still carries its own authoritative
 * wardrobe line (see {@link VISUAL_CLAUSE_OMIT_WARDROBE_ROUTE}).
 */
const WARDROBE_ROUTE_KIND_IDS: ReadonlySet<string> = new Set([
  VISUAL_STATE_WARDROBE_GARMENT_KIND_ID,
  VISUAL_STATE_WARDROBE_ITEM_KIND_ID,
]);

/** Garment current state — owned by the lane's garment narration, not a digest clause. */
const GARMENT_NOTE_KIND_IDS: ReadonlySet<string> = new Set([
  VISUAL_STATE_GARMENT_CONDITION_KIND_ID,
  VISUAL_STATE_GARMENT_PRESENTATION_KIND_ID,
  VISUAL_STATE_GARMENT_DEPOSIT_KIND_ID,
  VISUAL_STATE_GARMENT_DAMAGE_KIND_ID,
  VISUAL_STATE_GARMENT_MATERIAL_EFFECT_KIND_ID,
]);

/** Body language — owned by the scene plan's camera/staging/pose resolution. */
const SCENE_PLAN_KIND_IDS: ReadonlySet<string> = new Set([
  VISUAL_STATE_BODY_LANGUAGE_POSTURE_KIND_ID,
  VISUAL_STATE_BODY_LANGUAGE_SUPPORT_KIND_ID,
  VISUAL_STATE_BODY_LANGUAGE_FACING_KIND_ID,
  VISUAL_STATE_BODY_LANGUAGE_HAND_OCCUPATION_KIND_ID,
  VISUAL_STATE_BODY_LANGUAGE_MOTION_KIND_ID,
]);

/**
 * An active condition, stated by its canonical key ("soaked", "blindfolded") —
 * the condition system's own committed identity, the one value that can name a
 * condition without inventing a second vocabulary. Its attribute EFFECTS are
 * not restated here: they already resolve into the subject's attributes.
 */
function activeConditionClause(fact: VisualImageFact): VisualFactClause {
  const parsed = visualStateActiveConditionValueSchema.safeParse(fact.value);
  return parsed.success ? parsed.data.condition : undefined;
}

/**
 * Standing wetness on skin or hair — "hair soaked", "skin damp". The location
 * word comes from the body-location registry; an unresolvable locus is
 * degradation, never a guessed surface.
 */
function bodySurfaceWetnessClause(fact: VisualImageFact): VisualFactClause {
  const parsed = visualStateBodySurfaceWetnessValueSchema.safeParse(fact.value);
  if (!parsed.success) return undefined;
  if (fact.locus.kind !== "body") return undefined;
  const location = bodyLocationRegistry.byId(fact.locus.locus.bodyLocationId);
  if (location === undefined) return undefined;
  return `${location.label.toLowerCase()} ${parsed.data.band}`;
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
    // The scene cutover's arms (WP-C). The omissions are ROUTE decisions, not
    // gaps: each of these owners already reaches the prompt through a richer
    // route-owned line, and a second statement would be the duplication failure
    // the characterization matrix freezes against.
    if (WARDROBE_ROUTE_KIND_IDS.has(fact.kindId)) return { omit: VISUAL_CLAUSE_OMIT_WARDROBE_ROUTE };
    if (GARMENT_NOTE_KIND_IDS.has(fact.kindId)) return { omit: VISUAL_CLAUSE_OMIT_GARMENT_NOTES };
    if (SCENE_PLAN_KIND_IDS.has(fact.kindId)) return { omit: VISUAL_CLAUSE_OMIT_SCENE_PLAN };
    if (fact.kindId === VISUAL_STATE_CONDITION_ACTIVE_KIND_ID) return activeConditionClause(fact);
    if (fact.kindId === VISUAL_STATE_BODY_SURFACE_WETNESS_KIND_ID) return bodySurfaceWetnessClause(fact);
    // No canonical phrasing arm yet (anatomy departures, located facts,
    // presentation choices, affordance observations). Degradation by design: a
    // required fact lands in `missingRequired` and the route refuses before
    // spend rather than painting a fingerprint (spec.prompts.md §Failure
    // behavior).
    return undefined;
  };
}
