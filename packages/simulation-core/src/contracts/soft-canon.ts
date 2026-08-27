import { z } from "zod";
import {
  createCommandEnvelopeSchema,
  createCommandResultSchema,
  createEventEnvelopeSchema,
  createStableStringSetSchema,
} from "./envelopes";
import {
  commandIdSchema,
  composeSimulationId,
  eventIdSchema,
  narrativeCutIdSchema,
  simulationEntityIdSchema,
  softCanonEntryIdSchema,
  storySecondSchema,
  worldBranchIdSchema,
} from "./identity";
import { observationConfidenceSchema } from "./perception";

/**
 * E4.3 — soft canon (ruling 14). A soft-canon entry is a narrator-invented
 * detail ("the cafe's espresso machine hisses", "Mara calls the player
 * 'stray'") that survived validation and may be reused by later renders. It is
 * presentation-lane state, never hard truth: no entry may encode movement,
 * possession, injury, access, or another actor's private state, and promotion
 * to authored canon is always an explicit, audited event.
 *
 * Rows are DERIVED like §20 observations and §21 knowledge: the confirm
 * command captures the full post-fold entry snapshot in each event (§6.4), so
 * the fold is a pure upsert and a rebuilt branch mints identical rows.
 */

export const SOFT_CANON_DERIVATION_VERSION = "soft-canon-v1" as const;
export const softCanonDerivationVersionSchema = z
  .literal(SOFT_CANON_DERIVATION_VERSION)
  .brand<"DerivationVersion">();

export const softCanonScopes = [
  "scene",
  "relationship",
  "character",
  "location",
  "world",
] as const;
export const softCanonScopeSchema = z.enum(softCanonScopes);
export type SoftCanonScope = z.infer<typeof softCanonScopeSchema>;

/** Registry-style key naming WHAT the detail is — equality, never prose parsing. */
export const softCanonKeySchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => value.trim() === value, "Soft-canon keys cannot have surrounding whitespace")
  .refine((value) => !/\s/u.test(value), "Soft-canon keys cannot contain whitespace");

/** Values are opaque JSON — compared structurally, never interpreted. */
export const softCanonValueSchema = z.json();

const softCanonSubjectIdsSchema = createStableStringSetSchema(
  simulationEntityIdSchema,
  "Soft-canon subject IDs",
);

// --- Ruling-14 world-type rules ----------------------------------------------

/**
 * Every soft-canon threshold is a versioned world-type value (ruling 14): the
 * mechanism ships with documented defaults and is retuned by editing this
 * registry, never by a schema migration. The captured `rulesVersion` on every
 * entry and promotion event records which ruleset produced it.
 */
export const softCanonRulesSchema = z
  .object({
    /** Bumped on every tuning change so provenance survives retunes. */
    version: z.string().min(1).max(128),
    /** Ruling 14 lets a world type disable auto-promotion entirely. */
    autoPromotionEnabled: z.boolean(),
    /** Distinct committed cuts that must reuse a key before it auto-promotes. */
    promotionReuseCutCount: z.number().int().min(2),
    /** An entry below this confidence never auto-promotes. */
    promotionMinimumConfidenceFixedPoint: observationConfidenceSchema,
    /** Scopes eligible for auto-promotion; scene flavor always stays soft. */
    promotableScopes: z.array(softCanonScopeSchema),
    /** Proposals below this confidence are rejected at validation. */
    recordMinimumConfidenceFixedPoint: observationConfidenceSchema,
    /** Default expiry horizon per scope when a proposal names no validUntil. */
    ttlStorySecondsByScope: z.record(softCanonScopeSchema, z.number().int().positive()),
    /** The bounded store: live entries allowed per (branch, scope). */
    maxEntriesPerScope: z.number().int().positive(),
    /** Canonical-JSON byte budget per value — flavor, not a document store. */
    maxValueBytes: z.number().int().positive(),
    maxSubjectIds: z.number().int().positive(),
    /** Provenance cap: distinct source cuts remembered per entry. */
    maxSourceCutIds: z.number().int().min(2),
  })
  .strict();

export type SoftCanonRules = z.infer<typeof softCanonRulesSchema>;

/**
 * Default ruleset, documented for tuning (ruling 14):
 *
 * - `promotionReuseCutCount: 3` — one mention is flavor, two may be echo; a
 *   detail three distinct committed cuts reached for is load-bearing. Raise it
 *   if worlds promote noise; lower to 2 for short-session world types.
 * - `promotionMinimumConfidenceFixedPoint: 7_000` — below "fairly sure" the
 *   narrator itself hedged the detail; hedges should expire, not canonize.
 * - `promotableScopes` — scene ambiance never promotes (it dies with the
 *   scene); durable character/relationship/location/world texture may.
 * - TTLs — scene flavor lives an in-story hour; personal and place texture a
 *   week; world texture a month. Reuse refreshes the clock, so anything the
 *   narrator keeps reaching for effectively persists until promoted.
 * - `maxEntriesPerScope: 64` — the bounded store. Overflow rejects the newest
 *   proposal (never silently evicts something a render may rely on).
 * - `maxValueBytes: 2_048` — soft canon is a detail, not a lore document.
 */
