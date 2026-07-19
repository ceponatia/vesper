import { and, asc, eq, sql } from "drizzle-orm";
import {
  applyBodyConditionCommandResultSchema,
  applyBodyConditionCommandSchema,
  applyBodyModifierCommandResultSchema,
  applyBodyModifierCommandSchema,
  applyBodySourceCommandResultSchema,
  applyBodySourceCommandSchema,
  bodiesProjectionSchema,
  bodyConditionSchema,
  bodyMeterRegistryByVersion,
  bodyMeterStateSchema,
  bodyModifierSchema,
  bodyRegistryVersionSchema,
  endBodyConditionCommandResultSchema,
  endBodyConditionCommandSchema,
  initializeActorBodyCommandResultSchema,
  initializeActorBodyCommandSchema,
  resolveBodyThresholdCommandResultSchema,
  resolveBodyThresholdCommandSchema,
  type ApplyBodyConditionCommandResult,
  type ApplyBodyModifierCommandResult,
  type ApplyBodySourceCommandResult,
  type BodiesProjection,
  type BodyCondition,
  type BodyMeterState,
  type BodyModifier,
  type EndBodyConditionCommandResult,
  type InitializeActorBodyCommandResult,
  type ResolveBodyThresholdCommandResult,
} from "@/contracts/simulation/bodies";
import { worldBranchIdSchema } from "@/contracts/simulation/identity";
import {
  bodyConditionExpiryUniquenessKey,
  bodyThresholdUniquenessKeyPrefix,
  resolveApplyBodyCondition,
  resolveApplyBodyModifier,
  resolveApplyBodySource,
  resolveBodyThreshold,
  resolveEndBodyCondition,
  resolveInitializeActorBody,
  type MeterIntegrationView,
} from "@/lib/simulation/bodies";
import {
  db,
  simBodyConditions,
  simBodyMeters,
  simBodyModifiers,
  simBranches,
  simCharacters,
  simPhysicalLoci,
  simTriggers,
  type Db,
} from "@/server/db";
import {
  advanceLockedBranch,
  appendSimulationEvent,
  runSimulationCommand,
  type LockedBranchView,
} from "./command-runner";
import { applyTriggerScheduledEvent, type SimTx } from "./trigger-projector";

/**
 * E5.1 durable body authority. Meter rows persist only at MATERIAL boundaries
 * (sources, modifier boundaries, threshold crossings); every query integrates
 * analytically from the last write and persists nothing, which is what makes
 * partition invariance structural. Threshold alarms are committed as
 * trigger_scheduled events in the same transaction, retired-and-re-armed
 * under sequence-versioned uniqueness keys whenever a material event moves
 * the trajectory.
 */

export interface BodyStoreOptions {
  database?: Db;
  admitAtLockedVersion?: boolean;
}

export function bodyMeterFromRow(row: typeof simBodyMeters.$inferSelect): BodyMeterState {
  return bodyMeterStateSchema.parse({
    actorId: row.actorId,
    meterKey: row.meterKey,
    valueFixedPoint: row.valueFixedPoint,
    baselineFixedPoint: row.baselineFixedPoint,
    lastIntegratedAtStorySecond: row.lastIntegratedAt,
    registryVersion: row.registryVersion,
  });
}

export function bodyMeterRowInsert(
  branchId: string,
  meter: BodyMeterState,
  updatedSequence: number,
): typeof simBodyMeters.$inferInsert {
  return {
    branchId,
    actorId: meter.actorId,
    meterKey: meter.meterKey,
    valueFixedPoint: meter.valueFixedPoint,
    baselineFixedPoint: meter.baselineFixedPoint,
    lastIntegratedAt: meter.lastIntegratedAtStorySecond,
    registryVersion: meter.registryVersion,
    updatedSequence,
  };
}

export function bodyConditionFromRow(row: typeof simBodyConditions.$inferSelect): BodyCondition {
  return bodyConditionSchema.parse({
    id: row.conditionId,
    actorId: row.actorId,
    key: row.key,
    onsetAtStorySecond: row.onsetAt,
    ...(row.expiresAt === null ? {} : { expiresAtStorySecond: row.expiresAt }),
    status: row.status,
    ...(row.endBasis === null ? {} : { endBasis: row.endBasis }),
    sourceEventId: row.sourceEventId,
  });
}

