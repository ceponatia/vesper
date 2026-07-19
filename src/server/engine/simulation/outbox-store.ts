import { createHash } from "node:crypto";
import { and, asc, eq, gt, inArray, lt, lte, ne, notExists, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  itemMaterialFeedEventKinds,
  itemTransferFeedConsumerKind,
  itemTransferFeedProjectionSchemaVersion,
  itemTransferOutboxPayloadSchema,
  outboxRetryDelaySeconds,
  projectMaterialFeedRow,
} from "@/contracts/simulation/outbox";
import { worldBranchIdSchema } from "@/contracts/simulation/identity";
import {
  db,
  simBranches,
  simConsumerCheckpoints,
  simEvents,
  simItemTransferFeed,
  simOutbox,
  type Db,
} from "@/server/db";

const defaultLeaseSeconds = 30;
const defaultMaxAttempts = 8;
const priorOutbox = alias(simOutbox, "prior_sim_outbox");

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

export interface ClaimedOutboxObligation {
  id: string;
  branchId: string;
  sourceEventId: string;
  firstSequence: number;
  attempts: number;
}

function safeDiagnostic(error: unknown, claimed: ClaimedOutboxObligation): string {
  const name = error instanceof Error ? error.name : "UnknownError";
  const message = error instanceof Error ? error.message : "Consumer failed";
  return `outbox=${claimed.id} branch=${claimed.branchId} sequence=${claimed.firstSequence} event=${claimed.sourceEventId} attempt=${claimed.attempts} ${name}: ${message}`.slice(0, 500);
}

/**
 * A raw event envelope shape for `projectMaterialFeedRow` to parse — it
 * discriminates on `type` among `item_transferred`, `item_destroyed`, and
 * (E5.3 slice 2, §26.6) `item_consumed` itself, so this builder does not pick
 * a schema up front.
 */
function eventFromRow(row: typeof simEvents.$inferSelect): unknown {
  return {
    id: row.id,
    worldId: row.worldId,
    branchId: row.branchId,
    sequence: row.sequence,
    storySecond: row.storySecond,
    type: row.type,
    schemaVersion: row.schemaVersion,
    rulesetVersion: row.rulesetVersion,
    ...(row.derivationVersion ? { derivationVersion: row.derivationVersion } : {}),
    ...(row.commandId ? { commandId: row.commandId } : {}),
    ...(row.causationId ? { causationId: row.causationId } : {}),
    correlationId: row.correlationId,
    actorIds: row.actorIds,
    entityIds: row.entityIds,
    ...(row.locationId ? { locationId: row.locationId } : {}),
    recordedAtWallClock: row.recordedAt.toISOString(),
    payload: row.payload,
  };
}

/**
 * Claiming either takes the work or quarantines it. A consumer that dies by
 * process crash never runs its own catch block, so terminal state cannot only
 * be written there: an exhausted obligation must be retired by whoever next
 * tries to claim it, or a crash loop reclaims it forever (the outbox twin of
 * the E2.4 scheduler claim-time quarantine).
 */
export type OutboxClaimResult =
  | { kind: "claimed"; claimed: ClaimedOutboxObligation }
  | { kind: "quarantined"; outboxId: string };

