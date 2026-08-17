import {
  diag,
  type AffordancePerceptionView,
  type DiagnosticSink,
  type VisualAttentionBuild,
  type VisualImageSelection,
  type VisualMemoryState,
  type VisualNarratorSelection,
  type VisualObserverRef,
  type VisualStateSnapshot,
} from "@/contracts";
import {
  assembleVisualStateSnapshot,
  buildVisualStateSelections,
  type VisualStateAssemblyInput,
  type VisualStateLane,
} from "./assemble";
import { legacyNarratorAttributeIds, measureVisualState, type VisualStateMeasurements } from "./measure";

/**
 * THE SHADOW BUILD (visual-state.plan.md slice 6): one committed cut → the
 * snapshot, all three consumer reads, and the slice's measurements — beside the
 * live turn, never inside it.
 *
 * The resilience contract this file holds (docs/resilience.md): a shadow
 * failure must NEVER fail or alter a player turn. `safeBuildVisualStateShadow`
 * converts any throw into `null` plus one `visual_state.shadow.failed`
 * diagnostic on the caller's sink, and the build itself writes nothing —
 * the narrator selection's notices, post-notice memory and mention commits are
 * returned as plain data and dropped by every slice-6 caller.
 */

/** The shadow assembly threw; the build degraded to nothing and the turn is unaffected. */
export const VISUAL_STATE_SHADOW_FAILED = "visual_state.shadow.failed";

export interface VisualStateShadowInput extends VisualStateAssemblyInput {
  readonly lane: VisualStateLane;
  readonly perception: AffordancePerceptionView;
  readonly observerId: string;
  readonly observer: VisualObserverRef;
  /** Observer memory, loaded READ-ONLY. Slice 6 never writes it back. */
  readonly memory?: VisualMemoryState;
  /** The lane's resolved worn garment ids — the garment-summary comparison set. */
  readonly wornGarmentIds?: readonly string[];
}

export interface VisualStateShadowBuild {
  readonly lane: VisualStateLane;
  readonly snapshot: VisualStateSnapshot;
  readonly narrator: VisualNarratorSelection;
  readonly image: VisualImageSelection;
  readonly staircase: VisualAttentionBuild;
  readonly measurements: VisualStateMeasurements;
}

/** Snapshot → selections → measurements, pure over the passed cut. */
export function buildVisualStateShadow(input: VisualStateShadowInput): VisualStateShadowBuild {
  const assembled = assembleVisualStateSnapshot(input);
  const selections = buildVisualStateSelections({
    snapshot: assembled.snapshot,
    perception: input.perception,
    observerId: input.observerId,
    observer: input.observer,
    ...(input.memory === undefined ? {} : { memory: input.memory }),
    ...(input.sink === undefined ? {} : { sink: input.sink }),
  });
  const measurements = measureVisualState({
    snapshot: assembled.snapshot,
    narrator: selections.narrator,
    image: selections.image,
    // The successor narrator deliberately renders no attribute summary (its
    // canon block never reads profile.attributes — audit §Nothing found), so
    // there is nothing to disagree with in that lane.
    legacyAttributeIds:
      input.lane === "character_chat"
        ? legacyNarratorAttributeIds(assembled.stableResolved, assembled.realizedBody)
        : null,
    wornGarmentIds: input.wornGarmentIds === undefined ? null : input.wornGarmentIds,
  });
  return {
    lane: input.lane,
    snapshot: assembled.snapshot,
    narrator: selections.narrator,
    image: selections.image,
    staircase: selections.staircase,
    measurements,
  };
}

/**
 * The fenced build the turn pipelines call: any throw degrades to `null` with
 * one error diagnostic, so the shadow can never cost an exchange. Callers keep
 * their shadow diagnostics on a PRIVATE collector so the turn's own diagnostic
 * record stays byte-identical with the flag on.
 */
export function safeBuildVisualStateShadow(
  input: VisualStateShadowInput,
  sink?: DiagnosticSink,
): VisualStateShadowBuild | null {
  try {
    return buildVisualStateShadow(input);
  } catch (error) {
    (sink ?? input.sink)?.push(
      diag("error", VISUAL_STATE_SHADOW_FAILED, "visual-state shadow assembly threw; the turn is unaffected", {
        path: "visual_state.shadow",
        context: { lane: input.lane, error: error instanceof Error ? error.message : String(error) },
      }),
    );
    return null;
  }
}

/**
 * The one structured log line a shadowed turn emits — compact counts only, so
 * measurement accumulates from the deploy's log stream without a new table
 * (spec §Persistence and capture keeps debug snapshots optional).
 */
export function visualStateShadowLogSummary(build: VisualStateShadowBuild): Record<string, unknown> {
  const { measurements } = build;
  return {
    lane: build.lane,
    cutId: build.snapshot.cutId,
    atMinutes: build.snapshot.atMinutes,
    features: measurements.featureCount,
    byLayer: measurements.featuresByLayer,
    suppressions: measurements.suppressionCount,
    missingOwner: measurements.missingOwnerCount,
    duplicateKeys: measurements.duplicateKeyCount,
    narratorCandidates: measurements.narrator.candidateCount,
    narratorCues: measurements.narrator.selectedCount,
    imageMandatory: measurements.image.mandatoryCount,
    imageOptional: measurements.image.selectedCount,
    attributesLegacyOnly: measurements.attributes?.legacyOnly.length ?? null,
    attributesProjectedOnly: measurements.attributes?.projectedOnly.length ?? null,
    garmentsLegacyOnly: measurements.garments?.legacyOnly.length ?? null,
    garmentsProjectedOnly: measurements.garments?.projectedOnly.length ?? null,
  };
}
