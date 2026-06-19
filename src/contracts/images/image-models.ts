/**
 * Selectable image-generation models for the portrait studio
 * (scene-images.spec.md §5). After the 2026-06-19 Flux removal every avatar model
 * is an **uncensored Venice text-to-image** model; `qwen` is the default and the
 * rest are diversity/cost options (the lustify set is API-flagged most-uncensored
 * and cheaper; chroma is photoreal; illustrious is anime; turbo is fastest).
 *
 * This pure module carries only the picker's vocabulary + display labels so the
 * client and server agree on the key set without a component importing a server
 * module. The key → Venice-model-id resolution lives server-side
 * (`server/ai/venice.ts:veniceT2IModelId`), where provider model ids belong.
 */
export const avatarImageModels = ["qwen", "lustify", "chroma", "illustrious", "turbo"] as const;
export type AvatarImageModel = (typeof avatarImageModels)[number];

/** The default avatar model — Qwen-Image-2 (uncensored). */
export const DEFAULT_AVATAR_IMAGE_MODEL: AvatarImageModel = "qwen";

/** Display labels for the image-model picker (portrait studio). */
export const avatarImageModelLabels: Record<AvatarImageModel, string> = {
  qwen: "Qwen (uncensored)",
  lustify: "Lustify (most uncensored)",
  chroma: "Chroma (photoreal)",
  illustrious: "WAI Illustrious (anime)",
  turbo: "Z-Image Turbo (fast)",
};
