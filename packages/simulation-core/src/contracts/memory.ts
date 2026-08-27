import { z } from "zod";
import { createStableStringSetSchema } from "./envelopes";
import {
  composeSimulationId,
  eventIdSchema,
  storySecondSchema,
  worldBranchIdSchema,
  worldCharacterIdSchema,
} from "./identity";
import { observationConfidenceSchema } from "./perception";

/**
 * E4.4 — RAG memory documents. A memory document is a REDACTED, indexable
 * representation of something a viewpoint may recall — never an authority
 * record. Every document carries its source id/kind, its branch + sequence
 * interval, its eligibility surface, validity/supersedence intervals, and
 * schema/model versions, so eligibility is always resolved relationally
 * BEFORE any similarity ranking, and similarity can never decide witness,
 * truth, validity, or access.
 */

export const MEMORY_INDEX_CONSUMER_KIND = "memory_index" as const;
export const MEMORY_DOCUMENT_SCHEMA_VERSION = 1 as const;

/** Source classes shipped in E4.4; the enum is the extension point. */
export const memorySourceKinds = [
  "observation",
  "assertion",
  "belief",
  "speech_act",
  "soft_canon",
  "authored_lore",
] as const;
export const memorySourceKindSchema = z.enum(memorySourceKinds);
export type MemorySourceKind = z.infer<typeof memorySourceKindSchema>;

/**
 * How a document decides who may recall it:
 * - `public` — explicit public scope (world records, public lore, world/
 *   location soft canon);
 * - `actors` — a fixed set captured at index time (the observation's witness,
 *   a speech act's participants, a belief's holder);
 * - `belief_holders` — resolved relationally at query time: the viewpoint
 *   must hold a live belief in the source assertion on the query branch.
 */
export const memoryVisibilities = ["public", "actors", "belief_holders"] as const;
export const memoryVisibilitySchema = z.enum(memoryVisibilities);
export type MemoryVisibility = z.infer<typeof memoryVisibilitySchema>;

/** Every result names how the viewpoint knows it. */
export const epistemicLabels = [
  "observed",
  "glimpsed",
  "heard_about",
  "believed",
  "claimed",
  "witnessed_speech",
  "established_detail",
  "authored_lore",
] as const;
export const epistemicLabelSchema = z.enum(epistemicLabels);
export type EpistemicLabel = z.infer<typeof epistemicLabelSchema>;

const eligibleActorIdsSchema = createStableStringSetSchema(
  worldCharacterIdSchema,
  "Memory document eligible actor IDs",
);
const aboutEntityIdsSchema = createStableStringSetSchema(
  z.string().min(1).max(2_048),
  "Memory document subject IDs",
);

export const memoryDocumentSchema = z
  .object({
    id: z.string().min(1).max(2_048),
    branchId: worldBranchIdSchema,
    sourceKind: memorySourceKindSchema,
    /** The persisted source row this document represents — the memory link. */
    sourceId: z.string().min(1).max(2_048),
    /** The committed event that produced the source, when one exists. */
    sourceEventId: eventIdSchema.optional(),
    /** Sequence interval: zero marks a seeded document (authored lore). */
    firstSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    lastSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    storySecond: storySecondSchema,
    visibility: memoryVisibilitySchema,
    /** Non-empty exactly when visibility is `actors`. */
    eligibleActorIds: eligibleActorIdsSchema,
    /** Structured relevance surface: who/what this is about. */
    aboutEntityIds: aboutEntityIdsSchema,
    validFromSecond: storySecondSchema,
    validUntilSecond: storySecondSchema.optional(),
    /** Doc-carried supersedence; live source rows override it relationally. */
    supersededAtSecond: storySecondSchema.optional(),
    epistemicLabel: epistemicLabelSchema,
    confidenceFixedPoint: observationConfidenceSchema.optional(),
    /** Redacted text produced from authorized source data only. */
    text: z.string().min(1).max(4_000),
    /** Set when an embedding exists; ranking never mixes models. */
    embeddingModel: z.string().min(1).max(128).optional(),
    docSchemaVersion: z.literal(MEMORY_DOCUMENT_SCHEMA_VERSION),
  })
  .strict()
  .refine((doc) => doc.lastSequence >= doc.firstSequence, {
    message: "Memory document sequence interval is reversed",
    path: ["lastSequence"],
  })
  .refine((doc) => (doc.visibility === "actors") === (doc.eligibleActorIds.length > 0), {
    message: "Actor visibility requires eligible actors; other modes forbid them",
    path: ["eligibleActorIds"],
  })
  .refine(
    (doc) =>
      doc.validUntilSecond === undefined || doc.validFromSecond <= doc.validUntilSecond,
    { message: "Memory document validity interval is reversed", path: ["validUntilSecond"] },
  );

