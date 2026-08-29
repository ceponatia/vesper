import type {
  AffordanceEvidence,
  AffordanceIntensityBand,
  AffordancePhenomenonId,
  AffordanceSubjectId,
  AffordanceSuppression,
} from "../affordances/core";
import { SENSORY_TACTILE_NOT_PARTICIPANT } from "./diagnostics";
import type { SensoryBodyLocus, SensoryLocus } from "./locus";
import {
  composeSensoryPresentation,
  type SensoryNarratorDigest,
  type SensoryPerception,
  type SensoryPresentation,
} from "./presentation";

/**
 * The TACTILE presentation owner — touch's own observation contract and access
 * law, a sibling beside visual state, never a generalization of it.
 *
 * A tactile observation is a structured felt fact at a contact interface,
 * already true because a producer resolved it from committed contact and real
 * owner reads. It is never prose, and never automatically presented.
 */

/**
 * The committed transmission's tactilely relevant half, preserved verbatim
 * from the producer that owned the read. OPTIONAL because the routing envelope
 * does not carry transmission: a producer that owns the read supplies it, and
 * absent means unavailable — never "direct skin".
 */
export interface TactileTransmission {
  readonly directSkinContact: boolean;
}

/**
 * Touch's own observation contract. Deliberately NOT assignable to the shared
 * `AffordanceObservation` (no `kind` discriminant, its own field names) and not
 * to any sibling sense's contract (the `sense` literal): the only way a felt
 * fact reaches any consumer is through THIS owner.
 */
export interface TactileObservation {
  readonly sense: "tactile";
  readonly phenomenonId: AffordancePhenomenonId;
  /** Every character taking part in the qualifying committed contact, source-first. */
  readonly participantIds: readonly AffordanceSubjectId[];
  /** The body surface the felt fact stands at. */
  readonly surface: SensoryBodyLocus;
  /** The phenomenon's other end, where one exists — locus/path preserved. */
  readonly counterpart?: SensoryLocus;
  readonly transmission?: TactileTransmission;
  readonly intensityBand: AffordanceIntensityBand;
  /** Structured descriptors from real owner reads (a texture with no owner read never becomes a tag). Never prose. */
  readonly semanticTags: readonly string[];
  /** Anti-repeat identity without the band — the band is the thing that changes. */
  readonly repeatFamily: string;
  readonly evidence: readonly AffordanceEvidence[];
}

export interface TactileAccess {
  readonly observerId: AffordanceSubjectId;
}

/**
 * Touch's access law: **the observer must participate in the qualifying
 * committed contact.** Visual exposure is irrelevant — a felt fact under a
 * blanket is still felt — and proximity alone admits nothing: a bystander an
 * inch away felt no part of a touch between two other people.
 *
 * A refusal is an ANSWER, carried as a payload-free suppression with no sink
 * diagnostic (the contact severity rule).
 */
export function perceiveTactile(
  observations: readonly TactileObservation[],
  access: TactileAccess,
): SensoryPerception<TactileObservation> {
  const perceived: TactileObservation[] = [];
  const withheld: AffordanceSuppression[] = [];
  for (const observation of observations) {
    if (observation.participantIds.includes(access.observerId)) {
      perceived.push(observation);
      continue;
    }
    withheld.push({
      kind: "suppressed",
      phenomenonId: observation.phenomenonId,
      code: SENSORY_TACTILE_NOT_PARTICIPANT,
    });
  }
  return { perceived, withheld };
}

export type TactileNarratorDigest = SensoryNarratorDigest<"tactile", TactileObservation>;
export type TactilePresentation = SensoryPresentation<"tactile", TactileObservation>;

/** Access law, then the shared selection: touch's whole presentation for one observer. */
export function presentTactileCues(
  observations: readonly TactileObservation[],
  access: TactileAccess,
): TactilePresentation {
  return composeSensoryPresentation("tactile", access.observerId, perceiveTactile(observations, access));
}
