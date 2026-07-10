import { z, type ZodType } from "zod";

/**
 * Per-array caps on this LLM-parsed brief (docs/resilience.md §3, "trust
 * nothing"). `maxOutputTokens` is the only *implicit* bound today; a token-cap
 * bump would silently lift the ceiling, and these arrays feed deterministic
 * prompt builders / the reaction + puppet-guardrail seams downstream.
 *
 * Bounded here at the SCHEMA via `.transform((a) => a.slice(0, MAX))` (applied
 * after `.default([])`) — NOT `.max()`: this brief degrades whole-object
 * (`generateChecked` returns `emptyIntentBrief()` on any parse failure, and the
 * intake call would also fall back to the regex intent), so a rejecting `.max()`
 * would throw the whole brief away. A graceful slice keeps the first N and drops
 * the tail, mirroring the merge-side slices for the post-turn agent arrays
 * (src/server/engine/merge.ts). Generous values — a legitimate turn never
 * approaches them; the cap only fires on a runaway/adversarial flood.
 */
const MAX_ADDRESSED_NPCS = 30;
const MAX_SOCIAL_ACTS = 30;
const MAX_NARRATED_NPC_BEHAVIORS = 30;
const MAX_CO_TRAVEL_TARGETS = 30;
const MAX_CHECK_ATTRIBUTES = 30;

/** Graceful per-array cap: keep the first `max`, drop the tail (never rejects). */
const capArray = <T>(schema: ZodType<T>, max: number) =>
  z
    .array(schema)
    .default([])
    .transform((a) => a.slice(0, max));

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
  addressedNpcs: capArray(z.string(), MAX_ADDRESSED_NPCS),

  /**
   * Social acts the player directs at a character — the seam for authored
   * likes/dislikes (personality-and-state.spec.md §6). Each is a concept id (from
   * the interaction-concept vocabulary) aimed at a present character by name. An
   * **array** for forward headroom; v1 resolves only the primary (first) entry.
   * Empty on the regex fallback ⇒ no reaction fires.
   */
  socialActs: capArray(
    z.object({
      concept: z.string().min(1),
      target: z.string().min(1),
    }),
    MAX_SOCIAL_ACTS,
  ),

  /**
   * Player-authored NPC behaviour — the puppet-guardrail seam
   * (personality-and-state.spec.md §6, Note 2). Each entry names a present
   * character whose dialogue / affection / action the player's prose authored,
   * optionally classified to an interaction concept so a deterministic rule can
   * compare it to that character's disposition (the deflection fires only on a
   * *contradiction*). An **array** for forward headroom; empty on the regex
   * fallback ⇒ the guardrail never fires. Distinct from `socialActs` (the
   * player's OWN acts toward an NPC) and from `movement.kind:"narrated_npc"`
   * (physical relocation, owned by movement-authority).
   */
  narratedNpcBehaviors: capArray(
    z.object({
      npc: z.string().min(1),
      concept: z.string().optional(),
      summary: z.string().optional(),
    }),
    MAX_NARRATED_NPC_BEHAVIORS,
  ),

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
      coTravelTargets: capArray(z.string(), MAX_CO_TRAVEL_TARGETS),
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
      relevantAttributeIds: capArray(z.string(), MAX_CHECK_ATTRIBUTES),
      stakes: z.enum(["low", "med", "high"]).catch("low").default("low"),
    })
    .optional(),

  /**
   * Narration-focus planner (narrator-prompt-focus.plan.md §Phase 3) — the intake
   * agent's read of HOW the narrator should shape this turn's response, folded into
   * the brief instead of run as a second LLM call. Consumed by `buildResponseShape`
   * (engine/scene.ts) to enrich the §Phase-2 "## Response shape" steers.
   *
   * **`.optional()` at the object level — deliberately NOT `.default()`ed**, unlike
   * the rest of this brief: its absence is the signal that there is no planner
   * signal (the regex fallback / `emptyIntentBrief()` / any degrade leaves it
   * `undefined`), so `buildResponseShape` degrades cleanly to its deterministic
   * derivation. When the agent DOES emit it, each leaf is `.catch().default()`ed so
   * one bad field doesn't drop the object. It only shapes focus + reaction scale; it
   * never overrides deterministic authority (presence/wardrobe/movement/perception,
   * or the authored reaction band — which always wins over `reactionScale`).
   */
  focus: z
    .object({
      /**
       * The narrator's primary job this turn — finer than `actionType`.
       * `react_emotionally` was renamed `acknowledge_emotional_beat` (narrator-prompt-consolidation
       * slice 1 — "react emotionally" read as an instruction to make emotion conspicuous; the
       * authored reaction band owns magnitude). Old persisted briefs degrade to "converse" via
       * the `.catch()` — harmless (the brief is consumed the turn it's made; storage is inspector data).
       */
      primaryResponse: z
        // Pre-2026-07-10 vocabulary (rollback): ["converse", "answer_question", "resolve_action", "react_emotionally", "transition_scene", "ooc_answer"]
        .enum(["converse", "answer_question", "resolve_action", "acknowledge_emotional_beat", "transition_scene", "ooc_answer"])
        .catch("converse")
        .default("converse"),
      /** How large any in-world reaction to the player should be (the authored band overrides this). */
      reactionScale: z.enum(["none", "small", "moderate", "strong"]).catch("none").default("none"),
      /** Whether the narrator may open a new thread beyond the player's beat. */
      allowedNewTopic: z.enum(["none", "one_open_thread", "urgent_scene_event"]).catch("none").default("none"),
      /** The turn's overall form — the per-turn analogue of the global shape profile. */
      suggestedShape: z
        .enum(["concise_exchange", "scene_establishing", "multi_party", "action_resolution"])
        .catch("concise_exchange")
        .default("concise_exchange"),
    })
    .optional(),

  /** One-line rationale for the classification — diagnostics/inspector only. */
  notes: z.string().default(""),
});

export type IntentBrief = z.infer<typeof intentBriefSchema>;

/** The narration-focus planner sub-brief (present only when intake emits it). */
export type NarrationFocus = NonNullable<IntentBrief["focus"]>;

/** The degraded/empty brief — identical to today's behavior (no intent detected). */
export function emptyIntentBrief(): IntentBrief {
  return intentBriefSchema.parse({});
}
