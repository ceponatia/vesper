import { createHash } from "node:crypto";
import { and, asc, eq, lte, or, sql } from "drizzle-orm";
import { itemTransferredEventSchema } from "@/contracts/simulation/item-transfer";
import {
  itemTransferFeedConsumerKind,
  itemTransferFeedProjectionSchemaVersion,
  itemTransferOutboxPayloadSchema,
  outboxRetryDelaySeconds,
  projectItemTransferredFeedRow,
} from "@/contracts/simulation/outbox";
import { worldBranchIdSchema } from "@/contracts/simulation/identity";
import {
  db,
  simConsumerCheckpoints,
  simEvents,
  simItemTransferFeed,
  simOutbox,
  type Db,
} from "@/server/db";

const defaultLeaseSeconds = 30;
const defaultMaxAttempts = 8;

export type ItemTransferOutboxCrashPoint = "after_projection_write";

export interface ConsumeItemTransferOutboxOptions {
  database?: Db;
  workerId: string;
  now?: Date;
  leaseSeconds?: number;
  maxAttempts?: number;
  crashAt?: ItemTransferOutboxCrashPoint;
}

export type ConsumeItemTransferOutboxResult =
  | { status: "idle" }
  | { status: "completed"; outboxId: string; branchId: string; throughSequence: number }
  | { status: "failed"; outboxId: string; retryAt: Date | null; terminal: boolean }
  | { status: "lease_lost"; outboxId: string };

export interface ItemTransferFeedRebuildResult {
  branchId: string;
  throughSequence: number;
  rowCount: number;
  projectionHash: string;
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${label} must be positive`);
  return value;
}

function safeDiagnostic(error: unknown, claimed: { id: string; branchId: string; sourceEventId: string; firstSequence: number; attempts: number }): string {
  const name = error instanceof Error ? error.name : "UnknownError";
  const message = error instanceof Error ? error.message : "Consumer failed";
  return `outbox=${claimed.id} branch=${claimed.branchId} sequence=${claimed.firstSequence} event=${claimed.sourceEventId} attempt=${claimed.attempts} ${name}: ${message}`.slice(0, 500);
}

function eventFromRow(row: typeof simEvents.$inferSelect) {
  return itemTransferredEventSchema.parse({
    id: row.id,
    worldId: row.worldId,
    branchId: row.branchId,
    sequence: row.sequence,
    storySecond: row.storySecond,
    type: row.type,
    schemaVersion: row.schemaVersion,
    rulesetVersion: row.rulesetVersion,
    derivationVersion: row.derivationVersion,
    commandId: row.commandId,
    causationId: row.causationId,
    correlationId: row.correlationId,
    actorIds: row.actorIds,
    entityIds: row.entityIds,
    locationId: row.locationId,
    recordedAtWallClock: row.recordedAt.toISOString(),
    payload: row.payload,
  });
}

async function claimNext(database: Db, workerId: string, now: Date, leaseSeconds: number) {
  const leaseExpiresAt = new Date(now.getTime() + leaseSeconds * 1000);
  return database.transaction(async (tx) => {
    const [candidate] = await tx
      .select({ id: simOutbox.id })
      .from(simOutbox)
      .where(
        and(
          eq(simOutbox.consumerKind, itemTransferFeedConsumerKind),
          or(
            and(eq(simOutbox.state, "pending"), lte(simOutbox.availableAt, now)),
            and(eq(simOutbox.state, "processing"), sql`${simOutbox.leaseExpiresAt} <= ${now}`),
          ),
        ),
      )
      .orderBy(asc(simOutbox.firstSequence), asc(simOutbox.createdAt))
      .limit(1)
      .for("update", { skipLocked: true });
    if (!candidate) return undefined;

    const [claimed] = await tx
      .update(simOutbox)
      .set({
        state: "processing",
        attempts: sql`${simOutbox.attempts} + 1`,
        leaseOwner: workerId,
        leaseExpiresAt,
        lastError: null,
      })
      .where(eq(simOutbox.id, candidate.id))
      .returning({
        id: simOutbox.id,
        branchId: simOutbox.branchId,
        sourceEventId: simOutbox.sourceEventId,
        firstSequence: simOutbox.firstSequence,
        attempts: simOutbox.attempts,
      });
    return claimed;
  });
}

/** Claim and apply at most one item-transfer delivery obligation. */
export async function consumeNextItemTransferOutbox(
  options: ConsumeItemTransferOutboxOptions,
): Promise<ConsumeItemTransferOutboxResult> {
  const database = options.database ?? db();
  const workerId = options.workerId.trim();
  if (!workerId) throw new Error("Outbox worker ID is required");
  const leaseSeconds = positiveSafeInteger(options.leaseSeconds ?? defaultLeaseSeconds, "Lease seconds");
  const maxAttempts = positiveSafeInteger(options.maxAttempts ?? defaultMaxAttempts, "Max attempts");
  const now = options.now ? new Date(options.now) : new Date();
  if (Number.isNaN(now.getTime())) throw new RangeError("Outbox clock is invalid");

  const claimed = await claimNext(database, workerId, now, leaseSeconds);
  if (!claimed) return { status: "idle" };

  try {
    const completed = await database.transaction(async (tx) => {
      const [work] = await tx.select().from(simOutbox).where(eq(simOutbox.id, claimed.id)).limit(1).for("update");
      if (!work || work.state !== "processing" || work.leaseOwner !== workerId) return undefined;
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`${itemTransferFeedConsumerKind}:${work.branchId}`}))`,
      );
      const payload = itemTransferOutboxPayloadSchema.parse(work.payload);
      if (
        payload.sourceEventId !== work.sourceEventId ||
        work.schemaVersion !== itemTransferFeedProjectionSchemaVersion
      ) {
        throw new Error("Outbox envelope does not match its delivery contract");
      }

      const [eventRow] = await tx
        .select()
        .from(simEvents)
        .where(and(eq(simEvents.id, work.sourceEventId), eq(simEvents.branchId, work.branchId)))
        .limit(1);
      if (!eventRow) throw new Error("Referenced committed simulation event is missing");
      const feedRow = projectItemTransferredFeedRow(eventFromRow(eventRow));
      if (
        feedRow.sourceSequence !== work.firstSequence ||
        feedRow.sourceSequence !== work.lastSequence
      ) {
        throw new Error("Outbox sequence range does not match its source event");
      }

      const [checkpoint] = await tx
        .select()
        .from(simConsumerCheckpoints)
        .where(
          and(
            eq(simConsumerCheckpoints.consumerKind, itemTransferFeedConsumerKind),
            eq(simConsumerCheckpoints.branchId, work.branchId),
          ),
        )
        .limit(1)
        .for("update");
      const throughSequence = checkpoint?.throughSequence ?? 0;
      if (feedRow.sourceSequence > throughSequence + 1) {
        throw new Error(`Consumer sequence gap: expected ${throughSequence + 1}, received ${feedRow.sourceSequence}`);
      }

      await tx.insert(simItemTransferFeed).values(feedRow).onConflictDoNothing();
      if (options.crashAt === "after_projection_write") {
        throw new Error("Injected E2.3 crash after projection write");
      }

      const nextThroughSequence = Math.max(throughSequence, feedRow.sourceSequence);
      await tx
        .insert(simConsumerCheckpoints)
        .values({
          consumerKind: itemTransferFeedConsumerKind,
          branchId: work.branchId,
          throughSequence: nextThroughSequence,
          projectionSchemaVersion: itemTransferFeedProjectionSchemaVersion,
        })
        .onConflictDoUpdate({
          target: [simConsumerCheckpoints.consumerKind, simConsumerCheckpoints.branchId],
          set: {
            throughSequence: nextThroughSequence,
            projectionSchemaVersion: itemTransferFeedProjectionSchemaVersion,
          },
        });

      await tx
        .update(simOutbox)
        .set({ state: "completed", leaseOwner: null, leaseExpiresAt: null, completedAt: now, lastError: null })
        .where(and(eq(simOutbox.id, work.id), eq(simOutbox.leaseOwner, workerId)));
      return { branchId: work.branchId, throughSequence: nextThroughSequence };
    });

    return completed
      ? { status: "completed", outboxId: claimed.id, ...completed }
      : { status: "lease_lost", outboxId: claimed.id };
  } catch (error) {
    const terminal = claimed.attempts >= maxAttempts;
    const retryAt = terminal ? null : new Date(now.getTime() + outboxRetryDelaySeconds(claimed.attempts) * 1000);
    const released = await database
      .update(simOutbox)
      .set({
        state: terminal ? "failed" : "pending",
        availableAt: retryAt ?? now,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: safeDiagnostic(error, claimed),
      })
      .where(and(eq(simOutbox.id, claimed.id), eq(simOutbox.leaseOwner, workerId)))
      .returning({ id: simOutbox.id });
    if (released.length === 0) return { status: "lease_lost", outboxId: claimed.id };
    return { status: "failed", outboxId: claimed.id, retryAt, terminal };
  }
}

