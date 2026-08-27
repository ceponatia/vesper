import { imagePromptSegmentKinds, type ImagePromptSegmentKind } from "@vesper/image-core";
import { z } from "zod";
import { parseOrNull } from "@/lib/parse";
import {
  affordanceEvidence,
  AFFORDANCE_UNIT_ONE,
  type AffordanceEvidence,
  type UnitInterval,
} from "../affordances/core";
import {
  isMandatoryVisualStateFact,
  selectVisualImageFacts,
  VISUAL_SELECTION_CONTEXT_MISMATCH,
  type VisualAttentionCandidate,
  type VisualAttentionContext,
  type VisualImageSelection,
} from "../affordances/recognition";
import type { AppearanceDetailTier } from "../appearance-features";
import { diag, type DiagnosticSink } from "../diagnostics";
import {
  visualStateFeaturesFingerprint,
  visualStateFingerprint,
  visualStateKindRegistry,
  visualStateScopeKey,
  visualStateSourceKey,
  VISUAL_STATE_APPEARANCE_ANATOMY_KIND_ID,
  VISUAL_STATE_INTIMATE_GATED,
  VISUAL_STATE_SPECIES_FEATURE_GROUP_KIND_ID,
  VISUAL_STATE_WARDROBE_GARMENT_KIND_ID,
  VISUAL_STATE_WARDROBE_ITEM_KIND_ID,
  type VisualAngleBand,
  type VisualComponentRead,
  type VisualDistanceBand,
  type VisualFramingBand,
  type VisualLightingBand,
  type VisualMotionBand,
  type VisualStateFeature,
  type VisualStateLayer,
  type VisualStateLocusRef,
  type VisualStateScopeRef,
  type VisualStateSnapshot,
  type VisualStateSourceRef,
  type VisualStateStability,
  type VisualStateSuppression,
  type VisualVisibilityContext,
} from "../visual-state";
import type { SceneCameraSpec, SceneShotDistanceId, SceneSubjectOrientationId } from "./scene-camera";

/**
 * The image digest — what one committed visual moment hands a character-bearing
 * render.
 *
 * This module realizes `VisualImageDigest` from three inputs it does not own:
 * the snapshot (the projection's committed cut), the camera-relative attention
 * context, and the camera's `VisualImageSelection` (the mandatory lane
 * plus scored optional candidates). It adds no truth and re-ranks nothing; it
 * flattens the selection into facts a render intent can consume, classifies
 * each fact by the prompt-segment kind its prose belongs to, and derives the
 * compact provenance record a render stores.
 *
 * ## Why it lives in `contracts/images` rather than `contracts/visual-state`
 *
 * The import direction slices 1 and 4 reserved — recognition consumes the
 * projection, never the reverse — puts the selection downstream of
 * `visual-state`, and this digest is downstream of the selection. It also
 * speaks `@vesper/image-core`'s segment vocabulary, which is an image-seam
 * concern the projection has no business knowing. So it sits beside the camera
 * vocabulary, at the seam the spec names ("image realization belongs at the
 * shared render intent seam").
 *
 * ## What the digest promises
 *
 * - **Mandatory facts do not compete with salience.** The required lane is the
 *   selection's mandatory lane verbatim — snapshot order, visibility bypassed,
 *   only the intimate-consent gate removes one (spec invariant 7).
 * - **Structured facts, never prose.** Each fact carries its key, fingerprint,
 *   preserved source reference, semantic value and tags; turning them into a
 *   model's dialect is the prompt compiler's job (image-lane-consolidation
 *   owns route cutover; image-render-quality owns dialects).
 * - **Deterministic.** The same snapshot, context and selection produce a
 *   byte-equal digest; the three fingerprints exist so a render's provenance
 *   can tell "same composition, retry it" from "current state moved".
 * - **Failure is silent and diagnosed, never partial-by-accident.** A stale
 *   cut, a selection built from a different snapshot, or a wrong-consumer
 *   context each fail the whole digest closed with one diagnostic plus
 *   per-feature suppressions; a mandatory fact the digest LOST (unknown kind,
 *   unusable locus) is reported as missing rather than papered over.
 */

// ---------------------------------------------------------------------------
// Diagnostic codes — declared here because this module is their only emitter
// ---------------------------------------------------------------------------

