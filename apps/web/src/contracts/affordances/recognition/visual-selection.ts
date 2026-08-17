import { bodyLocationRegistry } from "../../body/locations";
import { diag, type DiagnosticSink } from "../../diagnostics";
import {
  affordanceEvidence,
  AFFORDANCE_CUES_PER_EXCHANGE,
  AFFORDANCE_UNIT_ZERO,
  type AffordanceEvidence,
  type UnitInterval,
} from "../core";
import {
  applyVisualCueMentions,
  emptyVisualCueState,
  recordVisualCuesSpoken,
  visualCueRecentlySpoken,
  intimateAllowedForSubject,
  observeVisualCues,
  visualStateKindRegistry,
  VISUAL_STATE_INTIMATE_GATED,
  VISUAL_STATE_KIND_UNKNOWN,
  VISUAL_STATE_LOCUS_INVALID,
  VISUAL_STATE_SOURCE_UNAVAILABLE,
  type VisualCueMentionCommit,
  type VisualCueObservation,
  type VisualCueState,
  type VisualStateAttentionPriors,
  type VisualStateFeature,
  type VisualStateLayer,
  type VisualStateLocusRef,
  type VisualStateSnapshot,
  type VisualStateSourceRef,
  type VisualStateSuppression,
} from "../../visual-state";
import { recognizableFeatureKeySchema, type RecognizableFeatureKey } from "./candidates";
import { recognitionCueReasons, type RecognitionCueReason, type RecognitionMentionCommit } from "./mention-policy";
import {
  recognitionCanNotice,
  recognitionFeatureSalience,
  recognitionFreshnessBucket,
  RECOGNITION_EMOTIONAL_CALLBACK_IMPORTANCE,
  RECOGNITION_MENTION_FLOOR,
} from "./salience";
import {
  applyRecognitionFingerprintChanges,
  applyRecognitionMention,
  applyRecognitionNotices,
  visualMemoryScopeKey,
  type RecognitionFingerprintChange,
  type RecognitionNotice,
  type VisualFeatureMemory,
  type VisualMemoryBinding,
  type VisualMemoryState,
} from "./visual-memory";
import {
  buildVisualAttentionCandidates,
  visualMemoryScopeOf,
  visualLocusListed,
  visualRecognitionStability,
  type VisualAttentionCandidate,
  type VisualAttentionContext,
} from "./visual-attention";

/**
 * Consumer selection over the scored visual-attention candidates
 * (visual-state.spec.md §Attention and memory, §Consumer digests; plan
 * §Consumer behavior).
 *
 * Two selections, deliberately asymmetric:
 *
 * - **The narrator's is observer-relative and remembers.** It consults visual
 *   memory and mention state, notices what crossed the threshold, adopts
 *   perceived fingerprint changes, offers at most a strict budget of cues, and
 *   returns mention commits as PLAIN DATA on the mention-policy precedent — a
 *   retake replays the captured selection instead of advancing memory twice.
 * - **The camera's is camera-relative and cannot remember.** Its function takes
 *   no memory, returns no memory, and builds its candidates with a cooldown of
 *   one — there is no code path by which a render can read or advance what an
 *   observer noticed, which is invariant 6 made structural.
 *
 * Salience selects OPTIONAL detail only. A mandatory identity, morphology or
 * wardrobe fact rides the image selection's mandatory lane straight from the
 * snapshot, bypassing visibility and ranking entirely (invariant 7); the one
 * thing that outranks it is the intimate-consent gate, which nothing bypasses.
 *
 * These selections produce structured facts — keys, fingerprints, semantic
 * values, evidence, repeat keys. No prose, no prompt text.
 */

// ---------------------------------------------------------------------------
// Diagnostic codes
// ---------------------------------------------------------------------------

/** The selection was called for the wrong consumer or viewpoint kind; nothing is selected. */
export const VISUAL_SELECTION_CONTEXT_MISMATCH = "visual_state.selection.context_mismatch";
/** The snapshot and the memory binding name different continuities; nothing is selected. */
export const VISUAL_SELECTION_SCOPE_MISMATCH = "visual_state.selection.scope_mismatch";
/** A selection budget was not a usable count; the default is used instead. */
export const VISUAL_SELECTION_BUDGET_INVALID = "visual_state.selection.budget_invalid";
/** A feature key observer memory cannot index; the feature is excluded from narration. */
export const VISUAL_SELECTION_KEY_UNBRANDABLE = "visual_state.selection.key_unbrandable";

// ---------------------------------------------------------------------------
// Budgets — strict, and calibration defaults rather than product law
// ---------------------------------------------------------------------------

/** The narrator's cue budget: the affordance core's strict "one or two". */
export const VISUAL_NARRATOR_CUE_BUDGET_DEFAULT = AFFORDANCE_CUES_PER_EXCHANGE;

