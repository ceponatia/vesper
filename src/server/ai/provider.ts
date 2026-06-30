import {
  createOpenRouter,
  type OpenRouterProvider,
} from "@openrouter/ai-sdk-provider";
import type { JSONValue, ProviderMetadata } from "ai";
import { DEFAULT_AGENT_MODEL_ID } from "@/lib/agent-models";
import { DEFAULT_NARRATIVE_MODEL_ID } from "@/lib/narrative-models";

export const MODEL_DEFAULTS = {
  // The curated narrator list (lib/narrative-models.ts) is the one source for
  // narrator options; the resolver below accepts any world-override id.
  narrative: DEFAULT_NARRATIVE_MODEL_ID,
  // state + tool both default to the curated in-session agent default
  // (lib/agent-models.ts). state backs the post-turn agents + authoring; tool
  // backs intake + the scene composer.
  state: DEFAULT_AGENT_MODEL_ID,
  tool: DEFAULT_AGENT_MODEL_ID,
  embedding: "openai/text-embedding-3-small",
} as const;

export function isDemoMode(): boolean {
  return !process.env.OPENROUTER_API_KEY || process.env.AI_FAKE === "1";
}

/**
 * The upstream provider OpenRouter actually routed a generation to (e.g.
 * "DeepInfra", "Together"), read from the response's `providerMetadata`.
 * Returns null when the metadata is absent. Used for the Inspector's per-leg
 * provider attribution — correlate it with latency to spot slow providers.
 */
export function routedProvider(
  meta: ProviderMetadata | undefined,
): string | null {
  const provider = meta?.openrouter?.provider;
  return typeof provider === "string" ? provider : null;
}

/**
 * Per-model OpenRouter provider exclusions, keyed by model id. A base provider
 * slug (lowercase, e.g. "deepinfra") matches every endpoint/variant for that
 * provider.
 *
 * GLM 5.2: DeepInfra advertises a low latency but in practice streams it
 * incredibly slowly (~82s for three paragraphs of narration), so the
 * latency-sorted routing below keeps landing on it. Drop it from the candidate
 * set for that model — `allow_fallbacks` stays on, so this only narrows the
 * pool, never a reliability loss.
 */
const PROVIDER_IGNORE: Readonly<Record<string, readonly string[]>> = {
  "z-ai/glm-5.2": ["deepinfra"],
};

/** OpenRouter `provider` routing block (the subset of knobs we set), shaped as a JSON object for `providerOptions`. */
export type OpenRouterRouting = Record<string, JSONValue>;

/**
 * Per-model narrator `reasoning` knob, keyed by model id. Ruled from the behavioral
 * eval (narrator-prompt-focus.eval-results.md, Run 2 — the pairwise re-judge, 2026-06-29):
 *
 * - **Aion 2.0** (session default) → `effort:"low"`: Run 2 ranked it 67% vs 33% for
 *   default — it suppresses the residual "hi"-beat doting/errand-invention at no quality
 *   cost. (`enabled:false` stays **off the table** — the AionLabs endpoint rejects it,
 *   "Reasoning is mandatory for this endpoint"; all 12 `off` eval cells died.)
 * - **GLM 5.2** (chat default) → `effort:"low"`: Run 2's sharper read put `low` first
 *   (Borda 61%), default a close second, `off` worst. (`off` is the deterministic *latency*
 *   win — sub-500ms TTFT — if chat first-token latency ever outranks the marginal quality.)
 *
 * Applies to BOTH lanes (session + chat) since both build options here, so a model gets
 * its knob wherever it narrates. Models not listed send no reasoning option (model default).
 */
const NARRATOR_REASONING: Readonly<Record<string, JSONValue>> = {
  "aion-labs/aion-2.0": { effort: "low" },
  "z-ai/glm-5.2": { effort: "low" },
};

/**
 * Build the OpenRouter `provider` routing block for a model: latency-sorted when
 * `sortLatency` is set, plus any per-model exclusions from PROVIDER_IGNORE.
 * Returns undefined when neither knob applies, so callers can omit `provider`
 * entirely rather than send an empty object.
 */
export function providerRouting(
  modelId: string,
  opts: { sortLatency?: boolean } = {},
): OpenRouterRouting | undefined {
  const routing: OpenRouterRouting = {};
  if (opts.sortLatency) routing.sort = "latency";
  const ignore = PROVIDER_IGNORE[modelId];
  if (ignore && ignore.length > 0) routing.ignore = [...ignore];
  return Object.keys(routing).length > 0 ? routing : undefined;
}

/**
 * The full `providerOptions.openrouter` block for a **narrator** generation — the
 * session turn stream (pipeline.ts) and the character-chat stream
 * (engine/character-chat.ts) both build their provider options here, so the two
 * lanes never drift. Wraps latency routing + per-model provider exclusions
 * (providerRouting) and the per-model reasoning knob (NARRATOR_REASONING) in the
 * `openrouter` envelope. Returns undefined when nothing applies, so callers can omit
 * `providerOptions` entirely rather than send an empty object.
 *
 * The reasoning knob is per-model and eval-ruled (NARRATOR_REASONING above — Aion
 * `effort:low`, GLM `effort:low`). Note `effort:"minimal"` was a
 * no-op on Aion in a 2026-06-21 probe; the 2026-06-28 behavioral eval (Run 2) measured
 * *output* rather than reasoning-token usage and found `effort:"low"` a positive signal.
 */
export function narrativeProviderOptions(
  modelId: string,
  opts: { sortLatency?: boolean } = {},
): { openrouter: Record<string, JSONValue> } | undefined {
  const openrouter: Record<string, JSONValue> = {};
  const provider = providerRouting(modelId, opts);
  if (provider) openrouter.provider = provider;
  const reasoning = NARRATOR_REASONING[modelId];
  if (reasoning) openrouter.reasoning = reasoning;
  return Object.keys(openrouter).length > 0 ? { openrouter } : undefined;
}

let cachedProvider: OpenRouterProvider | undefined;

export function openrouter(): OpenRouterProvider {
  cachedProvider ??= createOpenRouter({
    apiKey: process.env.OPENROUTER_API_KEY ?? "demo",
    headers: {
      "HTTP-Referer": "http://localhost:3200",
      "X-Title": "Vesper",
    },
  });
  return cachedProvider;
}

// Text-model selection is **code or UI only** — there is no env override layer.
// The narrator + in-session agent models come from the curated code defaults
// (lib/narrative-models.ts, lib/agent-models.ts) or a per-world UI choice (world
// creation + World tab); embeddings + the tool model default purely in code. A
// retired/typo'd env value can no longer silently shadow these (it once pinned the
// agent model to the pulled `openrouter/owl-alpha` stealth slug).
export function narrativeModelId(worldModel?: string | null): string {
  return worldModel?.trim() || MODEL_DEFAULTS.narrative;
}

export function stateModelId(): string {
  return MODEL_DEFAULTS.state;
}

export function toolModelId(): string {
  return MODEL_DEFAULTS.tool;
}

/**
 * Resolver for the **in-session, non-narrator text agents** (intake + the four
 * post-turn agents): the world's per-session override (set from the World tab),
 * else the curated default (lib/agent-models.ts). The authoring agents and the
 * image pipeline deliberately do NOT call this — they stay on the plain
 * `stateModelId`/`toolModelId` defaults, outside the session switch.
 */
export function agentModelId(worldAgentModel?: string | null): string {
  return worldAgentModel?.trim() || MODEL_DEFAULTS.state;
}

export function embeddingModelId(): string {
  return MODEL_DEFAULTS.embedding;
}
