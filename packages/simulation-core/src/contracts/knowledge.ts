import { z } from "zod";
import {
  createCommandEnvelopeSchema,
  createCommandResultSchema,
  createEventEnvelopeSchema,
  createStableStringSetSchema,
} from "./envelopes";
import {
  assertionIdSchema,
  beliefIdSchema,
  branchSequenceSchema,
  commandIdSchema,
  composeSimulationId,
  eventIdSchema,
  observationIdSchema,
  simulationEntityIdSchema,
  storySecondSchema,
  worldBranchIdSchema,
  worldCharacterIdSchema,
} from "./identity";
import { observationConfidenceSchema } from "./perception";

/**
 * E4.2 — assertions, beliefs, disclosure, and gossip (engine.spec §21). An
 * Assertion is a claim someone made — it may be false; canon truth lives in
 * events, never here. A Belief is one actor's held stance toward an assertion,
 * with provenance: which observations it rests on and through whom it
 * travelled. Gossip is a `disclosure_made` event plus the listeners'
 * observations and belief updates — each hop preserves provenance through an
 * explicit event, so "who told whom" is always reconstructible.
 *
 * Both ledgers are DERIVED projections of the event stream (like §20
 * observations): every id is deterministic, every update is a pure fold, and
 * a rebuilt branch mints identical rows bit-for-bit.
 */

export const KNOWLEDGE_DERIVATION_VERSION = "knowledge-v1" as const;
export const knowledgeDerivationVersionSchema = z
  .literal(KNOWLEDGE_DERIVATION_VERSION)
  .brand<"DerivationVersion">();

/**
 * A proposition key names WHAT is claimed ("works_at", "is_seeing_someone") —
 * registry-style vocabulary, so contradiction detection is an equality check,
 * never prose parsing.
 */
export const propositionKeySchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => value.trim() === value, "Proposition keys cannot have surrounding whitespace")
  .refine((value) => !/\s/u.test(value), "Proposition keys cannot contain whitespace");

const subjectIdsSchema = createStableStringSetSchema(
  simulationEntityIdSchema,
  "Assertion subject IDs",
).refine((ids) => ids.length >= 1, "An assertion needs at least one subject");

/** Claimed values are opaque JSON — compared structurally, never interpreted. */
export const claimedValueSchema = z.json();

// --- Assertion (engine.spec §21.1) ------------------------------------------

export const assertionStatuses = ["active", "contradicted", "superseded", "retracted"] as const;
export const assertionStatusSchema = z.enum(assertionStatuses);
export type AssertionStatus = z.infer<typeof assertionStatusSchema>;

/** Legal §21.1 status moves, exported so kernel and tests share one truth. */
export const assertionStatusTransitions: Record<AssertionStatus, readonly AssertionStatus[]> = {
  active: ["contradicted", "superseded", "retracted"],
  contradicted: ["superseded", "retracted"],
  superseded: ["retracted"],
  retracted: [],
};

export const assertionSchema = z
  .object({
    id: assertionIdSchema,
    branchId: worldBranchIdSchema,
    propositionKey: propositionKeySchema,
    subjectIds: subjectIdsSchema,
    claimedValue: claimedValueSchema,
    /** Optional per spec — headroom for E4.4 sourceless authored lore. */
    sourceActorId: worldCharacterIdSchema.optional(),
    sourceEventId: eventIdSchema.optional(),
    sourceEventSequence: branchSequenceSchema.optional(),
    assertedAt: storySecondSchema,
    validFrom: storySecondSchema.optional(),
    validUntil: storySecondSchema.optional(),
    status: assertionStatusSchema,
    statusChangedAt: storySecondSchema.optional(),
    statusCauseEventId: eventIdSchema.optional(),
    derivationVersion: knowledgeDerivationVersionSchema,
  })
  .strict()
  .refine(
    (assertion) =>
      assertion.validFrom === undefined ||
      assertion.validUntil === undefined ||
      assertion.validFrom <= assertion.validUntil,
    { message: "Assertion validity interval is reversed", path: ["validUntil"] },
  );

export type Assertion = z.infer<typeof assertionSchema>;

// --- Belief (engine.spec §21.2) ----------------------------------------------

export const beliefStatuses = ["active", "doubted", "rejected", "superseded"] as const;
export const beliefStatusSchema = z.enum(beliefStatuses);
export type BeliefStatus = z.infer<typeof beliefStatusSchema>;

export const beliefStatusTransitions: Record<BeliefStatus, readonly BeliefStatus[]> = {
  active: ["doubted", "rejected", "superseded"],
  doubted: ["rejected", "superseded"],
  rejected: [],
  superseded: [],
};

/** Gossip chains cap at 16 hops — the deriver truncates to the most recent. */
export const MAX_LEARNED_FROM_CHAIN = 16;

export const beliefSchema = z
  .object({
    id: beliefIdSchema,
    branchId: worldBranchIdSchema,
    holderActorId: worldCharacterIdSchema,
    assertionId: assertionIdSchema,
    confidenceFixedPoint: observationConfidenceSchema,
    /** The §20 observations this belief rests on (the disclosure as heard). */
    basisObservationIds: z.array(observationIdSchema).max(8),
    /** Provenance path, oldest → newest teller. A path, not a set: order is the route. */
    learnedFromActorIds: z.array(worldCharacterIdSchema).max(MAX_LEARNED_FROM_CHAIN),
    believedFrom: storySecondSchema,
    believedUntil: storySecondSchema.optional(),
    status: beliefStatusSchema,
    statusCauseEventId: eventIdSchema.optional(),
    /** The disclosure event that minted this row. */
    sourceEventId: eventIdSchema,
    sourceEventSequence: branchSequenceSchema,
    derivationVersion: knowledgeDerivationVersionSchema,
  })
  .strict()
  .refine(
    (belief) => belief.believedUntil === undefined || belief.believedFrom <= belief.believedUntil,
    { message: "Belief interval is reversed", path: ["believedUntil"] },
  );

