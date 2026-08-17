import { affordanceEvidence, type AffordanceObservation } from "../affordances/core";
import { diag, type DiagnosticSink } from "../diagnostics";
import { VISUAL_STATE_KIND_UNKNOWN } from "./diagnostics";
import {
  validateVisualStateFeature,
  visualStateFeatureKey,
  visualStateFingerprint,
  type VisualStateFeature,
} from "./feature";
import {
  VISUAL_STATE_AFFORDANCE_OBSERVATION_KIND_ID,
  type VisualStateObservationValue,
} from "./kinds";
import { visualStateKindRegistry } from "./registry";

/**
 * Supported physical-affordance observations as current-layer features
 * (visual-state.audit.md finding 11 — the one derived owner with the
 * `supported` / `unavailable` / `invalid` distinction already built in).
 *
 * The adapter takes RESOLVED observations, not domain state: the staged
 * affordance pipeline (adapters → profile → mechanics → phenomena) already
 * enforced the adapter result law, so an observation in this list IS a
 * supported fact — something actually true now, at a body location, because of
 * a current cause. Unavailable and invalid inputs never became observations,
 * which is why this adapter has no suppression half of its own: the silence
 * already happened upstream, in the owner whose job it is.
 *
 * Constraints and suppressions are deliberately NOT projected. A constraint is
 * narrator guidance (a prohibition, not an appearance), and a suppression is
 * diagnostic-visible only — "we considered saying this and did not" is exactly
 * the hidden state that must never reach a consumer digest.
 *
 * Observations are true for exactly one committed cut, so the kind is
 * `instantaneous`: no change stamp (nothing was written), no validity window
 * (the next cut recomputes), and no recognition eligibility (the registry
 * refuses the pairing at definition time).
 *
 * No composition either, and that is a recorded conservative choice: mapping
 * an observation back to the feature that caused it (wet clumping ← surface
 * wetness) would need per-phenomenon knowledge this projection does not own.
 * The observation's own `repeatKey` and location carry enough for slice 5's
 * ranking without a guessed edge.
 */

export interface VisualStateObservationProjectionInput {
  readonly subjectId: string;
  readonly observations: readonly AffordanceObservation[];
  readonly sink?: DiagnosticSink;
  readonly path?: string;
}

/**
 * One subject's observations as visual-state features, in the order the
 * affordance read resolved them (that order is itself deterministic — domain
 * registration order, then phenomenon order).
 *
 * The aspect is the phenomenon id, plus the target location when the
 * observation reaches toward one (`hair.strand_adhesion:neck`), so the same
 * phenomenon resolving against two targets keeps two keys. Both segments are
 * closed vocabulary — phenomenon ids are pattern-validated and targets are
 * registry body locations — so the aspect needs no escaping. An observation at
 * a body location the registry does not know is dropped by the shared feature
 * validator with its own diagnostics.
 */
export function projectObservationFeatures(
  input: VisualStateObservationProjectionInput,
): readonly VisualStateFeature[] {
  const path = input.path ?? "visual_state.observation";
  const kind = visualStateKindRegistry.byId(VISUAL_STATE_AFFORDANCE_OBSERVATION_KIND_ID);
  if (!kind) {
    input.sink?.push(
      diag("warn", VISUAL_STATE_KIND_UNKNOWN, `${VISUAL_STATE_AFFORDANCE_OBSERVATION_KIND_ID} is not registered`, {
        path,
        context: { subjectId: input.subjectId },
      }),
    );
    return [];
  }

  const projected: VisualStateFeature[] = [];
  for (const observation of input.observations) {
    const locus = { kind: "body", locus: { bodyLocationId: observation.sourceLocationId } } as const;
    const aspect =
      observation.targetLocationId === undefined
        ? `${VISUAL_STATE_AFFORDANCE_OBSERVATION_KIND_ID}:${observation.id}`
        : `${VISUAL_STATE_AFFORDANCE_OBSERVATION_KIND_ID}:${observation.id}:${observation.targetLocationId}`;
    const value: VisualStateObservationValue = {
      phenomenon: observation.id,
      band: observation.intensityBand,
      ...(observation.targetLocationId === undefined ? {} : { target: observation.targetLocationId }),
    };
    const candidate: VisualStateFeature = {
      version: 1,
      key: visualStateFeatureKey(input.subjectId, locus, aspect),
      subjectId: input.subjectId,
      kindId: VISUAL_STATE_AFFORDANCE_OBSERVATION_KIND_ID,
      layer: kind.layer,
      locus,
      sourceRef: { kind: "affordance", observationKey: observation.repeatKey },
      value,
      truthFingerprint: visualStateFingerprint(value),
      semanticTags: [observation.intensityBand, ...observation.semanticTags],
      stability: kind.stability,
      relationships: [],
      priors: {
        ...kind.priors,
        // The observation's own anti-repeat identity, band excluded — exactly
        // the repeat family the affordance cue ranker already keys cooldowns
        // on, carried through so slice 5 inherits it instead of recalibrating.
        repeatFamily: observation.repeatKey,
      },
      evidence: [
        affordanceEvidence("adapter", "visual_state.observation", observation.id),
        affordanceEvidence("state", `observation:${observation.repeatKey}`),
      ],
    };
    const accepted = validateVisualStateFeature(candidate, input.sink, path);
    if (accepted !== null) projected.push(accepted);
  }
  return projected;
}
