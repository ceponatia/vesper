import { and, asc, desc, eq, gt, inArray, isNull } from "drizzle-orm";
import { temporalPressureSchema } from "@vesper/simulation-core/contracts/commitments";
import type { DeliberationOutcome, DeliberatorRequest } from "@vesper/simulation-core/contracts/deliberation";
import { claimHoldingEngagementStates } from "@vesper/simulation-core/contracts/engagements";
import { composeSimulationId, worldBranchIdSchema } from "@vesper/simulation-core/contracts/identity";
import {
  KNOWLEDGE_DERIVATION_VERSION,
  disclosureMadeEventSchema,
  type Assertion,
  type Belief,
} from "@vesper/simulation-core/contracts/knowledge";
import {
  confirmNarratorResultCommandResultSchema,
  confirmNarratorResultCommandSchema,
  narrativeCutSchema,
  speechActDeliveredEventSchema,
  type ConfirmNarratorResultCommandResult,
  type NarrativeCut,
  type ProposedArmedEffect,
  type PublicFailurePresentation,
} from "@vesper/simulation-core/contracts/narrative";
import {
  SOFT_CANON_DERIVATION_VERSION,
  resolveSoftCanonRules,
  softCanonPromotedEventSchema,
  softCanonRecordedEventSchema,
} from "@vesper/simulation-core/contracts/soft-canon";
import { runDeliberation } from "@vesper/simulation-core/deliberation";
import { deriveDisclosureCapture } from "@vesper/simulation-core/knowledge";
import { compareStableText, simulationHash, sortedUnique } from "@vesper/simulation-core/hash";
import {
  compileNarrativeCut,
  decideDepartures,
  departureCandidates,
  type PolicyDeparture,
} from "@vesper/simulation-core/narrative";
import { resolveSoftCanonProposals } from "@vesper/simulation-core/soft-canon";
import {
  db,
  simActivities,
  simAssertions,
  simBeliefs,
  simBranches,
  simCommitments,
  simEngagements,
  simEvents,
  simTemporalPressures,
  simWorlds,
  type Db,
} from "@/server/db";
import { activityFromRow } from "./activity-store";
import { computeEngagementBodilyReads } from "./body-reads";
import {
  advanceLockedBranch,
  appendSimulationEvent,
  runSimulationCommand,
  type LockedBranchView,
} from "./command-runner";
import { engagementFromRow, submitDurableAcknowledgePressure } from "./engagement-store";
import { assertionFromRow, beliefFromRow } from "./knowledge-recorder";
import { loadSpeakerLiveBelief } from "./knowledge-store";
import { readEffectiveActorLod } from "./lod-store";
import { latestCutIdForEngagement, persistNarrativeCut, readPersistedCutRow } from "./narrative-cut-store";
import { branchEventFromRow, loadViewpointObservations } from "./observation-store";
import { advanceBranchStoryTime, type AdvanceStoryTimeOutcome } from "./scheduler-store";
import { loadSoftCanonProjection } from "./soft-canon-recorder";
import { loadSpaceRows, spaceProjectionFromRows, submitDurableMoveActor } from "./space-store";

/**
 * E4.3 — the live-scene turn seam: drain due
 * world work through the turn span, let deterministic policy (with an
 * optional §19.3-admitted deliberator) commit departures, compile one full
 * §22.1 cut, and persist it immutable. Confirmation validates the narrator's
 * declared enactments against the PERSISTED cut row — the model result is
 * never trusted for content, only for selection (§23.3, ruling 9).
 */

const MAX_BELIEF_ROWS = 64;

export interface PrepareTurnDeliberation {
  scoreGapThresholdFixedPoint: number;
  modelBudgetRemaining: number;
  /** The injected model seam — a stub in every test, zero live calls shipped. */
  deliberate: (request: DeliberatorRequest) => Promise<unknown>;
  /** Settles when the caller's deadline passes; absent means no deadline. */
  timeout?: Promise<unknown>;
  /** Bounded, caller-redacted evidence lines shown to the model. */
  evidence?: readonly string[];
}