export function bodyConditionRowInsert(
  branchId: string,
  condition: BodyCondition,
  updatedSequence: number,
): typeof simBodyConditions.$inferInsert {
  return {
    branchId,
    conditionId: condition.id,
    actorId: condition.actorId,
    key: condition.key,
    onsetAt: condition.onsetAtStorySecond,
    expiresAt: condition.expiresAtStorySecond ?? null,
    status: condition.status,
    endBasis: condition.endBasis ?? null,
    sourceEventId: condition.sourceEventId,
    updatedSequence,
  };
}

export function bodyModifierFromRow(row: typeof simBodyModifiers.$inferSelect): BodyModifier {
  return bodyModifierSchema.parse({
    id: row.modifierId,
    actorId: row.actorId,
    meterKey: row.meterKey,
    operation: row.operation,
    stackingGroup: row.stackingGroup,
    priority: row.priority,
    validFromStorySecond: row.validFrom,
    ...(row.validUntil === null ? {} : { validUntilStorySecond: row.validUntil }),
    visibility: row.visibility,
    ...(row.conditionId === null ? {} : { conditionId: row.conditionId }),
    sourceEventId: row.sourceEventId,
  });
}

export function bodyModifierRowInsert(
  branchId: string,
  modifier: BodyModifier,
  updatedSequence: number,
): typeof simBodyModifiers.$inferInsert {
  return {
    branchId,
    modifierId: modifier.id,
    actorId: modifier.actorId,
    meterKey: modifier.meterKey,
    operation: modifier.operation,
    stackingGroup: modifier.stackingGroup,
    priority: modifier.priority,
    validFrom: modifier.validFromStorySecond,
    validUntil: modifier.validUntilStorySecond ?? null,
    visibility: modifier.visibility,
    conditionId: modifier.conditionId ?? null,
    sourceEventId: modifier.sourceEventId,
    updatedSequence,
  };
}

/** Load the current typed bodies projection without a write lock. */
export async function readDurableBodies(
  rawBranchId: string,
  database: Db = db(),
): Promise<BodiesProjection> {
  const branchId = worldBranchIdSchema.parse(rawBranchId);
  const [branch] = await database
    .select({
      headSequence: simBranches.headSequence,
      version: simBranches.version,
      storySecond: simBranches.storySecond,
    })
    .from(simBranches)
    .where(eq(simBranches.id, branchId))
    .limit(1);
  if (!branch) throw new Error("Simulation branch not found");
  const [meterRows, conditionRows, modifierRows] = await Promise.all([
    database
      .select()
      .from(simBodyMeters)
      .where(eq(simBodyMeters.branchId, branchId))
      .orderBy(asc(simBodyMeters.actorId), asc(simBodyMeters.meterKey)),
    database
      .select()
      .from(simBodyConditions)
      .where(eq(simBodyConditions.branchId, branchId))
      .orderBy(asc(simBodyConditions.conditionId)),
    database
      .select()
      .from(simBodyModifiers)
      .where(eq(simBodyModifiers.branchId, branchId))
      .orderBy(asc(simBodyModifiers.modifierId)),
  ]);
  return bodiesProjectionSchema.parse({
    branchId,
    headSequence: branch.headSequence,
    version: branch.version,
    storySecond: branch.storySecond,
    meters: meterRows.map(bodyMeterFromRow),
    conditions: conditionRows.map(bodyConditionFromRow),
    modifiers: modifierRows.map(bodyModifierFromRow),
  });
}

function rejectedResult<TCode extends string>(commandId: string, code: TCode, publicReason: string) {
  return {
    status: "rejected" as const,
    commandId,
    code,
    publicReason,
    legalAlternativeCommandTypes: [],
  };
}

interface ActorBodyRows {
  meters: BodyMeterState[];
  conditions: BodyCondition[];
  modifiers: BodyModifier[];
}

