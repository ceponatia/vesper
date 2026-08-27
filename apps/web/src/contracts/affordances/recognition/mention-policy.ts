import type { AppearanceSourceRef, BodyLocusRef } from "../../appearance-features";
import { AFFORDANCE_UNIT_ZERO, type AffordanceStoryTime, type UnitInterval } from "../core";
import type { RecognizableFeatureCandidate, RecognizableFeatureKey } from "./candidates";
import {
  recognitionFeatureSalience,
  recognitionFreshnessBucket,
  recognitionMentionPriority,
  recognitionNovelty,
  recognitionRepetitionCooldown,
  RECOGNITION_ACTION_RELEVANCE,
  RECOGNITION_CHANGE_SIGNIFICANCE,
  RECOGNITION_EMOTIONAL_CALLBACK_IMPORTANCE,
  RECOGNITION_INSPECTION_NOTICE_THRESHOLD,
  RECOGNITION_MENTION_FLOOR,
  RECOGNITION_NOTICE_THRESHOLD,
  type RecognitionFreshnessBucket,
} from "./salience";
import {
  applyRecognitionFingerprintChanges,
  applyRecognitionMention,
  applyRecognitionNotices,
  type RecognitionFingerprintChange,
  type RecognitionNotice,
  type VisualFeatureMemory,
  type VisualMemoryState,
} from "./visual-memory";

/**
 * Mention policy — at most ONE recognition cue per beat.
 *
 * Two decisions live here and they are deliberately not the same decision:
 *
 * 1. **Notice** — did perception cross the threshold? Everything above it
 *    updates observer memory, silently and always. Recognition strengthens by
 *    looking, not by being talked about.
 * 2. **Mention** — is saying it worth the beat? At most one cue survives, and
 *    only for one of the five reasons. Stable ordinary visibility earns notices
 *    forever and cues almost never.
 *
 * The mention is returned as PLAIN DATA (`RecognitionMentionCommit`), not as a
 * closure, because the owner's ruling is that the selection is captured WITH
 * the cut: a serializable commit is what makes a retake reuse the captured
 * result instead of advancing memory a second time. The caller commits it —
 * `commitRecognitionMention(selection.memoryAfterNotices, selection.mentionCommit)`
 * — only once the cue actually enters the committed cut.
 *
 * No prose is generated here. The cue carries structured tags and provenance;
 * the chat adapter owns wording.
 */

export const recognitionCueReasons = [
  "first_notice",
  "recognition_refresh",
  "change",
  "action_relevance",
  "emotional_callback",
] as const;

export type RecognitionCueReason = (typeof recognitionCueReasons)[number];

/** One offered recognition cue. Structured; never prose. */
export interface RecognitionCue {
  readonly key: RecognizableFeatureKey;
  readonly subjectId: string;
  readonly locus: BodyLocusRef;
  readonly reason: RecognitionCueReason;
  readonly semanticTags: readonly string[];
  readonly truthFingerprint: string;
  readonly repeatKey: string;
  readonly priority: UnitInterval;
}

/** The retake-safe record of a selected mention, captured with the cut. */
export interface RecognitionMentionCommit {
  readonly featureKey: RecognizableFeatureKey;
  readonly atMinutes: AffordanceStoryTime;
  readonly reason: RecognitionCueReason;
  readonly repeatKey: string;
}

export interface RecognitionCueSelectionInput {
  readonly candidates: readonly RecognizableFeatureCandidate[];
  readonly memory: VisualMemoryState;
  readonly atMinutes: AffordanceStoryTime;
  /** Body-location ids the current action exposes, touches, or depends on. */
  readonly actionRelevantLocationIds?: ReadonlySet<string>;
  /** Body-location ids under deliberate inspection — the lowered notice threshold. */
  readonly inspectionFocus?: ReadonlySet<string>;
  /** Lane-neutral provenance stamped onto every notice from this cut. */
  readonly observationId?: string;
}

export interface RecognitionCueSelection {
  /** The single cue worth offering, or nothing. */
  readonly cue: RecognitionCue | null;
  /** Everything perception crossed the threshold on — memory bookkeeping, not narration. */
  readonly notices: readonly RecognitionNotice[];
  /** Perceived fingerprint changes, adopted through the explicit change path. */
  readonly changes: readonly RecognitionFingerprintChange[];
  /** Memory after notices and adopted changes. Mentions are NOT applied. */
  readonly memoryAfterNotices: VisualMemoryState;
  /** Apply this only when the cue enters the committed cut. */
  readonly mentionCommit: RecognitionMentionCommit | null;
}

/**
 * Importance grounded in something the observer could have witnessed. A v1
 * approximation of "emotional weight": a located fact or an anatomy delta was
 * committed by an event, whereas an attribute prior is authored backstory and
 * an item is merely worn. Replaceable once source events carry their own
 * observer-visible weight.
 */
function isGroundedRecognitionSource(sourceRef: AppearanceSourceRef): boolean {
  switch (sourceRef.kind) {
    case "located_fact":
    case "anatomy":
      return true;
    case "attribute":
    case "condition":
    case "presentation":
      return false;
  }
}

/**
 * Why this feature might be worth a beat, in precedence order. `null` means
 * "noticed, nothing to say" — the ordinary case for a familiar face.
 */
