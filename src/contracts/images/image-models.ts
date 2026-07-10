/**
 * Selectable image-generation models for the portrait studio
 * (scene-images.spec.md §5). After the 2026-06-19 Flux removal every avatar model
 * is an **uncensored Venice text-to-image** model; `chroma` is the default (owner
 * ruling 2026-07-10, was `qwen`) and the rest are diversity/cost options (the
 * lustify set is API-flagged most-uncensored and cheaper; qwen is the former
 * default; illustrious is anime; turbo is fastest).
 *
 * This pure module carries only the picker's vocabulary + display labels so the
 * client and server agree on the key set without a component importing a server
 * module. The key → Venice-model-id resolution lives server-side
 * (`server/ai/venice.ts:veniceT2IModelId`), where provider model ids belong.
 */
export const avatarImageModels = ["qwen", "lustify", "chroma", "illustrious", "turbo"] as const;
export type AvatarImageModel = (typeof avatarImageModels)[number];

/**
 * The default text-to-image pick — Chroma (photoreal, owner ruling 2026-07-10).
 * Governs the portrait studio's initial picker value / API default AND the scene
 * render ladder's text-to-image rung (`veniceSceneImageModelId`); the scene EDIT
 * rungs necessarily stay on the Qwen edit models (Chroma has no edit variant).
 */
export const DEFAULT_AVATAR_IMAGE_MODEL: AvatarImageModel = "chroma";

/** Display labels for the image-model picker (portrait studio). */
export const avatarImageModelLabels: Record<AvatarImageModel, string> = {
  qwen: "Qwen (uncensored)",
  lustify: "Lustify (most uncensored)",
  chroma: "Chroma (photoreal)",
  illustrious: "WAI Illustrious (anime)",
  turbo: "Z-Image Turbo (fast)",
};
