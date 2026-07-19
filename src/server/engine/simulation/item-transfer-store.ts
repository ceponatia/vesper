import { and, count, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  holdingContainerSchema,
  itemTransferCommandResultSchema,
  itemTransferProjectionSchema,
  simulationActorSchema,
  simulationItemSchema,
  transferItemCommandSchema,
  type ItemTransferCommandResult,
  type ItemTransferProjection,
  type ItemTransferredEvent,
  type TransferItemCommand,
} from "@/contracts/simulation/item-transfer";
import {
  branchHeadSequenceSchema,
  branchVersionSchema,
  composeSimulationId,
  rulesetVersionSchema,
  storySecondSchema,
  worldBranchIdSchema,
  worldIdSchema,
  worldTypeIdSchema,
} from "@/contracts/simulation/identity";
import {
  itemTransferFeedConsumerKind,
  itemTransferFeedProjectionSchemaVersion,
} from "@/contracts/simulation/outbox";
import {
  resolveItemTransferFromView,
  type ItemTransferResolutionView,
} from "@/lib/simulation/item-transfer";
import {
  db,
  simBranches,
  simCharacters,
  simCommands,
  simEvents,
  simHoldingContainers,
  simItemHoldings,
  simItems,
  simOutbox,
  simWorlds,
  type Db,
} from "@/server/db";
import { readDurableBranchState } from "./branch-store";
import { recordCommandObservations } from "./observation-store";

const worldSeedSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => value.trim() === value, "World seeds cannot have surrounding whitespace")
  .refine((value) => !/\s/u.test(value), "World seeds cannot contain whitespace");

export type DurableItemTransferCrashPoint =
  | "after_event_append"
  | "after_projection_update"
  | "after_outbox_insert"
  | "after_branch_advance"
  | "after_command_result"
  | "after_commit";

export class InjectedSimulationCrash extends Error {
  constructor(readonly point: DurableItemTransferCrashPoint) {
    super(`Injected E2.2 crash at ${point}`);
    this.name = "InjectedSimulationCrash";
  }
}

export interface DurableItemTransferOptions {
  database?: Db;
  /**
   * Test-only failpoint. It is a closed enum rather than a callback so callers
   * cannot smuggle network, model, clock, or arbitrary work under the branch lock.
   */
  crashAt?: DurableItemTransferCrashPoint;
  /**
   * Admit the command at whatever version the branch holds once its lock is taken,
   * instead of comparing against a caller-supplied expectedVersion.
   *
   * Optimistic version checks exist to protect a caller that read state and then
   * acted on a stale read. A scheduler resolving a committed trigger under a lease
   * has no such read: its payload was fixed when the trigger was scheduled. Left
   * optimistic, a concurrent command advancing the branch would make the trigger's
   * command conflict — and because a trigger's idempotency key is permanent, that
   * conflict would be stored under it and replayed by every later retry, poisoning
   * the trigger forever rather than delaying it.
   *
   * This never weakens serialization: the branch row lock is still held, and the
   * admitted version is still compare-and-swapped on advance.
   */
  admitAtLockedVersion?: boolean;
}

export interface DurableItemTransferSeedOptions {
  worldTypeId: string;
  worldSeed: string;
  worldStatus?: "active" | "paused" | "archived";
  /** Ruling 3: whether this world admits explicit forced-entry attempts. */
  permitsTrespass?: boolean;
  database?: Db;
}

export interface DurableItemTransferBranchState {
  projection: ItemTransferProjection;
  events: ItemTransferredEvent[];
}

function injectCrash(
  configured: DurableItemTransferCrashPoint | undefined,
  point: Exclude<DurableItemTransferCrashPoint, "after_commit">,
): void {
  if (configured === point) throw new InjectedSimulationCrash(point);
}

function invalidCommandResult(): ItemTransferCommandResult {
  return {
    status: "rejected",
    commandId: "invalid",
    code: "invalid_command",
    publicReason: "That action request is invalid.",
    legalAlternativeCommandTypes: [],
  };
}