/**
 * A fact the snapshot marks mandatory could not reach the digest for a reason
 * that is degradation, not design (unknown kind, unusable locus). The digest is
 * still returned without it; the caller decides whether the render profile is
 * eligible at all: missing mandatory identity or morphology makes an image
 * profile ineligible rather than guessed. A consent-gated
 * exclusion is deliberately NOT this code — that absence is designed, final by
 * the conservative ruling, and already recorded as
 * `visual_state.intimate.gated`.
 */
export const VISUAL_DIGEST_MANDATORY_MISSING = "visual_state.digest.mandatory_missing";

/**
 * The snapshot describes a different committed cut than the render asked for.
 * Nothing is selected: a digest over the wrong cut would leak earlier or later
 * state into this render, which is the retake-isolation failure the plan
 * forbids.
 */
export const VISUAL_DIGEST_SNAPSHOT_STALE = "visual_state.digest.snapshot_stale";

/**
 * The selection was not built from this snapshot (different subjects, or a
 * selected key the snapshot does not hold). Nothing is selected — pairing a
 * selection with a foreign snapshot would fingerprint one moment while
 * describing another.
 */
export const VISUAL_DIGEST_SELECTION_MISMATCH = "visual_state.digest.selection_mismatch";

// ---------------------------------------------------------------------------
// Segment-kind classification — the seam vocabulary
// ---------------------------------------------------------------------------

/**
 * The attribute whose adapted feature is the apparent-age anchor
 * (`identity.apparent_age` in the attribute registry). The age anchor is an
 * owner ruling, not a preference, and `@vesper/image-core` promotes an `age`
 * segment to mandatory regardless of what a lane says — this classification is
 * what routes the fact into that protected kind. No appearance recognition
 * catalog entry projects it today, so the mapping is forward-looking: until an
 * owner projects age, routes keep sourcing their age anchor from the attribute
 * registry directly.
 */
export const VISUAL_IMAGE_AGE_ATTRIBUTE_ID = "identity.apparent_age";

const MORPHOLOGY_KIND_IDS: readonly string[] = [
  VISUAL_STATE_APPEARANCE_ANATOMY_KIND_ID,
  VISUAL_STATE_SPECIES_FEATURE_GROUP_KIND_ID,
];

const WARDROBE_KIND_IDS: readonly string[] = [
  VISUAL_STATE_WARDROBE_GARMENT_KIND_ID,
  VISUAL_STATE_WARDROBE_ITEM_KIND_ID,
];

/** The slice of a feature the classifier reads — every field a snapshot feature already carries. */
export type VisualImageClassifiableFeature = Pick<
  VisualStateFeature,
  "layer" | "kindId" | "sourceRef" | "priors"
>;

function isAgeAttributeSource(sourceRef: VisualStateSourceRef): boolean {
  return (
    sourceRef.kind === "appearance" &&
    sourceRef.ref.kind === "attribute" &&
    sourceRef.ref.attributeId === VISUAL_IMAGE_AGE_ATTRIBUTE_ID
  );
}

/**
 * Which prompt-segment kind one fact's prose belongs to — the typed bridge
 * between the projection's layers and `@vesper/image-core`'s closed segment
 * vocabulary. This classifies WHERE a fact is said, never whether it is
 * protected: required/optional stays a separate flag, and an optional identity
 * detail folding into a (mandatory) identity segment is coherent because
 * fitting drops whole segments and sentences, not facts.
 *
 * The choices this table settles:
 *
 * - anatomy and species feature groups are `morphology` — the lane the
 *   negative-prompt conflict checker reads;
 * - the apparent-age attribute is `age`, the owner-ruling-protected kind;
 * - a worn or carried piece is `wardrobe`; a garment left at a scene locus is
 *   `setting` — a jacket over a chair is scenery, not an outfit, and `setting`
 *   is droppable exactly as an optional garment fact is;
 * - non-item presentation and every current-layer fact are `current_state`.
 *   The segment vocabulary has no `presentation` member, and adding one is
 *   image-render-quality's registry decision, not this plan's (the slice-2
 *   `wig` precedent) — `current_state` is the non-mandatory kind whose meaning
 *   contains them;
 * - body language is `pose`.
 *
 * There is deliberately no `exposure` mapping: exposure is a coverage read
 * over the composition, not a projected feature, and the consolidation adapter
 * consumes the canonical garment coverage readout directly.
 */
