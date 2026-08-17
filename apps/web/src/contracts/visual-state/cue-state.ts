import { z } from "zod";
import {
  toUnitInterval,
  AFFORDANCE_UNIT_ONE,
  type UnitInterval,
} from "../affordances/core";
import { visualStateFingerprint } from "./feature";

/**
 * NARRATOR VISUAL CUE STATE (visual-state.plan.md §Open questions → "how
 * repetition and first visibility are tracked for facts recognition does not
 * hold"; spec §Attention and memory).
 *
 * ## The gap this fills
 *
 * Current-state and body-language kinds are deliberately
 * `recognitionEligible: false` — an observer's recognition memory should not
 * fill up with "she was sitting down" or "her left sleeve was rolled", and
 * `defineVisualStateKind` refuses to let an instantaneous kind earn a
 * recognition floor at all. That ruling is right, and it has two costs the
 * shipped slices exposed:
 *
 * - **No cooldown.** `repetitionCooldown` reads observer memory's
 *   `lastMentionedAt`. A feature memory never holds cannot cool down, so a
 *   recently stamped rolled sleeve stays cue-eligible turn after turn — the
 *   exact chattiness the mention policy exists to prevent.
 * - **No first-visibility record.** Novelty reads whether memory has seen the
 *   feature before. Without one, nothing can tell the narrator that an ordinary
 *   visual fact became visible NOW rather than merely being true now — a coat
 *   coming off does not change the sleeve's own fingerprint, only what is in
 *   front of it.
 *
 * Repetition and newly-revealed detail are two of slice 7's five evaluation
 * axes, so the paid trial cannot score them until both are tracked.
 *
 * ## What this is, and what it deliberately is not
 *
 * A narrator-scoped record, kept SEPARATE from recognition memory and disjoint
 * from it: this state holds exactly the families memory cannot
 * (`recognitionEligible: false`, or a stability the floor law refuses), and
 * memory keeps holding the rest. Nothing here earns a recognition floor,
 * strengthens confidence, or claims the observer would recognize anyone — it
 * answers two questions and no others: *was this family in view last cut?* and
 * *when did we last say it?*
 *
 * It is keyed by REPEAT KEY rather than feature key, because both questions are
 * questions about the family. `visualAttentionRepeatKey` already renders the
 * locus into the key, so "the left sleeve's arrangement" and "the right
 * sleeve's arrangement" are separate families; two facts that genuinely share
 * one family (two aspects of one sleeve) are the case the repeat family exists
 * to merge, and their combined `visibleFingerprint` is the right granularity —
 * "did anything about this sleeve change while we were not looking".
 *
 * ## Why a sequence and not a clock
 *
 * "Newly visible" means *not visible in the immediately preceding cut*, which
 * is a question about cuts, not about story minutes: chat turns advance the
 * clock by wildly varying amounts, so any minute threshold would call a
 * continuously visible sleeve newly revealed after a long gap and miss a coat
 * that came off and went back on inside an hour. `sequence` counts the cuts
 * this observer has recorded, so the comparison is exact and clock-independent.
 * Story minutes are still stored, for the trial's own reporting and for the
 * mention cooldown, which IS a story-time question.
 *
 * ## Retakes
 *
 * Pure transitions returned as plain data, on the mention-policy precedent: a
 * retake restores the pre-exchange state (including the sequence) and
 * recomputes, so a second take of one exchange can never advance visibility or
 * mention counts twice.
 */

// ---------------------------------------------------------------------------
// Caps and calibration
// ---------------------------------------------------------------------------

/**
 * Rows kept per observer/subject — the same 96 the visual-memory cap uses, for
 * the same reason: a bounded record that a replay reproduces byte-for-byte.
 */
export const VISUAL_CUE_RECORDS_MAX = 96;

/**
 * Novelty for a family this observer has never had in view. Maximum by
 * definition, mirroring `RECOGNITION_NOVELTY_UNSEEN` — restated rather than
 * imported, because `visual-state` may not import `affordances/recognition`
 * (the import direction ruling in `scope.ts`; the identity is asserted at the
 * meeting point in `visual-attention.ts`).
 */
export const VISUAL_CUE_NOVELTY_FIRST_VISIBLE: UnitInterval = AFFORDANCE_UNIT_ONE;

/**
 * Novelty for a family that was in view before, is in view now, and was NOT in
 * view last cut — the newly-revealed case. High, and just below a changed
 * fingerprint: a sleeve reappearing matters less than a sleeve that is not as
 * it was.
 */
export const VISUAL_CUE_NOVELTY_REVEALED = 8_500;

/** Novelty for a family whose visible facts moved while it was in view. Mirrors the changed-fingerprint weight. */
export const VISUAL_CUE_NOVELTY_CHANGED = 9_000;

/**
 * Novelty for a family in continuous view and unchanged. Near zero — this is
 * the value that keeps a steady rolled sleeve quiet, which is the whole point.
 */
export const VISUAL_CUE_NOVELTY_STEADY = 500;

// ---------------------------------------------------------------------------
// The persisted row
// ---------------------------------------------------------------------------

