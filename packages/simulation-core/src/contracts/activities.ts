import { z } from "zod";
import {
  createCommandEnvelopeSchema,
  createCommandResultSchema,
  createEventEnvelopeSchema,
  createStableStringSetSchema,
  principalKindSchema,
} from "./envelopes";
import {
  actionDefinitionIdSchema,
  activityInstanceIdSchema,
  commandIdSchema,
  itemIdSchema,
  storySecondSchema,
  worldCharacterIdSchema,
  zoneIdSchema,
} from "./identity";
import { meterDeltaFixedPointSchema } from "./bodies";
import { consentScopeKeySchema } from "./social";

/**
 * E3.2 — typed actions, activities, and claims. An action definition is
 * authored, versioned data; an activity instance is one attempted action over
 * story time whose claims are acquired atomically at start and released by
 * every terminal phase.
 *
 * Deliberate E3.2 boundaries: resource costs join with Gate 5 materials;
 * privacy/consent requirements join with E3.5's access layer; the §16.4 graded
 * compatibility matrix (conversation-while-cooking) joins with E3.4
 * engagements — in this slice every body-claiming activity is stationary and
 * blocks departure outright.
 *
 * E5.3 slice 2 (§26.5–26.6) makes good on the resource-cost boundary: an
 * action definition may name `resourceCosts`, start selects and reserves
 * concrete items deterministically, and completion consumes the
 * `consume`-disposition ones through the same body-effect path `consume_item`
 * uses (`materials.ts`'s `buildConsumptionBodyEffects`).
 */

// --- Claims ----------------------------------------------------------------

export const attentionWeights = ["full", "partial"] as const;
export const attentionWeightSchema = z.enum(attentionWeights);

/**
 * The E3.2 claim vocabulary. `body` is exclusive occupation of the actor's own
 * physical capability; `attention` is graded so a partial claim can later
 * coexist with a remote engagement (E3.4).
 */
export const activityClaimSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("body") }).strict(),
  z.object({ kind: z.literal("attention"), weight: attentionWeightSchema }).strict(),
]);

export type ActivityClaim = z.infer<typeof activityClaimSchema>;

/** Two claim sets conflict when either demands what the other already holds. */
export function activityClaimsConflict(
  held: readonly ActivityClaim[],
  requested: readonly ActivityClaim[],
): boolean {
  const heldBody = held.some((claim) => claim.kind === "body");
  const requestedBody = requested.some((claim) => claim.kind === "body");
  if (heldBody && requestedBody) return true;
  const heldFullAttention = held.some((claim) => claim.kind === "attention" && claim.weight === "full");
  const requestedFullAttention = requested.some(
    (claim) => claim.kind === "attention" && claim.weight === "full",
  );
  return heldFullAttention && requestedFullAttention;
}

// --- Action definition -----------------------------------------------------

/** Fixed now; a duration distribution variant joins when a scenario funds it. */
export const durationRuleSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("fixed"),
      seconds: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    })
    .strict(),
]);

/**
 * Typed, enforced preconditions — an inert authored field is not acceptable
 * (spec §16.1). Every E3.2 activity already requires an at-locus universally
 * (graded in-transit compatibility is E3.4's), so the vocabulary starts with
 * zone-kind placement alone and grows per scenario need.
 *
 * E5.5 slice 2 (§16.1, ruling 16) adds `consent_covered`: a `ConsentScopeKey`
 * naming the class of touch/closeness/intimacy the action concerns. Coverage
 * is checked against the §21.4 relationship ledger — fail-closed, before any
 * claim or resource is reserved.
 */
export const actionPreconditionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("at_zone_kind"), zoneKind: z.string().trim().min(1) }).strict(),
  z.object({ kind: z.literal("consent_covered"), scopeKey: consentScopeKeySchema }).strict(),
]);

export const interruptibilities = ["free", "pausable", "abort_only", "locked"] as const;
export const interruptibilitySchema = z.enum(interruptibilities);

/**
 * Who perceives an activity's start/completion events. `obvious` is witnessed
 * by every co-located actor, `private` only by the participants themselves.
 * The full perception channel model is Gate 4; this profile is enforced now
 * so activity events carry the same captured witness sets item transfers do.
 */