export function visualImageFactSegmentKind(feature: VisualImageClassifiableFeature): ImagePromptSegmentKind {
  if (WARDROBE_KIND_IDS.includes(feature.kindId)) {
    return isMandatoryVisualStateFact(feature.priors) ? "wardrobe" : "setting";
  }
  switch (feature.layer) {
    case "identity":
      if (MORPHOLOGY_KIND_IDS.includes(feature.kindId)) return "morphology";
      if (isAgeAttributeSource(feature.sourceRef)) return "age";
      return "identity";
    case "presentation":
    case "current":
      return "current_state";
    case "body_language":
      return "pose";
  }
}

/** Which morphology family a fact belongs to, or `null` for a non-morphology fact. */
export function visualImageMorphologyOf(kindId: string): VisualImageMorphology | null {
  if (kindId === VISUAL_STATE_APPEARANCE_ANATOMY_KIND_ID) return "anatomy";
  if (kindId === VISUAL_STATE_SPECIES_FEATURE_GROUP_KIND_ID) return "species_feature_group";
  return null;
}

export type VisualImageMorphology = "anatomy" | "species_feature_group";

// ---------------------------------------------------------------------------
// Fact shapes
// ---------------------------------------------------------------------------

/**
 * Why this fact is in the digest.
 *
 * `identity_required` is the mandatory lane: the fact bypassed visibility, so
 * it carries no visibility factor or detail tier — a hidden anchor still holds
 * the generated character together. `camera_visible` is the optional lane,
 * carrying the camera's resolved read and its evidence trail.
 */
export type VisualImageFactVisibility =
  | { readonly basis: "identity_required"; readonly evidence: readonly AffordanceEvidence[] }
  | {
      readonly basis: "camera_visible";
      readonly visibility: UnitInterval;
      readonly detailTier: AppearanceDetailTier;
      readonly evidence: readonly AffordanceEvidence[];
    };

/**
 * One fact a render consumes: the feature's identity (key, fingerprint,
 * preserved source reference), its semantic value, its classification
 * (required flag and segment kind), and how the camera resolved it. Everything
 * a prompt compiler needs and nothing it may not have — no prose, no mention
 * state, no observer memory.
 */
export interface VisualImageFact {
  readonly key: string;
  readonly subjectId: string;
  readonly kindId: string;
  readonly layer: VisualStateLayer;
  readonly locus: VisualStateLocusRef;
  /** The owner's provenance, verbatim — the preserved source key the consolidation plan requires. */
  readonly sourceRef: VisualStateSourceRef;
  /** The same provenance as the flat diagnostic-form string. */
  readonly sourceKey: string;
  readonly value: unknown;
  readonly truthFingerprint: string;
  readonly semanticTags: readonly string[];
  readonly stability: VisualStateStability;
  /** Mandatory-lane facts; prompt fitting may never demote one to optional. */
  readonly required: boolean;
  readonly segmentKind: ImagePromptSegmentKind;
  readonly visibility: VisualImageFactVisibility;
  /** The selection priority for an optional fact; unit one for a required one. */
  readonly priority: UnitInterval;
  readonly changedAtMinutes?: number;
}

/** A morphology fact — the subset the negative-prompt conflict checker reads. */
export interface VisualMorphologyFact extends VisualImageFact {
  readonly morphology: VisualImageMorphology;
}

// ---------------------------------------------------------------------------
// Camera facts
// ---------------------------------------------------------------------------

/**
 * One resolved camera condition, as a typed fact rather than a pseudo-feature:
 * a camera read has no owner, key, or fingerprint, and minting one would
 * fabricate provenance. Only KNOWN reads produce facts — an unknown read has
 * already failed the optional lane closed and has nothing honest to assert.
 */
export type VisualImageCameraFact =
  | { readonly component: "framing"; readonly band: VisualFramingBand; readonly segmentKind: "framing" }
  | { readonly component: "distance"; readonly band: VisualDistanceBand; readonly segmentKind: "framing" }
  | { readonly component: "angle"; readonly band: VisualAngleBand; readonly segmentKind: "framing" }
  | { readonly component: "motion"; readonly band: VisualMotionBand; readonly segmentKind: "pose" }
  | { readonly component: "lighting"; readonly band: VisualLightingBand; readonly segmentKind: "lighting" };