/** Claim one obligation for a consumer kind — shared by every outbox lane. */
export async function claimNextOutboxObligation(
  database: Db,
  consumerKind: string,
  workerId: string,
  now: Date,
  leaseSeconds: number,
  maxAttempts: number,
): Promise<OutboxClaimResult | undefined> {
  const leaseExpiresAt = new Date(now.getTime() + leaseSeconds * 1000);
  return database.transaction(async (tx) => {
    const [candidate] = await tx
      .select({ id: simOutbox.id, attempts: simOutbox.attempts, branchId: simOutbox.branchId, firstSequence: simOutbox.firstSequence })
      .from(simOutbox)
      .where(
        and(
          eq(simOutbox.consumerKind, consumerKind),
          or(
            and(eq(simOutbox.state, "pending"), lte(simOutbox.availableAt, now)),
            and(eq(simOutbox.state, "processing"), sql`${simOutbox.leaseExpiresAt} <= ${now}`),
          ),
          notExists(
            tx
              .select({ id: priorOutbox.id })
              .from(priorOutbox)
              .where(
                and(
                  eq(priorOutbox.consumerKind, simOutbox.consumerKind),
                  eq(priorOutbox.branchId, simOutbox.branchId),
                  lt(priorOutbox.firstSequence, simOutbox.firstSequence),
                  ne(priorOutbox.state, "completed"),
                ),
              ),
          ),
        ),
      )
      .orderBy(asc(simOutbox.firstSequence), asc(simOutbox.createdAt))
      .limit(1)
      .for("update", { skipLocked: true });
    if (!candidate) return undefined;

    // Retire work that has already spent its budget. Reaching here with
    // attempts at the ceiling means previous workers died before their own
    // failure path could write terminal state.
    if (candidate.attempts >= maxAttempts) {
      await tx
        .update(simOutbox)
        .set({
          state: "failed",
          leaseOwner: null,
          leaseExpiresAt: null,
          lastError: `outbox=${candidate.id} branch=${candidate.branchId} sequence=${candidate.firstSequence} exhausted ${candidate.attempts}/${maxAttempts} attempts without a terminal outcome`,
          completedAt: now,
        })
        .where(eq(simOutbox.id, candidate.id));
      return { kind: "quarantined", outboxId: candidate.id };
    }

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
    return claimed ? { kind: "claimed", claimed } : undefined;
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

  const claim = await claimNextOutboxObligation(
    database,
    itemTransferFeedConsumerKind,
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
      const feedRow = projectMaterialFeedRow(eventFromRow(eventRow));
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
      // Contiguity is defined over material-feed obligations (item_transferred
      // AND item_destroyed — §26.4), not raw branch sequences: other event
      // families (e.g. trigger_scheduled) advance the branch without creating
      // feed work, so the guard asks whether an earlier material event exists
      // that has not been applied yet — never whether sequence numbers are dense.
      const [missing] = await tx
        .select({ sequence: simEvents.sequence })
        .from(simEvents)
        .where(
          and(
            eq(simEvents.branchId, work.branchId),
            inArray(simEvents.type, itemMaterialFeedEventKinds),
            gt(simEvents.sequence, throughSequence),
            lt(simEvents.sequence, feedRow.sourceSequence),
          ),
        )
        .orderBy(asc(simEvents.sequence))
        .limit(1);
      if (missing) {
        throw new Error(
          `Consumer sequence gap: transfer at sequence ${missing.sequence} is unapplied before ${feedRow.sourceSequence}`,
        );
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
    const failure = await releaseFailedOutboxObligation(database, claimed, workerId, now, maxAttempts, error);
    if (!failure.released) return { status: "lease_lost", outboxId: claimed.id };
    return { status: "failed", outboxId: claimed.id, retryAt: failure.retryAt, terminal: failure.terminal };
  }
}

/** Release a failed claim back to the queue (or quarantine it) — shared lane logic. */
export async function releaseFailedOutboxObligation(
  database: Db,
  claimed: ClaimedOutboxObligation,
  workerId: string,
  now: Date,
  maxAttempts: number,
  error: unknown,
): Promise<{ released: boolean; retryAt: Date | null; terminal: boolean }> {
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
  return { released: released.length > 0, retryAt, terminal };
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
    eventKind: row.eventKind,
    fromLocus: row.fromLocus,
    toLocus: row.toLocus,
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
    const [branch] = await tx
      .select({ forkSequence: simBranches.forkSequence })
      .from(simBranches)
      .where(eq(simBranches.id, branchId))
      .limit(1);
    if (!branch) throw new Error("Simulation branch not found");
    await tx
      .delete(simItemTransferFeed)
      .where(and(eq(simItemTransferFeed.consumerKind, itemTransferFeedConsumerKind), eq(simItemTransferFeed.branchId, branchId)));
    await tx
      .delete(simConsumerCheckpoints)
      .where(and(eq(simConsumerCheckpoints.consumerKind, itemTransferFeedConsumerKind), eq(simConsumerCheckpoints.branchId, branchId)));

    const events = await tx
      .select()
      .from(simEvents)
      .where(and(eq(simEvents.branchId, branchId), inArray(simEvents.type, itemMaterialFeedEventKinds)))
      .orderBy(asc(simEvents.sequence));
    const projected = events.map((event) => projectMaterialFeedRow(eventFromRow(event)));
    if (projected.length > 0) await tx.insert(simItemTransferFeed).values(projected);
    // A fork child's obligations start after the fork point — inherited events
    // were delivered on ancestors — so its rebuilt checkpoint bases there.
    const throughSequence = projected.at(-1)?.sourceSequence ?? branch.forkSequence ?? 0;
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