export const activityNoticeabilities = ["obvious", "private"] as const;
export const activityNoticeabilitySchema = z.enum(activityNoticeabilities);

/**
 * A named, quantified material requirement (§26.5). `consume` destroys the
 * selected items into their body/world effect at completion; `use` only
 * requires and reserves them for the activity's span — they release, unspent,
 * at every terminal phase (wear/cleanliness effects are slice 3).
 */
/** §26.7: a wear/cleanliness delta a `use`-disposition cost applies at completion. */
export const useConditionDeltaSchema = z
  .object({
    meterKey: z.string().trim().min(1).max(64),
    deltaFixedPoint: meterDeltaFixedPointSchema,
  })
  .strict();
export type UseConditionDelta = z.infer<typeof useConditionDeltaSchema>;

export const actionResourceCostSchema = z
  .object({
    materialKindKey: z.string().trim().min(1).max(64),
    quantity: z.number().int().min(1).max(8),
    disposition: z.enum(["consume", "use"]),
    /** §26.7: applied to each `use`-disposition reserved TRACKED item at completion. */
    useConditionDeltas: z.array(useConditionDeltaSchema).max(2).default([]),
  })
  .strict();
export type ActionResourceCost = z.infer<typeof actionResourceCostSchema>;

export const simulationActionDefinitionSchema = z
  .object({
    id: actionDefinitionIdSchema,
    version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    /**
     * A short human display label for player-facing surfaces (world-ui.plan.md
     * slice 3 — the world card's action chip, e.g. "Rest"). Optional and
     * forward-compatible: stored in the jsonb payload (no migration), and a
     * definition without it falls back to an id-derived label. Charter law —
     * a display label as data, never a raw id in prose.
     */
    label: z.string().trim().min(1).max(48).optional(),
    /** Principal kinds whose commands may start this action (spec §16.1). */
    controllerKinds: z.array(principalKindSchema).min(1),
    duration: durationRuleSchema,
    preconditions: z.array(actionPreconditionSchema),
    requiredClaims: z.array(activityClaimSchema),
    interruptibility: interruptibilitySchema,
    noticeability: activityNoticeabilitySchema,
    /** §26.5: materials reserved atomically at start, spent or released at completion. */
    resourceCosts: z.array(actionResourceCostSchema).max(4).default([]),
  })
  .strict()
  .refine(
    (definition) =>
      definition.preconditions.filter((precondition) => precondition.kind === "consent_covered").length <= 1,
    {
      message:
        "An action definition may declare at most one consent_covered precondition — the store/resolver resolve a single consentCovered boolean for the whole start, not a per-scope map (E5.5 slice 2).",
      path: ["preconditions"],
    },
  );

export type SimulationActionDefinition = z.infer<typeof simulationActionDefinitionSchema>;

// --- Activity instance -----------------------------------------------------

export const activityPhases = [
  "queued",
  "preparing",
  "active",
  "paused",
  "interrupted",
  "completed",
  "failed",
  "cancelled",
] as const;
export const activityPhaseSchema = z.enum(activityPhases);
export type ActivityPhase = z.infer<typeof activityPhaseSchema>;

/** The §16.3 legal-transition table, exported so kernel and tests share one truth. */
export const activityPhaseTransitions: Record<ActivityPhase, readonly ActivityPhase[]> = {
  queued: ["preparing", "active", "cancelled", "failed"],
  preparing: ["active", "interrupted", "cancelled", "failed"],
  active: ["paused", "interrupted", "completed", "failed", "cancelled"],
  paused: ["active", "interrupted", "cancelled", "failed"],
  interrupted: ["active", "cancelled", "failed"],
  completed: [],
  failed: [],
  cancelled: [],
};

export const terminalActivityPhases: readonly ActivityPhase[] = ["completed", "failed", "cancelled"];

/** Phases whose claims are held: acquired at start, released only terminally (§16.3). */
export const claimHoldingActivityPhases: readonly ActivityPhase[] = [
  "queued",
  "preparing",
  "active",
  "paused",
  "interrupted",
];

