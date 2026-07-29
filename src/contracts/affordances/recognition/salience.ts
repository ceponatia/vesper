import { scaleFixedPoint } from "@/lib/fixed-point";
import type { AppearanceDetailTier, AppearanceStability } from "../../appearance-features";
import {
  addUnits,
  complementUnit,
  multiplyUnits,
  toUnitInterval,
  AFFORDANCE_UNIT_ONE,
  AFFORDANCE_UNIT_ZERO,
  type AffordanceStoryTime,
  type UnitInterval,
} from "../core";

/**
 * Recognition salience — the whole scoring surface, in fixed point
 * (body-attribute-affordances.recognizable-features.memory.md §Scores).
 *
 * ```text
 * featureSalience  = visibility × (0.55 × uniqueness + 0.45 × importance)
 * mentionPriority  = featureSalience
 *                  × max(novelty, changeSignificance, actionRelevance)
 *                  × repetitionCooldown
 * ```
 *
 * **Every constant in this file is a fixture-tested calibration default, not
 * product law** (the owner's calibration stance, 2026-07-28). They are tuned
 * against the acceptance cases and are expected to move; what may NOT move is
 * the shape:
 *
 * - zero visibility is a hard gate — a product with a zero factor is zero, so
 *   an invisible feature can never notice however rare it is;
 * - uniqueness and importance stay SEPARATE inputs, never pre-blended into
 *   storage, so a common-but-important shared-event scar can be made to outrank
 *   a rare irrelevant mark on purpose rather than by accident;
 * - novelty and relevance move mention priority only. They never touch
 *   canonical recognizability, and a low priority never deletes memory.
 *
 * No floating point anywhere: a weight of `0.55` is `scaleFixedPoint(x, 5_500)`.
 * Two machines replaying the same cut must agree in the last digit.
 */

// ---------------------------------------------------------------------------
// Weights and thresholds
// ---------------------------------------------------------------------------

/** The `0.55` on uniqueness in the salience mix. */
export const RECOGNITION_UNIQUENESS_WEIGHT = 5_500;
/** The `0.45` on importance. Sums with the above to exactly one unit. */
export const RECOGNITION_IMPORTANCE_WEIGHT = 4_500;

/**
 * Notice threshold — the ruling's "roughly 0.35–0.40", taken at its lower edge
 * so an ordinary conversational look at a genuinely distinctive feature lands.
 */
export const RECOGNITION_NOTICE_THRESHOLD = 3_500;

/**
 * Deliberate inspection lowers the bar to the ruling's ~0.25. It never bypasses
 * visibility: an inspected but covered location still produces no candidate at
 * all, so there is nothing here to lower.
 */
export const RECOGNITION_INSPECTION_NOTICE_THRESHOLD = 2_500;

/** One story day. Under this, a feature is `recent`. */
export const RECOGNITION_FRESH_RECENT_MINUTES = 1_440;
/** Thirty story days. Past this, a feature is a `long_absence` recognition refresh. */
export const RECOGNITION_FRESH_FAMILIAR_MINUTES = 43_200;

/**
 * The recognition floor (the decay ruling): a repeatedly noticed STABLE feature
 * is never forgotten back to nothing. Only freshness moves between buckets.
 */
export const RECOGNITION_STRENGTH_FLOOR = 2_500;
/** "Repeatedly" — three clear notices before the floor is earned. */
export const RECOGNITION_STRENGTH_FLOOR_MIN_NOTICES = 3;

/** Below this mention priority nothing is said at all, whatever the reason. */
export const RECOGNITION_MENTION_FLOOR = 2_000;

/**
 * Full cooldown recovery span for a feature mentioned ONCE. The window scales
 * with the mention count, so the fourth callback to the same scar takes four
 * story days to earn instead of one.
 */
export const RECOGNITION_COOLDOWN_RECOVERY_MINUTES = 1_440;

/** Never seen before — maximum novelty by definition. */
export const RECOGNITION_NOVELTY_UNSEEN: UnitInterval = AFFORDANCE_UNIT_ONE;
/** Known, but not as it is now. Just below unseen: the observer has a baseline to contradict. */
export const RECOGNITION_NOVELTY_CHANGED = 9_000;
/** Recognition refresh after thirty story days. High, not maximal — this is re-identification. */
export const RECOGNITION_NOVELTY_LONG_ABSENCE = 7_000;
/** Seen within the month. Low: it supports identity continuity without narration. */
export const RECOGNITION_NOVELTY_FAMILIAR = 2_000;
/** Seen today. Near zero — this is the value that keeps ordinary visibility silent. */
export const RECOGNITION_NOVELTY_RECENT = 500;

