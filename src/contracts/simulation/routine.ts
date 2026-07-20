import { z } from "zod";
import {
  createCommandEnvelopeSchema,
  createCommandResultSchema,
  createEventEnvelopeSchema,
} from "./envelopes";
import { commandIdSchema, composeSimulationId, storySecondSchema, worldCharacterIdSchema } from "./identity";
import { simulationLodSchema } from "./lod";

/**
 * E6.2 — the background-life routine controller (engine.spec §19.1–19.2,
 * §27–28). Named actors at `event` simulation LOD advance their routine at
 * material transitions only: a `routine_policy_due` alarm fires at the
 * actor's own rhythm boundary, deterministic policy scores the legal
 * candidates with versioned fixed-point weights, and the chosen outcome
 * commits atomically through the ordinary body law — zero model calls, zero
 * per-minute work.
 */

/**
 * Every weights version that has ever written a decision event — history is
 * immutable, so parsing persisted events accepts the whole list while new
 * writes always use the current version.
 */
export const routinePolicyWeightsVersions = ["routine-policy-v1", "routine-policy-v2"] as const;
export const routinePolicyWeightsVersionSchema = z.enum(routinePolicyWeightsVersions);
export const routinePolicyDerivationVersion = "routine-policy-v2" as const;

// ---------------------------------------------------------------------------
// Candidate vocabulary + versioned weights (§19.2 — registry data)
// ---------------------------------------------------------------------------

/**
 * The closed v2 candidate set (`eat_meal` joined in E6.2 slice 2). The
 * vocabulary order IS the tie order: a later candidate must STRICTLY outscore
 * the running winner to take it, so equal non-hold scores keep the earlier
 * candidate and anything not strictly above zero keeps `hold` — the
 * ever-legal deterministic fallback.
 */
export const routineCandidateIds = ["begin_sleep", "eat_meal", "hold"] as const;
export const routineCandidateIdSchema = z.enum(routineCandidateIds);
export type RoutineCandidateId = z.infer<typeof routineCandidateIdSchema>;

/**
 * Why a candidate was illegal at scoring time, captured on the decision
 * event so the audit explains itself (§19.2 — never a model's private
 * chain of thought; these are deterministic gate names).
 * `no_eligible_item` is `eat_meal`'s §26.5 gate: the actor is inside a meal
 * window but no eligible consumable is within reach.
 */
export const routineIllegalReasons = [
  "already_asleep",
  "holding_claims",
  "in_engagement",
  "no_eligible_item",
] as const;
export const routineIllegalReasonSchema = z.enum(routineIllegalReasons);
export type RoutineIllegalReason = z.infer<typeof routineIllegalReasonSchema>;

/**
 * The obligation penalty on `begin_sleep`: a live obligation whose actBy
 * falls inside the coming sleep window subtracts 10 000 from the sleep score
 * — above the entire periodic circadian range (bedtime 3 500, trough peak
 * 8 900, `circadianCurveV1`), so an obligation always outranks routine
 * bedtime sleep. Deliberately BELOW where escalation pushes the sleep score
 * after ~21h past the actor's normal waking span (312/h) — a badly
 * sleep-deprived actor eventually sleeps through an obligation, emergently,
 * with no special case. (v1 scored the same 10 000 on `hold` instead; v2
 * moved it onto sleep so an evening obligation cannot outrank an instant
 * midday meal — the sleep-vs-hold decision boundary is unchanged.)
 * Versioned registry data.
 */
export const ROUTINE_SLEEP_OBLIGATION_PENALTY_FIXED_POINT = 10_000 as const;

/**
 * What `eat_meal` scores inside one of the actor's authored meal windows
 * (outside a window it scores 0 and `hold` keeps the tie — the same
 * due-inside-your-window law sleep follows, so disjoint windows never
 * compete). Where an authored meal window OVERLAPS the sleep window, 6 000
 * beats the 3 500 bedtime anchor (supper first), while escalation (312/h
 * past the normal waking span) pushes sleep past 6 000 after ~8h of overdue
 * sleep — a badly deprived actor sleeps through the overlap, emergently.
 * Eating is instantaneous (§26.6: one command, one atomic record), so no
 * obligation penalty applies. Versioned registry data.
 */
export const ROUTINE_MEAL_WEIGHT_FIXED_POINT = 6_000 as const;

