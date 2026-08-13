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
  { id: "~deepseek/deepseek-v4-flash-latest", label: "DeepSeek 4 Flash" },
  { id: "z-ai/glm-5.2", label: "GLM 5.2" },
];

/**
 * The in-session agent model used when neither the world nor the env override
 * one. DeepSeek 4 Flash: fast and capable, chosen 2026-07-15 after the chat
 * inspector's Agent-health panel showed GLM 5.2 timing out ~20/21 background legs
 * with `model_slow` (the pulse's 4s + the extraction legs' 6s budgets left no
 * margin for GLM's cold/slow OpenRouter endpoints — see the DeepInfra exclusion in
 * `PROVIDER_IGNORE`). A Flash-class classifier returns these tiny structured JSONs
 * in ~1–3s, so the dropped state (facts, mood/feeling, outfit/scene, plans) lands.
 * Reasoning-off still holds (the agent calls pass `disableReasoning: true`). GLM 5.2
 * stays curated above as a selectable option; the narrator default is untouched
 * (Aion — narrative-models.ts). Replaced the retired `openrouter/owl-alpha` stealth
 * slug, which returned "No endpoints found" once the alpha model was pulled.
 *
 * The id is OpenRouter's **floating alias** for the family (owner ask, 2026-08-04) —
 * the `~` prefix is part of the slug and required (`deepseek/deepseek-v4-flash-latest`
 * without it 404s). It always redirects to the newest V4 Flash release, so a new
 * snapshot needs no code change; the trade is that the exact weights can shift under
 * us (the dated `deepseek/deepseek-v4-flash-<mmdd>` slugs are the pin-it escape hatch
 * if a release ever regresses the agents' structured-JSON reliability).
 */
export const DEFAULT_AGENT_MODEL_ID = "~deepseek/deepseek-v4-flash-latest";
