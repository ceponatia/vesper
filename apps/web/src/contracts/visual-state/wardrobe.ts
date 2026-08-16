import {
  affordanceEvidence,
  AFFORDANCE_UNIT_ONE,
  divideUnits,
  toUnitInterval,
  type AffordanceEvidence,
  type UnitInterval,
} from "../affordances/core";
import { bodyLocationRegistry } from "../body/locations";
import type { DiagnosticSink } from "../diagnostics";
import type { GarmentBlueprint } from "../items/garment-blueprint";
import type { GarmentInstanceState, GarmentLocus } from "../items/garment-instance";
import { subtypedClothingCategoryIds } from "../items/subtypes";
import {
  validateVisualStateFeature,
  visualStateFeatureKey,
  visualStateFingerprint,
  type VisualStateFeature,
} from "./feature";
import {
  VISUAL_STATE_WARDROBE_GARMENT_KIND_ID,
  VISUAL_STATE_WARDROBE_ITEM_KIND_ID,
  type VisualStateWardrobeValue,
} from "./kinds";
import type { VisualStateLocusRef } from "./locus";
import type { VisualStateAttentionPriors } from "./priors";
import { visualStateKindRegistry } from "./registry";
import type { VisualStateRelationship } from "./relationships";
import type { VisualStateSourceRef } from "./sources";

/**
 * Garment and item loci as presentation features
 * (visual-state.audit.md finding 10 — the wardrobe stack is complete and gated
 * off, and slices 2 and 3 consume it).
 *
 * What this adapter projects is deliberately narrow: what a piece IS and WHERE
 * it sits. Closure, roll, tuck, displacement, wetness, deposits and damage are
 * the garment's CURRENT state and belong to slice 3 on the current layer; the
 * wardrobe owner already derives and fingerprints all of it
 * (`garment-effective-coverage.ts`, `garment-digest.ts`), so re-deriving any of
 * it here would be the second wardrobe the plan forbids.
 *
 * Three loci are visual and get projected — `worn`, `held`, and `scene` (the
 * jacket left over the desk chair, which is what makes it stop vanishing between
 * turns). `wardrobe` and `gone` are not: a shirt in a drawer and a coat the
 * fiction destroyed are wardrobe truth with nothing to see, and projecting them
 * would put facts into an image digest that no camera can support.
 *
 * ## What the adapter needs that the garment store does not carry
 *
 * A `GarmentInstanceState` knows its name, its blueprint and its locus. It does
 * not know the library definition's clothing CATEGORY or LAYER — those live on
 * the item definition, and materialization deliberately keeps the instance
 * independent of a library row that may later be edited or deleted. Both are
 * therefore optional inputs the caller supplies, and both degrade to silence:
 * no category means the piece is treated as ordinary clothing, and no layer
 * means no occlusion edge rather than a guessed stacking order.
 */

/** Clothing categories that carry an accessory vocabulary: jewelry, headwear, eyewear. */
const ACCESSORY_CATEGORY_IDS: ReadonlySet<string> = new Set(subtypedClothingCategoryIds);

/**
 * Accessory categories that ATTACH rather than conceal.
 *
 * A ring does not hide a finger and glasses do not hide eyes — eyewear's own
 * registry says so, noting that treating its coverage as concealment is a
 * simplification only a blindfold earns. Headwear is deliberately absent: a hat
 * genuinely covers hair, which is the plan's own worked example.
 */
const ATTACHING_CATEGORY_IDS: ReadonlySet<string> = new Set(["jewelry", "eyewear"]);

/** Denominator floor for the occlusion overlap ratio — one covered location. */
const OVERLAP_DENOMINATOR_FLOOR = 1;

export interface VisualStateGarmentInput {
  readonly instance: GarmentInstanceState;
  /** The instance's blueprint, resolved by the caller (`garmentBlueprintFor`). */
  readonly blueprint: GarmentBlueprint;
  /** The library definition's clothing category, when the piece has library provenance. */
  readonly categoryId?: string;
  /** The accessory subtype id ("earring", "glasses") — prompt-bearing upstream. */
  readonly subtypeId?: string;
  /** 0 underwear · 1 base · 2 mid · 3 outerwear. Absent ⇒ this piece stacks with nothing. */
  readonly layer?: number;
}

