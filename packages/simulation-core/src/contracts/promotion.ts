import { z } from "zod";
import { inferenceLodSchema } from "./deliberation";
import {
  createCommandEnvelopeSchema,
  createCommandResultSchema,
  createEventEnvelopeSchema,
} from "./envelopes";
import { promotionSampledDetailSchema } from "./households";
import {
  cohortIdSchema,
  commandIdSchema,
  locationIdSchema,
  worldCharacterIdSchema,
  zoneIdSchema,
} from "./identity";

/**
 * E6.4 — actor promotion out of the aggregate. The item-promotion shape
 * generalized to actors: `promote_actor_from_cohort` is the ONLY path a named
 * actor comes to exist mid-branch. It reserves a conserved unit from the
 * source cohort (step 2), samples any detail the caller did not supply from a
 * named deterministic stream with the draw captured on the event (step 3),
 * emits `actor_materialized_from_aggregate` (step 4), and may only materialize
 * where the analytic presence read admits a person — a promoted actor can
 * never contradict aggregate history (step 5).
 */

export const actorPromotionDerivationVersion = "actor-promotion-v1" as const;

// ---------------------------------------------------------------------------
// Landing detail levels — a materialized actor is by definition at or above
// `event`: materializing INTO a no-scheduled-work level would be a
// contradiction in terms (the aggregate already was that).
// ---------------------------------------------------------------------------

export const promotionLandingSimulationLods = ["exact", "event"] as const;
export const promotionLandingSimulationLodSchema = z.enum(promotionLandingSimulationLods);
export type PromotionLandingSimulationLod = z.infer<typeof promotionLandingSimulationLodSchema>;

export const promotionLandingLodSchema = z
  .object({
    simulationLod: promotionLandingSimulationLodSchema,
    inferenceLod: inferenceLodSchema,
  })
  .strict();
export type PromotionLandingLod = z.infer<typeof promotionLandingLodSchema>;

// ---------------------------------------------------------------------------
// promote_actor_from_cohort — privileged (storyteller/system), audited
// ---------------------------------------------------------------------------

const promoteActorFromCohortPayloadSchema = z
  .object({
    cohortId: cohortIdSchema,
    /** Where the actor materializes — checked against the presence read. */
    zoneId: zoneIdSchema,
    /** Omit to sample from the cohort's authored name pool (step 3). */
    name: z.string().trim().min(1).max(200).optional(),
    landing: promotionLandingLodSchema,
  })
  .strict();

export const promoteActorFromCohortCommandSchema = createCommandEnvelopeSchema(
  "promote_actor_from_cohort",
  1,
  promoteActorFromCohortPayloadSchema,
);

/**
 * `cohort_not_present` is step 5 made deterministic: the aggregate's own
 * presence read must admit a person at the named zone — `presentCount ≥ 1`
 * there, or a dispersed remainder ≥ 1 anywhere else. A zone the read declares
 * empty ("the square is empty tonight") cannot yield a person.
 */
export const promoteActorFromCohortRejectionCodes = [
  "invalid_command",
  "duplicate_command_id",
  "branch_mismatch",
  "unauthorized_principal",
  "cohort_not_found",
  "zone_not_found",
  "insufficient_population",
  "cohort_not_present",
  "actor_already_exists",
  "name_required",
] as const;
export const promoteActorFromCohortRejectionCodeSchema = z.enum(promoteActorFromCohortRejectionCodes);
export const promoteActorFromCohortCommandResultSchema = createCommandResultSchema(
  promoteActorFromCohortRejectionCodeSchema,
);

// ---------------------------------------------------------------------------
// actor_materialized_from_aggregate — step 4. The ONLY event that creates a
// `sim_characters` row mid-branch (the branch seed is the only other path an
// actor exists at all). Causation-chained to the `cohort_adjusted` reservation
// debit that funded it; the landing LOD rides the chained `actor_lod_assigned`
// that follows in the same command.
// ---------------------------------------------------------------------------

const actorMaterializedFromAggregatePayloadSchema = z
  .object({
    actorId: worldCharacterIdSchema,
    name: z.string().trim().min(1).max(200),
    cohortId: cohortIdSchema,
    zoneId: zoneIdSchema,
    /** The zone's location at materialization — the locus is (location, zone). */
    locationId: locationIdSchema,
    /** Absent when the caller supplied an explicit `name` (step 5). */
    sampledDetail: promotionSampledDetailSchema.optional(),
  })
  .strict();

export const actorMaterializedFromAggregateEventSchema = createEventEnvelopeSchema(
  "actor_materialized_from_aggregate",
  1,
  actorMaterializedFromAggregatePayloadSchema,
).extend({ commandId: commandIdSchema });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PromoteActorFromCohortCommand = z.infer<typeof promoteActorFromCohortCommandSchema>;
export type PromoteActorFromCohortCommandInput = z.input<typeof promoteActorFromCohortCommandSchema>;
export type PromoteActorFromCohortRejectionCode = z.infer<
  typeof promoteActorFromCohortRejectionCodeSchema
>;
export type PromoteActorFromCohortCommandResult = z.infer<
  typeof promoteActorFromCohortCommandResultSchema
>;
export type ActorMaterializedFromAggregateEvent = z.infer<
  typeof actorMaterializedFromAggregateEventSchema
>;
