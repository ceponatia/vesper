import type { AppearanceDetailTier, AppearanceStability } from "../../appearance-features";
import { diag, type DiagnosticSink } from "../../diagnostics";
import {
  affordanceEvidence,
  toUnitInterval,
  AFFORDANCE_UNIT_ONE,
  AFFORDANCE_UNIT_ZERO,
  type AffordanceEvidence,
  type UnitInterval,
} from "../core";
import {
  resolveVisualStateVisibility,
  visualCueFamilyFingerprint,
  visualCueNovelty,
  visualCueVisibilityStatus,
  visualStateKindRegistry,
  visualStateLocusKey,
  VISUAL_CUE_NOVELTY_FIRST_VISIBLE,
  VISUAL_STATE_KIND_UNKNOWN,
  VISUAL_STATE_VISIBILITY_HINTED,
  type VisualCueObservation,
  type VisualCueState,
  type VisualCueVisibilityStatus,
  type VisualStateFeature,
  type VisualStateLayer,
  type VisualStateLocusRef,
  type VisualStateScopeRef,
  type VisualStateSnapshot,
  type VisualStateStability,
  type VisualStateSuppression,
  type VisualStateVisibilityRead,
  type VisualVisibilityContext,
} from "../../visual-state";
import type { RECOGNITION_VISIBILITY_HINTED } from "./candidates";
import {
  recognitionFeatureSalience,
  recognitionFreshnessBucket,
  recognitionMentionPriority,
  recognitionNovelty,
  recognitionRepetitionCooldown,
  RECOGNITION_ACTION_RELEVANCE,
  RECOGNITION_CHANGE_SIGNIFICANCE,
  RECOGNITION_NOVELTY_UNSEEN,
} from "./salience";
import type { VisualMemoryScopeRef, VisualMemoryState } from "./visual-memory";

/**
 * Visual attention — the visual-state projection scored under the shipped
 * recognition laws.
 *
 * This module is the place the two families MEET, and the meeting direction is
 * the reserved one: recognition consumes the projection, never
 * the reverse. `visual-state` stays free of any `affordances/recognition`
 * import, so the restated scope union and hinted-exposure factor over there are
 * held to this module's compile-time identity checks below.
 *
 * The scoring shape extends the shipped law without forking it:
 *
 * ```text
 * featureSalience   = visibility × (0.55 × uniqueness + 0.45 × importance)
 * selectionPriority = featureSalience
 *                   × max(novelty, changeSignificance, actionRelevance, consumerRelevance)
 *                   × repetitionCooldown
 * ```
 *
 * Every factor function is the recognition layer's own — salience, novelty,
 * freshness, cooldown, and the priority product — so a calibration change there
 * moves this read with it. What is NEW here is exactly the plan's three
 * additions: change significance from the change stamps slices 2–3 committed,
 * action relevance over visual-state loci, and a per-consumer relevance table.
 * Stored uniqueness and importance are read, never rewritten.
 *
 * Observer isolation is structural: only a `narrator` consumer's build may read
 * observer memory (camera and inspector builds ignore a passed-in state
 * entirely), and nothing in this module writes memory at all — notices and
 * mentions are `visual-selection.ts`'s narrator-only output.
 */

// ---------------------------------------------------------------------------
// Meeting point 1 — the scope unions are one shape
// ---------------------------------------------------------------------------

/**
 * `VisualStateScopeRef` is declared beside the snapshot rather than imported
 * from this family, to keep the import direction one-way (the ruling recorded
 * in `visual-state/scope.ts`). These two conversions are the promised meeting:
 * each `return` compiles only while the unions stay structurally identical, so
 * a divergence is a compile error HERE rather than a silent scope mismatch in a
 * lane. They are real conversions, not decoration — the narrator selection
 * guards its memory read with the first one.
 */
export function visualMemoryScopeOf(scope: VisualStateScopeRef): VisualMemoryScopeRef {
  return scope;
}

/** The reverse direction of the same identity. */
export function visualStateScopeOf(scope: VisualMemoryScopeRef): VisualStateScopeRef {
  return scope;
}

// ---------------------------------------------------------------------------
// Meeting point 2 — the hinted exposure factor is one number
// ---------------------------------------------------------------------------

