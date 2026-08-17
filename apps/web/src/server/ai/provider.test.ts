import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_AGENT_MODEL_ID } from "@/lib/agent-models";
import { DEFAULT_SCENE_COMPOSER_MODEL_ID } from "@/lib/composer-models";
import {
  DEFAULT_CHARACTER_CHAT_MODEL_ID,
  DEFAULT_NARRATIVE_MODEL_ID,
  NARRATIVE_MODELS,
  narrativeModelProvider,
} from "@/lib/narrative-models";
import {
  agentModelId,
  chatNarrativeModelId,
  narrativeModelId,
  narrativeProviderOptions,
  providerRouting,
  textModel,
} from "./provider";

describe("strict model-id resolvers (codebase-review B3)", () => {
  it("passes a curated id through", () => {
    expect(narrativeModelId("z-ai/glm-5.2")).toBe("z-ai/glm-5.2");
    expect(agentModelId("z-ai/glm-5.2")).toBe("z-ai/glm-5.2");
  });

  it("coerces an uncurated slug to the default — never bills an arbitrary model", () => {
    expect(narrativeModelId("openai/o5-preview")).toBe(DEFAULT_NARRATIVE_MODEL_ID);
    expect(agentModelId("openai/o5-preview")).toBe(DEFAULT_AGENT_MODEL_ID);
  });

  it("empty / null / whitespace fall back to the default", () => {
    expect(narrativeModelId()).toBe(DEFAULT_NARRATIVE_MODEL_ID);
    expect(narrativeModelId(null)).toBe(DEFAULT_NARRATIVE_MODEL_ID);
    expect(narrativeModelId("  ")).toBe(DEFAULT_NARRATIVE_MODEL_ID);
    expect(agentModelId("")).toBe(DEFAULT_AGENT_MODEL_ID);
  });
});

describe("providerRouting", () => {
  it("returns undefined when no routing knob applies", () => {
    expect(providerRouting("~deepseek/deepseek-v4-flash-latest")).toBeUndefined();
  });

  it("sorts by latency when asked", () => {
    expect(providerRouting("~deepseek/deepseek-v4-flash-latest", { sortLatency: true })).toEqual({ sort: "latency" });
  });

  it("drops the per-model bad endpoint (DeepInfra on GLM 5.2)", () => {
    expect(providerRouting("z-ai/glm-5.2")).toEqual({ ignore: ["deepinfra"] });
  });

  it("prefers the cheap fp8 endpoints for the pinned composer, without making it a restriction", () => {
    // Unrouted, OpenRouter picks this snapshot by its own price/latency/uptime blend and
    // lands on endpoints at ~2× the cheapest available — on the model that runs for every
    // scene image. `allow_fallbacks` keeps a total outage of both a routing miss rather
    // than a failed composition.
    expect(providerRouting(DEFAULT_SCENE_COMPOSER_MODEL_ID)).toEqual({
      order: ["gmicloud/fp8", "deepinfra/fp8"],
      allow_fallbacks: true,
    });
  });
});

