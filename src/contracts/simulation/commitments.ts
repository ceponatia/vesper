import { z } from "zod";
import {
  createCommandEnvelopeSchema,
  createCommandResultSchema,
  createEventEnvelopeSchema,
} from "./envelopes";
import {
  assertionIdSchema,
  beliefIdSchema,
  commandIdSchema,
  commitmentIdSchema,
  eventIdSchema,
  storySecondSchema,
  worldCharacterIdSchema,
  zoneIdSchema,
} from "./identity";
import { gate3RouteVersionSchema } from "./space";

/**
 * E3.3 — commitments and temporal pressure (engine.spec §15, plan §"Gate 3
 * build order"). A commitment is an obligation with earliest/target/latest
 * boundaries; pressure derives from it deterministically; a schedule boundary
 * never sets location (spec §3.1 invariant 5) — the deadline trigger only
 * *evaluates* where the actor actually is.
 *
 * Deliberate E3.3 boundaries: the ruled per-commitment `flexibility` dial is
 * stored and drives severity now, and richer decision behavior (warn,
 * negotiate, depart via NPC policy) is E3.4's arbiter; `late → kept` repair
 * on a subsequent arrival is recorded in-table but its evaluator lands with
 * E3.4 arrival integration; acknowledgment (§15.3) is an E3.4 engagement
 * concern.
 *
 * E5.5 slice 2 (§15.1, §15.4) makes `destinationZoneId` optional — a
 * destinationless commitment carries no spatial obligation and can only ever
 * resolve `kept` (via `fulfill_commitment`) or `missed`, never `late`. An
 * optional `promisedToActorId` names the counterpart a promise runs toward
 * (the social ledger's directional evidence target); an optional
 * `repairsCommitmentId` links a new commitment to the `missed` one it repairs
 * (§15.4: history is not rewritten — the original stays `missed` forever).
 */

// --- Vocabulary (engine.spec §15.1, ruling 2) -------------------------------

export const commitmentKinds = ["shift", "appointment", "promise", "reservation", "routine"] as const;
export const commitmentKindSchema = z.enum(commitmentKinds);

/** Ruling 2: firmness is per commitment, never a global switch. */
export const commitmentFlexibilities = ["soft", "negotiable", "firm", "hard"] as const;
export const commitmentFlexibilitySchema = z.enum(commitmentFlexibilities);

export const commitmentStatuses = [
  "planned",
  "noticed",
  "accepted",
  "declined",
  "in_progress",
  "kept",
  "late",
  "missed",
  "cancelled",
] as const;
export const commitmentStatusSchema = z.enum(commitmentStatuses);
export type CommitmentStatus = z.infer<typeof commitmentStatusSchema>;

/** The §15.4 legal-transition table, exported so kernel and tests share one truth. */
export const commitmentStatusTransitions: Record<CommitmentStatus, readonly CommitmentStatus[]> = {
  planned: ["noticed", "accepted", "declined", "cancelled", "missed", "kept", "late"],
  noticed: ["accepted", "declined", "cancelled", "missed", "kept", "late"],
  accepted: ["in_progress", "cancelled", "missed", "kept", "late"],
  declined: ["cancelled", "accepted"],
  in_progress: ["kept", "late", "missed", "cancelled"],
  kept: [],
  late: ["kept", "missed"],
  missed: [],
  cancelled: [],
};

/**
 * Why the actor may act on this commitment (spec §15.1). `authored` is setup
 * the actor is deemed to know. `observed` (E4.1) names a perceptible event —
 * a spoken invitation, a witnessed exchange — and the notice trigger fires
 * only if the actor holds a §20 observation of it: an obligation made where
 * you weren't can't pressure you. `asserted` and `believed` (E4.2) route
 * through the §21 knowledge ledger — the promised no-schema-change
 * tightening: `asserted` names a claim and requires the actor to hold a live
 * (active or doubted) belief in it; `believed` names the exact belief row and
 * requires it live. All non-authored members fail closed.
 */
