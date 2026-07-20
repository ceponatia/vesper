import { z } from "zod";
import {
  createCommandEnvelopeSchema,
  createCommandResultSchema,
  createEventEnvelopeSchema,
} from "./envelopes";
import {
  branchSequenceSchema,
  commandIdSchema,
  commitmentIdSchema,
  eventIdSchema,
  relationshipLedgerEntryIdSchema,
  storySecondSchema,
  worldBranchIdSchema,
  worldCharacterIdSchema,
} from "./identity";

/**
 * E5.5 — the social ledger: promises, favors, debts, boundaries, and consent
 * (engine.spec §21.3–21.4, ruling 16). A relationship-ledger entry is a typed,
 * directional, causally-provenanced fact — derived automatically from an event
 * already in the branch's history, or authored explicitly by a privileged
 * command for facts the live mechanics do not yet produce. Trust, attraction,
 * and resentment are READ-time projections over the ledger (§6.4: only
 * material transitions write; reads recompute), never persisted numbers.
 *
 * Consent is ledger-gated and fail-closed (ruling 16): a `consent_covered`
 * action precondition (contracts/simulation/activities.ts) checks the same
 * ledger this file owns for a covering `permission_granted` entry; an
 * uncovered escalation routes through the §19.3 deliberator seam with a
 * deterministic fallback of decline, and the outcome lands back here as a
 * ledger entry either way.
 *
 * Slice 1 (E5.5 slice 1) ships the ledger substrate — derived and authored
 * entries, and the trust/attraction/resentment reads. The consent gate
 * (`consent_covered` precondition wiring), destinationless commitments, and
 * escalation (`attempt_consent_escalation`) are later slices; the
 * `consentScopeKeys` vocabulary below is defined now but unconsumed until
 * then.
 */

export const socialDerivationVersion = "social-v1" as const;

// ---------------------------------------------------------------------------
// Consent scope vocabulary (§21.4) — closed, versioned, registry-as-data
// ---------------------------------------------------------------------------

export const consentScopeKeys = [
  "closeness",
  "kiss",
  "touch_intimate",
  "undress",
  "sex",
] as const;
export const consentScopeKeySchema = z.enum(consentScopeKeys);
export type ConsentScopeKey = z.infer<typeof consentScopeKeySchema>;
export const consentScopeRegistryVersion = "consent-scope-v1" as const;

// ---------------------------------------------------------------------------
// Relationship ledger entry (§21.3) — closed kind vocabulary, discriminated payload
// ---------------------------------------------------------------------------

export const relationshipLedgerKinds = [
  "promise_made",
  "promise_accepted",
  "promise_kept",
  "promise_missed",
  "promise_repaired",
  "boundary_stated",
  "boundary_respected",
  "boundary_violated",
  "permission_granted",
  "permission_withdrawn",
  "consent_declined",
  "warning_given",
  "invitation_extended",
  "apology_offered",
  "confidence_shared",
  "help_given",
  "neglect_shown",
  "betrayal",
  "affection_shown",
  "conflict",
  "shared_scene",
  "authored_prior",
  "relationship_change_recorded",
] as const;
export const relationshipLedgerKindSchema = z.enum(relationshipLedgerKinds);
export type RelationshipLedgerKind = z.infer<typeof relationshipLedgerKindSchema>;

export const relationshipLedgerProvenances = ["derived", "authored"] as const;
export const relationshipLedgerProvenanceSchema = z.enum(relationshipLedgerProvenances);
export type RelationshipLedgerProvenance = z.infer<typeof relationshipLedgerProvenanceSchema>;

/** The 7 authored-only kinds `record_relationship_entry` may write (§7.5). */
export const authoredRelationshipLedgerKinds = [
  "boundary_violated",
  "help_given",
  "neglect_shown",
  "betrayal",
  "affection_shown",
  "conflict",
  "authored_prior",
] as const;
export const authoredRelationshipLedgerKindSchema = z.enum(authoredRelationshipLedgerKinds);
export type AuthoredRelationshipLedgerKind = z.infer<typeof authoredRelationshipLedgerKindSchema>;

