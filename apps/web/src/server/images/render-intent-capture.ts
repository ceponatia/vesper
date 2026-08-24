import {
  type ImageProfileOperation,
  type ImageProfileTask,
  type ImagePromptStrategy,
  type ImageReferenceRole,
  type ImageRenderIntent,
  type ImageRenderRefusal,
  type ImageRenderRuntimeFacts,
  planImageRender,
} from "@vesper/image-core";
import {
  parseVisualImageProvenance,
  VISUAL_IMAGE_PROVENANCE_META_KEY,
} from "@/contracts";
import type { DiagnosticSink } from "@/contracts/diagnostics";
import { sha256Hex } from "./render-fingerprint";

/**
 * THE render-intent transport capture (image-lane-consolidation.spec.prompts.md
 * §Characterization and comparison: "The transport half of the capture … is not
 * built; it belongs with the render intent Stage 3 starts comparing").
 *
 * The Stage 1 harness froze the CHARACTER-FACT half of every lane; this module
 * captures the TRANSPORT half — what a lane's request would actually configure
 * a provider with — as one plain, serializable, stably-keyed record. The
 * legacy-vs-digest comparison (`lane-cutover-comparison.test.ts`) reads two of
 * these off the same fixture and asserts that a cutover moved the WORDING and
 * nothing else: same task, profile, strategy, model, reference roles in send
 * order, target shape and controls, with the prompt hashes present on both
 * sides but deliberately not compared (changing the text is the migration's
 * purpose).
 *
 * It is the image-lab baseline's plan-first pattern with no provider IO at all:
 * `planImageRender` is pure, so compiling the plan is how the capture reads the
 * strategy-compiled prompt, the resolved negative, and the roles actually going
 * — a capture of the caller's inputs instead would record a render that never
 * happens. Everything captured is seed-independent (nothing here draws one;
 * seeds enter only in `renderImageIntent`), which is what makes two captures of
 * one configuration byte-comparable.
 *
 * The digest half rides the lane's own reserve-time meta fragment: the
 * `meta.visualState` provenance (parsed at the trust boundary, absent for a
 * legacy build) contributes the REQUIRED character-fact keys and the camera
 * fingerprint, so a route-specific fact gained or lost by a cutover shows up as
 * a changed key set rather than a wording diff.
 *
 * The controls half is the plan's own provenance vocabulary — `appliedControls`
 * and `droppedControls`, exactly what `ResolvedImageAttempt` stores. The
 * identity-trial `profileRenderControlsFingerprintJson` is deliberately NOT
 * folded in: it fingerprints a `ProfileRenderPlan` the render-intent path does
 * not surface, and types its reference roles in the identity-pack vocabulary,
 * so composing it here would mean a second compile and an unsound role cast.
 */

/** One comparable record of what a render intent would send. Plain data, stable key order, no bytes. */
export interface RenderIntentCapture {
  readonly task: ImageProfileTask;
  readonly profileId: string;
  readonly promptStrategy: ImagePromptStrategy;
  readonly modelSlug: string;
  /** The caller's explicit pin; null for a production render following the floating latest. */
  readonly requestedVersionId: string | null;
  /** The operation the LANE is requesting — supplied by the caller, beside the profile's own. */
  readonly requestedOperation: ImageProfileOperation;
  /** Hex sha256 of the strategy-compiled final prompt — presence is comparable, bytes are not. */
  readonly promptHash: string;
  /** Hex sha256 of the resolved negative that would accompany it, or null when none goes. */
  readonly negativeHash: string | null;
  /** Primary reference roles in SEND order — the plan's selection, not the caller's list. */
  readonly referenceRoles: readonly ImageReferenceRole[];
  /** The requested shape as a ratio, or null when the render asked for the model's own. */
  readonly targetAspect: number | null;
  /** The subjects this render depicts, in the lane's own order. */
  readonly subjectIds: readonly string[];
  /**
   * The REQUIRED character-fact keys from the digest provenance
   * (`meta.visualState` subjects[].selected[] where required), sorted. Empty for
   * a legacy build, which carries no digest — the comparison reads that as "the
   * facts ride the prompt text alone".
   */
  readonly requiredFactKeys: readonly string[];
  /** The provenance's camera fingerprint — the framing/viewpoint identity — or null without a digest. */
  readonly cameraFingerprint: string | null;
  /** The normalized controls that would reach the provider payload (the plan's own record). */
  readonly appliedControls: Record<string, unknown>;
  /** Every control that would not, each with its reason. */
  readonly droppedControls: readonly { control: string; reason: string }[];
}

