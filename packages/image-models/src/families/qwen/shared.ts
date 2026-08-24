import type { ImageModelQuirk } from "../../composer";
import {
  aspectRatioFeature,
  multiReferenceFeature,
  outputFormatFeature,
  outputQualityFeature,
  promptFeature,
  safetyToggleFeature,
  seedFeature,
  type ImageFeature,
} from "../../features";

/**
 * The Qwen-Image family: the Qwen-Image checkpoints Vesper runs on Replicate —
 * the instruction editors and the text-to-image generator arm.
 *
 * It names the CHECKPOINT family, not the provider account: `qwen/` is a
 * Replicate owner path and would eventually collect models with nothing in
 * common but a publisher, while everything in this folder shares one prompt
 * dialect and one set of reference conventions.
 */
export const QWEN_IMAGE_FAMILY = "qwen-image";

/**
 * The provider-neutral identity sentence Vesper's prompt builders emit. Copied
 * here verbatim because the dialect below rewrites exactly THIS string and
 * nothing else — a paraphrase would silently stop matching and every Qwen edit
 * would quietly revert to the generic wording.
 *
 * Deliberately not exported: it is the legacy spelling this family translates
 * AWAY from, and nothing outside should be authoring it against this constant.
 */
const LEGACY_PORTRAIT_IDENTITY_LOCK =
  "Generate a new image of the exact same person shown in the reference image. Preserve face, hair color and style, skin tone, body proportions, and apparent age.";

/** Kept no longer than the legacy lock so the edit path's fitted prompt stays fitted. */
export const QWEN_SINGLE_REFERENCE_IDENTITY_LOCK =
  "Image 1 is the identity reference. Preserve the exact face, hair, skin tone, body proportions, and apparent age. Change only what this instruction requests.";

/** Kept no longer than the legacy lock so the edit path's fitted prompt stays fitted. */
export const QWEN_MULTI_REFERENCE_IDENTITY_LOCK =
  "Use numbered references as assigned below. Preserve each person's exact face, hair, skin tone, build, and apparent age; change only requested details.";

/**
 * Qwen Edit's own multi-image guidance asks callers to identify images by
 * number and say what should remain unchanged. Vesper's prompt builders emit
 * the provider-neutral legacy lock, so this rewrites only that exact sentence
 * at the model boundary. Other families and custom Qwen instructions stay
 * byte-identical, because a prompt that never contained the legacy sentence is
 * returned unchanged.
 *
 * The rewrite is IDEMPOTENT, and that is load-bearing rather than incidental:
 * `compileProfileRenderPlan` hashes the prepared prompt and `renderWithModel`
 * prepares again on the way out, so a second pass that changed the text would
 * make every identity-trial cell refuse `cell_conflict` against its own
 * compiled prompt. `replaceAll` rather than `replace` is what makes the claim
 * TRUE: a prompt that somehow carried the legacy sentence twice kept its second
 * copy under `replace`, and the next pass would rewrite that one instead — the
 * same function returning two different strings for one input.
 *
 * The model argument is unused, and that is the improvement this package makes.
 * The behavior moved here from a shared quality preset that had to re-check the
 * model's slug on every call, because it ran for every model in the system. An
 * adapter is already the answer to "which model is this", so the slug check has
 * no work left to do — which is what plan §20 means by Qwen behavior living in
 * one adapter instead of in slug checks.
 */
export function qwenEditPromptDialect(): ImageModelQuirk {
  return {
    id: "qwen.numbered-reference-dialect",
    preparePrompt: (_model, prompt, referenceCount) => {
      if (referenceCount <= 0 || !prompt.includes(LEGACY_PORTRAIT_IDENTITY_LOCK)) return prompt;
      const lock = referenceCount === 1 ? QWEN_SINGLE_REFERENCE_IDENTITY_LOCK : QWEN_MULTI_REFERENCE_IDENTITY_LOCK;
      return prompt.replaceAll(LEGACY_PORTRAIT_IDENTITY_LOCK, lock);
    },
  };
}

/**
 * What every Qwen INSTRUCTION-EDIT endpoint expresses, whichever generation it
 * belongs to: an edit instruction, several numbered references, a requested
 * shape, a seed, an output encoding and quality, and a disableable safety
 * checker.
 *
 * Notably absent from every edit endpoint in this family: a negative prompt and
 * a guidance strength. Neither exists on these schemas at all — edit intensity
 * is governed by the instruction and the references, which is exactly what an
 * instruction editor means.
 *
 * A function rather than a shared array so each adapter composes its own
 * feature objects. Handing both editors the same array would make a later
 * per-endpoint tweak (a narrower reference cap, an extra check) look local
 * while changing the other one too.
 */
export function qwenEditFeatures(): ImageFeature[] {
  return [
    promptFeature(),
    multiReferenceFeature(),
    aspectRatioFeature(),
    seedFeature(),
    outputFormatFeature(),
    outputQualityFeature(),
    safetyToggleFeature(),
  ];
}