/**
 * The must-preserve block's cap — the plan's "compact must-preserve block",
 * given a number.
 *
 * A fence is not a cue budget and the two are calibrated against opposite
 * failures. The cue budget is small because volunteering detail is what the
 * failed affordance-cue trial punished; this cap is larger because a fact left
 * out of the fence is a fact the narrator is free to contradict, and it is
 * capped at all because a fence long enough to read as an inventory invites the
 * recitation that trial also punished. Six is a fixture-tested calibration
 * default, not product law.
 */
export const VISUAL_NARRATOR_CONSTRAINT_BUDGET_DEFAULT = 6;
/** Optional image facts per render until model profiles (slice 8) calibrate it. */
export const VISUAL_IMAGE_OPTIONAL_BUDGET_DEFAULT = 8;

function resolvedBudget(
  raw: number | undefined,
  fallback: number,
  sink: DiagnosticSink | undefined,
  path: string,
): number {
  if (raw === undefined) return fallback;
  if (!Number.isFinite(raw) || raw < 0) {
    sink?.push(
      diag("warn", VISUAL_SELECTION_BUDGET_INVALID, "Selection budget is not a usable count", {
        path,
        context: { budget: String(raw), fallback },
      }),
    );
    return fallback;
  }
  return Math.trunc(raw);
}

// ---------------------------------------------------------------------------
// Shared shapes and helpers
// ---------------------------------------------------------------------------

/**
 * Mandatory is a requirement flag on the feature's priors, never a score.
 *
 * Exported for the image digest (slice 8), which must agree with the selection
 * about which facts ride the mandatory lane: two definitions of "required"
 * would let a digest report a fact missing that the selection never owed it.
 */
export function isMandatoryVisualStateFact(priors: VisualStateAttentionPriors): boolean {
  return priors.mandatoryForIdentity === true || priors.mandatoryForContinuity === true;
}

/**
 * Importance grounded in something the observer could have witnessed — the
 * mention policy's v1 approximation, read through the nested appearance arm.
 * Every other visual source stays ungrounded until source events carry their
 * own observer-visible weight.
 */