export const routineScoredCandidateSchema = z
  .object({
    id: routineCandidateIdSchema,
    scoreFixedPoint: z.number().int().min(-1_000_000).max(1_000_000),
    legal: z.boolean(),
    illegalReason: routineIllegalReasonSchema.optional(),
  })
  .strict()
  .refine((candidate) => candidate.legal === (candidate.illegalReason === undefined), {
    message: "illegalReason must be present exactly when the candidate is illegal",
    path: ["illegalReason"],
  });
export type RoutineScoredCandidate = z.infer<typeof routineScoredCandidateSchema>;

// ---------------------------------------------------------------------------
// Trigger identity — versioned by arming sequence (E5.4 restock precedent)
// ---------------------------------------------------------------------------

export function routinePolicyUniquenessKey(actorId: string, armedAtSequence: number): string {
  return composeSimulationId("routine-policy", [actorId, String(armedAtSequence)]);
}

/** Prefix retiring every arming attempt for one actor regardless of version. */
export function routinePolicyUniquenessKeyPrefix(actorId: string): string {
  return `${composeSimulationId("routine-policy", [actorId])}:`;
}

// ---------------------------------------------------------------------------
// run_routine_policy — trigger-dispatched, system principal only
// ---------------------------------------------------------------------------

const runRoutinePolicyPayloadSchema = z
  .object({
    actorId: worldCharacterIdSchema,
    /** The branch sequence at arming — the alarm's identity version, echoed
     * for debuggability; freshness is re-validated structurally at fire time
     * (LOD still `event`, not asleep, rhythm still present). */
    armedAtSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

export const runRoutinePolicyCommandSchema = createCommandEnvelopeSchema(
  "run_routine_policy",
  1,
  runRoutinePolicyPayloadSchema,
);

export const runRoutinePolicyRejectionCodes = [
  "invalid_command",
  "duplicate_command_id",
  "branch_mismatch",
  "unauthorized_principal",
  "actor_not_found",
  "routine_stale",
] as const;
export const runRoutinePolicyRejectionCodeSchema = z.enum(runRoutinePolicyRejectionCodes);
export const runRoutinePolicyCommandResultSchema = createCommandResultSchema(
  runRoutinePolicyRejectionCodeSchema,
);

// ---------------------------------------------------------------------------
// routine_policy_resolved — the §19.2 decision record (§6.4 capture)
// ---------------------------------------------------------------------------

const routinePolicyResolvedPayloadSchema = z
  .object({
    actorId: worldCharacterIdSchema,
    chosenCandidateId: routineCandidateIdSchema,
    /** Every candidate with its deterministic score — the audit explanation. */
    candidates: z.array(routineScoredCandidateSchema).min(1).max(8),
    weightsVersion: routinePolicyWeightsVersionSchema,
    /** The simulation LOD that admitted this run, captured at fire time. */
    lodSimulation: simulationLodSchema,
    /** Present exactly when `begin_sleep` was chosen: the condition this
     * same command's causation-chained train applies. */
    sleep: z
      .object({
        conditionId: z.string().min(1).max(1_024),
        expiresAtStorySecond: storySecondSchema,
      })
      .strict()
      .optional(),
    /** Present exactly when `eat_meal` was chosen: the §26.5-selected item
     * this same command's causation-chained §26.6 consumption train eats. */
    meal: z
      .object({
        itemId: z.string().min(1).max(1_024),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((payload) => (payload.chosenCandidateId === "begin_sleep") === (payload.sleep !== undefined), {
    message: "sleep detail must be present exactly when begin_sleep was chosen",
    path: ["sleep"],
  })
  .refine((payload) => (payload.chosenCandidateId === "eat_meal") === (payload.meal !== undefined), {
    message: "meal detail must be present exactly when eat_meal was chosen",
    path: ["meal"],
  });

export const routinePolicyResolvedEventSchema = createEventEnvelopeSchema(
  "routine_policy_resolved",
  1,
  routinePolicyResolvedPayloadSchema,
).extend({ commandId: commandIdSchema });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RunRoutinePolicyCommand = z.infer<typeof runRoutinePolicyCommandSchema>;
export type RunRoutinePolicyCommandInput = z.input<typeof runRoutinePolicyCommandSchema>;
export type RunRoutinePolicyRejectionCode = z.infer<typeof runRoutinePolicyRejectionCodeSchema>;
export type RunRoutinePolicyCommandResult = z.infer<typeof runRoutinePolicyCommandResultSchema>;
export type RoutinePolicyResolvedEvent = z.infer<typeof routinePolicyResolvedEventSchema>;
