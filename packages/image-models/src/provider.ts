export const FAL_QWEN3_TEXT_SLUG = "alibaba/qwen-image-3/text-to-image";
export const FAL_QWEN3_EDIT_SLUG = "alibaba/qwen-image-3/edit";
export const CIVITAI_FLUX2_KLEIN4B_SLUG = "civitai/flux-2-klein-4b";
export const CIVITAI_QWEN_IMAGE_21_SLUG = "civitai/qwen-image-2.1";

/** Vesper-owned Civitai provider identities — exact slugs, never a prefix match. */
const CIVITAI_SLUGS: ReadonlySet<string> = new Set([CIVITAI_FLUX2_KLEIN4B_SLUG, CIVITAI_QWEN_IMAGE_21_SLUG]);

export type ImageModelProvider = "civitai" | "fal" | "replicate";

/** The provider that owns a registry slug. Unrecognized rows remain Replicate-native. */
export function imageModelProvider(slug: string): ImageModelProvider {
  if (CIVITAI_SLUGS.has(slug)) return "civitai";
  if (slug === FAL_QWEN3_TEXT_SLUG || slug === FAL_QWEN3_EDIT_SLUG) return "fal";
  return "replicate";
}