/** Progress is fixed-point parts-per-million (spec §6.1: no float rounding in rules). */
export const progressFixedPointSchema = z.number().int().min(0).max(1_000_000);

const activityActorIdsSchema = createStableStringSetSchema(worldCharacterIdSchema, "Activity actor IDs");
const activityReservedItemIdsSchema = createStableStringSetSchema(
  itemIdSchema,
  "Activity reserved item IDs",
);

export const activityInstanceSchema = z
  .object({
    id: activityInstanceIdSchema,
    actionDefinitionId: actionDefinitionIdSchema,
    /** Captured at start: a later definition edit never rewrites a running activity. */
    actionVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    actorIds: activityActorIdsSchema.refine((ids) => ids.length >= 1, "An activity needs an actor"),
    zoneId: zoneIdSchema,
    phase: activityPhaseSchema,
    startedAt: storySecondSchema.optional(),
    expectedCompleteAt: storySecondSchema.optional(),
    progressFixedPoint: progressFixedPointSchema,
    claims: z.array(activityClaimSchema),
    /** §26.5: items reserved at start, held across every claim-holding phase. */
    reservedItemIds: activityReservedItemIdsSchema.default([]),
    sourceCommandId: commandIdSchema,
  })
  .strict();

export type ActivityInstance = z.infer<typeof activityInstanceSchema>;

// --- Commands ---------------------------------------------------------------

const startActivityPayloadSchema = z
  .object({
    actionDefinitionId: actionDefinitionIdSchema,
    actorId: worldCharacterIdSchema,
    /** E5.5 slice 2: the second party a `consent_covered` precondition concerns. */
    targetActorId: worldCharacterIdSchema.optional(),
  })
  .strict()
  .refine((p) => p.targetActorId === undefined || p.targetActorId !== p.actorId, {
    message: "targetActorId must differ from actorId",
    path: ["targetActorId"],
  });

export const startActivityCommandSchema = createCommandEnvelopeSchema(
  "start_activity",
  1,
  startActivityPayloadSchema,
);

export const startActivityRejectionCodes = [
  "invalid_command",
  "duplicate_command_id",
  "branch_mismatch",
  "actor_not_found",
  "unauthorized_actor",
  "unauthorized_controller",
  "action_not_found",
  "actor_in_transit",
  "precondition_failed",
  "claim_conflict",
  "material_unavailable",
  /** E5.5 slice 2: a `consent_covered` precondition with no `targetActorId` supplied. */
  "target_actor_required",
  "target_not_co_located",
  /** E5.5 slice 2: fail-closed — no covering §21.4 ledger entry. */
  "consent_required",
] as const;
export const startActivityRejectionCodeSchema = z.enum(startActivityRejectionCodes);
export const startActivityCommandResultSchema = createCommandResultSchema(
  startActivityRejectionCodeSchema,
);

const completeActivityPayloadSchema = z
  .object({
    activityInstanceId: activityInstanceIdSchema,
  })
  .strict();

/** Dispatched by the completion trigger at its due second; system-only. */
export const completeActivityCommandSchema = createCommandEnvelopeSchema(
  "complete_activity",
  1,
  completeActivityPayloadSchema,
);

export const completeActivityRejectionCodes = [
  "invalid_command",
  "duplicate_command_id",
  "branch_mismatch",
  "activity_not_found",
  "activity_not_active",
  "unauthorized_principal",
  "completion_not_due",
] as const;
export const completeActivityRejectionCodeSchema = z.enum(completeActivityRejectionCodes);
export const completeActivityCommandResultSchema = createCommandResultSchema(
  completeActivityRejectionCodeSchema,
);

export const cancelActivityReasons = ["actor_choice", "superseded"] as const;
export const cancelActivityReasonSchema = z.enum(cancelActivityReasons);

const cancelActivityPayloadSchema = z
  .object({
    activityInstanceId: activityInstanceIdSchema,
    reason: cancelActivityReasonSchema,
  })
  .strict();

