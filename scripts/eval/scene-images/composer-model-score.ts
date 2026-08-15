import type { DiagnosticCollector } from "@/contracts/diagnostics";
import type { SceneCameraSpec } from "@/contracts/images/scene-camera";
import type { SceneStagingId } from "@/contracts/images/scene-staging";
import type { ViewerBodyPartId } from "@/contracts/images/viewer-body";
import {
  emptySceneSpec,
  resolveScenePlan,
  type SceneComposerContext,
  type SceneSpec,
  scrubBlush,
} from "@/server/images";

/**
 * The **grader** for the composer-model A/B (`composer-model-ab.ts`) — pure, so it lives in
 * its own module and is covered by `pnpm test` (`composer-model-score.test.ts`). A grader
 * nobody tests is an instrument nobody can trust, and this one decides whether the app moves
 * off a $3/M model.
 *
 * ## Why the composer can be graded in code at all
 *
 * Every other probe in this folder is human-scored, because an image is. The composer's
 * output is a **structured spec**, and almost everything that makes one good is already
 * checkable: the camera and staging are registry ids with a known right answer per fixture
 * beat; the evidence quotes are verified verbatim against the transcript by the production
 * resolver; the roster clamps and the skin-colour scrub are deterministic passes the
 * pipeline already runs. So the grade is mostly "what survived the REAL gates", not a second
 * opinion about them.
 *
 * That is the load-bearing design decision here: **scoring runs the spec through
 * `resolveScenePlan`**, the same function production calls, rather than re-implementing its
 * rules. A model cannot pass this grader by satisfying a paraphrase of the pipeline.
 *
 * The one genuinely subjective axis — is the prose concrete enough to paint? — is NOT
 * silently folded into the number. It is a single named check with a documented signature
 * (see {@link VAGUE_SIGNATURES}), and the full prose is printed for eyeballing regardless.
 */

/** What a beat's story actually establishes — the right answer the arms are graded against. */
export interface ComposerExpectation {
  /**
   * Camera ids the composer must propose. Stated ONLY for unstaged beats: a surviving
   * staging's camera outranks the composer's (`resolveScenePlan`), so grading the camera on
   * a staged beat would grade the registry rather than the model.
   */
  camera?: SceneCameraSpec;
  /** The staging the story explicitly describes; absent when the beat stages nothing. */
  stagingId?: SceneStagingId;
  /**
   * Viewer parts the narration genuinely grounds — every one must survive the real evidence
   * gate. Empty means "nothing is REQUIRED here"; it never means "proposing one is wrong",
   * because a grounded extra part is a legitimate reading of the same beat. What IS wrong is
   * an *ungrounded* part, and that is caught by {@link ComposerChecks.groundedParts}
   * regardless of what this list says.
   */
  viewerBody: readonly ViewerBodyPartId[];
  /** The roster name the shot must center on. */
  focalName: string;
}

/**
 * The vagueness signature, quoted from the failure this whole plan exists to fix: the
 * composer reads the most explicit stretch of a chat and answers with "on the bed, close to
 * the viewer" / "intimate with the viewer" (owner report 2026-08-10, and the exact pose and
 * activity strings the shipped intimate fixtures carry as the `old` arm's spec).
 *
 * Deliberately a SHORT list of that documented signature rather than a general
 * "is this prose good?" heuristic: a fuzzy readability score would quietly become the thing
 * the arms are ranked on, and it would be a measure nobody agreed to. These phrases are
 * hedges that name no body configuration at all, which is precisely why the render came back
 * as a nude portrait instead of an act.
 */
export const VAGUE_SIGNATURES: readonly RegExp[] = [
  /\bintimate with the viewer\b/i,
  /\bclose to the viewer\b/i,
  /\bbeing intimate\b/i,
  /\bin an intimate (?:moment|position|pose|embrace)\b/i,
  /\bin a compromising position\b/i,
  /\bengaged in intimacy\b/i,
];

/** One boolean per graded axis. `null` ⇒ this beat does not grade that axis. */
export interface ComposerChecks {
  /** The model produced a usable spec at all — not a refusal, a transport failure, or all-defaults. */
  answered: boolean;
  /** The shot centers on the roster member the story centers on, with no focal clamp. */
  focal: boolean | null;
  /** The proposed camera survived the evidence gate as the ids the story establishes. */
  camera: boolean | null;
  /** The staging the story explicitly describes survived every gate. */
  staging: boolean | null;
  /** Every expected viewer part was proposed. */
  viewerBody: boolean | null;
  /** Nothing the composer proposed was invented: no ungrounded, off-vocabulary or unrequested part. */
  groundedParts: boolean;
  /** No character invented into the frame. */
  noInventedCast: boolean;
  /** No skin-colour word survived into prose the render prompt would carry. */
  noBannedWords: boolean;
  /** The pose/activity name a body configuration rather than hedging (see {@link VAGUE_SIGNATURES}). */
  concrete: boolean;
}