export interface VisualStateWardrobeProjectionInput {
  readonly garments: readonly VisualStateGarmentInput[];
  /**
   * Garment actor handle (`c:<characterId>`, `player`) → the visual subject id.
   *
   * The caller scopes the snapshot, so a garment whose actor is not in this map
   * is simply not in this snapshot; that is not a degraded read and produces no
   * diagnostic.
   */
  readonly subjectsByActor: ReadonlyMap<string, string>;
  /**
   * The subject a garment left in the current place hangs under.
   *
   * A jacket over a chair belongs to nobody — `garmentLocusActorId` returns
   * `undefined` for a scene locus — but every feature needs a subject, so the
   * caller names the one the scene's own facts are filed under. Absent ⇒ loose
   * garments are not projected.
   */
  readonly sceneSubjectId?: string;
  /**
   * Features earlier adapters produced. Cover and attach edges are emitted only
   * against these, so this adapter never asserts an edge that would resolve away
   * as a missing target.
   */
  readonly composeAgainst?: readonly VisualStateFeature[];
  readonly sink?: DiagnosticSink;
  readonly path?: string;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Everything one garment reaches, its blueprint's baseline coverage expanded down the body tree. */
function coveredLocations(blueprint: GarmentBlueprint): ReadonlySet<string> {
  const covered = new Set<string>();
  for (const node of blueprint.nodes) {
    for (const locationId of node.baselineCoverage) {
      for (const expanded of bodyLocationRegistry.expand(locationId)) covered.add(expanded);
    }
  }
  return covered;
}

/** The subject a locus puts the garment under, or `undefined` when it is not a visual fact. */
function subjectForLocus(locus: GarmentLocus, input: VisualStateWardrobeProjectionInput): string | undefined {
  switch (locus.kind) {
    case "worn":
    case "held":
      return input.subjectsByActor.get(locus.actorId);
    case "scene":
      return input.sceneSubjectId;
    case "wardrobe":
    case "gone":
      return undefined;
  }
}

/** One garment resolved into the snapshot's vocabulary, before its edges are computed. */
interface ResolvedGarment {
  readonly input: VisualStateGarmentInput;
  readonly subjectId: string;
  readonly kindId: string;
  readonly key: string;
  readonly locus: VisualStateLocusRef;
  readonly covered: ReadonlySet<string>;
  /** True for `worn` and `held` — the loci a render must not silently change. */
  readonly onBody: boolean;
}

function resolveGarments(input: VisualStateWardrobeProjectionInput): ResolvedGarment[] {
  const resolved: ResolvedGarment[] = [];
  for (const garment of input.garments) {
    const subjectId = subjectForLocus(garment.instance.locus, input);
    if (subjectId === undefined) continue;
    const kindId =
      garment.categoryId !== undefined && ACCESSORY_CATEGORY_IDS.has(garment.categoryId)
        ? VISUAL_STATE_WARDROBE_ITEM_KIND_ID
        : VISUAL_STATE_WARDROBE_GARMENT_KIND_ID;
    const locus: VisualStateLocusRef = { kind: "item", itemInstanceId: garment.instance.id };
    resolved.push({
      input: garment,
      subjectId,
      kindId,
      key: visualStateFeatureKey(subjectId, locus, kindId),
      locus,
      covered: coveredLocations(garment.blueprint),
      onBody: garment.instance.locus.kind === "worn" || garment.instance.locus.kind === "held",
    });
  }
  return resolved;
}

/**
 * The body features this piece sits on: the identity and presentation facts of
 * its own subject that fall inside its coverage.
 */
function bodyTargets(
  garment: ResolvedGarment,
  composeAgainst: readonly VisualStateFeature[],
): readonly string[] {
  const keys: string[] = [];
  for (const target of composeAgainst) {
    if (target.subjectId !== garment.subjectId) continue;
    if (target.locus.kind !== "body") continue;
    if (!garment.covered.has(target.locus.locus.bodyLocationId)) continue;
    keys.push(target.key);
  }
  return keys.sort(compareStrings);
}

/**
 * How much of the lower piece the upper one hides: the share of the lower
 * piece's covered locations the upper one also reaches.
 *
 * Baseline coverage, not effective coverage. An unbuttoned coat still occludes
 * the shirt behind it as far as composition is concerned; how much of the shirt
 * that leaves READABLE is the effective-coverage read's answer, and slice 3
 * owns feeding it in.
 */
function overlapDegree(upper: ResolvedGarment, lower: ResolvedGarment): UnitInterval | null {
  if (lower.covered.size === 0) return null;
  let shared = 0;
  for (const locationId of lower.covered) {
    if (upper.covered.has(locationId)) shared += 1;
  }
  if (shared === 0) return null;
  return divideUnits({
    numerator: toUnitInterval(shared),
    denominator: toUnitInterval(lower.covered.size),
    denominatorFloor: OVERLAP_DENOMINATOR_FLOOR,
  });
}

/**
 * The occlusion edges one worn piece asserts over the pieces beneath it.
 *
 * Layer is the ONLY ordering input, and it is optional, so a wardrobe nobody
 * layered produces no occlusion at all. That is the conservative direction: an
 * invented stacking order would tell an image compiler that a visible garment is
 * hidden, which is the one wardrobe error a player cannot miss.
 */
function occlusionEdges(garment: ResolvedGarment, all: readonly ResolvedGarment[]): VisualStateRelationship[] {
  const layer = garment.input.layer;
  if (layer === undefined || garment.input.instance.locus.kind !== "worn") return [];
  const edges: { targetKey: string; degree: UnitInterval }[] = [];
  for (const other of all) {
    if (other.key === garment.key) continue;
    if (other.subjectId !== garment.subjectId) continue;
    if (other.input.instance.locus.kind !== "worn") continue;
    const otherLayer = other.input.layer;
    if (otherLayer === undefined || otherLayer >= layer) continue;
    const degree = overlapDegree(garment, other);
    if (degree === null) continue;
    edges.push({ targetKey: other.key, degree });
  }
  return edges
    .sort((left, right) => compareStrings(left.targetKey, right.targetKey))
    .map((edge) => ({ kind: "occludes", targetKey: edge.targetKey, degree: edge.degree }));
}

function wardrobeEvidence(garment: ResolvedGarment): AffordanceEvidence[] {
  const evidence = [
    affordanceEvidence("adapter", "visual_state.wardrobe", garment.input.instance.locus.kind),
    affordanceEvidence("state", `garment:${garment.input.instance.id}`),
  ];
  if (garment.input.categoryId !== undefined) {
    evidence.push(affordanceEvidence("state", `category:${garment.input.categoryId}`));
  }
  return evidence;
}

function wardrobeSourceRef(garment: ResolvedGarment): VisualStateSourceRef {
  return garment.kindId === VISUAL_STATE_WARDROBE_ITEM_KIND_ID
    ? { kind: "item_locus", itemInstanceId: garment.input.instance.id }
    : { kind: "garment", garmentInstanceId: garment.input.instance.id };
}

function wardrobeValue(garment: ResolvedGarment): VisualStateWardrobeValue {
  const instance = garment.input.instance;
  return {
    name: instance.name,
    locus: instance.locus,
    ...(instance.definitionId === undefined ? {} : { definitionId: instance.definitionId }),
    ...(garment.input.subtypeId === undefined ? {} : { subtypeId: garment.input.subtypeId }),
  };
}

/**
 * Wardrobe priors: the kind's calibration, plus the one flag that is a property
 * of WHERE the piece is rather than of what kind it is.
 *
 * A worn or carried piece is mandatory for continuity — invariant 7 puts
 * wardrobe truth beyond salience's reach, and a render that quietly changes a
 * shirt is the failure this plan exists to stop. A jacket on a chair is not: it
 * is scenery, and forcing it into a portrait of its owner would be worse than
 * leaving it out.
 */
function wardrobePriors(garment: ResolvedGarment, base: VisualStateAttentionPriors): VisualStateAttentionPriors {
  return garment.onBody ? { ...base, mandatoryForContinuity: true } : base;
}

function wardrobeTags(garment: ResolvedGarment): string[] {
  const tags: string[] = [garment.input.instance.locus.kind];
  if (garment.input.categoryId !== undefined) tags.push(garment.input.categoryId);
  if (garment.input.subtypeId !== undefined) tags.push(garment.input.subtypeId);
  return tags;
}

/**
 * Garments and worn items as visual-state features, with the composition edges
 * their coverage proves.
 *
 * The edge an ordinary garment asserts is `covers`; the edge jewelry and eyewear
 * assert is `attached_to`. Both are computed from the same baseline coverage —
 * the difference is what the piece DOES to the surface it reaches, and the
 * distinction matters downstream: a covered feature loses composed visibility,
 * an attached one does not, so a nose ring can never hide the nose it hangs
 * from.
 *
 * `replaces_visible_surface` and `derived_from` are not emitted. Nothing in the
 * wardrobe vocabulary distinguishes a hairpiece from a hat — there is no `wig`
 * subtype — and a derived effect needs the material and wetness reads slice 3
 * brings. The resolver handles both kinds; this adapter has no owner that
 * proves either, and the plan's answer to a missing owner is silence.
 */
export function projectWardrobeFeatures(
  input: VisualStateWardrobeProjectionInput,
): readonly VisualStateFeature[] {
  const path = input.path ?? "visual_state.wardrobe";
  const composeAgainst = input.composeAgainst ?? [];
  const resolved = resolveGarments(input);
  const projected: VisualStateFeature[] = [];

  for (const garment of resolved) {
    const kind = visualStateKindRegistry.byId(garment.kindId);
    if (!kind) continue;
    const attaches =
      garment.input.categoryId !== undefined && ATTACHING_CATEGORY_IDS.has(garment.input.categoryId);
    const surfaceEdges: VisualStateRelationship[] = bodyTargets(garment, composeAgainst).map((targetKey) =>
      attaches
        ? { kind: "attached_to", targetKey }
        : { kind: "covers", targetKey, degree: AFFORDANCE_UNIT_ONE },
    );
    const value = wardrobeValue(garment);
    const candidate: VisualStateFeature = {
      version: 1,
      key: garment.key,
      subjectId: garment.subjectId,
      kindId: garment.kindId,
      layer: kind.layer,
      locus: garment.locus,
      sourceRef: wardrobeSourceRef(garment),
      value,
      truthFingerprint: visualStateFingerprint(value),
      semanticTags: wardrobeTags(garment),
      stability: kind.stability,
      relationships: [...surfaceEdges, ...occlusionEdges(garment, resolved)],
      priors: wardrobePriors(garment, kind.priors),
      evidence: wardrobeEvidence(garment),
      changedAtMinutes: garment.input.instance.lastChange.atMinutes,
    };
    const accepted = validateVisualStateFeature(candidate, input.sink, path);
    if (accepted !== null) projected.push(accepted);
  }

  return projected;
}
