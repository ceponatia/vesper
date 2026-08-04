import { describe, expect, it } from "vitest";
import {
  AGENT_REASONING_LEGS,
  AGENT_REASONING_PROFILE_IDS,
  agentReasoningEnabled,
  agentReasoningPlan,
  resolveAgentReasoningProfile,
} from "./agent-reasoning";

describe("agent reasoning profiles", () => {
  it("fails unknown stored values closed to off", () => {
    expect(resolveAgentReasoningProfile("future-profile")).toBe("off");
    expect(resolveAgentReasoningProfile(null)).toBe("off");
  });

  it("keeps every covered leg off in the default profile", () => {
    for (const leg of AGENT_REASONING_LEGS) {
      expect(agentReasoningEnabled("off", leg)).toBe(false);
    }
  });

  it("enables only the curated profile matrix", () => {
    expect(agentReasoningEnabled("continuity", "continuity")).toBe(true);
    expect(agentReasoningEnabled("continuity", "memory")).toBe(false);
    expect(agentReasoningEnabled("synthesis", "meanwhile")).toBe(true);
    expect(agentReasoningEnabled("synthesis", "pulse")).toBe(false);
    expect(agentReasoningEnabled("broad_post_turn", "memory")).toBe(true);
    expect(agentReasoningEnabled("broad_post_turn", "pulse")).toBe(true);
    expect(AGENT_REASONING_PROFILE_IDS).toHaveLength(4);
  });

  it("preserves ordinary budgets when reasoning is off", () => {
    expect(
      agentReasoningPlan({
        profileId: "off",
        leg: "continuity",
        maxOutputTokens: 700,
        timeoutMs: 6_000,
      }),
    ).toEqual({
      profileId: "off",
      enabled: false,
      maxOutputTokens: 700,
      timeoutMs: 6_000,
    });
  });

  it("expands the token and timeout budgets when reasoning is enabled", () => {
    expect(
      agentReasoningPlan({
        profileId: "continuity",
        leg: "continuity",
        maxOutputTokens: 700,
        timeoutMs: 6_000,
      }),
    ).toEqual({
      profileId: "continuity",
      enabled: true,
      maxOutputTokens: 3_500,
      timeoutMs: 24_000,
      providerOptions: {
        openrouter: {
          reasoning: { enabled: true, effort: "high", exclude: true },
        },
      },
    });
  });

  it("caps experimental budgets so an oversized leg cannot wait or bill without bound", () => {
    const plan = agentReasoningPlan({
      profileId: "broad_post_turn",
      leg: "memory",
      maxOutputTokens: 20_000,
      timeoutMs: 90_000,
    });

    expect(plan.maxOutputTokens).toBe(32_768);
    expect(plan.timeoutMs).toBe(120_000);
  });
});