describe("narrativeProviderOptions", () => {
  // Per-model reasoning knobs are eval-ruled (narrator-prompt-focus.eval-results.md
  // Run 2 — see NARRATOR_REASONING in provider.ts): Aion/GLM effort:low.
  it("sets effort:low for the Aion narrator, even with no routing", () => {
    expect(narrativeProviderOptions("aion-labs/aion-2.0")).toEqual({
      openrouter: { reasoning: { effort: "low" } },
    });
    expect(narrativeProviderOptions("aion-labs/aion-2.0", { sortLatency: true })).toEqual({
      openrouter: { provider: { sort: "latency" }, reasoning: { effort: "low" } },
    });
  });

  it("sends NO reasoning knob for Aion 3.0 (reverted 2026-07-09 — un-evaled, hang suspect)", () => {
    // The provisional effort:low was pulled; Aion 3.0 now sends the model default.
    expect(narrativeProviderOptions("aion-labs/aion-3.0")).toBeUndefined();
    expect(narrativeProviderOptions("aion-labs/aion-3.0", { sortLatency: true })).toEqual({
      openrouter: { provider: { sort: "latency" } },
    });
  });

  it("combines latency routing, per-model exclusions, and the reasoning knob", () => {
    // GLM 5.2: latency routing + DeepInfra exclusion + effort:low.
    expect(narrativeProviderOptions("z-ai/glm-5.2", { sortLatency: true })).toEqual({
      openrouter: { provider: { sort: "latency", ignore: ["deepinfra"] }, reasoning: { effort: "low" } },
    });
  });

  it("carries only provider routing for a model with no reasoning ruling", () => {
    expect(narrativeProviderOptions("~deepseek/deepseek-v4-flash-latest", { sortLatency: true })).toEqual({
      openrouter: { provider: { sort: "latency" } },
    });
  });

  it("returns undefined when nothing applies (no routing, no reasoning ruling)", () => {
    expect(narrativeProviderOptions("~deepseek/deepseek-v4-flash-latest")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The second text provider (Featherless). Narrator ids only — see
// lib/narrative-models.ts §"Which upstream serves a row".
// ---------------------------------------------------------------------------

/** The curated Featherless row, read off the list so a re-labelled row cannot rot this file. */
const FEATHERLESS_MODEL_ID = NARRATIVE_MODELS.find((o) => o.provider === "featherless")?.id ?? "";

describe("multi-provider narrator routing", () => {
  it("the bench has a Featherless row to route", () => {
    expect(FEATHERLESS_MODEL_ID).not.toBe("");
    expect(narrativeModelProvider(FEATHERLESS_MODEL_ID)).toBe("featherless");
  });

  // The whole reason `providerRouting` is provider-aware: `sort`, `ignore` and
  // `order` name OpenRouter's own upstream endpoints. Sending them to Featherless
  // would be asking one vendor to honor another's query string.
  it("sends no OpenRouter routing block to a Featherless model, even when asked for latency sort", () => {
    expect(providerRouting(FEATHERLESS_MODEL_ID)).toBeUndefined();
    expect(providerRouting(FEATHERLESS_MODEL_ID, { sortLatency: true })).toBeUndefined();
  });

  it("sends no provider options at all to a Featherless narrator", () => {
    expect(narrativeProviderOptions(FEATHERLESS_MODEL_ID)).toBeUndefined();
    expect(narrativeProviderOptions(FEATHERLESS_MODEL_ID, { sortLatency: true })).toBeUndefined();
  });

  it("routes each id to the upstream that serves it", () => {
    // The AI SDK reports the provider that built the model; that is the observable
    // difference between the two transports without making a network call.
    expect(textModel(FEATHERLESS_MODEL_ID).provider).toContain("featherless");
    expect(textModel("aion-labs/aion-2.0").provider).toContain("openrouter");
  });

  it("routes an unknown id to OpenRouter — resolvers curate before anything reaches here", () => {
    expect(textModel("vendor/never-listed").provider).toContain("openrouter");
  });
});

describe("provider-key gate on narrator selection", () => {
  const original = process.env.FEATHERLESS_API_TOKEN;
  afterEach(() => {
    if (original === undefined) delete process.env.FEATHERLESS_API_TOKEN;
    else process.env.FEATHERLESS_API_TOKEN = original;
  });

  it("passes the Featherless pick through when the token is configured", () => {
    process.env.FEATHERLESS_API_TOKEN = "fl-test-token";
    expect(chatNarrativeModelId(FEATHERLESS_MODEL_ID)).toBe(FEATHERLESS_MODEL_ID);
    expect(narrativeModelId(FEATHERLESS_MODEL_ID)).toBe(FEATHERLESS_MODEL_ID);
  });

  // A missing token is a stale DEPLOYMENT, not a stale choice: the pick stays
  // stored and valid, and the turn degrades to a narrator that can actually answer
  // instead of spending itself on a guaranteed 401.
  it("degrades to the lane default when the token is missing or blank", () => {
    delete process.env.FEATHERLESS_API_TOKEN;
    expect(chatNarrativeModelId(FEATHERLESS_MODEL_ID)).toBe(DEFAULT_CHARACTER_CHAT_MODEL_ID);
    expect(narrativeModelId(FEATHERLESS_MODEL_ID)).toBe(DEFAULT_NARRATIVE_MODEL_ID);
    process.env.FEATHERLESS_API_TOKEN = "   ";
    expect(chatNarrativeModelId(FEATHERLESS_MODEL_ID)).toBe(DEFAULT_CHARACTER_CHAT_MODEL_ID);
  });

  it("leaves every OpenRouter narrator untouched by the gate", () => {
    delete process.env.FEATHERLESS_API_TOKEN;
    expect(chatNarrativeModelId("z-ai/glm-5.2")).toBe("z-ai/glm-5.2");
    expect(narrativeModelId("aion-labs/aion-2.0")).toBe("aion-labs/aion-2.0");
  });

  it("curates before it gates — an uncurated id still takes the lane default", () => {
    expect(chatNarrativeModelId("openai/o5-preview")).toBe(DEFAULT_CHARACTER_CHAT_MODEL_ID);
    expect(chatNarrativeModelId(null)).toBe(DEFAULT_CHARACTER_CHAT_MODEL_ID);
  });
});
