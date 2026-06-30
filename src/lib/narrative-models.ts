/**
 * Curated narrator model options (phase-2 T5 ruling): one pure list shared by
 * the client dropdown (components/play/world-tab.tsx) and the server's
 * narrativeModelId resolver default (server/ai/provider.ts). Ids are OpenRouter
 * model slugs (`vendor/model`). The planned BYOK feature replaces this static
 * list with a live-queried catalog; until then, adding a narrator is one entry
 * here.
 */

export interface NarrativeModelOption {
  /** OpenRouter model id, e.g. "aion-labs/aion-2.0". */
  id: string;
  /** Human label for the dropdown. */
  label: string;
}

export const NARRATIVE_MODELS: readonly NarrativeModelOption[] = [
  { id: "aion-labs/aion-2.0", label: "Aion 2.0" },
  { id: "deepseek/deepseek-v4-flash", label: "DeepSeek 4 Flash" },
  { id: "z-ai/glm-5.2", label: "GLM 5.2" },
  { id: "google/gemini-3.5-flash", label: "Gemini 3.5 Flash" },
];

/** The narrator used when neither the world nor the env override one. */
export const DEFAULT_NARRATIVE_MODEL_ID = "aion-labs/aion-2.0";

/**
 * The narrator the **character-chat** tab defaults to (the Chat-tab model
 * dropdown's initial value). Kept separate from the session narrator default
 * above so the two surfaces can diverge: chat favours GLM 5.2's voice for the
 * quick 1-on-1, while sessions stay on Aion 2.0. Must be an id in
 * {@link NARRATIVE_MODELS} so the dropdown shows it selected.
 */
export const DEFAULT_CHARACTER_CHAT_MODEL_ID = "z-ai/glm-5.2";

/**
 * Resolve a persisted/over-the-wire character-chat model id to a curated one: a
 * known {@link NARRATIVE_MODELS} id passes through, while an empty or unrecognised
 * value (no saved pick, or an id dropped from the registry) falls back to
 * {@link DEFAULT_CHARACTER_CHAT_MODEL_ID}. Keeps the chat dropdown's `value` always
 * matching a real option and never streams a blank model to the server.
 */
export function resolveChatModelId(id: string | null | undefined): string {
  return id && NARRATIVE_MODELS.some((option) => option.id === id) ? id : DEFAULT_CHARACTER_CHAT_MODEL_ID;
}