/**
 * Most entries carry no extra structure — `detail` (a free narrative string) is
 * a top-level optional field shared by every kind. Four kinds need a typed
 * reference: consent-scoped entries, promise-linked entries, and the
 * relationship-change marker. A discriminated union keeps `payload.kind`
 * mechanically tied to `entry.kind` — see `relationshipLedgerKindPayloadKind`
 * below, checked by a `.refine()` on the entry schema (never a free string).
 */
export const relationshipLedgerPayloadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z.object({ kind: z.literal("consent"), scopeKey: consentScopeKeySchema }).strict(),
  z.object({ kind: z.literal("commitment"), commitmentId: commitmentIdSchema }).strict(),
  z.object({ kind: z.literal("change"), changeKey: z.string().trim().min(1).max(128) }).strict(),
]);
export type RelationshipLedgerPayload = z.infer<typeof relationshipLedgerPayloadSchema>;

/**
 * Which payload variant a given ledger kind MUST carry — the fold and every
 * writer share this table so `kind`/`payload.kind` can never drift apart.
 *
 * `promise_made`/`promise_accepted` map to `"none"`, NOT `"commitment"` —
 * a deviation from the blueprint's literal table, found and fixed here.
 * Both kinds are sourced ONLY from a spoken `promise_offered`/
 * `promise_accepted` speech act (§4.2's speech-act mapping); a speech act
 * carries no `commitmentId` — a real `Commitment` row is created (or not)
 * by a wholly separate `create_commitment` command, and nothing links the
 * two. Only `promise_kept`/`promise_missed`/`promise_repaired` (Slice 2's
 * commitment-event arms, which resolve a real commitment row via
 * `commitmentById`) legitimately carry a `commitmentId`. The blueprint's
 * "Four kinds need a typed reference" doc comment groups all five
 * promise-related kinds together without this distinction.
 */
export const relationshipLedgerKindPayloadKind: Record<RelationshipLedgerKind, RelationshipLedgerPayload["kind"]> = {
  promise_made: "none",
  promise_accepted: "none",
  promise_kept: "commitment",
  promise_missed: "commitment",
  promise_repaired: "commitment",
  boundary_stated: "consent",
  boundary_respected: "consent",
  boundary_violated: "consent",
  permission_granted: "consent",
  permission_withdrawn: "consent",
  consent_declined: "consent",
  warning_given: "none",
  invitation_extended: "none",
  apology_offered: "none",
  confidence_shared: "none",
  help_given: "none",
  neglect_shown: "none",
  betrayal: "none",
  affection_shown: "none",
  conflict: "none",
  shared_scene: "none",
  authored_prior: "none",
  relationship_change_recorded: "change",
};

export const relationshipLedgerEntrySchema = z
  .object({
    id: relationshipLedgerEntryIdSchema,
    branchId: worldBranchIdSchema,
    kind: relationshipLedgerKindSchema,
    fromActorId: worldCharacterIdSchema,
    toActorId: worldCharacterIdSchema,
    provenance: relationshipLedgerProvenanceSchema,
    payload: relationshipLedgerPayloadSchema,
    detail: z.string().trim().min(1).max(500).optional(),
    sourceEventId: eventIdSchema,
    sequence: branchSequenceSchema,
    storySecond: storySecondSchema,
    derivationVersion: z.literal(socialDerivationVersion),
  })
  .strict()
  .refine((entry) => entry.fromActorId !== entry.toActorId, {
    message: "A relationship ledger entry needs two distinct actors",
    path: ["toActorId"],
  })
  .refine((entry) => entry.payload.kind === relationshipLedgerKindPayloadKind[entry.kind], {
    message: "Ledger payload variant does not match its entry kind",
    path: ["payload"],
  });
export type RelationshipLedgerEntry = z.infer<typeof relationshipLedgerEntrySchema>;

// ---------------------------------------------------------------------------
// Trust/attraction/resentment read (§21.3) — derived, signed, banded, decayed
// ---------------------------------------------------------------------------

export const relationshipAxisKeys = ["trust", "attraction", "resentment"] as const;
export const relationshipAxisKeySchema = z.enum(relationshipAxisKeys);
export type RelationshipAxisKey = z.infer<typeof relationshipAxisKeySchema>;

