import {
  visualStateLocusKey,
  visualStateScopeKey,
  visualStateSourceKey,
  type Diagnostic,
  type VisualAttentionCandidate,
  type VisualImageDigest,
  type VisualImageFact,
  type VisualImageProvenance,
  type VisualStateFeature,
  type VisualComponentRead,
  type VisualStateSuppression,
  type VisualViewingConditions,
} from "@/contracts";
import { visualStateImageDigestOfShadow } from "./image-digest";
import { emptyVisualStateMeasurements, type VisualStateMeasurements } from "./measure";
import type { VisualStateShadowBuild } from "./shadow";

/**
 * THE INSPECTOR PAYLOAD (plan §Consumer behavior → Inspector): the complete
 * source-to-selection staircase — source facts, projected features,
 * composition, suppression, visibility evidence, attention scores, memory
 * where applicable, and final consumer digests — as plain JSON for the
 * admin-gated chat-inspector panel.
 *
 * READ-ONLY by construction: it serializes an already-computed shadow build,
 * spends no notice or mention state (the build's narrator memory outputs are
 * simply not serialized as anything writable), and reports flag values rather
 * than obeying them — the spec's "the inspector may ignore flags for read-only
 * diagnostics but displays their values".
 */

export interface VisualStatePreviewFeature {
  readonly key: string;
  readonly kindId: string;
  readonly layer: string;
  readonly stability: string;
  readonly locus: string;
  readonly source: string;
  readonly value: unknown;
  readonly fingerprint: string;
  readonly tags: readonly string[];
  readonly changedAtMinutes: number | null;
  readonly validUntilMinutes: number | null;
  readonly relationships: readonly string[];
  readonly evidence: readonly string[];
}

export interface VisualStatePreviewComposition {
  readonly key: string;
  readonly effectiveVisibility: number;
  readonly coverage: number;
  readonly occlusion: number;
  readonly replacedBy: string | null;
  readonly modifiedBy: readonly string[];
  readonly attachedTo: readonly string[];
  readonly derivedFrom: readonly string[];
}

export interface VisualStatePreviewSuppression {
  readonly key: string;
  readonly code: string;
  readonly detail: string;
}

export interface VisualStatePreviewCandidate {
  readonly key: string;
  readonly layer: string;
  readonly priority: number;
  readonly visibility: number;
  readonly uniqueness: number;
  readonly importance: number;
  readonly detailTier: number;
  readonly novelty: number;
  readonly changeSignificance: number;
  readonly actionRelevance: number;
  readonly consumerRelevance: number;
  readonly repetitionCooldown: number;
  readonly repeatKey: string;
  /** Which record answered novelty and cooldown: observer memory, the cue state, or neither. */
  readonly noveltySource: string;
  /** How the cue state read this family's visibility, when the cue state answered. */
  readonly cueStatus: string | null;
}

export interface VisualStatePreviewCue {
  readonly key: string;
  readonly reason: string;
  readonly repeatKey: string;
  readonly priority: number;
}

export interface VisualStatePreviewDigest {
  readonly subjectId: string;
  readonly constraintKeys: readonly string[];
  readonly selected: readonly VisualStatePreviewCue[];
  readonly suppressedCount: number;
}

/**
 * The conditions the production reads ran under, and which of them nobody owns.
 *
 * The inspector's staircase deliberately substitutes ideal conditions, so
 * without this panel a reader cannot tell a grounded read from the release's
 * declared base — which is exactly the confusion that let "the inspector works,
 * so the narrator must too" stand while production had no candidates at all.
 */
export interface VisualStatePreviewViewing {
  readonly lighting: string;
  readonly distance: string;
  readonly angle: string;
  readonly motion: string;
  /** Components supplied by the declared release default rather than by an owner. */
  readonly declared: readonly string[];
}

/** The narrator cue record — repetition and first visibility for what memory does not hold. */
export interface VisualStatePreviewCueState {
  /**
   * Cuts this observer has recorded, THIS one included — the value a commit
   * would store. A stored `0` before the cut means the state has never been
   * committed, which is what makes every family read as first-visible.
   */
  readonly sequenceAfter: number;
  readonly recordCount: number;
  /** Families resolvable at this cut — what a commit would record. */
  readonly observedCount: number;
  /** Families whose cue would start a cooldown if this cut landed. */
  readonly mentionCommitCount: number;
}