export const defaultSoftCanonRules: SoftCanonRules = softCanonRulesSchema.parse({
  version: "soft-canon-rules-v1",
  autoPromotionEnabled: true,
  promotionReuseCutCount: 3,
  promotionMinimumConfidenceFixedPoint: 7_000,
  promotableScopes: ["relationship", "character", "location", "world"],
  recordMinimumConfidenceFixedPoint: 5_000,
  ttlStorySecondsByScope: {
    scene: 3_600,
    relationship: 604_800,
    character: 604_800,
    location: 604_800,
    world: 2_592_000,
  },
  maxEntriesPerScope: 64,
  maxValueBytes: 2_048,
  maxSubjectIds: 4,
  maxSourceCutIds: 16,
});

/**
 * Per-world-type overrides — the registry extension point. A world type
 * missing here runs the documented defaults; adding one is a data edit.
 */
export const worldTypeSoftCanonRules: Readonly<Record<string, SoftCanonRules>> = {};

export function resolveSoftCanonRules(worldTypeId: string): SoftCanonRules {
  return worldTypeSoftCanonRules[worldTypeId] ?? defaultSoftCanonRules;
}

// --- Proposal ----------------------------------------------------------------

/**
 * What the narrator emits (no source cut — the trust boundary stamps it; a
 * model is never trusted to attribute its own provenance).
 */
export const softCanonProposalDraftSchema = z
  .object({
    key: softCanonKeySchema,
    value: softCanonValueSchema,
    scope: softCanonScopeSchema,
    /**
     * Who or where the detail is about: actor ids for scene / relationship /
     * character scopes, the location or zone id for location scope, empty for
     * world scope. Validation enforces containment in the cut's visible
     * surface — soft canon cannot reach entities the render never saw.
     */
    subjectIds: softCanonSubjectIdsSchema,
    confidenceFixedPoint: observationConfidenceSchema,
    validUntil: storySecondSchema.optional(),
  })
  .strict();

export type SoftCanonProposalDraft = z.infer<typeof softCanonProposalDraftSchema>;

export const softCanonProposalSchema = softCanonProposalDraftSchema.extend({
  sourceCutId: narrativeCutIdSchema,
});

export type SoftCanonProposal = z.infer<typeof softCanonProposalSchema>;

// --- Entry -------------------------------------------------------------------

export const softCanonStatuses = ["active", "promoted", "demoted"] as const;
export const softCanonStatusSchema = z.enum(softCanonStatuses);
export type SoftCanonStatus = z.infer<typeof softCanonStatusSchema>;

/** Legal status moves, exported so kernel and tests share one truth. */
export const softCanonStatusTransitions: Record<SoftCanonStatus, readonly SoftCanonStatus[]> = {
  active: ["promoted", "demoted"],
  promoted: ["demoted"],
  demoted: [],
};

export const softCanonEntrySchema = z
  .object({
    id: softCanonEntryIdSchema,
    branchId: worldBranchIdSchema,
    key: softCanonKeySchema,
    scope: softCanonScopeSchema,
    subjectIds: softCanonSubjectIdsSchema,
    value: softCanonValueSchema,
    /** Highest confidence any accepted proposal carried for this entry. */
    confidenceFixedPoint: observationConfidenceSchema,
    firstRecordedAt: storySecondSchema,
    lastRecordedAt: storySecondSchema,
    /** Expiry is evaluated at read time; an expired entry is simply ignored. */
    validUntil: storySecondSchema.optional(),
    /** Distinct committed cuts that proposed or reused this key — provenance. */
    sourceCutIds: z.array(narrativeCutIdSchema).min(1),
    status: softCanonStatusSchema,
    statusChangedAt: storySecondSchema.optional(),
    statusCauseEventId: eventIdSchema.optional(),
    rulesVersion: z.string().min(1).max(128),
    derivationVersion: softCanonDerivationVersionSchema,
  })
  .strict()
  .refine((entry) => entry.firstRecordedAt <= entry.lastRecordedAt, {
    message: "Soft-canon recording interval is reversed",
    path: ["lastRecordedAt"],
  });

export type SoftCanonEntry = z.infer<typeof softCanonEntrySchema>;

/** One entry per (branch, scope, key, subjects); replay mints the identical id. */
export function deriveSoftCanonEntryId(
  branchId: string,
  scope: SoftCanonScope,
  key: string,
  subjectIds: readonly string[],
): string {
  return composeSimulationId("canon", [branchId, scope, key, ...subjectIds]);
}

