import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
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
  resolveBodyCollapseCommandResultSchema,
  resolveBodyCollapseCommandSchema,
  resolveBodyThresholdCommandResultSchema,
  resolveBodyThresholdCommandSchema,
  type ApplyBodyConditionCommandResult,
  type ApplyBodyModifierCommandResult,
  type ApplyBodySourceCommandResult,
  type BodiesProjection,
  type BodyCondition,
  type BodyMeterState,
  type BodyModifier,
  type BodyRhythmRow,
  bodyRhythmRowSchema,
  type EndBodyConditionCommandResult,
  type InitializeActorBodyCommandResult,
  type ResolveBodyCollapseCommandResult,
  type ResolveBodyThresholdCommandResult,
} from "@/contracts/simulation/bodies";
import type { SimulationBranchEvent } from "@/contracts/simulation/branching";
import { worldBranchIdSchema } from "@/contracts/simulation/identity";
import { actorLodStateSchema, isBelowEventLod } from "@/contracts/simulation/lod";
import { effectiveActorLod } from "@/lib/simulation/lod";
import { buildRoutinePolicyTrigger, nextRoutineBoundarySecond } from "@/lib/simulation/routine";
import {
  BODY_THRESHOLD_HORIZON_SECONDS,
  bodyCollapseUniquenessKeyPrefix,
  bodyConditionExpiryUniquenessKey,
  bodyThresholdUniquenessKeyPrefix,
  resolveBodyCollapse,
  type CollapseContext,
  integrateMeterValue,
  normalizeConditionModifierSpecs,
  selfCareAdjustmentsBetween,
  resolveApplyBodyCondition,
  resolveApplyBodyModifier,
  resolveApplyBodySource,
  resolveBodyThreshold,
  resolveEndBodyCondition,
  resolveInitializeActorBody,
  type MeterIntegrationView,
} from "@/lib/simulation/bodies";
import {
  deriveCircadianPressure,
  deriveEnergyRead,
  deriveIntimacyRead,
  deriveVisibleBodySigns,
  type EnergyRead,
} from "@/lib/simulation/body-reads";
import { cutBodilyReadsSchema, type CutBodilyReads } from "@/contracts/simulation/narrative";
import { claimHoldingActivityPhases } from "@/contracts/simulation/activities";
import { activityCompletionUniquenessKey } from "@/lib/simulation/activities";
import { claimHoldingEngagementStates, engagementSchema } from "@/contracts/simulation/engagements";
import {
  db,
  simActivities,
  simActorLods,
  simBodyConditions,
  simBodyMeters,
  simBodyModifiers,
  simBodyRhythms,
  simBranches,
  simCharacters,
  simEngagements,
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
import { activityFromRow } from "./activity-store";
import { applyTriggerScheduledEvent, type SimTx } from "./trigger-projector";

type DbExecutor = Db | SimTx;

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
    ...(row.endedAt === null ? {} : { endedAtStorySecond: row.endedAt }),
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
    endedAt: condition.endedAtStorySecond ?? null,
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

export function bodyRhythmFromRow(row: typeof simBodyRhythms.$inferSelect): BodyRhythmRow {
  return bodyRhythmRowSchema.parse({
    actorId: row.actorId,
    kind: row.kind,
    startMinuteOfDay: row.startMinuteOfDay,
    endMinuteOfDay: row.endMinuteOfDay,
  });
}

export function bodyRhythmRowInsert(
  branchId: string,
  row: BodyRhythmRow,
): typeof simBodyRhythms.$inferInsert {
  return {
    branchId,
    actorId: row.actorId,
    kind: row.kind,
    startMinuteOfDay: row.startMinuteOfDay,
    endMinuteOfDay: row.endMinuteOfDay,
  };
}

const bodyRhythmSeedSchema = z
  .object({
    branchId: worldBranchIdSchema,
    rows: z.array(bodyRhythmRowSchema).min(1),
  })
  .strict();

export type BodyRhythmSeed = z.input<typeof bodyRhythmSeedSchema>;

/**
 * Seed or extend one branch's rhythm rows (§25.5). Rhythms are authored data
 * read at integration time; every material event captures its derivation, so
 * replay never needs the rows and adding them mid-history is safe — though
 * alarms armed before a seed re-validate at fire time and may retire stale.
 * Seed rhythms before initializing bodies to keep initial alarms exact.
 */
export async function seedDurableBodyRhythms(
  rawSeed: BodyRhythmSeed,
  options: { database?: Db } = {},
): Promise<void> {
  const seed = bodyRhythmSeedSchema.parse(rawSeed);
  const database = options.database ?? db();
  await database.transaction(async (tx) => {
    const [branch] = await tx
      .select({ id: simBranches.id })
      .from(simBranches)
      .where(eq(simBranches.id, seed.branchId))
      .limit(1);
    if (!branch) throw new Error("Cannot seed body rhythms onto an unavailable branch");
    await tx.insert(simBodyRhythms).values(seed.rows.map((row) => bodyRhythmRowInsert(seed.branchId, row)));
  });
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

export interface ActorBodyRows {
  meters: BodyMeterState[];
  conditions: BodyCondition[];
  modifiers: BodyModifier[];
  rhythms: BodyRhythmRow[];
}

/** Exported for the E6.2 routine controller (routine-store.ts). */
export async function loadActorBody(tx: DbExecutor, branchId: string, actorId: string): Promise<ActorBodyRows> {
  const [meterRows, conditionRows, modifierRows, rhythmRows] = await Promise.all([
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
    tx
      .select()
      .from(simBodyRhythms)
      .where(and(eq(simBodyRhythms.branchId, branchId), eq(simBodyRhythms.actorId, actorId)))
      .orderBy(asc(simBodyRhythms.kind), asc(simBodyRhythms.startMinuteOfDay)),
  ]);
  return {
    meters: meterRows.map(bodyMeterFromRow),
    conditions: conditionRows.map(bodyConditionFromRow),
    modifiers: modifierRows.map(bodyModifierFromRow),
    rhythms: rhythmRows.map(bodyRhythmFromRow),
  };
}

/**
 * The kernel's per-meter integration view over one actor's loaded rows.
 * Rhythm self-care crossings enter as scheduled adjustments through the
 * solve horizon, so every material integration folds the §25.5 window law.
 */
export function meterViewOf(
  body: ActorBodyRows,
  meterKey: string,
  throughStorySecond: number,
): MeterIntegrationView | undefined {
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
    scheduledAdjustments: selfCareAdjustmentsBetween(
      body.rhythms,
      meterKey,
      state.lastIntegratedAtStorySecond,
      throughStorySecond,
    ),
  };
}

/** Retire this meter's pending alarm so it can never fire against stale state. */
export async function retirePendingThresholdTriggers(
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
  // Any material energy change also invalidates the actor's collapse alarm
  // (E5.2) — the same command re-arms the live one, mirroring replay.
  if (meterKey === "energy") {
    await retirePendingCollapseTriggers(tx, branch, commandId, submittedAtWallClock, actorId);
  }
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

/** The most recent second the actor actually finished sleeping, if any. */
function lastSleepEndedAtOf(conditions: readonly BodyCondition[]): number | undefined {
  return conditions
    .filter(
      (condition) =>
        condition.key === "asleep" &&
        condition.status === "ended" &&
        condition.endedAtStorySecond !== undefined,
    )
    .reduce<number | undefined>(
      (latest, condition) =>
        latest === undefined || (condition.endedAtStorySecond ?? 0) > latest
          ? condition.endedAtStorySecond
          : latest,
      undefined,
    );
}

/** Exported for the E6.3 LOD-assignment body-alarm re-arm (lod-store.ts). */
export function collapseContextOf(body: ActorBodyRows): CollapseContext {
  const lastSleepEndedAt = lastSleepEndedAtOf(body.conditions);
  return {
    rhythmRows: body.rhythms,
    ...(lastSleepEndedAt === undefined ? {} : { lastSleepEndedAtStorySecond: lastSleepEndedAt }),
  };
}

/** Retire the actor's pending collapse alarm (any arming attempt). */
export async function retirePendingCollapseTriggers(
  tx: SimTx,
  branch: LockedBranchView,
  commandId: string,
  submittedAtWallClock: string,
  actorId: string,
): Promise<void> {
  const prefix = bodyCollapseUniquenessKeyPrefix(actorId);
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

export async function upsertMeterRow(
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

/**
 * Co-located same-zone actors (excluding the subject) for witness capture.
 * Exported: material-store.ts's item-condition commands (E5.3 slice 3, §26.7)
 * reuse this same zone join for their own noticeable-threshold witnessing —
 * an item condition command's acting actor is always co-located with the
 * item's root zone (the `root_not_colocated` check enforces it), so this is
 * exactly "co-located with the item" for that case.
 */
export async function loadCoLocatedActorIds(tx: SimTx, branchId: string, actorId: string): Promise<string[]> {
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
      const existingMeterRows = await tx
        .select({ meterKey: simBodyMeters.meterKey })
        .from(simBodyMeters)
        .where(
          and(eq(simBodyMeters.branchId, branch.id), eq(simBodyMeters.actorId, command.payload.actorId)),
        );

      const rhythmRows = (
        await tx
          .select()
          .from(simBodyRhythms)
          .where(
            and(eq(simBodyRhythms.branchId, branch.id), eq(simBodyRhythms.actorId, command.payload.actorId)),
          )
      ).map(bodyRhythmFromRow);
      const selfCareAdjustmentsByMeter = new Map(
        bodyMeterRegistryByVersion[command.payload.registryVersion].map((definition) => [
          definition.key,
          selfCareAdjustmentsBetween(
            rhythmRows,
            definition.key,
            branch.storySecond,
            branch.storySecond + BODY_THRESHOLD_HORIZON_SECONDS,
          ),
        ]),
      );
      // E6.3: a body initialized for an actor already below `event` arms no
      // alarms — the dormant no-work law holds on every path. (Read inline
      // rather than through lod-store's seam: body-store must not import
      // lod-store, which imports back.)
      const [lodRow] = await tx
        .select()
        .from(simActorLods)
        .where(and(eq(simActorLods.branchId, branch.id), eq(simActorLods.actorId, command.payload.actorId)))
        .limit(1);
      const effectiveLod = effectiveActorLod(
        lodRow
          ? actorLodStateSchema.parse({
              actorId: lodRow.actorId,
              simulationLod: lodRow.simulationLod,
              inferenceLod: lodRow.inferenceLod,
              registryVersion: lodRow.registryVersion,
              assignedAtStorySecond: lodRow.assignedAtStorySecond,
            })
          : undefined,
      );
      const resolution = resolveInitializeActorBody(
        {
          worldId: branch.worldId,
          branchId: branch.id,
          rulesetVersion: branch.rulesetVersion,
          headSequence: branch.headSequence,
          storySecond: branch.storySecond,
          actorExists: actorRow !== undefined,
          existingMeterKeys: existingMeterRows.map((row) => row.meterKey),
          selfCareAdjustmentsByMeter,
          armAlarms: !isBelowEventLod(effectiveLod.simulationLod),
        },
        command,
      );
      if (!resolution.ok) return rejectedResult(command.id, resolution.code, resolution.publicReason);

      const [initialized] = resolution.events;
      // E6.4: a body initialized for an actor ALREADY AT `event` LOD also
      // arms the routine alarm — before this, only `assign_actor_lod` armed
      // it (E6.2 requires a tracked body at assignment time), so an actor who
      // landed at `event` first and gained a body second (a promoted actor's
      // canonical order) had no background life until an extra assignment.
      // The E6.2 invariant is one law either way: an event-LOD actor with a
      // tracked body has exactly one live routine alarm. (The arm lives here
      // rather than in the lib resolver because lib/routine imports
      // lib/bodies — the reverse import would cycle.)
      const events: SimulationBranchEvent[] = [...resolution.events];
      if (effectiveLod.simulationLod === "event") {
        const lastResolved = events[events.length - 1] ?? initialized;
        events.push(
          buildRoutinePolicyTrigger({
            view: {
              worldId: branch.worldId,
              branchId: branch.id,
              rulesetVersion: branch.rulesetVersion,
              headSequence: branch.headSequence,
              storySecond: branch.storySecond,
            },
            command,
            sequence: lastResolved.sequence + 1,
            causationId: initialized.id,
            actorId: command.payload.actorId,
            suffix: "init-arm-routine-policy",
            dueStorySecond: nextRoutineBoundarySecond(rhythmRows, branch.storySecond),
          }),
        );
      }
      await appendSimulationEvent(tx, initialized);
      for (const event of events) {
        if (event === initialized) continue;
        await appendSimulationEvent(tx, event);
        if (event.type === "trigger_scheduled") {
          await applyTriggerScheduledEvent(tx, event, { branchId: branch.id, worldId: branch.worldId });
        }
      }
      await tx
        .insert(simBodyMeters)
        .values(resolution.meters.map((meter) => bodyMeterRowInsert(branch.id, meter, initialized.sequence)));
      const lastSequence = events[events.length - 1]?.sequence ?? initialized.sequence;
      await advanceLockedBranch(tx, branch, lastSequence);

      return {
        status: "accepted",
        commandId: command.id,
        branchVersion: branch.version + 1,
        firstSequence: initialized.sequence,
        lastSequence,
        eventIds: events.map((event) => event.id),
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
      const horizon = branch.storySecond + BODY_THRESHOLD_HORIZON_SECONDS;
      const meterView = meterViewOf(body, command.payload.meterKey, horizon);
      // §25.4 coupling inputs: the hygiene view for exertion-on-energy, and
      // whether an afterglow already holds for climax-on-arousal.
      const coupledHygiene =
        command.payload.sourceKind === "exertion" && command.payload.meterKey === "energy"
          ? meterViewOf(body, "hygiene", horizon)
          : undefined;
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
          scheduledAdjustments: meterView?.scheduledAdjustments ?? [],
          activeAfterglow: body.conditions.some(
            (candidate) => candidate.status === "active" && candidate.key === "afterglow",
          ),
          ...(coupledHygiene ? { coupledHygiene } : {}),
          collapseContext: collapseContextOf(body),
        },
        command,
      );
      if (!resolution.ok) return rejectedResult(command.id, resolution.code, resolution.publicReason);

      const [sourceEvent, ...trailing] = resolution.events;
      await appendSimulationEvent(tx, sourceEvent);
      await retirePendingThresholdTriggers(
        tx,
        branch,
        command.id,
        command.submittedAtWallClock,
        command.payload.actorId,
        command.payload.meterKey,
      );
      if (resolution.coupledMeter) {
        await retirePendingThresholdTriggers(
          tx,
          branch,
          command.id,
          command.submittedAtWallClock,
          command.payload.actorId,
          resolution.coupledMeter.meterKey,
        );
      }
      for (const event of trailing) {
        await appendSimulationEvent(tx, event);
        if (event.type === "trigger_scheduled") {
          await applyTriggerScheduledEvent(tx, event, { branchId: branch.id, worldId: branch.worldId });
        }
      }
      if (resolution.condition) {
        await tx
          .insert(simBodyConditions)
          .values(bodyConditionRowInsert(branch.id, resolution.condition, sourceEvent.sequence));
      }
      await upsertMeterRow(tx, branch.id, resolution.meter, sourceEvent.sequence);
      if (resolution.coupledMeter) {
        await upsertMeterRow(tx, branch.id, resolution.coupledMeter, sourceEvent.sequence);
      }
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
      const meterView = meterViewOf(body, command.payload.modifier.meterKey, branch.storySecond + BODY_THRESHOLD_HORIZON_SECONDS);
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
          scheduledAdjustments: meterView?.scheduledAdjustments ?? [],
          collapseContext: collapseContextOf(body),
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
      // The §25.4 sleep coupling adds an energy suspend to asleep conditions,
      // so the energy view must load even when the caller sent no modifiers.
      for (const spec of normalizeConditionModifierSpecs(
        command.payload.conditionKey,
        command.payload.modifiers,
      )) {
        const view = meterViewOf(body, spec.meterKey, branch.storySecond + BODY_THRESHOLD_HORIZON_SECONDS);
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
          collapseContext: collapseContextOf(body),
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
      // A condition-owned modifier whose validity closes exactly at this
      // second (the expiry boundary itself) is still this ending's to retire
      // — only modifiers already dead strictly before now are excluded.
      const ownedModifiers = body.modifiers.filter(
        (modifier) =>
          modifier.conditionId === command.payload.conditionId &&
          (modifier.validUntilStorySecond === undefined ||
            modifier.validUntilStorySecond >= branch.storySecond),
      );
      const meterViews = new Map<string, MeterIntegrationView>();
      for (const modifier of ownedModifiers) {
        const view = meterViewOf(body, modifier.meterKey, branch.storySecond + BODY_THRESHOLD_HORIZON_SECONDS);
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
          collapseContext: collapseContextOf(body),
        },
        command,
      );
      if (!resolution.ok) return rejectedResult(command.id, resolution.code, resolution.publicReason);

      const [endedEvent, ...trailing] = resolution.events;
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
      for (const event of trailing) {
        await appendSimulationEvent(tx, event);
        if (event.type === "trigger_scheduled") {
          await applyTriggerScheduledEvent(tx, event, { branchId: branch.id, worldId: branch.worldId });
        }
      }
      const [updatedCondition] = await tx
        .update(simBodyConditions)
        .set({
          status: "ended",
          endBasis: command.payload.basis,
          endedAt: branch.storySecond,
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
      const meterView = meterViewOf(body, command.payload.meterKey, branch.storySecond + BODY_THRESHOLD_HORIZON_SECONDS);
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
          scheduledAdjustments: meterView?.scheduledAdjustments ?? [],
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
          collapseContext: collapseContextOf(body),
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

// ---------------------------------------------------------------------------
// E5.2 — the durable read surface (engine.spec §25.1 layer 3)
// ---------------------------------------------------------------------------

export interface DurableEnergyRead {
  actorId: string;
  reserveFixedPoint: number;
  pressureFixedPoint: number;
  read: EnergyRead;
}

/**
 * Per-actor energy reads at the branch's current story second: reserve
 * integrated purely (nothing persists), circadian pressure derived from the
 * actor's own rhythm and last real sleep, the signed axis clamped at its
 * saturating poles. Layer-3 only — the raw meters never leave this seam.
 */
export async function readDurableBodyReads(
  rawBranchId: string,
  database: Db = db(),
): Promise<{ branchId: string; storySecond: number; energy: DurableEnergyRead[] }> {
  const branchId = worldBranchIdSchema.parse(rawBranchId);
  const [branch] = await database
    .select({ storySecond: simBranches.storySecond })
    .from(simBranches)
    .where(eq(simBranches.id, branchId))
    .limit(1);
  if (!branch) throw new Error("Simulation branch not found");
  const [meterRows, modifierRows, rhythmRows, conditionRows] = await Promise.all([
    database
      .select()
      .from(simBodyMeters)
      .where(and(eq(simBodyMeters.branchId, branchId), eq(simBodyMeters.meterKey, "energy")))
      .orderBy(asc(simBodyMeters.actorId)),
    database
      .select()
      .from(simBodyModifiers)
      .where(and(eq(simBodyModifiers.branchId, branchId), eq(simBodyModifiers.meterKey, "energy"))),
    database.select().from(simBodyRhythms).where(eq(simBodyRhythms.branchId, branchId)),
    database
      .select()
      .from(simBodyConditions)
      .where(and(eq(simBodyConditions.branchId, branchId), eq(simBodyConditions.key, "asleep"))),
  ]);
  const energy: DurableEnergyRead[] = [];
  for (const meterRow of meterRows) {
    const state = bodyMeterFromRow(meterRow);
    const parsedVersion = bodyRegistryVersionSchema.safeParse(state.registryVersion);
    if (!parsedVersion.success) continue;
    const definition = bodyMeterRegistryByVersion[parsedVersion.data].find(
      (candidate) => candidate.key === "energy",
    );
    if (!definition) continue;
    const reserveFixedPoint = integrateMeterValue(
      {
        definition,
        state,
        modifiers: modifierRows
          .filter((row) => row.actorId === state.actorId)
          .map(bodyModifierFromRow),
      },
      branch.storySecond,
    );
    const lastSleepEndedAt = conditionRows
      .filter((row) => row.actorId === state.actorId && row.status === "ended" && row.endedAt !== null)
      .reduce<number | undefined>(
        (latest, row) => (latest === undefined || (row.endedAt ?? 0) > latest ? (row.endedAt ?? 0) : latest),
        undefined,
      );
    const pressureFixedPoint = deriveCircadianPressure({
      atStorySecond: branch.storySecond,
      rhythmRows: rhythmRows.filter((row) => row.actorId === state.actorId).map(bodyRhythmFromRow),
      ...(lastSleepEndedAt === undefined ? {} : { lastSleepEndedAtStorySecond: lastSleepEndedAt }),
    });
    energy.push({
      actorId: state.actorId,
      reserveFixedPoint,
      pressureFixedPoint,
      read: deriveEnergyRead({ reserveFixedPoint, pressureFixedPoint }),
    });
  }
  return { branchId, storySecond: branch.storySecond, energy };
}

/**
 * E5.2 — the cut's body surface (§22.1 `bodilyReads`): the viewpoint's own
 * energy read and intimacy pulse, plus each co-present actor's perceivable
 * signs at engaged-attention tier. Pure over loaded rows; empty when bodies
 * are uninitialized, so pre-Gate-5 worlds compile identical cuts.
 */
export async function computeEngagementBodilyReads(
  executor: DbExecutor,
  input: {
    branchId: string;
    storySecond: number;
    viewpointActorId: string;
    coPresentActorIds: readonly string[];
  },
): Promise<CutBodilyReads> {
  const actorIds = [...new Set([input.viewpointActorId, ...input.coPresentActorIds])];
  const bodies = new Map(
    await Promise.all(
      actorIds.map(
        async (actorId) => [actorId, await loadActorBody(executor, input.branchId, actorId)] as const,
      ),
    ),
  );

  const readOf = (actorId: string) => {
    const body = bodies.get(actorId);
    if (!body) return undefined;
    const energyView = meterViewOf(body, "energy", input.storySecond);
    if (!energyView) return undefined;
    const reserveFixedPoint = integrateMeterValue(energyView, input.storySecond);
    const lastSleepEndedAt = lastSleepEndedAtOf(body.conditions);
    const pressureFixedPoint = deriveCircadianPressure({
      atStorySecond: input.storySecond,
      rhythmRows: body.rhythms,
      ...(lastSleepEndedAt === undefined ? {} : { lastSleepEndedAtStorySecond: lastSleepEndedAt }),
    });
    const arousalView = meterViewOf(body, "arousal", input.storySecond);
    return {
      energyRead: deriveEnergyRead({ reserveFixedPoint, pressureFixedPoint }),
      arousalFixedPoint: arousalView ? integrateMeterValue(arousalView, input.storySecond) : 0,
      afterglowActive: body.conditions.some(
        (condition) => condition.status === "active" && condition.key === "afterglow",
      ),
    };
  };

  const selfRead = readOf(input.viewpointActorId);
  const observed: { actorId: string; signs: ReturnType<typeof deriveVisibleBodySigns> }[] = [];
  for (const actorId of input.coPresentActorIds) {
    if (actorId === input.viewpointActorId) continue;
    const read = readOf(actorId);
    if (!read) continue;
    const signs = deriveVisibleBodySigns({ ...read, detailTier: 3 });
    if (signs.length > 0) observed.push({ actorId, signs });
  }
  return cutBodilyReadsSchema.parse({
    ...(selfRead === undefined
      ? {}
      : {
          self: {
            energySignedFixedPoint: selfRead.energyRead.signedFixedPoint,
            energyBand: selfRead.energyRead.band,
            intimacyPhase: deriveIntimacyRead(selfRead),
          },
        }),
    observed,
  });
}

/** Resolve one due collapse (trigger-dispatched; the read floor re-validated). */
export async function submitDurableResolveBodyCollapse(
  rawCommand: unknown,
  options: BodyStoreOptions = {},
): Promise<ResolveBodyCollapseCommandResult> {
  return runSimulationCommand({
    rawCommand,
    commandSchema: resolveBodyCollapseCommandSchema,
    resultSchema: resolveBodyCollapseCommandResultSchema,
    invalidResult: () => rejectedResult("invalid", "invalid_command", "That body request is invalid."),
    branchUnavailableResult: (commandId) =>
      rejectedResult(commandId, "branch_mismatch", "That world branch is unavailable."),
    duplicateCommandIdResult: (commandId) =>
      rejectedResult(commandId, "duplicate_command_id", "That collapse has already been resolved."),
    conflictResult: (commandId, currentVersion) =>
      resolveBodyCollapseCommandResultSchema.parse({
        status: "conflict",
        commandId,
        currentVersion,
        retryable: true,
      }),
    database: options.database,
    admitAtLockedVersion: options.admitAtLockedVersion,
    execute: async (tx, branch: LockedBranchView, command) => {
      const body = await loadActorBody(tx, branch.id, command.payload.actorId);
      const meterView = meterViewOf(body, "energy", branch.storySecond + BODY_THRESHOLD_HORIZON_SECONDS);
      const coLocatedActorIds = await loadCoLocatedActorIds(tx, branch.id, command.payload.actorId);
      const activityRows = await tx
        .select()
        .from(simActivities)
        .where(
          and(
            eq(simActivities.branchId, branch.id),
            inArray(simActivities.phase, [...claimHoldingActivityPhases]),
            sql`${simActivities.actorIds} @> ${JSON.stringify([command.payload.actorId])}::jsonb`,
          ),
        )
        .orderBy(asc(simActivities.activityInstanceId));
      const engagementRows = await tx
        .select()
        .from(simEngagements)
        .where(
          and(
            eq(simEngagements.branchId, branch.id),
            eq(simEngagements.channel, "co_present"),
            inArray(simEngagements.state, [...claimHoldingEngagementStates]),
            sql`${simEngagements.participantIds} @> ${JSON.stringify([command.payload.actorId])}::jsonb`,
          ),
        )
        .orderBy(asc(simEngagements.engagementId));

      const resolution = resolveBodyCollapse(
        {
          worldId: branch.worldId,
          branchId: branch.id,
          rulesetVersion: branch.rulesetVersion,
          headSequence: branch.headSequence,
          storySecond: branch.storySecond,
          ...(meterView ? { meter: meterView.state, definition: meterView.definition } : {}),
          modifiers: meterView?.modifiers ?? [],
          scheduledAdjustments: meterView?.scheduledAdjustments ?? [],
          collapseContext: collapseContextOf(body),
          activeAsleep: body.conditions.some(
            (condition) => condition.status === "active" && condition.key === "asleep",
          ),
          interruptibleActivities: activityRows
            .map(activityFromRow)
            .filter((activity) => activity.phase !== "interrupted"),
          openEngagements: engagementRows.map((row) =>
            engagementSchema.parse({
              id: row.engagementId,
              participantIds: row.participantIds,
              channel: row.channel,
              ...(row.locationId === null ? {} : { locationId: row.locationId }),
              ...(row.zoneId === null ? {} : { zoneId: row.zoneId }),
              state: row.state,
              openedAt: row.openedAt,
              attentionClaim: row.attentionClaim,
              sourceCommandId: row.sourceCommandId,
            }),
          ),
          coLocatedActorIds,
        },
        command,
      );
      if (!resolution.ok) return rejectedResult(command.id, resolution.code, resolution.publicReason);

      // The energy retirement also sweeps the collapse alarm itself.
      await retirePendingThresholdTriggers(
        tx,
        branch,
        command.id,
        command.submittedAtWallClock,
        command.payload.actorId,
        "energy",
      );
      for (const event of resolution.events) {
        await appendSimulationEvent(tx, event);
        if (event.type === "trigger_scheduled") {
          await applyTriggerScheduledEvent(tx, event, { branchId: branch.id, worldId: branch.worldId });
        }
      }
      const firstSequence = resolution.events[0]?.sequence ?? branch.headSequence + 1;
      await tx
        .insert(simBodyConditions)
        .values(bodyConditionRowInsert(branch.id, resolution.condition, firstSequence));
      await tx
        .insert(simBodyModifiers)
        .values(
          resolution.modifiers.map((modifier) => bodyModifierRowInsert(branch.id, modifier, firstSequence)),
        );
      await upsertMeterRow(tx, branch.id, resolution.meter, firstSequence);

      // Interrupt every held activity: phase + captured progress, and the
      // completion alarm retired (prefix: resumed keys included) — both
      // `pending` rows AND rows a scheduler worker has already claimed into
      // `processing` but not yet dispatched. That second half matters the
      // same way it does for `retirePendingRestockTriggers`
      // (household-store.ts): a completion alarm claimed just before this
      // collapse commits would otherwise survive as `processing`, and a
      // later resume (legal once `phase` reads `interrupted`, exactly what
      // this write produces) flips the activity back to `active` with a
      // LATER `expectedCompleteAt` — reactivating `resolveCompleteActivity`'s
      // `phase !== "active"` guard's blind spot. Its own fire-time
      // `completion_not_due` re-validation fails that stale dispatch closed
      // regardless, but retiring the claimed row here keeps the trigger
      // ledger honest (one live completion alarm, never two) and lets the
      // scheduler's own fenced completion write no-op to `lease_lost`
      // instead of burning an attempt on a certain rejection.
      for (const event of resolution.events) {
        if (event.type === "activity_interrupted") {
          await tx
            .update(simActivities)
            .set({
              phase: "interrupted",
              progressFixedPoint: event.payload.progressFixedPoint,
              updatedSequence: event.sequence,
            })
            .where(
              and(
                eq(simActivities.branchId, branch.id),
                eq(simActivities.activityInstanceId, event.payload.activityInstanceId),
              ),
            );
          await tx
            .update(simTriggers)
            .set({
              state: "completed",
              resultCommandId: command.id,
              completedAt: new Date(command.submittedAtWallClock),
            })
            .where(
              and(
                eq(simTriggers.branchId, branch.id),
                inArray(simTriggers.state, ["pending", "processing"]),
                sql`starts_with(${simTriggers.uniquenessKey}, ${activityCompletionUniquenessKey(event.payload.activityInstanceId)})`,
              ),
            );
        } else if (event.type === "engagement_interrupted") {
          await tx
            .update(simEngagements)
            .set({ state: "interrupted", updatedSequence: event.sequence })
            .where(
              and(
                eq(simEngagements.branchId, branch.id),
                eq(simEngagements.engagementId, event.payload.engagementId),
              ),
            );
        }
      }

      const lastSequence = resolution.events[resolution.events.length - 1]?.sequence ?? firstSequence;
      await advanceLockedBranch(tx, branch, lastSequence);

      return {
        status: "accepted",
        commandId: command.id,
        branchVersion: branch.version + 1,
        firstSequence,
        lastSequence,
        eventIds: resolution.events.map((event) => event.id),
      };
    },
  });
}
