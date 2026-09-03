import { and, asc, eq } from "drizzle-orm";
import {
  commitmentSchema,
  commitmentsProjectionSchema,
  createCommitmentCommandResultSchema,
  createCommitmentCommandSchema,
  fulfillCommitmentCommandResultSchema,
  fulfillCommitmentCommandSchema,
  raisePressureCommandResultSchema,
  raisePressureCommandSchema,
  resolveCommitmentDeadlineCommandResultSchema,
  resolveCommitmentDeadlineCommandSchema,
  temporalPressureSchema,
  type Commitment,
  type CommitmentsProjection,
  type CreateCommitmentCommandResult,
  type FulfillCommitmentCommandResult,
  type RaisePressureCommandResult,
  type ResolveCommitmentDeadlineCommandResult,
  type TemporalPressure,
} from "@vesper/simulation-core/contracts/commitments";
import { worldBranchIdSchema } from "@vesper/simulation-core/contracts/identity";
import {
  resolveCommitmentDeadline,
  resolveCreateCommitment,
  resolveFulfillCommitment,
  resolveRaisePressure,
} from "@vesper/simulation-core/commitments";
import {
  db,
  simBranches,
  simCharacters,
  simCommitments,
  simJourneys,
  simPhysicalLoci,
  simTemporalPressures,
  simZones,
  type Db,
} from "@/server/db";
import {
  advanceLockedBranch,
  appendSimulationEvent,
  runSimulationCommand,
  type LockedBranchView,
} from "./command-runner";
import { holdsLiveBeliefInAssertion, isLiveBeliefHeldBy } from "./knowledge-store";
import { hasObservationOfEvent } from "./observation-store";
import { journeyFromRow, loadSpaceRows, locusFromRow, spaceProjectionFromRows } from "./space-store";
import { applyTriggerScheduledEvent, type SimTx } from "./trigger-projector";

/**
 * E3.3 durable commitment authority. A commitment row is event-projected
 * state; its notice and deadline triggers are committed as trigger_scheduled
 * events in the creating transaction, so fork replay re-arms or retires them
 * exactly as live history did.
 */

export interface CommitmentStoreOptions {
  database?: Db;
  admitAtLockedVersion?: boolean;
}

export function commitmentFromRow(row: typeof simCommitments.$inferSelect): Commitment {
  return commitmentSchema.parse({
    id: row.commitmentId,
    actorId: row.actorId,
    kind: row.kind,
    ...(row.destinationZoneId === null ? {} : { destinationZoneId: row.destinationZoneId }),
    ...(row.promisedToActorId === null ? {} : { promisedToActorId: row.promisedToActorId }),
    ...(row.repairsCommitmentId === null ? {} : { repairsCommitmentId: row.repairsCommitmentId }),
    window: {
      ...(row.earliestArrival === null ? {} : { earliestArrival: row.earliestArrival }),
      ...(row.targetArrival === null ? {} : { targetArrival: row.targetArrival }),
      latestArrival: row.latestArrival,
    },
    ...(row.expectedDurationSeconds === null ? {} : { expectedDurationSeconds: row.expectedDurationSeconds }),
    priority: row.priority,
    flexibility: row.flexibility,
    preparationSeconds: row.preparationSeconds,
    reliabilityBufferSeconds: row.reliabilityBufferSeconds,
    noticeLeadSeconds: row.noticeLeadSeconds,
    status: row.status,
    knowledgeSource: row.knowledgeSource,
    sourceCommandId: row.sourceCommandId,
  });
}