function isGroundedVisualSource(sourceRef: VisualStateSourceRef): boolean {
  return sourceRef.kind === "appearance" && (sourceRef.ref.kind === "located_fact" || sourceRef.ref.kind === "anatomy");
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Higher priority first; exact ties break on the feature key, ascending. */
function byPriorityThenKey(left: VisualAttentionCandidate, right: VisualAttentionCandidate): number {
  return right.priority - left.priority || compareStrings(left.feature.key, right.feature.key);
}

// ---------------------------------------------------------------------------
// Narrator selection
// ---------------------------------------------------------------------------

/**
 * One must-not-contradict fact: a visible mandatory feature, carried as data
 * for the prompt adapter's compact must-preserve block. Hidden mandatory facts
 * are deliberately NOT constraints — the narrator digest may never leak what
 * this observer cannot currently see, and contradiction prevention for the
 * unseen belongs to the narrator-guidance plan's binding constraints.
 */
export interface VisualConstraint {
  readonly key: string;
  readonly subjectId: string;
  readonly kindId: string;
  readonly locus: VisualStateLocusRef;
  readonly value: unknown;
  readonly truthFingerprint: string;
  readonly semanticTags: readonly string[];
  readonly evidence: readonly AffordanceEvidence[];
}

/**
 * Why a visual-state cue is live. The shipped recognition reasons, plus the one
 * the cue state made sayable: `newly_visible`.
 *
 * It is NOT folded into `recognitionCueReasons`, because the recognition lane
 * cannot produce it — recognition memory has no concept of a fact that became
 * visible without changing — and a shared vocabulary carrying a member one of
 * its producers can never emit is a vocabulary that lies to its consumers.
 * `visualNarratorCueReasonIsRecognition` narrows back where the two meet.
 */
export const visualNarratorCueReasons = [...recognitionCueReasons, "newly_visible"] as const;
export type VisualNarratorCueReason = (typeof visualNarratorCueReasons)[number];

/** Whether a visual cue reason is one the recognition mention ledger can record. */
export function visualNarratorCueReasonIsRecognition(
  reason: VisualNarratorCueReason,
): reason is RecognitionCueReason {
  return reason !== "newly_visible";
}

/** One offered narrator cue. Structured facts; the chat adapter owns wording. */
export interface VisualNarratorCue {
  readonly key: string;
  readonly subjectId: string;
  readonly kindId: string;
  readonly layer: VisualStateLayer;
  readonly locus: VisualStateLocusRef;
  readonly reason: VisualNarratorCueReason;
  readonly value: unknown;
  readonly truthFingerprint: string;
  readonly semanticTags: readonly string[];
  readonly repeatKey: string;
  readonly priority: UnitInterval;
  readonly evidence: readonly AffordanceEvidence[];
}

export interface VisualNarratorDigest {
  readonly subjectId: string;
  readonly constraints: readonly VisualConstraint[];
  readonly selected: readonly VisualNarratorCue[];
  /** Eligible candidates for this subject the selection left unsaid — restraint, measured. */
  readonly suppressedCount: number;
}

export interface VisualNarratorSelectionInput {
  readonly snapshot: VisualStateSnapshot;
  /** Must carry `consumer: "narrator"` and an observer viewpoint. */
  readonly context: VisualAttentionContext;
  /** The (scope, observer) pair `memory` was loaded for. */
  readonly binding: VisualMemoryBinding;
  readonly memory: VisualMemoryState;
  /**
   * The narrator cue state as of BEFORE this cut — repetition and first
   * visibility for the families observer memory deliberately does not hold.
   * Absent means the lane has not wired it, and every such family reads as
   * first-visible with a full cooldown.
   */
  readonly cues?: VisualCueState;
  /** Cues offered at most, after the mention floor. Defaults to the strict two. */
  readonly cueBudget?: number;
  /** Must-preserve facts carried at most. Defaults to the compact six. */
  readonly constraintBudget?: number;
  /** Lane-neutral provenance stamped onto every notice from this cut. */
  readonly observationId?: string;
  readonly sink?: DiagnosticSink;
}

export interface VisualNarratorSelection {
  /** One digest per snapshot subject, in the snapshot's subject order. */
  readonly digests: readonly VisualNarratorDigest[];
  /** The full scored candidate list — the inspector's staircase. */
  readonly candidates: readonly VisualAttentionCandidate[];
  /** Everything perception crossed the threshold on — memory bookkeeping, not narration. */
  readonly notices: readonly RecognitionNotice[];
  /** Perceived fingerprint changes, adopted through the explicit change path. */
  readonly changes: readonly RecognitionFingerprintChange[];
  /** Memory after notices and adopted changes. Mentions are NOT applied. */
  readonly memoryAfterNotices: VisualMemoryState;
  /** Apply these only when the selected cues enter the committed cut. */
  readonly mentionCommits: readonly RecognitionMentionCommit[];
  /** Every cue-owned family this observer could resolve at this cut. */
  readonly cueObservations: readonly VisualCueObservation[];
  /**
   * Cue state after this cut's visibility, mentions NOT applied — the exact
   * mirror of `memoryAfterNotices`. Seeing a rolled sleeve is what makes the
   * next cut's "newly visible" answer correct; SAYING it is a separate event
   * the caller commits only once the cut lands.
   */
  readonly cueStateAfterVisibility: VisualCueState;
  /** Apply these to `cueStateAfterVisibility` only when the cues enter the cut. */
  readonly cueMentionCommits: readonly VisualCueMentionCommit[];
  /** Every offered family's repeat key — the fence's just-spoken window, committed with the cut. */
  readonly spokenRepeatKeys: readonly string[];
  readonly suppressions: readonly VisualStateSuppression[];
}

/**
 * Why this candidate might be worth a beat, extending the shipped precedence
 * with the stamp-driven change the projection carries. `null` means "noticed,
 * nothing to say" — the ordinary case for a familiar face, and the only reason
 * familiar steady state stays quiet.
 */
function visualNarratorCueReason(input: {
  candidate: VisualAttentionCandidate;
  memoryEligible: boolean;
  row: VisualFeatureMemory | undefined;
  fingerprintChanged: boolean;
  atMinutes: number;
}): VisualNarratorCueReason | null {
  const { candidate } = input;
  if (input.fingerprintChanged) return "change";
  if (input.memoryEligible && input.row === undefined) return "first_notice";
  if (
    input.memoryEligible &&
    input.row !== undefined &&
    recognitionFreshnessBucket(input.row.lastNoticedAt, input.atMinutes) === "long_absence"
  ) {
    return "recognition_refresh";
  }
  // An owner's own change stamp outranks the cue state, deliberately: "this
  // sleeve was rolled nine minutes ago" is a more specific thing to say than
  // "we have no record of having seen it". Without this order every fact would
  // read as newly visible on the first narrated cut, when no family has a
  // record yet, and a genuinely fresh change would be reported as a first
  // sighting.
  if (candidate.changeSignificance > AFFORDANCE_UNIT_ZERO) return "change";
  // The cue state's own reasons, for the families memory never held. A family
  // in continuous, unchanged view produces NOTHING here and falls through to
  // the action tests below — which is the whole point: a rolled sleeve earns a
  // beat when it appears or changes, not for continuing to exist.
  switch (candidate.cueStatus) {
    case "first_visible":
    case "revealed":
      return "newly_visible";
    case "changed":
      return "change";
    case "steady":
    case undefined:
      break;
  }
  if (candidate.actionRelevance > AFFORDANCE_UNIT_ZERO) return "action_relevance";
  if (
    candidate.importance >= RECOGNITION_EMOTIONAL_CALLBACK_IMPORTANCE &&
    isGroundedVisualSource(candidate.feature.sourceRef)
  ) {
    return "emotional_callback";
  }
  return null;
}

/**
 * The must-preserve facts, per subject, capped.
 *
 * **The image-mandatory flags are NOT the narrator's fence.**
 * `mandatoryForIdentity` / `mandatoryForContinuity` are documented in
 * `priors.ts` as IMAGE REQUIREMENTS — what a render may not drop — and reusing
 * them here would fence exactly the facts a render needs (morphology, worn
 * garments) while leaving unfenced the ones prose actually contradicts: how a
 * sleeve is arranged, how wet the hair is, what posture the body is in. That
 * mismatch is why this is its own ranking rather than the mandatory filter it
 * started as.
 *
 * So the fence is every VISIBLE narrator-eligible fact, ranked mandatory-first
 * and then by salience, capped. Three properties matter:
 *
 * - **No change gate and no cooldown.** A coat worn for six exchanges is
 *   exactly as contradictable on the seventh; a fence that went quiet once
 *   mentioned would stop fencing precisely when the narrator was most likely to
 *   drift.
 * - **Visible only.** These are already the visibility read's survivors, so the
 *   fence can never state what this observer cannot see — hidden-fact
 *   contradiction prevention stays the narrator-guidance plan's business.
 * - **Mandatory first.** A cap that dropped a morphology anchor to make room
 *   for a crease would be the salience-over-requirement trade invariant 7
 *   forbids on the image side, and it reads no better here.
 */
function narratorConstraints(
  candidates: readonly VisualAttentionCandidate[],
  budget: number,
  /**
   * Feature keys the cue block already carries. They are EXCLUDED from the
   * fence: one fact belongs in one place, and the cue line is the place that
   * says more — it carries the same clause plus the reason the fact is live
   * this turn. Leaving it in both would spend a fence slot on a repetition and
   * bury the change signal the whole lane exists to surface.
   */
  spokenKeys: ReadonlySet<string>,
  /**
   * The cue state, for the just-spoken window. A family the narrator said on
   * the previous cut stays out of the fence for one cut
   * (`VISUAL_FENCE_QUIET_CUTS`) — the round-1 repetition finding, closed here
   * rather than in prompt wording: the fence cannot be re-presenting a fact the
   * narrator has only just used, because the narrator reads a fence entry as
   * something it may say.
   */
  cues: VisualCueState,
): Map<string, VisualAttentionCandidate[]> {
  const bySubject = new Map<string, VisualAttentionCandidate[]>();
  for (const candidate of candidates) {
    if (spokenKeys.has(candidate.feature.key)) continue;
    if (visualCueRecentlySpoken(cues, candidate.repeatKey)) continue;
    const list = bySubject.get(candidate.feature.subjectId);
    if (list === undefined) bySubject.set(candidate.feature.subjectId, [candidate]);
    else list.push(candidate);
  }
  const chosen = new Map<string, VisualAttentionCandidate[]>();
  for (const [subjectId, list] of bySubject) {
    const ranked = [...list].sort((left, right) => {
      const leftMandatory = isMandatoryVisualStateFact(left.feature.priors) ? 1 : 0;
      const rightMandatory = isMandatoryVisualStateFact(right.feature.priors) ? 1 : 0;
      if (leftMandatory !== rightMandatory) return rightMandatory - leftMandatory;
      // Salience, NOT priority: priority carries novelty and the mention
      // cooldown, and a fence must not fade as it gets mentioned.
      const bySalience =
        recognitionFeatureSalience(right) - recognitionFeatureSalience(left);
      return bySalience || compareStrings(left.feature.key, right.feature.key);
    });
    chosen.set(subjectId, ranked.slice(0, budget));
  }
  return chosen;
}

function visualConstraintOf(feature: VisualStateFeature): VisualConstraint {
  return {
    key: feature.key,
    subjectId: feature.subjectId,
    kindId: feature.kindId,
    locus: feature.locus,
    value: feature.value,
    truthFingerprint: feature.truthFingerprint,
    semanticTags: feature.semanticTags,
    evidence: feature.evidence,
  };
}

/** The whole snapshot suppressed under one code — the fail-closed empty selection. */
function suppressedSnapshot(snapshot: VisualStateSnapshot, code: string, detail: string): VisualStateSuppression[] {
  return snapshot.features.map((feature) => ({ key: feature.key, code, detail }));
}

function emptyNarratorSelection(
  input: VisualNarratorSelectionInput,
  suppressions: readonly VisualStateSuppression[],
): VisualNarratorSelection {
  return {
    digests: input.snapshot.subjects.map((subjectId) => ({
      subjectId,
      constraints: [],
      selected: [],
      suppressedCount: 0,
    })),
    candidates: [],
    notices: [],
    changes: [],
    memoryAfterNotices: input.memory,
    mentionCommits: [],
    // A failed-closed selection saw nothing, so it records nothing — the cue
    // state must not advance its sequence on a cut that resolved no features,
    // or every family would read as newly revealed on the next one.
    cueObservations: [],
    cueStateAfterVisibility: input.cues ?? emptyVisualCueState(),
    cueMentionCommits: [],
    spokenRepeatKeys: [],
    suppressions,
  };
}

interface ScoredNarratorEntry {
  readonly candidate: VisualAttentionCandidate;
  readonly reason: VisualNarratorCueReason;
  readonly brandedKey?: RecognizableFeatureKey;
}

/**
 * Score this cut's visible features for one observer, update observer memory,
 * and pick at most the budget of cues.
 *
 * The scope guard is meeting point 1 doing real work: the snapshot's scope
 * converts through `visualMemoryScopeOf` (a compile error if the unions ever
 * diverge) and must name the SAME continuity the memory was loaded for. A
 * mismatched read would either leak another continuity's visual knowledge into
 * this one or corrupt its notice history, so the whole selection fails closed
 * to silence instead — nothing selected, nothing noticed, memory untouched.
 *
 * Notice and mention stay different events, exactly as the mention policy
 * rules: everything above the notice threshold strengthens memory silently;
 * only committed cues ever start a cooldown, and committing is the CALLER's
 * step (`commitVisualNarratorMentions`) once the cut lands.
 */
export function selectVisualNarratorCues(input: VisualNarratorSelectionInput): VisualNarratorSelection {
  const path = "visual_state.selection.narrator";
  const { snapshot, context, memory } = input;
  const sink = input.sink;

  if (context.consumer !== "narrator" || context.viewpoint.kind !== "observer") {
    const detail = context.consumer !== "narrator" ? `consumer:${context.consumer}` : `viewpoint:${context.viewpoint.kind}`;
    sink?.push(
      diag("warn", VISUAL_SELECTION_CONTEXT_MISMATCH, "Narrator selection needs a narrator consumer and an observer viewpoint", {
        path,
        context: { detail },
      }),
    );
    return emptyNarratorSelection(input, suppressedSnapshot(snapshot, VISUAL_SELECTION_CONTEXT_MISMATCH, detail));
  }

  const snapshotScopeKey = visualMemoryScopeKey(visualMemoryScopeOf(snapshot.scope));
  const bindingScopeKey = visualMemoryScopeKey(input.binding.scope);
  if (snapshotScopeKey !== bindingScopeKey) {
    sink?.push(
      diag("warn", VISUAL_SELECTION_SCOPE_MISMATCH, "Snapshot and memory binding name different continuities", {
        path,
        context: { snapshotScope: snapshotScopeKey, bindingScope: bindingScopeKey },
      }),
    );
    return emptyNarratorSelection(input, suppressedSnapshot(snapshot, VISUAL_SELECTION_SCOPE_MISMATCH, bindingScopeKey));
  }

  const budget = resolvedBudget(input.cueBudget, VISUAL_NARRATOR_CUE_BUDGET_DEFAULT, sink, path);
  const constraintBudget = resolvedBudget(
    input.constraintBudget,
    VISUAL_NARRATOR_CONSTRAINT_BUDGET_DEFAULT,
    sink,
    path,
  );
  const atMinutes = Number.isFinite(snapshot.atMinutes) ? Math.max(0, Math.trunc(snapshot.atMinutes)) : 0;

  const priorCueState = input.cues ?? emptyVisualCueState();
  const build = buildVisualAttentionCandidates({
    snapshot,
    context,
    memory,
    cues: priorCueState,
    ...(sink === undefined ? {} : { sink }),
  });
  const suppressions: VisualStateSuppression[] = [...build.suppressions];
  const notices: RecognitionNotice[] = [];
  const changes: RecognitionFingerprintChange[] = [];
  const scorable: ScoredNarratorEntry[] = [];

  for (const candidate of build.candidates) {
    const { feature } = candidate;
    const kind = visualStateKindRegistry.byId(feature.kindId);
    if (kind === undefined) continue; // the build already suppressed and reported it

    const salience = recognitionFeatureSalience(candidate);
    const focused = visualLocusListed(context.focusLoci, feature.locus);
    if (!recognitionCanNotice({ salience, visibility: candidate.visibility, underInspection: focused })) {
      continue; // below the notice threshold: no notice, no cue — never a leak
    }

    const stability = visualRecognitionStability(feature.stability);
    const memoryEligible = kind.recognitionEligible && stability !== null;
    let row: VisualFeatureMemory | undefined;
    let brandedKey: RecognizableFeatureKey | undefined;
    let fingerprintChanged = false;

    if (memoryEligible && stability !== null) {
      const branded = recognizableFeatureKeySchema.safeParse(feature.key);
      if (!branded.success) {
        // Memory cannot index this key, so notices and cooldowns cannot work;
        // narrating it anyway would re-introduce it every turn. Fail closed.
        suppressions.push({ key: feature.key, code: VISUAL_SELECTION_KEY_UNBRANDABLE });
        sink?.push(
          diag("warn", VISUAL_SELECTION_KEY_UNBRANDABLE, "Feature key cannot index observer memory", {
            path,
            context: { key: feature.key },
          }),
        );
        continue;
      }
      brandedKey = branded.data;
      row = memory.features[feature.key];
      fingerprintChanged = row !== undefined && row.truthFingerprint !== feature.truthFingerprint;
      notices.push({
        candidate: {
          key: brandedKey,
          subjectId: feature.subjectId,
          truthFingerprint: feature.truthFingerprint,
          stability,
          visibility: candidate.visibility,
          uniqueness: candidate.uniqueness,
          importance: candidate.importance,
        },
        detailTier: candidate.detailTier,
        atMinutes,
        ...(input.observationId === undefined ? {} : { observationId: input.observationId }),
      });
      if (fingerprintChanged && brandedKey !== undefined) {
        changes.push({ featureKey: brandedKey, truthFingerprint: feature.truthFingerprint, atMinutes });
      }
    }

    // A mandatory fact never competes in the OPTIONAL lane. It already rides
    // the constraints list, which the prompt renders as its own must-preserve
    // block, so letting it also take one of the two cue slots would spend the
    // budget restating a fence the same prompt just put up — and the cue that
    // lost the slot is exactly the changed or newly revealed detail this lane
    // exists to surface. The image selection draws the same line (invariant 7);
    // this is that line on the narrator side.
    if (isMandatoryVisualStateFact(feature.priors)) continue;

    const reason = visualNarratorCueReason({ candidate, memoryEligible, row, fingerprintChanged, atMinutes });
    if (reason === null) continue;
    if (candidate.priority < RECOGNITION_MENTION_FLOOR) continue;
    scorable.push({ candidate, reason, ...(brandedKey === undefined ? {} : { brandedKey }) });
  }

  // Strict budget, deterministic order, one cue per repeat family — the same
  // scar must not be offered twice in one beat under two keys.
  const ranked = [...scorable].sort((left, right) => byPriorityThenKey(left.candidate, right.candidate));
  const selected: ScoredNarratorEntry[] = [];
  const seenFamilies = new Set<string>();
  for (const entry of ranked) {
    if (selected.length >= budget) break;
    if (seenFamilies.has(entry.candidate.repeatKey)) continue;
    seenFamilies.add(entry.candidate.repeatKey);
    selected.push(entry);
  }

  const cues: VisualNarratorCue[] = selected.map((entry) => {
    const { feature } = entry.candidate;
    return {
      key: feature.key,
      subjectId: feature.subjectId,
      kindId: feature.kindId,
      layer: feature.layer,
      locus: feature.locus,
      reason: entry.reason,
      value: feature.value,
      truthFingerprint: feature.truthFingerprint,
      semanticTags: feature.semanticTags,
      repeatKey: entry.candidate.repeatKey,
      priority: entry.candidate.priority,
      evidence: [...entry.candidate.evidence, affordanceEvidence("adapter", "visual_state.selection.reason", entry.reason)],
    };
  });

  // The two mention ledgers, split by which record answered for the feature —
  // the same disjoint split the scoring used, so one cue can never spend both.
  const mentionCommits: RecognitionMentionCommit[] = selected
    .filter((entry): entry is ScoredNarratorEntry & { brandedKey: RecognizableFeatureKey } => entry.brandedKey !== undefined)
    .flatMap((entry) =>
      visualNarratorCueReasonIsRecognition(entry.reason)
        ? [{ featureKey: entry.brandedKey, atMinutes, reason: entry.reason, repeatKey: entry.candidate.repeatKey }]
        : [],
    );
  const cueMentionCommits: VisualCueMentionCommit[] = selected
    .filter((entry) => entry.candidate.noveltySource === "cue")
    .map((entry) => ({ repeatKey: entry.candidate.repeatKey, atMinutes }));
  // EVERY offered family, not only the cue-owned ones: the fence's quiet window
  // is a fact about what the prompt just said, and it does not care which
  // record supplied the cooldown.
  const spokenRepeatKeys: string[] = selected.map((entry) => entry.candidate.repeatKey);

  const memoryAfterNotices = applyRecognitionFingerprintChanges(applyRecognitionNotices(memory, notices), changes);
  // Visibility is recorded for EVERY resolved cue family, mentioned or not:
  // looking is what makes the next cut's newly-visible answer correct, exactly
  // as a notice is for memory. The sequence advances once per selection.
  const cueStateAfterVisibility = observeVisualCues(priorCueState, {
    atMinutes,
    observations: build.cueObservations,
  });

  // One grouping pass per list, rather than re-walking every list once per
  // subject: a multi-participant snapshot scans the candidates once, not once
  // per subject.
  const constraintsBySubject = new Map<string, VisualConstraint[]>();
  const spokenKeys = new Set(cues.map((offered) => offered.key));
  for (const [subjectId, chosen] of narratorConstraints(build.candidates, constraintBudget, spokenKeys, priorCueState)) {
    constraintsBySubject.set(subjectId, chosen.map((candidate) => visualConstraintOf(candidate.feature)));
  }
  // `scorable`, NOT every scored candidate, is the population that was ever
  // eligible to be said: each entry already cleared the notice threshold,
  // earned a cue reason, and passed the mention floor. Counting the rest as
  // suppressed reported restraint the selection never had to exercise.
  const eligibleBySubject = new Map<string, number>();
  for (const entry of scorable) {
    const subjectId = entry.candidate.feature.subjectId;
    eligibleBySubject.set(subjectId, (eligibleBySubject.get(subjectId) ?? 0) + 1);
  }
  const cuesBySubject = new Map<string, VisualNarratorCue[]>();
  for (const cue of cues) {
    const list = cuesBySubject.get(cue.subjectId);
    if (list === undefined) cuesBySubject.set(cue.subjectId, [cue]);
    else list.push(cue);
  }

  const digests: VisualNarratorDigest[] = snapshot.subjects.map((subjectId) => {
    const subjectCues = cuesBySubject.get(subjectId) ?? [];
    return {
      subjectId,
      constraints: constraintsBySubject.get(subjectId) ?? [],
      selected: subjectCues,
      suppressedCount: (eligibleBySubject.get(subjectId) ?? 0) - subjectCues.length,
    };
  });

  return {
    digests,
    candidates: build.candidates,
    notices,
    changes,
    memoryAfterNotices,
    mentionCommits,
    cueObservations: build.cueObservations,
    cueStateAfterVisibility,
    cueMentionCommits,
    spokenRepeatKeys,
    suppressions,
  };
}

/**
 * Commit the selected cue mentions once the cut lands — the cue state's mirror
 * of `commitVisualNarratorMentions`, applied to `cueStateAfterVisibility`.
 *
 * An empty list is a no-op, and so is a commit for a family the state holds no
 * row for: the narrator cannot have spent a cooldown it never had.
 */
export function commitVisualNarratorCueMentions(
  state: VisualCueState,
  commits: readonly VisualCueMentionCommit[],
  /** Every offered family, for the fence's just-spoken window. */
  spokenRepeatKeys: readonly string[] = [],
): VisualCueState {
  return recordVisualCuesSpoken(applyVisualCueMentions(state, commits), spokenRepeatKeys);
}

/**
 * Commit the selected mentions once the cut lands. An empty list is a no-op,
 * as is a commit for a feature this observer holds no row for — the narrator
 * cannot have spent recognition mention state it never had.
 */
export function commitVisualNarratorMentions(
  state: VisualMemoryState,
  commits: readonly RecognitionMentionCommit[],
): VisualMemoryState {
  let next = state;
  for (const commit of commits) {
    next = applyRecognitionMention(next, { featureKey: commit.featureKey, atMinutes: commit.atMinutes });
  }
  return next;
}

// ---------------------------------------------------------------------------
// Image selection
// ---------------------------------------------------------------------------

export interface VisualImageSelectionInput {
  readonly snapshot: VisualStateSnapshot;
  /** Must carry `consumer: "image"` and a camera (or debug) viewpoint. */
  readonly context: VisualAttentionContext;
  /** Optional facts kept at most. Zero is honored — mandatory facts survive it. */
  readonly optionalBudget?: number;
  readonly sink?: DiagnosticSink;
}

export interface VisualImageSelection {
  readonly subjects: readonly string[];
  /** The subject-count fact, carried explicitly for the render digest (slice 8). */
  readonly subjectCount: number;
  /**
   * Every mandatory identity/morphology/wardrobe fact, in snapshot order,
   * REGARDLESS of visibility or salience — a hidden anchor still holds the
   * generated character together. Only the intimate-consent gate removes one.
   */
  readonly mandatory: readonly VisualStateFeature[];
  /** Camera-visible optional detail, best first, within the budget. */
  readonly optional: readonly VisualAttentionCandidate[];
  readonly suppressions: readonly VisualStateSuppression[];
  /** Optional candidates the floor or the budget left out. */
  readonly suppressedOptionalCount: number;
}

/**
 * Select what one camera hands the image compiler.
 *
 * Structurally memoryless: this function takes no observer memory, returns
 * none, and its candidate build runs with a repetition cooldown of one — a
 * mention the narrator spent an hour ago cannot dim an image fact, and a
 * render can never advance what a player noticed (invariant 6). Salience
 * ranks the OPTIONAL lane only; the mandatory lane comes straight from the
 * snapshot and survives a zero budget (invariant 7).
 */
export function selectVisualImageFacts(input: VisualImageSelectionInput): VisualImageSelection {
  const path = "visual_state.selection.image";
  const { snapshot, context } = input;
  const sink = input.sink;

  if (context.consumer !== "image" || context.viewpoint.kind === "observer") {
    const detail = context.consumer !== "image" ? `consumer:${context.consumer}` : "viewpoint:observer";
    sink?.push(
      diag("warn", VISUAL_SELECTION_CONTEXT_MISMATCH, "Image selection needs an image consumer and a camera viewpoint", {
        path,
        context: { detail },
      }),
    );
    return {
      subjects: snapshot.subjects,
      subjectCount: snapshot.subjects.length,
      mandatory: [],
      optional: [],
      suppressions: suppressedSnapshot(snapshot, VISUAL_SELECTION_CONTEXT_MISMATCH, detail),
      suppressedOptionalCount: 0,
    };
  }

  const budget = resolvedBudget(input.optionalBudget, VISUAL_IMAGE_OPTIONAL_BUDGET_DEFAULT, sink, path);
  const suppressions: VisualStateSuppression[] = [];

  // Mandatory lane: straight from the snapshot, no visibility, no ranking.
  const mandatory: VisualStateFeature[] = [];
  for (const feature of snapshot.features) {
    if (!isMandatoryVisualStateFact(feature.priors)) continue;
    const kind = visualStateKindRegistry.byId(feature.kindId);
    if (kind === undefined) {
      // The optional build reports the same record to the sink; the mandatory
      // lane only records why it is absent here.
      suppressions.push({ key: feature.key, code: VISUAL_STATE_KIND_UNKNOWN, detail: feature.kindId });
      continue;
    }
    if (!kind.imageEligible) {
      // A designed absence, but still recorded: without a suppression the
      // inspector and the digest show a mandatory fact simply gone, with no
      // way to tell a deliberate exclusion from a degradation.
      suppressions.push({ key: feature.key, code: VISUAL_STATE_SOURCE_UNAVAILABLE, detail: `image_ineligible:${feature.kindId}` });
      continue;
    }
    if (feature.locus.kind === "body") {
      const location = bodyLocationRegistry.byId(feature.locus.locus.bodyLocationId);
      if (location === undefined) {
        // An unknown location means the intimate gate cannot be evaluated,
        // which fails closed — even for a mandatory fact.
        suppressions.push({ key: feature.key, code: VISUAL_STATE_LOCUS_INVALID, detail: feature.locus.locus.bodyLocationId });
        continue;
      }
      // The consent gate is the ONE thing that outranks mandatory: rarity
      // never lifts it and neither does a requirement flag.
      if (location.intimateGroup !== undefined && !intimateAllowedForSubject(context, feature.subjectId)) {
        suppressions.push({ key: feature.key, code: VISUAL_STATE_INTIMATE_GATED, detail: `mandatory:${location.intimateGroup}` });
        continue;
      }
    }
    mandatory.push(feature);
  }

  // Optional lane: camera-visible candidates, ranked; mandatory facts never
  // compete here, so salience can only ever ADD detail.
  const build = buildVisualAttentionCandidates({
    snapshot,
    context,
    ...(sink === undefined ? {} : { sink }),
  });
  suppressions.push(...build.suppressions);

  const optionalCandidates = build.candidates.filter(
    (candidate) => !isMandatoryVisualStateFact(candidate.feature.priors) && candidate.priority > AFFORDANCE_UNIT_ZERO,
  );
  const optional = [...optionalCandidates].sort(byPriorityThenKey).slice(0, budget);

  return {
    subjects: snapshot.subjects,
    subjectCount: snapshot.subjects.length,
    mandatory,
    optional,
    suppressions,
    suppressedOptionalCount: optionalCandidates.length - optional.length,
  };
}
