import { affordanceEvidence, type AffordanceEvidence } from "../affordances/core";
import { diag, type DiagnosticSink } from "../diagnostics";
import {
  garmentPartMaterialProfile,
  GARMENT_CONDITION_NEUTRAL_BANDS,
} from "../items/garment-condition";
import { garmentStructuralFacts } from "../items/garment-digest";
import { garmentReadout, type GarmentReadout } from "../items/garment-effective-coverage";
import { garmentConditionKeys, type GarmentLocus } from "../items/garment-instance";
import type { GarmentMaterialProfile } from "../items/garment-material";
import { VISUAL_STATE_KIND_UNKNOWN } from "./diagnostics";
import {
  validateVisualStateFeature,
  visualStateFeatureKey,
  visualStateFingerprint,
  type VisualStateFeature,
} from "./feature";
import {
  garmentMaterialEffects,
  VISUAL_STATE_GARMENT_CONDITION_KIND_ID,
  VISUAL_STATE_GARMENT_DAMAGE_KIND_ID,
  VISUAL_STATE_GARMENT_DEPOSIT_KIND_ID,
  VISUAL_STATE_GARMENT_MATERIAL_EFFECT_KIND_ID,
  VISUAL_STATE_GARMENT_PRESENTATION_KIND_ID,
  VISUAL_STATE_WARDROBE_GARMENT_KIND_ID,
  VISUAL_STATE_WARDROBE_ITEM_KIND_ID,
  type GarmentMaterialEffect,
} from "./kinds";
import { encodeVisualStateKeySegment, type VisualStateLocusRef } from "./locus";
import { visualStateKindRegistry } from "./registry";
import type { VisualStateRelationship } from "./relationships";
import type { VisualStateSourceRef } from "./sources";
import type { VisualStateGarmentInput } from "./wardrobe";

/**
 * Garment CURRENT state as visual-state features — the half slice 2 left to
 * this module: how each piece currently SITS (closure, roll, tuck,
 * displacement) and what has HAPPENED to its material (wetness, soiling,
 * creasing, wear, deposits, damage), plus the derived wet-material effects.
 *
 * Everything is read through `garmentReadout`, the wardrobe owner's canonical
 * per-garment read: it integrates condition lazily to the cut's story minute
 * (persisting nothing), applies the one band ladder per channel, and derives
 * per-part structural bands through `garmentStructuralFacts`. Re-deriving any
 * of that here would be the second wardrobe the plan forbids.
 *
 * Bands are PLAIN, never hysteretic. Hysteresis needs the band a consumer last
 * reported, which is mention state (`GarmentCueState`) — reading it would make
 * the same committed truth project differently depending on what the narrator
 * happened to say, breaking snapshot determinism. Hysteresis stays where it
 * lives: in the consumers that own their own cue memory.
 *
 * Neutral is silence. A dry, clean, smooth, pristine, fully fastened garment
 * projects only its slice-2 identity feature; the current layer carries what
 * deviates. The one ruled exception is tuck, which the digest holds has no
 * neutral — every tuck reading projects, exactly as it always reaches the
 * narrator digest.
 *
 * No `validUntilMinutes` on any garment feature, deliberately. Garment drying
 * is EXPONENTIAL (a per-material half-life), so a band-crossing time needs a
 * logarithm — floating point in a path whose determinism is fixed-point
 * integer end to end. The body-surface adapter carries a window because its
 * law is linear and the crossing is exact integer arithmetic; here the honest
 * choices were an approximate window or none, and a consumer re-projecting at
 * a later cut gets the freshly integrated band either way.
 */

export interface VisualStateGarmentStateProjectionInput {
  readonly garments: readonly VisualStateGarmentInput[];
  /** Garment actor handle (`c:<characterId>`, `player`) → the visual subject id. */
  readonly subjectsByActor: ReadonlyMap<string, string>;
  /** The subject a garment left in the current place hangs under (see `wardrobe.ts`). */
  readonly sceneSubjectId?: string;
  /** The committed cut's story minute — the lazy-integration target. */
  readonly atMinutes: number;
  /**
   * Features earlier adapters produced. Every current-state feature asserts a
   * `modifies` edge against its own garment's slice-2 wardrobe feature — wet
   * modifies the shirt the way wet modifies a hairstyle — and only when that
   * feature is actually here.
   */
  readonly composeAgainst?: readonly VisualStateFeature[];
  readonly sink?: DiagnosticSink;
  readonly path?: string;
}

