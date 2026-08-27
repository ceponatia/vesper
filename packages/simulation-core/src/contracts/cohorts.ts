import { z } from "zod";
import { minuteOfDaySchema } from "./bodies";
import {
  createCommandEnvelopeSchema,
  createCommandResultSchema,
  createEventEnvelopeSchema,
} from "./envelopes";
import { cohortIdSchema, commandIdSchema, storySecondSchema, zoneIdSchema } from "./identity";

/**
 * E6.3 — population cohorts: the aggregate lane's substrate. A cohort is a
 * branch-scoped CONSERVED COUNT of unnamed background people — one row no
 * matter how many it holds — whose presence at a zone derives analytically
 * from authored windows at read time: zero rows written, zero triggers
 * armed, zero model calls, ever. Population changes only through events
 * (`cohort_created` / `cohort_adjusted`), which is what lets E6.4's actor
 * promotion reserve conserved quantities from it (§27.2 step 2) without
 * ever contradicting aggregate history.
 */

export const cohortDerivationVersion = "cohort-v1" as const;
export const cohortRegistryVersions = [cohortDerivationVersion] as const;
export const cohortRegistryVersionSchema = z.enum(cohortRegistryVersions);
export type CohortRegistryVersion = z.infer<typeof cohortRegistryVersionSchema>;

// ---------------------------------------------------------------------------
// Presence windows — authored minute-of-day spans, read analytically
// ---------------------------------------------------------------------------

/**
 * One authored presence window: during [start, end) (half-open, wrapping
 * midnight, the rhythm-window convention) `shareFixedPoint` of the cohort's
 * population (10 000 ≡ all of it) is present at `zoneId`. Outside every
 * window the cohort is dispersed — present nowhere in particular. Where
 * windows overlap, the earliest (start, end, zone) triple wins
 * deterministically; authoring disjoint windows is the intended shape.
 */
export const cohortPresenceWindowSchema = z
  .object({
    zoneId: zoneIdSchema,
    startMinuteOfDay: minuteOfDaySchema,
    endMinuteOfDay: minuteOfDaySchema,
    shareFixedPoint: z.number().int().min(0).max(10_000),
  })
  .strict();
export type CohortPresenceWindow = z.infer<typeof cohortPresenceWindowSchema>;

// ---------------------------------------------------------------------------
// The cohort entity
// ---------------------------------------------------------------------------

export const COHORT_POPULATION_MAX = 1_000_000_000;
export const cohortPopulationSchema = z.number().int().min(0).max(COHORT_POPULATION_MAX);

export const simulationCohortSchema = z
  .object({
    id: cohortIdSchema,
    name: z.string().trim().min(1).max(200),
    population: cohortPopulationSchema,
    presenceWindows: z.array(cohortPresenceWindowSchema).max(16),
    registryVersion: cohortRegistryVersionSchema,
  })
  .strict();
export type SimulationCohort = z.infer<typeof simulationCohortSchema>;
export type SimulationCohortInput = z.input<typeof simulationCohortSchema>;

/**
 * Why a population moved — closed vocabulary with headroom for the known
 * futures: `authoring` (storyteller world-building), `influx` / `attrition`
 * (authored demographic flows), and `promotion_reservation` (E6.4 §27.2
 * step 2: a named actor materializes out of the aggregate, debiting it).
 */
export const cohortAdjustmentReasons = [
  "authoring",
  "influx",
  "attrition",
  "promotion_reservation",
] as const;
export const cohortAdjustmentReasonSchema = z.enum(cohortAdjustmentReasons);
export type CohortAdjustmentReason = z.infer<typeof cohortAdjustmentReasonSchema>;

// ---------------------------------------------------------------------------
// Projection (mirrors `actorLodsProjectionSchema`)
// ---------------------------------------------------------------------------

export const cohortsProjectionSchema = z
  .object({
    branchId: z.string().min(1),
    headSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    version: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    storySecond: storySecondSchema,
    cohorts: z.array(simulationCohortSchema),
  })
  .strict();
export type CohortsProjection = z.infer<typeof cohortsProjectionSchema>;

