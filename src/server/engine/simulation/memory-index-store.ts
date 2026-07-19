import { and, asc, count, eq, gt, inArray, sql } from "drizzle-orm";
import type { z } from "zod";
import type { SimulationBranchEvent } from "@/contracts/simulation/branching";
import { composeSimulationId, worldBranchIdSchema } from "@/contracts/simulation/identity";
import {
  authoredLoreSeedSchema,
  MEMORY_DOCUMENT_SCHEMA_VERSION,
  MEMORY_INDEX_CONSUMER_KIND,
  memoryDocumentSchema,
  memoryIndexOutboxPayloadSchema,
  type MemoryDocument,
} from "@/contracts/simulation/memory";
import { observationSchema, type Observation } from "@/contracts/simulation/perception";
import {
  projectAssertionDocument,
  projectAuthoredLoreDocument,
  projectBeliefDocument,
  projectObservationDocument,
  projectSoftCanonDocument,
  projectSpeechActDocument,
} from "@/lib/simulation/memory";
import {
  db,
  simAssertions,
  simBeliefs,
  simBranches,
  simConsumerCheckpoints,
  simEvents,
  simMemoryDocuments,
  simObservations,
  simOutbox,
  simSoftCanon,
  type Db,
} from "@/server/db";
import { assertionFromRow, beliefFromRow } from "./knowledge-recorder";
import { branchEventFromRow } from "./observation-store";
import {
  claimNextOutboxObligation,
  releaseFailedOutboxObligation,
} from "./outbox-store";
import { softCanonEntryFromRow } from "./soft-canon-recorder";
import type { SimTx } from "./trigger-projector";

/**
 * E4.4 — outbox-driven memory indexing (engine.spec §24.3). Every accepted
 * command enqueues one obligation per indexable event AFTER authoritative
 * commit; a consumer later projects redacted documents from the persisted
 * source rows. Indexing failure retries through the outbox and shows up as
 * lag — world simulation never waits, and a missing document only NARROWS
 * recall, never widens it.
 */

const defaultLeaseSeconds = 30;
const defaultMaxAttempts = 8;

const knowledgeLaneEventTypes = [
  "disclosure_made",
  "speech_act_delivered",
  "soft_canon_recorded",
  "soft_canon_promoted",
  "soft_canon_demoted",
] as const;

/** The injected embedding seam — a stub in every test, zero live calls shipped. */
export type MemoryEmbedder = (
  texts: readonly string[],
) => Promise<{ model: string; vectors: number[][] }>;

/**
 * The §11.1 shell hook (also called by the pre-shell space and item-transfer
 * stores): enqueue one memory-index obligation per appended event that is
 * knowledge-lane or produced at least one observation. Runs inside the
 * command transaction so obligations are exactly-once with the events.
 */
export async function enqueueMemoryIndexObligations(
  tx: SimTx,
  branch: { id: string; worldId: string; headSequence: number },
): Promise<number> {
  const eventRows = await tx
    .select({ id: simEvents.id, type: simEvents.type, sequence: simEvents.sequence })
    .from(simEvents)
    .where(and(eq(simEvents.branchId, branch.id), gt(simEvents.sequence, branch.headSequence)))
    .orderBy(asc(simEvents.sequence));
  if (eventRows.length === 0) return 0;

  const observedRows = await tx
    .select({ sourceEventId: simObservations.sourceEventId })
    .from(simObservations)
    .where(
      and(
        eq(simObservations.branchId, branch.id),
        inArray(
          simObservations.sourceEventId,
          eventRows.map((row) => row.id),
        ),
      ),
    );
  const observedEventIds = new Set(observedRows.map((row) => row.sourceEventId));

  const indexable = eventRows.filter(
    (row) =>
      (knowledgeLaneEventTypes as readonly string[]).includes(row.type) || observedEventIds.has(row.id),
  );
  if (indexable.length === 0) return 0;
  await tx
    .insert(simOutbox)
    .values(
      indexable.map((row) => ({
        id: composeSimulationId("outbox", [MEMORY_INDEX_CONSUMER_KIND, row.id]),
        worldId: branch.worldId,
        branchId: branch.id,
        sourceEventId: row.id,
        firstSequence: row.sequence,
        lastSequence: row.sequence,
        consumerKind: MEMORY_INDEX_CONSUMER_KIND,
        schemaVersion: MEMORY_DOCUMENT_SCHEMA_VERSION,
        payload: { sourceEventId: row.id },
      })),
    )
    .onConflictDoNothing();
  return indexable.length;
}