export function commitmentRowInsert(
  branchId: string,
  commitment: Commitment,
  updatedSequence: number,
): typeof simCommitments.$inferInsert {
  return {
    branchId,
    commitmentId: commitment.id,
    actorId: commitment.actorId,
    kind: commitment.kind,
    destinationZoneId: commitment.destinationZoneId ?? null,
    promisedToActorId: commitment.promisedToActorId ?? null,
    repairsCommitmentId: commitment.repairsCommitmentId ?? null,
    earliestArrival: commitment.window.earliestArrival ?? null,
    targetArrival: commitment.window.targetArrival ?? null,
    latestArrival: commitment.window.latestArrival,
    expectedDurationSeconds: commitment.expectedDurationSeconds ?? null,
    priority: commitment.priority,
    flexibility: commitment.flexibility,
    preparationSeconds: commitment.preparationSeconds,
    reliabilityBufferSeconds: commitment.reliabilityBufferSeconds,
    noticeLeadSeconds: commitment.noticeLeadSeconds,
    status: commitment.status,
    knowledgeSource: commitment.knowledgeSource,
    sourceCommandId: commitment.sourceCommandId,
    updatedSequence,
  };
}

export function pressureRowInsert(
  branchId: string,
  pressure: TemporalPressure,
  updatedSequence: number,
): typeof simTemporalPressures.$inferInsert {
  return {
    branchId,
    pressureId: pressure.id,
    actorId: pressure.actorId,
    sourceCommitmentId: pressure.sourceCommitmentId,
    noticeAt: pressure.noticeAt,
    decideBy: pressure.decideBy,
    actBy: pressure.actBy,
    severity: pressure.severity,
    acknowledgedAt: pressure.acknowledgedAt ?? null,
    acknowledgedSeverity: pressure.acknowledgedSeverity ?? null,
    resolvedAt: pressure.resolvedAt ?? null,
    updatedSequence,
  };
}

/** Load the current typed commitments projection without a write lock, from one snapshot. */
export async function readDurableCommitments(
  rawBranchId: string,
  database: Db = db(),
): Promise<CommitmentsProjection> {
  const branchId = worldBranchIdSchema.parse(rawBranchId);
  return database.transaction((tx) => loadCommitmentsProjection(tx, branchId), {
    isolationLevel: "repeatable read",
    accessMode: "read only",
  });
}