export interface ComposerGrade {
  checks: ComposerChecks;
  /** Graded checks passed / graded checks applicable, 0–1. A refusal is 0 by construction. */
  score: number;
  /** Diagnostic codes the production resolver emitted — the receipts behind the booleans. */
  diagnosticCodes: string[];
  /** Joined pose + activity, for the side-by-side print. */
  prose: string;
}

/** Diagnostics that mean the composer proposed a viewer part it had no right to. */
const UNGROUNDED_PART_CODES = [
  "images.scene_composer.viewer_body_ungrounded",
  "images.scene_composer.viewer_body_dropped",
  "images.scene_composer.viewer_body_unrequested",
] as const;

/**
 * True when the spec is indistinguishable from `sceneSpecSchema.parse({})`.
 *
 * The same test the production ladder makes its retry decision on, and for the same reason:
 * an all-defaulted spec PARSES, so a refusal that `generateChecked` answered with schema
 * defaults would otherwise be scored as a successful composition with a merely-empty result.
 */
export function isEmptySpec(spec: SceneSpec): boolean {
  return JSON.stringify(spec) === JSON.stringify(emptySceneSpec());
}

/** Every free-text field the composer authors that reaches a render prompt. */
function composerProse(spec: SceneSpec): string[] {
  return [spec.pose, spec.activity, spec.mood, spec.setting, ...spec.others.map((other) => other.action)];
}

/**
 * Grade one arm's answer for one beat.
 *
 * `spec` is the RAW model output. The plan is resolved HERE rather than accepted from the
 * caller, so no runner can accidentally grade a plan built against different context than
 * the model was prompted with.
 */
export function gradeComposer(input: {
  spec: SceneSpec | null;
  /** True when `generateChecked` reported a degrade — refusal, transport failure, or schema miss. */
  degraded: boolean;
  context: SceneComposerContext;
  expectation: ComposerExpectation;
  /** A fresh collector; the caller keeps it to print the diagnostics alongside the grade. */
  sink: DiagnosticCollector;
}): ComposerGrade {
  const { spec, degraded, context, expectation, sink } = input;
  const gradesCamera = expectation.camera !== undefined;
  const gradesStaging = expectation.stagingId !== undefined;
  const gradesViewerBody = expectation.viewerBody.length > 0;

  // A refusal fails every axis it would have been graded on. Stated as an early return
  // rather than falling through the checks below, because "no spec" and "a spec that got
  // everything wrong" are the same score but very different findings, and only this branch
  // can tell the operator which one happened.
  if (degraded || !spec || isEmptySpec(spec)) {
    const checks: ComposerChecks = {
      answered: false,
      focal: null,
      camera: gradesCamera ? false : null,
      staging: gradesStaging ? false : null,
      viewerBody: gradesViewerBody ? false : null,
      groundedParts: false,
      noInventedCast: false,
      noBannedWords: false,
      concrete: false,
    };
    return { checks, score: scoreOf(checks), diagnosticCodes: sink.items.map((item) => item.code), prose: "" };
  }

  // THE production resolver, on THE context the model was prompted with — so the evidence
  // gates, the roster clamps and the registry validation that grade this answer are the same
  // ones that would have run had this spec come from a real turn.
  const plan = resolveScenePlan(spec, context, sink);
  const codes = sink.items.map((item) => item.code);
  const fired = (code: string): boolean => codes.includes(code);

  const camera = gradesCamera
    ? plan.camera.orientation === expectation.camera?.orientation &&
      plan.camera.distance === expectation.camera.distance &&
      plan.camera.height === expectation.camera.height
    : null;

  const prose = [spec.pose, spec.activity].map((part) => part.trim()).filter(Boolean).join("; ");

  const checks: ComposerChecks = {
    answered: true,
    focal: plan.focal?.name === expectation.focalName && !fired("images.scene_composer.focal_clamped"),
    camera,
    staging: gradesStaging ? plan.staging?.id === expectation.stagingId : null,
    // Scored against the RAW proposal, not the resolved plan: a surviving staging unions its
    // own registry parts into the plan, which would make this pass for a model that proposed
    // nothing at all.
    viewerBody: gradesViewerBody ? expectation.viewerBody.every((part) => spec.viewerBody.includes(part)) : null,
    groundedParts: !UNGROUNDED_PART_CODES.some(fired),
    noInventedCast: !fired("images.scene_composer.absent_character_dropped"),
    // `scrubBlush` is the production scrub; a text it rewrites is a text that contained a
    // banned word. Asking the scrubber beats keeping a second copy of its word list here.
    noBannedWords: composerProse(spec).every((text) => scrubBlush(text) === text),
    concrete: !VAGUE_SIGNATURES.some((pattern) => pattern.test(prose)),
  };

  return { checks, score: scoreOf(checks), diagnosticCodes: codes, prose };
}

/** Graded checks passed / graded checks applicable. `null` axes are not counted either way. */
export function scoreOf(checks: ComposerChecks): number {
  const graded = Object.values(checks).filter((value): value is boolean => value !== null);
  if (graded.length === 0) return 0;
  return graded.filter(Boolean).length / graded.length;
}
