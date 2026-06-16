import { z } from "zod";

/**
 * Pre-narrator intake output (docs/developer-notes/pre-narrator-agents.spec.md).
 * The intake agent reads the player's input BEFORE narration and reports what
 * they are trying to do; the brief is persisted on the turn row and consumed by
 * the deterministic prompt builders (exposure / glance / awareness) and the
 * post-turn continuity audit.
 *
 * Conventions mirror the post-turn agent schemas (turns/agent-results.ts):
 * every field .default()ed so the parsed-empty object IS the degraded fallback;
 * entities referenced by display name, never ids; leaf enums .catch()ed so one
 * bad field doesn't reject the object.
 *
 * The sense/target fields mirror engine `SceneIntent` so the regex fallback and
 * the `sceneIntentFromBrief` adapter are lossless. `movement` / `appointment` /
 * `check` are **persisted seams**: written in v1, enforced later by the
 * movement-authority, scheduled-arrivals, and attribute-check specs.
 */
export const intentBriefSchema = z.object({
  actionType: z
    .enum([
      "converse",
      "move",
      "observe",
      "touch",
      "manipulate_item",
      "comms",
      "rest",
      "social_attempt",
      "intimate",
      "meta",
      "other",
    ])
    .catch("other")
    .default("other"),

  // Sense/target fields — mirror SceneIntent (display names / in-scope item names).
  lookTarget: z.string().optional(),
  touchTarget: z.string().optional(),
  smellTarget: z.string().optional(),
  /** NPC display name the player is tasting / kissing / licking (raises taste + touch). */
  tasteTarget: z.string().optional(),
  examineItem: z.string().optional(),
  enterLocation: z.string().optional(),
  /** NPC display names the player is speaking to / addressing this turn. */
  addressedNpcs: z.array(z.string()).default([]),

  /**
   * Movement classification (movement-authority.spec.md §1/§3). Persisted
   * seam — v1 records it; the merge does not yet enforce authority off it.
   * - self: the player moves their own body.
   * - narrated_npc: the player's prose moved an NPC (must NOT directly relocate them).
   * - co_travel_request: the player asks/invites an NPC to come along.
   * - implied_subspace: movement within the current node ("steps to the window") — no graph hop.
   */
  movement: z
    .object({
      kind: z
        .enum(["none", "self", "narrated_npc", "co_travel_request", "implied_subspace"])
        .catch("none")
        .default("none"),
      /** Willed destination (may be non-adjacent / multi-hop) — location display name. */
      destination: z.string().optional(),
      /** NPC display names the player invites along (co_travel_request). */
      coTravelTargets: z.array(z.string()).default([]),
    })
    .default({ kind: "none", coTravelTargets: [] }),

  /**
   * A player-arranged appointment (scheduled-arrivals.spec.md). Persisted
   * seam — intake recognises the deal; the engine does the when-to-set-out math
   * later. `timePhrase` is raw ("5:30", "after dinner"); the engine parses it.
   */
  appointment: z
    .object({
      withNpc: z.string().optional(),
      location: z.string().optional(),
      timePhrase: z.string().optional(),
      reason: z.string().default(""),
    })
    .optional(),

  /**
   * Attribute-relevant resolution (the deferred romance "consequence loop").
   * Persisted seam — intake names the relevant attributes + stakes; no resolver
   * consumes it yet.
   */
  check: z
    .object({
      relevantAttributeIds: z.array(z.string()).default([]),
      stakes: z.enum(["low", "med", "high"]).catch("low").default("low"),
    })
    .optional(),

  /** One-line rationale for the classification — diagnostics/inspector only. */
  notes: z.string().default(""),
});

export type IntentBrief = z.infer<typeof intentBriefSchema>;

/** The degraded/empty brief — identical to today's behavior (no intent detected). */
export function emptyIntentBrief(): IntentBrief {
  return intentBriefSchema.parse({});
}