export type Belief = z.infer<typeof beliefSchema>;

// --- Disclosure content -------------------------------------------------------

/**
 * What a disclosure carries: an original claim, a relay of an existing
 * assertion (a gossip hop), or the source's own retraction. Relaying a stale
 * or superseded assertion is deliberately legal — gossip spreads old news.
 */
export const disclosureContentSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("claim"),
      propositionKey: propositionKeySchema,
      subjectIds: subjectIdsSchema,
      claimedValue: claimedValueSchema,
      validFrom: storySecondSchema.optional(),
      validUntil: storySecondSchema.optional(),
    })
    .strict(),
  z.object({ kind: z.literal("relay"), assertionId: assertionIdSchema }).strict(),
  z.object({ kind: z.literal("retraction"), assertionId: assertionIdSchema }).strict(),
]);

export type DisclosureContent = z.infer<typeof disclosureContentSchema>;

// --- Command (make_disclosure) ------------------------------------------------

const makeDisclosurePayloadSchema = z
  .object({
    speakerActorId: worldCharacterIdSchema,
    targetActorIds: createStableStringSetSchema(
      worldCharacterIdSchema,
      "Disclosure target actor IDs",
    ).refine((ids) => ids.length >= 1, "A disclosure needs at least one listener"),
    content: disclosureContentSchema,
  })
  .strict()
  .refine((payload) => !payload.targetActorIds.includes(payload.speakerActorId), {
    message: "A speaker cannot disclose to themselves",
    path: ["targetActorIds"],
  })
  .refine(
    (payload) =>
      payload.content.kind !== "claim" ||
      payload.content.validFrom === undefined ||
      payload.content.validUntil === undefined ||
      payload.content.validFrom <= payload.content.validUntil,
    { message: "Claim validity interval is reversed", path: ["content"] },
  );

export const makeDisclosureCommandSchema = createCommandEnvelopeSchema(
  "make_disclosure",
  1,
  makeDisclosurePayloadSchema,
);

export const makeDisclosureRejectionCodes = [
  "invalid_command",
  "duplicate_command_id",
  "branch_mismatch",
  "speaker_not_found",
  "target_not_found",
  "unauthorized_actor",
  "assertion_not_found",
  "relay_unbelieved",
  "retraction_unauthorized",
  "assertion_already_retracted",
] as const;
export const makeDisclosureRejectionCodeSchema = z.enum(makeDisclosureRejectionCodes);
export const makeDisclosureCommandResultSchema = createCommandResultSchema(
  makeDisclosureRejectionCodeSchema,
);

// --- Event (disclosure_made) --------------------------------------------------

const disclosureMadePayloadSchema = z
  .object({
    speakerActorId: worldCharacterIdSchema,
    targetActorIds: createStableStringSetSchema(
      worldCharacterIdSchema,
      "Disclosure target actor IDs",
    ),
    content: disclosureContentSchema,
    /**
     * Captured §6.4 derivation — the values the belief fold consumes, frozen
     * at command time so replay never re-reads mutable belief rows:
     * the assertion this disclosure is about, the teller's confidence at the
     * moment of telling (10 000 for an original claim or retraction, the
     * relayer's live belief confidence for a relay), and the provenance chain
     * listeners will record (always ends with this event's speaker).
     */
    derived: z
      .object({
        assertionId: assertionIdSchema,
        sourceConfidenceFixedPoint: observationConfidenceSchema,
        learnedFromActorIds: z
          .array(worldCharacterIdSchema)
          .min(1)
          .max(MAX_LEARNED_FROM_CHAIN),
      })
      .strict(),
  })
  .strict();

export const disclosureMadeEventSchema = createEventEnvelopeSchema(
  "disclosure_made",
  1,
  disclosureMadePayloadSchema,
).extend({
  commandId: commandIdSchema,
  derivationVersion: knowledgeDerivationVersionSchema,
});

export type MakeDisclosureCommand = z.infer<typeof makeDisclosureCommandSchema>;
export type MakeDisclosureCommandInput = z.input<typeof makeDisclosureCommandSchema>;
export type MakeDisclosureRejectionCode = z.infer<typeof makeDisclosureRejectionCodeSchema>;
export type MakeDisclosureCommandResult = z.infer<typeof makeDisclosureCommandResultSchema>;
export type DisclosureMadeEvent = z.infer<typeof disclosureMadeEventSchema>;

// --- Knowledge projection (parity and fork rebuild) ---------------------------

export const knowledgeProjectionSchema = z
  .object({
    branchId: worldBranchIdSchema,
    assertions: z.array(assertionSchema),
    beliefs: z.array(beliefSchema),
  })
  .strict();

export type KnowledgeProjection = z.infer<typeof knowledgeProjectionSchema>;

// --- Deterministic identity ---------------------------------------------------

/** One assertion per originating claim event; replay mints the identical id. */
export function deriveAssertionId(sourceEventId: string): string {
  return composeSimulationId("assert", [sourceEventId]);
}

/** One belief row per (disclosure event, holder); updates supersede, never overwrite. */
export function deriveBeliefId(sourceEventId: string, holderActorId: string): string {
  return composeSimulationId("belief", [sourceEventId, holderActorId]);
}
