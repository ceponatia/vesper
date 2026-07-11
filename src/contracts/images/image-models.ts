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

/**
 * The chat scene strip's hot-swappable model picker (owner request 2026-07-11),
 * persisted per conversation (`character_chat_state.scene_model`, saved on
 * select). `"reference"` is the default identity-locked route — the avatar
 * anchors a Qwen-edit render (the only Venice edit family; Chroma & co. have no
 * edit variants). Picking a t2i model renders THAT scene text-to-image with it:
 * a real style swap, at the cost of the avatar reference (identity rides the
 * prompt text instead).
 */
export const chatSceneModels = ["reference", ...avatarImageModels] as const;
export type ChatSceneModel = (typeof chatSceneModels)[number];

export const DEFAULT_CHAT_SCENE_MODEL: ChatSceneModel = "reference";

/** Picker labels: the reference route leads, then the t2i set. */
export const chatSceneModelLabels: Record<ChatSceneModel, string> = {
  reference: "Avatar reference (Qwen edit)",
  ...avatarImageModelLabels,
};

/** Coerce a stored/string value to a known scene-model key (default "reference"). */
export function parseChatSceneModel(value: string | null | undefined): ChatSceneModel {
  return (chatSceneModels as readonly string[]).includes(value ?? "") ? (value as ChatSceneModel) : "reference";
}