// ---------------------------------------------------------------------------
// Document persistence
// ---------------------------------------------------------------------------

export function memoryDocumentFromRow(row: typeof simMemoryDocuments.$inferSelect): MemoryDocument {
  return memoryDocumentSchema.parse({
    id: row.docId,
    branchId: row.branchId,
    sourceKind: row.sourceKind,
    sourceId: row.sourceId,
    ...(row.sourceEventId === null ? {} : { sourceEventId: row.sourceEventId }),
    firstSequence: row.firstSequence,
    lastSequence: row.lastSequence,
    storySecond: row.storySecond,
    visibility: row.visibility,
    eligibleActorIds: row.eligibleActorIds,
    aboutEntityIds: row.aboutEntityIds,
    validFromSecond: row.validFromSecond,
    ...(row.validUntilSecond === null ? {} : { validUntilSecond: row.validUntilSecond }),
    ...(row.supersededAtSecond === null ? {} : { supersededAtSecond: row.supersededAtSecond }),
    epistemicLabel: row.epistemicLabel,
    ...(row.confidenceFixedPoint === null ? {} : { confidenceFixedPoint: row.confidenceFixedPoint }),
    text: row.text,
    ...(row.embeddingModel === null ? {} : { embeddingModel: row.embeddingModel }),
    docSchemaVersion: row.docSchemaVersion,
  });
}

function documentRowInsert(
  document: MemoryDocument,
  updatedSequence: number,
  embedding: number[] | null,
): typeof simMemoryDocuments.$inferInsert {
  return {
    branchId: document.branchId,
    docId: document.id,
    sourceKind: document.sourceKind,
    sourceId: document.sourceId,
    sourceEventId: document.sourceEventId ?? null,
    firstSequence: document.firstSequence,
    lastSequence: document.lastSequence,
    storySecond: document.storySecond,
    visibility: document.visibility,
    eligibleActorIds: [...document.eligibleActorIds],
    aboutEntityIds: [...document.aboutEntityIds],
    validFromSecond: document.validFromSecond,
    validUntilSecond: document.validUntilSecond ?? null,
    supersededAtSecond: document.supersededAtSecond ?? null,
    epistemicLabel: document.epistemicLabel,
    confidenceFixedPoint: document.confidenceFixedPoint ?? null,
    text: document.text,
    embedding,
    embeddingModel: document.embeddingModel ?? null,
    docSchemaVersion: document.docSchemaVersion,
    updatedSequence,
  };
}

async function upsertDocuments(
  tx: Db | SimTx,
  rows: readonly (typeof simMemoryDocuments.$inferInsert)[],
): Promise<void> {
  for (const row of rows) {
    await tx
      .insert(simMemoryDocuments)
      .values(row)
      .onConflictDoUpdate({
        target: [simMemoryDocuments.branchId, simMemoryDocuments.docId],
        set: {
          visibility: row.visibility,
          eligibleActorIds: row.eligibleActorIds,
          aboutEntityIds: row.aboutEntityIds,
          validFromSecond: row.validFromSecond,
          validUntilSecond: row.validUntilSecond,
          supersededAtSecond: row.supersededAtSecond,
          epistemicLabel: row.epistemicLabel,
          confidenceFixedPoint: row.confidenceFixedPoint,
          text: row.text,
          ...(row.embedding === null ? {} : { embedding: row.embedding, embeddingModel: row.embeddingModel }),
          docSchemaVersion: row.docSchemaVersion,
          updatedSequence: row.updatedSequence,
        },
      });
  }
}

