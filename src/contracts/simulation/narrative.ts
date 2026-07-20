import { z } from "zod";
import {
  createCommandEnvelopeSchema,
  createCommandResultSchema,
  createEventEnvelopeSchema,
  createStableStringSetSchema,
} from "./envelopes";
import {
  actionDefinitionIdSchema,
  activityInstanceIdSchema,
  assertionIdSchema,
  beliefIdSchema,
  branchSequenceSchema,
  commandIdSchema,
  engagementIdSchema,
  eventIdSchema,
  narrativeCutIdSchema,
  observationIdSchema,
  softCanonEntryIdSchema,
  storySecondSchema,
  worldBranchIdSchema,
  worldCharacterIdSchema,
  worldIdSchema,
  zoneIdSchema,
} from "./identity";
import { activityPhaseSchema } from "./activities";
import {
  METER_FIXED_POINT_ONE,
  energyReadBandSchema,
  intimacyPhaseSchema,
  visibleBodySignSchema,
} from "./bodies";
import { pressureSeveritySchema } from "./commitments";
import {
  claimedValueSchema,
  disclosureContentSchema,
  MAX_LEARNED_FROM_CHAIN,
  propositionKeySchema,
} from "./knowledge";
import { consentScopeKeySchema } from "./social";
import {
  observationChannelSchema,
  observationConfidenceSchema,
  observationDetailTierSchema,
  observationEvidenceClassSchema,
} from "./perception";
import {
  softCanonProposalDraftSchema,
  softCanonProposalSchema,
  softCanonScopeSchema,
  softCanonValueSchema,
} from "./soft-canon";

/**
 * E4.3 — the full §22.1 NarrativeCut, the §23.1 narrator trust boundary, and
 * the §23.2 presentation audit. A cut is everything one narrator render may
 * know: compiled deterministically, persisted immutable (§22.3), and
 * perspective-safe by OMISSION — private facts are absent, not flagged
 * (prompt instructions are defense in depth, never the privacy boundary).
 *
 * Rerender re-reads the persisted cut and creates nothing; a failed render
 * retries from the same row (ruling 8). Armed speech acts confirm against the
 * persisted cut by id (§23.3, ruling 9) — unlisted ids are ignored, unenacted
 * effects expire with their cut.
 */

export const CUT_COMPILER_VERSION = "cut-v3" as const;

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
  "permission_granted", // E5.5, ruling 16
  "permission_withdrawn", // E5.5, ruling 16
] as const;
export const speechActTypeSchema = z.enum(speechActTypes);
export type SpeechActType = z.infer<typeof speechActTypeSchema>;

/** Speech-act types the E5.5 §21.3 fold turns into a consent-scoped ledger
 * entry (`boundary_stated`/`permission_granted`/`permission_withdrawn`) — a
 * speech act's free-text `detail` carries no structured scope, so these three
 * need `consentScopeKey` to name what boundary or permission it concerns. */
const CONSENT_SCOPED_SPEECH_ACT_TYPES: readonly SpeechActType[] = [
  "boundary_expressed",
  "permission_granted",
  "permission_withdrawn",
];

const armedEffectFields = {
  effectType: speechActTypeSchema,
  actorId: worldCharacterIdSchema,
  targetActorIds: z.array(worldCharacterIdSchema).min(1),
  /** Short human-readable content summary; never parsed for state. */
  detail: z.string().trim().min(1).max(500),
  /**
   * The E4.2 bridge: an armed `disclosure_made` MAY carry typed knowledge
   * content. When the render enacts it, confirmation appends a real §21
   * `disclosure_made` event alongside the speech act, so gossip spoken by the
   * narrator enters the belief ledgers with full provenance.
   */
  disclosureContent: disclosureContentSchema.optional(),
  /** E5.5 (§21.3, §21.4): required exactly on the three consent-scoped
   * effect types above — names the scope the boundary or permission covers. */
  consentScopeKey: consentScopeKeySchema.optional(),
};