export const commitmentKnowledgeSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("authored") }).strict(),
  z.object({ kind: z.literal("observed"), sourceEventId: eventIdSchema }).strict(),
  z.object({ kind: z.literal("asserted"), assertionId: assertionIdSchema }).strict(),
  z.object({ kind: z.literal("believed"), beliefId: beliefIdSchema }).strict(),
]);

export const pressureSeverities = ["background", "salient", "urgent", "hard"] as const;
export const pressureSeveritySchema = z.enum(pressureSeverities);

// --- Commitment (engine.spec §15.1) -----------------------------------------

const commitmentWindowSchema = z
  .object({
    earliestArrival: storySecondSchema.optional(),
    targetArrival: storySecondSchema.optional(),
    /** Required in E3.3: the deadline evaluator anchors here. */
    latestArrival: storySecondSchema,
  })
  .strict()
  .refine(
    (window) => window.earliestArrival === undefined || window.earliestArrival <= window.latestArrival,
    { message: "Earliest arrival cannot follow latest arrival", path: ["earliestArrival"] },
  )
  .refine(
    (window) =>
      window.targetArrival === undefined ||
      (window.targetArrival <= window.latestArrival &&
        (window.earliestArrival === undefined || window.targetArrival >= window.earliestArrival)),
    { message: "Target arrival must sit inside the window", path: ["targetArrival"] },
  );

export const commitmentSchema = z
  .object({
    id: commitmentIdSchema,
    actorId: worldCharacterIdSchema,
    kind: commitmentKindSchema,
    /** Optional (E5.5 slice 2): a destinationless commitment carries no spatial obligation. */
    destinationZoneId: zoneIdSchema.optional(),
    /** E5.5 slice 2: the counterpart a promise runs toward — the social ledger's directional target. */
    promisedToActorId: worldCharacterIdSchema.optional(),
    /** E5.5 slice 2: the `missed` commitment this one repairs (§15.4 — history is not rewritten). */
    repairsCommitmentId: commitmentIdSchema.optional(),
    window: commitmentWindowSchema,
    expectedDurationSeconds: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    priority: z.number().int().min(0).max(9_999),
    flexibility: commitmentFlexibilitySchema,
    preparationSeconds: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    reliabilityBufferSeconds: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    noticeLeadSeconds: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    status: commitmentStatusSchema,
    knowledgeSource: commitmentKnowledgeSourceSchema,
    sourceCommandId: commandIdSchema,
  })
  .strict()
  .refine((c) => c.promisedToActorId === undefined || c.promisedToActorId !== c.actorId, {
    message: "promisedToActorId must differ from actorId",
    path: ["promisedToActorId"],
  });

export type Commitment = z.infer<typeof commitmentSchema>;
export type CommitmentKnowledgeSource = z.infer<typeof commitmentKnowledgeSourceSchema>;

// --- Temporal pressure (engine.spec §15.2) ----------------------------------

export const temporalPressureSchema = z
  .object({
    id: z.string().min(1).max(1_024),
    actorId: worldCharacterIdSchema,
    sourceCommitmentId: commitmentIdSchema,
    noticeAt: storySecondSchema,
    decideBy: storySecondSchema,
    actBy: storySecondSchema,
    severity: pressureSeveritySchema,
    acknowledgedAt: storySecondSchema.optional(),
    /** E5.5 slice 3 (§18.1): the severity captured at acknowledgment time —
     * the cut's acknowledgment-aware pressure filter compares this against
     * the pressure's live `severity` to decide whether it re-surfaces. */
    acknowledgedSeverity: pressureSeveritySchema.optional(),
    resolvedAt: storySecondSchema.optional(),
  })
  .strict()
  .refine((pressure) => pressure.noticeAt <= pressure.decideBy && pressure.decideBy <= pressure.actBy, {
    message: "Pressure ordering must be noticeAt ≤ decideBy ≤ actBy",
    path: ["actBy"],
  });

