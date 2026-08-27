import { baseImageModelSlug } from "@vesper/image-core";
import type { ImageModelAdapter } from "./composer";
import { qwenImage2512, qwenImageEdit2511, qwenImageEditPlusLora } from "./families";

/**
 * Every model whose family behavior Vesper has written down, keyed by BASE
 * slug — the provider path with any pinned `owner/name:version` suffix removed.
 *
 * Keyed that way because a registry row's slug may or may not carry a version
 * pin, and the family's behavior does not change when it does: a prompt dialect
 * and a cold-start budget belong to the endpoint, not to one sha. Keying on the
 * raw slug would mean a row pinned for reproducibility silently lost its
 * adapter, which is the worst possible failure mode — no error, just the
 * generic behavior coming back.
 *
 * Only the Qwen family is here. Other families (Flux, Wan, SDXL, Seedream) stay
 * on the legacy path and migrate when their behavior is next touched, which is
 * exactly why the answer below is nullable rather than exhaustive.
 */
const IMAGE_MODEL_ADAPTERS: Readonly<Record<string, ImageModelAdapter>> = {
  "qwen/qwen-image-edit-2511": qwenImageEdit2511,
  "qwen/qwen-image-edit-plus-lora": qwenImageEditPlusLora,
  "qwen/qwen-image-2512": qwenImage2512,
};

/**
 * The adapter for a registered model, or null when Vesper has nothing special
 * to say about it.
 *
 * **Null is the ordinary answer, never an error.** Most registered
 * models have no adapter and render exactly as they do today; a caller treats
 * null as "no prompt dialect, no extra validation, no execution hints" and
 * carries on. If this ever started throwing or logging on a miss, every
 * unmigrated family would look broken while behaving perfectly.
 */
export function adapterForImageModel(slug: string): ImageModelAdapter | null {
  return IMAGE_MODEL_ADAPTERS[baseImageModelSlug(slug)] ?? null;
}
