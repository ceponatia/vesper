import { createOpenRouter, type OpenRouterProvider } from "@openrouter/ai-sdk-provider";
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
export function routedProvider(meta: ProviderMetadata | undefined): string | null {
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
 * Build the OpenRouter `provider` routing block for a model: latency-sorted when
 * `sortLatency` is set, plus any per-model exclusions from PROVIDER_IGNORE.
 * Returns undefined when neither knob applies, so callers can omit `provider`
 * entirely rather than send an empty object.
 */
export function providerRouting(modelId: string, opts: { sortLatency?: boolean } = {}): OpenRouterRouting | undefined {
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
 * lanes never drift. Currently just wraps latency routing + per-model provider
 * exclusions (providerRouting) in the `openrouter` envelope. Returns undefined
 * when nothing applies, so callers can omit `providerOptions` entirely rather
 * than send an empty object.
 *
 * No reasoning knob is set here on purpose: the default narrator (Aion 2.0,
 * `aion-labs/aion-2.0`) is served only by the first-party AionLabs endpoint,
 * which **ignores** OpenRouter's reasoning controls — a 2026-06-21 live probe
 * showed `effort:"minimal"` and even `reasoning.max_tokens:128` left reasoning
 * usage unchanged (~220 tok/turn, identical to baseline), and `effort:"none"` /
 * `reasoning.enabled:false` are rejected outright ("Reasoning is mandatory for
 * this endpoint"). So flooring effort bought nothing; it was removed. If a
 * narrator that *does* honor effort is added, reintroduce a per-model knob here.
 */
export function narrativeProviderOptions(
  modelId: string,
  opts: { sortLatency?: boolean } = {},
): { openrouter: Record<string, JSONValue> } | undefined {
  const provider = providerRouting(modelId, opts);
  return provider ? { openrouter: { provider } } : undefined;
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

export function narrativeModelId(worldModel?: string | null): string {
  return worldModel?.trim() || process.env.NARRATIVE_MODEL || MODEL_DEFAULTS.narrative;
}

export function stateModelId(): string {
  return process.env.STATE_MODEL || MODEL_DEFAULTS.state;
}

export function toolModelId(): string {
  return process.env.TOOL_MODEL || MODEL_DEFAULTS.tool;
}

/**
 * Resolver for the **in-session, non-narrator text agents** (intake + the four
 * post-turn agents): the world's per-session override (set from the World tab),
 * else `AGENT_MODEL`, else the curated default (deepseek-v4-flash). The authoring
 * agents and the image pipeline deliberately do NOT call this — they stay on the
 * plain `stateModelId`/`toolModelId` defaults, outside the session switch.
 */
export function agentModelId(worldAgentModel?: string | null): string {
  return worldAgentModel?.trim() || process.env.AGENT_MODEL || MODEL_DEFAULTS.state;
}

export function embeddingModelId(): string {
  return process.env.EMBEDDING_MODEL || MODEL_DEFAULTS.embedding;
}

// Image generation no longer routes through OpenRouter. After the 2026-06-19
// Flux removal (scene-images.plan.md) every image lane is Venice/Qwen — see
// `server/ai/venice.ts`. OpenRouter stays for text/LLM work only.
