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
 * The chat scene strip's model picker (owner request 2026-07-11), persisted per
 * conversation (`character_chat_state.scene_model`, saved on select).
 * `"reference"` is the identity-locked route — the avatar anchors a Qwen-edit
 * render. The t2i style-swap picks were REMOVED from this vocabulary (owner
 * ruling 2026-07-29): a scene that drops the avatar reference paints a
 * different-looking person, which defeats the point of a scene image. The
 * picker seam stays so reference-capable models can be added when found; the
 * portrait studio keeps the full t2i set (`avatarImageModels`) — those generate
 * NEW images, where a reference isn't wanted. A stored t2i pick from before the
 * ruling parses back to "reference".
 */
export const chatSceneModels = ["reference"] as const;
export type ChatSceneModel = (typeof chatSceneModels)[number];

export const DEFAULT_CHAT_SCENE_MODEL: ChatSceneModel = "reference";

/** Picker labels — reference-capable routes only. */
export const chatSceneModelLabels: Record<ChatSceneModel, string> = {
  reference: "Avatar reference (Qwen edit)",
};

/** Coerce a stored/string value to a known scene-model key (default "reference"). */
export function parseChatSceneModel(value: string | null | undefined): ChatSceneModel {
  return (chatSceneModels as readonly string[]).includes(value ?? "") ? (value as ChatSceneModel) : "reference";
}