async function loadActorBody(tx: SimTx, branchId: string, actorId: string): Promise<ActorBodyRows> {
  const [meterRows, conditionRows, modifierRows] = await Promise.all([
    tx
      .select()
      .from(simBodyMeters)
      .where(and(eq(simBodyMeters.branchId, branchId), eq(simBodyMeters.actorId, actorId)))
      .orderBy(asc(simBodyMeters.meterKey)),
    tx
      .select()
      .from(simBodyConditions)
      .where(and(eq(simBodyConditions.branchId, branchId), eq(simBodyConditions.actorId, actorId)))
      .orderBy(asc(simBodyConditions.conditionId)),
    tx
      .select()
      .from(simBodyModifiers)
      .where(and(eq(simBodyModifiers.branchId, branchId), eq(simBodyModifiers.actorId, actorId)))
      .orderBy(asc(simBodyModifiers.modifierId)),
  ]);
  return {
    meters: meterRows.map(bodyMeterFromRow),
    conditions: conditionRows.map(bodyConditionFromRow),
    modifiers: modifierRows.map(bodyModifierFromRow),
  };
}

/** The kernel's per-meter integration view over one actor's loaded rows. */
function meterViewOf(body: ActorBodyRows, meterKey: string): MeterIntegrationView | undefined {
  const state = body.meters.find((meter) => meter.meterKey === meterKey);
  if (!state) return undefined;
  const parsedVersion = bodyRegistryVersionSchema.safeParse(state.registryVersion);
  if (!parsedVersion.success) return undefined;
  const definition = bodyMeterRegistryByVersion[parsedVersion.data].find(
    (candidate) => candidate.key === meterKey,
  );
  if (!definition) return undefined;
  return {
    definition,
    state,
    modifiers: body.modifiers.filter((modifier) => modifier.meterKey === meterKey),
  };
}

/** Retire this meter's pending alarm so it can never fire against stale state. */
async function retirePendingThresholdTriggers(
  tx: SimTx,
  branch: LockedBranchView,
  commandId: string,
  submittedAtWallClock: string,
  actorId: string,
  meterKey: string,
): Promise<void> {
  const prefix = bodyThresholdUniquenessKeyPrefix(actorId, meterKey);
  await tx
    .update(simTriggers)
    .set({
      state: "completed",
      resultCommandId: commandId,
      completedAt: new Date(submittedAtWallClock),
    })
    .where(
      and(
        eq(simTriggers.branchId, branch.id),
        eq(simTriggers.state, "pending"),
        sql`starts_with(${simTriggers.uniquenessKey}, ${prefix})`,
      ),
    );
}

async function retirePendingExpiryTrigger(
  tx: SimTx,
  branch: LockedBranchView,
  commandId: string,
  submittedAtWallClock: string,
  conditionId: string,
): Promise<void> {
  await tx
    .update(simTriggers)
    .set({
      state: "completed",
      resultCommandId: commandId,
      completedAt: new Date(submittedAtWallClock),
    })
    .where(
      and(
        eq(simTriggers.branchId, branch.id),
        eq(simTriggers.uniquenessKey, bodyConditionExpiryUniquenessKey(conditionId)),
        eq(simTriggers.state, "pending"),
      ),
    );
}

async function upsertMeterRow(
  tx: SimTx,
  branchId: string,
  meter: BodyMeterState,
  updatedSequence: number,
): Promise<void> {
  const [updated] = await tx
    .update(simBodyMeters)
    .set({
      valueFixedPoint: meter.valueFixedPoint,
      baselineFixedPoint: meter.baselineFixedPoint,
      lastIntegratedAt: meter.lastIntegratedAtStorySecond,
      updatedSequence,
    })
    .where(
      and(
        eq(simBodyMeters.branchId, branchId),
        eq(simBodyMeters.actorId, meter.actorId),
        eq(simBodyMeters.meterKey, meter.meterKey),
      ),
    )
    .returning({ meterKey: simBodyMeters.meterKey });
  if (!updated) throw new Error("Locked body meter changed before its material update");
}

/** Co-located same-zone actors (excluding the subject) for witness capture. */
async function loadCoLocatedActorIds(tx: SimTx, branchId: string, actorId: string): Promise<string[]> {
  const [subject] = await tx
    .select({ kind: simPhysicalLoci.kind, zoneId: simPhysicalLoci.zoneId })
    .from(simPhysicalLoci)
    .where(and(eq(simPhysicalLoci.branchId, branchId), eq(simPhysicalLoci.actorId, actorId)))
    .limit(1);
  if (!subject || subject.kind !== "at" || subject.zoneId === null) return [];
  const rows = await tx
    .select({ actorId: simPhysicalLoci.actorId })
    .from(simPhysicalLoci)
    .where(
      and(
        eq(simPhysicalLoci.branchId, branchId),
        eq(simPhysicalLoci.kind, "at"),
        eq(simPhysicalLoci.zoneId, subject.zoneId),
      ),
    );
  return rows.map((row) => row.actorId).filter((candidate) => candidate !== actorId);
}