function disclosureContentOnlyOnDisclosures(effect: {
  effectType: SpeechActType;
  disclosureContent?: unknown;
}): boolean {
  return effect.disclosureContent === undefined || effect.effectType === "disclosure_made";
}

function consentScopeKeyRequiredOnConsentEffects(effect: {
  effectType: SpeechActType;
  consentScopeKey?: unknown;
}): boolean {
  const requiresScope = CONSENT_SCOPED_SPEECH_ACT_TYPES.includes(effect.effectType);
  return requiresScope ? effect.consentScopeKey !== undefined : effect.consentScopeKey === undefined;
}

export const armedEffectSchema = z
  .object({
    id: z.string().min(1).max(2_048),
    cutId: narrativeCutIdSchema,
    /** The branch version the cut was compiled at (§23.3 revalidation). */
    preconditionVersion: z.number().int().nonnegative(),
    ...armedEffectFields,
  })
  .strict()
  .refine(disclosureContentOnlyOnDisclosures, {
    message: "Only a disclosure_made effect may carry disclosure content",
    path: ["disclosureContent"],
  })
  .refine(consentScopeKeyRequiredOnConsentEffects, {
    message: "consentScopeKey is required on boundary/permission effects and illegal elsewhere",
    path: ["consentScopeKey"],
  });

export type ArmedEffect = z.infer<typeof armedEffectSchema>;

/** A speech act the caller proposes for arming; validated at compile time. */
export const proposedArmedEffectSchema = z
  .object(armedEffectFields)
  .strict()
  .refine(disclosureContentOnlyOnDisclosures, {
    message: "Only a disclosure_made effect may carry disclosure content",
    path: ["disclosureContent"],
  })
  .refine(consentScopeKeyRequiredOnConsentEffects, {
    message: "consentScopeKey is required on boundary/permission effects and illegal elsewhere",
    path: ["consentScopeKey"],
  });

export type ProposedArmedEffect = z.infer<typeof proposedArmedEffectSchema>;

// --- Cut building blocks (§22.1) ---------------------------------------------

const cutBeatSchema = z
  .object({
    kind: z.string().min(1),
    eventId: eventIdSchema,
    sequence: branchSequenceSchema,
    storySecond: storySecondSchema,
    /** One neutral sentence of world truth the prose must (or may) enact. */
    summary: z.string().min(1),
  })
  .strict();

export type NarrativeBeat = z.infer<typeof cutBeatSchema>;

const cutLocusSchema = z
  .object({
    actorId: worldCharacterIdSchema,
    kind: z.enum(["at", "in_transit"]),
    zoneId: zoneIdSchema.optional(),
  })
  .strict();

/** A co-located activity as the viewpoint can see it — no claims, no progress. */
const cutActivitySchema = z
  .object({
    activityId: activityInstanceIdSchema,
    actionDefinitionId: actionDefinitionIdSchema,
    actorIds: createStableStringSetSchema(worldCharacterIdSchema, "Cut activity actor IDs"),
    zoneId: zoneIdSchema,
    phase: activityPhaseSchema,
  })
  .strict();

export type CutActivity = z.infer<typeof cutActivitySchema>;

/** One §20 observation as narrator-facing evidence: how well, through what. */
const evidenceViewSchema = z
  .object({
    observationId: observationIdSchema,
    sourceEventId: eventIdSchema,
    eventKind: z.string().min(1),
    channel: observationChannelSchema,
    evidenceClass: observationEvidenceClassSchema,
    confidenceFixedPoint: observationConfidenceSchema,
    detailTier: observationDetailTierSchema,
    storySecond: storySecondSchema,
  })
  .strict();

export type EvidenceView = z.infer<typeof evidenceViewSchema>;

/**
 * One live belief of the VIEWPOINT actor, joined with its assertion so the
 * narrator can voice what this speaker thinks is true — which may be false,
 * stale, or gossip. Only the viewpoint's own beliefs ever enter a cut.
 */
