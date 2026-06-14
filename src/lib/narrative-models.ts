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
  { id: "z-ai/glm-5.1", label: "GLM 5.1" },
  { id: "google/gemini-3.5-flash", label: "Gemini 3.5 Flash" },
];

/** The narrator used when neither the world nor the env override one. */
export const DEFAULT_NARRATIVE_MODEL_ID = "aion-labs/aion-2.0";
