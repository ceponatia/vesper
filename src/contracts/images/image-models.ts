/**
 * Selectable image-generation models for the portrait studio
 * (scene-images.spec.md §5). Venice remains the default provider; Replicate's
 * official Qwen endpoint is an explicit opt-in alternative. Provider-prefixed
 * keys keep stored selections unambiguous, while the labels mark every
 * Replicate-hosted option with a leading `*` (owner request 2026-08-04).
 *
 * This pure module carries only the picker's vocabulary + display labels so the
 * client and server agree on the key set without importing a server module.
 * Concrete provider model ids stay server-side (`server/ai/venice.ts` and
 * `server/ai/replicate.ts`).
 */
export const veniceAvatarImageModels = ["qwen", "lustify", "chroma", "illustrious", "turbo"] as const;
export type VeniceAvatarImageModel = (typeof veniceAvatarImageModels)[number];

export const replicateAvatarImageModels = ["replicate_qwen_2512"] as const;
export type ReplicateAvatarImageModel = (typeof replicateAvatarImageModels)[number];

export const avatarImageModels = [...veniceAvatarImageModels, ...replicateAvatarImageModels] as const;
export type AvatarImageModel = (typeof avatarImageModels)[number];

/**
 * The default text-to-image pick — Venice Chroma (photoreal, owner ruling
 * 2026-07-10). Adding Replicate is opt-in and does not move production defaults.
 */
export const DEFAULT_AVATAR_IMAGE_MODEL = "chroma" satisfies AvatarImageModel;

/** Display labels for the image-model picker. `*` means Replicate, not Venice. */
export const avatarImageModelLabels: Record<AvatarImageModel, string> = {
  qwen: "Qwen Image 2 (Venice)",
  lustify: "Lustify (Venice, most uncensored)",
  chroma: "Chroma (Venice, photoreal)",
  illustrious: "WAI Illustrious (Venice, anime)",
  turbo: "Z-Image Turbo (Venice, fast)",
  replicate_qwen_2512: "* Qwen Image 2512 (Replicate)",
};

export function isReplicateAvatarImageModel(model: AvatarImageModel): model is ReplicateAvatarImageModel {
  return (replicateAvatarImageModels as readonly string[]).includes(model);
}

/**
 * The chat scene strip's model picker, persisted per conversation
 * (`character_chat_state.scene_model`, saved on select). Every option is a
 * reference-preserving edit route; text-to-image style swaps remain excluded.
 */
export const chatSceneModels = ["reference", "replicate_reference"] as const;
export type ChatSceneModel = (typeof chatSceneModels)[number];

export const DEFAULT_CHAT_SCENE_MODEL = "reference" satisfies ChatSceneModel;

/** Picker labels — `*` means the request runs through Replicate, not Venice. */
export const chatSceneModelLabels: Record<ChatSceneModel, string> = {
  reference: "Qwen Image 2 Edit (Venice)",
  replicate_reference: "* Qwen Image Edit 2511 (Replicate)",
};

export type ChatSceneProvider = "venice" | "replicate";

export function chatSceneProvider(model: ChatSceneModel): ChatSceneProvider {
  return model === "replicate_reference" ? "replicate" : "venice";
}

/** Coerce a stored/string value to a known scene-model key (default Venice reference). */
export function parseChatSceneModel(value: string | null | undefined): ChatSceneModel {
  return (chatSceneModels as readonly string[]).includes(value ?? "") ? (value as ChatSceneModel) : DEFAULT_CHAT_SCENE_MODEL;
}