/**
 * Slice 4 restated `RECOGNITION_VISIBILITY_HINTED` as
 * `VISUAL_STATE_VISIBILITY_HINTED` instead of importing it, for the same
 * import-direction reason. The intersection type below is `never` the moment
 * the two literals disagree, so recalibrating one without the other is a
 * compile error at this meeting point, exactly as both restatements promised.
 */
export const VISUAL_ATTENTION_HINTED_VISIBILITY: typeof RECOGNITION_VISIBILITY_HINTED &
  typeof VISUAL_STATE_VISIBILITY_HINTED = VISUAL_STATE_VISIBILITY_HINTED;

// ---------------------------------------------------------------------------
// Meeting point 3 — "never seen before" is one number in both records
// ---------------------------------------------------------------------------

/**
 * The two narrator-side records answer the same question for DISJOINT feature
 * sets — memory for what an observer can recognize, the cue state for
 * everything else — so a first sighting must weigh the same in both, or a
 * rolled sleeve and a scar would rank differently merely for being new.
 *
 * Unlike the two meeting points above, this one cannot be a type-level
 * identity: both constants are `UnitInterval`, whose brand erases the literal,
 * so an intersection would compile whatever the values were. A runtime
 * equality asserted at module load is the honest form — it costs one
 * comparison, it is covered by every test that imports this module, and it
 * fails loudly at boot rather than silently mis-ranking a cue.
 */
export const VISUAL_ATTENTION_FIRST_VISIBLE_NOVELTY: UnitInterval = VISUAL_CUE_NOVELTY_FIRST_VISIBLE;
if (VISUAL_ATTENTION_FIRST_VISIBLE_NOVELTY !== RECOGNITION_NOVELTY_UNSEEN) {
  throw new Error(
    "visual cue and recognition novelty disagree about an unseen feature: " +
      `${String(VISUAL_CUE_NOVELTY_FIRST_VISIBLE)} vs ${String(RECOGNITION_NOVELTY_UNSEEN)}`,
  );
}

// ---------------------------------------------------------------------------
// Context — slice 4's visibility context, extended, never reshaped
// ---------------------------------------------------------------------------

export const visualAttentionConsumers = ["narrator", "image", "inspector"] as const;
export type VisualAttentionConsumer = (typeof visualAttentionConsumers)[number];

/**
 * The full attention context. It EXTENDS
 * `VisualVisibilityContext` — every visibility field keeps its original meaning
 * — and adds only what attention needs:
 *
 * - `focusLoci` — loci under deliberate inspection. Lowers the notice
 *   threshold, exactly as recognition's inspection focus does. It does NOT
 *   raise the detail tier above what the viewing conditions resolve: an
 *   inspected feature in the dark is still in the dark, which is stricter than
 *   the chat lane's conditionless read and recorded as a slice-5 decision.
 * - `actionLoci` — loci the current action exposes, touches, or depends on.
 * - `importanceBoosts` — signed projection-time importance adjustment per
 *   feature key; clamped into the unit range, never written back to truth.
 * - `consumer` — who is asking. Consumer relevance, memory access, and
 *   repetition cooldown all key off it.
 *
 * Both locus sets hold `visualStateLocusKey` strings; for a body locus the
 * bare body-location id is also honored, matching the recognition layer's
 * `actionRelevantLocationIds` vocabulary so a lane can pass one set to both.
 */
export interface VisualAttentionContext extends VisualVisibilityContext {
  readonly focusLoci?: ReadonlySet<string>;
  readonly actionLoci?: ReadonlySet<string>;
  readonly importanceBoosts?: Readonly<Record<string, number>>;
  readonly consumer: VisualAttentionConsumer;
}

/** An importance boost that was not a finite number; it is ignored. */
export const VISUAL_ATTENTION_BOOST_INVALID = "visual_state.attention.boost_invalid";

/** Membership test for `focusLoci` / `actionLoci`, in both accepted vocabularies. */
export function visualLocusListed(
  loci: ReadonlySet<string> | undefined,
  locus: VisualStateLocusRef,
): boolean {
  if (loci === undefined || loci.size === 0) return false;
  if (loci.has(visualStateLocusKey(locus))) return true;
  return locus.kind === "body" && loci.has(locus.locus.bodyLocationId);
}

// ---------------------------------------------------------------------------
// Change significance — the stamps slices 2–3 committed, banded
// ---------------------------------------------------------------------------

