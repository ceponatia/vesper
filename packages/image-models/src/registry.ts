import { baseImageModelSlug } from "@vesper/image-core";
import type { ImageModelAdapter } from "./composer";
import {
  civitaiQwenImage21,
  fluxKleinBase,
  fluxKleinBaseLora,
  fluxKleinCivitaiDistilledLora,
  fluxKleinDistilled,
  fluxKontextDev,
  qwenImage2512,
  qwenImage3Edit,
  qwenImage3TextToImage,
  qwenImageEdit2511,
  seedream45,
  seedream5Lite,
} from "./families";
import {
  CIVITAI_FLUX2_KLEIN4B_SLUG,
  CIVITAI_QWEN_IMAGE_21_SLUG,
  FAL_QWEN3_EDIT_SLUG,
  FAL_QWEN3_TEXT_SLUG,
} from "./provider";

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
 * `/edit`) and therefore contain three path segments. Civitai's Vesper-owned
 * registry identity is likewise not a Replicate owner/name slug. Those provider
 * identities are intentionally registered verbatim rather than passed through
 * `baseImageModelSlug`, whose `owner/name[:version]` grammar belongs to
 * Replicate. The lookup handles those exact routes first.
 *
 * The Qwen family, the FLUX.2 klein bench-onboarding endpoints (#567), the
 * FLUX.1 Kontext Dev endpoint (#574), the Civitai Qwen Image 2.1 lane (#660),
 * and both Seedream endpoints are here. Other families (the production Flux
 * checkpoints, Wan, SDXL) use the generic path, which is why the answer below
 * is nullable rather than exhaustive.
 */
const IMAGE_MODEL_ADAPTERS: Readonly<Record<string, ImageModelAdapter>> = {
  "qwen/qwen-image-edit-2511": qwenImageEdit2511,
  "qwen/qwen-image-2512": qwenImage2512,
  [FAL_QWEN3_TEXT_SLUG]: qwenImage3TextToImage,
  [FAL_QWEN3_EDIT_SLUG]: qwenImage3Edit,
  [CIVITAI_FLUX2_KLEIN4B_SLUG]: fluxKleinCivitaiDistilledLora,
  // Civitai Qwen Image 2.1 (#660): a Vesper-owned exact provider identity,
  // registered verbatim like the klein slug above — not a Replicate
  // owner/name[:version] slug, so it never passes through `baseImageModelSlug`.
  [CIVITAI_QWEN_IMAGE_21_SLUG]: civitaiQwenImage21,
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
  // One Seedream family, two endpoint-specific compositions. Each exact base
  // slug also resolves when the registry row carries a Replicate version pin.
  "bytedance/seedream-4.5": seedream45,
  "bytedance/seedream-5-lite": seedream5Lite,
};

/**
 * Vesper-owned exact provider identities (Civitai, fal): registered verbatim
 * above, and never Replicate's `owner/name[:version]` grammar. A colon
 * appended to one of these is not a reproducibility pin — Civitai and fal
 * have no such suffix convention on these routes — so it must not fall back
 * onto the identity it was appended to.
 */
const EXACT_ONLY_SLUGS: ReadonlySet<string> = new Set([
  CIVITAI_FLUX2_KLEIN4B_SLUG,
  CIVITAI_QWEN_IMAGE_21_SLUG,
  FAL_QWEN3_TEXT_SLUG,
  FAL_QWEN3_EDIT_SLUG,
]);

/**
 * The adapter for a registered model, or null when Vesper has nothing special
 * to say about it.
 *
 * **Null is the ordinary answer, never an error.** Most registered
 * models have no adapter and render exactly as they do today; a caller treats
 * null as "no prompt dialect, no extra validation, no execution hints" and
 * carries on. If this ever started throwing or logging on a miss, every
 * unmigrated family would look broken while behaving perfectly.
 *
 * The base-slug fallback exists for Replicate's `owner/name:version` pins.
 * When stripping a suffix would land on one of the `EXACT_ONLY_SLUGS` above —
 * a Vesper-owned Civitai/fal identity — the fallback is refused instead: a
 * colon suffix on an exact provider identity is not that identity pinned, it
 * is an unrecognized spelling.
 */
export function adapterForImageModel(slug: string): ImageModelAdapter | null {
  const exact = IMAGE_MODEL_ADAPTERS[slug];
  if (exact) return exact;
  const base = baseImageModelSlug(slug);
  if (base !== slug && EXACT_ONLY_SLUGS.has(base)) return null;
  return IMAGE_MODEL_ADAPTERS[base] ?? null;
}
