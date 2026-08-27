import {
  affordanceEvidence,
  AFFORDANCE_UNIT_ONE,
  divideUnits,
  toUnitInterval,
  type AffordanceEvidence,
  type UnitInterval,
} from "../affordances/core";
import { diag, type DiagnosticSink } from "../diagnostics";
import { VISUAL_STATE_KIND_UNKNOWN } from "./diagnostics";
import type { EffectiveCoverageRead } from "../items/effective-coverage-read";
import type { GarmentBlueprint } from "../items/garment-blueprint";
import { garmentEffectiveCoverage } from "../items/garment-effective-coverage";
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
 * Garment and item loci as presentation features. The wardrobe stack is
 * complete and gated off, and this adapter is what consumes it.
 *
 * What this adapter projects is deliberately narrow: what a piece IS and WHERE
 * it sits. Closure, roll, tuck, displacement, wetness, deposits and damage are
 * the garment's CURRENT state and live on the current layer in
 * `garment-state.ts`; the wardrobe owner already derives and fingerprints all
 * of it (`garment-effective-coverage.ts`, `garment-digest.ts`), so re-deriving
 * any of it in either module would be the second wardrobe the plan forbids.
 * Presentation DOES reach this adapter's composition edges, through the same
 * owner's effective-coverage derivation (see `coveredLocations`).
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
   * caller names the one the scene's own facts are filed under.
   *
   * Absent ⇒ loose garments are not projected, SILENTLY. That is right when the
   * caller is projecting one character and does not want the room, and wrong
   * when the field was simply forgotten — in which case the jacket on the chair
   * disappears with nothing to say so. There is no way to tell those apart from
   * inside a pure function; a caller that means to include the room passes it.
   */
  readonly sceneSubjectId?: string;
  /**
   * Features earlier adapters produced. Cover and attach edges are emitted only
   * against these, so this adapter never asserts an edge that would resolve away
   * as a missing target.
   */
  readonly composeAgainst?: readonly VisualStateFeature[];
  /**
   * The CAPTURED effective-coverage read per subject id (the wardrobe owner's
   * "captured, not reconstructed" ruling — `ChatGarmentStore.coverage`, keyed
   * here by the visual subject the caller resolved the actor to).
   *
   * When present, a `covers` edge's degree is THIS garment's current effective
   * opacity over that location, so a soaked cotton shirt covers less than a dry
   * one and a sheer layer covers less than an opaque one. Absent — no capture,
   * no entry for the location, or no evidence row for this garment — degrades
   * to FULL degree: concealment is the conservative direction, and a degraded
   * read must never invent exposure.
   */
  readonly capturedCoverage?: ReadonlyMap<string, EffectiveCoverageRead>;
  readonly sink?: DiagnosticSink;
  readonly path?: string;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Everything one garment reaches RIGHT NOW: its presentation-aware effective
 * coverage, through the wardrobe owner's own derivation
 * (`garmentEffectiveCoverage` — behavior laws subtracting from each part's
 * expanded, `coverageRelevant`-filtered baseline).
 *
 * Slice 2 expanded the blueprint's baseline here and recorded the effective
 * read as this slice's debt. The swap is what makes presentation reach
 * composition: a sleeve rolled past the forearm threshold stops covering the
 * forearm, an open coat stops covering the chest, and the identity features
 * underneath become composed-visible without any consumer re-deriving a
 * coverage law. For a garment in its neutral presentation the two reads are
 * the same set, byte for byte.
 *
 * The `coverageRelevant` filter this inherits is not cosmetic: raw expansion
 * walks into locations no garment covers, so a plain shirt once claimed
 * `covers` at full degree over WINGS and a TAIL — zeroing the composed
 * visibility of the exact features this projection marks mandatory for
 * identity — and every non-slot id inflated the occlusion denominator.
 */
function coveredLocations(instance: GarmentInstanceState, blueprint: GarmentBlueprint): ReadonlySet<string> {
  return new Set(garmentEffectiveCoverage(instance, blueprint).covers);
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
  /** True only for `worn` — the one locus at which a piece touches a body surface. */
  readonly isWorn: boolean;
  /** The library category, trimmed and lower-cased the way `clothingCategoryById` matches. */
  readonly categoryId?: string;
}

/**
 * Normalize a library category id before any membership test.
 *
 * `clothingCategoryById` matches on `id.trim().toLowerCase()`, and the stored
 * `category` field is free text that only the forge normalizes at its own call
 * site — so unnormalized rows exist. A raw `Set.has` on `"Jewelry"` misses,
 * which silently flips a nose ring from `attached_to` to a full-degree `covers`
 * and hides the nose it hangs from.
 */
