import { defineImageModel, type ImageModelAdapter } from "../../composer";
import { QWEN_IMAGE_FAMILY, qwenEditFeatures, qwenEditPromptDialect } from "./shared";

/**
 * `qwen/qwen-image-edit-2511` — the current Qwen instruction editor, and
 * Vesper's default for chat scene images and portrait variants
 * (`docs/image-models/qwen-image-edit-2511.md`).
 *
 * Endpoint facts worth carrying here rather than rediscovering:
 *
 * - Its reference input is REQUIRED, so it cannot generate from a prompt alone
 *   and is never offered in the new-portrait picker. The registry row records
 *   that as `canGenerate: false`; the adapter does not restate it.
 * - It takes 1–3 references, addressed by number — the reason the family's
 *   prompt dialect exists at all.
 * - There is no edit-strength control. What changes and what is preserved is
 *   governed by the instruction and the references, which is what makes this an
 *   instruction editor rather than a repainter.
 *
 * **No LoRA feature, deliberately.** The model card's phrase "integrated LoRAs"
 * describes acceleration baked into the published weights, not a loadable
 * input: this endpoint exposes no LoRA field whatsoever. Composing the feature
 * "for symmetry" with the sibling wrapper would be a claim the schema cannot
 * back, and the wrapper below exists precisely because this one cannot do it.
 */
export const qwenImageEdit2511: ImageModelAdapter = defineImageModel({
  family: QWEN_IMAGE_FAMILY,
  features: qwenEditFeatures(),
  quirks: [qwenEditPromptDialect()],
});
