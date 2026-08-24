import { defineImageModel, type ImageModelAdapter } from "../../composer";
import { loraFeature } from "../../features";
import { QWEN_IMAGE_FAMILY, qwenEditFeatures, qwenEditPromptDialect } from "./shared";

/**
 * `qwen/qwen-image-edit-2511` — the current Qwen instruction editor and Vesper's
 * default for identity-critical edits.
 *
 * The endpoint accepts 1–3 reference images, addresses them by number, and is
 * the family member with the strongest reviewed identity preservation. Its
 * runtime schema now exposes one custom LoRA through `lora_weights` plus
 * `lora_scale` (0–4). The probed registry row remains authoritative for whether
 * those provider bindings exist on the version Vesper is actually going to run;
 * composing {@link loraFeature} here states the semantic capability without
 * inventing provider field names.
 *
 * This corrects an older adapter assumption that 2511's "integrated LoRAs"
 * referred only to built-in acceleration. Replicate's current 2511 API and the
 * pinned-version probe both expose loadable LoRA controls, so treating the older
 * 2509 plus-LoRA wrapper as the only Qwen edit endpoint with runtime LoRA support
 * made the Image Generator hide a control the selected model can genuinely use.
 *
 * `go_fast: false` remains a reviewed QUALITY decision in `@vesper/image-core`,
 * not a family quirk here. The adapter says what the endpoint can express; the
 * profile/quality layers decide which values Vesper should ask it to use.
 */
export const qwenImageEdit2511: ImageModelAdapter = defineImageModel({
  family: QWEN_IMAGE_FAMILY,
  features: [...qwenEditFeatures(), loraFeature()],
  quirks: [qwenEditPromptDialect()],
});