// --- Events ------------------------------------------------------------------

/**
 * §6.4 captured derivation: each event carries the full post-fold entry
 * snapshot computed at command time, so live upsert and fork replay are the
 * same trivial fold and never re-read mutable rows.
 */
const softCanonRecordedPayloadSchema = z
  .object({
    proposal: softCanonProposalSchema,
    derived: z
      .object({
        entry: softCanonEntrySchema,
        /** False minted the entry; true refreshed it from a new distinct cut. */
        reused: z.boolean(),
      })
      .strict(),
  })
  .strict();

export const softCanonRecordedEventSchema = createEventEnvelopeSchema(
  "soft_canon_recorded",
  1,
  softCanonRecordedPayloadSchema,
).extend({ commandId: commandIdSchema, derivationVersion: softCanonDerivationVersionSchema });

/**
 * Ruling 14's audited promotion: never a silent write. The payload carries the
 * promoted snapshot (full source-cut provenance and confidence) plus the
 * thresholds that fired, so the audit trail explains itself after a retune.
 */
const softCanonPromotedPayloadSchema = z
  .object({
    entry: softCanonEntrySchema,
    reuseCutCount: z.number().int().min(1),
    thresholds: z
      .object({
        rulesVersion: z.string().min(1).max(128),
        promotionReuseCutCount: z.number().int().min(2),
        promotionMinimumConfidenceFixedPoint: observationConfidenceSchema,
      })
      .strict(),
  })
  .strict();

export const softCanonPromotedEventSchema = createEventEnvelopeSchema(
  "soft_canon_promoted",
  1,
  softCanonPromotedPayloadSchema,
).extend({ commandId: commandIdSchema, derivationVersion: softCanonDerivationVersionSchema });

/** The demotion path: retracts the record without touching event history. */
const softCanonDemotedPayloadSchema = z
  .object({
    entry: softCanonEntrySchema,
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

export const softCanonDemotedEventSchema = createEventEnvelopeSchema(
  "soft_canon_demoted",
  1,
  softCanonDemotedPayloadSchema,
).extend({ commandId: commandIdSchema, derivationVersion: softCanonDerivationVersionSchema });

export type SoftCanonRecordedEvent = z.infer<typeof softCanonRecordedEventSchema>;
export type SoftCanonPromotedEvent = z.infer<typeof softCanonPromotedEventSchema>;
export type SoftCanonDemotedEvent = z.infer<typeof softCanonDemotedEventSchema>;

// --- Command (demote_soft_canon) ---------------------------------------------

const demoteSoftCanonPayloadSchema = z
  .object({
    entryId: softCanonEntryIdSchema,
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

export const demoteSoftCanonCommandSchema = createCommandEnvelopeSchema(
  "demote_soft_canon",
  1,
  demoteSoftCanonPayloadSchema,
);

export const demoteSoftCanonRejectionCodes = [
  "invalid_command",
  "duplicate_command_id",
  "branch_mismatch",
  "unauthorized_principal",
  "entry_not_found",
  "entry_not_demotable",
] as const;
export const demoteSoftCanonRejectionCodeSchema = z.enum(demoteSoftCanonRejectionCodes);
export const demoteSoftCanonCommandResultSchema = createCommandResultSchema(
  demoteSoftCanonRejectionCodeSchema,
);

export type DemoteSoftCanonCommand = z.infer<typeof demoteSoftCanonCommandSchema>;
export type DemoteSoftCanonCommandInput = z.input<typeof demoteSoftCanonCommandSchema>;
export type DemoteSoftCanonRejectionCode = z.infer<typeof demoteSoftCanonRejectionCodeSchema>;
export type DemoteSoftCanonCommandResult = z.infer<typeof demoteSoftCanonCommandResultSchema>;

// --- Projection (parity and fork rebuild) ------------------------------------

export const softCanonProjectionSchema = z
  .object({
    branchId: worldBranchIdSchema,
    entries: z.array(softCanonEntrySchema),
  })
  .strict();

export type SoftCanonProjection = z.infer<typeof softCanonProjectionSchema>;

/** Why one proposal was refused — diagnostics, never a failed turn (§23.4). */
export const softCanonRejectionCodes = [
  "value_unparseable",
  "confidence_below_minimum",
  "value_too_large",
  "too_many_subjects",
  "subjects_outside_cut",
  "wrong_source_cut",
  "conflicts_with_active_entry",
  "duplicate_proposal",
  "scope_full",
] as const;
export const softCanonRejectionCodeSchema = z.enum(softCanonRejectionCodes);
export type SoftCanonRejectionCode = z.infer<typeof softCanonRejectionCodeSchema>;