/** Seed one actor's body from the registry: rows + initial alarms, atomically. */
export async function submitDurableInitializeActorBody(
  rawCommand: unknown,
  options: BodyStoreOptions = {},
): Promise<InitializeActorBodyCommandResult> {
  return runSimulationCommand({
    rawCommand,
    commandSchema: initializeActorBodyCommandSchema,
    resultSchema: initializeActorBodyCommandResultSchema,
    invalidResult: () => rejectedResult("invalid", "invalid_command", "That body request is invalid."),
    branchUnavailableResult: (commandId) =>
      rejectedResult(commandId, "branch_mismatch", "That world branch is unavailable."),
    duplicateCommandIdResult: (commandId) =>
      rejectedResult(commandId, "duplicate_command_id", "That body has already been submitted."),
    conflictResult: (commandId, currentVersion) =>
      initializeActorBodyCommandResultSchema.parse({
        status: "conflict",
        commandId,
        currentVersion,
        retryable: true,
      }),
    database: options.database,
    admitAtLockedVersion: options.admitAtLockedVersion,
    execute: async (tx, branch: LockedBranchView, command) => {
      const [actorRow] = await tx
        .select({ characterId: simCharacters.characterId })
        .from(simCharacters)
        .where(
          and(eq(simCharacters.branchId, branch.id), eq(simCharacters.characterId, command.payload.actorId)),
        )
        .limit(1);
      const [existingMeter] = await tx
        .select({ meterKey: simBodyMeters.meterKey })
        .from(simBodyMeters)
        .where(
          and(eq(simBodyMeters.branchId, branch.id), eq(simBodyMeters.actorId, command.payload.actorId)),
        )
        .limit(1);

      const resolution = resolveInitializeActorBody(
        {
          worldId: branch.worldId,
          branchId: branch.id,
          rulesetVersion: branch.rulesetVersion,
          headSequence: branch.headSequence,
          storySecond: branch.storySecond,
          actorExists: actorRow !== undefined,
          alreadyInitialized: existingMeter !== undefined,
        },
        command,
      );
      if (!resolution.ok) return rejectedResult(command.id, resolution.code, resolution.publicReason);

      const [initialized, ...triggers] = resolution.events;
      await appendSimulationEvent(tx, initialized);
      for (const trigger of triggers) {
        await appendSimulationEvent(tx, trigger);
        await applyTriggerScheduledEvent(tx, trigger, { branchId: branch.id, worldId: branch.worldId });
      }
      await tx
        .insert(simBodyMeters)
        .values(resolution.meters.map((meter) => bodyMeterRowInsert(branch.id, meter, initialized.sequence)));
      const lastSequence = resolution.events[resolution.events.length - 1]?.sequence ?? initialized.sequence;
      await advanceLockedBranch(tx, branch, lastSequence);

      return {
        status: "accepted",
        commandId: command.id,
        branchVersion: branch.version + 1,
        firstSequence: initialized.sequence,
        lastSequence,
        eventIds: resolution.events.map((event) => event.id),
      };
    },
  });
}