export type TemporalPressure = z.infer<typeof temporalPressureSchema>;

/** Deterministic §15.2 derivation. Clamped at zero so a too-tight window is due immediately. */
export function deriveCommitmentTimes(input: {
  latestArrival: number;
  minimumRouteDurationSeconds: number;
  preparationSeconds: number;
  reliabilityBufferSeconds: number;
  noticeLeadSeconds: number;
}): { latestDeparture: number; noticeAt: number; decideBy: number; actBy: number } {
  const latestDeparture = Math.max(
    0,
    input.latestArrival -
      input.minimumRouteDurationSeconds -
      input.preparationSeconds -
      input.reliabilityBufferSeconds,
  );
  const actBy = latestDeparture;
  const noticeAt = Math.max(0, latestDeparture - input.noticeLeadSeconds);
  return { latestDeparture, noticeAt, decideBy: actBy, actBy };
}

/** Deterministic severity map (ruling 6: rules, no model call). */
export function derivePressureSeverity(flexibility: Commitment["flexibility"]): z.infer<typeof pressureSeveritySchema> {
  switch (flexibility) {
    case "hard":
      return "hard";
    case "firm":
      return "urgent";
    case "negotiable":
      return "salient";
    case "soft":
      return "background";
  }
}

// --- Commands ----------------------------------------------------------------

const createCommitmentPayloadSchema = z
  .object({
    actorId: worldCharacterIdSchema,
    kind: commitmentKindSchema,
    destinationZoneId: zoneIdSchema.optional(),
    promisedToActorId: worldCharacterIdSchema.optional(),
    repairsCommitmentId: commitmentIdSchema.optional(),
    window: commitmentWindowSchema,
    expectedDurationSeconds: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    priority: z.number().int().min(0).max(9_999).default(0),
    flexibility: commitmentFlexibilitySchema,
    preparationSeconds: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
    reliabilityBufferSeconds: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
    noticeLeadSeconds: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
    knowledgeSource: commitmentKnowledgeSourceSchema,
  })
  .strict();

export const createCommitmentCommandSchema = createCommandEnvelopeSchema(
  "create_commitment",
  1,
  createCommitmentPayloadSchema,
);

export const createCommitmentRejectionCodes = [
  "invalid_command",
  "duplicate_command_id",
  "branch_mismatch",
  "actor_not_found",
  "unauthorized_actor",
  "destination_not_found",
  "window_in_past",
  "repair_target_not_found",
  "repair_target_not_repairable",
  "promised_to_actor_not_found",
  "promised_to_self",
] as const;
export const createCommitmentRejectionCodeSchema = z.enum(createCommitmentRejectionCodes);
export const createCommitmentCommandResultSchema = createCommandResultSchema(
  createCommitmentRejectionCodeSchema,
);

const raisePressurePayloadSchema = z
  .object({
    commitmentId: commitmentIdSchema,
  })
  .strict();

/** Dispatched by the notice trigger; system-only, re-validated at fire time. */
export const raisePressureCommandSchema = createCommandEnvelopeSchema(
  "raise_pressure",
  1,
  raisePressurePayloadSchema,
);

export const raisePressureRejectionCodes = [
  "invalid_command",
  "duplicate_command_id",
  "branch_mismatch",
  "commitment_not_found",
  "commitment_not_open",
  "knowledge_unavailable",
  "unauthorized_principal",
] as const;
export const raisePressureRejectionCodeSchema = z.enum(raisePressureRejectionCodes);
export const raisePressureCommandResultSchema = createCommandResultSchema(
  raisePressureRejectionCodeSchema,
);

const resolveDeadlinePayloadSchema = z
  .object({
    commitmentId: commitmentIdSchema,
  })
  .strict();