function branchUnavailableResult(command: TransferItemCommand): ItemTransferCommandResult {
  return {
    status: "rejected",
    commandId: command.id,
    code: "branch_mismatch",
    publicReason: "That world branch is unavailable.",
    legalAlternativeCommandTypes: [],
  };
}

function duplicateCommandResult(command: TransferItemCommand): ItemTransferCommandResult {
  return {
    status: "rejected",
    commandId: command.id,
    code: "duplicate_command_id",
    publicReason: "That action request has already been submitted.",
    legalAlternativeCommandTypes: [],
  };
}

function parseStoredResult(value: unknown): ItemTransferCommandResult {
  return itemTransferCommandResultSchema.parse(value);
}

/**
 * Seed one new E2.2 branch atomically from the Gate 1 projection contract.
 *
 * This is a bootstrap/test seam, not a branch-fork implementation. E2.5 owns
 * ancestry and historical seed reconstruction.
 */
export async function seedDurableItemTransferBranch(
  rawProjection: unknown,
  options: DurableItemTransferSeedOptions,
): Promise<void> {
  const database = options.database ?? db();
  const projection = itemTransferProjectionSchema.parse(rawProjection);
  const worldTypeId = worldTypeIdSchema.parse(options.worldTypeId);
  const worldSeed = worldSeedSchema.parse(options.worldSeed);
  if (projection.version !== 0 || projection.headSequence !== 0 || projection.observations.length !== 0) {
    throw new Error("A durable E2.2 branch seed must begin before its first event");
  }

  const holdingsPerContainer = new Map<string, number>();
  for (const item of projection.items) {
    holdingsPerContainer.set(
      item.holdingContainerId,
      (holdingsPerContainer.get(item.holdingContainerId) ?? 0) + 1,
    );
  }
  for (const container of projection.containers) {
    if ((holdingsPerContainer.get(container.id) ?? 0) > container.capacity) {
      throw new Error(`Cannot seed over-capacity holding container ${container.id}`);
    }
  }

  await database.transaction(async (tx) => {
    await tx
      .insert(simWorlds)
      .values({
        id: projection.worldId,
        worldTypeId,
        seed: worldSeed,
        rulesetVersion: projection.rulesetVersion,
        status: options.worldStatus ?? "active",
        permitsTrespass: options.permitsTrespass ?? false,
      })
      .onConflictDoNothing();

    const [world] = await tx
      .select({
        worldTypeId: simWorlds.worldTypeId,
        seed: simWorlds.seed,
        rulesetVersion: simWorlds.rulesetVersion,
        status: simWorlds.status,
      })
      .from(simWorlds)
      .where(eq(simWorlds.id, projection.worldId))
      .limit(1);
    if (
      !world ||
      world.worldTypeId !== worldTypeId ||
      world.seed !== worldSeed ||
      world.rulesetVersion !== projection.rulesetVersion ||
      world.status !== (options.worldStatus ?? "active")
    ) {
      throw new Error("Existing simulation world metadata does not match the branch seed");
    }

    await tx.insert(simBranches).values({
      id: projection.branchId,
      worldId: projection.worldId,
      headSequence: 0,
      version: 0,
      storySecond: projection.storySecond,
      // The seed step is not an event (plan R3), so the origin clock must be
      // recorded here or a fork at sequence zero could never recover it.
      originStorySecond: projection.storySecond,
    });

    if (projection.actors.length > 0) {
      await tx.insert(simCharacters).values(
        projection.actors.map((actor) => ({
          branchId: projection.branchId,
          characterId: actor.id,
          name: actor.name,
          observedContainerIds: actor.observedContainerIds,
        })),
      );
    }
    if (projection.containers.length > 0) {
      await tx.insert(simHoldingContainers).values(
        projection.containers.map((container) => ({
          branchId: projection.branchId,
          holdingContainerId: container.id,
          kind: container.kind,
          name: container.name,
          capacity: container.capacity,
          accessibleToActorIds: container.accessibleToActorIds,
        })),
      );
    }
    if (projection.items.length > 0) {
      await tx.insert(simItems).values(
        projection.items.map((item) => ({
          branchId: projection.branchId,
          itemId: item.id,
          name: item.name,
        })),
      );
      await tx.insert(simItemHoldings).values(
        projection.items.map((item) => ({
          branchId: projection.branchId,
          itemId: item.id,
          holdingContainerId: item.holdingContainerId,
          updatedSequence: 0,
        })),
      );
    }
  });
}

