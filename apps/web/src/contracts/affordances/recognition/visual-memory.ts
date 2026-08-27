import { z } from "zod";
import { appearanceDetailTierSchema, type AppearanceDetailTier, type AppearanceStability } from "../../appearance-features";
import {
  toUnitInterval,
  unitIntervalSchema,
  AFFORDANCE_UNIT_ZERO,
  type AffordanceStoryTime,
  type UnitInterval,
} from "../core";
import type { RecognizableFeatureKey } from "./candidates";
import {
  recognitionFeatureSalience,
  recognitionNoticeConfidence,
  recognitionStrengthAfterNotice,
  recognitionStrengthWithFloor,
} from "./salience";

/**
 * Observer visual memory — the structured, per-observer read model.
 *
 * General semantic RAG is fine for callbacks and hopeless for deterministic
 * repetition control, so recognition keeps its own compact projection: what
 * this observer has noticed, how well, how long ago, and when the narrator last
 * said it out loud.
 *
 * The laws this module enforces, all of them load-bearing:
 *
 * - **Observer isolation is structural.** One `VisualMemoryState` per (scope,
 *   observer) pair — the pair rides the CONTAINER, never the rows. Nothing here
 *   merges two observers, because there is no function that could.
 * - **Notices and mentions are different events.** `lastNoticedAt` advances
 *   whenever perception crosses the threshold; `lastMentionedAt` advances only
 *   when the selected cue enters the committed cut. Recognition can strengthen
 *   in total silence, which is the whole point.
 * - **A plain notice never rewrites a fingerprint.** A changed fingerprint is a
 *   change CANDIDATE; adopting it goes through `applyRecognitionFingerprintChanges`
 *   so "what the observer knew" can never be silently overwritten mid-read.
 * - **Absence is not disappearance.** Rows are never deleted or decayed because
 *   a candidate did not appear this turn. Occlusion, a closed coat, and a
 *   narrator who said nothing are all indistinguishable from here, and none of
 *   them mean the feature is gone.
 *
 * The row shape crosses a JSONB trust boundary once a lane persists it, so it
 * heals field by field exactly like `affordanceCueStateSchema`
 * (`core/ranking.ts`): a corrupt counter degrades to zero, a corrupt row is
 * dropped, and a corrupt blob degrades to "this observer has noticed nothing".
 */

/** Max rows one observer retains for one subject-scope. Overflow evicts the coldest. */
export const VISUAL_MEMORY_FEATURES_MAX = 96;

// ---------------------------------------------------------------------------
// Scope and observer identity
// ---------------------------------------------------------------------------

/**
 * Who is remembering. Legacy chat carries a player viewpoint; the successor
 * carries an actor. Both are lane-local ids this module never interprets.
 */
export const visualObserverRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("actor"), actorId: z.string().min(1) }),
  z.object({ kind: z.literal("player_viewpoint"), viewpointId: z.string().min(1) }),
]);

export type VisualObserverRef = z.infer<typeof visualObserverRefSchema>;

/**
 * Which continuity the memory belongs to. Chat memory follows the chat memory
 * group so "continue our history" retains recognition while a fresh/AU
 * conversation stays isolated; successor memory is branch-scoped so a fork or a
 * retake cannot leak later visual knowledge backward. A standalone-character
 * scope is a render of one character outside any conversation (library avatar,
 * portrait); no observer remembers anything there, but the union stays
 * member-for-member identical to `VisualStateScopeRef` — the keep-in-step
 * ruling recorded in `visual-state/scope.ts`, held by the identity conversions
 * in `visual-attention.ts`.
 */
export const visualMemoryScopeRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("chat"), memoryGroupId: z.string().min(1) }),
  z.object({ kind: z.literal("world_branch"), branchId: z.string().min(1) }),
  z.object({ kind: z.literal("standalone_character"), characterId: z.string().min(1) }),
]);

export type VisualMemoryScopeRef = z.infer<typeof visualMemoryScopeRefSchema>;

export function visualObserverKey(ref: VisualObserverRef): string {
  switch (ref.kind) {
    case "actor":
      return `actor:${ref.actorId}`;
    case "player_viewpoint":
      return `viewpoint:${ref.viewpointId}`;
  }
}

