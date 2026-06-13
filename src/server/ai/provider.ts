import { createOpenRouter, type OpenRouterProvider } from "@openrouter/ai-sdk-provider";
import { DEFAULT_NARRATIVE_MODEL_ID } from "@/lib/narrative-models";

export const MODEL_DEFAULTS = {
  // The curated narrator list (lib/narrative-models.ts) is the one source for
  // narrator options; the resolver below accepts any world-override id.
  narrative: DEFAULT_NARRATIVE_MODEL_ID,
  state: "google/gemini-2.5-flash",
  tool: "google/gemini-2.5-flash",
  embedding: "openai/text-embedding-3-small",
  image: "black-forest-labs/flux.2-pro",
  imageFast: "black-forest-labs/flux.2-flex",
} as const;

export function isDemoMode(): boolean {
  return !process.env.OPENROUTER_API_KEY || process.env.AI_FAKE === "1";
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

export function embeddingModelId(): string {
  return process.env.EMBEDDING_MODEL || MODEL_DEFAULTS.embedding;
}

export function imageModelId(fast = false): string {
  return fast
    ? process.env.IMAGE_MODEL_FAST || MODEL_DEFAULTS.imageFast
    : process.env.IMAGE_MODEL || MODEL_DEFAULTS.image;
}

/**
 * Image generation model with image-only output modality. The provider's
 * default `modalities: ["image", "text"]` is rejected by image-only models
 * like flux ("No endpoints found that support the requested output
 * modalities"); extraBody spreads after the base body and overrides it.
 */
export function imageModel(fast = false) {
  return openrouter().imageModel(imageModelId(fast), {
    extraBody: { modalities: ["image"] },
  });
}