// ---------------------------------------------------------------------------
// Wet-material effect calibration
// ---------------------------------------------------------------------------

/**
 * CALIBRATION for the derived effects, stated against the material registry's
 * own coarse quarter-scale values and the shared wetness ladder:
 *
 * - **beading** — water sitting on a surface that will not take it in. Leather
 *   (absorbency 1_200) and synthetic shell (800) qualify, and the band gate is
 *   ANY non-dry reading: on a shell that barely absorbs, whatever wetness the
 *   channel records IS surface water. Gating it at `wet` would be dead
 *   vocabulary — increases are absorbency-scaled (fixture F7's own point), so
 *   a low-absorbency material can never reach the `wet` band at all.
 * - **clinging** — wet fabric pressed to the body, at `wet` or worse.
 *   Cotton/linen (cling 6_500), knit (7_500) and silk (9_000) qualify.
 * - **translucent** — the authored wet-opacity response actually firing, at
 *   `wet` or worse. Cotton/linen (7_000), knit (6_000) and silk (8_000)
 *   qualify.
 *
 * The conservative `unknown` profile (absorbency 5_000, cling 3_000, response
 * 3_000) passes NO gate, so an unidentified fabric produces no derived effect
 * at all — the degraded default is silence, with no special-casing needed.
 */
export const GARMENT_EFFECT_BEADING_MAX_ABSORBENCY = 2_000;
export const GARMENT_EFFECT_CLINGING_MIN_AFFINITY = 6_500;
export const GARMENT_EFFECT_TRANSLUCENT_MIN_RESPONSE = 6_000;

/** Any recorded wetness at all — the beading gate. */
const NON_DRY_WETNESS_BANDS: ReadonlySet<string> = new Set(["damp", "wet", "soaked"]);
/** Saturation the strong effects need — `damp` is not enough to cling or sheer out. */
const STRONG_WETNESS_BANDS: ReadonlySet<string> = new Set(["wet", "soaked"]);

