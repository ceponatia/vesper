/**
 * Shared identifiers for the intimate-scene LoRA pairing. Render routes and
 * admin tools use these constants so the selected library row and model do not
 * drift between surfaces.
 */

/** Seeded library row used for the intimate-scene anatomy LoRA. */
export const INTIMATE_SCENE_LORA_ID = "imglorqwennsfwallinclv20";

/** Base model the automatic intimate-scene route pairs with the curated LoRA. */
export const INTIMATE_SCENE_LORA_WRAPPER_SLUG = "qwen/qwen-image-edit-plus-lora";

/** Model selection that pre-fills the curated LoRA in the Image Generator. */
export const INTIMATE_SCENE_LORA_PREFILL_SLUG = INTIMATE_SCENE_LORA_WRAPPER_SLUG;
