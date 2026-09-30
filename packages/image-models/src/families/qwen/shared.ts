import {
  aspectRatioFeature,
  fastModeFeature,
  guidanceFeature,
  loraFeature,
  multiReferenceFeature,
  negativePromptFeature,
  outputFormatFeature,
  outputQualityFeature,
  promptFeature,
  safetyToggleFeature,
  seedFeature,
  stepsFeature,
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
 * feature objects. Handing two endpoints the same array would make a later
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

/**
 * What the Qwen Image 2.1 checkpoint expresses on Civitai's comfy `qwen21`
 * lane (`engine: "comfy"`, `ecosystem: "qwen"`, `model: "2.1"`).
 *
 * This is deliberately NOT `qwenEditFeatures()`, and not `qwenImage2512` or
 * `qwenImageEdit2511`'s composition either — 2.1 is a different architecture,
 * not another endpoint sharing the family's edit conventions:
 *
 * - it is a 7B **single-stream** DiT (the 2511/2512 family is the 20B
 *   checkpoint), so nothing about its sampling behavior should be assumed
 *   from the 20B siblings;
 * - it samples with **true CFG** and a real step count — `guidanceFeature()`
 *   and `stepsFeature()` — where the 20B edit endpoints take neither;
 * - its negative prompt **acts, conditionally**: the official pipeline
 *   documents `negative_prompt` as ignored unless `true_cfg_scale > 1`
 *   (diffusers `QwenImage21Pipeline`), which is a real, if gated, steering
 *   effect — unlike `qwen/qwen-image-2512`'s negative field, which Vesper
 *   measured as inert at any guidance value and therefore never composes
 *   `negativePromptFeature()` for;
 * - it takes up to **ten** numbered references in one unified checkpoint that
 *   both generates and edits, rather than a generator arm and a separate
 *   instruction editor; and
 * - its LoRAs are **not cross-compatible** with the 20B family: a Qwen 2.1
 *   LoRA carries Civitai `baseModel: "Qwen 2.1"` and AIR ecosystem `qwen21`
 *   (`urn:air:qwen21:lora:civitai:<modelId>@<versionId>`), while the 20B
 *   family's LoRAs carry `baseModel: "Qwen"` and AIR ecosystem `qwen`
 *   (`urn:air:qwen:lora:…`) — the provider accepts either on this lane, so
 *   Vesper's own render-time gate is the only thing that tells them apart.
 *
 * It composes no `fastModeFeature`, `outputFormatFeature`,
 * `outputQualityFeature`, or `safetyToggleFeature`: the lane's accepted-input
 * set (`ComfyQwen21ImageGenInput`) declares none of those — no accelerated
 * sampling toggle, no caller-selected output format or quality (the lane is
 * fixed to Vesper's own `outputFormat: "jpeg"` policy), and no local safety
 * checker the caller can disable.
 */
export function qwenImage21Features(): ImageFeature[] {
  return [
    promptFeature(),
    multiReferenceFeature(),
    aspectRatioFeature(),
    seedFeature(),
    guidanceFeature(),
    stepsFeature(),
    negativePromptFeature(),
    loraFeature(),
  ];
}
