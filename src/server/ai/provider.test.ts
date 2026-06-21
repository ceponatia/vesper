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
  // No reasoning knob is ever set: Aion's AionLabs endpoint ignores effort and
  // reasoning.max_tokens (2026-06-21 probe — see provider.ts), so the floor was
  // removed. These options now carry only provider routing.
  it("sets no reasoning knob for the Aion narrator — only latency routing", () => {
    expect(narrativeProviderOptions("aion-labs/aion-2.0")).toBeUndefined();
    expect(narrativeProviderOptions("aion-labs/aion-2.0", { sortLatency: true })).toEqual({
      openrouter: { provider: { sort: "latency" } },
    });
  });

  it("wraps latency routing + per-model exclusions in the openrouter envelope", () => {
    expect(narrativeProviderOptions("deepseek/deepseek-v4-flash", { sortLatency: true })).toEqual({
      openrouter: { provider: { sort: "latency" } },
    });
    expect(narrativeProviderOptions("z-ai/glm-5.2", { sortLatency: true })).toEqual({
      openrouter: { provider: { sort: "latency", ignore: ["deepinfra"] } },
    });
  });

  it("returns undefined when no routing knob applies", () => {
    expect(narrativeProviderOptions("deepseek/deepseek-v4-flash")).toBeUndefined();
  });
});
