import { and, asc, eq, gt, inArray, isNull } from "drizzle-orm";
import { temporalPressureSchema } from "@/contracts/simulation/commitments";
import { claimHoldingEngagementStates } from "@/contracts/simulation/engagements";
import { composeSimulationId, worldBranchIdSchema } from "@/contracts/simulation/identity";
import {
  confirmNarratorResultCommandResultSchema,
  confirmNarratorResultCommandSchema,
  proposedArmedEffectSchema,
  speechActDeliveredEventSchema,
  type ConfirmNarratorResultCommandResult,
  type Gate3NarrativeCut,
  type ProposedArmedEffect,
  type SpeechActDeliveredEvent,
} from "@/contracts/simulation/narrative";
import { simulationHash } from "@/lib/simulation/item-transfer";
import { compileGate3Cut, decideDepartures, type PolicyDeparture } from "@/lib/simulation/narrative";
import {
  db,
  simBranches,
  simCommitments,
  simEngagements,
  simEvents,
  simTemporalPressures,
  simWorlds,
  type Db,
} from "@/server/db";
import {
  advanceLockedBranch,
  appendSimulationEvent,
  runSimulationCommand,
  type LockedBranchView,
} from "./command-runner";
import { engagementFromRow } from "./engagement-store";
import { branchEventFromRow, loadViewpointObservations } from "./observation-store";
import { advanceBranchStoryTime, type AdvanceStoryTimeOutcome } from "./scheduler-store";
import { loadSpaceRows, spaceProjectionFromRows, submitDurableMoveActor } from "./space-store";

/**
 * E3.4 slice 2 — the deterministic live-scene turn seam (engine.spec §18.3):
 * drain due world work through the turn span, look ahead at participant
 * pressure, let deterministic policy commit departures (which interrupt the
 * scene atomically through the E3.4 slice-1 machinery), and compile one
 * immutable, perspective-safe NarrativeCut. No model call anywhere; a failed
 * narrator render re-reads the same cut (ruling 8) because cuts derive purely
 * from committed events — there is no state to roll back.
 */

export interface PrepareTurnInput {
  branchId: string;
  engagementId: string;
  viewpointActorId: string;
  /** Ruling 1: the fixed story-time span this exchange consumes. */
  spanSeconds: number;
  /** How far past the turn the departure policy anticipates. Default 600. */
  horizonSeconds?: number;
  /** Actors the player asked to stay (§15.3): departure defers to the last moment. */
  stayRequestedActorIds?: readonly string[];
  /** Actors policy must never move (player agency). Defaults to the viewpoint. */
  playerActorIds?: readonly string[];
  proposedArmedEffects?: readonly ProposedArmedEffect[];
  workerId: string;
}

export interface PreparedTurn {
  cut: Gate3NarrativeCut;
  advance: AdvanceStoryTimeOutcome;
  /** Policy departures attempted this turn, with each command's outcome. */
  departures: (PolicyDeparture & { result: string })[];
}