/** Within this many story minutes of its stamp, a change is FRESH. */
export const VISUAL_CHANGE_FRESH_MINUTES = 60;
/** Within one story day, a change is still RECENT. Past it, the stamp says nothing. */
export const VISUAL_CHANGE_RECENT_MINUTES = 1_440;
/** Relevance of a fresh change — just under the memory-contradiction weight. */
export const VISUAL_CHANGE_SIGNIFICANCE_FRESH = 9_000;
/** Relevance of a same-day change. A fixture-tested calibration default. */
export const VISUAL_CHANGE_SIGNIFICANCE_RECENT = 5_000;

/**
 * How much a feature's own change stamp is worth right now.
 *
 * Bands, not a curve — the recognition freshness precedent. The stamp is the
 * one change signal that needs no observer: slice 2's presentation reducer and
 * slice 3's per-fact stamps write `changedAtMinutes` only when the VALUE moved,
 * which is what makes this safe to trust camera-side where no memory exists.
 * No stamp means no claim (`0`), never "probably unchanged recently".
 */
export function visualChangeSignificance(input: {
  changedAtMinutes?: number;
  atMinutes: number;
}): UnitInterval {
  if (input.changedAtMinutes === undefined) return AFFORDANCE_UNIT_ZERO;
  if (!Number.isFinite(input.changedAtMinutes) || !Number.isFinite(input.atMinutes)) {
    return AFFORDANCE_UNIT_ZERO;
  }
  const elapsed = Math.max(0, Math.trunc(input.atMinutes) - Math.trunc(input.changedAtMinutes));
  if (elapsed <= VISUAL_CHANGE_FRESH_MINUTES) return toUnitInterval(VISUAL_CHANGE_SIGNIFICANCE_FRESH);
  if (elapsed <= VISUAL_CHANGE_RECENT_MINUTES) return toUnitInterval(VISUAL_CHANGE_SIGNIFICANCE_RECENT);
  return AFFORDANCE_UNIT_ZERO;
}

// ---------------------------------------------------------------------------
// Consumer relevance
// ---------------------------------------------------------------------------

/**
 * How relevant a layer is to a consumer, as a REASON weight in the priority
 * product. Fixture-tested calibration defaults, not product law; the shape that
 * may not move is the narrator row:
 *
 * - **The narrator's row is all zero.** A narrator speaks because something is
 *   new, changed, or in play — never merely because it is a narrator. This is
 *   the failed ambient-cue trial's lesson made structural: with zero consumer
 *   relevance, the four-way max degenerates to the shipped three-reason law and
 *   familiar steady state stays quiet.
 * - **The image rows are positive.** A render has to draw the whole figure
 *   whether or not anything changed, so steady optional detail still ranks —
 *   by salience, damped per layer — with current state highest (continuity is
 *   this plan's point) and identity lowest (its load-bearing half rides the
 *   mandatory lane, not this table).
 * - **The inspector's row is one.** The staircase shows everything.
 */
const CONSUMER_LAYER_RELEVANCE: Readonly<
  Record<VisualAttentionConsumer, Readonly<Record<VisualStateLayer, UnitInterval>>>
> = {
  narrator: {
    identity: AFFORDANCE_UNIT_ZERO,
    presentation: AFFORDANCE_UNIT_ZERO,
    current: AFFORDANCE_UNIT_ZERO,
    body_language: AFFORDANCE_UNIT_ZERO,
  },
  image: {
    identity: toUnitInterval(3_000),
    presentation: toUnitInterval(6_000),
    current: toUnitInterval(7_000),
    body_language: toUnitInterval(6_500),
  },
  inspector: {
    identity: AFFORDANCE_UNIT_ONE,
    presentation: AFFORDANCE_UNIT_ONE,
    current: AFFORDANCE_UNIT_ONE,
    body_language: AFFORDANCE_UNIT_ONE,
  },
};

export function visualConsumerRelevance(
  consumer: VisualAttentionConsumer,
  layer: VisualStateLayer,
): UnitInterval {
  return CONSUMER_LAYER_RELEVANCE[consumer][layer];
}

// ---------------------------------------------------------------------------
// Priority — the shipped law, with the fourth reason folded in
// ---------------------------------------------------------------------------

/**
 * `salience × max(novelty, changeSignificance, actionRelevance,
 * consumerRelevance) × repetitionCooldown`.
 *
 * Delegates to `recognitionMentionPriority` rather than restating the product:
 * `max` is associative, so folding the fourth reason into one argument of the
 * shipped three-way max computes exactly the four-way max the spec writes. The
 * law — max and not a sum, cooldown as the one silencer — stays owned in one
 * place, and a recalibration there moves this score with it.
 */
