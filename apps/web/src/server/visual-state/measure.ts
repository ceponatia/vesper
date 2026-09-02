import {
  VISUAL_STATE_DUPLICATE_KEY,
  VISUAL_STATE_SOURCE_UNAVAILABLE,
  type VisualImageSelection,
  type VisualNarratorSelection,
  type VisualStateSnapshot,
  type VisualStateSuppression,
} from "@/contracts";

/**
 * SHADOW MEASUREMENT: missing-owner frequency, duplicate facts, and the
 * wardrobe comparison — computed from one shadow build, surfaced as one
 * structured log line per shadowed turn and recomputed on demand by the
 * inspector. Nothing here is persisted; accumulation happens over the deploy's
 * log stream, which is the same place every other turn measurement already
 * lands.
 *
 * There is deliberately no attribute comparison. The narrator prompt and this
 * projection now take their appearance facts from the one shared read
 * (`contracts/visual-state/appearance-read.ts`), so an attribute set that
 * disagreed with the prompt's would mean a defect in that read rather than the
 * drift between two independent implementations this measurement once watched.
 * Wardrobe still has two independent producers, so its comparison stays.
 */

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
  /** What the lane's own resolved summary surfaces. */
  readonly resolvedCount: number;
  /** What the snapshot projects. */
  readonly projectedCount: number;
  readonly sharedCount: number;
  /** Surfaced by the resolved summary, absent from the snapshot — the drift risk. */
  readonly resolvedOnly: readonly string[];
  /** Projected but never surfaced by the resolved summary. */
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

export function compareSets(resolved: readonly string[], projected: readonly string[]): VisualStateSetComparison {
  // Both sides are DE-DUPLICATED before differencing. Either list may legally
  // repeat an id, and differencing the raw arrays would count that id twice in
  // `resolvedOnly` — which subtracted from a Set size produced a `sharedCount`
  // that undercounts agreement and can go negative.
  const resolvedSet = new Set(resolved);
  const projectedSet = new Set(projected);
  const resolvedOnly = [...resolvedSet].filter((id) => !projectedSet.has(id));
  const projectedOnly = [...projectedSet].filter((id) => !resolvedSet.has(id));
  return {
    resolvedCount: resolvedSet.size,
    projectedCount: projectedSet.size,
    sharedCount: resolvedSet.size - resolvedOnly.length,
    resolvedOnly,
    projectedOnly,
  };
}

export interface MeasureVisualStateInput {
  readonly snapshot: VisualStateSnapshot;
  readonly narrator: VisualNarratorSelection;
  readonly image: VisualImageSelection;
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
    garments:
      input.wornGarmentIds === null ? null : compareSets(input.wornGarmentIds, projectedGarmentIds(snapshot)),
  };
}
