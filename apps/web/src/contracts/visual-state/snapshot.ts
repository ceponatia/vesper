import { diag, type DiagnosticSink } from "../diagnostics";
import type { VisualMemoryScopeRef } from "../affordances/recognition";
import { VISUAL_STATE_DUPLICATE_KEY } from "./diagnostics";
import { visualStateLocusKey } from "./locus";
import type { VisualStateFeature } from "./feature";
import { visualStateAdapterRank, visualStateLayerRank, type VisualStateAdapterId } from "./vocabulary";

/**
 * One committed visual moment (visual-state.spec.md §Snapshot).
 *
 * A snapshot is RECOMPUTED, not stored as truth. It is pure over a committed
 * cut, which is what makes a retake restore the whole visual moment: the same
 * cut produces byte-equal keys, fingerprints and ordering, and later state can
 * never leak backward into an earlier one.
 */

/**
 * Which continuity a snapshot belongs to. This is deliberately the SAME type
 * observer visual memory is scoped by (`chat` memory group / `world_branch`
 * branch) rather than a second lane vocabulary — a snapshot and the memory read
 * against it must agree on which continuity they are in, and two types that must
 * always agree are one type.
 */
export type VisualStateScopeRef = VisualMemoryScopeRef;

/** A feature that did not make the snapshot, and the code that says why. */
export interface VisualStateSuppression {
  readonly key: string;
  /** A `visual_state.*` diagnostic code — the machine-readable reason. */
  readonly code: string;
  readonly detail?: string;
}

export interface VisualStateSnapshot {
  readonly version: 1;
  readonly scope: VisualStateScopeRef;
  readonly atMinutes: number;
  readonly cutId: string;
  readonly subjects: readonly string[];
  readonly features: readonly VisualStateFeature[];
  readonly suppressions: readonly VisualStateSuppression[];
}

/** One adapter's output, tagged with which adapter produced it. */
export interface VisualStateContribution {
  readonly adapterId: VisualStateAdapterId;
  readonly features: readonly VisualStateFeature[];
}

export interface VisualStateSnapshotInput {
  readonly scope: VisualStateScopeRef;
  readonly atMinutes: number;
  readonly cutId: string;
  readonly contributions: readonly VisualStateContribution[];
  readonly sink?: DiagnosticSink;
}

/**
 * Code-unit order, never `localeCompare`: the ordering is part of the contract,
 * and a locale-sensitive comparator would make it machine-specific.
 */
function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * The snapshot sort: subject, then layer, then kind, then locus, then key.
 *
 * Layer leads the tie-breaks so a reader (and a prompt budget) meets identity
 * before presentation, presentation before current state, and current state
 * before body language — the plan's four layers, in the order they matter.
 */
export function compareVisualStateFeatures(left: VisualStateFeature, right: VisualStateFeature): number {
  const bySubject = compareStrings(left.subjectId, right.subjectId);
  if (bySubject !== 0) return bySubject;
  const byLayer = visualStateLayerRank(left.layer) - visualStateLayerRank(right.layer);
  if (byLayer !== 0) return byLayer;
  const byKind = compareStrings(left.kindId, right.kindId);
  if (byKind !== 0) return byKind;
  const byLocus = compareStrings(visualStateLocusKey(left.locus), visualStateLocusKey(right.locus));
  if (byLocus !== 0) return byLocus;
  return compareStrings(left.key, right.key);
}

/** Contributions in the fixed adapter order, ties broken by call order. */
function contributionsInAdapterOrder(
  contributions: readonly VisualStateContribution[],
): readonly VisualStateContribution[] {
  return contributions
    .map((contribution, index) => ({ contribution, index }))
    .sort((left, right) => {
      const byAdapter =
        visualStateAdapterRank(left.contribution.adapterId) - visualStateAdapterRank(right.contribution.adapterId);
      return byAdapter !== 0 ? byAdapter : left.index - right.index;
    })
    .map((entry) => entry.contribution);
}

/**
 * Assemble one snapshot from every adapter's contribution.
 *
 * Contributions are consumed in the fixed adapter order rather than the order
 * the caller happened to pass them, so "which source wins a duplicate key" is a
 * property of the contract instead of a property of a call site. That only makes
 * FAILURE deterministic — properly designed kinds use distinct keys and typed
 * relationships, and a duplicate is a bug the snapshot reports rather than a
 * routine merge.
 *
 * A dropped feature is recorded twice on purpose: as a diagnostic (for the
 * developer) and as a suppression on the snapshot (for the inspector, which must
 * be able to show why something is missing without re-running the read).
 */
export function buildVisualStateSnapshot(input: VisualStateSnapshotInput): VisualStateSnapshot {
  const seen = new Set<string>();
  const kept: VisualStateFeature[] = [];
  const suppressions: VisualStateSuppression[] = [];
  const subjects = new Set<string>();

  for (const contribution of contributionsInAdapterOrder(input.contributions)) {
    for (const feature of contribution.features) {
      if (seen.has(feature.key)) {
        input.sink?.push(
          diag("warn", VISUAL_STATE_DUPLICATE_KEY, `Two adapters claim ${feature.key}`, {
            path: "visual_state.snapshot",
            context: { key: feature.key, adapterId: contribution.adapterId },
          }),
        );
        suppressions.push({ key: feature.key, code: VISUAL_STATE_DUPLICATE_KEY, detail: contribution.adapterId });
        continue;
      }
      seen.add(feature.key);
      subjects.add(feature.subjectId);
      kept.push(feature);
    }
  }

  return {
    version: 1,
    scope: input.scope,
    atMinutes: input.atMinutes,
    cutId: input.cutId,
    subjects: [...subjects].sort(compareStrings),
    features: kept.sort(compareVisualStateFeatures),
    suppressions,
  };
}