export function visualMemoryScopeKey(ref: VisualMemoryScopeRef): string {
  switch (ref.kind) {
    case "chat":
      return `chat:${ref.memoryGroupId}`;
    case "world_branch":
      return `branch:${ref.branchId}`;
    case "standalone_character":
      return `standalone_character:${ref.characterId}`;
  }
}

/** The (scope, observer) pair one `VisualMemoryState` belongs to. */
export interface VisualMemoryBinding {
  readonly scope: VisualMemoryScopeRef;
  readonly observer: VisualObserverRef;
}

/**
 * The storage key for one memory. Two observers in one scope, or one observer
 * across two scopes, produce different keys — which is the entire isolation
 * guarantee, expressed once, here.
 */
export function visualMemoryBindingKey(binding: VisualMemoryBinding): string {
  return `${visualMemoryScopeKey(binding.scope)}#${visualObserverKey(binding.observer)}`;
}

// ---------------------------------------------------------------------------
// The persisted row
// ---------------------------------------------------------------------------

const memoryIdSchema = z.string().trim().min(1).max(256);
const storyMinutesSchema = z.number().int().min(0).catch(0);
const memoryCountSchema = z.number().int().min(0).max(1_000_000).catch(0);

/**
 * Every optional field is modelled as REQUIRED-and-nullable at the parse layer
 * and mapped to an absent key afterwards. `.nullable().catch(null)` heals a
 * missing key, a null, and outright garbage to the same "not recorded" value,
 * which is both simpler to reason about and free of zod key-optionality
 * inference surprises.
 */
const visualFeatureMemoryRowSchema = z.object({
  featureKey: memoryIdSchema,
  subjectId: memoryIdSchema,
  truthFingerprint: z.string().max(256).catch(""),
  firstNoticedAt: storyMinutesSchema,
  lastNoticedAt: storyMinutesSchema,
  noticeCount: memoryCountSchema,
  strongestDetailTier: appearanceDetailTierSchema.catch(1),
  confidence: unitIntervalSchema.catch(AFFORDANCE_UNIT_ZERO),
  recognitionStrength: unitIntervalSchema.catch(AFFORDANCE_UNIT_ZERO),
  lastMentionedAt: z.number().int().min(0).nullable().catch(null),
  mentionCount: memoryCountSchema,
  firstObservationId: memoryIdSchema.nullable().catch(null),
  lastObservationId: memoryIdSchema.nullable().catch(null),
});

/**
 * What one observer knows about one feature.
 *
 * `firstObservationId` / `lastObservationId` are plain strings on purpose:
 * legacy chat passes message ids, the successor passes observation ids, and
 * this contract must not learn which lane it is serving.
 */
export interface VisualFeatureMemory {
  readonly featureKey: string;
  readonly subjectId: string;
  readonly truthFingerprint: string;
  readonly firstNoticedAt: AffordanceStoryTime;
  readonly lastNoticedAt: AffordanceStoryTime;
  readonly noticeCount: number;
  readonly strongestDetailTier: AppearanceDetailTier;
  readonly confidence: UnitInterval;
  readonly recognitionStrength: UnitInterval;
  readonly lastMentionedAt?: AffordanceStoryTime;
  readonly mentionCount: number;
  readonly firstObservationId?: string;
  readonly lastObservationId?: string;
}

function toVisualFeatureMemory(row: z.infer<typeof visualFeatureMemoryRowSchema>): VisualFeatureMemory {
  return {
    featureKey: row.featureKey,
    subjectId: row.subjectId,
    truthFingerprint: row.truthFingerprint,
    firstNoticedAt: row.firstNoticedAt,
    lastNoticedAt: row.lastNoticedAt,
    noticeCount: row.noticeCount,
    strongestDetailTier: row.strongestDetailTier,
    confidence: row.confidence,
    recognitionStrength: row.recognitionStrength,
    mentionCount: row.mentionCount,
    ...(row.lastMentionedAt === null ? {} : { lastMentionedAt: row.lastMentionedAt }),
    ...(row.firstObservationId === null ? {} : { firstObservationId: row.firstObservationId }),
    ...(row.lastObservationId === null ? {} : { lastObservationId: row.lastObservationId }),
  };
}

export const visualFeatureMemorySchema = visualFeatureMemoryRowSchema.transform(toVisualFeatureMemory);

// ---------------------------------------------------------------------------
// The persisted container
// ---------------------------------------------------------------------------

