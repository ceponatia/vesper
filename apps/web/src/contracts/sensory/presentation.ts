import {
  AFFORDANCE_CUES_PER_EXCHANGE,
  AFFORDANCE_INTENSITY_WEIGHT,
  type AffordanceIntensityBand,
  type AffordancePhenomenonId,
  type AffordanceSubjectId,
  type AffordanceSuppression,
} from "../affordances/core";

/**
 * The ONE shared presentation architecture the sibling sense owners hang on
 * (owner ruling 2026-08-22).
 *
 * What is shared is the STAGING and its laws — observer identity, fail-closed
 * modality access, repeat families, a strict bounded cue budget, deterministic
 * selection, structured facts with no prose — never the observation contracts
 * themselves. Each sense keeps its own contract in its own module, and this
 * file is generic over them: a routing envelope may carry a channel, but there
 * is no cross-sensory observation type here for one to collapse into, and the
 * shared affordance observation contract gains no channel discriminant.
 *
 * Two of visual state's laws are deliberately NOT reproduced yet, and their
 * absence is load-bearing rather than an oversight:
 *
 * - **No memory.** Visual cue state remembers notice/mention per observer;
 *   these owners recompute from committed truth every cut and persist nothing,
 *   which is what makes retake/branch restoration trivially exact. Sensory
 *   memory, if it ever exists, restores through its own owner — it is not
 *   borrowed from visual state and not smuggled in here.
 * - **No constraints half.** A visual constraint fences what the narrator must
 *   not contradict; the nonvisual senses have no committed always-perceivable
 *   fact to fence until real temperature/texture/source owners exist, and a
 *   fence built on absent owners would be a claim, not a law.
 */

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

/**
 * The narrator cue budget per sense digest — the affordance core's strict
 * "one or two", inherited rather than recalibrated: the restraint the failed
 * affordance-cue trial priced applies to every offered detail, not only the
 * visual ones.
 */
export const SENSORY_NARRATOR_CUE_BUDGET = AFFORDANCE_CUES_PER_EXCHANGE;

// ---------------------------------------------------------------------------
// Shared staging shapes
// ---------------------------------------------------------------------------

/**
 * The slice of every sense's observation contract the shared selection may
 * read. A structural bound, not a base type to extend: a sense contract
 * satisfies it by carrying its own fields, and nothing here can widen into an
 * all-senses observation because nothing here IS an observation.
 */
export interface PresentableSensoryObservation {
  readonly phenomenonId: AffordancePhenomenonId;
  readonly intensityBand: AffordanceIntensityBand;
  /** Anti-repeat identity without the band — the band is the thing that changes. */
  readonly repeatFamily: string;
}

/** What a sense's access law let one observer perceive, and what it withheld. */
export interface SensoryPerception<TObservation> {
  readonly perceived: readonly TObservation[];
  /**
   * Every candidate the access law refused, payload-free. Diagnostic-visible
   * only — a withheld result that still carried its observation would be one
   * convenient cast away from a narrator prompt.
   */
  readonly withheld: readonly AffordanceSuppression[];
}

/**
 * One observer's selected cues for one sense, structured facts only. The
 * narrator adapter downstream owns every word; nothing in a digest is prose.
 */
export interface SensoryNarratorDigest<TSense extends string, TObservation> {
  readonly sense: TSense;
  readonly observerId: AffordanceSubjectId;
  /** The offered cues, best first — already within the budget. */
  readonly selected: readonly TObservation[];
  /** Perceived candidates the selection left unsaid — restraint, measured. */
  readonly suppressedCount: number;
}

/** A sense owner's full presentation result: the digest plus the access refusals. */
export interface SensoryPresentation<TSense extends string, TObservation> {
  readonly digest: SensoryNarratorDigest<TSense, TObservation>;
  readonly withheld: readonly AffordanceSuppression[];
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function intensityWeight(observation: PresentableSensoryObservation): number {
  return AFFORDANCE_INTENSITY_WEIGHT[observation.intensityBand];
}

/** Stronger band first; exact ties break on the phenomenon id, ascending. */
function byIntensityThenId(left: PresentableSensoryObservation, right: PresentableSensoryObservation): number {
  return intensityWeight(right) - intensityWeight(left) || compareStrings(left.phenomenonId, right.phenomenonId);
}

export interface SensoryCueSelection<TObservation> {
  readonly selected: readonly TObservation[];
  readonly suppressedCount: number;
}

/**
 * The shared cue selection: one repeat family speaks once (its strongest
 * member), stronger bands outrank weaker ones, exact ties break on the
 * phenomenon id, and at most `SENSORY_NARRATOR_CUE_BUDGET` survive.
 *
 * Deterministic by construction — no clock, no randomness, no input-order
 * dependence beyond the tie-breaks above — so the same restored cut selects
 * the same cues on replay.
 */
export function selectSensoryCues<TObservation extends PresentableSensoryObservation>(
  perceived: readonly TObservation[],
): SensoryCueSelection<TObservation> {
  const strongestByFamily = new Map<string, TObservation>();
  for (const observation of perceived) {
    const standing = strongestByFamily.get(observation.repeatFamily);
    if (standing === undefined || byIntensityThenId(observation, standing) < 0) {
      strongestByFamily.set(observation.repeatFamily, observation);
    }
  }
  const ranked = [...strongestByFamily.values()].sort(byIntensityThenId);
  const selected = ranked.slice(0, SENSORY_NARRATOR_CUE_BUDGET);
  return { selected, suppressedCount: perceived.length - selected.length };
}

/**
 * Compose one sense's perception result into its presentation: shared
 * selection over what the access law admitted, the observer identity carried
 * through, the withheld set passed on untouched.
 */
export function composeSensoryPresentation<TSense extends string, TObservation extends PresentableSensoryObservation>(
  sense: TSense,
  observerId: AffordanceSubjectId,
  perception: SensoryPerception<TObservation>,
): SensoryPresentation<TSense, TObservation> {
  const { selected, suppressedCount } = selectSensoryCues(perception.perceived);
  return {
    digest: { sense, observerId, selected, suppressedCount },
    withheld: perception.withheld,
  };
}