const cueIdSchema = z.string().trim().min(1).max(512);
const storyMinutesSchema = z.number().int().min(0).catch(0);
const cueCountSchema = z.number().int().min(0).max(1_000_000).catch(0);

/**
 * Every optional field is modelled as REQUIRED-and-nullable at the parse layer
 * and mapped to an absent key afterwards — the `visualFeatureMemoryRowSchema`
 * precedent, so a missing key, a null and outright garbage all heal to the same
 * "not recorded" value.
 */
const visualCueRecordRowSchema = z.object({
  repeatKey: cueIdSchema,
  visibleFingerprint: z.string().max(256).catch(""),
  firstVisibleAtMinutes: storyMinutesSchema,
  lastVisibleAtMinutes: storyMinutesSchema,
  lastVisibleSequence: z.number().int().min(0).catch(0),
  lastMentionedAtMinutes: z.number().int().min(0).nullable().catch(null),
  mentionCount: cueCountSchema,
});

/** What the narrator knows about one repeat family's visibility and mention history. */
export interface VisualCueRecord {
  readonly repeatKey: string;
  /** Fingerprint over every visible feature in the family, at the last cut it was in view. */
  readonly visibleFingerprint: string;
  readonly firstVisibleAtMinutes: number;
  readonly lastVisibleAtMinutes: number;
  /** The cut counter at which it was last in view — the newly-visible comparison. */
  readonly lastVisibleSequence: number;
  readonly lastMentionedAtMinutes?: number;
  readonly mentionCount: number;
}

function toVisualCueRecord(row: z.infer<typeof visualCueRecordRowSchema>): VisualCueRecord {
  return {
    repeatKey: row.repeatKey,
    visibleFingerprint: row.visibleFingerprint,
    firstVisibleAtMinutes: row.firstVisibleAtMinutes,
    lastVisibleAtMinutes: row.lastVisibleAtMinutes,
    lastVisibleSequence: row.lastVisibleSequence,
    mentionCount: row.mentionCount,
    ...(row.lastMentionedAtMinutes === null ? {} : { lastMentionedAtMinutes: row.lastMentionedAtMinutes }),
  };
}

export const visualCueRecordSchema = visualCueRecordRowSchema.transform(toVisualCueRecord);

// ---------------------------------------------------------------------------
// The persisted container
// ---------------------------------------------------------------------------

/** One observer's narrator cue record for one subject, keyed by repeat key. */
export interface VisualCueState {
  /** How many cuts this observer has recorded. Rolls back with a retake. */
  readonly sequence: number;
  readonly cues: Readonly<Record<string, VisualCueRecord>>;
}

/** Nothing seen yet — the pre-seed value and the degraded default. */
export function emptyVisualCueState(): VisualCueState {
  return { sequence: 0, cues: {} };
}

