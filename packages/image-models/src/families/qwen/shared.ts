import {
  aspectRatioFeature,
  fastModeFeature,
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
 * common but a publisher, while everything in this folder shares one set of
 * reference conventions.
 *
 * The family's numbered-reference identity lock is NOT written here. It is
 * compiled from the world digest's `subject.identity` claim by the family's
 * prompt dialect in `@vesper/image-core` (`dialect-qwen-2511.ts`); the
 * `preparePrompt` quirk that once rewrote a lane-side legacy sentence into it
 * at the model boundary retired with that sentence (#251), so no adapter in
 * this family touches prompt text.
 */
export const QWEN_IMAGE_FAMILY = "qwen-image";

/**
 * What every Qwen INSTRUCTION-EDIT endpoint expresses, whichever generation it
 * belongs to: an edit instruction, several numbered references, a requested
 * shape, a seed, an accelerated sampling path it can be told to skip, an output
 * encoding and quality, and a disableable safety checker.
 *
 * Notably absent from every edit endpoint in this family: a negative prompt, a
 * guidance strength, and any numeric edit strength. None of the three exists on
 * these schemas at all — edit intensity is governed by the instruction and the
 * references, which is exactly what an instruction editor means.
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
    fastModeFeature(),
    outputFormatFeature(),
    outputQualityFeature(),
    safetyToggleFeature(),
  ];
}