/** Apply one material source to one meter (integrate → apply → re-arm). */
export async function submitDurableApplyBodySource(
  rawCommand: unknown,
  options: BodyStoreOptions = {},
): Promise<ApplyBodySourceCommandResult> {
  return runSimulationCommand({
    rawCommand,
    commandSchema: applyBodySourceCommandSchema,
    resultSchema: applyBodySourceCommandResultSchema,
    invalidResult: () => rejectedResult("invalid", "invalid_command", "That body request is invalid."),
    branchUnavailableResult: (commandId) =>
      rejectedResult(commandId, "branch_mismatch", "That world branch is unavailable."),
    duplicateCommandIdResult: (commandId) =>
      rejectedResult(commandId, "duplicate_command_id", "That source has already been submitted."),
    conflictResult: (commandId, currentVersion) =>
      applyBodySourceCommandResultSchema.parse({
        status: "conflict",
        commandId,
        currentVersion,
        retryable: true,
      }),
    database: options.database,
    admitAtLockedVersion: options.admitAtLockedVersion,
    execute: async (tx, branch: LockedBranchView, command) => {
      const body = await loadActorBody(tx, branch.id, command.payload.actorId);
      const meterView = meterViewOf(body, command.payload.meterKey);
      const resolution = resolveApplyBodySource(
        {
          worldId: branch.worldId,
          branchId: branch.id,
          rulesetVersion: branch.rulesetVersion,
          headSequence: branch.headSequence,
          storySecond: branch.storySecond,
          bodyInitialized: body.meters.length > 0,
          ...(meterView ? { meter: meterView.state, definition: meterView.definition } : {}),
          modifiers: meterView?.modifiers ?? [],
        },
        command,
      );
      if (!resolution.ok) return rejectedResult(command.id, resolution.code, resolution.publicReason);

      const [sourceEvent, ...triggers] = resolution.events;
      await appendSimulationEvent(tx, sourceEvent);
      await retirePendingThresholdTriggers(
        tx,
        branch,
        command.id,
        command.submittedAtWallClock,
        command.payload.actorId,
        command.payload.meterKey,
      );
      for (const trigger of triggers) {
        await appendSimulationEvent(tx, trigger);
        await applyTriggerScheduledEvent(tx, trigger, { branchId: branch.id, worldId: branch.worldId });
      }
      await upsertMeterRow(tx, branch.id, resolution.meter, sourceEvent.sequence);
      const lastSequence = resolution.events[resolution.events.length - 1]?.sequence ?? sourceEvent.sequence;
      await advanceLockedBranch(tx, branch, lastSequence);

      return {
        status: "accepted",
        commandId: command.id,
        branchVersion: branch.version + 1,
        firstSequence: sourceEvent.sequence,
        lastSequence,
        eventIds: resolution.events.map((event) => event.id),
      };
    },
  });
}

/** Attach one standalone §25.3 modifier (integrate → boundary write → re-arm). */
export async function submitDurableApplyBodyModifier(
  rawCommand: unknown,
  options: BodyStoreOptions = {},
): Promise<ApplyBodyModifierCommandResult> {
  return runSimulationCommand({
    rawCommand,
    commandSchema: applyBodyModifierCommandSchema,
    resultSchema: applyBodyModifierCommandResultSchema,
    invalidResult: () => rejectedResult("invalid", "invalid_command", "That body request is invalid."),
    branchUnavailableResult: (commandId) =>
      rejectedResult(commandId, "branch_mismatch", "That world branch is unavailable."),
    duplicateCommandIdResult: (commandId) =>
      rejectedResult(commandId, "duplicate_command_id", "That effect has already been submitted."),
    conflictResult: (commandId, currentVersion) =>
      applyBodyModifierCommandResultSchema.parse({
        status: "conflict",
        commandId,
        currentVersion,
        retryable: true,
      }),
    database: options.database,
    admitAtLockedVersion: options.admitAtLockedVersion,
    execute: async (tx, branch: LockedBranchView, command) => {
      const body = await loadActorBody(tx, branch.id, command.payload.actorId);
      const meterView = meterViewOf(body, command.payload.modifier.meterKey);
      const resolution = resolveApplyBodyModifier(
        {
          worldId: branch.worldId,
          branchId: branch.id,
          rulesetVersion: branch.rulesetVersion,
          headSequence: branch.headSequence,
          storySecond: branch.storySecond,
          bodyInitialized: body.meters.length > 0,
          ...(meterView ? { meter: meterView.state, definition: meterView.definition } : {}),
          modifiers: meterView?.modifiers ?? [],
        },
        command,
      );
      if (!resolution.ok) return rejectedResult(command.id, resolution.code, resolution.publicReason);

      const [modifierEvent, ...triggers] = resolution.events;
      await appendSimulationEvent(tx, modifierEvent);
      await retirePendingThresholdTriggers(
        tx,
        branch,
        command.id,
        command.submittedAtWallClock,
        command.payload.actorId,
        command.payload.modifier.meterKey,
      );
      for (const trigger of triggers) {
        await appendSimulationEvent(tx, trigger);
        await applyTriggerScheduledEvent(tx, trigger, { branchId: branch.id, worldId: branch.worldId });
      }
      await tx
        .insert(simBodyModifiers)
        .values(bodyModifierRowInsert(branch.id, resolution.modifier, modifierEvent.sequence));
      await upsertMeterRow(tx, branch.id, resolution.meter, modifierEvent.sequence);
      const lastSequence = resolution.events[resolution.events.length - 1]?.sequence ?? modifierEvent.sequence;
      await advanceLockedBranch(tx, branch, lastSequence);

      return {
        status: "accepted",
        commandId: command.id,
        branchVersion: branch.version + 1,
        firstSequence: modifierEvent.sequence,
        lastSequence,
        eventIds: resolution.events.map((event) => event.id),
      };
    },
  });
}

