import {
  visualStateLocusKey,
  visualStateScopeKey,
  visualStateSourceKey,
  type Diagnostic,
  type VisualAttentionCandidate,
  type VisualStateFeature,
  type VisualStateSuppression,
} from "@/contracts";
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

export interface VisualStatePreviewDiagnostic {
  readonly severity: string;
  readonly code: string;
  readonly message: string;
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
  readonly narrator: {
    readonly digests: readonly VisualStatePreviewDigest[];
    readonly noticeCount: number;
    readonly changeCount: number;
    readonly mentionCommitCount: number;
    readonly suppressions: readonly VisualStatePreviewSuppression[];
  };
  readonly image: {
    readonly mandatoryKeys: readonly string[];
    readonly optional: readonly VisualStatePreviewCandidate[];
    readonly suppressedOptionalCount: number;
    readonly suppressions: readonly VisualStatePreviewSuppression[];
  };
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
    narrator: { digests: [], noticeCount: 0, changeCount: 0, mentionCommitCount: 0, suppressions: [] },
    image: { mandatoryKeys: [], optional: [], suppressedOptionalCount: 0, suppressions: [] },
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
      suppressions: previewSuppressions(narrator.suppressions),
    },
    image: {
      mandatoryKeys: image.mandatory.map((feature) => feature.key),
      optional: image.optional.map(previewCandidate),
      suppressedOptionalCount: image.suppressedOptionalCount,
      suppressions: previewSuppressions(image.suppressions),
    },
    measurements: build.measurements,
    diagnostics: input.diagnostics.map((entry) => ({
      severity: entry.severity,
      code: entry.code,
      message: entry.message,
    })),
  };
}