function normalizeCategoryId(categoryId: string | undefined): string | undefined {
  const normalized = categoryId?.trim().toLowerCase();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}

function resolveGarments(input: VisualStateWardrobeProjectionInput): ResolvedGarment[] {
  const resolved: ResolvedGarment[] = [];
  for (const garment of input.garments) {
    const subjectId = subjectForLocus(garment.instance.locus, input);
    if (subjectId === undefined) continue;
    const categoryId = normalizeCategoryId(garment.categoryId);
    const kindId =
      categoryId !== undefined && ACCESSORY_CATEGORY_IDS.has(categoryId)
        ? VISUAL_STATE_WARDROBE_ITEM_KIND_ID
        : VISUAL_STATE_WARDROBE_GARMENT_KIND_ID;
    const locus: VisualStateLocusRef = { kind: "item", itemInstanceId: garment.instance.id };
    resolved.push({
      input: garment,
      subjectId,
      kindId,
      key: visualStateFeatureKey(subjectId, locus, kindId),
      locus,
      covered: coveredLocations(garment.instance, garment.blueprint),
      onBody: garment.instance.locus.kind === "worn" || garment.instance.locus.kind === "held",
      isWorn: garment.instance.locus.kind === "worn",
      ...(categoryId === undefined ? {} : { categoryId }),
    });
  }
  return resolved;
}

/** One coverable body feature: its key, and the location the coverage law gates on. */
interface BodyTarget {
  readonly key: string;
  readonly locationId: string;
}

/**
 * The body features this piece sits on: the identity and presentation facts of
 * its own subject that fall inside its coverage.
 *
 * WORN only. A garment's coverage describes where it sits when someone is
 * wearing it; a hat in a hand covers nothing, and a jacket over a chair covers
 * nothing even when the caller files loose garments under a character's own
 * subject id. Without this gate a held hat asserted full coverage of the
 * hairstyle it was nowhere near.
 */
function bodyTargets(
  garment: ResolvedGarment,
  composeAgainst: readonly VisualStateFeature[],
): readonly BodyTarget[] {
  if (!garment.isWorn) return [];
  const targets: BodyTarget[] = [];
  for (const target of composeAgainst) {
    if (target.subjectId !== garment.subjectId) continue;
    if (target.locus.kind !== "body") continue;
    if (!garment.covered.has(target.locus.locus.bodyLocationId)) continue;
    targets.push({ key: target.key, locationId: target.locus.locus.bodyLocationId });
  }
  return targets.sort((left, right) => compareStrings(left.key, right.key));
}

/**
 * How strongly this garment's cover CONCEALS one location: its own current
 * effective opacity from the captured read, else full degree.
 *
 * Only THIS garment's evidence rows count — another layer's opacity over the
 * same location is that layer's own edge. Every degraded path (no capture, no
 * entry, no row for this garment, and the schema-degraded opacity of 0 is a
 * row that exists and says "not concealing") lands on the concealing side or
 * on the captured value itself, never on invented exposure — except that a
 * captured 0 IS exposure, because the owner said so and this read only
 * carries it.
 */
function coverDegree(
  garment: ResolvedGarment,
  locationId: string,
  captured: EffectiveCoverageRead | undefined,
): UnitInterval {
  const entry = captured?.entries.find((row) => row.locationId === locationId);
  if (entry === undefined) return AFFORDANCE_UNIT_ONE;
  const rows = entry.evidence.filter((row) => row.garmentId === garment.input.instance.id);
  if (rows.length === 0) return AFFORDANCE_UNIT_ONE;
  return toUnitInterval(Math.max(...rows.map((row) => row.effectiveOpacity)));
}

