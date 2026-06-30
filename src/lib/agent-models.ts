/**
 * Curated **in-session agent** model options — the non-narrator text models that
 * run during a session (the pre-narrator intake agent and the four post-turn
 * agents: simulant, archivist, continuity, director). One pure list shared by the
 * client dropdown (components/play/world-tab.tsx) and the server's `agentModelId`
 * resolver (server/ai/provider.ts). Ids are OpenRouter slugs (`vendor/model`).
 *
 * Out of scope by design: the narrator (its own list, narrative-models.ts), the
 * character/world **authoring** agents (they run outside a session, on the
 * default), and anything in the **image** pipeline (the scene composer + the
 * image models). Adding an agent option is one entry here.
 */

export interface AgentModelOption {
  /** OpenRouter model id, e.g. "google/gemini-3.5-flash". */
  id: string;
  /** Human label for the dropdown. */
  label: string;
}

export const AGENT_MODELS: readonly AgentModelOption[] = [
  { id: "deepseek/deepseek-v4-flash", label: "DeepSeek 4 Flash" },
  { id: "z-ai/glm-5.2", label: "GLM 5.2" },
];

/**
 * The in-session agent model used when neither the world nor the env override
 * one. GLM 5.2: capable and reasonably fast, and already a curated narrator
 * option. Replaced the retired `openrouter/owl-alpha` stealth slug — OpenRouter
 * returns "No endpoints found" once an alpha model is pulled, which failed every
 * agent call that fell back to the default.
 */
export const DEFAULT_AGENT_MODEL_ID = "z-ai/glm-5.2";
