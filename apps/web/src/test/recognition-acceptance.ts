import { expect } from "vitest";
import type { DiagnosticCollector } from "@/contracts/diagnostics";
import type { AttributeValue } from "@/contracts/attributes";
import {
  appearanceFeatureKey,
  crookedNoseAttributes,
  freckleClusterFact,
  missingFingerState,
  projectAppearanceTruth,
  scarFact,
  APPEARANCE_BIRTHMARK_KIND_ID,
  APPEARANCE_FIXTURE_SUBJECT_ID,
  APPEARANCE_FRECKLE_CLUSTER_KIND_ID,
  APPEARANCE_PRESENCE_ASPECT,
  APPEARANCE_SCAR_KIND_ID,
  HUMANOID_HAND_DETAIL_SCHEMA_ID,
  type AnatomyPartState,
  type BodyLocusRef,
  type LocatedAppearanceFact,
  type ProjectedFeatureTruth,
} from "@/contracts/appearance-features";
import { affordancePerceptionView, type AffordanceExposure } from "@/contracts/affordances/core";
import {
  buildRecognitionCandidates,
  commitRecognitionMention,
  selectRecognitionCue,
  RECOGNITION_FIXTURE_VISIBLE_LOCATION_IDS,
  type RecognitionCueSelection,
  type RecognitionObserverContext,
  type RecognitionSuppression,
  type RecognizableFeatureCandidate,
  type VisualFeatureMemory,
  type VisualMemoryState,
} from "@/contracts/affordances/recognition";

/**
 * The slice-7 cross-package acceptance harness: ONE turn of the real chain,
 * shared by both acceptance suites.
 *
 * ```text
 * body truth (attributes | located facts | anatomy state)
 *   → projectAppearanceTruth        (appearance-features)
 *   → buildRecognitionCandidates    (recognition: observer gates)
 *   → selectRecognitionCue          (recognition: salience + memory + policy)
 *   → commitRecognitionMention      (the cut landed)
 * ```
 *
 * No mocks and no hand-built candidates on the happy paths: a scenario that
 * wants a covered shoulder covers the shoulder and lets the chain decide.
 * Deterministic throughout — no clock, no randomness.
 *
 * It lives in `src/test` (which sits outside every `no-restricted-imports`
 * zone) because two suites share it — `recognition-acceptance.test.ts` and
 * `recognition-acceptance-safety.test.ts`.
 */

export const ONE_DAY = 1_440;
export const ACCEPTANCE_SUBJECT_ID = APPEARANCE_FIXTURE_SUBJECT_ID;

export const FRECKLE_LOCUS: BodyLocusRef = { bodyLocationId: "shoulders" };
export const SCAR_LOCUS: BodyLocusRef = { bodyLocationId: "forearms", side: "right" };
export const BREAST_LOCUS: BodyLocusRef = { bodyLocationId: "breasts" };
export const FINGER_LOCUS: BodyLocusRef = {
  bodyLocationId: "fingers",
  side: "left",
  detail: { schemaId: HUMANOID_HAND_DETAIL_SCHEMA_ID, path: ["ring_finger"] },
};

/** The keys the chain produces, built with the REAL key builder — never typed by hand. */
export const NOSE_KEY = appearanceFeatureKey(ACCEPTANCE_SUBJECT_ID, { bodyLocationId: "nose" }, "shape");
export const FRECKLE_KEY = appearanceFeatureKey(
  ACCEPTANCE_SUBJECT_ID,
  FRECKLE_LOCUS,
  APPEARANCE_FRECKLE_CLUSTER_KIND_ID,
);
export const SCAR_KEY = appearanceFeatureKey(ACCEPTANCE_SUBJECT_ID, SCAR_LOCUS, APPEARANCE_SCAR_KIND_ID);
export const BREAST_MARK_KEY = appearanceFeatureKey(ACCEPTANCE_SUBJECT_ID, BREAST_LOCUS, APPEARANCE_BIRTHMARK_KIND_ID);
export const FINGER_KEY = appearanceFeatureKey(ACCEPTANCE_SUBJECT_ID, FINGER_LOCUS, APPEARANCE_PRESENCE_ASPECT);

export interface BodyTruth {
  readonly attributes?: readonly AttributeValue[];
  readonly locatedFacts?: readonly LocatedAppearanceFact[];
  readonly anatomy?: readonly AnatomyPartState[];
}

