import { diag, type DiagnosticSink } from "../diagnostics";
import type {
  AdapterRead,
  AffordanceEvidence,
  AffordanceIntensityBand,
  AffordancePhenomenonId,
  AffordanceSubjectId,
  AffordanceSuppression,
} from "../affordances/core";
import { SENSORY_GUSTATORY_NO_ORAL_CONTACT, SENSORY_GUSTATORY_ORAL_CONTACT_UNAVAILABLE } from "./diagnostics";
import { sensoryLocusKey, type SensoryLocus } from "./locus";
import {
  composeSensoryPresentation,
  type SensoryNarratorDigest,
  type SensoryPerception,
  type SensoryPresentation,
} from "./presentation";

/**
 * The GUSTATORY presentation owner — taste's own observation contract and
 * access law, a sibling beside visual state.
 *
 * A gustatory observation exists only because a producer resolved real source
 * contributors on the tasted surface; producing one without them is forbidden
 * upstream. The action/permission scope for the oral contact itself is
 * enforced where actions commit — this owner consumes committed truth only and
 * never re-litigates permission.
 */

/** Taste's own observation contract. See `TactileObservation` for the type-wall rules. */
export interface GustatoryObservation {
  readonly sense: "gustatory";
  readonly phenomenonId: AffordancePhenomenonId;
  /** Every character the taste fact is about, source-first. */
  readonly participantIds: readonly AffordanceSubjectId[];
  /** The qualifying surface the taste stands on. */
  readonly tastedSurface: SensoryLocus;
  /** The phenomenon's other end, where one exists — preserved verbatim. */
  readonly counterpart?: SensoryLocus;
  readonly intensityBand: AffordanceIntensityBand;
  /** Structured descriptors from real source reads. Never prose. */
  readonly semanticTags: readonly string[];
  /** Anti-repeat identity without the band — the band is the thing that changes. */
  readonly repeatFamily: string;
  readonly evidence: readonly AffordanceEvidence[];
}

export interface GustatoryAccess {
  readonly observerId: AffordanceSubjectId;
  /**
   * The surfaces the observer's committed direct oral contact currently
   * touches, as `sensoryLocusKey` identities — the lane derives them from the
   * contact owner's committed truth. A lane that cannot answer supplies
   * `unavailable` and admits nothing.
   */
  readonly oralContact: AdapterRead<ReadonlySet<string>>;
}

/**
 * Taste's access law: **explicit compatible direct oral contact with the
 * qualifying surface.** Proximity alone never creates taste, and no other
 * sense's access substitutes. A missing oral-contact read fails closed with a
 * `warn`; a committed oral contact that simply does not touch the tasted
 * surface is an ordinary refusal with no diagnostic.
 */
export function perceiveGustatory(
  observations: readonly GustatoryObservation[],
  access: GustatoryAccess,
  sink?: DiagnosticSink,
): SensoryPerception<GustatoryObservation> {
  const perceived: GustatoryObservation[] = [];
  const withheld: AffordanceSuppression[] = [];
  const oralContact = access.oralContact;
  if (oralContact.status !== "supported") {
    for (const observation of observations) {
      withheld.push({
        kind: "suppressed",
        phenomenonId: observation.phenomenonId,
        code: SENSORY_GUSTATORY_ORAL_CONTACT_UNAVAILABLE,
        detail: oralContact.status,
      });
    }
    if (observations.length > 0) {
      sink?.push(
        diag(
          "warn",
          SENSORY_GUSTATORY_ORAL_CONTACT_UNAVAILABLE,
          "no owner could answer what this observer's oral contact touches",
          { context: { observerId: access.observerId, unanswered: observations.length } },
        ),
      );
    }
    return { perceived, withheld };
  }
  const touched = oralContact.value;
  for (const observation of observations) {
    if (touched.has(sensoryLocusKey(observation.tastedSurface))) {
      perceived.push(observation);
      continue;
    }
    withheld.push({
      kind: "suppressed",
      phenomenonId: observation.phenomenonId,
      code: SENSORY_GUSTATORY_NO_ORAL_CONTACT,
    });
  }
  return { perceived, withheld };
}

export type GustatoryNarratorDigest = SensoryNarratorDigest<"gustatory", GustatoryObservation>;
export type GustatoryPresentation = SensoryPresentation<"gustatory", GustatoryObservation>;

/** Access law, then the shared selection: taste's whole presentation for one observer. */
export function presentGustatoryCues(
  observations: readonly GustatoryObservation[],
  access: GustatoryAccess,
  sink?: DiagnosticSink,
): GustatoryPresentation {
  return composeSensoryPresentation("gustatory", access.observerId, perceiveGustatory(observations, access, sink));
}
