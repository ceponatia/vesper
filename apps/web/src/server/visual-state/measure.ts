import {
  attributeRegistry,
  isIntimateAttributeCategory,
  promptValueWithNoneElided,
  VISUAL_STATE_DUPLICATE_KEY,
  VISUAL_STATE_SOURCE_UNAVAILABLE,
  type AttributeValue,
  type RealizedBody,
  type VisualImageSelection,
  type VisualNarratorSelection,
  type VisualStateSnapshot,
  type VisualStateSuppression,
} from "@/contracts";

/**
 * SLICE-6 MEASUREMENT: missing-owner frequency,
 * duplicate facts, and disagreement with the current summaries — computed from
 * one shadow build, surfaced as one structured log
 * line per shadowed turn and recomputed on demand by the inspector. Nothing
 * here is persisted; accumulation happens over the deploy's log stream, which
 * is the same place every other turn measurement already lands.
 */

// ---------------------------------------------------------------------------
// The legacy comparison set
// ---------------------------------------------------------------------------

/**
 * The attribute ids the legacy narrator prompt surfaces for this body — the
 * guard chain `prompts/character-chat/sensory-sections.ts` runs over `stableResolved` before rendering
 * its Attributes block and sensory cues (audit finding 2 records that chain
 * re-typed at seven sites; this is a MEASUREMENT REPLICA of it, and slice 10
 * owns consolidating all of them onto the shared snapshot).
 *
 * Deliberately measured against the STABLE resolve (base + persisted overlays,
 * no condition overlays), because that is what the prompt's stable block reads;
 * the snapshot projects the full resolve, so a condition-overlaid attribute can
 * honestly appear as projected-only — a real current-state-versus-identity
 * disagreement, not measurement noise.
 */