function knownBand<TValue>(read: VisualComponentRead<TValue> | undefined): TValue | undefined {
  return read !== undefined && read.status === "known" ? read.value : undefined;
}

/**
 * The camera facts one context asserts, in a fixed order that mirrors the
 * segment vocabulary's canonical emission order (framing before pose before
 * lighting).
 */
export function visualImageCameraFacts(context: VisualVisibilityContext): readonly VisualImageCameraFact[] {
  const facts: VisualImageCameraFact[] = [];
  const framing = knownBand(context.framing);
  if (framing !== undefined) facts.push({ component: "framing", band: framing, segmentKind: "framing" });
  const distance = knownBand(context.distance);
  if (distance !== undefined) facts.push({ component: "distance", band: distance, segmentKind: "framing" });
  const angle = knownBand(context.angle);
  if (angle !== undefined) facts.push({ component: "angle", band: angle, segmentKind: "framing" });
  const motion = knownBand(context.motion);
  if (motion !== undefined) facts.push({ component: "motion", band: motion, segmentKind: "pose" });
  const lighting = knownBand(context.lighting);
  if (lighting !== undefined) facts.push({ component: "lighting", band: lighting, segmentKind: "lighting" });
  return facts;
}

function componentFingerprintInput<TValue>(read: VisualComponentRead<TValue> | undefined): unknown {
  if (read === undefined) return null;
  return read.status === "known" ? { status: "known", value: read.value } : { status: read.status };
}

/**
 * A deterministic fingerprint over everything the camera asserts — viewpoint,
 * the five component reads (unknown and invalid included, so a degraded read
 * fingerprints differently from a bright one), and the consent allowance.
 * Selection-side inputs (action loci, boosts, budgets) are deliberately
 * excluded: their effect is already captured by the selection fingerprint.
 */
export function visualImageCameraFingerprint(context: VisualVisibilityContext): string {
  return visualStateFingerprint({
    viewpoint: context.viewpoint,
    lighting: componentFingerprintInput(context.lighting),
    distance: componentFingerprintInput(context.distance),
    angle: componentFingerprintInput(context.angle),
    motion: componentFingerprintInput(context.motion),
    framing: componentFingerprintInput(context.framing),
    intimateAllowed: context.intimateAllowed === true,
  });
}

// ---------------------------------------------------------------------------
// Scene-camera reads — the pure mapping a scene-image cutover will use
// ---------------------------------------------------------------------------

/** The component reads a committed scene camera can honestly assert. */
export interface VisualSceneCameraReads {
  readonly distance: VisualComponentRead<VisualDistanceBand>;
  readonly angle: VisualComponentRead<VisualAngleBand>;
  readonly framing: VisualComponentRead<VisualFramingBand>;
}

function distanceBandOfShot(distance: SceneShotDistanceId): VisualDistanceBand {
  switch (distance) {
    case "close":
    case "medium":
      return "close";
    case "full_figure":
      return "near";
    case "wide":
      return "distant";
  }
}

function framingBandOfShot(distance: SceneShotDistanceId): VisualFramingBand {
  switch (distance) {
    case "close":
      return "portrait";
    case "medium":
      return "waist_up";
    case "full_figure":
      return "full_figure";
    case "wide":
      return "wide";
  }
}

function angleBandOfOrientation(orientation: SceneSubjectOrientationId): VisualAngleBand {
  switch (orientation) {
    case "toward_viewer":
    case "three_quarter":
      return "toward";
    case "profile":
      return "side_on";
    case "away_glance_back":
    case "away":
      return "away";
  }
}

/**
 * What a committed scene camera can assert about visibility: distance, angle
 * and framing, all derived from the camera registry's own vocabulary through
 * exhaustive switches (a new registry member is a compile error here, not a
 * silent default).
 *
 * Lighting and motion are deliberately ABSENT: the scene camera proves where
 * the frame is, not what the light does, and no production owner asserts
 * either as typed data. A caller that cannot assert them passes unknown reads
 * and the optional lane fails closed — the intended shadow behavior.
 */