export function visualSelectionPriority(input: {
  salience: UnitInterval;
  novelty: UnitInterval;
  changeSignificance: UnitInterval;
  actionRelevance: UnitInterval;
  consumerRelevance: UnitInterval;
  repetitionCooldown: UnitInterval;
}): UnitInterval {
  return recognitionMentionPriority({
    salience: input.salience,
    novelty: input.novelty,
    changeSignificance: input.changeSignificance,
    actionRelevance: toUnitInterval(Math.max(input.actionRelevance, input.consumerRelevance)),
    repetitionCooldown: input.repetitionCooldown,
  });
}

// ---------------------------------------------------------------------------
// Stability — the recognition-floor gate, met exactly
// ---------------------------------------------------------------------------

/**
 * A visual-state stability as the memory law's vocabulary, or `null` when it
 * has no place there.
 *
 * `instantaneous` maps to nothing ON PURPOSE: the recognition floor gates on
 * stability (`recognitionStrengthWithFloor` — inherent and persistent only),
 * and a posture true for one committed cut must never even reach that law.
 * `defineVisualStateKind` already refuses an instantaneous recognition-eligible
 * kind; this mapping is the same rule enforced against a hand-built record
 * whose stability disagrees with its kind. Unknown fails closed.
 */
export function visualRecognitionStability(
  stability: VisualStateStability,
): AppearanceStability | null {
  switch (stability) {
    case "inherent":
      return "inherent";
    case "persistent":
      return "persistent";
    case "presentation":
      return "presentation";
    case "transient":
      return "transient";
    case "instantaneous":
      return null;
  }
}

// ---------------------------------------------------------------------------
// The repeat key
// ---------------------------------------------------------------------------

/**
 * The anti-repeat family key for one feature at one locus, in the recognition
 * layer's own format. For a body locus this is byte-identical to
 * `recognitionRepeatKey` — `visualStateLocusKey` renders a body locus as
 * exactly `bodyLocusKey` — so the repeat families live conversations already
 * calibrated keep matching when narration moves onto this read. Non-body loci
 * extend the same shape rather than opening a second namespace.
 */