export async function prepareEngagementTurn(
  input: PrepareTurnInput,
  options: { database?: Db } = {},
): Promise<PreparedTurn> {
  const database = options.database ?? db();
  const branchId = worldBranchIdSchema.parse(input.branchId);

  const [start] = await database
    .select({
      id: simBranches.id,
      worldId: simBranches.worldId,
      headSequence: simBranches.headSequence,
      storySecond: simBranches.storySecond,
    })
    .from(simBranches)
    .where(eq(simBranches.id, branchId))
    .limit(1);
  if (!start) throw new Error("Simulation branch not found");
  const [engagementRow] = await database
    .select()
    .from(simEngagements)
    .where(and(eq(simEngagements.branchId, branchId), eq(simEngagements.engagementId, input.engagementId)))
    .limit(1);
  if (!engagementRow) throw new Error("Engagement not found");
  const engagement = engagementFromRow(engagementRow);
  if (!claimHoldingEngagementStates.includes(engagement.state) || engagement.state === "interrupted") {
    throw new Error("Cannot prepare a turn for a scene that is not live");
  }
  if (!engagement.participantIds.includes(input.viewpointActorId as never)) {
    throw new Error("Viewpoint must be an engagement participant");
  }

  const fromSequence = start.headSequence;
  const fromStorySecond = start.storySecond;
  const turnEnd = fromStorySecond + input.spanSeconds;

  // §18.3 step 2: reconcile due world work through the turn boundary. The
  // world does not freeze for a conversation.
  const advance = await advanceBranchStoryTime(branchId, turnEnd, {
    workerId: input.workerId,
    database,
  });

  // §18.3 steps 4–6: look ahead and let deterministic policy decide.
  const pressureRows = await database
    .select()
    .from(simTemporalPressures)
    .where(
      and(
        eq(simTemporalPressures.branchId, branchId),
        isNull(simTemporalPressures.resolvedAt),
        inArray(simTemporalPressures.actorId, [...engagement.participantIds]),
      ),
    )
    .orderBy(asc(simTemporalPressures.pressureId));
  const commitmentIds = pressureRows.map((row) => row.sourceCommitmentId);
  const commitmentRows = commitmentIds.length
    ? await database
        .select({
          commitmentId: simCommitments.commitmentId,
          destinationZoneId: simCommitments.destinationZoneId,
        })
        .from(simCommitments)
        .where(and(eq(simCommitments.branchId, branchId), inArray(simCommitments.commitmentId, commitmentIds)))
    : [];
  const destinationByCommitment = new Map(
    commitmentRows.map((row) => [row.commitmentId, row.destinationZoneId]),
  );
  const playerActorIds = input.playerActorIds ?? [input.viewpointActorId];
  const departures = decideDepartures({
    pressures: pressureRows.flatMap((row) => {
      const destinationZoneId = destinationByCommitment.get(row.sourceCommitmentId);
      if (!destinationZoneId) return [];
      return [
        {
          ...temporalPressureSchema.parse({
            id: row.pressureId,
            actorId: row.actorId,
            sourceCommitmentId: row.sourceCommitmentId,
            noticeAt: row.noticeAt,
            decideBy: row.decideBy,
            actBy: row.actBy,
            severity: row.severity,
            ...(row.acknowledgedAt === null ? {} : { acknowledgedAt: row.acknowledgedAt }),
            ...(row.resolvedAt === null ? {} : { resolvedAt: row.resolvedAt }),
          }),
          destinationZoneId,
        },
      ];
    }),
    turnEndSecond: advance.storySecond,
    horizonSeconds: input.horizonSeconds ?? 600,
    stayRequestedActorIds: input.stayRequestedActorIds ?? [],
    policyControlledActorIds: engagement.participantIds.filter(
      (participantId) => !playerActorIds.includes(participantId),
    ),
  });

  // §18.3 step 7: commit. A departure interrupts this very scene atomically
  // (slice 1), so the cut compiled below already shows the interruption.
  const attempted: PreparedTurn["departures"] = [];
  for (const departure of departures) {
    // The engagement and commitment ids are themselves derived and can stack
    // past the 256-char compact-id cap once a journey id derives from this
    // command id — hash the variable-length parts instead of concatenating.
    const commandId = composeSimulationId("arbiter-move", [
      branchId,
      simulationHash({
        engagementId: input.engagementId,
        commitmentId: departure.commitmentId,
        storySecond: advance.storySecond,
      }),
    ]);
    const result = await submitDurableMoveActor(
      {
        id: commandId,
        branchId,
        expectedVersion: 0,
        idempotencyKey: commandId,
        principal: { kind: "npc_policy", principalId: "sim-arbiter", controlledActorIds: [departure.actorId] },
        submittedAtWallClock: new Date().toISOString(),
        correlationId: input.engagementId,
        type: "move_actor",
        schemaVersion: 1,
        payload: { actorId: departure.actorId, destinationZoneId: departure.destinationZoneId, travelMode: "walk" },
      },
      { database, admitAtLockedVersion: true },
    );
    attempted.push({ ...departure, result: result.status === "rejected" ? result.code : result.status });
  }

  // §18.3 step 8: compile one immutable perspective-safe cut.
  const [after] = await database
    .select({
      headSequence: simBranches.headSequence,
      version: simBranches.version,
      storySecond: simBranches.storySecond,
      rulesetVersion: simWorlds.rulesetVersion,
    })
    .from(simBranches)
    .innerJoin(simWorlds, eq(simWorlds.id, simBranches.worldId))
    .where(eq(simBranches.id, branchId))
    .limit(1);
  if (!after) throw new Error("Simulation branch vanished during turn preparation");
  const eventRows = await database
    .select()
    .from(simEvents)
    .where(and(eq(simEvents.branchId, branchId), gt(simEvents.sequence, fromSequence)))
    .orderBy(asc(simEvents.sequence));
  const events = eventRows.map(branchEventFromRow);
  const space = spaceProjectionFromRows(
    {
      worldId: start.worldId,
      branchId,
      rulesetVersion: after.rulesetVersion,
      version: after.version,
      headSequence: after.headSequence,
      storySecond: after.storySecond,
    },
    await loadSpaceRows(database, branchId),
  );
  const viewpointPressureRows = await database
    .select()
    .from(simTemporalPressures)
    .where(
      and(
        eq(simTemporalPressures.branchId, branchId),
        isNull(simTemporalPressures.resolvedAt),
        eq(simTemporalPressures.actorId, input.viewpointActorId),
      ),
    )
    .orderBy(asc(simTemporalPressures.pressureId));
  // E4.1: what the viewpoint perceived this interval comes from the committed
  // observation log — the compiler re-decides nothing about witnessing (§20).
  const viewpointObservations = await loadViewpointObservations(
    {
      branchId,
      witnessActorId: input.viewpointActorId,
      fromSequence,
      throughSequence: after.headSequence,
    },
    { database },
  );

  const cut = compileGate3Cut({
    branchVersion: after.version,
    engagement,
    viewpointActorId: input.viewpointActorId,
    events,
    fromSequence,
    throughSequence: after.headSequence,
    fromStorySecond,
    throughStorySecond: after.storySecond,
    space,
    viewpointObservations,
    viewpointPressures: viewpointPressureRows.map((row) =>
      temporalPressureSchema.parse({
        id: row.pressureId,
        actorId: row.actorId,
        sourceCommitmentId: row.sourceCommitmentId,
        noticeAt: row.noticeAt,
        decideBy: row.decideBy,
        actBy: row.actBy,
        severity: row.severity,
        ...(row.acknowledgedAt === null ? {} : { acknowledgedAt: row.acknowledgedAt }),
      }),
    ),
    proposedArmedEffects: input.proposedArmedEffects ?? [],
  });

  return { cut, advance, departures: attempted };
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

/**
 * Confirm which armed speech acts the rendered prose actually delivered
 * (ruling 9): one speech_act_delivered event per validated enacted effect.
 * Idempotent per cut through the command idempotency key; effects naming
 * non-participants are dropped rather than trusted (§23.3 — the narrator
 * result crosses a trust boundary).
 */
export async function submitDurableConfirmNarratorResult(
  rawCommand: unknown,
  options: { database?: Db; admitAtLockedVersion?: boolean } = {},
): Promise<ConfirmNarratorResultCommandResult> {
  return runSimulationCommand({
    rawCommand,
    commandSchema: confirmNarratorResultCommandSchema,
    resultSchema: confirmNarratorResultCommandResultSchema,
    invalidResult: () => rejectedResult("invalid", "invalid_command", "That confirmation is invalid."),
    branchUnavailableResult: (commandId) =>
      rejectedResult(commandId, "branch_mismatch", "That world branch is unavailable."),
    duplicateCommandIdResult: (commandId) =>
      rejectedResult(commandId, "duplicate_command_id", "That confirmation has already been submitted."),
    conflictResult: (commandId, currentVersion) =>
      confirmNarratorResultCommandResultSchema.parse({
        status: "conflict",
        commandId,
        currentVersion,
        retryable: true,
      }),
    database: options.database,
    admitAtLockedVersion: options.admitAtLockedVersion,
    execute: async (tx, branch: LockedBranchView, command) => {
      if (command.principal.kind !== "system") {
        return rejectedResult(command.id, "unauthorized_principal", "Confirmations resolve mechanically.");
      }
      const [engagementRow] = await tx
        .select()
        .from(simEngagements)
        .where(
          and(
            eq(simEngagements.branchId, branch.id),
            eq(simEngagements.engagementId, command.payload.engagementId),
          ),
        )
        .limit(1);
      if (!engagementRow) {
        return rejectedResult(command.id, "engagement_not_found", "That conversation is unknown.");
      }
      const engagement = engagementFromRow(engagementRow);
      const valid = command.payload.enactedEffects.filter(
        (effect) =>
          proposedArmedEffectSchema.safeParse(effect).success &&
          engagement.participantIds.includes(effect.actorId as never) &&
          effect.targetActorIds.every((target) => engagement.participantIds.includes(target as never)),
      );
      if (valid.length === 0) {
        return rejectedResult(command.id, "invalid_command", "No enacted effect named scene participants.");
      }

      let sequence = branch.headSequence;
      const eventIds: SpeechActDeliveredEvent["id"][] = [];
      for (const effect of valid) {
        sequence += 1;
        const event = speechActDeliveredEventSchema.parse({
          id: composeSimulationId("event", [branch.id, command.id, `speech-${eventIds.length + 1}`]),
          worldId: branch.worldId,
          branchId: branch.id,
          sequence,
          storySecond: branch.storySecond,
          type: "speech_act_delivered",
          schemaVersion: 1,
          rulesetVersion: branch.rulesetVersion,
          commandId: command.id,
          correlationId: command.correlationId,
          actorIds: [effect.actorId],
          entityIds: [...new Set([effect.actorId, ...effect.targetActorIds, engagement.id])].sort(),
          ...(engagement.locationId ? { locationId: engagement.locationId } : {}),
          recordedAtWallClock: command.submittedAtWallClock,
          payload: {
            cutId: command.payload.cutId,
            engagementId: engagement.id,
            effectType: effect.effectType,
            actorId: effect.actorId,
            targetActorIds: [...effect.targetActorIds].sort(),
            detail: effect.detail,
          },
        });
        await appendSimulationEvent(tx, event);
        eventIds.push(event.id);
      }
      await advanceLockedBranch(tx, branch, sequence);

      return {
        status: "accepted",
        commandId: command.id,
        branchVersion: branch.version + 1,
        firstSequence: branch.headSequence + 1,
        lastSequence: sequence,
        eventIds,
      };
    },
  });
}