export type MemoryDocument = z.infer<typeof memoryDocumentSchema>;

/** One document per source row; re-indexing upserts, never duplicates. */
export function deriveMemoryDocumentId(sourceKind: MemorySourceKind, sourceId: string): string {
  return composeSimulationId("memdoc", [sourceKind, sourceId]);
}

export const memoryIndexOutboxPayloadSchema = z
  .object({ sourceEventId: eventIdSchema })
  .strict();

// --- Query contract -------------------------------------------------------------

export const memoryQueryInputSchema = z
  .object({
    branchId: worldBranchIdSchema,
    viewpointActorId: worldCharacterIdSchema,
    /** The story second recall happens at — validity is evaluated here. */
    atStorySecond: storySecondSchema,
    /** Structured filters, applied before ranking. */
    sourceKinds: z.array(memorySourceKindSchema).optional(),
    aboutEntityIds: z.array(z.string().min(1).max(2_048)).max(16).optional(),
    /** Lexical ranking input; ignored when an embedding is supplied. */
    queryText: z.string().trim().min(1).max(2_000).optional(),
    /** Vector ranking input — ranks only documents of the same model. */
    queryEmbedding: z.array(z.number()).length(1_536).optional(),
    queryEmbeddingModel: z.string().min(1).max(128).optional(),
    /** Context budget. */
    limit: z.number().int().min(1).max(64).default(8),
    /** Eligible candidates considered before ranking, newest first. */
    maxCandidates: z.number().int().min(1).max(512).default(256),
  })
  .strict()
  .refine((input) => (input.queryEmbedding === undefined) === (input.queryEmbeddingModel === undefined), {
    message: "Vector queries name their embedding model; lexical queries name neither",
    path: ["queryEmbeddingModel"],
  });

export type MemoryQueryInput = z.infer<typeof memoryQueryInputSchema>;

export const memoryRecallResultSchema = z
  .object({
    docId: z.string().min(1),
    sourceKind: memorySourceKindSchema,
    sourceId: z.string().min(1),
    sourceEventId: eventIdSchema.optional(),
    epistemicLabel: epistemicLabelSchema,
    confidenceFixedPoint: observationConfidenceSchema.optional(),
    text: z.string().min(1),
    storySecond: storySecondSchema,
    /** Deterministic rank score; comparable only within one response. */
    scoreFixedPoint: z.number().int(),
  })
  .strict();

export type MemoryRecallResult = z.infer<typeof memoryRecallResultSchema>;

/** Indexing failure degrades recall visibly, never silently. */
export const memoryRecallDiagnosticsSchema = z
  .object({
    headSequence: z.number().int().nonnegative(),
    indexedThroughSequence: z.number().int().nonnegative(),
    pendingObligations: z.number().int().nonnegative(),
    failedObligations: z.number().int().nonnegative(),
    /** Eligible docs a vector query could not rank for lack of an embedding. */
    unembeddedEligible: z.number().int().nonnegative(),
  })
  .strict();

export const memoryRecallResponseSchema = z
  .object({
    branchId: worldBranchIdSchema,
    viewpointActorId: worldCharacterIdSchema,
    results: z.array(memoryRecallResultSchema),
    diagnostics: memoryRecallDiagnosticsSchema,
  })
  .strict();

export type MemoryRecallResponse = z.infer<typeof memoryRecallResponseSchema>;

// --- Authored lore seed ---------------------------------------------------------

/** Authored lore explicitly available to the viewpoint — seeded, not evented. */
export const authoredLoreSeedSchema = z
  .object({
    /** Stable caller identity for the lore entry (registry id, slug…). */
    loreId: z.string().min(1).max(256),
    text: z.string().min(1).max(4_000),
    visibility: z.enum(["public", "actors"]),
    eligibleActorIds: eligibleActorIdsSchema,
    aboutEntityIds: aboutEntityIdsSchema,
    validFromSecond: storySecondSchema,
    validUntilSecond: storySecondSchema.optional(),
  })
  .strict()
  .refine((seed) => (seed.visibility === "actors") === (seed.eligibleActorIds.length > 0), {
    message: "Actor visibility requires eligible actors; public lore forbids them",
    path: ["eligibleActorIds"],
  });

export type AuthoredLoreSeed = z.infer<typeof authoredLoreSeedSchema>;

export const memoryEmbeddingDimensions = 1_536;