const beliefViewSchema = z
  .object({
    beliefId: beliefIdSchema,
    assertionId: assertionIdSchema,
    propositionKey: propositionKeySchema,
    subjectIds: z.array(z.string().min(1)).min(1),
    claimedValue: claimedValueSchema,
    confidenceFixedPoint: observationConfidenceSchema,
    status: z.enum(["active", "doubted"]),
    /** Who it travelled through, oldest → newest — "Mara said that Iris said…". */
    learnedFromActorIds: z.array(worldCharacterIdSchema).max(MAX_LEARNED_FROM_CHAIN),
  })
  .strict();

export type BeliefView = z.infer<typeof beliefViewSchema>;

const cutPressureSchema = z
  .object({
    commitmentId: z.string().min(1),
    severity: pressureSeveritySchema,
    actBy: storySecondSchema,
  })
  .strict();

/** The §22.2 forbidden-claim vocabulary — typed codes, not only prose. */
export const forbiddenClaimCodes = [
  "impossible_presence",
  "unearned_travel",
  "unearned_possession",
  "unearned_knowledge",
  "unearned_access",
  "incompatible_action",
  "unauthorized_player_speech",
  "private_denial_disclosure",
  "future_completed",
] as const;
export const forbiddenClaimCodeSchema = z.enum(forbiddenClaimCodes);
export type ForbiddenClaimCode = z.infer<typeof forbiddenClaimCodeSchema>;

export const forbiddenClaimSchema = z
  .object({
    code: forbiddenClaimCodeSchema,
    claim: z.string().min(1),
    /** Specific actors the ban names (departed participants, absent actors). */
    subjectActorIds: createStableStringSetSchema(
      worldCharacterIdSchema,
      "Forbidden-claim subject actor IDs",
    ),
  })
  .strict();

export type ForbiddenClaim = z.infer<typeof forbiddenClaimSchema>;

/** §14.4: the public face of a failure — the private cause never enters a cut. */
export const publicFailurePresentationSchema = z
  .object({
    code: z.string().min(1).max(128),
    publicReason: z.string().min(1).max(500),
    publicEvidence: z.array(z.string().min(1).max(500)).max(8),
    legalAlternatives: z.array(z.string().min(1).max(128)).max(16),
  })
  .strict();

export type PublicFailurePresentation = z.infer<typeof publicFailurePresentationSchema>;

/**
 * Bounded invention the narrator MAY exercise (§23.1): transient ambiance,
 * the viewpoint's inner voice, consequence-free small talk, and reuse of
 * already-established soft canon. A license never grants a hard outcome.
 */
export const creativeLicenseKinds = [
  "ambient_detail",
  "inner_monologue",
  "small_talk",
  "established_detail",
] as const;
export const creativeLicenseKindSchema = z.enum(creativeLicenseKinds);
export type CreativeLicenseKind = z.infer<typeof creativeLicenseKindSchema>;