function observationFromRow(row: typeof simObservations.$inferSelect): Observation {
  return observationSchema.parse({
    id: row.observationId,
    branchId: row.branchId,
    sourceEventId: row.sourceEventId,
    sourceEventSequence: row.sourceEventSequence,
    witnessActorId: row.witnessActorId,
    storySecond: row.storySecond,
    channel: row.channel,
    evidenceClass: row.evidenceClass,
    confidenceFixedPoint: row.confidenceFixedPoint,
    detailTier: row.detailTier,
    derivationVersion: row.derivationVersion,
  });
}

/** Project every document one committed event justifies, from persisted rows. */
async function projectEventDocuments(
  tx: SimTx,
  branchId: string,
  event: SimulationBranchEvent,
): Promise<MemoryDocument[]> {
  const documents: MemoryDocument[] = [];

  const observationRows = await tx
    .select()
    .from(simObservations)
    .where(and(eq(simObservations.branchId, branchId), eq(simObservations.sourceEventId, event.id)))
    .orderBy(asc(simObservations.observationId));
  for (const row of observationRows) {
    documents.push(projectObservationDocument(observationFromRow(row), event));
  }

  if (event.type === "speech_act_delivered") {
    documents.push(projectSpeechActDocument(event));
  } else if (event.type === "disclosure_made") {
    // Re-project every knowledge row this event touched — including older
    // rows it superseded, whose documents pick up their supersedence here.
    const assertionRows = await tx
      .select()
      .from(simAssertions)
      .where(and(eq(simAssertions.branchId, branchId), eq(simAssertions.updatedSequence, event.sequence)))
      .orderBy(asc(simAssertions.assertionId));
    const beliefRows = await tx
      .select()
      .from(simBeliefs)
      .where(and(eq(simBeliefs.branchId, branchId), eq(simBeliefs.updatedSequence, event.sequence)))
      .orderBy(asc(simBeliefs.beliefId));
    const beliefs = beliefRows.map(beliefFromRow);
    const assertions = assertionRows.map(assertionFromRow);
    const neededAssertionIds = new Set([
      ...beliefs.map((belief) => belief.assertionId),
      ...assertions.map((assertion) => assertion.id),
    ]);
    const missingIds = [...neededAssertionIds].filter(
      (id) => !assertions.some((assertion) => assertion.id === id),
    );
    if (missingIds.length > 0) {
      const extraRows = await tx
        .select()
        .from(simAssertions)
        .where(and(eq(simAssertions.branchId, branchId), inArray(simAssertions.assertionId, missingIds)))
        .orderBy(asc(simAssertions.assertionId));
      assertions.push(...extraRows.map(assertionFromRow));
    }
    const assertionById = new Map(assertions.map((assertion) => [assertion.id, assertion]));
    for (const assertion of assertions) documents.push(projectAssertionDocument(assertion));
    for (const belief of beliefs) {
      const assertion = assertionById.get(belief.assertionId);
      if (assertion) documents.push(projectBeliefDocument(belief, assertion));
    }
  } else if (
    event.type === "soft_canon_recorded" ||
    event.type === "soft_canon_promoted" ||
    event.type === "soft_canon_demoted"
  ) {
    const entry =
      event.type === "soft_canon_recorded" ? event.payload.derived.entry : event.payload.entry;
    documents.push(projectSoftCanonDocument(entry, event.sequence));
  }

  return documents;
}

async function embedDocuments(
  documents: readonly MemoryDocument[],
  embed: MemoryEmbedder | undefined,
): Promise<Map<string, { model: string; vector: number[] }>> {
  const embeddings = new Map<string, { model: string; vector: number[] }>();
  if (!embed || documents.length === 0) return embeddings;
  try {
    const { model, vectors } = await embed(documents.map((document) => document.text));
    documents.forEach((document, index) => {
      const vector = vectors[index];
      if (vector) embeddings.set(document.id, { model, vector });
    });
  } catch {
    // §24.3 degradation: the documents still index for lexical recall; only
    // vector ranking quality degrades, and the query layer reports it.
  }
  return embeddings;
}

