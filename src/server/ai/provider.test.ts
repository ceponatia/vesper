import { describe, expect, it } from "vitest";
import { narrativeProviderOptions, providerRouting } from "./provider";

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