/** Relevance weight when the observer's memory of the feature is contradicted. */
export const RECOGNITION_CHANGE_SIGNIFICANCE: UnitInterval = toUnitInterval(9_500);
/** Relevance weight when the current action exposes, touches, or depends on the locus. */
export const RECOGNITION_ACTION_RELEVANCE: UnitInterval = toUnitInterval(8_000);
/** Importance at or above which a grounded feature may carry an emotional callback. */
export const RECOGNITION_EMOTIONAL_CALLBACK_IMPORTANCE = 7_000;

/**
 * How much a look at each detail tier is worth: a glance confirms, a close
 * inspection convinces. Feeds both recognition-strength gain and confidence.
 */
export const RECOGNITION_TIER_WEIGHT: Readonly<Record<AppearanceDetailTier, number>> = {
  1: 5_000,
  2: 7_500,
  3: 10_000,
};

/** Confidence is mostly about how well you saw it… */
export const RECOGNITION_CONFIDENCE_TIER_SHARE = 7_000;
/** …and partly about whether it was worth looking at. The two shares sum to one unit. */
export const RECOGNITION_CONFIDENCE_SALIENCE_SHARE = 3_000;

// ---------------------------------------------------------------------------
// Salience
// ---------------------------------------------------------------------------

/**
 * The three dimensions, structurally. Deliberately NOT the whole candidate:
 * salience is a function of exactly these, and taking less keeps this module
 * free of any dependency on the candidate builder.
 */
export interface RecognitionSalienceInput {
  readonly visibility: UnitInterval;
  readonly uniqueness: UnitInterval;
  readonly importance: UnitInterval;
}

/** `visibility × (0.55 × uniqueness + 0.45 × importance)`. */
export function recognitionFeatureSalience(input: RecognitionSalienceInput): UnitInterval {
  const mix = addUnits(
    toUnitInterval(scaleFixedPoint(input.uniqueness, RECOGNITION_UNIQUENESS_WEIGHT)),
    scaleFixedPoint(input.importance, RECOGNITION_IMPORTANCE_WEIGHT),
  );
  return multiplyUnits(input.visibility, mix);
}

// ---------------------------------------------------------------------------
// Freshness and novelty
// ---------------------------------------------------------------------------

export const recognitionFreshnessBuckets = ["recent", "familiar", "long_absence"] as const;
export type RecognitionFreshnessBucket = (typeof recognitionFreshnessBuckets)[number];

/**
 * Buckets before any continuous decay curve (the decay ruling). A non-finite
 * stamp degrades to `long_absence`: "we do not know when this was last seen" is
 * a re-identification, never a claim of freshness.
 */
export function recognitionFreshnessBucket(
  lastNoticedAt: AffordanceStoryTime,
  atMinutes: AffordanceStoryTime,
): RecognitionFreshnessBucket {
  if (!Number.isFinite(lastNoticedAt) || !Number.isFinite(atMinutes)) return "long_absence";
  const elapsed = Math.max(0, Math.trunc(atMinutes) - Math.trunc(lastNoticedAt));
  if (elapsed < RECOGNITION_FRESH_RECENT_MINUTES) return "recent";
  if (elapsed <= RECOGNITION_FRESH_FAMILIAR_MINUTES) return "familiar";
  return "long_absence";
}

/**
 * How new this reading is to the observer.
 *
 * Takes `hasMemory` rather than the memory row itself: novelty needs one bit of
 * it, and depending on the row would make salience import visual memory, which
 * already imports salience for the strength law (`pnpm lint:cycles` forbids the
 * loop, and the loop would be real, not incidental).
 */
export function recognitionNovelty(input: {
  hasMemory: boolean;
  fingerprintChanged: boolean;
  bucket: RecognitionFreshnessBucket;
}): UnitInterval {
  if (!input.hasMemory) return RECOGNITION_NOVELTY_UNSEEN;
  if (input.fingerprintChanged) return toUnitInterval(RECOGNITION_NOVELTY_CHANGED);
  switch (input.bucket) {
    case "long_absence":
      return toUnitInterval(RECOGNITION_NOVELTY_LONG_ABSENCE);
    case "familiar":
      return toUnitInterval(RECOGNITION_NOVELTY_FAMILIAR);
    case "recent":
      return toUnitInterval(RECOGNITION_NOVELTY_RECENT);
  }
}

// ---------------------------------------------------------------------------
// Repetition cooldown
// ---------------------------------------------------------------------------

/** A finite whole number of story minutes; anything else reads as zero. */
function wholeMinutes(value: number): number {
  return Number.isFinite(value) ? Math.trunc(value) : 0;
}

