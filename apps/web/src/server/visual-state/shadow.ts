import {
  diag,
  type AffordancePerceptionView,
  type DiagnosticSink,
  type VisualAttentionBuild,
  type VisualAttentionContext,
  type VisualCueState,
  type VisualImageSelection,
  type VisualMemoryState,
  type VisualNarratorSelection,
  type VisualObserverRef,
  type VisualStateSnapshot,
  type VisualViewingConditions,
} from "@/contracts";
import {
  assembleVisualStateSnapshot,
  buildVisualStateSelections,
  type VisualStateAssemblyInput,
  type VisualStateCameraBinding,
  type VisualStateLane,
  type VisualStateLaneScene,
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
  /** The narrator cue state, loaded READ-ONLY on exactly the same terms. */
  readonly cues?: VisualCueState;
  /** The lane's resolved worn garment ids — the garment-summary comparison set. */
  readonly wornGarmentIds?: readonly string[];
  /**
   * The render's committed scene camera, bound into the image selection pass.
   * Absent for the shadow builds (chat, sim, inspector), which stay
   * byte-identical to today; a consuming render route supplies one.
   */
  readonly camera?: VisualStateCameraBinding;
}

export interface VisualStateShadowBuild {
  readonly lane: VisualStateLane;
  readonly snapshot: VisualStateSnapshot;
  readonly narrator: VisualNarratorSelection;
  readonly image: VisualImageSelection;
  /** The camera context `image` was selected under — the image digest's third input. */
  readonly imageContext: VisualAttentionContext;
  readonly staircase: VisualAttentionBuild;
  /** The conditions the production reads ran under, declared components included. */
  readonly viewing: VisualViewingConditions;
  readonly measurements: VisualStateMeasurements;
}

/**
 * The SCENE participant whose facts file under one visual subject.
 *
 * The two id spaces coincide in the chat lane today (its map is the identity),
 * but they are not the same space — `subjectsByParticipant` exists precisely
 * because a lane may label them differently — and the scene owner answers only
 * to its own participant ids. Reading proximity with a visual subject id would
 * miss every relation and silently fall back to the declared base, which looks
 * exactly like a scene that stated nothing. First match wins on the map's
 * insertion order, so a lane that files two participants under one subject gets
 * a stable answer rather than an arbitrary one.
 */
function sceneParticipantFor(
  sceneRelations: VisualStateLaneScene | undefined,
  subjectId: string | undefined,
): string | undefined {
  if (sceneRelations === undefined || subjectId === undefined) return undefined;
  for (const [participantId, visualSubjectId] of sceneRelations.subjectsByParticipant) {
    if (visualSubjectId === subjectId) return participantId;
  }
  return undefined;
}

/** Snapshot → selections → measurements, pure over the passed cut. */
export function buildVisualStateShadow(input: VisualStateShadowInput): VisualStateShadowBuild {
  const observerParticipantId = sceneParticipantFor(input.sceneRelations, input.playerSubjectId);
  const subjectParticipantId = sceneParticipantFor(input.sceneRelations, input.subjectId);
  const assembled = assembleVisualStateSnapshot(input);
  const selections = buildVisualStateSelections({
    snapshot: assembled.snapshot,
    perception: input.perception,
    perceptionSubjectId: input.subjectId,
    observerId: input.observerId,
    observer: input.observer,
    ...(input.memory === undefined ? {} : { memory: input.memory }),
    ...(input.cues === undefined ? {} : { cues: input.cues }),
    // The viewing conditions read the same committed scene the body-language
    // adapter does; the observer is the lane's player subject.
    ...(input.sceneRelations === undefined ? {} : { scene: input.sceneRelations.scene }),
    ...(observerParticipantId === undefined ? {} : { observerParticipantId }),
    ...(subjectParticipantId === undefined ? {} : { subjectParticipantId }),
    ...(input.camera === undefined ? {} : { camera: input.camera }),
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
    imageContext: selections.imageContext,
    staircase: selections.staircase,
    viewing: selections.viewing,
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