export function legacyNarratorAttributeIds(
  stableResolved: readonly AttributeValue[],
  realizedBody: RealizedBody,
): string[] {
  const ids: string[] = [];
  for (const value of stableResolved) {
    if (value.id === "identity.apparent_age") continue; // portrait-studio-only
    const def = attributeRegistry.byId(value.id);
    if (!def) continue; // unknown vocabulary — the prompt never leaks a raw id
    if (def.excludeFromPrompts) continue;
    if (def.kind === "sensory" && isIntimateAttributeCategory(def.category)) continue;
    if (!realizedBody.isAttributeApplicable(def)) continue;
    const rendered = promptValueWithNoneElided(def, value.value);
    if (rendered === null) continue;
    if (typeof rendered === "boolean" && !rendered) continue;
    if (typeof rendered === "string" && rendered.trim().length === 0) continue;
    if (Array.isArray(rendered) && rendered.length === 0) continue;
    ids.push(value.id);
  }
  return ids.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/** The attribute ids the snapshot actually carries, via appearance provenance. */
export function projectedAttributeIds(snapshot: VisualStateSnapshot): string[] {
  const ids = new Set<string>();
  for (const feature of snapshot.features) {
    if (feature.sourceRef.kind === "appearance" && feature.sourceRef.ref.kind === "attribute") {
      ids.add(feature.sourceRef.ref.attributeId);
    }
  }
  return [...ids].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/** The garment instance ids the snapshot's wardrobe-identity features carry. */
export function projectedGarmentIds(snapshot: VisualStateSnapshot): string[] {
  const ids = new Set<string>();
  for (const feature of snapshot.features) {
    if (!feature.kindId.startsWith("wardrobe.")) continue;
    if (feature.sourceRef.kind === "garment") ids.add(feature.sourceRef.garmentInstanceId);
    if (feature.sourceRef.kind === "item_locus") ids.add(feature.sourceRef.itemInstanceId);
  }
  return [...ids].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Measurement shapes
// ---------------------------------------------------------------------------

export interface VisualStateSetComparison {
  /** What the current (legacy) summary surfaces. */
  readonly legacyCount: number;
  /** What the snapshot projects. */
  readonly projectedCount: number;
  readonly sharedCount: number;
  /** Surfaced by the legacy summary, absent from the snapshot — the drift risk. */
  readonly legacyOnly: readonly string[];
  /** Projected but never surfaced by the legacy summary. */
  readonly projectedOnly: readonly string[];
}

export interface VisualStateConsumerMeasurement {
  readonly candidateCount: number;
  readonly selectedCount: number;
  readonly suppressionsByCode: Readonly<Record<string, number>>;
}

export interface VisualStateMeasurements {
  readonly featureCount: number;
  readonly featuresByLayer: Readonly<Record<string, number>>;
  readonly featuresByKind: Readonly<Record<string, number>>;
  readonly suppressionCount: number;
  readonly suppressionsByCode: Readonly<Record<string, number>>;
  /** `visual_state.source.unavailable` suppressions — the missing-owner frequency. */
  readonly missingOwnerCount: number;
  /** `visual_state.snapshot.duplicate_key` suppressions — duplicate facts. */
  readonly duplicateKeyCount: number;
  readonly narrator: VisualStateConsumerMeasurement & {
    readonly constraintCount: number;
    readonly noticeCount: number;
  };
  readonly image: VisualStateConsumerMeasurement & {
    readonly mandatoryCount: number;
    readonly suppressedOptionalCount: number;
  };
  /** `null` when the lane has no attribute-rendering summary to compare against. */
  readonly attributes: VisualStateSetComparison | null;
  /** `null` when the lane resolved no structured worn rows this cut. */
  readonly garments: VisualStateSetComparison | null;
}

/** The all-zero measurement — the degraded default when a build produced nothing. */
export function emptyVisualStateMeasurements(): VisualStateMeasurements {
  return {
    featureCount: 0,
    featuresByLayer: {},
    featuresByKind: {},
    suppressionCount: 0,
    suppressionsByCode: {},
    missingOwnerCount: 0,
    duplicateKeyCount: 0,
    narrator: { candidateCount: 0, selectedCount: 0, suppressionsByCode: {}, constraintCount: 0, noticeCount: 0 },
    image: {
      candidateCount: 0,
      selectedCount: 0,
      suppressionsByCode: {},
      mandatoryCount: 0,
      suppressedOptionalCount: 0,
    },
    attributes: null,
    garments: null,
  };
}

// ---------------------------------------------------------------------------
// Computation
// ---------------------------------------------------------------------------

function tallyByCode(suppressions: readonly VisualStateSuppression[]): Record<string, number> {
  const tally: Record<string, number> = {};
  for (const suppression of suppressions) tally[suppression.code] = (tally[suppression.code] ?? 0) + 1;
  return tally;
}

function countCode(suppressions: readonly VisualStateSuppression[], code: string): number {
  return suppressions.reduce((count, suppression) => (suppression.code === code ? count + 1 : count), 0);
}

export function compareSets(legacy: readonly string[], projected: readonly string[]): VisualStateSetComparison {
  // Both sides are DE-DUPLICATED before differencing. Either list may legally
  // repeat an id (the legacy attribute chain can surface one id through two
  // guard steps), and differencing the raw arrays would count that id twice in
  // `legacyOnly` — which subtracted from a Set size produced a `sharedCount`
  // that undercounts agreement and can go negative.
  const legacySet = new Set(legacy);
  const projectedSet = new Set(projected);
  const legacyOnly = [...legacySet].filter((id) => !projectedSet.has(id));
  const projectedOnly = [...projectedSet].filter((id) => !legacySet.has(id));
  return {
    legacyCount: legacySet.size,
    projectedCount: projectedSet.size,
    sharedCount: legacySet.size - legacyOnly.length,
    legacyOnly,
    projectedOnly,
  };
}

export interface MeasureVisualStateInput {
  readonly snapshot: VisualStateSnapshot;
  readonly narrator: VisualNarratorSelection;
  readonly image: VisualImageSelection;
  /** `null` ⇒ this lane renders no attribute summary (the successor's canon block). */
  readonly legacyAttributeIds: readonly string[] | null;
  /** `null` ⇒ no structured worn rows this cut (free-text wardrobe, or no store). */
  readonly wornGarmentIds: readonly string[] | null;
}

/** One shadow build, measured. Pure arithmetic over the build's own records. */
export function measureVisualState(input: MeasureVisualStateInput): VisualStateMeasurements {
  const { snapshot, narrator, image } = input;

  const featuresByLayer: Record<string, number> = {};
  const featuresByKind: Record<string, number> = {};
  for (const feature of snapshot.features) {
    featuresByLayer[feature.layer] = (featuresByLayer[feature.layer] ?? 0) + 1;
    featuresByKind[feature.kindId] = (featuresByKind[feature.kindId] ?? 0) + 1;
  }

  const selectedCues = narrator.digests.reduce((count, digest) => count + digest.selected.length, 0);
  const constraintCount = narrator.digests.reduce((count, digest) => count + digest.constraints.length, 0);

  return {
    featureCount: snapshot.features.length,
    featuresByLayer,
    featuresByKind,
    suppressionCount: snapshot.suppressions.length,
    suppressionsByCode: tallyByCode(snapshot.suppressions),
    missingOwnerCount: countCode(snapshot.suppressions, VISUAL_STATE_SOURCE_UNAVAILABLE),
    duplicateKeyCount: countCode(snapshot.suppressions, VISUAL_STATE_DUPLICATE_KEY),
    narrator: {
      candidateCount: narrator.candidates.length,
      selectedCount: selectedCues,
      suppressionsByCode: tallyByCode(narrator.suppressions),
      constraintCount,
      noticeCount: narrator.notices.length,
    },
    image: {
      candidateCount: image.optional.length + image.suppressedOptionalCount,
      selectedCount: image.optional.length,
      suppressionsByCode: tallyByCode(image.suppressions),
      mandatoryCount: image.mandatory.length,
      suppressedOptionalCount: image.suppressedOptionalCount,
    },
    attributes:
      input.legacyAttributeIds === null
        ? null
        : compareSets(input.legacyAttributeIds, projectedAttributeIds(snapshot)),
    garments:
      input.wornGarmentIds === null ? null : compareSets(input.wornGarmentIds, projectedGarmentIds(snapshot)),
  };
}
