import type { Diagnostic, DiagnosticSink } from "../diagnostics";
import {
  emptyAffordanceCueState,
  filterAffordanceObservations,
  mergeAffordanceEvidence,
  selectAffordanceCues,
  type AffordanceConstraint,
  type AffordanceCueState,
  type AffordanceEvidence,
  type AffordanceObservation,
  type AffordancePerceptionView,
  type AffordanceStoryTime,
  type AffordanceSubjectId,
  type AffordanceSuppression,
  type RegisteredAffordanceDomain,
  type ResolvedAttributeSnapshot,
} from "./core";
import { affordanceDomains } from "./domains";

/**
 * The staged affordance read — one subject, one committed cut, one observer.
 *
 * ```text
 * per domain: compileProfile → readInputs → deriveMechanics → buildFrame → phenomena
 *      then:  perception filter → rank + repeat gate + cue cap
 * ```
 *
 * Three properties this function exists to guarantee:
 *
 * - **Physical resolution is observer-independent.** Every domain resolves in
 *   full before perception runs, so two observers of the same cut disagree only
 *   about what they can see — never about what is true.
 * - **Silence is explainable.** Nothing is dropped quietly: a phenomenon that
 *   said nothing appears in `suppressed` with the reason, and anything that
 *   DEGRADED (missing structure, an unavailable or invalid lane input) also
 *   records a diagnostic. Suppressions are debug output; they never reach a
 *   prompt.
 * - **It is a pure function of the committed cut.** No IO, no clock, no
 *   randomness, no hidden latch — so a retake that restores the same state and
 *   the same cue memory reproduces the identical read.
 */

export interface AffordanceReadRequest {
  readonly subjectId: AffordanceSubjectId;
  readonly storyTime: AffordanceStoryTime;
  readonly attributes: ResolvedAttributeSnapshot;
  /** This observer's view. Absent exposure and unasserted channels fail closed. */
  readonly perception: AffordancePerceptionView;
  /** Defaults to the registered tuple; tests and previews may pass a subset. */
  readonly domains?: readonly RegisteredAffordanceDomain[];
  /** Lane payload per domain id. A domain with no payload reads `unknown` and reports its own status. */
  readonly payloads?: Readonly<Record<string, unknown>>;
  /** The cue memory this cut starts from — restored with the state on a retake. */
  readonly previousCues?: AffordanceCueState;
  readonly cap?: number;
  /** Optional pipeline sink; the diagnostics are also returned. */
  readonly sink?: DiagnosticSink;
}

export interface AffordanceRead {
  /** Perception-safe observations — everything this observer may be offered. */
  readonly observations: readonly AffordanceObservation[];
  readonly constraints: readonly AffordanceConstraint[];
  /** Diagnostic-only: what fell silent, and why. Never narrator-visible. */
  readonly suppressed: readonly AffordanceSuppression[];
  /** The ≤ cap cues to actually offer this exchange. */
  readonly cues: readonly AffordanceObservation[];
  /** The cue memory to persist beside the state this read was taken from. */
  readonly nextCues: AffordanceCueState;
  readonly evidence: readonly AffordanceEvidence[];
  readonly diagnostics: readonly Diagnostic[];
}

export function deriveAffordanceRead(request: AffordanceReadRequest): AffordanceRead {
  const domains = request.domains ?? affordanceDomains;
  const resolved: AffordanceObservation[] = [];
  const constraints: AffordanceConstraint[] = [];
  const suppressed: AffordanceSuppression[] = [];
  const evidence: (readonly AffordanceEvidence[])[] = [];
  const diagnostics: Diagnostic[] = [];

  for (const domain of domains) {
    const run = domain.resolve({
      subjectId: request.subjectId,
      storyTime: request.storyTime,
      attributes: request.attributes,
      payload: request.payloads?.[domain.id],
    });
    evidence.push(run.evidence);
    diagnostics.push(...run.diagnostics);
    for (const resolution of run.resolutions) {
      switch (resolution.kind) {
        case "observation":
          resolved.push(resolution);
          break;
        case "constraint":
          constraints.push(resolution);
          break;
        case "suppressed":
          suppressed.push(resolution);
          break;
      }
    }
  }

  const perceived = filterAffordanceObservations({ observations: resolved, perception: request.perception });
  const selection = selectAffordanceCues({
    candidates: perceived.observations,
    previous: request.previousCues ?? emptyAffordanceCueState(),
    cap: request.cap,
    atStoryTime: request.storyTime,
  });

  for (const diagnostic of diagnostics) request.sink?.push(diagnostic);

  return {
    observations: perceived.observations,
    constraints,
    suppressed: [...suppressed, ...perceived.suppressed],
    cues: selection.cues,
    nextCues: selection.nextCues,
    evidence: mergeAffordanceEvidence(...evidence),
    diagnostics,
  };
}