/** One observer's whole visual memory, keyed by feature key. */
export interface VisualMemoryState {
  readonly features: Readonly<Record<string, VisualFeatureMemory>>;
}

/** Nothing noticed yet — the pre-seed value and the degraded default. */
export function emptyVisualMemoryState(): VisualMemoryState {
  return { features: {} };
}

/**
 * Deterministic eviction: coldest `lastNoticedAt` first, ties by key, and the
 * survivors are always returned in key order so a replay produces a byte-equal
 * blob. Applied in the schema transform AND on every write, so no path can grow
 * an unbounded record (the `capRecord` precedent in `core/ranking.ts`, with an
 * age policy instead of insertion order — a recognition memory that dropped its
 * newest rows would be worse than useless).
 */
export function capVisualMemoryFeatures(
  features: Readonly<Record<string, VisualFeatureMemory>>,
): Readonly<Record<string, VisualFeatureMemory>> {
  const entries = Object.entries(features);
  const kept =
    entries.length <= VISUAL_MEMORY_FEATURES_MAX
      ? entries
      : [...entries]
          .sort((left, right) => left[1].lastNoticedAt - right[1].lastNoticedAt || compareKeys(left[0], right[0]))
          .slice(entries.length - VISUAL_MEMORY_FEATURES_MAX);
  return Object.fromEntries([...kept].sort((left, right) => compareKeys(left[0], right[0])));
}