/** Dispatched by the deadline trigger at latestArrival; system-only. */
export const resolveCommitmentDeadlineCommandSchema = createCommandEnvelopeSchema(
  "resolve_commitment_deadline",
  1,
  resolveDeadlinePayloadSchema,
);

export const resolveDeadlineRejectionCodes = [
  "invalid_command",
  "duplicate_command_id",
  "branch_mismatch",
  "commitment_not_found",
  "commitment_not_open",
  "unauthorized_principal",
] as const;
export const resolveDeadlineRejectionCodeSchema = z.enum(resolveDeadlineRejectionCodes);
export const resolveCommitmentDeadlineCommandResultSchema = createCommandResultSchema(
  resolveDeadlineRejectionCodeSchema,
);

const fulfillCommitmentPayloadSchema = z
  .object({
    commitmentId: commitmentIdSchema,
  })
  .strict();

/**
 * E5.5 slice 2 (§15.1, §7.4): the destinationless analogue of the deadline
 * evaluator — an explicit self-report that keeps a commitment with no locus
 * to check. Rejects `commitment_has_destination` for a spatial commitment
 * (those resolve only through `resolve_commitment_deadline`).
 */
export const fulfillCommitmentCommandSchema = createCommandEnvelopeSchema(
  "fulfill_commitment",
  1,
  fulfillCommitmentPayloadSchema,
);

export const fulfillCommitmentRejectionCodes = [
  "invalid_command",
  "duplicate_command_id",
  "branch_mismatch",
  "commitment_not_found",
  "commitment_not_open",
  "commitment_has_destination",
  "unauthorized_actor",
  "deadline_passed",
] as const;
export const fulfillCommitmentRejectionCodeSchema = z.enum(fulfillCommitmentRejectionCodes);
export const fulfillCommitmentCommandResultSchema = createCommandResultSchema(
  fulfillCommitmentRejectionCodeSchema,
);

// --- Commitment event family (engine.spec §9.2) ------------------------------

const commitmentCreatedPayloadSchema = z
  .object({
    commitmentId: commitmentIdSchema,
    actorId: worldCharacterIdSchema,
    kind: commitmentKindSchema,
    destinationZoneId: zoneIdSchema.optional(),
    promisedToActorId: worldCharacterIdSchema.optional(),
    repairsCommitmentId: commitmentIdSchema.optional(),
    window: commitmentWindowSchema,
    expectedDurationSeconds: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    priority: z.number().int().min(0).max(9_999),
    flexibility: commitmentFlexibilitySchema,
    preparationSeconds: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    reliabilityBufferSeconds: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    noticeLeadSeconds: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    knowledgeSource: commitmentKnowledgeSourceSchema,
    /** Captured §15.2 derivation (spec §6.4: derived values that cause history). */
    derived: z
      .object({
        latestDeparture: storySecondSchema,
        noticeAt: storySecondSchema,
        decideBy: storySecondSchema,
        actBy: storySecondSchema,
        minimumRouteDurationSeconds: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      })
      .strict(),
  })
  .strict();

export const commitmentCreatedEventSchema = createEventEnvelopeSchema(
  "commitment_created",
  1,
  commitmentCreatedPayloadSchema,
).extend({
  commandId: commandIdSchema,
  derivationVersion: gate3RouteVersionSchema,
});

const pressureRaisedPayloadSchema = z
  .object({
    commitmentId: commitmentIdSchema,
    pressureId: z.string().min(1).max(1_024),
    actorId: worldCharacterIdSchema,
    noticeAt: storySecondSchema,
    decideBy: storySecondSchema,
    actBy: storySecondSchema,
    severity: pressureSeveritySchema,
  })
  .strict();

export const pressureRaisedEventSchema = createEventEnvelopeSchema(
  "pressure_raised",
  1,
  pressureRaisedPayloadSchema,
);