function projectionHash(rows: Array<typeof simItemTransferFeed.$inferSelect>): string {
  const canonical = rows.map((row) => ({
    consumerKind: row.consumerKind,
    branchId: row.branchId,
    sourceEventId: row.sourceEventId,
    sourceSequence: row.sourceSequence,
    storySecond: row.storySecond,
    actorId: row.actorId,
    itemId: row.itemId,
    fromContainerId: row.fromContainerId,
    toContainerId: row.toContainerId,
    projectionSchemaVersion: row.projectionSchemaVersion,
  }));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** Rebuild one branch's disposable feed from immutable authority events. */
export async function rebuildItemTransferFeed(
  rawBranchId: string,
  database: Db = db(),
): Promise<ItemTransferFeedRebuildResult> {
  const branchId = worldBranchIdSchema.parse(rawBranchId);
  return database.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${itemTransferFeedConsumerKind}:${branchId}`}))`);
    await tx
      .delete(simItemTransferFeed)
      .where(and(eq(simItemTransferFeed.consumerKind, itemTransferFeedConsumerKind), eq(simItemTransferFeed.branchId, branchId)));
    await tx
      .delete(simConsumerCheckpoints)
      .where(and(eq(simConsumerCheckpoints.consumerKind, itemTransferFeedConsumerKind), eq(simConsumerCheckpoints.branchId, branchId)));

    const events = await tx
      .select()
      .from(simEvents)
      .where(and(eq(simEvents.branchId, branchId), eq(simEvents.type, "item_transferred")))
      .orderBy(asc(simEvents.sequence));
    const projected = events.map((event) => projectItemTransferredFeedRow(eventFromRow(event)));
    if (projected.length > 0) await tx.insert(simItemTransferFeed).values(projected);
    const throughSequence = projected.at(-1)?.sourceSequence ?? 0;
    await tx.insert(simConsumerCheckpoints).values({
      consumerKind: itemTransferFeedConsumerKind,
      branchId,
      throughSequence,
      projectionSchemaVersion: itemTransferFeedProjectionSchemaVersion,
    });

    const rows = await tx
      .select()
      .from(simItemTransferFeed)
      .where(and(eq(simItemTransferFeed.consumerKind, itemTransferFeedConsumerKind), eq(simItemTransferFeed.branchId, branchId)))
      .orderBy(asc(simItemTransferFeed.sourceSequence));
    return { branchId, throughSequence, rowCount: rows.length, projectionHash: projectionHash(rows) };
  });
}