export interface TurnDeliberationRecord {
  actorId: string;
  candidatePressureIds: string[];
  outcome: DeliberationOutcome;
}

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
  /** §14.4 public faces of this turn's rejected commands, supplied by the caller. */
  failurePresentations?: readonly PublicFailurePresentation[];
  /**
   * The §19.3 deliberator admission seam: consulted only when one policy
   * actor holds several in-horizon departure candidates. Absent, the
   * deterministic policy stands alone — behavior is bit-identical.
   */
  deliberation?: PrepareTurnDeliberation;
  workerId: string;
}

export interface PreparedTurn {
  cut: NarrativeCut;
  advance: AdvanceStoryTimeOutcome;
  /** Policy departures attempted this turn, with each command's outcome. */
  departures: (PolicyDeparture & { result: string })[];
  /** §19.3 deliberations run this turn, rationale recorded, fallback-safe. */
  deliberations: TurnDeliberationRecord[];
  /** §15.3/§11 decision 5 (E5.5 slice 3): every open pressure belonging to a
   * scene participant who did NOT depart this turn, marked "looked at" —
   * `already_acknowledged` is an expected, harmless outcome on a repeat turn
   * at unchanged severity. */
  acknowledgments: { actorId: string; pressureId: string; result: string }[];
  /** False when this exact cut id + hash was already persisted (§22.3). */
  cutCreated: boolean;
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
  // world does not freeze for a conversation. A2-1: the advance is tolerant — a
  // concurrent skip/travel drain that already moved past `turnEnd` does NOT crash
  // the turn; the effective target clamps up to the drained clock and the turn
  // lands there. Due work through the effective target still drains first.
  const advance = await advanceBranchStoryTime(branchId, turnEnd, {
    workerId: input.workerId,
    database,
    targetMode: "at_least",
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
  const policyInput = {
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
            ...(row.acknowledgedSeverity === null ? {} : { acknowledgedSeverity: row.acknowledgedSeverity }),
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
  };
  const departures = decideDepartures(policyInput);

  // §19.3: when one actor legally could answer several pressures, an admitted
  // deliberator may pick among them — never outside them. Refusal, timeout,
  // and nonsense all land on the deterministic head-of-queue choice.
  const deliberations: TurnDeliberationRecord[] = [];
  if (input.deliberation) {
    const candidates = departureCandidates(policyInput);
    const actorIds = sortedUnique(candidates.map((pressure) => pressure.actorId));
    for (const actorId of actorIds) {
      const actorCandidates = candidates.filter((pressure) => pressure.actorId === actorId);
      if (actorCandidates.length < 2) continue;
      const horizonEnd = advance.storySecond + (input.horizonSeconds ?? 600);
      const scored = actorCandidates.map((pressure) => ({
        id: pressure.id,
        deterministicScoreFixedPoint: Math.max(
          -1_000_000,
          Math.min(1_000_000, horizonEnd - pressure.actBy),
        ),
      }));
      // E6.1: the acting NPC's real per-actor inference LOD (§28) — read per
      // actor, not per turn; unassigned actors read the registry default
      // (deliberator), reproducing the pre-Gate-6 caller-supplied value.
      const actorLod = await readEffectiveActorLod(database, branchId, actorId);
      const outcome = await runDeliberation({
        admissionInput: {
          actorId,
          inferenceLod: actorLod.inferenceLod,
          candidates: scored,
          scoreGapThresholdFixedPoint: input.deliberation.scoreGapThresholdFixedPoint,
          consequential: true,
          modelBudgetRemaining: input.deliberation.modelBudgetRemaining,
          hasDeterministicFallback: true,
        },
        evidence: input.deliberation.evidence ?? [],
        deliberate: input.deliberation.deliberate,
        ...(input.deliberation.timeout === undefined ? {} : { timeout: input.deliberation.timeout }),
      });
      deliberations.push({
        actorId,
        candidatePressureIds: scored.map((candidate) => candidate.id),
        outcome,
      });
      const chosen = actorCandidates.find((pressure) => pressure.id === outcome.chosenCandidateId);
      const departure = departures.find((candidate) => candidate.actorId === actorId);
      if (chosen && departure) {
        departure.commitmentId = chosen.sourceCommitmentId;
        departure.destinationZoneId = chosen.destinationZoneId;
        departure.actBy = chosen.actBy;
      }
    }
  }

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
  const activityRows = await database
    .select()
    .from(simActivities)
    .where(eq(simActivities.branchId, branchId))
    .orderBy(asc(simActivities.activityInstanceId));
  // E4.2: the viewpoint's own live beliefs, joined to what each one claims —
  // the speaker may voice them even when they are wrong (§21, §22.1).
  const beliefRows = await database
    .select({ belief: simBeliefs, assertion: simAssertions })
    .from(simBeliefs)
    .innerJoin(
      simAssertions,
      and(
        eq(simAssertions.branchId, simBeliefs.branchId),
        eq(simAssertions.assertionId, simBeliefs.assertionId),
      ),
    )
    .where(
      and(
        eq(simBeliefs.branchId, branchId),
        eq(simBeliefs.holderActorId, input.viewpointActorId),
        inArray(simBeliefs.status, ["active", "doubted"]),
      ),
    )
    .orderBy(desc(simBeliefs.believedFrom), asc(simBeliefs.beliefId))
    .limit(MAX_BELIEF_ROWS);
  const softCanon = await loadSoftCanonProjection(branchId, { database });
  // E5.2: the layer-3 body surface — the viewpoint's own reads plus the
  // perceivable signs of everyone sharing their zone. Empty for worlds with
  // no initialized bodies, so pre-Gate-5 scenarios compile identical cuts.
  const viewpointLocus = space.loci.find((locus) => locus.actorId === input.viewpointActorId);
  const viewpointZoneId =
    viewpointLocus && viewpointLocus.kind === "at" ? viewpointLocus.zoneId : undefined;
  const coPresentActorIds = space.loci
    .filter(
      (locus) =>
        locus.kind === "at" &&
        viewpointZoneId !== undefined &&
        locus.zoneId === viewpointZoneId &&
        locus.actorId !== input.viewpointActorId,
    )
    .map((locus) => locus.actorId)
    .sort();
  const bodilyReads = await computeEngagementBodilyReads(database, {
    branchId,
    storySecond: after.storySecond,
    viewpointActorId: input.viewpointActorId,
    coPresentActorIds,
  });

  const cut = compileNarrativeCut({
    branchVersion: after.version,
    engagement,
    viewpointActorId: input.viewpointActorId,
    events,
    fromSequence,
    throughSequence: after.headSequence,
    fromStorySecond,
    throughStorySecond: after.storySecond,
    space,
    activities: activityRows.map(activityFromRow),
    viewpointObservations,
    viewpointBeliefs: beliefRows.map((row) => ({
      belief: beliefFromRow(row.belief),
      assertion: assertionFromRow(row.assertion),
    })),
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
        ...(row.acknowledgedSeverity === null ? {} : { acknowledgedSeverity: row.acknowledgedSeverity }),
      }),
    ),
    failurePresentations: input.failurePresentations ?? [],
    softCanonEntries: softCanon.entries,
    proposedArmedEffects: input.proposedArmedEffects ?? [],
    bodilyReads,
  });

  // §22.3: the cut becomes an immutable, addressable row. Rerender and
  // narrator-failure retry (ruling 8) re-read it via `loadPersistedCut`.
  const { created } = await persistNarrativeCut(cut, { database });

  // E5.5 slice 3 (§15.3, §11 decision 5 REVISED): mark every open pressure
  // belonging to a scene participant "looked at" this turn, UNLESS that
  // actor's own departure was accepted (their pressure resolves via the
  // departure's own commitment machinery, not acknowledgment). Sourced from
  // `pressureRows` — the PRE-`destinationByCommitment`-filter load above —
  // deliberately NOT `policyInput.pressures`, which silently drops every
  // destinationless-commitment pressure entirely (that filter is legitimate
  // for `decideDepartures`/`departureCandidates` themselves, which need
  // somewhere to walk to; conflating "policy-visible for departure" with
  // "policy-visible for acknowledgment" would silently defeat acknowledgment
  // for exactly the destinationless commitments this slice adds).
  //
  // Placement: AFTER the cut is compiled and persisted, not before. A
  // pressure this turn is narratively surfacing should still show up in
  // THIS turn's own cut — acknowledging it now only suppresses it starting
  // the NEXT turn's cut (§9.4's filter compares live severity against the
  // captured acknowledgedSeverity at read time). Acknowledging before
  // compilation would silently swallow a pressure from the very turn that
  // raised it.
  const acknowledgments: PreparedTurn["acknowledgments"] = [];
  const departedActorIds = new Set(
    attempted.filter((departure) => departure.result === "accepted").map((departure) => departure.actorId),
  );
  for (const pressureRow of pressureRows) {
    if (departedActorIds.has(pressureRow.actorId)) continue;
    // Hashed the same way as the departure commandId above — pressure ids
    // nest a commitment id which nests a branch+command id, so concatenation
    // risks the 256-char compact-id cap.
    const commandId = composeSimulationId("arbiter-ack", [
      branchId,
      simulationHash({
        engagementId: input.engagementId,
        pressureId: pressureRow.pressureId,
        storySecond: advance.storySecond,
      }),
    ]);
    const result = await submitDurableAcknowledgePressure(
      {
        id: commandId,
        branchId,
        expectedVersion: 0,
        idempotencyKey: commandId,
        principal: { kind: "system", principalId: "sim-arbiter", controlledActorIds: [] },
        submittedAtWallClock: new Date().toISOString(),
        correlationId: input.engagementId,
        type: "acknowledge_pressure",
        schemaVersion: 1,
        payload: { engagementId: input.engagementId, pressureId: pressureRow.pressureId },
      },
      { database, admitAtLockedVersion: true },
    );
    acknowledgments.push({
      actorId: pressureRow.actorId,
      pressureId: pressureRow.pressureId,
      result: result.status === "rejected" ? result.code : result.status,
    });
  }

  return { cut, advance, departures: attempted, deliberations, acknowledgments, cutCreated: created };
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
 * Confirm one narrator render against its PERSISTED cut (§23.3, ruling 9):
 * the payload names armed-effect ids and soft-canon proposals; every enacted
 * id is revalidated against the cut row, unknown ids are ignored, unenacted
 * effects expire, and the E4.2 bridge turns an enacted armed disclosure into
 * a real §21 `disclosure_made` event. Only the newest cut of an engagement is
 * confirmable — an older cut's effects have expired with it.
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

      const cutRow = await readPersistedCutRow(tx, branch.id, command.payload.cutId);
      if (!cutRow || cutRow.engagementId !== engagement.id) {
        return rejectedResult(command.id, "cut_not_found", "That moment of the scene is unknown.");
      }
      const parsedCut = narrativeCutSchema.safeParse(cutRow.content);
      if (!parsedCut.success) {
        return rejectedResult(
          command.id,
          "cut_incompatible",
          "That moment cannot be read by this engine version.",
        );
      }
      const cut = parsedCut.data;
      const latestCutId = await latestCutIdForEngagement(tx, branch.id, engagement.id);
      if (latestCutId !== cut.id) {
        return rejectedResult(command.id, "cut_superseded", "That moment of the scene has passed.");
      }

      // §23.3: selection only. Unknown ids are dropped, order comes from the
      // cut, and every payload field below is quoted from the persisted row.
      const enactedIdSet = new Set(command.payload.enactedArmedEffectIds);
      const enactedEffects = cut.armedEffects.filter((effect) => enactedIdSet.has(effect.id));

      const softCanonProjection = await loadSoftCanonProjection(branch.id, { database: tx });
      const rules = resolveSoftCanonRules(branch.worldTypeId);
      const resolution = resolveSoftCanonProposals({
        branchId: branch.id,
        cutId: cut.id,
        participantActorIds: [...engagement.participantIds],
        zoneIds: sortedUnique(cut.currentLoci.flatMap((locus) => (locus.zoneId ? [locus.zoneId] : []))),
        proposals: command.payload.softCanonProposals,
        entries: softCanonProjection.entries,
        rules,
        storySecond: branch.storySecond,
      });

      if (enactedEffects.length === 0 && resolution.accepted.length === 0) {
        return rejectedResult(command.id, "nothing_to_record", "Nothing in that render survived validation.");
      }

      let sequence = branch.headSequence;
      const eventIds: string[] = [];
      const append = async (event: Parameters<typeof appendSimulationEvent>[1]): Promise<void> => {
        await appendSimulationEvent(tx, event);
        eventIds.push(event.id);
      };

      for (const effect of enactedEffects) {
        sequence += 1;
        await append(
          speechActDeliveredEventSchema.parse({
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
            entityIds: sortedUnique([effect.actorId, ...effect.targetActorIds, engagement.id]),
            ...(engagement.locationId ? { locationId: engagement.locationId } : {}),
            recordedAtWallClock: command.submittedAtWallClock,
            payload: {
              cutId: cut.id,
              engagementId: engagement.id,
              effectType: effect.effectType,
              actorId: effect.actorId,
              targetActorIds: [...effect.targetActorIds].sort(compareStableText),
              detail: effect.detail,
              // E5.5 (§21.3, §21.4): a consent-scoped enacted effect
              // (boundary_expressed/permission_granted/permission_withdrawn)
              // must carry its scopeKey into the real event, or
              // `speechActDeliveredPayloadSchema`'s
              // `consentScopeKeyRequiredOnConsentEffects` refine rejects it —
              // this was dropped here entirely (Stage A/B defect, found and
              // fixed in Stage C alongside the matching drop in
              // `compileNarrativeCut`).
              ...(effect.consentScopeKey === undefined ? {} : { consentScopeKey: effect.consentScopeKey }),
            },
          }),
        );

        // The E4.2 bridge: an enacted armed disclosure becomes a real §21
        // knowledge event, folded into beliefs by the shell's recorder. A
        // capture failure (stale relay, foreign retraction) degrades to the
        // speech act alone — the render already happened, truth stays safe.
        if (effect.disclosureContent !== undefined) {
          const content = effect.disclosureContent;
          let referencedAssertion: Assertion | undefined;
          let speakerBelief: Belief | undefined;
          if (content.kind !== "claim") {
            const [assertionRow] = await tx
              .select()
              .from(simAssertions)
              .where(
                and(eq(simAssertions.branchId, branch.id), eq(simAssertions.assertionId, content.assertionId)),
              )
              .limit(1);
            referencedAssertion = assertionRow ? assertionFromRow(assertionRow) : undefined;
            if (content.kind === "relay" && referencedAssertion) {
              speakerBelief = await loadSpeakerLiveBelief(tx, branch.id, effect.actorId, referencedAssertion.id);
            }
          }
          const disclosureEventId = composeSimulationId("event", [
            branch.id,
            command.id,
            `disclosure-${eventIds.length + 1}`,
          ]);
          const capture = deriveDisclosureCapture(
            {
              ...(referencedAssertion ? { referencedAssertion } : {}),
              ...(speakerBelief ? { speakerBelief } : {}),
            },
            effect.actorId,
            content,
            disclosureEventId,
          );
          if (capture.ok) {
            sequence += 1;
            const subjectEntityIds = content.kind === "claim" ? content.subjectIds : [];
            await append(
              disclosureMadeEventSchema.parse({
                id: disclosureEventId,
                worldId: branch.worldId,
                branchId: branch.id,
                sequence,
                storySecond: branch.storySecond,
                type: "disclosure_made",
                schemaVersion: 1,
                rulesetVersion: branch.rulesetVersion,
                derivationVersion: KNOWLEDGE_DERIVATION_VERSION,
                commandId: command.id,
                correlationId: command.correlationId,
                actorIds: sortedUnique([effect.actorId, ...effect.targetActorIds]),
                entityIds: sortedUnique([capture.derived.assertionId, ...subjectEntityIds]),
                ...(engagement.locationId ? { locationId: engagement.locationId } : {}),
                recordedAtWallClock: command.submittedAtWallClock,
                payload: {
                  speakerActorId: effect.actorId,
                  targetActorIds: sortedUnique([...effect.targetActorIds]),
                  content,
                  derived: capture.derived,
                },
              }),
            );
          }
        }
      }

      // §23.4: accepted proposals become audited records; a threshold-crossing
      // reuse appends the ruled promotion event right behind its record.
      for (const accepted of resolution.accepted) {
        sequence += 1;
        await append(
          softCanonRecordedEventSchema.parse({
            id: composeSimulationId("event", [branch.id, command.id, `canon-${eventIds.length + 1}`]),
            worldId: branch.worldId,
            branchId: branch.id,
            sequence,
            storySecond: branch.storySecond,
            type: "soft_canon_recorded",
            schemaVersion: 1,
            rulesetVersion: branch.rulesetVersion,
            derivationVersion: SOFT_CANON_DERIVATION_VERSION,
            commandId: command.id,
            correlationId: command.correlationId,
            actorIds: [],
            entityIds: sortedUnique([...accepted.entry.subjectIds]),
            recordedAtWallClock: command.submittedAtWallClock,
            payload: {
              proposal: accepted.proposal,
              derived: { entry: accepted.entry, reused: accepted.reused },
            },
          }),
        );
        if (accepted.promoted) {
          sequence += 1;
          const promotedEventId = composeSimulationId("event", [
            branch.id,
            command.id,
            `canon-promoted-${eventIds.length + 1}`,
          ]);
          await append(
            softCanonPromotedEventSchema.parse({
              id: promotedEventId,
              worldId: branch.worldId,
              branchId: branch.id,
              sequence,
              storySecond: branch.storySecond,
              type: "soft_canon_promoted",
              schemaVersion: 1,
              rulesetVersion: branch.rulesetVersion,
              derivationVersion: SOFT_CANON_DERIVATION_VERSION,
              commandId: command.id,
              correlationId: command.correlationId,
              actorIds: [],
              entityIds: sortedUnique([...accepted.entry.subjectIds]),
              recordedAtWallClock: command.submittedAtWallClock,
              payload: {
                entry: {
                  ...accepted.entry,
                  status: "promoted",
                  statusChangedAt: branch.storySecond,
                  statusCauseEventId: promotedEventId,
                },
                reuseCutCount: accepted.reuseCutCount,
                thresholds: {
                  rulesVersion: rules.version,
                  promotionReuseCutCount: rules.promotionReuseCutCount,
                  promotionMinimumConfidenceFixedPoint: rules.promotionMinimumConfidenceFixedPoint,
                },
              },
            }),
          );
        }
      }

      await advanceLockedBranch(tx, branch, sequence);

      return confirmNarratorResultCommandResultSchema.parse({
        status: "accepted",
        commandId: command.id,
        branchVersion: branch.version + 1,
        firstSequence: branch.headSequence + 1,
        lastSequence: sequence,
        eventIds,
      });
    },
  });
}