const commitmentOutcomePayloadSchema = z
  .object({
    commitmentId: commitmentIdSchema,
    actorId: worldCharacterIdSchema,
    resolvedAt: storySecondSchema,
    /** Captured evaluation inputs: where the actor actually was (spec §6.4). */
    evaluation: z.discriminatedUnion("basis", [
      z.object({ basis: z.literal("at_destination") }).strict(),
      z
        .object({
          basis: z.literal("en_route"),
          journeyId: z.string().min(1).max(1_024),
          expectedArrivalAt: storySecondSchema,
        })
        .strict(),
      z.object({ basis: z.literal("absent") }).strict(),
      /** E5.5 slice 2: a destinationless commitment kept via `fulfill_commitment`. */
      z.object({ basis: z.literal("self_reported"), sourceCommandId: commandIdSchema }).strict(),
    ]),
  })
  .strict();

export const commitmentKeptEventSchema = createEventEnvelopeSchema(
  "commitment_kept",
  1,
  commitmentOutcomePayloadSchema,
);

export const commitmentLateEventSchema = createEventEnvelopeSchema(
  "commitment_late",
  1,
  commitmentOutcomePayloadSchema,
);

export const commitmentMissedEventSchema = createEventEnvelopeSchema(
  "commitment_missed",
  1,
  commitmentOutcomePayloadSchema,
);

// --- Commitments projection ---------------------------------------------------

export const commitmentsProjectionSchema = z
  .object({
    branchId: z.string().min(1),
    headSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    version: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    storySecond: storySecondSchema,
    commitments: z.array(commitmentSchema),
    pressures: z.array(temporalPressureSchema),
  })
  .strict();

export type CommitmentsProjection = z.infer<typeof commitmentsProjectionSchema>;

// --- Types --------------------------------------------------------------------

export type CommitmentKind = z.infer<typeof commitmentKindSchema>;
export type CommitmentFlexibility = z.infer<typeof commitmentFlexibilitySchema>;
export type PressureSeverity = z.infer<typeof pressureSeveritySchema>;
export type CreateCommitmentCommand = z.infer<typeof createCommitmentCommandSchema>;
export type CreateCommitmentCommandInput = z.input<typeof createCommitmentCommandSchema>;
export type CreateCommitmentRejectionCode = z.infer<typeof createCommitmentRejectionCodeSchema>;
export type CreateCommitmentCommandResult = z.infer<typeof createCommitmentCommandResultSchema>;
export type RaisePressureCommand = z.infer<typeof raisePressureCommandSchema>;
export type RaisePressureRejectionCode = z.infer<typeof raisePressureRejectionCodeSchema>;
export type RaisePressureCommandResult = z.infer<typeof raisePressureCommandResultSchema>;
export type ResolveCommitmentDeadlineCommand = z.infer<typeof resolveCommitmentDeadlineCommandSchema>;
export type ResolveDeadlineRejectionCode = z.infer<typeof resolveDeadlineRejectionCodeSchema>;
export type ResolveCommitmentDeadlineCommandResult = z.infer<
  typeof resolveCommitmentDeadlineCommandResultSchema
>;
export type FulfillCommitmentCommand = z.infer<typeof fulfillCommitmentCommandSchema>;
export type FulfillCommitmentRejectionCode = z.infer<typeof fulfillCommitmentRejectionCodeSchema>;
export type FulfillCommitmentCommandResult = z.infer<typeof fulfillCommitmentCommandResultSchema>;
export type CommitmentCreatedEvent = z.infer<typeof commitmentCreatedEventSchema>;
export type PressureRaisedEvent = z.infer<typeof pressureRaisedEventSchema>;
export type CommitmentKeptEvent = z.infer<typeof commitmentKeptEventSchema>;
export type CommitmentLateEvent = z.infer<typeof commitmentLateEventSchema>;
export type CommitmentMissedEvent = z.infer<typeof commitmentMissedEventSchema>;