export function visualCameraReadsOfSceneCamera(camera: SceneCameraSpec): VisualSceneCameraReads {
  return {
    distance: { status: "known", value: distanceBandOfShot(camera.distance) },
    angle: { status: "known", value: angleBandOfOrientation(camera.orientation) },
    framing: { status: "known", value: framingBandOfShot(camera.distance) },
  };
}

// ---------------------------------------------------------------------------
// The digest
// ---------------------------------------------------------------------------

/** One rendered subject's slice of the digest. */
export interface VisualImageSubjectDigest {
  readonly subjectId: string;
  /** The mandatory lane, in snapshot order. */
  readonly required: readonly VisualImageFact[];
  /** Camera-visible optional detail, best first, already within budget. */
  readonly optional: readonly VisualImageFact[];
  /** The morphology subset of both lanes — the negative-prompt checker's input. */
  readonly morphology: readonly VisualMorphologyFact[];
  /**
   * Keys of facts the snapshot mandates that the digest LOST to degradation.
   * Non-empty means the profile-eligibility decision is the caller's to make;
   * consent-gated exclusions are designed absences and never appear here.
   */
  readonly missingMandatory: readonly string[];
}

/**
 * The image digest over one committed cut. Everything a character-bearing
 * render consumes from visual state, plus the three fingerprints its
 * provenance stores.
 */
export interface VisualImageDigest {
  readonly version: 1;
  readonly scope: VisualStateScopeRef;
  readonly cutId: string;
  readonly atMinutes: number;
  readonly snapshotVersion: 1;
  /** Digest over the snapshot's FULL ordered feature list — "is this the same visual moment?". */
  readonly snapshotFingerprint: string;
  /** Digest over the SELECTED facts in digest order — "is this the same composition?". */
  readonly selectionFingerprint: string;
  /** Fingerprint of everything the camera asserted. */
  readonly cameraFingerprint: string;
  readonly subjects: readonly VisualImageSubjectDigest[];
  readonly subjectCount: number;
  /** Every subject's mandatory lane, in snapshot order. */
  readonly mandatoryFacts: readonly VisualImageFact[];
  /** Every subject's optional lane, best first, within the selection's budget. */
  readonly optionalFacts: readonly VisualImageFact[];
  /** The morphology subset across subjects, mandatory lane first. */
  readonly intendedMorphology: readonly VisualMorphologyFact[];
  readonly cameraFacts: readonly VisualImageCameraFact[];
  /** Everything the selection or this digest excluded, and why. */
  readonly suppressions: readonly VisualStateSuppression[];
}

export interface VisualImageDigestInput {
  readonly snapshot: VisualStateSnapshot;
  /** Must carry `consumer: "image"` and a camera (or debug) viewpoint. */
  readonly context: VisualAttentionContext;
  /** The camera selection built from the SAME snapshot and context. */
  readonly selection: VisualImageSelection;
  /** The committed cut this render is for; a different snapshot fails closed. */
  readonly forCutId?: string;
  readonly sink?: DiagnosticSink;
}

const DIGEST_PATH = "visual_state.digest";

