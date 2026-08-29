import { diag, type DiagnosticSink } from "../diagnostics";
import type {
  AdapterRead,
  AffordanceEvidence,
  AffordanceIntensityBand,
  AffordancePhenomenonId,
  AffordanceSubjectId,
  AffordanceSuppression,
} from "../affordances/core";
import { SENSORY_OLFACTORY_OUT_OF_RANGE, SENSORY_OLFACTORY_RANGE_UNAVAILABLE } from "./diagnostics";
import type { SensoryLocus } from "./locus";
import {
  composeSensoryPresentation,
  type SensoryNarratorDigest,
  type SensoryPerception,
  type SensoryPresentation,
} from "./presentation";

/**
 * The OLFACTORY presentation owner — smell's own observation contract and
 * access law, a sibling beside visual state.
 *
 * An olfactory observation exists only because a producer resolved a REAL
 * current contributor/source from owner reads; the contract carries where that
 * source stands, and production without one is forbidden upstream (a missing
 * residue/product source never becomes a scent claim). Nothing here can turn
 * absence into "odorless" or "clean": an unperceived or unproduced scent is a
 * payload-free suppression, never a negative claim.
 */

/** Smell's own observation contract. See `TactileObservation` for the type-wall rules. */
export interface OlfactoryObservation {
  readonly sense: "olfactory";
  readonly phenomenonId: AffordancePhenomenonId;
  /** Every character the scent is about — its contributors, source-first. */
  readonly sourceSubjectIds: readonly AffordanceSubjectId[];
  /** Where the attested source stands. */
  readonly source: SensoryLocus;
  /** The phenomenon's other end, where one exists — preserved verbatim. */
  readonly counterpart?: SensoryLocus;
  readonly intensityBand: AffordanceIntensityBand;
  /** Structured descriptors from real source reads. Never prose. */
  readonly semanticTags: readonly string[];
  /** Anti-repeat identity without the band — the band is the thing that changes. */
  readonly repeatFamily: string;
  readonly evidence: readonly AffordanceEvidence[];
}

export interface OlfactoryAccess {
  readonly observerId: AffordanceSubjectId;
  /**
   * The lane's answer, per source, to "is this observer within scent range" —
   * distance, exposure, permeability, and airflow composed by THEIR owners and
   * handed in as one read, on the transfer transaction's lane-supplied-resolver
   * precedent. A lane that cannot answer supplies `unavailable` and admits
   * nothing.
   */
  scentRange(source: SensoryLocus): AdapterRead<boolean>;
}

/**
 * Smell's access law: a real range answer is REQUIRED. `unavailable` and
 * `invalid` fail closed with a `warn` (an owner could not answer — degraded,
 * worth counting); an attested out-of-range answer is an ordinary refusal and
 * gets no diagnostic at all.
 */
export function perceiveOlfactory(
  observations: readonly OlfactoryObservation[],
  access: OlfactoryAccess,
  sink?: DiagnosticSink,
): SensoryPerception<OlfactoryObservation> {
  const perceived: OlfactoryObservation[] = [];
  const withheld: AffordanceSuppression[] = [];
  let unanswered = 0;
  for (const observation of observations) {
    const range = access.scentRange(observation.source);
    if (range.status !== "supported") {
      unanswered += 1;
      withheld.push({
        kind: "suppressed",
        phenomenonId: observation.phenomenonId,
        code: SENSORY_OLFACTORY_RANGE_UNAVAILABLE,
        detail: range.status,
      });
      continue;
    }
    if (!range.value) {
      withheld.push({
        kind: "suppressed",
        phenomenonId: observation.phenomenonId,
        code: SENSORY_OLFACTORY_OUT_OF_RANGE,
      });
      continue;
    }
    perceived.push(observation);
  }
  if (unanswered > 0) {
    sink?.push(
      diag("warn", SENSORY_OLFACTORY_RANGE_UNAVAILABLE, "no owner could answer scent range for this observer", {
        context: { observerId: access.observerId, unanswered },
      }),
    );
  }
  return { perceived, withheld };
}

export type OlfactoryNarratorDigest = SensoryNarratorDigest<"olfactory", OlfactoryObservation>;
export type OlfactoryPresentation = SensoryPresentation<"olfactory", OlfactoryObservation>;

/** Access law, then the shared selection: smell's whole presentation for one observer. */
export function presentOlfactoryCues(
  observations: readonly OlfactoryObservation[],
  access: OlfactoryAccess,
  sink?: DiagnosticSink,
): OlfactoryPresentation {
  return composeSensoryPresentation("olfactory", access.observerId, perceiveOlfactory(observations, access, sink));
}