/** The spec's whole worked subject: attribute + authored fact + acquired fact + topology. */
export function richBody(): BodyTruth {
  return {
    attributes: crookedNoseAttributes(),
    locatedFacts: [freckleClusterFact(), scarFact()],
    anatomy: [missingFingerState()],
  };
}

/** A present part, which is deliberately NOT a feature — the pre-injury baseline. */
export function presentRingFinger(effectiveFrom = 0): AnatomyPartState {
  return { ...missingFingerState({ effectiveFrom }), state: "present", sourceEventId: "event_birth" };
}

export interface LookInput {
  readonly body: BodyTruth;
  readonly memory: VisualMemoryState;
  readonly atMinutes: number;
  /** Overrides over "every fixture location visible". `unknown` is the fail-closed lane. */
  readonly exposure?: Readonly<Record<string, AffordanceExposure>>;
  readonly inspecting?: readonly string[];
  readonly importanceBoosts?: Readonly<Record<string, number>>;
  readonly intimateAllowed?: boolean;
  readonly actionRelevant?: readonly string[];
  readonly observationId?: string;
  readonly sink?: DiagnosticCollector;
}

export interface Look {
  readonly projected: readonly ProjectedFeatureTruth[];
  readonly candidates: readonly RecognizableFeatureCandidate[];
  readonly suppressed: readonly RecognitionSuppression[];
  readonly selection: RecognitionCueSelection;
  /** Memory once the selected cue actually entered the committed cut. */
  readonly committed: VisualMemoryState;
}

/**
 * One turn: project this body, gate it through this observer, select at most
 * one cue, and commit whatever the cut carried. `inspecting` deliberately
 * reaches BOTH ends — deliberate inspection is a detail tier at the candidate
 * builder and a lowered notice threshold at the policy, and a lane that set one
 * without the other would be testing a state no adapter can produce.
 */
export function look(input: LookInput): Look {
  const exposure: Record<string, AffordanceExposure> = {};
  for (const locationId of RECOGNITION_FIXTURE_VISIBLE_LOCATION_IDS) exposure[locationId] = "visible";
  const inspectionFocus = input.inspecting === undefined ? undefined : new Set(input.inspecting);
  const observer: RecognitionObserverContext = {
    perception: affordancePerceptionView({
      exposure: { ...exposure, ...input.exposure },
      channels: { sight: "available" },
    }),
    baseDetailTier: 2,
    inspectionFocus,
    importanceBoosts: input.importanceBoosts,
    intimateAllowed: input.intimateAllowed,
  };
  const projected = projectAppearanceTruth({
    subjectId: ACCEPTANCE_SUBJECT_ID,
    attributes: input.body.attributes ?? [],
    locatedFacts: input.body.locatedFacts,
    anatomy: input.body.anatomy,
    atMinutes: input.atMinutes,
    sink: input.sink,
  });
  const built = buildRecognitionCandidates({ projected, observer, sink: input.sink });
  const selection = selectRecognitionCue({
    candidates: built.candidates,
    memory: input.memory,
    atMinutes: input.atMinutes,
    actionRelevantLocationIds: input.actionRelevant === undefined ? undefined : new Set(input.actionRelevant),
    inspectionFocus,
    observationId: input.observationId,
  });
  return {
    projected,
    candidates: built.candidates,
    suppressed: built.suppressed,
    selection,
    committed: commitRecognitionMention(selection.memoryAfterNotices, selection.mentionCommit),
  };
}

/** The memory row for a key, asserting it exists so the failure names the key. */
export function remembered(state: VisualMemoryState, key: string): VisualFeatureMemory {
  const row = state.features[key];
  if (row === undefined) {
    expect.fail(`expected a visual-memory row for ${key}`);
  }
  return row;
}

/** Everything perception crossed the threshold on this turn. */
export function noticedKeys(selection: RecognitionCueSelection): string[] {
  return selection.notices.map((notice) => notice.candidate.key);
}

/** The candidate for a key, asserting it survived the observer gates. */
export function candidateFor(read: Look, key: string): RecognizableFeatureCandidate {
  const candidate = read.candidates.find((entry) => entry.key === key);
  if (candidate === undefined) {
    expect.fail(`expected a candidate for ${key}`);
  }
  return candidate;
}