function compareKeys(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * Deterministic eviction: coldest `lastVisibleSequence` first, ties by key, and
 * the survivors always returned in key order so a replay produces a byte-equal
 * blob. Applied in the schema transform AND on every write, exactly as
 * `capVisualMemoryFeatures` is — with the cut counter as the age policy, since
 * a cue record's whole job is to know how long ago something was in view.
 */
export function capVisualCueRecords(
  cues: Readonly<Record<string, VisualCueRecord>>,
): Readonly<Record<string, VisualCueRecord>> {
  const entries = Object.entries(cues);
  const kept =
    entries.length <= VISUAL_CUE_RECORDS_MAX
      ? entries
      : [...entries]
          .sort(
            (left, right) =>
              left[1].lastVisibleSequence - right[1].lastVisibleSequence || compareKeys(left[0], right[0]),
          )
          .slice(entries.length - VISUAL_CUE_RECORDS_MAX);
  return Object.fromEntries([...kept].sort((left, right) => compareKeys(left[0], right[0])));
}

function healVisualCueRecords(
  parsed: Readonly<Record<string, VisualCueRecord | null>>,
): Readonly<Record<string, VisualCueRecord>> {
  const rows: Record<string, VisualCueRecord> = {};
  for (const row of Object.values(parsed)) {
    // A row that could not name itself is unusable — drop it rather than
    // inventing a key, and re-key by the row's own value so the record's key
    // and its contents can never disagree.
    if (row === null) continue;
    rows[row.repeatKey] = row;
  }
  return capVisualCueRecords(rows);
}

export const visualCueStateSchema = z
  .object({
    sequence: z.number().int().min(0).catch(0),
    cues: z.record(z.string(), visualCueRecordSchema.nullable().catch(null)).catch({}),
  })
  .catch({ sequence: 0, cues: {} })
  .transform((parsed): VisualCueState => ({ sequence: parsed.sequence, cues: healVisualCueRecords(parsed.cues) }));

// ---------------------------------------------------------------------------
// Family fingerprints
// ---------------------------------------------------------------------------

/** One visible feature's contribution to its family's fingerprint. */
export interface VisualCueFamilyMember {
  readonly key: string;
  readonly truthFingerprint: string;
}

/**
 * The fingerprint of everything visible in one family right now.
 *
 * Sorted by feature key before hashing, so a snapshot that happens to order two
 * members differently still fingerprints the same — the change signal must
 * describe the family's TRUTH, never the order an adapter emitted it in.
 */
export function visualCueFamilyFingerprint(members: readonly VisualCueFamilyMember[]): string {
  const sorted = [...members].sort((left, right) => compareKeys(left.key, right.key));
  return visualStateFingerprint(sorted.map((member) => [member.key, member.truthFingerprint]));
}

// ---------------------------------------------------------------------------
// Visibility status
// ---------------------------------------------------------------------------

export const visualCueVisibilityStatuses = ["first_visible", "revealed", "changed", "steady"] as const;
export type VisualCueVisibilityStatus = (typeof visualCueVisibilityStatuses)[number];

/**
 * What this family's visibility means right now, against the state as of BEFORE
 * this cut.
 *
 * Precedence is deliberate: never-seen outranks a change, and a change outranks
 * a reappearance. A family that both changed AND came back into view is
 * reported as changed, because the changed fact is the more specific thing to
 * say about it.
 */
export function visualCueVisibilityStatus(input: {
  state: VisualCueState;
  repeatKey: string;
  familyFingerprint: string;
}): VisualCueVisibilityStatus {
  const record = input.state.cues[input.repeatKey];
  if (record === undefined) return "first_visible";
  if (record.visibleFingerprint !== input.familyFingerprint) return "changed";
  // The record was written by some earlier cut. If that cut was not the one
  // immediately before this, the family left view and has come back.
  return record.lastVisibleSequence < input.state.sequence ? "revealed" : "steady";
}

/** The novelty weight one visibility status is worth. */
export function visualCueNovelty(status: VisualCueVisibilityStatus): UnitInterval {
  switch (status) {
    case "first_visible":
      return VISUAL_CUE_NOVELTY_FIRST_VISIBLE;
    case "changed":
      return toUnitInterval(VISUAL_CUE_NOVELTY_CHANGED);
    case "revealed":
      return toUnitInterval(VISUAL_CUE_NOVELTY_REVEALED);
    case "steady":
      return toUnitInterval(VISUAL_CUE_NOVELTY_STEADY);
  }
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

/** One family that was in view at this cut. */
export interface VisualCueObservation {
  readonly repeatKey: string;
  readonly familyFingerprint: string;
}

/** The retake-safe record of a selected cue, captured with the cut. */
export interface VisualCueMentionCommit {
  readonly repeatKey: string;
  readonly atMinutes: number;
}

function wholeMinutes(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

/**
 * Record this cut's visible families and advance the cut counter.
 *
 * Called for EVERY narrator cut, whether or not anything was said — looking is
 * what makes the next cut's "newly visible" answer correct, and a cut that
 * spent no cue still moves the sequence. Mention state is untouched here; that
 * is `applyVisualCueMentions`, and only for cues that entered the committed
 * cut.
 *
 * A family absent from `observations` is NOT deleted: its record keeps its old
 * sequence, which is precisely how it later reads as `revealed`.
 */
export function observeVisualCues(
  state: VisualCueState,
  input: { atMinutes: number; observations: readonly VisualCueObservation[] },
): VisualCueState {
  const atMinutes = wholeMinutes(input.atMinutes);
  const sequence = state.sequence + 1;
  const cues: Record<string, VisualCueRecord> = { ...state.cues };
  for (const observation of input.observations) {
    if (observation.repeatKey.length === 0) continue;
    const previous = cues[observation.repeatKey];
    cues[observation.repeatKey] =
      previous === undefined
        ? {
            repeatKey: observation.repeatKey,
            visibleFingerprint: observation.familyFingerprint,
            firstVisibleAtMinutes: atMinutes,
            lastVisibleAtMinutes: atMinutes,
            lastVisibleSequence: sequence,
            mentionCount: 0,
          }
        : {
            ...previous,
            visibleFingerprint: observation.familyFingerprint,
            lastVisibleAtMinutes: atMinutes,
            lastVisibleSequence: sequence,
          };
  }
  return { sequence, cues: capVisualCueRecords(cues) };
}

/**
 * Spend the mention cooldown for cues that actually entered the cut.
 *
 * A commit for a family with no record is a no-op: the narrator cannot have
 * spent cue state it never had. Callers apply this to the state
 * `observeVisualCues` already returned, so a mentioned family is guaranteed to
 * have a row.
 */
export function applyVisualCueMentions(
  state: VisualCueState,
  commits: readonly VisualCueMentionCommit[],
): VisualCueState {
  if (commits.length === 0) return state;
  const cues: Record<string, VisualCueRecord> = { ...state.cues };
  for (const commit of commits) {
    const previous = cues[commit.repeatKey];
    if (previous === undefined) continue;
    cues[commit.repeatKey] = {
      ...previous,
      lastMentionedAtMinutes: wholeMinutes(commit.atMinutes),
      mentionCount: previous.mentionCount + 1,
    };
  }
  return { sequence: state.sequence, cues: capVisualCueRecords(cues) };
}