export interface VisualStatePreviewDiagnostic {
  readonly severity: string;
  readonly code: string;
  readonly message: string;
}

// ---------------------------------------------------------------------------
// The realized image digest — image-lane-consolidation Stage 2
// ---------------------------------------------------------------------------

/** One selected fact, as the panel names it: identity, placement, and lane. */
export interface VisualStatePreviewDigestFact {
  readonly key: string;
  readonly kindId: string;
  readonly locus: string;
  readonly segmentKind: string;
  readonly required: boolean;
}

export interface VisualStatePreviewDigestSubject {
  readonly subjectId: string;
  readonly required: readonly VisualStatePreviewDigestFact[];
  readonly optional: readonly VisualStatePreviewDigestFact[];
  /** Mandatory facts the digest LOST to degradation — never a consent-gated absence. */
  readonly missingMandatory: readonly string[];
}

/** One suppression reason and how many facts it accounts for. */
export interface VisualStatePreviewDigestSuppression {
  readonly code: string;
  readonly count: number;
}

/**
 * What a character-bearing render would consume from THIS cut, plus the record
 * it would store. The panel shows it beside the raw image selection above it
 * because the two answer different questions: the selection is what the camera
 * scored, the digest is what a render actually receives — required and optional
 * split, each fact routed to the prompt segment its prose belongs in, with the
 * three fingerprints that let a stored image be traced back to this moment.
 *
 * No render consumes it yet; the inspector is Stage 2's only reader.
 */
export interface VisualStatePreviewImageDigest {
  readonly cutId: string;
  readonly subjectCount: number;
  /** "Is this the same visual moment?" */
  readonly snapshotFingerprint: string;
  /** "Is this the same composition?" */
  readonly selectionFingerprint: string;
  /** Everything the camera asserted. */
  readonly cameraFingerprint: string;
  readonly subjects: readonly VisualStatePreviewDigestSubject[];
  readonly requiredCount: number;
  readonly optionalCount: number;
  /** Every subject's missing-mandatory report, flattened. */
  readonly missingMandatory: readonly string[];
  readonly suppressionReasons: readonly VisualStatePreviewDigestSuppression[];
  /** The compact record a render row would file under `meta.visualState`. */
  readonly provenance: VisualImageProvenance;
}

export interface VisualStatePreviewPayload {
  readonly lane: "character_chat" | "successor";
  /** `CHAT_VISUAL_STATE_SHADOW` — reported, never obeyed. */
  readonly shadowFlagEnabled: boolean;
  readonly scopeKey: string;
  readonly cutId: string;
  readonly atMinutes: number;
  readonly subjects: readonly string[];
  readonly features: readonly VisualStatePreviewFeature[];
  readonly composition: readonly VisualStatePreviewComposition[];
  readonly suppressions: readonly VisualStatePreviewSuppression[];
  /** Every feature scored under the debug viewpoint's ideal conditions. */
  readonly staircase: readonly VisualStatePreviewCandidate[];
  /** What the production reads actually ran under. */
  readonly viewing: VisualStatePreviewViewing;
  readonly narrator: {
    readonly digests: readonly VisualStatePreviewDigest[];
    readonly noticeCount: number;
    readonly changeCount: number;
    readonly mentionCommitCount: number;
    readonly cueState: VisualStatePreviewCueState;
    readonly suppressions: readonly VisualStatePreviewSuppression[];
  };
  readonly image: {
    readonly mandatoryKeys: readonly string[];
    readonly optional: readonly VisualStatePreviewCandidate[];
    readonly suppressedOptionalCount: number;
    readonly suppressions: readonly VisualStatePreviewSuppression[];
  };
  /** The realized render digest, or `null` when there was no build to realize it from. */
  readonly imageDigest: VisualStatePreviewImageDigest | null;
  readonly measurements: VisualStateMeasurements;
  readonly diagnostics: readonly VisualStatePreviewDiagnostic[];
}

/** Cap for the two per-feature suppression lists — the tallies carry the rest. */
const PREVIEW_SUPPRESSION_CAP = 200;

function previewFeature(feature: VisualStateFeature): VisualStatePreviewFeature {
  return {
    key: feature.key,
    kindId: feature.kindId,
    layer: feature.layer,
    stability: feature.stability,
    locus: visualStateLocusKey(feature.locus),
    source: visualStateSourceKey(feature.sourceRef),
    value: feature.value,
    fingerprint: feature.truthFingerprint,
    tags: feature.semanticTags,
    changedAtMinutes: feature.changedAtMinutes ?? null,
    validUntilMinutes: feature.validUntilMinutes ?? null,
    relationships: feature.relationships.map((edge) => `${edge.kind} → ${edge.targetKey}`),
    evidence: feature.evidence.map((entry) => `${entry.kind}:${entry.ref}${entry.detail ? ` (${entry.detail})` : ""}`),
  };
}