/** Apply one categorical condition with owned modifiers and optional expiry. */
export async function submitDurableApplyBodyCondition(
  rawCommand: unknown,
  options: BodyStoreOptions = {},
): Promise<ApplyBodyConditionCommandResult> {
  return runSimulationCommand({
    rawCommand,
    commandSchema: applyBodyConditionCommandSchema,
    resultSchema: applyBodyConditionCommandResultSchema,
    invalidResult: () => rejectedResult("invalid", "invalid_command", "That body request is invalid."),
    branchUnavailableResult: (commandId) =>
      rejectedResult(commandId, "branch_mismatch", "That world branch is unavailable."),
    duplicateCommandIdResult: (commandId) =>
      rejectedResult(commandId, "duplicate_command_id", "That state has already been submitted."),
    conflictResult: (commandId, currentVersion) =>
      applyBodyConditionCommandResultSchema.parse({
        status: "conflict",
        commandId,
        currentVersion,
        retryable: true,
      }),
    database: options.database,
    admitAtLockedVersion: options.admitAtLockedVersion,
    execute: async (tx, branch: LockedBranchView, command) => {
      const body = await loadActorBody(tx, branch.id, command.payload.actorId);
      const meterViews = new Map<string, MeterIntegrationView>();
      for (const spec of command.payload.modifiers) {
        const view = meterViewOf(body, spec.meterKey);
        if (view) meterViews.set(spec.meterKey, view);
      }
      const resolution = resolveApplyBodyCondition(
        {
          worldId: branch.worldId,
          branchId: branch.id,
          rulesetVersion: branch.rulesetVersion,
          headSequence: branch.headSequence,
          storySecond: branch.storySecond,
          bodyInitialized: body.meters.length > 0,
          activeSameKey: body.conditions.some(
            (condition) => condition.status === "active" && condition.key === command.payload.conditionKey,
          ),
          meterViews,
        },
        command,
      );
      if (!resolution.ok) return rejectedResult(command.id, resolution.code, resolution.publicReason);

      const [conditionEvent, ...trailing] = resolution.events;
      await appendSimulationEvent(tx, conditionEvent);
      await tx
        .insert(simBodyConditions)
        .values(bodyConditionRowInsert(branch.id, resolution.condition, conditionEvent.sequence));
      for (const meterKey of resolution.meters.keys()) {
        await retirePendingThresholdTriggers(
          tx,
          branch,
          command.id,
          command.submittedAtWallClock,
          command.payload.actorId,
          meterKey,
        );
      }
      for (const event of trailing) {
        await appendSimulationEvent(tx, event);
        if (event.type === "trigger_scheduled") {
          await applyTriggerScheduledEvent(tx, event, { branchId: branch.id, worldId: branch.worldId });
        }
      }
      if (resolution.modifiers.length > 0) {
        await tx
          .insert(simBodyModifiers)
          .values(
            resolution.modifiers.map((modifier) =>
              bodyModifierRowInsert(branch.id, modifier, conditionEvent.sequence),
            ),
          );
      }
      for (const meter of resolution.meters.values()) {
        await upsertMeterRow(tx, branch.id, meter, conditionEvent.sequence);
      }
      const lastSequence = resolution.events[resolution.events.length - 1]?.sequence ?? conditionEvent.sequence;
      await advanceLockedBranch(tx, branch, lastSequence);

      return {
        status: "accepted",
        commandId: command.id,
        branchVersion: branch.version + 1,
        firstSequence: conditionEvent.sequence,
        lastSequence,
        eventIds: resolution.events.map((event) => event.id),
      };
    },
  });
}

