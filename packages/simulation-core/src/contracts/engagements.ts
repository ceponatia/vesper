import { z } from "zod";
import { activityClaimSchema } from "./activities";
import { pressureSeveritySchema } from "./commitments";
import {
  createCommandEnvelopeSchema,
  createCommandResultSchema,
  createEventEnvelopeSchema,
  createStableStringSetSchema,
} from "./envelopes";
import {
  commandIdSchema,
  engagementIdSchema,
  locationIdSchema,
  storySecondSchema,
  worldCharacterIdSchema,
  zoneIdSchema,
} from "./identity";

/**
 * E3.4 slice 1 — engagements as attention reservations. A conversation is a
 * world activity: it claims attention, it cannot place one body in two physical
 * scenes, and it never freezes the rest of the world. The live-scene arbiter,
 * pressure acknowledgment, winding-down choreography, NarrativeCut compilation,
 * and ArmedEffect confirmation build on this substrate in the next E3.4 slice.
 */

export const engagementChannels = ["co_present", "text", "voice", "video", "mixed"] as const;
export const engagementChannelSchema = z.enum(engagementChannels);
export type EngagementChannel = z.infer<typeof engagementChannelSchema>;

export const engagementStates = ["opening", "active", "winding_down", "ended", "interrupted"] as const;
export const engagementStateSchema = z.enum(engagementStates);
export type EngagementState = z.infer<typeof engagementStateSchema>;

/** The legal-transition table, exported so kernel and tests share one truth. */
export const engagementStateTransitions: Record<EngagementState, readonly EngagementState[]> = {
  opening: ["active", "ended", "interrupted"],
  active: ["winding_down", "ended", "interrupted"],
  winding_down: ["active", "ended", "interrupted"],
  interrupted: ["active", "ended"],
  ended: [],
};

/** States whose attention claims are held; only `ended` releases them. */
export const claimHoldingEngagementStates: readonly EngagementState[] = [
  "opening",
  "active",
  "winding_down",
  "interrupted",
];

const participantIdsSchema = createStableStringSetSchema(
  worldCharacterIdSchema,
  "Engagement participant IDs",
).refine((ids) => ids.length >= 2, "An engagement needs at least two participants");

export const engagementSchema = z
  .object({
    id: engagementIdSchema,
    participantIds: participantIdsSchema,
    channel: engagementChannelSchema,
    /** Present for co-present engagements: the shared physical scene. */
    locationId: locationIdSchema.optional(),
    zoneId: zoneIdSchema.optional(),
    state: engagementStateSchema,
    openedAt: storySecondSchema,
    /** The per-participant attention claim this engagement holds while open. */
    attentionClaim: activityClaimSchema,
    /** E5.5 slice 3: temporal-pressure ids acknowledged within this
     * engagement — a pressure "looked at and not resolved" this turn, so it
     * stops nagging until severity or assumptions change. */
    acknowledgedPressureIds: createStableStringSetSchema(
      z.string().min(1).max(1_024),
      "Acknowledged pressure IDs",
    ).default([]),
    sourceCommandId: commandIdSchema,
  })
  .strict()
  .refine((engagement) => engagement.channel !== "co_present" || engagement.zoneId !== undefined, {
    message: "A co-present engagement requires a physical zone",
    path: ["zoneId"],
  });

export type Engagement = z.infer<typeof engagementSchema>;

/**
 * The attention an engagement claims per participant: full presence for a
 * co-present scene, partial for a remote channel (a walking text chat coexists
 * with a walk; a co-present conversation does not coexist with another
 * full-attention occupation).
 */
export function engagementAttentionClaim(channel: EngagementChannel): z.infer<typeof activityClaimSchema> {
  return channel === "co_present"
    ? { kind: "attention", weight: "full" }
    : { kind: "attention", weight: "partial" };
}

// --- Commands ----------------------------------------------------------------

const openEngagementPayloadSchema = z
  .object({
    participantIds: participantIdsSchema,
    channel: engagementChannelSchema,
  })
  .strict();

export const openEngagementCommandSchema = createCommandEnvelopeSchema(
  "open_engagement",
  1,
  openEngagementPayloadSchema,
);

export const openEngagementRejectionCodes = [
  "invalid_command",
  "duplicate_command_id",
  "branch_mismatch",
  "participant_not_found",
  "unauthorized_actor",
  "participants_not_co_located",
  "participant_in_transit",
  "participant_already_engaged",
  "participant_unavailable",
] as const;
export const openEngagementRejectionCodeSchema = z.enum(openEngagementRejectionCodes);
export const openEngagementCommandResultSchema = createCommandResultSchema(
  openEngagementRejectionCodeSchema,
);

export const endEngagementReasons = ["participant_choice", "superseded"] as const;
export const endEngagementReasonSchema = z.enum(endEngagementReasons);

const endEngagementPayloadSchema = z
  .object({
    engagementId: engagementIdSchema,
    reason: endEngagementReasonSchema,
  })
  .strict();

export const endEngagementCommandSchema = createCommandEnvelopeSchema(
  "end_engagement",
  1,
  endEngagementPayloadSchema,
);

export const endEngagementRejectionCodes = [
  "invalid_command",
  "duplicate_command_id",
  "branch_mismatch",
  "engagement_not_found",
  "engagement_not_open",
  "unauthorized_actor",
] as const;
export const endEngagementRejectionCodeSchema = z.enum(endEngagementRejectionCodes);
export const endEngagementCommandResultSchema = createCommandResultSchema(
  endEngagementRejectionCodeSchema,
);

/** E5.5 slice 3: mark a live temporal pressure "looked at" by an engagement's
 * participant without resolving it. */
const acknowledgePressurePayloadSchema = z
  .object({
    engagementId: engagementIdSchema,
    pressureId: z.string().min(1).max(1_024),
  })
  .strict();