export interface RenderIntentCaptureInput {
  /** The intent exactly as the lane would hand it to `renderImageIntent`. */
  readonly intent: ImageRenderIntent;
  /** The deployment facts the plan compiles under — explicit, so a capture never guesses a safety posture. */
  readonly runtime: ImageRenderRuntimeFacts;
  readonly requestedOperation: ImageProfileOperation;
  readonly subjectIds: readonly string[];
  /**
   * The lane's reserve-time meta fragment (`digestMeta` from the segment
   * assemblies), whose `visualState` key carries the digest provenance. Omit for
   * a legacy build; a malformed value degrades to absent provenance via the
   * parser, never to fabricated keys.
   */
  readonly digestMeta?: Record<string, unknown>;
  readonly sink?: DiagnosticSink;
}

/** A capture, or the plan's own refusal — a configuration the lane could not have rendered either. */
export type CaptureRenderIntentResult =
  | { ok: true; capture: RenderIntentCapture }
  | { ok: false; refusal: ImageRenderRefusal };

/** The sorted required-fact keys the provenance names, or none without a digest. */
function requiredFactKeysOf(digestMeta: Record<string, unknown> | undefined, sink?: DiagnosticSink): {
  requiredFactKeys: string[];
  cameraFingerprint: string | null;
} {
  const provenance =
    digestMeta === undefined
      ? null
      : parseVisualImageProvenance(digestMeta[VISUAL_IMAGE_PROVENANCE_META_KEY], sink);
  if (provenance === null) return { requiredFactKeys: [], cameraFingerprint: null };
  const keys = provenance.subjects.flatMap((subject) =>
    subject.selected.filter((selection) => selection.required).map((selection) => selection.key),
  );
  return { requiredFactKeys: [...new Set(keys)].sort(), cameraFingerprint: provenance.cameraFingerprint };
}

/**
 * Capture one intent's comparable transport record, with no provider IO.
 * Deterministic over its inputs; a refused plan is returned as the refusal
 * rather than a partial record, because a configuration that cannot compile has
 * no transport to compare.
 */
export function captureRenderIntent(input: RenderIntentCaptureInput): CaptureRenderIntentResult {
  const planned = planImageRender(input.intent, input.runtime, input.sink);
  if (!planned.ok) return { ok: false, refusal: planned.refusal };
  const { plan } = planned;
  const { profile, model } = input.intent.profile;
  const digest = requiredFactKeysOf(input.digestMeta, input.sink);
  return {
    ok: true,
    capture: {
      task: profile.task,
      profileId: profile.id,
      promptStrategy: profile.promptStrategy,
      modelSlug: model.slug,
      requestedVersionId: input.intent.versionId ?? null,
      requestedOperation: input.requestedOperation,
      promptHash: sha256Hex(plan.prompt),
      negativeHash: plan.negativePrompt === null ? null : sha256Hex(plan.negativePrompt),
      referenceRoles: plan.sentReferences.map((reference) => reference.role),
      targetAspect: plan.targetRatio,
      subjectIds: [...input.subjectIds],
      requiredFactKeys: digest.requiredFactKeys,
      cameraFingerprint: digest.cameraFingerprint,
      appliedControls: plan.appliedControls,
      droppedControls: plan.droppedControls,
    },
  };
}