/** End one condition (explicit clear, or the expiry trigger's dispatch). */
export async function submitDurableEndBodyCondition(
  rawCommand: unknown,
  options: BodyStoreOptions = {},
): Promise<EndBodyConditionCommandResult> {
  return runSimulationCommand({
    rawCommand,
    commandSchema: endBodyConditionCommandSchema,
    resultSchema: endBodyConditionCommandResultSchema,
    invalidResult: () => rejectedResult("invalid", "invalid_command", "That body request is invalid."),
    branchUnavailableResult: (commandId) =>
      rejectedResult(commandId, "branch_mismatch", "That world branch is unavailable."),
    duplicateCommandIdResult: (commandId) =>
      rejectedResult(commandId, "duplicate_command_id", "That ending has already been submitted."),
    conflictResult: (commandId, currentVersion) =>
      endBodyConditionCommandResultSchema.parse({
        status: "conflict",
        commandId,
        currentVersion,
        retryable: true,
      }),
    database: options.database,
    admitAtLockedVersion: options.admitAtLockedVersion,
    execute: async (tx, branch: LockedBranchView, command) => {
      const body = await loadActorBody(tx, branch.id, command.payload.actorId);
      const condition = body.conditions.find((candidate) => candidate.id === command.payload.conditionId);
      const ownedModifiers = body.modifiers.filter(
        (modifier) =>
          modifier.conditionId === command.payload.conditionId &&
          (modifier.validUntilStorySecond === undefined ||
            modifier.validUntilStorySecond > branch.storySecond),
      );
      const meterViews = new Map<string, MeterIntegrationView>();
      for (const modifier of ownedModifiers) {
        const view = meterViewOf(body, modifier.meterKey);
        if (view) meterViews.set(modifier.meterKey, view);
      }
      const resolution = resolveEndBodyCondition(
        {
          worldId: branch.worldId,
          branchId: branch.id,
          rulesetVersion: branch.rulesetVersion,
          headSequence: branch.headSequence,
          storySecond: branch.storySecond,
          ...(condition ? { condition } : {}),
          ownedModifiers,
          meterViews,
        },
        command,
      );
      if (!resolution.ok) return rejectedResult(command.id, resolution.code, resolution.publicReason);

      const [endedEvent, ...triggers] = resolution.events;
      await appendSimulationEvent(tx, endedEvent);
      await retirePendingExpiryTrigger(
        tx,
        branch,
        command.id,
        command.submittedAtWallClock,
        command.payload.conditionId,
      );
      for (const meterKey of resolution.meters.keys()) {
        await retirePendingThresholdTriggers(
          tx,
          branch,
          command.id,
          command.submittedAtWallClock,
          command.payload.actorId,
          meterKey,
        );
      }
      for (const trigger of triggers) {
        await appendSimulationEvent(tx, trigger);
        await applyTriggerScheduledEvent(tx, trigger, { branchId: branch.id, worldId: branch.worldId });
      }
      const [updatedCondition] = await tx
        .update(simBodyConditions)
        .set({
          status: "ended",
          endBasis: command.payload.basis,
          updatedSequence: endedEvent.sequence,
        })
        .where(
          and(
            eq(simBodyConditions.branchId, branch.id),
            eq(simBodyConditions.conditionId, command.payload.conditionId),
            eq(simBodyConditions.status, "active"),
          ),
        )
        .returning({ conditionId: simBodyConditions.conditionId });
      if (!updatedCondition) throw new Error("Locked body condition changed before its ending update");
      for (const retired of endedEvent.payload.retiredModifiers) {
        await tx
          .update(simBodyModifiers)
          .set({
            // Mirror the projector: close validity at the ending boundary,
            // clamped to a legal (non-empty) interval.
            validUntil: sql`greatest(${branch.storySecond}, ${simBodyModifiers.validFrom} + 1)`,
            updatedSequence: endedEvent.sequence,
          })
          .where(
            and(eq(simBodyModifiers.branchId, branch.id), eq(simBodyModifiers.modifierId, retired.modifierId)),
          );
      }
      for (const meter of resolution.meters.values()) {
        await upsertMeterRow(tx, branch.id, meter, endedEvent.sequence);
      }
      const lastSequence = resolution.events[resolution.events.length - 1]?.sequence ?? endedEvent.sequence;
      await advanceLockedBranch(tx, branch, lastSequence);

      return {
        status: "accepted",
        commandId: command.id,
        branchVersion: branch.version + 1,
        firstSequence: endedEvent.sequence,
        lastSequence,
        eventIds: resolution.events.map((event) => event.id),
      };
    },
  });
}