export const acknowledgePressureCommandSchema = createCommandEnvelopeSchema(
  "acknowledge_pressure",
  1,
  acknowledgePressurePayloadSchema,
);
export const acknowledgePressureRejectionCodes = [
  "invalid_command",
  "duplicate_command_id",
  "branch_mismatch",
  "engagement_not_found",
  "engagement_not_open",
  "pressure_not_found",
  "pressure_not_relevant",
  "unauthorized_principal",
  "already_acknowledged",
] as const;
export const acknowledgePressureRejectionCodeSchema = z.enum(acknowledgePressureRejectionCodes);
export const acknowledgePressureCommandResultSchema = createCommandResultSchema(
  acknowledgePressureRejectionCodeSchema,
);

// --- Engagement event family -------------------------------------------------

const engagementOpenedPayloadSchema = z
  .object({
    engagementId: engagementIdSchema,
    channel: engagementChannelSchema,
    zoneId: zoneIdSchema.optional(),
    openedAt: storySecondSchema,
    attentionClaim: activityClaimSchema,
  })
  .strict();

export const engagementOpenedEventSchema = createEventEnvelopeSchema(
  "engagement_opened",
  1,
  engagementOpenedPayloadSchema,
).extend({ commandId: commandIdSchema });

const engagementEndedPayloadSchema = z
  .object({
    engagementId: engagementIdSchema,
    endedAt: storySecondSchema,
    reason: endEngagementReasonSchema,
  })
  .strict();

export const engagementEndedEventSchema = createEventEnvelopeSchema(
  "engagement_ended",
  1,
  engagementEndedPayloadSchema,
);

export const engagementInterruptReasons = [
  "participant_departed",
  "participant_collapsed",
  "pressure",
  "hazard",
] as const;
export const engagementInterruptReasonSchema = z.enum(engagementInterruptReasons);

const engagementInterruptedPayloadSchema = z
  .object({
    engagementId: engagementIdSchema,
    interruptedAt: storySecondSchema,
    reason: engagementInterruptReasonSchema,
  })
  .strict();

export const engagementInterruptedEventSchema = createEventEnvelopeSchema(
  "engagement_interrupted",
  1,
  engagementInterruptedPayloadSchema,
);

const engagementWindingDownPayloadSchema = z
  .object({
    engagementId: engagementIdSchema,
    at: storySecondSchema,
  })
  .strict();

/** Vocabulary + applier now; the arbiter's winding-down choreography emits it (E3.4b). */
export const engagementWindingDownEventSchema = createEventEnvelopeSchema(
  "engagement_winding_down",
  1,
  engagementWindingDownPayloadSchema,
);

/** E5.5 slice 3: a pressure was looked at and not resolved — the engagement's
 * `acknowledgedPressureIds` and the pressure's own
 * `acknowledgedAt`/`acknowledgedSeverity` (`contracts/simulation/commitments.ts`)
 * both fold from this one event — two domain projectors, one cause. */
const pressureAcknowledgedPayloadSchema = z
  .object({
    engagementId: engagementIdSchema,
    pressureId: z.string().min(1).max(1_024),
    actorId: worldCharacterIdSchema,
    acknowledgedAt: storySecondSchema,
    /** Captured value — the narrative cut's acknowledgment-aware
     * pressure filter compares a live pressure's CURRENT severity against
     * this captured value, not merely presence/absence of acknowledgment. */
    acknowledgedSeverity: pressureSeveritySchema,
  })
  .strict();

export const pressureAcknowledgedEventSchema = createEventEnvelopeSchema(
  "pressure_acknowledged",
  1,
  pressureAcknowledgedPayloadSchema,
).extend({ commandId: commandIdSchema });

// --- Engagements projection ---------------------------------------------------

export const engagementsProjectionSchema = z
  .object({
    branchId: z.string().min(1),
    headSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    version: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    storySecond: storySecondSchema,
    engagements: z.array(engagementSchema),
  })
  .strict();

export type EngagementsProjection = z.infer<typeof engagementsProjectionSchema>;

// --- Types --------------------------------------------------------------------

export type OpenEngagementCommand = z.infer<typeof openEngagementCommandSchema>;
export type OpenEngagementCommandInput = z.input<typeof openEngagementCommandSchema>;
export type OpenEngagementRejectionCode = z.infer<typeof openEngagementRejectionCodeSchema>;
export type OpenEngagementCommandResult = z.infer<typeof openEngagementCommandResultSchema>;
export type EndEngagementCommand = z.infer<typeof endEngagementCommandSchema>;
export type EndEngagementReason = z.infer<typeof endEngagementReasonSchema>;
export type EndEngagementRejectionCode = z.infer<typeof endEngagementRejectionCodeSchema>;
export type EndEngagementCommandResult = z.infer<typeof endEngagementCommandResultSchema>;
export type EngagementOpenedEvent = z.infer<typeof engagementOpenedEventSchema>;
export type EngagementEndedEvent = z.infer<typeof engagementEndedEventSchema>;
export type EngagementInterruptedEvent = z.infer<typeof engagementInterruptedEventSchema>;
export type EngagementInterruptReason = z.infer<typeof engagementInterruptReasonSchema>;
export type EngagementWindingDownEvent = z.infer<typeof engagementWindingDownEventSchema>;
export type AcknowledgePressureCommand = z.infer<typeof acknowledgePressureCommandSchema>;
export type AcknowledgePressureRejectionCode = z.infer<typeof acknowledgePressureRejectionCodeSchema>;
export type AcknowledgePressureCommandResult = z.infer<typeof acknowledgePressureCommandResultSchema>;
export type PressureAcknowledgedEvent = z.infer<typeof pressureAcknowledgedEventSchema>;
