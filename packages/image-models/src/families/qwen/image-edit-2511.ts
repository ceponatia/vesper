import { defineImageModel, type ImageModelAdapter } from "../../composer";
import { loraFeature } from "../../features";
import { QWEN_IMAGE_FAMILY, qwenEditFeatures } from "./shared";

/**
 * `qwen/qwen-image-edit-2511` — the current Qwen instruction editor and Vesper's
 * default for identity-critical edits
 * (`docs/image-models/models/qwen-image-edit-2511.md`).
 *
 * The endpoint accepts 1–3 reference images, addresses them by number, and is
 * the family member with the strongest reviewed identity preservation. Its
 * runtime schema now exposes one custom LoRA through `lora_weights` plus
 * `lora_scale` (0–4). The probed registry row remains authoritative for whether
 * those provider bindings exist on the version Vesper is actually going to run;
 * composing {@link loraFeature} here states the semantic capability without
 * inventing provider field names.
 *
 * "Integrated LoRAs" in the endpoint's own copy names built-in acceleration
 * rather than a loadable adapter, and reading that as the whole story is what
 * makes the Image Generator hide a control the selected model can genuinely
 * use: Replicate's current 2511 API and the pinned-version probe both expose
 * loadable LoRA controls.
 *
 * The accelerated sampling path remains a reviewed QUALITY decision in
 * `@vesper/image-core`, not a family quirk here: production keeps it off,
 * because every production use of this endpoint is identity-critical. The
 * adapter says what the endpoint can EXPRESS, which is both answers — that is
 * what lets the admin bench ask for the accelerated path on a model whose
 * production ruling refuses it, without either layer contradicting the other.
 */
export const qwenImageEdit2511: ImageModelAdapter = defineImageModel({
  family: QWEN_IMAGE_FAMILY,
  features: [...qwenEditFeatures(), loraFeature()],
});