/** Assemble the typed commitments projection inside a caller's transaction. */
export async function loadCommitmentsProjection(tx: SimTx, branchId: string): Promise<CommitmentsProjection> {
  const [branch] = await tx
    .select({
      headSequence: simBranches.headSequence,
      version: simBranches.version,
      storySecond: simBranches.storySecond,
    })
    .from(simBranches)
    .where(eq(simBranches.id, branchId))
    .limit(1);
  if (!branch) throw new Error("Simulation branch not found");
  const commitmentRows = await tx
    .select()
    .from(simCommitments)
    .where(eq(simCommitments.branchId, branchId))
    .orderBy(asc(simCommitments.commitmentId));
  const pressureRows = await tx
    .select()
    .from(simTemporalPressures)
    .where(eq(simTemporalPressures.branchId, branchId))
    .orderBy(asc(simTemporalPressures.pressureId));
  return commitmentsProjectionSchema.parse({
    branchId,
    headSequence: branch.headSequence,
    version: branch.version,
    storySecond: branch.storySecond,
    commitments: commitmentRows.map(commitmentFromRow),
    pressures: pressureRows.map((row) =>
      temporalPressureSchema.parse({
        id: row.pressureId,
        actorId: row.actorId,
        sourceCommitmentId: row.sourceCommitmentId,
        noticeAt: row.noticeAt,
        decideBy: row.decideBy,
        actBy: row.actBy,
        severity: row.severity,
        ...(row.acknowledgedAt === null ? {} : { acknowledgedAt: row.acknowledgedAt }),
        ...(row.acknowledgedSeverity === null ? {} : { acknowledgedSeverity: row.acknowledgedSeverity }),
        ...(row.resolvedAt === null ? {} : { resolvedAt: row.resolvedAt }),
      }),
    ),
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

async function loadCommitment(
  tx: SimTx,
  branchId: string,
  commitmentId: string,
): Promise<Commitment | undefined> {
  const [row] = await tx
    .select()
    .from(simCommitments)
    .where(and(eq(simCommitments.branchId, branchId), eq(simCommitments.commitmentId, commitmentId)))
    .limit(1);
  return row ? commitmentFromRow(row) : undefined;
}

/** Create one commitment: created event + notice and deadline triggers, atomically. */
/** The actor's derivation origin: their zone, or their journey's destination in transit. */
async function loadActorOriginSpace(tx: SimTx, branch: LockedBranchView, actorId: string | undefined) {
  const space = spaceProjectionFromRows(
    {
      worldId: branch.worldId,
      branchId: branch.id,
      rulesetVersion: branch.rulesetVersion,
      version: branch.version,
      headSequence: branch.headSequence,
      storySecond: branch.storySecond,
    },
    await loadSpaceRows(tx, branch.id),
  );
  const locus = actorId === undefined ? undefined : space.loci.find((candidate) => candidate.actorId === actorId);
  const originZoneId =
    locus === undefined
      ? undefined
      : locus.kind === "at"
        ? locus.zoneId
        : space.journeys.find((journey) => journey.id === locus.journeyId)?.destinationZoneId;
  return { space, originZoneId };
}

export async function submitDurableCreateCommitment(
  rawCommand: unknown,
  options: CommitmentStoreOptions = {},
): Promise<CreateCommitmentCommandResult> {
  return runSimulationCommand({
    rawCommand,
    commandSchema: createCommitmentCommandSchema,
    resultSchema: createCommitmentCommandResultSchema,
    invalidResult: () => rejectedResult("invalid", "invalid_command", "That obligation request is invalid."),
    branchUnavailableResult: (commandId) =>
      rejectedResult(commandId, "branch_mismatch", "That world branch is unavailable."),
    duplicateCommandIdResult: (commandId) =>
      rejectedResult(commandId, "duplicate_command_id", "That obligation has already been submitted."),
    conflictResult: (commandId, currentVersion) =>
      createCommitmentCommandResultSchema.parse({
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
      // E5.5 slice 2: a destinationless commitment names no destination to look up —
      // the query only runs when one was supplied (mechanical guard for the now-optional
      // payload field; the "only check when named" acceptance semantics are slice 2's
      // resolver work, not this loader's).
      const [destinationRow] =
        command.payload.destinationZoneId === undefined
          ? []
          : await tx
              .select({ zoneId: simZones.zoneId })
              .from(simZones)
              .where(
                and(
                  eq(simZones.branchId, branch.id),
                  eq(simZones.zoneId, command.payload.destinationZoneId),
                ),
              )
              .limit(1);
      const { space, originZoneId } = await loadActorOriginSpace(tx, branch, command.payload.actorId);

      // E5.5 slice 2: both loads are conditional on the payload naming them —
      // no cost when a commitment names neither a repair nor a promise target.
      const repairTargetRow =
        command.payload.repairsCommitmentId === undefined
          ? undefined
          : await loadCommitment(tx, branch.id, command.payload.repairsCommitmentId);
      const [promisedToActorRow] =
        command.payload.promisedToActorId === undefined
          ? []
          : await tx
              .select({ characterId: simCharacters.characterId })
              .from(simCharacters)
              .where(
                and(
                  eq(simCharacters.branchId, branch.id),
                  eq(simCharacters.characterId, command.payload.promisedToActorId),
                ),
              )
              .limit(1);

      const resolution = resolveCreateCommitment(
        {
          worldId: branch.worldId,
          branchId: branch.id,
          rulesetVersion: branch.rulesetVersion,
          headSequence: branch.headSequence,
          storySecond: branch.storySecond,
          actorExists: actorRow !== undefined,
          ...(originZoneId ? { originZoneId } : {}),
          destinationZoneExists: destinationRow !== undefined,
          topology: { locations: space.locations, zones: space.zones, links: space.links },
          ...(repairTargetRow
            ? {
                repairTarget: {
                  actorId: repairTargetRow.actorId,
                  kind: repairTargetRow.kind,
                  status: repairTargetRow.status,
                },
              }
            : {}),
          ...(command.payload.promisedToActorId === undefined
            ? {}
            : { promisedToActorExists: promisedToActorRow !== undefined }),
        },
        command,
      );
      if (!resolution.ok) return rejectedResult(command.id, resolution.code, resolution.publicReason);

      const [createdEvent, noticeTrigger, deadlineTrigger] = resolution.events;
      await appendSimulationEvent(tx, createdEvent);
      await appendSimulationEvent(tx, noticeTrigger);
      await appendSimulationEvent(tx, deadlineTrigger);
      await applyTriggerScheduledEvent(tx, noticeTrigger, { branchId: branch.id, worldId: branch.worldId });
      await applyTriggerScheduledEvent(tx, deadlineTrigger, { branchId: branch.id, worldId: branch.worldId });
      await tx
        .insert(simCommitments)
        .values(commitmentRowInsert(branch.id, resolution.commitment, createdEvent.sequence));
      await advanceLockedBranch(tx, branch, deadlineTrigger.sequence);

      return {
        status: "accepted",
        commandId: command.id,
        branchVersion: branch.version + 1,
        firstSequence: createdEvent.sequence,
        lastSequence: deadlineTrigger.sequence,
        eventIds: resolution.events.map((event) => event.id),
      };
    },
  });
}

/** Raise one commitment's pressure at its notice second (trigger-dispatched). */
export async function submitDurableRaisePressure(
  rawCommand: unknown,
  options: CommitmentStoreOptions = {},
): Promise<RaisePressureCommandResult> {
  return runSimulationCommand({
    rawCommand,
    commandSchema: raisePressureCommandSchema,
    resultSchema: raisePressureCommandResultSchema,
    invalidResult: () => rejectedResult("invalid", "invalid_command", "That pressure request is invalid."),
    branchUnavailableResult: (commandId) =>
      rejectedResult(commandId, "branch_mismatch", "That world branch is unavailable."),
    duplicateCommandIdResult: (commandId) =>
      rejectedResult(commandId, "duplicate_command_id", "That pressure has already been submitted."),
    conflictResult: (commandId, currentVersion) =>
      raisePressureCommandResultSchema.parse({
        status: "conflict",
        commandId,
        currentVersion,
        retryable: true,
      }),
    database: options.database,
    admitAtLockedVersion: options.admitAtLockedVersion,
    execute: async (tx, branch: LockedBranchView, command) => {
      const commitment = await loadCommitment(tx, branch.id, command.payload.commitmentId);
      const { space, originZoneId } = await loadActorOriginSpace(tx, branch, commitment?.actorId);
      // The knowledge gate, resolved per source kind: an E4.1
      // observation of the named event, or an E4.2 live belief in the named
      // assertion / the named belief row. Fails closed on every miss.
      let knowledgeSourceHeld = false;
      if (commitment) {
        switch (commitment.knowledgeSource.kind) {
          case "authored":
            break;
          case "observed":
            knowledgeSourceHeld = await hasObservationOfEvent(tx, {
              branchId: branch.id,
              witnessActorId: commitment.actorId,
              sourceEventId: commitment.knowledgeSource.sourceEventId,
            });
            break;
          case "asserted":
            knowledgeSourceHeld = await holdsLiveBeliefInAssertion(tx, {
              branchId: branch.id,
              holderActorId: commitment.actorId,
              assertionId: commitment.knowledgeSource.assertionId,
            });
            break;
          case "believed":
            knowledgeSourceHeld = await isLiveBeliefHeldBy(tx, {
              branchId: branch.id,
              beliefId: commitment.knowledgeSource.beliefId,
              holderActorId: commitment.actorId,
            });
            break;
        }
      }
      const resolution = resolveRaisePressure(
        {
          worldId: branch.worldId,
          branchId: branch.id,
          rulesetVersion: branch.rulesetVersion,
          headSequence: branch.headSequence,
          storySecond: branch.storySecond,
          ...(commitment ? { commitment } : {}),
          ...(originZoneId ? { originZoneId } : {}),
          topology: { locations: space.locations, zones: space.zones, links: space.links },
          knowledgeSourceHeld,
        },
        command,
      );
      if (!resolution.ok) return rejectedResult(command.id, resolution.code, resolution.publicReason);

      await appendSimulationEvent(tx, resolution.event);
      const [updated] = await tx
        .update(simCommitments)
        .set({ status: "noticed", updatedSequence: resolution.event.sequence })
        .where(
          and(
            eq(simCommitments.branchId, branch.id),
            eq(simCommitments.commitmentId, resolution.commitment.id),
            eq(simCommitments.status, "planned"),
          ),
        )
        .returning({ commitmentId: simCommitments.commitmentId });
      if (!updated) throw new Error("Locked commitment changed before its notice update");
      await tx
        .insert(simTemporalPressures)
        .values(pressureRowInsert(branch.id, resolution.pressure, resolution.event.sequence));
      await advanceLockedBranch(tx, branch, resolution.event.sequence);

      return {
        status: "accepted",
        commandId: command.id,
        branchVersion: branch.version + 1,
        firstSequence: resolution.event.sequence,
        lastSequence: resolution.event.sequence,
        eventIds: [resolution.event.id],
      };
    },
  });
}

/** Evaluate one commitment at its deadline (trigger-dispatched; ruling 6 rules). */
export async function submitDurableResolveCommitmentDeadline(
  rawCommand: unknown,
  options: CommitmentStoreOptions = {},
): Promise<ResolveCommitmentDeadlineCommandResult> {
  return runSimulationCommand({
    rawCommand,
    commandSchema: resolveCommitmentDeadlineCommandSchema,
    resultSchema: resolveCommitmentDeadlineCommandResultSchema,
    invalidResult: () => rejectedResult("invalid", "invalid_command", "That deadline request is invalid."),
    branchUnavailableResult: (commandId) =>
      rejectedResult(commandId, "branch_mismatch", "That world branch is unavailable."),
    duplicateCommandIdResult: (commandId) =>
      rejectedResult(commandId, "duplicate_command_id", "That deadline has already been submitted."),
    conflictResult: (commandId, currentVersion) =>
      resolveCommitmentDeadlineCommandResultSchema.parse({
        status: "conflict",
        commandId,
        currentVersion,
        retryable: true,
      }),
    database: options.database,
    admitAtLockedVersion: options.admitAtLockedVersion,
    execute: async (tx, branch: LockedBranchView, command) => {
      const commitment = await loadCommitment(tx, branch.id, command.payload.commitmentId);
      const locusRow = commitment ? await loadActorLocus(tx, branch.id, commitment.actorId) : undefined;
      const journey =
        locusRow && locusRow.kind === "in_transit"
          ? await loadJourney(tx, branch.id, locusRow.journeyId)
          : undefined;

      const resolution = resolveCommitmentDeadline(
        {
          worldId: branch.worldId,
          branchId: branch.id,
          rulesetVersion: branch.rulesetVersion,
          headSequence: branch.headSequence,
          storySecond: branch.storySecond,
          ...(commitment ? { commitment } : {}),
          ...(locusRow ? { actorLocus: locusRow } : {}),
          ...(journey ? { actorJourney: journey } : {}),
        },
        command,
      );
      if (!resolution.ok) return rejectedResult(command.id, resolution.code, resolution.publicReason);

      await appendSimulationEvent(tx, resolution.event);
      const [updated] = await tx
        .update(simCommitments)
        .set({ status: resolution.outcome, updatedSequence: resolution.event.sequence })
        .where(
          and(
            eq(simCommitments.branchId, branch.id),
            eq(simCommitments.commitmentId, resolution.commitment.id),
          ),
        )
        .returning({ commitmentId: simCommitments.commitmentId });
      if (!updated) throw new Error("Locked commitment changed before its deadline update");
      await tx
        .update(simTemporalPressures)
        .set({ resolvedAt: branch.storySecond, updatedSequence: resolution.event.sequence })
        .where(
          and(
            eq(simTemporalPressures.branchId, branch.id),
            eq(simTemporalPressures.sourceCommitmentId, resolution.commitment.id),
          ),
        );
      await advanceLockedBranch(tx, branch, resolution.event.sequence);

      return {
        status: "accepted",
        commandId: command.id,
        branchVersion: branch.version + 1,
        firstSequence: resolution.event.sequence,
        lastSequence: resolution.event.sequence,
        eventIds: [resolution.event.id],
      };
    },
  });
}

/**
 * E5.5 slice 2: fulfill a destinationless commitment via an
 * explicit self-report. The social ledger recorder picks up the
 * resulting `commitment_kept` event on its own pass — this store needs no
 * direct social awareness.
 */
export async function submitDurableFulfillCommitment(
  rawCommand: unknown,
  options: CommitmentStoreOptions = {},
): Promise<FulfillCommitmentCommandResult> {
  return runSimulationCommand({
    rawCommand,
    commandSchema: fulfillCommitmentCommandSchema,
    resultSchema: fulfillCommitmentCommandResultSchema,
    invalidResult: () => rejectedResult("invalid", "invalid_command", "That fulfillment request is invalid."),
    branchUnavailableResult: (commandId) =>
      rejectedResult(commandId, "branch_mismatch", "That world branch is unavailable."),
    duplicateCommandIdResult: (commandId) =>
      rejectedResult(commandId, "duplicate_command_id", "That fulfillment has already been submitted."),
    conflictResult: (commandId, currentVersion) =>
      fulfillCommitmentCommandResultSchema.parse({
        status: "conflict",
        commandId,
        currentVersion,
        retryable: true,
      }),
    database: options.database,
    admitAtLockedVersion: options.admitAtLockedVersion,
    execute: async (tx, branch: LockedBranchView, command) => {
      const commitment = await loadCommitment(tx, branch.id, command.payload.commitmentId);

      const resolution = resolveFulfillCommitment(
        {
          worldId: branch.worldId,
          branchId: branch.id,
          rulesetVersion: branch.rulesetVersion,
          headSequence: branch.headSequence,
          storySecond: branch.storySecond,
          ...(commitment ? { commitment } : {}),
        },
        command,
      );
      if (!resolution.ok) return rejectedResult(command.id, resolution.code, resolution.publicReason);

      await appendSimulationEvent(tx, resolution.event);
      const [updated] = await tx
        .update(simCommitments)
        .set({ status: "kept", updatedSequence: resolution.event.sequence })
        .where(
          and(
            eq(simCommitments.branchId, branch.id),
            eq(simCommitments.commitmentId, resolution.commitment.id),
          ),
        )
        .returning({ commitmentId: simCommitments.commitmentId });
      if (!updated) throw new Error("Locked commitment changed before its fulfillment update");
      await tx
        .update(simTemporalPressures)
        .set({ resolvedAt: branch.storySecond, updatedSequence: resolution.event.sequence })
        .where(
          and(
            eq(simTemporalPressures.branchId, branch.id),
            eq(simTemporalPressures.sourceCommitmentId, resolution.commitment.id),
          ),
        );
      await advanceLockedBranch(tx, branch, resolution.event.sequence);

      return {
        status: "accepted",
        commandId: command.id,
        branchVersion: branch.version + 1,
        firstSequence: resolution.event.sequence,
        lastSequence: resolution.event.sequence,
        eventIds: [resolution.event.id],
      };
    },
  });
}

async function loadActorLocus(tx: SimTx, branchId: string, actorId: string) {
  const [row] = await tx
    .select()
    .from(simPhysicalLoci)
    .where(and(eq(simPhysicalLoci.branchId, branchId), eq(simPhysicalLoci.actorId, actorId)))
    .limit(1);
  return row ? locusFromRow(row) : undefined;
}

async function loadJourney(tx: SimTx, branchId: string, journeyId: string) {
  const [row] = await tx
    .select()
    .from(simJourneys)
    .where(and(eq(simJourneys.branchId, branchId), eq(simJourneys.journeyId, journeyId)))
    .limit(1);
  return row ? journeyFromRow(row) : undefined;
}