export const cancelActivityCommandSchema = createCommandEnvelopeSchema(
  "cancel_activity",
  1,
  cancelActivityPayloadSchema,
);

export const cancelActivityRejectionCodes = [
  "invalid_command",
  "duplicate_command_id",
  "branch_mismatch",
  "activity_not_found",
  "activity_not_cancellable",
  "unauthorized_actor",
] as const;
export const cancelActivityRejectionCodeSchema = z.enum(cancelActivityRejectionCodes);
export const cancelActivityCommandResultSchema = createCommandResultSchema(
  cancelActivityRejectionCodeSchema,
);

// --- Activity event family -------------------------------------------------

const witnessActorIdsSchema = createStableStringSetSchema(
  worldCharacterIdSchema,
  "Activity witness actor IDs",
);

const activityStartedPayloadSchema = z
  .object({
    activityInstanceId: activityInstanceIdSchema,
    actionDefinitionId: actionDefinitionIdSchema,
    actionVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    zoneId: zoneIdSchema,
    startedAt: storySecondSchema,
    expectedCompleteAt: storySecondSchema,
    claims: z.array(activityClaimSchema),
    /** Captured derived value: replay does not recompute historical eligibility. */
    observerActorIds: witnessActorIdsSchema,
    /** §26.5: the deterministic item selection, captured immutable at start. */
    reservedItemIds: activityReservedItemIdsSchema,
    /**
     * E5.5 slice 2: present only when a `consent_covered` precondition was
     * checked and passed — the social ledger derives a `boundary_respected`
     * entry from this capture.
     */
    consentGrant: z
      .object({
        granterActorId: worldCharacterIdSchema,
        granteeActorId: worldCharacterIdSchema,
        scopeKey: consentScopeKeySchema,
      })
      .strict()
      .optional(),
  })
  .strict();

export const activityStartedEventSchema = createEventEnvelopeSchema(
  "activity_started",
  1,
  activityStartedPayloadSchema,
).extend({ commandId: commandIdSchema });

const activityCompletedPayloadSchema = z
  .object({
    activityInstanceId: activityInstanceIdSchema,
    completedAt: storySecondSchema,
    observerActorIds: witnessActorIdsSchema,
    /** §26.6: the `consume`-disposition reserved items spent at completion. */
    consumedItemIds: activityReservedItemIdsSchema.default([]),
  })
  .strict();

export const activityCompletedEventSchema = createEventEnvelopeSchema(
  "activity_completed",
  1,
  activityCompletedPayloadSchema,
);

const activityCancelledPayloadSchema = z
  .object({
    activityInstanceId: activityInstanceIdSchema,
    cancelledAt: storySecondSchema,
    reason: cancelActivityReasonSchema,
    observerActorIds: witnessActorIdsSchema,
  })
  .strict();

export const activityCancelledEventSchema = createEventEnvelopeSchema(
  "activity_cancelled",
  1,
  activityCancelledPayloadSchema,
);

export const activityFailureReasons = ["actor_incapacitated", "external_event"] as const;
export const activityFailureReasonSchema = z.enum(activityFailureReasons);

const activityFailedPayloadSchema = z
  .object({
    activityInstanceId: activityInstanceIdSchema,
    failedAt: storySecondSchema,
    reason: activityFailureReasonSchema,
    observerActorIds: witnessActorIdsSchema,
  })
  .strict();

export const activityFailedEventSchema = createEventEnvelopeSchema(
  "activity_failed",
  1,
  activityFailedPayloadSchema,
);

export const activityInterruptReasons = ["engagement", "pressure", "hazard", "collapse"] as const;
export const activityInterruptReasonSchema = z.enum(activityInterruptReasons);

const activityInterruptedPayloadSchema = z
  .object({
    activityInstanceId: activityInstanceIdSchema,
    interruptedAt: storySecondSchema,
    reason: activityInterruptReasonSchema,
    progressFixedPoint: progressFixedPointSchema,
  })
  .strict();

/** Vocabulary + applier now; the emitting path is E3.4's engagement interruption. */
export const activityInterruptedEventSchema = createEventEnvelopeSchema(
  "activity_interrupted",
  1,
  activityInterruptedPayloadSchema,
);