/** Resolve one meter's due threshold (trigger-dispatched; re-validated now). */
export async function submitDurableResolveBodyThreshold(
  rawCommand: unknown,
  options: BodyStoreOptions = {},
): Promise<ResolveBodyThresholdCommandResult> {
  return runSimulationCommand({
    rawCommand,
    commandSchema: resolveBodyThresholdCommandSchema,
    resultSchema: resolveBodyThresholdCommandResultSchema,
    invalidResult: () => rejectedResult("invalid", "invalid_command", "That body request is invalid."),
    branchUnavailableResult: (commandId) =>
      rejectedResult(commandId, "branch_mismatch", "That world branch is unavailable."),
    duplicateCommandIdResult: (commandId) =>
      rejectedResult(commandId, "duplicate_command_id", "That limit has already been resolved."),
    conflictResult: (commandId, currentVersion) =>
      resolveBodyThresholdCommandResultSchema.parse({
        status: "conflict",
        commandId,
        currentVersion,
        retryable: true,
      }),
    database: options.database,
    admitAtLockedVersion: options.admitAtLockedVersion,
    execute: async (tx, branch: LockedBranchView, command) => {
      const body = await loadActorBody(tx, branch.id, command.payload.actorId);
      const meterView = meterViewOf(body, command.payload.meterKey);
      const definition = meterView?.definition;
      const threshold = definition?.thresholds.find(
        (candidate) => candidate.key === command.payload.thresholdKey,
      );
      const coLocatedActorIds =
        threshold?.noticeable === true
          ? await loadCoLocatedActorIds(tx, branch.id, command.payload.actorId)
          : [];
      const resolution = resolveBodyThreshold(
        {
          worldId: branch.worldId,
          branchId: branch.id,
          rulesetVersion: branch.rulesetVersion,
          headSequence: branch.headSequence,
          storySecond: branch.storySecond,
          ...(meterView ? { meter: meterView.state, definition: meterView.definition } : {}),
          modifiers: meterView?.modifiers ?? [],
          ...(threshold?.outcome.kind === "condition_onset"
            ? {
                activeOutcomeConditionKey: body.conditions.some(
                  (condition) =>
                    condition.status === "active" &&
                    threshold.outcome.kind === "condition_onset" &&
                    condition.key === threshold.outcome.conditionKey,
                ),
              }
            : {}),
          coLocatedActorIds,
        },
        command,
      );
      if (!resolution.ok) return rejectedResult(command.id, resolution.code, resolution.publicReason);

      const [crossedEvent, ...trailing] = resolution.events;
      await appendSimulationEvent(tx, crossedEvent);
      await retirePendingThresholdTriggers(
        tx,
        branch,
        command.id,
        command.submittedAtWallClock,
        command.payload.actorId,
        command.payload.meterKey,
      );
      for (const event of trailing) {
        await appendSimulationEvent(tx, event);
        if (event.type === "trigger_scheduled") {
          await applyTriggerScheduledEvent(tx, event, { branchId: branch.id, worldId: branch.worldId });
        }
      }
      if (resolution.condition) {
        await tx
          .insert(simBodyConditions)
          .values(bodyConditionRowInsert(branch.id, resolution.condition, crossedEvent.sequence));
      }
      await upsertMeterRow(tx, branch.id, resolution.meter, crossedEvent.sequence);
      const lastSequence = resolution.events[resolution.events.length - 1]?.sequence ?? crossedEvent.sequence;
      await advanceLockedBranch(tx, branch, lastSequence);

      return {
        status: "accepted",
        commandId: command.id,
        branchVersion: branch.version + 1,
        firstSequence: crossedEvent.sequence,
        lastSequence,
        eventIds: resolution.events.map((event) => event.id),
      };
    },
  });
}
