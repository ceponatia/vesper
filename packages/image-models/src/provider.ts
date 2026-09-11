export const FAL_QWEN3_TEXT_SLUG = "alibaba/qwen-image-3/text-to-image";
export const FAL_QWEN3_EDIT_SLUG = "alibaba/qwen-image-3/edit";

export type ImageModelProvider = "fal" | "replicate";

/** The provider that owns a registry slug. Unrecognized rows remain Replicate-native. */
export function imageModelProvider(slug: string): ImageModelProvider {
  return slug === FAL_QWEN3_TEXT_SLUG || slug === FAL_QWEN3_EDIT_SLUG ? "fal" : "replicate";
}