// ---------------------------------------------------------------------------
// The consumer
// ---------------------------------------------------------------------------

export interface ConsumeMemoryIndexOptions {
  database?: Db;
  workerId: string;
  now?: Date;
  leaseSeconds?: number;
  maxAttempts?: number;
  embed?: MemoryEmbedder;
}

export type ConsumeMemoryIndexResult =
  | { status: "idle" }
  | { status: "completed"; outboxId: string; branchId: string; documentCount: number }
  | { status: "failed"; outboxId: string; retryAt: Date | null; terminal: boolean }
  | { status: "lease_lost"; outboxId: string };

/** Claim and fulfil at most one memory-index obligation (§24.3). */
export async function consumeNextMemoryIndexOutbox(
  options: ConsumeMemoryIndexOptions,
): Promise<ConsumeMemoryIndexResult> {
  const database = options.database ?? db();
  const workerId = options.workerId.trim();
  if (!workerId) throw new Error("Outbox worker ID is required");
  const leaseSeconds = options.leaseSeconds ?? defaultLeaseSeconds;
  const maxAttempts = options.maxAttempts ?? defaultMaxAttempts;
  const now = options.now ? new Date(options.now) : new Date();
  if (Number.isNaN(now.getTime())) throw new RangeError("Outbox clock is invalid");

  const claim = await claimNextOutboxObligation(
    database,
    MEMORY_INDEX_CONSUMER_KIND,
    workerId,
    now,
    leaseSeconds,
    maxAttempts,
  );
  if (!claim) return { status: "idle" };
  if (claim.kind === "quarantined") {
    return { status: "failed", outboxId: claim.outboxId, retryAt: null, terminal: true };
  }
  const claimed = claim.claimed;

  try {
    const completed = await database.transaction(async (tx) => {
      const [work] = await tx.select().from(simOutbox).where(eq(simOutbox.id, claimed.id)).limit(1).for("update");
      if (!work || work.state !== "processing" || work.leaseOwner !== workerId) return undefined;
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`${MEMORY_INDEX_CONSUMER_KIND}:${work.branchId}`}))`,
      );
      const payload = memoryIndexOutboxPayloadSchema.parse(work.payload);
      if (payload.sourceEventId !== work.sourceEventId) {
        throw new Error("Outbox envelope does not match its indexing contract");
      }

      const [eventRow] = await tx
        .select()
        .from(simEvents)
        .where(and(eq(simEvents.id, work.sourceEventId), eq(simEvents.branchId, work.branchId)))
        .limit(1);
      if (!eventRow) throw new Error("Referenced committed simulation event is missing");
      const event = branchEventFromRow(eventRow);

      const documents = await projectEventDocuments(tx, work.branchId, event);
      const embeddings = await embedDocuments(documents, options.embed);
      const rows = documents.map((document) => {
        const embedded = embeddings.get(document.id);
        const withModel = embedded ? { ...document, embeddingModel: embedded.model } : document;
        return documentRowInsert(
          memoryDocumentSchema.parse(withModel),
          event.sequence,
          embedded?.vector ?? null,
        );
      });
      await upsertDocuments(tx, rows);

      const [checkpoint] = await tx
        .select()
        .from(simConsumerCheckpoints)
        .where(
          and(
            eq(simConsumerCheckpoints.consumerKind, MEMORY_INDEX_CONSUMER_KIND),
            eq(simConsumerCheckpoints.branchId, work.branchId),
          ),
        )
        .limit(1)
        .for("update");
      const nextThroughSequence = Math.max(checkpoint?.throughSequence ?? 0, event.sequence);
      await tx
        .insert(simConsumerCheckpoints)
        .values({
          consumerKind: MEMORY_INDEX_CONSUMER_KIND,
          branchId: work.branchId,
          throughSequence: nextThroughSequence,
          projectionSchemaVersion: MEMORY_DOCUMENT_SCHEMA_VERSION,
        })
        .onConflictDoUpdate({
          target: [simConsumerCheckpoints.consumerKind, simConsumerCheckpoints.branchId],
          set: {
            throughSequence: nextThroughSequence,
            projectionSchemaVersion: MEMORY_DOCUMENT_SCHEMA_VERSION,
          },
        });

      await tx
        .update(simOutbox)
        .set({ state: "completed", leaseOwner: null, leaseExpiresAt: null, completedAt: now, lastError: null })
        .where(and(eq(simOutbox.id, work.id), eq(simOutbox.leaseOwner, workerId)));
      return { branchId: work.branchId, documentCount: rows.length };
    });

    return completed
      ? { status: "completed", outboxId: claimed.id, ...completed }
      : { status: "lease_lost", outboxId: claimed.id };
  } catch (error) {
    const failure = await releaseFailedOutboxObligation(database, claimed, workerId, now, maxAttempts, error);
    if (!failure.released) return { status: "lease_lost", outboxId: claimed.id };
    return { status: "failed", outboxId: claimed.id, retryAt: failure.retryAt, terminal: failure.terminal };
  }
}

/** Drain every due obligation for tests and batch catch-up. */
export async function drainMemoryIndexOutbox(
  options: ConsumeMemoryIndexOptions & { maxIterations?: number },
): Promise<{ completed: number; failed: number }> {
  let completed = 0;
  let failed = 0;
  const maxIterations = options.maxIterations ?? 100;
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const result = await consumeNextMemoryIndexOutbox(options);
    if (result.status === "idle") break;
    if (result.status === "completed") completed += 1;
    else failed += 1;
  }
  return { completed, failed };
}

// ---------------------------------------------------------------------------
// Seeded lore, lag diagnostics, rebuild
// ---------------------------------------------------------------------------

/** §24.2 authored lore: seeded documents with explicit visibility. */
export async function seedAuthoredLoreDocuments(
  input: { branchId: string; seeds: readonly z.input<typeof authoredLoreSeedSchema>[] },
  options: { database?: Db | SimTx } = {},
): Promise<number> {
  const database = options.database ?? db();
  const branchId = worldBranchIdSchema.parse(input.branchId);
  const rows = input.seeds
    .map((seed) => authoredLoreSeedSchema.parse(seed))
    .map((seed) => documentRowInsert(projectAuthoredLoreDocument(branchId, seed), 0, null));
  if (rows.length === 0) return 0;
  await upsertDocuments(database, rows);
  return rows.length;
}

export interface MemoryIndexLag {
  headSequence: number;
  indexedThroughSequence: number;
  pendingObligations: number;
  failedObligations: number;
}

/** §24.3: recall degradation must be visible, never inferred. */
export async function memoryIndexLag(
  branchId: string,
  options: { database?: Db | SimTx } = {},
): Promise<MemoryIndexLag> {
  const database = options.database ?? db();
  const [branch] = await database
    .select({ headSequence: simBranches.headSequence, forkSequence: simBranches.forkSequence })
    .from(simBranches)
    .where(eq(simBranches.id, branchId))
    .limit(1);
  if (!branch) throw new Error("Simulation branch not found");
  const [checkpoint] = await database
    .select({ throughSequence: simConsumerCheckpoints.throughSequence })
    .from(simConsumerCheckpoints)
    .where(
      and(
        eq(simConsumerCheckpoints.consumerKind, MEMORY_INDEX_CONSUMER_KIND),
        eq(simConsumerCheckpoints.branchId, branchId),
      ),
    )
    .limit(1);
  const [pending] = await database
    .select({ value: count() })
    .from(simOutbox)
    .where(
      and(
        eq(simOutbox.consumerKind, MEMORY_INDEX_CONSUMER_KIND),
        eq(simOutbox.branchId, branchId),
        inArray(simOutbox.state, ["pending", "processing"]),
      ),
    );
  const [failed] = await database
    .select({ value: count() })
    .from(simOutbox)
    .where(
      and(
        eq(simOutbox.consumerKind, MEMORY_INDEX_CONSUMER_KIND),
        eq(simOutbox.branchId, branchId),
        eq(simOutbox.state, "failed"),
      ),
    );
  return {
    headSequence: branch.headSequence,
    indexedThroughSequence: checkpoint?.throughSequence ?? branch.forkSequence ?? 0,
    pendingObligations: pending?.value ?? 0,
    failedObligations: failed?.value ?? 0,
  };
}

/** Rebuild one branch's event-derived documents; seeded lore is preserved. */
export async function rebuildMemoryIndex(
  rawBranchId: string,
  options: { database?: Db; embed?: MemoryEmbedder } = {},
): Promise<{ branchId: string; documentCount: number; throughSequence: number }> {
  const branchId = worldBranchIdSchema.parse(rawBranchId);
  const database = options.database ?? db();
  return database.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`${MEMORY_INDEX_CONSUMER_KIND}:${branchId}`}))`,
    );
    const [branch] = await tx
      .select({ forkSequence: simBranches.forkSequence })
      .from(simBranches)
      .where(eq(simBranches.id, branchId))
      .limit(1);
    if (!branch) throw new Error("Simulation branch not found");
    await tx
      .delete(simMemoryDocuments)
      .where(
        and(
          eq(simMemoryDocuments.branchId, branchId),
          inArray(simMemoryDocuments.sourceKind, [
            "observation",
            "assertion",
            "belief",
            "speech_act",
            "soft_canon",
          ]),
        ),
      );
    await tx
      .delete(simConsumerCheckpoints)
      .where(
        and(
          eq(simConsumerCheckpoints.consumerKind, MEMORY_INDEX_CONSUMER_KIND),
          eq(simConsumerCheckpoints.branchId, branchId),
        ),
      );

    const eventRows = await tx
      .select()
      .from(simEvents)
      .where(eq(simEvents.branchId, branchId))
      .orderBy(asc(simEvents.sequence));
    let documentCount = 0;
    let throughSequence = branch.forkSequence ?? 0;
    for (const eventRow of eventRows) {
      const event = branchEventFromRow(eventRow);
      const documents = await projectEventDocuments(tx, branchId, event);
      const embeddings = await embedDocuments(documents, options.embed);
      const rows = documents.map((document) => {
        const embedded = embeddings.get(document.id);
        const withModel = embedded ? { ...document, embeddingModel: embedded.model } : document;
        return documentRowInsert(
          memoryDocumentSchema.parse(withModel),
          event.sequence,
          embedded?.vector ?? null,
        );
      });
      await upsertDocuments(tx, rows);
      documentCount += rows.length;
      throughSequence = Math.max(throughSequence, event.sequence);
    }

    // Snapshot-derived ledgers may hold rows whose latest state predates the
    // replayed window (fork children); re-project them from their tables.
    const softCanonRows = await tx
      .select()
      .from(simSoftCanon)
      .where(eq(simSoftCanon.branchId, branchId))
      .orderBy(asc(simSoftCanon.entryId));
    for (const row of softCanonRows) {
      const entry = softCanonEntryFromRow(row);
      await upsertDocuments(tx, [
        documentRowInsert(projectSoftCanonDocument(entry, row.updatedSequence), row.updatedSequence, null),
      ]);
    }

    await tx.insert(simConsumerCheckpoints).values({
      consumerKind: MEMORY_INDEX_CONSUMER_KIND,
      branchId,
      throughSequence,
      projectionSchemaVersion: MEMORY_DOCUMENT_SCHEMA_VERSION,
    });
    return { branchId, documentCount, throughSequence };
  });
}
