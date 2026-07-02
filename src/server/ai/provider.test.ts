import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_MODEL_ID } from "@/lib/agent-models";
import { DEFAULT_NARRATIVE_MODEL_ID } from "@/lib/narrative-models";
import { agentModelId, narrativeModelId, narrativeProviderOptions, providerRouting } from "./provider";

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
    expect(providerRouting("deepseek/deepseek-v4-flash")).toBeUndefined();
  });

  it("sorts by latency when asked", () => {
    expect(providerRouting("deepseek/deepseek-v4-flash", { sortLatency: true })).toEqual({ sort: "latency" });
  });

  it("drops the per-model bad endpoint (DeepInfra on GLM 5.2)", () => {
    expect(providerRouting("z-ai/glm-5.2")).toEqual({ ignore: ["deepinfra"] });
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

  it("combines latency routing, per-model exclusions, and the reasoning knob", () => {
    // GLM 5.2: latency routing + DeepInfra exclusion + effort:low.
    expect(narrativeProviderOptions("z-ai/glm-5.2", { sortLatency: true })).toEqual({
      openrouter: { provider: { sort: "latency", ignore: ["deepinfra"] }, reasoning: { effort: "low" } },
    });
  });

  it("carries only provider routing for a model with no reasoning ruling", () => {
    expect(narrativeProviderOptions("deepseek/deepseek-v4-flash", { sortLatency: true })).toEqual({
      openrouter: { provider: { sort: "latency" } },
    });
  });

  it("returns undefined when nothing applies (no routing, no reasoning ruling)", () => {
    expect(narrativeProviderOptions("deepseek/deepseek-v4-flash")).toBeUndefined();
  });
});