/** Fixed-point per-kind contribution to each axis; `authored_prior` is the one
 * kind excluded — its command supplies an explicit override instead (§7.5). */
export interface RelationshipLedgerWeight {
  trustFixedPoint: number;
  attractionFixedPoint: number;
  resentmentFixedPoint: number;
}
export const relationshipLedgerWeightRegistryVersion = "relationship-weight-v1" as const;
export const relationshipLedgerWeightRegistryV1: Readonly<
  Record<Exclude<RelationshipLedgerKind, "authored_prior" | "relationship_change_recorded">, RelationshipLedgerWeight>
> = {
  promise_made: { trustFixedPoint: 200, attractionFixedPoint: 0, resentmentFixedPoint: 0 },
  promise_accepted: { trustFixedPoint: 100, attractionFixedPoint: 0, resentmentFixedPoint: 0 },
  promise_kept: { trustFixedPoint: 1_500, attractionFixedPoint: 0, resentmentFixedPoint: 0 },
  promise_missed: { trustFixedPoint: -2_000, attractionFixedPoint: 0, resentmentFixedPoint: 200 },
  promise_repaired: { trustFixedPoint: 800, attractionFixedPoint: 0, resentmentFixedPoint: -300 },
  boundary_stated: { trustFixedPoint: 0, attractionFixedPoint: 0, resentmentFixedPoint: 0 },
  boundary_respected: { trustFixedPoint: 600, attractionFixedPoint: 0, resentmentFixedPoint: 0 },
  boundary_violated: { trustFixedPoint: -3_000, attractionFixedPoint: 0, resentmentFixedPoint: 3_000 },
  permission_granted: { trustFixedPoint: 200, attractionFixedPoint: 300, resentmentFixedPoint: 0 },
  permission_withdrawn: { trustFixedPoint: 0, attractionFixedPoint: 0, resentmentFixedPoint: 0 },
  consent_declined: { trustFixedPoint: 0, attractionFixedPoint: 0, resentmentFixedPoint: 100 },
  warning_given: { trustFixedPoint: 150, attractionFixedPoint: 0, resentmentFixedPoint: 0 },
  invitation_extended: { trustFixedPoint: 0, attractionFixedPoint: 150, resentmentFixedPoint: 0 },
  apology_offered: { trustFixedPoint: 300, attractionFixedPoint: 0, resentmentFixedPoint: -500 },
  confidence_shared: { trustFixedPoint: 250, attractionFixedPoint: 100, resentmentFixedPoint: 0 },
  help_given: { trustFixedPoint: 400, attractionFixedPoint: 0, resentmentFixedPoint: 0 },
  neglect_shown: { trustFixedPoint: -400, attractionFixedPoint: 0, resentmentFixedPoint: 600 },
  betrayal: { trustFixedPoint: -3_000, attractionFixedPoint: 0, resentmentFixedPoint: 2_500 },
  affection_shown: { trustFixedPoint: 0, attractionFixedPoint: 500, resentmentFixedPoint: 0 },
  conflict: { trustFixedPoint: 0, attractionFixedPoint: 0, resentmentFixedPoint: 800 },
  shared_scene: { trustFixedPoint: 50, attractionFixedPoint: 50, resentmentFixedPoint: 0 },
};

/** Per-axis analytic half-life in story seconds — resentment fades fastest,
 * trust slowest; all tunable, all documented (engine.spec §6.4). */
export const RELATIONSHIP_AXIS_HALF_LIFE_SECONDS: Record<RelationshipAxisKey, number> = {
  trust: 2_592_000, // 30 days
  attraction: 864_000, // 10 days
  resentment: 518_400, // 6 days
};

export const trustBandKeys = ["distrustful", "wary", "neutral", "trusting", "devoted"] as const;
export const attractionBandKeys = ["averse", "indifferent", "interested", "drawn", "smitten"] as const;
export const resentmentBandKeys = ["none", "mild", "simmering", "seething", "hostile"] as const;
export const trustBandSchema = z.enum(trustBandKeys);
export const attractionBandSchema = z.enum(attractionBandKeys);
export const resentmentBandSchema = z.enum(resentmentBandKeys);

