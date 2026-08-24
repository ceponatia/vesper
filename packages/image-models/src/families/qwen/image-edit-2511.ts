import { defineImageModel, type ImageModelAdapter } from "../../composer";
import { QWEN_IMAGE_FAMILY, qwenEditFeatures, qwenEditPromptDialect } from "./shared";

/**
 * `qwen/qwen-image-edit-2511` — the current Qwen instruction editor, and
 * Vesper's default for chat scene images and portrait variants
 * (`docs/image-models/models/qwen-image-edit-2511.md`).
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
 * **No LoRA feature, deliberately.** The active Vesper probe snapshot this
 * adapter was built against exposes no LoRA binding, so the current adapter
 * cannot honestly claim one. Replicate's latest 2511 wrapper checked on
 * 2026-08-24 does advertise runtime LoRA inputs; that provider drift becomes a
 * Vesper capability only after the candidate version is probed, smoke-tested,
 * and activated. The provider-reference page above owns that version history.
 */
export const qwenImageEdit2511: ImageModelAdapter = defineImageModel({
  family: QWEN_IMAGE_FAMILY,
  features: qwenEditFeatures(),
  quirks: [qwenEditPromptDialect()],
});