const activityResumedPayloadSchema = z
  .object({
    activityInstanceId: activityInstanceIdSchema,
    resumedAt: storySecondSchema,
    newExpectedCompleteAt: storySecondSchema,
  })
  .strict();

export const activityResumedEventSchema = createEventEnvelopeSchema(
  "activity_resumed",
  1,
  activityResumedPayloadSchema,
);

// --- ResumeActivity (E5.2 — the carried E3.4 re-arm design note) --------------

const resumeActivityPayloadSchema = z
  .object({
    activityInstanceId: activityInstanceIdSchema,
  })
  .strict();

export const resumeActivityCommandSchema = createCommandEnvelopeSchema(
  "resume_activity",
  1,
  resumeActivityPayloadSchema,
);

export const resumeActivityRejectionCodes = [
  "invalid_command",
  "duplicate_command_id",
  "branch_mismatch",
  "activity_not_found",
  "activity_not_interrupted",
  "unauthorized_actor",
] as const;
export const resumeActivityRejectionCodeSchema = z.enum(resumeActivityRejectionCodes);
export const resumeActivityCommandResultSchema = createCommandResultSchema(
  resumeActivityRejectionCodeSchema,
);

export type ResumeActivityCommand = z.infer<typeof resumeActivityCommandSchema>;
export type ResumeActivityRejectionCode = z.infer<typeof resumeActivityRejectionCodeSchema>;
export type ResumeActivityCommandResult = z.infer<typeof resumeActivityCommandResultSchema>;

// --- Activities projection ---------------------------------------------------

export const activitiesProjectionSchema = z
  .object({
    branchId: z.string().min(1),
    headSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    version: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    storySecond: storySecondSchema,
    activities: z.array(activityInstanceSchema),
  })
  .strict();

export type ActivitiesProjection = z.infer<typeof activitiesProjectionSchema>;

// --- Types -------------------------------------------------------------------

export type AttentionWeight = z.infer<typeof attentionWeightSchema>;
export type DurationRule = z.infer<typeof durationRuleSchema>;
export type ActionPrecondition = z.infer<typeof actionPreconditionSchema>;
export type Interruptibility = z.infer<typeof interruptibilitySchema>;
export type ActivityNoticeability = z.infer<typeof activityNoticeabilitySchema>;
export type StartActivityCommand = z.infer<typeof startActivityCommandSchema>;
export type StartActivityCommandInput = z.input<typeof startActivityCommandSchema>;
export type StartActivityRejectionCode = z.infer<typeof startActivityRejectionCodeSchema>;
export type StartActivityCommandResult = z.infer<typeof startActivityCommandResultSchema>;
export type CompleteActivityCommand = z.infer<typeof completeActivityCommandSchema>;
export type CompleteActivityRejectionCode = z.infer<typeof completeActivityRejectionCodeSchema>;
export type CompleteActivityCommandResult = z.infer<typeof completeActivityCommandResultSchema>;
export type CancelActivityCommand = z.infer<typeof cancelActivityCommandSchema>;
export type CancelActivityReason = z.infer<typeof cancelActivityReasonSchema>;
export type CancelActivityRejectionCode = z.infer<typeof cancelActivityRejectionCodeSchema>;
export type CancelActivityCommandResult = z.infer<typeof cancelActivityCommandResultSchema>;
export type ActivityStartedEvent = z.infer<typeof activityStartedEventSchema>;
export type ActivityCompletedEvent = z.infer<typeof activityCompletedEventSchema>;
export type ActivityCancelledEvent = z.infer<typeof activityCancelledEventSchema>;
export type ActivityFailedEvent = z.infer<typeof activityFailedEventSchema>;
export type ActivityFailureReason = z.infer<typeof activityFailureReasonSchema>;
export type ActivityInterruptedEvent = z.infer<typeof activityInterruptedEventSchema>;
export type ActivityInterruptReason = z.infer<typeof activityInterruptReasonSchema>;
export type ActivityResumedEvent = z.infer<typeof activityResumedEventSchema>;