function previewSuppressions(suppressions: readonly VisualStateSuppression[]): VisualStatePreviewSuppression[] {
  return suppressions
    .slice(0, PREVIEW_SUPPRESSION_CAP)
    .map((entry) => ({ key: entry.key, code: entry.code, detail: entry.detail ?? "" }));
}

function previewCandidate(candidate: VisualAttentionCandidate): VisualStatePreviewCandidate {
  return {
    key: candidate.feature.key,
    layer: candidate.feature.layer,
    priority: candidate.priority,
    visibility: candidate.visibility,
    uniqueness: candidate.uniqueness,
    importance: candidate.importance,
    detailTier: candidate.detailTier,
    novelty: candidate.novelty,
    changeSignificance: candidate.changeSignificance,
    actionRelevance: candidate.actionRelevance,
    consumerRelevance: candidate.consumerRelevance,
    repetitionCooldown: candidate.repetitionCooldown,
    repeatKey: candidate.repeatKey,
    noveltySource: candidate.noveltySource,
    cueStatus: candidate.cueStatus ?? null,
  };
}

function previewViewing(viewing: VisualViewingConditions): VisualStatePreviewViewing {
  const band = (read: VisualComponentRead<string>): string =>
    read.status === "known" ? read.value : read.status;
  // Spelled out per component rather than walked over `Object.entries`: the
  // conditions object is a typed contract, and enumerating it loses the types
  // that make `declared` checkable at all.
  const declared: string[] = [];
  if (viewing.lighting.status === "known" && viewing.lighting.declared === true) declared.push("lighting");
  if (viewing.distance.status === "known" && viewing.distance.declared === true) declared.push("distance");
  if (viewing.angle.status === "known" && viewing.angle.declared === true) declared.push("angle");
  if (viewing.motion.status === "known" && viewing.motion.declared === true) declared.push("motion");
  return {
    lighting: band(viewing.lighting),
    distance: band(viewing.distance),
    angle: band(viewing.angle),
    motion: band(viewing.motion),
    declared,
  };
}

function previewDigestFact(fact: VisualImageFact): VisualStatePreviewDigestFact {
  return {
    key: fact.key,
    kindId: fact.kindId,
    locus: visualStateLocusKey(fact.locus),
    segmentKind: fact.segmentKind,
    required: fact.required,
  };
}

/**
 * Suppression reasons, tallied by code and ordered most-frequent first (ties
 * alphabetically, so the panel is stable across refreshes). The per-feature
 * lists above already carry every key; what a reader wants HERE is which
 * reasons account for the digest's silence.
 */