// ---------------------------------------------------------------------------
// create_cohort — privileged authoring (storyteller/system), audited via event
// ---------------------------------------------------------------------------

const createCohortPayloadSchema = z
  .object({
    cohort: simulationCohortSchema,
  })
  .strict();

export const createCohortCommandSchema = createCommandEnvelopeSchema(
  "create_cohort",
  1,
  createCohortPayloadSchema,
);

export const createCohortRejectionCodes = [
  "invalid_command",
  "duplicate_command_id",
  "branch_mismatch",
  "unauthorized_principal",
  "cohort_already_exists",
  "zone_not_found",
] as const;
export const createCohortRejectionCodeSchema = z.enum(createCohortRejectionCodes);
export const createCohortCommandResultSchema = createCommandResultSchema(createCohortRejectionCodeSchema);

// ---------------------------------------------------------------------------
// adjust_cohort — conserved integer deltas with reasons
// ---------------------------------------------------------------------------

const adjustCohortPayloadSchema = z
  .object({
    cohortId: cohortIdSchema,
    deltaCount: z
      .number()
      .int()
      .min(-COHORT_POPULATION_MAX)
      .max(COHORT_POPULATION_MAX)
      .refine((delta) => delta !== 0, { message: "A zero adjustment is not an adjustment" }),
    reason: cohortAdjustmentReasonSchema,
  })
  .strict();

export const adjustCohortCommandSchema = createCommandEnvelopeSchema(
  "adjust_cohort",
  1,
  adjustCohortPayloadSchema,
);

export const adjustCohortRejectionCodes = [
  "invalid_command",
  "duplicate_command_id",
  "branch_mismatch",
  "unauthorized_principal",
  "cohort_not_found",
  "insufficient_population",
] as const;
export const adjustCohortRejectionCodeSchema = z.enum(adjustCohortRejectionCodes);
export const adjustCohortCommandResultSchema = createCommandResultSchema(adjustCohortRejectionCodeSchema);

// ---------------------------------------------------------------------------
// Event family — cohort state is fully evented
// ---------------------------------------------------------------------------

const cohortCreatedPayloadSchema = z
  .object({
    cohort: simulationCohortSchema,
  })
  .strict();

export const cohortCreatedEventSchema = createEventEnvelopeSchema(
  "cohort_created",
  1,
  cohortCreatedPayloadSchema,
).extend({ commandId: commandIdSchema });

const cohortAdjustedPayloadSchema = z
  .object({
    cohortId: cohortIdSchema,
    deltaCount: z.number().int().min(-COHORT_POPULATION_MAX).max(COHORT_POPULATION_MAX),
    reason: cohortAdjustmentReasonSchema,
    /** The replaced and resulting counts — audit-without-reads (the
     * `previousWasDefault` precedent); replay needs no arithmetic trust. */
    populationBefore: cohortPopulationSchema,
    populationAfter: cohortPopulationSchema,
  })
  .strict();

export const cohortAdjustedEventSchema = createEventEnvelopeSchema(
  "cohort_adjusted",
  1,
  cohortAdjustedPayloadSchema,
).extend({ commandId: commandIdSchema });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CreateCohortCommand = z.infer<typeof createCohortCommandSchema>;
export type CreateCohortCommandInput = z.input<typeof createCohortCommandSchema>;
export type CreateCohortRejectionCode = z.infer<typeof createCohortRejectionCodeSchema>;
export type CreateCohortCommandResult = z.infer<typeof createCohortCommandResultSchema>;
export type AdjustCohortCommand = z.infer<typeof adjustCohortCommandSchema>;
export type AdjustCohortCommandInput = z.input<typeof adjustCohortCommandSchema>;
export type AdjustCohortRejectionCode = z.infer<typeof adjustCohortRejectionCodeSchema>;
export type AdjustCohortCommandResult = z.infer<typeof adjustCohortCommandResultSchema>;
export type CohortCreatedEvent = z.infer<typeof cohortCreatedEventSchema>;
export type CohortAdjustedEvent = z.infer<typeof cohortAdjustedEventSchema>;
