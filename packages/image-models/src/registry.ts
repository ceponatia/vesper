import { baseImageModelSlug } from "@vesper/image-core";
import type { ImageModelAdapter } from "./composer";
import {
  fluxKleinBase,
  fluxKleinBaseLora,
  fluxKleinDistilled,
  fluxKontextDev,
  qwenImage2512,
  qwenImage3Edit,
  qwenImage3TextToImage,
  qwenImageEdit2511,
} from "./families";
import { FAL_QWEN3_EDIT_SLUG, FAL_QWEN3_TEXT_SLUG } from "./provider";

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
 * Qwen Image 3's fal routes include an operation path (`/text-to-image` or
 * `/edit`) and therefore contain three path segments. They are intentionally
 * registered verbatim rather than passed through `baseImageModelSlug`, whose
 * `owner/name[:version]` grammar belongs to Replicate. The lookup handles those
 * two exact routes first.
 *
 * The Qwen family, the FLUX.2 klein bench-onboarding endpoints (#567), and the
 * FLUX.1 Kontext Dev endpoint (#574) are here. Other families (the production
 * Flux checkpoints, Wan, SDXL, Seedream) stay on the legacy path and migrate
 * when their behavior is next touched, which is exactly why the answer below
 * is nullable rather than exhaustive.
 */
const IMAGE_MODEL_ADAPTERS: Readonly<Record<string, ImageModelAdapter>> = {
  "qwen/qwen-image-edit-2511": qwenImageEdit2511,
  "qwen/qwen-image-2512": qwenImage2512,
  [FAL_QWEN3_TEXT_SLUG]: qwenImage3TextToImage,
  [FAL_QWEN3_EDIT_SLUG]: qwenImage3Edit,
  // FLUX.2 klein (#567): 4B/9B parameter-count twins share one variant object.
  // Registering the 9B slugs is code support only — no 9B database row exists,
  // and adding one is #564's decision, not this registry's.
  "black-forest-labs/flux-2-klein-4b": fluxKleinDistilled,
  "black-forest-labs/flux-2-klein-4b-base": fluxKleinBase,
  "black-forest-labs/flux-2-klein-4b-base-lora": fluxKleinBaseLora,
  "black-forest-labs/flux-2-klein-9b": fluxKleinDistilled,
  "black-forest-labs/flux-2-klein-9b-base": fluxKleinBase,
  "black-forest-labs/flux-2-klein-9b-base-lora": fluxKleinBaseLora,
  // FLUX.1 Kontext Dev (#574): the bare and pinned dev slug only — the pro/max
  // and dev-lora siblings, and flux-dev, resolve nothing here.
  "black-forest-labs/flux-kontext-dev": fluxKontextDev,
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
  const exact = IMAGE_MODEL_ADAPTERS[slug];
  if (exact) return exact;
  return IMAGE_MODEL_ADAPTERS[baseImageModelSlug(slug)] ?? null;
}