function compareKeys(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function healVisualMemoryFeatures(
  parsed: Readonly<Record<string, VisualFeatureMemory | null>>,
): Readonly<Record<string, VisualFeatureMemory>> {
  const rows: Record<string, VisualFeatureMemory> = {};
  for (const row of Object.values(parsed)) {
    // A row that could not name itself is unusable — drop it rather than
    // inventing a key, and re-key by the row's own value so the record's key
    // and its contents can never disagree.
    if (row === null) continue;
    rows[row.featureKey] = row;
  }
  return capVisualMemoryFeatures(rows);
}

export const visualMemoryStateSchema = z
  .object({
    features: z.record(z.string(), visualFeatureMemorySchema.nullable().catch(null)).catch({}),
  })
  .catch({ features: {} })
  .transform((parsed): VisualMemoryState => ({ features: healVisualMemoryFeatures(parsed.features) }));

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

/**
 * What a notice must know about the noticed feature — exactly the fields the
 * row math reads, and nothing more.
 *
 * This is the "extend eligible sources" seam the visual-state plan relies on:
 * `RecognizableFeatureCandidate` satisfies it structurally (the original and
 * still-primary source), and the slice-5 visual-attention integration is the
 * second — a recognition-eligible visual-state feature noticed under the same
 * law. Widening the INPUT here is what lets one memory serve both reads
 * without a second appearance-memory system.
 */
export interface RecognitionNoticeSource {
  readonly key: RecognizableFeatureKey;
  readonly subjectId: string;
  readonly truthFingerprint: string;
  readonly stability: AppearanceStability;
  readonly visibility: UnitInterval;
  readonly uniqueness: UnitInterval;
  readonly importance: UnitInterval;
}

/** One feature this observer perceived above threshold, on one cut. */
export interface RecognitionNotice {
  readonly candidate: RecognitionNoticeSource;
  readonly detailTier: AppearanceDetailTier;
  readonly atMinutes: AffordanceStoryTime;
  /** Lane-neutral provenance: a chat message id or a successor observation id. */
  readonly observationId?: string;
}

/** The ONLY input that may replace a remembered fingerprint. */
export interface RecognitionFingerprintChange {
  readonly featureKey: RecognizableFeatureKey;
  readonly truthFingerprint: string;
  readonly atMinutes: AffordanceStoryTime;
}

/** A committed mention, as captured with the cut. */
export interface RecognitionMentionRecord {
  readonly featureKey: RecognizableFeatureKey;
  readonly atMinutes: AffordanceStoryTime;
}

function wholeMinutes(value: number): AffordanceStoryTime {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function strongerTier(
  existing: AppearanceDetailTier | undefined,
  next: AppearanceDetailTier,
): AppearanceDetailTier {
  if (existing === undefined) return next;
  return existing >= next ? existing : next;
}

function noticedRow(existing: VisualFeatureMemory | undefined, notice: RecognitionNotice): VisualFeatureMemory {
  const { candidate } = notice;
  const at = wholeMinutes(notice.atMinutes);
  const salience = recognitionFeatureSalience(candidate);
  const noticeCount = (existing?.noticeCount ?? 0) + 1;
  const recognitionStrength = recognitionStrengthWithFloor({
    strength: recognitionStrengthAfterNotice({
      previous: existing?.recognitionStrength ?? AFFORDANCE_UNIT_ZERO,
      salience,
      detailTier: notice.detailTier,
    }),
    stability: candidate.stability,
    noticeCount,
  });
  const confidence = toUnitInterval(
    Math.max(existing?.confidence ?? AFFORDANCE_UNIT_ZERO, recognitionNoticeConfidence({ salience, detailTier: notice.detailTier })),
  );
  const firstObservationId = existing?.firstObservationId ?? notice.observationId;
  const lastObservationId = notice.observationId ?? existing?.lastObservationId;
  return {
    featureKey: candidate.key,
    subjectId: candidate.subjectId,
    // NOT `candidate.truthFingerprint`: a plain notice may not overwrite what
    // the observer knew. Only `applyRecognitionFingerprintChanges` may.
    truthFingerprint: existing?.truthFingerprint ?? candidate.truthFingerprint,
    firstNoticedAt: existing?.firstNoticedAt ?? at,
    lastNoticedAt: Math.max(existing?.lastNoticedAt ?? at, at),
    noticeCount,
    strongestDetailTier: strongerTier(existing?.strongestDetailTier, notice.detailTier),
    confidence,
    recognitionStrength,
    mentionCount: existing?.mentionCount ?? 0,
    ...(existing?.lastMentionedAt === undefined ? {} : { lastMentionedAt: existing.lastMentionedAt }),
    ...(firstObservationId === undefined ? {} : { firstObservationId }),
    ...(lastObservationId === undefined ? {} : { lastObservationId }),
  };
}

/**
 * Record what this observer noticed on one cut.
 *
 * Only the noticed keys are touched. A feature that was true but covered, or
 * true but unremarkable, simply is not in `notices` — and its row survives
 * untouched, because occlusion is not disappearance.
 */
export function applyRecognitionNotices(
  state: VisualMemoryState,
  notices: readonly RecognitionNotice[],
): VisualMemoryState {
  if (notices.length === 0) return state;
  const features: Record<string, VisualFeatureMemory> = { ...state.features };
  for (const notice of notices) {
    features[notice.candidate.key] = noticedRow(features[notice.candidate.key], notice);
  }
  return { features: capVisualMemoryFeatures(features) };
}

/**
 * Adopt perceived changes — the one path that may replace a fingerprint.
 *
 * The observer saw the ring finger is gone; memory follows what was actually
 * perceived. Narration is a separate decision made by the mention policy, and
 * an unknown feature is NOT changed into existence here: a change to something
 * never noticed is a first notice, and belongs to `applyRecognitionNotices`.
 */
export function applyRecognitionFingerprintChanges(
  state: VisualMemoryState,
  changes: readonly RecognitionFingerprintChange[],
): VisualMemoryState {
  if (changes.length === 0) return state;
  const features: Record<string, VisualFeatureMemory> = { ...state.features };
  let touched = false;
  for (const change of changes) {
    const existing = features[change.featureKey];
    if (existing === undefined) continue;
    features[change.featureKey] = {
      ...existing,
      truthFingerprint: change.truthFingerprint,
      lastNoticedAt: Math.max(existing.lastNoticedAt, wholeMinutes(change.atMinutes)),
    };
    touched = true;
  }
  return touched ? { features: capVisualMemoryFeatures(features) } : state;
}

/**
 * Record that the selected cue entered the committed cut.
 *
 * Separate from notices by ruling: the cut is the retake-safe record of WHAT
 * was said, this projection is the cooldown record of WHEN. A mention of a
 * feature with no memory row is a no-op — the narrator cannot have committed a
 * cue for something this observer never noticed.
 */
export function applyRecognitionMention(
  state: VisualMemoryState,
  mention: RecognitionMentionRecord,
): VisualMemoryState {
  const existing = state.features[mention.featureKey];
  if (existing === undefined) return state;
  return {
    features: {
      ...state.features,
      [mention.featureKey]: {
        ...existing,
        lastMentionedAt: wholeMinutes(mention.atMinutes),
        mentionCount: existing.mentionCount + 1,
      },
    },
  };
}