export function visualAttentionRepeatKey(repeatFamily: string, locus: VisualStateLocusRef): string {
  return `recognition.${repeatFamily}.${visualStateLocusKey(locus)}`;
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

/**
 * One visible feature, scored.
 * `repeatKey` extends the scored fields on the
 * `RecognizableFeatureCandidate` precedent: it is derived from the feature's
 * priors and locus, and every consumer of a candidate needs it.
 */
export interface VisualAttentionCandidate {
  readonly feature: VisualStateFeature;
  readonly visibility: UnitInterval;
  readonly uniqueness: UnitInterval;
  readonly importance: UnitInterval;
  readonly detailTier: AppearanceDetailTier;
  readonly novelty: UnitInterval;
  readonly changeSignificance: UnitInterval;
  readonly actionRelevance: UnitInterval;
  readonly consumerRelevance: UnitInterval;
  readonly repetitionCooldown: UnitInterval;
  readonly priority: UnitInterval;
  readonly repeatKey: string;
  /**
   * Which record answered novelty and cooldown for this candidate. `memory` is
   * observer visual memory; `cue` is the narrator cue state, which covers
   * exactly the features memory refuses; `none` is a camera or inspector read,
   * which consults neither. The two records are disjoint by construction, so
   * this is a fact about the feature rather than a preference.
   */
  readonly noveltySource: "memory" | "cue" | "none";
  /** How the cue state read this family's visibility, when `noveltySource` is `cue`. */
  readonly cueStatus?: VisualCueVisibilityStatus;
  readonly evidence: readonly AffordanceEvidence[];
}

export interface VisualAttentionBuildInput {
  readonly snapshot: VisualStateSnapshot;
  readonly context: VisualAttentionContext;
  /**
   * Observer memory, consulted by a `narrator` consumer ONLY. A camera or
   * inspector build ignores a passed-in state entirely — novelty reads zero and
   * cooldown reads one — so observer familiarity can never hide an otherwise
   * useful image fact and an inspector read never depends on who has looked.
   */
  readonly memory?: VisualMemoryState;
  /**
   * The narrator's cue state, as of BEFORE this cut. Consulted by a `narrator`
   * consumer ONLY, on the same isolation rule as memory: a render must not be
   * dimmed by what narration said an hour ago, and an inspector read must not
   * depend on it either.
   *
   * Absent means the lane has not wired cue state yet, and every cue-backed
   * feature reads as first-visible with a full cooldown — the pre-slice-7
   * behavior, unchanged.
   */
  readonly cues?: VisualCueState;
  readonly sink?: DiagnosticSink;
  readonly path?: string;
}

export interface VisualAttentionBuild {
  /** Scored candidates, in the snapshot's own order. */
  readonly candidates: readonly VisualAttentionCandidate[];
  /** Everything the viewpoint or the registry could not resolve, and why. */
  readonly suppressions: readonly VisualStateSuppression[];
  /**
   * Every cue-backed family this viewpoint could resolve at this cut, with its
   * combined fingerprint — what `observeVisualCues` records so the NEXT cut can
   * tell steady state from a newly revealed fact. Empty for a camera or
   * inspector build, and for a narrator build with no cue state wired.
   */
  readonly cueObservations: readonly VisualCueObservation[];
}

/** A finite whole story minute; anything else degrades to zero. */
function wholeMinutes(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

/**
 * Whether this kind's facts may reach this consumer at all. The filter is
 * silent — a designed absence is context, not degradation, and the inspector
 * (which sees every kind) is where the difference shows.
 */
function kindEligibleFor(
  eligibility: { narratorEligible: boolean; imageEligible: boolean },
  consumer: VisualAttentionConsumer,
): boolean {
  switch (consumer) {
    case "narrator":
      return eligibility.narratorEligible;
    case "image":
      return eligibility.imageEligible;
    case "inspector":
      return true;
  }
}

/**
 * Whether observer memory can hold this feature at all: a recognition-eligible
 * kind whose stability maps into the floor law's vocabulary.
 *
 * This ONE predicate decides which of the two narrator records answers for a
 * feature, so the records stay disjoint: true ⇒ visual memory, false ⇒ the cue
 * state. Splitting the decision across the two call sites is how they would
 * drift into double-counting a mention or double-cooling a cue.
 */
function isMemoryEligible(
  kind: { recognitionEligible: boolean },
  feature: VisualStateFeature,
): boolean {
  return kind.recognitionEligible && visualRecognitionStability(feature.stability) !== null;
}

/**
 * The repeat key one feature's family answers under. Extracted because the cue
 * pre-pass and the scoring loop must derive it identically — a mismatch would
 * fingerprint one family and score another.
 */
function repeatKeyOf(
  feature: VisualStateFeature,
  kind: { repeatFamily: string },
): string {
  return visualAttentionRepeatKey(feature.priors.repeatFamily ?? kind.repeatFamily, feature.locus);
}

/**
 * Score every feature one viewpoint can resolve.
 *
 * The visibility half is slice 4's `resolveVisualStateVisibility`, verbatim —
 * hidden, distant, occluded, gated and unknown features arrive here already
 * suppressed and can never become candidates. On top of that this build adds
 * only ranking inputs: it never deletes a snapshot feature, never writes
 * memory, and never decides what a consumer finally uses — selection and
 * budgets live in `visual-selection.ts`.
 *
 * Determinism is structural: features walk in snapshot order, every factor is
 * fixed-point, and memory is read through plain key lookups.
 */
export function buildVisualAttentionCandidates(input: VisualAttentionBuildInput): VisualAttentionBuild {
  const path = input.path ?? "visual_state.attention";
  const { snapshot, context } = input;
  const consumer = context.consumer;
  // Observer isolation, structurally: only the narrator's read may see either
  // narrator-side record.
  const memory = consumer === "narrator" ? input.memory : undefined;
  const cues = consumer === "narrator" ? input.cues : undefined;
  const atMinutes = wholeMinutes(snapshot.atMinutes);

  const visibilityBuild = resolveVisualStateVisibility({
    snapshot,
    context,
    ...(input.sink === undefined ? {} : { sink: input.sink }),
  });
  const readsByKey = new Map<string, VisualStateVisibilityRead>();
  for (const read of visibilityBuild.visible) readsByKey.set(read.key, read);

  // Cue pre-pass: a family's fingerprint is the fingerprint of ALL its visible
  // members, so it cannot be computed inside the per-feature loop that consumes
  // it. Runs only for a narrator build with cue state wired.
  const cueFingerprints = cues === undefined ? new Map<string, string>() : cueFamilyFingerprints(snapshot, readsByKey);
  const cueObservations: VisualCueObservation[] = [...cueFingerprints.entries()]
    .map(([repeatKey, familyFingerprint]) => ({ repeatKey, familyFingerprint }))
    .sort((left, right) => (left.repeatKey < right.repeatKey ? -1 : left.repeatKey > right.repeatKey ? 1 : 0));

  const suppressions: VisualStateSuppression[] = [...visibilityBuild.suppressions];
  const candidates: VisualAttentionCandidate[] = [];
  const consumerEvidence = affordanceEvidence("adapter", "visual_state.attention", consumer);

  for (const feature of snapshot.features) {
    const read = readsByKey.get(feature.key);
    if (read === undefined) continue; // already suppressed by the visibility read

    const kind = visualStateKindRegistry.byId(feature.kindId);
    if (kind === undefined) {
      // Every adapter validates kinds, so this is a hand-built record; the
      // registry cannot say who may use it, which fails closed.
      suppressions.push({ key: feature.key, code: VISUAL_STATE_KIND_UNKNOWN, detail: feature.kindId });
      input.sink?.push(
        diag("warn", VISUAL_STATE_KIND_UNKNOWN, `No registered kind carries ${feature.kindId}`, {
          path,
          context: { key: feature.key, kindId: feature.kindId },
        }),
      );
      continue;
    }
    if (!kindEligibleFor(kind, consumer)) continue;

    const rawBoost = context.importanceBoosts?.[feature.key] ?? 0;
    const boost = Number.isFinite(rawBoost) ? Math.trunc(rawBoost) : 0;
    if (!Number.isFinite(rawBoost)) {
      input.sink?.push(
        diag("warn", VISUAL_ATTENTION_BOOST_INVALID, "Importance boost was not a finite number", {
          path,
          context: { key: feature.key },
        }),
      );
    }

    const uniqueness = feature.priors.baseUniqueness;
    const importance = toUnitInterval(feature.priors.baseImportance + boost);
    const visibility = read.visibility;

    // Memory-backed dimensions exist only for the narrator, and only for a
    // feature the memory law can hold: a recognition-eligible kind whose
    // stability maps into the floor law's vocabulary.
    const memoryEligible = isMemoryEligible(kind, feature);
    const row = memoryEligible ? memory?.features[feature.key] : undefined;
    const fingerprintChanged = row !== undefined && row.truthFingerprint !== feature.truthFingerprint;
    const repeatKey = repeatKeyOf(feature, kind);

    // The cue state answers for exactly what memory refuses. A family with no
    // fingerprint this cut is one the pre-pass did not resolve, which cannot
    // happen for a feature that reached here — but reading it defensively keeps
    // the two derivations from silently disagreeing.
    const cueFamilyFingerprint = memoryEligible ? undefined : cueFingerprints.get(repeatKey);
    const cueStatus: VisualCueVisibilityStatus | undefined =
      cues === undefined || cueFamilyFingerprint === undefined
        ? undefined
        : visualCueVisibilityStatus({ state: cues, repeatKey, familyFingerprint: cueFamilyFingerprint });
    const cueRow = cues === undefined ? undefined : cues.cues[repeatKey];

    const noveltySource: "memory" | "cue" | "none" =
      memory !== undefined && memoryEligible ? "memory" : cueStatus !== undefined ? "cue" : "none";
    const novelty =
      noveltySource === "memory"
        ? recognitionNovelty({
            hasMemory: row !== undefined,
            fingerprintChanged,
            bucket: row === undefined ? "recent" : recognitionFreshnessBucket(row.lastNoticedAt, atMinutes),
          })
        : cueStatus !== undefined
          ? visualCueNovelty(cueStatus)
          : AFFORDANCE_UNIT_ZERO;

    const stampSignificance = visualChangeSignificance({
      ...(feature.changedAtMinutes === undefined ? {} : { changedAtMinutes: feature.changedAtMinutes }),
      atMinutes,
    });
    // A stamp says when the WORLD changed. The cue state says whether THIS
    // observer has already had the family in view, in exactly this state, since
    // then — and where the two disagree the observer-relative answer wins.
    //
    // Without this, a posture settled forty story minutes before the scene
    // opens reads as a fresh change on every cut for a whole story day: the
    // stamp stays inside the freshness band, the cue reason tests it before the
    // cue status, and the narrator is handed "changed from what it was" about
    // something it described last turn. That is the repetition this lane exists
    // to prevent, arriving through the one door the cue state does not guard.
    const steadyInView = cueStatus === "steady";
    const changeSignificance = fingerprintChanged
      ? toUnitInterval(Math.max(stampSignificance, RECOGNITION_CHANGE_SIGNIFICANCE))
      : steadyInView
        ? AFFORDANCE_UNIT_ZERO
        : stampSignificance;

    const actionRelevance = visualLocusListed(context.actionLoci, feature.locus)
      ? RECOGNITION_ACTION_RELEVANCE
      : AFFORDANCE_UNIT_ZERO;
    const consumerRelevance = visualConsumerRelevance(consumer, feature.layer);

    // The one factor that can silence an otherwise perfect cue — and only the
    // narrator has it. An image or inspector read never spends mention state,
    // so its cooldown is structurally one. Which
    // record supplies the last mention follows the same disjoint split as
    // novelty: a rolled sleeve now cools down on its OWN history rather than on
    // the full-cooldown default a feature memory never held always produced.
    const cooldownRow = memoryEligible
      ? { lastMentionedAt: row?.lastMentionedAt, mentionCount: row?.mentionCount ?? 0 }
      : { lastMentionedAt: cueRow?.lastMentionedAtMinutes, mentionCount: cueRow?.mentionCount ?? 0 };
    const repetitionCooldown =
      consumer === "narrator"
        ? recognitionRepetitionCooldown({
            ...(cooldownRow.lastMentionedAt === undefined ? {} : { lastMentionedAt: cooldownRow.lastMentionedAt }),
            mentionCount: cooldownRow.mentionCount,
            atMinutes,
          })
        : AFFORDANCE_UNIT_ONE;

    const salience = recognitionFeatureSalience({ visibility, uniqueness, importance });
    const priority = visualSelectionPriority({
      salience,
      novelty,
      changeSignificance,
      actionRelevance,
      consumerRelevance,
      repetitionCooldown,
    });

    const evidence: AffordanceEvidence[] = [...read.evidence, consumerEvidence];
    if (boost !== 0) {
      evidence.push(affordanceEvidence("adapter", "visual_state.attention.importance_boost", String(boost)));
    }
    if (cueStatus !== undefined) {
      evidence.push(affordanceEvidence("adapter", "visual_state.attention.cue_state", cueStatus));
    }

    candidates.push({
      feature,
      visibility,
      uniqueness,
      importance,
      detailTier: read.detailTier,
      novelty,
      changeSignificance,
      actionRelevance,
      consumerRelevance,
      repetitionCooldown,
      priority,
      repeatKey,
      noveltySource,
      ...(cueStatus === undefined ? {} : { cueStatus }),
      evidence,
    });
  }

  return { candidates, suppressions, cueObservations };
}

/**
 * Repeat key → the fingerprint of every VISIBLE member of that family.
 *
 * Only families the cue state owns are collected: narrator-eligible kinds that
 * observer memory cannot hold. Recognition-eligible facts keep answering out of
 * memory, so the two records never hold a row for the same family and the cue
 * cap is spent entirely on the gap it exists to fill.
 */
function cueFamilyFingerprints(
  snapshot: VisualStateSnapshot,
  readsByKey: ReadonlyMap<string, VisualStateVisibilityRead>,
): Map<string, string> {
  const members = new Map<string, { key: string; truthFingerprint: string }[]>();
  for (const feature of snapshot.features) {
    if (!readsByKey.has(feature.key)) continue;
    const kind = visualStateKindRegistry.byId(feature.kindId);
    if (kind === undefined || !kind.narratorEligible) continue;
    if (isMemoryEligible(kind, feature)) continue;
    const repeatKey = repeatKeyOf(feature, kind);
    const list = members.get(repeatKey);
    const member = { key: feature.key, truthFingerprint: feature.truthFingerprint };
    if (list === undefined) members.set(repeatKey, [member]);
    else list.push(member);
  }
  const fingerprints = new Map<string, string>();
  for (const [repeatKey, list] of members) fingerprints.set(repeatKey, visualCueFamilyFingerprint(list));
  return fingerprints;
}
