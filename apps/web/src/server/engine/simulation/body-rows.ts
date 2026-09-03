import { and, asc, eq, sql } from "drizzle-orm";
import {
  bodyConditionSchema,
  bodyMeterStateSchema,
  bodyModifierSchema,
  bodyRhythmRowSchema,
  type BodyCondition,
  type BodyMeterState,
  type BodyModifier,
  type BodyRhythmRow,
} from "@vesper/simulation-core/contracts/bodies";
import {
  BODY_THRESHOLD_HORIZON_SECONDS,
  bodyCollapseUniquenessKeyPrefix,
  bodyConditionExpiryUniquenessKey,
  bodyThresholdUniquenessKeyPrefix,
  buildMeterView,
  collapseContextOf,
  type MeterIntegrationView,
} from "@vesper/simulation-core/bodies";
import type { ConsumptionBodyView } from "@vesper/simulation-core/materials";
import {
  simBodyConditions,
  simBodyMeters,
  simBodyModifiers,
  simBodyRhythms,
  simPhysicalLoci,
  simTriggers,
} from "@/server/db";
import type { LockedBranchView } from "./command-runner";
import type { SimTx } from "./trigger-projector";

/**
 * The E5.1 body ROW layer: every `sim_body_*` row mapping, the per-actor load,
 * the material-boundary meter write, and the alarm retirements — the substrate
 * body-store.ts's command shells, body-reads.ts's layer-3 reads, and the
 * material/activity lanes' own consumption paths all build on.
 *
 * This module is deliberately a LEAF: it imports no sibling store, which is
 * what lets activity-store.ts and material-store.ts share one copy of the body
 * substrate instead of the local duplicates they used to carry to dodge the
 * `material-store → body-store → activity-store` cycle.
 */

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

export interface ActorBodyRows {
  meters: BodyMeterState[];
  conditions: BodyCondition[];
  modifiers: BodyModifier[];
  rhythms: BodyRhythmRow[];
}

/** Exported for the E6.2 routine controller (routine-store.ts). */
export async function loadActorBody(tx: SimTx, branchId: string, actorId: string): Promise<ActorBodyRows> {
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
 * Build one actor's `ConsumptionBodyView` — meters, modifiers, rhythms,
 * and the collapse context's last-real-sleep fact — over the same rows every
 * body command loads. The ONE copy: the material lane's `consume_item`, the
 * activity lane's completion-time consumption, and the E6.2 routine
 * controller's `eat_meal` train all resolve through it.
 */
export async function loadConsumptionBodyView(
  tx: SimTx,
  branchId: string,
  actorId: string,
  storySecond: number,
): Promise<ConsumptionBodyView> {
  const body = await loadActorBody(tx, branchId, actorId);
  const horizon = storySecond + BODY_THRESHOLD_HORIZON_SECONDS;
  const meterView = (meterKey: string): MeterIntegrationView | undefined =>
    buildMeterView(body, meterKey, horizon);

  return {
    bodyInitialized: body.meters.length > 0,
    meterView,
    collapseContext: collapseContextOf(body),
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

export async function retirePendingExpiryTrigger(
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
 * Exported: material-store.ts's item-condition commands (E5.3 slice 3)
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