/** The effects one material supports at one wetness band, in the vocabulary's fixed order. */
export function garmentMaterialEffectsFor(
  profile: GarmentMaterialProfile,
  wetnessBand: string,
): GarmentMaterialEffect[] {
  if (!NON_DRY_WETNESS_BANDS.has(wetnessBand)) return [];
  const strong = STRONG_WETNESS_BANDS.has(wetnessBand);
  const supported: GarmentMaterialEffect[] = [];
  for (const effect of garmentMaterialEffects) {
    switch (effect) {
      case "beading":
        if (profile.absorbency <= GARMENT_EFFECT_BEADING_MAX_ABSORBENCY) supported.push(effect);
        break;
      case "clinging":
        if (strong && profile.clingAffinity >= GARMENT_EFFECT_CLINGING_MIN_AFFINITY) supported.push(effect);
        break;
      case "translucent":
        if (strong && profile.wetOpacityResponse >= GARMENT_EFFECT_TRANSLUCENT_MIN_RESPONSE) supported.push(effect);
        break;
    }
  }
  return supported;
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

/** The subject a locus puts the garment under, or `undefined` when it is not a visual fact. */
function subjectForLocus(
  locus: GarmentLocus,
  input: VisualStateGarmentStateProjectionInput,
): string | undefined {
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

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * The slice-2 wardrobe feature this garment projects under, found rather than
 * rebuilt: rebuilding the key would mean re-deciding the garment-versus-item
 * categorization here, and the two decisions could drift. No wardrobe feature
 * in `composeAgainst` means no `modifies` edges — the established rule that an
 * adapter asserts nothing it cannot see.
 */
function wardrobeFeatureKey(
  garmentInstanceId: string,
  subjectId: string,
  composeAgainst: readonly VisualStateFeature[],
): string | undefined {
  for (const target of composeAgainst) {
    if (target.subjectId !== subjectId) continue;
    if (target.kindId !== VISUAL_STATE_WARDROBE_GARMENT_KIND_ID && target.kindId !== VISUAL_STATE_WARDROBE_ITEM_KIND_ID) {
      continue;
    }
    if (target.locus.kind !== "item" || target.locus.itemInstanceId !== garmentInstanceId) continue;
    return target.key;
  }
  return undefined;
}

/** One garment's fixed evidence spine; per-feature entries append to a copy. */
function garmentEvidence(garmentInstanceId: string, detail: string): AffordanceEvidence[] {
  return [
    affordanceEvidence("adapter", "visual_state.garment_state", detail),
    affordanceEvidence("state", `garment:${garmentInstanceId}`),
  ];
}

interface GarmentFeatureDraft {
  readonly aspect: string;
  readonly locus: VisualStateLocusRef;
  readonly kindId: string;
  readonly sourceRef: VisualStateSourceRef;
  readonly value: unknown;
  readonly semanticTags: readonly string[];
  readonly relationships: readonly VisualStateRelationship[];
  readonly evidence: readonly AffordanceEvidence[];
  readonly changedAtMinutes?: number;
}

/** Every draft one garment's readout yields, in a fixed emission order. */
function draftGarmentFeatures(
  garment: VisualStateGarmentInput,
  readout: GarmentReadout,
  modifiesWardrobe: readonly VisualStateRelationship[],
): GarmentFeatureDraft[] {
  const instance = garment.instance;
  const itemLocus: VisualStateLocusRef = { kind: "item", itemInstanceId: instance.id };
  const garmentSource: VisualStateSourceRef = { kind: "garment", garmentInstanceId: instance.id };
  const drafts: GarmentFeatureDraft[] = [];
  const lastChange = instance.lastChange;

  /**
   * Story minute a channel's value last moved by a COMMITTED WRITE, or absent.
   * The instance's stamp is coarse (one per garment), so it is spent only when
   * its kind actually writes the channel family in question: `condition` ops
   * write the gradient channels, and a `damage` op also ages `wear`. Band drift
   * from lazy drying never restamps — the same law the body-surface owner
   * states for its own anchor.
   */
  const conditionChangedAt = (channel: string): number | undefined => {
    if (lastChange.kind === "condition") return lastChange.atMinutes;
    if (lastChange.kind === "damage" && channel === "wear") return lastChange.atMinutes;
    return undefined;
  };

  // --- Whole-garment condition channels, worst reading, non-neutral only ----
  for (const channel of garmentConditionKeys) {
    const band = readout.condition[channel];
    if (band === GARMENT_CONDITION_NEUTRAL_BANDS[channel]) continue;
    const changedAtMinutes = conditionChangedAt(channel);
    drafts.push({
      aspect: `${VISUAL_STATE_GARMENT_CONDITION_KIND_ID}:${channel}`,
      locus: itemLocus,
      kindId: VISUAL_STATE_GARMENT_CONDITION_KIND_ID,
      sourceRef: garmentSource,
      value: { channel, band },
      semanticTags: [channel, band],
      relationships: modifiesWardrobe,
      evidence: garmentEvidence(instance.id, channel),
      ...(changedAtMinutes === undefined ? {} : { changedAtMinutes }),
    });
  }

  // --- Per-part condition overrides that read differently, non-neutral only -
  for (const part of readout.conditionParts) {
    for (const channel of garmentConditionKeys) {
      const band = part.bands[channel];
      if (band === undefined || band === GARMENT_CONDITION_NEUTRAL_BANDS[channel]) continue;
      const changedAtMinutes = conditionChangedAt(channel);
      drafts.push({
        aspect: `${VISUAL_STATE_GARMENT_CONDITION_KIND_ID}:${channel}`,
        locus: { kind: "garment_part", garmentInstanceId: instance.id, partId: part.partId },
        kindId: VISUAL_STATE_GARMENT_CONDITION_KIND_ID,
        sourceRef: { kind: "garment_part", garmentInstanceId: instance.id, partId: part.partId },
        value: { channel, band },
        semanticTags: [channel, band],
        relationships: modifiesWardrobe,
        evidence: garmentEvidence(instance.id, `${part.partId}:${channel}`),
        ...(changedAtMinutes === undefined ? {} : { changedAtMinutes }),
      });
    }
  }

  // --- Structural presentation, the digest's own deviation rule -------------
  const seenChannels = new Set<string>();
  for (const fact of garmentStructuralFacts(readout)) {
    if (!fact.deviation) continue;
    // One feature per (part, channel): a blueprint that bound two behaviors on
    // one channel to one part would otherwise mint a duplicate key. First
    // binding wins, matching the blueprint's own behavior order.
    const slot = `${fact.partId} ${fact.channel}`;
    if (seenChannels.has(slot)) continue;
    seenChannels.add(slot);
    drafts.push({
      aspect: `${VISUAL_STATE_GARMENT_PRESENTATION_KIND_ID}:${fact.channel}`,
      locus: { kind: "garment_part", garmentInstanceId: instance.id, partId: fact.partId },
      kindId: VISUAL_STATE_GARMENT_PRESENTATION_KIND_ID,
      sourceRef: { kind: "garment_part", garmentInstanceId: instance.id, partId: fact.partId },
      value: { channel: fact.channel, band: fact.band },
      semanticTags: [fact.channel, fact.band],
      relationships: modifiesWardrobe,
      evidence: garmentEvidence(instance.id, `${fact.partId}:${fact.channel}`),
      ...(lastChange.kind === "presentation" ? { changedAtMinutes: lastChange.atMinutes } : {}),
    });
  }

  // --- Deposits: located contaminants, whole-garment locus, parts in value --
  const depositStamps = new Map(instance.condition.deposits.map((deposit) => [deposit.id, deposit.atMinutes]));
  for (const deposit of readout.deposits) {
    // A sub-`slight` intensity is nothing anyone can see; the cleaning floor
    // normally removes it outright, so a null band here is honest silence.
    if (deposit.intensity === null) continue;
    const changedAtMinutes = depositStamps.get(deposit.id);
    drafts.push({
      aspect: `${VISUAL_STATE_GARMENT_DEPOSIT_KIND_ID}:${encodeVisualStateKeySegment(deposit.id)}`,
      locus: itemLocus,
      kindId: VISUAL_STATE_GARMENT_DEPOSIT_KIND_ID,
      sourceRef: garmentSource,
      value: {
        deposit: deposit.kind,
        intensity: deposit.intensity,
        freshness: deposit.freshness,
        parts: [...deposit.partIds].sort(compareStrings),
      },
      semanticTags: [deposit.kind, deposit.intensity, deposit.freshness],
      relationships: modifiesWardrobe,
      evidence: garmentEvidence(instance.id, `deposit:${deposit.kind}`),
      ...(changedAtMinutes === undefined ? {} : { changedAtMinutes }),
    });
  }

  // --- Damage marks: one part each ------------------------------------------
  const damageStamps = new Map(instance.condition.damageMarks.map((mark) => [mark.id, mark.atMinutes]));
  for (const mark of readout.damage) {
    if (mark.severity === null) continue;
    const changedAtMinutes = damageStamps.get(mark.id);
    drafts.push({
      aspect: `${VISUAL_STATE_GARMENT_DAMAGE_KIND_ID}:${encodeVisualStateKeySegment(mark.id)}`,
      locus: { kind: "garment_part", garmentInstanceId: instance.id, partId: mark.partId },
      kindId: VISUAL_STATE_GARMENT_DAMAGE_KIND_ID,
      sourceRef: { kind: "garment_part", garmentInstanceId: instance.id, partId: mark.partId },
      value: { damage: mark.kind, severity: mark.severity },
      semanticTags: [mark.kind, mark.severity],
      relationships: modifiesWardrobe,
      evidence: garmentEvidence(instance.id, `damage:${mark.kind}`),
      ...(changedAtMinutes === undefined ? {} : { changedAtMinutes }),
    });
  }

  return drafts;
}

/**
 * The derived wet-material effects for one garment — the owner the slice-2
 * `derived_from` relationship was recorded as waiting for.
 *
 * Each effect derives from the garment's OWN whole-piece wetness feature,
 * which is structurally guaranteed to be in the same contribution: every
 * effect gate requires a non-dry band, and every non-dry band is non-neutral,
 * so the wetness feature the edge names was just drafted. The material
 * coefficient is the blueprint's root profile — provenance rides the evidence,
 * because a material is registry calibration, not a feature to point an edge
 * at.
 */
function draftMaterialEffects(
  garment: VisualStateGarmentInput,
  readout: GarmentReadout,
  subjectId: string,
): GarmentFeatureDraft[] {
  const profile = garmentPartMaterialProfile(garment.blueprint);
  const instance = garment.instance;
  const itemLocus: VisualStateLocusRef = { kind: "item", itemInstanceId: instance.id };
  const wetnessKey = visualStateFeatureKey(
    subjectId,
    itemLocus,
    `${VISUAL_STATE_GARMENT_CONDITION_KIND_ID}:wetness`,
  );
  return garmentMaterialEffectsFor(profile, readout.condition.wetness).map((effect) => ({
    aspect: `${VISUAL_STATE_GARMENT_MATERIAL_EFFECT_KIND_ID}:${effect}`,
    locus: itemLocus,
    kindId: VISUAL_STATE_GARMENT_MATERIAL_EFFECT_KIND_ID,
    sourceRef: { kind: "garment", garmentInstanceId: instance.id },
    value: { effect },
    semanticTags: [effect, profile.id],
    relationships: [{ kind: "derived_from", targetKey: wetnessKey }],
    evidence: [...garmentEvidence(instance.id, effect), affordanceEvidence("state", `material:${profile.id}`)],
    // No stamp: a derived effect has no committed write of its own — its
    // cause's stamp lives on the wetness feature it derives from.
  }));
}

/**
 * Every garment's current state as visual-state features.
 *
 * A garment in someone's wardrobe or destroyed by the fiction projects
 * nothing; a garment worn, held, or left in the scene projects under the same
 * subject its slice-2 identity feature uses. A wet jacket over a chair is
 * still a wet jacket.
 */
export function projectGarmentCurrentState(
  input: VisualStateGarmentStateProjectionInput,
): readonly VisualStateFeature[] {
  const path = input.path ?? "visual_state.garment_state";
  const composeAgainst = input.composeAgainst ?? [];
  const projected: VisualStateFeature[] = [];

  for (const garment of input.garments) {
    const subjectId = subjectForLocus(garment.instance.locus, input);
    if (subjectId === undefined) continue;

    const readout = garmentReadout(garment.instance, garment.blueprint, { atMinutes: input.atMinutes });
    const wardrobeKey = wardrobeFeatureKey(garment.instance.id, subjectId, composeAgainst);
    const modifiesWardrobe: readonly VisualStateRelationship[] =
      wardrobeKey === undefined ? [] : [{ kind: "modifies", targetKey: wardrobeKey }];

    const drafts = [
      ...draftGarmentFeatures(garment, readout, modifiesWardrobe),
      ...draftMaterialEffects(garment, readout, subjectId),
    ];

    for (const draft of drafts) {
      const kind = visualStateKindRegistry.byId(draft.kindId);
      if (!kind) {
        input.sink?.push(
          diag("warn", VISUAL_STATE_KIND_UNKNOWN, `${draft.kindId} is not registered`, {
            path,
            context: { garmentId: garment.instance.id, kindId: draft.kindId },
          }),
        );
        continue;
      }
      const candidate: VisualStateFeature = {
        version: 1,
        key: visualStateFeatureKey(subjectId, draft.locus, draft.aspect),
        subjectId,
        kindId: draft.kindId,
        layer: kind.layer,
        locus: draft.locus,
        sourceRef: draft.sourceRef,
        value: draft.value,
        // Filled in from the PARSED value below, once the kind's schema has had
        // its say — the wardrobe adapter's own rule.
        truthFingerprint: "pending",
        semanticTags: draft.semanticTags,
        stability: kind.stability,
        relationships: draft.relationships,
        priors: kind.priors,
        evidence: draft.evidence,
        ...(draft.changedAtMinutes === undefined ? {} : { changedAtMinutes: draft.changedAtMinutes }),
      };
      const accepted = validateVisualStateFeature(candidate, input.sink, path);
      if (accepted !== null) {
        projected.push({ ...accepted, truthFingerprint: visualStateFingerprint(accepted.value) });
      }
    }
  }

  return projected;
}
