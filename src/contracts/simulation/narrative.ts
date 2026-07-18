import { z } from "zod";
import {
  createCommandEnvelopeSchema,
  createCommandResultSchema,
  createEventEnvelopeSchema,
} from "./envelopes";
import {
  commandIdSchema,
  engagementIdSchema,
  narrativeCutIdSchema,
  storySecondSchema,
  worldBranchIdSchema,
  worldCharacterIdSchema,
  worldIdSchema,
  zoneIdSchema,
} from "./identity";
import { pressureSeveritySchema } from "./commitments";

/**
 * E3.4 slice 2 — the live-scene turn contract: one perspective-safe
 * NarrativeCut per prepared turn (engine.spec §22 trimmed to Gate 3's
 * deterministic subset) and ArmedEffect confirmation for speech acts
 * (§23.3, ruling 9: every semantic speech act is recorded only when the
 * rendered reply actually delivers it).
 *
 * Cuts are derived, not stored: identity and semantic hash are pure functions
 * of immutable events and the viewpoint, so recompiling a cut ID reproduces
 * its content hash (§22.3) and a failed narrator render (ruling 8) simply
 * re-reads the same cut — there is no state to roll back. Two-phase arming
 * with persisted cut rows joins with the Gate 4 narrator integration.
 */

/** The ruled §23.3 speech-act vocabulary — closed; physical outcomes cannot ride it. */
export const speechActTypes = [
  "promise_offered",
  "promise_accepted",
  "invitation_spoken",
  "disclosure_made",
  "warning_communicated",
  "boundary_expressed",
  "question_asked",
  "apology_delivered",
] as const;
export const speechActTypeSchema = z.enum(speechActTypes);
export type SpeechActType = z.infer<typeof speechActTypeSchema>;

export const armedEffectSchema = z
  .object({
    id: z.string().min(1).max(2_048),
    cutId: narrativeCutIdSchema,
    effectType: speechActTypeSchema,
    actorId: worldCharacterIdSchema,
    targetActorIds: z.array(worldCharacterIdSchema).min(1),
    /** Short human-readable content summary; never parsed for state. */
    detail: z.string().trim().min(1).max(500),
  })
  .strict();

export type ArmedEffect = z.infer<typeof armedEffectSchema>;

// --- The Gate 3 NarrativeCut -------------------------------------------------

const cutBeatSchema = z
  .object({
    kind: z.string().min(1),
    eventId: z.string().min(1),
    sequence: z.number().int().positive(),
    storySecond: storySecondSchema,
    /** One neutral sentence of world truth the prose must enact. */
    summary: z.string().min(1),
  })
  .strict();

const cutLocusSchema = z
  .object({
    actorId: worldCharacterIdSchema,
    kind: z.enum(["at", "in_transit"]),
    zoneId: zoneIdSchema.optional(),
  })
  .strict();

const cutPressureSchema = z
  .object({
    commitmentId: z.string().min(1),
    severity: pressureSeveritySchema,
    actBy: storySecondSchema,
  })
  .strict();

export const gate3NarrativeCutSchema = z
  .object({
    id: narrativeCutIdSchema,
    semanticHash: z.string().regex(/^[0-9a-f]{8}$/u),
    worldId: worldIdSchema,
    branchId: worldBranchIdSchema,
    branchVersion: z.number().int().nonnegative(),
    engagementId: engagementIdSchema,
    viewpointActorId: worldCharacterIdSchema,
    fromSequence: z.number().int().nonnegative(),
    throughSequence: z.number().int().nonnegative(),
    fromStorySecond: storySecondSchema,
    throughStorySecond: storySecondSchema,
    /** Perspective-safe loci: the viewpoint's own plus co-located actors only. */
    currentLoci: z.array(cutLocusSchema),
    /** Interval beats the viewpoint witnessed; prose must enact each once. */
    mustEnact: z.array(cutBeatSchema),
    /**
     * The viewpoint's OWN pressures only. Another actor's obligations enter a
     * cut solely as observable beats (a departure), never as private causes
     * (spec §14.4 — redaction by omission, not instruction).
     */
    relevantPressures: z.array(cutPressureSchema),
    forbiddenClaims: z.array(z.string().min(1)),
    armedEffects: z.array(armedEffectSchema),
    provenance: z.array(z.string().min(1)),
  })
  .strict()
  .refine((cut) => cut.throughSequence >= cut.fromSequence, {
    message: "NarrativeCut sequence range is reversed",
    path: ["throughSequence"],
  });

export type Gate3NarrativeCut = z.infer<typeof gate3NarrativeCutSchema>;

// --- Turn preparation input ---------------------------------------------------

/** A speech act the caller proposes for arming; validated at compile and confirm. */
export const proposedArmedEffectSchema = z
  .object({
    effectType: speechActTypeSchema,
    actorId: worldCharacterIdSchema,
    targetActorIds: z.array(worldCharacterIdSchema).min(1),
    detail: z.string().trim().min(1).max(500),
  })
  .strict();

export type ProposedArmedEffect = z.infer<typeof proposedArmedEffectSchema>;

// --- Speech-act confirmation (§23.3) ------------------------------------------

const confirmNarratorResultPayloadSchema = z
  .object({
    engagementId: engagementIdSchema,
    cutId: narrativeCutIdSchema,
    /**
     * Only the effects the rendered prose actually delivered, in meaning. A
     * render that delivered none records nothing — expiry is implicit, so
     * confirm is called only when at least one act landed.
     */
    enactedEffects: z.array(proposedArmedEffectSchema).min(1),
  })
  .strict();

export const confirmNarratorResultCommandSchema = createCommandEnvelopeSchema(
  "confirm_narrator_result",
  1,
  confirmNarratorResultPayloadSchema,
);

export const confirmNarratorResultRejectionCodes = [
  "invalid_command",
  "duplicate_command_id",
  "branch_mismatch",
  "engagement_not_found",
  "unauthorized_principal",
] as const;
export const confirmNarratorResultRejectionCodeSchema = z.enum(confirmNarratorResultRejectionCodes);
export const confirmNarratorResultCommandResultSchema = createCommandResultSchema(
  confirmNarratorResultRejectionCodeSchema,
);

const speechActDeliveredPayloadSchema = z
  .object({
    cutId: narrativeCutIdSchema,
    engagementId: engagementIdSchema,
    effectType: speechActTypeSchema,
    actorId: worldCharacterIdSchema,
    targetActorIds: z.array(worldCharacterIdSchema).min(1),
    detail: z.string().trim().min(1).max(500),
  })
  .strict();

/**
 * One delivered semantic speech act. Gate 5's social ledger derives promises
 * and boundaries from these; the closed effectType enum keeps the §9.2
 * distinct-concept rule honest while the family shares one envelope.
 */
export const speechActDeliveredEventSchema = createEventEnvelopeSchema(
  "speech_act_delivered",
  1,
  speechActDeliveredPayloadSchema,
).extend({ commandId: commandIdSchema });

export type ConfirmNarratorResultCommand = z.infer<typeof confirmNarratorResultCommandSchema>;
export type ConfirmNarratorResultRejectionCode = z.infer<typeof confirmNarratorResultRejectionCodeSchema>;
export type ConfirmNarratorResultCommandResult = z.infer<typeof confirmNarratorResultCommandResultSchema>;
export type SpeechActDeliveredEvent = z.infer<typeof speechActDeliveredEventSchema>;