/**
 * Execute one transfer against PostgreSQL authority.
 *
 * Every parsed command result is written in the same transaction as its event,
 * projection, and branch advance. The only work while the row lock is held is
 * database IO, schema parsing, and the pure deterministic resolver.
 */
export async function submitDurableItemTransfer(
  rawCommand: unknown,
  options: DurableItemTransferOptions = {},
): Promise<ItemTransferCommandResult> {
  const parsed = transferItemCommandSchema.safeParse(rawCommand);
  if (!parsed.success) return invalidCommandResult();

  const submitted = parsed.data;
  const database = options.database ?? db();

  const [preLockCached] = await database
    .select({ result: simCommands.result })
    .from(simCommands)
    .where(
      and(
        eq(simCommands.branchId, submitted.branchId),
        eq(simCommands.idempotencyKey, submitted.idempotencyKey),
      ),
    )
    .limit(1);
  if (preLockCached) return parseStoredResult(preLockCached.result);

  const result = await database.transaction(async (tx) => {
    const [branch] = await tx
      .select({
        id: simBranches.id,
        worldId: simBranches.worldId,
        headSequence: simBranches.headSequence,
        version: simBranches.version,
        storySecond: simBranches.storySecond,
        rulesetVersion: simWorlds.rulesetVersion,
        worldStatus: simWorlds.status,
      })
      .from(simBranches)
      .innerJoin(simWorlds, eq(simWorlds.id, simBranches.worldId))
      .where(eq(simBranches.id, submitted.branchId))
      .limit(1)
      // The joined world row supplies status/ruleset metadata, but only the
      // branch is the sequencing mutex. Locking both rows would accidentally
      // serialize independent branches in the same world.
      .for("update", { of: simBranches });

    if (!branch) return branchUnavailableResult(submitted);

    // Resolve the admitted version only once the branch lock is held, so a
    // locked-version admission cannot race the value it is admitted at.
    const command: TransferItemCommand = options.admitAtLockedVersion
      ? { ...submitted, expectedVersion: branchVersionSchema.parse(branch.version) }
      : submitted;

    // The pre-lock read is only a fast path. A peer may have committed while
    // this transaction waited, so idempotency is checked again under the lock.
    const [cached] = await tx
      .select({ result: simCommands.result })
      .from(simCommands)
      .where(
        and(
          eq(simCommands.branchId, command.branchId),
          eq(simCommands.idempotencyKey, command.idempotencyKey),
        ),
      )
      .limit(1);
    if (cached) return parseStoredResult(cached.result);

    const [sameCommandId] = await tx
      .select({ idempotencyKey: simCommands.idempotencyKey })
      .from(simCommands)
      .where(
        and(
          eq(simCommands.branchId, command.branchId),
          eq(simCommands.commandId, command.id),
        ),
      )
      .limit(1);

    let commandResult: ItemTransferCommandResult;
    if (sameCommandId) {
      commandResult = duplicateCommandResult(command);
    } else if (branch.worldStatus !== "active") {
      commandResult = branchUnavailableResult(command);
    } else if (command.expectedVersion !== branch.version) {
      commandResult = {
        status: "conflict",
        commandId: command.id,
        currentVersion: branch.version,
        retryable: true,
      };
    } else {
      const [actorRow] = await tx
        .select({
          characterId: simCharacters.characterId,
          name: simCharacters.name,
          observedContainerIds: simCharacters.observedContainerIds,
        })
        .from(simCharacters)
        .where(
          and(
            eq(simCharacters.branchId, command.branchId),
            eq(simCharacters.characterId, command.payload.actorId),
          ),
        )
        .limit(1);

      const [itemRow] = await tx
        .select({
          itemId: simItems.itemId,
          name: simItems.name,
          holdingContainerId: simItemHoldings.holdingContainerId,
        })
        .from(simItems)
        .innerJoin(
          simItemHoldings,
          and(
            eq(simItemHoldings.branchId, simItems.branchId),
            eq(simItemHoldings.itemId, simItems.itemId),
          ),
        )
        .where(
          and(
            eq(simItems.branchId, command.branchId),
            eq(simItems.itemId, command.payload.itemId),
          ),
        )
        .limit(1);

      const containerRows = await tx
        .select({
          holdingContainerId: simHoldingContainers.holdingContainerId,
          kind: simHoldingContainers.kind,
          name: simHoldingContainers.name,
          capacity: simHoldingContainers.capacity,
          accessibleToActorIds: simHoldingContainers.accessibleToActorIds,
        })
        .from(simHoldingContainers)
        .where(
          and(
            eq(simHoldingContainers.branchId, command.branchId),
            inArray(simHoldingContainers.holdingContainerId, [
              command.payload.fromContainerId,
              command.payload.toContainerId,
            ]),
          ),
        );

      const [destinationCountRow] = await tx
        .select({ value: count() })
        .from(simItemHoldings)
        .where(
          and(
            eq(simItemHoldings.branchId, command.branchId),
            eq(simItemHoldings.holdingContainerId, command.payload.toContainerId),
          ),
        );

      const requiredObservedContainers = [
        ...new Set([
          command.payload.fromContainerId,
          command.payload.toContainerId,
        ]),
      ].sort();
      const observerRows = actorRow
        ? await tx
            .select({ characterId: simCharacters.characterId })
            .from(simCharacters)
            .where(
              and(
                eq(simCharacters.branchId, command.branchId),
                sql`${simCharacters.observedContainerIds} @> ${JSON.stringify(requiredObservedContainers)}::jsonb`,
              ),
            )
        : [];

      const containerById = new Map(
        containerRows.map((row) => [
          row.holdingContainerId,
          holdingContainerSchema.parse({
            id: row.holdingContainerId,
            kind: row.kind,
            name: row.name,
            capacity: row.capacity,
            accessibleToActorIds: row.accessibleToActorIds,
          }),
        ]),
      );
      const view: ItemTransferResolutionView = {
        worldId: worldIdSchema.parse(branch.worldId),
        branchId: worldBranchIdSchema.parse(branch.id),
        rulesetVersion: rulesetVersionSchema.parse(branch.rulesetVersion),
        version: branchVersionSchema.parse(branch.version),
        headSequence: branchHeadSequenceSchema.parse(branch.headSequence),
        storySecond: storySecondSchema.parse(branch.storySecond),
        actor: actorRow
          ? simulationActorSchema.parse({
              id: actorRow.characterId,
              name: actorRow.name,
              observedContainerIds: actorRow.observedContainerIds,
            })
          : undefined,
        item: itemRow
          ? simulationItemSchema.parse({
              id: itemRow.itemId,
              name: itemRow.name,
              holdingContainerId: itemRow.holdingContainerId,
            })
          : undefined,
        source: containerById.get(command.payload.fromContainerId),
        destination: containerById.get(command.payload.toContainerId),
        destinationItemCount: destinationCountRow?.value ?? 0,
        observerActorIds: observerRows
          .map((row) => simulationActorSchema.shape.id.parse(row.characterId))
          .sort(),
      };

      const resolution = resolveItemTransferFromView(view, command);
      if (!resolution.ok) {
        commandResult = {
          status: "rejected",
          commandId: command.id,
          code: resolution.code,
          publicReason: resolution.publicReason,
          legalAlternativeCommandTypes: [],
        };
      } else {
        const event = resolution.event;
        await tx.insert(simEvents).values({
          id: event.id,
          worldId: event.worldId,
          branchId: event.branchId,
          sequence: event.sequence,
          storySecond: event.storySecond,
          type: event.type,
          schemaVersion: event.schemaVersion,
          rulesetVersion: event.rulesetVersion,
          derivationVersion: event.derivationVersion,
          commandId: event.commandId,
          causationId: event.causationId,
          correlationId: event.correlationId,
          actorIds: event.actorIds,
          entityIds: event.entityIds,
          locationId: event.locationId,
          recordedAt: new Date(event.recordedAtWallClock),
          payload: event.payload,
        });
        injectCrash(options.crashAt, "after_event_append");

        const moved = await tx
          .update(simItemHoldings)
          .set({
            holdingContainerId: event.payload.toContainerId,
            updatedSequence: event.sequence,
          })
          .where(
            and(
              eq(simItemHoldings.branchId, event.branchId),
              eq(simItemHoldings.itemId, event.payload.itemId),
              eq(simItemHoldings.holdingContainerId, event.payload.fromContainerId),
            ),
          )
          .returning({ itemId: simItemHoldings.itemId });
        if (moved.length !== 1) {
          throw new Error("Locked item holding changed before projection update");
        }
        injectCrash(options.crashAt, "after_projection_update");

        await tx.insert(simOutbox).values({
          id: composeSimulationId("outbox", [itemTransferFeedConsumerKind, event.id]),
          worldId: event.worldId,
          branchId: event.branchId,
          sourceEventId: event.id,
          firstSequence: event.sequence,
          lastSequence: event.sequence,
          consumerKind: itemTransferFeedConsumerKind,
          schemaVersion: itemTransferFeedProjectionSchemaVersion,
          payload: { sourceEventId: event.id },
        });
        injectCrash(options.crashAt, "after_outbox_insert");

        // E4.1: the transfer's captured witnesses become typed observations,
        // committed atomically with the event they perceive (§20).
        await recordCommandObservations(tx, { id: branch.id, headSequence: branch.headSequence });

        const advanced = await tx
          .update(simBranches)
          .set({
            headSequence: event.sequence,
            version: branch.version + 1,
          })
          .where(
            and(
              eq(simBranches.id, branch.id),
              eq(simBranches.version, branch.version),
              eq(simBranches.headSequence, branch.headSequence),
            ),
          )
          .returning({ id: simBranches.id });
        if (advanced.length !== 1) {
          throw new Error("Locked simulation branch failed its compare-and-swap advance");
        }
        injectCrash(options.crashAt, "after_branch_advance");

        commandResult = {
          status: "accepted",
          commandId: command.id,
          branchVersion: branch.version + 1,
          firstSequence: event.sequence,
          lastSequence: event.sequence,
          eventIds: [event.id],
        };
      }
    }

    await tx.insert(simCommands).values({
      branchId: command.branchId,
      idempotencyKey: command.idempotencyKey,
      commandId: command.id,
      type: command.type,
      schemaVersion: command.schemaVersion,
      expectedVersion: command.expectedVersion,
      principalKind: command.principal.kind,
      envelope: command,
      status: commandResult.status,
      result: commandResult,
      submittedAt: new Date(command.submittedAtWallClock),
    });
    injectCrash(options.crashAt, "after_command_result");
    return commandResult;
  });

  if (options.crashAt === "after_commit") {
    throw new InjectedSimulationCrash("after_commit");
  }
  return result;
}

/**
 * Load the current typed projection and immutable transfer events without a
 * write lock. Events resolve through branch ancestry (plan R4), so a fork
 * child sees its inherited history here exactly as a root sees its own.
 */
export async function readDurableItemTransferBranch(
  rawBranchId: string,
  database: Db = db(),
): Promise<DurableItemTransferBranchState> {
  const state = await readDurableBranchState(rawBranchId, database);
  return {
    projection: state.projection,
    events: state.events.filter(
      (event): event is ItemTransferredEvent => event.type === "item_transferred",
    ),
  };
}