function previewDigestSuppressions(
  suppressions: readonly VisualStateSuppression[],
): VisualStatePreviewDigestSuppression[] {
  const counts = new Map<string, number>();
  for (const entry of suppressions) counts.set(entry.code, (counts.get(entry.code) ?? 0) + 1);
  return [...counts.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((left, right) => right.count - left.count || left.code.localeCompare(right.code, "en"));
}

function previewImageDigest(
  digest: VisualImageDigest,
  provenance: VisualImageProvenance,
): VisualStatePreviewImageDigest {
  return {
    cutId: digest.cutId,
    subjectCount: digest.subjectCount,
    snapshotFingerprint: digest.snapshotFingerprint,
    selectionFingerprint: digest.selectionFingerprint,
    cameraFingerprint: digest.cameraFingerprint,
    subjects: digest.subjects.map((subject) => ({
      subjectId: subject.subjectId,
      required: subject.required.map(previewDigestFact),
      optional: subject.optional.map(previewDigestFact),
      missingMandatory: subject.missingMandatory,
    })),
    requiredCount: digest.mandatoryFacts.length,
    optionalCount: digest.optionalFacts.length,
    missingMandatory: digest.subjects.flatMap((subject) => subject.missingMandatory),
    suppressionReasons: previewDigestSuppressions(digest.suppressions),
    provenance,
  };
}

/**
 * The degraded payload for a build that produced nothing: the diagnostics
 * carry why, everything else is honestly empty rather than a 500 — the
 * inspector's shape-heals-not-errors rule.
 */
export function degradedVisualStatePreviewPayload(input: {
  lane: "character_chat" | "successor";
  shadowFlagEnabled: boolean;
  diagnostics: readonly Diagnostic[];
}): VisualStatePreviewPayload {
  return {
    lane: input.lane,
    shadowFlagEnabled: input.shadowFlagEnabled,
    scopeKey: "",
    cutId: "",
    atMinutes: 0,
    subjects: [],
    features: [],
    composition: [],
    suppressions: [],
    staircase: [],
    viewing: { lighting: "unknown", distance: "unknown", angle: "unknown", motion: "unknown", declared: [] },
    narrator: {
      digests: [],
      noticeCount: 0,
      changeCount: 0,
      mentionCommitCount: 0,
      cueState: { sequenceAfter: 0, recordCount: 0, observedCount: 0, mentionCommitCount: 0 },
      suppressions: [],
    },
    image: { mandatoryKeys: [], optional: [], suppressedOptionalCount: 0, suppressions: [] },
    // No build means no cut to realize a digest over, and an empty digest here
    // would claim a moment that was never assembled. Absent, not fabricated.
    imageDigest: null,
    measurements: emptyVisualStateMeasurements(),
    diagnostics: input.diagnostics.map((entry) => ({
      severity: entry.severity,
      code: entry.code,
      message: entry.message,
    })),
  };
}

export function visualStatePreviewPayload(input: {
  build: VisualStateShadowBuild;
  shadowFlagEnabled: boolean;
  diagnostics: readonly Diagnostic[];
}): VisualStatePreviewPayload {
  const { build } = input;
  const { snapshot, narrator, image, staircase } = build;
  // Realized from the build's OWN snapshot, selection and camera context — the
  // one place both lanes' previews meet, so the chat and successor inspectors
  // show the digest on identical terms. No `forCutId`: the inspector realizes
  // the very cut it just assembled.
  const realized = visualStateImageDigestOfShadow(build);
  return {
    lane: build.lane,
    shadowFlagEnabled: input.shadowFlagEnabled,
    scopeKey: visualStateScopeKey(snapshot.scope),
    cutId: snapshot.cutId,
    atMinutes: snapshot.atMinutes,
    subjects: snapshot.subjects,
    features: snapshot.features.map(previewFeature),
    composition: snapshot.composition.entries.map((entry) => ({
      key: entry.key,
      effectiveVisibility: entry.effectiveVisibility,
      coverage: entry.coverage,
      occlusion: entry.occlusion,
      replacedBy: entry.replacedBy ?? null,
      modifiedBy: entry.modifiedBy,
      attachedTo: entry.attachedTo,
      derivedFrom: entry.derivedFrom,
    })),
    suppressions: previewSuppressions(snapshot.suppressions),
    staircase: staircase.candidates.map(previewCandidate),
    viewing: previewViewing(build.viewing),
    narrator: {
      digests: narrator.digests.map((digest) => ({
        subjectId: digest.subjectId,
        constraintKeys: digest.constraints.map((constraint) => constraint.key),
        selected: digest.selected.map((cue) => ({
          key: cue.key,
          reason: cue.reason,
          repeatKey: cue.repeatKey,
          priority: cue.priority,
        })),
        suppressedCount: digest.suppressedCount,
      })),
      noticeCount: narrator.notices.length,
      changeCount: narrator.changes.length,
      mentionCommitCount: narrator.mentionCommits.length,
      cueState: {
        sequenceAfter: narrator.cueStateAfterVisibility.sequence,
        recordCount: Object.keys(narrator.cueStateAfterVisibility.cues).length,
        observedCount: narrator.cueObservations.length,
        mentionCommitCount: narrator.cueMentionCommits.length,
      },
      suppressions: previewSuppressions(narrator.suppressions),
    },
    image: {
      mandatoryKeys: image.mandatory.map((feature) => feature.key),
      optional: image.optional.map(previewCandidate),
      suppressedOptionalCount: image.suppressedOptionalCount,
      suppressions: previewSuppressions(image.suppressions),
    },
    imageDigest: previewImageDigest(realized.digest, realized.provenance),
    measurements: build.measurements,
    diagnostics: input.diagnostics.map((entry) => ({
      severity: entry.severity,
      code: entry.code,
      message: entry.message,
    })),
  };
}
