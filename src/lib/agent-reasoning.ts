import { z } from "zod";

/**
 * Admin-only per-chat experiments for the structured helper agents. Narrator
 * reasoning is intentionally separate: these profiles only affect the small
 * JSON agents that observe and fold a completed chat exchange.
 */
export const AGENT_REASONING_PROFILE_IDS = [
  "off",
  "continuity",
  "synthesis",
  "broad_post_turn",
] as const;

export const strictAgentReasoningProfileSchema = z.enum(AGENT_REASONING_PROFILE_IDS);
export const agentReasoningProfileSchema = strictAgentReasoningProfileSchema.catch("off");
export type AgentReasoningProfileId = (typeof AGENT_REASONING_PROFILE_IDS)[number];

export interface AgentReasoningProfileOption {
  id: AgentReasoningProfileId;
  label: string;
  description: string;
}

export const AGENT_REASONING_PROFILES: readonly AgentReasoningProfileOption[] = [
  {
    id: "off",
    label: "Current — Off",
    description: "Reasoning stays disabled for every covered helper agent.",
  },
  {
    id: "continuity",
    label: "Continuity",
    description: "Reasoning for continuity, character, and per-character personal tracking.",
  },
  {
    id: "synthesis",
    label: "Synthesis",
    description: "Continuity profile plus off-screen developments and location sketches.",
  },
  {
    id: "broad_post_turn",
    label: "Broad post-turn",
    description: "Synthesis profile plus memory extraction and the reaction pulse.",
  },
] as const;

/**
 * Only experiment-worthy helper legs are represented here. Permission/contact
 * decision classifiers, intake, and other authority-sensitive classifiers are
 * deliberately absent, so an unknown/new leg fails closed to reasoning off.
 */
export const AGENT_REASONING_LEGS = [
  "memory",
  "continuity",
  "character",
  "personal",
  "pulse",
  "meanwhile",
  "scene_sketch",
] as const;
export type AgentReasoningLeg = (typeof AGENT_REASONING_LEGS)[number];

const ENABLED_LEGS: Readonly<Record<AgentReasoningProfileId, readonly AgentReasoningLeg[]>> = {
  off: [],
  continuity: ["continuity", "character", "personal"],
  synthesis: ["continuity", "character", "personal", "meanwhile", "scene_sketch"],
  broad_post_turn: [
    "memory",
    "continuity",
    "character",
    "personal",
    "pulse",
    "meanwhile",
    "scene_sketch",
  ],
};

/**
 * OpenRouter may spend most of maxOutputTokens on the hidden reasoning trace.
 * Preserve roughly the old completion allowance by multiplying the total cap.
 */
export const AGENT_REASONING_TOKEN_MULTIPLIER = 5;
export const AGENT_REASONING_MAX_OUTPUT_TOKENS = 32_768;

/** Reasoning has a much longer time-to-first-usable-JSON tail than extraction-only calls. */
export const AGENT_REASONING_TIMEOUT_MULTIPLIER = 4;
export const AGENT_REASONING_MIN_TIMEOUT_MS = 20_000;
export const AGENT_REASONING_MAX_TIMEOUT_MS = 120_000;

export interface AgentReasoningPlan {
  profileId: AgentReasoningProfileId;
  enabled: boolean;
  maxOutputTokens: number;
  timeoutMs: number;
  providerOptions?: {
    openrouter: {
      reasoning: {
        enabled: true;
        effort: "high";
        exclude: true;
      };
    };
  };
}

export function resolveAgentReasoningProfile(value: unknown): AgentReasoningProfileId {
  return agentReasoningProfileSchema.parse(value);
}

export function agentReasoningEnabled(
  profileId: AgentReasoningProfileId,
  leg: AgentReasoningLeg,
): boolean {
  return ENABLED_LEGS[profileId].includes(leg);
}

/**
 * Resolve the effective provider options and watchdog budgets for one call.
 * The off path returns the exact supplied budgets; callers continue sending
 * reasoning:{enabled:false}, preserving current behavior.
 */
export function agentReasoningPlan(input: {
  profileId: AgentReasoningProfileId;
  leg: AgentReasoningLeg;
  maxOutputTokens: number;
  timeoutMs: number;
}): AgentReasoningPlan {
  const enabled = agentReasoningEnabled(input.profileId, input.leg);
  if (!enabled) {
    return {
      profileId: input.profileId,
      enabled: false,
      maxOutputTokens: input.maxOutputTokens,
      timeoutMs: input.timeoutMs,
    };
  }

  return {
    profileId: input.profileId,
    enabled: true,
    maxOutputTokens: Math.min(
      AGENT_REASONING_MAX_OUTPUT_TOKENS,
      input.maxOutputTokens * AGENT_REASONING_TOKEN_MULTIPLIER,
    ),
    timeoutMs: Math.min(
      AGENT_REASONING_MAX_TIMEOUT_MS,
      Math.max(AGENT_REASONING_MIN_TIMEOUT_MS, input.timeoutMs * AGENT_REASONING_TIMEOUT_MULTIPLIER),
    ),
    providerOptions: {
      openrouter: {
        reasoning: { enabled: true, effort: "high", exclude: true },
      },
    },
  };
}