/**
 * How much of the lower piece the upper one hides: the share of the lower
 * piece's covered locations the upper one also reaches.
 *
 * Both sets are the pieces' presentation-aware EFFECTIVE coverage — the
 * slice-3 read that closed slice 2's recorded debt. An unbuttoned coat has
 * already lost `chest` from its own set, so the share of the shirt it still
 * occludes falls exactly where the coverage law says the shirt became
 * readable; a coat worn closed occludes the same share it always did. The
 * denominator stays the lower piece's `coverageRelevant`-filtered set, never
 * the raw body-tree expansion, which would pad it with locations no garment
 * can occupy.
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
  if (layer === undefined || !garment.isWorn) return [];
  const edges: { targetKey: string; degree: UnitInterval }[] = [];
  for (const other of all) {
    if (other.key === garment.key) continue;
    if (other.subjectId !== garment.subjectId) continue;
    if (!other.isWorn) continue;
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
  if (garment.categoryId !== undefined) tags.push(garment.categoryId);
  if (garment.input.subtypeId !== undefined) tags.push(garment.input.subtypeId);
  return tags;
}

/**
 * The change kinds whose effect this slice's VALUE actually reflects.
 *
 * `garmentChangeKinds` also covers `presentation`, `condition`, `damage` and
 * `repair`, and none of those touch a garment's name, locus, definition or
 * subtype — they are slice 3's facts. Stamping `changedAtMinutes` from a
 * condition change would advance the clock against an identical fingerprint and
 * make a shirt that merely got damp read as a change candidate: the same wrong
 * contract the presentation owner's conditional stamp exists to avoid.
 */
const VALUE_BEARING_CHANGE_KINDS: ReadonlySet<string> = new Set(["mint", "transfer"]);

/** The story minute this feature's own value last moved, or absent when nothing it carries did. */
function wardrobeChangedAt(garment: ResolvedGarment): number | undefined {
  const change = garment.input.instance.lastChange;
  return VALUE_BEARING_CHANGE_KINDS.has(change.kind) ? change.atMinutes : undefined;
}

/**
 * Garments and worn items as visual-state features, with the composition edges
 * their coverage proves.
 *
 * The edge an ordinary garment asserts is `covers`; the edge jewelry and eyewear
 * assert is `attached_to`. Both come from the same filtered baseline coverage —
 * the difference is what the piece DOES to the surface it reaches, and the
 * distinction matters downstream: a covered feature loses composed visibility,
 * an attached one does not, so a nose ring can never hide the nose it hangs
 * from.
 *
 * An accessory only produces an edge when its definition carries AUTHORED
 * coverage. The jewelry category template is `coverage: []` — the subtype's
 * anchor (`earring` → ears) is an editor pre-fill, not something the mint path
 * stores — so a piece instantiated straight from the template covers nothing and
 * attaches to nothing. It is still projected, with its own identity and locus;
 * it simply asserts no relationship, which is the honest read of a garment
 * nobody said where to put.
 *
 * `replaces_visible_surface` and `derived_from` are not emitted HERE.
 * `derived_from` gained its owner in slice 3 — `garment-state.ts` asserts it
 * from a wet-material effect to the wetness fact it rides on — but nothing in
 * the wardrobe vocabulary distinguishes a hairpiece from a hat (there is no
 * `wig` subtype), so `replaces_visible_surface` still has no owner anywhere,
 * and the plan's answer to a missing owner is silence.
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
    if (!kind) {
      input.sink?.push(
        diag("warn", VISUAL_STATE_KIND_UNKNOWN, `Wardrobe kind ${garment.kindId} is not registered`, {
          path,
          context: { key: garment.key, kindId: garment.kindId },
        }),
      );
      continue;
    }
    const attaches = garment.categoryId !== undefined && ATTACHING_CATEGORY_IDS.has(garment.categoryId);
    const captured = input.capturedCoverage?.get(garment.subjectId);
    const surfaceEdges: VisualStateRelationship[] = bodyTargets(garment, composeAgainst).map((target) =>
      attaches
        ? { kind: "attached_to", targetKey: target.key }
        : { kind: "covers", targetKey: target.key, degree: coverDegree(garment, target.locationId, captured) },
    );
    const changedAtMinutes = wardrobeChangedAt(garment);
    const candidate: VisualStateFeature = {
      version: 1,
      key: garment.key,
      subjectId: garment.subjectId,
      kindId: garment.kindId,
      layer: kind.layer,
      locus: garment.locus,
      sourceRef: wardrobeSourceRef(garment),
      value: wardrobeValue(garment),
      // Filled in below from the PARSED value, once the kind's schema has had
      // its say — a name the schema trims must not fingerprint differently from
      // the identical name that arrived already trimmed.
      truthFingerprint: "pending",
      semanticTags: wardrobeTags(garment),
      stability: kind.stability,
      relationships: [...surfaceEdges, ...occlusionEdges(garment, resolved)],
      priors: wardrobePriors(garment, kind.priors),
      evidence: wardrobeEvidence(garment),
      ...(changedAtMinutes === undefined ? {} : { changedAtMinutes }),
    };
    const accepted = validateVisualStateFeature(candidate, input.sink, path);
    if (accepted !== null) {
      projected.push({ ...accepted, truthFingerprint: visualStateFingerprint(accepted.value) });
    }
  }

  return projected;
}