export const creativeLicenseSchema = z
  .object({
    kind: creativeLicenseKindSchema,
    note: z.string().min(1).max(500),
    subjectActorIds: createStableStringSetSchema(
      worldCharacterIdSchema,
      "Creative-license subject actor IDs",
    ),
    zoneId: zoneIdSchema.optional(),
    /** Present exactly when kind is established_detail: the entry to reuse. */
    softCanon: z
      .object({
        entryId: softCanonEntryIdSchema,
        key: z.string().min(1).max(128),
        scope: softCanonScopeSchema,
        value: softCanonValueSchema,
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((license) => (license.kind === "established_detail") === (license.softCanon !== undefined), {
    message: "established_detail licenses carry soft canon; no other kind may",
    path: ["softCanon"],
  });

export type CreativeLicense = z.infer<typeof creativeLicenseSchema>;

/**
 * E5.2 — the §25.1 layer-3 body surface inside the cut. The viewpoint gets
 * their OWN reads (interoception: the signed energy axis and the intimacy
 * pulse); everyone else appears only as the closed visible-sign vocabulary a
 * witness could actually perceive. Raw meters structurally cannot enter a
 * cut — this schema has no field for them.
 */
export const cutBodilyReadsSchema = z
  .object({
    /** Absent when the viewpoint has no initialized body. */
    self: z
      .object({
        energySignedFixedPoint: z
          .number()
          .int()
          .min(-METER_FIXED_POINT_ONE)
          .max(METER_FIXED_POINT_ONE),
        energyBand: energyReadBandSchema,
        intimacyPhase: intimacyPhaseSchema,
      })
      .strict()
      .optional(),
    /** Co-present actors with at least one perceivable sign, actor-sorted. */
    observed: z
      .array(
        z
          .object({
            actorId: worldCharacterIdSchema,
            signs: z.array(visibleBodySignSchema).min(1).max(8),
          })
          .strict(),
      )
      .max(16),
  })
  .strict();

export type CutBodilyReads = z.infer<typeof cutBodilyReadsSchema>;

/** Per-field provenance: which persisted records justify each cut field. */
export const provenanceRefKinds = [
  "event",
  "observation",
  "belief",
  "pressure",
  "activity",
  "locus",
  "soft_canon",
  "failure",
] as const;
export const provenanceRefKindSchema = z.enum(provenanceRefKinds);

export const provenanceRefSchema = z
  .object({
    field: z.string().min(1).max(64),
    kind: provenanceRefKindSchema,
    ids: z.array(z.string().min(1).max(2_048)).min(1),
  })
  .strict();

export type ProvenanceRef = z.infer<typeof provenanceRefSchema>;

// --- The NarrativeCut (§22.1) -------------------------------------------------

export const narrativeCutSchema = z
  .object({
    id: narrativeCutIdSchema,
    /** §22.3: recompiling this cut id must reproduce this hash, or fail loudly. */
    semanticHash: z.string().regex(/^[0-9a-f]{8}$/u),
    compilerVersion: z.string().min(1).max(64),
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
    /** Claim-holding activities visibly running in the viewpoint's zone. */
    currentActivities: z.array(cutActivitySchema),
    /** Interval beats the viewpoint witnessed; prose must enact each once. */
    mustEnact: z.array(cutBeatSchema),
    /** The viewpoint's §20 evidence for this interval, graded as it arrived. */
    perceptibleNow: z.array(evidenceViewSchema),
    /** What the viewpoint believes (§21) — voiceable, possibly false. */
    speakerBeliefs: z.array(beliefViewSchema),
    /**
     * The viewpoint's OWN pressures only. Another actor's obligations enter a
     * cut solely as observable beats (a departure), never as private causes
     * (spec §14.4 — redaction by omission, not instruction).
     */
    relevantPressures: z.array(cutPressureSchema),
    /** Already-resolved beats the narrator MAY portray — never new outcomes. */
    allowedTransitions: z.array(cutBeatSchema),
    forbiddenClaims: z.array(forbiddenClaimSchema),
    /** Public faces of this turn's failed attempts, private causes omitted. */
    failurePresentations: z.array(publicFailurePresentationSchema),
    creativeLicenses: z.array(creativeLicenseSchema),
    armedEffects: z.array(armedEffectSchema),
    /** Defaulted so cuts persisted before cut-v3 still parse (§22.3). */
    bodilyReads: cutBodilyReadsSchema.default({ observed: [] }),
    provenance: z.array(provenanceRefSchema),
  })
  .strict()
  .refine((cut) => cut.throughSequence >= cut.fromSequence, {
    message: "NarrativeCut sequence range is reversed",
    path: ["throughSequence"],
  });

export type NarrativeCut = z.infer<typeof narrativeCutSchema>;

// --- Narrator result (§23.1) ---------------------------------------------------

/**
 * The narrator's structured reply. Deliberately NOT `.strict()`: it crosses a
 * trust boundary, so unknown fields are stripped and ignored rather than
 * failing the render. Enactment is declared by ID — paraphrase counts, keyword
 * matching never happens (ruling 9).
 */
export const narratorResultSchema = z.object({
  prose: z.string().max(20_000),
  enactedArmedEffectIds: z.array(z.string().min(1).max(2_048)).max(32),
  /** Which mustEnact beats the prose delivered, by event id (§23.2 audit). */
  enactedBeatEventIds: z.array(z.string().min(1).max(2_048)).max(64),
  proposedSoftCanon: z.array(softCanonProposalDraftSchema).max(16),
  diagnostics: z.array(z.string().min(1).max(500)).max(16).optional(),
});

export type NarratorResult = z.infer<typeof narratorResultSchema>;

// --- Presentation audit (§23.2) ------------------------------------------------

export const presentationAuditVerdicts = ["accept", "accept_with_bridge", "rerender"] as const;
export const presentationAuditVerdictSchema = z.enum(presentationAuditVerdicts);
export type PresentationAuditVerdict = z.infer<typeof presentationAuditVerdictSchema>;

/**
 * The auditor's report. It can request a rerender or supply a deterministic
 * bridge built from beat summaries; it can never mutate truth — every field
 * is a flag or a sentence, none is an event.
 */
export const presentationAuditSchema = z
  .object({
    verdict: presentationAuditVerdictSchema,
    missingBeatEventIds: z.array(eventIdSchema),
    /** Neutral beat summaries appended when small omissions are bridgeable. */
    bridgeProse: z.string().min(1).optional(),
    unknownEnactedArmedEffectIds: z.array(z.string().min(1)),
    unknownEnactedBeatEventIds: z.array(z.string().min(1)),
    proseEmpty: z.boolean(),
    diagnostics: z.array(z.string().min(1)),
  })
  .strict();

export type PresentationAudit = z.infer<typeof presentationAuditSchema>;

// --- Narrator-result confirmation (§23.3, ruling 9) ----------------------------

const confirmNarratorResultPayloadSchema = z
  .object({
    engagementId: engagementIdSchema,
    cutId: narrativeCutIdSchema,
    /**
     * The armed-effect ids the rendered prose actually delivered, in meaning.
     * Validated against the PERSISTED cut row — unlisted or unknown ids are
     * ignored, and everything unenacted expires with the cut.
     */
    enactedArmedEffectIds: z.array(z.string().min(1).max(2_048)).max(32),
    /** Validated §23.4 proposals, source cut already stamped by the boundary. */
    softCanonProposals: z.array(softCanonProposalSchema).max(16),
  })
  .strict()
  .refine(
    (payload) => payload.enactedArmedEffectIds.length > 0 || payload.softCanonProposals.length > 0,
    { message: "A confirmation with nothing enacted and nothing proposed records nothing" },
  );

export const confirmNarratorResultCommandSchema = createCommandEnvelopeSchema(
  "confirm_narrator_result",
  2,
  confirmNarratorResultPayloadSchema,
);

export const confirmNarratorResultRejectionCodes = [
  "invalid_command",
  "duplicate_command_id",
  "branch_mismatch",
  "engagement_not_found",
  "unauthorized_principal",
  "cut_not_found",
  "cut_superseded",
  "cut_incompatible",
  "nothing_to_record",
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
    /** E5.5 (§21.3, §21.4) — see `armedEffectFields`'s doc comment above. */
    consentScopeKey: consentScopeKeySchema.optional(),
  })
  .strict()
  .refine(consentScopeKeyRequiredOnConsentEffects, {
    message: "consentScopeKey is required on boundary/permission effects and illegal elsewhere",
    path: ["consentScopeKey"],
  });

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
export type ConfirmNarratorResultCommandInput = z.input<typeof confirmNarratorResultCommandSchema>;
export type ConfirmNarratorResultRejectionCode = z.infer<typeof confirmNarratorResultRejectionCodeSchema>;
export type ConfirmNarratorResultCommandResult = z.infer<typeof confirmNarratorResultCommandResultSchema>;
export type SpeechActDeliveredEvent = z.infer<typeof speechActDeliveredEventSchema>;