export const relationshipReadSchema = z
  .object({
    subjectActorId: worldCharacterIdSchema,
    aboutActorId: worldCharacterIdSchema,
    evaluatedAtStorySecond: storySecondSchema,
    trustFixedPoint: z.number().int(),
    attractionFixedPoint: z.number().int(),
    resentmentFixedPoint: z.number().int(),
    trustBand: trustBandSchema,
    attractionBand: attractionBandSchema,
    resentmentBand: resentmentBandSchema,
    entryCount: z.number().int().nonnegative(),
    /** Non-fatal read-time degradations (e.g. an `authored_prior` entry with no
     * matching `authoredPriorWeights` override) — reuses the SAME shape as
     * `DeliberationOutcome.diagnostics` (`contracts/simulation/deliberation.ts`),
     * never a thrown error (§4.3, added on review — resilience.md: degraded
     * defaults must be visible, not silent). */
    diagnostics: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type RelationshipRead = z.infer<typeof relationshipReadSchema>;

// ---------------------------------------------------------------------------
// Commands (§7) — Slice 1: authored entries and relationship-change marking.
// `attempt_consent_escalation` (§7.6) ships in Slice 3.
// ---------------------------------------------------------------------------

const recordRelationshipEntryPayloadSchema = z
  .object({
    fromActorId: worldCharacterIdSchema,
    toActorId: worldCharacterIdSchema,
    kind: authoredRelationshipLedgerKindSchema,
    detail: z.string().trim().min(1).max(500),
    storySecond: storySecondSchema.optional(), // `authored_prior` only — see §7.5
    weightOverride: z
      .object({
        trustFixedPoint: z.number().int(),
        attractionFixedPoint: z.number().int(),
        resentmentFixedPoint: z.number().int(),
      })
      .strict()
      .optional(), // `authored_prior` only — see §7.5
    /** `boundary_violated` only — that kind's declared payload variant is
     * `"consent"` (`relationshipLedgerKindPayloadKind`), which needs a scope;
     * a discovered amendment (mirrors narrative.ts's `consentScopeKey` on
     * consent-scoped speech acts) — the original draft omitted this, which
     * would have made `boundary_violated` unauthorable despite §21.4 naming
     * it authored-backfill-only, never live. */
    scopeKey: consentScopeKeySchema.optional(),
  })
  .strict()
  .refine((p) => p.fromActorId !== p.toActorId, { message: "Two distinct actors required", path: ["toActorId"] })
  .refine((p) => p.kind === "authored_prior" || p.storySecond === undefined, {
    message: "storySecond override is only legal for authored_prior",
    path: ["storySecond"],
  })
  .refine((p) => p.kind === "authored_prior" || p.weightOverride === undefined, {
    message: "weightOverride is only legal for authored_prior",
    path: ["weightOverride"],
  })
  .refine((p) => p.kind === "boundary_violated" || p.scopeKey === undefined, {
    message: "scopeKey is only legal for boundary_violated",
    path: ["scopeKey"],
  })
  .refine((p) => p.kind !== "boundary_violated" || p.scopeKey !== undefined, {
    message: "boundary_violated requires a scopeKey",
    path: ["scopeKey"],
  });

export const recordRelationshipEntryCommandSchema = createCommandEnvelopeSchema(
  "record_relationship_entry",
  1,
  recordRelationshipEntryPayloadSchema,
);
export const recordRelationshipEntryRejectionCodes = [
  "invalid_command",
  "duplicate_command_id",
  "branch_mismatch",
  "unauthorized_principal",
  "actor_not_found",
] as const;
export const recordRelationshipEntryRejectionCodeSchema = z.enum(recordRelationshipEntryRejectionCodes);
export const recordRelationshipEntryCommandResultSchema = createCommandResultSchema(
  recordRelationshipEntryRejectionCodeSchema,
);

const recordRelationshipChangePayloadSchema = z
  .object({
    fromActorId: worldCharacterIdSchema,
    toActorId: worldCharacterIdSchema,
    changeKey: z.string().trim().min(1).max(128),
    detail: z.string().trim().min(1).max(500),
  })
  .strict()
  .refine((p) => p.fromActorId !== p.toActorId, { message: "Two distinct actors required", path: ["toActorId"] });

export const recordRelationshipChangeCommandSchema = createCommandEnvelopeSchema(
  "record_relationship_change",
  1,
  recordRelationshipChangePayloadSchema,
);
export const recordRelationshipChangeRejectionCodes = [
  "invalid_command",
  "duplicate_command_id",
  "branch_mismatch",
  "unauthorized_principal",
  "actor_not_found",
] as const;
export const recordRelationshipChangeRejectionCodeSchema = z.enum(recordRelationshipChangeRejectionCodes);
export const recordRelationshipChangeCommandResultSchema = createCommandResultSchema(
  recordRelationshipChangeRejectionCodeSchema,
);

// ---------------------------------------------------------------------------
// Events (§9.2) — Slice 1: `relationship_entry_authored` and
// `relationship_change_recorded`. `consent_escalation_resolved` ships in
// Slice 3 alongside `attempt_consent_escalation`.
// ---------------------------------------------------------------------------

// Exported (not file-local like the other payload schemas above) — a future
// slice's store-layer query needs to narrow a raw jsonb column to this shape
// when extracting `weightOverride` for `authored_prior` reads.
export const relationshipEntryAuthoredPayloadSchema = z
  .object({
    fromActorId: worldCharacterIdSchema,
    toActorId: worldCharacterIdSchema,
    kind: authoredRelationshipLedgerKindSchema,
    detail: z.string().trim().min(1).max(500),
    entryStorySecond: storySecondSchema, // captured §6.4 value — may predate this event
    weightOverride: z
      .object({ trustFixedPoint: z.number().int(), attractionFixedPoint: z.number().int(), resentmentFixedPoint: z.number().int() })
      .strict()
      .optional(),
    /** `boundary_violated` only — mirrors the command payload's `scopeKey`
     * (see `recordRelationshipEntryPayloadSchema`'s doc comment). */
    scopeKey: consentScopeKeySchema.optional(),
  })
  .strict()
  .refine((p) => p.kind === "boundary_violated" || p.scopeKey === undefined, {
    message: "scopeKey is only legal for boundary_violated",
    path: ["scopeKey"],
  })
  .refine((p) => p.kind !== "boundary_violated" || p.scopeKey !== undefined, {
    message: "boundary_violated requires a scopeKey",
    path: ["scopeKey"],
  });
export type RelationshipEntryAuthoredPayload = z.infer<typeof relationshipEntryAuthoredPayloadSchema>;

export const relationshipEntryAuthoredEventSchema = createEventEnvelopeSchema(
  "relationship_entry_authored",
  1,
  relationshipEntryAuthoredPayloadSchema,
).extend({ commandId: commandIdSchema });

const relationshipChangeRecordedPayloadSchema = z
  .object({
    fromActorId: worldCharacterIdSchema,
    toActorId: worldCharacterIdSchema,
    changeKey: z.string().trim().min(1).max(128),
    detail: z.string().trim().min(1).max(500),
  })
  .strict();

export const relationshipChangeRecordedEventSchema = createEventEnvelopeSchema(
  "relationship_change_recorded",
  1,
  relationshipChangeRecordedPayloadSchema,
).extend({ commandId: commandIdSchema });

// --- Types --------------------------------------------------------------------

export type RecordRelationshipEntryCommand = z.infer<typeof recordRelationshipEntryCommandSchema>;
export type RecordRelationshipEntryRejectionCode = z.infer<typeof recordRelationshipEntryRejectionCodeSchema>;
export type RecordRelationshipEntryCommandResult = z.infer<typeof recordRelationshipEntryCommandResultSchema>;
export type RecordRelationshipChangeCommand = z.infer<typeof recordRelationshipChangeCommandSchema>;
export type RecordRelationshipChangeRejectionCode = z.infer<typeof recordRelationshipChangeRejectionCodeSchema>;
export type RecordRelationshipChangeCommandResult = z.infer<typeof recordRelationshipChangeCommandResultSchema>;
export type RelationshipEntryAuthoredEvent = z.infer<typeof relationshipEntryAuthoredEventSchema>;
export type RelationshipChangeRecordedEvent = z.infer<typeof relationshipChangeRecordedEventSchema>;