function wholeMinutes(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function suppressedSnapshot(
  snapshot: VisualStateSnapshot,
  code: string,
  detail: string,
): readonly VisualStateSuppression[] {
  return snapshot.features.map((feature) => ({ key: feature.key, code, detail }));
}

/** The fail-closed empty digest: fingerprints still identify the refused inputs. */
function emptyDigest(
  snapshot: VisualStateSnapshot,
  context: VisualAttentionContext,
  suppressions: readonly VisualStateSuppression[],
): VisualImageDigest {
  return {
    version: 1,
    scope: snapshot.scope,
    cutId: snapshot.cutId,
    atMinutes: wholeMinutes(snapshot.atMinutes),
    snapshotVersion: snapshot.version,
    snapshotFingerprint: visualStateFeaturesFingerprint(snapshot.features),
    selectionFingerprint: visualStateFeaturesFingerprint([]),
    cameraFingerprint: visualImageCameraFingerprint(context),
    subjects: snapshot.subjects.map((subjectId) => ({
      subjectId,
      required: [],
      optional: [],
      morphology: [],
      missingMandatory: [],
    })),
    subjectCount: snapshot.subjects.length,
    mandatoryFacts: [],
    optionalFacts: [],
    intendedMorphology: [],
    cameraFacts: visualImageCameraFacts(context),
    suppressions,
  };
}

/** The fields both lanes copy verbatim from the feature. */
function factFieldsOf(feature: VisualStateFeature): Omit<VisualImageFact, "required" | "visibility" | "priority"> {
  return {
    key: feature.key,
    subjectId: feature.subjectId,
    kindId: feature.kindId,
    layer: feature.layer,
    locus: feature.locus,
    sourceRef: feature.sourceRef,
    sourceKey: visualStateSourceKey(feature.sourceRef),
    value: feature.value,
    truthFingerprint: feature.truthFingerprint,
    semanticTags: feature.semanticTags,
    stability: feature.stability,
    segmentKind: visualImageFactSegmentKind(feature),
    ...(feature.changedAtMinutes === undefined ? {} : { changedAtMinutes: feature.changedAtMinutes }),
  };
}

function requiredFactOf(feature: VisualStateFeature): VisualImageFact {
  return {
    ...factFieldsOf(feature),
    required: true,
    visibility: {
      basis: "identity_required",
      evidence: [...feature.evidence, affordanceEvidence("adapter", DIGEST_PATH, "identity_required")],
    },
    priority: AFFORDANCE_UNIT_ONE,
  };
}

function optionalFactOf(candidate: VisualAttentionCandidate): VisualImageFact {
  return {
    ...factFieldsOf(candidate.feature),
    required: false,
    visibility: {
      basis: "camera_visible",
      visibility: candidate.visibility,
      detailTier: candidate.detailTier,
      evidence: candidate.evidence,
    },
    priority: candidate.priority,
  };
}

function morphologyFactsOf(facts: readonly VisualImageFact[]): VisualMorphologyFact[] {
  const morphology: VisualMorphologyFact[] = [];
  for (const fact of facts) {
    const family = visualImageMorphologyOf(fact.kindId);
    if (family !== null) morphology.push({ ...fact, morphology: family });
  }
  return morphology;
}

function sameSubjects(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((subject, index) => subject === right[index]);
}

/**
 * Realize the image digest from a snapshot, its camera context, and the
 * selection built over them.
 *
 * Three fail-closed gates run first, each with one diagnostic plus per-feature
 * suppressions: the consumer/viewpoint guard (mirroring the selection's own),
 * the committed-cut guard (`forCutId`), and the selection-consistency guard
 * (the selection must name this snapshot's subjects and only its keys).
 *
 * Past the gates, the digest is a flattening, not a decision: the mandatory
 * lane is the selection's, in snapshot order; the optional lane is the
 * selection's, best first; the missing-mandatory report compares what the
 * snapshot mandates against what the mandatory lane kept, excusing only the
 * consent gate.
 */
export function realizeVisualImageDigest(input: VisualImageDigestInput): VisualImageDigest {
  const { snapshot, context, selection } = input;
  const sink = input.sink;

  if (context.consumer !== "image" || context.viewpoint.kind === "observer") {
    const detail = context.consumer !== "image" ? `consumer:${context.consumer}` : "viewpoint:observer";
    sink?.push(
      diag("warn", VISUAL_SELECTION_CONTEXT_MISMATCH, "The image digest needs an image consumer and a camera viewpoint", {
        path: DIGEST_PATH,
        context: { detail },
      }),
    );
    return emptyDigest(snapshot, context, suppressedSnapshot(snapshot, VISUAL_SELECTION_CONTEXT_MISMATCH, detail));
  }

  if (input.forCutId !== undefined && input.forCutId !== snapshot.cutId) {
    sink?.push(
      diag("warn", VISUAL_DIGEST_SNAPSHOT_STALE, "The snapshot describes a different committed cut than this render", {
        path: DIGEST_PATH,
        context: { snapshotCut: snapshot.cutId, forCut: input.forCutId },
      }),
    );
    return emptyDigest(
      snapshot,
      context,
      suppressedSnapshot(snapshot, VISUAL_DIGEST_SNAPSHOT_STALE, `cut:${input.forCutId}`),
    );
  }

  const snapshotKeys = new Set(snapshot.features.map((feature) => feature.key));
  const selectedKeys = [
    ...selection.mandatory.map((feature) => feature.key),
    ...selection.optional.map((candidate) => candidate.feature.key),
  ];
  const foreignKey = selectedKeys.find((key) => !snapshotKeys.has(key));
  if (!sameSubjects(selection.subjects, snapshot.subjects) || foreignKey !== undefined) {
    const detail = foreignKey === undefined ? "subjects" : `key:${foreignKey}`;
    sink?.push(
      diag("warn", VISUAL_DIGEST_SELECTION_MISMATCH, "The selection was not built from this snapshot", {
        path: DIGEST_PATH,
        context: { detail },
      }),
    );
    return emptyDigest(snapshot, context, suppressedSnapshot(snapshot, VISUAL_DIGEST_SELECTION_MISMATCH, detail));
  }

  const mandatoryFacts = selection.mandatory.map(requiredFactOf);
  const optionalFacts = selection.optional.map(optionalFactOf);
  const intendedMorphology = [...morphologyFactsOf(mandatoryFacts), ...morphologyFactsOf(optionalFacts)];

  // The missing-mandatory report: what the snapshot mandates, minus what the
  // mandatory lane kept, minus designed absences (an image-ineligible kind, a
  // consent-gated locus). What remains was lost to degradation, and the caller
  // must be able to see it before spending a render on an incomplete person.
  const keptMandatory = new Set(selection.mandatory.map((feature) => feature.key));
  const firstSuppressionByKey = new Map<string, VisualStateSuppression>();
  for (const suppression of selection.suppressions) {
    if (!firstSuppressionByKey.has(suppression.key)) firstSuppressionByKey.set(suppression.key, suppression);
  }
  const missingBySubject = new Map<string, string[]>();
  for (const feature of snapshot.features) {
    if (!isMandatoryVisualStateFact(feature.priors)) continue;
    if (keptMandatory.has(feature.key)) continue;
    const kind = visualStateKindRegistry.byId(feature.kindId);
    if (kind !== undefined && !kind.imageEligible) continue; // designed absence, silent
    if (firstSuppressionByKey.get(feature.key)?.code === VISUAL_STATE_INTIMATE_GATED) continue; // consent-designed
    const missing = missingBySubject.get(feature.subjectId) ?? [];
    missing.push(feature.key);
    missingBySubject.set(feature.subjectId, missing);
    sink?.push(
      diag("warn", VISUAL_DIGEST_MANDATORY_MISSING, "A mandatory visual fact could not reach the render digest", {
        path: DIGEST_PATH,
        context: { key: feature.key, kindId: feature.kindId },
      }),
    );
  }

  const subjects: VisualImageSubjectDigest[] = snapshot.subjects.map((subjectId) => {
    const required = mandatoryFacts.filter((fact) => fact.subjectId === subjectId);
    const optional = optionalFacts.filter((fact) => fact.subjectId === subjectId);
    return {
      subjectId,
      required,
      optional,
      morphology: [...morphologyFactsOf(required), ...morphologyFactsOf(optional)],
      missingMandatory: missingBySubject.get(subjectId) ?? [],
    };
  });

  return {
    version: 1,
    scope: snapshot.scope,
    cutId: snapshot.cutId,
    atMinutes: wholeMinutes(snapshot.atMinutes),
    snapshotVersion: snapshot.version,
    snapshotFingerprint: visualStateFeaturesFingerprint(snapshot.features),
    selectionFingerprint: visualStateFeaturesFingerprint([
      ...selection.mandatory,
      ...selection.optional.map((candidate) => candidate.feature),
    ]),
    cameraFingerprint: visualImageCameraFingerprint(context),
    subjects,
    subjectCount: snapshot.subjects.length,
    mandatoryFacts,
    optionalFacts,
    intendedMorphology,
    cameraFacts: visualImageCameraFacts(context),
    suppressions: selection.suppressions,
  };
}

export interface VisualImageDigestBuildInput {
  readonly snapshot: VisualStateSnapshot;
  readonly context: VisualAttentionContext;
  /** Optional facts kept at most; the selection's default applies when absent. */
  readonly optionalBudget?: number;
  readonly forCutId?: string;
  readonly sink?: DiagnosticSink;
}

/**
 * The one-call form: run the camera selection and realize the digest from it.
 * A caller that already holds the selection (the inspector, showing the whole
 * staircase) uses {@link realizeVisualImageDigest} directly.
 */
export function buildVisualImageDigest(input: VisualImageDigestBuildInput): VisualImageDigest {
  const selection = selectVisualImageFacts({
    snapshot: input.snapshot,
    context: input.context,
    ...(input.optionalBudget === undefined ? {} : { optionalBudget: input.optionalBudget }),
    ...(input.sink === undefined ? {} : { sink: input.sink }),
  });
  return realizeVisualImageDigest({
    snapshot: input.snapshot,
    context: input.context,
    selection,
    ...(input.forCutId === undefined ? {} : { forCutId: input.forCutId }),
    ...(input.sink === undefined ? {} : { sink: input.sink }),
  });
}

// ---------------------------------------------------------------------------
// Provenance — what a render stores
// ---------------------------------------------------------------------------

/**
 * The key a render row's `meta` files visual provenance under, beside the
 * package-owned `meta.render` attempt record. App-owned on purpose: the
 * package knows nothing of characters or snapshots, so its provenance and this
 * one are siblings, never merged.
 */
export const VISUAL_IMAGE_PROVENANCE_META_KEY = "visualState";

const provenanceSelectionSchema = z.object({
  key: z.string().min(1),
  truthFingerprint: z.string().min(1),
  required: z.boolean(),
  segmentKind: z.enum(imagePromptSegmentKinds),
});

const provenanceSubjectSchema = z.object({
  subjectId: z.string().min(1),
  selected: z.array(provenanceSelectionSchema),
});

const provenanceSuppressionSchema = z.object({
  key: z.string().min(1),
  code: z.string().min(1),
  detail: z.string().min(1).optional(),
});

/**
 * The wire shape of {@link VisualImageProvenance}. Non-strict on purpose: a
 * later field addition must not turn every older row into "no provenance".
 */
export const visualImageProvenanceSchema = z.object({
  version: z.literal(1),
  /** The flat scope key (`visualStateScopeKey`) — identifying, never parsed back into parts. */
  scopeKey: z.string().min(1),
  cutId: z.string().min(1),
  atMinutes: z.number().int().min(0),
  snapshotFingerprint: z.string().min(1),
  selectionFingerprint: z.string().min(1),
  cameraFingerprint: z.string().min(1),
  subjects: z.array(provenanceSubjectSchema),
  suppressions: z.array(provenanceSuppressionSchema),
});

/**
 * The compact visual provenance a render stores:
 * identifiers and fingerprints only, never a second copy of source values.
 * Enough to answer, for a stored image, WHICH visual moment produced it and
 * WHAT was selected before provider execution — and, via the fingerprints,
 * whether a retry is "same composition" or "current state moved".
 */
export type VisualImageProvenance = z.infer<typeof visualImageProvenanceSchema>;

/** Derive the stored provenance record from a digest. Pure and total. */
export function visualImageProvenanceOf(digest: VisualImageDigest): VisualImageProvenance {
  return {
    version: 1,
    scopeKey: visualStateScopeKey(digest.scope),
    cutId: digest.cutId,
    atMinutes: digest.atMinutes,
    snapshotFingerprint: digest.snapshotFingerprint,
    selectionFingerprint: digest.selectionFingerprint,
    cameraFingerprint: digest.cameraFingerprint,
    subjects: digest.subjects.map((subject) => ({
      subjectId: subject.subjectId,
      selected: [...subject.required, ...subject.optional].map((fact) => ({
        key: fact.key,
        truthFingerprint: fact.truthFingerprint,
        required: fact.required,
        segmentKind: fact.segmentKind,
      })),
    })),
    suppressions: digest.suppressions.map((suppression) => ({
      key: suppression.key,
      code: suppression.code,
      ...(suppression.detail === undefined ? {} : { detail: suppression.detail }),
    })),
  };
}

/**
 * The trust boundary for stored provenance: a persisted `meta.visualState`
 * value becomes a validated record or `null` (docs/resilience.md §1). Old rows
 * and malformed values degrade to ABSENT provenance, never fabricated
 * provenance.
 */
export function parseVisualImageProvenance(
  raw: unknown,
  sink?: DiagnosticSink,
  path = `${DIGEST_PATH}.provenance`,
): VisualImageProvenance | null {
  return parseOrNull(visualImageProvenanceSchema, raw, sink, path);
}