function recognitionCueReason(input: {
  candidate: RecognizableFeatureCandidate;
  memory: VisualFeatureMemory | undefined;
  fingerprintChanged: boolean;
  bucket: RecognitionFreshnessBucket;
  actionRelevant: boolean;
}): RecognitionCueReason | null {
  if (input.fingerprintChanged) return "change";
  if (input.memory === undefined) return "first_notice";
  if (input.bucket === "long_absence") return "recognition_refresh";
  if (input.actionRelevant) return "action_relevance";
  if (
    input.candidate.importance >= RECOGNITION_EMOTIONAL_CALLBACK_IMPORTANCE &&
    isGroundedRecognitionSource(input.candidate.sourceRef)
  ) {
    return "emotional_callback";
  }
  return null;
}

/** Highest priority wins; exact ties break on the feature key, ascending. */
function strongerCue(left: RecognitionCue, right: RecognitionCue): RecognitionCue {
  if (right.priority > left.priority) return right;
  if (right.priority < left.priority) return left;
  return right.key < left.key ? right : left;
}

/**
 * Score this cut's candidates, update observer memory, and pick at most one cue.
 *
 * Candidates arrive already perception-gated (`buildRecognitionCandidates`
 * suppresses everything hidden, unknown, intimate, or too far), so a zero
 * visibility can never reach here — and if one did, its salience would be zero
 * and it would fail the notice threshold anyway. Both belts are deliberate.
 */
export function selectRecognitionCue(input: RecognitionCueSelectionInput): RecognitionCueSelection {
  const atMinutes = Number.isFinite(input.atMinutes) ? Math.max(0, Math.trunc(input.atMinutes)) : 0;
  const notices: RecognitionNotice[] = [];
  const changes: RecognitionFingerprintChange[] = [];
  let cue: RecognitionCue | null = null;

  for (const candidate of input.candidates) {
    const salience = recognitionFeatureSalience(candidate);
    const locationId = candidate.locus.bodyLocationId;
    const underInspection = input.inspectionFocus?.has(locationId) ?? false;
    const threshold = underInspection ? RECOGNITION_INSPECTION_NOTICE_THRESHOLD : RECOGNITION_NOTICE_THRESHOLD;
    if (candidate.visibility <= AFFORDANCE_UNIT_ZERO || salience < threshold) continue;

    notices.push({
      candidate,
      detailTier: candidate.detailTier,
      atMinutes,
      ...(input.observationId === undefined ? {} : { observationId: input.observationId }),
    });

    const memory = input.memory.features[candidate.key];
    const fingerprintChanged = memory !== undefined && memory.truthFingerprint !== candidate.truthFingerprint;
    if (fingerprintChanged) {
      changes.push({ featureKey: candidate.key, truthFingerprint: candidate.truthFingerprint, atMinutes });
    }

    const bucket: RecognitionFreshnessBucket =
      memory === undefined ? "recent" : recognitionFreshnessBucket(memory.lastNoticedAt, atMinutes);
    const actionRelevant = input.actionRelevantLocationIds?.has(locationId) ?? false;
    const reason = recognitionCueReason({ candidate, memory, fingerprintChanged, bucket, actionRelevant });
    if (reason === null) continue;

    const priority = recognitionMentionPriority({
      salience,
      novelty: recognitionNovelty({ hasMemory: memory !== undefined, fingerprintChanged, bucket }),
      changeSignificance: fingerprintChanged ? RECOGNITION_CHANGE_SIGNIFICANCE : AFFORDANCE_UNIT_ZERO,
      actionRelevance: actionRelevant ? RECOGNITION_ACTION_RELEVANCE : AFFORDANCE_UNIT_ZERO,
      repetitionCooldown: recognitionRepetitionCooldown({
        ...(memory?.lastMentionedAt === undefined ? {} : { lastMentionedAt: memory.lastMentionedAt }),
        mentionCount: memory?.mentionCount ?? 0,
        atMinutes,
      }),
    });
    if (priority < RECOGNITION_MENTION_FLOOR) continue;

    const scored: RecognitionCue = {
      key: candidate.key,
      subjectId: candidate.subjectId,
      locus: candidate.locus,
      reason,
      semanticTags: candidate.semanticTags,
      truthFingerprint: candidate.truthFingerprint,
      repeatKey: candidate.repeatKey,
      priority,
    };
    cue = cue === null ? scored : strongerCue(cue, scored);
  }

  const memoryAfterNotices = applyRecognitionFingerprintChanges(
    applyRecognitionNotices(input.memory, notices),
    changes,
  );
  const mentionCommit: RecognitionMentionCommit | null =
    cue === null
      ? null
      : { featureKey: cue.key, atMinutes, reason: cue.reason, repeatKey: cue.repeatKey };

  return { cue, notices, changes, memoryAfterNotices, mentionCommit };
}

/**
 * Commit the selected mention. `null` (no cue this beat) is a no-op, so a lane
 * can call this unconditionally after the cut lands.
 */
export function commitRecognitionMention(
  state: VisualMemoryState,
  commit: RecognitionMentionCommit | null,
): VisualMemoryState {
  if (commit === null) return state;
  return applyRecognitionMention(state, { featureKey: commit.featureKey, atMinutes: commit.atMinutes });
}