/**
 * Linear recovery, deliberately boring and fully deterministic:
 *
 * ```text
 * window   = RECOGNITION_COOLDOWN_RECOVERY_MINUTES × max(1, mentionCount)
 * cooldown = clamp( (now − lastMentionedAt) / window )
 * ```
 *
 * Never mentioned ⇒ fully recovered (`1.0`). The instant after a mention ⇒ `0`,
 * which zeroes mention priority outright — that is the "said it, stop saying
 * it" rule, and it is the one factor that can silence an otherwise perfect cue.
 * Each additional mention widens the window, so a feature the narrator keeps
 * returning to gets progressively harder to return to.
 */
export function recognitionRepetitionCooldown(input: {
  lastMentionedAt?: AffordanceStoryTime;
  mentionCount: number;
  atMinutes: AffordanceStoryTime;
}): UnitInterval {
  if (input.lastMentionedAt === undefined) return AFFORDANCE_UNIT_ONE;
  const elapsed = Math.max(0, wholeMinutes(input.atMinutes) - wholeMinutes(input.lastMentionedAt));
  const mentions = Math.max(1, wholeMinutes(input.mentionCount));
  return toUnitInterval((elapsed * AFFORDANCE_UNIT_ONE) / (RECOGNITION_COOLDOWN_RECOVERY_MINUTES * mentions));
}

// ---------------------------------------------------------------------------
// Mention priority
// ---------------------------------------------------------------------------

/**
 * `salience × max(novelty, changeSignificance, actionRelevance) × cooldown`.
 *
 * `max` and not a sum: the three are competing REASONS to speak, and the best
 * reason is the reason. Summing would let three weak excuses out-argue one good
 * one, which is exactly the chattiness this policy exists to prevent.
 */
export function recognitionMentionPriority(input: {
  salience: UnitInterval;
  novelty: UnitInterval;
  changeSignificance: UnitInterval;
  actionRelevance: UnitInterval;
  repetitionCooldown: UnitInterval;
}): UnitInterval {
  const strongest = toUnitInterval(Math.max(input.novelty, input.changeSignificance, input.actionRelevance));
  return multiplyUnits(input.salience, strongest, input.repetitionCooldown);
}

// ---------------------------------------------------------------------------
// Recognition strength and confidence
// ---------------------------------------------------------------------------

/**
 * One notice's saturating gain: each clear look closes a `salience × tier`
 * fraction of whatever distance to certainty remains. Monotone, bounded, and it
 * can never reach a value a single look would have justified — which is what
 * makes "repeated clear observations raise recognition strength" true without
 * letting one lucky glance make a stranger unforgettable.
 */
export function recognitionStrengthAfterNotice(input: {
  previous: UnitInterval;
  salience: UnitInterval;
  detailTier: AppearanceDetailTier;
}): UnitInterval {
  const gain = multiplyUnits(input.salience, toUnitInterval(RECOGNITION_TIER_WEIGHT[input.detailTier]));
  return addUnits(input.previous, scaleFixedPoint(complementUnit(input.previous), gain));
}

/**
 * The recognition floor law: a stable feature noticed enough times keeps a
 * residual strength forever. Transient and presentation features do not — a
 * bruise or a borrowed coat is legitimately forgettable.
 */
export function recognitionStrengthWithFloor(input: {
  strength: UnitInterval;
  stability: AppearanceStability;
  noticeCount: number;
}): UnitInterval {
  if (input.noticeCount < RECOGNITION_STRENGTH_FLOOR_MIN_NOTICES) return input.strength;
  switch (input.stability) {
    case "inherent":
    case "persistent":
      return toUnitInterval(Math.max(input.strength, RECOGNITION_STRENGTH_FLOOR));
    case "transient":
    case "presentation":
      return input.strength;
  }
}

/** How sure the observer is of what they saw: mostly closeness, partly salience. */
export function recognitionNoticeConfidence(input: {
  salience: UnitInterval;
  detailTier: AppearanceDetailTier;
}): UnitInterval {
  const fromTier = scaleFixedPoint(RECOGNITION_TIER_WEIGHT[input.detailTier], RECOGNITION_CONFIDENCE_TIER_SHARE);
  const fromSalience = scaleFixedPoint(input.salience, RECOGNITION_CONFIDENCE_SALIENCE_SHARE);
  return toUnitInterval(fromTier + fromSalience);
}

/** The zero-visibility gate, as a named predicate the tests can assert directly. */
export function recognitionCanNotice(input: {
  salience: UnitInterval;
  visibility: UnitInterval;
  underInspection: boolean;
}): boolean {
  if (input.visibility <= AFFORDANCE_UNIT_ZERO) return false;
  const threshold = input.underInspection ? RECOGNITION_INSPECTION_NOTICE_THRESHOLD : RECOGNITION_NOTICE_THRESHOLD;
  return input.salience >= threshold;
}
